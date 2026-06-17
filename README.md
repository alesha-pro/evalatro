# Evalatro

**The open benchmark where language models play real Balatro.**

Evalatro turns Balatro into a repeatable LLM benchmark: models play the actual game through
[balatrobot](https://github.com/coder/balatrobot), every decision is logged, and finished games receive a single
0-100 score that can be compared on a public leaderboard.

**Public leaderboard:** [evalatro.dev](https://evalatro.dev)

![Evalatro hero](assets/evalatro-hero.png)

Language models are getting good at tidy toy tasks. Balatro is not tidy. It is long-horizon planning, partial
information, resource management, tactical card play, build selection, and failure recovery inside a real commercial
game. Evalatro gives models the raw game state and legal actions, then lets them prove whether they can actually play.

[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6)](https://www.typescriptlang.org/)
[![Balatro](https://img.shields.io/badge/game-Balatro-bd1f2d)](https://www.playbalatro.com/)
[![Leaderboard](https://img.shields.io/badge/leaderboard-evalatro.dev-f38020)](https://evalatro.dev)
[![License](https://img.shields.io/badge/license-ISC-green)](package.json)

## Why It Exists

Most agent benchmarks measure whether a model can follow instructions in a synthetic sandbox. Evalatro asks a more
annoying question: can the model survive a messy game where early choices shape the whole run?

- **Real environment:** the model plays the real Balatro executable through the balatrobot API.
- **No strategy rails:** no pre-sorted cards, no hidden hints, no hand-crafted planner.
- **Comparable score:** every game gets a 0-100 score based on progress and illegal moves.
- **Full replay:** decisions, reasoning, states, tokens, cost, and outcome are persisted.
- **Bring any model:** OpenAI-compatible endpoints work, including OpenRouter, OpenAI, DeepSeek, Groq, Ollama, LM Studio, vLLM, and local servers.
- **Public by default:** completed real-model runs submit to the shared leaderboard unless you opt out.

## Quick Start

You need to own and install **Balatro through Steam** first. Evalatro does not install, ship, or pirate the game.

If Node.js/npm are already installed:

```bash
npm run setup:install
npm run live -- naive
```

On a fresh machine without Node.js/npm, use the OS bootstrap first:

```powershell
# Windows PowerShell
powershell -ExecutionPolicy ByPass -File scripts\bootstrap.ps1
```

```bash
# macOS
sh scripts/bootstrap.sh
```

`npm run live -- naive` is a smoke test. It spends no model tokens. If it reaches `Game over (...)`, Balatro, Lovely,
Steamodded, balatrobot, and this runner are wired together.

Then configure a real model in `.env`:

```ini
BASE_URL=https://openrouter.ai/api/v1
BASE_KEY=sk-...
MODEL=openai/gpt-4o-mini
MODEL_MODE=tools
# Optional override; default is 16384.
# MODEL_MAX_TOKENS=16384
# LLM_REQUEST_TIMEOUT_MS=120000
```

Run one live game:

```bash
npm run live
```

The local viewer opens at <http://localhost:3001> while `live`, `bench:watch`, or `serve` is running.

## What Gets Installed

Models play the real game, so the local stack has a few pieces:

| # | Piece | Purpose |
|---|-------|---------|
| 1 | [Balatro](https://store.steampowered.com/app/2379780/Balatro/) | the game itself |
| 2 | [Lovely](https://github.com/ethangreen-dev/lovely-injector) | native injector for Lua mods |
| 3 | [Steamodded](https://github.com/Steamodded/smods) | Balatro mod framework |
| 4 | [balatrobot mod](https://github.com/coder/balatrobot) | exposes the running game over HTTP/JSON-RPC |
| 5 | balatrobot CLI | launches/serves the local game API on `:12346` |
| 6 | this repo | LLM runner, local viewer, scoring, and submission client |

The setup helper can install the repo pieces, mods, and Lovely files. It intentionally cannot install Balatro or log
into Steam.

```bash
npm run setup:install                   # one-command install: CLI deps, repo deps, configs, mods, unlock helper, and Lovely
npm run setup:check                     # print detected paths and missing pieces
npm run setup:uninstall                 # remove helper-installed pieces
node scripts/setup-local.mjs --install        # advanced form: same installer, but with confirmation and extra flags
node scripts/setup-local.mjs --install-mods   # only create/update Steamodded + balatrobot + unlock helper mod folders
node scripts/setup-local.mjs --install-lovely # only install Lovely into the game folder
node scripts/setup-local.mjs --dry-run        # print what would happen
```

On Windows and macOS, `npm run setup:install` also bootstraps `uv` if it is not already on `PATH`, then uses it to
install the persistent `balatrobot` CLI.

If `npm` itself is missing, run `scripts\bootstrap.ps1` on Windows or `scripts/bootstrap.sh` on macOS. The bootstrap
script installs Node.js/npm and Git with the platform package manager, then delegates to `npm run setup:install`.

If Balatro is missing, `--install` stops before doing the rest:

```text
Cannot continue:
- Balatro is not installed at ...
```

On Windows, the helper reads Steam's `libraryfolders.vdf` and tries every Steam library it can find. If detection still
misses your install, pass the game directory or executable explicitly:

```bash
node scripts/setup-local.mjs --install --game-path "D:\\SteamLibrary\\steamapps\\common\\Balatro\\Balatro.exe"
```

`--uninstall` removes the helper-installed pieces: `balatrobot` CLI, local repo outputs (`node_modules`, `dist`,
`.env`, `balatro.config.json`, logs/bench data), Steamodded, the balatrobot mod, the Evalatro unlock helper, Lovely files, and Lovely runtime logs.
It does not uninstall Balatro itself.

`setup:install` also installs a tiny `evalatro_unlock` helper mod. During `spawn` runs, Evalatro temporarily switches
Balatro to a dedicated benchmark profile slot (`evalProfileSlot`, default `2`) and unlocks/discovers all content there.
Your normal profile files are not edited. Set `"evalProfileSlot": 0` to disable this automation.

The unlock helper copies Balatro profile slot `1` as the dedicated slot. You must launch Balatro
once through Steam first so that slot `1` exists; otherwise Evalatro stops with a clear message
telling you to launch the game and rerun.

For agent-assisted setup, hand [`SETUP_WITH_AI.md`](SETUP_WITH_AI.md) to an AI coding agent with shell access.

## Manual Setup

Use this only if the helper cannot install a piece automatically.

### Runner + CLI

```bash
uv tool install balatrobot
balatrobot --help

npm install
npm run setup
cp balatro.config.example.json balatro.config.json
cp .env.example .env
```

`uvx balatrobot` alone is ephemeral. The runner spawns the bare `balatrobot` command from `PATH`, so install it as a
persistent tool.

### Game-Side Mods

<details>
<summary><b>Windows</b> - verified</summary>

1. Put Lovely's `version.dll` next to `Balatro.exe`.
2. Clone or download Steamodded into `%AppData%\Balatro\Mods\smods\`.
3. Place the balatrobot mod in `%AppData%\Balatro\Mods\balatrobot\`.
4. Place the Evalatro unlock helper in `%AppData%\Balatro\Mods\evalatro_unlock\`.
5. Launch Balatro once through Steam. The main menu should show a **Mods** button.
6. Keep `"launchMode": "spawn"` in `balatro.config.json`.

</details>

<details>
<summary><b>macOS</b> - verified</summary>

1. Put Lovely's `liblovely.dylib` and `run_lovely_macos.sh` in `~/Library/Application Support/Steam/steamapps/common/Balatro/`.
2. If Gatekeeper blocks them: `xattr -rd com.apple.quarantine liblovely.dylib run_lovely_macos.sh`.
3. Put Steamodded in `~/Library/Application Support/Balatro/Mods/smods/`.
4. Put the balatrobot mod in `~/Library/Application Support/Balatro/Mods/balatrobot/`.
5. Put the Evalatro unlock helper in `~/Library/Application Support/Balatro/Mods/evalatro_unlock/`.
6. Keep `"launchMode": "spawn"`.

</details>

<details>
<summary><b>Linux + Steam Proton</b> - experimental</summary>

Evalatro does not spawn Balatro under Proton. Start the game yourself and use attach mode.

1. Use the Windows Lovely `version.dll`.
2. Put mods inside the Proton prefix:
   `~/.local/share/Steam/steamapps/compatdata/2379780/pfx/drive_c/users/steamuser/AppData/Roaming/Balatro/Mods/`
3. Configure Lovely through Balatro's Steam launch options.
4. Set `"launchMode": "attach"` in `balatro.config.json`.

</details>

Upstream source of truth: the [balatrobot installation guide](https://coder.github.io/balatrobot/installation/).

## Running Games

```bash
npm run live -- naive       # deterministic smoke test, no tokens spent
npm run live                # one game with the .env model
npm run bench:watch         # seed matrix with live browser view
npm run bench               # headless seed matrix
npm run bench -- naive      # deterministic baseline matrix, no tokens spent
npm run bench:watch -- naive # baseline matrix with live browser view
npm run leaderboard         # print the local leaderboard
```

`npm run live`, `npm run bench`, and `npm run bench:watch` use `BASE_URL`, `BASE_KEY`, `MODEL`, `MODEL_MODE`,
and optional model knobs like `MODEL_MAX_TOKENS` or `LLM_REQUEST_TIMEOUT_MS` from `.env` when no model name is
passed. The default per-turn output limit is 16384 tokens; tools mode retries text-only answers with a required
tool call and gracefully drops provider fields such as `tool_choice` or `response_format` when an OpenAI-compatible
server rejects them. If `.env` has no active model settings, real-model commands stop instead of silently falling
back to `naive`.

Add named model presets in `balatro.config.json`, then run:

```bash
npm run bench -- <model-name>
npm run bench:watch -- <model-name>
npm run live -- <model-name>
```

Use `npm run bench:watch` for the live benchmark viewer. Avoid `npm run bench -- --watch` on Windows because some
npm/PowerShell combinations do not forward that flag reliably.

## Scoring

Evalatro v2 targets **clearing Ante 12**. The base game win at Ante 8 is only a milestone; it is not a benchmark win.
The runner stops as soon as the model advances past Ante 12, so a clean target clear is exactly 100.

```text
progress = ladder position / (targetAnte * 3) + partial chip credit on the losing blind
legality = 1 - illegalMoves / totalMoves
score    = round(progress * legality * 100, 1)
```

Only a target-ante clear can score 100. Illegal moves reduce the score. A model's leaderboard number is the mean score over
scored games: `won`, `lost`, and `stuck`. Provider errors and explicit caps are excluded as infrastructure failures.

The scorer lives in [`src/scoring/score.ts`](src/scoring/score.ts) and is used twice:

- locally, so your runner can show a score immediately;
- server-side, so submitted runs are recomputed from the transcript instead of trusting the client.

## Submitting And Privacy

Finished real-model games submit to the public leaderboard by default:

<https://evalatro.dev>

Opt out:

```powershell
$env:SUBMIT="false"; npm run bench
```

```bash
SUBMIT=false npm run bench
```

Override the destination:

```powershell
$env:SUBMIT_URL="https://your-leaderboard.example"; npm run bench
```

```bash
SUBMIT_URL=https://your-leaderboard.example npm run bench
```

What is sent:

- move-by-move state snapshots;
- model reasoning and chosen actions;
- token and cost totals;
- public model id and provider host, such as `openrouter.ai`;
- eval version and code hash.

What is never sent:

- API keys;
- the full base URL;
- local `.env` contents.

This is a best-effort community leaderboard, not anti-cheat. The server recomputes the score, rejects impossible
transcripts, dedupes stable run hashes, and tags known unmodified releases as **official**. Modified or unknown builds
are **community**.

At release time, run:

```bash
npm run codehash
```

Then add the printed hash to [`src/server/known-hashes.ts`](src/server/known-hashes.ts).

## Local Web UI

The local UI is a Vite + React app in [`web/`](web/), served by the Node backend.

```bash
npm run serve     # API + built web app on :3001
npm run web:dev   # Vite dev server with proxy on :5173
```

Pages:

- **Leaderboard:** ranked model table;
- **Model:** model history and score distribution;
- **Game:** full replay with board state and reasoning chain;
- **Live:** current run over SSE, with `/live?demo=1` for a sample;
- **About:** public explanation of the benchmark.

The production leaderboard is a separate Cloudflare Workers + D1 project: `evalatro-leaderboard`. This repo remains
the local runner and development UI.

## MCP Mode

The same tool registry can run as an MCP server:

```bash
npm run mcp
```

That lets a local AI assistant drive Balatro interactively over stdio. The LLM runner and MCP server share
[`src/tools/registry.ts`](src/tools/registry.ts), so the action surface stays in sync.

## Project Layout

```text
src/
  agent/               system prompt and player loop
  bench/               SQLite storage, leaderboard, matrix runner
  client/              balatrobot HTTP client
  game/                launch, decision, and run loop
  llm/                 OpenAI-compatible adapter and tests
  scoring/             0-100 metric and release code hash
  server/              submission schema, recompute, integrity checks
  state/               raw game state summarizer
  stream/              SSE relay, REST API, static web host
  tools/               action registry shared by LLM and MCP
  config.ts            config and .env loader
  submit.ts            runner to leaderboard submission client
web/                   Vite + React local UI
scripts/               setup helper and setup tests
assets/                README and documentation assets
```

## Development

```bash
npm run build
npm test
npm run test:setup
npm run test:adapter
npm run test:score
```

## Credits

Built on [coder/balatrobot](https://github.com/coder/balatrobot), [Lovely](https://github.com/ethangreen-dev/lovely-injector),
and [Steamodded](https://github.com/Steamodded/smods).

Balatro is © LocalThunk. Evalatro is an educational and research tool. It ships no game code.
