import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CERTIFICATION_EVIDENCE_FORMAT_VERSION,
  CERTIFICATION_LEGS,
  CERTIFIED_CLIENTS,
  CertificationEvidenceError,
  SUPPORTED_CERTIFICATION_FORMAT_VERSIONS,
  certificationCell,
  certificationStatus,
  certificationSummary,
  certifyClientCell,
  loadClientCertificationReceipts,
  missingRuntimeCertificationCells,
  satisfiesMinimumVersion,
  validateClientCertificationReceipt,
} from './client-certification-evidence.mjs';
import { loadLaunchPolicy } from './launch-policy.mjs';

// The floors are the policy's, so the floor cases read the committed policy rather than restating a
// number that would silently stop testing anything the day it changed.
const { policy } = loadLaunchPolicy();

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const COMMIT = 'a'.repeat(40);
const CAPTURED_AT = '2026-09-08T00:00:00.000Z';
const notRun = { status: 'not-run' };
/** Attribution for a runtime pass: who ran it, on what host, and when. */
const attestation = {
  operator: 'fixture-operator',
  host: 'fixture-host',
  capturedAt: CAPTURED_AT,
};

// ─── version 1: readable for diagnostics ────────────────────────────────────────────────────────
const receipt = (overrides = {}) => ({
  format: 'knowledge-crib-client-certification',
  formatVersion: 1,
  generatedAt: CAPTURED_AT,
  policySha256: SHA_A,
  product: { commit: COMMIT, packageSha256: SHA_A },
  client: { id: 'codex', version: '1.0.0' },
  platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
  evidence: {
    configuration: { status: 'pass', configSha256: SHA_A },
    protocol: notRun,
    runtime: notRun,
  },
  ...overrides,
});
const configuration = { status: 'pass', configSha256: SHA_A };
const vendorProtocol = { status: 'pass', transcriptSha256: SHA_A, source: 'vendor-client' };

// ─── version 2: the certifying schema ───────────────────────────────────────────────────────────

/** Every leg passing, with handshake/toolUse attributed to the vendor client. */
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

const runtimeBytes = (name) =>
  `vendor run ${name}: record -> interrupt -> restart -> authorized resume\n`;
const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Drop one key from a copy. `delete` is banned by the linter, and assigning `undefined` is not the
 * same thing — the key survives, `Object.keys` still lists it, and only `JSON.stringify` hides it.
 * A validator that asks whether a field is present must see it genuinely gone.
 */
const without = (object, key) => {
  const { [key]: _dropped, ...rest } = object;
  return rest;
};

/**
 * A complete version-2 receipt whose log actually exists under `dir`, so every fixture is backed by
 * a real artifact — a certifying receipt the loader must accept, which a test can then break one
 * fact at a time.
 */
function v2Receipt(dir, name, overrides = {}) {
  const bytes = runtimeBytes(name);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', `${name}.log`), bytes);
  return {
    format: 'knowledge-crib-client-certification',
    formatVersion: 2,
    generatedAt: CAPTURED_AT,
    policySha256: SHA_A,
    product: { commit: COMMIT, packageSha256: SHA_A },
    client: { id: 'codex', version: '9.9.9', driverVersion: '1.0.0', certificationMode: 'codex' },
    platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
    runId: `run-${name}`,
    capture: { hostname: 'fixture-host', operator: 'fixture-operator', capturedAt: CAPTURED_AT },
    principalMarkers: { owner: SHA_A, foreign: SHA_B },
    vendor: {
      processIdentity: 'codex 9.9.9 (/usr/local/bin/codex, pid 4711)',
      logPath: `logs/${name}.log`,
      logSha256: digestOf(bytes),
    },
    legs: allPassLegs(),
    ...overrides,
  };
}

assert.equal(CERTIFICATION_EVIDENCE_FORMAT_VERSION, 2);
assert.deepEqual(SUPPORTED_CERTIFICATION_FORMAT_VERSIONS, [1, 2]);
assert.deepEqual(CERTIFICATION_LEGS, [
  'configuration',
  'handshake',
  'toolUse',
  'record',
  'interruption',
  'restart',
  'authorizedResume',
  'foreignPrincipalExclusion',
]);
assert.deepEqual(CERTIFIED_CLIENTS, [
  'claude',
  'copilot',
  'cursor',
  'codex',
  'windsurf',
  'gemini',
  'vscode',
]);

