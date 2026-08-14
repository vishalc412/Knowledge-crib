/**
 * Tests for the local MuleSoft sample acceptance gate (MUnit-hardening Task 6).
 *
 * The happy path indexes the deterministic synthetic fixture and asserts every topology count + the
 * two security canaries + the synthetic secret canary (the planted secret value never enters the
 * graph). The failure path indexes a deliberately minimal project and asserts the checker reports
 * the differing metric with its expected vs actual count and exits nonzero.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXPECTED, checkMuleSample } from './check-mule-sample.mjs';
import { SECRET_CANARY, syntheticMuleProject } from './fixtures/synthetic-mule-project.mjs';

const CLI_DIST = resolve('packages/cli/dist/cli.js');

// The checker drives the built CLI; the root `pretest` build makes dist available. Skip with a
// clear message (not a failure) if the repo has not been built in this working tree.
if (!existsSync(CLI_DIST)) {
  console.log('check-mule-sample tests skipped — run `corepack pnpm@9.15.0 build` first');
  process.exit(0);
}

// 1. Happy path: the full synthetic corpus must match the baseline exactly, with clean canaries.
const happy = mkdtempSync(join(tmpdir(), 'mule-synth-'));
syntheticMuleProject(happy);
const result = checkMuleSample(happy, { secretCanary: SECRET_CANARY });
assert.equal(
  result.passed,
  true,
  `synthetic corpus must pass acceptance:\n${JSON.stringify(result.mismatches)}`,
);
for (const key of Object.keys(EXPECTED))
  assert.equal(result.counts[key], EXPECTED[key], `topology count ${key} must match the baseline`);
// Security canaries: no raw property values, no semantic nodes from report JS, and the planted
// secret string must never appear anywhere in the extracted graph (keys + references only).
assert.equal(
  result.canaries.propertiesWithRawValue,
  0,
  'property nodes must never carry a raw value',
);
assert.equal(result.canaries.reportJsSymbols, 0, 'report/asset JS must yield zero semantic nodes');
assert.equal(result.canaries.secretHits, 0, 'the planted secret value must never enter the graph');

// 2. Failure path: a minimal (descriptor-only) project must fail and name the differing metric.
const minimal = mkdtempSync(join(tmpdir(), 'mule-min-'));
writeFileSync(join(minimal, 'mule-artifact.json'), '{}\n');
const failed = checkMuleSample(minimal);
assert.equal(
  failed.passed,
  false,
  'a descriptor-only project must not pass the synthetic baseline',
);
assert.ok(failed.mismatches.length > 0, 'a failure must report at least one differing metric');
const flowMismatch = failed.mismatches.find((m) => m.metric === 'flows');
assert.ok(flowMismatch, 'a failure must report the `flows` metric');
assert.equal(flowMismatch.expected, EXPECTED.flows);
assert.equal(flowMismatch.actual, 0);

// 3. CLI entry point: a missing --archive must exit 2 with a usage message (not a crash).
const checker = resolve('scripts/check-mule-sample.mjs');
try {
  execFileSync(process.execPath, [checker], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.fail('checker must exit nonzero when --archive is missing');
} catch (err) {
  assert.notEqual(err.status, 0);
  assert.match(err.stderr, /usage:.*--archive/);
}

console.log('check-mule-sample tests ok');
