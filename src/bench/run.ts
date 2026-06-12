import * as fs from "fs";
import { loadConfig, envModel, resolveModelConfig, ModelConfig } from "../config.js";
import { makeOpenAiPlayer } from "../llm/openai-adapter.js";
import { maybeSubmit } from "../submit.js";
import { launchBalatro, waitForHealth, sleep } from "../game/launch.js";
import { runGame } from "../game/loop.js";
import { naiveDecide, DecideFn } from "../game/decide.js";
import { BalatroBotClient } from "../client/balatrobot.js";
import { getDb, insertRun, recordMovesToDb } from "./db.js";
import { printLeaderboard } from "./leaderboard.js";
import { startRelay } from "../stream/relay.js";

/**
 * Resolve a player (DecideFn) by name. Only the deterministic naive baseline
 * exists today; cloud and local LLMs plug in here once the OpenAI-compatible
 * adapter lands (next phase). The harness around it stays frozen so we measure
 * the model, not the scaffold.
 */
function resolvePlayer(modelName?: string): { label: string; decide: DecideFn; model: ModelConfig | null } {
  if (modelName === "naive") return { label: "naive", decide: naiveDecide, model: null };
  // No arg → the .env model (BASE_URL/MODEL) if set, else the naive baseline.
  // A name → that preset from balatro.config.json; "env" → force the .env model.
  // resolveModelConfig throws a helpful message if the name/env isn't configured;
  // makeOpenAiPlayer fails fast if the key env var is missing.
  const m = modelName ? resolveModelConfig(modelName) : envModel();
  if (!m) return { label: "naive", decide: naiveDecide, model: null };
  return { label: m.name, decide: makeOpenAiPlayer(m), model: m };
}

async function main() {
  const cfg = loadConfig();
  const args = process.argv.slice(2);
  const modelName = args.find(a => !a.startsWith("--"));
  const watch = args.includes("--watch");

  const { label, decide, model } = resolvePlayer(modelName);
  if (args.includes("--no-submit")) cfg.submit = false;
  if (watch) {
    startRelay(cfg.relayPort);
    console.error(`Watching live at http://localhost:${cfg.relayPort}`);
  }

  const db = getDb();
  recordMovesToDb(db); // persist every move for the per-game history pages
  fs.mkdirSync("logs", { recursive: true });

  console.error(`Benchmark: ${label} · ${cfg.seeds.length} seeds × ${cfg.runsPerSeed} runs/seed`);

  for (const seed of cfg.seeds) {
    for (let k = 0; k < cfg.runsPerSeed; k++) {
      const gameId = `${label}:${seed}:r${k}:${Date.now()}`;
      console.error(`\n→ ${gameId}`);
      const game = launchBalatro(cfg.basePort);
      await sleep(cfg.startupWaitMs);

      const client = new BalatroBotClient({ port: cfg.basePort, timeout: 30_000, retries: 3, retryDelay: 2000 });
      const logStream = fs.createWriteStream(`logs/${label}-${seed}-r${k}.jsonl`, { flags: "w" });
      try {
        await waitForHealth(client);
        // SAME seed across the K runs → isolates the model's own variance.
        const rec = await runGame(decide, { client, model: label, gameId, seed, logStream });
        insertRun(db, rec);
        await maybeSubmit(db, rec, model, cfg);
        console.error(
          `  ante=${rec.maxAnte} actions=${rec.actions} illegal=${rec.illegalActions}` +
          (rec.error ? ` ERROR: ${rec.error}` : ""),
        );
      } catch (e: any) {
        console.error(`  FAILED: ${e.message}`);
      } finally {
        logStream.end();
        game.stop();
        await sleep(3000);
      }
    }
  }

  printLeaderboard(db);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
