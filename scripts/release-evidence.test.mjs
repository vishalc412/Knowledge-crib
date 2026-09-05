import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReleaseEvidence,
  requiredGateFailures,
  writeReleaseEvidence,
} from './release-evidence.mjs';

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
    commit: 'abc123',
    branch: 'codex/launch-readiness',
    dirty: true,
    dirtyPaths: ['packages/memory/src/recall.ts'],
    dirtyDigest: 'sha256:fixture',
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
    manifestSha256: 'sha256:model',
  },
  launchGate: greenReport,
  workload: { name: 'memory-launch-corpus', queries: 500, records: 307, scale: 1 },
};

const manifest = buildReleaseEvidence(base);
assert.equal(manifest.format, 'knowledge-crib-release-evidence');
assert.equal(manifest.formatVersion, 1);
assert.equal(manifest.acceptance.pass, true);
assert.deepEqual(requiredGateFailures(manifest), []);
assert.equal(manifest.reproducibility.git.dirty, true);
assert.equal(manifest.retrieval.model.id, 'intfloat/multilingual-e5-large');
assert.equal(manifest.retrieval.scorer, greenReport.scorerVersion);

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

const dir = mkdtempSync(join(tmpdir(), 'crib-release-evidence-'));
try {
  const out = join(dir, 'manifest.json');
  writeReleaseEvidence(out, manifest);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), manifest);
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

console.log('release evidence tests ok');
