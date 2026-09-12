/**
 * The launch decision's contract, stated as probes.
 *
 * The audit (A01/A02) drove four independent probes to GO that should never have reached it:
 * ordinary non-certifying evidence, a manifest with an empty gate array, one with `git.dirty=true`,
 * and one with `retrieval.model={}`. A fifth (A02) applied 21 receipts for commit B to candidate A.
 * Each of those is a named case below, and the shape of this file is deliberate: ONE complete
 * fixture that earns GO, then one mutation per mandatory fact, each asserted to return NO-GO with
 * its exact reason. A decision that cannot be made to fail is not a decision.
 *
 * The fixture is REAL, not merely well-shaped. A certifying client receipt is a claim that a vendor
 * transcript exists on disk, and a global receipt's artifact is verified against disk, so the one
 * shape that earns GO is backed by actual bytes under a temporary evidence root, and every negative
 * probe mutates that same fixture rather than a looser copy of it. A fixture that certified without
 * its transcripts would be testing a decision nobody ships.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CertificationEvidenceError,
  certifyClientCell,
  loadClientCertificationReceipts,
} from './client-certification-evidence.mjs';
import {
  aggregateLaunchDecisions,
  evaluateLaunchDecision,
  loadReleaseEvidence,
  uncertifiedClientCells,
} from './launch-decision.mjs';
import {
  loadLaunchPolicy,
  policyClientCells,
  policyFuzzRequirements,
  policyOsNodeCells,
} from './launch-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { policy, sha256: POLICY_SHA } = loadLaunchPolicy();

const COMMIT = 'a'.repeat(40);
const PACKAGE = `sha256:${'b'.repeat(64)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const FOREIGN_MARKER = `sha256:${'9'.repeat(64)}`;
const SCORER = policy.semanticModel.supportedScorers[0];
const CAPTURED_AT = '2026-09-09T00:00:00.000Z';
// Above every per-cell floor the policy declares (the highest is cursor's 2025.01.01), so a fixture
// never certifies a cell by accident of a floor this file failed to check.
const CLIENT_VERSION = '9999.12.31';
const FUZZ = policyFuzzRequirements(policy);
const CLIENT_CELLS = policyClientCells(policy);
const OS_CELLS = policyOsNodeCells(policy);

// ─── the evidence root ────────────────────────────────────────────────────────────────────────
//
// A failing assert exits the process without reaching any cleanup written at the bottom of this file,
// so the tree is removed from an exit hook instead: a suite that refuses must not leave a receipt
// directory behind for the next run to read.
const root = mkdtempSync(join(tmpdir(), 'crib-launch-decision-'));
const receiptsDir = join(root, 'client-receipts');
const globalDir = join(root, 'global-receipts');
const cellsDir = join(root, 'cells');
for (const directory of [join(receiptsDir, 'logs'), globalDir, cellsDir]) {
  mkdirSync(directory, { recursive: true });
}
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const logName = (cell) => `${cell.replace(/\//g, '-')}.log`;
const logBytes = (cell) => `session start -> record -> interrupt -> restart -> resume (${cell})\n`;
const cellOf = (receipt) => `${receipt?.client?.id}/${receipt?.platform?.os}`;
const receiptFor = (receipts, cell) => receipts.find((receipt) => cellOf(receipt) === cell);

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
 * Write one certifying receipt for `cell`, backed by a real log under `directory/logs/`.
 *
 * Nothing here is a shortcut: the log is written first, its digest is computed from those bytes, and
 * the receipt points at it by the same relative path the loader will resolve. That is the only way
 * the "altering a transcript invalidates its cell" probe below can mean anything.
 */
function writeCertifyingReceipt(directory, cell, overrides = {}) {
  const [id, os] = cell.split('/');
  const bytes = logBytes(cell);
  writeFileSync(join(directory, 'logs', logName(cell)), bytes);
  const receipt = {
    format: 'knowledge-crib-client-certification',
    formatVersion: 2,
    generatedAt: CAPTURED_AT,
    policySha256: POLICY_SHA,
    product: { commit: COMMIT, packageSha256: PACKAGE },
    client: { id, version: CLIENT_VERSION, driverVersion: '1.0.0', certificationMode: id },
    platform: { os, arch: 'x64', node: 'v22.23.1' },
    runId: `run-${id}-${os}`,
    capture: { hostname: 'fixture-host', operator: 'fixture-operator', capturedAt: CAPTURED_AT },
    principalMarkers: { owner: DIGEST, foreign: FOREIGN_MARKER },
    vendor: {
      processIdentity: `${id} ${CLIENT_VERSION} (/usr/local/bin/${id}, pid 4711)`,
      logPath: `logs/${logName(cell)}`,
      logSha256: digestOf(bytes),
    },
    legs: allPassLegs(),
    ...overrides,
  };
  writeFileSync(join(directory, `${id}-${os}.json`), `${JSON.stringify(receipt)}\n`);
  return receipt;
}

for (const cell of CLIENT_CELLS) writeCertifyingReceipt(receiptsDir, cell);

// Loading the directory here does two jobs at once: it proves the fixture is a set the REAL loader
// accepts — digests, unique cells, unique run ids and all — and it gives every probe below a fresh
// deep copy to mutate, so one probe can never leak its damage into the next.
const CERTIFICATION_PAYLOAD = JSON.stringify(loadClientCertificationReceipts(receiptsDir));
const certificationReceipts = () => JSON.parse(CERTIFICATION_PAYLOAD);

// ─── the candidate-wide receipt (the deep sweep) ──────────────────────────────────────────────
const FUZZ_BYTES = `deep fuzz sweep: workload=${FUZZ.workload} seed=${FUZZ.seed} iterations=${FUZZ.requiredIterations}\n`;
writeFileSync(join(globalDir, 'fuzz-deep.log'), FUZZ_BYTES);

