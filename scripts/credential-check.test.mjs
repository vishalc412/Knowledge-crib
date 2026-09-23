/**
 * Unit tests for the WP3 credential/secret check.
 *
 * Same discipline as boundaries-check.test.mjs: the gate is an executable, so it is driven as a
 * subprocess against SYNTHETIC trees in a tmpdir, and every rule is shown both FIRING on a violating
 * fixture and staying QUIET on its compliant twin. A scanner that fails on everything and one that
 * fails on nothing are equally useless, and only the twin tells them apart.
 *
 * Two properties here are about the GATE rather than its subject, and both are load-bearing:
 *   - REDACTION. A finding must never print the matched value. A scanner that logs the credential
 *     while reporting it has leaked exactly what it was run to prevent, so the test plants a value
 *     and asserts the value is absent from the scanner's own output.
 *   - THE DOCUMENTED LIMITS ARE TESTED, not assumed. The git path reads tracked files only, so an
 *     untracked file is NOT scanned — asserted here so the blind spot is pinned as behaviour rather
 *     than trusted to a docblock; and the walk fallback is asserted to actually find hits, so
 *     "not a git work tree" cannot silently mean "nothing scanned".
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'credential-check.mjs');

/** Build a tree under a fresh tmpdir. `files` maps repo-relative paths to contents.
 *  `stage` picks which of them git should track; the rest are left untracked on purpose, so the
 *  "tracked only" limit can be pinned as behaviour. Omitting `stage` with `git: true` stages all. */
function fixture(files, entries = [], { git = false, stage } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'credential-check-'));
  const write = (rel, body) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  write('scripts/credential-scan-allowlist.json', JSON.stringify({ entries }, null, 2));
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  if (git) {
    const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    run(['init', '-q']);
    // `git add -A` would stage every fixture file, and a STAGED file IS tracked — which would make
    // the untracked-limit test below vacuous by staging the very file it means to leave out.
    for (const rel of stage ?? Object.keys(files)) run(['add', rel]);
  }
  return root;
}

/** Run the gate against a fixture and return { status, report, stdout }. */
function run(root) {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [CHECK, '--root', root, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    stdout = error.stdout ?? '';
    status = error.status;
  }
  return { status, stdout, report: JSON.parse(stdout) };
}

const roots = [];
const withFixture = (...args) => {
  const root = fixture(...args);
  roots.push(root);
  return root;
};

// A shape-valid but entirely invented AWS key id: AKIA + 16 upper-case alphanumerics. Written out so
// the fixtures below read as fixtures; it is not a credential and never was one.
const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

try {
  // ─── the compliant twin: env indirection, prose values, placeholders ────────
  {
    const root = withFixture({
      'packages/a/src/one.ts': [
        'const AWS_KEY = process.env.AWS_KEY;',
        "const password = 'none';",
        'const token = "<your-token-here>";',
        'const opaque = "abcdefghijklmnopqrst";',
        'export { AWS_KEY, password, token, opaque };',
        '',
      ].join('\n'),
    });
    const { status, report } = run(root);
    assert.equal(status, 0, `compliant source must pass; got ${JSON.stringify(report.failures)}`);
    assert.equal(report.findings.length, 0, 'no finding may be raised for the compliant twin');
  }

  // ─── a planted key fails, and the gate does not echo it ─────────────────────
  {
    const root = withFixture({
      'packages/a/src/leak.ts': `const key = '${FAKE_AWS_KEY}';\nexport { key };\n`,
    });
    const { status, stdout, report } = run(root);
    assert.equal(status, 1, 'a credential-shaped literal must fail the check');
    assert.deepEqual(
      report.findings.map((f) => f.pattern),
      ['aws-access-key-id'],
    );
    // The security property of the gate itself.
    assert.ok(
      !stdout.includes(FAKE_AWS_KEY),
      'the scanner must never print the matched value — that would leak it into the log',
    );
    assert.ok(
      report.findings[0].redacted.includes('chars'),
      'a finding must still carry something an operator can rotate against',
    );
  }

  // ─── a PEM block fails ──────────────────────────────────────────────────────
  {
    const root = withFixture({
      'keys/sample.pem':
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEow…\n-----END RSA PRIVATE KEY-----\n',
    });
    const { status, report } = run(root);
    assert.equal(status, 1);
    assert.deepEqual(
      report.findings.map((f) => f.pattern),
      ['private-key-block'],
    );
  }

  // ─── an allowlist entry silences a hit, and carries its reason ──────────────
  {
    const entries = [
      {
        path: 'packages/a/src/fixture.ts',
        pattern: 'aws-access-key-id',
        reason: 'synthetic fixture for a redaction test',
      },
    ];
    const root = withFixture(
      { 'packages/a/src/fixture.ts': `const key = '${FAKE_AWS_KEY}';\n` },
      entries,
    );
    const { status, report } = run(root);
    assert.equal(status, 0, 'an allowlisted hit must not fail the check');
    assert.equal(report.findings[0].allowlisted, true);
    assert.equal(report.findings[0].reason, 'synthetic fixture for a redaction test');
  }

  // ─── the ratchet: an entry that excepts nothing FAILS ───────────────────────
  {
    const entries = [
      { path: 'packages/a/src/gone.ts', pattern: 'aws-access-key-id', reason: 'was a fixture' },
    ];
    const root = withFixture({ 'packages/a/src/clean.ts': 'export const a = 1;\n' }, entries);
    const { status, report } = run(root);
    assert.equal(
      status,
      1,
      'a stale allowlist entry must fail — otherwise the exemption outlives the thing it excepted',
    );
    assert.match(report.failures.join('\n'), /stale allowlist entry/);
  }

  // ─── the git path reads TRACKED files; untracked is the documented blind spot ─
  {
    const root = withFixture(
      {
        'packages/a/src/tracked.ts': 'export const a = 1;\n',
        'packages/a/src/untracked.ts': `const key = '${FAKE_AWS_KEY}';\n`,
      },
      [],
      { git: true, stage: ['packages/a/src/tracked.ts'] },
    );
    const { status, report } = run(root);
    assert.equal(report.scannedVia, 'git ls-files', 'a work tree root must take the git path');
    assert.equal(
      report.textFilesScanned,
      1,
      'exactly the one STAGED file may be read — a git path that read nothing would pass the assertion below for the wrong reason',
    );
    assert.equal(
      status,
      0,
      'the untracked file is NOT scanned: that is the stated limit, pinned here so it is behaviour rather than a promise',
    );
  }

  // ─── the fallback finds hits, so "no work tree" cannot mean "nothing scanned" ─
  {
    const root = withFixture({
      'packages/a/src/leak.ts': `const key = '${FAKE_AWS_KEY}';\n`,
    });
    const { status, report } = run(root);
    assert.match(report.scannedVia, /directory walk/);
    assert.equal(status, 1, 'the walk fallback must still find the planted key');
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('credential-check tests ok\n');
