import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CharNgramEmbedder, encodeVec } from '../embeddings/char-ngram.js';
import type { Embedder, Vec } from '../embeddings/types.js';
import { newManifest } from '../manifest.js';
import { SoulStore } from '../soul-store.js';
import { SqliteIndexStore } from './sqlite-index.js';

/**
 * WP4 §7 — the BATCHING proof obligation, and the reason it precedes every timing claim.
 *
 * `buildVectors` and `applyDelta` each hand-maintained the same three rules (skip detail kinds,
 * embed `vectorText(node, repoRoot, fileCache)`, upsert `encodeVec(v)`) with a comment in the delta
 * promising it matched the build. Both now route through ONE `embedNodes` helper that chunks into
 * `embedBatch`. That is a PERFORMANCE change only if the written vectors are unchanged — and this
 * repository has already paid for the alternative: the embedder adapter applied E5's `query:` prefix
 * in `embed()` and `passage:` in `embedBatch()`, and switching a record loop from one method to the
 * other silently cost 8 points of paraphrase recall. A speedup measured on a build that produced
 * different vectors is not a speedup; it is a different index.
 *
 * What makes this a proof rather than a re-assertion of the contract is the ORACLE: the expected
 * bytes are computed outside the store, from the text the embedder actually received, and tied back
 * to the node by a unique marker in that node's signature. A chunk-boundary off-by-one, a reversed
 * batch, or a dropped tail therefore moves a vector onto the wrong node and fails here — none of
 * which a "batched == node-by-node" comparison could catch, because both sides would be wrong the
 * same way.
 *
 * DISCRIMINATION RUN (WP1-D15 — a test that cannot fail is not evidence). Verified by mutation, not
 * by assertion: the write index in `embedNodes` was changed to `(i + 1) % pending.length` (the
 * classic off-by-one this file exists for) and the suite was re-run. Result, observed rather than
 * predicted: **2 of 6 failed** — the per-node oracle mapping and the delta's rewrite check, each
 * naming the marker whose vector came from another node. The other four stayed GREEN under the
 * mutation — the contract equivalence and the chunking assertions cannot see a mis-mapping, because
 * both sides move together. That asymmetry is the whole reason the marker oracle exists, and the
 * mutation was then reverted and the suite re-run green. Unlike a `packages/cli` discrimination run
 * there is no rebuild step: vitest executes this package from source.
 */

const FILE_COUNT = 8;
const SYMBOLS_PER_FILE = 20;
const LINES_PER_FILE = 60;
/** Detail-kind nodes: never embedded by either path, and asserted so rather than assumed. */
const DETAIL_COUNT = 5;
const EMBEDDABLE = FILE_COUNT * SYMBOLS_PER_FILE; // 160 — deliberately > 2 × the 64 chunk

/** `MARK0007` — unique per node, and never a substring of another node's marker. */
function mark(n: number): string {
  return `MARK${String(n).padStart(4, '0')}`;
}

function detailMarker(n: number): string {
  return `DTL${String(n).padStart(4, '0')}`;
}

function sym(path: string, qualifiedName: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: qualifiedName.split('.').pop() ?? qualifiedName,
    qualifiedName,
    file: path,
    span: { start: line, end: line + 2 },
    lang: 'typescript',
    hash: contentHash(`${path}#${qualifiedName}`),
    ...extra,
  };
}

/**
 * An embedder that records every batch it is handed and re-batches INTERNALLY at a different
 * boundary than the store's chunk, so the store's own chunking is what the oracle tests rather than
 * a coincidence of both using 64.
 */
class RecordingEmbedder implements Embedder {
  /** one entry per `embedBatch` call, in order */
  readonly batches: string[][] = [];
  private readonly inner = new CharNgramEmbedder();
  constructor(private readonly subBatch = 3) {}

