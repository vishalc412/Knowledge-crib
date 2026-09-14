/**
 * Acceptance-receipt validator v2 (Task 2 regressions).
 *
 * The v1 envelope could certify anything: a receipt with no candidate package, no run identity,
 * no command exit codes, and artifacts resolved by ANY path — including absolute paths and
 * symlinks pointing outside the evidence root. Duplicate receipt types were last-wins in two
 * different collectors. These tests pin every one of those defects closed, and pin that a
 * complete v2 receipt backed by real bytes produces NO problems.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_RECEIPT_FORMAT,
  ACCEPTANCE_RECEIPT_FORMAT_VERSION,
  SUPPORTED_ACCEPTANCE_FORMAT_VERSIONS,
  acceptanceReceiptProblems,
  nodeMajorOf,
} from './acceptance-receipt.mjs';
import { loadLaunchPolicy } from './launch-policy.mjs';
import { ReleaseEvidenceError, collectReceipts } from './release-evidence.mjs';
import { buildReceipt } from './write-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { policy } = loadLaunchPolicy();

const COMMIT = 'a'.repeat(40);
const PACKAGE = `sha256:${'b'.repeat(64)}`;
const POLICY_SHA = `sha256:${'c'.repeat(64)}`;
const CAPTURED_AT = '2026-09-09T00:00:00.000Z';

const root = mkdtempSync(join(tmpdir(), 'acceptance-receipt-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const evidenceDir = join(root, 'evidence');
mkdirSync(evidenceDir, { recursive: true });

const sha256Of = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const cell = { os: 'linux', nodeMajor: 22 };

/** A complete v2 receipt for one type, backed by REAL bytes in `evidenceDir`. */
function receipt(type, overrides = {}) {
  const bytes = `acceptance-${type} pass\n`;
  writeFileSync(join(evidenceDir, `${type}.log`), bytes);
  return {
    format: ACCEPTANCE_RECEIPT_FORMAT,
    formatVersion: 2,
    type,
    status: 'pass',
    recordedAt: CAPTURED_AT,
    runId: `run-${type}`,
    candidateCommit: COMMIT,
    candidatePackageSha256: PACKAGE,
    policySha256: POLICY_SHA,
    command: `pnpm ${type}`,
    commandResults: [{ command: `pnpm ${type}`, exitCode: 0 }],
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    runner: { provider: 'github-actions', runId: '1' },
    artifacts: [{ path: `${type}.log`, sha256: sha256Of(bytes) }],
    ...(type === 'freshness'
      ? { p95Ms: policy.freshness.p95TargetMs - 1, workload: policy.freshness.workload }
      : {}),
    ...overrides,
  };
}

const candidate = { commit: COMMIT, packageSha256: PACKAGE };

function problems(type, overrides = {}, optionsOverrides = {}) {
  return acceptanceReceiptProblems(receipt(type, overrides), {
    type,
    candidate,
    policySha256: POLICY_SHA,
    policy,
    cell,
    evidenceRoot: evidenceDir,
    ...optionsOverrides,
  });
}

// ── a complete v2 receipt certifies ──────────────────────────────────────────────────────────────
assert.deepEqual(problems('install'), [], 'a complete v2 receipt must produce no problems');
assert.deepEqual(
  problems('freshness'),
  [],
  'a passing freshness receipt inside the p95 target certifies',
);

// ── format and version gates ─────────────────────────────────────────────────────────────────────
assert.match(
  problems('install', { format: 'someone-elses-receipt' }).join('\n'),
  /receipt-unknown-format:install:someone-elses-receipt/,
);
// v1 stays READABLE but never certifies: the schema gate fires before any fact is judged.
assert.match(
  problems('install', { formatVersion: 1 }).join('\n'),
  /receipt-schema-non-certifying:install:v1/,
);
assert.deepEqual(SUPPORTED_ACCEPTANCE_FORMAT_VERSIONS, [1, 2], 'v1 manifests must remain readable');
assert.equal(ACCEPTANCE_RECEIPT_FORMAT_VERSION, 2);

// ── identity gates: a receipt must describe THIS candidate under THIS policy ─────────────────────
assert.match(
  problems('install', { candidateCommit: 'e'.repeat(40) }).join('\n'),
  /receipt-foreign-commit:install/,
);
assert.match(
  problems('install', { candidateCommit: undefined }).join('\n'),
  /receipt-foreign-commit:install/,
);
assert.match(
  problems('install', { candidatePackageSha256: `sha256:${'9'.repeat(64)}` }).join('\n'),
  /receipt-foreign-package:install/,
);
assert.match(
  problems('install', { candidatePackageSha256: undefined }).join('\n'),
  /receipt-foreign-package:install/,
);
assert.match(
  problems('install', { policySha256: `sha256:${'9'.repeat(64)}` }).join('\n'),
  /receipt-foreign-policy:install/,
);
assert.match(
  problems('install', { type: 'browser' }).join('\n'),
  /receipt-type-mismatch:install:browser/,
);

