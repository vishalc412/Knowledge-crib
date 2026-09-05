import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * G3.2 — the pre-registered held-out retrieval eval. The RULE lives in
 * docs/bench/retrieval-pre-registration.md and was frozen BEFORE this harness ever ran; this file
 * implements that rule AS CODE so the selection is executable, not narrative.
 *
 * Construction (pre-registration §1): the index is the existing P0 relevance corpus
 * (`relevanceCorpus`) seeded into REAL stores exactly like `runRecallRelevance` — team/local
 * alternating + the global decoy — so the fixture is identical to the published baseline. The
 * decision queries are the HELD-OUT paraphrases (bench/heldout.ts), one per topic, word-disjoint
 * from their claim AND from the published (dev) paraphrases. The dev paraphrases are measured too
 * but are explicitly NON-DECIDING (they are the set the fusion work was built against).
 *
 * Metric (pre-registration §2): recall@5 on held-out paraphrases is the decision metric; exact
 * recall@5 is a regression guard (a strategy that trades away exact dominance is disqualified);
 * MRR/precision are reported; per-call rank latency (FRESH scorer per query — vector precompute
 * inside the window, the production shape) is the tie-break only.
 *
 * Selection (pre-registration §4): highest held-out recall@5, ties → lower p95, gated by the
 * minimum-effect threshold (recall@5 ≥ lexical-only + {@link MIN_EFFECT_RECALL_DELTA}, no exact
 * regression, p95 ≤ {@link MAX_P95_RATIO}× lexical-only). If nothing clears the bar, lexical-only
 * ships — reported as a negative result, never spun.
 */
import { performance } from 'node:perf_hooks';
import type { Embedder } from '@knowledge-crib/core';
import { CharNgramEmbedder } from '@knowledge-crib/core';
import { MemoryFtsIndex } from '../fts-index.js';
import { type FusionStrategy, VersionedLexicalScorer } from '../fusion.js';
import {
  type GatheredRecall,
  type RecallStores,
  gatherRecall,
  recallProjection,
} from '../recall.js';
import { MemoryStore } from '../store.js';
import type { MemoryRecord, MemoryRecordVersioned } from '../types.js';
import { benchHash, buildBenchRecord, quoteEvidence } from './corpus.js';
import { heldOutQueries } from './heldout.js';
import { mrr, p50p95, precisionAtK, recallAtK } from './metrics.js';
import { relevanceCorpus } from './scenarios.js';

/** Pre-registered minimum-effect threshold: held-out recall@5 must beat lexical-only by this much. */
export const MIN_EFFECT_RECALL_DELTA = 0.15;
/** Pre-registered latency guard: fused rank p95 may not exceed this multiple of lexical-only's. */
export const MAX_P95_RATIO = 2;

/** Where the frozen rule lives — every report carries the pointer so numbers cite their contract. */
export const PREREGISTRATION_DOC = 'docs/bench/retrieval-pre-registration.md';

/** Per-strategy held-out eval result. */
export interface StrategyEval {
  versionId: string;
  strategy: FusionStrategy;
  /** The embedder backing the cosine channel ('none' for lexical-only). */
  embedderId: string;
  /** THE decision metric: recall@5 on the held-out paraphrase split. */
  recallAt5: number;
  precisionAt5: number;
  mrr: number;
  /** Regression guard (pre-registration §2): must not drop below lexical-only's. */
  exactRecallAt5: number;
  /** NON-DECIDING — the dev split the fusion work was built against (reported for transparency). */
  devParaphraseRecallAt5: number;
  /** Per-call rank latency, fresh scorer per query (pre-registration §2). Tie-break only. */
  rankP50Ms: number;
  rankP95Ms: number;
}

