import http from "http";
import fs from "fs";
import path from "path";
import { globalBus, BalatroEvent, EventBus } from "../bus/index.js";

// Serve the built SPA (web/dist) when present; otherwise the raw web/ folder
// (legacy pages, or before the SPA is built). Override with WEB_DIR.
const WEB_DIR = process.env.WEB_DIR
  ? path.resolve(process.env.WEB_DIR)
  : fs.existsSync(path.resolve("web", "dist", "index.html")) ? path.resolve("web", "dist") : path.resolve("web");
const MAX_BUFFER = 1000;
const MAX_INGEST_BODY = 256 * 1024;
const MAX_SUBMIT_BODY = 8 * 1024 * 1024;

// Best-effort per-IP rate limit for the write endpoints (/ingest, /api/runs).
const rlBuckets = new Map<string, { n: number; reset: number }>();
function rateLimited(ip: string, limit = 30, windowMs = 600_000): boolean {
  const now = Date.now();
  let b = rlBuckets.get(ip);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; rlBuckets.set(ip, b); }
  b.n++;
  return b.n > limit;
}
function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "", size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new Error("body too large")); req.destroy(); } else body += c;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export interface RelayHandle {
  server: http.Server;
  port: number;
  close: () => void;
}

/**
 * The single live hub. Subscribes to the event bus and broadcasts every event
 * to SSE clients. In-process runners share `globalBus` directly; out-of-process
 * runners (or a replay) can POST events to /ingest.
 *
 *   GET  /events  → SSE stream (replays the recent buffer on connect)
 *   POST /ingest  → push a BalatroEvent (or array) onto the bus
 *   GET  /api     → status + current leaderboard (from SQLite, if present)
 *   GET  /*       → static files from web/
 */
export function startRelay(port: number, bus: EventBus = globalBus): RelayHandle {
  const clients = new Set<http.ServerResponse>();
  const buffer: BalatroEvent[] = [];

  bus.subscribe((event) => {
    buffer.push(event);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try { res.write(data); } catch { clients.delete(res); }
    }
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = (req.url || "/").split("?")[0];
    const q = new URLSearchParams((req.url || "").split("?")[1] || "");

    if (url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      for (const ev of buffer) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      res.write(`data: {"type":"connected"}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url === "/ingest" && req.method === "POST") {
      // On a public server, gate live-ingest behind a shared secret (the owner's
      // runner sends X-Ingest-Key). When INGEST_KEY is unset (local dev), open.
      const ingestKey = process.env.INGEST_KEY;
      if (ingestKey && req.headers["x-ingest-key"] !== ingestKey) {
        res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"unauthorized"}'); return;
      }
      try {
        const parsed = JSON.parse(await readBody(req, MAX_INGEST_BODY));
        const events = Array.isArray(parsed) ? parsed : [parsed];
        for (const e of events) bus.emit(e as BalatroEvent);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(/too large/.test(e.message || "") ? 413 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Submission endpoint: a runner POSTs a finished game; the server recomputes
    // the score from the transcript, runs integrity checks, dedupes, and stores.
    if (url === "/api/runs" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "";
      if (rateLimited(ip)) { res.writeHead(429, { "Content-Type": "application/json" }); res.end('{"error":"rate limited"}'); return; }
      try {
        const payload = JSON.parse(await readBody(req, MAX_SUBMIT_BODY));
        const m = await import("../server/runs.js");
        const result = m.handleSubmitRun(payload, ip);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (e: any) {
        res.writeHead(/too large/.test(e.message || "") ? 413 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (url === "/api") {
      let leaderboard: unknown[] = [];
      try {
        const m = await import("../bench/db.js");
        leaderboard = m.leaderboard(m.getDb(), { officialOnly: q.get("official") === "1" });
      } catch { /* no db yet — fine */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", clients: clients.size, events: buffer.length, leaderboard }));
      return;
    }

    if (url === "/api/games") {
      let games: unknown[] = [];
      try { const m = await import("../bench/db.js"); games = m.gamesByModel(m.getDb(), q.get("model") || ""); } catch { /* no db */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: q.get("model") || "", games }));
      return;
    }

    if (url === "/api/game") {
      let data: { run: unknown; moves: unknown[] } = { run: null, moves: [] };
      try { const m = await import("../bench/db.js"); data = m.gameMoves(m.getDb(), q.get("game") || ""); } catch { /* no db */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    // static files (with index.html fallback)
    const filePath = url === "/" ? "/index.html" : url;
    const full = path.join(WEB_DIR, filePath);
    if (!full.startsWith(WEB_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
    fs.readFile(full, (err, data) => {
      if (err) {
        fs.readFile(path.join(WEB_DIR, "index.html"), (_e, d) => {
          if (!d) { res.writeHead(404); res.end("Not found"); return; }
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          res.end(d);
        });
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  });

  server.listen(port, () => {
    console.error(`Relay: http://localhost:${port}  (SSE /events · POST /ingest · GET /api)`);
  });

  return { server, port, close: () => server.close() };
}
