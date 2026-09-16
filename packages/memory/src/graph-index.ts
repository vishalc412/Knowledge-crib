/**
 * WP-G2's disposable SQLite read model. Canonical graph entries remain in the memory journal;
 * this index contains one already-authorized projection and can therefore be deleted and rebuilt
 * without changing graph truth. Replacements run in one SQLite transaction so a reader observes
 * either the preceding projection or the complete next projection, never a mixed graph.
 */
import { DatabaseSync } from 'node:sqlite';
import type { GraphProjection } from './graph-projection.js';
import type { GraphAssertion } from './types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_graph_assertions (
    id TEXT PRIMARY KEY,
    subject_ref TEXT NOT NULL,
    object_ref TEXT NOT NULL,
    predicate TEXT NOT NULL,
    assertion_json TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS memory_graph_adjacency (
    ref TEXT NOT NULL,
    assertion_id TEXT NOT NULL,
    PRIMARY KEY (ref, assertion_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS memory_graph_adjacency_ref
    ON memory_graph_adjacency(ref, assertion_id);
  CREATE TABLE IF NOT EXISTS memory_graph_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
`;

export interface GraphIndexReplaceMeta {
  /** Durable graph-journal position represented by this projection. */
  sourcePosition: string;
  /** Code graph revision whose refs were available when it was built. */
  codeRevision: string;
  /** Monotonic published generation assigned by the refresh coordinator. */
  generation: number;
}

export interface GraphIndexStatus extends GraphIndexReplaceMeta {
  assertionCount: number;
}

/** A SQLite index over one authorized graph projection. */
export class MemoryGraphIndex {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  /** Replace every derived row atomically with `projection.current`. */
  replace(projection: GraphProjection, meta: GraphIndexReplaceMeta): void {
    const insertAssertion = this.db.prepare(
      `INSERT INTO memory_graph_assertions (id, subject_ref, object_ref, predicate, assertion_json)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertAdjacency = this.db.prepare(
      'INSERT INTO memory_graph_adjacency (ref, assertion_id) VALUES (?, ?)',
    );
    const putMeta = this.db.prepare(
      'INSERT INTO memory_graph_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM memory_graph_adjacency');
      this.db.exec('DELETE FROM memory_graph_assertions');
      for (const assertion of projection.current) {
        insertAssertion.run(
          assertion.id,
          assertion.subject,
          assertion.object,
          assertion.predicate,
          JSON.stringify(assertion),
        );
        insertAdjacency.run(assertion.subject, assertion.id);
        if (assertion.object !== assertion.subject)
          insertAdjacency.run(assertion.object, assertion.id);
      }
      putMeta.run('sourcePosition', meta.sourcePosition);
      putMeta.run('codeRevision', meta.codeRevision);
      putMeta.run('generation', String(meta.generation));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Deterministically retrieve trusted projection edges touching one exact reference. */
  neighbors(ref: string): GraphAssertion[] {
    const rows = this.db
      .prepare(
        `SELECT a.assertion_json
         FROM memory_graph_adjacency AS d
         JOIN memory_graph_assertions AS a ON a.id = d.assertion_id
         WHERE d.ref = ?
         ORDER BY a.id ASC`,
      )
      .all(ref) as { assertion_json: string }[];
    return rows.map((row) => JSON.parse(row.assertion_json) as GraphAssertion);
  }

  /** The metadata and row count are the index's freshness report. */
  status(): GraphIndexStatus {
    const values = this.db
      .prepare('SELECT key, value FROM memory_graph_meta WHERE key IN (?, ?, ?)')
      .all('sourcePosition', 'codeRevision', 'generation') as { key: string; value: string }[];
    const meta = new Map(values.map((row) => [row.key, row.value]));
    const count = this.db
      .prepare('SELECT count(*) AS count FROM memory_graph_assertions')
      .get() as { count: number };
    return {
      sourcePosition: meta.get('sourcePosition') ?? '',
      codeRevision: meta.get('codeRevision') ?? '',
      generation: Number(meta.get('generation') ?? 0),
      assertionCount: count.count,
    };
  }

  close(): void {
    this.db.close();
  }
}