export interface RetrievalEvalReport {
  preregistration: string;
  scale: { records: number; heldoutQueries: number; devQueries: number; exactQueries: number };
  /** The embedder tier the DECISION was made on (the fallback tier — see pre-registration §3). */
  embedderTier: 'fallback' | 'installed';
  embedderId: string;
  strategies: StrategyEval[];
  launchDefault: LaunchDefault;
}

export interface LaunchDefault {
  versionId: string;
  /** true iff a FUSION strategy won; false means the incumbent lexical-only ships (a negative result). */
  fusionWon: boolean;
  /** The rule's verdict in words, including the threshold arithmetic — auditable, not vibes. */
  reason: string;
}

/**
 * Run the pre-registered eval over the held-out split. Deterministic except the latency samples
 * (inherent); the RANKINGS the decision metric is computed over are byte-identical run to run.
 * `opts.embedder` swaps the cosine channel's embedder (e.g. an installed on-device model);
 * the default is the char-ngram fallback tier — the only tier guaranteed present at launch.
 */
export function runRetrievalEval(
  opts: { topics?: number; embedder?: Embedder; embedderTier?: 'fallback' | 'installed' } = {},
): RetrievalEvalReport {
  const topics = opts.topics ?? 40; // full pre-registered corpus (the bank is capped at 40)
  const embedder = opts.embedder ?? new CharNgramEmbedder();
  const embedderTier = opts.embedderTier ?? 'fallback';

  const fixture = buildEvalFixture(topics);
  const heldout = heldOutQueries(topics, fixture.queries);
  const exact = fixture.queries.filter((q) => q.family === 'exact');
  const dev = fixture.queries.filter((q) => q.family === 'paraphrase');

  const strategies: StrategyEval[] = [];
  const candidates: Array<{ strategy: FusionStrategy; embedder?: Embedder }> = [
    { strategy: 'lexical-only' },
    { strategy: 'rrf', embedder },
    { strategy: 'weighted', embedder },
  ];
  const fts = new MemoryFtsIndex(':memory:');
  try {
    const corpusRecords = fixture.gathered.records.map((g) => g.record);
    fts.rebuild(corpusRecords);
    for (const c of candidates) {
      strategies.push(
        evalStrategy(c.strategy, c.embedder, fts, corpusRecords, fixture.gathered, {
          exact,
          dev,
          heldout,
        }),
      );
    }
  } finally {
    fts.close();
  }

  const base = strategies[0]!;
  return {
    preregistration: PREREGISTRATION_DOC,
    scale: {
      records: fixture.gathered.records.length,
      heldoutQueries: heldout.length,
      devQueries: dev.length,
      exactQueries: exact.length,
    },
    embedderTier,
    embedderId: embedder.id,
    strategies,
    launchDefault: selectLaunchDefault(strategies),
  };
}

/**
 * The pre-registered selection rule, executable (pre-registration §4): highest held-out recall@5
 * wins; ties broken by lower p95; a fusion strategy only REPLACES the incumbent if it clears the
 * minimum-effect threshold. No fusion winner ⇒ lexical-only ships and the reason says so plainly.
 */
