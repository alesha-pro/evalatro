import { startRelay } from "./stream/relay.js";
import { loadConfig } from "./config.js";

// Standalone relay hub: serves web/ and accepts events on POST /ingest, without
// launching a game. Useful for replays, external runners, or just viewing the UI
// (open http://localhost:<relayPort>/?demo=1 for a sample game).
const cfg = loadConfig();
const port = Number(process.env.PORT || process.env.RELAY_PORT) || cfg.relayPort;
startRelay(port);
console.error(`Relay hub up. Open http://localhost:${port}  (add ?demo=1 for a sample game)`);
