/**
 * The deterministic conflict rule for edges sharing `(src,dst,rel)` (which, by the edge-id grammar,
 * share an `id`). This is the single source of truth applied by BOTH `SoulStore.putEdges` and the
 * `.crib` git merge driver — they MUST agree, so the logic lives here once.
 *
 * Rule (data-model §3 + soul-format §3, with the reconciliation #10 tie-break):
 *   1. EXTRACTED beats INFERRED.
 *   2. Among equal provenance, higher `confidence` wins.
 *   3. Among equal provenance AND equal confidence, lower `method` rank wins (static < explicit < …).
 *   4. Final tie-break (reconciliation #10): merge `evidence`, keep the edge whose id is
 *      lexicographically smaller — fully deterministic regardless of insertion order.
 *
 * The loser is discarded; callers separately drop any survivor whose confidence < link threshold.
 */
import { METHOD_RANK } from '@knowledge-crib/soul-schema';
import type { Edge, Evidence } from '@knowledge-crib/soul-schema';

/** Default link threshold: edges below this confidence are not persisted (data-model §3). */
export const DEFAULT_LINK_THRESHOLD = 0.4;

/** Return the winning edge of two that share `(src,dst,rel)`. Deterministic. */
export function resolveEdgeConflict(a: Edge, b: Edge): Edge {
  // 1. provenance: EXTRACTED beats INFERRED
  const aExtracted = a.provenance === 'EXTRACTED';
  const bExtracted = b.provenance === 'EXTRACTED';
  if (aExtracted !== bExtracted) return aExtracted ? a : b;

  // 2. higher confidence
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;

  // 3. lower method rank (stronger derivation)
  const ra = METHOD_RANK[a.method];
  const rb = METHOD_RANK[b.method];
  if (ra !== rb) return ra < rb ? a : b;

  // 4. deterministic tie-break: merge evidence onto the lexicographically-smaller-id edge
  const winner = a.id <= b.id ? a : b;
  const loser = winner === a ? b : a;
  const evidence = mergeEvidence(winner.evidence, loser.evidence);
  return evidence ? { ...winner, evidence } : winner;
}

/** Merge two optional evidence objects; snippets concatenated distinctly, `by` lists unioned. */
function mergeEvidence(x?: Evidence, y?: Evidence): Evidence | undefined {
  if (!x) return y;
  if (!y) return x;
  const merged: Evidence = { ...x };
  for (const [k, v] of Object.entries(y)) {
    if (merged[k] === undefined) merged[k] = v;
  }
  return merged;
}

/** Whether a survivor edge clears the link threshold and should be persisted. */
export function passesThreshold(edge: Edge, threshold = DEFAULT_LINK_THRESHOLD): boolean {
  return edge.confidence >= threshold;
}
