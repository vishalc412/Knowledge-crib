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

/**
 * Which step of a cache operation failed.
 *
 * `open` — the cache could not be opened or schema'd (a corrupt file, a full disk, a read-only home,
 * a `node:sqlite` without the API this assumes). `read` — the handle opened but a lookup threw.
 * `begin` / `write` / `commit` — the write-back transaction failed at that step. `rollback` — the
 * transaction was opened, the write failed, and the undo ITSELF then failed: the store is left in
 * the state the transaction was meant to leave behind, which is a distinct and worse outcome than a
 * clean `begin` failure, and the one a caller most needs to hear about.
 */
export type VectorCacheFailurePhase = 'open' | 'read' | 'begin' | 'write' | 'commit' | 'rollback';

/** One failed cache operation, reported through {@link MemoryVectorStoreOptions.onCacheFailure}. */
export interface VectorCacheFailure {
  phase: VectorCacheFailurePhase;
  error: unknown;
  /**
   * How many rows had been attempted when it failed. Always 0 for `open`, `read` and `begin` —
   * nothing had been written yet at those points.
   */
  attempted: number;
}

export interface MemoryVectorStoreOptions {
  /** `:memory:` for an ephemeral store (tests, no repo home). */
  dbPath: string;
  /** Identifies the embedding model; part of the row key so two models never share vectors. */
  embedderId: string;
  /** Identifies the text composition (see the module doc); part of the row key. */
  textVersion: string;
  dim: number;
  /**
   * Observe a failed cache operation. The READ PATH stays fail-OPEN either way — the caller still
   * receives its vectors — but a cache that fails on every call must not look identical to a healthy
   * one. WP1 defect D1-i: both of this class's failure paths used to be completely silent, so a
   * permanently failing cache degraded every call to "embed from scratch" with no signal anywhere:
   * the ledger still answered, and every answer paid a model call it should not have.
   *
   * The callback is best-effort: an observer that throws cannot break the read it observes.
   */
  onCacheFailure?: (failure: VectorCacheFailure) => void;
}

/**
 * A content-addressed vector cache. Reads are a single indexed lookup; misses are embedded in ONE
 * batch and written back, so a cold ledger costs one model call rather than N.
 */
export class MemoryVectorStore {
  private db: DatabaseSync | undefined;
  private selectStmt: StatementSync | undefined;
  private insertStmt: StatementSync | undefined;
  private cacheFailureCount = 0;

  constructor(private readonly opts: MemoryVectorStoreOptions) {}

  /**
   * How many cache operations have failed in this store's lifetime. Non-zero means the cache is not
   * doing its job: reads are still CORRECT (they are embedded in-process on every call), they are
   * just paying the model call every time. Reported separately from a throw because every read path
   * here is deliberately fail-open.
   */
  cacheFailures(): number {
    return this.cacheFailureCount;
  }

  /** Record one failed cache operation and hand it to the optional observer. Never throws. */
  private noteCacheFailure(
    phase: VectorCacheFailurePhase,
    error: unknown,
    attempted: number,
  ): void {
    this.cacheFailureCount += 1;
    try {
      this.opts.onCacheFailure?.({ phase, error, attempted });
    } catch {
      // An observer that throws must not break the fail-open read it is observing.
    }
  }

