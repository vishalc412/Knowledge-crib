/**
 * ADR-003 (Gate 4) D5 — the derive-and-diff sweep. The bootstrap, the steady-state push heal, and
 * the repair path after a lost/corrupt log are ONE routine: walk the syncable collections (D1/D2:
 * records — local ⇒ `active`, global ⇒ `records`, mirroring recall's record sources — plus
 * `decisions` as `decision.append` and `feedback` as `feedback.append`, because a tombstone or a
 * conflict resolution is a DECISION event: without walking it, deletes never sync across devices),
 * derive each entry's `evt:` id, and enqueue only events not already pending-or-acked. Membership
 * is tested by ID DERIVATION, never by timestamp: the same content re-derives the same id
 * everywhere, so the sweep is order-independent and idempotent (a re-run is a no-op).
 *
 * Backfill is NOT implied by membership alone: `init-sync` seeds the state with "all current
 * entries acked" so only post-init changes sync, and full backfill is an explicit `--backfill`
 * flag (D5) — the sweep must therefore run against the seeded state, and the seeding caller marks
 * the pre-existing ids acked (via {@link markEventAcked} after staging, or by directly seeding
 * `ackedEvents` through saveSyncState). Never timestamped snapshots.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryStore } from '../store.js';
import type {
  MemoryDecision,
  MemoryEntry,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordV2,
  MemoryStoreRole,
} from '../types.js';
import { type SyncEventKind, type SyncStoreScope, deriveEventId } from './event.js';
import {
  SYNC_STATE_FILE,
  type SyncState,
  defaultSyncState,
  loadSyncState,
  readStagedEventIds,
  saveSyncState,
} from './queue.js';

/** One walked entry: the entry plus its derived (not yet queued) event coordinates. */
export interface WalkedSyncableEntry {
  entry: MemoryEntry;
  /** the `evt:` id the entry derives (kind per the collection it was walked from). */
  eventId: string;
  kind: SyncEventKind;
  store: SyncStoreScope;
  repoId?: string;
}

/** What the sweep found: the entries needing an event (derived ids), and any shard-read errors. */
export interface SyncableWalk {
  entries: WalkedSyncableEntry[];
  /** `source: reason` for unreadable shard lines (the caller reports; never a silent skip). */
  errors: string[];
}

/** Sweep options: `backfill` (D5) tests membership against the PENDING set only, so entries the
 *  init baseline marked acked are staged too (an explicit full re-stage, never implied). `repoId`
 *  overrides the local-scope derivation id (the sync config's stable `syncRepoId` — the manifest's
 *  `repo.id` is a per-checkout random UUID that two real clones cannot share). */
export interface WalkSyncableOpts {
  backfill?: boolean;
  repoId?: string;
}

/** The backfill source collection per store role (D2). Refuses team — the team store is NOT a sync
 *  participant (git IS its backend, D2). */
function syncSourceCollection(role: MemoryStoreRole): 'active' | 'records' {
  if (role === 'team') {
    throw new Error(
      'the team store is not a sync participant (git is its backend, D2) — sync local + global only',
    );
  }
  return role === 'local' ? 'active' : 'records';
}

/**
 * Walk the syncable collections and return only the entries whose derived `evt:` id is NOT already
 * pending-or-acked in the sidecar queue/state — the derive-and-diff reconciliation sweep (D4/D5).
 * Records come from the D2 source collection (`decision.append`/`feedback.append` come from the
 * `decisions`/`feedback` collections — D9: a tombstone IS a decision, and a delete that never syncs
 * resurrects on every other device). With `{backfill: true}` the membership set is the PENDING ids
 * only, so a store the baseline seeded "all current entries acked" re-stages its full history (the
 * explicit D5 flag). PURE over the store's lock-free reads + the sidecar files.
 */