// Dotted-numeric comparison, so a date-versioned client (2025.01.01) and a two-part version (1.0)
// both compare by number rather than by string length, and anything unparseable fails closed.
assert.equal(satisfiesMinimumVersion('2.1.0', '2.1.0'), true);
assert.equal(satisfiesMinimumVersion('2.0.9', '2.1.0'), false);
assert.equal(satisfiesMinimumVersion('2.10.0', '2.9.0'), true, 'numeric, not lexical');
assert.equal(satisfiesMinimumVersion('v22.1.0', '22.0.0'), true);
assert.equal(satisfiesMinimumVersion('1.0', '1.0.0'), true);
assert.equal(satisfiesMinimumVersion('not-a-version', '1.0.0'), false);
assert.equal(satisfiesMinimumVersion(undefined, '1.0.0'), false);

// Backward compatibility: receipts predating platform.wsl and protocol.source still validate — a
// missing platform.wsl means false, and a not-run protocol tier carries no claim to attribute.
assert.deepEqual(validateClientCertificationReceipt(receipt()), receipt());

assert.throws(
  () => validateClientCertificationReceipt(receipt({ client: { id: 'made-up', version: '1' } })),
  CertificationEvidenceError,
);
assert.throws(
  () => validateClientCertificationReceipt(receipt({ formatVersion: 3 })),
  /unsupported certification receipt version/,
);
assert.throws(
  () => validateClientCertificationReceipt(receipt({ generatedAt: 'yesterday' })),
  /ISO-8601/,
);
assert.throws(
  () =>
    validateClientCertificationReceipt(
      receipt({ product: { commit: 'a'.repeat(39), packageSha256: SHA_A } }),
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
          configuration: { status: 'fail', configSha256: SHA_A },
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
          protocol: { status: 'pass', transcriptSha256: SHA_A },
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
          protocol: { status: 'pass', transcriptSha256: SHA_A, source: 'nonsense' },
          runtime: notRun,
        },
      }),
    ),
  /must declare its source/,
);

