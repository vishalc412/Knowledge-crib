import { readFileSync } from 'node:fs';
import { runEval } from './eval/harness.mjs';

// A RATCHET, not a "must beat plain RRF" gate. The original assertion (rerank MRR strictly greater
// than the no-rerank baseline on the fixture eval) has failed on every run since at least
// 2026-09-21, and the stronger instrument contradicts it: on the 61-task real-repository corpus the
// structural prior is worth +7.8pp MRR (0.4169 on vs 0.3389 off, docs/bench/rerank-prior.md). So
// the prior stays on and this gate protects what the fixtures CAN protect: the fixture deltas never
// get worse than the recorded baseline, and the ranking stays deterministic.
const BASELINE = JSON.parse(
  readFileSync(new URL('./rerank-baseline.json', import.meta.url), 'utf8'),
).fixtures;
// The eval is deterministic to the digit across machines (CI and local agree), so the tolerance only
// absorbs the baseline's six-decimal rounding.
const TOLERANCE = 1e-6;
let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  rerank:check FAIL — ${msg}\n`);
  failed++;
};
const pp = (x) => `${(x * 100).toFixed(2)}pp`;

// release:verify builds every package before any gate runs, so the harness's dynamic import of the
// built core + pipeline dist resolves. Two independent runs prove determinism across fresh builds.
const a = await runEval(undefined, { semantic: true });
const b = await runEval(undefined, { semantic: true });

const sa = a.overall.semantic;
const sb = b.overall.semantic;
const recallDelta = sa.hybridRerankConceptualRecall - sa.hybridConceptualRecall;

// (1) MRR delta does not regress past the baseline.
if (sa.rerankMrrDelta < BASELINE.mrrDelta - TOLERANCE) {
  fail(
    `rerank MRR delta regressed: ${pp(sa.rerankMrrDelta)} < baseline ${pp(BASELINE.mrrDelta)} ` +
      `(hybridMRR=${sa.hybridConceptualMrr.toFixed(4)} rerankMRR=${sa.hybridRerankConceptualMrr.toFixed(4)})`,
  );
} else {
  process.stdout.write(
    `  rerank:check — MRR delta ${pp(sa.rerankMrrDelta)} holds the baseline ${pp(BASELINE.mrrDelta)}\n`,
  );
  if (sa.rerankMrrDelta > BASELINE.mrrDelta + TOLERANCE) {
    process.stdout.write(
      '  rerank:check — improved on the baseline: raise fixtures.mrrDelta in scripts/rerank-baseline.json\n',
    );
  }
}

// (2) Recall delta does not regress past the baseline.
if (recallDelta < BASELINE.recallDelta - TOLERANCE) {
  fail(
    `rerank recall delta regressed: ${pp(recallDelta)} < baseline ${pp(BASELINE.recallDelta)} ` +
      `(hybrid=${sa.hybridConceptualRecall.toFixed(4)} rerank=${sa.hybridRerankConceptualRecall.toFixed(4)})`,
  );
} else {
  process.stdout.write(
    `  rerank:check — recall delta ${pp(recallDelta)} holds the baseline ${pp(BASELINE.recallDelta)}\n`,
  );
}

// (3) Determinism — two runs identical on the rerank metrics.
const sig = (s) =>
  JSON.stringify({
    mrr: s.hybridRerankConceptualMrr,
    recall: s.hybridRerankConceptualRecall,
  });
if (sig(sa) !== sig(sb)) {
  fail(`rerank nondeterministic across two runs: runA=${sig(sa)} runB=${sig(sb)}`);
} else {
  process.stdout.write('  rerank:check — deterministic across two independent runs\n');
}

// Per-language visibility (no gate — surfaces where rerank helps or hurts for tuning).
process.stdout.write('  rerank:check — per-language rerankΔMRR:\n');
for (const [lang, r] of Object.entries(a.perLang)) {
  if (!r.semantic) continue;
  const d = r.semantic.rerankMrrDelta;
  const flag = d < -0.01 ? ' ⚠' : '';
  process.stdout.write(
    `    ${lang.padEnd(8)} ΔMRR=${(d * 100).toFixed(1)}pp  ` +
      `recall ${r.semantic.hybrid.conceptual.recall10.toFixed(3)}→${r.semantic.hybridRerank.conceptual.recall10.toFixed(3)}${flag}\n`,
  );
}

if (failed > 0) {
  process.stderr.write(`\nrerank:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nrerank:check — all assertions passed\n');
