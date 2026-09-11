import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CertificationEvidenceError,
  loadClientCertificationReceipts,
} from './client-certification-evidence.mjs';
import { renderClientCertificationMatrix } from './client-certification-matrix.mjs';

const SHA = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);
const CAPTURED_AT = '2026-09-08T00:00:00.000Z';

/** Every leg passing, which is what a genuine native vendor run records. */
const allPassLegs = (overrides = {}) => ({
  configuration: { status: 'pass' },
  handshake: { status: 'pass', source: 'vendor-client' },
  toolUse: { status: 'pass', source: 'vendor-client' },
  record: { status: 'pass' },
  interruption: { status: 'pass' },
  restart: { status: 'pass' },
  authorizedResume: { status: 'pass' },
  foreignPrincipalExclusion: { status: 'pass' },
  ...overrides,
});

/**
 * A version-2 certifying receipt. The matrix renderer is a pure leg-and-cell consumer, so these
 * in-memory fixtures need no artifacts on disk — the ones written out for the CLI path below do.
 */
const v2Receipt = (overrides = {}) => ({
  format: 'knowledge-crib-client-certification',
  formatVersion: 2,
  generatedAt: CAPTURED_AT,
  policySha256: SHA,
  product: { commit: COMMIT, packageSha256: SHA },
  client: { id: 'codex', version: '0.42.0', driverVersion: '1.0.0', certificationMode: 'codex' },
  platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
  runId: 'run-matrix-fixture',
  capture: { hostname: 'fixture-host', operator: 'fixture-operator', capturedAt: CAPTURED_AT },
  principalMarkers: { owner: SHA, foreign: `sha256:${'b'.repeat(64)}` },
  vendor: {
    processIdentity: 'codex 0.42.0 (/usr/local/bin/codex, pid 4711)',
    logPath: 'logs/codex.log',
    logSha256: SHA,
  },
  legs: allPassLegs(),
  ...overrides,
});

const rendered = renderClientCertificationMatrix([
  v2Receipt({
    client: { id: 'codex', version: '0.42.0', driverVersion: '1', certificationMode: 'codex' },
  }),
]);

assert.match(rendered, /\| Codex \| runtime verified \| macOS arm64 \(0\.42\.0\) \|/);
assert.match(rendered, /\| Claude Code \| not certified \| — \|/);
assert.doesNotMatch(rendered, /configuration verified.*Codex/);

