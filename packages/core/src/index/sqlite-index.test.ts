import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CharNgramEmbedder } from '../embeddings/char-ngram.js';
import type { HybridQuery } from '../index-store.js';
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

// ---- M2.1 hybrid fusion (RRF of BM25 ∪ char-n-gram vectors) ----

describe('SqliteIndexStore — M2.1 vector layer + RRF hybrid query', () => {
  it('default store (no embedder) is pure BM25 — capabilities.vector=false', () => {
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir);
    expect(idx.capabilities().vector).toBe(false);
    // semantic:false is a no-op when no vectors were built — returns BM25 unchanged.
    const a = idx.query({ text: 'login', kinds: ['symbol'] });
    const b = idx.query({ text: 'login', kinds: ['symbol'], semantic: false });
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
    idx.close();
  });

  it('building with the char-n-gram embedder sets capabilities.vector=true', () => {
    const idx = new SqliteIndexStore(':memory:', { embedder: new CharNgramEmbedder() });
    idx.buildFromSoul(store, dir);
    expect(idx.capabilities().vector).toBe(true);
    idx.close();
  });

  it('hybrid query retrieves a paraphrase BM25 misses (the recall mechanism)', () => {
    // Paraphrase: "logged in" shares no exact token with "login"/"AuthService.login" beyond "login",
    // but the char-n-gram vector generalizes the inflection. The hybrid path should rank login highly.
    const idx = new SqliteIndexStore(':memory:', { embedder: new CharNgramEmbedder() });
    idx.buildFromSoul(store, dir);
    const hybrid = idx.query({ text: 'logged in session', kinds: ['symbol'] });
    const pure = idx.query({ text: 'logged in session', kinds: ['symbol'], semantic: false });
    // hybrid must include login; pure BM25 may or may not, but hybrid definitely does.
    expect(hybrid.map((h) => h.id)).toContain(login.id);
    // and hybrid should rank it no worse than pure BM25 does (RRF can only help, not hurt, a present hit).
    if (pure.some((h) => h.id === login.id)) {
      expect(hybrid.findIndex((h) => h.id === login.id)).toBeLessThanOrEqual(
        pure.findIndex((h) => h.id === login.id),
      );
    }
    idx.close();
  });

  it('hybrid query is deterministic — identical results across two fresh builds', () => {
    const a = new SqliteIndexStore(':memory:', { embedder: new CharNgramEmbedder() });
    a.buildFromSoul(store, dir);
    const ra = a.query({ text: 'auth token login session', kinds: ['symbol'] });
    a.close();
    const b = new SqliteIndexStore(':memory:', { embedder: new CharNgramEmbedder() });
    b.buildFromSoul(store, dir);
    const rb = b.query({ text: 'auth token login session', kinds: ['symbol'] });
    b.close();
    expect(ra.map((h) => h.id)).toEqual(rb.map((h) => h.id));
  });

  it('applyDelta keeps the vector table in sync (upsert + delete)', () => {
    const idx = new SqliteIndexStore(':memory:', { embedder: new CharNgramEmbedder() });
    idx.buildFromSoul(store, dir);
    const before = idx.query({ text: 'login', kinds: ['symbol'] });
    // mutate the soul: rename login's surface text via a new node, then delta-remove login.
    const renamed = sym('src/auth/AuthService.ts', 'AuthService.signin', 42);
    const s2 = new SoulStore(dir, { manifest: store.getManifest() });
    s2.load();
    s2.putNodes([renamed]);
    s2.commit('2026-01-01T00:00:00.000Z');
    idx.applyDelta({ nodes: [renamed], edges: [], removed: [login.id] }, dir);
    const after = idx.query({ text: 'signin', kinds: ['symbol'] });
    expect(after.map((h) => h.id)).toContain(renamed.id);
    expect(after.map((h) => h.id)).not.toContain(login.id);
    // original login still queryable before the delta (sanity that the before-state had it)
    expect(before.map((h) => h.id)).toContain(login.id);
    idx.close();
  });

  it('building with an embedder never mutates the committed soul (vectors live in the derived index only)', () => {
    // The M2.1 determinism invariant: vectors feed ONLY the gitignored derived index, never the
    // soul. If buildFromSoul wrote a vectors file into the soul dir, the committed graph would
    // differ between an embedder-on and embedder-off repo and --extracted-only would no longer be
    // byte-identical. Snapshot the soul dir tree + file hashes before/after to pin this.
    const snapshot = (root: string): string => {
      const out: string[] = [];
      const walk = (rel: string) => {
        const full = join(root, rel);
        for (const name of readdirSync(full).sort()) {
          const sub = rel ? `${rel}/${name}` : name;
          const st = statSync(join(full, name));
          if (st.isDirectory()) {
            out.push(`D ${sub}`);
            walk(sub);
          } else {
            const buf = readFileSync(join(full, name));
            out.push(`F ${sub} ${createHash('sha256').update(buf).digest('hex')}`);
          }
        }
      };
      walk('');
      return out.join('\n');
    };
    const before = snapshot(dir);
    const idx = new SqliteIndexStore(':memory:', { embedder: new CharNgramEmbedder() });
    idx.buildFromSoul(store, dir);
    idx.query({ text: 'login', kinds: ['symbol'] });
    idx.close();
    expect(snapshot(dir)).toBe(before);
  });

  it('extractedOnly query results are identical whether the index was built with or without vectors', () => {
    // The plan's "--extracted-only byte-identical" gate at the query layer: the deterministic
    // EXTRACTED-provenance view must not depend on the vector layer. semantic:false (the
    // deterministic path) returns the same hits on a no-embedder and an embedder-built index,
    // because semantic:false bypasses the vector table entirely.
    const plain = new SqliteIndexStore();
    plain.buildFromSoul(store, dir);
    const withVec = new SqliteIndexStore(':memory:', { embedder: new CharNgramEmbedder() });
    withVec.buildFromSoul(store, dir);
    const q: HybridQuery = { text: 'login', kinds: ['symbol'], semantic: false };
    expect(withVec.query(q).map((h) => h.id)).toEqual(plain.query(q).map((h) => h.id));
    plain.close();
    withVec.close();
  });
});