export function walkSyncableEntries(store: MemoryStore, opts: WalkSyncableOpts = {}): SyncableWalk {
  const collection = syncSourceCollection(store.role);
  const read = store.readCollection(collection);
  const scope: SyncStoreScope = store.role === 'local' ? 'local' : 'global';
  const repoId = scope === 'local' ? (opts.repoId ?? store.readManifest()?.repo?.id) : undefined;
  const pending = new Set<string>(readStagedEventIds(store.rootDir).ids);
  const membership = opts.backfill
    ? pending
    : new Set<string>([...pending, ...(loadSyncState(store.rootDir)?.ackedEvents ?? [])]);
  const entries: WalkedSyncableEntry[] = [];
  for (const entry of read.entries) {
    if (!entry.id.startsWith('mem:')) {
      read.errors.push(
        `${scope}.${collection}: non-record entry ${String(entry?.id)} in the sync source`,
      );
      continue;
    }
    const record = entry as MemoryRecord | MemoryRecordV2;
    const eventId = deriveEventId('record.upsert', scope, repoId, record);
    if (membership.has(eventId)) continue;
    entries.push({
      entry: record,
      eventId,
      kind: 'record.upsert',
      store: scope,
      ...(repoId !== undefined ? { repoId } : {}),
    });
  }
  // D1 — decisions and feedback are first-class syncable events. A pulled tombstone suppresses the
  // local copy (D9) and an appended resolution converges only if these collections are walked; the
  // admission matrix (D10) admits any non-`mem:` payload, so no extra gate is needed here.
  const appendCollections: { collection: 'decisions' | 'feedback'; kind: SyncEventKind }[] = [
    { collection: 'decisions', kind: 'decision.append' },
    { collection: 'feedback', kind: 'feedback.append' },
  ];
  for (const { collection: c, kind } of appendCollections) {
    if (!store.collections.includes(c)) continue;
    for (const entry of store.readCollection(c).entries as (MemoryDecision | MemoryFeedback)[]) {
      const prefix = entry.id.startsWith('dec:')
        ? 'dec'
        : entry.id.startsWith('fb:')
          ? 'fb'
          : undefined;
      if (prefix === undefined) {
        read.errors.push(`${scope}.${c}: unexpected entry ${String(entry?.id)} in ${c}`);
        continue;
      }
      const eventId = deriveEventId(kind, scope, repoId, entry);
      if (membership.has(eventId)) continue;
      entries.push({
        entry,
        eventId,
        kind,
        store: scope,
        ...(repoId !== undefined ? { repoId } : {}),
      });
    }
  }
  return { entries, errors: read.errors };
}

/** The result of {@link seedSyncBaseline}: whether a fresh state was written, plus the state. */
export interface SeedBaselineResult {
  created: boolean;
  state: SyncState;
}

/**
 * Seed the sidecar sync-state for a store (D5, `init-sync`): a fresh {@link defaultSyncState} whose
 * `ackedEvents` are the derived `evt:` ids of every LIVE syncable entry — "all current entries
 * acked", so only post-init changes sync. With `backfill: true` the baseline acks NOTHING, so the
 * next push's sweep stages the full history (the explicit D5 flag). Idempotent: when the state
 * already exists it is returned UNCHANGED (re-init never clobbers cursors or the ack ledger — the
 * repair paths are the sweep itself, never a re-seed). PURE over the store's lock-free reads.
 */
export function seedSyncBaseline(
  store: MemoryStore,
  opts: { deviceId: string; backfill?: boolean; repoId?: string },
): SeedBaselineResult {
  if (store.role === 'team') {
    throw new Error(
      'the team store is not a sync participant (git is its backend, D2) — seed local + global only',
    );
  }
  const existing = loadSyncState(store.rootDir);
  if (existing !== undefined) return { created: false, state: existing };
  const state = defaultSyncState(opts.deviceId);
  if (!opts.backfill) {
    // Derive WITHOUT staging: the baseline is bookkeeping only — the sweep on a later push
    // re-derives the same ids and finds them acked, so a mature store never re-uploads (D5). The
    // `syncRepoId` override is threaded through so the baseline acks under the SAME ids a later
    // push (with the same override) derives.
    for (const walked of walkSyncableEntries(
      store,
      opts.repoId !== undefined ? { repoId: opts.repoId } : {},
    ).entries)
      state.ackedEvents.push(walked.eventId);
  }
  saveSyncState(store.rootDir, state);
  return { created: true, state };
}

/** True when the store root has an initialized sync-state (the honest "configured" check). */
export function hasSyncState(store: MemoryStore): boolean {
  return existsSync(join(store.rootDir, SYNC_STATE_FILE));
}
