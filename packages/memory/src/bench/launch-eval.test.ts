/**
 * The launch gate's own gate. Three jobs, mirroring the retrieval-eval test discipline:
 *
 *   1. the corpus construction invariants `bench/launch-corpus.ts` names in its header: pinned
 *      composition (500 labeled queries across all ten categories at full scale), resolvable
 *      labels, byte-determinism, and the FROZEN word-disjointness invariant (zero shared content
 *      tokens between a paraphrase/multilingual query and its claim — including FTS prefix
 *      collisions — so the semantic gap the runner measures is real, not a tokenization artifact);
 *
 *   2. the structural guarantees the runner must hold EVERY run: zero untrusted content in
 *      normal recall, zero scoped cross-principal results, byte-identical adversarial round-trip,
 *      zero stale leakage, classification at or above its floor;
 *
 *   3. the honesty contract: the cross-principal finding must report a REAL union-probe leak (the
 *      no-principal-column gap is documented, never papered over) and the paraphrase finding must
 *      carry the word-disjointness disclosure.
 */
import { describe, expect, it } from 'vitest';
import {
  LAUNCH_CATEGORIES,
  LAUNCH_SCALE_CI,
  LAUNCH_SCALE_FULL,
  type LaunchCategory,
  type LaunchCorpus,
  buildLaunchCorpus,
  launchContentTokens,
  launchTokens,
} from './launch-corpus.js';
import { PREREGISTRATION_DOC, formatLaunchGate, runLaunchGate } from './launch-eval.js';

/** The pinned full-scale composition — the docs/bench/launch-gates.md table must match this. */
const FULL_COMPOSITION: Record<LaunchCategory, number> = {
  decisions: 90,
  preferences: 60,
  procedures: 60,
  failures: 60,
  temporal: 36,
  refactors: 36,
  multilingual: 88,
  contradictions: 20,
  adversarial: 20,
  'cross-principal': 30,
};

