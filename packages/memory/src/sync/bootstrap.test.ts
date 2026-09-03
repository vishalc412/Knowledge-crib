/**
 * D5 derive-and-diff sweep tests: walks the syncable record collections by role, excludes already
 * pending-or-acked ids BY ID DERIVATION (never timestamps), reports unreadable shard lines, and
 * refuses the team store.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, __resetMemoryLockGuardForTest } from '../index.js';
import { walkSyncableEntries } from './bootstrap.js';
import { defaultSyncState, saveSyncState, stageOutboundEvent } from './queue.js';
import {
  REPO,
  decision,
  eventFor,
  freshTestHome,
  v1Record,
  v2Record,
} from './sync-test-fixtures.js';

let home: ReturnType<typeof freshTestHome>;
let localStore: MemoryStore;
let globalStore: MemoryStore;

beforeEach(() => {
  __resetMemoryLockGuardForTest();
  home = freshTestHome();
  localStore = MemoryStore.local(REPO, { env: home.env });
  globalStore = MemoryStore.global({ env: home.env });
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home.home, { recursive: true, force: true });
  rmSync(home.regDir, { recursive: true, force: true });
});

describe('walkSyncableEntries (D5)', () => {
  it('walks the local store over `active` with the repoId attached', () => {
    localStore.upsertEntry('active', v1Record());
    localStore.ensureManifest(); // the manifest's repo.id is the seed's repoId
    const walk = walkSyncableEntries(localStore);
    expect(walk.errors).toEqual([]);
    expect(walk.entries).toHaveLength(1);
    const walked = walk.entries[0]!;
    expect(walked.store).toBe('local');
    expect(walked.repoId).toBe(REPO);
    expect(walked.kind).toBe('record.upsert');
    expect(walked.eventId).toBe(eventFor(walked.entry, { store: 'local', repoId: REPO }).id);
    expect(walked.entry.id).toBe((v1Record() as { id: string }).id);
  });

  it('walks the global store over `records` with NO repoId', () => {
    globalStore.upsertEntry('records', v2Record());
    globalStore.ensureManifest();
    const walk = walkSyncableEntries(globalStore);
    expect(walk.entries).toHaveLength(1);
    const walked = walk.entries[0]!;
    expect(walked.store).toBe('global');
    expect(walked.repoId).toBeUndefined();
    expect(walked.eventId).toBe(eventFor(walked.entry, { store: 'global' }).id);
  });

  it('excludes entries already staged in the outbox (by id derivation)', () => {
    const rec = v1Record();
    localStore.upsertEntry('active', rec);
    localStore.ensureManifest();
    const evt = eventFor(rec, { store: 'local', repoId: REPO });
    stageOutboundEvent(evt, localStore.rootDir); // caller-held lock; the sweep reads the sidecar
    expect(walkSyncableEntries(localStore).entries).toHaveLength(0);
  });

  it('excludes entries already acked in the sync-state (seeded init)', () => {
    const rec = v1Record();
    localStore.upsertEntry('active', rec);
    localStore.ensureManifest();
    const evt = eventFor(rec, { store: 'local', repoId: REPO });
    const state = defaultSyncState('device-a');
    state.ackedEvents = [evt.id];
    saveSyncState(localStore.rootDir, state);
    expect(walkSyncableEntries(localStore).entries).toHaveLength(0);
  });

  it('re-walks cleanly after the sweep stages its events (idempotent, order-independent)', () => {
    localStore.upsertEntry('active', v1Record());
    localStore.upsertEntry('active', v1Record('A.b does the other thing'));
    localStore.ensureManifest();
    const first = walkSyncableEntries(localStore);
    expect(first.entries).toHaveLength(2);
    for (const walked of first.entries) {
      stageOutboundEvent(
        eventFor(walked.entry, { store: walked.store, repoId: walked.repoId }),
        localStore.rootDir,
      );
    }
    expect(walkSyncableEntries(localStore).entries).toHaveLength(0);
  });

  it('reports a non-record line in the sync source as an error (never a silent skip)', () => {
    // `active` is record-only by contract; a decision landing there is malformed for the walk
    const dec = decision('quarantine', 'mem:orphan');
    localStore.upsertEntry('active', dec);
    localStore.upsertEntry('active', v1Record());
    localStore.ensureManifest();
    const walk = walkSyncableEntries(localStore);
    expect(walk.entries).toHaveLength(1); // only the record is walked
    expect(walk.errors.length).toBe(1);
    expect(walk.errors[0]).toContain(dec.id);
  });

  it('refuses the team store outright (git is its backend, D2)', () => {
    const team = MemoryStore.team(home.home, { env: home.env });
    expect(() => walkSyncableEntries(team)).toThrow(/not a sync participant/);
  });
});
