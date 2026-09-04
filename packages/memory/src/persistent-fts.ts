/**
 * G3.1 — the PERSISTENT memory FTS read model: one on-disk FTS5 snapshot per repo, opened lazily at
 * first use, kept current INCREMENTALLY by the store's write hooks, and self-healing when it is
 * stale, corrupt, or written by a different index format.
 *
 * WHY: every `memory_recall` / `memory{op:'search'}` call rebuilt an ephemeral `:memory:` FTS index
 * over the whole gathered ledger — an O(N) insert per query that dominates recall latency as the
 * ledger grows (the Gate 3 scale target). The snapshot moves that cost to the write path as an
 * O(delta) upsert; the hot open path validates a tiny meta header and serves the file with ZERO
 * gather IO beyond what the projection already pays.
 *
 * Home: `<localStoreRoot>/fts/` (paths.ts layout — machine-local, gitignored by construction). It
 * deliberately does NOT live under the repo `.crib` with the soul's derived index: the local/global
 * stores live outside `.crib` on purpose (the repo clean/reindex paths sweep `.crib`), and a memory
 * read model must survive them. It is ONE merged snapshot over team + local + global records — BM25
 * scores are corpus statistics, so a per-store index trio would rank differently than the ephemeral
 * full-rebuild over the same gathered set (the byte-comparability invariant this module pins).
 *
 * Honesty rules (Gate 3.1, mirroring crib serve's stale-index self-heal):
 *   - **Staleness** is detected by a per-store generation sidecar (`<rootDir>/fts.gen`, bumped by
 *     MemoryStore under its write lock on every record-collection mutation) plus a store-root
 *     binding and a random nonce (so a cleared-and-recreated store can never coincide with a stale
 *     recorded generation). ANY divergence — format version, root, generation, nonce, or a store
 *     appearing/disappearing — falls back to a full rebuild from the shards. The shards are truth;
 *     the snapshot is disposable.
 *   - **Incremental** updates flow through the store's write listener (in-process): a
 *     record-collection mutation notifies the open index, which upserts/removes rows and records
 *     the new generation. A listener failure is fail-open — the index rows or meta lag, and the
 *     next open's generation check rebuilds. Writes while NO index is open bump the generation and
 *     the next open rebuilds (the honest cross-process catch-up; the long-running serve process,
 *     where writes and reads share the process, gets true incremental behaviour).
 *   - **Crash safety** mirrors the store's atomic temp→rename discipline for the meta header
 *     ({@link writeJsonAtomic}); the SQLite file itself is transactional, and anything unreadable
 *     is deleted and rebuilt rather than served.
 *   - **Sources-filtered queries** must NOT use the merged snapshot: a `sources` subset changes the
 *     corpus BM25's IDF is computed over, so a subset query against a full-corpus index would rank
 *     differently than today's ephemeral rebuild. Callers keep the ephemeral path for filtered
 *     queries; the snapshot serves the default all-sources path.
 *
 * NO wall-clock read anywhere in this module — the meta header carries only the format version and
 * per-store generation/nonce (the freshness ages on recall hits come from the evaluator, not from
 * index bookkeeping).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { writeJsonAtomic } from './atomic.js';
import { MemoryFtsIndex } from './fts-index.js';
import { type RecallStores, gatherRecall } from './recall.js';
import type { MemoryFtsGeneration, MemoryFtsWriteNotice } from './store.js';
import type { MemoryEntry, MemoryRecord, MemoryRecordV2, MemoryStoreRole } from './types.js';
import { MemoryVectorStore } from './vector-store.js';

/**
 * The index-format version. Bump on any change to the FTS schema, the row composition, or the meta
 * contract — a mismatch makes every existing snapshot rebuild once (self-healing, never fatal).
 */
export const MEMORY_FTS_FORMAT_VERSION = 1;

/** The per-store binding a snapshot records: where the store lives + the generation it was at. */
interface IndexStoreMeta extends MemoryFtsGeneration {
  root: string;
}

