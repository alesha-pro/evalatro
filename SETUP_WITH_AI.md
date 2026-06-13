# Set up the Balatro × LLM benchmark — a guide for an AI agent

**You (the human):** paste this entire file to an AI coding agent that can run shell commands on your machine
(Claude Code, Cursor, Cline, a Copilot agent, …) and tell it: *"Read this and set everything up."*
Have ready: a Steam account that owns **Balatro**, and an API key for the model you want to test.

---

## Agent: your mission

Set up the full local environment for **this repository** until `npm run live -- naive` plays one game end to end.
There are 6 pieces (a game + 3 mods + a CLI + this repo). Install/verify each **in order**, confirm it works before
moving on, and **stop to ask the user** whenever a step needs them (Steam login, a download choice, sudo, the API key).

### Rules of engagement
1. **Detect the OS first** and follow only that platform's branch in Step 2.
2. **Fetch the current official docs** (links below) instead of trusting your training data — these tools move fast and your knowledge may be stale.
3. **Never write secrets into tracked files.** API keys go only in `.env` (gitignored). Never commit `.env` or `balatro.config.json`.
4. **This repo ships no game files.** The user must own Balatro on Steam; do not try to download or pirate the game.
5. **Verify, don't assume.** Run the check command after each step and report the real output. If something fails, diagnose it — don't claim success you didn't observe.
6. Do not run `sudo` or touch anything outside this project and the Balatro `Mods/` folder without asking first.

### The stack you're assembling
| # | Piece | Role | Lives in |
|---|-------|------|----------|
| 1 | Balatro (Steam) | the game | Steam library |
| 2 | Lovely Injector | native injector that loads Lua mods | next to the game binary |
| 3 | Steamodded | mod framework | `…/Balatro/Mods/Steamodded/` |
| 4 | balatrobot **mod** | exposes the game over HTTP/JSON-RPC | `…/Balatro/Mods/balatrobot/` |
| 5 | balatrobot **CLI** | launches the game with the mod + serves the API on `:12346` | your `PATH` |
| 6 | this repo | LLM runner + local viewer | here |

### Official docs — consult the live versions
- balatrobot install: <https://coder.github.io/balatrobot/installation/>
- balatrobot CLI: <https://coder.github.io/balatrobot/cli/>
- Lovely Injector: <https://github.com/ethangreen-dev/lovely-injector>
- Steamodded: <https://github.com/Steamodded/smods/wiki>

---

## Step 0 · Environment check

