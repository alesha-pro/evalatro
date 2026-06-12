import { parseChatResponse, extractJson, ChatResponse } from "./openai-adapter.js";
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

console.log("\ntools mode:");
let d = parseChatResponse(toolsCfg, {
  choices: [{ message: { content: "play a pair", tool_calls: [{ function: { name: "play_hand", arguments: '{"cards":[0,1,2]}' } }] } }],
  usage: { prompt_tokens: 50, completion_tokens: 10 },
} as ChatResponse);
eq("tool name", d.tool, "play_hand");
eq("args parsed", d.args, { cards: [0, 1, 2] });
eq("reasoning from content", d.reasoning, "play a pair");
eq("tokensIn tracked", d.usage?.tokensIn, 50);

d = parseChatResponse(toolsCfg, { choices: [{ message: { content: "just chatting" } }] } as ChatResponse);
eq("no tool_call -> sentinel (counts illegal)", d.tool, "no_tool_call");

d = parseChatResponse(toolsCfg, { choices: [{ message: { tool_calls: [{ function: { name: "discard", arguments: "{bad" } }] } }] } as ChatResponse);
eq("bad args -> sentinel", d.tool, "bad_tool_args");

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

d = parseChatResponse(jsonCfg, { choices: [{ message: { content: '{"reasoning":"r","tool":"select_blind","args":{}}' } }] } as ChatResponse);
eq("notes falls back to reasoning", d.notes, "r");

console.log("\nextractJson:");
eq("nested braces", extractJson('prefix {"a":{"b":1},"c":2} suffix'), { a: { b: 1 }, c: 2 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
