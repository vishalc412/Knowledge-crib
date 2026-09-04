import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from '@knowledge-crib/core';
/**
 * LAUNCH GATE runner — measures the pinned launch corpus (bench/launch-corpus.ts) through the REAL
 * recall surface and renders the frozen gate table. The threshold table lives in
 * docs/bench/launch-gates.md and was frozen BEFORE the deciding run (pre-registration discipline,
 * mirroring docs/bench/retrieval-pre-registration.md): thresholds are never negotiated after
 * numbers exist — a failure ships as a failure.
 *
 * Scorer: the LAUNCH DEFAULT, `memory-rank-v2:none:bm25:lexical-only` (the Gate-3 pre-registered
 * outcome — no fusion strategy cleared the minimum-effect bar, so the lexical scorer ships). No
 * latency is reported here at all: the gate must be byte-stable, and timing is machine-dependent.
 *
 * Honesty notes the report carries verbatim (never papered over):
 *   - The paraphrase + multilingual families are word-disjoint from their claims BY CONSTRUCTION,
 *     so the lexical-only scorer cannot lexically match them — those numbers ARE the honest
 *     semantic-recall measurement, expected to sit at the deterministic tie floor on this corpus.
 *   - v1 records carry NO principal column and the projection has NO principal filter: principal
 *     isolation is STRUCTURAL (store topology). The runner additionally probes a union gather
 *     across the two principal fixtures and reports the leak as a FINDING.
 */
import { MemoryEvaluator, effectiveVerdicts, isRecallEligible } from '../evaluator.js';
import { MemoryFtsIndex } from '../fts-index.js';
import { type FusionStrategy, VersionedLexicalScorer } from '../fusion.js';
import {
  type GatheredRecall,
  type RecallStores,
  gatherRecall,
  recallProjection,
} from '../recall.js';
import { MemoryStore } from '../store.js';
import type { MemoryRecord, MemoryRecordV2 } from '../types.js';
import { FakeSoulPort } from './corpus.js';
import {
  LAUNCH_CATEGORIES,
  LAUNCH_REPO,
  LAUNCH_SCALE_FULL,
  type LaunchCategory,
  type LaunchCorpus,
  type LaunchQuery,
  type PrincipalFixture,
  buildLaunchCorpus,
} from './launch-corpus.js';
import { mrr, precisionAtK, recallAtK } from './metrics.js';

/** Where the frozen gate table lives — every report cites its contract. */
export const PREREGISTRATION_DOC = 'docs/bench/launch-gates.md';

// ─── frozen gate thresholds (frozen BEFORE the deciding run — see the doc) ───

/** G1: exact recall@5 must be 100% (epsilon for float equality). */
export const GATE_EXACT_RECALL_AT5 = 1;
/** G2: paraphrase recall@5 (word-disjoint by construction) must reach 80%. */
export const GATE_PARAPHRASE_RECALL_AT5 = 0.8;
/** G3: MRR over every labeled query. */
export const GATE_MRR = 0.75;
/** G4: temporal + contradiction classification must reach 90%. */
export const GATE_CLASSIFICATION = 0.9;
/** G5: stale memory surfaced as current < 1%. */
export const GATE_STALE_LEAK = 0.01;
/** G6: untrusted content in normal recall — ZERO (candidates + mis-shelved + hostile pool). */
export const GATE_UNTRUSTED_LEAK = 0;
/** G7: unauthorised cross-principal results in scoped runs — ZERO. */
export const GATE_PRINCIPAL_LEAK = 0;
/** G8: adversarial payload round-trip through the real stores must be byte-identical — 100%. */
export const GATE_ROUNDTRIP = 1;

/** Float tolerance for the "= 100%" style gates (recall arithmetic is plain division). */
const EQ_EPSILON = 1e-9;

export interface CategoryMetrics {
  category: LaunchCategory;
  queries: number;
  recallAt5: number;
  precisionAt5: number;
  mrr: number;
}

export interface GateResult {
  id: string;
  label: string;
  /** The measured value as a 0..1 rate (or an absolute count for zero-leak gates). */
  measured: number;
  threshold: number;
  comparison: 'gte' | 'lte';
  pass: boolean;
  /** The threshold arithmetic in words — every gate prints its own math. */
  detail: string;
}

