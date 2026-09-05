/**
 * D1 envelope tests: id determinism + metadata-exclusion (the dedupe backbone), payload-id
 * re-derivation, fail-closed parse, and the repoId pairing the schema encodes.
 */
import { describe, expect, it } from 'vitest';
import { createIntakeCheckpoint, createIntakeRequirement } from '../intake.js';
import { MemorySchemaVersionError } from '../migrations.js';
import { MemorySchemaError } from '../validate.js';
import {
  type SyncEvent,
  buildSyncEvent,
  deriveEventId,
  parseSyncEvent,
  serializeSyncEvent,
  verifyPayloadId,
} from './event.js';
import {
  NOW,
  REPO,
  decision,
  eventFor,
  feedback,
  v1Record,
  v2Record,
} from './sync-test-fixtures.js';

function intakeEntries() {
  const requirement = createIntakeRequirement({
    namespace: { principalId: 'principal-vishal', projectId: REPO },
    original: 'Continue the sync work',
    interpretation: {
      outcome: 'Finish sync',
      scope: ['packages/memory'],
      constraints: [],
      acceptanceCriteria: ['Device B resumes'],
    },
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
    provenance: {
      principalId: 'principal-vishal',
      deviceId: 'device-a',
      actorId: 'actor-a',
      clientId: 'test',
    },
    createdAt: NOW,
  });
  const checkpoint = createIntakeCheckpoint({
    intakeId: requirement.id,
    kind: 'progress',
    phase: 'executing',
    nextSafeAction: 'Run sync tests',
    summary: 'Sync implementation started',
    repository: { head: 'abc', dirty: false },
    actor: 'actor-a',
    recordedAt: NOW,
  });
  return { requirement, checkpoint };
}

describe('deriveEventId (D1)', () => {
  it('is deterministic over the seed {kind, store, repoId?, body}', () => {
    const rec = v1Record();
    expect(deriveEventId('record.upsert', 'local', REPO, rec)).toBe(
      deriveEventId('record.upsert', 'local', REPO, v1Record()),
    );
    // a different kind or payload → a different id
    expect(deriveEventId('record.upsert', 'local', REPO, rec)).not.toBe(
      deriveEventId('decision.append', 'local', REPO, decision('quarantine')),
    );
    expect(deriveEventId('record.upsert', 'local', REPO, rec)).not.toBe(
      deriveEventId('record.upsert', 'local', REPO, v1Record('A.b does the other thing')),
    );
  });

  it('is INDEPENDENT of deviceId/principalId/ts (envelope metadata only)', () => {
    const rec = v1Record();
    const a = eventFor(rec, { deviceId: 'device-a', ts: NOW });
    const b = eventFor(rec, { deviceId: 'device-b', ts: '2026-06-06T00:00:00.000Z' });
    expect(a.id).toBe(b.id); // two devices deriving the same claim collapse to ONE event
    expect(a.id.startsWith('evt:')).toBe(true);
  });

  it('keys local events on the repoId', () => {
    const rec = v1Record();
    expect(deriveEventId('record.upsert', 'local', REPO, rec)).not.toBe(
      deriveEventId('record.upsert', 'local', 'r-other', rec),
    );
  });

  it('refuses local without a repoId and global with one (the schema pairing)', () => {
    expect(() => deriveEventId('record.upsert', 'local', undefined, v1Record())).toThrow(/repoId/);
    expect(() => deriveEventId('record.upsert', 'local', '', v1Record())).toThrow(/repoId/);
    expect(() => deriveEventId('record.upsert', 'global', REPO, v1Record())).toThrow(/repoId/);
    expect(() => deriveEventId('record.upsert', 'global', undefined, v1Record())).not.toThrow();
  });
});

