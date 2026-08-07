import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
/**
 * The three memory stores (PRD §2 storage layout + W2 Slice 2): team, local, global.
 *
 *   - **team**   — committed + team-shared, `<cribDir>/memory/team/{records,decisions,receipts}`.
 *                  No manifest (counts derive from shards; the committed `policy.json` lives one level
 *                  up at `<cribDir>/memory/policy.json` — see {@link policyPath}). Writes serialize on
 *                  the repo's `.crib/.lock` — the SAME lock the soul reindex holds — so a team memory
 *                  write never races a reindex (PRD: "repo writes serialized via `.crib/.lock`").
 *   - **local**  — per-machine, per-repo, `~/.crib/memory/repos/<repoId>/{attempts,candidates,
 *                  active,feedback,receipts}` + `manifest.json`. Own lock at `<root>/.lock`.
 *   - **global** — per-machine, cross-repo, `~/.crib/memory/global/{records,decisions,feedback}` +
 *                  `manifest.json`. Own lock at `<root>/.lock`.
 *
 * Invariants (enforced here):
 *   1. **atomic writes** — every mutation is temp→rename via {@link writeJsonAtomic}; a crash leaves
 *      the prior valid snapshot + an orphan `.tmp` (never read). Readers see old-or-new, never torn.
 *   2. **single-writer per store** — every mutation runs under the store's `CribLock` (10-min stale
 *      reclaim, reused from `core`). Reads do NOT lock (atomic writes make concurrent reads safe).
 *   3. **no cross-store lock nesting** — {@link withMemoryLock} throws `MemoryLockNestingError` if a
 *      second, *different* store's lock is acquired while one is held (PRD: "NEVER acquire repo+global
 *      locks simultaneously"). Same-store re-entrancy (e.g. `persistManifest` inside `withLock`) is
 *      allowed; the outer `withLock` owns the single acquire/release.
 *   4. **validate + secret-scan on write** — `writeShard`/`upsertEntries` run `assertValidMemoryEntry`
 *      + `assertNoMemorySecrets` on every entry BEFORE serializing; a bad entry aborts the whole write
 *      (no partial shard). "A secret anywhere is a hard reject" + "malformed never silently skipped".
 *   5. **team is never bulk-deleted** — `clearStore()` refuses team (the committed ledger; PRD:
 *      "reindex/graph migration never delete `.crib/memory/team`"). The store exposes no other
 *      team-delete path. (The soul's `resetForRebuild` only dirties node/edge shards — it never
 *      touches `.crib/memory` — so reindex is already safe; this guard is the belt-and-suspenders.)
 */
import { CribLock, type CribLockOptions, LockBusyError } from '@knowledge-crib/core';
import { writeJsonAtomic } from './atomic.js';
import { memoryShard } from './ids.js';
import { loadMemoryManifestJson, parseMemoryShard } from './loader.js';
import { newMemoryManifest } from './manifest.js';
import { globalStoreRoot, localStoreRoot, teamStoreRoot } from './paths.js';
import { assertNoMemorySecrets } from './secrets.js';
import { serializeMemoryShard } from './serialization.js';
import type { MemoryCounts, MemoryEntry, MemoryManifest, MemoryStoreRole } from './types.js';
import { assertValidMemoryEntry } from './validate.js';

/** The on-disk collection directories a store may hold. */
export type MemoryCollection =
  | 'records'
  | 'decisions'
  | 'receipts'
  | 'attempts'
  | 'candidates'
  | 'active'
  | 'feedback';

const TEAM_COLLECTIONS: readonly MemoryCollection[] = ['records', 'decisions', 'receipts'];
const LOCAL_COLLECTIONS: readonly MemoryCollection[] = [
  'attempts',
  'candidates',
  'active',
  'feedback',
  'receipts',
];
const GLOBAL_COLLECTIONS: readonly MemoryCollection[] = ['records', 'decisions', 'feedback'];

