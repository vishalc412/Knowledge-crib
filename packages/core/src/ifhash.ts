/**
 * ifHash — a stateless, change-aware response fingerprint (M2.6).
 *
 * The crib is content-addressed: every node carries a `blake3:` hash of its canonical form. That
 * makes a *response-level* change-detection cache trivial and deterministic, with no server-side
 * session state: a verb builds its response object, fingerprints it with {@link ifHash}, and returns
 * `{ ...result, hash }`. On a repeat call the client passes the same `hash` as `ifHash`; if the
 * rebuilt response would be byte-for-byte identical, the verb collapses the whole body to
 * `{ unchanged: true, hash }` — a ~30-byte stand-in for what may be a 50 KB dossier.
 *
 * Why this matters for cost: `context`/`dossier`/`source` results land in the agent's *input*
 * context window as tool results, not the model's output. Re-sending an unchanged 50 KB dossier on
 * every repeat `context` call bloats the session and burns input tokens for nothing. `ifHash` lets
 * the agent skip the re-read — the "repeat agent session token cost measurably drops" gate.
 *
 * Determinism: the fingerprint is `contentHash(canonicalStringify(value))`. `canonicalStringify`
 * recursively sorts object keys (a stable projection of the value regardless of insertion order) and
 * passes strings through unchanged, so two structurally-equal responses always hash identically.
 * `contentHash` is BLAKE3 (pure-JS, no native bindings) — the same primitive the soul uses for node
 * hashes, so a fingerprint collides with itself across processes and across cold restarts.
 */
import { contentHash } from '@knowledge-crib/soul-schema';

/**
 * Recursively key-sorted JSON serialization. A stable projection of `value`: two values that carry
 * the same data at every depth serialize identically regardless of key order. Strings pass through
 * unchanged (a `format: 'markdown'` response is a plain string, not an object — its identity IS its
 * bytes, so quoting it would only add noise to the fingerprint).
 */
export function canonicalStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/**
 * The change-aware fingerprint: `blake3:<hex>` of {@link canonicalStringify}(value). Stable across
 * processes and cold restarts (BLAKE3 is deterministic). Use to mark a verb response, then accept
 * the same value back as `ifHash` on a repeat call to short-circuit an unchanged response.
 */
export function ifHash(value: unknown): string {
  return contentHash(canonicalStringify(value));
}
