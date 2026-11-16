#!/usr/bin/env node
/**
 * Teardown sequencing tests — the two cases that made the next seed fail.
 *
 * Both are driven through the injected `teardown()` from src/game/launch.ts and
 * a real localhost listener, so they exercise actual socket behaviour rather
 * than a mocked boolean. Balatro itself is not involved.
 *
 *   1. Launcher already exited, child still holds the port. The old code
 *      returned immediately here (1 ms, port still open).
 *   2. Launcher exits after SIGTERM, child keeps the port. The old code
 *      cancelled the SIGKILL timer on exit and `waitForPortFree` returned
 *      `void` at its deadline, so stop() "succeeded" with the socket held.
 *
 * In both cases teardown() must reject, and SIGKILL must have been sent.
 */
import { connect, createServer } from "node:net";
import { teardown } from "../dist/game/launch.js";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const listen = () => new Promise((resolve) => {
  const server = createServer(socket => socket.end());
  server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
});

const shutdown = server => new Promise(resolve => server.close(resolve));

/** Same shape as the production probe: is anything accepting connections? */
const probe = port => new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port });
  let settled = false;
  const done = (inUse) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(inUse);
  };
  socket.setTimeout(200, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
});

const recorder = () => {
  const signals = [];
  return { signals, signal: s => signals.push(s) };
};

const base = (port, rec, overrides) => ({
  port,
  pid: 4242,
  alreadyExited: false,
  exited: async () => {},
  signal: rec.signal,
  isPortInUse: () => probe(port),
  graceMs: 40,
  portTimeoutMs: 300,
  pollMs: 20,
  ...overrides,
});

console.log("teardown: launcher exited before stop(), child holds the port");
{
  const { server, port } = await listen();
  const rec = recorder();
  const started = Date.now();
  let err = null;
  try {
    await teardown(base(port, rec, { alreadyExited: true }));
  } catch (e) { err = e; }
  const elapsed = Date.now() - started;
  check("rejects instead of returning", err !== null, "resolved while the port was held");
  check("error names the port", /port \d+ still in use/.test(err?.message ?? ""), err?.message);
  check("error says the next seed is refused", /refusing to start the next seed/.test(err?.message ?? ""), err?.message);
  check("SIGKILL was escalated", rec.signals.includes("SIGKILL"), JSON.stringify(rec.signals));
  check("does not sit on the 15s default when configured short", elapsed < 2000, `${elapsed}ms`);
  await shutdown(server);
}

console.log("\nteardown: launcher exits after SIGTERM, child keeps the port");
{
  const { server, port } = await listen();
  const rec = recorder();
  let err = null;
  try {
    await teardown(base(port, rec, {
      alreadyExited: false,
      exited: () => new Promise(resolve => setTimeout(resolve, 50)),
    }));
  } catch (e) { err = e; }
  check("rejects when the child outlives the launcher", err !== null, "resolved with the port held");
  check("SIGKILL still fires after launcher exit", rec.signals.includes("SIGKILL"), JSON.stringify(rec.signals));
  await shutdown(server);
}

console.log("\nteardown: socket released while waiting");
{
  const { server, port } = await listen();
  const rec = recorder();
  setTimeout(() => { server.close(); }, 60);
  let err = null;
  try {
    await teardown(base(port, rec, { portTimeoutMs: 3000, graceMs: 1000 }));
  } catch (e) { err = e; }
  check("resolves once the socket is freed", err === null, err?.message);
}

console.log("\nteardown: nothing was spawned and the port is already free");
{
  const { server, port } = await listen();
  await shutdown(server);
  const rec = recorder();
  const started = Date.now();
  let err = null;
  try {
    await teardown(base(port, rec, { pid: undefined, alreadyExited: true }));
  } catch (e) { err = e; }
  check("resolves", err === null, err?.message);
  check("nothing is signalled", rec.signals.length === 0, JSON.stringify(rec.signals));
  check("returns promptly", Date.now() - started < 1000, `${Date.now() - started}ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