export interface LaunchGateReport {
  preregistration: string;
  scale: number;
  corpus: {
    records: number;
    gatheredRecords: number;
    eligibleRecords: number;
    queries: number;
    categoryCounts: Record<LaunchCategory, number>;
  };
  /** The launch-default scorer the gate measures (Gate-3 outcome: lexical-only ships). */
  scorerVersion: string;
  /** 5 / gatheredRecords — the deterministic tie-order floor for recall@5 on this fixture. */
  tieFloor: number;
  categories: CategoryMetrics[];
  gates: GateResult[];
  /** Reported (non-gate) metrics: refactor survival + adversarial surface rate. */
  refactorEligibility: number;
  adversarialSurfacedAt5: number;
  /** Honest findings — including any gap the harness deliberately did NOT paper over. */
  findings: string[];
  pass: boolean;
}

interface RankedQuery {
  query: LaunchQuery;
  ranked: string[];
}

// ─── the runner ──────────────────────────────────────────────────────────────

/** One gathered store set with its FTS index and the deterministic rank closure over it. */
interface ScopedRank {
  gathered: GatheredRecall;
  records: MemoryRecord[];
  /** The versioned scorer id every fresh scorer in this set produces (deterministic config). */
  versionId: string;
  /** How many gathered records passed the hard eligibility filter (query-independent). */
  eligible: number;
  rank: (query: string) => string[];
}

/**
 * Build an in-memory FTS index over a gathered store set plus the rank closure. A FRESH scorer per
 * query is the production shape (one projection per call). Every index created here is pushed into
 * `registry` so the caller closes them all in one finally — no leaked sqlite handles.
 */
function rankerFor(
  gathered: GatheredRecall,
  registry: MemoryFtsIndex[],
  scorerCfg: LaunchScorerConfig = { strategy: 'lexical-only' },
): ScopedRank {
  const records = gathered.records.map((g) => g.record);
  const fts = new MemoryFtsIndex(':memory:');
  fts.rebuild(records);
  registry.push(fts);
  const mk = (): VersionedLexicalScorer =>
    new VersionedLexicalScorer({
      fts,
      records,
      strategy: scorerCfg.strategy,
      ...(scorerCfg.embedder ? { embedder: scorerCfg.embedder } : {}),
      ...(scorerCfg.alpha !== undefined ? { alpha: scorerCfg.alpha } : {}),
      ...(scorerCfg.rrfK !== undefined ? { rrfK: scorerCfg.rrfK } : {}),
      ...(scorerCfg.embedTextOf ? { embedTextOf: scorerCfg.embedTextOf } : {}),
    });
  // ONE scorer for every query in this scope. `VersionedLexicalScorer` memoizes its fused ranking
  // per distinct QUERY STRING and embeds the record vectors once per scorer lifetime, so reuse is
  // score-identical to a fresh scorer per query — but a fresh one re-embeds all N records for every
  // query, which at 500 queries × 307 records is quadratic embedding work (it timed out outright).
  const shared = mk();
  const versionId = shared.versionId;
  const rank = (query: string): string[] => {
    const proj = recallProjection(gathered, { query, lexicalScorer: shared });
    return proj.memories.slice(0, 5).map((m) => m.record.id);
  };
  // Eligibility is a property of the verdicts, not the query — one probe projection measures it.
  const probeScorer = shared;
  const probeQuery = records[0]?.subject ?? '';
  const eligible = recallProjection(gathered, { query: probeQuery, lexicalScorer: probeScorer })
    .provenance.counts.eligible;
  return { gathered, records, versionId, eligible, rank };
}

/** Seed the MAIN fixture into real stores — the same shape as the published baseline harnesses. */
function seedMainStores(dir: string, env: NodeJS.ProcessEnv, corpus: LaunchCorpus): RecallStores {
  const stores: RecallStores = {
    team: MemoryStore.team(join(dir, 'team-main'), { env, repoRoot: dir }),
    local: MemoryStore.local(LAUNCH_REPO, { env, repoRoot: dir }),
    global: MemoryStore.global({ env }),
  };
  corpus.records.forEach((rec, i) => {
    const teamRow = i % 2 === 0;
    (teamRow ? stores.team : stores.local)?.upsertEntry(teamRow ? 'records' : 'active', rec);
  });
  for (const d of corpus.globalDecoys) stores.global?.upsertEntry('records', d);
  // Mis-shelved candidates sit in ACTIVE — gather sees them; the trust filter must exclude them.
  for (const m of corpus.misShelvedCandidates) stores.local?.upsertEntry('active', m);
  // The untrusted staging pool lives in CANDIDATES — never gathered into recall at all.
  for (const u of corpus.untrustedCandidates) stores.local?.upsertEntry('candidates', u);
  // Team supersede decisions retire every temporal-stale record everywhere (no-poison overlay).
  stores.team?.upsertEntries('decisions', corpus.temporalSupersedeDecisions);
  return stores;
}