/**
 * A candidate-bound `fuzz-deep` receipt. Its measured numbers are the POLICY's own figures rather
 * than restated literals, so a floor that moves in the policy moves here too.
 */
function fuzzReceipt(overrides = {}) {
  return {
    type: 'fuzz-deep',
    status: 'pass',
    candidateCommit: COMMIT,
    candidatePackageSha256: PACKAGE,
    policySha256: POLICY_SHA,
    artifacts: [{ path: 'fuzz-deep.log', sha256: digestOf(FUZZ_BYTES) }],
    details: {
      workload: FUZZ.workload,
      seed: FUZZ.seed,
      iterations: FUZZ.requiredIterations,
      extractorCount: FUZZ.minimumExtractors,
      failures: [],
    },
    ...overrides,
  };
}

// The CLI reads candidate-wide receipts off disk, so the fixture's receipt is written out beside the
// sweep log it names — the same pair a real run produces.
writeFileSync(join(globalDir, 'fuzz-deep.json'), `${JSON.stringify(fuzzReceipt())}\n`);

/**
 * The summary a MANIFEST restates about its own coverage. The decision compares it against the raw
 * receipts and names every cell where the two disagree — so this is a claim to be CHECKED, never the
 * thing that certifies a cell (the A01 defect).
 */
function manifestCertificationClaim() {
  return CLIENT_CELLS.map((cell) => {
    const [id, os] = cell.split('/');
    return { client: { id }, platform: { os }, runtimeStatus: 'pass' };
  });
}

/** A measurement that passes the policy's own threshold for one gate. */
const passingMeasurement = (gate) => gate.threshold;

/** The complete, certifying manifest — the ONLY shape that may produce GO. */
function completeEvidence() {
  return {
    format: 'knowledge-crib-release-evidence',
    formatVersion: 2,
    generatedAt: CAPTURED_AT,
    candidate: {
      commit: COMMIT,
      dirty: false,
      packageSha256: PACKAGE,
      policySha256: POLICY_SHA,
    },
    product: {
      name: 'knowledge-crib',
      packages: { 'knowledge-crib': '0.1.0' },
      schemas: { soul: '1.6', memory: ['1'], evidenceManifest: '2' },
      clients: {},
    },
    reproducibility: {
      git: {
        commit: COMMIT,
        branch: 'fixture',
        dirty: false,
        dirtyPaths: [],
        dirtyDigest: `sha256:${'0'.repeat(64)}`,
      },
      platform: { os: 'linux', arch: 'x64', node: 'v22.23.1' },
      runner: { provider: 'github-actions', runId: '1', runUrl: 'https://example.invalid/1' },
      workload: { name: 'memory-launch-corpus' },
    },
    run: {
      command: 'pnpm release:verify',
      exitCode: 0,
      startedAt: CAPTURED_AT,
      endedAt: '2026-09-09T00:10:00.000Z',
    },
    retrieval: {
      mode: 'on-device-semantic',
      scorer: SCORER,
      model: {
        id: 'intfloat/multilingual-e5-large',
        version: '1',
        embedderId: 'e5-large-1024',
        dim: 1024,
        manifestSha256: DIGEST,
      },
    },
    gates: policy.gates.map((gate) => ({
      id: gate.id,
      measured: passingMeasurement(gate),
      threshold: gate.threshold,
      comparison: gate.direction,
      pass: true,
    })),
    receipts: Object.fromEntries(
      policy.receiptTypes.map((type) => [
        type,
        {
          status: 'pass',
          candidateCommit: COMMIT,
          artifacts: [{ path: `${type}.log`, sha256: DIGEST }],
          ...(type === 'freshness'
            ? { p95Ms: policy.freshness.p95TargetMs - 1, workload: policy.freshness.workload }
            : {}),
        },
      ]),
    ),
    artifacts: [{ path: 'release-evidence.json', sha256: DIGEST }],
    certification: { receipts: manifestCertificationClaim() },
    acceptance: { pass: true, requiredFailures: [] },
  };
}

const CANDIDATE = { commit: COMMIT, packageSha256: PACKAGE };

/** The options a candidate-scoped decision is given: raw receipts, never a manifest's summary. */
function fixtureOptions(overrides = {}) {
  return {
    candidate: CANDIDATE,
    certificationReceipts: certificationReceipts(),
    globalReceipts: [fuzzReceipt()],
    globalReceiptsRoot: globalDir,
    ...overrides,
  };
}

const decide = (evidence, overrides) => evaluateLaunchDecision(evidence, fixtureOptions(overrides));

/** Mutate one fact — in the manifest, in the receipts, or in the options — and assert the refusal. */
function refuses(label, mutate, pattern) {
  const evidence = completeEvidence();
  const options = fixtureOptions();
  mutate(evidence, options);
  const result = evaluateLaunchDecision(evidence, options);
  assert.equal(result.decision, 'NO-GO', `${label} must be NO-GO`);
  assert.ok(
    result.blockers.some((blocker) => pattern.test(blocker)),
    `${label}: expected a blocker matching ${pattern}, got ${JSON.stringify(result.blockers)}`,
  );
}

// ─── the one shape that earns GO ──────────────────────────────────────────────────────────────
const complete = decide(completeEvidence());
assert.deepEqual(
  complete,
  { decision: 'GO', blockers: [], certifying: true },
  `a complete independent fixture must return GO, got ${JSON.stringify(complete)}`,
);

