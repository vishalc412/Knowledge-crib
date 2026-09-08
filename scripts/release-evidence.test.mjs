import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_EVIDENCE_FORMAT_VERSION,
  REQUIRED_GATE_IDS,
  ReleaseEvidenceError,
  buildReleaseEvidence,
  requiredGateFailures,
  validateReleaseEvidence,
  writeReleaseEvidence,
} from './release-evidence.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const greenReport = {
  preregistration: 'docs/bench/launch-gates.md',
  scale: 1,
  scorerVersion: 'memory-rank-v2:e5-large-1024:cosine:semantic-only',
  corpus: { records: 307, gatheredRecords: 323, eligibleRecords: 283, queries: 500 },
  gates: Array.from({ length: 8 }, (_, i) => ({
    id: `G${i + 1}`,
    name: `gate ${i + 1}`,
    measured: 1,
    threshold: 1,
    direction: 'gte',
    detail: 'fixture',
    pass: true,
  })),
  pass: true,
};

const base = {
  generatedAt: '2026-09-05T00:00:00.000Z',
  git: {
    commit: 'a'.repeat(40),
    branch: 'codex/launch-readiness',
    dirty: false,
    dirtyPaths: [],
    dirtyDigest: `sha256:${'0'.repeat(64)}`,
  },
  platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1', cpu: 'fixture', ramBytes: 1 },
  packages: { 'knowledge-crib': '0.1.0' },
  schemas: { soul: '1.6', memory: ['1', '2', '3'], evidenceManifest: '1' },
  clients: { codex: 'unknown' },
  embedder: {
    state: 'installed',
    modelId: 'intfloat/multilingual-e5-large',
    modelVersion: '1',
    embedderId: 'e5-large-1024',
    dim: 1024,
    manifestSha256: `sha256:${'1'.repeat(64)}`,
  },
  launchGate: greenReport,
  workload: { name: 'memory-launch-corpus', queries: 500, records: 307, scale: 1 },
};

const manifest = buildReleaseEvidence(base);
assert.equal(manifest.format, 'knowledge-crib-release-evidence');
assert.equal(manifest.formatVersion, RELEASE_EVIDENCE_FORMAT_VERSION);
assert.equal(manifest.acceptance.pass, true);
assert.deepEqual(requiredGateFailures(manifest), []);
assert.equal(manifest.reproducibility.git.dirty, false);
assert.equal(manifest.retrieval.model.id, 'intfloat/multilingual-e5-large');
assert.equal(manifest.retrieval.model.version, '1');
assert.equal(manifest.retrieval.scorer, greenReport.scorerVersion);
// WP9.2 — the receipt carries exactly the frozen G1..G8 gate set, nothing self-reported.
assert.deepEqual(
  manifest.gates.map((g) => g.id),
  REQUIRED_GATE_IDS,
);

const dirty = buildReleaseEvidence({
  ...base,
  git: {
    ...base.git,
    dirty: true,
    dirtyPaths: ['packages/memory/src/recall.ts'],
  },
});
assert.deepEqual(requiredGateFailures(dirty), ['clean-commit']);
assert.equal(dirty.acceptance.pass, false);

const red = buildReleaseEvidence({
  ...base,
  launchGate: {
    ...greenReport,
    pass: false,
    gates: greenReport.gates.map((g) => (g.id === 'G2' ? { ...g, pass: false } : g)),
  },
});
assert.deepEqual(requiredGateFailures(red), ['G2']);
assert.equal(red.acceptance.pass, false);

const lexical = buildReleaseEvidence({
  ...base,
  embedder: { state: 'missing', reason: 'not installed' },
  launchGate: greenReport,
});
assert.deepEqual(requiredGateFailures(lexical), ['semantic-model']);
assert.equal(lexical.acceptance.pass, false);

const missingCertification = buildReleaseEvidence({
  ...base,
  requireRuntimeCertification: true,
  certificationReceipts: [],
});
assert.equal(missingCertification.certification.required, true);
assert.equal(missingCertification.certification.missingRuntimeCells.length, 21);
assert.deepEqual(requiredGateFailures(missingCertification), ['runtime-certification']);