export function selectLaunchDefault(strategies: readonly StrategyEval[]): LaunchDefault {
  const base = strategies.find((s) => s.strategy === 'lexical-only');
  if (!base) throw new Error('lexical-only baseline missing from eval — invalid report');
  const fused = strategies.filter((s) => s.strategy !== 'lexical-only');
  const eligible = fused.filter(
    (s) =>
      s.recallAt5 >= base.recallAt5 + MIN_EFFECT_RECALL_DELTA &&
      s.exactRecallAt5 >= base.exactRecallAt5 &&
      s.rankP95Ms <= base.rankP95Ms * MAX_P95_RATIO,
  );
  if (eligible.length === 0) {
    const best = fused.reduce<StrategyEval | undefined>(
      (a, b) => (a === undefined || b.recallAt5 > a.recallAt5 ? b : a),
      undefined,
    );
    const bestNote = best
      ? ` best fusion ${best.versionId} reached recall@5 ${fmt(best.recallAt5)} vs baseline ${fmt(base.recallAt5)} (delta ${fmt(best.recallAt5 - base.recallAt5)} < ${MIN_EFFECT_RECALL_DELTA}, or guard failed)`
      : ' no fusion strategy was measured';
    return {
      versionId: base.versionId,
      fusionWon: false,
      reason: `no fusion strategy cleared the pre-registered minimum-effect threshold.${bestNote} lexical-only ships as the launch default (negative result, per docs/bench/retrieval-pre-registration.md §4)`,
    };
  }
  const winner = eligible.reduce((a, b) =>
    b.recallAt5 > a.recallAt5 || (b.recallAt5 === a.recallAt5 && b.rankP95Ms < a.rankP95Ms) ? b : a,
  );
  return {
    versionId: winner.versionId,
    fusionWon: true,
    reason: `won the pre-registered rule: held-out recall@5 ${fmt(winner.recallAt5)} ≥ baseline ${fmt(base.recallAt5)} + ${MIN_EFFECT_RECALL_DELTA}, exact recall@5 ${fmt(winner.exactRecallAt5)} unregressed, rank p95 ${winner.rankP95Ms.toFixed(1)}ms ≤ ${MAX_P95_RATIO}× baseline`,
  };
}

function fmt(x: number): string {
  return x.toFixed(3);
}

// ─── fixture + per-strategy measurement ──────────────────────────────────────

interface EvalFixture {
  gathered: GatheredRecall;
  queries: Array<{ query: string; relevantIds: string[]; family: 'exact' | 'paraphrase' }>;
}

/**
 * The index half of the eval set (pre-registration §1): the SAME seeding as `runRecallRelevance` —
 * real stores under a temp dir, team/local alternating, the global decoy — then gathered once. The
 * gathered set is reused by every strategy so the only difference between rows is the scorer.
 */
