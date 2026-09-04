/**
 * P0 bench — correctness invariants at FAST scale. These tests are the benchmark's own regression
 * suite: every scenario family must uphold its invariants (relevance ranking exact-only, PRD verdict
 * transitions, content-id dedupe, trust-discipline, real-store latency phases complete). TIMING is
 * deliberately NOT asserted — CI machines are too noisy; the latency numbers are published by the
 * CLI (`crib memory bench`), gated only on the scenario completing.
 */
import { describe, expect, it } from 'vitest';
import { mrr, p50p95, percentile, recallAtK } from './metrics.js';
import { BENCH_SCALE_FAST, type BenchScale, formatBenchReport, runMemoryBench } from './run.js';
import { TOPIC_BANK_SIZE, relevanceCorpus } from './scenarios.js';

// ─── metrics ─────────────────────────────────────────────────────────────────

describe('bench metrics', () => {
  it('recall@5 counts relevant hits within the top k', () => {
    expect(recallAtK(['a', 'b', 'c', 'd', 'e', 'f'], ['b', 'f'], 5)).toBe(0.5);
    expect(recallAtK(['a', 'b'], [], 3)).toBe(0); // no ground truth → 0, never NaN
    expect(recallAtK([], ['x'], 3)).toBe(0);
  });

  it('mrr averages reciprocal rank over queries with ground truth, 0 when absent', () => {
    expect(mrr([['a', 'b'], ['x', 'y'], []], [['b'], ['z'], []])).toBeCloseTo((0.5 + 0) / 2);
    expect(mrr([], [])).toBe(0);
  });

  it('percentile is nearest-rank on the sorted sample', () => {
    const xs = [5, 1, 9, 3, 7];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 0.5)).toBe(5);
    expect(percentile(xs, 1)).toBe(9);
    expect(p50p95(xs).p95).toBe(9);
  });
});

// ─── corpus determinism + topic discipline ──────────────────────────────────

describe('bench corpus', () => {
  it('is deterministic: same scale → byte-identical ids and labels', () => {
    const a = relevanceCorpus(6);
    const b = relevanceCorpus(6);
    expect(a.records.map((r) => r.id)).toEqual(b.records.map((r) => r.id));
    expect(a.queries).toEqual(b.queries);
  });

  it('never reuses a content id across instances', () => {
    const { records } = relevanceCorpus(TOPIC_BANK_SIZE);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
  });

  it('draws DISTINCT topics only: n above the bank size is capped, one topic per record', () => {
    const { records, queries } = relevanceCorpus(TOPIC_BANK_SIZE + 20);
    expect(records.length).toBe(TOPIC_BANK_SIZE);
    expect(queries.length).toBe(TOPIC_BANK_SIZE * 2);
    // every query labels exactly one record → recall@5 and MRR both get a clean 1.0 ceiling
    for (const q of queries) expect(q.relevantIds).toHaveLength(1);
    // no two records share a claim once the mod token is stripped → the bank was not cycled
    const stripMod = (claim: string) => claim.replace(/mod\d+/g, '').trim();
    expect(new Set(records.map((r) => stripMod(r.claim))).size).toBe(records.length);
  });

  it('paraphrase queries share ZERO tokens with their claim (the honest semantic-recall split)', () => {
    const { records, queries } = relevanceCorpus(TOPIC_BANK_SIZE);
    const tokens = (s: string) =>
      new Set(
        s
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length > 0),
      );
    for (const q of queries) {
      if (q.family !== 'paraphrase') continue;
      const rec = records.find((r) => q.relevantIds.includes(r.id))!;
      const claimTokens = tokens(rec.claim);
      const queryTokens = [...tokens(q.query)].filter((t) => !STOPWORDS.has(t));
      const overlap = queryTokens.filter((t) => claimTokens.has(t));
      expect(overlap).toEqual([]);
    }
  });

  it('exact queries DO share claim tokens (the lexical path must stay near-perfect)', () => {
    const { records, queries } = relevanceCorpus(TOPIC_BANK_SIZE);
    for (const q of queries) {
      if (q.family !== 'exact') continue;
      const rec = records.find((r) => q.relevantIds.includes(r.id))!;
      const claimTokens = new Set(rec.claim.toLowerCase().split(/[^a-z0-9]+/));
      const queryTokens = q.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => !STOPWORDS.has(t));
      const shared = queryTokens.filter((t) => claimTokens.has(t));
      expect(shared.length).toBeGreaterThanOrEqual(2);
    }
  });
});

/** Articles/preps that appear on both sides and would make the zero-overlap check a false alarm. */
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'on', 'of', 'in', 'it', 'is', 'so', 'per']);

// ─── the five families at fast scale ─────────────────────────────────────────

describe('memory bench (fast scale)', () => {
  const scale: BenchScale = BENCH_SCALE_FAST;
  const report = runMemoryBench(scale);

  it('(a) ranks exact queries at the top; paraphrase is reported honestly (lexical-only baseline)', () => {
    expect(report.scenarios.recallRelevance.exact.recallAt5).toBeGreaterThan(0.9);
    expect(report.scenarios.recallRelevance.exact.mrr).toBeGreaterThan(0.9);
    // The paraphrase line is a PUBLISHED NUMBER, not an assertion — a lexical-only scorer may or
    // may not squeak by on shared stopwords. It must simply be finite and computed over all queries.
    expect(report.scenarios.recallRelevance.paraphrase.recallAt5).toBeGreaterThanOrEqual(0);
  });

  it('(b) every PRD verdict transition survives refactor survival', () => {
    const b = report.scenarios.refactorSurvival;
    expect(b.stalenessPrecision).toBe(1);
    expect(b.cases.map((c) => c.name)).toEqual(['kept', 'drift', 'moved', 'quote-gone']);
  });

  it('(c) duplicate observations collapse to one row and conflicts surface', () => {
    const c = report.scenarios.crossWriter;
    expect(c.distinctRows).toBe(1);
    expect(c.dedupeRate).toBe(1);
    expect(c.conflictsSurfaced).toBe(c.conflictsExpected);
    expect(c.writesPerSecond).toBeGreaterThan(0);
  });

  it('(d) trust gradient holds every invariant (candidate never recalls, no-poison)', () => {
    const d = report.scenarios.trustGradient;
    expect(d.violations).toEqual([]);
    expect(d.checks).toBeGreaterThanOrEqual(5);
  });

  it('(e) latency family returns all five phase blocks over real stores', () => {
    const e = report.scenarios.latency;
    expect(e.records).toBe(scale.records);
    expect(e.gatherMs.p50).toBeGreaterThan(0);
    expect(e.ftsRebuildMs.p50).toBeGreaterThan(0);
    expect(e.freshEvalMs.p50).toBeGreaterThanOrEqual(0); // 0 stays legal only if the store was empty — it is not
    expect(e.freshEvalMs.p50).toBeGreaterThan(0);
    expect(e.totalMs.p95).toBeGreaterThanOrEqual(e.totalMs.p50);
    expect(e.soulNodes).toBeGreaterThan(0);
  });

  it('renders a human-readable report', () => {
    const text = formatBenchReport(report);
    expect(text).toContain('recall relevance');
    expect(text).toContain('staleness-precision');
    expect(text).toContain('violations');
  });
});
