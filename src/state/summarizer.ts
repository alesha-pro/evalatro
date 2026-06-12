import { GameState, Card, CardArea, BlindInfo } from "../client/balatrobot.js";
import { legalToolNames } from "../tools/registry.js";

/**
 * Human-readable description of each game state. The legal ACTIONS are NOT kept
 * here — they come from the tool registry (legalToolNames), so the action names
 * the model sees are always exactly the callable tool names and can never drift.
 */
const STATE_DESC: Record<string, string> = {
  MENU: "Main menu. A new run can be started.",
  BLIND_SELECT: "Choosing a blind to play or skip.",
  SELECTING_HAND: "Selecting cards to play or discard.",
  ROUND_EVAL: "Round complete. Ready to cash out.",
  SHOP: "Shopping phase.",
  SMODS_BOOSTER_OPENED: "Booster pack opened. Pick a card or skip.",
  GAME_OVER: "Game over.",
};

export function computeLegalActions(state: string): { state: string; actions: string[] } {
  return { state: STATE_DESC[state] ?? `Unknown state: ${state}`, actions: legalToolNames(state) };
}

export interface BlindSummary {
  name: string;
  type: string;
  score: number;
  status: string;
  /** Boss blind effect (e.g. "-1 hand size"); empty for small/big. */
  effect?: string;
  /** Reward tag for SKIPPING this blind (small/big only) + what it does. */
  skip_tag?: string;
  skip_reward?: string;
}

export interface SummarizedState {
  state: string;
  ante: number;
  round: number;
  money: number;
  deck: string;
  stake: string;
  seed: string;
  won: boolean;
  /** The blind to act on right now (the one you select/play). */
  blind: BlindSummary | null;
  /** All three blinds of this ante — see the boss while deciding to skip. */
  blinds?: { small: BlindSummary; big: BlindSummary; boss: BlindSummary };
  score: { chips: number; target: number };
  hands_left: number;
  discards_left: number;
  reroll_cost: number;
  used_vouchers: string[];
  hand_cards: CardSummary[];
  jokers: CardSummary[];
  consumables: CardSummary[];
  shop?: { cards: CardSummary[]; vouchers: CardSummary[]; packs: CardSummary[] };
  /** Cards inside the currently opened booster pack (state SMODS_BOOSTER_OPENED). */
  pack?: { cards: CardSummary[] };
  poker_hands: { name: string; level: number; chips: number; mult: number }[];
  legal_actions: string[];
}

export interface CardSummary {
  index: number;
  key: string;
  label: string;
  /** Card kind: "" for playing cards, else TAROT / PLANET / SPECTRAL / JOKER / VOUCHER… */
  set: string;
  suit: string;
  rank: string;
  enhancement: string | null;
  edition: string | null;
  seal: string | null;
  sell_cost: number;
  buy_cost: number;
  /** What the card does (jokers, consumables, pack cards) — omitted when empty. */
  effect?: string;
  /** Joker stickers — present only when set. */
  eternal?: boolean;
  perishable?: number | null;
  rental?: boolean;
  /** Face-down (fog-of-war boss): identity is masked, like a human seeing a card back. */
  hidden?: boolean;
  /** Debuffed — visible but disabled (e.g. a boss-debuffed suit). */
  debuff?: boolean;
}

function summarizeCards(area: CardArea): CardSummary[] {
  return (area?.cards ?? []).map((c: Card, i: number) => {
    // balatrobot reports a card's true value even when it is face-down, so we
    // must mask hidden cards ourselves — otherwise the model "sees" through
    // fog-of-war bosses (The House / The Fish / The Mark) that a human cannot.
    const hidden = !!(c.state as any)?.hidden;
    if (hidden) {
      return {
        index: i, key: "?", label: "(face down)", set: "",
        suit: "?", rank: "?", enhancement: null, edition: null, seal: null,
        sell_cost: c.cost?.sell ?? 0, buy_cost: c.cost?.buy ?? 0, hidden: true,
      };
    }
    const debuff = !!(c.state as any)?.debuff;
    return {
      index: i,
      key: c.key,
      label: c.label,
      set: c.set ?? "",
      suit: c.value?.suit ?? "",
      rank: c.value?.rank ?? "",
      enhancement: c.modifier?.enhancement ?? null,
      edition: c.modifier?.edition ?? null,
      seal: c.modifier?.seal ?? null,
      sell_cost: c.cost?.sell ?? 0,
      buy_cost: c.cost?.buy ?? 0,
      ...(debuff ? { debuff: true } : {}),
      ...(c.value?.effect ? { effect: c.value.effect } : {}),
      ...(c.modifier?.eternal ? { eternal: true } : {}),
      ...(c.modifier?.perishable ? { perishable: c.modifier.perishable } : {}),
      ...(c.modifier?.rental ? { rental: true } : {}),
    };
  });
}

function summarizeBlind(b: BlindInfo): BlindSummary {
  return {
    name: b.name, type: b.type, score: b.score, status: b.status,
    ...(b.effect ? { effect: b.effect } : {}),
    ...(b.tag_name ? { skip_tag: b.tag_name, skip_reward: b.tag_effect } : {}),
  };
}

export function summarizeState(raw: GameState): SummarizedState {
  const legal = computeLegalActions(raw.state);
  const blinds = raw.blinds
    ? { small: summarizeBlind(raw.blinds.small), big: summarizeBlind(raw.blinds.big), boss: summarizeBlind(raw.blinds.boss) }
    : undefined;
  // The active blind is the one to SELECT (at BLIND_SELECT) or CURRENT (in play).
  const current = blinds
    ? [blinds.small, blinds.big, blinds.boss].find(b => b.status === "SELECT" || b.status === "CURRENT") ?? blinds.boss
    : null;
  return {
    state: raw.state,
    ante: raw.ante_num,
    round: raw.round_num,
    money: raw.money,
    deck: raw.deck,
    stake: raw.stake,
    seed: raw.seed,
    won: raw.won ?? false,
    blind: current,
    blinds,
    score: { chips: raw.round?.chips ?? 0, target: current?.score ?? 0 },
    hands_left: raw.round?.hands_left ?? 0,
    discards_left: raw.round?.discards_left ?? 0,
    reroll_cost: raw.round?.reroll_cost ?? 0,
    used_vouchers: raw.used_vouchers ?? [],
    hand_cards: summarizeCards(raw.hand),
    jokers: summarizeCards(raw.jokers),
    consumables: summarizeCards(raw.consumables),
    shop: raw.shop ? {
      cards: summarizeCards(raw.shop),
      vouchers: summarizeCards(raw.vouchers),
      packs: summarizeCards(raw.packs),
    } : undefined,
    pack: raw.pack && raw.pack.cards?.length ? { cards: summarizeCards(raw.pack) } : undefined,
    poker_hands: Object.entries(raw.hands ?? {}).map(([name, info]) => ({
      name, level: info.level, chips: info.chips, mult: info.mult,
    })),
    legal_actions: legal.actions,
  };
}
