import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export const SMODS_REPO = "https://github.com/Steamodded/smods.git";
export const BALATROBOT_REPO = "https://github.com/coder/balatrobot.git";
export const LOVELY_RELEASE_BASE = "https://github.com/ethangreen-dev/lovely-injector/releases/latest/download";
export const UV_INSTALL_PS1 = "https://astral.sh/uv/install.ps1";
export const UV_INSTALL_SH = "https://astral.sh/uv/install.sh";

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function joinFor(platform, ...parts) {
  return pathApi(platform).join(...parts);
}

function pathEnvKey() {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function userLocalBin(platform, home) {
  return joinFor(platform, home, ".local", "bin");
}

function prependToPath(dir) {
  const key = pathEnvKey();
  const current = process.env[key] ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const parts = current.split(delimiter).filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === dir.toLowerCase())) {
    process.env[key] = [dir, ...parts].join(delimiter);
  }
}

function resolveLocalCommand(name) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return "";
  const bin = userLocalBin(process.platform, home);
  const candidates = process.platform === "win32"
    ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
    : [name];
  for (const candidate of candidates) {
    const target = path.join(bin, candidate);
    if (fs.existsSync(target)) return target;
  }
  return "";
}

function decodeSteamVdfString(value) {
  return value
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

export function parseSteamLibraryFoldersVdf(text) {
  const libraries = [];
  const seen = new Set();
  const add = (value) => {
    const decoded = decodeSteamVdfString(value).trim();
    const key = decoded.toLowerCase();
    if (decoded && !seen.has(key)) {
      seen.add(key);
      libraries.push(decoded);
    }
  };

  for (const match of text.matchAll(/"path"\s+"((?:\\.|[^"\\])*)"/gi)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/^\s*"\d+"\s+"((?:\\.|[^"\\])*)"\s*$/gm)) {
    add(match[1]);
  }
  return libraries;
}

function windowsSteamRoots(env) {
  return [
    ...(env.steamRoots ?? []),
    env.steamPath,
    process.env.STEAM_PATH,
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
  ].filter(Boolean);
}

function discoverWindowsBalatroGameDir(env) {
  const api = path.win32;
  const exists = env.exists ?? fs.existsSync;
  const readFileSync = env.readFileSync ?? ((target) => fs.readFileSync(target, "utf8"));
  const defaultSteamRoot = "C:\\Program Files (x86)\\Steam";
  const libraries = [];
  const seen = new Set();
  const addLibrary = (target) => {
    const normalized = api.normalize(target);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      libraries.push(normalized);
    }
  };

  for (const root of windowsSteamRoots(env)) {
    addLibrary(root);
    const vdfPath = api.join(root, "steamapps", "libraryfolders.vdf");
    if (!exists(vdfPath)) continue;
    try {
      for (const library of parseSteamLibraryFoldersVdf(readFileSync(vdfPath))) {
        addLibrary(library);
      }
    } catch {
      // Broken or unreadable Steam metadata should not prevent manual --game-path use.
    }
  }

  for (const library of libraries) {
    const gameDir = api.join(library, "steamapps", "common", "Balatro");
    if (exists(gameDir) || exists(api.join(gameDir, "Balatro.exe"))) return gameDir;
  }

  return api.join(defaultSteamRoot, "steamapps", "common", "Balatro");
}

function withGamePath(layout, platform, gamePath) {
  if (!gamePath) return layout;
  const api = pathApi(platform);
  const normalized = api.normalize(gamePath);
  const lower = normalized.toLowerCase();
  if (platform === "darwin") {
    const gameDir = lower.endsWith("balatro.app")
      ? api.dirname(normalized)
      : lower.endsWith(api.join("contents", "macos", "love"))
        ? api.resolve(normalized, "..", "..", "..", "..")
        : normalized;
    return {
      ...layout,
      gameDir,
      gameExecutable: api.join(gameDir, "Balatro.app", "Contents", "MacOS", "love"),
      lovelyDir: gameDir,
    };
  }
  if (platform === "win32") {
    const gameDir = lower.endsWith("balatro.exe") ? api.dirname(normalized) : normalized;
    return {
      ...layout,
      gameDir,
      gameExecutable: api.join(gameDir, "Balatro.exe"),
      lovelyDir: gameDir,
    };
  }
  return { ...layout, gameDir: normalized, gameExecutable: normalized, lovelyDir: normalized };
}

