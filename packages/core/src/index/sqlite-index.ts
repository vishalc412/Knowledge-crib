import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Edge, Node, NodeKind, Rel } from '@knowledge-crib/soul-schema';
import { cosine, decodeVec, encodeVec } from '../embeddings/char-ngram.js';
import type { Embedder } from '../embeddings/types.js';
/**
 * SqliteIndexStore — the default IndexStore backend (M1).
 *
 * Built-in `node:sqlite` + FTS5 (BM25 ranking) + materialized adjacency, so
 * `impact`/`neighbors`/`shortestPath` are O(degree) graph walks over indexed
 * `edges(src)` / `edges(dst)`. No vector index ships — `capabilities().vector=false`
 * unconditionally. The INFERRED "semantic" layer is the M7 pure-JS TF-IDF linker
 * (pipeline `runSemanticLink`, gated by `IndexOpts.semantic` / CLI `--semantic`),
 * which emits capped `references` edges — it is not a vector ANN path and stays off
 * the deterministic query hot path.
 *
 * Using Node's built-in `node:sqlite` removes the native `better-sqlite3` build
 * dependency, so `pnpm install` works on a fresh machine without Xcode / CLT /
 * Python / node-gyp. Requires Node.js >= 22.5.0 (stable `node:sqlite`).
 *
 * The FTS5 `body` column is a SEARCH-ONLY projection: at build/delta time each node's
 * span is rehydrated from `repoRoot` on disk (capped at BODY_FTS_CAP chars) and folded
 * together with the in-soul logic fragments (`expr`/`cursorQuery`/`whenSelector`/
 * `errorMessage`/`assignTarget`) so a query can match rule *content*
 * (e.g. "DTI > 0.43"), not just names/signatures. The body text is NEVER surfaced
 * from `query` — `query` returns ids/scores only; deep body retrieval is
 * `rehydrateBody` (with its own `truncated` flag) via the `source`/`context`/
 * `dossier` verbs. So the body column carries no honesty flag of its own: the cap is
 * a build-time constant and the surfaced body's truncation discipline lives in
 * `rehydrateBody`. The soul stays lean — body text lives only in this derived index,
 * never in the soul.
 */
import type {
  Dir,
  Hit,
  HybridQuery,
  ImpactResult,
  IndexCapabilities,
  IndexDelta,
  IndexStore,
  PathResult,
} from '../index-store.js';
import type { SoulStore } from '../soul-store.js';
import { redactMuleSecretAttributes, redactPropertyText, sourcePolicy } from '../source-policy.js';
import { rerank } from './rerank.js';
import type { RerankCandidate } from './rerank.js';
import { expandToken } from './synonyms.js';

/** Columns we feed into FTS5 for free-text search over symbols + doc sections + bodies. */
const FTS_COLUMNS = 'name, qualifiedName, signature, heading, file, body';

/** The text embedded per node for the vector retriever (M2.1). Surface fields only — no body. */
function vectorText(node: Node): string {
  return [node.name, node.qualifiedName, node.signature, node.heading, node.file]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');
}

/** Reciprocal-rank fusion (RRF) of two retriever rankings. k=60 is the standard constant. */
const RRF_K = 60;
function rrfFuse(bm25: Hit[], vec: Hit[]): Hit[] {
  const score = new Map<string, number>();
  const meta = new Map<string, Hit>();
  const add = (hits: Hit[]) => {
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!;
      const rank = i + 1;
      score.set(h.id, (score.get(h.id) ?? 0) + 1 / (RRF_K + rank));
      if (!meta.has(h.id)) meta.set(h.id, h);
    }
  };
  add(bm25);
  add(vec);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.map(([id, s]) => {
    const h = meta.get(id)!;
    return { id: h.id, kind: h.kind, score: s, name: h.name, file: h.file };
  });
}

/** Round to 5 decimals so RRF scores don't carry float noise into deterministic snapshots. */
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/**
 * Per-node char cap for the FTS `body` column. Generous enough that a typical procedure/DDL body is
 * indexed in full; bounded so a multi-thousand-line file does not blow up the index. The surfaced
 * (paged) body is capped separately by `rehydrateBody`'s own budgets.
 */
