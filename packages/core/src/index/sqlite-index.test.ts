import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newManifest } from '../manifest.js';
import { SoulStore } from '../soul-store.js';
import { openIndex } from './factory.js';
import { KuzuIndexStore } from './kuzu-index.js';
import { SqliteIndexStore } from './sqlite-index.js';

let dir: string;
let store: SoulStore;

function sym(path: string, name: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: name, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: name.split('.').pop() ?? name,
    qualifiedName: name,
    file: path,
    span: { start: line, end: line + 2 },
    lang: 'typescript',
    hash: contentHash(`${path}#${name}`),
    ...extra,
  };
}
function file(path: string): Node {
  return { id: idFor({ kind: 'file', path }), kind: 'file', file: path, hash: contentHash(path) };
}
function calls(src: Node, dst: Node): Edge {
  return {
    id: edgeId(src.id, dst.id, 'calls'),
    src: src.id,
    dst: dst.id,
    rel: 'calls',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
  };
}

// Graph:  controller --calls--> AuthService.login --calls--> TokenService.issue
const controller = sym('src/http/Controller.ts', 'Controller.handle', 10);
const login = sym('src/auth/AuthService.ts', 'AuthService.login', 42, {
  signature: 'login(email,pw):Session',
});
const issue = sym('src/auth/TokenService.ts', 'TokenService.issue', 88);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-idx-'));
  store = new SoulStore(dir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  store.load();
  store.putNodes([
    file('src/http/Controller.ts'),
    file('src/auth/AuthService.ts'),
    file('src/auth/TokenService.ts'),
    controller,
    login,
    issue,
  ]);
  store.putEdges([calls(controller, login), calls(login, issue)]);
  store.commit('2026-01-01T00:00:00.000Z');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteIndexStore.buildFromSoul + query (M1 gate)', () => {
  it('BM25 query returns the expected symbol id', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    const hits = idx.query({ text: 'login', kinds: ['symbol'] });
    expect(hits[0]?.id).toBe(login.id);
    idx.close();
  });

  it('query respects kind filter', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    const onlyFiles = idx.query({ text: 'AuthService' });
    // both the file node and the symbol mention AuthService; filter narrows it
    expect(
      idx.query({ text: 'AuthService', kinds: ['file'] }).every((h) => h.kind === 'file'),
    ).toBe(true);
    expect(onlyFiles.length).toBeGreaterThan(0);
    idx.close();
  });
});

describe('impact (blast radius)', () => {
  it('up = dependents: who is affected if login changes', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    const res = idx.impact(login.id, 'up');
    expect(res.nodes).toContain(controller.id);
    expect(res.nodes).not.toContain(issue.id);
    idx.close();
  });
  it('down = dependencies: what login relies on', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    const res = idx.impact(login.id, 'down');
    expect(res.nodes).toContain(issue.id);
    expect(res.nodes).not.toContain(controller.id);
    idx.close();
  });
  it('depth limits the traversal', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    expect(idx.impact(controller.id, 'down', 1).nodes).toEqual([login.id]);
    expect(idx.impact(controller.id, 'down', 2).nodes.sort()).toEqual([login.id, issue.id].sort());
    idx.close();
  });
});

describe('neighbors + shortestPath', () => {
  it('neighbors filters by rel and dir', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    expect(idx.neighbors(login.id, 'calls', 'down').map((e) => e.dst)).toEqual([issue.id]);
    expect(idx.neighbors(login.id, 'calls', 'up').map((e) => e.src)).toEqual([controller.id]);
    idx.close();
  });
  it('shortestPath walks the call chain', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    const p = idx.shortestPath(controller.id, issue.id);
    expect(p.found).toBe(true);
    expect(p.path).toEqual([controller.id, login.id, issue.id]);
    expect(p.edges).toHaveLength(2);
    expect(idx.shortestPath(issue.id, controller.id).found).toBe(false); // directed
    idx.close();
  });
});

describe('applyDelta (incremental)', () => {
  it('adds and removes records', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store);
    idx.applyDelta({ nodes: [], edges: [], removed: [calls(login, issue).id] });
    expect(idx.impact(login.id, 'down').nodes).not.toContain(issue.id);
    idx.close();
  });
});

describe('capabilities + factory', () => {
  it('sqlite reports cypher=false, vector=false', () => {
    const idx = openIndex('sqlite');
    expect(idx.capabilities()).toEqual({ cypher: false, vector: false });
    idx.close();
  });
  it('kuzu backend is a deferred stub that throws on construction', () => {
    expect(() => new KuzuIndexStore()).toThrow(/deferred stub/);
    expect(() => openIndex('kuzu')).toThrow(/deferred stub/);
  });
});

describe('persisted index file rebuilds from soul', () => {
  it('writes to disk and re-reads', () => {
    const dbPath = join(dir, 'crib.sqlite');
    const idx = new SqliteIndexStore(dbPath);
    idx.buildFromSoul(store);
    idx.close();
    const reopened = new SqliteIndexStore(dbPath);
    expect(reopened.query({ text: 'issue', kinds: ['symbol'] })[0]?.id).toBe(issue.id);
    reopened.close();
  });
});
