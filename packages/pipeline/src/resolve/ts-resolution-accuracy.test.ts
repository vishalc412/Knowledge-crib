import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

interface Labels {
  positiveEdges: string[];
  forbiddenEdges: string[];
  unresolvedCalls: string[];
}

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'ts-resolution-accuracy',
);
const LABELS = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'labels.json'), 'utf8')) as Labels;

let cribDir: string;
beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-ts-accuracy-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('F11 labelled TypeScript call-resolution fixture', () => {
  it('publishes perfect precision and recall for statically resolvable calls', async () => {
    const soul = new SoulStore(cribDir, {
      manifest: newManifest({ now: '2026-09-05T00:00:00.000Z' }),
    });
    soul.load();
    await indexRepo(soul, FIXTURE_ROOT, {
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
    const expected = new Set(LABELS.positiveEdges);
    const tp = [...actual].filter((edge) => expected.has(edge)).length;
    const fp = [...actual].filter((edge) => !expected.has(edge)).length;
    const fn = [...expected].filter((edge) => !actual.has(edge)).length;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);

    expect({ tp, fp, fn, precision, recall }).toEqual({
      tp: 5,
      fp: 0,
      fn: 0,
      precision: 1,
      recall: 1,
    });
    for (const edge of LABELS.forbiddenEdges) expect(actual.has(edge)).toBe(false);
    expect(LABELS.unresolvedCalls).toContain('dynamic.ghost');
  });
});
