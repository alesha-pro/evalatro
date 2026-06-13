import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSetupPlan,
  defaultLayout,
  ensureLocalFiles,
  lovelyAssetFor,
  parseArgs,
} from "./setup-local-lib.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test("defaultLayout returns macOS Steam, Mods, and Lovely paths", () => {
  const layout = defaultLayout({
    platform: "darwin",
    home: "/Users/alice",
    arch: "arm64",
  });

  assert.equal(
    layout.gameDir,
    "/Users/alice/Library/Application Support/Steam/steamapps/common/Balatro",
  );
  assert.equal(
    layout.gameExecutable,
    "/Users/alice/Library/Application Support/Steam/steamapps/common/Balatro/Balatro.app/Contents/MacOS/love",
  );
  assert.equal(
    layout.modsDir,
    "/Users/alice/Library/Application Support/Balatro/Mods",
  );
  assert.deepEqual(layout.lovelyFiles, ["liblovely.dylib", "run_lovely_macos.sh"]);
  assert.equal(layout.platformLabel, "macOS arm64");
});

test("defaultLayout returns Windows Steam and AppData paths", () => {
  const layout = defaultLayout({
    platform: "win32",
    home: "C:\\Users\\Alice",
    appData: "C:\\Users\\Alice\\AppData\\Roaming",
  });

  assert.equal(layout.gameDir, "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Balatro");
  assert.equal(layout.gameExecutable, "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Balatro\\Balatro.exe");
  assert.equal(layout.modsDir, "C:\\Users\\Alice\\AppData\\Roaming\\Balatro\\Mods");
  assert.deepEqual(layout.lovelyFiles, ["version.dll"]);
});

test("defaultLayout detects Balatro in a secondary Windows Steam library", () => {
  const vdfPath = "C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf";
  const balatroExe = "D:\\Games\\SteamLibrary\\steamapps\\common\\Balatro\\Balatro.exe";
  const layout = defaultLayout({
    platform: "win32",
    home: "C:\\Users\\Alice",
    appData: "C:\\Users\\Alice\\AppData\\Roaming",
    exists: (target) => target === vdfPath || target === balatroExe,
    readFileSync: (target) => {
      assert.equal(target, vdfPath);
      return `"libraryfolders"
{
  "0"
  {
    "path" "C:\\\\Program Files (x86)\\\\Steam"
  }
  "1"
  {
    "path" "D:\\\\Games\\\\SteamLibrary"
  }
}`;
    },
  });

  assert.equal(layout.gameDir, "D:\\Games\\SteamLibrary\\steamapps\\common\\Balatro");
  assert.equal(layout.gameExecutable, balatroExe);
  assert.equal(layout.lovelyDir, "D:\\Games\\SteamLibrary\\steamapps\\common\\Balatro");
});

test("parseArgs keeps check mode safe by default", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "check",
    dryRun: false,
    yes: false,
    skipNpm: false,
    gamePath: "",
  });
  assert.deepEqual(parseArgs(["--install", "--yes", "--skip-npm", "--game-path", "/tmp/Balatro"]), {
    mode: "install",
    dryRun: false,
    yes: true,
    skipNpm: true,
    gamePath: "/tmp/Balatro",
  });
  assert.equal(parseArgs(["--uninstall"]).mode, "uninstall");
});

test("buildSetupPlan shows missing game as a warning in check mode", () => {
  const plan = buildSetupPlan({
    options: parseArgs(["--check", "--game-path", "/missing/Balatro"]),
    layout: defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "arm64" }),
    exists: (target) => target === "/Users/alice/Library/Application Support/Balatro/Mods",
    commandExists: (name) => name === "node" || name === "npm" || name === "git" || name === "uv",
  });

  assert.equal(plan.canInstallRepo, true);
  assert.equal(plan.canInstallMods, true);
  assert.equal(plan.canInstallLovely, false);
  assert.deepEqual(plan.blockers, []);
  assert(plan.warnings.some((warning) => warning.includes("Balatro is not installed")));
  assert(plan.steps.some((step) => step.title === "Install balatrobot CLI"));
  assert(plan.steps.some((step) => step.title === "Install Steamodded and balatrobot mods"));
});

