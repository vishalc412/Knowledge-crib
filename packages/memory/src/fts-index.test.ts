/**
 * W3 Slice 2 — the derived memory FTS index + the BM25-backed {@link FtsLexicalScorer} (criterion 1
 * lexical relevance). Exercises `toFtsMatch`, `MemoryFtsIndex.rebuild/upsert/search`, the scorer's
 * exact-match dominance + FTS fallback + cache, and an end-to-end `recallProjection` rank where a
 * claim-token match outranks a non-match via the FTS scorer (proving the port wires through).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Verdicts } from './enums.js';
import { FtsLexicalScorer, MemoryFtsIndex, toFtsMatch } from './fts-index.js';
import { memoryRecordId } from './ids.js';
import { EXACT_MATCH_BONUS, recallProjection } from './recall.js';
import type { MemoryEvidence, MemoryRecord } from './types.js';

const NOW = '2026-01-01T00:00:00.000Z';
const BLAKE_A = `blake3:${'a'.repeat(64)}`;

function evidence(
  partial: Partial<MemoryEvidence> & { kind?: MemoryEvidence['kind'] } = {},
): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: BLAKE_A,
    ...partial,
  };
}

function record(opts: {
  subject?: string;
  claim?: string;
  appliesTo?: string[];
  trust?: Verdicts['trust'];
  verdicts?: Partial<Verdicts>;
}): MemoryRecord {
  const subject = opts.subject ?? 'sym:src/a.ts#A.b';
  const claim = opts.claim ?? 'A.b does the thing';
  const appliesTo = opts.appliesTo ?? [subject];
  const input = {
    kind: 'fact' as const,
    subject,
    claim,
    scope: { boundary: 'repo' as const, repoId: 'r-test' },
    appliesTo,
    evidence: [evidence({ soulId: subject, quote: 'does the thing' })],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: opts.trust ?? 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
      ...opts.verdicts,
    },
    createdAt: NOW,
  };
}

let index: MemoryFtsIndex;

beforeEach(() => {
  index = new MemoryFtsIndex(':memory:');
});
afterEach(() => {
  index.close();
});

// ─── toFtsMatch ──────────────────────────────────────────────────────────────

describe('toFtsMatch', () => {
  it('OR-joins alphanumeric tokens as prefix matches', () => {
    expect(toFtsMatch('auth login')).toBe('"auth"* OR "login"*');
  });
  it('returns undefined for a query with no usable tokens', () => {
    expect(toFtsMatch('   ')).toBeUndefined();
    expect(toFtsMatch('!@#$%')).toBeUndefined();
    expect(toFtsMatch('')).toBeUndefined();
  });
});

// ─── MemoryFtsIndex ──────────────────────────────────────────────────────────

describe('MemoryFtsIndex', () => {
  it('search returns a higher=better BM25 map; non-matching records are absent', () => {
    const auth = record({
      subject: 'topic:auth',
      claim: 'the auth module handles login and logout',
    });
    const ui = record({ subject: 'topic:ui', claim: 'renders the button and the icon' });
    index.rebuild([auth, ui]);
    const hits = index.search('auth');
    expect(hits.has(auth.id)).toBe(true);
    expect(hits.has(ui.id)).toBe(false); // "ui" record has no "auth" token
    expect(hits.get(auth.id)).toBeGreaterThan(0);
  });

  it('a record matching more query tokens scores higher (BM25 relevance)', () => {
    const strong = record({ subject: 'topic:a', claim: 'auth login session token' });
    const weak = record({ subject: 'topic:b', claim: 'auth only appears once here' });
    index.rebuild([strong, weak]);
    const hits = index.search('auth login token');
    expect(hits.get(strong.id) ?? 0).toBeGreaterThan(hits.get(weak.id) ?? 0);
  });

  it('rebuild clears the prior index (no stale rows)', () => {
    const old = record({ subject: 'topic:old', claim: 'stale auth claim' });
    index.rebuild([old]);
    index.rebuild([record({ subject: 'topic:new', claim: 'fresh ui claim' })]);
    const hits = index.search('auth');
    expect(hits.size).toBe(0); // the only auth-bearing record was dropped on rebuild
  });

  it('upsert adds new records and replaces updated ones (delete-by-id + insert, not append)', () => {
    const r = record({ subject: 'topic:auth', claim: 'auth handles login' });
    index.upsert([r]);
    expect(index.search('login').has(r.id)).toBe(true); // 'login' is claim-only
    // upsert an updated claim for the same id; the old row must be replaced, not appended.
    const updated: MemoryRecord = { ...r, claim: 'now about the ui button' };
    index.upsert([updated]);
    expect(index.search('login').has(r.id)).toBe(false); // old claim token gone after replace
    expect(index.search('button').has(r.id)).toBe(true); // new claim token present
  });

  it('search on an unusable query returns an empty map (no FTS scan)', () => {
    index.rebuild([record({ claim: 'auth' })]);
    expect(index.search('   ').size).toBe(0);
  });

  it('indexes evidence quotes + appliesTo targets for lexical match', () => {
    const r = record({
      subject: 'topic:unrelated',
      claim: 'no mention here',
      appliesTo: ['sym:src/auth.ts#login'],
    });
    index.rebuild([r]);
    // the appliesTo target carries the "auth" token into the targets column
    expect(index.search('auth').has(r.id)).toBe(true);
  });
});

// ─── FtsLexicalScorer ────────────────────────────────────────────────────────

describe('FtsLexicalScorer', () => {
  it('exact subject match dominates (returns EXACT_MATCH_BONUS, no FTS needed)', () => {
    const r = record({
      subject: 'sym:src/auth.ts#login',
      claim: 'c',
      appliesTo: ['sym:other.ts#Z'],
    });
    index.rebuild([r]);
    const scorer = new FtsLexicalScorer(index);
    expect(scorer.score(r, 'sym:src/auth.ts#login', [])).toBe(EXACT_MATCH_BONUS);
  });

  it('exact appliesTo target match returns EXACT_MATCH_BONUS + matched count', () => {
    const r = record({
      subject: 'topic:auth',
      claim: 'c',
      appliesTo: ['sym:src/a.ts#A.b', 'sym:src/b.ts#C.d'],
    });
    index.rebuild([r]);
    const scorer = new FtsLexicalScorer(index);
    expect(scorer.score(r, 'q', ['sym:src/a.ts#A.b', 'sym:src/b.ts#C.d'])).toBe(
      EXACT_MATCH_BONUS + 2,
    );
  });

  it('non-exact match falls back to FTS BM25 (higher=better, ≥0)', () => {
    const r = record({ subject: 'topic:auth', claim: 'the auth module handles login' });
    index.rebuild([r]);
    const scorer = new FtsLexicalScorer(index);
    const score = scorer.score(r, 'auth', []);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(EXACT_MATCH_BONUS); // FTS magnitudes are O(1–10)
  });

  it('empty query with no exact match returns 0 (no FTS scan)', () => {
    const r = record({ subject: 'topic:auth', claim: 'c', appliesTo: ['sym:other.ts#Z'] });
    index.rebuild([r]);
    const scorer = new FtsLexicalScorer(index);
    expect(scorer.score(r, '', ['sym:unrelated.ts#X'])).toBe(0);
  });

  it('memoizes one FTS query per distinct query string', () => {
    const r = record({ subject: 'topic:auth', claim: 'auth handles login' });
    index.rebuild([r]);
    const scorer = new FtsLexicalScorer(index);
    const s1 = scorer.score(r, 'auth', []);
    // Rebuild the index with a different record (different id) underneath the cache. A non-memoizing
    // scorer would re-query and find r.id absent → 0; the memoized cache serves the original s1.
    index.rebuild([record({ subject: 'topic:auth', claim: 'completely different now' })]);
    const s2 = scorer.score(r, 'auth', []);
    expect(s2).toBe(s1); // cache hit — the underlying FTS scan was NOT repeated
  });
});

// ─── end-to-end: recallProjection with the FTS scorer (criterion 1) ───────────

describe('recallProjection + FtsLexicalScorer (criterion 1 lexical relevance)', () => {
  it('a claim-token match outranks a non-match when no exact match is present', () => {
    const authClaim = record({ subject: 'topic:x', claim: 'the auth module handles login' });
    const noMatch = record({
      subject: 'topic:y',
      claim: 'renders the button',
      appliesTo: ['sym:ui.ts#Z'],
    });
    index.rebuild([authClaim, noMatch]);
    const scorer = new FtsLexicalScorer(index);
    const p = recallProjection(
      {
        records: [
          { record: noMatch, source: 'local' },
          { record: authClaim, source: 'local' },
        ],
        decisions: [],
        localDecisions: [],
        feedback: [],
        errors: [],
      },
      { query: 'auth', lexicalScorer: scorer },
    );
    expect(p.memories[0]?.record.id).toBe(authClaim.id); // lexical relevance wins (criterion 1)
    expect(p.memories[0]?.score.lexical).toBeGreaterThan(0);
    expect(p.memories[1]?.score.lexical).toBe(0);
  });
});
