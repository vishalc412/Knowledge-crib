import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CERTIFIED_CLIENTS,
  CertificationEvidenceError,
  certificationSummary,
  loadClientCertificationReceipts,
  validateClientCertificationReceipt,
} from './client-certification-evidence.mjs';

const SHA = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);
const receipt = (overrides = {}) => ({
  format: 'knowledge-crib-client-certification',
  formatVersion: 1,
  generatedAt: '2026-09-08T00:00:00.000Z',
  product: { commit: COMMIT, packageSha256: SHA },
  client: { id: 'codex', version: '1.0.0' },
  platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
  evidence: {
    configuration: { status: 'pass', configSha256: SHA },
    protocol: { status: 'pass', transcriptSha256: SHA },
    runtime: {
      status: 'pass',
      source: 'vendor-client',
      recordedMemory: true,
      interrupted: true,
      authorizedResume: true,
      logSha256: SHA,
    },
  },
  ...overrides,
});

assert.deepEqual(CERTIFIED_CLIENTS, [
  'claude',
  'copilot',
  'cursor',
  'codex',
  'windsurf',
  'gemini',
  'vscode',
]);

assert.deepEqual(validateClientCertificationReceipt(receipt()), receipt());
const configuredOnly = receipt({
  evidence: {
    configuration: { status: 'pass', configSha256: SHA },
    protocol: { status: 'not-run' },
    runtime: { status: 'not-run' },
  },
});
assert.deepEqual(validateClientCertificationReceipt(configuredOnly), configuredOnly);
assert.throws(
  () => validateClientCertificationReceipt(receipt({ client: { id: 'made-up', version: '1' } })),
  CertificationEvidenceError,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({
        evidence: {
          ...receipt().evidence,
          runtime: { ...receipt().evidence.runtime, source: 'simulated-client' },
        },
      }),
    ),
  /vendor-client/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({
        evidence: {
          ...receipt().evidence,
          runtime: { ...receipt().evidence.runtime, authorizedResume: false },
        },
      }),
    ),
  /authorized resume/,
);

const root = mkdtempSync(join(tmpdir(), 'crib-certification-evidence-'));
try {
  const dir = join(root, 'receipts');
  mkdirSync(dir);
  writeFileSync(join(dir, 'codex-darwin.json'), `${JSON.stringify(receipt())}\n`);
  writeFileSync(
    join(dir, 'cursor-linux.json'),
    `${JSON.stringify(receipt({ client: { id: 'cursor', version: '1.0.0' }, platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' }, evidence: configuredOnly.evidence }))}\n`,
  );
  const receipts = loadClientCertificationReceipts(dir);
  assert.equal(receipts.length, 2);
  assert.deepEqual(certificationSummary(receipts), {
    claude: 'not-certified',
    copilot: 'not-certified',
    cursor: 'configuration-verified',
    codex: 'runtime-verified',
    windsurf: 'not-certified',
    gemini: 'not-certified',
    vscode: 'not-certified',
  });

  writeFileSync(join(dir, 'codex-darwin-duplicate.json'), `${JSON.stringify(receipt())}\n`);
  assert.throws(() => loadClientCertificationReceipts(dir), /duplicate certification cell/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('client certification evidence tests ok');
