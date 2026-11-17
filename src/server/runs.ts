import { createHash } from "crypto";
import { getDb, insertRun, insertSubmission, runHashExists, recordMovesArray } from "../bench/db.js";
import { SubmissionSchema, Submission, SCHEMA_VERSION } from "./schema.js";
import { isOfficialHash } from "./known-hashes.js";
import { computeScore, deriveScoreInput, MoveSnapshot } from "../scoring/score.js";
import { legalToolNames } from "../tools/registry.js";
import { RunRecord } from "../game/loop.js";

export interface SubmitResult { status: number; body: Record<string, unknown>; }

/** Stable hash of a run, for idempotent dedupe. */
function runHash(s: Submission): string {
  const seq = s.moves.map(m => `${m.tool}:${JSON.stringify(m.args ?? {})}`).join("|");
  const key = [s.model.modelId, s.config.seed, s.config.deck, s.config.stake, s.config.targetAnte ?? s.runRecord.targetAnte ?? 12, s.clientMeta.startedAt ?? 0, seq].join("\n");
  return "sha256:" + createHash("sha256").update(key).digest("hex");
}

/** The pre-move snapshots the scorer needs, lifted from each submitted move's state. */
function snapshotsOf(s: Submission): MoveSnapshot[] {
  return s.moves.map(m => {
    const st: any = m.state ?? {};
    return {
      state: typeof st.state === "string" ? st.state : "",
      ante: typeof st.ante === "number" ? st.ante : 0,
      blind: st.blind ?? null,
      score: st.score ?? { chips: 0, target: 0 },
      illegal: m.illegal ?? null,
    };
  });
}

interface Checks { hard: string[]; soft: string[]; maxAnte: number; }

function stateProvesWin(raw: unknown, targetAnte: number): boolean {
  const st: any = raw ?? {};
  return (targetAnte <= 8 && st.won === true) || (typeof st.ante === "number" && st.ante >= targetAnte + 1);
}

function finalStateOf(s: Submission): unknown {
  return (s as any).finalState ?? (s.runRecord as any).finalState;
}

export function transcriptProvesWin(s: Submission, targetAnte: number): boolean {
  if (stateProvesWin(finalStateOf(s), targetAnte)) return true;
  const maxAnte = s.moves.reduce((m, move) => {
    const st: any = move.state ?? {};
    return Math.max(m, typeof st.ante === "number" ? st.ante : 0);
  }, 0);
  return maxAnte >= targetAnte + 1;
}

/**
 * Transcript consistency checks. `hard` failures are tamper signals → reject.
 * `soft` flags are stored and force the run "unofficial" but keep it.
 */
export function sanityChecks(s: Submission, snaps: MoveSnapshot[], won: boolean, serverScore: number, targetAnte: number): Checks {
  const hard: string[] = [], soft: string[] = [];
  const maxAnte = snaps.reduce((m, x) => Math.max(m, x.ante || 0), 0);

  // An ante decrease is legal: Hieroglyph and Petroglyph both read "-1 Ante"
  // and are ordinary shop vouchers, so 5 → 4 is a real game state. Flag it
  // instead of rejecting. Scoring is peak-based (deriveScoreInput takes
  // Math.max over the snapshots), so a dip cannot move the score, and a client
  // that wanted to fabricate would simply emit a monotonic sequence anyway.
  let prev = 0;
  for (const x of snaps) { const a = x.ante || 0; if (a < prev) { soft.push("ante decreased mid-run"); break; } prev = Math.max(prev, a); }

  if (won && maxAnte < targetAnte && !stateProvesWin(finalStateOf(s), targetAnte)) {
    hard.push(`claimed win but transcript never reached ante ${targetAnte}`);
  }

  // every accepted (non-illegal) move must be legal for the state it was made in
  for (const m of s.moves) {
    if (m.illegal == null) {
      const st: any = m.state ?? {};
      const legal = legalToolNames(typeof st.state === "string" ? st.state : "");
      if (legal.length && !legal.includes(m.tool)) { hard.push(`accepted move illegal for state: ${m.tool} @ ${st.state}`); break; }
    }
  }

  // timestamps should be non-decreasing (soft — clock jitter is possible)
  for (let i = 1; i < s.moves.length; i++) {
    if ((s.moves[i].ts ?? 0) < (s.moves[i - 1].ts ?? 0)) { soft.push("timestamps out of order"); break; }
  }
  // plausible token counts (soft)
  for (const m of s.moves) {
    const t = m.tokensOut ?? 0;
    if (t < 0 || t > 1_000_000) { soft.push("implausible token count"); break; }
  }
  // client vs server score mismatch (soft — the server number is authoritative)
  if (Math.abs((s.runRecord.score ?? 0) - serverScore) > 1) soft.push(`client score ${s.runRecord.score} != server ${serverScore}`);

  return { hard, soft, maxAnte };
}

