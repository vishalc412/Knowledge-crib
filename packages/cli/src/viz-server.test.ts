import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VizHttpError, readVizNodeSource, resolveVizAsset } from './viz-server.js';

let root: string;
let outside: string;
let soul: SoulStore;

function sourceNode(file: string, start = 2, end = 3): Node {
  return {
    id: idFor({ kind: 'symbol', path: file, qualifiedName: 'demo.run', startLine: start }),
    kind: 'symbol',
    type: 'function',
    name: 'run',
    qualifiedName: 'demo.run',
    file,
    span: { start, end },
    lang: 'typescript',
    hash: contentHash(file),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crib-viz-source-'));
  outside = mkdtempSync(join(tmpdir(), 'crib-viz-outside-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  soul = new SoulStore(join(root, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('viz source endpoint helpers', () => {
  it('returns exact UTF-8 source span through indexed node id', async () => {
    writeFileSync(join(root, 'src', 'demo.ts'), 'zero\nconst café = 1;\nreturn café;\nlast\n');
    const node = sourceNode('src/demo.ts');
    soul.putNodes([node]);

    await expect(readVizNodeSource(soul, root, node.id)).resolves.toEqual({
      nodeId: node.id,
      file: 'src/demo.ts',
      span: { start: 2, end: 3 },
      excerpt: { start: 2, end: 3, text: 'const café = 1;\nreturn café;', truncated: false },
    });
  });

  it('rejects indexed traversal and symlink escape', async () => {
    writeFileSync(join(outside, 'secret.ts'), 'secret\n');
    const traversal = sourceNode(`../${outside.split('/').pop()}/secret.ts`, 1, 1);
    soul.putNodes([traversal]);
    await expect(readVizNodeSource(soul, root, traversal.id)).rejects.toMatchObject({
      status: 403,
    });

    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'linked.ts'));
    const linked = sourceNode('src/linked.ts', 1, 1);
    soul.putNodes([linked]);
    await expect(readVizNodeSource(soul, root, linked.id)).rejects.toMatchObject({ status: 403 });
  });

  it('reports unavailable and missing source distinctly', async () => {
    const noLocation: Node = {
      id: 'sym:no-location',
      kind: 'symbol',
      hash: contentHash('none'),
    };
    soul.putNodes([noLocation]);
    await expect(readVizNodeSource(soul, root, noLocation.id)).rejects.toMatchObject({
      status: 422,
    });
    await expect(readVizNodeSource(soul, root, 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('caps long previews and reports deleted indexed files', async () => {
    writeFileSync(
      join(root, 'src', 'long.ts'),
      Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n'),
    );
    const long = sourceNode('src/long.ts', 1, 250);
    const deleted = sourceNode('src/deleted.ts', 1, 1);
    soul.putNodes([long, deleted]);

    const preview = await readVizNodeSource(soul, root, long.id);
    expect(preview.excerpt.start).toBe(1);
    expect(preview.excerpt.end).toBe(200);
    expect(preview.excerpt.text.split('\n')).toHaveLength(200);
    expect(preview.excerpt.truncated).toBe(true);
    await expect(readVizNodeSource(soul, root, deleted.id)).rejects.toMatchObject({ status: 404 });
  });

  it('contains static assets and rejects traversal', async () => {
    const assets = join(root, 'assets');
    mkdirSync(assets);
    writeFileSync(join(assets, 'index.html'), 'ok');
    writeFileSync(join(root, 'src', 'demo.ts'), 'outside asset root');
    await expect(resolveVizAsset(assets, '/')).resolves.toBe(
      realpathSync(join(assets, 'index.html')),
    );
    await expect(resolveVizAsset(assets, '/../src/demo.ts')).rejects.toBeInstanceOf(VizHttpError);
    await expect(resolveVizAsset(assets, '/%2e%2e/src/demo.ts')).rejects.toMatchObject({
      status: 403,
    });
  });
});
