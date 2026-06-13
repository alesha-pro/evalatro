import { resolveModelConfig } from "../config.js";
import { makeOpenAiPlayer } from "./openai-adapter.js";
import { SummarizedState, CardSummary } from "../state/summarizer.js";

// Probe a configured model with ONE decision against a synthetic state.
// Verifies auth + endpoint + tool-calling/JSON parsing without launching a game.
//   npm run probe -- <model-name>

const card = (index: number, key: string, label: string, suit: string, rank: string): CardSummary =>
  ({ index, key, label, set: "", suit, rank, enhancement: null, edition: null, seal: null, sell_cost: 0, buy_cost: 0 });

// A SELECTING_HAND position with five spades in hand → a flush is available.
const FAKE: SummarizedState = {
  state: "SELECTING_HAND",
  ante: 1, round: 1, money: 4, deck: "RED", stake: "WHITE", seed: "PROBE",
  won: false, reroll_cost: 5, used_vouchers: [],
  blind: { name: "Small Blind", type: "SMALL", score: 300, status: "CURRENT" },
  score: { chips: 0, target: 300 },
  hands_left: 4, discards_left: 3,
  hand_cards: [
    card(0, "S_A", "Ace of Spades", "S", "A"),
    card(1, "S_K", "King of Spades", "S", "K"),
    card(2, "H_5", "Five of Hearts", "H", "5"),
    card(3, "D_2", "Two of Diamonds", "D", "2"),
    card(4, "S_Q", "Queen of Spades", "S", "Q"),
    card(5, "S_7", "Seven of Spades", "S", "7"),
    card(6, "S_3", "Three of Spades", "S", "3"),
    card(7, "C_9", "Nine of Clubs", "C", "9"),
  ],
  jokers: [], consumables: [],
  poker_hands: [
    { name: "Flush", level: 1, chips: 35, mult: 4 },
    { name: "Pair", level: 1, chips: 10, mult: 2 },
    { name: "High Card", level: 1, chips: 5, mult: 1 },
  ],
  legal_actions: ["play_hand", "discard", "use_consumable", "rearrange_jokers"],
};

async function main() {
  const name = process.argv[2]; // optional — no arg uses the .env model
  const m = resolveModelConfig(name);
  console.error(`Probing ${m.name}  (${m.model} @ ${m.baseURL}, mode=${m.mode})`);
  const decide = makeOpenAiPlayer(m);

  const t0 = Date.now();
  const d = await decide(FAKE, { step: 0, legalActions: FAKE.legal_actions, notes: undefined });
  console.error(
    `latency ${Date.now() - t0}ms · tokens in/out ${d.usage?.tokensIn}/${d.usage?.tokensOut} · $${d.usage?.costUsd ?? 0}`,
  );
  console.log(JSON.stringify({ tool: d.tool, args: d.args, reasoning: d.reasoning, notes: d.notes }, null, 2));

  const ok = ["play_hand", "discard", "use_consumable", "rearrange_jokers"].includes(d.tool);
  console.error(ok ? "✓ model returned a valid in-game action" : `✗ model returned "${d.tool}" (not a clean action — check mode/prompt)`);
}

main().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