const certifiedCells = [
  'claude',
  'copilot',
  'cursor',
  'codex',
  'windsurf',
  'gemini',
  'vscode',
].flatMap((client) =>
  ['darwin', 'linux', 'win32'].map((os) => ({
    client: { id: client, version: '1.0.0' },
    platform: { os, arch: 'fixture', node: 'v22.23.1' },
    evidence: { runtime: { status: 'pass' } },
  })),
);
const certified = buildReleaseEvidence({
  ...base,
  requireRuntimeCertification: true,
  certificationReceipts: certifiedCells,
});
assert.deepEqual(certified.certification.missingRuntimeCells, []);
assert.equal(certified.acceptance.pass, true);

// ─── WP9.2 — the frozen gate set, scorer identity and model revision are REQUIRED ───
// launch-eval.ts computes pass via gates.every(), so a deleted gate would otherwise leave
// pass=true; the evidence builder must fail the receipt on any deviation from the frozen set.
const missingGate = buildReleaseEvidence({
  ...base,
  launchGate: { ...greenReport, gates: greenReport.gates.filter((g) => g.id !== 'G5') },
});
assert.ok(requiredGateFailures(missingGate).includes('gate-set:missing:G5'));
assert.equal(missingGate.acceptance.pass, false);

const extraGate = buildReleaseEvidence({
  ...base,
  launchGate: {
    ...greenReport,
    gates: [...greenReport.gates, { id: 'G9', name: 'fabricated', pass: true }],
  },
});
assert.ok(requiredGateFailures(extraGate).includes('gate-set:extra:G9'));
assert.equal(extraGate.acceptance.pass, false);

// The builder emits G1..G8 exactly once, so a duplicate id is fabrication, and it is rejected.
const duplicateGate = buildReleaseEvidence({
  ...base,
  launchGate: { ...greenReport, gates: [...greenReport.gates, greenReport.gates[1]] },
});
assert.ok(requiredGateFailures(duplicateGate).includes('gate-set:duplicate:G2'));
assert.equal(duplicateGate.acceptance.pass, false);

// An absent scorer version must never pass silently under --require-pass.
const unknownScorer = buildReleaseEvidence({
  ...base,
  requirePass: true,
  launchGate: { ...greenReport, scorerVersion: undefined },
});
assert.ok(requiredGateFailures(unknownScorer).includes('scorer-identity'));
assert.equal(unknownScorer.acceptance.pass, false);
assert.equal(unknownScorer.retrieval.scorer, 'unknown');

// An installed embedder must report which model revision produced the semantic tier.
const missingModelRevision = buildReleaseEvidence({
  ...base,
  embedder: { ...base.embedder, modelVersion: undefined },
});
assert.ok(requiredGateFailures(missingModelRevision).includes('model-revision'));
assert.equal(missingModelRevision.acceptance.pass, false);

// ─── WP9.1 — validateReleaseEvidence: tamper / omission / duplicate legs ───
const clone = (value) => JSON.parse(JSON.stringify(value));
const validManifest = buildReleaseEvidence(base);
assert.equal(validateReleaseEvidence(validManifest), validManifest);

