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
import { REQUIRED_GATE_IDS } from './release-evidence.mjs';

assert.deepEqual(
  evaluateLaunchDecision({
    acceptance: { pass: true, requiredFailures: [] },
    certification: { required: true, missingRuntimeCells: [] },
  }),
  { decision: 'GO', blockers: [] },
);
assert.deepEqual(
  evaluateLaunchDecision({
    acceptance: { pass: false, requiredFailures: ['clean-commit', 'runtime-certification'] },
    certification: { required: true, missingRuntimeCells: ['codex/win32'] },
  }),
  {
    decision: 'NO-GO',
    blockers: ['clean-commit', 'runtime-certification', 'codex/win32'],
  },
);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A structurally valid green cell manifest — validateReleaseEvidence must accept it as-is. */
const greenCell = () => ({
  format: 'knowledge-crib-release-evidence',
  formatVersion: 1,
  generatedAt: '2026-09-05T00:00:00.000Z',
  reproducibility: {
    git: {
      commit: 'a'.repeat(40),
      branch: 'fixture',
      dirty: false,
      dirtyPaths: [],
      dirtyDigest: `sha256:${'0'.repeat(64)}`,
    },
  },
  retrieval: {
    mode: 'on-device-semantic',
    scorer: 'memory-rank-v2:e5-large-1024:cosine:semantic-only',
    model: {
      id: 'intfloat/multilingual-e5-large',
      version: '1',
      embedderId: 'e5-large-1024',
      dim: 1024,
      manifestSha256: `sha256:${'1'.repeat(64)}`,
    },
  },
  product: { schemas: { soul: '1.6', memory: ['1'], evidenceManifest: '1' } },
  gates: REQUIRED_GATE_IDS.map((id) => ({ id, pass: true })),
  acceptance: { pass: true, requiredFailures: [] },
});

const redCell = () => {
  const cell = greenCell();
  cell.gates = cell.gates.map((gate) => (gate.id === 'G2' ? { ...gate, pass: false } : gate));
  cell.acceptance = { pass: false, requiredFailures: ['G2'] };
  return cell;
};

// ─── WP9.4 — aggregate decisions across cells ───
// (a) three OS cells pass -> GO.
const allGreen = aggregateLaunchDecisions(
  ['verify/ubuntu-latest', 'verify/macos-latest', 'verify/windows-latest'].map((cell) => ({
    cell,
    manifest: greenCell(),
  })),
);
assert.equal(allGreen.decision, 'GO');
assert.deepEqual(allGreen.blockers, []);
assert.deepEqual(
  allGreen.cells.map((row) => row.decision),
  ['GO', 'GO', 'GO'],
);

// (b) windows red -> NO-GO with a windows-tagged blocker; ubuntu success alone is insufficient.
const mixed = aggregateLaunchDecisions([
  { cell: 'verify/ubuntu-latest', manifest: greenCell() },
  { cell: 'verify/windows-latest', manifest: redCell() },
]);
assert.equal(mixed.decision, 'NO-GO', 'one green cell must not carry a red one');
assert.ok(mixed.blockers.includes('verify/windows-latest:G2'));
assert.deepEqual(mixed.cells.find((row) => row.cell === 'verify/ubuntu-latest').blockers, []);

// (c) one cell file missing -> NO-GO with 'missing-evidence:<cell>'.
const withMissing = aggregateLaunchDecisions([
  { cell: 'verify/ubuntu-latest', manifest: greenCell() },
  { cell: 'verify/windows-latest', manifest: null },
]);
assert.equal(withMissing.decision, 'NO-GO');
assert.ok(withMissing.blockers.includes('missing-evidence:verify/windows-latest'));

// A structurally invalid cell blocks the aggregate as invalid evidence.
const tampered = greenCell();
tampered.reproducibility.git.dirtyDigest = 'sha256:short';
const withInvalid = aggregateLaunchDecisions([
  { cell: 'verify/ubuntu-latest', manifest: tampered },
]);
assert.equal(withInvalid.decision, 'NO-GO');
assert.ok(withInvalid.blockers.includes('invalid-evidence:verify/ubuntu-latest'));

// An empty cell set is NO-GO, never a vacuous GO.
assert.deepEqual(aggregateLaunchDecisions([]), {
  decision: 'NO-GO',
  blockers: ['no-evidence'],
  cells: [],
});

// ─── WP9.1 — loadReleaseEvidence refuses tampered files before any decision reads them ───
const evidenceDir = mkdtempSync(join(tmpdir(), 'crib-launch-decision-'));
try {
  const greenPath = join(evidenceDir, 'green.json');
  writeFileSync(greenPath, `${JSON.stringify(greenCell(), null, 2)}\n`);
  assert.equal(loadReleaseEvidence(greenPath).acceptance.pass, true);

  const tamperedPath = join(evidenceDir, 'tampered.json');
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(() => loadReleaseEvidence(tamperedPath), /dirtyDigest/);

  // CLI contract: `node scripts/launch-decision.mjs --cells <dir>` exits 0 only on aggregate GO,
  // and --expect pins the matrix so a cell whose file never arrived is NO-GO missing-evidence.
  const cellsDir = join(evidenceDir, 'cells');
  mkdirSync(cellsDir);
  writeFileSync(join(cellsDir, 'verify-ubuntu-latest.json'), JSON.stringify(greenCell()));
  writeFileSync(join(cellsDir, 'verify-windows-latest.json'), JSON.stringify(redCell()));

  const goRun = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/launch-decision.mjs'),
      '--cells',
      cellsDir,
      '--expect',
      'verify-ubuntu-latest,verify-windows-latest',
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );
  // windows is red here, so this run is NO-GO; it proves the CLI surfaces cell-tagged blockers.
  assert.notEqual(goRun.status, 0);
  assert.match(goRun.stdout, /verify-windows-latest:G2/);

  const allGreenDir = join(evidenceDir, 'all-green');
  mkdirSync(allGreenDir);
  writeFileSync(join(allGreenDir, 'verify-ubuntu-latest.json'), JSON.stringify(greenCell()));
  writeFileSync(join(allGreenDir, 'verify-windows-latest.json'), JSON.stringify(greenCell()));
  const goOnly = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/launch-decision.mjs'),
      '--cells',
      allGreenDir,
      '--expect',
      'verify-ubuntu-latest,verify-windows-latest',
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.equal(goOnly.status, 0);
  assert.match(goOnly.stdout, /"decision": "GO"/);

  const missingRun = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts/launch-decision.mjs'),
      '--cells',
      allGreenDir,
      '--expect',
      'verify-ubuntu-latest,verify-windows-latest,verify/macos-latest',
    ],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stdout, /missing-evidence:verify\/macos-latest/);
} finally {
  rmSync(evidenceDir, { recursive: true, force: true });
}

console.log('launch decision tests ok');
