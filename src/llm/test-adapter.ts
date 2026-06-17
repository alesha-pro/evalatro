import {
  parseChatResponse,
  extractJson,
  ChatResponse,
  buildChatPayload,
  retryOptionsForDecision,
  sanitizePayloadForProviderError,
} from "./openai-adapter.js";
import { openAiTools } from "../tools/registry.js";
import { ModelConfig } from "../config.js";

// Unit test for the response-parsing seam — no network, no game.

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, got: any, want: any) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const toolsCfg: ModelConfig = { name: "t", baseURL: "x", model: "m", mode: "tools" };
const jsonCfg: ModelConfig = { name: "j", baseURL: "x", model: "m", mode: "json", pricePerMTokIn: 1, pricePerMTokOut: 2 };

console.log("registry invariants:");
const names = openAiTools().map(t => t.function.name);
check("start_run NOT exposed to LLM", !names.includes("start_run"));
check("get_game_state NOT exposed to LLM", !names.includes("get_game_state"));
check("play_hand exposed", names.includes("play_hand"));
check("exactly 12 action tools", names.length === 12, `got ${names.length}`);
const playHandSchema = openAiTools().find(t => t.function.name === "play_hand")?.function.parameters;
check("action tools expose optional notes memory", !!playHandSchema?.properties.notes);
check("notes memory is optional", !(playHandSchema?.required ?? []).includes("notes"));

console.log("\ntools mode:");
let d = parseChatResponse(toolsCfg, {
  choices: [{ message: { content: "play a pair", tool_calls: [{ function: { name: "play_hand", arguments: '{"cards":[0,1,2]}' } }] } }],
  usage: { prompt_tokens: 50, completion_tokens: 10 },
} as ChatResponse);
eq("tool name", d.tool, "play_hand");
eq("args parsed", d.args, { cards: [0, 1, 2] });
eq("reasoning from content", d.reasoning, "play a pair");
eq("tokensIn tracked", d.usage?.tokensIn, 50);
eq("finish reason diagnostic defaults to null", d.diagnostic?.finishReason, null);
eq("tool call count diagnostic", d.diagnostic?.rawToolCallsCount, 1);

d = parseChatResponse(toolsCfg, {
  choices: [{ finish_reason: "tool_calls", message: { content: "", reasoning_content: "hidden chain", tool_calls: [{ function: { name: "discard", arguments: '{"cards":[4]}' } }] } }],
} as ChatResponse);
eq("reasoning_content is kept when content is empty", d.reasoning, "hidden chain");
eq("finish reason diagnostic is kept", d.diagnostic?.finishReason, "tool_calls");

d = parseChatResponse(toolsCfg, {
  choices: [{ finish_reason: "tool_calls", message: { content: "", reasoning: "OpenRouter reasoning field", tool_calls: [{ function: { name: "shop_buy", arguments: '{"card":1}' } }] } as any }],
} as ChatResponse);
eq("OpenRouter message.reasoning is kept when content is empty", d.reasoning, "OpenRouter reasoning field");
eq("OpenRouter reasoning contributes to diagnostic length", d.diagnostic?.reasoningLength, "OpenRouter reasoning field".length);

d = parseChatResponse(toolsCfg, {
  choices: [{ finish_reason: "tool_calls", message: { content: "", reasoning_details: [{ type: "reasoning.text", text: "reasoning details text" }], tool_calls: [{ function: { name: "next_round", arguments: '{}' } }] } as any }],
} as ChatResponse);
eq("OpenRouter reasoning_details text is used as a fallback", d.reasoning, "reasoning details text");

d = parseChatResponse(toolsCfg, {
  choices: [{ message: { content: "buying for mult build", tool_calls: [{ function: { name: "shop_buy", arguments: '{"card":0,"notes":"Build around flat mult; prioritize reliable pair/two-pair scoring."}' } }] } }],
} as ChatResponse);
eq("tool notes become carried memory", d.notes, "Build around flat mult; prioritize reliable pair/two-pair scoring.");
eq("tool notes are stripped from game args", d.args, { card: 0 });

d = parseChatResponse(toolsCfg, { choices: [{ message: { content: "just chatting" } }] } as ChatResponse);
eq("no tool_call -> sentinel (counts illegal)", d.tool, "no_tool_call");

d = parseChatResponse(toolsCfg, { choices: [{ finish_reason: "stop", message: { content: "Let me buy Mad Joker." } }] } as ChatResponse);
eq("no tool_call with normal stop explains missing tool call", d.reasoning, "model returned text without a tool call: Let me buy Mad Joker.");

d = parseChatResponse(toolsCfg, { choices: [{ finish_reason: "length", message: { content: "Let me buy Mad Joker." } }] } as ChatResponse);
check("no tool_call with length mentions MODEL_MAX_TOKENS", (d.reasoning ?? "").includes("MODEL_MAX_TOKENS"));
eq("no tool_call with length gets truncation sentinel", d.tool, "no_tool_call_length");
eq("no tool_call diagnostic cause is length", d.diagnostic?.cause, "length");

d = parseChatResponse(toolsCfg, { choices: [{ message: { tool_calls: [{ function: { name: "discard", arguments: "{bad" } }] } }] } as ChatResponse);
eq("bad args -> sentinel", d.tool, "bad_tool_args");

let payload = buildChatPayload(toolsCfg, "system", { state: "SHOP" } as any, { step: 1, legalActions: ["shop_buy"] });
eq("tools mode defaults to auto tool choice", payload.tool_choice, "auto");
eq("default max_tokens is 16k", payload.max_tokens, 16_384);

