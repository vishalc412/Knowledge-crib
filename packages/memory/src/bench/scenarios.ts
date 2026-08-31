/**
 * P0 bench scenarios — the five measurement families from the mem0-gap plan (PART III, Phase 0):
 *
 *   (a) `runRecallRelevance`   — labeled query↔claim retrieval, split into an `exact` family
 *                                (query shares several claim tokens) and a `paraphrase` family
 *                                (query is word-disjoint with the claim — pure meaning). The exact
 *                                family should stay near-perfect; the paraphrase family is the one
 *                                a hybrid/semantic scorer (Phase 3) must demonstrably move.
 *   (b) `runRefactorSurvival`  — synthetic repo evolution (kept / content-drift / symbol move /
 *                                quote-death) against the real reattachment machinery; counts how
 *                                many records project the PRD-expected verdict transitions.
 *   (c) `runCrossWriter`       — N writers observing the same claim (dedupe by content id), two
 *                                writers disagreeing on one subject+scope (conflict surfacing),
 *                                and single-record write throughput under the store lock.
 *   (d) `runTrustGradient`     — trust-topology discipline: candidates never recall; a contradicted
 *                                signal without admissible counter-evidence never quarantines; WITH
 *                                admissible counter-evidence it quarantines LOCALLY ONLY (no-poison:
 *                                the team copy of the same id stays recall-eligible).
 *   (e) `runLatency`           — gather / FTS rebuild / rank(fresh=false) / revalidate(fresh=true)
 *                                timings over a scale-configurable store — the J1 baseline curve.
 *
 * Every scenario is deterministic except (e)'s timings (inherent). Sizes are parameters: tests run
 * small variants; the CLI default runs the 10k-record scale for the published report.
 */
import { performance } from 'node:perf_hooks';
import type { Node } from '@knowledge-crib/soul-schema';
import { MemoryEvaluator, effectiveVerdicts, isRecallEligible } from '../evaluator.js';
import { applyContradictedFeedback } from '../feedback.js';
import { FtsLexicalScorer, MemoryFtsIndex } from '../fts-index.js';
import { decisionId, feedbackId } from '../ids.js';
import { type RecallStores, gatherRecall, recallProjection } from '../recall.js';
import type { MemoryDecision, MemoryEvidence, MemoryFeedback, MemoryRecord } from '../types.js';
import {
  FakeSoulPort,
  benchHash,
  benchNode,
  buildBenchCandidate,
  buildBenchRecord,
  quoteEvidence,
} from './corpus.js';
import { p50p95 } from './metrics.js';

// ─── shared types ────────────────────────────────────────────────────────────

/** A labeled relevance query: the query text + the record ids that are the right answers. */
export interface LabeledQuery {
  query: string;
  relevantIds: string[];
  family: 'exact' | 'paraphrase';
}

export interface RankMetrics {
  recallAt5: number;
  precisionAt5: number;
  mrr: number;
}

export interface RecallRelevanceResult {
  family: 'recall-relevance';
  queries: number;
  /** token-rich queries (share several claim tokens) — baseline expectation ≈ 1.0. */
  exact: RankMetrics;
  /** word-disjoint queries (zero shared tokens) — the semantic-recall target Phase 3 must move. */
  paraphrase: RankMetrics;
}

export interface RefactorExpectation {
  evidence: string;
  applicability: string;
  eligible: boolean;
}

export interface RefactorCase {
  name: string;
  records: number;
  expected: RefactorExpectation;
  actualMatched: number;
}

export interface RefactorSurvivalResult {
  cases: RefactorCase[];
  /** fraction of records that projected the expected verdict transition (1.0 = perfect). */
  stalenessPrecision: number;
}

export interface CrossWriterResult {
  writers: number;
  observations: number;
  /** rows in the store for the shared claim after `writers` identical observations (expected 1). */
  distinctRows: number;
  /** (observations − distinctRows) / (observations − 1): 1.0 = every duplicate collapsed. */
  dedupeRate: number;
  conflictsExpected: number;
  conflictsSurfaced: number;
  /** single-entry upserts per second (includes per-write lock acquire/release). */
  writesPerSecond: number;
}

