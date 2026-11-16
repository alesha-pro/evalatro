#!/usr/bin/env node
/**
 * Verify the tool-schema contract is identical on zod 3 and zod 4.
 *
 * The repo locks zod 3, but anyone who runs `npm update` gets zod 4 — that is
 * how the `shop_buy` regression shipped. This swaps zod 4 in, runs the suite
 * (including the golden fixture that was generated under zod 3), and restores
 * the locked tree on every exit path so a failing check cannot leave zod 4
 * installed behind you.
 *
 * There is no CI workflow in this repo, so this is a manual gate: run it before
 * touching src/tools/registry.ts.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
};

let failed = false;
try {
  run("npm install zod@4.6.7 --no-save");
  run("npm run build");
  run("npm run test:schema");
  run("npm test");
} catch {
  failed = true;
  console.error("\nFAIL  the zod 4 path does not match the zod 3 fixture");
} finally {
  console.log("\nrestoring the locked tree (zod 3)");
  run("npm ci");
  run("npm run build");
}

process.exit(failed ? 1 : 0);