test("buildSetupPlan blocks full install when Balatro is missing", () => {
  const plan = buildSetupPlan({
    options: parseArgs(["--install"]),
    layout: defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "arm64" }),
    exists: (target) => target === "/Users/alice/Library/Application Support/Balatro/Mods",
    commandExists: () => true,
  });

  assert.equal(plan.canInstallLovely, false);
  assert(plan.blockers.some((blocker) => blocker.includes("Balatro is not installed")));
  assert(!plan.steps.some((step) => step.title === "Install and verify this repo"));
  assert(!plan.steps.some((step) => step.title === "Install Steamodded and balatrobot mods"));
  assert(!plan.steps.some((step) => step.title.includes("Lovely")));
});

test("buildSetupPlan plans cleanup without requiring Balatro", () => {
  const plan = buildSetupPlan({
    options: parseArgs(["--uninstall"]),
    layout: defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "arm64" }),
    exists: () => false,
    commandExists: () => true,
  });

  assert.deepEqual(plan.blockers, []);
  assert(!plan.warnings.some((warning) => warning.includes("Balatro is not installed")));
  assert(plan.steps.some((step) => step.title === "Uninstall balatrobot CLI"));
  assert(plan.steps.some((step) => step.title === "Remove local repo outputs"));
  assert(plan.steps.some((step) => step.title === "Remove game-side mod folders"));
  assert(plan.steps.some((step) => step.title === "Remove Lovely Injector files"));
  assert(!plan.steps.some((step) => step.title === "Install balatrobot CLI"));
  assert(!plan.steps.some((step) => step.title === "Install and verify this repo"));
});

test("buildSetupPlan installs Lovely automatically when the game is present", () => {
  const plan = buildSetupPlan({
    options: parseArgs(["--install"]),
    layout: defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "arm64" }),
    exists: () => true,
    commandExists: () => true,
  });

  assert.equal(plan.canInstallLovely, true);
  assert(plan.steps.some((step) => step.title === "Install Lovely Injector"));
  assert(!plan.steps.some((step) => step.title === "Install Lovely Injector manually"));
});

test("lovelyAssetFor chooses the right upstream release asset", () => {
  assert.equal(
    lovelyAssetFor(defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "arm64" })).name,
    "lovely-aarch64-apple-darwin.tar.gz",
  );
  assert.equal(
    lovelyAssetFor(defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "x64" })).name,
    "lovely-x86_64-apple-darwin.tar.gz",
  );
  assert.equal(
    lovelyAssetFor(defaultLayout({ platform: "win32", home: "C:\\Users\\Alice" })).name,
    "lovely-x86_64-pc-windows-msvc.zip",
  );
  assert.equal(
    lovelyAssetFor(defaultLayout({ platform: "linux", home: "/home/alice", arch: "x64" })).name,
    "lovely-x86_64-pc-windows-msvc.zip",
  );
});

test("buildSetupPlan keeps install-mods scoped to mod folders", () => {
  const plan = buildSetupPlan({
    options: parseArgs(["--install-mods"]),
    layout: defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "arm64" }),
    exists: () => true,
    commandExists: () => true,
  });

  assert(!plan.steps.some((step) => step.title === "Create local ignored config files"));
  assert(!plan.steps.some((step) => step.title === "Install and verify this repo"));
  assert(!plan.steps.some((step) => step.title === "Install balatrobot CLI"));
  assert(!plan.steps.some((step) => step.title === "Install Lovely Injector manually"));
  assert(plan.steps.some((step) => step.title === "Install Steamodded and balatrobot mods"));
});

test("ensureLocalFiles writes ignored config files without secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evalatro-setup-"));
  fs.writeFileSync(
    path.join(dir, "balatro.config.example.json"),
    JSON.stringify({ launchMode: "spawn", submit: true, models: [{ name: "example" }] }, null, 2),
  );
  fs.writeFileSync(path.join(dir, ".env.example"), "BASE_KEY=sk-example\nSUBMIT_URL=http://example\n");

  const result = ensureLocalFiles({
    repoRoot: dir,
    write: true,
    layout: defaultLayout({ platform: "darwin", home: "/Users/alice", arch: "arm64" }),
  });

  assert.deepEqual(result.created.sort(), [".env", "balatro.config.json"]);
  const config = JSON.parse(fs.readFileSync(path.join(dir, "balatro.config.json"), "utf8"));
  assert.equal(config.submit, true);
  assert.equal(config.submitUrl, "https://evalatro-leaderboard.anonymousmaharaj.workers.dev");
  assert.deepEqual(config.models, []);
  assert.equal(config.launchMode, "spawn");

  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert(!env.includes("sk-example"));
  assert(env.includes("# SUBMIT=false"));
});
