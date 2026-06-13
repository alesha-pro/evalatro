import { loadConfig, envModel, resolveModelConfig, ModelConfig } from "./config.js";
import { maybeSubmit } from "./submit.js";
import { openBrowser } from "./web-open.js";
import { startRelay } from "./stream/relay.js";
import { launchBalatro, waitForHealth, sleep } from "./game/launch.js";
import { runGame } from "./game/loop.js";
import { naiveDecide } from "./game/decide.js";
import { makeOpenAiPlayer } from "./llm/openai-adapter.js";
import { getDb, insertRun, recordMovesToDb } from "./bench/db.js";
import { BalatroBotClient } from "./client/balatrobot.js";

/**
 * Watch a single game live in the browser. Starts the relay, launches Balatro,
 * and plays one naive run, streaming state + reasoning to web/index.html.
 * Open http://localhost:<relayPort>.
 */
async function main() {
  const cfg = loadConfig();
  startRelay(cfg.relayPort);
  console.error(`Open http://localhost:${cfg.relayPort}`);
  openBrowser(`http://localhost:${cfg.relayPort}`);

  const db = getDb();
  recordMovesToDb(db); // persist every move for the per-game history pages

  const game = launchBalatro(cfg.basePort);
  if (cfg.launchMode !== "attach") await sleep(cfg.startupWaitMs);

  const client = new BalatroBotClient({ port: cfg.basePort, timeout: 30_000, retries: 3 });
  await waitForHealth(client);

  // `npm run live` → the .env model (BASE_URL/MODEL); `-- naive` → baseline;
  // `-- <name>` → a preset from balatro.config.json.
  const arg = process.argv.slice(2).find(a => !a.startsWith("--"));
  if (process.argv.includes("--no-submit")) cfg.submit = false;
  let decide = naiveDecide;
  let label = "naive";
  let model: ModelConfig | null = null;
  if (arg !== "naive") {
    const m = arg ? resolveModelConfig(arg) : envModel();
    if (m) {
      decide = makeOpenAiPlayer(m);
      label = m.name;
      model = m;
      console.error(`Player: ${label} (${m.model} @ ${m.baseURL})`);
    }
  }

  const seed = process.env.SEED || cfg.seeds[0] || "LIVE";
  const gameId = `live-${Date.now()}`;
  const rec = await runGame(decide, { client, model: label, gameId, seed });
  insertRun(db, rec, "live"); // count this game in the leaderboard (if it completed)
  await maybeSubmit(db, rec, model, cfg);
  console.error(`Game over (${rec.outcome}): ${label} reached ante ${rec.maxAnte}. Leaderboard → http://localhost:${cfg.relayPort}/leaderboard.html · Ctrl+C to exit.`);
  game.stop();
}

main().catch((e) => console.error(e));
