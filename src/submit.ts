import * as fs from "fs";
import * as os from "os";
import { request } from "undici";
import Database from "better-sqlite3";
import { RunRecord } from "./game/loop.js";
import { ModelConfig, BenchConfig } from "./config.js";
import { computeCodeHash, EVAL_VERSION } from "./scoring/codehash.js";
import { gameMoves } from "./bench/db.js";

const RUNNER_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync("package.json", "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
})();

/** Assemble the submission payload from a finished run + its persisted moves.
 *  Sends the model's HOST only — never the full baseURL or the API key. */
export function buildSubmission(
  rec: RunRecord,
  moves: any[],
  model: ModelConfig,
  opts: { submitter?: string; startedAt?: number; endedAt?: number } = {},
) {
  let host = "local";
  try { host = new URL(model.baseURL).host; } catch { /* keep local */ }
  return {
    schemaVersion: 1,
    evalVersion: EVAL_VERSION,
    codeHash: computeCodeHash(),
    submittedAt: Date.now(),
    ...(opts.submitter ? { submitter: opts.submitter } : {}),
    model: { name: model.name, baseURLHost: host, modelId: model.model, mode: model.mode },
    config: { deck: rec.deck, stake: rec.stake, seed: rec.seed },
    runRecord: rec,
    moves: moves.map(m => ({
      step: m.step, ts: m.ts, state: m.state, tool: m.tool, args: m.args ?? {},
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      illegal: m.illegal ?? null,
      tokensIn: m.tokensIn ?? 0, tokensOut: m.tokensOut ?? 0, costUsd: m.costUsd ?? 0,
    })),
    clientMeta: {
      os: `${process.platform} ${os.release()}`.trim(),
      runnerVersion: RUNNER_VERSION,
      nodeVersion: process.version,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt ?? Date.now(),
    },
  };
}

export async function submitRun(baseUrl: string, submission: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const url = normalized.endsWith("/api/runs") ? normalized : normalized + "/api/runs";
  const res = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
  const body = await res.body.json().catch(() => ({}));
  return { ok: res.statusCode < 400, status: res.statusCode, body };
}

/** Submit a finished run to the configured backend, if enabled. Best-effort —
 *  a submission failure never breaks the run. Naive/baseline runs aren't sent. */
export async function maybeSubmit(db: Database.Database, rec: RunRecord, model: ModelConfig | null, cfg: BenchConfig): Promise<void> {
  if (!cfg.submit || !cfg.submitUrl || !model) return; // silently no-op when not configured
  try {
    const { moves } = gameMoves(db, rec.gameId);
    const submission = buildSubmission(rec, moves, model, { submitter: cfg.submitterHandle || undefined, startedAt: rec.ts });
    const r = await submitRun(cfg.submitUrl, submission);
    if (r.ok) console.error(`  submitted → score ${r.body.score ?? "?"}${r.body.official ? " (official)" : ""}${r.body.deduped ? " (dup)" : ""}`);
    else console.error(`  submit failed (${r.status}): ${JSON.stringify(r.body)}`);
  } catch (e: any) {
    console.error(`  submit error: ${e.message}`);
  }
}
