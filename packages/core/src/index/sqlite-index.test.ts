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

  // Guards the rowid-mapped FTS delete. `nodes_fts.id` is UNINDEXED, so the old
  // `DELETE FROM nodes_fts WHERE id = ?` full-scanned the table (O(N^2) builds). We now delete by a
  // mapped rowid — correct ONLY if the id->rowid map is written on the fresh build path too. If it
  // were written only on the delta path, `deleteFtsRow` would find no mapping for a
  // build-time row, silently skip the delete, and leave a stale duplicate whose superseded text
  // stays matchable forever. Both tests below seed a UNIQUE token into the soul before the fresh
  // build so that leaked row is actually observable.
  function seedUnique(token: string): Node {
    const node = sym('src/auth/Unique.ts', 'Unique.probe', 7, { signature: token });
    const s2 = new SoulStore(dir, { manifest: store.getManifest() });
    s2.load();
    s2.putNodes([file('src/auth/Unique.ts'), node]);
    s2.commit('2026-01-02T00:00:00.000Z');
    store = s2;
    return node;
  }

  it('re-indexing a node purges the FTS text written by the fresh build', () => {
    const probe = seedUnique('ZZORIGINALTOKEN');
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir); // fresh path — must record the id->rowid mapping
    expect(idx.query({ text: 'ZZORIGINALTOKEN' }).map((h) => h.id)).toContain(probe.id);

    idx.applyDelta(
      { nodes: [{ ...probe, signature: 'ZZREPLACEDTOKEN' } as Node], edges: [], removed: [] },
      dir,
    );
    expect(idx.query({ text: 'ZZREPLACEDTOKEN' }).map((h) => h.id)).toContain(probe.id);
    // The build-time row must be gone, not merely outranked or shadowed by a duplicate.
    expect(idx.query({ text: 'ZZORIGINALTOKEN' })).toEqual([]);
    idx.close();
  });

  // Note: this one passes even without the id->rowid mapping, because `bm25Query` JOINs `nodes` and
  // a removed node has no `nodes` row to join to. It pins the user-visible contract; the
  // replacement test above is what actually guards the mapping.
  it('removing a node makes its FTS text unsearchable', () => {
    const probe = seedUnique('ZZREMOVEMETOKEN');
    const idx = new SqliteIndexStore();
    idx.buildFromSoul(store, dir);
    expect(idx.query({ text: 'ZZREMOVEMETOKEN' }).map((h) => h.id)).toContain(probe.id);
    idx.applyDelta({ nodes: [], edges: [], removed: [probe.id] }, dir);
    expect(idx.query({ text: 'ZZREMOVEMETOKEN' })).toEqual([]);
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

describe('SqliteIndexStore — source redaction policy (FTS never indexes secret values)', () => {
  it('indexes property keys but not values (query db.password hits, swordfish does not)', () => {
    writeFileSync(join(dir, 'secure.properties'), 'db.user=alice\ndb.password=swordfish');
    const redactStore = new SoulStore(dir, {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    redactStore.load();
    const props: Node = {
      id: idFor({ kind: 'file', path: 'secure.properties' }),
      kind: 'file',
      file: 'secure.properties',
      span: { start: 1, end: 2 },
      hash: contentHash('secure.properties'),
      meta: { sourcePolicy: 'redact-properties' },
    };
    redactStore.putNodes([props]);
    redactStore.commit('2026-01-01T00:00:00.000Z');

    const idx = new SqliteIndexStore();
    idx.buildFromSoul(redactStore, dir);
    // the KEY is searchable (redacted body keeps keys)
    expect(idx.query({ text: 'db.password' }).map((h) => h.id)).toContain(props.id);
    // the secret VALUE is never indexed
    expect(idx.query({ text: 'swordfish' }).map((h) => h.id)).not.toContain(props.id);
    expect(idx.query({ text: 'alice' }).map((h) => h.id)).not.toContain(props.id);
    idx.close();
  });

  it('redacts Mule XML secret attributes: xml-canary never indexed, api.token placeholder is', () => {
    writeFileSync(
      join(dir, 'http.xml'),
      '<http:request password="xml-canary" token="${api.token}"/>',
    );
    const redactStore = new SoulStore(dir, {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    redactStore.load();
    const xml: Node = {
      id: idFor({ kind: 'file', path: 'http.xml' }),
      kind: 'file',
      file: 'http.xml',
      span: { start: 1, end: 1 },
      hash: contentHash('http.xml'),
      meta: { sourcePolicy: 'redact-mule-secrets' },
    };
    redactStore.putNodes([xml]);
    redactStore.commit('2026-01-01T00:00:00.000Z');

    const idx = new SqliteIndexStore();
    idx.buildFromSoul(redactStore, dir);
    // the secret VALUE token never reaches the FTS body (canary only appears in the redacted value)
    expect(idx.query({ text: 'canary' }).map((h) => h.id)).not.toContain(xml.id);
    // the placeholder reference key remains searchable
    expect(idx.query({ text: 'api.token' }).map((h) => h.id)).toContain(xml.id);
    idx.close();
  });

  it('deny nodes never reach the FTS body at all', () => {
    writeFileSync(join(dir, 'keystore.jks'), 'RAW-KEYSTORE-BYTES-SECRET');
    const redactStore = new SoulStore(dir, {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    redactStore.load();
    const deny: Node = {
      id: idFor({ kind: 'file', path: 'keystore.jks' }),
      kind: 'file',
      file: 'keystore.jks',
      span: { start: 1, end: 1 },
      hash: contentHash('keystore.jks'),
      meta: { sourcePolicy: 'deny' },
    };
    redactStore.putNodes([deny]);
    redactStore.commit('2026-01-01T00:00:00.000Z');

    const idx = new SqliteIndexStore();
    idx.buildFromSoul(redactStore, dir);
    // the secret CONTENT token never reaches the FTS body (deny blocks the disk read)
    expect(idx.query({ text: 'BYTES' }).map((h) => h.id)).not.toContain(deny.id);
    expect(idx.query({ text: 'SECRET' }).map((h) => h.id)).not.toContain(deny.id);
    // the file path itself is still indexed (it carries no secret)
    expect(idx.query({ text: 'keystore.jks' }).map((h) => h.id)).toContain(deny.id);
    idx.close();
  });
});

// Authored meaning has to be SEARCHABLE, not merely attachable. Before this existed, a phrase
// occurring only in authored prose returned zero hits: the semantic layer decorated results that
// keyword search had already chosen, and could never change which result was found.
describe('semantic search over authored meaning', () => {
  function seeded() {
    const s = new SqliteIndexStore();
    s.buildSemanticIndex(
      [
        {
          targetId: 'file:a.ts',
          layer: 'file',
          purpose: 'Detects a parser that hangs by running it inside a killable worker.',
          detail: 'Terminate a worker that exceeds its time budget',
        },
        {
          targetId: 'file:b.ts',
          layer: 'file',
          purpose: 'Formats a date for display.',
          detail: 'Render timestamps',
        },
      ],
      7,
    );
    return s;
  }

  it('finds a target by prose that appears nowhere in its source', () => {
    const s = seeded();
    const hits = s.semanticSearch('killable worker', 5);
    expect(hits[0]?.targetId).toBe('file:a.ts');
    s.close();
  });

  it('records the generation it was built at, so staleness is a single comparison', () => {
    const s = new SqliteIndexStore();
    expect(s.semanticIndexGeneration()).toBe(-1); // never built
    s.buildSemanticIndex([], 7);
    expect(s.semanticIndexGeneration()).toBe(7);
    s.close();
  });

  it('replaces the whole projection on rebuild rather than accumulating', () => {
    const s = seeded();
    s.buildSemanticIndex(
      [{ targetId: 'file:c.ts', layer: 'file', purpose: 'Something else entirely.', detail: '' }],
      8,
    );
    expect(s.semanticSearch('killable worker', 5)).toHaveLength(0); // old entry gone
    expect(s.semanticIndexGeneration()).toBe(8);
    s.close();
  });

  it('returns nothing rather than throwing on an unusable query', () => {
    const s = seeded();
    expect(s.semanticSearch('', 5)).toEqual([]);
    expect(s.semanticSearch('!!! ***', 5)).toEqual([]);
    s.close();
  });
});

// Query scaffolding ("why did you...") is OR-joined with the real terms, so it matches a large
// share of a corpus that now contains hundreds of files of English prose and drags unrelated
// documents up. Measured: "why did you choose blake3" ranked an unrelated ADR above the hashing
// module that answers it.
describe('query stopword handling', () => {
  it('ignores question scaffolding when real terms are present', () => {
    const s = new SqliteIndexStore();
    s.buildSemanticIndex(
      [
        {
          targetId: 'file:hash.ts',
          layer: 'file',
          purpose: 'Content hashing without native bindings.',
          detail: '',
        },
        {
          targetId: 'file:why.ts',
          layer: 'file',
          purpose: 'A module about why and how you should do things.',
          detail: '',
        },
      ],
      1,
    );
    const hits = s.semanticSearch('why did you choose hashing', 5);
    expect(hits[0]?.targetId).toBe('file:hash.ts');
    s.close();
  });

  it('still answers a query made ENTIRELY of scaffolding, rather than returning nothing', () => {
    const s = new SqliteIndexStore();
    s.buildSemanticIndex(
      [{ targetId: 'file:a.ts', layer: 'file', purpose: 'How does it work.', detail: '' }],
      1,
    );
    // Falls back to the unfiltered tokens — an empty result would be worse than a loose one.
    expect(s.semanticSearch('how does it work', 5).length).toBeGreaterThan(0);
    s.close();
  });

  it('never treats a real code identifier as scaffolding', () => {
    // `type`, `class`, `use`, `get`, `set`, `new`, `call` read like stopwords in English but are
    // genuine identifiers in code. The decoy repeats the SHARED word, so it outranks the target on
    // that word alone — the target can only win if the identifier is still part of the query.
    const s = new SqliteIndexStore();
    s.buildSemanticIndex(
      [
        { targetId: 'file:type.ts', layer: 'file', purpose: 'The type system.', detail: '' },
        {
          targetId: 'file:decoy.ts',
          layer: 'file',
          purpose: 'system system system system system system',
          detail: 'system system system system system system',
        },
      ],
      1,
    );
    expect(s.semanticSearch('type system', 5)[0]?.targetId).toBe('file:type.ts');

    s.buildSemanticIndex(
      [
        { targetId: 'file:class.ts', layer: 'file', purpose: 'The class loader.', detail: '' },
        {
          targetId: 'file:decoy2.ts',
          layer: 'file',
          purpose: 'loader loader loader loader loader loader',
          detail: 'loader loader loader loader loader loader',
        },
      ],
      2,
    );
    expect(s.semanticSearch('class loader', 5)[0]?.targetId).toBe('file:class.ts');
    s.close();
  });
});
