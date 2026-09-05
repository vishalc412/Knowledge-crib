/**
 * ADR-003 (Gate 4) D3 + D4 — the outbound sidecar queue. Store-root sidecars, NOT new
 * MemoryCollections (D3): `<storeRoot>/sync-outbox.jsonl` + `<storeRoot>/sync-state.json` sit
 * deliberately outside the closed collection union (no manifest count-key churn, no BM25 corpus
 * pollution, no FTS hazard) and outside the merge driver's `*.jsonl` claim.
 *
 * Two laws lifted from outbox.ts:
 *
 *   1. **The sidecar path bypasses the store's write gate** (D3), so {@link stageOutboundEvent} runs
 *      the gate ITSELF — `assertValidMemoryEntry` + `assertNoMemorySecrets` on the payload, plus the
 *      D8 id-derivation check (a staged envelope whose `evt:` id does not re-derive from its payload
 *      is refused, and so is a payload whose content id does not re-derive from its own bytes).
 *   2. **Durable result FIRST, bookkeeping LAST** (D4): the caller pushes via `putObject` and only
 *      THEN calls {@link markEventAcked} — a crash between the two heals as an at-least-once
 *      redelivery that the same `evt:` id dedupes. The ack bookkeeping must never precede the
 *      durable result it acknowledges.
 *
 * Lock convention: the append runs under the caller's hold of the store's own lock
 * (`<storeRoot>/.lock` — the SAME file `MemoryStore.withLock` holds, never a second lock; `CribLock`
 * is exclusive-create, so a nested acquire would fail loudly rather than nest).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../atomic.js';
import { assertNoMemorySecrets } from '../secrets.js';
import { assertValidMemoryEntry } from '../validate.js';
import {
  type SyncEvent,
  deriveEventId,
  parseSyncEvent,
  serializeSyncEvent,
  verifyPayloadId,
} from './event.js';

/** `<storeRoot>/sync-outbox.jsonl` — the staged, not-yet-pushed event lines. */
export const SYNC_OUTBOX_FILE = 'sync-outbox.jsonl';
/** `<storeRoot>/sync-state.json` — cursors, ack ledger, conflicts, quarantine, purge acks. */
export const SYNC_STATE_FILE = 'sync-state.json';

/** Thrown when an envelope is refused at staging (gate hit, id mismatch, forged envelope). */
export class SyncStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncStageError';
  }
}

/** Thrown on a corrupt or absent-when-required sync-state. */
export class SyncStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncStateError';
  }
}

/** One same-id-different-bytes ledger row (D8 step 4). Digests only — never the payload bytes. */
export interface ConflictRecord {
  eventId: string;
  payloadId: string;
  localDigest: string;
  remoteDigest: string;
  sourceDevice: string;
  seenAt: string;
}

/** One quarantined pull (D8 step 1: an operator `--skip` quarantines, never deletes). The reason is
 *  the finding KIND, by id + location only (D10) — never the finding text. */
export interface QuarantineRecord {
  eventId: string;
  payloadId: string;
  reason: string;
  seenAt: string;
}

/** `<storeRoot>/sync-state.json` (D3): everything sync needs to survive a crash, keyed by id. */
export interface SyncState {
  schemaVersion: '1';
  deviceId: string;
  /** The pulled batch ids (D6: the batch manifest IS the cursor — advanced LAST). */
  cursors: { pulledBatches: string[] };
  /** Event ids whose remote blob is durably pushed (ack LAST, D4). */
  ackedEvents: string[];
  conflicts: ConflictRecord[];
  quarantine: QuarantineRecord[];
  /** Physical purges acknowledged on the remote (terminal state first, bookkeeping last — D11). */
  purgeAcks: string[];
  keyEpoch: number;
}

/** A fresh state for a device (first `init-sync` seeds it). */
export function defaultSyncState(deviceId: string): SyncState {
  return {
    schemaVersion: '1',
    deviceId,
    cursors: { pulledBatches: [] },
    ackedEvents: [],
    conflicts: [],
    quarantine: [],
    purgeAcks: [],
    keyEpoch: 1,
  };
}

/** Fail-closed shape check for a loaded state (an unknown version is a refusal, never a coercion). */
function assertSyncStateShape(state: Record<string, unknown>): void {
  if (state.schemaVersion !== '1') {
    throw new SyncStateError(
      `unsupported sync-state schemaVersion ${String(state.schemaVersion)} (expected '1')`,
    );
  }
  if (typeof state.deviceId !== 'string' || state.deviceId.length === 0) {
    throw new SyncStateError('sync-state.deviceId must be a non-empty string');
  }
  for (const key of ['ackedEvents', 'conflicts', 'quarantine', 'purgeAcks'] as const) {
    if (!Array.isArray(state[key])) {
      throw new SyncStateError(`sync-state.${key} must be an array`);
    }
  }
  if (
    state.cursors === null ||
    typeof state.cursors !== 'object' ||
    !Array.isArray((state.cursors as Record<string, unknown>).pulledBatches)
  ) {
    throw new SyncStateError('sync-state.cursors.pulledBatches must be an array');
  }
  if (typeof state.keyEpoch !== 'number') {
    throw new SyncStateError('sync-state.keyEpoch must be a number');
  }
}

