import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { SoulStore, newManifest } from '../packages/core/dist/index.js';
import { indexRepo } from '../packages/pipeline/dist/index.js';

const fixtureRoot = resolve('packages/pipeline/fixtures/ts-resolution-accuracy');
const labelsPath = resolve(fixtureRoot, 'labels.json');
const labelBytes = readFileSync(labelsPath);
const labels = JSON.parse(labelBytes);
const temp = mkdtempSync(resolve(tmpdir(), 'crib-graph-accuracy-'));

try {
  const soul = new SoulStore(temp, {
    manifest: newManifest({ now: '2026-09-05T00:00:00.000Z' }),
  });
  soul.load();
  await indexRepo(soul, fixtureRoot, {
    now: '2026-09-05T00:00:00.000Z',
    ownership: false,
    dossiers: false,
  });
  const nodes = new Map([...soul.iterate('symbol')].map((node) => [node.id, node]));
  const actual = new Set(
    [...soul.iterateEdges('calls')].map((edge) => {
      const src = nodes.get(edge.src)?.qualifiedName ?? edge.src;
      const dst = nodes.get(edge.dst)?.qualifiedName ?? edge.dst;
      return `${src} -> ${dst}`;
    }),
  );
  const expected = new Set(labels.positiveEdges);
  const tp = [...actual].filter((edge) => expected.has(edge)).length;
  const fp = [...actual].filter((edge) => !expected.has(edge)).length;
  const fn = [...expected].filter((edge) => !actual.has(edge)).length;
  const report = {
    format: 'knowledge-crib-graph-accuracy',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: 'ts-resolution-accuracy',
    labelsSha256: `sha256:${createHash('sha256').update(labelBytes).digest('hex')}`,
    language: labels.language,
    resolutionMethod: 'static',
    categories: labels.categories,
    counts: {
      labelledPositive: expected.size,
      labelledUnresolved: labels.unresolvedCalls.length,
      truePositive: tp,
      falsePositive: fp,
      falseNegative: fn,
    },
    precision: tp / Math.max(1, tp + fp),
    recall: tp / Math.max(1, tp + fn),
    unresolvedWithoutConfidentEdge: labels.forbiddenEdges.every((edge) => !actual.has(edge)),
    actualEdges: [...actual].sort(),
  };
  const outIndex = process.argv.indexOf('--out');
  if (outIndex >= 0) {
    const out = resolve(process.argv[outIndex + 1]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.precision !== 1 || report.recall !== 1 || !report.unresolvedWithoutConfidentEdge) {
    process.exitCode = 1;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