// ── cell gates: the receipt's platform must match the cell it is offered to ───────────────────────
assert.match(
  problems('install', { platform: { os: 'darwin', arch: 'x64', node: 'v22.23.1' } }).join('\n'),
  /receipt-platform-mismatch:install:darwin/,
);
assert.match(
  problems('install', { platform: { os: 'linux', arch: 'x64', node: 'v24.1.0' } }).join('\n'),
  /receipt-node-mismatch:install:v24\.1\.0/,
);
assert.equal(nodeMajorOf('v22.23.1'), 22);
assert.equal(nodeMajorOf('v24'), 24);
assert.equal(nodeMajorOf(undefined), undefined);
assert.equal(nodeMajorOf('not-a-version'), undefined);

// ── run identity and command results: pass/fail must be recomputed from facts ─────────────────────
assert.match(
  problems('install', { runId: undefined }).join('\n'),
  /receipt-run-identity-missing:install/,
);
assert.match(problems('install', { runId: '' }).join('\n'), /receipt-run-identity-missing:install/);
assert.match(
  problems('install', { commandResults: [] }).join('\n'),
  /receipt-exit-code-missing:install/,
);
assert.match(
  problems('install', { commandResults: undefined }).join('\n'),
  /receipt-exit-code-missing:install/,
);
assert.match(
  problems('install', { commandResults: [{ command: 'pnpm install', exitCode: 'zero' }] }).join(
    '\n',
  ),
  /receipt-exit-code-missing:install/,
);
// A nonzero exit code must not be laundered by a hand-written status: pass.
assert.match(
  problems('install', { commandResults: [{ command: 'pnpm install', exitCode: 1 }] }).join('\n'),
  /receipt-status-contradiction:install:pass/,
);
// Multi-command checks archive EVERY constituent command result; one nonzero exit is a fail.
assert.match(
  problems('security-privacy', {
    commandResults: [
      { command: 'pnpm security:battery', exitCode: 0 },
      { command: 'pnpm security:check', exitCode: 2 },
    ],
  }).join('\n'),
  /receipt-status-contradiction:security-privacy:pass/,
);
assert.match(
  problems('security-privacy', {
    status: 'fail',
    commandResults: [
      { command: 'pnpm security:battery', exitCode: 0 },
      { command: 'pnpm security:check', exitCode: 2 },
    ],
  }).join('\n'),
  /receipt-not-passing:security-privacy:fail/,
);
// A failed receipt is judged as not-passing without artifact verification.
assert.deepEqual(
  problems('install', {
    status: 'fail',
    artifacts: [],
    commandResults: [{ command: 'pnpm install', exitCode: 1 }],
  }),
  ['receipt-not-passing:install:fail'],
);

// ── artifact gates: the bytes must exist, inside the evidence root, with the recorded digest ─────
assert.match(problems('install', { artifacts: [] }).join('\n'), /receipt-artifact-missing:install/);
assert.match(
  problems('install', {
    artifacts: [{ path: 'install.log', sha256: `sha256:${'0'.repeat(64)}` }],
  }).join('\n'),
  /receipt-artifact-digest:install:install\.log/,
);
// A deleted log is a missing artifact, named by path.
assert.match(
  problems('install', { artifacts: [{ path: 'gone.log', sha256: sha256Of('x') }] }).join('\n'),
  /receipt-artifact-missing:install:gone\.log/,
);
// No evidence root means the artifact bytes CANNOT be verified — that is a blocker, not a skip.
assert.match(
  problems('install', {}, { evidenceRoot: undefined }).join('\n'),
  /receipt-artifact-unverifiable:install/,
);
// A --receipts-root that is not there (a typo) is the same verdict — a NAMED blocker, not the
// ENOENT crash acceptanceReceiptProblems used to throw from insideRoot's realpathSync(root).
assert.match(
  problems('install', {}, { evidenceRoot: join(root, 'does-not-exist') }).join('\n'),
  /receipt-artifact-unverifiable:install/,
);
// An artifact entry that names a DIRECTORY inside the root: the bytes cannot be read, so the
// digest cannot match — a named blocker, not the EISDIR the validator used to throw.
mkdirSync(join(evidenceDir, 'logs'));
assert.match(
  problems('install', { artifacts: [{ path: 'logs', sha256: sha256Of('x') }] }).join('\n'),
  /receipt-artifact-digest:install:logs/,
);
// Path traversal out of the root is refused even when the digest is real.
const outsideBytes = 'bytes outside the evidence root\n';
writeFileSync(join(root, 'outside.log'), outsideBytes);
assert.match(
  problems('install', {
    artifacts: [{ path: '../outside.log', sha256: sha256Of(outsideBytes) }],
  }).join('\n'),
  /receipt-artifact-outside-root:install:\.\.\/outside\.log/,
);
// A symlink INSIDE the root that escapes it is refused too.
symlinkSync(join(root, 'outside.log'), join(evidenceDir, 'escape.log'));
assert.match(
  problems('install', { artifacts: [{ path: 'escape.log', sha256: sha256Of(outsideBytes) }] }).join(
    '\n',
  ),
  /receipt-artifact-outside-root:install:escape\.log/,
);
// An absolute path pointing at real bytes outside the root is refused as well.
assert.match(
  problems('install', {
    artifacts: [{ path: join(root, 'outside.log'), sha256: sha256Of(outsideBytes) }],
  }).join('\n'),
  /receipt-artifact-outside-root/,
);

