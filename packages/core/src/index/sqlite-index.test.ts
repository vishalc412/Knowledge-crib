import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    idx.buildFromSoul(store, dir);
    const hits = idx.query({ text: 'login', kinds: ['symbol'] });
    expect(hits[0]?.id).toBe(login.id);
    idx.close();
  });

  it('query respects kind filter', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir);
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
    idx.buildFromSoul(store, dir);
    const res = idx.impact(login.id, 'up');
    expect(res.nodes).toContain(controller.id);
    expect(res.nodes).not.toContain(issue.id);
    idx.close();
  });
  it('down = dependencies: what login relies on', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir);
    const res = idx.impact(login.id, 'down');
    expect(res.nodes).toContain(issue.id);
    expect(res.nodes).not.toContain(controller.id);
    idx.close();
  });
  it('depth limits the traversal', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir);
    expect(idx.impact(controller.id, 'down', 1).nodes).toEqual([login.id]);
    expect(idx.impact(controller.id, 'down', 2).nodes.sort()).toEqual([login.id, issue.id].sort());
    idx.close();
  });
});

describe('neighbors + shortestPath', () => {
  it('neighbors filters by rel and dir', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir);
    expect(idx.neighbors(login.id, 'calls', 'down').map((e) => e.dst)).toEqual([issue.id]);
    expect(idx.neighbors(login.id, 'calls', 'up').map((e) => e.src)).toEqual([controller.id]);
    idx.close();
  });
  it('shortestPath walks the call chain', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir);
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
    idx.buildFromSoul(store, dir);
    idx.applyDelta({ nodes: [], edges: [], removed: [calls(login, issue).id] }, dir);
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
    idx.buildFromSoul(store, dir);
    idx.close();
    const reopened = new SqliteIndexStore(dbPath);
    expect(reopened.query({ text: 'issue', kinds: ['symbol'] })[0]?.id).toBe(issue.id);
    reopened.close();
  });
});

describe('WS-1 body-searchable FTS', () => {
  // A node whose name/signature carry NO hint of the rule logic; the searchable token lives only in
  // the on-disk body. Pre-WS-1 this query returned nothing; with the body FTS column it must hit.
  it('matches a token that appears only in the rehydrated body, not the name/signature', () => {
    const bodyFile = 'src/rules/EvalDti.ts';
    mkdirSync(join(dir, 'src', 'rules'), { recursive: true });
    writeFileSync(
      join(dir, bodyFile),
      [
        'export function evaluate(applicant) {',
        '  // DTI ratio gate: reject when debt-to-income exceeds 0.43',
        '  if (applicant.dti > 0.43) return REJECT;',
        '}',
      ].join('\n'),
    );
    const dti = sym(bodyFile, 'EvalDti.evaluate', 1, { signature: 'evaluate(applicant)' });
    const ruleStore = new SoulStore(dir, {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    ruleStore.load();
    ruleStore.putNodes([file(bodyFile), dti]);
    ruleStore.commit('2026-01-01T00:00:00.000Z');

    const idx = new SqliteIndexStore();
    idx.buildFromSoul(ruleStore, dir);
    // '0.43' appears only in the body — a signature-only index would never match it.
    const hits = idx.query({ text: '0.43', kinds: ['symbol'] });
    expect(hits.map((h) => h.id)).toContain(dti.id);
    // 'debt-to-income' likewise — body-only phrasing.
    expect(idx.query({ text: 'debt-to-income', kinds: ['symbol'] }).map((h) => h.id)).toContain(
      dti.id,
    );
    idx.close();
  });

  it('still indexes signatures when the body file is absent (spec-only case)', () => {
    const specOnly = sym('src/PKG_spec.sql', 'PKG.SPEC_PROC', 12, { signature: 'SPEC_PROC(x)' });
    const specStore = new SoulStore(dir, {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    specStore.load();
    specStore.putNodes([file('src/PKG_spec.sql'), specOnly]);
    specStore.commit('2026-01-01T00:00:00.000Z');

    const idx = new SqliteIndexStore();
    idx.buildFromSoul(specStore, dir); // file not on disk → body column empty, signature still indexed
    expect(idx.query({ text: 'SPEC_PROC', kinds: ['symbol'] })[0]?.id).toBe(specOnly.id);
    idx.close();
  });
});

describe('P2 lightweight hybrid retrieval (synonym-expanded query)', () => {
  it('a conceptual query ("save") finds a symbol named with its synonym ("persistData"), which pure prefix-FTS5 would miss', () => {
    const persistFn = sym('src/storage/Writer.ts', 'persistData', 1, {
      signature: 'persistData(record): void',
    });
    const semStore = new SoulStore(dir, {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    semStore.load();
    semStore.putNodes([file('src/storage/Writer.ts'), persistFn]);
    semStore.commit('2026-01-01T00:00:00.000Z');

    const idx = new SqliteIndexStore();
    idx.buildFromSoul(semStore, dir);
    // sanity: plain substring-unrelated terms never collide ("save" is not a substring of
    // "persistData", so this proves the hit comes from synonym expansion, not a lucky prefix match).
    expect('persistdata'.startsWith('save')).toBe(false);
    const hits = idx.query({ text: 'save', kinds: ['symbol'] });
    expect(hits.map((h) => h.id)).toContain(persistFn.id);
    idx.close();
  });

  it('an unrelated query term does not pull in a synonym group (no false-positive recall)', () => {
    const persistFn = sym('src/storage/Writer.ts', 'persistData', 1);
    const semStore = new SoulStore(dir, {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    semStore.load();
    semStore.putNodes([file('src/storage/Writer.ts'), persistFn]);
    semStore.commit('2026-01-01T00:00:00.000Z');

    const idx = new SqliteIndexStore();
    idx.buildFromSoul(semStore, dir);
    expect(idx.query({ text: 'render', kinds: ['symbol'] }).map((h) => h.id)).not.toContain(
      persistFn.id,
    );
    idx.close();
  });
});
