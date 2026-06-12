import { pathToFileURL } from "url";
import Database from "better-sqlite3";
import { getDb, leaderboard } from "./db.js";

/** Pretty-print the leaderboard (completed games only). Reused by `bench/run`. */
export function printLeaderboard(db: Database.Database = getDb()): void {
  const rows = leaderboard(db);
  if (!rows.length) {
    console.log("No runs yet. Run `npm run bench` or `npm run live` first.");
    return;
  }
  console.log("\n=== Balatro LLM Leaderboard (scored games: won/lost/stuck) ===");
  console.table(
    rows.map(s => ({
      model: s.model,
      score: `${s.avgScore} ± ${s.stdevScore}`,
      "win%": s.winRate,
      "scored/att": `${s.scored}/${s.attempts}`,
      ante: `${s.avgAnte} ± ${s.stdevAnte}`,
      max: s.maxAnte,
      "$": s.avgMoney,
      "illegal%": s.illegalRate,
      "tok/out": s.avgTokensOut,
      "$/run": s.avgCostUsd,
    })),
  );
}

// Run only when invoked directly (not when imported by bench/run).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  printLeaderboard();
}