/**
 * Handle a POST /api/runs body. Validates, RECOMPUTES the score from the
 * transcript (the client's score/won are never trusted for ranking), runs
 * integrity checks, dedupes, and stores into runs + moves + submissions.
 */
export function handleSubmitRun(raw: unknown, ip = ""): SubmitResult {
  const parsed = SubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.slice(0, 5).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { status: 400, body: { error: "invalid submission: " + msg } };
  }
  const s = parsed.data;
  if (s.schemaVersion !== SCHEMA_VERSION) return { status: 400, body: { error: `unsupported schemaVersion ${s.schemaVersion} (expected ${SCHEMA_VERSION})` } };
  if (!s.moves.length) return { status: 400, body: { error: "no moves" } };

  const db = getDb();
  const hash = runHash(s);
  const dup = runHashExists(db, hash);
  if (dup !== undefined) return { status: 200, body: { ok: true, deduped: true, runId: dup } };

  // Recompute the score from the transcript — the client's numbers are advisory.
  const snaps = snapshotsOf(s);
  const targetAnte = Math.max(1, Math.floor(s.config.targetAnte ?? s.runRecord.targetAnte ?? 12));
  const won = transcriptProvesWin(s, targetAnte);
  const result = computeScore(deriveScoreInput(snaps, won, targetAnte), targetAnte);

  const checks = sanityChecks(s, snaps, won, result.score, targetAnte);
  if (s.runRecord.won === true && !won) checks.soft.push("client claimed win but transcript/finalState did not prove it");
  if (checks.hard.length) return { status: 422, body: { error: "rejected: " + checks.hard.join("; ") } };

  const official = isOfficialHash(s.evalVersion, s.codeHash) && checks.soft.length === 0 ? 1 : 0;

  // Keep outcome consistent with the server's win decision.
  let outcome = s.runRecord.outcome;
  if (won) outcome = "won";
  else if (outcome === "won") outcome = "lost"; // claimed a win the server can't confirm

  const rec: RunRecord = {
    ...s.runRecord,
    targetAnte,
    won,
    outcome: outcome as RunRecord["outcome"],
    maxAnte: won ? targetAnte : result.antesCleared,
    score: result.score,
    actions: result.actions,
    illegalActions: result.illegalActions,
  };
  const runId = insertRun(db, rec, "submission", official);
  recordMovesArray(db, s.runRecord.gameId, s.model.name, s.config.seed, s.moves);
  insertSubmission(db, {
    runId, runHash: hash, schemaVersion: s.schemaVersion, evalVersion: s.evalVersion, codeHash: s.codeHash,
    official, flags: checks.soft, submitter: s.submitter ?? null, modelHost: s.model.baseURLHost,
    clientMeta: s.clientMeta, ip,
  });

  return { status: 200, body: { ok: true, deduped: false, runId, score: result.score, official: !!official, flags: checks.soft } };
}