export function defaultLayout(env = {}) {
  const platform = env.platform ?? process.platform;
  const home = env.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const arch = env.arch ?? process.arch;
  const appData = env.appData ?? process.env.APPDATA ?? joinFor(platform, home, "AppData", "Roaming");

  if (platform === "darwin") {
    const gameDir = joinFor(platform, home, "Library", "Application Support", "Steam", "steamapps", "common", "Balatro");
    const modsDir = joinFor(platform, home, "Library", "Application Support", "Balatro", "Mods");
    return {
      platform,
      platformLabel: `macOS ${arch}`,
      gameDir,
      gameExecutable: joinFor(platform, gameDir, "Balatro.app", "Contents", "MacOS", "love"),
      modsDir,
      smodsDir: joinFor(platform, modsDir, "smods"),
      balatrobotModDir: joinFor(platform, modsDir, "balatrobot"),
      lovelyDir: gameDir,
      lovelyFiles: ["liblovely.dylib", "run_lovely_macos.sh"],
      launchMode: "spawn",
    };
  }

  if (platform === "win32") {
    const gameDir = discoverWindowsBalatroGameDir(env);
    const modsDir = joinFor(platform, appData, "Balatro", "Mods");
    return {
      platform,
      platformLabel: "Windows",
      gameDir,
      gameExecutable: joinFor(platform, gameDir, "Balatro.exe"),
      modsDir,
      smodsDir: joinFor(platform, modsDir, "smods"),
      balatrobotModDir: joinFor(platform, modsDir, "balatrobot"),
      lovelyDir: gameDir,
      lovelyFiles: ["version.dll"],
      launchMode: "spawn",
    };
  }

  const gameDir = joinFor(platform, home, ".local", "share", "Steam", "steamapps", "common", "Balatro");
  const modsDir = joinFor(
    platform,
    home,
    ".local",
    "share",
    "Steam",
    "steamapps",
    "compatdata",
    "2379780",
    "pfx",
    "drive_c",
    "users",
    "steamuser",
    "AppData",
    "Roaming",
    "Balatro",
    "Mods",
  );
  return {
    platform,
    platformLabel: `Linux ${arch}`,
    gameDir,
    gameExecutable: "",
    modsDir,
    smodsDir: joinFor(platform, modsDir, "smods"),
    balatrobotModDir: joinFor(platform, modsDir, "balatrobot"),
    lovelyDir: gameDir,
    lovelyFiles: ["version.dll"],
    launchMode: "attach",
  };
}