// ─── the three-valued option sentinel ─────────────────────────────────────────────────────────
//
// Client certification is candidate-scoped: the 21 vendor-runtime cells describe the BUILD, not any
// one OS/Node cell, so the aggregate asks the question once and each per-cell decision defers. The
// three states are deliberately distinct, because "deferred" and "never supplied" must not read the
// same: `null` defers, an array judges, and `undefined` is a blocker.
assert.deepEqual(
  decide(completeEvidence(), { certificationReceipts: null, globalReceipts: null }),
  { decision: 'GO', blockers: [], certifying: true },
  'deferring a candidate-scoped question to the aggregate is not a failure',
);
{
  const result = decide(completeEvidence(), { certificationReceipts: undefined });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes('certification-receipts-not-loaded'));
  // This call is ONE manifest's decision. The 21 missing cells belong to the aggregate, which is
  // where they are enumerated once — repeating them into six per-cell manifests would read as six
  // problems instead of one. So the absence is named here and costed there.
  assert.equal(
    result.blockers.filter((b) => b.startsWith('client-cell-uncertified:')).length,
    0,
    'a per-cell decision names the absent input, not every cell it costs',
  );
  // The two inputs are independent: a decision missing one still judges the other, so neither can
  // hide behind the other's absence.
  assert.ok(!result.blockers.includes('global-receipts-not-loaded'));
}
{
  const result = decide(completeEvidence(), { globalReceipts: undefined });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes('global-receipts-not-loaded'));
  assert.ok(!result.blockers.includes('certification-receipts-not-loaded'));
}

// ─── A01: the four probes that used to return GO ──────────────────────────────────────────────

// (1) ordinary non-certifying evidence — the schema that cannot express the required facts.
assert.equal(decide({ acceptance: { pass: true, requiredFailures: [] } }).decision, 'NO-GO');
assert.ok(
  decide({ formatVersion: 1, acceptance: { pass: true, requiredFailures: [] } }).blockers.some(
    (b) => b.startsWith('evidence-schema-non-certifying'),
  ),
);
assert.equal(
  decide({ formatVersion: 1, acceptance: { pass: true, requiredFailures: [] } }).certifying,
  false,
);

// (2) an empty gate array no longer passes vacuously: every frozen gate is required BY NAME.
{
  const evidence = completeEvidence();
  evidence.gates = [];
  const result = decide(evidence);
  assert.equal(result.decision, 'NO-GO');
  for (const gate of policy.gates) {
    assert.ok(
      result.blockers.includes(`gate-missing:${gate.id}`),
      `an empty gate array must name the missing ${gate.id}`,
    );
  }
}

// (3) a dirty tree, (4) a missing model proof.
refuses(
  'a dirty working tree',
  (e) => {
    e.candidate.dirty = true;
  },
  /^candidate-dirty-or-unknown$/,
);
refuses(
  'an empty model block',
  (e) => {
    e.retrieval.model = {};
  },
  /^semantic-model-proof-missing$/,
);
refuses(
  'an unsupported scorer',
  (e) => {
    e.retrieval.scorer = 'lexical-only';
  },
  /^scorer-unsupported:/,
);

// ─── gates: set, thresholds, directions, measurements, contradictions ─────────────────────────
refuses('a missing gate', (e) => void e.gates.splice(1, 1), /^gate-missing:G2$/);
refuses('a duplicated gate', (e) => void e.gates.push({ ...e.gates[0] }), /^gate-duplicate:G1$/);
refuses(
  'an unknown gate id',
  (e) => {
    e.gates.push({ id: 'G99', measured: 1, threshold: 1, comparison: 'gte', pass: true });
  },
  /^gate-unknown:G99$/,
);
refuses(
  'a relaxed threshold',
  (e) => {
    const g2 = e.gates.find((gate) => gate.id === 'G2');
    g2.threshold = 0.1;
    g2.measured = 0.2;
  },
  /^gate-threshold-altered:G2$/,
);
refuses(
  'a flipped direction',
  (e) => {
    e.gates.find((gate) => gate.id === 'G5').comparison = 'gte';
  },
  /^gate-direction-altered:G5$/,
);
refuses(
  'a measurement below the frozen threshold',
  (e) => {
    const g2 = e.gates.find((gate) => gate.id === 'G2');
    g2.measured = 0.5;
    g2.pass = false;
  },
  /^gate-failed:G2:threshold$/,
);
for (const [label, value] of [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['a string', '1'],
  ['undefined', undefined],
]) {
  refuses(
    `a non-finite G6 measurement (${label})`,
    (e) => {
      e.gates.find((gate) => gate.id === 'G6').measured = value;
    },
    /^gate-failed:G6:measurement-not-finite$/,
  );
}
refuses(
  'a pass flag contradicting the measurement',
  (e) => {
    e.gates.find((gate) => gate.id === 'G2').measured = 0.1;
  },
  /^gate-contradiction:G2$/,
);

// ─── candidate identity and policy binding ────────────────────────────────────────────────────
refuses(
  'a missing commit',
  (e) => {
    e.candidate.commit = '';
  },
  /^candidate-commit-missing$/,
);
refuses(
  'evidence for a different commit',
  (e) => {
    e.candidate.commit = 'd'.repeat(40);
    e.reproducibility.git.commit = 'd'.repeat(40);
  },
  /^candidate-commit-mismatch:/,
);
refuses(
  'evidence for a different package',
  (e) => {
    e.candidate.packageSha256 = `sha256:${'9'.repeat(64)}`;
  },
  /^candidate-package-mismatch:/,
);
refuses(
  'evidence collected under a different policy',
  (e) => {
    e.candidate.policySha256 = `sha256:${'8'.repeat(64)}`;
  },
  /^policy-mismatch:/,
);
refuses(
  'a run that did not exit 0',
  (e) => {
    e.run.exitCode = 1;
  },
  /^run-exit-code:1$/,
);

