#!/usr/bin/env node
/**
 * UI remediation Phase 6 — the `crib viz` release gate.
 *
 * Three outcomes, like every release gate in this repository:
 *   PASS (0)         every requirement has evidence and none fails;
 *   FAIL (1)         a requirement has evidence that it is NOT met;
 *   UNAVAILABLE (2)  a requirement has no evidence yet — never read as a pass.
 *
 * Requirements (docs/program/ui-remediation plan, Phase 6 step 5), each read from a JSON artifact
 * in the evidence directory (default docs/audits/2026-09-23/a11y):
 *   checks.json      exit codes of the unit/browser/security/package commands, written by CI;
 *   benchmark.json   the large-graph benchmark against the Phase 0 baseline;
 *   issue-log.json   every accessibility finding with its WCAG level and status;
 *   assessment.json  the INDEPENDENT WCAG 2.2 AA assessment and its retests;
 *   ux-tasks.json    the reviewed results of the four product tasks.
 *
 * An A/AA issue that is open or deferred FAILS the gate. One marked fixed still needs the
 * independent assessor's retest (listed in assessment.retestedIssueIds) before it counts. Automated
 * results, however clean, never stand in for the assessment: without assessment.json the gate is
 * UNAVAILABLE.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUTCOME = { PASS: 0, FAIL: 1, UNAVAILABLE: 2 };
const NAMES = ['PASS', 'FAIL', 'UNAVAILABLE'];
export const REQUIRED_CHECKS = ['unit', 'typecheck', 'browser', 'security', 'package'];
/** Names that identify the implementation team's own agents, which cannot self-assess. */
const IMPLEMENTER_PATTERN = /\b(claude|codex|gpt|copilot|cursor|agent)\b/i;

function result(requirement, outcome, reason) {
  return { requirement, outcome: NAMES[outcome], code: outcome, reason };
}

export function evaluateChecks(checks) {
  if (!checks) return result('checks', OUTCOME.UNAVAILABLE, 'checks.json is missing');
  // A receipt from a dirty tree describes code that was never committed, so it is not evidence.
  if (checks.dirty === true) {
    return result('checks', OUTCOME.UNAVAILABLE, 'checks were recorded on a dirty working tree');
  }
  const missing = REQUIRED_CHECKS.filter((name) => typeof checks[name]?.exitCode !== 'number');
  const failed = REQUIRED_CHECKS.filter(
    (name) => typeof checks[name]?.exitCode === 'number' && checks[name].exitCode !== 0,
  );
  if (failed.length) return result('checks', OUTCOME.FAIL, `failed: ${failed.join(', ')}`);
  if (missing.length)
    return result('checks', OUTCOME.UNAVAILABLE, `not recorded: ${missing.join(', ')}`);
  return result('checks', OUTCOME.PASS, `${REQUIRED_CHECKS.length} checks passed`);
}

export function evaluateBenchmark(bench) {
  if (!bench) return result('benchmark', OUTCOME.UNAVAILABLE, 'benchmark.json is missing');
  const threshold = typeof bench.thresholdPct === 'number' ? bench.thresholdPct : 10;
  const regressions = [];
  for (const [metric, base] of Object.entries(bench.baseline ?? {})) {
    const now = bench.current?.[metric];
    if (typeof base !== 'number' || typeof now !== 'number') {
      return result('benchmark', OUTCOME.UNAVAILABLE, `no current value for ${metric}`);
    }
    const pct = base === 0 ? 0 : ((now - base) / base) * 100;
    if (pct > threshold && !bench.explanations?.[metric]) {
      regressions.push(`${metric} +${pct.toFixed(1)}%`);
    }
  }
  if (Object.keys(bench.baseline ?? {}).length === 0) {
    return result('benchmark', OUTCOME.UNAVAILABLE, 'no baseline metrics');
  }
  if (regressions.length) {
    return result('benchmark', OUTCOME.FAIL, `unexplained regression: ${regressions.join(', ')}`);
  }
  return result('benchmark', OUTCOME.PASS, `within ${threshold}% or explained`);
}