  get id(): string {
    return this.inner.id;
  }
  dim(): number {
    return this.inner.dim();
  }
  embed(text: string): Vec {
    return this.inner.embed(text);
  }
  embedBatch(texts: string[]): Vec[] {
    this.batches.push([...texts]);
    const out: Vec[] = [];
    for (let i = 0; i < texts.length; i += this.subBatch) {
      out.push(...this.inner.embedBatch(texts.slice(i, i + this.subBatch)));
    }
    return out;
  }
  /** every text embedded so far, in call order */
  get texts(): string[] {
    return this.batches.flat();
  }
  /**
   * The bytes the oracle expects for `text`, computed WITHOUT the store: the single-text path of the
   * same model, encoded the same way. Named for what it returns rather than for the method it wraps,
   * so the oracle reads as "the bytes for this text" and not as a re-assertion of the contract.
   */
  vectorHexFor(text: string): string {
    return Buffer.from(encodeVec(this.inner.embed(text))).toString('hex');
  }
}

type VecRow = { id: string; hex: string; dim: number };

interface ProbeDb {
  prepare(sql: string): { all(): unknown[] };
}

/**
 * The store's private sqlite handle. Widened through `unknown` rather than `any`, so the cast states
 * exactly what it does not verify (the handle's shape) instead of switching type-checking off for the
 * whole expression. Test-only: the derived tables are not observable through `query`.
 */
function probeDb(store: SqliteIndexStore): ProbeDb {
  return (store as unknown as { db: ProbeDb }).db;
}

/** Read the derived `vectors` table directly — its bytes are not observable through `query`. */
function readVectors(path: string): VecRow[] {
  const store = new SqliteIndexStore(path);
  const db = probeDb(store);
  const rows = db.prepare('SELECT id, vec, dim FROM vectors ORDER BY id').all() as Array<{
    id: string;
    vec: Uint8Array;
    dim: number;
  }>;
  const out = rows.map((r) => ({
    id: r.id,
    hex: Buffer.from(r.vec).toString('hex'),
    dim: Number(r.dim),
  }));
  store.close();
  return out;
}

function readVectorMeta(path: string): Array<{ k: string; v: string }> {
  const store = new SqliteIndexStore(path);
  const db = probeDb(store);
  const rows = db.prepare('SELECT k, v FROM vector_meta ORDER BY k').all() as Array<{
    k: string;
    v: string;
  }>;
  store.close();
  return rows.map((r) => ({ k: String(r.k), v: String(r.v) }));
}

