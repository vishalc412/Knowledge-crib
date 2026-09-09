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

const rendered = renderClientCertificationMatrix([
  {
    client: { id: 'codex', version: '0.42.0' },
    platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
    evidence: {
      configuration: { status: 'pass' },
      protocol: { status: 'pass' },
      runtime: { status: 'pass' },
    },
  },
]);

assert.match(rendered, /\| Codex \| runtime verified \| macOS arm64 \(0\.42\.0\) \|/);
assert.match(rendered, /\| Claude Code \| not certified \| — \|/);
assert.doesNotMatch(rendered, /configuration verified.*Codex/);

// A receipt captured under WSL (process.platform 'linux', platform.wsl true) renders WSL in its
// cell — never plain Linux.
const wslRendered = renderClientCertificationMatrix([
  {
    client: { id: 'cursor', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1', wsl: true },
    evidence: {
      configuration: { status: 'pass' },
      protocol: { status: 'pass' },
      runtime: { status: 'pass' },
    },
  },
]);
assert.match(wslRendered, /\| Cursor \| runtime verified \| WSL x64 \(1\.0\.0\) \|/);
assert.doesNotMatch(wslRendered, /Linux x64/);

// A Copilot-shaped test client's protocol evidence is labelled protocol evidence only and is
// never presented as a runtime claim; a vendor-client protocol probe keeps the plain label.
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

function writeRuntimeReceipt(receiptsDir, name, runtime = {}) {
  mkdirSync(join(receiptsDir, 'logs'), { recursive: true });
  const logName = `${name}.log`;
  const bytes = `record -> interrupt -> authorized resume (${logName})\n`;
  writeFileSync(join(receiptsDir, 'logs', logName), bytes);
  return {
    format: 'knowledge-crib-client-certification',
    formatVersion: 1,
    generatedAt: '2026-09-08T00:00:00.000Z',
    // A runtime pass records the launch policy it was collected under and names who ran it: a
    // digest proves a file is unchanged, never who produced it.
    policySha256: `sha256:${'a'.repeat(64)}`,
    product: { commit: 'a'.repeat(40), packageSha256: `sha256:${'a'.repeat(64)}` },
    client: { id: 'codex', version: '1.0.0' },
    platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
    evidence: {
      configuration: { status: 'pass', configSha256: `sha256:${'a'.repeat(64)}` },
      protocol: {
        status: 'pass',
        transcriptSha256: `sha256:${'a'.repeat(64)}`,
        source: 'vendor-client',
      },
      runtime: {
        status: 'pass',
        source: 'vendor-client',
        recordedMemory: true,
        interrupted: true,
        authorizedResume: true,
        foreignPrincipalExcluded: true,
        logSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        logPath: `logs/${logName}`,
        attestation: {
          operator: 'fixture-operator',
          host: 'fixture-host',
          capturedAt: '2026-09-08T00:00:00.000Z',
        },
        ...runtime,
      },
    },
  };
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
  malformed.evidence.runtime.source = 'simulated-client';
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