describe('launch corpus construction', () => {
  it('pins the full corpus at 500 labeled queries across all ten categories', () => {
    const corpus = buildLaunchCorpus(LAUNCH_SCALE_FULL);
    expect(
      corpus.queries.length + corpus.principalA.queries.length + corpus.principalB.queries.length,
    ).toBe(500);
    for (const category of LAUNCH_CATEGORIES) {
      expect(FULL_COMPOSITION[category]).toBeGreaterThan(0);
      expect(corpus.categoryCounts[category]).toBe(FULL_COMPOSITION[category]);
    }
  });

  it('labels every query with record ids that resolve in the fixture', () => {
    const corpus = buildLaunchCorpus(LAUNCH_SCALE_FULL);
    const ids = new Set<string>(
      [...corpus.records, ...corpus.principalA.records, ...corpus.principalB.records].map(
        (r) => r.id,
      ),
    );
    for (const q of [
      ...corpus.queries,
      ...corpus.principalA.queries,
      ...corpus.principalB.queries,
    ]) {
      for (const id of q.relevantIds)
        expect(ids.has(id), `relevant ${id} for "${q.query}"`).toBe(true);
      if (q.staleId !== undefined) expect(ids.has(q.staleId), `stale ${q.staleId}`).toBe(true);
      for (const id of q.conflictIds ?? []) expect(ids.has(id), `conflict ${id}`).toBe(true);
    }
  });

  it('is byte-deterministic across builds — no wall clock anywhere in the fixture', () => {
    const strip = (c: LaunchCorpus): string =>
      JSON.stringify({
        ...c,
        // Maps serialize to {} in JSON — freeze them to entry lists so drift would still surface.
        refactorSoul: { nodes: c.refactorSoul.nodes, texts: [...c.refactorSoul.texts.entries()] },
      });
    expect(strip(buildLaunchCorpus(LAUNCH_SCALE_CI))).toBe(
      strip(buildLaunchCorpus(LAUNCH_SCALE_CI)),
    );
  });

  it('keeps the frozen disjointness invariant: paraphrase/multilingual queries share zero content tokens with their claim, with no FTS prefix collisions', () => {
    const corpus = buildLaunchCorpus(LAUNCH_SCALE_FULL);
    const byId = new Map(
      [...corpus.records, ...corpus.principalA.records, ...corpus.principalB.records].map((r) => [
        r.id,
        r,
      ]),
    );
    const problems: string[] = [];
    for (const q of [
      ...corpus.queries,
      ...corpus.principalA.queries,
      ...corpus.principalB.queries,
    ]) {
      if (q.family !== 'paraphrase' && q.family !== 'multilingual') continue;
      const rec = byId.get(q.relevantIds[0] ?? '');
      if (!rec) continue;
      const claimTokens = launchTokens(rec.claim);
      for (const qt of launchContentTokens(q.query)) {
        for (const ct of claimTokens) {
          if (ct === qt) problems.push(`"${q.query}" shares token "${qt}" with its claim`);
          else if (ct.startsWith(qt)) {
            problems.push(`"${q.query}" token "${qt}" is an FTS prefix of claim token "${ct}"`);
          }
        }
      }
      // The synthetic module name must never leak into a hand-written query (it would short-circuit
      // BM25 with a subject token instead of measuring the paraphrase).
      if (/(^|[^a-z0-9])mod\d+([^a-z0-9]|$)/.test(q.query))
        problems.push(`mod token leak: ${q.query}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('launch gate runner (CI scale)', () => {
  // The full 500-query run is 0.4s; CI runs the 0.4 scale so the suite stays well inside budget.
  const report = runLaunchGate(LAUNCH_SCALE_CI);
  const gate = (id: string) => report.gates.find((g) => g.id === id);

  it('cites its pre-registration contract and measures a real query volume', () => {
    expect(report.preregistration).toBe(PREREGISTRATION_DOC);
    expect(report.scale).toBe(LAUNCH_SCALE_CI);
    expect(report.corpus.queries).toBeGreaterThan(100);
    expect(report.scorerVersion).toBe('memory-rank-v2:none:bm25:lexical-only');
  });

  it('holds every structural gate: exact recall, classification, stale/untrusted/principal leaks, adversarial round-trip', () => {
    expect(gate('G1')?.pass).toBe(true);
    expect(gate('G1')?.measured).toBe(1);
    expect(gate('G4')?.pass).toBe(true);
    expect(gate('G5')?.measured).toBe(0);
    expect(gate('G6')?.measured).toBe(0);
    expect(gate('G7')?.measured).toBe(0);
    expect(gate('G8')?.measured).toBe(1);
    // The frozen semantic thresholds stay frozen — the runner reports against them unmodified.
    expect(gate('G2')?.threshold).toBe(0.8);
  });

  it('reports refactor survival and adversarial surface above their floors', () => {
    expect(report.refactorEligibility).toBeGreaterThanOrEqual(0.9);
    expect(report.adversarialSurfacedAt5).toBe(1);
  });

  it('derives the tie floor from the gathered record count and ranks the eligible set only', () => {
    expect(report.tieFloor).toBeCloseTo(5 / report.corpus.gatheredRecords, 10);
    expect(report.corpus.eligibleRecords).toBeLessThanOrEqual(report.corpus.gatheredRecords);
    for (const category of LAUNCH_CATEGORIES) {
      const row = report.categories.find((c) => c.category === category);
      expect(row, `category ${category} missing`).toBeDefined();
      expect(row?.queries).toBeGreaterThan(0);
    }
  });

  it('reports the cross-principal gap honestly: scoped leak zero, union-probe leak real and disclosed', () => {
    expect(report.findings[0]?.startsWith('CROSS-PRINCIPAL GAP')).toBe(true);
    // The union probe MUST have leaked something (> 0) — a zero here would mean the probe was
    // defanged, i.e. the gap was papered over rather than reported.
    expect(report.findings.join('\n')).toMatch(/leaked [1-9]\d* foreign results/);
  });

  it('carries the word-disjointness honesty note on the paraphrase family', () => {
    expect(
      report.findings.some((f) => f.includes('word-disjoint') && f.includes('never relaxed')),
    ).toBe(true);
  });

  it('renders a gate table naming every gate and the findings verbatim', () => {
    const text = formatLaunchGate(report);
    for (const g of report.gates) expect(text).toContain(g.id);
    expect(text).toContain('OVERALL');
    expect(text).toContain('CROSS-PRINCIPAL GAP');
    expect(text).toContain(report.preregistration);
  });

  it('is byte-deterministic across runs — no wall clock enters scored output', () => {
    expect(JSON.stringify(runLaunchGate(0.2))).toBe(JSON.stringify(runLaunchGate(0.2)));
  });
});
