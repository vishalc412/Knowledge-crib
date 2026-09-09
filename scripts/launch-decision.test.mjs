/**
 * The launch decision's contract, stated as probes.
 *
 * The audit (A01/A02) drove four independent probes to GO that should never have reached it:
 * ordinary non-certifying evidence, a manifest with an empty gate array, one with `git.dirty=true`,
 * and one with `retrieval.model={}`. A fifth (A02) applied 21 receipts for commit B to candidate A.
 * Each of those is a named case below, and the shape of this file is deliberate: ONE complete
 * fixture that earns GO, then one mutation per mandatory fact, each asserted to return NO-GO with
 * its exact reason. A decision that cannot be made to fail is not a decision.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateLaunchDecisions,
  evaluateLaunchDecision,
  loadReleaseEvidence,
} from './launch-decision.mjs';
import { loadLaunchPolicy, policyClientCells, policyOsNodeCells } from './launch-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { policy, sha256: POLICY_SHA } = loadLaunchPolicy();

const COMMIT = 'a'.repeat(40);
const PACKAGE = `sha256:${'b'.repeat(64)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const SCORER = policy.semanticModel.supportedScorers[0];

/** A measurement that passes the policy's own threshold for one gate. */
function passingMeasurement(gate) {
  return gate.direction === 'gte' ? gate.threshold : gate.threshold;
}

/** Every advertised client/platform cell, certified against THIS candidate. */
function certificationReceipts() {
  return policyClientCells(policy).map((cell) => {
    const [id, os] = cell.split('/');
    return {
      client: { id, version: '1.0.0' },
      platform: { os, arch: 'x64' },
      product: { commit: COMMIT, packageSha256: PACKAGE },
      policySha256: POLICY_SHA,
      runtimeStatus: 'pass',
    };
  });
}

/** The complete, certifying manifest — the ONLY shape that may produce GO. */
function completeEvidence() {
  return {
    format: 'knowledge-crib-release-evidence',
    formatVersion: 2,
    generatedAt: '2026-09-09T00:00:00.000Z',
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
      startedAt: '2026-09-09T00:00:00.000Z',
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
    certification: { receipts: certificationReceipts() },
    acceptance: { pass: true, requiredFailures: [] },
  };
}

const CANDIDATE = { commit: COMMIT, packageSha256: PACKAGE };
const decide = (evidence) => evaluateLaunchDecision(evidence, { candidate: CANDIDATE });

/** Mutate one fact and assert the decision refuses with a blocker matching `pattern`. */
function refuses(label, mutate, pattern) {
  const evidence = completeEvidence();
  mutate(evidence);
  const result = decide(evidence);
  assert.equal(result.decision, 'NO-GO', `${label} must be NO-GO`);
  assert.ok(
    result.blockers.some((blocker) => pattern.test(blocker)),
    `${label}: expected a blocker matching ${pattern}, got ${JSON.stringify(result.blockers)}`,
  );
}

// ─── the one shape that earns GO ──────────────────────────────────────────────
const complete = decide(completeEvidence());
assert.deepEqual(
  complete,
  { decision: 'GO', blockers: [], certifying: true },
  `a complete independent fixture must return GO, got ${JSON.stringify(complete)}`,
);

// ─── A01: the four probes that used to return GO ──────────────────────────────

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

// ─── gates: set, thresholds, directions, measurements, contradictions ─────────
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

// ─── candidate identity and policy binding ────────────────────────────────────
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

// ─── typed receipts: missing types are blockers, never inferences ─────────────
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

// ─── the preregistered freshness target is enforced, not decorative ───────────
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