export interface TrustGradientResult {
  /** number of invariant checks performed. */
  checks: number;
  /** descriptions of failed invariants (expected: always empty). */
  violations: string[];
}

export interface LatencyBlock {
  p50: number;
  p95: number;
  min: number;
}

export interface LatencyResult {
  records: number;
  candidates: number;
  decisions: number;
  feedback: number;
  soulNodes: number;
  trials: number;
  /** per-phase timings in ms, p50/p95/min across trials (J1 evidence). */
  gatherMs: LatencyBlock;
  ftsRebuildMs: LatencyBlock;
  rankColdMs: LatencyBlock;
  freshEvalMs: LatencyBlock;
  totalMs: LatencyBlock;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function meanPerQuery(
  ranked: readonly (readonly string[])[],
  relevant: readonly (readonly string[])[],
  f: (rankedIds: readonly string[], relevantIds: readonly string[]) => number,
): number {
  if (ranked.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < ranked.length; i++) total += f(ranked[i] ?? [], relevant[i] ?? []);
  return total / ranked.length;
}

// ─── the topic bank (a) ──────────────────────────────────────────────────────

/**
 * Hand-written coding-domain topics. The `paraphrase` string shares NO token with its `claim` BY
 * CONSTRUCTION (the corpus test asserts zero token intersection); the `mod` slot appears only in
 * the claim + exact query. A lexical-only scorer can therefore recall the relevant record only via
 * the exact family — the paraphrase family is the honest "lexical-only recall misses meaning" line.
 */
const TOPICS: ReadonlyArray<{
  claim: (mod: string) => string;
  exact: (mod: string) => string;
  paraphrase: string;
}> = [
  {
    claim: (m) =>
      `${m} deploy retries with exponential backoff, three attempts, before failing the release job`,
    exact: (m) => `${m} deploy retries exponential backoff`,
    paraphrase: 'build step keeps stalling, pauses again during growing waits per push',
  },
  {
    claim: (m) => `${m} pnpm dedupe after every lockfile churn keeps installs reproducible`,
    exact: (m) => `${m} pnpm dedupe lockfile churn installs`,
    paraphrase: 'dependency resolution breaks whenever the manifest gets regenerated',
  },
  {
    claim: (m) => `${m} parser hangs on stray WHEN blocks until recover bails without advancing`,
    exact: (m) => `${m} parser hangs stray WHEN blocks recover`,
    paraphrase: 'tokenizer never moves forward on malformed conditional branches',
  },
  {
    claim: (m) => `${m} evaluator re-grounds every claim against the live graph on each recall`,
    exact: (m) => `${m} evaluator re-grounds claim live graph`,
    paraphrase: 'verification of assertions happens using current data per lookup',
  },
  {
    claim: (m) => `${m} secrets never land in the ledger, the scanner rejects before any write`,
    exact: (m) => `${m} secrets scanner rejects write ledger`,
    paraphrase: 'credential values are blocked from storage ahead of persistence commits',
  },
  {
    claim: (m) => `${m} uses blake3 content addressing so repeated observations collapse to one id`,
    exact: (m) => `${m} blake3 content addressing collapse id`,
    paraphrase: 'hash based identity makes duplicate notes fold together',
  },
  {
    claim: (m) => `${m} gate refuses to run without a committed policy naming runner profiles`,
    exact: (m) => `${m} gate refuses committed policy runner profiles`,
    paraphrase: 'execution promotion needs an approved configuration on file first',
  },
  {
    claim: (m) => `${m} local quarantine never retracts the same record trusted by the team store`,
    exact: (m) => `${m} local quarantine never retract team`,
    paraphrase: 'one machine negative vote cannot pull shared group trust down',
  },
  {
    claim: (m) => `${m} candidates stay out of recall until they pass an evaluation`,
    exact: (m) => `${m} candidates stay out recall evaluation`,
    paraphrase: 'unproven notes remain invisible while checks are not cleared',
  },
  {
    claim: (m) => `${m} receipts store a digest, never raw command output`,
    exact: (m) => `${m} receipts digest raw command output`,
    paraphrase: 'execution logs are remembered as hashes instead of verbatim text',
  },
  {
    claim: (m) => `${m} conflicts surface together instead of silently picking a winner`,
    exact: (m) => `${m} conflicts surface together silently picking winner`,
    paraphrase: 'disagreeing notes appear side by side rather than one hidden answer',
  },
  {
    claim: (m) => `${m} merge driver unions shards strictly by content id`,
    exact: (m) => `${m} merge driver unions shards content id`,
    paraphrase: 'parallel writers combine through identity of what was stated',
  },
];

/** Deterministic relevance corpus: `n` instances cycling the topic bank (exact + paraphrase pair
 *  per record). `mod${i}` makes every instance's claim unique → distinct content ids. */
export function relevanceCorpus(n: number): { records: MemoryRecord[]; queries: LabeledQuery[] } {
  const records: MemoryRecord[] = [];
  const queries: LabeledQuery[] = [];
  for (let i = 0; i < n; i++) {
    const t = TOPICS[i % TOPICS.length]!;
    const mod = `mod${i}`;
    const subject = `sym:src/${mod}.ts#${mod}Module@L10`;
    const claim = t.claim(mod);
    const record = buildBenchRecord({
      subject,
      claim,
      appliesTo: [subject],
      evidence: [quoteEvidence(subject, claim, benchHash('live'))],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    });
    records.push(record);
    queries.push({ query: t.exact(mod), relevantIds: [record.id], family: 'exact' });
    queries.push({ query: t.paraphrase, relevantIds: [record.id], family: 'paraphrase' });
  }
  return { records, queries };
}

/** Deterministic claim text at scale (latency corpus): cycle the topic bank with generated mods. */
function scaleClaim(i: number): string {
  return TOPICS[i % TOPICS.length]!.claim(`scale${i}`);
}

// ─── (a) recall relevance ────────────────────────────────────────────────────

/**
 * Seed `n` labeled records into REAL stores (local + team placement alternating so criteria 2–3 are
 * exercised, plus a global decoy), then rank each labeled query through `gatherRecall` + FTS + the
 * 6-criterion projection. Reports recall@5 / precision@5 / MRR split by family.
 */
export function runRecallRelevance(
  stores: RecallStores,
  opts: { topics: number },
): RecallRelevanceResult {
  const { records, queries } = relevanceCorpus(opts.topics);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const teamRow = i % 2 === 0;
    const store = teamRow ? stores.team : stores.local;
    store?.upsertEntry(teamRow ? 'records' : 'active', rec);
  }
  // A global decoy with an unrelated claim — must never hijack a query.
  stores.global?.upsertEntry(
    'records',
    buildBenchRecord({
      subject: 'topic:global-convention',
      claim: 'prefer pnpm workspaces over npm across this org',
    }),
  );