/** `active` local records count under `records` (the local equivalent of team/global's records bucket). */
function collectionCountKey(c: MemoryCollection): keyof MemoryCounts {
  switch (c) {
    case 'records':
    case 'active':
      return 'records';
    case 'candidates':
      return 'candidates';
    case 'attempts':
      return 'attempts';
    case 'receipts':
      return 'receipts';
    case 'decisions':
      return 'decisions';
    case 'feedback':
      return 'feedback';
  }
}

const SHARD_FILE_RE = /^[0-9a-f]{2}\.jsonl$/;
const LOCK_NAME = '.lock';

/**
 * Thrown when a second, *different* memory store's lock would be acquired while one is already held
 * by this process — the PRD's "NEVER acquire repo+global locks simultaneously" rule. Same-store
 * re-entrancy is allowed; only cross-store nesting is forbidden.
 */
export class MemoryLockNestingError extends Error {
  constructor(
    readonly heldPath: string,
    readonly requestedPath: string,
  ) {
    super(
      `refusing to nest memory locks: ${requestedPath} requested while ${heldPath} is held (PRD: never acquire repo+global locks simultaneously)`,
    );
    this.name = 'MemoryLockNestingError';
  }
}

// ─── process-global no-cross-store-nesting guard ──────────────────────────────
// Tracks the ONE memory lock held by this process so withMemoryLock can allow same-store
// re-entrancy but forbid acquiring a different store's lock mid-operation. The soul reindex's lock
// (acquired via raw CribLock in core, not here) is NOT tracked — it composes by mutual exclusion on
// the lock file itself (a team write whose .crib/.lock is held by a reindex gets LockBusyError).
let heldLockPath: string | undefined;
let heldDepth = 0;
let heldLock: CribLock | undefined;

/**
 * Run `fn` while holding the memory lock at `lockPath`. Re-entrant for the SAME path (the outer call
 * owns acquire/release); throws `MemoryLockNestingError` if a DIFFERENT path is requested while held.
 */
function withMemoryLock<T>(lockPath: string, acquire: () => CribLock, fn: () => T): T {
  if (heldLockPath !== undefined && heldLockPath !== lockPath) {
    throw new MemoryLockNestingError(heldLockPath, lockPath);
  }
  const alreadyHeld = heldLockPath === lockPath;
  if (!alreadyHeld) {
    heldLock = acquire();
    heldLockPath = lockPath;
  }
  heldDepth++;
  try {
    return fn();
  } finally {
    heldDepth--;
    if (heldDepth === 0) {
      heldLock?.release();
      heldLock = undefined;
      heldLockPath = undefined;
    }
  }
}

/** Reset the process-global lock guard (test isolation: between tests no lock should remain held). */
export function __resetMemoryLockGuardForTest(): void {
  heldLock?.release();
  heldLock = undefined;
  heldLockPath = undefined;
  heldDepth = 0;
}

/** One parsed shard's read result (mirrors {@link parseMemoryShard}). */
export interface MemoryShardRead {
  entries: MemoryEntry[];
  errors: string[];
}

export interface StoreOpts {
  /** Env override (tests relocate `~/.crib/memory` via `KCRIB_MEMORY_DIR`). */
  env?: NodeJS.ProcessEnv;
  /** Fixed clock for deterministic manifest `lastUpdated` (tests). Defaults to wall clock. */
  now?: () => string;
  /**
   * Project root for the local manifest's `repo.root`. Defaults to `dirname(cribDir)` when the store
   * was opened from a crib dir. Informational only (the repoId is the load-bearing identity).
   */
  repoRoot?: string;
}

interface StoreInit {
  role: MemoryStoreRole;
  rootDir: string;
  lockDir: string;
  collections: readonly MemoryCollection[];
  repoId?: string;
  repoRoot?: string;
  env: NodeJS.ProcessEnv;
  now: () => string;
}

