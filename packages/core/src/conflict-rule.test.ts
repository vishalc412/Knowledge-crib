import type { Edge } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK_THRESHOLD, passesThreshold, resolveEdgeConflict } from './conflict-rule.js';

function edge(over: Partial<Edge>): Edge {
  return {
    id: 'e:00',
    src: 'a',
    dst: 'b',
    rel: 'describes',
    method: 'identifier',
    provenance: 'EXTRACTED',
    confidence: 0.8,
    ...over,
  };
}

describe('resolveEdgeConflict', () => {
  it('EXTRACTED beats INFERRED regardless of confidence', () => {
    const extracted = edge({ provenance: 'EXTRACTED', confidence: 0.5 });
    const inferred = edge({ provenance: 'INFERRED', confidence: 0.99, method: 'semantic' });
    expect(resolveEdgeConflict(extracted, inferred)).toBe(extracted);
    expect(resolveEdgeConflict(inferred, extracted)).toBe(extracted);
  });

  it('higher confidence wins among equal provenance', () => {
    const lo = edge({ confidence: 0.6 });
    const hi = edge({ confidence: 0.9 });
    expect(resolveEdgeConflict(lo, hi)).toBe(hi);
  });

  it('lower method rank breaks confidence ties', () => {
    const explicit = edge({ confidence: 0.8, method: 'explicit' });
    const identifier = edge({ confidence: 0.8, method: 'identifier' });
    expect(resolveEdgeConflict(identifier, explicit)).toBe(explicit);
  });

  it('is deterministic and order-independent on a full tie (id tie-break + evidence merge)', () => {
    const a = edge({ id: 'e:aaa', confidence: 0.8, method: 'explicit', evidence: { by: 'x' } });
    const b = edge({
      id: 'e:bbb',
      confidence: 0.8,
      method: 'explicit',
      evidence: { snippet: 's' },
    });
    const ab = resolveEdgeConflict(a, b);
    const ba = resolveEdgeConflict(b, a);
    expect(ab.id).toBe('e:aaa'); // lexicographically smaller id wins
    expect(ab).toEqual(ba); // order-independent
    expect(ab.evidence).toEqual({ by: 'x', snippet: 's' }); // merged
  });
});

describe('passesThreshold', () => {
  it('uses 0.4 default', () => {
    expect(DEFAULT_LINK_THRESHOLD).toBe(0.4);
    expect(passesThreshold(edge({ confidence: 0.4 }))).toBe(true);
    expect(passesThreshold(edge({ confidence: 0.39 }))).toBe(false);
  });
});
