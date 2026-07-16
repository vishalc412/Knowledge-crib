import { runEval } from './eval/harness.mjs';

const MIN_MRR_LIFT = 0; // strict: rerank MRR must be strictly greater than the no-rerank baseline
let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  rerank:check FAIL — ${msg}\n`);
  failed++;
};

// release:verify builds every package before any gate runs, so the harness's dynamic import of the
// built core + pipeline dist resolves. Two independent runs prove determinism across fresh builds.
const a = await runEval(undefined, { semantic: true });
const b = await runEval(undefined, { semantic: true });

const sa = a.overall.semantic;
const sb = b.overall.semantic;

// (1) MRR improves — strict.
if (!(sa.rerankMrrDelta > MIN_MRR_LIFT)) {
  fail(
    `overall rerank MRR did not improve: hybridMRR=${sa.hybridConceptualMrr.toFixed(4)} ` +
      `rerankMRR=${sa.hybridRerankConceptualMrr.toFixed(4)} Δ=${sa.rerankMrrDelta.toFixed(4)} ` +
      `(need Δ > ${MIN_MRR_LIFT})`,
  );
} else {
  process.stdout.write(
    `  rerank:check — MRR improved: ${sa.hybridConceptualMrr.toFixed(4)} → ` +
      `${sa.hybridRerankConceptualMrr.toFixed(4)} (Δ=${(sa.rerankMrrDelta * 100).toFixed(2)}pp)\n`,
  );
}

// (2) Recall does not regress.
if (!(sa.hybridRerankConceptualRecall >= sa.hybridConceptualRecall)) {
  fail(
    `rerank regressed conceptual recall: hybrid=${sa.hybridConceptualRecall.toFixed(4)} ` +
      `rerank=${sa.hybridRerankConceptualRecall.toFixed(4)}`,
  );
} else {
  process.stdout.write(
    `  rerank:check — recall held/improved: ${sa.hybridConceptualRecall.toFixed(4)} → ` +
      `${sa.hybridRerankConceptualRecall.toFixed(4)}\n`,
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
