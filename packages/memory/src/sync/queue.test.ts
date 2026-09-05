/**
 * D3/D4 queue tests: the sidecar staging gates (schema + secret-scan + id re-derivation),
 * idempotent re-stage, the ack ledger (durable-result-first law), the torn-tail tolerance of the
 * membership read, and the fail-closed sync-state shape.
 */
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetMemoryLockGuardForTest } from '../index.js';
import {
  type ConflictRecord,
  type QuarantineRecord,
  SYNC_OUTBOX_FILE,
  SYNC_STATE_FILE,
  SyncStageError,
  SyncStateError,
  compactSyncOutbox,
  defaultSyncState,
  loadSyncState,
  markEventAcked,
  mergeSyncState,
  readStagedEventIds,
  readStagedEvents,
  saveSyncState,
  stageOutboundEvent,
} from './queue.js';
import { type TestHome, eventFor, freshTestHome, v1Record } from './sync-test-fixtures.js';

let home: TestHome;
let root: string;

beforeEach(() => {
  __resetMemoryLockGuardForTest();
  home = freshTestHome();
  root = mkdtempSync(join(tmpdir(), 'sync-queue-root-'));
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home.home, { recursive: true, force: true });
  rmSync(home.regDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('stageOutboundEvent (D3 sidecar + gates)', () => {
  it('stages one canonical line and reads it back', () => {
    const evt = eventFor(v1Record());
    const res = stageOutboundEvent(evt, root);
    expect(res).toEqual({ id: evt.id, staged: true, idempotent: false });
    const file = join(root, SYNC_OUTBOX_FILE);
    expect(existsSync(file)).toBe(true);
    const staged = readStagedEvents(root);
    expect(staged.malformed).toBe(0);
    expect(staged.events).toHaveLength(1);
    expect(staged.events[0]?.id).toBe(evt.id);
    expect(staged.events[0]?.payload.id).toBe(evt.payload.id);
  });

  it('is idempotent: the same content re-stages nothing', () => {
    const evt = eventFor(v1Record());
    expect(stageOutboundEvent(evt, root).staged).toBe(true);
    const again = stageOutboundEvent(evt, root);
    expect(again).toEqual({ id: evt.id, staged: false, idempotent: true });
    expect(readStagedEventIds(root).ids).toEqual([evt.id]);
  });

  it('refuses a forged envelope whose evt: id does not re-derive from its seed', () => {
    const evt = eventFor(v1Record());
    const forged = { ...evt, id: `evt:${'f'.repeat(64)}` };
    expect(() => stageOutboundEvent(forged, root)).toThrow(SyncStageError);
    expect(existsSync(join(root, SYNC_OUTBOX_FILE))).toBe(false);
  });

  it('refuses an envelope whose payloadId does not match the payload', () => {
    const evt = eventFor(v1Record());
    const mismatched = { ...evt, payloadId: 'mem:other' };
    expect(() => stageOutboundEvent(mismatched, root)).toThrow(/payloadId/);
  });

  it('refuses a payload whose content id does not re-derive (hand-edited bytes)', () => {
    const rec = v1Record();
    const edited = { ...rec, claim: 'A.b does the OTHER thing' };
    const evt = eventFor(edited); // builds an envelope over the EDITED payload with ITS id
    expect(() => stageOutboundEvent(evt, root)).toThrow(/does not re-derive/);
  });

  it('refuses a payload that fails schema validation (per-event, typed)', () => {
    // the broken field must NOT be part of the id seed (an id-seed break would be refused at the
    // id-derivation gate instead) — verdicts are validated by the schema, never hashed into the id
    const rec = v1Record();
    const broken = { ...rec, verdicts: { ...rec.verdicts, lifecycle: 'deleted' } };
    const evt = eventFor(broken as typeof rec);
    expect(() => stageOutboundEvent(evt, root)).toThrow(/schema validation failed/);
  });

  it('refuses a payload carrying a secret (the scanner refuses; the run may abort)', () => {
    const rec = v1Record(`A.b reads ${`token=sk-${'a'.repeat(30)}`} from env`);
    // the content id derives honestly over the edited claim, so ONLY the secret gate can refuse
    const evt = eventFor(rec);
    try {
      stageOutboundEvent(evt, root);
      expect.unreachable();
    } catch (err) {
      // the scanner's own error type propagates UN-wrapped (the run-level abort keys on it, D10)
      expect((err as Error).name).not.toBe('SyncStageError');
      expect(existsSync(join(root, SYNC_OUTBOX_FILE))).toBe(false);
    }
  });
});

describe('ack ledger (D4: durable result first, bookkeeping last)', () => {
  it('marks an event acked idempotently, and membership = staged ∪ acked', () => {
    const evt = eventFor(v1Record());
    const rec2 = v1Record('A.b does the other thing');
    const evt2 = eventFor(rec2);
    saveSyncState(root, defaultSyncState('device-a'));
    expect(stageOutboundEvent(evt, root).staged).toBe(true);
    markEventAcked(root, evt.id); // the push happened BEFORE this line — the ordering law
    markEventAcked(root, evt.id); // idempotent re-ack
    const state = loadSyncState(root);
    expect(state?.ackedEvents).toEqual([evt.id]);
    const ids = new Set([
      ...readStagedEventIds(root).ids,
      ...(loadSyncState(root)?.ackedEvents ?? []),
    ]);
    expect(ids.has(evt.id)).toBe(true);
    expect(ids.has(evt2.id)).toBe(false);
  });

  it('refuses to ack against an un-initialized store (init-sync owns the seed)', () => {
    expect(() => markEventAcked(root, 'evt:x')).toThrow(SyncStateError);
  });

  it('tolerates a torn tail in the membership read (counted, not thrown)', () => {
    const evt = eventFor(v1Record());
    expect(stageOutboundEvent(evt, root).staged).toBe(true);
    // simulate a crash mid-append: a half-written trailing line
    const path = join(root, SYNC_OUTBOX_FILE);
    appendFileSync(path, '{"id":"evt:half-wri', 'utf8');
    const ids = readStagedEventIds(root);
    expect(ids.ids).toEqual([evt.id]);
    expect(ids.malformed).toBe(1);
    // the strict reader reports the same tail as malformed, not a crash
    const strict = readStagedEvents(root);
    expect(strict.events.map((e) => e.id)).toEqual([evt.id]);
    expect(strict.malformed).toBe(1);
    // and the derive-and-diff heal re-stages cleanly (D4 at-least-once)
    expect(stageOutboundEvent(evt, root)).toEqual({ id: evt.id, staged: false, idempotent: true });
  });

  it('compacts only durably acked events and preserves pending events', () => {
    const first = eventFor(v1Record());
    const second = eventFor(v1Record('A.b remains pending'));
    saveSyncState(root, defaultSyncState('device-a'));
    stageOutboundEvent(first, root);
    stageOutboundEvent(second, root);
    markEventAcked(root, first.id);

    expect(compactSyncOutbox(root, { dryRun: true })).toMatchObject({
      before: 2,
      after: 1,
      removed: 1,
      dryRun: true,
    });
    expect(readStagedEvents(root).events).toHaveLength(2);

    expect(compactSyncOutbox(root)).toMatchObject({ before: 2, after: 1, removed: 1 });
    expect(readStagedEvents(root).events.map((event) => event.id)).toEqual([second.id]);
  });

  it('refuses a malformed queue and leaves the original bytes intact', () => {
    const evt = eventFor(v1Record());
    saveSyncState(root, defaultSyncState('device-a'));
    stageOutboundEvent(evt, root);
    appendFileSync(join(root, SYNC_OUTBOX_FILE), '{"id":"evt:torn', 'utf8');
    const before = readFileSync(join(root, SYNC_OUTBOX_FILE), 'utf8');
    expect(() => compactSyncOutbox(root)).toThrow(/malformed/);
    expect(readFileSync(join(root, SYNC_OUTBOX_FILE), 'utf8')).toBe(before);
  });

  it('keeps the original outbox when atomic replacement fails', () => {
    const evt = eventFor(v1Record());
    saveSyncState(root, defaultSyncState('device-a'));
    stageOutboundEvent(evt, root);
    markEventAcked(root, evt.id);
    const before = readFileSync(join(root, SYNC_OUTBOX_FILE), 'utf8');
    expect(() =>
      compactSyncOutbox(root, {
        write: () => {
          throw new Error('simulated disk full');
        },
      }),
    ).toThrow(/disk full/);
    expect(readFileSync(join(root, SYNC_OUTBOX_FILE), 'utf8')).toBe(before);
  });
});

describe('sync-state (D3)', () => {
  it('defaults, saves, and loads round-trip', () => {
    const state = defaultSyncState('device-a');
    state.ackedEvents = ['evt:aa'];
    state.purgeAcks = ['evt:bb'];
    state.keyEpoch = 3;
    saveSyncState(root, state);
    expect(loadSyncState(root)).toEqual(state);
    expect(readFileSync(join(root, SYNC_STATE_FILE), 'utf8').endsWith('\n')).toBe(true);
  });

  it('returns undefined when absent', () => {
    expect(loadSyncState(root)).toBeUndefined();
  });

  it('fails closed on a corrupt state file', () => {
    writeFileSync(join(root, SYNC_STATE_FILE), '{not json', 'utf8');
    expect(() => loadSyncState(root)).toThrow(SyncStateError);
  });

  it('fails closed on an unknown state schemaVersion (never coerced)', () => {
    writeFileSync(
      join(root, SYNC_STATE_FILE),
      JSON.stringify({ ...defaultSyncState('device-a'), schemaVersion: '9' }),
      'utf8',
    );
    expect(() => loadSyncState(root)).toThrow(/schemaVersion/);
  });

  it('fails closed on a malformed ledger array / cursor', () => {
    writeFileSync(
      join(root, SYNC_STATE_FILE),
      JSON.stringify({ ...defaultSyncState('device-a'), ackedEvents: 'evt:aa' }),
      'utf8',
    );
    expect(() => loadSyncState(root)).toThrow(/ackedEvents/);
    writeFileSync(
      join(root, SYNC_STATE_FILE),
      JSON.stringify({ ...defaultSyncState('device-a'), cursors: { pulledBatches: 'b1' } }),
      'utf8',
    );
    expect(() => loadSyncState(root)).toThrow(/pulledBatches/);
  });

  it('mergeSyncState unions the cursors, acks, and purge acks over the LATEST on-disk state', () => {
    // the locked-save law: a run's `next` is merged over the LATEST state re-read under the lock,
    // so a concurrent writer's acks/purge-acks survive this run's save.
    const latest = defaultSyncState('device-a');
    latest.ackedEvents = ['evt:acked-on-disk'];
    latest.purgeAcks = ['evt:purged-on-disk'];
    latest.cursors.pulledBatches = ['b/disk-1.json'];
    const incoming = defaultSyncState('device-b'); // base's deviceId wins
    incoming.ackedEvents = ['evt:acked-this-run'];
    incoming.purgeAcks = ['evt:purged-this-run'];
    incoming.cursors.pulledBatches = ['b/disk-1.json', 'b/run-2.json'];
    incoming.keyEpoch = 2; // base's epoch wins — a concurrent rotation must not be rolled back
    incoming.conflicts = [conflictRow('evt:c1')];
    incoming.quarantine = [quarantineRow('evt:q1')];
    const merged = mergeSyncState(latest, incoming);
    expect(merged.deviceId).toBe('device-a');
    expect(merged.keyEpoch).toBe(1); // the base's epoch wins over the stale run's
    expect(merged.ackedEvents.sort()).toEqual(['evt:acked-on-disk', 'evt:acked-this-run']);
    expect(merged.purgeAcks.sort()).toEqual(['evt:purged-on-disk', 'evt:purged-this-run']);
    expect([...merged.cursors.pulledBatches].sort()).toEqual(['b/disk-1.json', 'b/run-2.json']);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.quarantine).toHaveLength(1);
  });

  it('mergeSyncState dedupes conflict and quarantine rows by their outcome keys', () => {
    const base = defaultSyncState('device-a');
    const incoming = defaultSyncState('device-b');
    incoming.conflicts = [
      conflictRow('evt:c'),
      // same event + remote digest but a different local digest — the SAME outcome (event ×
      // remote divergence), so the redelivered row dedupes instead of appending twice
      { ...conflictRow('evt:c'), localDigest: 'z' },
    ];
    incoming.quarantine = [
      quarantineRow('evt:q'),
      // same event + payload + reason at a different seenAt — still the same outcome, deduped
      { ...quarantineRow('evt:q'), seenAt: '2027-01-01T00:00:00.000Z' },
    ];
    const merged = mergeSyncState(base, incoming);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.quarantine).toHaveLength(1);
  });
});

const T0 = '2026-01-01T00:00:00.000Z';

function conflictRow(eventId: string): ConflictRecord {
  return {
    eventId,
    payloadId: 'mem:1',
    localDigest: 'd-local',
    remoteDigest: 'd-remote',
    sourceDevice: 'device-x',
    seenAt: T0,
  };
}

function quarantineRow(eventId: string): QuarantineRecord {
  return { eventId, payloadId: 'mem:2', reason: 'invalid-schema', seenAt: T0 };
}
