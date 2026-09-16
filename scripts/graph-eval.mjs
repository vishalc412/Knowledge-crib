#!/usr/bin/env node
/**
 * WP-G5/G8 — run the frozen connected-memory-graph corpus through the BUILT `memory_graph` serving
 * path and write the measured report. It never applies a threshold: `docs/bench/graph-gates.md`
 * states the gates and the launch decision applies them to a receipt.
 *
 *   node scripts/graph-eval.mjs --out <report.json>
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGraphCorpusEvaluation } from '../packages/mcp/dist/graph-eval.js';

const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (out === undefined) {
  process.stderr.write('usage: node scripts/graph-eval.mjs --out <report.json>\n');
  process.exit(2);
}
const workDir = mkdtempSync(join(tmpdir(), 'crib-graph-eval-'));
try {
  const report = runGraphCorpusEvaluation({ workDir });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  const { results: _results, ...summary } = report;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