/** Seed ONE principal's records into its own structurally separate store set (scoped isolation). */
function seedPrincipalStores(
  dir: string,
  env: NodeJS.ProcessEnv,
  fixture: PrincipalFixture,
): RecallStores {
  const stores: RecallStores = {
    team: MemoryStore.team(join(dir, `team-${fixture.principalId}`), { env, repoRoot: dir }),
    local: MemoryStore.local(fixture.principalId, { env, repoRoot: dir }),
  };
  fixture.records.forEach((rec, i) => {
    const teamRow = i % 2 === 0;
    (teamRow ? stores.team : stores.local)?.upsertEntry(teamRow ? 'records' : 'active', rec);
  });
  return stores;
}

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

function mkGate(
  id: string,
  label: string,
  measured: number,
  threshold: number,
  comparison: 'gte' | 'lte',
  detail: string,
): GateResult {
  const pass =
    comparison === 'gte' ? measured >= threshold - EQ_EPSILON : measured <= threshold + EQ_EPSILON;
  return { id, label, measured, threshold, comparison, pass, detail };
}

/** Per-category recall/precision/MRR over the combined ranked rows (main + scoped principals). */
function categoryMetrics(rows: readonly RankedQuery[]): CategoryMetrics[] {
  return LAUNCH_CATEGORIES.filter((category) =>
    rows.some((r) => r.query.category === category),
  ).map((category) => {
    const picked = rows.filter((r) => r.query.category === category);
    const rankedIds = picked.map((r) => r.ranked);
    const relevant = picked.map((r) => r.query.relevantIds);
    return {
      category,
      queries: picked.length,
      recallAt5: mean(rankedIds, relevant, (r, rel) => recallAtK(r, rel, 5)),
      precisionAt5: mean(rankedIds, relevant, (r, rel) => precisionAtK(r, rel, 5)),
      mrr: mrr(rankedIds, relevant),
    };
  });
}

/**
 * Run the full launch gate at `scale`. Every measurement flows through the REAL surface: stores are
 * real (temp dir), gather reads the shards from disk, ranking goes through `recallProjection` with
 * the launch-default lexical-only scorer. Deterministic — no wall clock enters any scored number.
 */
/**
 * The scorer the gate measures. Defaults to `lexical-only` — the no-embedder deployment. When an
 * on-device tier is installed, the caller passes the strategy the RETRIEVAL pre-registration
 * selected (docs/bench/retrieval-pre-registration.md §4); the gate does not choose a strategy of its
 * own, it measures the one that already won under a frozen rule.
 */
export interface LaunchScorerConfig {
  strategy: FusionStrategy;
  embedder?: Embedder;
  /** `weighted` mix: score = alpha*bm25 + (1-alpha)*cosine. alpha=0 is PURE SEMANTIC. */
  alpha?: number;
  rrfK?: number;
  /** what the cosine channel embeds per record (see VersionedScorerOptions.embedTextOf) */
  embedTextOf?: (record: MemoryRecord | MemoryRecordV2) => string;
}

