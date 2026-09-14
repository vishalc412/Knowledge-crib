/**
 * Fuzz receipt artifact-path tests (Task 4 regression).
 *
 * The deep-fuzz harness used to record its transcript with a MACHINE-ABSOLUTE path. The launch
 * decision resolves artifact paths against the receipts root it was handed, and resolve() honours
 * an absolute path VERBATIM — so the transcript digest could never verify once the receipts moved
 * (the CI layout uploads them out of the checkout entirely): every real release run NO-GO'd on
 * `global-receipt-artifact-digest:fuzz-deep`. The producer-side contract — record the artifact
 * RELATIVE to the receipt's own directory, with --artifact-root naming what to resolve it against
 * — is what these tests pin. The decision side (a relative artifact verifying from the receipts
 * root) is already covered by launch-decision.test.mjs's fuzz fixtures.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReceipt } from './write-receipt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const root = mkdtempSync(join(tmpdir(), 'fuzz-receipt-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const shaOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// ── the receipt records its transcript relative to its own directory ─────────────────────────────
// Exactly what the harness produces: a transcript beside the receipt (fuzz-deep.json.log), passed
// with --artifact-root so the writer resolves and hashes it at build time but stores the PATH
// relative — relocatable evidence, the collector's established pattern.
const sweepDir = join(root, 'evidence', 'global');
mkdirSync(sweepDir, { recursive: true });
const transcriptBytes = 'the archived transcript bytes\n';
writeFileSync(join(sweepDir, 'fuzz-deep.json.log'), transcriptBytes);
const pkgBytes = 'candidate tarball bytes\n';
writeFileSync(join(root, 'candidate.tgz'), pkgBytes);

const receipt = buildReceipt({
  type: 'fuzz-deep',
  argv: [
    '--command',
    'node scripts/fuzz-check.mjs --iterations 1000000',
    '--exit-code',
    '0',
    '--status',
    'pass',
    '--artifact',
    'fuzz-deep.json.log',
    '--artifact-root',
    sweepDir,
    '--package',
    join(root, 'candidate.tgz'),
  ],
  details: { workload: 'seeded-deep', seed: 1, iterations: 1000000 },
});
assert.equal(
  receipt.artifacts[0]?.path,
  'fuzz-deep.json.log',
  'the stored artifact path must be the relative name, not the machine-absolute path',
);
assert.ok(!isAbsolute(receipt.artifacts[0].path), 'a stored artifact path must never be absolute');
assert.equal(receipt.artifacts[0].sha256, shaOf(transcriptBytes));
assert.equal(receipt.status, 'pass');

// The property that was broken: the receipt still verifies after its whole directory has MOVED —
// which is what an upload + download between producer and judge is. The decision resolves
// `<receiptsRoot>/<artifact.path>`; a relative path survives that, an absolute one cannot.
const movedDir = join(root, 'downloaded', 'global');
mkdirSync(dirname(movedDir), { recursive: true });
renameSync(sweepDir, movedDir);
const movedArtifact = join(movedDir, receipt.artifacts[0].path);
assert.ok(existsSync(movedArtifact), 'the recorded artifact must resolve from the MOVED root');
assert.equal(shaOf(readFileSync(movedArtifact)), receipt.artifacts[0].sha256);

// The inverse is the old defect: a receipt whose artifact path is absolute pins its evidence to
// the producing machine's directory tree — refuse nothing at build time (the writer cannot know
// the future root), but the PATH FIELD is what a judge resolves, so the contract is on the field.
const absoluteReceipt = buildReceipt({
  type: 'fuzz-deep',
  argv: [
    '--command',
    'node scripts/fuzz-check.mjs --iterations 1000000',
    '--exit-code',
    '0',
    '--status',
    'pass',
    '--artifact',
    join(movedDir, 'fuzz-deep.json.log'),
    '--package',
    join(root, 'candidate.tgz'),
  ],
  details: { workload: 'seeded-deep', seed: 1, iterations: 1000000 },
});
assert.equal(absoluteReceipt.artifacts[0].path, join(movedDir, 'fuzz-deep.json.log'));
assert.ok(
  isAbsolute(absoluteReceipt.artifacts[0].path),
  'a bare --artifact is stored VERBATIM (the writer does not relativize) — the harness must relativize itself',
);

// ── the harness side: fuzz-check.mjs is not importable (importing it runs the sweep), so the
// artifact argv is pinned by reading the source — the exact seam that broke, in the only way it
// can be tested without running a million-iteration fuzz.
const source = readFileSync(join(HERE, 'fuzz-check.mjs'), 'utf8');
assert.match(
  source,
  /'--artifact',\s*relative\(receiptDir,\s*archived\)/,
  'the harness must record the transcript relative to the receipt directory, never machine-absolute',
);
assert.match(
  source,
  /'--artifact-root',\s*receiptDir/,
  'the harness must pass --artifact-root so the writer hashes the transcript at build time',
);

console.log('fuzz receipt artifact tests ok');