  const gathered = gatherRecall(stores);
  const ranked: Record<'exact' | 'paraphrase', string[][]> = { exact: [], paraphrase: [] };
  const relevant: Record<'exact' | 'paraphrase', string[][]> = { exact: [], paraphrase: [] };
  const fts = new MemoryFtsIndex(':memory:');
  try {
    fts.rebuild(gathered.records.map((g) => g.record));
    const scorer = new FtsLexicalScorer(fts);
    for (const q of queries) {
      ranked[q.family].push(
        recallProjection(gathered, { query: q.query, lexicalScorer: scorer })
          .memories.slice(0, 10)
          .map((m) => m.record.id),
      );
      relevant[q.family].push(q.relevantIds);
    }
  } finally {
    fts.close();
  }
  return {
    family: 'recall-relevance',
    queries: queries.length,
    exact: rankMetrics(ranked.exact, relevant.exact),
    paraphrase: rankMetrics(ranked.paraphrase, relevant.paraphrase),
  };
}

/** Average recall@5 / precision@5 / MRR over the per-query lists. */
function rankMetrics(
  ranked: readonly (readonly string[])[],
  relevant: readonly (readonly string[])[],
): RankMetrics {
  const recallAt = (r: readonly string[], rl: readonly string[]) => {
    if (rl.length === 0) return 0;
    let hits = 0;
    for (const id of rl) if (r.slice(0, 5).includes(id)) hits += 1;
    return hits / rl.length;
  };
  const precisionAt = (r: readonly string[], rl: readonly string[]) => {
    if (rl.length === 0) return 0;
    const rel = new Set(rl);
    return r.slice(0, 5).filter((id) => rel.has(id)).length / Math.max(1, r.slice(0, 5).length);
  };
  const recip = (r: readonly string[], rl: readonly string[]) => {
    if (rl.length === 0) return 0;
    const idx = r.findIndex((id) => rl.includes(id));
    return idx >= 0 ? 1 / (idx + 1) : 0;
  };
  return {
    recallAt5: meanPerQuery(ranked, relevant, recallAt),
    precisionAt5: meanPerQuery(ranked, relevant, precisionAt),
    mrr: meanPerQuery(ranked, relevant, recip),
  };
}

