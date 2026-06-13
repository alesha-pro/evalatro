import { request } from "undici";
import * as fs from "fs";
import { ModelConfig, resolveApiKey } from "../config.js";
import { DecideFn, Decision, DecideCtx } from "../game/decide.js";
import { SummarizedState } from "../state/summarizer.js";
import { ACTION_TOOLS, openAiTools } from "../tools/registry.js";

const SYSTEM_PROMPT_PATH = "src/agent/SYSTEM_PROMPT.md";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Shapes of the OpenAI-compatible chat/completions response ──
export interface ChatResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function loadStrategyPrompt(): string {
  try {
    return fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
  } catch {
    return "You are a Balatro AI player. Reach the highest ante possible.";
  }
}

function toolListForPrompt(): string {
  return ACTION_TOOLS.map(t => {
    const params = Object.keys((t.schema as any).shape ?? {});
    return `- ${t.name}(${params.join(", ")}) — ${t.description}`;
  }).join("\n");
}

/** Extract a JSON object from possibly-noisy model output (code fences, prose). */
export function extractJson(text: string): any {
  let t = (text ?? "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === "{") depth++;
    else if (t[i] === "}") {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON object");
}

function estimateCost(cfg: ModelConfig, usage?: ChatResponse["usage"]): number {
  if (!usage) return 0;
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  return (inTok / 1e6) * (cfg.pricePerMTokIn ?? 0) + (outTok / 1e6) * (cfg.pricePerMTokOut ?? 0);
}

function splitToolNotes(args: Record<string, unknown>): { args: Record<string, unknown>; notes?: string } {
  const notes = typeof args.notes === "string" ? args.notes.trim() : "";
  if (!("notes" in args)) return { args };
  const { notes: _notes, ...cleanArgs } = args;
  return { args: cleanArgs, notes: notes || undefined };
}

/**
 * Pure response → Decision mapping. This is the unit-testable seam: it takes a
 * raw chat response (no network) and produces the move.
 *
 * Malformed output (no tool call, bad args, unparseable JSON) returns a Decision
 * with an INVALID tool name on purpose — the game loop then rejects it via
 * executeTool, counting it as an illegal move (a rules/format-understanding
 * signal) and continuing, rather than crashing the whole run.
 */
export function parseChatResponse(cfg: ModelConfig, json: ChatResponse): Decision {
  const usage = {
    tokensIn: json.usage?.prompt_tokens ?? 0,
    tokensOut: json.usage?.completion_tokens ?? 0,
    costUsd: estimateCost(cfg, json.usage),
  };
  const choice = json.choices?.[0];
  const msg = choice?.message;
  if (!msg) return { tool: "no_response", args: {}, reasoning: "model returned no message", usage };
  // Reasoning models put their chain-of-thought in reasoning_content — fall back to it.
  const think = (msg.content || msg.reasoning_content || "").trim();

  if (cfg.mode === "tools") {
    const call = msg.tool_calls?.[0];
    if (!call) {
      const why = choice?.finish_reason === "length"
        ? `model produced no tool call before finish_reason=length (raise MODEL_MAX_TOKENS or reduce prompt): ${think}`.trim()
        : think
          ? `model returned text without a tool call: ${think}`
          : `model produced no tool call (finish_reason=${choice?.finish_reason ?? "unknown"})`;
      return { tool: "no_tool_call", args: {}, reasoning: why, notes: think || undefined, usage };
    }
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return { tool: "bad_tool_args", args: {}, reasoning: `unparseable tool args: ${call.function.arguments}`, usage };
    }
    const split = splitToolNotes(args);
    return { tool: call.function.name, args: split.args, reasoning: think, notes: split.notes ?? (think || undefined), usage };
  }

  // mode === "json"
  let parsed: any;
  try {
    parsed = extractJson(msg.content ?? msg.reasoning_content ?? "");
  } catch (e: any) {
    return { tool: "parse_error", args: {}, reasoning: `JSON parse failed: ${e.message} | raw: ${think.slice(0, 200)}`, usage };
  }
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  return {
    tool: typeof parsed.tool === "string" ? parsed.tool : "missing_tool",
    args: parsed.args && typeof parsed.args === "object" ? parsed.args : {},
    reasoning,
    notes: typeof parsed.notes === "string" ? parsed.notes : (reasoning || undefined),
    usage,
  };
}

export function buildChatPayload(
  cfg: ModelConfig,
  systemContent: string,
  state: SummarizedState,
  ctx: DecideCtx,
  opts: { toolChoice?: "auto" | "required" } = {},
): Record<string, unknown> {
  const errBlock = ctx.lastError
    ? `⚠ Your previous action was REJECTED by the game — do NOT repeat it:\n` +
      `  action: ${ctx.lastAction ? ctx.lastAction.tool + " " + JSON.stringify(ctx.lastAction.args) : "(unknown)"}\n` +
      `  error: ${ctx.lastError}\n` +
      `Pick a DIFFERENT, valid action that fixes this.\n\n`
    : "";
  const userContent =
    errBlock +
    `Current game state:\n${JSON.stringify(state)}\n\n` +
    `Legal actions now: ${ctx.legalActions.join(", ")}\n` +
    `Your notes from last turn: ${ctx.notes ?? "(none)"}\n\n` +
    `Make your move.`;

  const payload: any = {
    model: cfg.model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    temperature: cfg.temperature ?? 0.3,
    max_tokens: cfg.maxTokens ?? 2048,
  };
  if (cfg.mode === "tools") {
    payload.tools = openAiTools();
    payload.tool_choice = opts.toolChoice ?? "auto";
  } else {
    payload.response_format = { type: "json_object" };
  }
  return payload;
}

async function callChat(
  endpoint: string,
  apiKey: string | undefined,
  extraHeaders: Record<string, string> | undefined,
  payload: unknown,
  retries = 2,
): Promise<ChatResponse> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      let res;
      try {
        res = await request(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...(extraHeaders ?? {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const body = (await res.body.json()) as ChatResponse;
      if (res.statusCode < 400) return body;
      const m = body?.error?.message ?? `status ${res.statusCode}`;
      const err = new Error(`HTTP ${res.statusCode}: ${m}`);
      // 4xx (except rate-limit) are caller errors — don't retry.
      if (res.statusCode < 500 && res.statusCode !== 429) throw err;
      lastErr = err;
    } catch (e: any) {
      if (e.message?.startsWith("HTTP 4") && !e.message.startsWith("HTTP 429")) throw e;
      lastErr = e;
    }
    if (attempt < retries) await sleep(1500 * (attempt + 1));
  }
  throw new Error(`chat request failed: ${lastErr?.message ?? "unknown"}`);
}

/**
 * Build a DecideFn backed by an OpenAI-compatible /v1/chat/completions endpoint.
 * Same code for cloud and local — only the config (baseURL/model/mode) differs.
 *
 * Stateless per turn + a carried "notes" scratchpad: each call sends the current
 * state and the model's own note from last turn (cheap long-horizon memory that
 * keeps token cost bounded over a 100-300 move game).
 */
export function makeOpenAiPlayer(cfg: ModelConfig): DecideFn {
  const strategy = loadStrategyPrompt();
  const apiKey = resolveApiKey(cfg); // throws early if apiKeyEnv is set but missing
  const endpoint = `${cfg.baseURL.replace(/\/+$/, "")}/chat/completions`;

  const systemContent =
    cfg.mode === "tools"
      ? `${strategy}\n\n## How to respond\nEach turn, call exactly ONE tool to make your move. Reason briefly in your message text, then make the call. Only use actions that are legal in the current state. Every action accepts an optional \`notes\` string. Use \`notes\` as compact run memory for your next turn: current build plan, important purchases, shop priorities, and tactical reminders. Keep notes under 1200 characters; do not put private API keys or irrelevant history there.`
      : `${strategy}\n\n## How to respond\nReply with ONLY a JSON object, nothing around it:\n` +
        `{"reasoning": "<short why>", "tool": "<tool name>", "args": { ... }, "notes": "<plan to remember next turn>"}\n\n` +
        `Available tools:\n${toolListForPrompt()}\n\nCard indices are 0-based, left to right. Only use actions legal in the current state.`;

  return async (state: SummarizedState, ctx: DecideCtx): Promise<Decision> => {
    const payload = buildChatPayload(cfg, systemContent, state, ctx);
    const json = await callChat(endpoint, apiKey, cfg.extraHeaders, payload);
    const decision = parseChatResponse(cfg, json);
    if (cfg.mode !== "tools" || decision.tool !== "no_tool_call") return decision;

    const retryCtx: DecideCtx = {
      ...ctx,
      lastError: "Your previous response was text-only. Reason briefly if needed, but you must also call exactly one valid tool.",
      lastAction: undefined,
    };
    const retryPayload = buildChatPayload(cfg, systemContent, state, retryCtx);
    const retryJson = await callChat(endpoint, apiKey, cfg.extraHeaders, retryPayload, 0);
    const retry = parseChatResponse(cfg, retryJson);
    if (retry.reasoning) {
      retry.reasoning = `${decision.reasoning}\n\nRetry after missing tool call:\n${retry.reasoning}`;
    } else {
      retry.reasoning = `${decision.reasoning}\n\nRetry after missing tool call returned ${retry.tool}.`;
    }
    retry.usage = {
      tokensIn: (decision.usage?.tokensIn ?? 0) + (retry.usage?.tokensIn ?? 0),
      tokensOut: (decision.usage?.tokensOut ?? 0) + (retry.usage?.tokensOut ?? 0),
      costUsd: (decision.usage?.costUsd ?? 0) + (retry.usage?.costUsd ?? 0),
    };
    return retry;
  };
}
