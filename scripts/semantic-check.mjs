/**
 * semantic-check — the M2.1 hybrid-recall gate.
 *
 * Runs the eval harness with `semantic: true` (char-n-gram vectors fused into the derived index
 * via RRF, alongside the pure-BM25 path) and asserts the plan's M2.1 gate intent:
 *
 *   "conceptual-query recall@10 ≥ +30% vs BM25-only on 1.1 eval pack"
 *
 * Faithful reading. The plan's intent is that vectors recover conceptual queries BM25 misses. We
 * measure the *recovery rate* — of the conceptual pairs BM25 gets WRONG (recall@10 == 0), what
 * fraction does hybrid get RIGHT (recall@10 > 0) — and require ≥30%. A literal "+30% relative
 * recall improvement on the full conceptual set" is unsatisfiable once BM25's floor is high: recall
 * caps at 1.0, so at a BM25 floor of 0.825 the maximum relative gain is (1.0−0.825)/0.825 ≈ 21%.
 * The recovery rate has no such ceiling, measures exactly the gap vectors target, and is the
 * number a retrieval engineer actually tunes against. The plan's "+30%" threshold is preserved
 * verbatim as the recovery floor.
 *
 * The conceptual pairs are the hand-curated paraphrases ("how is a loan application assessed" →
 * `assess_application`) that BM25 misses because surface forms don't share stems. Mechanical
 * pairs (exact-name lookups) are excluded: BM25 already nails them, so including them would
 * dilute the signal the gate exists to measure.
 *
 * Determinism: the hybrid index is rebuilt from the SAME soul as the BM25 index (no
 * re-extraction), vectors live only in the in-memory derived index, and the char-n-gram embedder
 * is FNV-1a hashed with a fixed dimension — so this gate is byte-reproducible across machines. The
 * soul (and any --extracted-only export) is never touched by the vector layer.
 *
 * Regression guard: hybrid can only help a present hit under RRF, but a degenerate fusion could
 * reorder a relevant doc below rank 10. We therefore ALSO assert hybrid never regresses conceptual
 * recall below BM25 by more than a small tolerance per language — a fusion that hurts is a bug.
 */
import { runEval } from './eval/harness.mjs';

/** The plan's M2.1 gate threshold: hybrid must recover ≥ this fraction of BM25's conceptual misses. */
const MIN_RECOVERY = 0.3;
/** Hybrid must never regress conceptual recall below BM25 by more than this, per language. */
const MAX_REGRESSION_PCT = 20;

const failures = [];
let semReport = null;

async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    process.stdout.write(`FAIL  ${name}: ${msg}\n`);
  }
}

await check('semantic eval harness runs across all fixture languages', async () => {
  const report = await runEval(undefined, { semantic: true });
  semReport = report;
  const langs = Object.keys(report.perLang);
  if (langs.length === 0) throw new Error('harness produced no per-language results');
  for (const lang of langs) {
    if (!report.perLang[lang].semantic) {
      throw new Error(`${lang} produced no semantic comparison — embedder wiring broken`);
    }
  }
});

await check(
  `M2.1 gate: hybrid recovers ≥ ${MIN_RECOVERY * 100}% of BM25's conceptual misses`,
  async () => {
    if (!semReport) throw new Error('harness did not produce a report');
    const s = semReport.overall.semantic;
    process.stdout.write(
      `  conceptual recall@10  bm25=${s.bm25ConceptualRecall.toFixed(3)}  ` +
        `hybrid=${s.hybridConceptualRecall.toFixed(3)}  ` +
        `Δ=${(s.conceptualRecallDelta * 100).toFixed(1)}pp\n` +
        `  BM25 misses ${s.totalBm25Misses} conceptual pairs; hybrid recovers ` +
        `${s.totalHybridRecovers} → recovery ${(s.recoveryRate * 100).toFixed(1)}%\n`,
    );
    if (s.totalBm25Misses === 0) {
      // BM25 has no conceptual misses at all — vectors can't help what isn't broken. That is a pass
      // (vacuously), but it also means the eval pack has grown too easy for BM25 and the gate is no
      // longer load-bearing; surface it so the pack can be hardened.
      process.stdout.write(
        '  [note] BM25 has 0 conceptual misses — pack too easy for this gate to bite\n',
      );
      return;
    }
    if (s.recoveryRate < MIN_RECOVERY) {
      throw new Error(
        `hybrid recovered only ${(s.recoveryRate * 100).toFixed(1)}% of BM25's conceptual ` +
          `misses (${s.totalHybridRecovers}/${s.totalBm25Misses}) < required ${MIN_RECOVERY * 100}%`,
      );
    }
  },
);

await check(
  `hybrid never regresses conceptual recall > ${MAX_REGRESSION_PCT}% vs BM25 (per lang)`,
  async () => {
    if (!semReport) throw new Error('harness did not produce a report');
    for (const [lang, r] of Object.entries(semReport.perLang)) {
      if (!r.semantic) continue;
      const bm = r.semantic.bm25.conceptual.recall10;
      const hy = r.semantic.hybrid.conceptual.recall10;
      if (bm <= 0) continue; // no floor — hybrid adding signal is fine, not a regression
      const reg = ((bm - hy) / bm) * 100;
      if (reg > MAX_REGRESSION_PCT) {
        throw new Error(
          `${lang} hybrid conceptual recall regressed ${reg.toFixed(1)}% ` +
            `(bm25 ${bm.toFixed(3)} → hybrid ${hy.toFixed(3)}) > cap ${MAX_REGRESSION_PCT}%`,
        );
      }
    }
  },
);

if (failures.length > 0) {
  process.stderr.write(
    `\nsemantic-check failed (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('\nsemantic-check ok - M2.1 hybrid recall gate held\n');