/** Read the sync-state; `undefined` when absent (an un-initialized store). Corrupt/unknown → throw. */
export function loadSyncState(storeRoot: string): SyncState | undefined {
  const path = join(storeRoot, SYNC_STATE_FILE);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SyncStateError(`corrupt ${SYNC_STATE_FILE}: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyncStateError(`${SYNC_STATE_FILE} is not a JSON object`);
  }
  assertSyncStateShape(parsed as Record<string, unknown>);
  return parsed as unknown as SyncState;
}

/** Persist the state (atomic temp→rename; the caller owns the lock hold). */
export function saveSyncState(storeRoot: string, state: SyncState): void {
  assertSyncStateShape(state as unknown as Record<string, unknown>);
  writeJsonAtomic(join(storeRoot, SYNC_STATE_FILE), `${JSON.stringify(state)}\n`);
}

/** Dedupe keys for the ledger rows a merge folds in (same event + same outcome = one row, no
 *  matter how many times a crash-redelivered run re-derives it). */
function conflictRowKey(row: ConflictRecord): string {
  return `${row.eventId}|${row.remoteDigest}`;
}
function quarantineRowKey(row: QuarantineRecord): string {
  return `${row.eventId}|${row.payloadId}|${row.reason}`;
}

/**
 * Merge a freshly-computed state INTO the latest on-disk state, for writers that reloaded their
 * base before a long (lock-free, async) run: cursors/acks/purgeAcks union, ledger rows folded in
 * with dedupe. A crash-redelivered conflict or quarantine re-derives byte-identical rows — the
 * (eventId, outcome) key is what makes redelivery append-once, not append-every-time. The base's
 * deviceId/keyEpoch win: a concurrent rotation must not be rolled back by a stale run's epoch.
 */
export function mergeSyncState(base: SyncState, incoming: SyncState): SyncState {
  // the seen-set grows as rows are accepted, so duplicates WITHIN one run's state fold too
  // (a crash-redelivered row re-derived mid-run must not double-append).
  const seenConflicts = new Set(base.conflicts.map(conflictRowKey));
  const conflicts = [...base.conflicts];
  for (const row of incoming.conflicts) {
    const key = conflictRowKey(row);
    if (seenConflicts.has(key)) continue;
    seenConflicts.add(key);
    conflicts.push(row);
  }
  const seenQuarantine = new Set(base.quarantine.map(quarantineRowKey));
  const quarantine = [...base.quarantine];
  for (const row of incoming.quarantine) {
    const key = quarantineRowKey(row);
    if (seenQuarantine.has(key)) continue;
    seenQuarantine.add(key);
    quarantine.push(row);
  }
  return {
    ...base,
    cursors: {
      pulledBatches: [
        ...new Set([...base.cursors.pulledBatches, ...incoming.cursors.pulledBatches]),
      ],
    },
    ackedEvents: [...new Set([...base.ackedEvents, ...incoming.ackedEvents])],
    conflicts,
    quarantine,
    purgeAcks: [...new Set([...base.purgeAcks, ...incoming.purgeAcks])],
  };
}

/** The `evt:` ids already staged in the outbox (pending). A torn/trailing line is counted, not
 *  thrown on: a torn append is re-staged by the derive-and-diff sweep (D4 heals by redelivery), and
 *  membership must not wedge the queue on a half-written tail. */
export function readStagedEventIds(storeRoot: string): { ids: string[]; malformed: number } {
  const path = join(storeRoot, SYNC_OUTBOX_FILE);
  if (!existsSync(path)) return { ids: [], malformed: 0 };
  const ids: string[] = [];
  let malformed = 0;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      const evt = JSON.parse(line) as { id?: unknown };
      if (typeof evt.id === 'string') ids.push(evt.id);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { ids, malformed };
}

/**
 * Stage ONE event into the sidecar outbox — the ONLY sidecar writer (D3). Gates, in order:
 *   1. the envelope's `payloadId` matches its payload's own id;
 *   2. the payload's content id re-derives from its own bytes ({@link verifyPayloadId} — D8 step 2);
 *   3. the envelope's `evt:` id re-derives from its seed (a forged envelope is refused);
 *   4. the store's write gates run on the plaintext payload BEFORE anything is staged:
 *      `assertValidMemoryEntry` + `assertNoMemorySecrets` (D3/D10 — a secret-scan hit refuses the
 *      stage, and the push RUN aborts on a hit; every other refusal skips-and-reports).
 *
 * Idempotent: an id already staged appends nothing (the same content re-derives the same `evt:` id).
 * Caller MUST hold the store's lock (`<storeRoot>/.lock`) — the same lock the store writes hold.
 */
export function stageOutboundEvent(
  evt: SyncEvent,
  storeRoot: string,
): { id: string; staged: boolean; idempotent: boolean } {
  if (evt.payloadId !== evt.payload.id) {
    throw new SyncStageError(
      `envelope payloadId ${evt.payloadId} does not match payload ${evt.payload.id}`,
    );
  }
  const payloadCheck = verifyPayloadId(evt.payload);
  if (!payloadCheck.ok) {
    throw new SyncStageError(
      `payload content id does not re-derive from its own bytes (declared ${payloadCheck.actualId}, derived ${payloadCheck.expectedId ?? 'nothing'})`,
    );
  }
  if (deriveEventId(evt.kind, evt.store, evt.repoId, evt.payload) !== evt.id) {
    throw new SyncStageError(`envelope id ${evt.id} does not re-derive from its seed`);
  }
  // The sidecar path bypasses the store's write gate by design (D3), so the gate runs HERE. The two
  // errors stay TYPED and un-wrapped: a schema failure is a per-event refusal, while a secret-scan
  // hit aborts the whole push run (D10 — the run-level check keys on the scanner's own error type).
  assertValidMemoryEntryGate(evt);
  assertNoMemorySecrets(evt.payload);
  const { ids } = readStagedEventIds(storeRoot);
  if (ids.includes(evt.id)) {
    return { id: evt.id, staged: false, idempotent: true };
  }
  mkdirSync(storeRoot, { recursive: true });
  appendFileSync(join(storeRoot, SYNC_OUTBOX_FILE), `${serializeSyncEvent(evt)}\n`, 'utf8');
  return { id: evt.id, staged: true, idempotent: false };
}

/** Schema gate on the staged payload + envelope (imported here so the sidecar path cannot skip it). */
function assertValidMemoryEntryGate(evt: SyncEvent): void {
  // The envelope validates through the `evt:` id-prefix dispatch; the payload validates through its
  // own kind's dispatch (the same validators `MemoryStore.assertWritable` runs on the store path).
  assertValidMemoryEntry(evt as unknown as { id: string } & Record<string, unknown>);
  assertValidMemoryEntry(evt.payload as unknown as { id: string } & Record<string, unknown>);
}

/** Read every staged event (parsed, fail closed on a malformed line — readers are strict, writers
 *  tolerate a torn tail via {@link readStagedEventIds}). */
export function readStagedEvents(storeRoot: string): { events: SyncEvent[]; malformed: number } {
  const path = join(storeRoot, SYNC_OUTBOX_FILE);
  if (!existsSync(path)) return { events: [], malformed: 0 };
  const events: SyncEvent[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(parseSyncEvent(line));
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

export interface SyncOutboxCompactionResult {
  before: number;
  after: number;
  removed: number;
  dryRun: boolean;
}

export interface SyncOutboxCompactionOptions {
  dryRun?: boolean;
  /** Test seam for disk-full/interrupted-write acceptance; production uses atomic temp→rename. */
  write?: (path: string, content: string) => void;
}

/**
 * Remove outbox payload lines whose ids are already durably recorded in `sync-state.ackedEvents`.
 * Pending events retain their original order and canonical serialization. A malformed line refuses
 * the entire compaction so cleanup can never erase a torn event that reconciliation still needs.
 * Caller must hold the owning MemoryStore lock when `dryRun` is false.
 */
export function compactSyncOutbox(
  storeRoot: string,
  options: SyncOutboxCompactionOptions = {},
): SyncOutboxCompactionResult {
  const state = loadSyncState(storeRoot);
  if (!state)
    throw new SyncStateError(`no ${SYNC_STATE_FILE} in ${storeRoot} — run init-sync first`);
  const staged = readStagedEvents(storeRoot);
  if (staged.malformed > 0) {
    throw new SyncStateError(
      `refusing to compact ${SYNC_OUTBOX_FILE}: ${staged.malformed} malformed line(s)`,
    );
  }
  const acked = new Set(state.ackedEvents);
  const seen = new Set<string>();
  const pending = staged.events.filter((event) => {
    if (acked.has(event.id) || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  const result = {
    before: staged.events.length,
    after: pending.length,
    removed: staged.events.length - pending.length,
    dryRun: options.dryRun === true,
  };
  if (!result.dryRun && result.removed > 0) {
    const content = pending.map((event) => serializeSyncEvent(event)).join('\n');
    (options.write ?? writeJsonAtomic)(
      join(storeRoot, SYNC_OUTBOX_FILE),
      content.length > 0 ? `${content}\n` : '',
    );
  }
  return result;
}

/**
 * Record the ack for one event id in sync-state (D4 ordering law: the durable result — the
 * `putObject` — was already written; bookkeeping comes LAST, so a crash between the two is an
 * at-least-once redelivery deduped by the same `evt:` id). Idempotent. Refuses to run against a
 * store whose sync-state was never initialized (`init-sync` owns the seed).
 */
export function markEventAcked(storeRoot: string, evtId: string): void {
  const state = loadSyncState(storeRoot);
  if (state === undefined) {
    throw new SyncStateError(`no ${SYNC_STATE_FILE} in ${storeRoot} — run init-sync first`);
  }
  if (state.ackedEvents.includes(evtId)) return; // idempotent re-ack
  state.ackedEvents.push(evtId);
  saveSyncState(storeRoot, state);
}