// ─── (b) refactor survival ───────────────────────────────────────────────────

const SURVIVAL_BODY = [
  'validates the killable worker under a strict time budget',
  'flushes the pending shard before releasing the write lock',
  'reattaches orphaned claims by stable locator',
  'rejects a shard whose checksum drifts from the manifest',
];

/**
 * Fake soul v1 with one record per node, then evolve per the 4 transition cases (cycling across
 * records): kept / drift / moved / quote-gone. Re-evaluate every record against v2 and score how
 * many projected the PRD-expected verdict transition. Uses the REAL `bestLocatorMatches` reattach.
 */
export function runRefactorSurvival(opts: { perCase: number }): RefactorSurvivalResult {
  const n = opts.perCase;
  const v1nodes: Node[] = [];
  const v1texts = new Map<string, string>();
  const records: MemoryRecord[] = [];
  for (let i = 0; i < n * 4; i++) {
    const mod = `surv${i}`;
    const file = `src/${mod}.ts`;
    const id = `sym:${file}#${mod}Step@L12`;
    const body = SURVIVAL_BODY[i % SURVIVAL_BODY.length]!;
    v1nodes.push(
      benchNode({
        id,
        kind: 'symbol',
        qualifiedName: `${mod}Step`,
        name: `${mod}Step`,
        file,
        hash: benchHash('v1'),
        span: { start: 12, end: 16 },
      }),
    );
    v1texts.set(id, `function ${mod}Step() {\n  ${body}\n}`);
    records.push(
      buildBenchRecord({
        subject: id,
        claim: body,
        appliesTo: [id],
        evidence: [quoteEvidence(id, body, benchHash('v1'))],
      }),
    );
  }
  const soul = new FakeSoulPort(v1nodes, v1texts);
  const ctx = { soul };
  const evaluator = new MemoryEvaluator();

  // Baseline sanity: every record must be eligible against v1, else the transition table is noise.
  const evalV1 = (r: MemoryRecord) => effectiveVerdicts(r, [], evaluator.evaluate(r, ctx));
  const baselineOk = records.filter((r) => isRecallEligible(evalV1(r))).length;

  // Evolve to v2 per case (i % 4).
  const v2nodes: Node[] = [];
  const v2texts = new Map<string, string>();
  for (let i = 0; i < n * 4; i++) {
    const mod = `surv${i}`;
    const oldId = `sym:src/${mod}.ts#${mod}Step@L12`;
    const body = SURVIVAL_BODY[i % SURVIVAL_BODY.length]!;
    const c = i % 4;
    if (c === 2) {
      // moved: the OLD id is gone; the symbol reappears under a NEW path with the same qualified
      // name + the same body (quote still grounds) → reattach by name, exactly one candidate
      // (kind 30 + qname 30 = 60 ≥ threshold 50; every other node has a different qualified name).
      const newId = `sym:src/v2/${mod}.ts#${mod}Step@L40`;
      v2nodes.push(
        benchNode({
          id: newId,
          kind: 'symbol',
          qualifiedName: `${mod}Step`,
          name: `${mod}Step`,
          file: `src/v2/${mod}.ts`,
          hash: benchHash('v1'),
          span: { start: 40, end: 44 },
        }),
      );
      v2texts.set(newId, `function ${mod}Step() {\n  ${body}\n}`);
    } else if (c === 3) {
      // quote gone: same id, new hash, body reworded so the quote no longer appears
      v2nodes.push(
        benchNode({
          id: oldId,
          kind: 'symbol',
          qualifiedName: `${mod}Step`,
          name: `${mod}Step`,
          file: `src/${mod}.ts`,
          hash: benchHash('v3'),
          span: { start: 12, end: 18 },
        }),
      );
      v2texts.set(oldId, `function ${mod}Step() {\n  return rewroteEverythingFromScratch();\n}`);
    } else if (c === 1) {
      // content drift: same id, new hash, quote still present → hash-drift, still eligible
      v2nodes.push(
        benchNode({
          id: oldId,
          kind: 'symbol',
          qualifiedName: `${mod}Step`,
          name: `${mod}Step`,
          file: `src/${mod}.ts`,
          hash: benchHash('v2'),
          span: { start: 12, end: 18 },
        }),
      );
      v2texts.set(oldId, `function ${mod}Step(attempts) {\n  ${body}  // now parameterized\n}`);
    } else {
      // kept: id, hash, text unchanged
      v2nodes.push(
        benchNode({
          id: oldId,
          kind: 'symbol',
          qualifiedName: `${mod}Step`,
          name: `${mod}Step`,
          file: `src/${mod}.ts`,
          hash: benchHash('v1'),
          span: { start: 12, end: 16 },
        }),
      );
      v2texts.set(oldId, `function ${mod}Step() {\n  ${body}\n}`);
    }
  }
  soul.setNodes(v2nodes, v2texts);

  // Expected transitions (the PRD freshness table):
  //   kept → valid/current/eligible · drift → degraded/current/eligible
  //   moved → degraded(current, reattached)/eligible
  //   quote-gone (node alive, quote dead) → invalid/needs-review/DROPPED from eligibility
  const EXPECTED: RefactorExpectation[] = [
    { evidence: 'valid', applicability: 'current', eligible: true },
    { evidence: 'degraded', applicability: 'current', eligible: true },
    { evidence: 'degraded', applicability: 'current', eligible: true },
    { evidence: 'invalid', applicability: 'needs-review', eligible: false },
  ];
  const cases: RefactorCase[] = [
    { name: 'kept', records: n, expected: EXPECTED[0]!, actualMatched: 0 },
    { name: 'drift', records: n, expected: EXPECTED[1]!, actualMatched: 0 },
    { name: 'moved', records: n, expected: EXPECTED[2]!, actualMatched: 0 },
    { name: 'quote-gone', records: n, expected: EXPECTED[3]!, actualMatched: 0 },
  ];
  let matched = 0;
  for (let i = 0; i < records.length; i++) {
    const v = evalV1(records[i]!);
    const exp = EXPECTED[i % 4]!;
    const row = cases[i % 4]!;
    if (
      v.evidence === exp.evidence &&
      v.applicability === exp.applicability &&
      isRecallEligible(v) === exp.eligible
    ) {
      row.actualMatched += 1;
      matched += 1;
    }
  }
  const result: RefactorSurvivalResult = {
    cases,
    stalenessPrecision: records.length > 0 ? matched / records.length : 0,
  };
  if (baselineOk !== records.length) {
    result.cases.push({
      name: 'BASELINE-DRIFT (pre-evolution ineligibility — corpus bug, not engine behaviour)',
      records: records.length - baselineOk,
      expected: EXPECTED[0]!,
      actualMatched: 0,
    });
  }
  return result;
}