describe('buildSyncEvent / serialize / parse', () => {
  it('round-trips through the canonical line byte-stably', () => {
    const evt = eventFor(v1Record());
    const parsed = parseSyncEvent(serializeSyncEvent(evt));
    expect(parsed.id).toBe(evt.id);
    expect(parsed.payloadId).toBe(evt.payload.id);
    expect(parsed.repoId).toBe(REPO);
    expect(serializeSyncEvent(parsed)).toBe(serializeSyncEvent(evt));
  });

  it('carries meta.origin and re-parses it', () => {
    const evt = eventFor(decision('quarantine'), { kind: 'decision.append' });
    evt.meta = { origin: 'pull' };
    const parsed = parseSyncEvent(serializeSyncEvent(evt));
    expect(parsed.meta?.origin).toBe('pull');
  });

  it('fails closed on an unknown schemaVersion (typed, like records)', () => {
    const evt = eventFor(v1Record());
    // mutate the ENVELOPE's version (not the payload's) via parse+rewrite, not string surgery
    const mutated = { ...evt, schemaVersion: '2' } as unknown as SyncEvent;
    expect(() => parseSyncEvent(serializeSyncEvent(mutated))).toThrow(MemorySchemaVersionError);
  });

  it('fails closed on an unknown kind and on an unknown id prefix', () => {
    const evt = eventFor(v1Record());
    expect(() =>
      parseSyncEvent(serializeSyncEvent(evt).replace('record.upsert', 'record.delete')),
    ).toThrow(MemorySchemaError);
    // a mem: id in an evt: envelope fails the schema's closed id pattern
    const forged = { ...evt, id: 'mem:notahash' } as unknown as SyncEvent;
    expect(() => parseSyncEvent(serializeSyncEvent(forged))).toThrow(MemorySchemaError);
  });

  it('fails closed on the repoId pairing at parse time (schema if/then)', () => {
    const evt = eventFor(v1Record());
    const global = { ...evt, repoId: undefined } as unknown as SyncEvent;
    expect(() => parseSyncEvent(serializeSyncEvent(global))).toThrow(MemorySchemaError);
    const gRec = v1Record();
    const globalOk = buildSyncEvent({
      kind: 'record.upsert',
      store: 'global',
      deviceId: 'device-a',
      principalId: 'principal-vishal',
      payload: gRec,
      ts: NOW,
    });
    expect(() => parseSyncEvent(serializeSyncEvent(globalOk))).not.toThrow();
  });
});

describe('verifyPayloadId (D8 step 2)', () => {
  it('accepts honestly-derived mem:/dec:/fb: payloads', () => {
    expect(verifyPayloadId(v1Record()).ok).toBe(true);
    expect(verifyPayloadId(v2Record()).ok).toBe(true);
    expect(verifyPayloadId(decision('quarantine', 'mem:x')).ok).toBe(true);
    expect(verifyPayloadId(feedback('useful', 'mem:x')).ok).toBe(true);
  });

  it('accepts honestly-derived intake and checkpoint payloads', () => {
    const { requirement, checkpoint } = intakeEntries();
    expect(verifyPayloadId(requirement).ok).toBe(true);
    expect(verifyPayloadId(checkpoint).ok).toBe(true);
  });

  it('rejects a hand-edited payload (id no longer re-derives)', () => {
    const rec = v1Record();
    const edited = { ...rec, claim: 'A.b does the OTHER thing' };
    const check = verifyPayloadId(edited);
    expect(check.ok).toBe(false);
    // the id derives over the EDITED content, so it differs from the record's true id
    expect(check.expectedId).not.toBe(rec.id);
    expect(check.actualId).toBe(rec.id);
  });

  it('refuses an undervivable payload (missing seed fields) — never a pass', () => {
    const rec = v1Record();
    // scope is part of the v1 seed; without it the builder throws → not derivable
    const broken = { ...rec, scope: undefined };
    const check = verifyPayloadId(broken as unknown as { id: string });
    expect(check.ok).toBe(false);
    expect(check.expectedId).toBeUndefined();
  });

  it('refuses any other id prefix', () => {
    expect(verifyPayloadId({ id: 'alias:abc' } as unknown as { id: string }).ok).toBe(false);
    expect(verifyPayloadId({ id: 'weird:abc' } as unknown as { id: string }).ok).toBe(false);
  });
});
