import { spawn, ChildProcess } from "child_process";
import { loadConfig } from "../config.js";
import { BalatroBotClient } from "../client/balatrobot.js";

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface GameHandle {
  port: number;
  proc: ChildProcess;
  stop: () => void;
}

/** Spawn Balatro under balatrobot's CLI on the given port (paths from config). */
export function launchBalatro(port?: number): GameHandle {
  const cfg = loadConfig();
  const p = port ?? cfg.basePort;
  const env = { ...process.env, PATH: `${cfg.pythonScriptsDir};${cfg.userBin};${process.env.PATH}` };
  const proc = spawn(
    "balatrobot",
    [
      "serve", "--fast",
      "--port", String(p),
      "--love-path", cfg.balatroPath,
      "--lovely-path", cfg.lovelyPath,
      "--no-shaders",
      "--logs-path", "logs",
    ],
    { stdio: "ignore", shell: true, env },
  );
  return {
    port: p,
    proc,
    stop: () => {
      try {
        spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", shell: true });
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
