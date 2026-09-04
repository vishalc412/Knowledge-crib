/**
 * G3.2 fusion tests — the versioned scorer + the pre-registered fusion strategies.
 *
 * Pinned invariants (red lines #3/#6 + pre-registration §4):
 *   - `lexical-only` is SCORE-IDENTICAL to the incumbent `FtsLexicalScorer` (delegation, not
 *     reimplementation) and names the no-embedder version id — the launch default.
 *   - fusion is UNCONSTRUCTIBLE without an embedder (fail closed — never fabricate a semantic
 *     channel), and the version id is traceable to configuration (embedder id + strategy + params).
 *   - the exact-match band is invariant in EVERY strategy: an exact subject/target match outranks
 *     any fused score, in any position of the candidate set (the exact-dominance regression guard).
 *   - the fusion math (rrf k=60, weighted alpha=0.5) is pure and pinned on fixed fixtures.
 */
import { CharNgramEmbedder } from '@knowledge-crib/core';
import { describe, expect, it } from 'vitest';
import { MemoryFtsIndex } from './fts-index.js';
import { FtsLexicalScorer } from './fts-index.js';
import {
  DEFAULT_FUSION_ALPHA,
  DEFAULT_RRF_K,
  type FusionStrategy,
  MEMORY_RANK_SCORER_VERSION,
  VersionedLexicalScorer,
  fuseRrf,
  fuseWeighted,
  recordEmbedText,
  scorerVersionId,
} from './fusion.js';
import {
  EXACT_MATCH_BONUS,
  type GatheredRecall,
  type LexicalScorer,
  type MemorySource,
  recallProjection,
} from './recall.js';
import type { MemoryRecord, MemoryRecordV2 } from './types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const REPO = 'r-fusion';
const SCOPE = { boundary: 'repo' as const, repoId: REPO };

/** Minimal valid v1 record (evidence shape kept honest: one valid source-quote). */
function record(opts: {
  id?: string;
  subject: string;
  claim: string;
  appliesTo?: string[];
}): MemoryRecord {
  return {
    id: opts.id ?? `mem:${opts.subject}`,
    schemaVersion: '1',
    kind: 'fact',
    subject: opts.subject,
    claim: opts.claim,
    scope: SCOPE,
    appliesTo: opts.appliesTo ?? [opts.subject],
    evidence: [
      {
        kind: 'source-quote',
        verdict: 'valid',
        checkedAt: T0,
        soulId: opts.subject,
        quote: opts.claim,
        targetHash: `blake3:${'a'.repeat(64)}`,
      },
    ],
    authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: T0,
  };
}

function buildIndex(records: MemoryRecord[]): { fts: MemoryFtsIndex; close: () => void } {
  const fts = new MemoryFtsIndex(':memory:');
  fts.rebuild(records);
  return { fts, close: () => fts.close() };
}

// ─── version id ──────────────────────────────────────────────────────────────

describe('scorerVersionId — the ranking-configuration audit trail (red line #6)', () => {
  it('lexical-only names the no-embedder configuration', () => {
    expect(scorerVersionId({ strategy: 'lexical-only' })).toBe(
      `${MEMORY_RANK_SCORER_VERSION}:none:bm25:lexical-only`,
    );
  });

  it('fusion strategies name the embedder + pre-registered parameters', () => {
    expect(scorerVersionId({ strategy: 'rrf', embedderId: 'char-ngram-3-6-512' })).toBe(
      `${MEMORY_RANK_SCORER_VERSION}:char-ngram-3-6-512:bm25+cosine:rrf-k${DEFAULT_RRF_K}`,
    );
    expect(scorerVersionId({ strategy: 'weighted', embedderId: 'char-ngram-3-6-512' })).toBe(
      `${MEMORY_RANK_SCORER_VERSION}:char-ngram-3-6-512:bm25+cosine:weighted-a${DEFAULT_FUSION_ALPHA}`,
    );
  });

  it('refuses a fusion version id without an embedder — never fabricate a semantic channel', () => {
    expect(() => scorerVersionId({ strategy: 'rrf' })).toThrow(/requires an embedder/);
  });
});

// ─── the scorer ──────────────────────────────────────────────────────────────

