/**
 * G3.2 — the retrieval eval's own gate. Two jobs, both demanded BY the code under test:
 *
 *   1. the held-out construction invariants `bench/heldout.ts` names in its header ("asserted by
 *      `retrieval-eval.test.ts`, never hand-waved"): zero word-token overlap with the labeled
 *      record's claim, word-disjointness from the published (dev) paraphrase, and index alignment
 *      of `HELDOUT_PARAPHRASES[i]` with the record `relevanceCorpus()` emits for topic `i`;
 *
 *   2. the pre-registered selection rule AS CODE (`selectLaunchDefault`): the minimum-effect
 *      threshold, the exact-recall regression guard, the p95 latency guard, the tie-break, and the
 *      negative result — a fusion strategy that does not clear the bar ships NOTHING.
 */
import { describe, expect, it } from 'vitest';
import { HELDOUT_PARAPHRASES, heldOutQueries } from './heldout.js';
import {
  MAX_P95_RATIO,
  MIN_EFFECT_RECALL_DELTA,
  PREREGISTRATION_DOC,
  type StrategyEval,
  runRetrievalEval,
  selectLaunchDefault,
} from './retrieval-eval.js';
import { TOPIC_BANK_SIZE, relevanceCorpus } from './scenarios.js';

/** Word tokens, lowercase; underscores kept (mod tokens / identifiers must not split). */
function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => !/^mod\d+$/.test(t)));
}

function overlap(a: string, b: string): string[] {
  const ta = tokens(a);
  const tb = tokens(b);
  return [...ta].filter((t) => tb.has(t));
}

// ─── held-out construction invariants (heldout.ts's own contract) ────────────

describe('held-out construction invariants', () => {
  it('the held-out bank is complete and index-aligned with the topic bank', () => {
    expect(HELDOUT_PARAPHRASES.length).toBe(TOPIC_BANK_SIZE);
    // Every entry is a real, non-empty paraphrase — a placeholder would silently weaken the split.
    for (const q of HELDOUT_PARAPHRASES) {
      expect(q.trim().length).toBeGreaterThan(10);
    }
  });

  it('heldOutQueries labels each held-out paraphrase with the record the corpus emitted for topic i', () => {
    const { queries } = relevanceCorpus(8);
    const held = heldOutQueries(8, queries);
    expect(held.length).toBe(8);
    for (let i = 0; i < held.length; i++) {
      // The corpus emits [exact(i), paraphrase(i)] — the dev paraphrase at 2i+1 labels record i,
      // so the held-out query for topic i must carry the SAME relevant id (invariant 3).
      expect(held[i]!.relevantIds).toEqual(queries[2 * i + 1]!.relevantIds);
      expect(held[i]!.family).toBe('heldout-paraphrase');
    }
  });

  it('every held-out paraphrase shares zero word tokens with its labeled record claim (invariant 1)', () => {
    const { records } = relevanceCorpus(TOPIC_BANK_SIZE);
    const bad: string[] = [];
    for (let i = 0; i < HELDOUT_PARAPHRASES.length; i++) {
      const hits = overlap(HELDOUT_PARAPHRASES[i]!, records[i]!.claim);
      if (hits.length > 0) bad.push(`[${i}] ${hits.join(', ')}`);
    }
    expect(bad, `held-out entries sharing claim tokens: ${bad.join(' | ')}`).toEqual([]);
  });

  it('every held-out paraphrase is word-disjoint from the published (dev) paraphrase (invariant 2)', () => {
    const { queries } = relevanceCorpus(TOPIC_BANK_SIZE);
    const bad: string[] = [];
    for (let i = 0; i < HELDOUT_PARAPHRASES.length; i++) {
      const dev = queries[2 * i + 1]!.query;
      const hits = overlap(HELDOUT_PARAPHRASES[i]!, dev);
      if (hits.length > 0) bad.push(`[${i}] ${hits.join(', ')}`);
    }
    expect(bad, `held-out entries rewording the dev split: ${bad.join(' | ')}`).toEqual([]);
  });
});

// ─── the harness end-to-end (small corpus; the full 40-topic run is the bench, not the gate) ──

