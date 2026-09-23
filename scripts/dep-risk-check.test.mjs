/**
 * Unit tests for the WP3 dependency-risk check.
 *
 * Both inputs are injected (`--audit` and `--deps`), so the entire reachability rule is exercised
 * against synthetic trees. That matters more here than anywhere else in the hygiene set: the policy
 * IS the reachability split, and the one tree available to test against (this repository's) contains
 * only dev-only advisories — a gate tested only on that tree would never once have taken its FAIL
 * branch, and the branch that gates a release is the one that has to be proven to fire.
 *
 * The three cases that carry the policy:
 *   - a chain whose first hop is a dev dependency   → reported, does NOT gate;
 *   - a chain whose first hop is a runtime dependency → FAILS, at any severity;
 *   - a chain whose first hop is a name the split does not know → FAILS. This is the strictness
 *     that keeps the rule safe: an unrecognised chain (a new resolution shape, a parser drift) must
 *     fail loudly rather than be classified as a test tool and waved through.
 *
 * The gate's own failure modes are tested as well: an unreachable registry is UNAVAILABLE and exits
 * non-zero by default, `--allow-unavailable` downgrades it explicitly, a baseline entry accepts a
 * runtime advisory, and a stale entry fails.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'dep-risk-check.mjs');

const roots = [];
// A workspace with one runtime dependency and one dev-only dependency. `devOnly` therefore holds
// exactly `test-lib`, and anything else in a chain is treated as runtime.
const DEPS = [
  {
    name: 'pkg-a',
    version: '1.0.0',
    dependencies: { 'runtime-lib': '1.0.0' },
    devDependencies: { 'test-lib': '1.0.0' },
  },
];

/** One advisory reachable through the given chain, in pnpm's advisory shape. */
const auditOf = (
  chain,
  { severity = 'high', module = 'bad-lib', ghsa = 'GHSA-aaaa-bbbb-cccc' } = {},
) => ({
  advisories: {
    1: {
      module_name: module,
      severity,
      title: `${module} does something it should not`,
      vulnerable_versions: '<2.0.0',
      patched_versions: '>=2.0.0',
      github_advisory_id: ghsa,
      findings: [{ version: '1.0.0', paths: [chain] }],
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    totalDependencies: 229,
  },
});

function run({ audit, deps = DEPS, entries = [], extraArgs = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'dep-risk-check-'));
  roots.push(root);
  const auditPath = join(root, 'audit.json');
  const depsPath = join(root, 'deps.json');
  const baselinePath = join(root, 'dep-risk-baseline.json');
  writeFileSync(auditPath, typeof audit === 'string' ? audit : JSON.stringify(audit, null, 2));
  writeFileSync(depsPath, JSON.stringify(deps, null, 2));
  writeFileSync(baselinePath, JSON.stringify({ entries }, null, 2));
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        CHECK,
        '--audit',
        auditPath,
        '--deps',
        depsPath,
        '--baseline',
        baselinePath,
        '--json',
        ...extraArgs,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    stdout = error.stdout ?? '';
    status = error.status;
  }
  return { status, stdout, report: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null };
}

try {
  // ─── a dev-only chain is reported and does NOT gate ─────────────────────────
  {
    const { status, report } = run({ audit: auditOf('. > test-lib@1.0.0 > bad-lib@1.0.0') });
    assert.equal(
      status,
      0,
      `a dev-only advisory must not gate a release; got ${JSON.stringify(report?.failures)}`,
    );
    assert.equal(report.byReachability['dev-only'], 1);
    assert.equal(report.byReachability.runtime, undefined);
    // Reported, not dropped: the id and severity are in the document a release log archives.
    assert.equal(report.devOnly.length, 1);
    assert.equal(report.devOnly[0].ghsa, 'GHSA-aaaa-bbbb-cccc');
    assert.equal(report.devOnly[0].severity, 'high');
  }

  // ─── a runtime chain FAILS, at any severity ─────────────────────────────────
  for (const severity of ['low', 'moderate', 'high', 'critical']) {
    const { status, report } = run({
      audit: auditOf('. > runtime-lib@1.0.0 > bad-lib@1.0.0', { severity }),
    });
    assert.equal(
      status,
      1,
      `a runtime-reachable ${severity} advisory must fail — severity is not the policy`,
    );
    assert.match(report.failures.join('\n'), /reachable from a RUNTIME dependency/);
    assert.match(
      report.failures.join('\n'),
      /reachable from a RUNTIME dependency via \. > runtime-lib/,
    );
  }

  // ─── an unknown first hop is treated as runtime, not waved through ──────────
  {
    const { status, report } = run({
      audit: auditOf('. > nobody-has-heard-of-this@1.0.0 > bad-lib@1.0.0'),
    });
    assert.equal(
      status,
      1,
      'a chain whose first hop the split does not recognise must FAIL, not be assumed dev-only',
    );
    assert.equal(report.byReachability.runtime, 1);
  }

  // ─── one advisory with BOTH a dev and a runtime chain FAILS ─────────────────
  {
    const audit = auditOf('. > test-lib@1.0.0 > bad-lib@1.0.0');
    audit.advisories[1].findings[0].paths.push('. > runtime-lib@1.0.0 > bad-lib@1.0.0');
    const { status, report } = run({ audit });
    assert.equal(
      status,
      1,
      'a single runtime path anywhere in the advisory makes the advisory runtime',
    );
    assert.equal(report.byReachability.runtime, 1, 'and it must not also be counted as dev-only');
  }

  // ─── no advisories at all is a real PASS ────────────────────────────────────
  {
    const { status, report } = run({ audit: { advisories: {}, metadata: {} } });
    assert.equal(status, 0);
    assert.equal(report.advisories, 0);
  }

  // ─── a baseline entry accepts a runtime advisory, and carries its reason ────
  {
    const entries = [
      {
        ghsa: 'GHSA-aaaa-bbbb-cccc',
        reason: 'vulnerable loader path is unreachable; the dependency is used for its types only',
      },
    ];
    const { status, report } = run({
      audit: auditOf('. > runtime-lib@1.0.0 > bad-lib@1.0.0'),
      entries,
    });
    assert.equal(status, 0, 'an accepted runtime advisory must not fail the gate');
    assert.equal(report.baselineEntriesMatched, 1);
    assert.equal(report.failures.length, 0);
  }

  // ─── the ratchet: a baseline entry that accepts nothing FAILS ───────────────
  {
    const entries = [
      { ghsa: 'GHSA-gone-gone-gone', reason: 'was reachable before the version bump' },
    ];
    const { status, report } = run({
      audit: auditOf('. > test-lib@1.0.0 > bad-lib@1.0.0'),
      entries,
    });
    assert.equal(
      status,
      1,
      'a stale acceptance must fail — otherwise it outlives the advisory it accepted',
    );
    assert.match(report.failures.join('\n'), /stale baseline entry/);
  }

  // ─── an unreadable audit is UNAVAILABLE, and that is not a pass ─────────────
  {
    const { status, stdout } = run({ audit: 'not json at all' });
    assert.equal(
      status,
      2,
      'a gate that could not check must not exit 0 — a release gate that goes green without checking is a false green',
    );
    assert.match(stdout, /UNAVAILABLE/);
  }
  {
    const { status, stdout } = run({
      audit: 'not json at all',
      extraArgs: ['--allow-unavailable'],
    });
    assert.equal(status, 0, '--allow-unavailable must downgrade it explicitly, for local runs');
    assert.match(stdout, /UNAVAILABLE/, 'and it must still SAY so — a downgrade is not a silence');
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('dep-risk-check tests ok\n');