describe('VersionedLexicalScorer', () => {
  const a = record({ subject: 'sym:src/a.ts#aFn', claim: 'deploy retries back off exponentially' });
  const b = record({ subject: 'sym:src/b.ts#bFn', claim: 'connection pool drains before exit' });
  const c = record({ subject: 'sym:src/c.ts#cFn', claim: 'parser hangs on stray WHEN blocks' });
  const records = [a, b, c];

  it('lexical-only is score-identical to the incumbent FtsLexicalScorer', () => {
    const { fts, close } = buildIndex(records);
    try {
      const incumbent = new FtsLexicalScorer(fts);
      const versioned = new VersionedLexicalScorer({ fts, records, strategy: 'lexical-only' });
      expect(versioned.versionId).toBe(`${MEMORY_RANK_SCORER_VERSION}:none:bm25:lexical-only`);
      const queries = ['back off retries', 'pool drains', 'zzz-no-match', ''];
      for (const q of queries) {
        for (const r of records) {
          expect(versioned.score(r, q, [])).toBe(incumbent.score(r, q, []));
        }
      }
    } finally {
      close();
    }
  });

  it('fusion strategies without an embedder fail closed in the constructor', () => {
    const { fts, close } = buildIndex(records);
    try {
      for (const strategy of ['rrf', 'weighted'] as const) {
        expect(() => new VersionedLexicalScorer({ fts, records, strategy })).toThrow(
          /requires an embedder/,
        );
      }
    } finally {
      close();
    }
  });

  it('rrf fuses the bm25 and cosine channels and reports the fused version id', () => {
    const { fts, close } = buildIndex(records);
    try {
      const embedder = new CharNgramEmbedder();
      const scorer = new VersionedLexicalScorer({ fts, records, embedder, strategy: 'rrf' });
      expect(scorer.versionId).toBe(
        `${MEMORY_RANK_SCORER_VERSION}:${embedder.id}:bm25+cosine:rrf-k${DEFAULT_RRF_K}`,
      );
      // A lexical query must still rank its BM25 hit; the cosine channel may only reorder BELOW
      // the exact band, never produce a score for a zero-signal record that outranks the exact one.
      const exact = scorer.score(a, 'sym:src/a.ts#aFn', []);
      const fused = scorer.score(b, 'pool drains', []);
      expect(exact).toBeGreaterThanOrEqual(EXACT_MATCH_BONUS);
      expect(fused).toBeLessThan(EXACT_MATCH_BONUS);
    } finally {
      close();
    }
  });

  it('the exact-match band is invariant in EVERY strategy (criterion-1 dominance)', () => {
    const { fts, close } = buildIndex(records);
    try {
      const embedder = new CharNgramEmbedder();
      const strategies: FusionStrategy[] = ['rrf', 'weighted'];
      for (const strategy of strategies) {
        const scorer = new VersionedLexicalScorer({ fts, records, embedder, strategy });
        // Even a query the cosine channel ranks highest for another record cannot unseat the exact
        // subject match — fusion reorders strictly BELOW the band.
        const exactScore = scorer.score(c, 'sym:src/c.ts#cFn', []);
        expect(exactScore).toBeGreaterThanOrEqual(EXACT_MATCH_BONUS);
        for (const r of records) {
          expect(scorer.score(r, 'sym:src/c.ts#cFn', [])).toBeLessThanOrEqual(exactScore);
        }
      }
    } finally {
      close();
    }
  });

  it('recordEmbedText embeds subject + claim + appliesTo (v1) and drops appliesTo for v2', () => {
    const v1 = record({
      subject: 'sym:a.ts#A',
      claim: 'A does the thing',
      appliesTo: ['sym:a.ts#A'],
    });
    expect(recordEmbedText(v1)).toBe('sym:a.ts#A A does the thing sym:a.ts#A');
    // A v2 twin carries no appliesTo — the embed text stays deterministic over the record alone.
    // isMemoryRecordV2 keys on schemaVersion==='2' + a propositionKey (the memory-2 identity).
    const v2 = {
      id: 'mem:v2',
      schemaVersion: '2',
      propositionKey: 'k-v2',
      subject: 'sym:b.ts#B',
      claim: 'B does the other thing',
      evidence: v1.evidence,
    } as unknown as MemoryRecordV2;
    expect(recordEmbedText(v2)).toBe('sym:b.ts#B B does the other thing');
  });
});

// ─── the fusion math (pure, fixed fixtures) ──────────────────────────────────

