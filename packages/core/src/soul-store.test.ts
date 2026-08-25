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

describe('schema 1.2 round-trip + 1.1 forward-compat (Workstream G)', () => {
  it('round-trips every 1.2 behavior node + edge field through write→read byte-identically', () => {
    const proc: Node = {
      id: idFor({ kind: 'symbol', path: 'src/loan.pkb', qualifiedName: 'assess', startLine: 5 }),
      kind: 'symbol',
      type: 'procedure',
      name: 'assess',
      qualifiedName: 'assess',
      file: 'src/loan.pkb',
      span: { start: 5, end: 30 },
      lang: 'plsql',
      hash: contentHash('assess'),
    };
    const raise: Node = {
      id: idFor({ kind: 'raise', file: 'src/loan.pkb', line: 12 }),
      kind: 'raise',
      name: 'raise_application_error',
      errorCode: '-20001',
      errorMessage: 'bad claim',
      file: 'src/loan.pkb',
      span: { start: 12, end: 12 },
      lang: 'plsql',
      hash: contentHash('raise'),
    };
    const exc: Node = {
      id: idFor({ kind: 'exception-handler', file: 'src/loan.pkb', line: 20 }),
      kind: 'exception-handler',
      whenSelector: 'NO_DATA_FOUND',
      file: 'src/loan.pkb',
      span: { start: 20, end: 20 },
      lang: 'plsql',
      hash: contentHash('exc'),
    };
    const caseB: Node = {
      id: idFor({ kind: 'case-branch', file: 'src/loan.pkb', line: 9 }),
      kind: 'case-branch',
      whenSelector: "v_status = 'OPEN'",
      file: 'src/loan.pkb',
      span: { start: 9, end: 9 },
      lang: 'plsql',
      hash: contentHash('case'),
    };
    const assign: Node = {
      id: idFor({ kind: 'assignment', file: 'src/loan.pkb', line: 8 }),
      kind: 'assignment',
      assignTarget: 'v_status',
      file: 'src/loan.pkb',
      span: { start: 8, end: 8 },
      lang: 'plsql',
      hash: contentHash('assign'),
    };
    const cursor: Node = {
      id: idFor({ kind: 'cursor', file: 'src/loan.pkb', name: 'c_app', line: 6 }),
      kind: 'cursor',
      name: 'c_app',
      cursorQuery: 'SELECT * FROM loan_applications',
      file: 'src/loan.pkb',
      span: { start: 6, end: 6 },
      lang: 'plsql',
      hash: contentHash('cursor'),
    };
    const expl: Node = {
      id: idFor({ kind: 'explanation', path: 'src/loan.pkb', startLine: 4 }),
      kind: 'explanation',
      commentRef: { file: 'src/loan.pkb', span: { start: 3, end: 4 } },
      file: 'src/loan.pkb',
      span: { start: 3, end: 4 },
      lang: 'plsql',
      hash: contentHash('expl'),
      meta: { text: 'assess a loan' },
    };
    const mk = (rel: Edge['rel'], src: string, dst: string): Edge => ({
      id: edgeId(src, dst, rel),
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      // 1.1/1.2 edge guard-chain fields round-trip too
      cfgPath: ['root', 'if'],
      branch: 'THEN',
      inLoop: true,
      inException: false,
      evidence: { by: 'test' },
    });

    const store = open();
    store.putNodes([fileNode('src/loan.pkb'), proc, raise, exc, caseB, assign, cursor, expl]);
    store.putEdges([
      mk('raises', proc.id, raise.id),
      mk('handles', exc.id, assign.id),
      mk('iterates', caseB.id, cursor.id),
      mk('declares', proc.id, cursor.id),
      mk('describes', expl.id, proc.id),
    ]);
    store.commit('2026-01-01T00:00:00.000Z');

    const reopened = open();
    // every 1.2 node field preserved verbatim
    expect(reopened.getNode(raise.id)).toEqual(raise);
    expect(reopened.getNode(exc.id)).toEqual(exc);
    expect(reopened.getNode(caseB.id)).toEqual(caseB);
    expect(reopened.getNode(assign.id)).toEqual(assign);
    expect(reopened.getNode(cursor.id)).toEqual(cursor);
    expect(reopened.getNode(expl.id)).toEqual(expl);
    // every 1.2 rel + guard-chain edge field preserved verbatim
    for (const rel of ['raises', 'handles', 'iterates', 'declares', 'describes'] as const) {
      const e = [...reopened.iterateEdges(rel)][0]!;
      expect(e.cfgPath).toEqual(['root', 'if']);
      expect(e.branch).toBe('THEN');
      expect(e.inLoop).toBe(true);
      expect(e.inException).toBe(false);
    }
    // re-commit is byte-stable (no churn on an unchanged soul)
    const snap1 = snapshotJsonl(dir);
    reopened.commit('2026-01-01T00:00:00.000Z');
    expect(snapshotJsonl(dir)).toEqual(snap1);
  });

  it('loads a 1.1 soul verbatim + rewrites it byte-stably WITHOUT widening to 1.2', () => {
    // a 1.1 soul: cfgPath:string[] + inLoop/inException, but no 1.2 kinds/fields.
    const manifest11 = {
      ...newManifest({ now: '2026-01-01T00:00:00.000Z', repoId: 'fixed' }),
      schemaVersion: '1.1' as const,
    };
    const store = new SoulStore(dir, { manifest: manifest11 });
    store.load(); // no crib.json yet → keeps the 1.1 manifest
    expect(store.getManifest().schemaVersion).toBe('1.1');

    const a = symNode('src/a.ts', 'doA', 1);
    store.putNodes([fileNode('src/a.ts'), a]);
    store.putEdges([
      {
        id: edgeId(a.id, a.id, 'executes'),
        src: a.id,
        dst: a.id,
        rel: 'executes',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        cfgPath: ['doA'],
        inLoop: false,
        evidence: { by: 'test' },
      },
    ]);
    store.commit('2026-01-01T00:00:00.000Z');

    // reload: schemaVersion stays 1.1 (the loader never widens), 1.1 fields preserved
    const reopened = new SoulStore(dir);
    reopened.load();
    expect(reopened.getManifest().schemaVersion).toBe('1.1');
    const e = [...reopened.iterateEdges('executes')][0]!;
    expect(e.cfgPath).toEqual(['doA']);
    expect(e.inLoop).toBe(false);

    // re-commit a 1.1 soul is byte-stable (no silent 1.2 widening churn)
    const snap1 = snapshotJsonl(dir);
    reopened.commit('2026-01-01T00:00:00.000Z');
    expect(snapshotJsonl(dir)).toEqual(snap1);
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

describe('atomic cluster replacement', () => {
  it('validates full replacement before removing existing topology', () => {
    const a = symNode('src/a.ts', 'doA', 1);
    const first: Node = {
      id: 'c:first',
      kind: 'cluster',
      members: [a.id],
      hash: contentHash('first'),
    };
    const membership: Edge = {
      id: edgeId(a.id, first.id, 'member-of'),
      src: a.id,
      dst: first.id,
      rel: 'member-of',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
    };
    const store = open();
    store.putNodes([a]);
    store.replaceClusters([first], [membership]);

    const invalid: Node = {
      id: 'c:invalid',
      kind: 'cluster',
      members: ['sym:missing'],
      hash: contentHash('invalid'),
    };
    expect(() => store.replaceClusters([invalid], [])).toThrow('missing member');
    expect(store.getNode(first.id)).toEqual(first);
    expect(store.getEdge(membership.id)).toEqual(membership);
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

// The kind index is a cache: `iterate(kind)` serves pre-bucketed arrays instead of scanning every
// node. Every mutation path must invalidate it, or reads silently serve a stale view of the soul.
describe('kind index invalidation', () => {
  const kinds = (soul: SoulStore, kind: 'symbol' | 'file') =>
    [...soul.iterate(kind)].map((n) => n.id).sort();

  it('putNodes after a read is visible to iterate(kind)', () => {
    const soul = new SoulStore(dir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
    soul.load();
    const a = symNode('src/a.ts', 'a', 1);
    soul.putNodes([fileNode('src/a.ts'), a]);
    expect(kinds(soul, 'symbol')).toEqual([a.id]); // warms the cache

    const b = symNode('src/b.ts', 'b', 1);
    soul.putNodes([fileNode('src/b.ts'), b]);
    expect(kinds(soul, 'symbol')).toEqual([a.id, b.id].sort());
    expect(kinds(soul, 'file')).toHaveLength(2);
  });

  it('removeByFile after a read is visible to iterate(kind)', () => {
    const soul = new SoulStore(dir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
    soul.load();
    const a = symNode('src/a.ts', 'a', 1);
    const b = symNode('src/b.ts', 'b', 1);
    soul.putNodes([fileNode('src/a.ts'), fileNode('src/b.ts'), a, b]);
    expect(kinds(soul, 'symbol')).toHaveLength(2); // warms the cache

    soul.removeByFile('src/a.ts');
    expect(kinds(soul, 'symbol')).toEqual([b.id]);
  });

  it('iterate(kind) preserves insertion order, which the determinism gates depend on', () => {
    const soul = new SoulStore(dir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
    soul.load();
    const nodes = [
      symNode('src/z.ts', 'z', 1),
      symNode('src/a.ts', 'a', 1),
      symNode('src/m.ts', 'm', 1),
    ];
    soul.putNodes(nodes);
    expect([...soul.iterate('symbol')].map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });

  it('nodeGeneration advances on every mutation so derived caches can version off it', () => {
    const soul = new SoulStore(dir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
    soul.load();
    const before = soul.nodeGeneration;
    soul.putNodes([symNode('src/a.ts', 'a', 1)]);
    const afterPut = soul.nodeGeneration;
    expect(afterPut).toBeGreaterThan(before);
    soul.removeByFile('src/a.ts');
    expect(soul.nodeGeneration).toBeGreaterThan(afterPut);
  });
});