Run and report:
```bash
node -v          # need 20+
npm -v
git --version
uv --version     # if missing, install uv first: https://docs.astral.sh/uv/getting-started/installation/
```
Identify the OS and find the Balatro game directory:
- **Windows:** `…\steamapps\common\Balatro\` (next to `Balatro.exe`)
- **macOS:** `~/Library/Application Support/Steam/steamapps/common/Balatro/` (contains `Balatro.app`)
- **Linux:** under the Steam library; the game runs via Proton.

If you can't locate the game directory, ask the user where Balatro is installed.

## Step 1 · balatrobot CLI on PATH

```bash
uv tool install balatrobot
balatrobot --help            # must print usage
```
⚠️ The runner spawns the **bare command `balatrobot`** from PATH. `uvx balatrobot` alone runs ephemerally and will
**not** be found — install it as a persistent tool (above) or via `pipx install balatrobot`. If `balatrobot --help`
fails, fix PATH before continuing (don't move on with a broken CLI).

## Step 2 · Game-side mods — follow ONLY your platform

First fetch <https://coder.github.io/balatrobot/installation/> for the current versions and exact file names.
Order matters: **Lovely → Steamodded → balatrobot mod.**

### 🪟 Windows
1. **Lovely:** download the Windows build from the [releases](https://github.com/ethangreen-dev/lovely-injector/releases); put `version.dll` in the game dir next to `Balatro.exe`.
2. **Steamodded:** download/clone into `%AppData%\Balatro\Mods\Steamodded\`.
3. **balatrobot mod:** install into `%AppData%\Balatro\Mods\balatrobot\` (per the install doc).
4. **Verify:** launch Balatro via Steam once — the main menu should show a **Mods** button. Close the game.
5. If Balatro lives in a non-default Steam library, record the full `Balatro.exe` path for Step 4.

### 🍎 macOS
1. **Lovely (macOS build):** place `liblovely.dylib` and `run_lovely_macos.sh` in `…/steamapps/common/Balatro/`.
   If macOS quarantines them: `xattr -rd com.apple.quarantine liblovely.dylib run_lovely_macos.sh`.
2. **Steamodded:** `~/Library/Application Support/Balatro/Mods/Steamodded/`.
3. **balatrobot mod:** `~/Library/Application Support/Balatro/Mods/balatrobot/`.
4. **Verify the game binary name:** `ls "…/steamapps/common/Balatro/Balatro.app/Contents/MacOS/"`.
   The runner defaults to a binary named `love` there — if it's named differently (e.g. `Balatro`), record the real path for Step 4.

### 🐧 Linux (Steam + Proton) — experimental, unverified
The runner does **not** spawn the game under Proton; the user launches it and the runner attaches.
1. Mods + the **Windows** Lovely `version.dll` go **inside the Proton prefix**:
   `~/.local/share/Steam/steamapps/compatdata/2379780/pfx/drive_c/users/steamuser/AppData/Roaming/Balatro/Mods/`.
2. Configure Lovely via the Balatro **Launch Options** in Steam (see the install doc).
3. Have the user launch Balatro through Steam with the mods loaded, then confirm the API is up:
   ```bash
   curl -s -X POST http://127.0.0.1:12346 -d '{"jsonrpc":"2.0","method":"health","id":1}'
   ```
4. In Step 4, set `"launchMode": "attach"` (not `"spawn"`).

## Step 3 · This repo

```bash
npm install
npm run setup     # builds the runner + the local web viewer
npm test          # expect "20 passed, 0 failed"
```

## Step 4 · Configure

1. `cp balatro.config.example.json balatro.config.json`, then edit:
   - `"launchMode"` → `"spawn"` (Windows/macOS) or `"attach"` (Linux/Proton).
   - Only if auto-detect failed: set `"balatroPath"` (and `"lovelyPath"`) to the paths you recorded in Step 2.
2. `cp .env.example .env`, then **ask the user** for these and write them into `.env` only:
   - `BASE_URL` — e.g. `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`, or a local `http://localhost:11434/v1`
   - `BASE_KEY` — their API key (paste into `.env`, never anywhere tracked)
   - `MODEL` — the provider's model id
   - `MODEL_MODE` — `tools` for capable models, `json` for weak/local ones

## Step 5 · End-to-end verification

```bash
npm run live -- naive
```
Expected: balatrobot launches Balatro (spawn mode) or connects (attach mode) → health becomes OK →
one deterministic game plays → `Game over (...)` prints. **No API tokens are spent** on `naive`.
If that works, try the real model with `npm run live` and confirm the local viewer opens at <http://localhost:3001>.

### If it hangs or fails
- **`balatrobot: command not found`** → Step 1 (PATH).
- **"Balatro did not become healthy in time"** → the mod isn't loading. Confirm the `balatrobot` mod folder is in `Mods/`, Lovely is injecting (the **Mods** button is visible in-game), and nothing else is using port `12346`. On a non-default Steam library, set `balatroPath`.
- **macOS: spawn fails / game never starts** → wrong binary name; fix `balatroPath` (Step 2.4) and `lovelyPath`.
- **Linux** → you must use `"launchMode": "attach"` and launch the game yourself first.

## When you're done

Report to the user: the OS detected, versions of node / uv / balatrobot, where each mod was installed, the config
you wrote (with the API key **redacted**), and the exact output of `npm run live -- naive`.
