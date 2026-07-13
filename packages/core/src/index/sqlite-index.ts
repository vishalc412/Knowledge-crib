import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Edge, Node, NodeKind, Rel } from '@knowledge-crib/soul-schema';
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
import { expandToken } from './synonyms.js';

/** Columns we feed into FTS5 for free-text search over symbols + doc sections + bodies. */
const FTS_COLUMNS = 'name, qualifiedName, signature, heading, file, body';

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

  /**
   * @param path file path for the sqlite db, or ':memory:' for an ephemeral index.
   */
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.createSchema();
  }

  buildFromSoul(soul: SoulStore, repoRoot: string): void {
    this.reset();
    const fileCache: FileLineCache = new Map();
    const insertMany = this.transaction(() => {
      for (const node of soul.iterate()) this.insertNode(node, repoRoot, fileCache);
      for (const edge of soul.iterateEdges()) this.insertEdge(edge);
    });
    insertMany();
  }

  applyDelta(changed: IndexDelta, repoRoot: string): void {
    const fileCache: FileLineCache = new Map();
    const apply = this.transaction(() => {
      for (const id of changed.removed) {
        this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM nodes_fts WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM edges WHERE id = ?').run(id);
      }
      for (const node of changed.nodes) this.insertNode(node, repoRoot, fileCache);
      for (const edge of changed.edges) this.insertEdge(edge);
    });
    apply();
  }

  query(q: HybridQuery): Hit[] {
    const limit = q.limit ?? 10;
    const match = toFtsMatch(q.text);
    if (!match) return [];
    const kindFilter = q.kinds?.length
      ? ` AND n.kind IN (${q.kinds.map(() => '?').join(',')})`
      : '';
    const offset = q.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.kind AS kind, n.name AS name, n.file AS file, bm25(nodes_fts) AS score
         FROM nodes_fts
         JOIN nodes n ON n.id = nodes_fts.id
         WHERE nodes_fts MATCH ?${kindFilter}
         ORDER BY score ASC
         LIMIT ? OFFSET ?`,
      )
      .all(match, ...(q.kinds ?? []), limit, offset) as Array<{
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
    return { cypher: false, vector: false };
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

  private insertNode(node: Node, repoRoot: string, fileCache: FileLineCache): void {
    this.db
      .prepare('INSERT OR REPLACE INTO nodes (id, kind, name, file, json) VALUES (?, ?, ?, ?, ?)')
      .run(node.id, node.kind, node.name ?? null, node.file ?? null, JSON.stringify(node));
    this.db.prepare('DELETE FROM nodes_fts WHERE id = ?').run(node.id);
    this.db
      .prepare(`INSERT INTO nodes_fts (id, ${FTS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        node.id,
        node.name ?? '',
        node.qualifiedName ?? '',
        node.signature ?? '',
        node.heading ?? '',
        node.file ?? '',
        composeSearchableBody(node, repoRoot, fileCache),
      );
  }

  private insertEdge(edge: Edge): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO edges (id, src, dst, rel, provenance, confidence, json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
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
    `);
  }

  private reset(): void {
    // DROP + recreate (not just DELETE rows) so a persisted index built with an older DDL
    // — e.g. before the WS-1 `body` FTS column — is migrated to the current schema on the
    // next full rebuild. reset() is only called by buildFromSoul (the full-rebuild path),
    // so dropping here is semantically the same as the old row-delete and is safe.
    this.db.exec(`
      DROP TABLE IF EXISTS nodes_fts;
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS nodes;
    `);
    this.createSchema();
  }
}

/**
 * Turn a user query into a safe FTS5 MATCH expression: each alphanumeric token (plus its synonym
 * group, when one exists — the lightweight hybrid layer, see synonyms.ts) becomes a prefix match,
 * OR-joined. Returns undefined if the query has no usable tokens.
 */
function toFtsMatch(text: string): string | undefined {
  const rawTokens = text.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 0);
  if (rawTokens.length === 0) return undefined;
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
  if (node.file && node.span) {
    const lines = readCachedLines(repoRoot, node.file, fileCache);
    if (lines && lines.length > 0) {
      const start = Math.max(node.span.start - 1, 0);
      const end = Math.min(node.span.end, lines.length);
      if (end > start) {
        const spanText = lines.slice(start, end).join('\n');
        parts.push(spanText.length > BODY_FTS_CAP ? spanText.slice(0, BODY_FTS_CAP) : spanText);
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
