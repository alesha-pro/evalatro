import { spawn, ChildProcess } from "child_process";
import { connect } from "net";
import * as path from "path";
import { loadConfig } from "../config.js";
import { BalatroBotClient } from "../client/balatrobot.js";
import { prepareEvalProfile } from "./profile.js";

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** How long stop() waits for a killed game to actually exit before giving up. */
const STOP_TIMEOUT_MS = 8000;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5000;
/** How long to wait for the port to be released after the process exits. */
const PORT_FREE_TIMEOUT_MS = 15000;
/** How often to re-probe the port while waiting for it to free. */
const PORT_POLL_MS = 250;

/** Is something accepting connections on this port right now? */
function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Wait until nothing is listening on the port. Process exit is not proof the
 * socket is gone: the CLI can die before its Balatro child releases it, and the
 * next seed spawns into the same port.
 *
 * Returns `false` when the deadline passes with the port still occupied. The
 * caller must treat that as a failure — the old version returned `void` here,
 * so a held port looked exactly like a clean shutdown.
 */
async function waitForPortFree(
  isPortInUse: () => Promise<boolean>,
  timeoutMs = PORT_FREE_TIMEOUT_MS,
  pollMs = PORT_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Probe at least once even past the deadline: teardown can be entered
    // after the launcher already exited, which says nothing about the socket.
    if (!(await isPortInUse())) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

export interface GameHandle {
  port: number;
  proc?: ChildProcess;
  /**
   * Resolves once the game process (and its child) is gone AND the port is
   * free. Rejects when the port is still occupied at the deadline — the caller
   * must not start the next seed in that case.
   */
  stop: () => Promise<void>;
}

/**
 * Dependencies of the shutdown sequence, injected so the sequencing can be
 * tested without spawning Balatro. The production wiring is in `stop()` below;
 * `scripts/teardown.test.mjs` drives it with a real localhost listener.
 */
export interface TeardownDeps {
  port: number;
  /** Launcher pid, or undefined when it never started. */
  pid?: number;
  /** True when the launcher already emitted `exit` before teardown began. */
  alreadyExited: boolean;
  /** Resolves when the launcher exits. Must resolve immediately if already gone. */
  exited: () => Promise<void>;
  /** Signal the process group. Must not throw. */
  signal: (sig: NodeJS.Signals) => void;
  /** True while something still accepts connections on the port. */
  isPortInUse: () => Promise<boolean>;
  graceMs?: number;
  exitTimeoutMs?: number;
  portTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Shut the game down and prove it is down.
 *
 * Two invariants, both learned from production failures:
 *
 *   1. Launcher exit != teardown complete. The CLI can exit while its Balatro
 *      child still holds the port, so the socket is checked unconditionally —
 *      including on the already-exited path, which used to return immediately.
 *   2. The SIGKILL escalation timer is not cancelled by launcher exit. A child
 *      that outlives its launcher is exactly the case the grace period exists
 *      for; cancelling on exit left it running forever.
 *
 * Throws when the port is still occupied at the deadline rather than returning
 * quietly, so a held socket can never look like a clean shutdown.
 */
export async function teardown(deps: TeardownDeps): Promise<void> {
  const graceMs = deps.graceMs ?? KILL_GRACE_MS;
  const exitTimeoutMs = deps.exitTimeoutMs ?? STOP_TIMEOUT_MS;
  const portTimeoutMs = deps.portTimeoutMs ?? PORT_FREE_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? PORT_POLL_MS;

  if (deps.pid) deps.signal("SIGTERM");
  const killTimer = setTimeout(() => {
    if (deps.pid) deps.signal("SIGKILL");
  }, graceMs);
  killTimer.unref?.();

  try {
    if (deps.pid && !deps.alreadyExited) {
      await Promise.race([deps.exited(), sleep(exitTimeoutMs)]);
    }
    if (!(await waitForPortFree(deps.isPortInUse, portTimeoutMs, pollMs))) {
      throw new Error(
        `teardown failed: port ${deps.port} still in use ${portTimeoutMs}ms after shutdown; ` +
        `refusing to start the next seed`,
      );
    }
  } finally {
    clearTimeout(killTimer);
  }
}

/** Spawn Balatro under balatrobot's CLI on the given port (paths from config). */
export function launchBalatro(port?: number): GameHandle {
  const cfg = loadConfig();
  const p = port ?? cfg.basePort;
  if (cfg.launchMode === "attach") {
    return { port: p, stop: async () => {} };
  }
  const preparedProfile = prepareEvalProfile(cfg.evalProfileSlot);

  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === "path") ?? "PATH";
  const pathParts = [cfg.pythonScriptsDir, cfg.userBin, process.env[pathKey]].filter(Boolean);
  const env = {
    ...process.env,
    [pathKey]: pathParts.join(path.delimiter),
    ...(cfg.autoUnlockAll ? { EVALATRO_UNLOCK: "1" } : {}),
    ...(cfg.evalProfileSlot ? { EVALATRO_PROFILE_SLOT: String(cfg.evalProfileSlot) } : {}),
  };
  const args = [
    "serve", "--fast",
    "--port", String(p),
    "--no-shaders",
    "--logs-path", "logs",
  ];
  if (cfg.balatroPath) args.push("--love-path", cfg.balatroPath);
  if (cfg.lovelyPath) args.push("--lovely-path", cfg.lovelyPath);

  const proc = spawn("balatrobot", args, {
    stdio: "ignore",
    shell: false,
    detached: process.platform !== "win32",
    env,
  });
  let exited = false;
  let restored = false;
  const restoreProfile = () => {
    if (restored) return;
    restored = true;
    preparedProfile.restore();
  };
  proc.once("exit", () => { exited = true; restoreProfile(); });

  const signalTree = (signal: NodeJS.Signals) => {
    const pid = proc.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", shell: false });
      } else {
        process.kill(-pid, signal);
      }
    } catch { /* best effort */ }
  };

  return {
    port: p,
    proc,
    stop: async () => {
      try {
        await teardown({
          port: p,
          pid: proc.pid,
          alreadyExited: exited,
          exited: () => new Promise<void>((resolve) => {
            if (exited) resolve();
            else proc.once("exit", () => resolve());
          }),
          signal: signalTree,
          isPortInUse: () => portInUse(p),
        });
      } finally {
        // Restore the eval profile even when teardown fails — the original
        // profile is needed back either way.
        restoreProfile();
      }
    },
  };
}

/** Poll the health endpoint until the game is up (or give up). */
export async function waitForHealth(client: BalatroBotClient, attempts = 40, delayMs = 2000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await client.health();
      return;
    } catch {
      await sleep(delayMs);
    }
  }
  throw new Error("Balatro did not become healthy in time");
}