payload = buildChatPayload(toolsCfg, "system", { state: "SHOP" } as any, { step: 1, legalActions: ["shop_buy"] }, { toolChoice: "required" });
eq("tools mode can require a tool call when explicitly requested", payload.tool_choice, "required");

payload = buildChatPayload({ ...toolsCfg, maxTokens: 1_000_000 }, "system", { state: "SHOP" } as any, { step: 1, legalActions: ["shop_buy"] });
eq("max_tokens follows the configured per-turn limit", payload.max_tokens, 1_000_000);

eq("no_tool_call retry requires a tool", retryOptionsForDecision({ tool: "no_tool_call" }), { toolChoice: "required" });
eq("length no_tool_call retry requires a tool", retryOptionsForDecision({ tool: "no_tool_call_length" }), { toolChoice: "required" });
eq("normal tool call does not retry", retryOptionsForDecision({ tool: "play_hand" }), null);

console.log("\njson mode:");
d = parseChatResponse(jsonCfg, {
  choices: [{ message: { content: '```json\n{"reasoning":"r","tool":"discard","args":{"cards":[3]},"notes":"keep flush"}\n```' } }],
  usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
} as ChatResponse);
eq("fenced json -> tool", d.tool, "discard");
eq("fenced json -> args", d.args, { cards: [3] });
eq("explicit notes kept", d.notes, "keep flush");
eq("cost = 1M*$1 + 1M*$2", d.usage?.costUsd, 3);

d = parseChatResponse(jsonCfg, { choices: [{ message: { content: 'Sure! {"tool":"cash_out","args":{}} hope it helps' } }] } as ChatResponse);
eq("prose-wrapped json", d.tool, "cash_out");

d = parseChatResponse(jsonCfg, { choices: [{ message: { content: "no json here at all" } }] } as ChatResponse);
eq("garbage -> parse_error sentinel", d.tool, "parse_error");

d = parseChatResponse(jsonCfg, { choices: [{ message: { content: "thinking in prose", reasoning_content: '{"reasoning":"r2","tool":"discard","args":{"cards":[2]}}' } }] } as ChatResponse);
eq("json mode falls back from content to reasoning_content", d.tool, "discard");

d = parseChatResponse(jsonCfg, { choices: [{ message: { content: '{"reasoning":"r","tool":"select_blind","args":{}}' } }] } as ChatResponse);
eq("notes falls back to reasoning", d.notes, "r");

console.log("\nextractJson:");
eq("nested braces", extractJson('prefix {"a":{"b":1},"c":2} suffix'), { a: { b: 1 }, c: 2 });
eq("braces inside strings", extractJson('prefix {"reasoning":"play {card} here","tool":"play_hand","args":{"cards":[0]}} suffix'), { reasoning: "play {card} here", tool: "play_hand", args: { cards: [0] } });

console.log("\npayload provider fallback:");
const requiredPayload = buildChatPayload(toolsCfg, "system", { state: "SHOP" } as any, { step: 1, legalActions: ["shop_buy"] }, { toolChoice: "required" });
const noToolChoice = sanitizePayloadForProviderError(requiredPayload, "tool_choice required is not supported");
eq("tool_choice is dropped for provider errors", { field: noToolChoice?.field, hasToolChoice: Object.prototype.hasOwnProperty.call(noToolChoice?.payload ?? {}, "tool_choice") }, { field: "tool_choice", hasToolChoice: false });
const noCamelToolChoice = sanitizePayloadForProviderError(requiredPayload, "toolChoice is not a valid parameter");
eq("camelCase toolChoice provider errors drop tool_choice", { field: noCamelToolChoice?.field, hasToolChoice: Object.prototype.hasOwnProperty.call(noCamelToolChoice?.payload ?? {}, "tool_choice") }, { field: "tool_choice", hasToolChoice: false });
const jsonPayload = buildChatPayload(jsonCfg, "system", { state: "SHOP" } as any, { step: 1, legalActions: ["next_round"] });
const noResponseFormat = sanitizePayloadForProviderError(jsonPayload, "response_format json_object is not supported");
eq("response_format is dropped for provider errors", { field: noResponseFormat?.field, hasResponseFormat: Object.prototype.hasOwnProperty.call(noResponseFormat?.payload ?? {}, "response_format") }, { field: "response_format", hasResponseFormat: false });
const noTemperature = sanitizePayloadForProviderError(requiredPayload, "temperature is unsupported for this model");
eq("temperature is dropped for provider errors", { field: noTemperature?.field, hasTemperature: Object.prototype.hasOwnProperty.call(noTemperature?.payload ?? {}, "temperature") }, { field: "temperature", hasTemperature: false });
const noMaxTokens = sanitizePayloadForProviderError(requiredPayload, "max_tokens is not a valid field");
eq("max_tokens is dropped for provider errors", { field: noMaxTokens?.field, hasMaxTokens: Object.prototype.hasOwnProperty.call(noMaxTokens?.payload ?? {}, "max_tokens") }, { field: "max_tokens", hasMaxTokens: false });
eq("context length max_tokens errors are not treated as unsupported fields", sanitizePayloadForProviderError(requiredPayload, "context length exceeds max_tokens limit"), null);
eq("unrelated provider error has no sanitizer", sanitizePayloadForProviderError(requiredPayload, "invalid api key"), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