// Tamper leg: each mutated field is named by the refusal.
const tamperedDigest = clone(validManifest);
tamperedDigest.reproducibility.git.dirtyDigest = 'sha256:not-a-digest';
assert.throws(
  () => validateReleaseEvidence(tamperedDigest),
  (error) => error instanceof ReleaseEvidenceError && /dirtyDigest/.test(error.message),
);
const tamperedModel = clone(validManifest);
tamperedModel.retrieval.model.manifestSha256 = 'sha256:model';
assert.throws(
  () => validateReleaseEvidence(tamperedModel),
  (error) => error instanceof ReleaseEvidenceError && /manifestSha256/.test(error.message),
);
const tamperedVerdictType = clone(validManifest);
tamperedVerdictType.acceptance.pass = 'true';
assert.throws(
  () => validateReleaseEvidence(tamperedVerdictType),
  (error) => error instanceof ReleaseEvidenceError && /acceptance\.pass/.test(error.message),
);
const tamperedFormat = clone(validManifest);
tamperedFormat.format = 'knowledge-crib-release-evidence-v2';
assert.throws(
  () => validateReleaseEvidence(tamperedFormat),
  (error) => error instanceof ReleaseEvidenceError && /format/.test(error.message),
);
// The original WP9.1 gap: a red manifest edited to acceptance.pass=true must be refused even
// though the edit is type-correct — its own gates array still shows the failed gate.
const tamperedVerdict = clone(validManifest);
tamperedVerdict.gates = tamperedVerdict.gates.map((g) =>
  g.id === 'G2' ? { ...g, pass: false } : g,
);
tamperedVerdict.acceptance.pass = true;
tamperedVerdict.acceptance.requiredFailures = [];
assert.throws(
  () => validateReleaseEvidence(tamperedVerdict),
  (error) => error instanceof ReleaseEvidenceError && /G2/.test(error.message),
);

// Omission leg: each deleted required field is named by the refusal.
const omittedEvidenceSchema = clone(validManifest);
omittedEvidenceSchema.product.schemas.evidenceManifest = undefined;
assert.throws(
  () => validateReleaseEvidence(omittedEvidenceSchema),
  (error) =>
    error instanceof ReleaseEvidenceError && /schemas\.evidenceManifest/.test(error.message),
);
const omittedCommit = clone(validManifest);
omittedCommit.reproducibility.git.commit = undefined;
assert.throws(
  () => validateReleaseEvidence(omittedCommit),
  (error) => error instanceof ReleaseEvidenceError && /git\.commit/.test(error.message),
);
const omittedAcceptance = clone(validManifest);
omittedAcceptance.acceptance = undefined;
assert.throws(
  () => validateReleaseEvidence(omittedAcceptance),
  (error) => error instanceof ReleaseEvidenceError && /acceptance/.test(error.message),
);
const omittedGates = clone(validManifest);
omittedGates.gates = undefined;
assert.throws(
  () => validateReleaseEvidence(omittedGates),
  (error) => error instanceof ReleaseEvidenceError && /gates/.test(error.message),
);

// Duplicate leg: the gate ids are the format's keyed collection, and they are unique-by-value —
// the builder emits G1..G8 exactly once, so a duplicated id is rejected as fabrication.
const duplicatedGates = clone(validManifest);
duplicatedGates.gates.push(clone(validManifest.gates[1]));
assert.throws(
  () => validateReleaseEvidence(duplicatedGates),
  (error) =>
    error instanceof ReleaseEvidenceError && /duplicate gate id in gates: G2/.test(error.message),
);

const dir = mkdtempSync(join(tmpdir(), 'crib-release-evidence-'));
try {
  const out = join(dir, 'manifest.json');
  writeReleaseEvidence(out, manifest);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), manifest);

  // The decision path must refuse the tampered file end-to-end, not just the validator:
  // launch-decision.mjs exits non-zero naming the offending field instead of printing a GO.
  const tamperedPath = join(dir, 'tampered.json');
  writeFileSync(tamperedPath, `${JSON.stringify(tamperedVerdict, null, 2)}\n`);
  const refused = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/launch-decision.mjs'), '--evidence', tamperedPath],
    { encoding: 'utf8', cwd: repoRoot },
  );
  assert.notEqual(refused.status, 0, 'launch decision must refuse tampered evidence');
  assert.match(refused.stderr, /G2/);
  assert.ok(!refused.stdout.includes('GO'), 'a tampered manifest must never yield GO');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts?.['release:evidence'], 'node scripts/release-evidence.mjs --require-pass');
assert.match(
  readFileSync('scripts/release-verify.mjs', 'utf8'),
  /pnpm\(\['release:evidence'\]\)/,
  'release verification must enforce the evidence manifest after builds and quality checks',
);
assert.match(
  readFileSync('scripts/release-verify.mjs', 'utf8'),
  /release-evidence\.test\.mjs/,
  'release verification must run this self-check (tamper/omission/duplicate legs) after the launch-decision check',
);

console.log('release evidence tests ok');
