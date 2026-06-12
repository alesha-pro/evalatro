/**
 * evalVersion → the official codeHash for that release.
 *
 * Populate at release time: run `npm run codehash`, paste the printed hash here
 * keyed by the current EVAL_VERSION (see src/scoring/codehash.ts). A submission
 * whose codeHash matches its evalVersion's entry is tagged "official"; everything
 * else is "modified" / community. This is a LABEL, not a security boundary — the
 * server recomputes the score from the transcript regardless (see runs.ts).
 */
export const KNOWN_HASHES: Record<string, string> = {
  "0.3.0": "sha256:80c77c52c18c7e39a2f248b1a5a976d2411025f989a27bbf63a60edae2bf39a8",
};

export function isOfficialHash(evalVersion: string, codeHash: string): boolean {
  const known = KNOWN_HASHES[evalVersion];
  return !!known && known === codeHash;
}