/**
 * A memory store. Construct via the {@link MemoryStore.team}/`.local`/`.global` factories — they
 * resolve the storage root + lock dir per the PRD layout. All mutation methods are locked +
 * atomic; reads are lock-free (safe under atomic writes).
 */
export class MemoryStore {
  private readonly init: StoreInit;
  private readonly lockPath: string;

  private constructor(init: StoreInit) {
    this.init = init;
    this.lockPath = join(init.lockDir, LOCK_NAME);
  }

  /** The committed team-shared store. Writes serialize on `<cribDir>/.lock` (shared with soul reindex). */
  static team(cribDir: string, opts: StoreOpts = {}): MemoryStore {
    return new MemoryStore({
      role: 'team',
      rootDir: teamStoreRoot(cribDir),
      lockDir: cribDir,
      collections: TEAM_COLLECTIONS,
      repoRoot: opts.repoRoot,
      env: opts.env ?? process.env,
      now: opts.now ?? (() => new Date().toISOString()),
    });
  }

  /** The per-machine, per-repo local store at `~/.crib/memory/repos/<repoId>`. */
  static local(repoId: string, opts: StoreOpts = {}): MemoryStore {
    return new MemoryStore({
      role: 'local',
      rootDir: localStoreRoot(repoId, opts.env ?? process.env),
      lockDir: localStoreRoot(repoId, opts.env ?? process.env),
      collections: LOCAL_COLLECTIONS,
      repoId,
      repoRoot: opts.repoRoot,
      env: opts.env ?? process.env,
      now: opts.now ?? (() => new Date().toISOString()),
    });
  }

  /** The per-machine, cross-repo global store at `~/.crib/memory/global`. */
  static global(opts: StoreOpts = {}): MemoryStore {
    return new MemoryStore({
      role: 'global',
      rootDir: globalStoreRoot(opts.env ?? process.env),
      lockDir: globalStoreRoot(opts.env ?? process.env),
      collections: GLOBAL_COLLECTIONS,
      env: opts.env ?? process.env,
      now: opts.now ?? (() => new Date().toISOString()),
    });
  }

  get role(): MemoryStoreRole {
    return this.init.role;
  }

  get rootDir(): string {
    return this.init.rootDir;
  }

  /** Absolute lock file path (`<lockDir>/.lock`). */
  get lockFilePath(): string {
    return this.lockPath;
  }

  /** The collections this store role may hold. */
  get collections(): readonly MemoryCollection[] {
    return this.init.collections;
  }

  /** True for local + global (team uses `policy.json`, not a manifest). */
  get hasManifest(): boolean {
    return this.init.role !== 'team';
  }

  /** Manifest path (`<rootDir>/manifest.json`), or `undefined` for the team store. */
  manifestPath(): string | undefined {
    return this.hasManifest ? join(this.init.rootDir, 'manifest.json') : undefined;
  }

  /** `<rootDir>/<collection>` directory. */
  collectionDir(collection: MemoryCollection): string {
    this.assertCollection(collection);
    return join(this.init.rootDir, collection);
  }

  /** `<rootDir>/<collection>/<shard>.jsonl` path. */
  shardPath(collection: MemoryCollection, shard: string): string {
    return join(this.collectionDir(collection), `${shard}.jsonl`);
  }

  // ─── reads (lock-free; atomic writes make concurrent reads safe) ───────────

  /** Read one shard. A missing shard is an empty read (not an error). */
  readShard(collection: MemoryCollection, shard: string): MemoryShardRead {
    const path = this.shardPath(collection, shard);
    if (!existsSync(path)) return { entries: [], errors: [] };
    const text = readFileSync(path, 'utf8');
    const rel = `${this.init.role}/${collection}/${shard}.jsonl`;
    const parsed = parseMemoryShard(text, rel);
    return { entries: parsed.entries as unknown as MemoryEntry[], errors: parsed.errors };
  }

