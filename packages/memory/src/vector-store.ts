/**
 * Persistent vector store for the cosine channel — SQLite, one row per (record, embedder).
 *
 * WHY THIS EXISTS, measured. `VersionedLexicalScorer` holds record vectors for its own lifetime, and
 * `lexicalChannel` constructs a FRESH scorer for every verb call. With the char-ngram fallback that
 * was free (a hashing trick over the text). With a real on-device model it is not: embedding a
 * 307-record ledger with `multilingual-e5-large` measured **4,896 ms**. Paid per recall, by every
 * agent, that alone would make the semantic default unusable — the ranking quality would be real
 * and nobody could afford to ask for it.
 *
 * The invalidation story is unusually simple, and it is a property of the ledger rather than a
 * trick: a memory id is `mem:<blake3-of-content>`, so a record's text CANNOT change under a stable
 * id. A vector keyed by `(recordId, embedderId, textVersion)` is therefore **immutable** — there is
 * no staleness to detect, no generation to compare, and no write path that can invalidate a row.
 * Edits mint a new id and simply miss the cache. That is why this store has no `invalidate()`:
 * offering one would imply a hazard that does not exist.
 *
 * `textVersion` is in the key because WHAT is embedded is a versioned decision (`recordSemanticText`
 * today, `recordEmbedText` before it). Changing that composition changes the vector for an unchanged
 * record, so it must not silently reuse rows written under the old composition.
 *
 * Everything here is derived state: it lives beside the FTS snapshot under the store's own index
 * home, is never committed, and can be deleted at any time — the next call simply re-embeds.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Embedder } from '@knowledge-crib/core';
import { decodeVec, encodeVec } from '@knowledge-crib/core';

/** The vector table. `dim` is stored so a mismatched model is refused rather than mis-scored. */
const TABLE = 'mem_vectors';
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    record_id    TEXT NOT NULL,
    embedder_id  TEXT NOT NULL,
    text_version TEXT NOT NULL,
    dim          INTEGER NOT NULL,
    vec          BLOB NOT NULL,
    PRIMARY KEY (record_id, embedder_id, text_version)
  ) WITHOUT ROWID;
`;

/** What a caller needs vectors for: an id and the text that represents it. */
export interface VectorTarget {
  id: string;
  text: string;
}

export interface MemoryVectorStoreOptions {
  /** `:memory:` for an ephemeral store (tests, no repo home). */
  dbPath: string;
  /** Identifies the embedding model; part of the row key so two models never share vectors. */
  embedderId: string;
  /** Identifies the text composition (see the module doc); part of the row key. */
  textVersion: string;
  dim: number;
}

/**
 * A content-addressed vector cache. Reads are a single indexed lookup; misses are embedded in ONE
 * batch and written back, so a cold ledger costs one model call rather than N.
 */
export class MemoryVectorStore {
  private db: DatabaseSync | undefined;
  private selectStmt: StatementSync | undefined;
  private insertStmt: StatementSync | undefined;

  constructor(private readonly opts: MemoryVectorStoreOptions) {}

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    if (this.opts.dbPath !== ':memory:') mkdirSync(dirname(this.opts.dbPath), { recursive: true });
    const db = new DatabaseSync(this.opts.dbPath);
    db.exec(SCHEMA);
    this.selectStmt = db.prepare(
      `SELECT vec, dim FROM ${TABLE} WHERE record_id = ? AND embedder_id = ? AND text_version = ?`,
    );
    this.insertStmt = db.prepare(
      `INSERT OR REPLACE INTO ${TABLE} (record_id, embedder_id, text_version, dim, vec) VALUES (?, ?, ?, ?, ?)`,
    );
    this.db = db;
    return db;
  }

  /**
   * Vectors for every target, embedding only the misses.
   *
   * Fail-OPEN by construction: if the cache cannot be opened or read, the targets are embedded
   * directly. A derived read model must never break the operation it accelerates — the worst a
   * broken cache can do here is cost time.
   */
  vectorsFor(targets: readonly VectorTarget[], embedder: Embedder): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const missing: VectorTarget[] = [];

    try {
      this.handle();
      for (const t of targets) {
        const row = this.selectStmt?.get(t.id, this.opts.embedderId, this.opts.textVersion) as
          | { vec: Uint8Array; dim: number }
          | undefined;
        // A dim mismatch means the row predates a model change that kept its id — treat as a miss
        // rather than returning a vector the scorer would silently compare against the wrong space.
        if (row && row.dim === this.opts.dim) out.set(t.id, decodeVec(row.vec, row.dim));
        else missing.push(t);
      }
    } catch {
      return this.embedAll(targets, embedder); // unreadable cache → behave as if it were empty
    }

    if (missing.length === 0) return out;

    // ONE batch for every miss: a model call's fixed cost dominates its per-item cost.
    const fresh = embedder.embedBatch(missing.map((t) => t.text));
    for (let i = 0; i < missing.length; i++) {
      const vec = fresh[i];
      if (!vec) continue;
      out.set(missing[i]!.id, vec);
    }
    try {
      const db = this.handle();
      db.exec('BEGIN');
      for (let i = 0; i < missing.length; i++) {
        const vec = fresh[i];
        if (!vec) continue;
        this.insertStmt?.run(
          missing[i]!.id,
          this.opts.embedderId,
          this.opts.textVersion,
          this.opts.dim,
          encodeVec(vec),
        );
      }
      db.exec('COMMIT');
    } catch {
      try {
        this.handle().exec('ROLLBACK');
      } catch {
        // the write is best-effort; the vectors are already in `out`
      }
    }
    return out;
  }

  private embedAll(
    targets: readonly VectorTarget[],
    embedder: Embedder,
  ): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const vecs = embedder.embedBatch(targets.map((t) => t.text));
    for (let i = 0; i < targets.length; i++) {
      const vec = vecs[i];
      if (vec) out.set(targets[i]!.id, vec);
    }
    return out;
  }

  /** Rows currently held for this (embedder, textVersion). Diagnostics only. */
  size(): number {
    try {
      const row = this.handle()
        .prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE embedder_id = ? AND text_version = ?`)
        .get(this.opts.embedderId, this.opts.textVersion) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Drop rows whose record id is no longer live. Vectors are immutable, so this is the ONLY reason
   * to delete one: the record it described is gone. Returns the number removed.
   */
  pruneOrphans(liveIds: ReadonlySet<string>): number {
    try {
      const db = this.handle();
      const rows = db.prepare(`SELECT record_id FROM ${TABLE}`).all() as { record_id: string }[];
      const dead = rows.map((r) => r.record_id).filter((id) => !liveIds.has(id));
      if (dead.length === 0) return 0;
      const del = db.prepare(`DELETE FROM ${TABLE} WHERE record_id = ?`);
      db.exec('BEGIN');
      for (const id of dead) del.run(id);
      db.exec('COMMIT');
      return dead.length;
    } catch {
      return 0;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = undefined;
    this.selectStmt = undefined;
    this.insertStmt = undefined;
  }
}