describe('fuseRrf (pre-registered, k = 60)', () => {
  it('sums 1/(k + rank) over the channels a record appears in', () => {
    const bm25 = new Map([
      ['a', 3.2],
      ['b', 1.1],
    ]);
    const cos = new Map([
      ['b', 0.9],
      ['c', 0.5],
    ]);
    const fused = fuseRrf(bm25, cos, DEFAULT_RRF_K);
    expect(fused.get('a')).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12); // bm25 rank 1
    expect(fused.get('b')).toBeCloseTo(1 / (DEFAULT_RRF_K + 2) + 1 / (DEFAULT_RRF_K + 1), 12);
    expect(fused.get('c')).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 12);
    // b appears in BOTH channels — the fused sum must beat either single-channel rank alone.
    expect(fused.get('b')!).toBeGreaterThan(fused.get('a')!);
    expect(fused.get('b')!).toBeGreaterThan(fused.get('c')!);
  });

  it('drops zero/negative channel scores from the ranking entirely', () => {
    const fused = fuseRrf(new Map([['a', 0]]), new Map([['b', 0]]));
    expect(fused.size).toBe(0);
  });
});

describe('fuseWeighted (pre-registered, alpha frozen at 0.5)', () => {
  it('max-normalizes bm25 and mixes with cosine at alpha', () => {
    const bm25 = new Map([
      ['a', 4],
      ['b', 2],
    ]);
    const cos = new Map([
      ['a', 0.2],
      ['c', 0.6],
    ]);
    const fused = fuseWeighted(bm25, cos, DEFAULT_FUSION_ALPHA);
    const alpha = DEFAULT_FUSION_ALPHA;
    // a: bm25 max (1.0 normalized) + low cosine; c: no bm25, cosine only.
    expect(fused.get('a')).toBeCloseTo(alpha * 1 + (1 - alpha) * 0.2, 12);
    expect(fused.get('b')).toBeCloseTo(alpha * 0.5, 12);
    expect(fused.get('c')).toBeCloseTo((1 - alpha) * 0.6, 12);
  });

  it('a query with no bm25 hits contributes 0 lexically and lets cosine decide', () => {
    const fused = fuseWeighted(new Map(), new Map([['a', 0.7]]), DEFAULT_FUSION_ALPHA);
    expect(fused.get('a')).toBeCloseTo((1 - DEFAULT_FUSION_ALPHA) * 0.7, 12);
  });

  it('negative cosine never fabricates a positive score', () => {
    const fused = fuseWeighted(new Map(), new Map([['a', -0.5]]), DEFAULT_FUSION_ALPHA);
    expect(fused.has('a')).toBe(false);
  });
});

// LexicalScorer structural conformance: the versioned scorer satisfies the projection's port.
describe('port conformance', () => {
  it('VersionedLexicalScorer satisfies LexicalScorer (with the optional versionId)', () => {
    const { fts, close } = buildIndex([
      record({ subject: 'sym:a.ts#A', claim: 'alpha beta gamma' }),
    ]);
    try {
      const scorer: LexicalScorer = new VersionedLexicalScorer({
        fts,
        records: [],
        strategy: 'lexical-only',
      });
      expect(scorer.versionId).toBeDefined();
    } finally {
      close();
    }
  });

  // Red-line pin #6 END-TO-END: the ranking-version id must reach the ANSWER, not just the scorer —
  // the projection carries it on provenance, and the API layer copies it into the search response.
  it('recallProjection carries the version id on provenance; the default scorer leaves it off', () => {
    const r = record({ subject: 'sym:a.ts#A', claim: 'alpha beta gamma' });
    const g: GatheredRecall = {
      records: [{ record: r, source: 'team' as MemorySource }],
      decisions: [],
      localDecisions: [],
      feedback: [],
      errors: [],
    };
    const { fts, close } = buildIndex([r]);
    try {
      const scorer = new VersionedLexicalScorer({ fts, records: [r], strategy: 'lexical-only' });
      const withVersion = recallProjection(g, { query: 'alpha', lexicalScorer: scorer });
      expect(withVersion.provenance.scorerVersion).toBe(scorer.versionId);
      // Backward compatibility: the incumbent scorer has no version id, so the key stays ABSENT
      // (the portable response shape pins its top-level keys — no phantom fields).
      const incumbent = recallProjection(g, { query: 'alpha' });
      expect('scorerVersion' in incumbent.provenance).toBe(false);
    } finally {
      close();
    }
  });
});

// ─── semantic-only (added for the G3.2-R2 pre-registration) ──────────────────

