import { SummarizedState, CardSummary } from "../state/summarizer.js";

/** What a player returns each turn. The loop executes {tool, args}. */
export interface Decision {
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable rationale — shown in the live stream, logged for review. */
  reasoning?: string;
  /** Optional scratchpad carried to the next turn (cheap long-horizon memory). */
  notes?: string;
  /** Token/cost accounting, filled by LLM adapters (naive player leaves empty). */
  usage?: { tokensIn: number; tokensOut: number; costUsd?: number };
  /** Adapter diagnostics for provider-format failures and truncation analysis. */
  diagnostic?: {
    finishReason?: string | null;
    cause?: "length" | "no_tool_call" | "bad_tool_args" | "parse_error" | "no_response" | null;
    retried?: boolean;
    contentLength?: number;
    reasoningLength?: number;
    rawToolCallsCount?: number;
  };
}

/** Context the loop hands to the player alongside the state snapshot. */
export interface DecideCtx {
  step: number;
  legalActions: string[];
  /** notes the player returned last turn, if any. */
  notes?: string;
  /** If the previous move was rejected, the game's error — so the player can fix it. */
  lastError?: string;
  /** The move that was rejected (paired with lastError). */
  lastAction?: { tool: string; args: Record<string, unknown> };
}

export type DecideFn = (state: SummarizedState, ctx: DecideCtx) => Promise<Decision>;

const RANK: Record<string, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, T: 10, J: 11, Q: 12, K: 13, A: 14,
};
const rv = (c: CardSummary) => RANK[c.rank] ?? 0;

/** Pick a rough "best" set of indices: flush > pair(s) > nothing (→ discard). */
function pickBestHand(cards: CardSummary[]): number[] {
  if (cards.length < 1) return [];
  const bySuit: Record<string, CardSummary[]> = {};
  for (const c of cards) (bySuit[c.suit] ??= []).push(c);
  for (const g of Object.values(bySuit)) if (g.length >= 5) return g.slice(0, 5).map(c => c.index);

  const byRank: Record<string, CardSummary[]> = {};
  for (const c of cards) (byRank[c.rank] ??= []).push(c);
  const groups = Object.values(byRank)
    .filter(g => g.length >= 2)
    .sort((a, b) => b.length - a.length || rv(b[0]) - rv(a[0]));
  if (groups.length) return groups.flat().slice(0, 5).map(c => c.index);

  return [];
}

/**
 * Deterministic heuristic baseline. Not smart — it exists as a control to
 * compare LLMs against and to smoke-test the harness without spending tokens.
 */
export const naiveDecide: DecideFn = async (s) => {
  switch (s.state) {
    case "BLIND_SELECT":
      return { tool: "select_blind", args: {}, reasoning: "play the blind" };

    case "SELECTING_HAND": {
      const cards = s.hand_cards;
      const best = pickBestHand(cards);
      if (best.length) return { tool: "play_hand", args: { cards: best }, reasoning: "play best available hand" };
      if (s.discards_left > 0 && cards.length > 2) {
        const low = [...cards].sort((a, b) => rv(a) - rv(b)).slice(0, 3).map(c => c.index);
        return { tool: "discard", args: { cards: low }, reasoning: "discard low cards" };
      }
      return {
        tool: "play_hand",
        args: { cards: cards.slice(0, Math.min(5, cards.length)).map(c => c.index) },
        reasoning: "forced play (no discards left)",
      };
    }

    case "ROUND_EVAL":
      return { tool: "cash_out", args: {}, reasoning: "cash out the round" };

    case "SHOP":
      return { tool: "next_round", args: {}, reasoning: "skip shopping, go next round" };

    case "SMODS_BOOSTER_OPENED":
      return { tool: "pack_pick", args: { skip: true }, reasoning: "skip the pack" };

    default:
      return { tool: "get_game_state", args: {}, reasoning: `observe (${s.state})` };
  }
};