const BODY_FTS_CAP = 8192;

/** Cache of file → split lines, so `buildFromSoul` reads each file ONCE, not once per node. */
type FileLineCache = Map<string, string[] | undefined>;

export class SqliteIndexStore implements IndexStore {
  private readonly db: DatabaseSync;
  /** When set, `buildFromSoul` embeds every node and `query` fuses BM25 ∪ vector via RRF. */
  private readonly embedder: Embedder | null;
  /** The embedder id used for the last build, or null if no vectors were built. */
  private builtEmbedderId: string | null = null;
  private builtDim = 0;
  /**
   * Prepared-statement cache keyed by SQL text. `node:sqlite` recompiles nothing for us, so
   * re-preparing the same INSERT once per row costs a full parse+codegen each time. Cleared by
   * `reset()` because the DROP/CREATE there invalidates every statement compiled against the old
   * tables.
   */
  private stmtCache = new Map<string, StatementSync>();

  /**
   * @param path file path for the sqlite db, or ':memory:' for an ephemeral index.
   * @param opts.embedder when provided, vectors are built at index time and `query` runs RRF hybrid
   *   fusion; `capabilities().vector` becomes true. When null/omitted, the store is pure BM25 — the
   *   backward-compatible default. The caller resolves any external provider (async) and passes the
   *   instance in, keeping `buildFromSoul` synchronous.
   */
  constructor(path = ':memory:', opts: { embedder?: Embedder | null } = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.embedder = opts.embedder ?? null;
    this.createSchema();
  }

  buildFromSoul(soul: SoulStore, repoRoot: string): void {
    this.reset();
    const fileCache: FileLineCache = new Map();
    const insertMany = this.transaction(() => {
      for (const node of soul.iterate()) this.insertNode(node, repoRoot, fileCache, true);
      for (const edge of soul.iterateEdges()) this.insertEdge(edge);
    });
    insertMany();
    if (this.embedder) this.buildVectors(soul);
  }

  applyDelta(changed: IndexDelta, repoRoot: string): void {
    const fileCache: FileLineCache = new Map();
    const apply = this.transaction(() => {
      for (const id of changed.removed) {
        // `removed` carries both node ids and edge ids (see IndexDelta), hence both deletes.
        this.stmt('DELETE FROM nodes WHERE id = ?').run(id);
        this.deleteFtsRow(id);
        this.stmt('DELETE FROM vectors WHERE id = ?').run(id);
        this.stmt('DELETE FROM edges WHERE id = ?').run(id);
      }
      for (const node of changed.nodes) this.insertNode(node, repoRoot, fileCache, false);
      for (const edge of changed.edges) this.insertEdge(edge);
      if (this.embedder) {
        const upsertVec = this.db.prepare(
          'INSERT OR REPLACE INTO vectors (id, vec, dim) VALUES (?, ?, ?)',
        );
        for (const node of changed.nodes) {
          const v = this.embedder.embed(vectorText(node));
          upsertVec.run(node.id, Buffer.from(encodeVec(v)), v.length);
        }
      }
    });
    apply();
  }

  query(q: HybridQuery): Hit[] {
    const limit = q.limit ?? 10;
    const offset = q.offset ?? 0;
    const wantSemantic = q.semantic !== false && this.builtEmbedderId !== null;
    if (!wantSemantic) return this.bm25Query(q, limit, offset);
    // M2.1 — RRF hybrid fusion of BM25 ∪ vector retrieval. Vectors generalize across the
    // case/affix/paraphrase gaps exact-match BM25 misses; RRF merges ranks without needing
    // comparable score scales. `score` returned is the RRF score (higher = better).
    //
    // M2.2 — after fusion, a deterministic structural prior (centrality × stereotype-match ×
    // per-intent kind prior) multiplies the RRF score and re-sorts. The prior anchors BM25-found
    // relevant docs so vector noise can't push them below rank 10 (the java -10.5pp case). Offset
    // is applied AFTER fusion+rerank so paging stays consistent with the reranked order.
    const pool = Math.max(limit * 5, 50);
    const bm25Hits = this.bm25Query(q, pool, 0);
    const vecHits = this.vectorQuery(q.text, pool, q.kinds);
    const fused = rrfFuse(bm25Hits, vecHits);
    if (q.rerank !== false) {
      const degrees = this.degreesFor(fused.map((h) => h.id));
      const candidates: RerankCandidate[] = fused.map((h) => ({
        id: h.id,
        kind: h.kind,
        name: h.name ?? null,
        file: h.file ?? null,
        rrfScore: h.score,
        degree: degrees.get(h.id) ?? 0,
      }));
      return rerank(candidates, q.text, limit, offset);
    }
    return fused.slice(offset, offset + limit).map((h) => ({ ...h, score: round5(h.score) }));
  }