// ─── typed receipts: missing types are blockers, never inferences ─────────────────────────────
for (const type of policy.receiptTypes) {
  refuses(
    `a missing ${type} receipt`,
    (e) => {
      delete e.receipts[type];
    },
    new RegExp(`^receipt-missing:${type}$`),
  );
  refuses(
    `a not-run ${type} receipt`,
    (e) => {
      e.receipts[type] = { status: 'not-run' };
    },
    new RegExp(`^receipt-not-passing:${type}:not-run$`),
  );
}
refuses(
  'a receipt with no artifact behind it',
  (e) => {
    e.receipts.browser = { status: 'pass', artifacts: [] };
  },
  /^receipt-artifact-missing:browser$/,
);
refuses(
  'a receipt collected for another commit',
  (e) => {
    e.receipts.install.candidateCommit = 'e'.repeat(40);
  },
  /^receipt-candidate-mismatch:install$/,
);

// ─── the preregistered freshness target is enforced, not decorative ───────────────────────────
refuses(
  'a freshness p95 above the preregistered target',
  (e) => {
    e.receipts.freshness.p95Ms = policy.freshness.p95TargetMs + 1;
  },
  /^freshness-p95-exceeded:/,
);
refuses(
  'a freshness receipt for a different workload',
  (e) => {
    e.receipts.freshness.workload = 'something-easier';
  },
  /^freshness-workload-mismatch:/,
);

// ─── A02: client certification must be bound to THIS candidate ────────────────────────────────

// The manifest's summary is not what covers a cell, in EITHER direction. A manifest that restates
// nothing is still certified by the raw receipts it did not restate…
assert.deepEqual(
  (() => {
    const evidence = completeEvidence();
    evidence.certification.receipts = [];
    return decide(evidence);
  })(),
  { decision: 'GO', blockers: [], certifying: true },
  'coverage comes from the raw receipts, not from the manifest restating them',
);
// …and a manifest claiming a runtime pass the raw receipts do not support is a tampering signal,
// reported per cell, because a manifest must never be able to certify itself.
refuses(
  'a manifest claiming cells the raw receipts do not cover',
  (_e, options) => {
    options.certificationReceipts = [];
  },
  /^certification-summary-unsupported:claude\/darwin$/,
);

// No receipts at all: every advertised cell is named, and nothing else is invented.
{
  const evidence = completeEvidence();
  evidence.certification.receipts = [];
  const result = decide(evidence, { certificationReceipts: [] });
  assert.equal(result.decision, 'NO-GO');
  assert.equal(
    result.blockers.filter((b) => b.startsWith('client-cell-uncertified:')).length,
    CLIENT_CELLS.length,
    'every advertised cell must be named when no receipts exist',
  );
  for (const cell of CLIENT_CELLS) {
    assert.ok(result.blockers.includes(`client-cell-uncertified:${cell}`), `${cell} must be named`);
  }
}

// Removing ONE receipt opens exactly ONE cell. The other twenty stay covered, so the report is
// actionable rather than a blanket refusal — a decision that can only say "something is missing" is
// not telling a reader what to collect.
//
// The lost receipt also makes the manifest's OWN summary unsupported, which is the A02 guard working
// as intended: the manifest claims a pass for a cell the raw receipts no longer cover, and that
// disagreement is reported rather than resolving silently in the manifest's favour.
{
  const missingCell = 'codex/win32';
  const options = fixtureOptions();
  options.certificationReceipts = options.certificationReceipts.filter(
    (receipt) => cellOf(receipt) !== missingCell,
  );
  const result = evaluateLaunchDecision(completeEvidence(), options);
  assert.equal(result.decision, 'NO-GO');
  assert.deepEqual(result.blockers, [
    `client-cell-uncertified:${missingCell}`,
    `certification-summary-unsupported:${missingCell}`,
    'acceptance-contradiction',
  ]);
  assert.equal(
    result.blockers.filter((b) => b.startsWith('client-cell-uncertified:')).length,
    1,
    'one missing receipt costs exactly one cell',
  );
}

// The binding facts. A foreign receipt is DISCARDED and the cell it claimed stays open; the two
// findings are reported separately because they answer different questions — "was this receipt about
// my build?" and "is this cell certified?".
refuses(
  'a full receipt set for ANOTHER commit',
  (_e, options) => {
    for (const receipt of options.certificationReceipts) receipt.product.commit = 'f'.repeat(40);
  },
  /^client-receipt-foreign-commit:/,
);
refuses(
  'receipts for another package digest',
  (_e, options) => {
    for (const receipt of options.certificationReceipts) {
      receipt.product.packageSha256 = `sha256:${'7'.repeat(64)}`;
    }
  },
  /^client-receipt-foreign-package:/,
);
refuses(
  'receipts collected under another policy',
  (_e, options) => {
    for (const receipt of options.certificationReceipts) {
      receipt.policySha256 = `sha256:${'6'.repeat(64)}`;
    }
  },
  /^client-receipt-foreign-policy:/,
);
{
  const cell = 'claude/darwin';
  const options = fixtureOptions();
  receiptFor(options.certificationReceipts, cell).product.commit = 'f'.repeat(40);
  const result = evaluateLaunchDecision(completeEvidence(), options);
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes(`client-receipt-foreign-commit:${cell}:${'f'.repeat(40)}`));
  assert.ok(result.blockers.includes(`client-cell-uncertified:${cell}`));
  assert.equal(
    result.blockers.filter((b) => b.startsWith('client-cell-uncertified:')).length,
    1,
    'one foreign receipt costs exactly one cell',
  );
}

// A leg that did not pass is named WITH its cause, so a reader never has to infer the reason from an
// absence — and the reason arrives from the receipt, not from a second vocabulary here.
refuses(
  'a receipt whose restart leg was blocked',
  (_e, options) => {
    receiptFor(options.certificationReceipts, 'claude/darwin').legs.restart = { status: 'blocked' };
  },
  /^client-cell-not-certifying:claude\/darwin:legs not passed: restart$/,
);