// ── freshness measurements stay judged (existing blocker names) ──────────────────────────────────
assert.match(
  problems('freshness', { p95Ms: policy.freshness.p95TargetMs + 1 }).join('\n'),
  /freshness-p95-exceeded:/,
);
assert.match(problems('freshness', { p95Ms: Number.NaN }).join('\n'), /freshness-p95-not-finite/);
assert.match(
  problems('freshness', { workload: 'some-other-workload' }).join('\n'),
  /freshness-workload-mismatch:some-other-workload/,
);

// ── the writer emits v2: package required, exit codes archived, status derived ────────────────────
const pkgBytes = 'a fake candidate tarball\n';
const pkgPath = join(root, 'candidate.tgz');
writeFileSync(pkgPath, pkgBytes);
const logPath = join(evidenceDir, 'writer.log');
writeFileSync(logPath, 'step output\n');

// --package is now REQUIRED: a receipt that binds no package certifies nothing.
assert.throws(
  () =>
    buildReceipt({
      type: 'install',
      argv: ['--command', 'pnpm x', '--exit-code', '0', '--artifact', logPath],
    }),
  /--package is required/,
);
// At least one --command/--exit-code pair is required: with no commands at all the writer refuses
// before the count check, so an empty commandResults array can never be written as a pass.
assert.throws(
  () => buildReceipt({ type: 'install', argv: ['--package', pkgPath, '--artifact', logPath] }),
  /at least one --command/,
);
// Command and exit-code counts must agree.
assert.throws(
  () =>
    buildReceipt({
      type: 'install',
      argv: [
        '--package',
        pkgPath,
        '--artifact',
        logPath,
        '--command',
        'pnpm x',
        '--exit-code',
        '0',
        '--command',
        'pnpm y',
      ],
    }),
  /same number of times/,
);
// A nonexistent artifact still refuses.
assert.throws(
  () =>
    buildReceipt({
      type: 'install',
      argv: [
        '--package',
        pkgPath,
        '--command',
        'pnpm x',
        '--exit-code',
        '0',
        '--artifact',
        join(root, 'nope.log'),
      ],
    }),
  /does not exist/,
);
// --artifact-root resolves a RELATIVE path for existence/digest while the receipt stores it
// verbatim: the collector writes `logs/<type>.log` entries, so the evidence tree certifies from
// any copy of itself — a machine-absolute path only certifies on the machine it was written on.
const relocated = buildReceipt({
  type: 'install',
  argv: [
    '--package',
    pkgPath,
    '--command',
    'pnpm x',
    '--exit-code',
    '0',
    '--artifact-root',
    evidenceDir,
    '--artifact',
    'writer.log',
  ],
});
assert.equal(
  relocated.artifacts[0].path,
  'writer.log',
  'the path is stored verbatim, not absolutized',
);
assert.equal(relocated.artifacts[0].sha256, sha256Of('step output\n'));
assert.throws(
  () =>
    buildReceipt({
      type: 'install',
      argv: [
        '--package',
        pkgPath,
        '--command',
        'pnpm x',
        '--exit-code',
        '0',
        '--artifact-root',
        evidenceDir,
        '--artifact',
        'nope.log',
      ],
    }),
  /does not exist/,
);