interface PersistentFtsMeta {
  formatVersion: number;
  stores: Partial<Record<MemoryStoreRole, IndexStoreMeta>>;
}

const ROLES: readonly MemoryStoreRole[] = ['team', 'local', 'global'];

/** Delete the snapshot db + any SQLite sidecar files (targeted rm of files this module owns). */
function removeIndexFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

export interface OpenMemoryFtsOptions {
  /**
   * Explicit index directory override (tests, or an operator relocating the snapshot). Defaults to
   * `<localStoreRoot>/fts`.
   */
  dir?: string;
  /** Force a full rebuild on open (self-heal escape hatch; tests). */
  rebuild?: boolean;
}

/**
 * Open the persistent memory FTS snapshot for a recall context. The snapshot lives under the LOCAL
 * store root (the repo-scoped memory root) because the gathered corpus is repo-scoped: team records
 * from this repo's `.crib`, this repo's local records, and the machine-global records. With no
 * local store there is no repo-scoped home — the factory degrades to the ephemeral `:memory:` mode
 * (rebuilt at first use, never persisted) rather than guessing a home.
 *
 * The returned index IS-A {@link MemoryFtsIndex}: the existing call surface
 * (`new FtsLexicalScorer(fts)` / `fts.search` / `fts.close`) is unchanged. Callers MUST `close()`
 * (releases the SQLite handle + the store write listeners).
 */
export function openMemoryFts(
  stores: RecallStores,
  opts: OpenMemoryFtsOptions = {},
): PersistentMemoryFts {
  const indexDir = opts.dir ?? (stores.local ? join(stores.local.rootDir, 'fts') : undefined);
  if (indexDir === undefined) {
    // No repo-scoped home — degrade to the ephemeral mode (rebuilt at first use, nothing persisted).
    return new PersistentMemoryFts({ stores, dbPath: ':memory:' });
  }
  return new PersistentMemoryFts({
    stores,
    dbPath: join(indexDir, 'memory-fts.sqlite'),
    metaPath: join(indexDir, 'fts-meta.json'),
    ...(opts.rebuild === true ? { forceRebuild: true } : {}),
  });
}

/**
 * The persistent memory FTS snapshot. Extends {@link MemoryFtsIndex} so the existing scorer + call
 * surface work unchanged; the subclass adds the lazy open-vs-rebuild decision, the store write
 * listener, and the generation meta.
 */
export class PersistentMemoryFts extends MemoryFtsIndex {
  private readonly stores: RecallStores;
  private readonly metaPath: string | undefined;
  private readonly forceRebuild: boolean;
  private healedOnOpen = false;
  private listenersInstalled = false;

  /**
   * Construct via {@link openMemoryFts} — the factory resolves the snapshot home and the ephemeral
   * fallback. The constructor is public only so the factory (same module) can build both modes.
   */
  constructor(config: {
    stores: RecallStores;
    dbPath: string;
    metaPath?: string;
    forceRebuild?: boolean;
  }) {
    super(config.dbPath);
    this.stores = config.stores;
    this.metaPath = config.metaPath;
    this.forceRebuild = config.forceRebuild === true;
  }

  /** Absolute path of the on-disk FTS snapshot, or `:memory:` in the ephemeral fallback. */
  get indexFilePath(): string {
    return this.dbPath;
  }

  /** The meta header path, or `undefined` in the ephemeral fallback (test + doctor observability). */
  get metaFilePath(): string | undefined {
    return this.metaPath;
  }

  /** How many full rebuilds this instance performed — the self-heal counter (doctor observability). */
  private rebuildCount = 0;
  get rebuildCountForTest(): number {
    return this.rebuildCount;
  }

  /**
   * Open-recovery: a corrupt snapshot file must not fail the query — delete it, retry the open,
   * and mark {@link healedOnOpen} so {@link onFirstUse} rebuilds (the reopened file is fresh +
   * EMPTY; serving it would silently answer every query with nothing). One attempt per handle
   * lifetime: a second failure is a real IO problem, not a healable snapshot.
   */
  protected override recoverFromOpenFailure(err: unknown): boolean {
    if (this.metaPath === undefined) return false; // :memory: — nothing on disk to heal
    if (this.healedOnOpen) return false;
    this.healedOnOpen = true;
    removeIndexFiles(this.dbPath);
    return true;
  }