// A test client that merely speaks the protocol must not cover a cell. This probe hands the decision
// an ALREADY-PARSED receipt, which is the mode it consumes them in — the rule has to hold at the
// judgement site, not only in the loader that happens to run before it.
refuses(
  'a test-client handshake',
  (_e, options) => {
    receiptFor(options.certificationReceipts, 'claude/darwin').legs.handshake = {
      status: 'pass',
      source: 'test-client',
    };
  },
  /^client-cell-not-certifying:claude\/darwin:legs\.handshake was not produced by a vendor-client$/,
);

// WSL runs on a Windows host and reports itself as linux. It satisfies every leg and can still never
// be a native Linux or Windows runtime, so the cell stays open and the receipt says why.
refuses(
  'a WSL run claiming the native linux cell',
  (_e, options) => {
    receiptFor(options.certificationReceipts, 'cursor/linux').platform.wsl = true;
  },
  /^client-cell-not-certifying:cursor\/linux:a WSL run is not a native runtime$/,
);
// …while a native run of the same cell is ordinary evidence. The refusal is about the platform the
// run happened on, not a permanent mark against the client.
{
  const options = fixtureOptions();
  const wsl = receiptFor(options.certificationReceipts, 'cursor/linux');
  wsl.platform.wsl = true;
  const native = certificationReceipts().find((receipt) => cellOf(receipt) === 'cursor/linux');
  native.runId = 'run-cursor-linux-native';
  options.certificationReceipts.push(native);
  const result = evaluateLaunchDecision(completeEvidence(), options);
  assert.equal(result.decision, 'GO', JSON.stringify(result.blockers));
}

// A client version below the CELL's floor cannot cover its cell. The floor is read from the committed
// policy rather than restated, so the probe keeps meaning something if the number moves.
{
  const cell = 'claude/darwin';
  const floor = policy.clientVersionRequirements[cell];
  assert.ok(floor, `the policy must declare a ${cell} floor for this probe to mean anything`);
  const options = fixtureOptions();
  receiptFor(options.certificationReceipts, cell).client.version = '0.0.1';
  const result = evaluateLaunchDecision(completeEvidence(), options);
  assert.equal(result.decision, 'NO-GO');
  assert.ok(
    result.blockers.includes(`client-version-unsupported:${cell}:0.0.1 < ${floor}`),
    JSON.stringify(result.blockers),
  );
}
// The same law through the coverage helper directly: the floor is per client/platform, so a client
// keyed policy cannot certify a platform it never declared a floor for.
{
  const strictPolicy = {
    ...policy,
    clientVersionRequirements: {
      ...policy.clientVersionRequirements,
      'claude/darwin': '10000.0.0',
    },
  };
  const verdict = uncertifiedClientCells(certificationReceipts(), {
    policy: strictPolicy,
    policySha256: POLICY_SHA,
    candidate: CANDIDATE,
  });
  assert.ok(
    verdict.includes('client-version-unsupported:claude/darwin:9999.12.31 < 10000.0.0'),
    JSON.stringify(verdict),
  );
}

// ─── the transcript is what makes a leg evidence ──────────────────────────────────────────────
//
// "Altering a transcript after receipt generation invalidates its cell" is a claim about the loader,
// so it is proved through the loader: the same bytes that loaded a moment ago must refuse once a
// single character changes. The receipts are copied first, because the mutation is the point.
{
  const altered = join(root, 'altered');
  cpSync(receiptsDir, altered, { recursive: true });
  const victim = join(altered, 'logs', logName('claude/darwin'));
  writeFileSync(victim, `${readFileSync(victim, 'utf8')}tampered\n`);
  assert.throws(() => loadClientCertificationReceipts(altered), CertificationEvidenceError);
  assert.throws(
    () => loadClientCertificationReceipts(altered),
    /logs\/claude-darwin\.log/,
    'the refusal must name the transcript that no longer matches its receipt',
  );
}

// A hand-written receipt with no runtime artifact behind it cannot certify a cell — the legs are
// assertion and the transcript is evidence. Refused by the loader, and refused again by the cell
// judgement so it cannot certify a cell even when it never touches disk.
{
  const handwritten = join(root, 'handwritten');
  mkdirSync(handwritten, { recursive: true });
  const receipt = receiptFor(certificationReceipts(), 'claude/darwin');
  // The process identity stays — the receipt still describes a real client process. What is gone is
  // the transcript it points at, which is the only thing that could have made the legs more than an
  // assertion.
  receipt.vendor = { processIdentity: receipt.vendor.processIdentity };
  writeFileSync(join(handwritten, 'claude-darwin.json'), JSON.stringify(receipt));
  assert.throws(
    () => loadClientCertificationReceipts(handwritten),
    /a certifying receipt must reference a vendor transcript or log/,
  );
  assert.deepEqual(certifyClientCell(receipt), {
    ok: false,
    problem: 'client-cell-uncertified',
    cell: 'claude/darwin',
    detail: 'a certifying receipt references no runtime transcript or log',
  });
}

// A path that escapes the receipts area is refused rather than read: the receipt may name where its
// evidence is, but not outside the area the evidence was collected into.
{
  const escaping = join(root, 'escaping');
  mkdirSync(escaping, { recursive: true });
  const receipt = receiptFor(certificationReceipts(), 'claude/darwin');
  receipt.vendor.logPath = '../../etc/hosts';
  writeFileSync(join(escaping, 'claude-darwin.json'), JSON.stringify(receipt));
  assert.throws(() => loadClientCertificationReceipts(escaping), /escapes the receipts area/);
}

