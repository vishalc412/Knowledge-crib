import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newManifest } from './manifest.js';
import { SoulStore } from './soul-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-soul-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileNode(path: string): Node {
  return {
    id: idFor({ kind: 'file', path }),
    kind: 'file',
    file: path,
    hash: contentHash(path),
    lang: 'typescript',
  };
}
function symNode(path: string, name: string, line: number): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: name, startLine: line }),
    kind: 'symbol',
    type: 'function',
    name,
    qualifiedName: name,
    file: path,
    span: { start: line, end: line + 2 },
    lang: 'typescript',
    hash: contentHash(`${path}#${name}`),
  };
}
function callEdge(
  src: Node,
  dst: Node,
  conf = 1.0,
  provenance: Edge['provenance'] = 'EXTRACTED',
): Edge {
  return {
    id: edgeId(src.id, dst.id, 'calls'),
    src: src.id,
    dst: dst.id,
    rel: 'calls',
    method: 'static',
    provenance,
    confidence: conf,
    evidence: { by: 'test' },
  };
}

function open(): SoulStore {
  const store = new SoulStore(dir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  store.load();
  return store;
}

describe('round-trip + byte stability (M0 gate)', () => {
  it('persists nodes/edges and reloads them identically', () => {
    const a = symNode('src/a.ts', 'doA', 1);
    const b = symNode('src/b.ts', 'doB', 5);
    const store = open();
    store.putNodes([fileNode('src/a.ts'), fileNode('src/b.ts'), a, b]);
    store.putEdges([callEdge(a, b)]);
    store.commit('2026-01-01T00:00:00.000Z');

    const reopened = open();
    expect([...reopened.iterate('symbol')].map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect([...reopened.iterateEdges('calls')]).toHaveLength(1);
    expect(reopened.getNode(a.id)).toEqual(a);
  });

  it('re-indexing identical content produces byte-identical chunks', () => {
    const a = symNode('src/a.ts', 'doA', 1);
    const b = symNode('src/b.ts', 'doB', 5);
    const build = () => {
      const s = new SoulStore(dir, {
        manifest: newManifest({ now: '2026-01-01T00:00:00.000Z', repoId: 'fixed' }),
      });
      s.load();
      s.putNodes([fileNode('src/a.ts'), fileNode('src/b.ts'), a, b]);
      s.putEdges([callEdge(a, b)]);
      s.commit('2026-01-01T00:00:00.000Z');
    };
    build();
    const snapshot = snapshotJsonl(dir);
    rmSync(dir, { recursive: true, force: true });
    build();
    expect(snapshotJsonl(dir)).toEqual(snapshot);
  });

  it("a one-file edit rewrites only that file's shard", () => {
    const a = symNode('src/a.ts', 'doA', 1);
    const store = open();
    store.putNodes([fileNode('src/a.ts'), a]);
    store.commit('2026-01-01T00:00:00.000Z');
    const before = snapshotJsonl(dir);

    // Re-open, edit only b in a brand-new file; a's shard chunk must be untouched.
    const s2 = open();
    const b = symNode('src/b.ts', 'doB', 9);
    s2.putNodes([fileNode('src/b.ts'), b]);
    s2.commit('2026-01-02T00:00:00.000Z');
    const after = snapshotJsonl(dir);

    for (const [path, content] of Object.entries(before)) {
      expect(after[path]).toBe(content); // a's chunks unchanged
    }
    expect(Object.keys(after).length).toBeGreaterThan(Object.keys(before).length);
  });
});

describe('invariant #1 — no dangling edges after commit', () => {
  it('drops edges whose endpoints do not exist', () => {
    const a = symNode('src/a.ts', 'doA', 1);
    const ghost = symNode('src/ghost.ts', 'ghost', 1);
    const store = open();
    store.putNodes([fileNode('src/a.ts'), a]);
    store.putEdges([callEdge(a, ghost)]); // dst missing
    store.commit('2026-01-01T00:00:00.000Z');
    expect([...store.iterateEdges()]).toHaveLength(0);
  });
});

describe('invariant #4 — closed enums reject unknown values', () => {
  it('rejects an unknown node kind', () => {
    const store = open();
    expect(() =>
      store.putNodes([{ id: 'x:1', kind: 'bogus' as never, hash: 'blake3:00' }]),
    ).toThrow();
  });
  it('rejects an unknown edge rel', () => {
    const store = open();
    expect(() =>
      store.putEdges([
        {
          id: 'e:00',
          src: 'a',
          dst: 'b',
          rel: 'frobnicates' as never,
          method: 'static',
          provenance: 'EXTRACTED',
          confidence: 1,
        },
      ]),
    ).toThrow();
  });
});

describe('invariant #5 — unknown meta preserved on round-trip', () => {
  it('keeps extension fields', () => {
    const a = symNode('src/a.ts', 'doA', 1);
    a.meta = { customTool: 'x', nested: { k: [1, 2, 3] } };
    const store = open();
    store.putNodes([fileNode('src/a.ts'), a]);
    store.commit('2026-01-01T00:00:00.000Z');
    expect(open().getNode(a.id)?.meta).toEqual({ customTool: 'x', nested: { k: [1, 2, 3] } });
  });
});

describe('incremental removeByFile', () => {
  it("removes a file's nodes and touching edges", () => {
    const a = symNode('src/a.ts', 'doA', 1);
    const b = symNode('src/b.ts', 'doB', 5);
    const store = open();
    store.putNodes([fileNode('src/a.ts'), fileNode('src/b.ts'), a, b]);
    store.putEdges([callEdge(a, b)]);
    store.commit('2026-01-01T00:00:00.000Z');

    store.removeByFile('src/a.ts');
    store.commit('2026-01-02T00:00:00.000Z');
    const reopened = open();
    expect(reopened.getNode(a.id)).toBeUndefined();
    expect(reopened.getNode(b.id)).toBeDefined();
    expect([...reopened.iterateEdges('calls')]).toHaveLength(0); // edge touched a.ts
  });
});

/** Read every .jsonl + manifest under .crib into a path→content map for byte comparison. */
function snapshotJsonl(cribRoot: string): Record<string, string> {
  const crib = join(cribRoot);
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const abs = join(crib, rel);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = join(rel, e);
      const childAbs = join(crib, childRel);
      if (statSync(childAbs).isDirectory()) walk(childRel);
      else if (e.endsWith('.jsonl')) out[childRel] = readFileSync(childAbs, 'utf8');
    }
  };
  walk('');
  return out;
}
