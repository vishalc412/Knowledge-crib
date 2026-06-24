import { DEFAULT_LINK_THRESHOLD } from '@knowledge-crib/core';
/**
 * Scoring: combine the signals fired for a (doc-section, symbol) pair into one edge.
 *
 *   conf      = max(signalConf) + 0.04 per additional agreeing signal, capped at 0.99
 *   method    = the method of the strongest signal (lowest METHOD_RANK)
 *   edge type = `describes` if conf ≥ 0.8 and method ∈ {explicit, identifier}; else `references`
 *   persist   = conf ≥ link threshold (default 0.4)
 */
import { METHOD_RANK } from '@knowledge-crib/soul-schema';
import type { Method, Rel } from '@knowledge-crib/soul-schema';
import type { SignalHit } from './signals.js';

export interface ScoredLink {
  method: Method;
  confidence: number;
  rel: Rel;
}

const DESCRIBES_METHODS: ReadonlySet<Method> = new Set<Method>(['explicit', 'identifier']);

/** Combine ≥1 signals for the same symbol into a single scored link, or null if below threshold. */
export function scoreLink(
  hits: SignalHit[],
  threshold = DEFAULT_LINK_THRESHOLD,
): ScoredLink | null {
  if (hits.length === 0) return null;
  const max = hits.reduce((best, h) => (h.conf > best.conf ? h : best));
  const confidence = Math.min(0.99, max.conf + 0.04 * (hits.length - 1));
  if (confidence < threshold) return null;

  // strongest method = lowest rank among the hits at/near the top confidence
  const method = hits.reduce((best, h) =>
    METHOD_RANK[h.method] < METHOD_RANK[best.method] ? h : best,
  ).method;
  const rel: Rel = confidence >= 0.8 && DESCRIBES_METHODS.has(method) ? 'describes' : 'references';
  return { method, confidence, rel };
}