// Two receipts for one cell, and two cells sharing one run id, are both refused: one cell is one run,
// and a reused run id means one run's evidence is being counted twice.
{
  const duplicated = join(root, 'duplicated');
  cpSync(receiptsDir, duplicated, { recursive: true });
  const copy = receiptFor(certificationReceipts(), 'claude/darwin');
  copy.runId = 'run-claude-darwin-copy';
  writeFileSync(join(duplicated, 'claude-darwin-copy.json'), JSON.stringify(copy));
  assert.throws(
    () => loadClientCertificationReceipts(duplicated),
    /duplicate certification cell: claude\/darwin\/x64/,
  );
}
{
  const reused = join(root, 'reused-run-id');
  cpSync(receiptsDir, reused, { recursive: true });
  const copy = receiptFor(certificationReceipts(), 'claude/darwin');
  copy.platform.os = 'linux';
  writeFileSync(join(reused, 'claude-linux-shadow.json'), JSON.stringify(copy));
  assert.throws(
    () => loadClientCertificationReceipts(reused),
    /duplicate certification run id: run-claude-darwin/,
  );
}

// ─── candidate-wide receipts: the deep sweep ──────────────────────────────────────────────────
refuses(
  'an absent deep-fuzz receipt',
  (_e, options) => {
    options.globalReceipts = [];
  },
  /^global-receipt-missing:fuzz-deep$/,
);
refuses(
  'a failed deep-fuzz receipt',
  (_e, options) => {
    options.globalReceipts = [fuzzReceipt({ status: 'fail' })];
  },
  /^global-receipt-not-passing:fuzz-deep:fail$/,
);
refuses(
  'a deep-fuzz receipt for another commit',
  (_e, options) => {
    options.globalReceipts = [fuzzReceipt({ candidateCommit: 'f'.repeat(40) })];
  },
  /^global-receipt-foreign-commit:fuzz-deep$/,
);
refuses(
  'a deep-fuzz receipt for another package',
  (_e, options) => {
    options.globalReceipts = [fuzzReceipt({ candidatePackageSha256: `sha256:${'7'.repeat(64)}` })];
  },
  /^global-receipt-foreign-package:fuzz-deep$/,
);
refuses(
  'a deep-fuzz receipt collected under another policy',
  (_e, options) => {
    options.globalReceipts = [fuzzReceipt({ policySha256: `sha256:${'6'.repeat(64)}` })];
  },
  /^global-receipt-foreign-policy:fuzz-deep$/,
);
// The sweep's own numbers are re-judged against the policy. A receipt is not the authority on what a
// launch needs — the policy is — so a shallow run that reported success is still refused.
refuses(
  'a deep-fuzz receipt below the required iteration count',
  (_e, options) => {
    options.globalReceipts = [
      fuzzReceipt({
        details: { ...fuzzReceipt().details, iterations: FUZZ.requiredIterations - 1 },
      }),
    ];
  },
  /^fuzz-receipt-iterations-below-floor:/,
);
refuses(
  'a deep-fuzz receipt covering too few extractors',
  (_e, options) => {
    options.globalReceipts = [
      fuzzReceipt({
        details: { ...fuzzReceipt().details, extractorCount: FUZZ.minimumExtractors - 1 },
      }),
    ];
  },
  /^fuzz-receipt-extractors-below-floor:/,
);
refuses(
  'a deep-fuzz receipt for another workload',
  (_e, options) => {
    options.globalReceipts = [
      fuzzReceipt({ details: { ...fuzzReceipt().details, workload: 'a-shorter-sweep' } }),
    ];
  },
  /^fuzz-receipt-workload-mismatch:/,
);
refuses(
  'a deep-fuzz receipt with the wrong seed',
  (_e, options) => {
    options.globalReceipts = [
      fuzzReceipt({ details: { ...fuzzReceipt().details, seed: FUZZ.seed + 1 } }),
    ];
  },
  /^fuzz-receipt-seed-mismatch:/,
);
refuses(
  'a deep-fuzz receipt reporting failures',
  (_e, options) => {
    options.globalReceipts = [
      fuzzReceipt({ details: { ...fuzzReceipt().details, failures: [{ extractor: 'python' }] } }),
    ];
  },
  /^fuzz-receipt-failures:1$/,
);
refuses(
  'a deep-fuzz receipt with no artifact behind it',
  (_e, options) => {
    options.globalReceipts = [fuzzReceipt({ artifacts: [] })];
  },
  /^global-receipt-artifact-missing:fuzz-deep$/,
);
refuses(
  'a deep-fuzz receipt whose artifact no longer hashes to what it recorded',
  (_e, options) => {
    options.globalReceipts = [
      fuzzReceipt({ artifacts: [{ path: 'fuzz-deep.log', sha256: `sha256:${'5'.repeat(64)}` }] }),
    ];
  },
  /^global-receipt-artifact-digest:fuzz-deep:fuzz-deep\.log$/,
);
// A receipt whose evidence cannot be located is a claim, not a proof: without the directory there is
// nothing to hash, and that is named rather than skipped.
refuses(
  'a deep-fuzz receipt with nowhere to verify its artifact',
  (_e, options) => {
    options.globalReceiptsRoot = undefined;
  },
  /^global-receipt-artifact-unverifiable:fuzz-deep$/,
);

// ─── the manifest's own conclusion is compared, never trusted ─────────────────────────────────
{
  const evidence = completeEvidence();
  evidence.acceptance = { pass: true, requiredFailures: [] };
  evidence.receipts.recovery = { status: 'fail' };
  const result = decide(evidence);
  assert.ok(result.blockers.includes('acceptance-contradiction'));
  assert.ok(result.blockers.includes('receipt-not-passing:recovery:fail'));
}

// ─── A03: aggregation requires the exact policy cell set, one candidate ───────────────────────
const greenCells = () => OS_CELLS.map((cell) => ({ cell, manifest: completeEvidence() }));
const aggregateOptions = (overrides = {}) => ({
  candidate: CANDIDATE,
  certificationReceipts: certificationReceipts(),
  globalReceipts: [fuzzReceipt()],
  globalReceiptsRoot: globalDir,
  ...overrides,
});

