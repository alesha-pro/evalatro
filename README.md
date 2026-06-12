# Balatro × LLM — a benchmark where models play real Balatro

Language models play **actual [Balatro](https://www.playbalatro.com/)** — the real game, driven through
[balatrobot](https://github.com/coder/balatrobot)'s HTTP API — and get a single **0–100 score**. This repo is
both the **runner** you download and run, and the **leaderboard site** that collects results.

It's a *clean* eval: the model plays from the same raw state a human sees. No strategy hints, no pre-sorted
cards, no comprehension aids. It's told the rules and the tools; the rest is on the model.

- 🎯 **One number, 0–100.** 100 = won all 8 antes with zero illegal moves. (See [Scoring](#scoring).)
- 🌐 **Any OpenAI-compatible model**, cloud or local — OpenRouter, OpenAI, DeepSeek, Groq, Ollama, LM Studio, vLLM…
- 📺 **Live view + full replays** — watch a model play, or step through any past game move-by-move with its reasoning.
- 🏆 **Shared leaderboard** — finished games are submitted to a central site (opt-out, see [Submitting](#submitting--privacy)).

---

## Quick start

**Prerequisites:** Balatro (Steam) + [Lovely](https://github.com/ethangreen-dev/lovely-injector) +
[Steamodded](https://github.com/Steamodded/smods) + [balatrobot](https://github.com/coder/balatrobot) installed and on PATH.
Then:

```bash
npm install
npm run build

cp balatro.config.example.json balatro.config.json   # set balatroPath
```

Point it at a model via `.env` (gitignored — keys never leave your machine):

```ini
BASE_URL=https://api.deepseek.com/v1
BASE_KEY=sk-...
MODEL=deepseek-v4-flash
MODEL_MODE=tools          # "tools" = function-calling; "json" = JSON-in-content (weak local models)
```

Run a benchmark (matrix of seeds × runs from the config), or watch one game live:

```bash
npm run bench               # uses the .env model; results → SQLite + (optional) submission
npm run bench -- naive      # deterministic baseline, no tokens spent
npm run live                # play one game, watch at http://localhost:3001
npm run leaderboard         # print the local leaderboard
```

> Add more models as named presets in `balatro.config.json` and run `npm run bench -- <name>`.

---

## Scoring

A standard run is **8 antes × 3 blinds** (Small / Big / Boss) = a **24-blind ladder**; winning = beating the
Ante 8 Boss. Per game:

```
progress = ladder position / 24      (+ partial credit for chips on the blind you died on)
legality = 1 − illegalMoves / totalMoves
score    = round(progress × legality × 100, 1)
```

A flawless ante-8 win is exactly **100**; any illegal move on a win drops it below 100, and only a real win
can show 100. A model's leaderboard number is the **mean ± stdev** over its **scored games** (won / lost /
stuck — a model that loops itself into a stuck state genuinely failed). Infra failures (provider errors) are
excluded. Endless mode (ante 9+) is out of scope (only the default jokers exist).

The scorer is one pure module — [`src/scoring/score.ts`](src/scoring/score.ts) — used by both the runner (to show
you a local score) and the server (which **recomputes** it authoritatively from the transcript). `npm run test:score`.

---

## Submitting & privacy

When a game finishes, the runner POSTs the full run to the leaderboard backend (`submitUrl` in config, or the
`SUBMIT_URL` env var). This is **opt-out**:

```bash
SUBMIT=false npm run bench        # or:
npm run bench -- --no-submit
```

**What is sent:** the move-by-move transcript (each state + the model's reasoning), token/cost totals, your
model id and the provider **host** (e.g. `openrouter.ai`), eval version, a code hash, and an optional handle.
**What is never sent:** your API key, or the full base URL.

**Trust model (best-effort, no accounts).** An open-source client can't be made tamper-proof, so:

- The server **recomputes the score from the transcript** and rejects inconsistent runs (non-monotonic antes,
  moves marked legal that aren't, impossible wins).
- Runs from an unmodified release are tagged **official** (the code hash matches a known release); modified or
  local builds are **community**. Treat *community* as unverified.

At release time, run `npm run codehash` and add the printed hash to
[`src/server/known-hashes.ts`](src/server/known-hashes.ts) so official runs are recognized.

---

## The site (leaderboard + live)

A Vite + React app in [`web/`](web/), served by the Node backend.

```bash
# development (two terminals): API on :3001, Vite (with proxy) on :5173
npm run serve
npm run web:dev

# production: build the SPA, then the backend serves web/dist + the API on :3001
npm run web:build
npm run serve
```

Pages: **Leaderboard** (ranked by score), **Model** (a model's games + score distribution), **Game** (full
replay with the schematic board + chain of thought), **Live** (SSE; `/live?demo=1` for a sample), **About**.

**Hosting the central site:** deploy the Node server with its own DB (`BENCH_DB=/data/bench.db`). To accept live
streaming on the public `/ingest`, set `INGEST_KEY` and have the host runner send it via `liveIngestKey`/
`liveIngestUrl`. Community runners submit at game-end only.

---

## MCP mode

The same tool registry powers an MCP server, so you can let your own AI assistant (Claude Desktop, Cursor, …)
drive Balatro interactively: `npm run mcp` (stdio). Both paths read [`src/tools/registry.ts`](src/tools/registry.ts),
so the action surface never drifts.

---

## Layout

```
src/
  config.ts             config + .env loader
  client/balatrobot.ts  HTTP client for the game API
  state/summarizer.ts   raw game state → compact, fog-of-war-masked snapshot
  tools/registry.ts     single source of truth for the action surface (MCP + LLM)
  llm/openai-adapter.ts OpenAI-compatible player (cloud + local)
  game/loop.ts          the one game driver (drives a run, emits events, scores it)
  scoring/score.ts      the 0–100 metric (shared by runner + server)
  scoring/codehash.ts   release integrity hash
  server/               submission endpoint: schema, scoring recompute, integrity
  bench/                SQLite + leaderboard + matrix runner
  stream/relay.ts       SSE hub + REST API + static SPA host
  submit.ts             runner → backend submission client
  agent/SYSTEM_PROMPT.md the prompt: rules + interface, no strategy
web/                    Vite + React leaderboard / live / replay app
```

Built on [coder/balatrobot](https://github.com/coder/balatrobot). Balatro is © LocalThunk — this is an
educational/research tool and ships no game code.
