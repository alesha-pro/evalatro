/**
 * The single source of truth for the 0–100 Balatro benchmark score.
 *
 * Pure and dependency-free, imported by BOTH the runner (to show a local score)
 * and the server (to RECOMPUTE the authoritative score from the submitted
 * transcript). One implementation ⇒ the two numbers always agree unless the
 * transcript was tampered with.
 *
 * A standard run = 8 antes × 3 blinds (Small/Big/Boss) = a 24-blind ladder;
 * winning = beating the Ante 8 Boss. Score = progress × legality × 100, so a
 * flawless ante-8 win is exactly 100 and any illegal move drops below it.
 */

export const BLINDS_PER_ANTE = 3;
export const ANTES_TO_WIN = 8;
export const TOTAL_BLINDS = ANTES_TO_WIN * BLINDS_PER_ANTE; // 24

/** Position of each blind within an ante. */
const BLIND_INDEX: Record<string, number> = { SMALL: 0, BIG: 1, BOSS: 2 };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

export interface ScoreInput {
  /** The corrected win flag (state.won === true || ante ≥ 9). */
  won: boolean;
  /** Antes fully cleared, 0..8. */
  antesCleared: number;
  /** Furthest blind reached in the current ante: SMALL=0, BIG=1, BOSS=2. */
  blindIndex: number;
  /** Best chips/target on the in-progress blind, 0..0.99 (never a full blind). */
  activeFraction: number;
  actions: number;
  illegalActions: number;
}

export interface ScoreResult extends ScoreInput {
  /** 0..100 — the headline number. */
  score: number;
  /** 0..1 — ladder progress (1.0 only on a real win). */
  progress: number;
  /** 0..1 — 1 − illegalRate. */
  legality: number;
  /** 0..24 — position on the blind ladder. */
  ladderPos: number;
  /** 0..1 — illegalActions / max(1, actions). */
  illegalRate: number;
}

/** The pure formula. */
export function computeScore(i: ScoreInput): ScoreResult {
  const antesCleared = clamp(i.antesCleared, 0, ANTES_TO_WIN);
  const blindIndex = clamp(i.blindIndex, 0, BLINDS_PER_ANTE - 1);
  const activeFraction = clamp(i.activeFraction, 0, 0.99);
  const within = blindIndex + activeFraction; // [0, 2.99]
  const ladderPos = Math.min(antesCleared * BLINDS_PER_ANTE + within, TOTAL_BLINDS);

  // Only a real win reaches progress 1.0; the 0.99 clamp guarantees every
  // non-win stays strictly below a "completed" 24th blind.
  const progress = i.won ? 1 : Math.min(ladderPos, TOTAL_BLINDS - 0.01) / TOTAL_BLINDS;

  const illegalRate = i.illegalActions / Math.max(1, i.actions);
  const legality = clamp(1 - illegalRate, 0, 1);

  // Only a real win can display a perfect 100.0. The 0.99 fraction clamp already
  // keeps progress < 1; this caps the rounded score so a 99%-of-ante-8 loss
  // (which rounds to 100.0) can't masquerade as a win.
  let score = round1(progress * legality * 100);
  if (!i.won) score = Math.min(score, 99.9);

  return {
    won: i.won, antesCleared, blindIndex, activeFraction,
    actions: i.actions, illegalActions: i.illegalActions,
    score, progress, legality, ladderPos, illegalRate,
  };
}

/**
 * One ordered per-move snapshot. A structural SUBSET of SummarizedState, so the
 * JSON stored in the moves table (and what summarizeState produces) satisfies it
 * directly — no adapter needed. One snapshot per decision (legal or illegal).
 */
export interface MoveSnapshot {
  state: string;
  ante: number;
  blind: { type?: string } | null;
  score: { chips: number; target: number };
  /** Set when the move was rejected by the game. */
  illegal?: string | null;
}

/**
 * Derive the ScoreInput from one game's ordered move snapshots.
 *
 * Key facts (verified against real transcripts):
 *  - `ante` increments the instant a boss is beaten, so maxAnteObserved − 1 =
 *    antes cleared (even mid-shop). A real win is passed in via `won`.
 *  - `blind.type`/`score.target` are only trustworthy at SELECTING_HAND (at
 *    ROUND_EVAL/SHOP the summarizer falls back to the boss blind), so blindIndex
 *    and the chips/target fraction are read ONLY from SELECTING_HAND snapshots.
 */
export function deriveScoreInput(snapshots: MoveSnapshot[], won: boolean): ScoreInput {
  const actions = snapshots.length;
  const illegalActions = snapshots.filter(s => s.illegal != null).length;

  const maxAnteObserved = snapshots.reduce((m, s) => Math.max(m, s.ante || 0), 0);
  const antesCleared = won ? ANTES_TO_WIN : clamp(maxAnteObserved - 1, 0, ANTES_TO_WIN);

  // Within the last ante reached, the furthest blind actually attempted and the
  // best chips/target seen on it. Between blinds (no SELECTING_HAND for the last
  // ante) → blindIndex 0, fraction 0: cleared blinds are already in antesCleared.
  const attempts = snapshots.filter(
    s => s.state === "SELECTING_HAND" && (s.ante || 0) === maxAnteObserved && s.blind,
  );
  let blindIndex = 0;
  let activeFraction = 0;
  if (attempts.length) {
    blindIndex = attempts.reduce(
      (mx, s) => Math.max(mx, BLIND_INDEX[(s.blind?.type || "").toUpperCase()] ?? 0), 0,
    );
    const onBlind = attempts.filter(
      s => (BLIND_INDEX[(s.blind?.type || "").toUpperCase()] ?? 0) === blindIndex,
    );
    activeFraction = onBlind.reduce((mx, s) => {
      const t = s.score?.target ?? 0;
      const c = s.score?.chips ?? 0;
      return t > 0 ? Math.max(mx, c / t) : mx;
    }, 0);
  }

  return { won, antesCleared, blindIndex, activeFraction, actions, illegalActions };
}

/** Convenience: transcript → final score in one call. */
export function scoreFromTranscript(snapshots: MoveSnapshot[], won: boolean): ScoreResult {
  return computeScore(deriveScoreInput(snapshots, won));
}
