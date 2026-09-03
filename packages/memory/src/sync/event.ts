/**
 * The ADR-003 (Gate 4) sync event envelope (D1) — the ONE id grammar of cross-device sync.
 *
 *   `evt:<blake3Hex(canonical({ kind, store, repoId?, body }))>`
 *
 * where `body` is the canonical entry JSON (`canonicalMemoryJson` — the event is a wrapper, never a
 * re-encoding). `deviceId`, `principalId`, and `ts` are ENVELOPE METADATA ONLY — never in the seed —
 * and there is no seq and no prev-chaining (D1 ruling: chaining would make two devices'
 * independently-derived events for one claim distinct and unreconcilable). Two devices that derive
 * an event for the same claim therefore produce the SAME `evt:` id, which is the dedupe backbone of
 * push/pull (D4) and the membership test of the derive-and-diff sweep (D5).
 *
 * The frozen-seed law applies: `{ kind, store, repoId?, body }` is frozen once landed.
 */
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { decisionId, feedbackId, memoryRecordId, memoryRecordV2Id } from '../ids.js';
import { MemorySchemaVersionError } from '../migrations.js';
import { canonicalMemoryJson } from '../serialization.js';
import { isMemoryRecordV2 } from '../types.js';
import type {
  MemoryDecision,
  MemoryEntry,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordV2,
} from '../types.js';
import { MemorySchemaError, assertValidSyncEvent } from '../validate.js';

/** The event kinds (D1). Tombstones ride `decision.append` as retract/supersede decisions (D9). */
export type SyncEventKind = 'record.upsert' | 'decision.append' | 'feedback.append' | 'purge.mark';

export const SYNC_EVENT_KINDS: readonly SyncEventKind[] = [
  'record.upsert',
  'decision.append',
  'feedback.append',
  'purge.mark',
];

/** The store scope an event was pushed from (D2: local + global only — team stays git-only). */
export type SyncStoreScope = 'local' | 'global';

/** Where an event came from: a live write, the init backfill, or a pulled peer event. */
export type SyncEventOrigin = 'write' | 'bootstrap' | 'pull';

/** The envelope's `meta` (D1) — open for additive keys, `origin` is the load-bearing one. */
export interface SyncEventMeta {
  origin?: SyncEventOrigin;
  [k: string]: unknown;
}

/** What a sync event carries: the entry kinds that ever sync (D1: nothing else is ever shipped). */
export type SyncEventPayload = MemoryRecord | MemoryRecordV2 | MemoryDecision | MemoryFeedback;

/** The sync event envelope (D1, `sync-event.schema.json`). */
export interface SyncEvent {
  /** `evt:<blake3Hex>` — content-addressed over `{ kind, store, repoId?, body }` ONLY. */
  id: string;
  schemaVersion: '1';
  kind: SyncEventKind;
  store: SyncStoreScope;
  /** present iff store === 'local' (schema-enforced both ways). */
  repoId?: string;
  /** envelope metadata only — never in the id seed. */
  deviceId: string;
  /** envelope metadata only — never in the id seed. */
  principalId: string;
  /** the payload entry's content id (re-derivable — see {@link verifyPayloadId}). */
  payloadId: string;
  /** the canonical entry object (the event wraps it, never re-encodes it). */
  payload: SyncEventPayload;
  /** envelope metadata only — never in the id seed. */
  ts: string;
  meta?: SyncEventMeta;
}

/** Thrown when an envelope is built or staged against the D1 contract (bad repoId pairing, an id
 *  that does not re-derive from its own payload). */
export class SyncEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncEventError';
  }
}

/**
 * The `evt:` id seed — the D1 ruling that collapses four downstream specs. PURE and deterministic:
 * the same payload always derives the same id, and deviceId/ts/principalId are metadata only. The
 * seed is frozen once landed.
 */
export function deriveEventId(
  kind: SyncEventKind,
  store: SyncStoreScope,
  repoId: string | undefined,
  payload: SyncEventPayload,
): string {
  const body = canonicalMemoryJson(payload as MemoryEntry);
  const seed: Record<string, unknown> = { kind, store, body };
  if (store === 'local') {
    if (repoId === undefined || repoId.length === 0) {
      throw new SyncEventError(`kind '${kind}' on the local store requires a repoId in the seed`);
    }
    seed.repoId = repoId;
  } else if (repoId !== undefined) {
    throw new SyncEventError(`kind '${kind}' on the global store must not carry a repoId`);
  }
  // canonicalMemoryJson key-sorts whatever it is given (the same helper the shards use) — the event
  // seed therefore shares the exact canonical form the merge driver unions over.
  return `evt:${blake3Hex(canonicalMemoryJson(seed as unknown as MemoryEntry))}`;
}