export function evaluateAssessment(assessment) {
  if (!assessment) {
    return result(
      'assessment',
      OUTCOME.UNAVAILABLE,
      'no independent WCAG 2.2 AA assessment recorded',
    );
  }
  const assessor = assessment.assessor ?? {};
  const who = `${assessor.name ?? ''} ${assessor.organization ?? ''}`.trim();
  if (!who || assessor.independent !== true || IMPLEMENTER_PATTERN.test(who)) {
    return result(
      'assessment',
      OUTCOME.UNAVAILABLE,
      'the assessor is not recorded as independent of the implementation team',
    );
  }
  if (assessment.standard !== 'WCAG 2.2 AA') {
    return result('assessment', OUTCOME.UNAVAILABLE, 'the assessment does not state WCAG 2.2 AA');
  }
  if (assessment.result !== 'conforms') {
    return result('assessment', OUTCOME.FAIL, `assessment result: ${assessment.result ?? 'none'}`);
  }
  return result('assessment', OUTCOME.PASS, `independent assessment by ${who}`);
}

export function evaluateIssues(log, assessment) {
  if (!log) return result('issues', OUTCOME.UNAVAILABLE, 'issue-log.json is missing');
  const retested = new Set(assessment?.retestedIssueIds ?? []);
  const applicable = (log.issues ?? []).filter(
    (issue) => issue.level === 'A' || issue.level === 'AA',
  );
  const unresolved = applicable.filter(
    (issue) => issue.status === 'open' || issue.status === 'deferred',
  );
  if (unresolved.length) {
    return result(
      'issues',
      OUTCOME.FAIL,
      `unresolved A/AA: ${unresolved.map((issue) => issue.id).join(', ')}`,
    );
  }
  const awaiting = applicable.filter(
    (issue) => issue.status !== 'verified' && !retested.has(issue.id),
  );
  if (awaiting.length) {
    return result(
      'issues',
      OUTCOME.UNAVAILABLE,
      `fixed, awaiting independent retest: ${awaiting.map((issue) => issue.id).join(', ')}`,
    );
  }
  return result('issues', OUTCOME.PASS, `${applicable.length} A/AA issues resolved and retested`);
}

export function evaluateUxTasks(ux) {
  if (!ux) return result('ux-tasks', OUTCOME.UNAVAILABLE, 'ux-tasks.json is missing');
  if (!ux.reviewedBy || !Array.isArray(ux.tasks) || ux.tasks.length < 4) {
    return result('ux-tasks', OUTCOME.UNAVAILABLE, 'fewer than four reviewed product tasks');
  }
  const failed = ux.tasks.filter(
    (task) =>
      task.completedWithoutPointer !== true ||
      task.evidenceMistakenForValid === true ||
      task.countedItemUnreachable === true,
  );
  if (failed.length)
    return result(
      'ux-tasks',
      OUTCOME.FAIL,
      `failed tasks: ${failed.map((task) => task.id).join(', ')}`,
    );
  return result('ux-tasks', OUTCOME.PASS, `${ux.tasks.length} tasks completed and reviewed`);
}

/** The whole gate. FAIL dominates; otherwise any missing evidence makes it UNAVAILABLE. */
export function evaluateUiReleaseGate(inputs) {
  const results = [
    evaluateChecks(inputs.checks),
    evaluateBenchmark(inputs.benchmark),
    evaluateIssues(inputs.issues, inputs.assessment),
    evaluateAssessment(inputs.assessment),
    evaluateUxTasks(inputs.ux),
  ];
  const code = results.some((r) => r.code === OUTCOME.FAIL)
    ? OUTCOME.FAIL
    : results.some((r) => r.code === OUTCOME.UNAVAILABLE)
      ? OUTCOME.UNAVAILABLE
      : OUTCOME.PASS;
  return { outcome: NAMES[code], code, results };
}

function readJson(dir, file) {
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

function main(argv) {
  const dirFlag = argv.indexOf('--dir');
  const dir = resolve(dirFlag >= 0 ? argv[dirFlag + 1] : 'docs/audits/2026-09-23/a11y');
  let gate;
  try {
    gate = evaluateUiReleaseGate({
      checks: readJson(dir, 'checks.json'),
      benchmark: readJson(dir, 'benchmark.json'),
      issues: readJson(dir, 'issue-log.json'),
      assessment: readJson(dir, 'assessment.json'),
      ux: readJson(dir, 'ux-tasks.json'),
    });
  } catch (err) {
    process.stderr.write(`ui-release-gate: UNAVAILABLE — ${err.message}\n`);
    return OUTCOME.UNAVAILABLE;
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
  } else {
    for (const r of gate.results)
      process.stdout.write(`${r.outcome.padEnd(11)} ${r.requirement.padEnd(10)} ${r.reason}\n`);
    process.stdout.write(`ui-release-gate: ${gate.outcome}\n`);
  }
  return gate.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
