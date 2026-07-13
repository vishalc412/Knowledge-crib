/**
 * M3.5 parser fuzzing — STRUCTURAL validator for an extractor's output.
 *
 * Pure + worker-agnostic: imported by the worker (fuzz-worker.ts, runs in the isolate) AND by the
 * vitest unit test (extractor-fuzz.test.ts, runs in-process). Splitting it out keeps the
 * thread-boundary behavior (hang/throw detection) in the build-gated .mjs gate (mirroring M3.4's
 * parse-pool precedent) while the validator's logic is unit-testable without spawning a worker.
 *
 * This is STRUCTURAL validation only — does each node/edge individually satisfy the soul schema's
 * field invariants (id non-empty, kind/rel/method/provenance in their enums, confidence ∈ [0,1]).
 * It is NOT referential integrity (does edge.src resolve to a node, are ids unique) — that is the
 * resolve/link phase's job, downstream of extraction, and out of scope for "the extractor didn't
 * produce garbage." Mixing the two would conflate parse-time and link-time failures.
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { isMethod, isNodeKind, isProvenance, isRel } from '@knowledge-crib/soul-schema';
import type { ExtractResult } from '../types.js';

export type FuzzOutcomeKind = 'ok' | 'throw' | 'hang' | 'invalid';

/** Validate an extractor's returned node/edge set. `ok:true` iff every field is well-formed. */
export function validateFuzzResult(
  res: ExtractResult,
): { ok: true } | { ok: false; reason: string } {
  for (const n of res.nodes) {
    if (typeof n.id !== 'string' || n.id.length === 0)
      return { ok: false, reason: 'node.id empty' };
    if (!isNodeKind(n.kind)) return { ok: false, reason: `node.kind invalid: ${String(n.kind)}` };
    if (typeof n.hash !== 'string' || n.hash.length === 0)
      return { ok: false, reason: 'node.hash empty' };
  }
  for (const e of res.edges as Edge[]) {
    if (typeof e.id !== 'string' || e.id.length === 0)
      return { ok: false, reason: 'edge.id empty' };
    if (typeof e.src !== 'string' || e.src.length === 0)
      return { ok: false, reason: 'edge.src empty' };
    if (typeof e.dst !== 'string' || e.dst.length === 0)
      return { ok: false, reason: 'edge.dst empty' };
    if (!isRel(e.rel)) return { ok: false, reason: `edge.rel invalid: ${String(e.rel)}` };
    if (!isMethod(e.method))
      return { ok: false, reason: `edge.method invalid: ${String(e.method)}` };
    if (!isProvenance(e.provenance))
      return { ok: false, reason: `edge.provenance invalid: ${String(e.provenance)}` };
    if (typeof e.confidence !== 'number' || e.confidence < 0 || e.confidence > 1)
      return { ok: false, reason: `edge.confidence out of [0,1]: ${e.confidence}` };
  }
  return { ok: true };
}

/** Type guard for a single node's well-formedness (used by the unit test). */
export function nodeIsValid(n: Node): { ok: true } | { ok: false; reason: string } {
  return validateFuzzResult({ nodes: [n], edges: [] });
}

/** Type guard for a single edge's well-formedness (used by the unit test). */
export function edgeIsValid(e: Edge): { ok: true } | { ok: false; reason: string } {
  return validateFuzzResult({ nodes: [], edges: [e] });
}