  /** Read every shard of a collection, concatenating entries + collecting per-shard errors. */
  readCollection(collection: MemoryCollection): MemoryShardRead {
    const dir = this.collectionDir(collection);
    if (!existsSync(dir)) return { entries: [], errors: [] };
    const entries: MemoryEntry[] = [];
    const errors: string[] = [];
    for (const file of readdirSync(dir).sort()) {
      if (!SHARD_FILE_RE.test(file)) continue;
      const shard = file.slice(0, 2);
      const res = this.readShard(collection, shard);
      entries.push(...res.entries);
      errors.push(...res.errors);
    }
    return { entries, errors };
  }

  /** Read the manifest. `undefined` when absent (uninitialized store). Throws on a corrupt manifest. */
  readManifest(): MemoryManifest | undefined {
    if (!this.hasManifest) return undefined;
    const path = this.manifestPath();
    if (path === undefined || !existsSync(path)) return undefined;
    return loadMemoryManifestJson(JSON.parse(readFileSync(path, 'utf8')));
  }

  // ─── writes (locked + atomic + validated + secret-scanned) ─────────────────

  /**
   * Fully replace one shard with `entries` (id-sorted, canonical). Validates + secret-scans every
   * entry first; a single bad entry aborts the whole write — no partial shard is ever persisted.
   */
  writeShard(collection: MemoryCollection, shard: string, entries: MemoryEntry[]): void {
    this.assertCollection(collection);
    for (const entry of entries) this.assertWritable(entry);
    const text = serializeMemoryShard(entries);
    this.withLock(() => writeJsonAtomic(this.shardPath(collection, shard), text));
  }

  /**
   * Read-merge-write entries into a collection, grouping by shard. Existing entries with the same id
   * are REPLACED (content-addressed ids make a replace a no-op byte-wise when content is unchanged);
   * new ids are inserted. All affected shards are rewritten atomically under one lock hold.
   */
  upsertEntries(collection: MemoryCollection, entries: MemoryEntry[]): void {
    this.assertCollection(collection);
    for (const entry of entries) this.assertWritable(entry);
    this.withLock(() => {
      const byShard = new Map<string, MemoryEntry[]>();
      for (const entry of entries) {
        const shard = memoryShard(entry.id);
        const bucket = byShard.get(shard);
        if (bucket) bucket.push(entry);
        else byShard.set(shard, [entry]);
      }
      for (const [shard, incoming] of byShard) {
        const existing = this.readShard(collection, shard).entries;
        const merged = new Map<string, MemoryEntry>();
        for (const e of existing) merged.set(e.id, e);
        for (const e of incoming) merged.set(e.id, e); // replace by id
        writeJsonAtomic(
          this.shardPath(collection, shard),
          serializeMemoryShard([...merged.values()]),
        );
      }
    });
  }

  /** Upsert a single entry (convenience over {@link upsertEntries}). */
  upsertEntry(collection: MemoryCollection, entry: MemoryEntry): void {
    this.upsertEntries(collection, [entry]);
  }

  // ─── manifest (local + global; recomputable cache) ──────────────────────────

  /**
   * Return the manifest, creating + persisting a fresh one if it is absent. A *corrupt* manifest is
   * rebuilt (the manifest is a derived cache; the shards are the source of truth, so rebuilding it
   * never loses data). Throws on a corrupt manifest's parse error ONLY if rebuilding is impossible.
   */
  ensureManifest(): MemoryManifest {
    if (!this.hasManifest) {
      throw new Error(`${this.init.role} store has no manifest (team uses policy.json)`);
    }
    try {
      const existing = this.readManifest();
      if (existing) return existing;
    } catch {
      // corrupt manifest — rebuild from shards below (the shards are truth, not the manifest)
    }
    const fresh = this.freshManifest();
    this.writeManifestLocked(fresh);
    return fresh;
  }

