import * as fs from "fs";
import * as path from "path";

// Load .env (gitignored) into process.env before anything reads API keys.
// Minimal parser, no dependency. Real environment variables take precedence.
function loadDotEnv(): void {
  try {
    const p = path.resolve(process.env.DOTENV_PATH || ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* best effort */ }
}
loadDotEnv();

/**
 * One model entry = one player in the benchmark.
 * Works with any OpenAI-compatible /v1/chat/completions endpoint:
 * OpenRouter, OpenAI, DeepSeek, Groq, Together, and local servers
 * (Ollama, LM Studio, vLLM, llama.cpp). Cloud and local on equal footing.
 *
 * API keys are NEVER stored here — only the NAME of the env var that holds them.
 */
export interface ModelConfig {
  /** Display id used in the leaderboard / stream (must be unique). */
  name: string;
  /** Base URL up to and including /v1, e.g. "https://openrouter.ai/api/v1". */
  baseURL: string;
  /** Provider model id, e.g. "openai/gpt-4o-mini" or "llama3.1:8b". */
  model: string;
  /** Name of the env var holding the API key. Omit for keyless local servers. */
  apiKeyEnv?: string;
  /**
   * "tools" = native function-calling (tools/tool_calls). Use for capable models.
   * "json"  = model returns a JSON action in message content; we parse it.
   *           Fallback for local models with weak/no tool-calling support.
   */
  mode: "tools" | "json";
  temperature?: number;
  maxTokens?: number;
  /** Extra HTTP headers (e.g. OpenRouter ranking headers). */
  extraHeaders?: Record<string, string>;
  /** Set false to keep the entry in the file but skip it in runs. */
  enabled?: boolean;
  /** Optional USD price per 1M tokens, used for cost estimates in the leaderboard. */
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
}

export interface BenchConfig {
  /** Path to Balatro.exe (launched via the balatrobot CLI). */
  balatroPath: string;
  /** Path to Lovely (version.dll). Derived from balatroPath dir if omitted. */
  lovelyPath: string;
  /** Dir containing the balatrobot CLI shim (added to PATH on spawn). */
  pythonScriptsDir: string;
  /** Extra dir to add to PATH on spawn (e.g. pipx/user bin). */
  userBin: string;
  /** Port the balatrobot HTTP API listens on. */
  basePort: number;
  /** Port the live relay (SSE + /ingest) listens on. */
  relayPort: number;
  /** Fixed seeds — Balatro is seed-deterministic, so models face identical draws. */
  seeds: string[];
  /** Repeat each seed K times to measure variance (deterministic models: keep 1). */
  runsPerSeed: number;
  deck: string;
  stake: string;
  /** Max decisions per game. 0 = unlimited — play until win / loss / stuck-loop. */
  maxDecisionsPerGame: number;
  /** Abort a game after this many consecutive illegal moves (stuck-loop guard). */
  maxConsecutiveIllegal: number;
  /** How long to wait after spawning Balatro before polling health (ms). */
  startupWaitMs: number;
  /** Submit finished runs to a central leaderboard backend. Opt-out (default true). */
  submit: boolean;
  /** Backend base URL for submissions, e.g. https://your-site.example. Empty = don't submit. */
  submitUrl: string;
  /** Optional public handle shown next to your submitted runs (no account needed). */
  submitterHandle: string;
  /** Owner-only: also stream live events to a backend /ingest in real time (Live tab). */
  liveIngestUrl: string;
  /** Shared secret sent as X-Ingest-Key with live-ingest events. */
  liveIngestKey: string;
  models: ModelConfig[];
}

const CONFIG_PATH = path.resolve(process.env.BALATRO_CONFIG || "balatro.config.json");

const DEFAULTS: BenchConfig = {
  balatroPath: "E:\\SteamLibrary\\steamapps\\common\\Balatro\\Balatro.exe",
  lovelyPath: "",
  pythonScriptsDir: path.join(
    process.env.LOCALAPPDATA ?? "",
    "Packages",
    "PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0",
    "LocalCache",
    "local-packages",
    "Python313",
    "Scripts",
  ),
  userBin: path.join(process.env.USERPROFILE ?? "", ".local", "bin"),
  basePort: 12346,
  relayPort: 3001,
  seeds: ["BENCH01", "BENCH02", "BENCH03", "BENCH04", "BENCH05"],
  runsPerSeed: 1,
  deck: "RED",
  stake: "WHITE",
  maxDecisionsPerGame: 0,
  maxConsecutiveIllegal: 10,
  startupWaitMs: 25_000,
  submit: true,
  submitUrl: "",
  submitterHandle: "",
  liveIngestUrl: "",
  liveIngestKey: "",
  models: [],
};

let cached: BenchConfig | null = null;

export function loadConfig(): BenchConfig {
  if (cached) return cached;
  let fileCfg: Partial<BenchConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (e: any) {
      throw new Error(`Failed to parse ${CONFIG_PATH}: ${e.message}`);
    }
  }
  const cfg: BenchConfig = { ...DEFAULTS, ...fileCfg };
  if (!cfg.lovelyPath) cfg.lovelyPath = path.join(path.dirname(cfg.balatroPath), "version.dll");
  // Env overrides for the submission / live-ingest knobs (so they can be set
  // without editing the committed config file).
  if (process.env.SUBMIT_URL !== undefined) cfg.submitUrl = process.env.SUBMIT_URL;
  if (process.env.SUBMIT !== undefined) cfg.submit = !["false", "0", "no"].includes(process.env.SUBMIT.toLowerCase());
  if (process.env.SUBMITTER !== undefined) cfg.submitterHandle = process.env.SUBMITTER;
  if (process.env.LIVE_INGEST_URL !== undefined) cfg.liveIngestUrl = process.env.LIVE_INGEST_URL;
  if (process.env.LIVE_INGEST_KEY !== undefined) cfg.liveIngestKey = process.env.LIVE_INGEST_KEY;
  cached = cfg;
  return cfg;
}