// ─── A02: client certification must be bound to THIS candidate ────────────────
{
  const evidence = completeEvidence();
  evidence.certification.receipts = [];
  const result = decide(evidence);
  assert.equal(result.decision, 'NO-GO');
  assert.equal(
    result.blockers.filter((b) => b.startsWith('client-cell-uncertified:')).length,
    policyClientCells(policy).length,
    'every advertised cell must be named when no receipts exist',
  );
  assert.ok(result.blockers.includes('client-cell-uncertified:claude/win32'));
}
refuses(
  'a full 21-cell receipt set for ANOTHER commit',
  (e) => {
    for (const receipt of e.certification.receipts) receipt.product.commit = 'f'.repeat(40);
  },
  /^client-receipt-foreign-commit:/,
);
refuses(
  'receipts for another package digest',
  (e) => {
    for (const receipt of e.certification.receipts)
      receipt.product.packageSha256 = `sha256:${'7'.repeat(64)}`;
  },
  /^client-receipt-foreign-package:/,
);
refuses(
  'receipts collected under another policy',
  (e) => {
    for (const receipt of e.certification.receipts)
      receipt.policySha256 = `sha256:${'6'.repeat(64)}`;
  },
  /^client-receipt-foreign-policy:/,
);
refuses(
  'a protocol-only receipt promoted to a runtime cell',
  (e) => {
    e.certification.receipts[0].runtimeStatus = 'not-run';
  },
  /^client-cell-uncertified:/,
);
refuses(
  'a WSL run standing in for a native linux cell',
  (e) => {
    for (const receipt of e.certification.receipts) {
      if (receipt.platform.os === 'linux') receipt.platform.wsl = true;
    }
  },
  /^client-cell-uncertified:[a-z]+\/linux$/,
);

// A client version below a policy-declared minimum cannot cover its cell.
{
  const strictPolicy = {
    ...policy,
    clientVersionRequirements: { claude: '2.0.0' },
  };
  const result = evaluateLaunchDecision(completeEvidence(), {
    policy: strictPolicy,
    policySha256: POLICY_SHA,
    candidate: CANDIDATE,
  });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(
    result.blockers.some((b) => b.startsWith('client-version-unsupported:claude/')),
    `expected an unsupported-version blocker, got ${JSON.stringify(result.blockers)}`,
  );
}

// ─── the manifest's own conclusion is compared, never trusted ─────────────────
{
  const evidence = completeEvidence();
  evidence.acceptance = { pass: true, requiredFailures: [] };
  evidence.receipts.recovery = { status: 'fail' };
  const result = decide(evidence);
  assert.ok(result.blockers.includes('acceptance-contradiction'));
  assert.ok(result.blockers.includes('receipt-not-passing:recovery:fail'));
}

// ─── A03: aggregation requires the exact policy cell set, one candidate ───────
const osCells = policyOsNodeCells(policy);
const greenCells = () => osCells.map((cell) => ({ cell, manifest: completeEvidence() }));

{
  const all = aggregateLaunchDecisions(greenCells(), { candidate: CANDIDATE });
  assert.equal(all.decision, 'GO', JSON.stringify(all.blockers));
  assert.deepEqual(all.candidate, CANDIDATE);
}

// One cell short of the policy set — the exact defect A03 named (a one-cell green aggregate).
{
  const one = aggregateLaunchDecisions([{ cell: osCells[0], manifest: completeEvidence() }], {
    candidate: CANDIDATE,
  });
  assert.equal(one.decision, 'NO-GO', 'a single green cell must never aggregate to GO');
  for (const cell of osCells.slice(1)) {
    assert.ok(one.blockers.includes(`missing-evidence:${cell}`), `missing ${cell} must be named`);
  }
}

// A removed OS manifest blocks publication.
{
  const cells = greenCells();
  const dropped = cells.pop();
  const result = aggregateLaunchDecisions(cells, { candidate: CANDIDATE });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes(`missing-evidence:${dropped.cell}`));
}

// A duplicate cell is a defect, not a bonus.
{
  const cells = greenCells();
  cells.push({ cell: osCells[0], manifest: completeEvidence() });
  const result = aggregateLaunchDecisions(cells, { candidate: CANDIDATE });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.includes(`duplicate-cell:${osCells[0]}`));
}

// Mixed candidates: cells that do not all describe the same build.
{
  const cells = greenCells();
  const foreign = completeEvidence();
  foreign.candidate.commit = 'd'.repeat(40);
  foreign.reproducibility.git.commit = 'd'.repeat(40);
  cells[1] = { cell: osCells[1], manifest: foreign };
  const result = aggregateLaunchDecisions(cells, { candidate: CANDIDATE });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.some((b) => b.includes('candidate-commit-mismatch')));
}

