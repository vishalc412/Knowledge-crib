#!/usr/bin/env node
/**
 * WP-G8 — write the candidate-bound `connected-memory-graph` receipt.
 *
 *   node scripts/graph-receipt.mjs --package <candidate.tgz> --out <evidence-dir> [--run-id <id>]
 *
 * It RUNS what it records, in this order, and archives every command with its real exit code:
 *   1. the deterministic graph suites the policy names (isolation, temporal, alias, contradiction,
 *      purge, replay, rebuild), each a named vitest run over the suites that pin that law;
 *   2. the frozen-corpus evaluation through the built `memory_graph` serving path, whose report is
 *      written to `<out>/graph/graph-eval-report.json` and hashed into the receipt.
 *
 * The receipt carries no verdict on the thresholds. The launch decision re-reads the report
 * artifact (digest-verified) and applies the policy's `graph` floors to the REPORT's numbers — a
 * receipt that restated better numbers than its report would be refused by field.
 *
 * `heldOut` is not an operator claim. Corpus version 1 is recorded as NOT held out: run 1
 * (docs/bench/graph-gates.md) repaired product defects while looking at its failures, so by the
 * test-set-selection law it can never certify. Only a later, independently authored corpus version
 * registered in HELD_OUT_CORPUS_VERSIONS below may say otherwise, and adding one is a reviewed
 * change to this file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLaunchPolicy, policyGraphRequirements } from './launch-policy.mjs';
import { buildReceipt } from './write-receipt.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Independently authored held-out corpus versions. v2 (packages/memory/src/graph-corpus/
 * heldout-v2.ts, commit 13cc9244) was written by an author isolated from run-1 results, retrieval
 * code and the harness, and committed after the retrieval configuration froze (18fc98c3).
 */
export const HELD_OUT_CORPUS_VERSIONS = [2];

/** Which suites pin which graph law — the files a suite's receipt entry actually ran. */
export const GRAPH_SUITE_FILES = {
  isolation: {
    memory: ['src/graph-projection.test.ts', 'src/graph-api.test.ts'],
    mcp: ['src/verbs-memory-graph.test.ts', 'src/graph-eval.test.ts'],
  },
  temporal: { memory: ['src/graph-projection.test.ts', 'src/graph-context.test.ts'] },
  alias: { memory: ['src/graph-projection.test.ts', 'src/graph-contracts.test.ts'] },
  contradiction: { memory: ['src/graph-projection.test.ts', 'src/graph-retrieval.test.ts'] },
  purge: { memory: ['src/graph-api.test.ts', 'src/api-sync.test.ts'] },
  replay: { memory: ['src/graph-submit.test.ts', 'src/graph-extraction.test.ts'] },
  rebuild: { memory: ['src/graph-index.test.ts', 'src/graph-backfill.test.ts'] },
};

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function runSuite(name) {
  const commands = [];
  for (const [pkg, files] of Object.entries(GRAPH_SUITE_FILES[name])) {
    const cwd = join(REPO, 'packages', pkg);
    const bin = join(cwd, 'node_modules', '.bin', 'vitest');
    const result = spawnSync(bin, ['run', ...files], { cwd, stdio: 'inherit' });
    const exitCode = typeof result.status === 'number' ? result.status : 1;
    commands.push({
      command: `vitest run ${files.join(' ')} (packages/${pkg}, suite ${name})`,
      exitCode,
    });
  }
  return commands;
}

async function main() {
  const argv = process.argv.slice(2);
  const packagePath = flag(argv, '--package');
  const out = flag(argv, '--out');
  if (!packagePath || !out) {
    process.stderr.write(
      'usage: graph-receipt.mjs --package <candidate.tgz> --out <evidence-dir>\n',
    );
    process.exit(2);
  }
  if (!existsSync(packagePath)) {
    process.stderr.write(`--package ${packagePath} does not exist\n`);
    process.exit(2);
  }
  const outDir = resolve(out);
  const { policy } = loadLaunchPolicy();
  const requirements = policyGraphRequirements(policy);

  const commandResults = [];
  const suites = {};
  for (const suite of requirements.requiredSuites) {
    const results = runSuite(suite);
    commandResults.push(...results);
    suites[suite] = results.every((r) => r.exitCode === 0) ? 'pass' : 'fail';
  }

  const reportRel = 'graph/graph-eval-report.json';
  mkdirSync(join(outDir, 'graph'), { recursive: true });
  const evalRun = spawnSync(
    process.execPath,
    [
      join(REPO, 'scripts/graph-eval.mjs'),
      '--corpus',
      'heldout-v2',
      '--out',
      join(outDir, reportRel),
    ],
    { cwd: REPO, stdio: 'inherit' },
  );
  const evalExit = typeof evalRun.status === 'number' ? evalRun.status : 1;
  commandResults.push({
    command: `node scripts/graph-eval.mjs --corpus heldout-v2 --out ${reportRel}`,
    exitCode: evalExit,
  });

  const { TOOL_NAMES } = await import(join(REPO, 'packages/mcp/dist/capabilities.js'));
  let report;
  if (evalExit === 0) {
    report = JSON.parse(readFileSync(join(outDir, reportRel), 'utf8'));
  }
  const { results: _results, ...measured } = report ?? {};

  const receiptArgv = [
    '--package',
    packagePath,
    ...(flag(argv, '--run-id') ? ['--run-id', flag(argv, '--run-id')] : []),
    ...commandResults.flatMap((r) => ['--command', r.command, '--exit-code', String(r.exitCode)]),
    ...(report ? ['--artifact', reportRel, '--artifact-root', outDir] : []),
  ];
  const receipt = buildReceipt({
    type: 'connected-memory-graph',
    argv: receiptArgv,
    details: {
      workload: requirements.workload,
      heldOut: report ? HELD_OUT_CORPUS_VERSIONS.includes(report.corpusVersion) : false,
      retrievalEnabled: TOOL_NAMES.includes('memory_graph'),
      reportPath: reportRel,
      measured,
      suites,
      extraction: { exercised: false },
    },
  });
  const receiptPath = join(outDir, 'connected-memory-graph.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `connected-memory-graph receipt (${receipt.status}) -> ${receiptPath}\n` +
      `  heldOut=${receipt.details.heldOut} recall=${measured.evidencePathRecall ?? 'n/a'} ` +
      `unauthorized=${measured.unauthorizedPaths ?? 'n/a'}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
