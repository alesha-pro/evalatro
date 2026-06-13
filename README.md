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

## Setup

Models play the **real** game, so you assemble a small stack once. Top to bottom:

| # | Piece | What it does |
|---|-------|--------------|
| 1 | **[Balatro](https://store.steampowered.com/app/2379780/Balatro/)** (Steam) | the game itself |
| 2 | **[Lovely](https://github.com/ethangreen-dev/lovely-injector)** | native injector that lets Lua mods load |
| 3 | **[Steamodded](https://github.com/Steamodded/smods)** | the mod framework Lovely loads |
| 4 | **[balatrobot](https://github.com/coder/balatrobot) mod** | exposes the running game over an HTTP/JSON-RPC API |
| 5 | **balatrobot CLI** | launches Balatro with the mod **and** serves the API on `:12346` |
| 6 | **this repo** | the LLM runner + local viewer that drive `:12346` |

> 🤖 **Fast path:** install Balatro from Steam, then run the local setup helper:
>
> ```bash
> npm run setup:local -- --check
> npm run setup:local -- --install
> npm run live -- naive
> ```
>
> It detects your OS, installs the repo/CLI pieces, creates local ignored config files, installs Steamodded,
> installs the balatrobot mod, and installs Lovely when the Balatro game folder exists. It does **not** install
> Balatro, log into Steam, download pirated game files, or write API keys. For agent-assisted setup, hand
> [`SETUP_WITH_AI.md`](SETUP_WITH_AI.md) to an AI agent with shell access.

### 1 · Automated local setup

First install **Balatro through Steam**. Then, from this repo:

```bash
npm run setup:local -- --check     # print detected paths and missing pieces
npm run setup:local -- --install   # install CLI, repo deps, local configs, mods, and Lovely
npm run live -- naive              # smoke test: deterministic baseline, no tokens spent
```

`--install` intentionally stops if Balatro is not installed yet:

```text
Cannot continue:
- Balatro is not installed at ...
```

Install Balatro through Steam first. On Windows, the helper reads Steam's `libraryfolders.vdf` and tries every
Steam library it can find. If detection still misses the game, pass `--game-path "/path/to/Balatro"`.

Useful options:

```bash
npm run setup:local -- --install --game-path "/path/to/Balatro"
npm run setup:local -- --install-mods
npm run setup:local -- --install-lovely
npm run setup:local -- --uninstall
npm run setup:local -- --dry-run
```

`--uninstall` removes the helper-installed pieces: `balatrobot` CLI, local repo outputs (`node_modules`, `dist`,
`.env`, `balatro.config.json`, logs/bench data), Steamodded, balatrobot mod, Lovely files, and Lovely runtime logs.
It does **not** uninstall Balatro itself.

If the smoke test prints `Game over (...)`, the game, Lovely, Steamodded, balatrobot, and this repo are wired
together. Then add a model to `.env`:

```ini
BASE_URL=https://openrouter.ai/api/v1
BASE_KEY=sk-...
MODEL=openai/gpt-4o-mini
MODEL_MODE=tools
```

Run `npm run live` for a real model game. The local viewer is at <http://localhost:3001> while `live`,
`bench --watch`, or `serve` is running.

### 2 · Manual setup: runner + balatrobot CLI

```bash
# balatrobot CLI: install uv (https://docs.astral.sh/uv), then install the CLI ON your PATH —
uv tool install balatrobot     # NOTE: `uvx balatrobot` alone is ephemeral; the runner calls `balatrobot` from PATH
balatrobot --help              # should print usage

# this repo:
npm install
npm run setup                  # builds the runner + the local web viewer (also installs web deps)
cp balatro.config.example.json balatro.config.json
cp .env.example .env           # set BASE_URL / BASE_KEY / MODEL (keys stay on your machine)
```

### 3 · Manual setup: game-side mods

<details>
<summary><b>🪟 Windows</b> — verified</summary>

1. **Lovely** — from the [releases](https://github.com/ethangreen-dev/lovely-injector/releases), put `version.dll` next to `Balatro.exe` in `…\steamapps\common\Balatro\`.
2. **Steamodded** — clone or download it into `%AppData%\Balatro\Mods\smods\`.
3. **balatrobot mod** — place it in `%AppData%\Balatro\Mods\balatrobot\`.
4. Launch Balatro once via Steam — the main menu should show a **Mods** button (that means Lovely is injecting). Close it.
5. Keep `"launchMode": "spawn"` in `balatro.config.json`. The setup helper tries all Steam libraries on Windows; only set `"balatroPath": "D:\\…\\Balatro\\Balatro.exe"` if auto-detection fails.

</details>

<details>
<summary><b>🍎 macOS</b> — verified</summary>

1. **Lovely (macOS build)** — put `liblovely.dylib` and `run_lovely_macos.sh` in `…/steamapps/common/Balatro/`. If Gatekeeper blocks them: `xattr -rd com.apple.quarantine liblovely.dylib run_lovely_macos.sh`.
2. **Steamodded** — `~/Library/Application Support/Balatro/Mods/smods/`.
3. **balatrobot mod** — `~/Library/Application Support/Balatro/Mods/balatrobot/`.
4. Keep `"launchMode": "spawn"`. The runner defaults `balatroPath` to `…/Balatro.app/Contents/MacOS/love` and derives `liblovely.dylib` next to the app — if your binary or dylib live elsewhere, set `balatroPath` / `lovelyPath` explicitly.

</details>

<details>
<summary><b>🐧 Linux — Steam + Proton</b> — experimental, untested</summary>

This repo does **not** launch Balatro under Proton; you start the game yourself and the runner *attaches*.

1. Lovely + mods live **inside the Proton prefix**. Use the **Windows** Lovely `version.dll`, and put the mod folders under
   `~/.local/share/Steam/steamapps/compatdata/2379780/pfx/drive_c/users/steamuser/AppData/Roaming/Balatro/Mods/`
   (`smods/` for Steamodded, `balatrobot/` for the bot mod).
2. Add Lovely to Steam **Launch Options** for Balatro (see the [balatrobot install docs](https://coder.github.io/balatrobot/installation/)).
3. Launch Balatro through Steam with the mods loaded — the API comes up on `:12346`.
4. Set `"launchMode": "attach"` in `balatro.config.json` — the runner connects instead of spawning.

</details>

> Versions the upstreams expect: **Balatro 1.0.1+, Lovely 0.8.0+, Steamodded 1.0.0-beta-1221a+, uv 0.9.21+**. The
> [balatrobot installation guide](https://coder.github.io/balatrobot/installation/) is the source of truth for the game-side stack.

### 4 · Point it at a model

`.env` (gitignored — keys never leave your machine):

```ini
BASE_URL=https://api.deepseek.com/v1
BASE_KEY=sk-...
MODEL=deepseek-v4-flash
MODEL_MODE=tools          # "tools" = function-calling; "json" = JSON-in-content (weak local models)
```

### 5 · Run

```bash
npm run live -- naive       # smoke test: deterministic baseline, no tokens spent
npm run live                # play one game with your .env model; viewer at http://localhost:3001
npm run bench -- --watch    # run the seed × runs matrix and watch it live in the browser
npm run bench               # headless matrix; results → local DB + submission
npm run leaderboard         # print the local leaderboard
```

Both `live` and `bench --watch` start a **local web viewer** and open it automatically (disable with `NO_OPEN=1`); the result still submits to `SUBMIT_URL` at game end.

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

When a game finishes, the runner POSTs the full run to the public Evalatro leaderboard by default:
<https://evalatro-leaderboard.anonymousmaharaj.workers.dev>. Override it with `submitUrl` in config or the
`SUBMIT_URL` env var. `SUBMIT_URL` may be either the site base URL or the full `/api/runs` endpoint.
This is **opt-out**:

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

**Hosting the central site:** the production leaderboard lives in the separate `evalatro-leaderboard` Cloudflare
Worker + D1 project. The local Node server remains for development and local live viewing; community runners
submit finished games to the production `/api/runs` endpoint.

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