{
  const all = aggregateLaunchDecisions(greenCells(), aggregateOptions());
  assert.equal(all.decision, 'GO', JSON.stringify(all.blockers));
  assert.deepEqual(all.candidate, CANDIDATE);
  assert.equal(all.policySha256, POLICY_SHA);
}

// The aggregate is the one place the 21 cells are judged, so an aggregate that never loaded them says
// so by name instead of passing on the strength of five green OS cells.
{
  const result = aggregateLaunchDecisions(
    greenCells(),
    aggregateOptions({ certificationReceipts: undefined }),
  );
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes('certification-receipts-not-loaded'));
  for (const cell of CLIENT_CELLS) {
    assert.ok(result.blockers.includes(`client-cell-uncertified:${cell}`), `${cell} must be named`);
  }
}
{
  const result = aggregateLaunchDecisions(
    greenCells(),
    aggregateOptions({ globalReceipts: undefined }),
  );
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes('global-receipts-not-loaded'));
  assert.ok(result.blockers.includes('global-receipt-missing:fuzz-deep'));
}

// The aggregate must publish a COMPLETE approved candidate even when the caller pinned only the
// commit: the release job refuses to ship without a digest, so an undefined one would block a
// legitimate GO (and, worse, invite someone to remove the check).
{
  const commitOnly = aggregateLaunchDecisions(
    greenCells(),
    aggregateOptions({ candidate: { commit: COMMIT } }),
  );
  assert.equal(commitOnly.decision, 'GO', JSON.stringify(commitOnly.blockers));
  assert.equal(commitOnly.candidate.packageSha256, PACKAGE);
  assert.equal(commitOnly.candidate.commit, COMMIT);
  assert.equal(commitOnly.policySha256, POLICY_SHA);
}

// One cell short of the policy set — the exact defect A03 named (a one-cell green aggregate).
{
  const one = aggregateLaunchDecisions(
    [{ cell: OS_CELLS[0], manifest: completeEvidence() }],
    aggregateOptions(),
  );
  assert.equal(one.decision, 'NO-GO', 'a single green cell must never aggregate to GO');
  for (const cell of OS_CELLS.slice(1)) {
    assert.ok(one.blockers.includes(`missing-evidence:${cell}`), `missing ${cell} must be named`);
  }
}

// A removed OS manifest blocks publication.
{
  const cells = greenCells();
  const dropped = cells.pop();
  const result = aggregateLaunchDecisions(cells, aggregateOptions());
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes(`missing-evidence:${dropped.cell}`));
}

// A duplicate cell is a defect, not a bonus.
{
  const cells = greenCells();
  cells.push({ cell: OS_CELLS[0], manifest: completeEvidence() });
  const result = aggregateLaunchDecisions(cells, aggregateOptions());
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes(`duplicate-cell:${OS_CELLS[0]}`));
}

// Mixed candidates: cells that do not all describe the same build.
{
  const cells = greenCells();
  const foreign = completeEvidence();
  foreign.candidate.commit = 'd'.repeat(40);
  foreign.reproducibility.git.commit = 'd'.repeat(40);
  cells[1] = { cell: OS_CELLS[1], manifest: foreign };
  const result = aggregateLaunchDecisions(cells, aggregateOptions());
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.some((b) => b.includes('candidate-commit-mismatch')));
}

// A red cell blocks the aggregate, and the green ones stay honestly green.
{
  const cells = greenCells();
  const red = completeEvidence();
  red.gates.find((gate) => gate.id === 'G2').measured = 0.1;
  cells[2] = { cell: OS_CELLS[2], manifest: red };
  const result = aggregateLaunchDecisions(cells, aggregateOptions());
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.some((b) => b.startsWith(`${OS_CELLS[2]}:gate-failed:G2`)));
  assert.deepEqual(result.cells.find((row) => row.cell === OS_CELLS[0]).blockers, []);
}

// An empty cell set is NO-GO with every policy cell named, never a vacuous GO.
{
  const empty = aggregateLaunchDecisions([], aggregateOptions());
  assert.equal(empty.decision, 'NO-GO');
  for (const cell of OS_CELLS) assert.ok(empty.blockers.includes(`missing-evidence:${cell}`));
}
// ...and a set that is empty BY CONSTRUCTION (no cells, and no expectation to narrow) says so in one
// actionable line rather than expanding into six names that describe the fixture, not the defect.
{
  const empty = aggregateLaunchDecisions([], aggregateOptions({ expectedCells: [] }));
  assert.equal(empty.decision, 'NO-GO');
  assert.deepEqual(empty.blockers, ['no-evidence']);
}

// A structurally invalid cell blocks the aggregate as invalid evidence.
{
  const cells = greenCells();
  cells[0].manifest.reproducibility.git.dirtyDigest = 'sha256:short';
  const result = aggregateLaunchDecisions(cells, aggregateOptions());
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.some((b) => b.startsWith(`invalid-evidence:${OS_CELLS[0]}`)));
}

// ─── CLI contract ─────────────────────────────────────────────────────────────────────────────
//
// The per-platform manifests written here carry NO certification summary at all. That is deliberate:
// the only way this run can reach GO is by loading and validating the 21 raw receipts itself, which
// is exactly the independence the plan demands of the aggregate. A CLI that trusted a manifest's
// copied-in summary would return NO-GO here, and this assertion would catch it.
for (const cell of OS_CELLS) {
  mkdirSync(join(cellsDir, dirname(cell)), { recursive: true });
  const manifest = completeEvidence();
  manifest.certification.receipts = [];
  writeFileSync(join(cellsDir, `${cell}.json`), JSON.stringify(manifest));
}
assert.deepEqual(loadReleaseEvidence(join(cellsDir, `${OS_CELLS[0]}.json`)).candidate.dirty, false);

