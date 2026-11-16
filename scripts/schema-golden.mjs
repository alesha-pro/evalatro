#!/usr/bin/env node
/**
 * Tool-schema contract guard.
 *
 * The rendered tool schema IS the benchmark's interface contract, and it is
 * produced two different ways depending on the installed zod major: zod 4's
 * `z.toJSONSchema`, or the zod 3 fallback in src/tools/registry.ts. A gap
 * between the two changes what the model is told — and therefore how it plays —
 * while `codeHash` stays unchanged, because zod itself is not hashed (issue #7).
 * That is exactly how `shop_buy` shipped without parameter types.
 *
 * Both paths are therefore pinned to one committed fixture:
 *
 *   npm run schema:golden   regenerate after an intended contract change
 *   npm run test:schema     verify (also runs inside `npm test`)
 *   npm run check:zod4      swap zod 4 in, verify against the same fixture, swap back
 *
 * Key order is not part of the contract: zod 4 emits `minItems` before `type`,
 * the fallback emits `type` first, and no JSON consumer cares. `deepStrictEqual`
 * ignores key order, so this compares structure rather than bytes. If a
 * byte-stable diff is ever wanted, sort keys on both paths instead of changing
 * this check.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { fileURLToPath } from "node:url";
import { openAiTools } from "../dist/tools/registry.js";

const fixture = "test/tool-schemas.golden.json";
const fixturePath = fileURLToPath(new URL(`../${fixture}`, import.meta.url));

// Round-trip through JSON so the live value is plain data, not class instances.
const live = JSON.parse(JSON.stringify(openAiTools()));

if (process.argv.includes("--write")) {
  mkdirSync(new URL("../test", import.meta.url), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify(live, null, 2)}\n`);
  console.log(`wrote ${live.length} tool schemas -> ${fixture}`);
  process.exit(0);
}

let golden;
try {
  golden = JSON.parse(readFileSync(fixturePath, "utf8"));
} catch (e) {
  console.error(`FAIL  cannot read ${fixture}: ${e.message}`);
  console.error("      generate it with: npm run schema:golden");
  process.exit(1);
}

try {
  deepStrictEqual(live, golden);
} catch (e) {
  console.error(`FAIL  rendered tool schemas differ from ${fixture}`);
  console.error(String(e.message).split("\n").slice(0, 30).join("\n"));
  console.error("\nIf the change is intended, regenerate with: npm run schema:golden");
  process.exit(1);
}

const bounded = live.filter(t => JSON.stringify(t).includes("maxLength")).map(t => t.function.name);
console.log(`PASS  ${live.length} tool schemas match ${fixture} (maxLength carried by: ${bounded.join(", ")})`);
