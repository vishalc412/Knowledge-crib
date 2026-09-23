/**
 * Unit tests for the WP3 license check.
 *
 * The policy half is driven through `--licenses <file>`, which feeds the gate a synthetic inventory.
 * That indirection is the point: the licenses that MUST fail (GPL, an unknown term, an unparseable
 * field) cannot be installed here to be tested, and a policy gate whose only tested input is the
 * one tree it happens to be sitting in has not been tested at all.
 *
 * The expression evaluator is tested at its two edges, because they fail in OPPOSITE directions and
 * a single wrong branch in either is invisible from a green run:
 *   - `MIT OR GPL-3.0` must PASS — the consumer may choose the MIT arm. A gate that fails it is
 *     rejecting a dependency that offers acceptable terms.
 *   - `MIT AND GPL-3.0` must FAIL — every conjunct applies. A gate that passes it is accepting
 *     copyleft terms because a permissive one appeared in the same string.
 * Same three tokens, both orders, opposite verdicts: that pair is the whole reason this is parsed
 * rather than string-matched.
 *
 * As in the credential check, the gate's OWN failure modes are tested rather than assumed: an empty
 * inventory must FAIL (a check over zero packages passes trivially), an unmodelled `WITH` must be
 * reported rather than silently accepted, and a stale allowlist entry must fail.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'license-check.mjs');

const roots = [];

/** Run the gate over a synthetic inventory and an allowlist, both written to a fresh tmpdir. */
function run(inventory, entries = []) {
  const root = mkdtempSync(join(tmpdir(), 'license-check-'));
  roots.push(root);
  const licenses = join(root, 'licenses.json');
  const allowlist = join(root, 'license-allowlist.json');
  writeFileSync(licenses, JSON.stringify(inventory, null, 2));
  writeFileSync(allowlist, JSON.stringify({ entries }, null, 2));
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [CHECK, '--licenses', licenses, '--allowlist', allowlist, '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    stdout = error.stdout ?? '';
    status = error.status;
  }
  return { status, stdout, report: JSON.parse(stdout) };
}

/** A one-package inventory for the given expression, in pnpm's license→packages shape. */
const inventoryOf = (expression, name = 'some-dep') => ({
  [expression]: [{ name, versions: ['1.0.0'], license: expression }],
});

try {
  // ─── the compliant twin: a permissive expression passes ─────────────────────
  {
    const { status, report } = run(inventoryOf('MIT'));
    assert.equal(status, 0, `MIT must pass; got ${JSON.stringify(report.failures)}`);
    assert.equal(report.byVerdict.allowed, 1);
    assert.equal(report.failures.length, 0, 'a permissive license must raise no failure');
  }

  // ─── the operator pair: same tokens, opposite verdicts ──────────────────────
  {
    const or = run(inventoryOf('MIT OR GPL-3.0'));
    assert.equal(
      or.status,
      0,
      'OR means the consumer may choose: an MIT arm makes the dependency acceptable',
    );
  }
  {
    const and = run(inventoryOf('MIT AND GPL-3.0'));
    assert.equal(
      and.status,
      1,
      'AND means every conjunct applies: a copyleft term beside a permissive one must still fail',
    );
    assert.equal(and.report.byVerdict.denied, 1);
  }

  // ─── a copyleft license alone fails ─────────────────────────────────────────
  {
    const { status, report } = run(inventoryOf('GPL-3.0-only', 'copyleft-dep'));
    assert.equal(status, 1);
    assert.match(report.failures.join('\n'), /copyleft-dep@1\.0\.0/);
    assert.match(report.failures.join('\n'), /not on the permissive list/);
  }

  // ─── `WITH` is reported as unmodelled, not silently accepted ────────────────
  {
    const { status, report } = run(inventoryOf('GPL-2.0-only WITH Classpath-exception-2.0'));
    assert.equal(
      status,
      1,
      'a WITH clause changes the terms in ways this evaluator does not model, so it must be reviewed',
    );
    assert.equal(report.byVerdict.unmodelled, 1);
    assert.match(report.failures.join('\n'), /WITH/);
  }

  // ─── an unparseable expression is reported, never guessed at ────────────────
  {
    const { status, report } = run(inventoryOf('MIT OR', 'broken-dep'));
    assert.equal(status, 1, 'a malformed expression must not be resolved by guessing');
    assert.match(report.failures.join('\n'), /could not be parsed/);
  }

  // ─── an allowlist entry accepts a term, and carries its reason ──────────────
  {
    const entries = [
      { name: 'copyleft-dep', reason: 'reviewed by legal, used unmodified at build time' },
    ];
    const { status, report } = run(inventoryOf('GPL-3.0-only', 'copyleft-dep'), entries);
    assert.equal(status, 0, 'an allowlisted package must not fail the check');
    assert.equal(report.failures.length, 0);
  }

  // ─── the ratchet: an entry that excepts nothing FAILS ───────────────────────
  {
    const entries = [{ name: 'not-installed', reason: 'was a dependency once' }];
    const { status, report } = run(inventoryOf('MIT'), entries);
    assert.equal(
      status,
      1,
      'a stale allowlist entry must fail — otherwise the exemption outlives the dependency',
    );
    assert.match(report.failures.join('\n'), /stale allowlist entry/);
  }

  // ─── the vacuity guard: an empty inventory is a FAILURE ────────────────────
  {
    const { status, report } = run({});
    assert.equal(
      status,
      1,
      'zero packages passes trivially — it is the shape of a wrong working directory, so it must fail',
    );
    assert.match(report.failures.join('\n'), /EMPTY/);
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('license-check tests ok\n');