const RECEIPTS_ARGS = ['--certification-receipts', receiptsDir, '--global-receipts', globalDir];
const decideCli = (args) =>
  spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/launch-decision.mjs'),
      '--cells',
      cellsDir,
      '--candidate-commit',
      COMMIT,
      '--candidate-package',
      PACKAGE,
      ...args,
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );

{
  const green = decideCli(RECEIPTS_ARGS);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /"decision": "GO"/);
  assert.match(green.stdout, /"policySha256"/);
}

// Each required input, withheld on its own, is a named blocker — never a silent pass.
{
  const withoutCertification = decideCli(['--global-receipts', globalDir]);
  assert.notEqual(withoutCertification.status, 0);
  assert.match(withoutCertification.stdout, /certification-receipts-not-loaded/);
  assert.match(withoutCertification.stdout, /client-cell-uncertified:claude\/darwin/);
}
{
  const withoutGlobal = decideCli(['--certification-receipts', receiptsDir]);
  assert.notEqual(withoutGlobal.status, 0);
  assert.match(withoutGlobal.stdout, /global-receipts-not-loaded/);
}

// Publishing the WRONG package: the same green cells and the same receipts, a different declared
// candidate. The build is judged, not the tag.
{
  const wrongPackage = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/launch-decision.mjs'),
      '--cells',
      cellsDir,
      '--candidate-commit',
      COMMIT,
      '--candidate-package',
      `sha256:${'5'.repeat(64)}`,
      ...RECEIPTS_ARGS,
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.notEqual(wrongPackage.status, 0);
  assert.match(wrongPackage.stdout, /candidate-package-mismatch/);
  // The receipts are bound to the real package too, so both facts are reported.
  assert.match(wrongPackage.stdout, /client-receipt-foreign-package:claude\/darwin/);
}

// A tampered transcript on disk fails the whole receipts directory — reported as one named cause
// alongside the cells it leaves open, so a reader sees both the reason and its cost.
{
  const tamperedRun = decideCli([
    '--certification-receipts',
    join(root, 'altered'),
    '--global-receipts',
    globalDir,
  ]);
  assert.notEqual(tamperedRun.status, 0);
  assert.match(tamperedRun.stdout, /certification-receipts-unreadable:/);
  assert.match(tamperedRun.stdout, /logs\/claude-darwin\.log/);
}

// A duplicated cell cannot be resolved by counting it twice.
{
  const duplicatedRun = decideCli([
    '--certification-receipts',
    join(root, 'duplicated'),
    '--global-receipts',
    globalDir,
  ]);
  assert.notEqual(duplicatedRun.status, 0);
  assert.match(duplicatedRun.stdout, /duplicate certification cell/);
}

// A missing global receipts directory is named rather than treated as "no receipts required".
{
  const absentGlobal = decideCli([
    '--certification-receipts',
    receiptsDir,
    '--global-receipts',
    join(root, 'nowhere'),
  ]);
  assert.notEqual(absentGlobal.status, 0);
  assert.match(absentGlobal.stdout, /global-receipts-unreadable:/);
}

// An acceptance receipt sitting beside the certification receipts is skipped, not mistaken for one:
// the two artifact types live side by side in a real evidence pass.
{
  const mixed = join(root, 'mixed');
  cpSync(receiptsDir, mixed, { recursive: true });
  writeFileSync(
    join(mixed, 'adapter.json'),
    JSON.stringify({
      format: 'knowledge-crib-acceptance-receipt',
      type: 'adapter',
      status: 'pass',
    }),
  );
  const mixedRun = decideCli(['--certification-receipts', mixed, '--global-receipts', globalDir]);
  assert.equal(mixedRun.status, 0, mixedRun.stdout + mixedRun.stderr);
  assert.match(mixedRun.stdout, /"decision": "GO"/);
}

// The cell ids on disk are file names, and a name that is not a policy cell id leaves that cell open.
// The policy's set is always required; the caller cannot narrow it away.
{
  const dashed = join(root, 'dashed');
  mkdirSync(dashed, { recursive: true });
  for (const cell of OS_CELLS) {
    writeFileSync(
      join(dashed, `${cell.replace(/\//g, '-')}.json`),
      JSON.stringify(completeEvidence()),
    );
  }
  const dashedRun = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/launch-decision.mjs'), '--cells', dashed, ...RECEIPTS_ARGS],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.notEqual(
    dashedRun.status,
    0,
    'file names that do not match the policy cell ids cannot pass',
  );
  assert.match(dashedRun.stdout, /missing-evidence:/);
}

// ─── a schema-1 manifest still loads, and still cannot certify ────────────────────────────────
{
  const legacyPath = join(root, 'legacy.json');
  writeFileSync(
    legacyPath,
    `${JSON.stringify(
      {
        format: 'knowledge-crib-release-evidence',
        formatVersion: 1,
        generatedAt: '2026-09-05T00:00:00.000Z',
        reproducibility: {
          git: {
            commit: COMMIT,
            branch: 'fixture',
            dirty: false,
            dirtyPaths: [],
            dirtyDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
        retrieval: { mode: 'lexical-fallback', scorer: 'unknown', model: { state: 'missing' } },
        product: { schemas: { soul: '1.6', memory: ['1'], evidenceManifest: '1' } },
        gates: [],
        acceptance: { pass: false, requiredFailures: ['semantic-model'] },
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(loadReleaseEvidence(legacyPath).formatVersion, 1);
  assert.equal(decide(loadReleaseEvidence(legacyPath)).certifying, false);
}

// A tampered manifest is refused by the validator before any decision reads a measurement from it.
{
  const tamperedPath = join(root, 'tampered.json');
  const tampered = completeEvidence();
  tampered.reproducibility.git.dirtyDigest = 'sha256:short';
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => loadReleaseEvidence(tamperedPath), /dirtyDigest/);
}

console.log('launch decision tests ok');
