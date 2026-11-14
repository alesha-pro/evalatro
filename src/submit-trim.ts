/**
 * Payload trimmer for submissions.
 *
 * A verbose reasoning model can produce a move log larger than the relay's 8 MiB
 * cap for POST /api/runs. That fails the upload as
 * `submit failed (413): {"error":"body too large"}` and loses a finished run.
 *
 * Scoring needs, per move: the pre-move state snapshot, the tool, its args and
 * the illegal flag. `reasoning` is history/display only, and most of the state
 * snapshot is UI detail the server never reads. So trim in two stages and send
 * the first candidate that fits.
 *
 * Deliberately outside HASHED_FILES: this transports the run, it does not
 * change how the model plays or how the run is scored.
 */

/** Stay under the relay's 8 MiB /api/runs cap with headroom. */
export const SUBMIT_MAX_BYTES = Number(process.env.SUBMIT_MAX_BYTES ?? 7 * 1024 * 1024);

/** Bytes the JSON body will occupy on the wire. */
export const bodyBytes = (o: unknown): number => Buffer.byteLength(JSON.stringify(o));

/** The per-move state fields the server scores and validates. */
export function compactMoveState(st: any): Record<string, unknown> {
  return {
    state: typeof st?.state === "string" ? st.state : "",
    ante: typeof st?.ante === "number" ? st.ante : 0,
    blind: st?.blind ? { type: st.blind.type } : null,
    score: { chips: st?.score?.chips ?? 0, target: st?.score?.target ?? 0 },
  };
}

/**
 * stage 1: drop reasoning + diagnostic (history only).
 * stage 2: also reduce each state snapshot to the scored fields.
 * `runRecord.finalState` is dropped either way — the top-level copy is what the
 * server reads, and zod strips the runRecord copy.
 */
export function trimSubmission(sub: any, stage: 1 | 2): any {
  const moves = sub.moves.map((m: any) => {
    const clean = { ...m };
    delete clean.reasoning;
    delete clean.diagnostic;
    return stage === 2 ? { ...clean, state: compactMoveState(m.state) } : clean;
  });
  const runRecord = { ...sub.runRecord };
  delete runRecord.finalState;
  return { ...sub, runRecord, moves };
}

/** First candidate under the cap; otherwise the most-trimmed one. */
export function fitSubmission<T>(candidates: T[]): T {
  return candidates.find(c => bodyBytes(c) <= SUBMIT_MAX_BYTES) ?? candidates[candidates.length - 1];
}
