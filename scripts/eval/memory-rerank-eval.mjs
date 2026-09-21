#!/usr/bin/env node
/**
 * Does the cross-encoder close the gap it was BUILT for?
 *
 * `packages/memory/src/fusion.ts` declared the `Reranker` port on the back of a measurement from this
 * corpus: the bi-encoder retrieves the correct record for EVERY word-disjoint query at some depth, yet
 * ranks it top-5 for only 43.8% of them. That is a precision problem a bi-encoder cannot fix, because
 * it must commit to a query-independent document vector. This script runs the same frozen launch gate
 * with and without the second stage, so the port's justification is finally tested against the corpus
 * that produced it.
 *
 * It is separate from `code-vector-eval.mjs` on purpose: that one measures CODE retrieval, where the
 * reranker MEASURED A NET LOSS (MRR 0.287 -> 0.267 on the labelled corpus, even though it pulled one
 * more answer into the top-10 window). Two surfaces, two corpora, two answers — reporting one number
 * for "does reranking help" would hide the disagreement, which is the interesting part.
 *
 * Usage: node scripts/eval/memory-rerank-eval.mjs [--scale N]
 */
import { loadInstalledEmbedder, loadInstalledReranker } from '../../packages/core/dist/index.js';
import { LAUNCH_SCALE_FULL } from '../../packages/memory/dist/bench/launch-corpus.js';
import { runLaunchGate } from '../../packages/memory/dist/bench/launch-eval.js';

const args = process.argv.slice(2);
const scaleIdx = args.indexOf('--scale');
const scale = scaleIdx >= 0 ? Number(args[scaleIdx + 1]) : LAUNCH_SCALE_FULL;

const embedder = await loadInstalledEmbedder().catch(() => undefined);
if (!embedder) {
  console.error('no embed tier installed — run `crib embed setup` first');
  process.exit(1);
}
const reranker = await loadInstalledReranker().catch((e) => {
  console.error(`no reranker installed (${e.message}) — run \`crib rerank setup --yes\``);
  return undefined;
});
if (!reranker) process.exit(1);

/** The two gate keys the reranker is supposed to move: G2 paraphrase recall@5 and G3 MRR. */
function summarize(report) {
  const gates = report.gates ?? [];
  const byId = new Map(gates.map((g) => [g.id, g]));
  const pick = (id) => {
    const g = byId.get(id);
    // GateResult calls it `measured`, not `value`.
    return g === undefined ? null : { value: g.measured, threshold: g.threshold, pass: g.pass };
  };
  return {
    passed: gates.filter((g) => g.pass).length,
    total: gates.length,
    G2: pick('G2'),
    G3: pick('G3'),
  };
}

console.log(`corpus scale: ${scale}`);
console.log(`embedder    : ${embedder.id}`);
console.log(`reranker    : ${reranker.id}\n`);

const rows = [];
{
  const t0 = Date.now();
  const r = runLaunchGate(scale, { strategy: 'semantic-only', embedder });
  rows.push(['semantic-only', summarize(r), Date.now() - t0]);
}
{
  const t0 = Date.now();
  const r = runLaunchGate(scale, { strategy: 'semantic-only', embedder, reranker });
  rows.push(['+ cross-encoder', summarize(r), Date.now() - t0]);
}

const fmt = (m) => (m === null ? '   n/a' : `${(m.value * 100).toFixed(1)}%`.padStart(7));
const fmtMrr = (m) => (m === null ? '  n/a' : m.value.toFixed(3).padStart(6));
for (const [label, s, ms] of rows) {
  console.log(
    `${label.padEnd(16)} gates ${String(s.passed).padStart(2)}/${s.total}   ` +
      `G2 paraphrase@5 ${fmt(s.G2)}   G3 MRR ${fmtMrr(s.G3)}   (${(ms / 1000).toFixed(1)}s)`,
  );
}
const [, base] = rows[0];
const [, withRr] = rows[1];
if (base.G3 && withRr.G3) {
  const delta = withRr.G3.value - base.G3.value;
  const reading =
    delta > 0.005
      ? 'the second stage earns its cost on this corpus.'
      : delta < -0.005
        ? 'the second stage COSTS accuracy here; do not enable it for memory recall.'
        : 'no meaningful difference; the cost is not justified.';
  console.log(`\nMRR delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} — ${reading}`);
}
