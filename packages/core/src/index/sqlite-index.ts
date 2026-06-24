import type { Edge, Node, NodeKind, Rel } from '@knowledge-crib/soul-schema';
/**
 * SqliteIndexStore — the default IndexStore backend (M1).
 *
 * better-sqlite3 + FTS5 (BM25 ranking) + materialized adjacency, so `impact`/`neighbors`/
 * `shortestPath` are O(degree) graph walks over indexed `edges(src)` / `edges(dst)`. Vectors are
 * out of scope for the deterministic core — `withEmbeddings` provisions an (empty) vector table but
 * ANN search lands with the semantic linker at M7; until then `capabilities().vector=false`.
 *
 * sqlite-vec ceiling (research §4.3): brute-force exact KNN is impractical above ~100k vectors, so
 * vectors are opt-in and never on the deterministic query hot path.
 */
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import type {
  BuildOpts,
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

/** Columns we feed into FTS5 for free-text search over symbols + doc sections. */
const FTS_COLUMNS = 'name, qualifiedName, signature, heading, file';

export class SqliteIndexStore implements IndexStore {
  private readonly db: DB;
  private withEmbeddings = false;

  /**
   * @param path file path for the sqlite db, or ':memory:' for an ephemeral index.
   */
  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
    this.createSchema();
  }

  buildFromSoul(soul: SoulStore, opts: BuildOpts = {}): void {
    this.withEmbeddings = opts.withEmbeddings ?? false;
    this.reset();
    const insertMany = this.db.transaction(() => {
      for (const node of soul.iterate()) this.insertNode(node);
      for (const edge of soul.iterateEdges()) this.insertEdge(edge);
    });
    insertMany();
  }

  applyDelta(changed: IndexDelta): void {
    const apply = this.db.transaction(() => {
      for (const id of changed.removed) {
        this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM nodes_fts WHERE id = ?').run(id);
        this.db.prepare('DELETE FROM edges WHERE id = ?').run(id);
      }
      for (const node of changed.nodes) this.insertNode(node);
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
    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.kind AS kind, n.name AS name, n.file AS file, bm25(nodes_fts) AS score
         FROM nodes_fts
         JOIN nodes n ON n.id = nodes_fts.id
         WHERE nodes_fts MATCH ?${kindFilter}
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(match, ...(q.kinds ?? []), limit) as Array<{
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

  private insertNode(node: Node): void {
    this.db
      .prepare('INSERT OR REPLACE INTO nodes (id, kind, name, file, json) VALUES (?, ?, ?, ?, ?)')
      .run(node.id, node.kind, node.name ?? null, node.file ?? null, JSON.stringify(node));
    this.db.prepare('DELETE FROM nodes_fts WHERE id = ?').run(node.id);
    this.db
      .prepare(`INSERT INTO nodes_fts (id, ${FTS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        node.id,
        node.name ?? '',
        node.qualifiedName ?? '',
        node.signature ?? '',
        node.heading ?? '',
        node.file ?? '',
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
        id UNINDEXED, name, qualifiedName, signature, heading, file
      );
    `);
  }

  private reset(): void {
    this.db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM nodes_fts;');
  }
}

/**
 * Turn a user query into a safe FTS5 MATCH expression: each alphanumeric token becomes a prefix
 * match, OR-joined. Returns undefined if the query has no usable tokens.
 */
function toFtsMatch(text: string): string | undefined {
  const tokens = text
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return tokens.length > 0 ? tokens.join(' OR ') : undefined;
}