const single = buildReceipt({
  type: 'install',
  argv: [
    '--package',
    pkgPath,
    '--artifact',
    logPath,
    '--command',
    'pnpm installer:smoke-userdir',
    '--exit-code',
    '0',
  ],
});
assert.equal(single.formatVersion, 2, 'the writer must emit formatVersion 2');
assert.equal(single.format, ACCEPTANCE_RECEIPT_FORMAT);
assert.equal(single.candidatePackageSha256, sha256Of(pkgBytes));
assert.ok(typeof single.runId === 'string' && single.runId, 'v2 receipts must carry run identity');
assert.deepEqual(single.commandResults, [{ command: 'pnpm installer:smoke-userdir', exitCode: 0 }]);
assert.equal(single.status, 'pass', 'all-zero exit codes derive status pass');
assert.equal(single.command, 'pnpm installer:smoke-userdir');

const multi = buildReceipt({
  type: 'security-privacy',
  argv: [
    '--package',
    pkgPath,
    '--artifact',
    logPath,
    '--command',
    'pnpm security:battery',
    '--exit-code',
    '0',
    '--command',
    'pnpm security:check',
    '--exit-code',
    '0',
  ],
});
assert.equal(multi.status, 'pass');
assert.deepEqual(multi.commandResults, [
  { command: 'pnpm security:battery', exitCode: 0 },
  { command: 'pnpm security:check', exitCode: 0 },
]);
assert.equal(multi.command, 'pnpm security:battery && pnpm security:check');

const failed = buildReceipt({
  type: 'install',
  argv: ['--package', pkgPath, '--command', 'pnpm installer:smoke-userdir', '--exit-code', '1'],
});
assert.equal(failed.status, 'fail', 'a nonzero exit code derives status fail');
assert.equal(failed.artifacts.length, 0, 'a failing receipt needs no artifact');

// A hand-written --status must AGREE with the derived one.
assert.throws(
  () =>
    buildReceipt({
      type: 'install',
      argv: [
        '--package',
        pkgPath,
        '--command',
        'pnpm x',
        '--exit-code',
        '0',
        '--artifact',
        logPath,
        '--status',
        'fail',
      ],
    }),
  /contradicts/,
);
assert.throws(
  () =>
    buildReceipt({
      type: 'install',
      argv: [
        '--package',
        pkgPath,
        '--command',
        'pnpm x',
        '--exit-code',
        '1',
        '--status',
        'pass',
        '--artifact',
        logPath,
      ],
    }),
  /contradicts/,
);
// An explicit --status that agrees is accepted (back-compat for single-command callers).
assert.equal(
  buildReceipt({
    type: 'install',
    argv: [
      '--package',
      pkgPath,
      '--command',
      'pnpm x',
      '--exit-code',
      '0',
      '--artifact',
      logPath,
      '--status',
      'pass',
    ],
  }).status,
  'pass',
);
// --run-id is honored when supplied (one id shared by a whole pass).
const chosenId = randomUUID();
assert.equal(
  buildReceipt({
    type: 'install',
    argv: [
      '--package',
      pkgPath,
      '--command',
      'pnpm x',
      '--exit-code',
      '0',
      '--artifact',
      logPath,
      '--run-id',
      chosenId,
    ],
  }).runId,
  chosenId,
);

// ── collectReceipts rejects duplicate receipt types (last-wins used to hide a stale pair) ─────────
const dupDir = join(root, 'dup');
mkdirSync(dupDir);
const dupReceipt = (name) =>
  JSON.stringify({
    format: ACCEPTANCE_RECEIPT_FORMAT,
    formatVersion: 2,
    type: 'install',
    status: 'pass',
    recordedAt: CAPTURED_AT,
    runId: name,
    candidateCommit: COMMIT,
    candidatePackageSha256: PACKAGE,
    policySha256: POLICY_SHA,
    command: 'pnpm install',
    commandResults: [{ command: 'pnpm install', exitCode: 0 }],
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    runner: { provider: 'local', host: 'test' },
    artifacts: [],
  });
writeFileSync(join(dupDir, 'a.json'), `${dupReceipt('run-a')}\n`);
writeFileSync(join(dupDir, 'b.json'), `${dupReceipt('run-b')}\n`);
assert.throws(
  () => collectReceipts(['--receipts', dupDir]),
  (error) => error instanceof ReleaseEvidenceError && /duplicate/i.test(error.message),
  'two receipts declaring the same type must be a structural refusal',
);

console.log('acceptance receipt tests ok');
