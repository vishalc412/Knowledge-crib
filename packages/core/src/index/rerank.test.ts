/**
 * M2.2 graph-aware rerank — pure-module invariants.
 *
 * The recall/MRR gate (hybrid+rerank conceptual MRR > hybrid-no-rerank) is measured by the eval
 * harness (scripts/rerank-check.mjs). These tests pin the prior's building blocks so a weight
 * change can't silently break determinism or the intent/stereotype/centrality mechanics.
 */
import { describe, expect, it } from 'vitest';
import {
  type RerankCandidate,
  actionStemsInQuery,
  detectIntent,
  rerank,
  structuralPrior,
} from './rerank.js';

function cand(
  id: string,
  rrfScore: number,
  degree = 0,
  kind: RerankCandidate['kind'] = 'symbol',
  name: string | null = null,
): RerankCandidate {
  return { id, kind, name, file: null, rrfScore, degree };
}

describe('detectIntent', () => {
  it('classifies location / behavior / entity / unknown from leading question words', () => {
    expect(detectIntent('where is the token service defined')).toBe('location');
    expect(detectIntent('how does the auth flow work')).toBe('behavior');
    expect(detectIntent('what issues a session token')).toBe('entity');
    expect(detectIntent('which route handles login')).toBe('entity');
    expect(detectIntent('token service')).toBe('unknown');
  });
  it('is case-insensitive', () => {
    expect(detectIntent('WHERE IS LOGIN')).toBe('location');
    expect(detectIntent('How Does It Work')).toBe('behavior');
  });
});

describe('actionStemsInQuery', () => {
  it('extracts action stems present in the query', () => {
    expect([...actionStemsInQuery('which method issues a token')]).toContain('issue');
    expect([...actionStemsInQuery('assess the application')]).toContain('assess');
  });
  it('returns empty for a query with no action stems', () => {
    expect(actionStemsInQuery('banana sunset').size).toBe(0);
  });
});

describe('structuralPrior', () => {
  it('centrality is monotonic in degree (more connected → higher prior)', () => {
    const lo = structuralPrior(cand('a', 1, 0), 'token');
    const hi = structuralPrior(cand('a', 1, 64), 'token');
    expect(hi).toBeGreaterThan(lo);
  });
  it('stereotype boost fires when a query stem matches the name', () => {
    const noMatch = structuralPrior(cand('a', 1, 0, 'symbol', 'tokenService'), 'login session');
    const match = structuralPrior(
      cand('a', 1, 0, 'symbol', 'issueToken'),
      'which method issues a token',
    );
    // 'issue' is in the query and in the name → 1.2× boost over the no-match baseline.
    expect(match / noMatch).toBeGreaterThan(1.15);
  });
  it('kind prior prefers symbols over files for location intent', () => {
    const sym = structuralPrior(cand('a', 1, 0, 'symbol'), 'where is login defined');
    const file = structuralPrior(cand('a', 1, 0, 'file'), 'where is login defined');
    expect(sym).toBeGreaterThan(file);
  });
});

describe('rerank — determinism', () => {
  it('identical candidates + query yield byte-identical order across calls', () => {
    const cs = [
      cand('b', 0.05, 2),
      cand('a', 0.05, 0),
      cand('c', 0.04, 10, 'symbol', 'issueToken'),
    ];
    const q = 'which method issues a token';
    const r1 = rerank(cs, q, 10, 0);
    const r2 = rerank(cs, q, 10, 0);
    expect(r1).toEqual(r2);
  });
  it('input order does not affect output order (stable id tiebreak)', () => {
    const a = cand('a', 0.05, 0);
    const b = cand('b', 0.05, 0);
    expect(rerank([a, b], 'token', 10, 0).map((h) => h.id)).toEqual(
      rerank([b, a], 'token', 10, 0).map((h) => h.id),
    );
  });
});

describe('rerank — the java anchor case', () => {
  it('a stereotype-matched, well-connected symbol outranks a higher-RRF noise hit', () => {
    // BM25 already found the relevant `issueToken` doc; vector noise fused a higher-RRF unrelated
    // doc above it. The prior (stereotype 'issue' match + centrality) must pull issueToken back up.
    const noise = cand('noise', 0.06, 0, 'symbol', 'unrelatedHelper');
    const target = cand('issueToken', 0.05, 12, 'symbol', 'TokenService.issueToken');
    const out = rerank([noise, target], 'which method issues a token', 10, 0);
    expect(out[0]?.id).toBe('issueToken');
  });
});

describe('rerank — limit + offset', () => {
  it('offset pages past the first results', () => {
    const cs = [cand('a', 0.1, 10), cand('b', 0.09, 8), cand('c', 0.08, 6)];
    expect(rerank(cs, 'token', 1, 0).map((h) => h.id)).toEqual(['a']);
    expect(rerank(cs, 'token', 1, 1).map((h) => h.id)).toEqual(['b']);
    expect(rerank(cs, 'token', 1, 2).map((h) => h.id)).toEqual(['c']);
  });
  it('limit caps the returned count', () => {
    const cs = [cand('a', 0.1), cand('b', 0.09), cand('c', 0.08), cand('d', 0.07)];
    expect(rerank(cs, 'token', 2, 0)).toHaveLength(2);
  });
});