describe('runRetrievalEval', () => {
  it('measures all three strategies over the three splits on the same fixture', () => {
    const report = runRetrievalEval({ topics: 6 });
    expect(report.preregistration).toBe(PREREGISTRATION_DOC);
    // records = the 6 corpus rows + the global decoy the baseline seeds alongside them.
    expect(report.scale).toEqual({ records: 7, heldoutQueries: 6, devQueries: 6, exactQueries: 6 });
    expect(report.strategies.map((s) => s.strategy)).toEqual(['lexical-only', 'rrf', 'weighted']);
    expect(report.strategies[0]!.embedderId).toBe('none');
    expect(report.strategies[1]!.embedderId).toBe(report.embedderId);
    for (const s of report.strategies) {
      expect(s.recallAt5).toBeGreaterThanOrEqual(0);
      expect(s.recallAt5).toBeLessThanOrEqual(1);
      // The regression guard split must be measurable at all: exact queries hit the exact-match
      // band, so the incumbent cannot miss them (recall@5 of a single labeled record).
      expect(s.exactRecallAt5).toBe(1);
      expect(s.rankP95Ms).toBeGreaterThan(0);
    }
  });

  it('applies the pre-registered rule to its own measured rows (whatever the honest outcome)', () => {
    const report = runRetrievalEval({ topics: 6 });
    const again = selectLaunchDefault(report.strategies);
    expect(again.versionId).toBe(report.launchDefault.versionId);
    expect(again.fusionWon).toBe(report.launchDefault.fusionWon);
    // The decision cites the frozen rule document either way — never an untraceable number.
    expect(report.launchDefault.reason).toMatch(/pre-registered/);
    if (report.launchDefault.fusionWon) {
      const winner = report.strategies.find((s) => s.versionId === report.launchDefault.versionId);
      const base = report.strategies[0]!;
      expect(winner!.recallAt5).toBeGreaterThanOrEqual(base.recallAt5 + MIN_EFFECT_RECALL_DELTA);
      expect(winner!.exactRecallAt5).toBeGreaterThanOrEqual(base.exactRecallAt5);
    } else {
      expect(report.launchDefault.reason).toMatch(/negative result/);
    }
  });
});

// ─── the selection rule, unit-pinned on fabricated rows ──────────────────────

/** A minimal StrategyEval row — only the fields the rule reads carry meaning. */
function row(opts: Partial<StrategyEval> & { strategy: StrategyEval['strategy'] }): StrategyEval {
  const { strategy, ...rest } = opts;
  return {
    versionId: `memory-rank-v2:test:${strategy}`,
    embedderId: strategy === 'lexical-only' ? 'none' : 'test-embedder',
    recallAt5: 0.3,
    precisionAt5: 0.3,
    mrr: 0.3,
    exactRecallAt5: 1,
    devParaphraseRecallAt5: 0.3,
    rankP50Ms: 1,
    rankP95Ms: 2,
    strategy,
    ...rest,
  };
}

describe('selectLaunchDefault — the frozen rule (pre-registration §4)', () => {
  const base = row({ strategy: 'lexical-only' });

  it('a fusion strategy clearing every gate replaces the incumbent', () => {
    const winner = row({ strategy: 'rrf', recallAt5: base.recallAt5 + MIN_EFFECT_RECALL_DELTA });
    const d = selectLaunchDefault([base, winner]);
    expect(d.fusionWon).toBe(true);
    expect(d.versionId).toBe(winner.versionId);
    expect(d.reason).toMatch(/won the pre-registered rule/);
  });

  it('a below-threshold delta is a NEGATIVE RESULT — lexical-only ships, never spun', () => {
    const almost = row({ strategy: 'weighted', recallAt5: base.recallAt5 + 0.149 });
    const d = selectLaunchDefault([base, almost]);
    expect(d.fusionWon).toBe(false);
    expect(d.versionId).toBe(base.versionId);
    expect(d.reason).toMatch(/negative result/);
    expect(d.reason).toMatch(/delta 0\.149/);
  });

  it('an exact-recall regression disqualifies a fusion strategy outright', () => {
    const regression = row({
      strategy: 'rrf',
      recallAt5: base.recallAt5 + 0.3,
      exactRecallAt5: 0.9,
    });
    const d = selectLaunchDefault([base, regression]);
    expect(d.fusionWon).toBe(false);
  });

  it('a latency blowout past the pre-registered ratio disqualifies a fusion strategy', () => {
    const slow = row({
      strategy: 'weighted',
      recallAt5: base.recallAt5 + 0.3,
      rankP95Ms: base.rankP95Ms * MAX_P95_RATIO * 1.01,
    });
    const d = selectLaunchDefault([base, slow]);
    expect(d.fusionWon).toBe(false);
  });

  it('an equal-recall tie is broken by lower rank p95', () => {
    const fast = row({ strategy: 'rrf', recallAt5: 0.6, rankP95Ms: 1 });
    const slow = row({ strategy: 'weighted', recallAt5: 0.6, rankP95Ms: 3 });
    const d = selectLaunchDefault([base, slow, fast]);
    expect(d.fusionWon).toBe(true);
    expect(d.versionId).toBe(fast.versionId);
  });

  it('the HIGHEST eligible recall wins among multiple eligible strategies', () => {
    const good = row({ strategy: 'rrf', recallAt5: 0.5 });
    const better = row({ strategy: 'weighted', recallAt5: 0.7 });
    const d = selectLaunchDefault([base, good, better]);
    expect(d.versionId).toBe(better.versionId);
  });

  it('refuses a report with no lexical-only baseline', () => {
    expect(() => selectLaunchDefault([row({ strategy: 'rrf', recallAt5: 0.9 })])).toThrow(
      /lexical-only baseline missing/,
    );
  });

  it('reports the no-fusion case honestly instead of throwing', () => {
    const d = selectLaunchDefault([base]);
    expect(d.fusionWon).toBe(false);
    expect(d.reason).toMatch(/no fusion strategy was measured/);
  });
});
