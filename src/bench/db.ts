import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { RunRecord } from "../game/loop.js";
import { globalBus, EventBus } from "../bus/index.js";

const DB_PATH = path.resolve(process.env.BENCH_DB || path.join("bench", "bench.db"));

let _db: Database.Database | null = null;

/** Open (once) and migrate the SQLite DB. Singleton: one connection per process
 *  so the server can serve concurrent requests without opening a fresh handle
 *  (and fighting over the WAL) on every call. */
export function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync("bench", { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameId TEXT,
      model TEXT NOT NULL,
      seed TEXT NOT NULL,
      deck TEXT NOT NULL DEFAULT 'RED',
      stake TEXT NOT NULL DEFAULT 'WHITE',
      maxAnte INTEGER NOT NULL DEFAULT 0,
      finalRound INTEGER NOT NULL DEFAULT 0,
      finalMoney INTEGER NOT NULL DEFAULT 0,
      won INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      score REAL NOT NULL DEFAULT 0,
      actions INTEGER NOT NULL DEFAULT 0,
      illegalActions INTEGER NOT NULL DEFAULT 0,
      durationMs INTEGER NOT NULL DEFAULT 0,
      tokensIn INTEGER NOT NULL DEFAULT 0,
      tokensOut INTEGER NOT NULL DEFAULT 0,
      costUsd REAL NOT NULL DEFAULT 0,
      error TEXT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'local',
      official INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameId TEXT NOT NULL,
      model TEXT,
      seed TEXT,
      step INTEGER,
      ts INTEGER,
      state TEXT,
      tool TEXT,
      args TEXT,
      reasoning TEXT,
      illegal TEXT,
      tokensIn INTEGER DEFAULT 0,
      tokensOut INTEGER DEFAULT 0,
      costUsd REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model);
    CREATE INDEX IF NOT EXISTS idx_runs_seed ON runs(seed);
    CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(gameId);
    CREATE INDEX IF NOT EXISTS idx_moves_model ON moves(model);
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER,
      runHash TEXT UNIQUE,
      schemaVersion INTEGER,
      evalVersion TEXT,
      codeHash TEXT,
      official INTEGER DEFAULT 0,
      flags TEXT,
      submitter TEXT,
      modelHost TEXT,
      clientMeta TEXT,
      ip TEXT,
      ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_hash ON submissions(runHash);
    CREATE INDEX IF NOT EXISTS idx_runs_score ON runs(score);
  `);
  // Migrate older DBs (additive — safe to run on every open).
  try { db.exec("ALTER TABLE runs ADD COLUMN outcome TEXT"); } catch { /* already present */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN gameId TEXT"); } catch { /* already present */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN score REAL NOT NULL DEFAULT 0"); } catch { /* already present */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'local'"); } catch { /* already present */ }
  try { db.exec("ALTER TABLE runs ADD COLUMN official INTEGER NOT NULL DEFAULT 0"); } catch { /* already present */ }
  _db = db;
  return db;
}

export function insertRun(db: Database.Database, r: RunRecord, source = "local", official = 0): number {
  const stmt = db.prepare(`
    INSERT INTO runs (gameId, model, seed, deck, stake, maxAnte, finalRound, finalMoney, won, outcome, score,
                      actions, illegalActions, durationMs, tokensIn, tokensOut, costUsd, error, ts, source, official)
    VALUES (@gameId, @model, @seed, @deck, @stake, @maxAnte, @finalRound, @finalMoney, @won, @outcome, @score,
            @actions, @illegalActions, @durationMs, @tokensIn, @tokensOut, @costUsd, @error, @ts, @source, @official)
  `);
  return stmt.run({ ...r, won: r.won ? 1 : 0, ts: r.ts || Date.now(), source, official }).lastInsertRowid as number;
}

interface RunRow {
  model: string;
  maxAnte: number;
  won: number;
  actions: number;
  illegalActions: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
}

export interface ModelStats {
  model: string;
  runs: number;
  avgAnte: number;
  stdevAnte: number;
  maxAnte: number;
  winRate: number;
  illegalRate: number;
  avgActions: number;
  avgTokensIn: number;
  avgTokensOut: number;
  avgCostUsd: number;
  avgDurationMs: number;
  errors: number;
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const round = (x: number, d = 2) => { const f = 10 ** d; return Math.round(x * f) / f; };

/**
 * Aggregate per model. Stats are computed in JS (not SQL) so we can report
 * stdev and derived rates cleanly — the dataset is small (a pet-project matrix).
 */
export function modelStats(db: Database.Database): ModelStats[] {
  const rows = db.prepare(
    "SELECT model, maxAnte, won, actions, illegalActions, durationMs, tokensIn, tokensOut, costUsd, error FROM runs",
  ).all() as RunRow[];

  const byModel = new Map<string, RunRow[]>();
  for (const row of rows) {
    const arr = byModel.get(row.model) ?? [];
    arr.push(row);
    byModel.set(row.model, arr);
  }

  const out: ModelStats[] = [];
  for (const [model, rs] of byModel) {
    const antes = rs.map(r => r.maxAnte);
    const mean = avg(antes);
    const variance = avg(antes.map(a => (a - mean) ** 2));
    const totalActions = sum(rs.map(r => r.actions));
    const totalIllegal = sum(rs.map(r => r.illegalActions));
    out.push({
      model,
      runs: rs.length,
      avgAnte: round(mean),
      stdevAnte: round(Math.sqrt(variance)),
      maxAnte: antes.length ? Math.max(...antes) : 0,
      winRate: round(100 * avg(rs.map(r => (r.won ? 1 : 0))), 1),
      illegalRate: totalActions ? round((100 * totalIllegal) / totalActions, 1) : 0,
      avgActions: round(avg(rs.map(r => r.actions)), 1),
      avgTokensIn: Math.round(avg(rs.map(r => r.tokensIn))),
      avgTokensOut: Math.round(avg(rs.map(r => r.tokensOut))),
      avgCostUsd: round(avg(rs.map(r => r.costUsd)), 4),
      avgDurationMs: Math.round(avg(rs.map(r => r.durationMs))),
      errors: rs.filter(r => r.error).length,
    });
  }
  return out.sort((a, b) => b.avgAnte - a.avgAnte);
}

export interface LeaderboardRow {
  model: string;
  attempts: number;     // all runs
  scored: number;       // won + lost + stuck — games that count toward the score
  completed: number;    // won + lost (winRate denominator)
  incomplete: number;   // error + cap — excluded (infra / cut short)
  won: number;
  avgScore: number;     // 0–100 — PRIMARY ranking metric
  stdevScore: number;
  winRate: number;      // won / completed (%)
  avgAnte: number;      // antes cleared, over scored games
  stdevAnte: number;
  maxAnte: number;
  avgMoney: number;
  illegalRate: number;
  avgTokensOut: number;
  avgCostUsd: number;
  avgDurationMs: number;
}

interface LbRow {
  model: string; maxAnte: number; won: number; outcome: string | null; score: number; finalMoney: number;
  actions: number; illegalActions: number; durationMs: number; tokensOut: number; costUsd: number;
}

/** Outcomes that count toward a model's score: games that genuinely played out.
 *  A `stuck` game (illegal / no-progress loop) is a real failure and counts.
 *  `error` (infra / provider failure) and `cap` are excluded. */
const SCORED_OUTCOMES = new Set(["won", "lost", "stuck"]);

/**
 * Leaderboard ranked by the 0–100 score (mean ± stdev) over SCORED games
 * (won | lost | stuck). Games excluded for infra reasons (error | cap) are
 * surfaced via `incomplete` for transparency.
 */
export function leaderboard(db: Database.Database, opts: { officialOnly?: boolean } = {}): LeaderboardRow[] {
  const rows = db.prepare(
    "SELECT model, maxAnte, won, outcome, score, finalMoney, actions, illegalActions, durationMs, tokensOut, costUsd FROM runs" +
    (opts.officialOnly ? " WHERE official = 1" : ""),
  ).all() as LbRow[];

  const byModel = new Map<string, LbRow[]>();
  for (const r of rows) {
    const arr = byModel.get(r.model) ?? [];
    arr.push(r);
    byModel.set(r.model, arr);
  }

  const out: LeaderboardRow[] = [];
  for (const [model, rs] of byModel) {
    const scored = rs.filter(r => SCORED_OUTCOMES.has(r.outcome ?? ""));
    const done = rs.filter(r => r.outcome === "won" || r.outcome === "lost");
    const scores = scored.map(r => r.score ?? 0);
    const meanScore = avg(scores);
    const antes = scored.map(r => r.maxAnte);
    const meanAnte = avg(antes);
    const wonN = done.filter(r => r.won).length;
    const totalActions = sum(scored.map(r => r.actions));
    const totalIllegal = sum(scored.map(r => r.illegalActions));
    out.push({
      model,
      attempts: rs.length,
      scored: scored.length,
      completed: done.length,
      incomplete: rs.length - scored.length,
      won: wonN,
      avgScore: round(meanScore, 1),
      stdevScore: round(Math.sqrt(avg(scores.map(s => (s - meanScore) ** 2))), 1),
      winRate: done.length ? round((100 * wonN) / done.length, 1) : 0,
      avgAnte: round(meanAnte),
      stdevAnte: round(Math.sqrt(avg(antes.map(a => (a - meanAnte) ** 2)))),
      maxAnte: antes.length ? Math.max(...antes) : 0,
      avgMoney: round(avg(scored.map(r => r.finalMoney)), 1),
      illegalRate: totalActions ? round((100 * totalIllegal) / totalActions, 1) : 0,
      avgTokensOut: Math.round(avg(scored.map(r => r.tokensOut))),
      avgCostUsd: round(avg(scored.map(r => r.costUsd)), 4),
      avgDurationMs: Math.round(avg(scored.map(r => r.durationMs))),
    });
  }
  // Rank: avg score (primary), then win rate, then consistency (lower stdev).
  return out.sort((a, b) => b.avgScore - a.avgScore || b.winRate - a.winRate || a.stdevScore - b.stdevScore);
}

// ── Per-move history (for the per-game observability pages) ──

let movesSubscribed = false;

/**
 * Persist every decision event onto the moves table. Call once per process
 * (bench and live both do) — works off the shared event bus, so it captures
 * the full move-by-move history regardless of how the game was launched.
 */
export function recordMovesToDb(db: Database.Database, bus: EventBus = globalBus): void {
  if (movesSubscribed) return;
  movesSubscribed = true;
  const stmt = db.prepare(`
    INSERT INTO moves (gameId, model, seed, step, ts, state, tool, args, reasoning, illegal, tokensIn, tokensOut, costUsd)
    VALUES (@gameId, @model, @seed, @step, @ts, @state, @tool, @args, @reasoning, @illegal, @tokensIn, @tokensOut, @costUsd)
  `);
  bus.subscribe((ev) => {
    if (ev.type !== "decision") return;
    const d = ev as any;
    try {
      stmt.run({
        gameId: d.gameId ?? "?", model: d.model ?? "?", seed: d.seed ?? "?",
        step: d.step ?? null, ts: d.ts ?? Date.now(),
        state: JSON.stringify(d.state ?? {}),
        tool: d.action?.tool ?? "", args: JSON.stringify(d.action?.args ?? {}),
        reasoning: d.reasoning ?? "", illegal: d.illegal ?? null,
        tokensIn: d.usage?.tokensIn ?? 0, tokensOut: d.usage?.tokensOut ?? 0, costUsd: d.usage?.costUsd ?? 0,
      });
    } catch { /* never let move-logging break a game */ }
  });
}

// ── Submission path (server side) ──

/** Insert a batch of moves for one game from an array (not the live bus). */
export function recordMovesArray(
  db: Database.Database,
  gameId: string,
  model: string,
  seed: string,
  moves: Array<{ step?: number; ts?: number; state?: unknown; tool?: string; args?: unknown; reasoning?: string; illegal?: string | null; tokensIn?: number; tokensOut?: number; costUsd?: number }>,
): void {
  const stmt = db.prepare(`
    INSERT INTO moves (gameId, model, seed, step, ts, state, tool, args, reasoning, illegal, tokensIn, tokensOut, costUsd)
    VALUES (@gameId, @model, @seed, @step, @ts, @state, @tool, @args, @reasoning, @illegal, @tokensIn, @tokensOut, @costUsd)
  `);
  const insertAll = db.transaction((rows: typeof moves) => {
    for (const m of rows) stmt.run({
      gameId, model, seed,
      step: m.step ?? null, ts: m.ts ?? Date.now(),
      state: JSON.stringify(m.state ?? {}),
      tool: m.tool ?? "", args: JSON.stringify(m.args ?? {}),
      reasoning: m.reasoning ?? "", illegal: m.illegal ?? null,
      tokensIn: m.tokensIn ?? 0, tokensOut: m.tokensOut ?? 0, costUsd: m.costUsd ?? 0,
    });
  });
  insertAll(moves);
}

export interface SubmissionRow {
  runId: number; runHash: string; schemaVersion: number; evalVersion: string; codeHash: string;
  official: number; flags: string[]; submitter?: string | null; modelHost?: string | null;
  clientMeta?: unknown; ip?: string | null;
}

export function insertSubmission(db: Database.Database, s: SubmissionRow): number {
  const stmt = db.prepare(`
    INSERT INTO submissions (runId, runHash, schemaVersion, evalVersion, codeHash, official, flags, submitter, modelHost, clientMeta, ip, ts)
    VALUES (@runId, @runHash, @schemaVersion, @evalVersion, @codeHash, @official, @flags, @submitter, @modelHost, @clientMeta, @ip, @ts)
  `);
  return stmt.run({
    runId: s.runId, runHash: s.runHash, schemaVersion: s.schemaVersion, evalVersion: s.evalVersion,
    codeHash: s.codeHash, official: s.official, flags: JSON.stringify(s.flags ?? []),
    submitter: s.submitter ?? null, modelHost: s.modelHost ?? null,
    clientMeta: JSON.stringify(s.clientMeta ?? {}), ip: s.ip ?? null, ts: Date.now(),
  }).lastInsertRowid as number;
}

/** Returns the runId of an already-submitted run with this hash, or undefined (idempotent dedupe). */
export function runHashExists(db: Database.Database, runHash: string): number | undefined {
  const row = db.prepare("SELECT runId FROM submissions WHERE runHash = ? LIMIT 1").get(runHash) as { runId: number } | undefined;
  return row?.runId;
}

const safeParse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export interface GameSummary {
  gameId: string; model: string; seed: string; outcome: string | null; won: number; score: number;
  source: string; official: number;
  maxAnte: number; finalMoney: number; actions: number; illegalActions: number;
  durationMs: number; tokensOut: number; costUsd: number; ts: number; moveCount: number;
}

/** All games (runs) for a model, newest first, with move counts. */
export function gamesByModel(db: Database.Database, model: string): GameSummary[] {
  const runs = db.prepare(
    "SELECT gameId, model, seed, outcome, won, score, source, official, maxAnte, finalMoney, actions, illegalActions, durationMs, tokensOut, costUsd, ts FROM runs WHERE model = ? ORDER BY ts DESC",
  ).all(model) as any[];
  const countStmt = db.prepare("SELECT COUNT(*) c FROM moves WHERE gameId = ?");
  return runs.map(r => ({ ...r, moveCount: r.gameId ? (countStmt.get(r.gameId) as any).c : 0 }));
}

/** Full move-by-move history for one game (plus its run summary). */
export function gameMoves(db: Database.Database, gameId: string): { run: any; moves: any[] } {
  const run = db.prepare("SELECT * FROM runs WHERE gameId = ? LIMIT 1").get(gameId) ?? null;
  const rows = db.prepare(
    "SELECT step, ts, state, tool, args, reasoning, illegal, tokensIn, tokensOut, costUsd FROM moves WHERE gameId = ? ORDER BY id ASC",
  ).all(gameId) as any[];
  const moves = rows.map(m => ({ ...m, state: safeParse(m.state), args: safeParse(m.args) }));
  return { run, moves };
}