// A red cell blocks the aggregate, and the green ones stay honestly green.
{
  const cells = greenCells();
  const red = completeEvidence();
  red.gates.find((gate) => gate.id === 'G2').measured = 0.1;
  cells[2] = { cell: osCells[2], manifest: red };
  const result = aggregateLaunchDecisions(cells, { candidate: CANDIDATE });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.some((b) => b.startsWith(`${osCells[2]}:gate-failed:G2`)));
  assert.deepEqual(result.cells.find((row) => row.cell === osCells[0]).blockers, []);
}

// An empty cell set is NO-GO with every policy cell named, never a vacuous GO.
{
  const empty = aggregateLaunchDecisions([], { candidate: CANDIDATE });
  assert.equal(empty.decision, 'NO-GO');
  for (const cell of osCells) assert.ok(empty.blockers.includes(`missing-evidence:${cell}`));
}

// A structurally invalid cell blocks the aggregate as invalid evidence.
{
  const cells = greenCells();
  cells[0].manifest.reproducibility.git.dirtyDigest = 'sha256:short';
  const result = aggregateLaunchDecisions(cells, { candidate: CANDIDATE });
  assert.equal(result.decision, 'NO-GO');
  assert.ok(result.blockers.some((b) => b.startsWith(`invalid-evidence:${osCells[0]}`)));
}

// ─── CLI contract ─────────────────────────────────────────────────────────────
const evidenceDir = mkdtempSync(join(tmpdir(), 'crib-launch-decision-'));
try {
  const greenPath = join(evidenceDir, 'green.json');
  writeFileSync(greenPath, `${JSON.stringify(completeEvidence(), null, 2)}\n`);
  assert.equal(loadReleaseEvidence(greenPath).acceptance.pass, true);

  // A schema-1 manifest still LOADS (diagnostics survive) but cannot certify.
  const legacy = {
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
  };
  const legacyPath = join(evidenceDir, 'legacy.json');
  writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
  assert.equal(loadReleaseEvidence(legacyPath).formatVersion, 1);
  assert.equal(decide(legacy).certifying, false);

  const tamperedPath = join(evidenceDir, 'tampered.json');
  const tampered = completeEvidence();
  tampered.reproducibility.git.dirtyDigest = 'sha256:short';
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => loadReleaseEvidence(tamperedPath), /dirtyDigest/);

  const cellsDir = join(evidenceDir, 'cells');
  mkdirSync(cellsDir);
  for (const cell of osCells) {
    writeFileSync(
      join(cellsDir, `${cell.replace(/\//g, '-')}.json`),
      JSON.stringify(completeEvidence()),
    );
  }
  // The cell ids on disk are file names; the policy set is expressed with '/'. The CLI must still
  // require the policy cells, so this run is NO-GO with every policy cell named as missing.
  const run = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/launch-decision.mjs'), '--cells', cellsDir],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.notEqual(run.status, 0, 'file names that do not match the policy cell ids cannot pass');
  assert.match(run.stdout, /missing-evidence:/);

  // Named exactly as the policy declares them, the same manifests aggregate to GO.
  const namedDir = join(evidenceDir, 'named');
  for (const cell of osCells) {
    mkdirSync(join(namedDir, dirname(cell)), { recursive: true });
    writeFileSync(join(namedDir, `${cell}.json`), JSON.stringify(completeEvidence()));
  }
  const namedRun = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/launch-decision.mjs'),
      '--cells',
      namedDir,
      '--candidate-commit',
      COMMIT,
      '--candidate-package',
      PACKAGE,
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.equal(namedRun.status, 0, namedRun.stdout + namedRun.stderr);
  assert.match(namedRun.stdout, /"decision": "GO"/);

  // Publishing the WRONG package: the same green cells, a different declared candidate.
  const wrongPackage = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/launch-decision.mjs'),
      '--cells',
      namedDir,
      '--candidate-commit',
      COMMIT,
      '--candidate-package',
      `sha256:${'5'.repeat(64)}`,
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.notEqual(wrongPackage.status, 0);
  assert.match(wrongPackage.stdout, /candidate-package-mismatch/);
} finally {
  rmSync(evidenceDir, { recursive: true, force: true });
}

console.log('launch decision tests ok');
