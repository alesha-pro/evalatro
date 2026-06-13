import { z } from "zod";
import { BalatroBotClient, GameState } from "../client/balatrobot.js";
import { summarizeState, SummarizedState } from "../state/summarizer.js";

/**
 * Single source of truth for the action surface.
 *
 * Both consumers read from here, so they can never drift:
 *   - the MCP server (server.ts) registers these as MCP tools (interactive path);
 *   - the LLM adapters render these into provider tool schemas (benchmark path).
 *
 * `kind: "action"` tools are the moves an agent makes and are exposed to the LLM.
 * `kind: "query"` tools (get_game_state) are MCP conveniences — the benchmark
 * loop feeds state to the model instead of making it ask.
 */
export interface ToolDef<S extends z.ZodObject<any> = z.ZodObject<any>> {
  name: string;
  description: string;
  kind: "action" | "query" | "control";
  schema: S;
  /** Game states (G.STATE) in which this tool is legal — hint for prompts/UX. */
  states: string[];
  execute: (client: BalatroBotClient, args: z.infer<S>) => Promise<GameState>;
}

const def = <S extends z.ZodObject<any>>(d: ToolDef<S>): ToolDef => d as unknown as ToolDef;
const actionNotes = z.string().max(1200).optional().describe(
  "Optional compact run memory for yourself next turn: current build plan, important purchases, priorities, and tactical reminders. This is not sent to the game.",
);
const actionSchema = <S extends z.ZodRawShape>(shape: S) => z.object({ ...shape, notes: actionNotes });

export const TOOLS: ToolDef[] = [
  def({
    name: "get_game_state",
    description: "Get a compact snapshot of the current game state.",
    kind: "query",
    schema: z.object({}),
    states: [],
    execute: (c) => c.gamestate(),
  }),
  def({
    name: "start_run",
    description: "Start a new run from the main menu with a deck and stake (optional seed). Control action — the benchmark harness starts runs itself, so this is not offered to the playing model.",
    kind: "control",
    schema: z.object({
      deck: z.string().describe("Deck name, e.g. RED, BLUE, ABANDONED"),
      stake: z.string().describe("Stake level, e.g. WHITE, RED, GOLD"),
      seed: z.string().optional().describe("Optional seed for a deterministic run"),
    }),
    states: ["MENU"],
    execute: (c, a) => c.start(a.deck, a.stake, a.seed),
  }),
  def({
    name: "play_hand",
    description: "Play cards from your hand (1-5 cards, by 0-based left-to-right index). The best poker hand scores the most chips.",
    kind: "action",
    schema: actionSchema({
      cards: z.array(z.number().int()).min(1).max(5).describe("0-based indices of cards to play"),
    }),
    states: ["SELECTING_HAND"],
    execute: (c, a) => c.play(a.cards),
  }),
  def({
    name: "discard",
    description: "Discard cards from your hand to draw replacements (costs one discard).",
    kind: "action",
    schema: actionSchema({
      cards: z.array(z.number().int()).min(1).max(5).describe("0-based indices of cards to discard"),
    }),
    states: ["SELECTING_HAND"],
    execute: (c, a) => c.discard(a.cards),
  }),
  def({
    name: "select_blind",
    description: "Select the current blind and begin the round.",
    kind: "action",
    schema: actionSchema({}),
    states: ["BLIND_SELECT"],
    execute: (c) => c.select(),
  }),
  def({
    name: "skip_blind",
    description: "Skip the current small or big blind (cannot skip a boss blind) to claim its tag.",
    kind: "action",
    schema: actionSchema({}),
    states: ["BLIND_SELECT"],
    execute: (c) => c.skip(),
  }),
  def({
    name: "shop_buy",
    description: "Buy a card, voucher, or pack from the shop by index.",
    kind: "action",
    schema: actionSchema({
      card: z.number().int().optional().describe("Index of shop card to buy"),
      voucher: z.number().int().optional().describe("Index of voucher to buy"),
      pack: z.number().int().optional().describe("Index of booster pack to buy"),
    }),
    states: ["SHOP"],
    execute: (c, a) => c.buy({ card: a.card, voucher: a.voucher, pack: a.pack }),
  }),
  def({
    name: "shop_sell",
    description: "Sell a joker or consumable for money.",
    kind: "action",
    schema: actionSchema({
      joker: z.number().int().optional().describe("Index of joker to sell"),
      consumable: z.number().int().optional().describe("Index of consumable to sell"),
    }),
    states: ["SHOP"],
    execute: (c, a) => c.sell({ joker: a.joker, consumable: a.consumable }),
  }),
  def({
    name: "shop_reroll",
    description: "Reroll the shop's card offerings (costs money).",
    kind: "action",
    schema: actionSchema({}),
    states: ["SHOP"],
    execute: (c) => c.reroll(),
  }),
  def({
    name: "cash_out",
    description: "Cash out the round's rewards and proceed to the shop.",
    kind: "action",
    schema: actionSchema({}),
    states: ["ROUND_EVAL"],
    execute: (c) => c.cashOut(),
  }),
  def({
    name: "next_round",
    description: "Leave the shop and advance to the next blind selection.",
    kind: "action",
    schema: actionSchema({}),
    states: ["SHOP"],
    execute: (c) => c.nextRound(),
  }),
  def({
    name: "use_consumable",
    description: "Use a consumable card (tarot, planet, or spectral), optionally targeting cards.",
    kind: "action",
    schema: actionSchema({
      consumable: z.number().int().describe("0-based index of consumable to use"),
      cards: z.array(z.number().int()).optional().describe("Target card indices, for consumables that need them"),
    }),
    states: ["SELECTING_HAND", "SHOP"],
    execute: (c, a) => c.use(a.consumable, a.cards),
  }),
  def({
    name: "pack_pick",
    description: "Pick a card from the opened booster pack (see state.pack.cards) by index, or skip it. " +
      "Tarot/Spectral cards that act on your cards ALSO need `targets` = indices of cards in state.hand_cards " +
      "(the pack card's effect says how many, e.g. 1-2). To skip the pack, pass skip:true (not skip:false).",
    kind: "action",
    schema: actionSchema({
      card: z.number().int().optional().describe("Index into state.pack.cards to pick"),
      targets: z.array(z.number().int()).optional().describe("Hand-card indices to target, required by tarot/spectral cards that modify your cards"),
      skip: z.boolean().optional().describe("Pass true to skip the pack without picking"),
    }),
    states: ["SMODS_BOOSTER_OPENED"],
    execute: (c, a) => c.pack({ card: a.card, targets: a.targets, skip: a.skip }),
  }),
  def({
    name: "rearrange_jokers",
    description: "Reorder your jokers (left-to-right order affects scoring).",
    kind: "action",
    schema: actionSchema({
      order: z.array(z.number().int()).describe("New joker order as a permutation of current indices"),
    }),
    states: ["SELECTING_HAND", "SHOP"],
    execute: (c, a) => c.rearrange({ jokers: a.order }),
  }),
];

