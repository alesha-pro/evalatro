import { createHash } from "crypto";
import { readFileSync } from "fs";
import * as path from "path";

/**
 * Semantic version of the eval's gameplay + scoring contract. Bump it whenever
 * the hashed files below change in a way that affects how the model plays or how
 * a run is scored, then regenerate the known hash (npm run codehash) and add it
 * to src/server/known-hashes.ts.
 */
export const EVAL_VERSION = "0.3.0";

/**
 * The files whose contents define WHAT the model experiences and HOW a run is
 * scored. A submission's codeHash is computed over these; the server marks a run
 * "official" only if the hash matches a known release. This catches accidental
 * or casual modification (e.g. someone adds strategy tips to the prompt). It is
 * NOT tamper-proof — the same client computes the hash — which is why the server
 * always recomputes the score from the transcript regardless.
 */
export const HASHED_FILES = [
  "src/scoring/score.ts",
  "src/state/summarizer.ts",
  "src/tools/registry.ts",
  "src/game/loop.ts",
  "src/game/decide.ts",
  "src/llm/openai-adapter.ts",
  "src/agent/SYSTEM_PROMPT.md",
];

/** sha256 over the normalized contents of the hashed files (CRLF→LF, sorted order). */
export function computeCodeHash(root = process.cwd()): string {
  const h = createHash("sha256");
  for (const rel of HASHED_FILES) {
    let content: string;
    try {
      content = readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
    } catch {
      content = "<MISSING>";
    }
    h.update(`${rel}\n${content}\n`);
  }
  return "sha256:" + h.digest("hex");
}