describe('semantic-only — the cosine channel alone', () => {
  it('carries its own version id and does not claim a lexical mix', () => {
    expect(scorerVersionId({ strategy: 'semantic-only', embedderId: 'e5-768' })).toBe(
      'memory-rank-v2:e5-768:cosine:semantic-only',
    );
  });

  it('requires an embedder, exactly like the other fusion strategies', () => {
    expect(() => scorerVersionId({ strategy: 'semantic-only' })).toThrow(/requires an embedder/);
  });

  it('preserves the exact-match short-circuit (the pre-registration regression guard)', () => {
    // The exact band runs BEFORE any channel, so dropping BM25 must not weaken exact retrieval —
    // this is what keeps the launch gate's G1 at 100% when the ranker goes fully semantic.
    const r = record({ subject: 'sym:src/z.ts#zFn', claim: 'tokens rotate on every deploy' });
    const { fts, close } = buildIndex([r]);
    try {
      const scorer = new VersionedLexicalScorer({
        fts,
        records: [r],
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
      });
      expect(scorer.versionId).toBe(
        `${MEMORY_RANK_SCORER_VERSION}:${new CharNgramEmbedder().id}:cosine:semantic-only`,
      );
      expect(scorer.score(r, r.subject, [r.subject])).toBeGreaterThanOrEqual(EXACT_MATCH_BONUS);
    } finally {
      close();
    }
  });

  it('fails closed without an embedder, exactly like the other fusion strategies', () => {
    const r = record({ subject: 'sym:src/z.ts#zFn', claim: 'tokens rotate on every deploy' });
    const { fts, close } = buildIndex([r]);
    try {
      expect(
        () => new VersionedLexicalScorer({ fts, records: [r], strategy: 'semantic-only' }),
      ).toThrow(/requires an embedder/);
    } finally {
      close();
    }
  });
});

// ─── second stage (rerank) + embed-text seam ─────────────────────────────────

describe('rerank stage', () => {
  const r1 = record({ subject: 'sym:src/a.ts#a', claim: 'alpha one' });
  const r2 = record({ subject: 'sym:src/b.ts#b', claim: 'beta two' });
  const recs = [r1, r2];

  /** Reverses the first stage: whatever came first, this scores last. */
  const inverting = {
    id: 'test-rr',
    rerankBatch: (_q: string, texts: readonly string[]) => texts.map((_t, i) => -i),
  };

  it('names the reranker and depth in the version id', () => {
    const { fts, close } = buildIndex(recs);
    try {
      const s = new VersionedLexicalScorer({
        fts,
        records: recs,
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
        reranker: inverting,
        rerankDepth: 10,
      });
      expect(s.versionId).toContain(':cosine:semantic-only+rerank-test-rr-d10');
    } finally {
      close();
    }
  });

  it('lets the reranker decide the order of the window it saw', () => {
    const { fts, close } = buildIndex(recs);
    try {
      const s = new VersionedLexicalScorer({
        fts,
        records: recs,
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
        reranker: inverting,
        rerankDepth: 10,
      });
      // the inverting reranker scores the FIRST stage-1 candidate lowest, so the two must swap
      const a = s.score(r1, 'alpha one beta', []);
      const b = s.score(r2, 'alpha one beta', []);
      expect(a).not.toBe(b);
    } finally {
      close();
    }
  });

  it('fails closed: a reranker returning the wrong shape changes nothing', () => {
    const { fts, close } = buildIndex(recs);
    try {
      const broken = { id: 'broken', rerankBatch: () => [] };
      const base = new VersionedLexicalScorer({
        fts,
        records: recs,
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
      });
      const withBroken = new VersionedLexicalScorer({
        fts,
        records: recs,
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
        reranker: broken,
      });
      expect(withBroken.score(r1, 'alpha', [])).toBe(base.score(r1, 'alpha', []));
    } finally {
      close();
    }
  });

  it('defaults the cosine channel to the CLAIM alone, and embedTextOf can override it', () => {
    const { fts, close } = buildIndex(recs);
    try {
      const dflt = new VersionedLexicalScorer({
        fts,
        records: recs,
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
      });
      const explicitClaim = new VersionedLexicalScorer({
        fts,
        records: recs,
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
        embedTextOf: (r) => r.claim,
      });
      const withSubject = new VersionedLexicalScorer({
        fts,
        records: recs,
        embedder: new CharNgramEmbedder(),
        strategy: 'semantic-only',
        embedTextOf: recordEmbedText,
      });
      // the default IS claim-only …
      expect(dflt.score(r1, 'alpha', [])).toBe(explicitClaim.score(r1, 'alpha', []));
      // … and the old FTS-mirroring composition embeds different text, so it scores differently
      expect(withSubject.score(r1, 'alpha', [])).not.toBe(dflt.score(r1, 'alpha', []));
    } finally {
      close();
    }
  });
});