// ─── (c) cross-writer ────────────────────────────────────────────────────────

export function runCrossWriter(
  stores: RecallStores,
  opts: { writers: number; throughputWrites: number },
): CrossWriterResult {
  const local = stores.local!;
  // Same actor re-observing the identical claim: content-addressed ids collapse every duplicate.
  const shared = buildBenchRecord({
    subject: 'sym:src/shared.ts#sharedStep@L1',
    claim: 'the shared claim is that shards are flushed before the release',
    evidence: [],
  });
  for (let w = 0; w < opts.writers; w++) local.upsertEntry('active', shared);
  const distinctRows = local
    .readCollection('active')
    .entries.filter((e) => (e as MemoryRecord).id === shared.id).length;
  const observations = opts.writers;
  // duplicates collapsed out of the writers−1 redundant observations
  const dedupeRate = observations > 1 ? (observations - distinctRows) / (observations - 1) : 1;

  // Write throughput: N distinct single-entry upserts (each acquires + releases the store lock).
  const t0 = performance.now();
  for (let i = 0; i < opts.throughputWrites; i++) {
    local.upsertEntry(
      'active',
      buildBenchRecord({
        subject: `sym:src/tp${i}.ts#tpStep@L1`,
        claim: `throughput probe record number ${i} over the locked write path`,
      }),
    );
  }
  const writeSeconds = (performance.now() - t0) / 1000;
  const writesPerSecond = writeSeconds > 0 ? opts.throughputWrites / writeSeconds : 0;

  // Conflict surfacing: two DIFFERENT actors, same subject + scope, different claims → 1 group.
  const a = buildBenchRecord({
    subject: 'sym:src/conflict.ts#cfg@L1',
    claim: 'the config loader caches parsed values',
    actor: 'writer-A',
  });
  const b = buildBenchRecord({
    subject: 'sym:src/conflict.ts#cfg@L1',
    claim: 'the config loader re-reads on each access',
    actor: 'writer-B',
  });
  local.upsertEntry('active', a);
  local.upsertEntry('active', b);
  const proj = recallProjection(gatherRecall(stores), {});
  return {
    writers: opts.writers + 2,
    observations,
    distinctRows,
    dedupeRate,
    conflictsExpected: 1,
    conflictsSurfaced: proj.conflicts.length,
    writesPerSecond,
  };
}