function buildEvalFixture(topics: number): EvalFixture {
  const dir = mkdtempSync(join(tmpdir(), 'crib-retrieval-eval-'));
  const env: NodeJS.ProcessEnv = { KCRIB_MEMORY_DIR: dir };
  const stores: RecallStores = {
    team: MemoryStore.team(join(dir, 'team-crib'), { env, repoRoot: dir }),
    local: MemoryStore.local('retrieval-eval-repo', { env, repoRoot: dir }),
    global: MemoryStore.global({ env }),
  };
  try {
    const { records, queries } = relevanceCorpus(topics);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      const teamRow = i % 2 === 0;
      (teamRow ? stores.team : stores.local)?.upsertEntry(teamRow ? 'records' : 'active', rec);
    }
    // The same global decoy the baseline uses — must never hijack a held-out query either.
    stores.global?.upsertEntry(
      'records',
      buildBenchRecord({
        subject: 'topic:global-convention',
        claim: 'prefer pnpm workspaces over npm across this org',
        evidence: [
          quoteEvidence(
            'topic:global-convention',
            'prefer pnpm workspaces over npm across this org',
            benchHash('live'),
          ),
        ],
      }),
    );
    return { gathered: gatherRecall(stores), queries };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface QuerySplit {
  exact: ReadonlyArray<{ query: string; relevantIds: string[] }>;
  dev: ReadonlyArray<{ query: string; relevantIds: string[] }>;
  heldout: ReadonlyArray<{ query: string; relevantIds: string[] }>;
}

/** Rank all three splits through the projection with a FRESH scorer per query; time the calls. */
function evalStrategy(
  strategy: FusionStrategy,
  embedder: Embedder | undefined,
  fts: MemoryFtsIndex,
  corpusRecords: ReadonlyArray<MemoryRecordLike>,
  gathered: GatheredRecall,
  split: QuerySplit,
): StrategyEval {
  const versionId = new VersionedLexicalScorer({
    fts,
    records: corpusRecords,
    embedder,
    strategy,
  }).versionId;
  const timed = (
    qs: ReadonlyArray<{ query: string; relevantIds: string[] }>,
  ): {
    ranked: string[][];
    relevant: string[][];
    ms: number[];
  } => {
    const ranked: string[][] = [];
    const relevant: string[][] = [];
    const ms: number[] = [];
    for (const q of qs) {
      // FRESH scorer per query — the production shape (one projection per call), so the cosine
      // channel's lazy per-record precompute is inside the measured window (pre-registration §2).
      const scorer = new VersionedLexicalScorer({
        fts,
        records: corpusRecords,
        embedder,
        strategy,
      });
      const t0 = performance.now();
      const proj = recallProjection(gathered, { query: q.query, lexicalScorer: scorer });
      ms.push(performance.now() - t0);
      ranked.push(proj.memories.slice(0, 10).map((m) => m.record.id));
      relevant.push([...q.relevantIds]);
    }
    return { ranked, relevant, ms };
  };

  const held = timed(split.heldout);
  const ex = timed(split.exact);
  const dev = timed(split.dev);
  const allMs = [...held.ms, ...ex.ms, ...dev.ms];
  const { p50, p95 } = p50p95(allMs);
  return {
    versionId,
    strategy,
    embedderId: embedder?.id ?? 'none',
    recallAt5: mean(held.ranked, held.relevant, (r, rel) => recallAtK(r, rel, 5)),
    precisionAt5: mean(held.ranked, held.relevant, (r, rel) => precisionAtK(r, rel, 5)),
    mrr: mrr(held.ranked, held.relevant),
    exactRecallAt5: mean(ex.ranked, ex.relevant, (r, rel) => recallAtK(r, rel, 5)),
    devParaphraseRecallAt5: mean(dev.ranked, dev.relevant, (r, rel) => recallAtK(r, rel, 5)),
    rankP50Ms: p50,
    rankP95Ms: p95,
  };
}

/** memory Record shape the projection ranks (v1 read model; v2 participates via the same ports). */
type MemoryRecordLike = MemoryRecord | MemoryRecordVersioned;

function mean(
  ranked: readonly (readonly string[])[],
  relevant: readonly (readonly string[])[],
  f: (r: readonly string[], rel: readonly string[]) => number,
): number {
  if (ranked.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < ranked.length; i++) total += f(ranked[i] ?? [], relevant[i] ?? []);
  return total / ranked.length;
}

/** Human-readable report (the honest, threshold-arithmetic-included rendering). */
export function formatRetrievalEval(r: RetrievalEvalReport): string {
  const lines: string[] = [];
  lines.push('retrieval scorer eval — pre-registered held-out rule (G3.2)');
  lines.push(`rule: ${r.preregistration}`);
  lines.push(
    `set: ${r.scale.records} records; heldout ${r.scale.heldoutQueries} / dev ${r.scale.devQueries} / exact ${r.scale.exactQueries} queries; embedder tier ${r.embedderTier} (${r.embedderId})`,
  );
  lines.push('');
  lines.push(
    '  strategy                                        heldout R@5   exact R@5 (guard)   dev R@5   rank p50/p95',
  );
  for (const s of r.strategies) {
    lines.push(
      `  ${s.versionId.padEnd(47)} ${(s.recallAt5 * 100).toFixed(1).padStart(6)}%      ` +
        `${(s.exactRecallAt5 * 100).toFixed(1).padStart(6)}%           ` +
        `${(s.devParaphraseRecallAt5 * 100).toFixed(1).padStart(6)}%   ` +
        `${s.rankP50Ms.toFixed(1)}ms / ${s.rankP95Ms.toFixed(1)}ms`,
    );
  }
  lines.push('');
  lines.push(`launch default: ${r.launchDefault.versionId}`);
  lines.push(`  ${r.launchDefault.reason}`);
  return lines.join('\n');
}
