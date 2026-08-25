/**
 * W3 Slice 2 — the derived memory FTS index: a disposable, gitignored SQLite FTS5 read model over
 * the memory records (PRD boundary #3, W3 lines 323–326). This is the layer that supplies the
 * criterion-1 *lexical relevance* signal the Slice 1 recall core consumes via the {@link LexicalScorer}
 * port — the recall core itself stays SQLite-free and unit-testable in isolation.
 *
 * DELIBERATELY SEPARATE from the soul's code BM25 index (`SqliteIndexStore`): PRD W3 line 333 —
 * "never mix code BM25 + memory scores". This index lives in its own DB file under `.crib/index/`
 * (gitignored, disposable, rebuilt on demand), indexes ONLY memory records, and is consumed ONLY by
 * the memory recall path. `brief` returns the two as typed groups so they are never fused.
 *
 * Indexed fields (PRD W3 line 325): claim, subject, scope, appliesTo targets, evidence summaries, and
 * artifact/path references folded out of appliesTo + evidence soul ids. Each record is one FTS5 row;
 * `bm25(mem_fts)` ranks matches. The scorer negates bm25 (FTS5 returns negative, lower = better) so
 * the score is "higher = better", consistent with {@link exactLexicalScorer}, and clamps to ≥0 so a
 * weak FTS match never scores below a non-match. BM25 magnitudes are O(1–10), vastly below
 * {@link EXACT_MATCH_BONUS} = 1e6, so exact subject/target matches always dominate lexical relevance.
 *
 * The index is built once per recall session from the gathered records and is immutable for the
 * scorer's lifetime; {@link FtsLexicalScorer} memoizes one FTS query per distinct query string (a
 * recall projection reuses a single query, so this is one FTS scan per projection).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type LexicalScorer, exactLexicalScorer } from './recall.js';
import type { MemoryEvidence, MemoryRecord } from './types.js';

// ─── schema ──────────────────────────────────────────────────────────────────

/** The FTS5 columns indexed for lexical search over memory records. */
const FTS_TABLE = 'mem_fts';
const FTS_COLUMNS = ['subject', 'claim', 'targets', 'evidence', 'scope'] as const;
const FTS_COLUMN_LIST = FTS_COLUMNS.join(', ');

const SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
    id UNINDEXED,
    ${FTS_COLUMN_LIST},
    tokenize = 'unicode61'
  );