// ─── (d) trust gradient ──────────────────────────────────────────────────────

const BENCH_TS = '2026-06-01T00:00:00.000Z';

export function runTrustGradient(stores: RecallStores): TrustGradientResult {
  const local = stores.local!;
  const team = stores.team!;
  const violations: string[] = [];
  let checks = 0;
  const expect = (ok: boolean, label: string) => {
    checks += 1;
    if (!ok) violations.push(label);
  };

  // 1. A candidate never enters recall (candidates are not even gathered → separate overlay only).
  local.upsertEntry(
    'candidates',
    buildBenchCandidate({
      subject: 'sym:src/tg1.ts#tgStep@L1',
      claim: 'a pending claim must never enter the trusted recall group',
      evidence: [],
    }),
  );
  const projCand = recallProjection(gatherRecall(stores), {
    query: 'pending claim trusted recall',
  });
  expect(projCand.memories.length === 0, 'candidate entered recall');

  // 2. A contradicted signal WITHOUT admissible counter-evidence never quarantines (review only).
  const anchored = buildBenchRecord({
    subject: 'sym:src/tg2.ts#tgStep@L1',
    claim: 'tg2 quotes are checked against the rehydrated span before any activation',
    evidence: [
      quoteEvidence('sym:src/tg2.ts#tgStep@L1', 'tg2 quotes are checked', benchHash('live')),
    ],
  });
  local.upsertEntry('active', anchored);
  const r1 = applyContradictedFeedback(local, {
    record: { id: anchored.id, kind: anchored.kind },
    feedback: {
      id: '',
      schemaVersion: '1',
      signal: 'contradicted',
      subject: anchored.id,
      actor: 'bench-reviewer',
      ts: BENCH_TS,
    },
    counterEvidence: [],
    now: () => BENCH_TS,
  });
  expect(
    r1.suppression.suppress !== true,
    'contradicted without counter-evidence suppressed the record',
  );

  // 3. WITH admissible+valid counter-evidence: local quarantine fires — LOCALLY ONLY (no-poison).
  //    The team store holds the SAME content id (the promotion twin); its copy must stay eligible.
  const twin = buildBenchRecord({
    subject: anchored.subject,
    claim: anchored.claim,
    appliesTo: anchored.appliesTo,
    evidence: anchored.evidence,
    trust: 'team',
  });
  expect(twin.id === anchored.id, 'content-addressed ids diverged between local + team twins');
  team.upsertEntry('records', twin);
  const validCounter: MemoryEvidence[] = [
    {
      kind: 'source-quote',
      verdict: 'valid',
      checkedAt: BENCH_TS,
      soulId: 'sym:src/tg2.ts#tgStep@L1',
      quote: 'tg2 quotes are checked',
      targetHash: benchHash('live'),
    },
  ];
  const r2 = applyContradictedFeedback(local, {
    record: { id: anchored.id, kind: anchored.kind },
    feedback: {
      id: '',
      schemaVersion: '1',
      signal: 'contradicted',
      subject: anchored.id,
      actor: 'bench-reviewer',
      ts: BENCH_TS,
    },
    counterEvidence: validCounter,
    now: () => BENCH_TS,
  });
  expect(
    'decision' in r2.suppression,
    'contradicted WITH admissible counter-evidence did not quarantine',
  );

  // no-poison: locally quarantined copy drops out; the team twin stays.
  const proj = recallProjection(gatherRecall(stores), {});
  const localCopyGone = !proj.memories.some(
    (m) => m.source === 'local' && m.record.id === anchored.id,
  );
  const teamCopyAlive = proj.memories.some((m) => m.source === 'team' && m.record.id === twin.id);
  expect(localCopyGone, 'locally quarantined record stayed recall-eligible');
  expect(teamCopyAlive, 'team copy of the same id was poisoned by the local quarantine');
  return { checks, violations };
}

