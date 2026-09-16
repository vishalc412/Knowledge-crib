#!/usr/bin/env node
/**
 * WP-G5/G8 — run a graph question set through the BUILT `memory_graph` serving path and write the
 * measured report. It never applies a threshold: `docs/bench/graph-gates.md` states the gates and
 * the launch decision applies them to a receipt.
 *
 *   node scripts/graph-eval.mjs --out <report.json> [--corpus v1|heldout-v2] [--no-semantic]
 *
 * The semantic seed channel runs on the INSTALLED launch embedder (the policy requires one); a run
 * without it records `embedderId: null`, which the decision refuses, rather than silently measuring
 * a weaker configuration than the one that ships.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadInstalledEmbedder } from '../packages/core/dist/index.js';
import { runGraphCorpusEvaluation } from '../packages/mcp/dist/graph-eval.js';

const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const out = flag('--out');
const corpus = flag('--corpus') ?? 'v1';
if (out === undefined || !['v1', 'heldout-v2'].includes(corpus)) {
  process.stderr.write(
    'usage: node scripts/graph-eval.mjs --out <report.json> [--corpus v1|heldout-v2] [--no-semantic]\n',
  );
  process.exit(2);
}

const embedder = process.argv.includes('--no-semantic') ? undefined : await loadInstalledEmbedder();
let questions;
if (corpus === 'heldout-v2') {
  const memory = await import('../packages/memory/dist/index.js');
  questions = (built) => ({
    version: memory.GRAPH_HELDOUT_CORPUS_VERSION,
    questions: memory.buildHeldOutGraphQuestions(built),
  });
}

const workDir = mkdtempSync(join(tmpdir(), 'crib-graph-eval-'));
try {
  const report = runGraphCorpusEvaluation({
    workDir,
    ...(embedder ? { embedder } : {}),
    ...(questions ? { questions } : {}),
  });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  const { results: _results, ...summary } = report;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