export const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));
export const ACTION_TOOLS = TOOLS.filter(t => t.kind === "action");

/**
 * Action-tool NAMES legal in a given game state — the authoritative action list
 * fed to the model. Derived from each tool's `states`, so it can never drift
 * from the real callable surface (the old hand-written list named actions like
 * "buy_card"/"reroll" that didn't match the tools, manufacturing illegal moves).
 */
export function legalToolNames(state: string): string[] {
  return ACTION_TOOLS.filter(t => t.states.includes(state)).map(t => t.name);
}

/** Execute a tool by name and return the resulting summarized state. */
export async function executeTool(
  client: BalatroBotClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<SummarizedState> {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new Error(`UNKNOWN_TOOL - "${name}" is not a valid action`);
  let parsed: any;
  try {
    parsed = tool.schema.parse(args ?? {});
  } catch (e: any) {
    // Flatten the zod error into a short, model-readable message.
    const issues = e?.issues;
    const msg = Array.isArray(issues) && issues.length
      ? issues.map((i: any) => `${i.path?.length ? i.path.join(".") : "args"}: ${i.message}`).join("; ")
      : e.message;
    throw new Error(`BAD_ARGS - ${name}: ${msg}`);
  }
  const raw = await tool.execute(client, parsed);
  return summarizeState(raw);
}

// ── Minimal zod → JSON Schema for the OpenAI tool format ──────────────
// Covers exactly the shapes used above (object of number / array<number> /
// boolean / string, each optionally optional). Kept dependency-free.

function fieldToJson(schema: z.ZodTypeAny): any {
  let s: any = schema;
  while (s?._def && (s._def.typeName === "ZodOptional" || s._def.typeName === "ZodDefault")) {
    s = s._def.innerType;
  }
  const tn = s?._def?.typeName;
  const out: any =
    tn === "ZodNumber" ? { type: "integer" }
    : tn === "ZodString" ? { type: "string" }
    : tn === "ZodBoolean" ? { type: "boolean" }
    : tn === "ZodArray" ? { type: "array", items: fieldToJson(s._def.type) }
    : {};
  const desc = (schema as any)?._def?.description ?? s?._def?.description;
  if (desc) out.description = desc;
  return out;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, any>;
  required: string[];
  additionalProperties: boolean;
}

export function toJsonSchema(schema: z.ZodObject<any>): JsonSchema {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = fieldToJson(field);
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** OpenAI-compatible tool definitions for the action surface (for adapters). */
export function openAiTools() {
  return ACTION_TOOLS.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: toJsonSchema(t.schema) },
  }));
}