export function parseArgs(argv) {
  const options = {
    mode: "check",
    dryRun: false,
    yes: false,
    skipNpm: false,
    gamePath: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--check") options.mode = "check";
    else if (arg === "--install") options.mode = "install";
    else if (arg === "--install-mods") options.mode = "install-mods";
    else if (arg === "--install-lovely") options.mode = "install-lovely";
    else if (arg === "--uninstall") options.mode = "uninstall";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--skip-npm") options.skipNpm = true;
    else if (arg === "--game-path") {
      i++;
      if (!argv[i]) throw new Error("--game-path requires a path");
      options.gamePath = argv[i];
    } else if (arg === "--help" || arg === "-h") {
      options.mode = "help";
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function commandExists(name) {
  const result = process.platform === "win32"
    ? childProcess.spawnSync("where", [name], { stdio: "ignore", shell: false })
    : childProcess.spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore", shell: false });
  return result.status === 0 || !!resolveLocalCommand(name);
}

export function lovelyAssetFor(layout) {
  if (layout.platform === "darwin") {
    const name = layout.platformLabel.includes("arm64")
      ? "lovely-aarch64-apple-darwin.tar.gz"
      : "lovely-x86_64-apple-darwin.tar.gz";
    return { name, kind: "tar", files: ["liblovely.dylib", "run_lovely_macos.sh"] };
  }
  if (layout.platform === "win32") {
    return { name: "lovely-x86_64-pc-windows-msvc.zip", kind: "zip", files: ["version.dll"] };
  }
  return { name: "lovely-x86_64-pc-windows-msvc.zip", kind: "zip", files: ["version.dll"] };
}

export function buildSetupPlan({ options, layout, exists = fs.existsSync, commandExists: hasCommand = commandExists }) {
  const effectiveLayout = withGamePath(layout, layout.platform, options.gamePath);
  const missingCommands = ["node", "npm", "git", "uv"].filter((name) => !hasCommand(name));
  const missingRequiredCommands = ["node", "npm", "git"].filter((name) => !hasCommand(name));
  const uvMissing = missingCommands.includes("uv");
  const gameExists = exists(effectiveLayout.gameDir) || exists(effectiveLayout.gameExecutable);
  const modsExists = exists(effectiveLayout.modsDir);
  const requiresGame = options.mode === "install" || options.mode === "install-lovely";

  const blockers = [];
  const warnings = [];
  if (missingRequiredCommands.length) warnings.push(`Missing required commands: ${missingRequiredCommands.join(", ")}`);
  if (uvMissing && options.mode !== "uninstall") {
    warnings.push("uv is not on PATH; --install will bootstrap it with the official Astral installer.");
  }
  if (!gameExists && options.mode !== "uninstall") {
    const message = `Balatro is not installed at ${effectiveLayout.gameDir}. Install Balatro through Steam first, or pass --game-path if Steam library auto-detection missed it.`;
    if (requiresGame) blockers.push(message);
    else warnings.push(message);
  }
  if (effectiveLayout.platform === "linux") {
    warnings.push("Linux uses attach mode: launch Balatro through Steam/Proton yourself before running npm run live.");
  }

  const steps = [];
  if (options.mode === "uninstall") {
    if (!missingCommands.includes("uv")) {
      steps.push({ title: "Uninstall balatrobot CLI", commands: [["uv", "tool", "uninstall", "balatrobot"]] });
    }
    steps.push({ title: "Remove local repo outputs", commands: [] });
    steps.push({ title: "Remove game-side mod folders", commands: [] });
    steps.push({ title: "Remove Lovely Injector files", commands: [] });
  }
  if (uvMissing && options.mode === "install" && !blockers.length) {
    steps.push({ title: "Install uv", commands: [] });
  }
  if (options.mode !== "install-mods" && options.mode !== "install-lovely" && options.mode !== "uninstall" && !blockers.length) {
    steps.push({ title: "Install balatrobot CLI", commands: [["uv", "tool", "install", "balatrobot"]] });
  }
  if (options.mode !== "install-mods" && options.mode !== "install-lovely" && options.mode !== "uninstall" && !blockers.length) {
    steps.push({ title: "Create local ignored config files", commands: [] });
  }
  if (!options.skipNpm && options.mode !== "install-mods" && options.mode !== "install-lovely" && options.mode !== "uninstall" && !blockers.length) {
    steps.push({
      title: "Install and verify this repo",
      commands: [
        ["npm", "install"],
        ["npm", "run", "setup"],
        ["npm", "test"],
      ],
    });
  }
  if (options.mode !== "install-lovely" && options.mode !== "uninstall" && !blockers.length) {
    steps.push({
      title: "Install Steamodded and balatrobot mods",
      commands: [
        ["git", "clone", "--depth", "1", SMODS_REPO, effectiveLayout.smodsDir],
        ["git", "clone", "--depth", "1", BALATROBOT_REPO, effectiveLayout.balatrobotModDir],
      ],
    });
  }
  if (options.mode !== "install-mods" && options.mode !== "uninstall" && !blockers.length) {
    const asset = lovelyAssetFor(effectiveLayout);
    steps.push({
      title: gameExists ? "Install Lovely Injector" : "Install Lovely Injector manually",
      commands: gameExists ? [["curl", "-L", `${LOVELY_RELEASE_BASE}/${asset.name}`]] : [],
      note: gameExists
        ? `Download ${asset.name} and place ${effectiveLayout.lovelyFiles.join(", ")} in ${effectiveLayout.lovelyDir}.`
        : `Install Balatro first, then place ${effectiveLayout.lovelyFiles.join(", ")} in ${effectiveLayout.lovelyDir}.`,
    });
  }

  return {
    layout: effectiveLayout,
    missingCommands,
    missingRequiredCommands,
    uvMissing,
    blockers,
    warnings,
    steps,
    canInstallRepo: missingRequiredCommands.length === 0,
    canInstallMods: !missingCommands.includes("git") && (modsExists || options.mode !== "check"),
    canInstallLovely: gameExists,
  };
}

export function ensureLocalFiles({ repoRoot, write, layout }) {
  const created = [];
  const skipped = [];
  const configPath = path.join(repoRoot, "balatro.config.json");
  const envPath = path.join(repoRoot, ".env");

  if (fs.existsSync(configPath)) {
    skipped.push("balatro.config.json");
  } else {
    created.push("balatro.config.json");
    if (write) {
      const config = {
        _comment: "Local machine config. API keys stay in .env only.",
        launchMode: layout.launchMode,
        balatroPath: layout.platform === "linux" ? "" : layout.gameExecutable,
        lovelyPath: "",
        basePort: 12346,
        relayPort: 3001,
        deck: "RED",
        stake: "WHITE",
        seeds: ["BENCH01", "BENCH02", "BENCH03", "BENCH04", "BENCH05"],
        runsPerSeed: 1,
        maxDecisionsPerGame: 0,
        startupWaitMs: 25000,
        submit: true,
        submitUrl: "https://evalatro.dev",
        models: [],
      };
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  }

  if (fs.existsSync(envPath)) {
    skipped.push(".env");
  } else {
    created.push(".env");
    if (write) {
      fs.writeFileSync(
        envPath,
        [
          "# Local evalatro environment. Leave model fields empty until you want to run a real LLM.",
          "# For the smoke test, use: npm run live -- naive",
          "",
          "# BASE_URL=https://openrouter.ai/api/v1",
          "# BASE_KEY=",
          "# MODEL=openai/gpt-4o-mini",
          "# MODEL_MODE=tools",
          "",
          "# Finished games submit to the public Evalatro leaderboard by default.",
          "# To opt out entirely, uncomment:",
          "# SUBMIT=false",
          "",
        ].join("\n"),
      );
    }
  }

  return { created, skipped };
}

export function runCommand(command, args, { dryRun }) {
  const executable = process.platform === "win32" && command === "npm" ? process.execPath : command;
  const resolvedExecutable = executable === command ? resolveLocalCommand(command) || command : executable;
  const spawnArgs = process.platform === "win32" && command === "npm"
    ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args]
    : args;
  const display = [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
  console.log(`$ ${display}`);
  if (dryRun) return;
  const result = childProcess.spawnSync(resolvedExecutable, spawnArgs, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${display}`);
  }
}

function runCommandBestEffort(command, args, { dryRun }) {
  const executable = process.platform === "win32" && command === "npm" ? process.execPath : command;
  const resolvedExecutable = executable === command ? resolveLocalCommand(command) || command : executable;
  const spawnArgs = process.platform === "win32" && command === "npm"
    ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args]
    : args;
  const display = [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
  console.log(`$ ${display}`);
  if (dryRun) return;
  const result = childProcess.spawnSync(resolvedExecutable, spawnArgs, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    console.log(`Skip: command did not complete cleanly (${display})`);
  }
}

function installUvIfNeeded(layout, options) {
  if (commandExists("uv")) return;
  if (layout.platform === "win32") {
    runCommand("powershell", ["-ExecutionPolicy", "ByPass", "-c", `irm ${UV_INSTALL_PS1} | iex`], options);
  } else {
    runCommand("sh", ["-c", `curl -LsSf ${UV_INSTALL_SH} | sh`], options);
  }
  prependToPath(userLocalBin(layout.platform, process.env.HOME ?? process.env.USERPROFILE ?? ""));
  if (!options.dryRun && !commandExists("uv")) {
    throw new Error("uv was installed, but is still not on PATH. Restart your shell or add your user .local/bin directory to PATH.");
  }
}

function removePath(target, options) {
  console.log(`Remove ${target}`);
  if (options.dryRun) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function cleanupLocalRepo(repoRoot, options) {
  for (const relative of [
    "node_modules",
    "dist",
    "web/node_modules",
    "web/dist",
    "logs",
    "bench",
    ".env",
    "balatro.config.json",
    "tsconfig.tsbuildinfo",
    "web/tsconfig.tsbuildinfo",
  ]) {
    removePath(path.join(repoRoot, relative), options);
  }
}

function lovelyTarget(layout, file) {
  return path.join(layout.lovelyDir, file);
}

function copyExtractedLovelyFiles(layout, extractDir, options) {
  for (const file of lovelyAssetFor(layout).files) {
    const source = path.join(extractDir, file);
    const target = lovelyTarget(layout, file);
    console.log(`Copy ${source} -> ${target}`);
    if (!options.dryRun) fs.copyFileSync(source, target);
  }
  if (layout.platform === "darwin") {
    runCommand("chmod", ["+x", lovelyTarget(layout, "run_lovely_macos.sh")], options);
    runCommand("xattr", ["-rd", "com.apple.quarantine", ...lovelyAssetFor(layout).files.map((file) => lovelyTarget(layout, file))], options);
  }
}

function installLovely(layout, options) {
  if (!fs.existsSync(layout.gameDir) && !fs.existsSync(layout.gameExecutable)) {
    console.log(`Skip Lovely: Balatro game directory was not found at ${layout.gameDir}.`);
    return;
  }
  const asset = lovelyAssetFor(layout);
  const workDir = options.dryRun ? path.join(os.tmpdir(), "evalatro-lovely-dry-run") : fs.mkdtempSync(path.join(os.tmpdir(), "evalatro-lovely-"));
  const archivePath = path.join(workDir, asset.name);
  const extractDir = path.join(workDir, "extract");
  if (!options.dryRun) fs.mkdirSync(extractDir, { recursive: true });

  runCommand("curl", ["-L", `${LOVELY_RELEASE_BASE}/${asset.name}`, "-o", archivePath], options);
  if (asset.kind === "tar") {
    runCommand("tar", ["-xzf", archivePath, "-C", extractDir], options);
  } else if (layout.platform === "win32") {
    runCommand("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(extractDir)}`], options);
  } else {
    runCommand("unzip", ["-o", archivePath, "-d", extractDir], options);
  }
  copyExtractedLovelyFiles(layout, extractDir, options);
}

function cloneOrPull(dir, repo, options) {
  if (fs.existsSync(path.join(dir, ".git"))) {
    runCommand("git", ["-C", dir, "pull", "--ff-only"], options);
  } else if (fs.existsSync(dir)) {
    console.log(`Skip ${dir}: directory exists and is not a git checkout.`);
  } else {
    runCommand("git", ["clone", "--depth", "1", repo, dir], options);
  }
}

function cleanupGameSide(layout, options) {
  removePath(layout.smodsDir, options);
  removePath(layout.balatrobotModDir, options);
  removePath(path.join(layout.modsDir, "lovely"), options);
  for (const file of lovelyAssetFor(layout).files) {
    removePath(lovelyTarget(layout, file), options);
  }
}

export async function confirmIfNeeded(options, plan) {
  if (options.mode === "check" || options.dryRun || options.yes) return true;
  console.log("");
  if (options.mode === "uninstall") {
    console.log("This will remove local repo outputs, installed mod folders, Lovely files, and the balatrobot CLI.");
    console.log("It will not uninstall Balatro itself.");
  } else {
    console.log(`This will write local files in this repo and install game-side files into: ${plan.layout.modsDir} / ${plan.layout.lovelyDir}`);
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("Continue? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export async function executeSetup({ repoRoot, options, plan }) {
  const write = !options.dryRun;
  const commandOptions = { dryRun: options.dryRun };

  if (options.mode === "check") return true;
  if (plan.blockers.length) {
    process.exitCode = 1;
    return false;
  }
  if (!(await confirmIfNeeded(options, plan))) {
    console.log("Cancelled.");
    return false;
  }

  if (options.mode === "uninstall") {
    if (!plan.missingCommands.includes("uv")) {
      runCommandBestEffort("uv", ["tool", "uninstall", "balatrobot"], commandOptions);
    }
    cleanupLocalRepo(repoRoot, commandOptions);
    cleanupGameSide(plan.layout, commandOptions);
    return true;
  }

  if (options.mode === "install" && plan.canInstallRepo) {
    installUvIfNeeded(plan.layout, commandOptions);
    runCommand("uv", ["tool", "install", "balatrobot"], commandOptions);
    ensureLocalFiles({ repoRoot, write, layout: plan.layout });
    if (!options.skipNpm) {
      runCommand("npm", ["install"], commandOptions);
      runCommand("npm", ["run", "setup"], commandOptions);
      runCommand("npm", ["test"], commandOptions);
    }
  } else if (options.mode !== "install-mods" && options.mode !== "install-lovely") {
    ensureLocalFiles({ repoRoot, write, layout: plan.layout });
  }

  if ((options.mode === "install" || options.mode === "install-mods") && plan.canInstallMods) {
    if (!options.dryRun) fs.mkdirSync(plan.layout.modsDir, { recursive: true });
    cloneOrPull(plan.layout.smodsDir, SMODS_REPO, commandOptions);
    cloneOrPull(plan.layout.balatrobotModDir, BALATROBOT_REPO, commandOptions);
  }

  if ((options.mode === "install" || options.mode === "install-lovely") && plan.canInstallLovely) {
    installLovely(plan.layout, commandOptions);
  }
  return true;
}

export function printHelp() {
  console.log(`Usage: npm run setup:local -- [options]

Options:
  --check                  Print detected paths and next steps without writing.
  --install                Install CLI deps, repo deps, local configs, and mods.
  --install-mods           Only create/update game-side mod folders.
  --install-lovely         Only download/install Lovely into the Balatro game folder.
  --uninstall              Remove helper-installed CLI, repo outputs, mods, and Lovely files.
  --game-path <path>       Override Balatro game dir or executable path.
  --skip-npm               Skip npm install/setup/test during --install.
  --dry-run                Print commands without running them.
  --yes, -y                Do not ask for confirmation.

On Windows, the script reads Steam's libraryfolders.vdf and tries all Steam libraries before falling back to the default Steam path.
The script never installs Balatro, logs into Steam, or writes API keys.`);
}

export function printPlan(plan, options) {
  console.log(`Platform: ${plan.layout.platformLabel}`);
  console.log(`Mode: ${options.mode}${options.dryRun ? " (dry-run)" : ""}`);
  console.log(`Game: ${plan.layout.gameDir}`);
  console.log(`Mods: ${plan.layout.modsDir}`);
  console.log(`Launch mode: ${plan.layout.launchMode}`);
  if (plan.warnings.length) {
    console.log("");
    console.log("Warnings:");
    for (const warning of plan.warnings) console.log(`- ${warning}`);
  }
  if (plan.blockers.length) {
    console.log("");
    console.log("Cannot continue:");
    for (const blocker of plan.blockers) console.log(`- ${blocker}`);
  }
  if (plan.steps.length) {
    console.log("");
    console.log("Planned steps:");
    for (const step of plan.steps) {
      console.log(`- ${step.title}`);
      if (step.note) console.log(`  ${step.note}`);
    }
  }
}
