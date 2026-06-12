import { computeScore, deriveScoreInput, scoreFromTranscript, MoveSnapshot } from "./score.js";

// Pure unit tests for the scoring seam — no network, no game. Mirrors test-adapter.ts.

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, got: any, want: any) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function approx(name: string, got: number, want: number, eps = 0.01) {
  check(name, Math.abs(got - want) <= eps, `got ${got}, want ~${want}`);
}

console.log("computeScore:");
eq("flawless ante-8 win = 100", computeScore({ won: true, antesCleared: 8, blindIndex: 2, activeFraction: 0, actions: 120, illegalActions: 0 }).score, 100);
eq("win, 2/50 illegal = 96.0", computeScore({ won: true, antesCleared: 8, blindIndex: 0, activeFraction: 0, actions: 50, illegalActions: 2 }).score, 96);
eq("lost ante-4 boss @60%, clean = 48.3", computeScore({ won: false, antesCleared: 3, blindIndex: 2, activeFraction: 0.6, actions: 80, illegalActions: 0 }).score, 48.3);
eq("zero actions = 0", computeScore({ won: false, antesCleared: 0, blindIndex: 0, activeFraction: 0, actions: 0, illegalActions: 0 }).score, 0);
eq("8/8 illegal = 0 (legality 0)", computeScore({ won: false, antesCleared: 2, blindIndex: 1, activeFraction: 0.5, actions: 8, illegalActions: 8 }).score, 0);

console.log("\ninvariant — only a real win shows 100.0:");
const nearWin = computeScore({ won: false, antesCleared: 7, blindIndex: 2, activeFraction: 0.99, actions: 200, illegalActions: 0 });
check("non-win progress < 1.0", nearWin.progress < 1, `progress ${nearWin.progress}`);
check("non-win score < 100", nearWin.score < 100, `score ${nearWin.score}`);
eq("non-win capped at 99.9", nearWin.score, 99.9);

console.log("\nderiveScoreInput (transcript → input):");
const SH = (ante: number, type: string, chips: number, target: number, illegal: string | null = null): MoveSnapshot =>
  ({ state: "SELECTING_HAND", ante, blind: { type }, score: { chips, target }, illegal });
const AT = (ante: number, state: string): MoveSnapshot =>
  ({ state, ante, blind: { type: "BOSS" }, score: { chips: 0, target: 9999 }, illegal: null });

// Reached ante-4 boss at ~19.44%, cleared antes 1–3 (mirrors the real bench.db game).
{
  const snaps = [SH(1, "SMALL", 276, 300), SH(1, "BIG", 304, 450), SH(1, "BOSS", 592, 600), AT(2, "SHOP"), SH(2, "SMALL", 0, 800), SH(4, "BOSS", 1944, 10000)];
  const inp = deriveScoreInput(snaps, false);
  eq("antesCleared = maxAnte-1", inp.antesCleared, 3);
  eq("blindIndex = boss(2)", inp.blindIndex, 2);
  approx("activeFraction ≈ 0.1944", inp.activeFraction, 0.1944);
}
// Ended between blinds (in ante-4 shop after beating ante-3 boss): no SELECTING_HAND at ante 4.
{
  const snaps = [SH(3, "BOSS", 4000, 4000), AT(4, "SHOP"), AT(4, "BLIND_SELECT")];
  const inp = deriveScoreInput(snaps, false);
  eq("between-blinds antesCleared", inp.antesCleared, 3);
  eq("between-blinds blindIndex 0", inp.blindIndex, 0);
  eq("between-blinds fraction 0", inp.activeFraction, 0);
}
// Skipped small+big, now on ante-2 boss → skip-neutral (blindIndex still 2).
{
  const inp = deriveScoreInput([SH(1, "BOSS", 600, 600), SH(2, "BOSS", 100, 1600)], false);
  eq("skip: antesCleared 1", inp.antesCleared, 1);
  eq("skip: blindIndex 2", inp.blindIndex, 2);
}
// Win is taken from the flag (the transcript stores pre-move states, no post-win snapshot).
{
  const r = scoreFromTranscript([SH(8, "BOSS", 5000, 10000)], true);
  eq("won → antesCleared 8", r.antesCleared, 8);
  eq("won → score 100", r.score, 100);
}
// actions/illegal recomputed from the snapshots themselves.
{
  const inp = deriveScoreInput([SH(1, "SMALL", 0, 300), SH(1, "SMALL", 0, 300, "BAD_ARGS"), SH(1, "SMALL", 100, 300)], false);
  eq("actions = snapshot count", inp.actions, 3);
  eq("illegal counted", inp.illegalActions, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