/** Models marked enabled (default true when the field is absent). */
export function enabledModels(): ModelConfig[] {
  return loadConfig().models.filter(m => m.enabled !== false);
}

export function getModel(name: string): ModelConfig {
  const m = loadConfig().models.find(x => x.name === name);
  if (!m) {
    const have = loadConfig().models.map(x => x.name).join(", ") || "(none)";
    throw new Error(`Model "${name}" not found in config. Available: ${have}`);
  }
  return m;
}

/** Resolve the API key from the env var named by the model's apiKeyEnv. */
export function resolveApiKey(m: ModelConfig): string | undefined {
  if (!m.apiKeyEnv) return undefined;
  const key = process.env[m.apiKeyEnv];
  if (!key) throw new Error(`Model "${m.name}" needs env var ${m.apiKeyEnv}, but it is not set.`);
  return key;
}

/**
 * Quick single-model from .env: BASE_URL + MODEL (+ optional BASE_KEY, MODEL_MODE,
 * MODEL_NAME). Lets you swap the model under test by editing .env instead of
 * touching balatro.config.json. Returns null if BASE_URL/MODEL aren't set.
 */
export function envModel(): ModelConfig | null {
  const baseURL = process.env.BASE_URL;
  const model = process.env.MODEL;
  if (!baseURL || !model) return null;
  return {
    name: process.env.MODEL_NAME || model,
    baseURL,
    model,
    apiKeyEnv: process.env.BASE_KEY ? "BASE_KEY" : undefined,
    mode: process.env.MODEL_MODE === "json" ? "json" : "tools",
    temperature: process.env.MODEL_TEMPERATURE ? Number(process.env.MODEL_TEMPERATURE) : undefined,
    maxTokens: process.env.MODEL_MAX_TOKENS ? Number(process.env.MODEL_MAX_TOKENS) : undefined,
    enabled: true,
  };
}

/** Resolve a model: a named preset from config, or (no name / "env") the .env model. */
export function resolveModelConfig(name?: string): ModelConfig {
  if (name && name !== "env") return getModel(name);
  const em = envModel();
  if (!em) throw new Error("No model configured: set BASE_URL/BASE_KEY/MODEL in .env, or pass a model name from balatro.config.json.");
  return em;
}
