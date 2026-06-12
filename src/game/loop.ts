import * as fs from "fs";
import { BalatroBotClient } from "../client/balatrobot.js";
import { executeTool } from "../tools/registry.js";
import { summarizeState, computeLegalActions, SummarizedState } from "../state/summarizer.js";
import { DecideFn, DecideCtx, Decision } from "./decide.js";
import { globalBus, EventBus } from "../bus/index.js";
import { loadConfig } from "../config.js";
import { scoreFromTranscript, MoveSnapshot } from "../scoring/score.js";

/** One row of benchmark results — also the shape persisted to SQLite. */
export interface RunRecord {
  gameId: string;
  model: string;
  seed: string;
  deck: string;
  stake: string;
  maxAnte: number;
  finalRound: number;
  finalMoney: number;
  won: boolean;
  /** How the game ended. won/lost = the game finished; cap/stuck/error = cut short. */
  outcome: "won" | "lost" | "cap" | "stuck" | "error";
  /** 0–100 benchmark score, computed from the transcript (see scoring/score.ts). */
  score: number;
  actions: number;
  illegalActions: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
  ts: number;
}

export interface RunOptions {
  client: BalatroBotClient;
  /** Leaderboard id for the player. */
  model: string;
  /** Room id for the live stream (unique per concurrent game). */
  gameId: string;
  /** Balatro seed (fixed → deterministic deck). */
  seed: string;
  deck?: string;
  stake?: string;
  maxDecisions?: number;
  bus?: EventBus;
  /** Optional JSONL sink for full replay logs. */
  logStream?: fs.WriteStream;
}

const TERMINAL = new Set(["GAME_OVER", "MENU"]);

/** Signature of the meaningful game state — used to detect no-progress loops. */
function progressSig(s: SummarizedState): string {
  const cards = (a: { key: string; enhancement?: string | null; edition?: string | null; seal?: string | null }[]) =>
    a.map(c => `${c.key}${c.enhancement ?? ""}${c.edition ?? ""}${c.seal ?? ""}`).join(",");
  return [
    s.state, s.ante, s.round, s.score?.chips, s.hands_left, s.discards_left, s.money,
    cards(s.hand_cards), s.jokers.map(j => j.key).join(","), cards(s.consumables),
  ].join("|");
}

/**
 * The one game loop. Drives a single run from menu → game over, asking `decide`
 * for each move, executing it against balatrobot, and emitting state/decision/
 * result events onto the bus (consumed by both the SQLite persist and the SSE
 * stream). `decide` is the only thing that varies between naive and each LLM.
 */