  /** Total in+out edge count per node id — the centrality signal for M2.2 rerank. Indexed lookups. */
  private degreesFor(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    // Two indexed subqueries, not `src = ? OR dst = ?` — SQLite cannot use both idx_edges_src and
    // idx_edges_dst for an OR, so the single-predicate form degrades to a scan. Runs once per
    // reranked candidate (pool >= 50), so it sits on the interactive query path.
    const stmt = this.stmt(
      'SELECT (SELECT COUNT(*) FROM edges WHERE src = ?) + (SELECT COUNT(*) FROM edges WHERE dst = ?) AS n',
    );
    for (const id of ids) {
      const row = stmt.get(id, id) as { n: number };
      out.set(id, row.n);
    }
    return out;
  }

  /** Pure BM25 projection (FTS5). Lower `score` = better. */
  private bm25Query(q: HybridQuery, limit: number, offset: number): Hit[] {
    const match = toFtsMatch(q.text);
    if (!match) return [];
    const kindFilter = q.kinds?.length
      ? ` AND n.kind IN (${q.kinds.map(() => '?').join(',')})`
      : '';
    const rows = this.stmt(
      `SELECT n.id AS id, n.kind AS kind, n.name AS name, n.file AS file, bm25(nodes_fts) AS score
         FROM nodes_fts
         JOIN nodes n ON n.id = nodes_fts.id
         WHERE nodes_fts MATCH ?${kindFilter}
         ORDER BY score ASC
         LIMIT ? OFFSET ?`,
    ).all(match, ...(q.kinds ?? []), limit, offset) as Array<{
      id: string;
      kind: NodeKind;
      name: string | null;
      file: string | null;
      score: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      score: r.score,
      ...(r.name != null ? { name: r.name } : {}),
      ...(r.file != null ? { file: r.file } : {}),
    }));
  }

  /**
   * Brute-force cosine ANN over the derived `vectors` table (M2.1). No native vector extension —
   * the float32 vectors live as BLOBs in the existing `node:sqlite` index, scanned in one pass.
   * For 18k nodes this is sub-millisecond; M3.6's ≥1M-LOC scale bench decides whether to graduate
   * to sqlite-vec / sharded loading. `score` = cosine similarity (higher = better).
   */
  private vectorQuery(text: string, limit: number, kinds?: NodeKind[]): Hit[] {
    if (!this.embedder || this.builtDim === 0) return [];
    const qvec = this.embedder.embed(text);
    const kindSet = kinds?.length ? new Set(kinds) : undefined;
    const rows = this.db
      .prepare('SELECT v.id AS id, v.vec AS vec FROM vectors v WHERE v.dim = ?')
      .all(this.builtDim) as Array<{ id: string; vec: Uint8Array }>;
    const scored: Array<{ id: string; score: number }> = [];
    for (const r of rows) {
      const v = decodeVec(r.vec, this.builtDim);
      const sim = cosine(qvec, v);
      if (sim <= 0) continue;
      scored.push({ id: r.id, score: sim });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);
    if (top.length === 0) return [];
    const scoreById = new Map(top.map((s) => [s.id, s.score]));
    const metaRows = this.db
      .prepare(
        `SELECT id, kind, name, file FROM nodes WHERE id IN (${top.map(() => '?').join(',')})`,
      )
      .all(...top.map((s) => s.id)) as Array<{
      id: string;
      kind: NodeKind;
      name: string | null;
      file: string | null;
    }>;
    const meta = new Map(metaRows.map((r) => [r.id, r]));
    if (kindSet) {
      for (const r of metaRows) if (!kindSet.has(r.kind)) meta.delete(r.id);
    }
    return top
      .map((s) => meta.get(s.id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        score: scoreById.get(r.id)!,
        ...(r.name != null ? { name: r.name } : {}),
        ...(r.file != null ? { file: r.file } : {}),
      }));
  }

  /**
   * Embed every node into the `vectors` table. Uses only the in-soul surface fields (name +
   * qualifiedName + signature + heading + file) — NOT the rehydrated body — so the build is fast,
   * deterministic, and aligned with the conceptual-query mechanism (paraphrases match the *name*
   * surface). The body is already in FTS5 for exact-content matches.
   */
  private buildVectors(soul: SoulStore): void {
    if (!this.embedder) return;
    const e = this.embedder;
    this.builtDim = e.dim();
    this.builtEmbedderId = e.id;
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO vectors (id, vec, dim) VALUES (?, ?, ?)',
    );
    const insertMany = this.transaction(() => {
      for (const node of soul.iterate()) {
        const v = e.embed(vectorText(node));
        upsert.run(node.id, Buffer.from(encodeVec(v)), v.length);
      }
    });
    insertMany();
  }

  impact(id: string, dir: Dir, depth = Number.POSITIVE_INFINITY): ImpactResult {
    const visited = new Set<string>([id]);
    const collectedNodes: string[] = [];
    const collectedEdges: Edge[] = [];
    let frontier = [id];
    let d = 0;
    while (frontier.length > 0 && d < depth) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const edge of this.adjacent(cur, dir)) {
          const neighbor = dir === 'up' ? edge.src : edge.dst;
          collectedEdges.push(edge);
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            collectedNodes.push(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
      d++;
    }
    return { root: id, dir, depth: d, nodes: collectedNodes, edges: collectedEdges };
  }

  neighbors(id: string, rel?: Rel, dir?: Dir): Edge[] {
    const dirs: Dir[] = dir ? [dir] : ['down', 'up'];
    const out: Edge[] = [];
    const seen = new Set<string>();
    for (const dd of dirs) {
      for (const edge of this.adjacent(id, dd)) {
        if (rel && edge.rel !== rel) continue;
        if (seen.has(edge.id)) continue;
        seen.add(edge.id);
        out.push(edge);
      }
    }
    return out;
  }

  shortestPath(from: string, to: string, maxHops = Number.POSITIVE_INFINITY): PathResult {
    if (from === to) return { found: true, path: [from], edges: [] };
    // BFS over directed edges (src→dst), tracking the edge used to reach each node.
    const prev = new Map<string, { node: string; edge: Edge }>();
    const visited = new Set<string>([from]);
    let frontier = [from];
    let hops = 0;
    while (frontier.length > 0 && hops < maxHops) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const edge of this.adjacent(cur, 'down')) {
          const nb = edge.dst;
          if (visited.has(nb)) continue;
          visited.add(nb);
          prev.set(nb, { node: cur, edge });
          if (nb === to) return this.reconstruct(from, to, prev);
          next.push(nb);
        }
      }
      frontier = next;
      hops++;
    }
    return { found: false, path: [], edges: [] };
  }

  capabilities(): IndexCapabilities {
    return { cypher: false, vector: this.builtEmbedderId !== null };
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Best effort: in-memory/closing handles may not need or accept a checkpoint.
    }
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private reconstruct(
    from: string,
    to: string,
    prev: Map<string, { node: string; edge: Edge }>,
  ): PathResult {
    const path: string[] = [to];
    const edges: Edge[] = [];
    let cur = to;
    while (cur !== from) {
      const step = prev.get(cur);
      if (!step) break;
      edges.push(step.edge);
      path.push(step.node);
      cur = step.node;
    }
    path.reverse();
    edges.reverse();
    return { found: true, path, edges };
  }

  /** Edges adjacent to `id`: `down` = outgoing (src=id), `up` = incoming (dst=id). */
  private adjacent(id: string, dir: Dir): Edge[] {
    const col = dir === 'down' ? 'src' : 'dst';
    const rows = this.db.prepare(`SELECT json FROM edges WHERE ${col} = ?`).all(id) as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as Edge);
  }

  /**
   * Wrap a callback in BEGIN ... COMMIT / ROLLBACK.
   * `node:sqlite` has no built-in `transaction()` helper, so we provide the same
   * synchronous, all-or-nothing semantics that `better-sqlite3` offered. The
   * current call sites never nest transactions, so a flat BEGIN is sufficient.
   */
  private transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec('BEGIN');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  /** Prepare-once/reuse accessor. See {@link stmtCache}. */
  private stmt(sql: string): StatementSync {
    let prepared = this.stmtCache.get(sql);
    if (prepared === undefined) {
      prepared = this.db.prepare(sql);
      this.stmtCache.set(sql, prepared);
    }
    return prepared;
  }

  /**
   * Remove a node's row from the FTS index by its *rowid*.
   *
   * `nodes_fts.id` is declared UNINDEXED, so `DELETE FROM nodes_fts WHERE id = ?` cannot seek — it
   * full-scans the entire FTS table per call, which made a full build O(N^2) (measured: 34.7s vs
   * 40ms for 30k rows). `rowid` IS the FTS5 docid and is always indexed, so we keep an explicit
   * id -> rowid map and delete by rowid instead.
   */
  private deleteFtsRow(id: string): void {
    const row = this.stmt('SELECT rid FROM fts_map WHERE id = ?').get(id) as
      | { rid: number }
      | undefined;
    if (row === undefined) return;
    this.stmt('DELETE FROM nodes_fts WHERE rowid = ?').run(row.rid);
    this.stmt('DELETE FROM fts_map WHERE id = ?').run(id);
  }

  private insertNode(node: Node, repoRoot: string, fileCache: FileLineCache, fresh: boolean): void {
    this.stmt(
      'INSERT OR REPLACE INTO nodes (id, kind, name, file, json) VALUES (?, ?, ?, ?, ?)',
    ).run(node.id, node.kind, node.name ?? null, node.file ?? null, JSON.stringify(node));
    // `fresh` = the full-rebuild path, where `reset()` has just dropped and recreated `nodes_fts`.
    // There is provably no prior row, so skipping the delete is not an optimisation gamble.
    if (!fresh) this.deleteFtsRow(node.id);
    const inserted = this.stmt(
      `INSERT INTO nodes_fts (id, ${FTS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      node.id,
      node.name ?? '',
      node.qualifiedName ?? '',
      node.signature ?? '',
      node.heading ?? '',
      node.file ?? '',
      composeSearchableBody(node, repoRoot, fileCache),
    );
    // Recorded on BOTH paths: without a map entry from the fresh build, the first later delta would
    // have no rowid to delete by and would leave a stale FTS row behind.
    this.stmt('INSERT OR REPLACE INTO fts_map (id, rid) VALUES (?, ?)').run(
      node.id,
      Number(inserted.lastInsertRowid),
    );
  }

  private insertEdge(edge: Edge): void {
    this.stmt(
      'INSERT OR REPLACE INTO edges (id, src, dst, rel, provenance, confidence, json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      edge.id,
      edge.src,
      edge.dst,
      edge.rel,
      edge.provenance,
      edge.confidence,
      JSON.stringify(edge),
    );
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT,
        file TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        rel TEXT NOT NULL,
        provenance TEXT NOT NULL,
        confidence REAL NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
      CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id UNINDEXED, name, qualifiedName, signature, heading, file, body
      );
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        vec BLOB NOT NULL,
        dim INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fts_map (
        id TEXT PRIMARY KEY,
        rid INTEGER NOT NULL
      );
      -- Authored meaning, searchable. Deliberately separate from nodes_fts: node text derives
      -- from the soul and changes only when code changes, whereas authored prose changes whenever
      -- an agent saves an artifact - a different lifecycle, tracked by its own generation counter.
      CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
        targetId UNINDEXED, layer UNINDEXED, purpose, detail
      );
      CREATE TABLE IF NOT EXISTS semantic_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  /**
   * Replace the searchable projection of the authored semantic layer.
   *
   * Without this the semantic layer is invisible to retrieval: prose is attached to hits only AFTER
   * keyword search has already chosen them, so authoring meaning improves how an answer READS but
   * never which answer is FOUND. Measured on this repo before it existed, a phrase occurring only
   * in authored prose returned zero hits, and "how do I debug a parser that hangs" ranked a Rust
   * test fixture first while the fuzz harness - described precisely for that - never surfaced.
   *
   * `generation` is `manifest.generation.semantic`, which every artifact save bumps, so a caller
   * can tell this projection is behind without re-reading every artifact.
   */
  buildSemanticIndex(
    entries: Array<{ targetId: string; layer: string; purpose: string; detail: string }>,
    generation: number,
  ): void {
    const apply = this.transaction(() => {
      this.db.exec('DELETE FROM semantic_fts');
      const insert = this.db.prepare(
        'INSERT INTO semantic_fts (targetId, layer, purpose, detail) VALUES (?, ?, ?, ?)',
      );
      for (const e of entries) insert.run(e.targetId, e.layer, e.purpose, e.detail);
      this.db
        .prepare('INSERT OR REPLACE INTO semantic_meta (k, v) VALUES (?, ?)')
        .run('generation', String(generation));
    });
    apply();
  }

  /** The `generation.semantic` this searchable projection was built at, or -1 if never built. */
  semanticIndexGeneration(): number {
    try {
      const row = this.db.prepare('SELECT v FROM semantic_meta WHERE k = ?').get('generation') as
        | { v: string }
        | undefined;
      return row === undefined ? -1 : Number.parseInt(row.v, 10);
    } catch {
      return -1; // table absent - an index built before this existed
    }
  }

  /**
   * Rank authored prose against a query. Returns target ids, best first (lower bm25 = better).
   *
   * `purpose` is weighted far above `detail`: a purpose is a deliberate one-line answer to "what is
   * this", while responsibilities and rules are supporting text that would otherwise let a long
   * artifact outrank a precisely-matching short one on term frequency alone.
   */
  semanticSearch(text: string, limit: number): Array<{ targetId: string; score: number }> {
    const match = toFtsMatch(text);
    if (match === undefined) return [];
    try {
      return this.db
        .prepare(
          `SELECT targetId, bm25(semantic_fts, 0.0, 0.0, 10.0, 1.0) AS score
             FROM semantic_fts WHERE semantic_fts MATCH ? ORDER BY score LIMIT ?`,
        )
        .all(match, limit) as Array<{ targetId: string; score: number }>;
    } catch {
      return []; // an unparseable query is an empty result, never an error
    }
  }

  private reset(): void {
    // DROP + recreate (not just DELETE rows) so a persisted index built with an older DDL
    // — e.g. before the WS-1 `body` FTS column — is migrated to the current schema on the
    // next full rebuild. reset() is only called by buildFromSoul (the full-rebuild path),
    // so dropping here is semantically the same as the old row-delete and is safe.
    this.db.exec(`
      DROP TABLE IF EXISTS nodes_fts;
      DROP TABLE IF EXISTS vectors;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS nodes;
      DROP TABLE IF EXISTS fts_map;
    `);
    // Every cached statement was compiled against the tables just dropped.
    this.stmtCache.clear();
    this.builtEmbedderId = null;
    this.builtDim = 0;
    this.createSchema();
  }
}

/**
 * Question scaffolding carried by natural-language queries. Deliberately small and closed: only
 * words that are almost never the SUBJECT of a code question. Domain words that look like
 * stopwords elsewhere (`use`, `set`, `get`, `call`, `new`, `class`, `type`) are excluded from this
 * list precisely because they are real identifiers in code.
 */
const QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doing',
  'have',
  'has',
  'had',
  'having',
  'i',
  'you',
  'we',
  'they',
  'it',
  'he',
  'she',
  'me',
  'my',
  'our',
  'your',
  'what',
  'why',
  'how',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'that',
  'this',
  'these',
  'those',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'from',
  'about',
  'into',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'there',
  'here',
  'not',
  'no',
  'so',
  'as',
  'too',
  'very',
  'just',
]);

/**
 * Turn a user query into a safe FTS5 MATCH expression: each alphanumeric token (plus its synonym
 * group, when one exists — the lightweight hybrid layer, see synonyms.ts) becomes a prefix match,
 * OR-joined. Returns undefined if the query has no usable tokens.
 */
function toFtsMatch(text: string): string | undefined {
  const allTokens = text.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 0);
  if (allTokens.length === 0) return undefined;
  // Drop question scaffolding. Tokens are OR-joined, so a word like "why" or "does" matches a large
  // share of the corpus and pulls unrelated documents up — an effect that got materially worse once
  // the semantic layer added hundreds of files of English prose to search. Measured: "why did you
  // choose blake3" ranked an unrelated ADR above the hashing module that answers it.
  //
  // Falls back to the unfiltered tokens when a query is nothing BUT scaffolding, so "how does it
  // work" still returns something rather than nothing.
  const content = allTokens.filter((t) => !QUERY_STOPWORDS.has(t.toLowerCase()));
  const rawTokens = content.length > 0 ? content : allTokens;
  const expanded = new Set<string>();
  for (const t of rawTokens) {
    for (const e of expandToken(t)) expanded.add(e);
  }
  return [...expanded].map((t) => `"${t}"*`).join(' OR ');
}

/**
 * Read `file`'s split lines, memoized in `fileCache` so a build over many nodes that share a file
 * reads it once. Returns undefined for unreadable files (the body column stays empty for that node).
 */
function readCachedLines(
  repoRoot: string,
  file: string,
  fileCache: FileLineCache,
): string[] | undefined {
  if (fileCache.has(file)) return fileCache.get(file);
  let lines: string[] | undefined;
  try {
    lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
  } catch {
    lines = undefined; // missing/unreadable file — body stays empty, signatures still indexed
  }
  fileCache.set(file, lines);
  return lines;
}

/**
 * Compose the searchable `body` text for one node: the rehydrated span from disk (capped at
 * BODY_FTS_CAP chars) folded with the in-soul logic fragments that survive even when the body is
 * absent (`expr` on statements/assignments/conditions, `cursorQuery`, `whenSelector` on
 * case-branches/exception-handlers, `errorMessage` on raises, `assignTarget`). This is a search-only
 * projection — it is never returned by `query`; deep body retrieval uses `rehydrateBody` (with its
 * own `truncated` paging flag). The cap is a build-time constant; no honesty flag is stored because
 * the column is never surfaced.
 */
function composeSearchableBody(node: Node, repoRoot: string, fileCache: FileLineCache): string {
  const parts: string[] = [];

  // 1. Rehydrated span text from disk (the body / DDL / statement text).
  //    The source policy is applied BEFORE the text enters the searchable body so a secret VALUE
  //    can never be matched by FTS. `deny` blocks the disk read entirely (encrypted/secure files +
  //    key/trust stores never reach the index body); `redact-properties` / `redact-mule-secrets`
  //    keep keys / placeholder references so structure stays searchable.
  if (node.file && node.span) {
    const policy = sourcePolicy(node);
    if (policy !== 'deny') {
      const lines = readCachedLines(repoRoot, node.file, fileCache);
      if (lines && lines.length > 0) {
        const start = Math.max(node.span.start - 1, 0);
        const end = Math.min(node.span.end, lines.length);
        if (end > start) {
          let spanText = lines.slice(start, end).join('\n');
          if (policy === 'redact-properties') spanText = redactPropertyText(spanText);
          else if (policy === 'redact-mule-secrets')
            spanText = redactMuleSecretAttributes(spanText);
          parts.push(spanText.length > BODY_FTS_CAP ? spanText.slice(0, BODY_FTS_CAP) : spanText);
        }
      }
    }
  }

  // 2. In-soul logic fragments — searchable even when the body is absent (e.g. a spec-only file).
  //    These are already on the node, so no disk read is needed; they carry the rule expressions,
  //    cursor queries, case selectors, and raise error messages that the extractors captured.
  if (node.expr) parts.push(node.expr);
  if (node.cursorQuery) parts.push(node.cursorQuery);
  if (node.whenSelector) parts.push(node.whenSelector);
  if (node.errorMessage) parts.push(node.errorMessage);
  if (node.assignTarget) parts.push(node.assignTarget);

  // Bound the combined blob so the in-soul fragments plus body never exceed the cap.
  const body = parts.join('\n');
  return body.length > BODY_FTS_CAP ? body.slice(0, BODY_FTS_CAP) : body;
}
