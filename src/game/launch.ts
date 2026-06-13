import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { loadConfig } from "../config.js";
import { BalatroBotClient } from "../client/balatrobot.js";

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface GameHandle {
  port: number;
  proc?: ChildProcess;
  stop: () => void;
}

/** Spawn Balatro under balatrobot's CLI on the given port (paths from config). */
export function launchBalatro(port?: number): GameHandle {
  const cfg = loadConfig();
  const p = port ?? cfg.basePort;
  if (cfg.launchMode === "attach") {
    return { port: p, stop: () => {} };
  }

  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === "path") ?? "PATH";
  const pathParts = [cfg.pythonScriptsDir, cfg.userBin, process.env[pathKey]].filter(Boolean);
  const env = { ...process.env, [pathKey]: pathParts.join(path.delimiter) };
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
  proc.once("exit", () => { exited = true; });

  return {
    port: p,
    proc,
    stop: () => {
      if (!proc.pid) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", shell: false });
          return;
        }
        process.kill(-proc.pid, "SIGTERM");
        const timer = setTimeout(() => {
          if (!exited) {
            try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* best effort */ }
          }
        }, 5000);
        timer.unref?.();
      } catch { /* best effort */ }
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