  protected override openDatabase(): DatabaseSync {
    if (this.metaPath !== undefined) {
      // The snapshot dir is created lazily with the first open (mkdir -p is idempotent); the meta
      // header's atomic write would mkdir too, but the DB opens first.
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    return super.openDatabase();
  }

  /**
   * The open decision (run once per handle lifetime): serve the snapshot when the meta header
   * matches the live store generations; otherwise rebuild from the shards — the shards are truth.
   */
  protected override onFirstUse(): void {
    if (!this.forceRebuild && !this.healedOnOpen && this.snapshotUsable()) {
      this.installListeners();
      return;
    }
    this.rebuildFromStores();
    this.installListeners();
  }

  /** Release the SQLite handle + unsubscribe the store write listeners. */
  override close(): void {
    if (this.listenersInstalled) {
      this.listenersInstalled = false;
      for (const role of ROLES) this.stores[role]?.setFtsWriteListener(undefined);
    }
    super.close();
  }

  // ─── snapshot validation ───────────────────────────────────────────────────

  /**
   * True when the meta header describes EXACTLY the current context: same format version, same
   * store set, same roots, same generations + nonces. Any divergence rebuilds — a stale snapshot
   * that misses a record shifts BM25's IDF for every query, so "probably fresh" is never good
   * enough (the byte-comparable-ranking invariant).
   */
  private snapshotUsable(): boolean {
    if (this.metaPath === undefined) return false;
    if (!existsSync(this.metaPath)) return false;
    let meta: PersistentFtsMeta;
    try {
      meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as PersistentFtsMeta;
    } catch {
      return false; // torn/unparseable meta — rebuild (the header is disposable, the shards are truth)
    }
    if (meta.formatVersion !== MEMORY_FTS_FORMAT_VERSION) return false;
    const expected = this.expectedStoreMeta();
    const roles = new Set<MemoryStoreRole>(
      Object.keys(expected).concat(Object.keys(meta.stores)) as MemoryStoreRole[],
    );
    for (const role of roles) {
      const e = expected[role];
      const r = meta.stores[role];
      if (!e || !r) return false; // a store appeared or disappeared since the snapshot was written
      if (e.root !== r.root || e.gen !== r.gen || e.nonce !== r.nonce) return false;
    }
    return true;
  }

  /** The per-store binding the snapshot must match right now (absent stores contribute nothing). */
  private expectedStoreMeta(): Partial<Record<MemoryStoreRole, IndexStoreMeta>> {
    const out: Partial<Record<MemoryStoreRole, IndexStoreMeta>> = {};
    for (const role of ROLES) {
      const store = this.stores[role];
      if (!store) continue;
      out[role] = { root: store.rootDir, ...store.readFtsGeneration() };
    }
    return out;
  }

  // ─── self-heal ─────────────────────────────────────────────────────────────

  /**
   * Full rebuild from the shards: discard the (possibly corrupt) handle, delete the snapshot files,
   * reopen, rebuild over the gathered corpus, and record the current generations. The same
   * fail-safe pattern as crib serve's stale-index heal: a failed/absent snapshot never blocks a
   * query — it costs one rebuild and then the fast path resumes.
   */
  private rebuildFromStores(): void {
    this.discardHandle();
    if (this.metaPath !== undefined) removeIndexFiles(this.dbPath);
    this.reopenWithoutFirstUse();
    const gathered = gatherRecall(this.stores);
    this.rebuild(gathered.records.map((r) => r.record));
    this.writeMeta();
    this.rebuildCount += 1;
    this.healedOnOpen = false;
  }

  /** Persist the meta header (atomic temp→rename). Failure is fail-open: meta lags → next open rebuilds. */
  private writeMeta(stores?: Partial<Record<MemoryStoreRole, IndexStoreMeta>>): void {
    if (this.metaPath === undefined) return;
    try {
      const body: PersistentFtsMeta = {
        formatVersion: MEMORY_FTS_FORMAT_VERSION,
        stores: stores ?? this.expectedStoreMeta(),
      };
      writeJsonAtomic(this.metaPath, `${JSON.stringify(body, null, 2)}\n`);
    } catch {
      // The snapshot rows are already correct; only the header lags, and the header check
      // rebuilds rather than serves a stale snapshot. Never fatal to the query in flight.
    }
  }

  // ─── the store write listener (incremental catch-up) ───────────────────────

  /**
   * Subscribe to the record-collection write notices of every present store. One listener per
   * store instance: a second concurrently-open snapshot on the SAME stores takes over the hook and
   * the first simply rebuilds on its next open (generation check) — never silently stale rows.
   */
  private installListeners(): void {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    for (const role of ROLES) {
      const store = this.stores[role];
      if (!store) continue;
      store.setFtsWriteListener((notice) => this.onStoreWrite(notice));
    }
  }

  /**
   * Apply one store write to the snapshot INCREMENTALLY, inside the store's write lock (the store
   * notifies before releasing it, so concurrent notices are serialized per store). Any failure is
   * swallowed: the snapshot may lag, and the next open's generation check rebuilds — a derived
   * read model must never break the write it is shadowing.
   */
  private onStoreWrite(notice: MemoryFtsWriteNotice): void {
    try {
      if (notice.reset) {
        // The store root was cleared: the snapshot is meaningless. Drop the handle + files; the
        // next use lazily rebuilds (the store's generation nonce changed, so even a cross-process
        // reader converges on the same verdict).
        this.discardHandle();
        if (this.metaPath !== undefined) removeIndexFiles(this.dbPath);
        return;
      }
      const upserts = notice.upserted.filter(isRecordEntry);
      if (upserts.length > 0) this.upsert(upserts);
      if (notice.removed.length > 0) this.remove(notice.removed);
      const store = this.stores[notice.role];
      if (!store) return; // the notice's store left the context — the next open reconciles the set
      const meta = this.readMeta() ?? { formatVersion: MEMORY_FTS_FORMAT_VERSION, stores: {} };
      meta.stores[notice.role] = {
        root: store.rootDir,
        gen: notice.generation.gen,
        nonce: notice.generation.nonce,
      };
      this.writeMeta(meta.stores);
    } catch {
      // Fail-open: rows or meta may lag the store. The next open sees a generation mismatch and
      // self-heals — the index never lies loudly, it just rebuilds.
    }
  }

  private readMeta(): PersistentFtsMeta | undefined {
    if (this.metaPath === undefined || !existsSync(this.metaPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.metaPath, 'utf8')) as PersistentFtsMeta;
    } catch {
      return undefined;
    }
  }
}

/** A gathered/notice entry that is an actual memory record (either schema version, shared `mem:` id prefix). */
function isRecordEntry(e: MemoryEntry): e is MemoryRecord | MemoryRecordV2 {
  return typeof e.id === 'string' && e.id.startsWith('mem:');
}

/**
 * Open the persistent vector store beside the FTS snapshot, under the local store's index home.
 *
 * Same home resolution as {@link openMemoryFts} on purpose: both are derived read models of the same
 * ledger, both are gitignored, and both can be deleted at any time. Returns an EPHEMERAL store when
 * there is no repo-scoped home, so a store-less caller still works — it just re-embeds.
 */
export function openMemoryVectors(
  stores: RecallStores,
  opts: { embedderId: string; dim: number; textVersion: string; dir?: string },
): MemoryVectorStore {
  const indexDir = opts.dir ?? (stores.local ? join(stores.local.rootDir, 'vectors') : undefined);
  return new MemoryVectorStore({
    dbPath: indexDir ? join(indexDir, 'memory-vectors.sqlite') : ':memory:',
    embedderId: opts.embedderId,
    textVersion: opts.textVersion,
    dim: opts.dim,
  });
}