// platform.wsl is optional but must be a boolean, and is only ever set on linux receipts.
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
  // ─── version 1: a healthy runtime receipt ───────────────────────────────────────────────────
  const dir = join(root, 'receipts');
  mkdirSync(dir);
  const logBytes = 'record -> interrupt -> restart -> authorized resume\n';
  writeFileSync(join(dir, 'codex-runtime.log'), logBytes);
  const vendorRuntime = {
    status: 'pass',
    source: 'vendor-client',
    recordedMemory: true,
    interrupted: true,
    authorizedResume: true,
    foreignPrincipalExcluded: true,
    attestation,
    logSha256: digestOf(logBytes),
    logPath: 'codex-runtime.log',
  };
  const runtimeReceipt = (runtime) =>
    receipt({ evidence: { configuration, protocol: vendorProtocol, runtime } });
  const vendorReceipt = runtimeReceipt(vendorRuntime);
  assert.deepEqual(
    validateClientCertificationReceipt(vendorReceipt, { evidenceRoot: dir }),
    vendorReceipt,
  );

  // A runtime pass must record the launch policy it was collected under: requirements can change,
  // and a receipt taken under looser ones must not silently satisfy the stricter promise (A02).
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

  // The vendor-client law: a runtime pass from anything else — including a test client that merely
  // speaks the client's protocol — is rejected.
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
        { evidenceRoot: dir },
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

  // Receipt-contract tightening: a hand-typed minimal receipt cannot pass. The referenced transcript
  // or log file must exist under the receipts area and match its digest.
  assert.throws(
    () =>
      validateClientCertificationReceipt(runtimeReceipt({ ...vendorRuntime, logPath: undefined }), {
        evidenceRoot: dir,
      }),
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
      validateClientCertificationReceipt(runtimeReceipt({ ...vendorRuntime, logSha256: SHA_B }), {
        evidenceRoot: dir,
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(
        runtimeReceipt({ ...vendorRuntime, logSha256: 'not-a-sha' }),
        { evidenceRoot: dir },
      ),
    /sha256 digest/,
  );

  // ─── version 1 stays READABLE but can never CERTIFY ─────────────────────────────────────────
  //
  // The structural reason is in the receipt's own history: it recorded interruption and restart as
  // one fact and never separated tool invocation from the handshake. Reading it generously here is
  // exactly what would let a legacy receipt silently satisfy the stricter promise (A02), so the
  // schema check comes first and names itself.
  assert.deepEqual(certifyClientCell(vendorReceipt), {
    ok: false,
    problem: 'client-cell-uncertified',
    cell: 'codex/darwin',
    detail: 'receipt schema v1 is not certifying',
  });
  assert.equal(certificationStatus(vendorReceipt), 'protocol-verified');
  assert.equal(certificationSummary([vendorReceipt]).codex, 'protocol-verified');
  assert.ok(missingRuntimeCertificationCells([vendorReceipt]).includes('codex/darwin'));
  // Schema precedes binding: however foreign a v1 receipt's candidate is, the more fundamental
  // refusal is that the schema cannot express the legs.
  assert.equal(
    certifyClientCell(vendorReceipt, {
      candidate: { commit: 'b'.repeat(40), packageSha256: SHA_B },
    }).problem,
    'client-cell-uncertified',
  );
  // A v1 receipt that only configured itself is still readable as configuration evidence.
  assert.equal(certificationStatus(receipt()), 'configuration-verified');

  // ─── version 2: a complete certifying receipt ───────────────────────────────────────────────
  const v2Dir = join(root, 'v2');
  mkdirSync(v2Dir);
  const certifying = v2Receipt(v2Dir, 'codex-darwin');
  assert.deepEqual(
    validateClientCertificationReceipt(certifying, { evidenceRoot: v2Dir }),
    certifying,
  );
  assert.deepEqual(certifyClientCell(certifying), { ok: true, cell: 'codex/darwin' });
  assert.equal(certificationCell(certifying), 'codex/darwin');
  assert.equal(certificationStatus(certifying), 'runtime-verified');
  assert.equal(certificationSummary([certifying]).codex, 'runtime-verified');
  assert.ok(!missingRuntimeCertificationCells([certifying]).includes('codex/darwin'));

  // Candidate, package and policy binding.
  assert.equal(
    certifyClientCell(certifying, { candidate: { commit: 'c'.repeat(40) } }).problem,
    'client-receipt-foreign-commit',
  );
  assert.equal(
    certifyClientCell(certifying, { candidate: { packageSha256: SHA_B } }).problem,
    'client-receipt-foreign-package',
  );
  assert.equal(
    certifyClientCell(certifying, { policySha256: SHA_B }).problem,
    'client-receipt-foreign-policy',
  );
  assert.throws(
    () =>
      validateClientCertificationReceipt(certifying, {
        evidenceRoot: v2Dir,
        candidate: { commit: 'c'.repeat(40), packageSha256: SHA_A },
      }),
    /client-receipt-foreign-commit:codex\/darwin:a{40}/,
  );

  // The version floor is looked up PER CELL against the committed policy. A client below the floor
  // is refused by name; one above it passes — so the floor is a floor, not a ban.
  const floor = policy.clientVersionRequirements['codex/darwin'];
  assert.ok(floor, 'the policy must state a codex/darwin floor for this test to mean anything');
  const belowFloor = v2Receipt(v2Dir, 'codex-old', {
    client: { id: 'codex', version: '0.0.1', driverVersion: '1.0.0', certificationMode: 'codex' },
  });
  assert.deepEqual(certifyClientCell(belowFloor, { policy }), {
    ok: false,
    problem: 'client-version-unsupported',
    cell: 'codex/darwin',
    detail: `0.0.1 < ${floor}`,
  });
  assert.deepEqual(certifyClientCell(certifying, { policy }), { ok: true, cell: 'codex/darwin' });

  // ─── version 2: every deviation is a named refusal ──────────────────────────────────────────
  const broken =
    (overrides, name = 'codex-broken') =>
    () =>
      validateClientCertificationReceipt(v2Receipt(v2Dir, name, overrides), {
        evidenceRoot: v2Dir,
      });

  assert.throws(() => {
    const { policySha256: _dropped, ...withoutPolicy } = certifying;
    return validateClientCertificationReceipt(withoutPolicy, { evidenceRoot: v2Dir });
  }, /policySha256/);
  for (const field of ['driverVersion', 'certificationMode']) {
    assert.throws(
      () => {
        const fixture = v2Receipt(v2Dir, `codex-no-${field}`);
        fixture.client = without(fixture.client, field);
        return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
      },
      new RegExp(`client\\.${field} is required`),
    );
  }
  assert.throws(
    broken({
      client: { id: 'codex', version: '9.9.9', driverVersion: '1', certificationMode: 'slack' },
    }),
    /unknown certification mode: slack/,
  );
  assert.throws(() => {
    const fixture = without(v2Receipt(v2Dir, 'codex-no-runid'), 'runId');
    return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
  }, /runId is required/);

  // Who ran it, where and when — the same attribution a v1 runtime pass must carry.
  assert.throws(() => {
    const fixture = without(v2Receipt(v2Dir, 'codex-no-capture'), 'capture');
    return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
  }, /capture is required/);
  for (const field of ['hostname', 'operator', 'capturedAt']) {
    assert.throws(
      () => {
        const fixture = v2Receipt(v2Dir, `codex-capture-${field}`);
        fixture.capture = without(fixture.capture, field);
        return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
      },
      new RegExp(`capture\\.${field} is required`),
    );
  }
  assert.throws(
    broken({ capture: { hostname: 'h', operator: 'o', capturedAt: 'whenever' } }),
    /capture\.capturedAt must be ISO-8601/,
  );

  // Sanitized principal markers: the receipt names both principals by digest, and they must differ —
  // an "exclusion" leg whose two markers are the same proves nothing was excluded.
  assert.throws(() => {
    const fixture = without(v2Receipt(v2Dir, 'codex-no-markers'), 'principalMarkers');
    return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
  }, /principalMarkers is required/);
  assert.throws(
    broken({ principalMarkers: { owner: 'owner-principal', foreign: SHA_B } }),
    /principalMarkers\.owner must be a sha256 digest/,
  );
  assert.throws(
    broken({ principalMarkers: { owner: SHA_A, foreign: SHA_A } }),
    /owner and foreign principal markers must differ/,
  );

  // Legs: all eight present, each with a valid status.
  assert.throws(() => {
    const fixture = v2Receipt(v2Dir, 'codex-no-leg');
    fixture.legs = without(fixture.legs, 'toolUse');
    return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
  }, /legs\.toolUse is required/);
  assert.throws(
    broken({ legs: allPassLegs({ record: { status: 'maybe' } }) }),
    /legs\.record\.status is invalid: maybe/,
  );
  // The two vendor-asserting legs state their source unconditionally.
  for (const leg of ['handshake', 'toolUse']) {
    assert.throws(
      broken({ legs: allPassLegs({ [leg]: { status: 'pass', source: 'test-client' } }) }),
      new RegExp(`legs\\.${leg} must be produced by a vendor-client`),
    );
    assert.throws(
      broken({ legs: allPassLegs({ [leg]: { status: 'pass' } }) }),
      new RegExp(`legs\\.${leg} must be produced by a vendor-client`),
    );
  }

  // The same law holds at the JUDGEMENT site, not only in the loader. `certifyClientCell` is what the
  // launch decision and the public matrix call, and both may be handed receipts parsed elsewhere. If
  // the rule lived only in the loader, an already-parsed test-client claim would certify a cell that
  // the on-disk path refused — the same receipt judged two ways, by the two things that must agree.
  for (const leg of ['handshake', 'toolUse']) {
    assert.deepEqual(
      certifyClientCell(
        v2Receipt(v2Dir, `codex-sourceless-${leg}`, {
          legs: allPassLegs({ [leg]: { status: 'pass', source: 'test-client' } }),
        }),
      ),
      {
        ok: false,
        problem: 'client-cell-uncertified',
        cell: 'codex/darwin',
        detail: `legs.${leg} was not produced by a vendor-client`,
      },
    );
  }
  // A receipt carrying no legs at all is refused rather than read as "nothing failed".
  assert.equal(
    certifyClientCell(v2Receipt(v2Dir, 'codex-no-legs', { legs: {} })).detail,
    'legs.handshake was not produced by a vendor-client',
  );

  // A leg that did not pass must say what stopped it. Silence reads as "not attempted", which is a
  // different fact from "the account was not signed in".
  assert.throws(
    broken({ legs: allPassLegs({ restart: { status: 'blocked' } }) }),
    /blockedReason \(legs not passed: restart\) is required/,
  );
  // …and a receipt that says why is READABLE — an honest failure stays legible, so a blocked receipt
  // needs neither artifacts nor an evidence root to load.
  const blockedFixture = v2Receipt(v2Dir, 'codex-blocked', {
    legs: allPassLegs({ interruption: { status: 'blocked' }, restart: { status: 'not-run' } }),
    blockedReason: 'the vendor client refused to start without an interactive desktop session',
  });
  blockedFixture.vendor = undefined;
  assert.deepEqual(
    validateClientCertificationReceipt(blockedFixture, {}),
    blockedFixture,
    'a receipt that names its blocker must not also need an evidence root',
  );
  assert.deepEqual(certifyClientCell(blockedFixture), {
    ok: false,
    problem: 'client-cell-uncertified',
    cell: 'codex/darwin',
    detail: 'legs not passed: interruption, restart',
  });

  // A certifying receipt is a claim that a real vendor process ran. Legs alone are assertion; the
  // transcript is what makes them evidence, and the vendor process identity is what says WHICH
  // binary produced it — a harness that merely speaks the protocol has a transcript too.
  assert.throws(() => {
    const fixture = without(v2Receipt(v2Dir, 'codex-unbacked'), 'vendor');
    return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
  }, /a certifying receipt must reference a vendor transcript or log/);
  assert.throws(() => {
    const fixture = v2Receipt(v2Dir, 'codex-nameless');
    fixture.vendor = without(fixture.vendor, 'processIdentity');
    return validateClientCertificationReceipt(fixture, { evidenceRoot: v2Dir });
  }, /vendor\.processIdentity is required/);
  assert.throws(
    () => validateClientCertificationReceipt(certifying, {}),
    /a certifying receipt requires an evidence root/,
  );
  // …and the same refusal holds without disk access, so the launch decision cannot be handed a
  // hand-written receipt that covers a cell:
  assert.deepEqual(certifyClientCell({ ...certifying, vendor: {} }), {
    ok: false,
    problem: 'client-cell-uncertified',
    cell: 'codex/darwin',
    detail: 'a certifying receipt references no runtime transcript or log',
  });
  assert.throws(
    broken({ vendor: { processIdentity: 'codex', logPath: '../escape.log', logSha256: SHA_A } }),
    /escapes the receipts area/,
  );
  assert.throws(
    broken({ vendor: { processIdentity: 'codex', logPath: 'logs/absent.log', logSha256: SHA_A } }),
    /missing from the receipts area/,
  );

  // A leg may declare its own artifact, and then it too must be verified.
  assert.throws(
    broken({
      legs: allPassLegs({
        restart: { status: 'pass', transcriptPath: 'legs/absent.txt', transcriptSha256: SHA_A },
      }),
    }),
    /legs\.restart\.transcriptPath references a file missing from the receipts area/,
  );

  // ─── a transcript altered AFTER the receipt was generated invalidates its cell ──────────────
  {
    const alteredDir = join(root, 'altered');
    mkdirSync(alteredDir);
    const fresh = v2Receipt(alteredDir, 'codex-altered');
    writeFileSync(join(alteredDir, `${fresh.runId}.json`), `${JSON.stringify(fresh)}\n`);
    assert.equal(loadClientCertificationReceipts(alteredDir).length, 1);
    // The digest is the whole point: the receipt is unchanged, the artifact is not, and the cell
    // stops counting rather than continuing to cite evidence that no longer says what it said.
    writeFileSync(
      join(alteredDir, 'logs', 'codex-altered.log'),
      `${runtimeBytes('codex-altered')}tampered\n`,
    );
    assert.throws(
      () => loadClientCertificationReceipts(alteredDir),
      /vendor\.logSha256 does not match the logs\/codex-altered\.log file/,
    );
  }

  // A WSL receipt (process.platform reports 'linux') validates and shows the legs it ran, but it can
  // never satisfy the native-linux runtime certification cell.
  const cursorClient = {
    id: 'cursor',
    version: '2025.01.01',
    driverVersion: '1.0.0',
    certificationMode: 'cursor',
  };
  const wslReceipt = v2Receipt(v2Dir, 'cursor-wsl', {
    client: cursorClient,
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1', wsl: true },
  });
  assert.deepEqual(
    validateClientCertificationReceipt(wslReceipt, { evidenceRoot: v2Dir }),
    wslReceipt,
  );
  assert.deepEqual(certifyClientCell(wslReceipt), {
    ok: false,
    problem: 'client-cell-uncertified',
    cell: 'cursor/linux',
    detail: 'a WSL run is not a native runtime',
  });
  assert.equal(certificationSummary([wslReceipt]).cursor, 'runtime-verified');
  assert.ok(missingRuntimeCertificationCells([wslReceipt]).includes('cursor/linux'));

  // Contrast: a native linux runtime pass does satisfy the native-linux cell.
  const nativeLinuxReceipt = v2Receipt(v2Dir, 'cursor-native', {
    client: cursorClient,
    platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
  });
  assert.deepEqual(certifyClientCell(nativeLinuxReceipt), { ok: true, cell: 'cursor/linux' });
  assert.ok(!missingRuntimeCertificationCells([nativeLinuxReceipt]).includes('cursor/linux'));

  // ─── loading a directory ────────────────────────────────────────────────────────────────────
  const loadedDir = join(root, 'loaded');
  mkdirSync(loadedDir);
  // Three cells, each with its own log inside THIS directory, so the loader can verify every digest.
  const loadedFixtures = [
    v2Receipt(loadedDir, 'codex-darwin'),
    {
      ...nativeLinuxReceipt,
      runId: 'run-cursor-loaded',
      vendor: {
        processIdentity: 'cursor 2025.01.01 (/usr/local/bin/cursor, pid 4712)',
        logPath: 'logs/cursor-loaded.log',
        logSha256: digestOf(runtimeBytes('cursor-loaded')),
      },
    },
    {
      ...v2Receipt(loadedDir, 'claude-win32', {
        client: {
          id: 'claude',
          version: '2.1.0',
          driverVersion: '1.0.0',
          certificationMode: 'claude',
        },
        platform: { os: 'win32', arch: 'x64', node: 'v22.23.1' },
      }),
      vendor: {
        processIdentity: 'claude 2.1.0 (/usr/local/bin/claude, pid 4713)',
        logPath: 'logs/claude-win32.log',
        logSha256: digestOf(runtimeBytes('claude-win32')),
      },
    },
  ];
  for (const fixture of loadedFixtures) {
    const fileName = fixture.vendor.logPath.replace('logs/', '');
    mkdirSync(join(loadedDir, 'logs'), { recursive: true });
    writeFileSync(join(loadedDir, 'logs', fileName), runtimeBytes(fileName.replace('.log', '')));
    writeFileSync(join(loadedDir, `${fixture.runId}.json`), `${JSON.stringify(fixture)}\n`);
  }
  const loaded = loadClientCertificationReceipts(loadedDir);
  assert.equal(loaded.length, 3);
  assert.deepEqual(certificationSummary(loaded), {
    claude: 'runtime-verified',
    copilot: 'not-certified',
    cursor: 'runtime-verified',
    codex: 'runtime-verified',
    windsurf: 'not-certified',
    gemini: 'not-certified',
    vscode: 'not-certified',
  });
  const covered = new Set(loaded.map(certificationCell));
  assert.deepEqual([...covered].sort(), ['claude/win32', 'codex/darwin', 'cursor/linux']);
  // 18 of the 21 cells are still open — the aggregate reports what is missing, and a cell count that
  // quietly rounded up to "covered" is the failure this function exists to prevent.
  const missing = missingRuntimeCertificationCells(loaded);
  assert.equal(missing.length, 18);
  assert.deepEqual(
    missing,
    CERTIFIED_CLIENTS.flatMap((client) =>
      ['darwin', 'linux', 'win32']
        .filter((platform) => !covered.has(`${client}/${platform}`))
        .map((platform) => `${client}/${platform}`),
    ),
  );

  // The same client on the same platform, twice: one cell, counted once.
  const duplicateCellDir = join(root, 'duplicate-cell');
  mkdirSync(duplicateCellDir);
  const first = v2Receipt(duplicateCellDir, 'codex-one');
  const second = v2Receipt(duplicateCellDir, 'codex-two');
  writeFileSync(join(duplicateCellDir, 'a.json'), `${JSON.stringify(first)}\n`);
  writeFileSync(join(duplicateCellDir, 'b.json'), `${JSON.stringify(second)}\n`);
  assert.throws(
    () => loadClientCertificationReceipts(duplicateCellDir),
    /duplicate certification cell: codex\/darwin\/arm64/,
  );

  // Two cells may legitimately share a host binary (a Copilot and a VS Code run, say), but each is a
  // separate RUN. A reused run id means one run's evidence is being counted twice.
  const duplicateRunDir = join(root, 'duplicate-run');
  mkdirSync(duplicateRunDir);
  const sharedRun = 'run-shared-0001';
  const runA = v2Receipt(duplicateRunDir, 'codex-shared', { runId: sharedRun });
  const runB = v2Receipt(duplicateRunDir, 'vscode-shared', {
    runId: sharedRun,
    client: {
      id: 'vscode',
      version: '1.99.0',
      driverVersion: '1.0.0',
      certificationMode: 'vscode',
    },
  });
  writeFileSync(join(duplicateRunDir, 'a.json'), `${JSON.stringify(runA)}\n`);
  writeFileSync(join(duplicateRunDir, 'b.json'), `${JSON.stringify(runB)}\n`);
  assert.throws(
    () => loadClientCertificationReceipts(duplicateRunDir),
    /duplicate certification run id: run-shared-0001/,
  );

  // A malformed receipt anywhere in the directory invalidates the whole set: a broken receipt
  // silently becoming a missing cell is the failure this module exists to prevent.
  const invalidDir = join(root, 'invalid');
  mkdirSync(invalidDir);
  const invalid = v2Receipt(invalidDir, 'codex-invalid');
  invalid.vendor.logPath = 'logs/absent.log';
  writeFileSync(join(invalidDir, 'codex-darwin.json'), `${JSON.stringify(invalid)}\n`);
  assert.throws(() => loadClientCertificationReceipts(invalidDir), CertificationEvidenceError);

  // An absent directory is no evidence, not an error: the aggregate reports the missing cells.
  assert.deepEqual(loadClientCertificationReceipts(join(root, 'never-collected')), []);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ─── a mixed evidence directory ────────────────────────────────────────────────────────────────
// Acceptance and certification receipts sit side by side in a real evidence pass, and pointing the
// loader at the wrong one of the two produced "unsupported certification receipt format" on a file
// like adapter.json — a message that explains nothing. An acceptance receipt is now skipped by its
// own declared format, while anything unrecognised still throws: a malformed CERTIFICATION receipt
// silently becoming a missing cell is the exact failure this module exists to prevent.
{
  const mixed = mkdtempSync(join(tmpdir(), 'crib-mixed-receipts-'));
  try {
    writeFileSync(
      join(mixed, 'adapter.json'),
      JSON.stringify({
        format: 'knowledge-crib-acceptance-receipt',
        type: 'adapter',
        status: 'pass',
      }),
    );
    assert.deepEqual(
      loadClientCertificationReceipts(mixed),
      [],
      'acceptance receipts are not cells',
    );

    writeFileSync(join(mixed, 'junk.json'), JSON.stringify({ format: 'something-else' }));
    assert.throws(
      () => loadClientCertificationReceipts(mixed),
      /unsupported certification receipt format/,
      'an unrecognised receipt must still be refused, never skipped',
    );
  } finally {
    rmSync(mixed, { recursive: true, force: true });
  }
}

console.log('client certification evidence tests ok');
