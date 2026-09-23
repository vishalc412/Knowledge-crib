import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OUTCOME,
  REQUIRED_CHECKS,
  evaluateAssessment,
  evaluateBenchmark,
  evaluateChecks,
  evaluateIssues,
  evaluateUiReleaseGate,
  evaluateUxTasks,
} from './ui-release-gate.mjs';

const checks = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, { exitCode: 0 }]));
const benchmark = {
  baseline: { pageStartupMs: 1653, searchMs: 71 },
  current: { pageStartupMs: 1700, searchMs: 72 },
  thresholdPct: 10,
};
const assessment = {
  standard: 'WCAG 2.2 AA',
  assessor: { name: 'A. Assessor', organization: 'Independent Audits Ltd', independent: true },
  result: 'conforms',
  retestedIssueIds: ['A11Y-002'],
};
const issues = {
  issues: [
    { id: 'A11Y-002', level: 'AA', status: 'fixed' },
    { id: 'A11Y-900', level: 'best-practice', status: 'open' },
  ],
};
const ux = {
  reviewedBy: 'Product review',
  tasks: ['find', 'source', 'blast', 'claim'].map((id) => ({
    id,
    completedWithoutPointer: true,
    evidenceMistakenForValid: false,
    countedItemUnreachable: false,
  })),
};
const complete = { checks, benchmark, issues, assessment, ux };

// A complete, passing evidence set passes.
assert.equal(evaluateUiReleaseGate(complete).outcome, 'PASS');

// Missing evidence is UNAVAILABLE — never a pass — for every requirement.
for (const key of Object.keys(complete)) {
  const gate = evaluateUiReleaseGate({ ...complete, [key]: undefined });
  assert.equal(gate.code, OUTCOME.UNAVAILABLE, `missing ${key} must be UNAVAILABLE`);
}

// Automated evidence alone (no assessment, no UX review) cannot pass.
assert.equal(
  evaluateUiReleaseGate({ checks, benchmark, issues: { issues: [] } }).outcome,
  'UNAVAILABLE',
);

// Checks: a failing command fails; an unrecorded one is unavailable.
assert.equal(evaluateChecks({ ...checks, browser: { exitCode: 1 } }).code, OUTCOME.FAIL);
assert.equal(evaluateChecks({ unit: { exitCode: 0 } }).code, OUTCOME.UNAVAILABLE);
assert.equal(evaluateChecks({ ...checks, dirty: true }).code, OUTCOME.UNAVAILABLE);

// Benchmark: an unexplained regression past the threshold fails; an explained one does not.
const slow = { ...benchmark, current: { pageStartupMs: 2500, searchMs: 72 } };
assert.equal(evaluateBenchmark(slow).code, OUTCOME.FAIL);
assert.equal(
  evaluateBenchmark({ ...slow, explanations: { pageStartupMs: 'larger fixture' } }).code,
  OUTCOME.PASS,
);
assert.equal(evaluateBenchmark({ ...benchmark, current: {} }).code, OUTCOME.UNAVAILABLE);

// Issues: open or deferred A/AA fails; fixed-but-not-retested waits; other levels do not gate.
assert.equal(
  evaluateIssues({ issues: [{ id: 'X', level: 'A', status: 'open' }] }, assessment).code,
  OUTCOME.FAIL,
);
assert.equal(
  evaluateIssues({ issues: [{ id: 'X', level: 'AA', status: 'deferred' }] }, assessment).code,
  OUTCOME.FAIL,
);
assert.equal(
  evaluateIssues({ issues: [{ id: 'Y', level: 'AA', status: 'fixed' }] }, assessment).code,
  OUTCOME.UNAVAILABLE,
);
assert.equal(
  evaluateIssues({ issues: [{ id: 'Y', level: 'AA', status: 'verified' }] }, undefined).code,
  OUTCOME.PASS,
);

// Assessment: the implementation team's own agents are not independent; a non-conforming result fails.
for (const name of ['Claude Code', 'codex agent', 'GPT reviewer']) {
  assert.equal(
    evaluateAssessment({ ...assessment, assessor: { name, independent: true } }).code,
    OUTCOME.UNAVAILABLE,
    `${name} must not count as independent`,
  );
}
assert.equal(
  evaluateAssessment({ ...assessment, assessor: { ...assessment.assessor, independent: false } })
    .code,
  OUTCOME.UNAVAILABLE,
);
assert.equal(
  evaluateAssessment({ ...assessment, standard: 'WCAG 2.1 AA' }).code,
  OUTCOME.UNAVAILABLE,
);
assert.equal(evaluateAssessment({ ...assessment, result: 'does-not-conform' }).code, OUTCOME.FAIL);

// UX tasks: any pointer dependence, mistaken evidence or unreachable counted item fails.
assert.equal(
  evaluateUxTasks({
    ...ux,
    tasks: ux.tasks.map((t, i) => (i ? t : { ...t, countedItemUnreachable: true })),
  }).code,
  OUTCOME.FAIL,
);
assert.equal(evaluateUxTasks({ ...ux, tasks: ux.tasks.slice(0, 3) }).code, OUTCOME.UNAVAILABLE);

// FAIL dominates UNAVAILABLE.
assert.equal(
  evaluateUiReleaseGate({
    ...complete,
    assessment: undefined,
    checks: { ...checks, unit: { exitCode: 2 } },
  }).outcome,
  'FAIL',
);

// The CLI maps outcomes to exit codes and reports invalid JSON as UNAVAILABLE.
const dir = mkdtempSync(join(tmpdir(), 'ui-gate-'));
try {
  const run = () =>
    spawnSync(process.execPath, ['scripts/ui-release-gate.mjs', '--dir', dir], {
      encoding: 'utf8',
    });
  assert.equal(run().status, OUTCOME.UNAVAILABLE);
  for (const [file, value] of Object.entries({
    'checks.json': checks,
    'benchmark.json': benchmark,
    'issue-log.json': issues,
    'assessment.json': assessment,
    'ux-tasks.json': ux,
  })) {
    writeFileSync(join(dir, file), JSON.stringify(value));
  }
  assert.equal(run().status, OUTCOME.PASS);
  writeFileSync(
    join(dir, 'issue-log.json'),
    JSON.stringify({ issues: [{ id: 'Z', level: 'A', status: 'open' }] }),
  );
  assert.equal(run().status, OUTCOME.FAIL);
  writeFileSync(join(dir, 'issue-log.json'), '{ not json');
  assert.equal(run().status, OUTCOME.UNAVAILABLE);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('ui-release-gate: all assertions passed');
