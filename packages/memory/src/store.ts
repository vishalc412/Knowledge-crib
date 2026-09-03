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
 *                  active,feedback,receipts,decisions}` + `manifest.json`. Own lock at `<root>/.lock`.
 *                  `decisions` holds tombstone events (W5 Slice 2): when a local active record's content
 *                  becomes team-trusted, the local copy is removed + a `supersede` decision records why.
 *                  These local decisions are AUDIT-ONLY — recall deliberately does NOT gather them (a
 *                  local tombstone must not poison the same-id team record; see {@link tombstone}).
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
import {
  type MigrationProvenanceOverrides,
  type RecordMigration,
  migrateRecordV1ToV2,
  migrationProvenance,
} from './migrations.js';
import { globalStoreRoot, localStoreRoot, teamStoreRoot } from './paths.js';
import { assertNoMemorySecrets } from './secrets.js';
import { serializeMemoryShard } from './serialization.js';
import type {
  MemoryAlias,
  MemoryCounts,
  MemoryEntry,
  MemoryManifest,
  MemoryRecord,
  MemoryStoreRole,
} from './types.js';
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
  'decisions',
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

/** A `mem:` entry still on the memory-1 envelope (the migration's input; schemaVersion is the
 *  discriminator because both versions share the `mem:` prefix). */
function isV1RecordEntry(e: MemoryEntry): e is MemoryRecord {
  return (
    typeof e.id === 'string' && e.id.startsWith('mem:') && (e as MemoryRecord).schemaVersion === '1'
  );
}

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

/** Options for {@link MemoryStore.migrateToV2} (G1.2): provenance overrides for the derived
 *  memory-2 envelope, and nothing else — the rewrite is otherwise fully deterministic. */
export interface StoreMigrationOpts {
  provenance?: MigrationProvenanceOverrides;
}

/** What {@link MemoryStore.migrateToV2} did: the v2 ids written, the alias ids persisted, how many
 *  v1 records were skipped (their v2 twin already existed — first writer wins), and how many v1
 *  lines were RETAINED untouched (team's append-only ledger: alias only, no rewrite). */
export interface StoreMigrationResult {
  migrated: string[];
  aliases: string[];
  skipped: number;
  retained: number;
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

  // ─── the legacy-ID alias map (G1.2 migration) ────────────────────────────────

  /**
   * `<rootDir>/aliases` — the persisted legacy-ID alias map, sharded by `memoryShard(legacyId)` like
   * every other collection. Lives OUTSIDE the validated collections because an alias is migration
   * metadata, not a memory claim; its lines still validate through the `alias:` id-prefix dispatch
   * and serialize canonically (byte-stable). Under `.crib/memory/team/aliases/` the W0 strict merge
   * driver unions alias lines by id, so concurrent team migrations converge.
   */
  aliasesDir(): string {
    return join(this.init.rootDir, 'aliases');
  }

  /** `<rootDir>/aliases/<shard>.jsonl` path for the shard a legacy id aliases in. */
  aliasShardPath(legacyId: string): string {
    return join(this.aliasesDir(), `${memoryShard(legacyId)}.jsonl`);
  }

  /**
   * Read every persisted alias. Fail closed: an unreadable or misplaced line throws (an alias map
   * that silently dropped a binding would mis-rank every migrated record keyed on it).
   */
  readAliases(): MemoryAlias[] {
    return this.parseAliasShards(this.aliasShardFiles());
  }

  /** Read the alias binding `legacyId`, or `undefined` when it has none. */
  readAlias(legacyId: string): MemoryAlias | undefined {
    const path = this.aliasShardPath(legacyId);
    if (!existsSync(path)) return undefined;
    const parsed = this.parseAliasShards([path]);
    let found: MemoryAlias | undefined;
    for (const alias of parsed) {
      if (alias.legacyId !== legacyId) continue;
      if (found !== undefined && found.resolvedId !== alias.resolvedId) {
        throw new Error(
          `conflicting legacy-ID aliases for ${legacyId}: ${found.resolvedId} vs ${alias.resolvedId}`,
        );
      }
      found = alias;
    }
    return found;
  }

  /** Resolve `id` through the alias map: the v2 id when a legacy alias binds it, else `id`. */
  resolveId(id: string): string {
    return this.readAlias(id)?.resolvedId ?? id;
  }

  /**
   * The transparent alias-following lookup (G1.2): find the entry whose id is `id`; when no entry
   * carries that id, follow its alias and return the migrated record that now owns the claim. A
   * direct hit ALWAYS wins over the alias (the team store retains its v1 lines — they are real,
   * valid records, not stale addresses). Lock-free read (atomic writes make it safe).
   */
  findEntry(collection: MemoryCollection, id: string): MemoryEntry | undefined {
    const direct = this.entryInShard(collection, id);
    if (direct) return direct;
    const resolved = this.readAlias(id)?.resolvedId;
    if (resolved === undefined || resolved === id) return undefined;
    return this.entryInShard(collection, resolved);
  }

  /**
   * Upsert aliases into the map (locked + atomic + validated + secret-scanned — the same write gate
   * as the collections). Alias ids are content-addressed over `{ legacyId, resolvedId }`, so a
   * re-migration upserts byte-identical lines (idempotent).
   */
  upsertAliases(aliases: readonly MemoryAlias[]): void {
    for (const alias of aliases) {
      assertValidMemoryEntry(alias as unknown as { id: string } & Record<string, unknown>);
      assertNoMemorySecrets(alias);
    }
    this.withLock(() => {
      const byShard = new Map<string, MemoryAlias[]>();
      for (const alias of aliases) {
        const shard = memoryShard(alias.legacyId);
        const bucket = byShard.get(shard);
        if (bucket) bucket.push(alias);
        else byShard.set(shard, [alias]);
      }
      for (const [shard, incoming] of byShard) {
        const merged = new Map<string, MemoryAlias>();
        for (const e of this.parseAliasShards([this.aliasShardForShard(shard)]))
          merged.set(e.id, e);
        for (const e of incoming) merged.set(e.id, e); // replace by id
        writeJsonAtomic(this.aliasShardForShard(shard), serializeMemoryShard([...merged.values()]));
      }
    });
  }

  // ─── the v1→v2 rewrite pass (G1.2) ────────────────────────────────────────────

  /**
   * Run the explicit memory-1 → memory-2 rewrite over this store's record collections
   * (`local.active` / `global.records` / `team.records`): read v1, write v2, persist the
   * legacy-ID alias for every migrated record. Idempotent — a re-run finds no v1 records (or
   * already-present v2 twins) and writes nothing.
   *
   * Per role:
   *   - **local / global** — the v1 line is REPLACED by its re-seeded v2 twin. The claim travels
   *     in the twin; the placement, reattachment targets, `meta`, and stamped verdicts the closed
   *     v2 envelope has no counterpart for travel in the ALIAS binding (migrations.ts), so the
   *     as-believed v1 state stays recoverable after the replacement, and `findEntry` resolves
   *     the old address through the alias.
   *   - **team** — the committed ledger is append-only, and its v1 lines stay LIVE in recall;
   *     writing a v2 twin beside the original would double-list the same claim once the alias
   *     restores the twin's verdicts. Team migration therefore records the id binding ONLY.
   *
   * Never destructive: v1 lines remain loadable everywhere they are retained, and the pass refuses
   * to touch a collection with unreadable lines. Runs under one lock hold (re-entrant with the
   * per-shard writes).
   */
  migrateToV2(opts: StoreMigrationOpts = {}): StoreMigrationResult {
    const result: StoreMigrationResult = { migrated: [], aliases: [], skipped: 0, retained: 0 };
    this.withLock(() => {
      const aliases: MemoryAlias[] = [];
      for (const collection of this.recordCollections()) {
        this.migrateCollectionToV2(collection, opts.provenance, aliases, result);
      }
      if (aliases.length > 0) {
        this.upsertAliases(aliases); // same-store re-entrant lock
        result.aliases.push(...aliases.map((a) => a.id));
      }
      if (result.migrated.length > 0 && this.hasManifest) {
        this.persistManifest(); // counts may have moved between shards; 1:1 replacement keeps them equal
      }
    });
    return result;
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  /** The record collections this store role holds (the collections the migration walks). */
  private recordCollections(): readonly MemoryCollection[] {
    return this.init.role === 'local' ? ['active'] : ['records'];
  }

  /** Find an entry by id inside its single shard (a direct hit; no alias chase). */
  private entryInShard(collection: MemoryCollection, id: string): MemoryEntry | undefined {
    return this.readShard(collection, memoryShard(id)).entries.find((e) => e.id === id);
  }

  /** The existing alias-shard file names (`NN.jsonl`), sorted; empty when the map is absent. */
  private aliasShardFiles(): string[] {
    const dir = this.aliasesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .sort()
      .filter((f) => SHARD_FILE_RE.test(f))
      .map((f) => join(dir, f));
  }

  /** `<rootDir>/aliases/<shard>.jsonl` path for an explicit shard id. */
  private aliasShardForShard(shard: string): string {
    return join(this.aliasesDir(), `${shard}.jsonl`);
  }

  /** Parse alias lines from shard files. Throws on any unreadable or non-alias line (fail closed). */
  private parseAliasShards(paths: readonly string[]): MemoryAlias[] {
    const out: MemoryAlias[] = [];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const parsed = parseMemoryShard(readFileSync(path, 'utf8'), path);
      if (parsed.errors.length > 0) {
        throw new Error(`corrupt alias map: ${parsed.errors[0]}`);
      }
      for (const entry of parsed.entries) {
        if (typeof entry.id !== 'string' || !entry.id.startsWith('alias:')) {
          throw new Error(`corrupt alias map: non-alias entry ${String(entry.id)} in ${path}`);
        }
        out.push(entry as unknown as MemoryAlias);
      }
    }
    return out;
  }

  /**
   * Migrate one record collection in place. Mutates `result` (the running tally) and appends the
   * collection's aliases to `aliases` for the caller to persist. Local/global REPLACE each v1 line
   * with its v2 twin; team records the binding only (see {@link migrateToV2}).
   */
  private migrateCollectionToV2(
    collection: MemoryCollection,
    provenance: MigrationProvenanceOverrides | undefined,
    aliases: MemoryAlias[],
    result: StoreMigrationResult,
  ): void {
    const read = this.readCollection(collection);
    if (read.errors.length > 0) {
      throw new Error(
        `refusing to migrate ${this.init.role}/${collection}: unreadable lines (${read.errors[0]})`,
      );
    }
    const entries = read.entries;
    const ids = new Set(entries.map((e) => e.id));
    const next = new Map<string, MemoryEntry>();
    for (const entry of entries) next.set(entry.id, entry);
    let changed = false;
    for (const entry of entries) {
      if (!isV1RecordEntry(entry)) continue;
      const migration = this.migrateEntryToV2(entry, provenance);
      aliases.push(migration.alias);
      if (this.init.role === 'team') {
        result.retained += 1; // append-only ledger: never rewrite or remove a committed line
        continue;
      }
      if (ids.has(migration.record.id) && migration.record.id !== entry.id) {
        // The v2 twin already exists (a prior pass or an independent write): first writer wins, the
        // v1 line is still retired (the twin owns the claim) but the twin is never overwritten.
        result.skipped += 1;
        next.delete(entry.id);
        changed = true;
        continue;
      }
      ids.add(migration.record.id);
      result.migrated.push(migration.record.id);
      next.delete(entry.id);
      next.set(migration.record.id, migration.record);
      changed = true;
    }
    if (changed) this.rewriteCollectionShards(collection, next, entries);
  }

  /** Migrate one v1 record entry (validate the twin before anything is written). */
  private migrateEntryToV2(
    entry: MemoryEntry,
    provenance: MigrationProvenanceOverrides | undefined,
  ): RecordMigration {
    const v1 = entry as unknown as MemoryRecord;
    const resolved = migrationProvenance(v1.authorship, provenance ?? {}, this.init.env);
    const migration = migrateRecordV1ToV2(v1, resolved);
    // The write gate (invariant #4): a twin that fails validation or carries a secret aborts the
    // whole pass before ANY shard is rewritten — never a partial migration.
    assertValidMemoryEntry(migration.record as unknown as { id: string } & Record<string, unknown>);
    assertNoMemorySecrets(migration.record);
    return migration;
  }

  /**
   * Rewrite a collection's shards from `next` (the full post-migration entry set). The v2 twin's
   * shard is `memoryShard(v2 id)`, which can differ from the v1 line's shard, so the rewrite
   * regroups every entry by its shard and rewrites each file atomically; a shard the migration
   * emptied is rewritten empty (mirroring `removeEntry`).
   */
  private rewriteCollectionShards(
    collection: MemoryCollection,
    next: ReadonlyMap<string, MemoryEntry>,
    before: readonly MemoryEntry[],
  ): void {
    const byShard = new Map<string, MemoryEntry[]>();
    for (const entry of next.values()) {
      const shard = memoryShard(entry.id);
      const bucket = byShard.get(shard);
      if (bucket) bucket.push(entry);
      else byShard.set(shard, [entry]);
    }
    // Shards that existed before but hold nothing after must still be rewritten (emptied).
    for (const entry of before) {
      const shard = memoryShard(entry.id);
      if (!byShard.has(shard)) byShard.set(shard, []);
    }
    for (const [shard, list] of byShard) {
      for (const entry of list) this.assertWritable(entry);
      writeJsonAtomic(this.shardPath(collection, shard), serializeMemoryShard(list));
    }
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

  /**
   * Remove a single entry by id (locked + atomic). Used by promotion cleanup: a candidate is removed
   * from `candidates` AFTER its record + receipt have been durably written to `active`/`receipts`, so
   * a crash between the shared write and the cleanup leaves a candidate that the next run's
   * idempotent promotion re-deduplicates + re-cleans (PRD W4: "the next run deduplicates and
   * completes cleanup"). Returns true iff an entry was removed. Refuses the team store (the
   * committed ledger is never mutated by a remove — `clearStore` is the only team path and it too
   * refuses; lifecycle retirement is an append-only decision, never a delete).
   */
  removeEntry(collection: MemoryCollection, id: string): boolean {
    this.assertCollection(collection);
    if (this.init.role === 'team') {
      throw new Error(
        'refusing to remove from the team store: .crib/memory/team is append-only (PRD — retire via a decision event, never a delete)',
      );
    }
    return this.withLock(() => {
      const shard = memoryShard(id);
      const existing = this.readShard(collection, shard).entries;
      const next = existing.filter((e) => e.id !== id);
      if (next.length === existing.length) return false; // not present — nothing to clean
      writeJsonAtomic(this.shardPath(collection, shard), serializeMemoryShard(next));
      return true;
    });
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
