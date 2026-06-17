export interface CardT {
  index: number; key: string; label: string; set?: string;
  suit?: string; rank?: string; enhancement?: string | null; edition?: string | null; seal?: string | null;
  sell_cost?: number; buy_cost?: number; effect?: string;
  eternal?: boolean; perishable?: number | null; rental?: boolean; hidden?: boolean; debuff?: boolean;
}
export interface BlindT { name: string; type: string; score: number; status: string; effect?: string; skip_tag?: string; skip_reward?: string; }
export interface StateT {
  state: string; ante: number; round: number; money: number; deck: string; stake: string; seed: string; won?: boolean;
  blind?: BlindT | null; blinds?: { small: BlindT; big: BlindT; boss: BlindT };
  score: { chips: number; target: number }; hands_left: number; discards_left: number; reroll_cost?: number; used_vouchers?: string[];
  hand_cards: CardT[]; jokers: CardT[]; consumables: CardT[];
  shop?: { cards: CardT[]; vouchers: CardT[]; packs: CardT[] }; pack?: { cards: CardT[] };
  poker_hands?: { name: string; level: number; chips: number; mult: number }[]; legal_actions?: string[];
}
export interface LeaderboardRow {
  model: string; attempts: number; scored: number; completed: number; incomplete: number; won: number;
  avgScore: number; stdevScore: number; winRate: number; avgAnte: number; stdevAnte: number; maxAnte: number;
  avgMoney: number; illegalRate: number; avgTokensOut: number; avgCostUsd: number; avgDurationMs: number;
}
export interface GameSummaryT {
  gameId: string; model: string; seed: string; outcome: string | null; won: number; score: number;
  source: string; official: number; maxAnte: number; finalMoney: number; actions: number; illegalActions: number;
  durationMs: number; tokensOut: number; costUsd: number; ts: number; moveCount: number;
}
export interface MoveT {
  step: number; ts: number; state: StateT; tool: string; args: Record<string, unknown>;
  reasoning?: string; illegal?: string | null; finishReason?: string | null; diagnostic?: Record<string, unknown> | null;
  tokensIn?: number; tokensOut?: number; costUsd?: number;
}
export interface RunRow {
  gameId: string; model: string; seed: string; deck: string; stake: string; outcome: string | null; won: number;
  score: number; source: string; official: number; maxAnte: number; finalRound: number; finalMoney: number;
  actions: number; illegalActions: number; durationMs: number; tokensIn: number; tokensOut: number; costUsd: number;
  error: string | null; ts: number;
}
export interface GameDetail { run: RunRow | null; moves: MoveT[]; }

export interface LiveEvent {
  type: string; gameId?: string; model?: string; seed?: string; ts?: number;
  state?: StateT; reasoning?: string; action?: { tool: string; args: Record<string, unknown> };
  illegal?: string; finishReason?: string | null; diagnostic?: Record<string, unknown>;
  step?: number; usage?: { tokensIn: number; tokensOut: number; costUsd?: number };
  outcome?: string; won?: boolean; finalAnte?: number; finalRound?: number; dollars?: number;
}
