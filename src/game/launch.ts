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
 */
async function waitForPortFree(port: number, timeoutMs = PORT_FREE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return;
    await sleep(250);
  }
}

export interface GameHandle {
  port: number;
  proc?: ChildProcess;
  /** Resolves once the game process (and its child) is gone. */
  stop: () => Promise<void>;
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
      if (!proc.pid || exited) {
        restoreProfile();
        return;
      }
      // Resolve only once the game is actually gone. The next seed binds the
      // same port, and spawning it while this instance still holds 12346 makes
      // waitForHealth() exhaust its whole retry budget and fail the run.
      const exitedPromise = new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
      });
      signalTree("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!exited) signalTree("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
      await Promise.race([exitedPromise, sleep(STOP_TIMEOUT_MS)]);
      clearTimeout(killTimer);
      restoreProfile();
      // Confirm the socket is actually gone before the caller spawns the next
      // seed. Sleeping a fixed number of seconds is what caused the race.
      await waitForPortFree(p);
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