export async function runGame(decide: DecideFn, opts: RunOptions): Promise<RunRecord> {
  const cfg = loadConfig();
  const bus = opts.bus ?? globalBus;
  const { client, model, gameId, seed } = opts;
  const deck = opts.deck ?? cfg.deck;
  const stake = opts.stake ?? cfg.stake;
  const maxDecisions = opts.maxDecisions ?? cfg.maxDecisionsPerGame;

  const rec: RunRecord = {
    gameId, model, seed, deck, stake,
    maxAnte: 0, finalRound: 0, finalMoney: 0, won: false, outcome: "error", score: 0,
    actions: 0, illegalActions: 0, durationMs: 0,
    tokensIn: 0, tokensOut: 0, costUsd: 0,
    error: null, ts: Date.now(),
  };
  const t0 = Date.now();

  const log = (obj: unknown) => opts.logStream?.write(JSON.stringify(obj) + "\n");
  const emitState = (state: SummarizedState) => {
    bus.emit({ type: "state", gameId, model, seed, ts: Date.now(), state: state as any });
    log({ ts: Date.now(), type: "state", gameId, model, seed, state });
  };

  const maxConsecutiveIllegal = cfg.maxConsecutiveIllegal ?? 10;
  const NO_PROGRESS_LIMIT = 15; // abort if the state doesn't change for this many moves
  let consecutiveIllegal = 0;
  let noProgress = 0;
  let lastSig = "";
  let lastError: string | undefined;
  let lastAction: { tool: string; args: Record<string, unknown> } | undefined;
  let state: SummarizedState;
  let notes: string | undefined;
  const snapshots: MoveSnapshot[] = []; // one per decision → fed to the scorer

  try {
    // Ensure a clean start, then start the run on the fixed seed.
    let raw = await client.gamestate();
    if (raw.state !== "MENU") {
      try { raw = await client.menu(); } catch { /* already mid-run; start() will reset */ }
    }
    raw = await client.start(deck, stake, seed);
    state = summarizeState(raw);
    emitState(state);
    lastSig = progressSig(state);

    // No decision cap by default (maxDecisions <= 0): the game runs until it is
    // won, lost, or a loop guard fires.
    for (let step = 0; ; step++) {
      if (TERMINAL.has(state.state)) break;
      if (maxDecisions > 0 && step >= maxDecisions) { rec.error = `cap: reached ${maxDecisions} decisions`; break; }

      const legalActions = computeLegalActions(state.state).actions;
      const ctx: DecideCtx = { step, legalActions, notes, lastError, lastAction };

      let decision: Decision;
      try {
        decision = await decide(state, ctx);
      } catch (e: any) {
        rec.error = `decide failed: ${e.message}`;
        break;
      }

      if (decision.usage) {
        rec.tokensIn += decision.usage.tokensIn || 0;
        rec.tokensOut += decision.usage.tokensOut || 0;
        rec.costUsd += decision.usage.costUsd || 0;
      }
      if (decision.notes !== undefined) notes = decision.notes;

      // Execute the move, then emit ONE decision event with the outcome.
      // The event carries the PRE-move state (so the UI can highlight the cards
      // being played) and an `illegal` field if the game rejected the move.
      const preState = state;
      rec.actions++;
      let illegal: string | undefined;
      try {
        state = await executeTool(client, decision.tool, decision.args);
      } catch (e: any) {
        // The model proposed something the game rejected (wrong state, no tool
        // call, bad args). Count it (a rules/format signal) and keep playing.
        rec.illegalActions++;
        illegal = e.message;
        try { state = summarizeState(await client.gamestate()); } catch { /* keep old state */ }
      }
      // Feed the rejection back to the model so it can correct on the next turn.
      lastError = illegal;
      lastAction = illegal ? { tool: decision.tool, args: decision.args } : undefined;
      consecutiveIllegal = illegal ? consecutiveIllegal + 1 : 0;
      snapshots.push({ state: preState.state, ante: preState.ante, blind: preState.blind, score: preState.score, illegal });

      bus.emit({
        type: "decision", gameId, model, seed, ts: Date.now(), step,
        reasoning: decision.reasoning ?? "",
        action: { tool: decision.tool, args: decision.args },
        legalActions, state: preState as any, usage: decision.usage, illegal,
      });
      log({
        ts: Date.now(), type: "decision", gameId, model, seed, step,
        reasoning: decision.reasoning, action: { tool: decision.tool, args: decision.args }, legalActions, illegal,
      });
      emitState(state);

      // Loop guards — with no decision cap, these are the only non-terminal ways
      // a game ends: repeated rejected moves, or the state not changing at all.
      if (consecutiveIllegal >= maxConsecutiveIllegal) {
        rec.error = `stuck: ${consecutiveIllegal} consecutive illegal moves (last: ${illegal})`;
        break;
      }
      const sig = progressSig(state);
      noProgress = sig === lastSig ? noProgress + 1 : 0;
      lastSig = sig;
      if (noProgress >= NO_PROGRESS_LIMIT) {
        rec.error = `stuck: no state change for ${noProgress} moves`;
        break;
      }
    }

    // Win = the real win flag, or having advanced PAST ante 8 (ante_num ≥ 9).
    // state.ante hits 8 the moment ante 7's boss falls, so the old ">= 8" counted
    // merely *reaching* ante 8 — and even *losing* on its boss — as a win.
    rec.won = state.won === true || state.ante >= 9;
    // maxAnte = antes fully cleared (8 on a win; ante_num-1 otherwise, since the
    // ante counter only advances once a boss has been beaten).
    rec.maxAnte = rec.won ? 8 : Math.max(0, state.ante - 1);
    rec.finalRound = state.round;
    rec.finalMoney = state.money;
    rec.score = scoreFromTranscript(snapshots, rec.won).score;
    // Classify how the game ended (drives score-eligibility in the leaderboard:
    // won/lost/stuck count, error/cap are excluded). The cap branch is dead while
    // maxDecisions=0; a decide() failure is infra, not the model → "error".
    rec.outcome = rec.error?.startsWith("stuck") ? "stuck"
      : rec.error?.startsWith("cap") ? "cap"
      : rec.error?.startsWith("decide failed") ? "error"
      : rec.won ? "won"
      : (state.state === "GAME_OVER" || state.state === "MENU") ? "lost"
      : "error";
  } catch (e: any) {
    rec.error = rec.error ?? e.message;
    rec.outcome = "error";
  }

  rec.durationMs = Date.now() - t0;
  bus.emit({
    type: "result", gameId, model, seed, ts: Date.now(),
    outcome: rec.outcome, won: rec.won,
    finalAnte: rec.maxAnte, finalRound: rec.finalRound, dollars: rec.finalMoney,
  });
  log({ ts: Date.now(), type: "result", gameId, model, seed, record: rec });
  return rec;
}