let repoRoot: string;
let idxDir: string;
let dbPath: string;
let soul: SoulStore;
/** symbol nodes in fixture order; index `g` in this array carries marker `mark(g)` */
let symbols: Node[];

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'crib-vecbatch-repo-'));
  idxDir = mkdtempSync(join(tmpdir(), 'crib-vecbatch-idx-'));
  dbPath = join(idxDir, 'crib.sqlite');

  symbols = [];
  const detailNodes: Node[] = [];
  for (let f = 0; f < FILE_COUNT; f++) {
    const path = `src/mod${f}/unit${f}.ts`;
    const lines: string[] = [];
    for (let l = 0; l < LINES_PER_FILE; l++) lines.push(`// filler ${f}:${l} — no marker here`);
    for (let j = 0; j < SYMBOLS_PER_FILE; j++) {
      const g = f * SYMBOLS_PER_FILE + j;
      const line = 1 + j * 3;
      // the marker lives in the SIGNATURE, which `vectorText` always carries, so a vector can be
      // tied back to its node without the test re-implementing the embedding recipe.
      lines[line - 1] = `export function op${j}(${mark(g)}: number) {`;
      symbols.push(sym(path, `Unit${f}.op${j}`, line, { signature: `op${j}(MARK ${mark(g)})` }));
    }
    const abs = join(repoRoot, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${lines.join('\n')}\n`);
  }
  // Detail nodes live in their OWN file, and carry their marker in `signature`. Both choices are
  // load-bearing: `vectorText` embeds the surface fields PLUS the rehydrated span, so putting a
  // detail node in a symbol file would make its text contain other nodes' markers and the oracle's
  // `find` ambiguous — and putting its marker anywhere but the surface would make the skip
  // assertion below vacuous, since a skipped node and an embedded one would look identical.
  const detailPath = 'src/detail.ts';
  const detailLines = Array.from({ length: DETAIL_COUNT + 4 }, (_, l) => `// detail filler ${l}`);
  const detailAbs = join(repoRoot, detailPath);
  mkdirSync(dirname(detailAbs), { recursive: true });
  writeFileSync(detailAbs, `${detailLines.join('\n')}\n`);
  for (let d = 0; d < DETAIL_COUNT; d++) {
    detailNodes.push({
      id: idFor({ kind: 'statement', file: detailPath, line: d + 1 }),
      kind: 'statement',
      file: detailPath,
      span: { start: d + 1, end: d + 1 },
      signature: detailMarker(d),
      hash: contentHash(`detail${d}`),
    });
  }

  soul = new SoulStore(idxDir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  soul.load();
  soul.putNodes([...symbols, ...detailNodes]);
  soul.commit('2026-01-01T00:00:00.000Z');
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(idxDir, { recursive: true, force: true });
});

/** The node whose signature carries `marker`. */
function nodeFor(marker: string): Node {
  const found = symbols.find((s) => s.signature?.includes(marker) === true);
  if (!found) throw new Error(`no fixture node carries ${marker}`);
  return found;
}

/**
 * The oracle: for every fixture node, the row under ITS id must hold the bytes for the text that
 * carries ITS marker. This is the assertion a chunk-boundary bug cannot survive.
 */
function expectOracleMapping(embedder: RecordingEmbedder, rows: VecRow[]): void {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const texts = embedder.texts;
  for (let g = 0; g < symbols.length; g++) {
    const marker = mark(g);
    const text = texts.find((t) => t.includes(marker));
    expect(text, `no embedded text carried ${marker}`).toBeDefined();
    expect(byId.get(nodeFor(marker).id)?.hex, `vector for ${marker} came from another node`).toBe(
      embedder.vectorHexFor(text!),
    );
  }
}

describe('the batched vector build writes each node its own vector (WP4 §7)', () => {
  it('maps every node to the bytes for its own text, across the chunk boundary', () => {
    const rec = new RecordingEmbedder();
    const store = new SqliteIndexStore(dbPath, { embedder: rec });
    store.buildFromSoul(soul, repoRoot);

    expectOracleMapping(rec, readVectors(dbPath));
    store.close();
  });

  it('actually chunked — more than one call, none larger than the chunk, none dropped', () => {
    const rec = new RecordingEmbedder();
    const store = new SqliteIndexStore(dbPath, { embedder: rec });
    store.buildFromSoul(soul, repoRoot);

    // if `embedNodes` had built one array for the whole corpus, the rest of this file would still
    // pass and the change would be nothing but a rename of `embed`.
    expect(EMBEDDABLE).toBeGreaterThan(64);
    expect(rec.batches.length).toBeGreaterThan(1);
    expect(rec.batches.every((b) => b.length <= 64)).toBe(true);
    // …and the tail is not dropped at a chunk boundary
    expect(rec.batches.reduce((n, b) => n + b.length, 0)).toBe(EMBEDDABLE);
    store.close();
  });

  it('covers the corpus exactly: one row per embeddable node, and no detail-kind row', () => {
    const rec = new RecordingEmbedder();
    const store = new SqliteIndexStore(dbPath, { embedder: rec });
    store.buildFromSoul(soul, repoRoot);

    const rows = readVectors(dbPath);
    expect(rows).toHaveLength(EMBEDDABLE);
    expect(new Set(rows.map((r) => r.id)).size).toBe(EMBEDDABLE);
    // the skip rule is asserted, not assumed: a detail node's marker reaching the embedder would
    // mean the corpus grew by nodes discovery never ranks
    for (let d = 0; d < DETAIL_COUNT; d++) {
      expect(rec.texts.some((t) => t.includes(detailMarker(d)))).toBe(false);
    }
    store.close();
  });

  it('produces the same bytes and the same vector_meta as a per-text build', () => {
    // subBatch 1 is the pre-change semantics inside one call: one text at a time. The store's
    // chunking must not be observable in the result. This is a CONTRACT check — the oracle test
    // above is the bug detector, because two equally-wrong sides would agree here.
    const batched = new RecordingEmbedder(3);
    const perText = new RecordingEmbedder(1);
    const otherPath = join(idxDir, 'per-text.sqlite');

    const a = new SqliteIndexStore(dbPath, { embedder: batched });
    a.buildFromSoul(soul, repoRoot);
    a.close();
    const b = new SqliteIndexStore(otherPath, { embedder: perText });
    b.buildFromSoul(soul, repoRoot);
    b.close();

    expect(readVectors(dbPath)).toEqual(readVectors(otherPath));
    expect(readVectorMeta(dbPath)).toEqual(readVectorMeta(otherPath));
    expect(readVectorMeta(dbPath).map((r) => r.k)).toEqual(['dim', 'embedderId', 'textVersion']);
  });
});

describe('the incremental delta shares that one path (WP4 §7)', () => {
  it('rewrites only the changed nodes, byte-identically for the ones that did not change', () => {
    const rec = new RecordingEmbedder();
    const store = new SqliteIndexStore(dbPath, { embedder: rec });
    store.buildFromSoul(soul, repoRoot);
    const before = readVectors(dbPath);
    const metaBefore = readVectorMeta(dbPath);

    // 70 > the 64 chunk: the delta flushes twice, so a boundary bug would strand the 65th change.
    const CHANGED = 70;
    const changed = symbols.slice(0, CHANGED).map((s, i) => ({
      ...s,
      signature: `renamed(MARK ${mark(1000 + i)})`,
      hash: contentHash(`changed${i}`),
    }));
    const textsBefore = rec.texts.length;
    store.applyDelta({ nodes: changed, edges: [], removed: [] }, repoRoot);

    const after = readVectors(dbPath);
    expect(after).toHaveLength(EMBEDDABLE);
    // the delta handed exactly the changed nodes to the embedder — not the whole corpus, and not
    // one node too few. An exact count, so a partial rewrite cannot hide here.
    expect(rec.texts.length - textsBefore).toBe(CHANGED);

    const beforeById = new Map(before.map((r) => [r.id, r.hex]));
    const afterById = new Map(after.map((r) => [r.id, r.hex]));
    for (let i = 0; i < CHANGED; i++) {
      const marker = mark(1000 + i);
      const text = rec.texts.slice(textsBefore).find((t) => t.includes(marker));
      expect(text, `delta did not embed ${marker}`).toBeDefined();
      expect(afterById.get(changed[i]!.id)).toBe(rec.vectorHexFor(text!));
    }
    for (const s of symbols.slice(CHANGED)) {
      expect(afterById.get(s.id), `untouched node ${s.id} was rewritten`).toBe(
        beforeById.get(s.id),
      );
    }
    expect(readVectorMeta(dbPath)).toEqual(metaBefore);
    store.close();
  });
});

describe('a broken batch fails loudly instead of writing a partial index', () => {
  it('throws on a short embedBatch return, and commits no vectors at all', () => {
    const inner = new CharNgramEmbedder();
    const short: Embedder = {
      id: inner.id,
      dim: () => inner.dim(),
      embed: (t) => inner.embed(t),
      // a plausible adapter bug: the last text of every batch is dropped
      embedBatch: (texts) => inner.embedBatch(texts.slice(0, -1)),
    };
    const store = new SqliteIndexStore(dbPath, { embedder: short });

    expect(() => store.buildFromSoul(soul, repoRoot)).toThrow(/embedBatch returned/);
    // The transaction rolled back, so the index is LEXICAL — never the "few hundred of N nodes"
    // state `applyDelta`'s own comment calls worse than an unvectorized index, because it looks
    // like it works. Absent vectors are a recall loss; a partial table is a wrong answer.
    expect(readVectors(dbPath)).toHaveLength(0);
    expect(readVectorMeta(dbPath)).toHaveLength(0);
    expect(store.capabilities().vector).toBe(false);
    expect(store.capabilities().vectorNote).toBeUndefined();
    store.close();
  });
});