  /**
   * Name a failure by whether the handle ever came up. `handle()` assigns `this.db` only after the
   * schema and both statements are prepared, so an undefined handle proves the fault was in opening
   * the cache — a different problem (and a different fix) from one raised after it opened.
   */
  private failurePhaseFor(openedPhase: VectorCacheFailurePhase): VectorCacheFailurePhase {
    return this.db === undefined ? 'open' : openedPhase;
  }

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
    } catch (error) {
      // Unreadable cache → behave as if it were empty, which keeps the operation correct. The one
      // thing it must not do is pass for a healthy cache: without this report, a store whose file is
      // corrupt re-embeds the entire ledger on every single call, for the life of the process, and
      // looks from the outside exactly like a store that is working.
      this.noteCacheFailure(this.failurePhaseFor('read'), error, 0);
      return this.embedAll(targets, embedder);
    }

    if (missing.length === 0) return out;

    // ONE batch for every miss: a model call's fixed cost dominates its per-item cost.
    const fresh = embedder.embedBatch(missing.map((t) => t.text));
    for (let i = 0; i < missing.length; i++) {
      const vec = fresh[i];
      if (!vec) continue;
      out.set(missing[i]!.id, vec);
    }
    // The write-back is best-effort BY DESIGN: `out` already holds every vector, so a failure here
    // costs time on the next call and never correctness on this one. What it must NOT be is SILENT
    // (WP1 defect D1-i) — which is what it was, so `COMMIT` and `ROLLBACK` and "BEGIN never ran"
    // were indistinguishable from the caller and a permanently dead cache looked healthy.
    let phase: VectorCacheFailurePhase = 'begin';
    let inTransaction = false;
    let attempted = 0;
    try {
      const db = this.handle();
      db.exec('BEGIN');
      inTransaction = true;
      phase = 'write';
      for (let i = 0; i < missing.length; i++) {
        const vec = fresh[i];
        if (!vec) continue;
        attempted += 1;
        this.insertStmt?.run(
          missing[i]!.id,
          this.opts.embedderId,
          this.opts.textVersion,
          this.opts.dim,
          encodeVec(vec),
        );
      }
      phase = 'commit';
      db.exec('COMMIT');
      inTransaction = false;
    } catch (error) {
      // Annotated, not inferred: control-flow analysis sees only the values ASSIGNED in the `try`
      // ('begin' | 'write' | 'commit'), so an inferred local could never hold the `'rollback'` this
      // catch is the one place able to produce.
      let failurePhase: VectorCacheFailurePhase = this.failurePhaseFor(phase);
      // Undo only what was actually opened. A throw out of `handle()` or `BEGIN` leaves no
      // transaction of ours, and ROLLBACK against one throws "no transaction is active" — which the
      // previous code swallowed, hiding that the undo it claimed to attempt never happened.
      if (inTransaction) {
        try {
          this.handle().exec('ROLLBACK');
        } catch {
          failurePhase = 'rollback';
        }
      }
      this.noteCacheFailure(failurePhase, error, attempted);
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

  /**
   * Rows currently held for this (embedder, textVersion). Diagnostics only.
   *
   * A `0` is honest about the ROW COUNT and silent about the reason — an unreadable cache also
   * yields 0. {@link cacheFailures} tells the two apart, and this call reports into it like the
   * others rather than being the one path that can fail invisibly.
   */
  size(): number {
    try {
      const row = this.handle()
        .prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE embedder_id = ? AND text_version = ?`)
        .get(this.opts.embedderId, this.opts.textVersion) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch (error) {
      this.noteCacheFailure(this.failurePhaseFor('read'), error, 0);
      return 0;
    }
  }

  /**
   * Drop rows whose record id is no longer live. Vectors are immutable, so this is the ONLY reason
   * to delete one: the record it described is gone. Returns the number removed.
   *
   * A `0` on a store whose cache is failing means "could not prune", not "nothing to prune" — the
   * same false acknowledgement {@link vectorsFor} had (WP1 defect D1-i). Check {@link cacheFailures}
   * (or pass `onCacheFailure`) when the distinction matters.
   */
  pruneOrphans(liveIds: ReadonlySet<string>): number {
    // Starts at 'read', not 'begin': the scan runs BEFORE any transaction is opened, so a failure
    // there is a read failure. (`failurePhaseFor` separately promotes an unopened handle to 'open'.)
    let phase: VectorCacheFailurePhase = 'read';
    let inTransaction = false;
    let attempted = 0;
    try {
      const db = this.handle();
      const rows = db.prepare(`SELECT record_id FROM ${TABLE}`).all() as { record_id: string }[];
      const dead = rows.map((r) => r.record_id).filter((id) => !liveIds.has(id));
      if (dead.length === 0) return 0;
      const del = db.prepare(`DELETE FROM ${TABLE} WHERE record_id = ?`);
      phase = 'begin';
      db.exec('BEGIN');
      inTransaction = true;
      phase = 'write';
      for (const id of dead) {
        attempted += 1;
        del.run(id);
      }
      phase = 'commit';
      db.exec('COMMIT');
      inTransaction = false;
      return dead.length;
    } catch (error) {
      let failurePhase: VectorCacheFailurePhase = this.failurePhaseFor(phase);
      if (inTransaction) {
        try {
          this.handle().exec('ROLLBACK');
        } catch {
          failurePhase = 'rollback';
        }
      }
      this.noteCacheFailure(failurePhase, error, attempted);
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