  /** Overwrite the manifest with `manifest` (locked + atomic). Caller is responsible for correctness. */
  writeManifest(manifest: MemoryManifest): void {
    this.assertHasManifest();
    this.withLock(() => this.writeManifestLocked(manifest));
  }

  /** Recompute counts from the on-disk shards and persist a fresh manifest (locked). */
  persistManifest(): MemoryManifest {
    this.assertHasManifest();
    return this.withLock(() => {
      const counts = this.recomputeCounts();
      const fresh = this.freshManifest(counts);
      this.writeManifestLocked(fresh);
      return fresh;
    });
  }

  /** Scan every collection's shards and tally counts by {@link collectionCountKey}. Lock-free read. */
  recomputeCounts(): MemoryCounts {
    const counts: MemoryCounts = {
      records: 0,
      candidates: 0,
      attempts: 0,
      receipts: 0,
      decisions: 0,
      feedback: 0,
    };
    for (const collection of this.init.collections) {
      const { entries } = this.readCollection(collection);
      counts[collectionCountKey(collection)] += entries.length;
    }
    return counts;
  }

  // ─── reset (local + global ONLY; team is never bulk-deleted) ────────────────

  /**
   * Remove the entire store root (all collections + manifest). Refuses team — the committed ledger is
   * never bulk-deleted by the store (PRD: reindex/graph migration never delete `.crib/memory/team`).
   * Used by tests + a future `crib memory reset` for local/global only.
   */
  clearStore(): void {
    if (this.init.role === 'team') {
      throw new Error(
        'refusing to clear the team store: .crib/memory/team is the committed ledger and must never be bulk-deleted (PRD)',
      );
    }
    this.withLock(() => {
      if (existsSync(this.init.rootDir))
        rmSync(this.init.rootDir, { recursive: true, force: true });
    });
  }

  // ─── lock ───────────────────────────────────────────────────────────────────

  /**
   * Run `fn` while holding this store's lock. Re-entrant for the same store; throws
   * `MemoryLockNestingError` if a different store's lock is held. Exposed so a caller can batch
   * several mutations under one acquire (e.g. write a record + its decision atomically).
   */
  withLock<T>(fn: () => T): T {
    const opts: CribLockOptions = { cribDir: this.init.lockDir, lockName: LOCK_NAME };
    return withMemoryLock(
      this.lockPath,
      () => {
        const lock = new CribLock(opts);
        lock.acquire();
        return lock;
      },
      fn,
    );
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private assertCollection(collection: MemoryCollection): void {
    if (!this.init.collections.includes(collection)) {
      throw new Error(
        `collection '${collection}' is not held by the ${this.init.role} store (holds: ${this.init.collections.join(', ')})`,
      );
    }
  }

  private assertHasManifest(): void {
    if (!this.hasManifest) {
      throw new Error(`${this.init.role} store has no manifest (team uses policy.json)`);
    }
  }

  /** Validate against the memory-1 schema + secret-scan — the write gate (invariant #4). */
  private assertWritable(entry: MemoryEntry): void {
    assertValidMemoryEntry(entry as unknown as { id: string } & Record<string, unknown>);
    assertNoMemorySecrets(entry);
  }

  private freshManifest(counts?: MemoryCounts): MemoryManifest {
    if (this.init.role === 'global') {
      const m = newMemoryManifest({ store: 'global', now: this.init.now() });
      if (counts) m.counts = counts;
      return m;
    }
    // local (team never reaches here — it has no manifest)
    const repoId = this.init.repoId;
    if (!repoId) throw new Error('local store manifest requires a repoId');
    const m = newMemoryManifest({
      store: 'local',
      repoId,
      repoRoot: this.init.repoRoot,
      now: this.init.now(),
    });
    if (counts) m.counts = counts;
    return m;
  }

  private writeManifestLocked(manifest: MemoryManifest): void {
    const path = this.manifestPath();
    if (path === undefined) return; // team — no manifest
    writeJsonAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export { LockBusyError };