// ─── (e) latency / scale ─────────────────────────────────────────────────────

const LATENCY_QUERY = 'deploy retries exponential backoff lockfile';

export function runLatency(
  stores: RecallStores,
  opts: {
    records: number;
    candidates: number;
    decisions: number;
    feedback: number;
    trials: number;
  },
): LatencyResult {
  const local = stores.local!;
  const global = stores.global!;
  const team = stores.team!;
  const nodes: Node[] = [];
  const texts = new Map<string, string>();
  const records: MemoryRecord[] = [];
  const teamRows: MemoryRecord[] = [];
  const localRows: MemoryRecord[] = [];
  const globalRows: MemoryRecord[] = [];
  for (let i = 0; i < opts.records; i++) {
    const mod = `scale${i}`;
    const id = `sym:src/${mod}.ts#${mod}Step@L7`;
    const claim = scaleClaim(i);
    // 5% orphans (anchor never existed → O(n) locator scan, then dead) · 15% drift (hash mismatch).
    const orphan = i % 20 === 0;
    const drift = !orphan && i % 7 === 0;
    const soulId = orphan ? `sym:src/gone-${mod}.ts#goneStep@L7` : id;
    const teamRow = i % 5 === 0;
    const record = buildBenchRecord({
      subject: id,
      claim,
      appliesTo: [id],
      evidence: [quoteEvidence(soulId, claim, drift ? benchHash('stale') : benchHash('live'))],
      trust: teamRow ? 'team' : 'local',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i % 1000)).toISOString(),
    });
    records.push(record);
    (teamRow ? teamRows : localRows).push(record);
    if (!orphan) {
      nodes.push(
        benchNode({
          id,
          kind: 'symbol',
          qualifiedName: `${mod}Step`,
          name: `${mod}Step`,
          file: `src/${mod}.ts`,
          hash: drift ? benchHash('moved') : benchHash('live'),
          span: { start: 7, end: 12 },
        }),
      );
      texts.set(id, claim);
    }
    // a third gather tier: sparse cross-repo records
    if (i % 11 === 0) {
      globalRows.push(buildBenchRecord({ subject: `topic:g${i}`, claim: scaleClaim(10_000 + i) }));
    }
  }
  team.upsertEntries('records', teamRows);
  local.upsertEntries('active', localRows);
  global.upsertEntries('records', globalRows);
  // 1) decisions overlay · 2) bounded feedback · 3) an untrusted candidate pool (gather ignores it).
  // Seeding uses batched upsertEntries (one lock hold per chunk — the seed is not the measured phase).
  const supersedeTargets = records.filter((_, i) => i % 3 === 0);
  const teamDecisions: MemoryDecision[] = [];
  const localDecisions: MemoryDecision[] = [];
  for (let i = 0; i < opts.decisions; i++) {
    const target = supersedeTargets[i % Math.max(1, supersedeTargets.length)];
    if (!target) break;
    const dec: MemoryDecision = {
      id: decisionId({
        kind: i % 4 === 0 ? ('quarantine' as const) : ('supersede' as const),
        subject: target.id,
        actor: 'bench',
        reason: 'bench overlay exercise',
      }),
      schemaVersion: '1',
      kind: i % 4 === 0 ? ('quarantine' as const) : ('supersede' as const),
      subject: target.id,
      actor: 'bench',
      reason: 'bench overlay exercise',
      ts: BENCH_TS,
    };
    (i % 2 === 0 ? teamDecisions : localDecisions).push(dec);
  }
  team.upsertEntries('decisions', teamDecisions);
  local.upsertEntries('decisions', localDecisions);
  const feedbackRows: MemoryFeedback[] = [];
  for (let i = 0; i < opts.feedback; i++) {
    const signal = i % 3 === 0 ? ('useful' as const) : ('unhelpful' as const);
    const subject = records[i % records.length]!.id;
    feedbackRows.push({
      id: feedbackId({ signal, subject, actor: 'bench-reviewer', context: undefined }),
      schemaVersion: '1',
      signal,
      subject,
      actor: 'bench-reviewer',
      ts: BENCH_TS,
    });
  }
  local.upsertEntries('feedback', feedbackRows);
  const candidateRows = [];
  for (let i = 0; i < opts.candidates; i++) {
    candidateRows.push(
      buildBenchCandidate({
        subject: `sym:src/pool${i}.ts#poolStep@L1`,
        claim: `an in-flight observation number ${i} that might graduate later`,
      }),
    );
  }
  local.upsertEntries('candidates', candidateRows);

  const evaluator = new MemoryEvaluator();
  const evalCtx = { soul: new FakeSoulPort(nodes, texts) };
  const gather: number[] = [];
  const ftsB: number[] = [];
  const rankC: number[] = [];
  const freshM: number[] = [];
  const total: number[] = [];
  for (let t = 0; t < opts.trials; t++) {
    const t0 = performance.now();
    const gathered = gatherRecall(stores);
    const t1 = performance.now();
    const fts = new MemoryFtsIndex(':memory:');
    fts.rebuild(gathered.records.map((g) => g.record));
    const scorer = new FtsLexicalScorer(fts);
    const t2 = performance.now();
    recallProjection(gathered, { query: LATENCY_QUERY, lexicalScorer: scorer });
    const t3 = performance.now();
    recallProjection(gathered, { query: LATENCY_QUERY, lexicalScorer: scorer, evaluator, evalCtx });
    const t4 = performance.now();
    fts.close();
    gather.push(t1 - t0);
    ftsB.push(t2 - t1);
    rankC.push(t3 - t2);
    freshM.push(t4 - t3);
    total.push(t4 - t0);
  }
  const block = (xs: number[]) => ({ ...p50p95(xs), min: Math.min(...(xs.length ? xs : [0])) });
  return {
    records: opts.records,
    candidates: opts.candidates,
    decisions: opts.decisions,
    feedback: opts.feedback,
    soulNodes: nodes.length,
    trials: opts.trials,
    gatherMs: block(gather),
    ftsRebuildMs: block(ftsB),
    rankColdMs: block(rankC),
    freshEvalMs: block(freshM),
    totalMs: block(total),
  };
}
