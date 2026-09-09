import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CERTIFIED_CLIENTS,
  CertificationEvidenceError,
  certificationSummary,
  loadClientCertificationReceipts,
  missingRuntimeCertificationCells,
  validateClientCertificationReceipt,
} from './client-certification-evidence.mjs';

const SHA = `sha256:${'a'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);
const notRun = { status: 'not-run' };
/** Attribution for a runtime pass: who ran it, on what host, and when. */
const attestation = {
  operator: 'fixture-operator',
  host: 'fixture-host',
  capturedAt: '2026-09-08T00:00:00.000Z',
};
const receipt = (overrides = {}) => ({
  format: 'knowledge-crib-client-certification',
  formatVersion: 1,
  generatedAt: '2026-09-08T00:00:00.000Z',
  policySha256: SHA,
  product: { commit: COMMIT, packageSha256: SHA },
  client: { id: 'codex', version: '1.0.0' },
  platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
  evidence: {
    configuration: { status: 'pass', configSha256: SHA },
    protocol: notRun,
    runtime: notRun,
  },
  ...overrides,
});
const configuration = { status: 'pass', configSha256: SHA };
const vendorProtocol = { status: 'pass', transcriptSha256: SHA, source: 'vendor-client' };

assert.deepEqual(CERTIFIED_CLIENTS, [
  'claude',
  'copilot',
  'cursor',
  'codex',
  'windsurf',
  'gemini',
  'vscode',
]);

// Backward compatibility: receipts predating platform.wsl and protocol.source still validate —
// a missing platform.wsl means false and a not-run protocol tier carries no claim to attribute.
assert.deepEqual(validateClientCertificationReceipt(receipt()), receipt());

assert.throws(
  () => validateClientCertificationReceipt(receipt({ client: { id: 'made-up', version: '1' } })),
  CertificationEvidenceError,
);
assert.throws(
  () => validateClientCertificationReceipt(receipt({ formatVersion: 2 })),
  /receipt version/,
);
assert.throws(
  () => validateClientCertificationReceipt(receipt({ generatedAt: 'yesterday' })),
  /ISO-8601/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({ product: { commit: 'a'.repeat(39), packageSha256: SHA } }),
    ),
  /bad commit/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({ product: { commit: COMMIT, packageSha256: 'not-a-sha' } }),
    ),
  /sha256 digest/,
);
assert.throws(
  () => validateClientCertificationReceipt(receipt({ client: { id: 'codex', version: '' } })),
  /client.version/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({ platform: { os: 'freebsd', arch: 'arm64', node: 'v22.23.1' } }),
    ),
  /platform/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({ platform: { os: 'darwin', arch: 'arm64', node: '22.23.1' } }),
    ),
  /platform.node/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({
        evidence: {
          configuration: { status: 'fail', configSha256: SHA },
          protocol: notRun,
          runtime: notRun,
        },
      }),
    ),
  /must pass/,
);

// Protocol provenance: a protocol pass must declare vendor-client or test-client.
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({
        evidence: {
          configuration,
          protocol: { status: 'pass', transcriptSha256: SHA },
          runtime: notRun,
        },
      }),
    ),
  /must declare its source/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({
        evidence: {
          configuration,
          protocol: { status: 'pass', transcriptSha256: SHA, source: 'nonsense' },
          runtime: notRun,
        },
      }),
    ),
  /must declare its source/,
);

// platform.wsl is optional but must be a boolean and only ever set on linux receipts.
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({ platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1', wsl: 'yes' } }),
    ),
  /platform.wsl must be a boolean/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({ platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1', wsl: true } }),
    ),
  /platform.wsl is only valid on linux/,
);

const root = mkdtempSync(join(tmpdir(), 'crib-certification-evidence-'));
try {
  const dir = join(root, 'receipts');
  mkdirSync(dir);
  const writeArtifact = (base, name, bytes) => {
    mkdirSync(join(base, 'logs'), { recursive: true });
    writeFileSync(join(base, 'logs', name), bytes);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  };
  const logBytes = 'record -> interrupt -> restart -> authorized resume\n';
  const logSha256 = writeArtifact(dir, 'codex-runtime.log', logBytes);
  const vendorRuntime = {
    status: 'pass',
    source: 'vendor-client',
    recordedMemory: true,
    interrupted: true,
    authorizedResume: true,
    foreignPrincipalExcluded: true,
    attestation,
    logSha256,
    logPath: 'logs/codex-runtime.log',
  };
  const runtimeReceipt = (runtime) =>
    receipt({
      evidence: {
        configuration,
        protocol: vendorProtocol,
        runtime,
      },
    });
  const vendorReceipt = runtimeReceipt(vendorRuntime);
  assert.deepEqual(
    validateClientCertificationReceipt(vendorReceipt, { evidenceRoot: dir }),
    vendorReceipt,
  );

  // A runtime pass must record the launch policy it was collected under: requirements change, and
  // a receipt taken under looser ones must not silently satisfy the stricter promise (A02).
  assert.throws(() => {
    const { policySha256: _dropped, ...withoutPolicy } = runtimeReceipt(vendorRuntime);
    return validateClientCertificationReceipt(withoutPolicy, { evidenceRoot: dir });
  }, /policySha256/);

  // Attribution: a digest proves a file is unchanged, never who produced it. A runtime pass names
  // its operator, host and capture time so a self-authored run is identifiable AS one.
  for (const field of ['operator', 'host', 'capturedAt']) {
    assert.throws(
      () => {
        const { [field]: _missing, ...partial } = attestation;
        return validateClientCertificationReceipt(
          runtimeReceipt({ ...vendorRuntime, attestation: partial }),
          { evidenceRoot: dir },
        );
      },
      new RegExp(`runtime\\.attestation\\.${field} is required`),
    );
  }
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, attestation: undefined }),
        { evidenceRoot: dir },
      ),
    /must carry an attestation/,
  );

  // The vendor-client law: a runtime pass from anything else — including a test client that
  // merely speaks the client's protocol — is rejected.
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, source: 'simulated-client' }),
        { evidenceRoot: dir },
      ),
    /vendor-client/,
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, source: 'test-client' }),
        {
          evidenceRoot: dir,
        },
      ),
    /vendor-client/,
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, authorizedResume: false }),
        { evidenceRoot: dir },
      ),
    /authorized resume/,
  );

  // The principal boundary gates the pass, both ways: a receipt whose exclusion leg failed, and a
  // receipt predating the leg entirely, are refused — the cell must be re-collected.
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, foreignPrincipalExcluded: false }),
        { evidenceRoot: dir },
      ),
    /foreign principal/,
  );
  assert.throws(() => {
    const { foreignPrincipalExcluded: _absent, ...predating } = vendorRuntime;
    return validateClientCertificationReceipt(runtimeReceipt(predating), { evidenceRoot: dir });
  }, /foreign principal/);

  // Receipt-contract tightening: a hand-typed minimal vendor-client receipt cannot pass. The
  // referenced transcript or log file must exist under the receipts area and match its digest.
  const minimalRuntime = { ...vendorRuntime };
  minimalRuntime.logPath = undefined;
  assert.throws(
    () => validateClientCertificationReceipt(runtimeReceipt(minimalRuntime), { evidenceRoot: dir }),
    /transcriptPath or logPath/,
  );
  assert.throws(
    () => validateClientCertificationReceipt(runtimeReceipt(vendorRuntime)),
    /evidence root/,
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, logPath: '../escape.log' }),
        { evidenceRoot: dir },
      ),
    /escapes the receipts area/,
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, logPath: 'logs/absent.log' }),
        { evidenceRoot: dir },
      ),
    /missing from the receipts area/,
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, logSha256: `sha256:${'b'.repeat(64)}` }),
        { evidenceRoot: dir },
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({
          ...vendorRuntime,
          logPath: 'logs/codex-runtime.log',
          logSha256: 'not-a-sha',
        }),
        { evidenceRoot: dir },
      ),
    /sha256 digest/,
  );

  // A WSL receipt (process.platform reports 'linux') validates and certifies its client, but it
  // can never satisfy the native-linux runtime certification cell.
  const wslLogSha256 = writeArtifact(dir, 'cursor-wsl.log', 'wsl runtime transcript\n');
  const wslReceipt = receipt({
    client: { id: 'cursor', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1', wsl: true },
    evidence: {
      configuration,
      protocol: vendorProtocol,
      runtime: {
        status: 'pass',
        source: 'vendor-client',
        recordedMemory: true,
        interrupted: true,
        authorizedResume: true,
        foreignPrincipalExcluded: true,
        attestation,
        logSha256: wslLogSha256,
        logPath: 'logs/cursor-wsl.log',
      },
    },
  });
  assert.deepEqual(
    validateClientCertificationReceipt(wslReceipt, { evidenceRoot: dir }),
    wslReceipt,
  );
  assert.equal(certificationSummary([wslReceipt]).cursor, 'runtime-verified');
  assert.ok(missingRuntimeCertificationCells([wslReceipt]).includes('cursor/linux'));

  // Contrast: a native linux runtime pass does satisfy the native-linux cell.
  const nativeLogSha256 = writeArtifact(dir, 'cursor-native.log', 'native linux transcript\n');
  const nativeLinuxReceipt = receipt({
    client: { id: 'cursor', version: '1.0.0' },
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
    evidence: {
      configuration,
      protocol: vendorProtocol,
      runtime: {
        status: 'pass',
        source: 'vendor-client',
        recordedMemory: true,
        interrupted: true,
        authorizedResume: true,
        foreignPrincipalExcluded: true,
        attestation,
        logSha256: nativeLogSha256,
        logPath: 'logs/cursor-native.log',
      },
    },
  });
  assert.ok(!missingRuntimeCertificationCells([nativeLinuxReceipt]).includes('cursor/linux'));

  // The load path validates each receipt against the receipts directory as its evidence root, so
  // the same artifacts must exist there too.
  const loadedDir = join(root, 'loaded');
  mkdirSync(loadedDir);
  writeArtifact(loadedDir, 'codex-runtime.log', logBytes);
  writeArtifact(loadedDir, 'cursor-wsl.log', 'wsl runtime transcript\n');
  writeArtifact(loadedDir, 'cursor-native.log', 'native linux transcript\n');
  writeFileSync(join(loadedDir, 'codex-darwin.json'), `${JSON.stringify(vendorReceipt)}\n`);
  writeFileSync(join(loadedDir, 'cursor-linux-wsl.json'), `${JSON.stringify(wslReceipt)}\n`);
  writeFileSync(
    join(loadedDir, 'cursor-linux-native.json'),
    `${JSON.stringify(nativeLinuxReceipt)}\n`,
  );
  const loaded = loadClientCertificationReceipts(loadedDir);
  assert.equal(loaded.length, 3);
  assert.deepEqual(certificationSummary(loaded), {
    claude: 'not-certified',
    copilot: 'not-certified',
    cursor: 'runtime-verified',
    codex: 'runtime-verified',
    windsurf: 'not-certified',
    gemini: 'not-certified',
    vscode: 'not-certified',
  });

  // Native and WSL receipts for the same client/arch are distinct cells, but an exact repeat of
  // either is still a duplicate.
  writeFileSync(
    join(loadedDir, 'codex-darwin-duplicate.json'),
    `${JSON.stringify(vendorReceipt)}\n`,
  );
  assert.throws(() => loadClientCertificationReceipts(loadedDir), /duplicate certification cell/);

  const invalidDir = join(root, 'invalid');
  mkdirSync(invalidDir);
  writeFileSync(
    join(invalidDir, 'codex-darwin.json'),
    `${JSON.stringify(runtimeReceipt({ ...vendorRuntime, logPath: 'logs/absent.log' }))}\n`,
  );
  assert.throws(() => loadClientCertificationReceipts(invalidDir), CertificationEvidenceError);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('client certification evidence tests ok');