`;

// ─── text composition ────────────────────────────────────────────────────────

/** Per-evidence lexical summary: kind + the source quote / soul anchor it pins to (if any). */
function evidenceSummary(ev: MemoryEvidence): string {
  const parts: string[] = [ev.kind];
  const quote = (ev as Record<string, unknown>).quote;
  if (typeof quote === 'string' && quote.length > 0) parts.push(quote);
  const soulId = (ev as Record<string, unknown>).soulId;
  if (typeof soulId === 'string' && soulId.length > 0) parts.push(soulId);
  const desc = (ev as Record<string, unknown>).description;
  if (typeof desc === 'string' && desc.length > 0) parts.push(desc);
  return parts.join(' ');
}

/** Compose the `targets` column: appliesTo ids + evidence soul ids (artifact/path refs included). */
function targetsText(record: MemoryRecord): string {
  const refs = new Set<string>(record.appliesTo);
  for (const ev of record.evidence) {
    const soulId = (ev as Record<string, unknown>).soulId;
    if (typeof soulId === 'string' && soulId.length > 0) refs.add(soulId);
  }
  return [...refs].join(' ');
}

/** Compose the `scope` column from the record's scope (boundary + repoId). */
function scopeText(record: MemoryRecord): string {
  const s = record.scope;
  return s.boundary === 'global' ? 'global' : `repo ${s.repoId ?? ''}`;
}

/** The FTS row values for one record, in column order: [id, subject, claim, targets, evidence, scope]. */
function ftsRow(record: MemoryRecord): [string, string, string, string, string, string] {
  return [
    record.id,
    record.subject,
    record.claim,
    targetsText(record),
    record.evidence.map(evidenceSummary).join(' '),
    scopeText(record),
  ];
}

// ─── the index ───────────────────────────────────────────────────────────────

/**
 * The disposable memory FTS5 index. Construct with a filesystem path under `.crib/index/` (the
 * derived, gitignored read model) or `:memory:` for tests. {@link rebuild} clears + bulk-inserts in
 * one transaction; {@link upsert} is the incremental delete-by-id + insert. Always {@link close} when
 * done to release the SQLite handle (the PRD forbids holding a filesystem lock across evaluation /
 * enrichment commands — this index is a memory-only derived artifact, rebuilt and closed per session).
 */
export class MemoryFtsIndex {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly searchStmt: StatementSync;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      `INSERT INTO ${FTS_TABLE} (id, ${FTS_COLUMN_LIST}) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.deleteStmt = this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE id = ?`);
    // bm25() returns a negative value (lower = better); ORDER BY score ASC puts best first.
    this.searchStmt = this.db.prepare(
      `SELECT id, bm25(${FTS_TABLE}) AS score FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY score ASC`,
    );
  }

  /** Clear and bulk-insert all records in one transaction. The canonical "rebuild the read model" op. */
  rebuild(records: Iterable<MemoryRecord>): void {
    this.assertNotClosed();
    this.db.exec('BEGIN');
    try {
      this.db.exec(`DELETE FROM ${FTS_TABLE}`);
      for (const r of records) this.insertStmt.run(...ftsRow(r));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Incremental delete-by-id + insert for a batch of records (FTS5 `id UNINDEXED` is not unique). */
  upsert(records: Iterable<MemoryRecord>): void {
    this.assertNotClosed();
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        this.deleteStmt.run(r.id);
        this.insertStmt.run(...ftsRow(r));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Run an FTS5 MATCH query and return a per-record-id lexical-relevance map (higher = better, ≥0).
   * Non-matching records are simply absent from the map (callers default to 0). The MATCH expression
   * is built by {@link toFtsMatch}; an unusable query yields an empty map.
   */
  search(query: string): Map<string, number> {
    this.assertNotClosed();
    const match = toFtsMatch(query);
    if (!match) return new Map();
    const rows = this.searchStmt.all(match) as Array<{ id: string; score: number }>;
    const out = new Map<string, number>();
    for (const row of rows) {
      // FTS5 bm25 is ≤0 (lower = better); negate so higher = better, clamp weak/odd positives to 0.
      out.set(row.id, Math.max(0, -row.score));
    }
    return out;
  }

  /** Release the SQLite handle. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private assertNotClosed(): void {
    if (this.closed) throw new Error('MemoryFtsIndex is closed');
  }
}

// ─── the scorer (criterion 1 lexical relevance, FTS5-BM25-backed) ────────────

/**
 * The {@link LexicalScorer} backed by a {@link MemoryFtsIndex}. Exact subject/target match dominates
 * (returns {@link EXACT_MATCH_BONUS} + matched-target count, identical to {@link exactLexicalScorer});
 * otherwise the record's FTS5 BM25 score is returned (higher = better, ≥0, O(1–10) — well below the
 * exact-match bonus). One FTS query per distinct query string is memoized; call {@link reset} if the
 * underlying index is rebuilt mid-scorer-lifetime (not the default one-session pattern).
 */
export class FtsLexicalScorer implements LexicalScorer {
  private readonly cache = new Map<string, Map<string, number>>();

  constructor(private readonly index: MemoryFtsIndex) {}

  score(record: MemoryRecord, query: string, targetIds: readonly string[]): number {
    // Exact subject/target match is criterion 1's dominant signal — short-circuit before FTS.
    const exact = exactLexicalScorer(record, query, targetIds);
    if (exact > 0) return exact;
    if (query.length === 0) return 0; // empty MATCH is invalid in FTS5; no lexical signal.
    let byId = this.cache.get(query);
    if (byId === undefined) {
      byId = this.index.search(query);
      this.cache.set(query, byId);
    }
    return byId.get(record.id) ?? 0;
  }

  /** Drop the memoized FTS results (e.g. after the index is rebuilt with new records). */
  reset(): void {
    this.cache.clear();
  }
}

// ─── FTS5 MATCH expression ───────────────────────────────────────────────────

/**
 * Turn a user query into a safe FTS5 MATCH expression: each alphanumeric token becomes a prefix
 * match (`"token"*`), OR-joined. Returns `undefined` if the query has no usable tokens (the caller
 * skips the FTS scan entirely). Mirrors the soul index's `toFtsMatch` but stays local + synonym-free
 * (memory recall does not need the code-synonym layer).
 */
export function toFtsMatch(text: string): string | undefined {
  const tokens = text.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}