/** Build the envelope, deriving the `evt:` id from the seed ({@link deriveEventId}). PURE. */
export function buildSyncEvent(input: {
  kind: SyncEventKind;
  store: SyncStoreScope;
  repoId?: string;
  deviceId: string;
  principalId: string;
  payload: SyncEventPayload;
  ts: string;
  meta?: SyncEventMeta;
}): SyncEvent {
  const evt: SyncEvent = {
    id: deriveEventId(input.kind, input.store, input.repoId, input.payload),
    schemaVersion: '1',
    kind: input.kind,
    store: input.store,
    deviceId: input.deviceId,
    principalId: input.principalId,
    payloadId: input.payload.id,
    payload: input.payload,
    ts: input.ts,
  };
  if (input.store === 'local') evt.repoId = input.repoId;
  if (input.meta !== undefined) evt.meta = input.meta;
  return evt;
}

/** One canonical JSON line (no trailing newline — the queue appends it). Byte-stable: the same
 *  event serializes identically on every device (the at-least-once redelivery no-op, D4/D6). */
export function serializeSyncEvent(evt: SyncEvent): string {
  return canonicalMemoryJson(evt as unknown as MemoryEntry);
}

/**
 * Parse + validate one event JSON line. Fail closed (the loader's posture): an unknown
 * `schemaVersion` throws `MemorySchemaVersionError`, anything structurally invalid throws
 * `MemorySchemaError` (an unknown kind fails the schema's closed enum, and the repoId pairing is
 * enforced by the schema's if/then).
 */
export function parseSyncEvent(line: string): SyncEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new MemorySchemaError('sync-event', [{ invalidJson: (err as Error).message }]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MemorySchemaError('sync-event', [{ notAnObject: true }]);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== '1') {
    throw new MemorySchemaVersionError(
      typeof obj.schemaVersion === 'string' ? obj.schemaVersion : JSON.stringify(obj.schemaVersion),
    );
  }
  assertValidSyncEvent(obj as unknown as SyncEvent);
  if (!SYNC_EVENT_KINDS.includes(obj.kind as SyncEventKind)) {
    throw new MemorySchemaError('sync-event', [{ unknownKind: String(obj.kind) }]);
  }
  return obj as unknown as SyncEvent;
}

/**
 * Re-derive the payload entry's content id with the ids.ts builder for its kind (D8 step 2, on push
 * AND pull): a `mem:` re-seeds through the record builder (memory-2 uses the v2 seed), a `dec:`
 * through `decisionId`, an `fb:` through `feedbackId`. A mismatch = forged / hand-edited content —
 * a hard-conflict trigger, never applied. `ok: false` with no `expectedId` means the kind's seed
 * could not be derived at all (missing fields) — that is a refusal, never a pass.
 */
export function verifyPayloadId(entry: {
  id: string;
}): {
  ok: boolean;
  expectedId?: string;
  actualId: string;
} {
  // the builders read seed fields by name — any entry with a string id is introspectable here
  const rec = entry as unknown as Record<string, unknown>;
  const actualId = entry.id;
  const colon = actualId.indexOf(':');
  const prefix = colon > 0 ? actualId.slice(0, colon) : '';
  try {
    if (prefix === 'mem') {
      const expected = isMemoryRecordV2(rec)
        ? memoryRecordV2Id({
            kind: rec.kind as MemoryRecordV2['kind'],
            subject: rec.subject as string,
            propositionKey: rec.propositionKey as string,
            claim: rec.claim as string,
            evidence: rec.evidence as MemoryRecordV2['evidence'],
          })
        : memoryRecordId(rec as unknown as MemoryRecord);
      return { ok: expected === actualId, expectedId: expected, actualId };
    }
    if (prefix === 'dec') {
      const expected = decisionId(entry as unknown as Parameters<typeof decisionId>[0]);
      return { ok: expected === actualId, expectedId: expected, actualId };
    }
    if (prefix === 'fb') {
      const expected = feedbackId(entry as unknown as Parameters<typeof feedbackId>[0]);
      return { ok: expected === actualId, expectedId: expected, actualId };
    }
  } catch {
    // a seed field is missing/malformed — the id is not derivable, which IS the mismatch
    return { ok: false, actualId };
  }
  return { ok: false, actualId };
}
