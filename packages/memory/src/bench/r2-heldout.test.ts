import { describe, expect, it } from 'vitest';
import { buildLaunchCorpus, launchContentTokens, launchTokens } from './launch-corpus.js';
import { R2_NON_ENGLISH_STOPWORDS, buildR2Heldout } from './r2-heldout.js';
import { relevanceCorpus } from './scenarios.js';

/**
 * R2-HELDOUT construction invariants (docs/bench/retrieval-pre-registration-r2.md §4).
 *
 * These tests are the reason the split can be trusted. R2 exists because the earlier semantic result
 * was produced by tuning against the launch-gate corpus; a held-out split that quietly reused those
 * queries, or that let a lexical handle leak into a "word-disjoint" paraphrase, would reproduce the
 * same error more subtly.
 *
 * The four invariants, each asserted below:
 *   1. zero content-token overlap between a query and its labeled claim;
 *   2. no query token is an FTS PREFIX of a claim token;
 *   3. one distinct claim template per record (no clone dilution);
 *   4. byte-deterministic construction.
 * Plus the one that makes it held-out at all: no reuse from any other corpus in the repo.
 */

const HELDOUT = buildR2Heldout();
const claimOf = (id: string): string => HELDOUT.records.find((r) => r.id === id)?.claim ?? '';

/** Content tokens of a query. A multilingual query additionally drops non-English function words —
 *  see R2_NON_ENGLISH_STOPWORDS for why that is a correction, not a loosening. */
const contentTokensOf = (q: { query: string; family: string }): string[] => {
  const base = launchContentTokens(q.query);
  return q.family === 'multilingual' ? base.filter((t) => !R2_NON_ENGLISH_STOPWORDS.has(t)) : base;
};

describe('R2-HELDOUT — scale + shape', () => {
  it('carries at least the 150 labeled queries the pre-registration requires', () => {
    expect(HELDOUT.queries.length).toBeGreaterThanOrEqual(150);
  });

  it('every query is single-label and resolves to a record the builder emitted', () => {
    const ids = new Set(HELDOUT.records.map((r) => r.id));
    for (const q of HELDOUT.queries) {
      expect(q.relevantIds).toHaveLength(1);
      expect(ids.has(q.relevantIds[0]!)).toBe(true);
    }
  });

  it('covers the decision-relevant families: exact, paraphrase, multilingual', () => {
    const families = new Set(HELDOUT.queries.map((q) => q.family));
    expect([...families].sort()).toEqual(['exact', 'multilingual', 'paraphrase']);
  });
});

describe('R2-HELDOUT — invariant 1: zero content-token overlap', () => {
  it('no word-disjoint query shares a content token with its labeled claim', () => {
    const offenders: string[] = [];
    for (const q of HELDOUT.queries) {
      if (q.family !== 'paraphrase' && q.family !== 'multilingual') continue;
      const claimTokens = new Set(launchContentTokens(claimOf(q.relevantIds[0]!)));
      const shared = contentTokensOf(q).filter((t) => claimTokens.has(t));
      if (shared.length > 0) offenders.push(`"${q.query}" shares [${shared.join(', ')}]`);
    }
    expect(offenders).toEqual([]);
  });

  it('the exact family DOES share tokens — otherwise the guard would measure nothing', () => {
    // The exact guard only means something if BM25 can find these at all.
    for (const q of HELDOUT.queries) {
      if (q.family !== 'exact') continue;
      const claimTokens = new Set(launchContentTokens(claimOf(q.relevantIds[0]!)));
      expect(launchContentTokens(q.query).some((t) => claimTokens.has(t))).toBe(true);
    }
  });
});

describe('R2-HELDOUT — invariant 2: no lexical prefix handle', () => {
  it('no word-disjoint query token is a prefix of any token in its claim', () => {
    // An FTS prefix match still retrieves lexically, so a shared stem would fake semantic recall.
    const offenders: string[] = [];
    for (const q of HELDOUT.queries) {
      if (q.family !== 'paraphrase' && q.family !== 'multilingual') continue;
      const claimTokens = launchTokens(claimOf(q.relevantIds[0]!));
      for (const qt of contentTokensOf(q)) {
        // FTS prefix search is `qt*`, so only this direction can produce a lexical hit. Checking
        // the reverse (`qt.startsWith(ct)`) would flag "addressed" against the stopword "a".
        const hit = claimTokens.find((ct) => ct !== qt && ct.startsWith(qt));
        if (hit) offenders.push(`"${qt}" is a prefix of "${hit}" in ${q.relevantIds[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the mod token never leaks into a word-disjoint query', () => {
    // `m` is the only per-record handle; if it appeared in a paraphrase the family would be exact.
    for (const q of HELDOUT.queries) {
      if (q.family !== 'paraphrase' && q.family !== 'multilingual') continue;
      expect(/\br2(dec|pref|proc|fail|ref|ml)\d+\b/.test(q.query)).toBe(false);
    }
  });
});

describe('R2-HELDOUT — invariant 3: no clone dilution', () => {
  it('every record has a distinct claim template', () => {
    // The P0 corpus cycled a 12-topic bank, so several records differed only by mod token; a
    // semantic retriever ranked the clones adjacently and MRR was capped at ~0.46 regardless of
    // model. One template per record keeps the ceiling at 1.0.
    const template = (claim: string): string =>
      claim
        .replace(/\br2(dec|pref|proc|fail|ref|ml)\d+\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const seen = new Map<string, number>();
    for (const r of HELDOUT.records) {
      const t = template(r.claim);
      seen.set(t, (seen.get(t) ?? 0) + 1);
    }
    const clones = [...seen.entries()].filter(([, n]) => n > 1);
    expect(clones).toEqual([]);
    expect(seen.size).toBe(HELDOUT.records.length);
  });
});

describe('R2-HELDOUT — invariant 4: determinism', () => {
  it('two builds are byte-identical', () => {
    expect(JSON.stringify(buildR2Heldout())).toBe(JSON.stringify(buildR2Heldout()));
  });

  it('no record carries a wall-clock timestamp', () => {
    for (const r of HELDOUT.records) expect(r.createdAt.startsWith('2027-')).toBe(true);
  });
});

describe('R2-HELDOUT — genuinely held out', () => {
  it('shares no query with the launch-gate corpus', () => {
    const launch = new Set(buildLaunchCorpus().queries.map((q) => q.query));
    const reused = HELDOUT.queries.filter((q) => launch.has(q.query)).map((q) => q.query);
    expect(reused).toEqual([]);
  });

  it('shares no query with the P0 relevance corpus', () => {
    const p0 = new Set(relevanceCorpus(40).queries.map((q) => q.query));
    const reused = HELDOUT.queries.filter((q) => p0.has(q.query)).map((q) => q.query);
    expect(reused).toEqual([]);
  });

  it('shares no claim with either corpus', () => {
    const others = new Set([
      ...buildLaunchCorpus().records.map((r) => r.claim),
      ...relevanceCorpus(40).records.map((r) => r.claim),
    ]);
    const reused = HELDOUT.records.filter((r) => others.has(r.claim)).map((r) => r.claim);
    expect(reused).toEqual([]);
  });
});
