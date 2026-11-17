import { sanityChecks, transcriptProvesWin } from "./runs.js";
import { computeScore, deriveScoreInput, MoveSnapshot } from "../scoring/score.js";

// Unit tests for the server-side transcript checks — no DB, no network.
// Importing runs.js is safe: getDb() opens lazily and is never called here.

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, got: any, want: any) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/**
 * A transcript that walks the given ante sequence, one SELECTING_HAND decision
 * per entry. `play_hand` is legal in SELECTING_HAND, so the legality check has
 * nothing to flag and the ante rule is the only thing under test.
 */
function transcript(antes: number[]) {
  const moves = antes.map((ante, i) => ({
    tool: "play_hand",
    args: { cards: [0] },
    ts: 1_000 + i,
    tokensOut: 10,
    illegal: null,
    state: {
      state: "SELECTING_HAND",
      ante,
      blind: { type: i % 3 === 2 ? "BOSS" : "SMALL" },
      score: { chips: 10, target: 100 },
    },
  }));
  const snaps: MoveSnapshot[] = moves.map(m => ({
    state: m.state.state,
    ante: m.state.ante,
    blind: m.state.blind,
    score: m.state.score,
    illegal: m.illegal,
  }));
  const serverScore = computeScore(deriveScoreInput(snaps, false, 12), 12).score;
  // Mirrored client score so the "client != server" soft flag stays quiet.
  const submission: any = { moves, runRecord: { score: serverScore } };
  return { moves, snaps, submission, serverScore };
}

console.log("ante monotonicity is a soft flag, not a rejection:");

const mono = transcript([1, 2, 3, 4, 5]);
const monoChecks = sanityChecks(mono.submission, mono.snaps, false, mono.serverScore, 12);
check(
  "a monotonic transcript raises no ante flag",
  ![...monoChecks.hard, ...monoChecks.soft].some(f => f.includes("ante decreased")),
  JSON.stringify([monoChecks.hard, monoChecks.soft]),
);

// Hieroglyph and Petroglyph both read "-1 Ante", so 5 -> 4 is a real run.
const dip = transcript([1, 2, 3, 4, 5, 4, 4]);
const dipChecks = sanityChecks(dip.submission, dip.snaps, false, dip.serverScore, 12);
check("a 5 -> 4 dip is not a hard rejection", !dipChecks.hard.some(f => f.includes("ante decreased")), JSON.stringify(dipChecks.hard));
check("the dip is still flagged soft", dipChecks.soft.some(f => f.includes("ante decreased")), JSON.stringify(dipChecks.soft));
check("the otherwise-valid transcript has no hard failures", dipChecks.hard.length === 0, JSON.stringify(dipChecks.hard));

console.log("\nscoring is indifferent to a post-peak dip:");

const peakOnly = transcript([1, 2, 3, 4, 5]);
const withDip = transcript([1, 2, 3, 4, 5, 4, 4]);
eq(
  "same score with and without the trailing dip",
  computeScore(deriveScoreInput(withDip.snaps, false, 12), 12).score,
  computeScore(deriveScoreInput(peakOnly.snaps, false, 12), 12).score,
);
eq(
  "same antesCleared with and without the dip",
  deriveScoreInput(withDip.snaps, false, 12).antesCleared,
  deriveScoreInput(peakOnly.snaps, false, 12).antesCleared,
);

console.log("\nwin detection is peak-based too:");

const win = transcript([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 12]);
check("a dip after clearing the target ante still proves the win", transcriptProvesWin(win.submission, 12) === true);
const noWin = transcript([1, 2, 3, 4, 5, 4]);
check("a dip that never reaches the target is not a win", transcriptProvesWin(noWin.submission, 12) === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