// A WSL receipt (process.platform 'linux', platform.wsl true) satisfies every leg and still is not a
// native runtime, so the row discloses the run and never presents it as a native Linux pass. This is
// the same judgement the launch decision makes: the table must not contradict it.
const wslRendered = renderClientCertificationMatrix([
  v2Receipt({
    client: { id: 'cursor', version: '1.0.0', driverVersion: '1', certificationMode: 'cursor' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1', wsl: true },
  }),
]);
assert.match(
  wslRendered,
  /\| Cursor \| runtime evidence only \(not a native runtime\) \| WSL x64 \(1\.0\.0\) \|/,
);
assert.doesNotMatch(wslRendered, /\| Cursor \| runtime verified \|/);
assert.doesNotMatch(wslRendered, /Linux x64/);

// A native linux pass beside the WSL run still certifies the cell, and the row shows the stronger
// evidence — the disclosure is about the evidence displayed, not a permanent mark on the client.
const nativeBesideWsl = renderClientCertificationMatrix([
  v2Receipt({
    client: { id: 'cursor', version: '1.0.0', driverVersion: '1', certificationMode: 'cursor' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1', wsl: true },
    runId: 'run-matrix-wsl',
  }),
  v2Receipt({
    client: { id: 'cursor', version: '1.0.0', driverVersion: '1', certificationMode: 'cursor' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    runId: 'run-matrix-native',
  }),
]);
assert.match(nativeBesideWsl, /\| Cursor \| runtime verified \| Linux x64 \(1\.0\.0\) \|/);

// A Copilot-shaped test client's protocol evidence is labelled protocol evidence only and is never
// presented as a runtime claim; a vendor-client protocol probe keeps the plain label. Only a
// schema-1 receipt can express this at all: the certifying schema refuses a test-client handshake.
const testClientRendered = renderClientCertificationMatrix([
  {
    client: { id: 'copilot', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    evidence: {
      configuration: { status: 'pass' },
      protocol: { status: 'pass', source: 'test-client' },
      runtime: { status: 'not-run' },
    },
  },
]);
assert.match(testClientRendered, /\| GitHub Copilot \| protocol evidence only \(test client\) \|/);
assert.match(
  testClientRendered,
  /\| GitHub Copilot \| protocol evidence only \(test client\) \| Linux x64 \(1\.0\.0\) \|/,
);
assert.doesNotMatch(testClientRendered, /GitHub Copilot \| runtime verified/);

const vendorProtocolRendered = renderClientCertificationMatrix([
  {
    client: { id: 'copilot', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    evidence: {
      configuration: { status: 'pass' },
      protocol: { status: 'pass', source: 'vendor-client' },
      runtime: { status: 'not-run' },
    },
  },
]);
assert.match(vendorProtocolRendered, /\| GitHub Copilot \| protocol verified \|/);
// The renderer's fixed legend paragraph always explains the "protocol evidence only" label, so
// scope this check to the GitHub Copilot row rather than the whole document.
assert.doesNotMatch(vendorProtocolRendered, /\| GitHub Copilot \| protocol evidence only/);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'client-certification-matrix.mjs');
const DOCS_TEMPLATE = [
  '# capability matrix',
  '',
  '<!-- client-certification:generated:start -->',
  'stale placeholder',
  '<!-- client-certification:generated:end -->',
  '',
].join('\n');

const runMatrix = (docs, receipts, args = []) =>
  spawnSync(process.execPath, [SCRIPT, '--docs', docs, '--receipts', receipts, ...args], {
    encoding: 'utf8',
  });

/** A certifying version-2 receipt backed by a real log file under `receiptsDir`. */
function writeRuntimeReceipt(receiptsDir, name, runtime = {}) {
  mkdirSync(join(receiptsDir, 'logs'), { recursive: true });
  const logName = `${name}.log`;
  const bytes = `record -> interrupt -> restart -> authorized resume (${logName})\n`;
  writeFileSync(join(receiptsDir, 'logs', logName), bytes);
  return v2Receipt({
    runId: `run-${name}`,
    client: { id: 'codex', version: '1.0.0', driverVersion: '1.0.0', certificationMode: 'codex' },
    vendor: {
      processIdentity: 'codex 1.0.0 (/usr/local/bin/codex, pid 4711)',
      logPath: `logs/${logName}`,
      logSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
    ...runtime,
  });
}

const root = mkdtempSync(join(tmpdir(), 'crib-certification-matrix-'));
try {
  // Receipt removal flips state: a runtime-verified row degrades to not certified once its
  // receipt is gone, and --check reports the previously generated document as stale in between.
  const flipDir = join(root, 'flip');
  const flipDocs = join(root, 'flip-capability-matrix.md');
  mkdirSync(flipDir);
  writeFileSync(flipDocs, DOCS_TEMPLATE);
  writeFileSync(
    join(flipDir, 'codex-darwin.json'),
    `${JSON.stringify(writeRuntimeReceipt(flipDir, 'codex-darwin'))}\n`,
  );
  assert.equal(runMatrix(flipDocs, flipDir).status, 0);
  let flipDoc = readFileSync(flipDocs, 'utf8');
  assert.match(flipDoc, /\| Codex \| runtime verified \| macOS arm64 \(1\.0\.0\) \|/);
  assert.equal(runMatrix(flipDocs, flipDir, ['--check']).status, 0);

  unlinkSync(join(flipDir, 'codex-darwin.json'));
  const stale = runMatrix(flipDocs, flipDir, ['--check']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale/);

  assert.equal(runMatrix(flipDocs, flipDir).status, 0);
  flipDoc = readFileSync(flipDocs, 'utf8');
  assert.match(flipDoc, /\| Codex \| not certified \| — \|/);
  assert.doesNotMatch(flipDoc, /Codex \| runtime verified/);
  assert.equal(runMatrix(flipDocs, flipDir, ['--check']).status, 0);

  // Validation coupling: generation loads receipts through the validator, so a malformed receipt
  // in the directory makes it refuse rather than render a runtime-verified row.
  const refuseDir = join(root, 'refuse');
  const refuseDocs = join(root, 'refuse-capability-matrix.md');
  mkdirSync(refuseDir);
  writeFileSync(refuseDocs, DOCS_TEMPLATE);
  const malformed = writeRuntimeReceipt(refuseDir, 'codex-darwin');
  // A test client that merely speaks the protocol is the sharpest case: it can produce a transcript,
  // and the certifying schema refuses it outright rather than leaving a reader to notice.
  malformed.legs.handshake = { status: 'pass', source: 'test-client' };
  writeFileSync(join(refuseDir, 'codex-darwin.json'), `${JSON.stringify(malformed)}\n`);
  assert.throws(() => loadClientCertificationReceipts(refuseDir), CertificationEvidenceError);
  assert.throws(() => loadClientCertificationReceipts(refuseDir), /vendor-client/);
  const refused = runMatrix(refuseDocs, refuseDir);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /vendor-client/);
  assert.doesNotMatch(readFileSync(refuseDocs, 'utf8'), /runtime verified/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('client certification matrix tests ok');
