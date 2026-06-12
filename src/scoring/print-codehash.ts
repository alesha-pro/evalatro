import { computeCodeHash, EVAL_VERSION, HASHED_FILES } from "./codehash.js";

// Prints the current code hash. At each release, paste the output into
// src/server/known-hashes.ts keyed by EVAL_VERSION so matching runs are tagged
// "official" by the leaderboard backend.
console.log(`evalVersion: ${EVAL_VERSION}`);
console.log(`codeHash:    ${computeCodeHash()}`);
console.log(`(over ${HASHED_FILES.length} files: ${HASHED_FILES.join(", ")})`);
