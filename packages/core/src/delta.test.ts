import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDelta, fileScopedIds } from './delta.js';
import { newManifest } from './manifest.js';
import { SoulStore } from './soul-store.js';

let dir: string;
let soul: SoulStore;
let aSym: Node;
let bSym: Node;
let bCallsA: Edge;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-delta-'));
  soul = new SoulStore(dir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  soul.load();

  const aFile: Node = {
    id: idFor({ kind: 'file', path: 'src/a.ts' }),
    kind: 'file',
    file: 'src/a.ts',
    hash: contentHash('src/a.ts'),
    lang: 'typescript',
  };
  const bFile: Node = {
    id: idFor({ kind: 'file', path: 'src/b.ts' }),
    kind: 'file',
    file: 'src/b.ts',
    hash: contentHash('src/b.ts'),
    lang: 'typescript',
  };
  aSym = {
    id: idFor({ kind: 'symbol', path: 'src/a.ts', qualifiedName: 'greet', startLine: 1 }),
    kind: 'symbol',
    type: 'function',
    name: 'greet',
    qualifiedName: 'greet',
    file: 'src/a.ts',
    span: { start: 1, end: 3 },
    lang: 'typescript',
    hash: contentHash('src/a.ts#greet'),
  };
  bSym = {
    id: idFor({ kind: 'symbol', path: 'src/b.ts', qualifiedName: 'main', startLine: 2 }),
    kind: 'symbol',
    type: 'function',
    name: 'main',
    qualifiedName: 'main',
    file: 'src/b.ts',
    span: { start: 2, end: 3 },
    lang: 'typescript',
    hash: contentHash('src/b.ts#main'),
  };
  bCallsA = {
    id: edgeId(bSym.id, aSym.id, 'calls'),
    src: bSym.id,
    dst: aSym.id,
    rel: 'calls',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by: 'test' },
  };
  soul.putNodes([aFile, bFile, aSym, bSym]);
  soul.putEdges([bCallsA]);
  soul.commit('2026-01-01T00:00:00.000Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fileScopedIds membership (P0-4: edges route by src AND dst)', () => {
  it('captures a.ts nodes', () => {
    const ids = fileScopedIds(soul, new Set(['src/a.ts']));
    expect(ids.nodeIds.has(aSym.id)).toBe(true);
    expect(ids.nodeIds.has('file:src/a.ts')).toBe(true);
    expect(ids.nodeIds.has(bSym.id)).toBe(false); // b lives in src/b.ts
  });

  it('captures the incoming B→A edge by dst path (and by src path on b.ts)', () => {
    const aIds = fileScopedIds(soul, new Set(['src/a.ts']));
    expect(aIds.edgeIds.has(bCallsA.id)).toBe(true); // dst resolves to src/a.ts
    const bIds = fileScopedIds(soul, new Set(['src/b.ts']));
    expect(bIds.edgeIds.has(bCallsA.id)).toBe(true); // src resolves to src/b.ts
  });

  it('does NOT capture an edge whose endpoints are both outside the file set', () => {
    const ids = fileScopedIds(soul, new Set(['src/c.ts']));
    expect(ids.edgeIds.size).toBe(0);
    expect(ids.nodeIds.size).toBe(0);
  });
});

describe('buildDelta', () => {
  it('removed is empty and upserts present when nothing changed', () => {
    const before = fileScopedIds(soul, new Set(['src/a.ts', 'src/b.ts']));
    const delta = buildDelta(soul, before, new Set(['src/a.ts', 'src/b.ts']));
    expect(delta.removed).toEqual([]);
    expect(delta.nodes.map((n) => n.id)).toContain(aSym.id);
    expect(delta.edges.map((e) => e.id)).toContain(bCallsA.id);
  });

  it('reports removed node + edge ids after a scoped file is dropped', () => {
    const before = fileScopedIds(soul, new Set(['src/a.ts']));
    expect(before.nodeIds.has(aSym.id)).toBe(true);
    soul.removeByFile('src/a.ts');
    const delta = buildDelta(soul, before, new Set(['src/a.ts']));
    expect(delta.removed).toContain(aSym.id);
    expect(delta.removed).toContain('file:src/a.ts');
    expect(delta.removed).toContain(bCallsA.id); // dst touched src/a.ts → dropped
    expect(delta.nodes).toEqual([]);
  });
});