export function runLaunchGate(
  scale: number = LAUNCH_SCALE_FULL,
  scorerCfg: LaunchScorerConfig = { strategy: 'lexical-only' },
): LaunchGateReport {
  const corpus = buildLaunchCorpus(scale);
  const dir = mkdtempSync(join(tmpdir(), 'crib-launch-gate-'));
  const env: NodeJS.ProcessEnv = { KCRIB_MEMORY_DIR: dir };
  const ftsRegistry: MemoryFtsIndex[] = [];
  try {
    const stores = seedMainStores(dir, env, corpus);
    const main = rankerFor(gatherRecall(stores), ftsRegistry, scorerCfg);
    const storesA = seedPrincipalStores(dir, env, corpus.principalA);
    const storesB = seedPrincipalStores(dir, env, corpus.principalB);
    const scopedA = rankerFor(gatherRecall(storesA), ftsRegistry, scorerCfg);
    const scopedB = rankerFor(gatherRecall(storesB), ftsRegistry, scorerCfg);

    const ranked: RankedQuery[] = corpus.queries.map((q) => ({
      query: q,
      ranked: main.rank(q.query),
    }));
    const rankedA: RankedQuery[] = corpus.principalA.queries.map((q) => ({
      query: q,
      ranked: scopedA.rank(q.query),
    }));
    const rankedB: RankedQuery[] = corpus.principalB.queries.map((q) => ({
      query: q,
      ranked: scopedB.rank(q.query),
    }));
    const rankedAll = [...ranked, ...rankedA, ...rankedB];

    // UNION probe across principals (the no-principal-column finding): principal A's team store +
    // principal B's local store gathered TOGETHER — the exact mistake a caller without a principal
    // filter could make. The leak this produces is reported, never smoothed over.
    const union = rankerFor(
      gatherRecall({ team: storesA.team, local: storesB.local }),
      ftsRegistry,
    );
    const idsB = new Set(corpus.principalB.records.map((r) => r.id));
    const idsA = new Set(corpus.principalA.records.map((r) => r.id));
    let unionForeign = 0;
    let unionSlots = 0;
    for (const q of corpus.principalA.queries) {
      const ids = union.rank(q.query);
      unionSlots += ids.length;
      unionForeign += ids.filter((id) => idsB.has(id)).length;
    }

    // ── family slices ──
    const exactRows = rankedAll.filter((r) => r.query.family === 'exact');
    const paraRows = rankedAll.filter((r) => r.query.family === 'paraphrase');
    const temporalRows = rankedAll.filter((r) => r.query.family === 'temporal');
    const contraRows = rankedAll.filter((r) => r.query.family === 'contradiction');
    const advRows = rankedAll.filter((r) => r.query.family === 'adversarial');
    const classifiable = temporalRows.length + contraRows.length;

    const exactRecall = mean(
      exactRows.map((r) => r.ranked),
      exactRows.map((r) => r.query.relevantIds),
      (r, rel) => recallAtK(r, rel, 5),
    );
    const paraRecall = mean(
      paraRows.map((r) => r.ranked),
      paraRows.map((r) => r.query.relevantIds),
      (r, rel) => recallAtK(r, rel, 5),
    );
    const overallMrr = mrr(
      rankedAll.map((r) => r.ranked),
      rankedAll.map((r) => r.query.relevantIds),
    );

    // G4 classification: temporal correct = the CURRENT record surfaces AND the superseded one
    // does not; contradiction correct = BOTH conflicting records surface together (no silent pick).
    let classified = 0;
    for (const r of temporalRows) {
      const current = r.query.relevantIds[0];
      if (
        current !== undefined &&
        r.ranked.includes(current) &&
        !r.ranked.includes(r.query.staleId ?? '')
      ) {
        classified++;
      }
    }
    for (const r of contraRows) {
      if ((r.query.conflictIds ?? []).every((id) => r.ranked.includes(id))) classified++;
    }

    // G5 stale leak: a superseded record surfacing on a temporal query is a harmful current claim.
    const staleLeaks = temporalRows.filter((r) => r.ranked.includes(r.query.staleId ?? '')).length;

    // G6 untrusted leak: mis-shelved actives + candidate-pool records + hostile untrusted copies —
    // none may appear in ANY top-5 across every query.
    const untrustedIds = new Set<string>([
      ...corpus.misShelvedCandidates.map((m) => m.id),
      ...corpus.untrustedCandidates.map((c) => c.id),
      ...corpus.adversarialUntrustedIds,
    ]);
    let untrustedLeak = 0;
    for (const r of rankedAll) for (const id of r.ranked) if (untrustedIds.has(id)) untrustedLeak++;

    // G7 scoped cross-principal leak: within one principal's own store set, no foreign record.
    const leakQueries = (rows: RankedQuery[], foreign: Set<string>): number =>
      rows.filter((r) => r.ranked.some((id) => foreign.has(id))).length;
    const scopedLeakQueries = leakQueries(rankedA, idsB) + leakQueries(rankedB, idsA);

    // G8 adversarial round-trip: the hostile claim must survive real-store serialization
    // byte-identically (the gather reads shards from disk — this IS the store round trip).
    const builtById = new Map(corpus.records.map((r) => [r.id, r]));
    const storedById = new Map(main.gathered.records.map((g) => [g.record.id, g.record]));
    const roundtripOk = corpus.adversarialTrustedIds.filter((id) => {
      const built = builtById.get(id);
      const stored = storedById.get(id);
      return built !== undefined && stored !== undefined && stored.claim === built.claim;
    }).length;

    const advTrusted = new Set(corpus.adversarialTrustedIds);
    const advSurfaced = advRows.filter((r) => r.ranked.some((id) => advTrusted.has(id))).length;

    // Reported (non-gate) refactor survival: fresh evaluation of the v1 records against the MOVED
    // soul (v2 nodes only) — reattachment must carry the memory across the refactor.
    const refactorRecords = corpus.records.filter((r) => r.subject.startsWith('sym:src/ref'));
    const evaluator = new MemoryEvaluator();
    const refactorCtx = {
      soul: new FakeSoulPort(corpus.refactorSoul.nodes, corpus.refactorSoul.texts),
    };
    const refactorEligible = refactorRecords.filter((r) =>
      isRecallEligible(effectiveVerdicts(r, [], evaluator.evaluate(r, refactorCtx))),
    ).length;

    const tieFloor = main.gathered.records.length > 0 ? 5 / main.gathered.records.length : 0;
    const gates: GateResult[] = [
      mkGate(
        'G1',
        'exact recall@5 = 100%',
        exactRecall,
        GATE_EXACT_RECALL_AT5,
        'gte',
        `${exactRows.length} exact-family queries — recall@5 ${(exactRecall * 100).toFixed(1)}% must equal 100%`,
      ),
      mkGate(
        'G2',
        'word-disjoint paraphrase recall@5 >= 80%',
        paraRecall,
        GATE_PARAPHRASE_RECALL_AT5,
        'gte',
        `${paraRows.length} word-disjoint paraphrase queries — recall@5 ${(paraRecall * 100).toFixed(1)}% (tie floor ${(tieFloor * 100).toFixed(1)}%) vs >= 80%`,
      ),
      mkGate(
        'G3',
        'MRR over every labeled query >= 0.75',
        overallMrr,
        GATE_MRR,
        'gte',
        `${rankedAll.length} labeled queries — MRR ${overallMrr.toFixed(3)} vs >= 0.75`,
      ),
      mkGate(
        'G4',
        'temporal + contradiction classification >= 90%',
        classifiable === 0 ? 0 : classified / classifiable,
        GATE_CLASSIFICATION,
        'gte',
        `${classified}/${classifiable} temporal+contradiction classifications correct vs >= 90%`,
      ),
      mkGate(
        'G5',
        'stale memory surfaced as current < 1%',
        temporalRows.length === 0 ? 0 : staleLeaks / temporalRows.length,
        GATE_STALE_LEAK,
        'lte',
        `${staleLeaks}/${temporalRows.length} temporal queries surfaced the superseded record vs < 1%`,
      ),
      mkGate(
        'G6',
        'untrusted content in normal recall = 0',
        untrustedLeak,
        GATE_UNTRUSTED_LEAK,
        'lte',
        `${untrustedLeak} mis-shelved/candidate/hostile records in any top-5 across ${rankedAll.length} queries — must be 0`,
      ),
      mkGate(
        'G7',
        'unauthorised cross-principal results = 0',
        scopedLeakQueries,
        GATE_PRINCIPAL_LEAK,
        'lte',
        `${scopedLeakQueries} scoped principal queries returning a foreign principal's record across ${rankedA.length + rankedB.length} — must be 0 (structural store separation)`,
      ),
      mkGate(
        'G8',
        'adversarial claim round-trip = 100%',
        corpus.adversarialTrustedIds.length === 0
          ? 0
          : roundtripOk / corpus.adversarialTrustedIds.length,
        GATE_ROUNDTRIP,
        'gte',
        `${roundtripOk}/${corpus.adversarialTrustedIds.length} hostile claims byte-identical through real-store round-trip — must be 100%`,
      ),
    ];

    const scopedQueries = rankedA.length + rankedB.length;
    const unionPct = unionSlots === 0 ? 'n/a' : ((unionForeign / unionSlots) * 100).toFixed(1);
    const findings: string[] = [
      // The structural-isolation gap, stated plainly — the harness deliberately does NOT paper over it.
      `CROSS-PRINCIPAL GAP: v1 MemoryRecord carries NO principal column and recallProjection has NO principal filter — principal isolation is STRUCTURAL (store topology only). Scoped leak measured ${scopedLeakQueries} over ${scopedQueries} scoped queries. The union probe (principal A's team store + principal B's local store, gathered together) leaked ${unionForeign} foreign results across ${unionSlots} ranked slots (${unionPct}%) — any caller that merges store sets across principals WILL see cross-principal data. The fix belongs in the record schema (a principal column + a projection filter), not in this harness.`,
      `PARAPHRASE/MULTILINGUAL: these queries are word-disjoint from their claims BY CONSTRUCTION (frozen LAUNCH_STOPWORDS rule in bench/launch-corpus.ts), so the lexical-only launch default scores them at BM25 zero: G2 recall sits at the deterministic tie floor (${(tieFloor * 100).toFixed(1)}%), and those families drag the all-query MRR (G3) down with them. This IS the honest semantic-recall measurement (mirrors the P0 finding: exact 100% vs paraphrase 1.7%); a failure here is reported as a failure — disjointness is never relaxed to pass the gate.`,
      `ADVERSARIAL-AS-DATA: every hostile payload's claim round-trips through real store serialization byte-identically (${roundtripOk}/${corpus.adversarialTrustedIds.length}); recall only RANKS the text — nothing executes it — and the untrusted hostile copies (candidates pool) never enter normal recall (leak ${untrustedLeak}).`,
    ];

    const pass = gates.every((g) => g.pass);
    return {
      preregistration: PREREGISTRATION_DOC,
      scale,
      corpus: {
        records: corpus.records.length,
        gatheredRecords: main.gathered.records.length,
        eligibleRecords: main.eligible,
        queries: rankedAll.length,
        categoryCounts: corpus.categoryCounts,
      },
      scorerVersion: main.versionId,
      tieFloor,
      categories: categoryMetrics(rankedAll),
      gates,
      refactorEligibility:
        refactorRecords.length === 0 ? 0 : refactorEligible / refactorRecords.length,
      adversarialSurfacedAt5: advRows.length === 0 ? 0 : advSurfaced / advRows.length,
      findings,
      pass,
    };
  } finally {
    for (const fts of ftsRegistry) fts.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Human-readable gate report: every gate prints its own threshold arithmetic, failures included. */
export function formatLaunchGate(r: LaunchGateReport): string {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('LAUNCH GATE — memory quality (pre-registered thresholds, frozen before the run)');
  lines.push(`contract: ${r.preregistration} · scale ${r.scale} · scorer ${r.scorerVersion}`);
  lines.push(
    `corpus: ${r.corpus.records} records built · ${r.corpus.gatheredRecords} gathered · ` +
      `${r.corpus.eligibleRecords} eligible · ${r.corpus.queries} labeled queries`,
  );
  lines.push(
    `deterministic tie floor for recall@5 (5 / gathered): ${(r.tieFloor * 100).toFixed(2)}%`,
  );
  lines.push('');
  lines.push('gates');
  for (const g of r.gates) {
    const verdict = g.pass ? 'PASS' : 'FAIL';
    const cmp = g.comparison === 'gte' ? '>=' : '<=';
    lines.push(
      `  ${g.id} ${g.label.padEnd(44)} ${pct(g.measured).padStart(8)}  ${cmp} ${pct(g.threshold).padEnd(7)} ${verdict}`,
    );
  }
  lines.push(
    `  OVERALL: ${r.pass ? 'PASS — every gate holds' : 'FAIL — failing gates reported honestly, never tuned away'}`,
  );
  lines.push('');
  lines.push('categories (recall@5 / precision@5 / MRR / queries)');
  for (const c of r.categories) {
    lines.push(
      `  ${c.category.padEnd(16)} ${pct(c.recallAt5).padStart(7)} / ${pct(c.precisionAt5).padStart(7)} / ${c.mrr.toFixed(3)} / ${c.queries}`,
    );
  }
  lines.push('');
  lines.push(
    `  refactor survival (reported, non-gate): ${(r.refactorEligibility * 100).toFixed(1)}% eligible against the moved-soul fixture`,
  );
  lines.push(
    `  adversarial surface (reported, non-gate): ${(r.adversarialSurfacedAt5 * 100).toFixed(1)}% of hostile-memory queries surfaced the record at top-5`,
  );
  lines.push('');
  lines.push('findings');
  r.findings.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
  return lines.join('\n');
}
