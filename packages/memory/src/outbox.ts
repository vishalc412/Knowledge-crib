import { buildAttemptEvent } from './attempt.js';
/**
 * The durable capture outbox (G2.2) — the mechanics of the write-ahead queue behind capture.
 *
 * Ordering law (mirrors `activateLocal` in promotion.ts): the DURABLE RESULT is written first and
 * the queue-lifecycle bookkeeping LAST, so every crash window heals as an idempotent no-op:
 *
 *   capture:  outbox upsert (pending)  →  candidate upsert      (crash between → the pending entry
 *                                                                 is re-drained; the re-capture
 *                                                                 re-derives the same `cap:` id)
 *   drain:    distiller's durable result →  markCaptureDone      (crash between → at-least-once
 *                                                                 redelivery; dedupe rides the
 *                                                                 shared `cand:` id)
 *   dead:     dead-entry upsert (dead)   →  outbox removal       (crash between → the entry lives in
 *                                                                 BOTH; reads let `dead` win)
 *
 * The outbox entry is content-addressed (`cap:` — ids.ts) over the capture's SEMANTIC identity only
 * (idempotency key + offsets + claim content), so status transitions happen in place without the id
 * moving. Retries are ATTEMPT-STYLE APPENDS on the existing `attempts` collection (`attemptEventId`
 * seeds the attempt count inside the outcome, so distinct attempts never collide); a dead-letter is
 * a LIFECYCLE TRANSITION to the `dead` collection — never a delete.
 *
 * No wall-clock read anywhere in this module: `now` is always a caller-supplied port, and nothing
 * here feeds an id except the pure `captureEntryId` seed (which excludes timestamps by design).
 */
import { attemptEventId, captureEntryId, memoryShard as shardOf } from './ids.js';
import type { MemoryStore } from './store.js';
import type { AttemptEvent, CaptureOutboxEntry, MemoryScope } from './types.js';

/** How many failed distillation attempts an outbox entry tolerates before dead-lettering. */
export const DEFAULT_MAX_CAPTURE_ATTEMPTS = 3;

/** Everything needed to durably stage one capture (the candidate payload rides along). */
export interface CaptureOutboxInput {
  kind: string;
  subject: string;
  claim: string;
  scope: MemoryScope;
  appliesTo: string[];
  evidence: CaptureOutboxEntry['evidence'];
  authorship: CaptureOutboxEntry['authorship'];
  origin: 'observe' | 'attempt';
  attemptId?: string;
  idempotencyKey?: string;
  sessionId?: string;
  sessionOffset?: number;
  eventOffset?: number;
}

/** Build the outbox entry with its content-addressed id pre-stamped. PURE. */
export function buildCaptureOutboxEntry(
  input: CaptureOutboxInput,
  proposedAt: string,
): CaptureOutboxEntry {
  const id = captureEntryId({
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.sessionOffset !== undefined ? { sessionOffset: input.sessionOffset } : {}),
    ...(input.eventOffset !== undefined ? { eventOffset: input.eventOffset } : {}),
    kind: input.kind,
    subject: input.subject,
    claim: input.claim,
    actor: input.authorship.actor,
  });
  return {
    id,
    schemaVersion: '1',
    kind: input.kind as CaptureOutboxEntry['kind'],
    subject: input.subject,
    claim: input.claim,
    scope: input.scope,
    appliesTo: input.appliesTo,
    evidence: input.evidence,
    authorship: input.authorship,
    origin: input.origin,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.sessionOffset !== undefined ? { sessionOffset: input.sessionOffset } : {}),
    ...(input.eventOffset !== undefined ? { eventOffset: input.eventOffset } : {}),
    status: 'pending',
    proposedAt,
  };
}

/** Read one outbox entry by id (lock-free direct shard read). */
export function readCaptureOutboxEntry(
  store: MemoryStore,
  capId: string,
): CaptureOutboxEntry | undefined {
  const hit = store.readShard('outbox', shardOf(capId)).entries.find((e) => e.id === capId);
  return hit as CaptureOutboxEntry | undefined;
}

/** Read one dead-lettered entry by id. */
export function readDeadCapture(store: MemoryStore, capId: string): CaptureOutboxEntry | undefined {
  const hit = store.readShard('dead', shardOf(capId)).entries.find((e) => e.id === capId);
  return hit as CaptureOutboxEntry | undefined;
}

// shardOf: same 2-hex shard grammar as every collection (memoryShard), aliased for readability.

/**
 * Durable enqueue: upsert the entry into the LOCAL `outbox` collection. Idempotent — the same
 * capture content re-derives the same `cap:` id and upserts byte-identically. A TERMINAL entry
 * (`done`/`dead`) is never clobbered by a re-derive of `pending`: if the existing entry already
 * finished, the enqueue is a no-op and the caller is told the entry's ACTUAL state, so a re-capture
 * racing a drain cannot rewind a completed capture back into the queue.
 */
export function stageCaptureOutboxEntry(
  store: MemoryStore,
  entry: CaptureOutboxEntry,
): { id: string; idempotent: boolean; status: 'pending' | 'done' | 'dead' } {
  const existing = readCaptureOutboxEntry(store, entry.id);
  if (existing && existing.status !== 'pending') {
    return { id: existing.id, idempotent: true, status: existing.status };
  }
  // An existing pending entry keeps its ORIGINAL proposedAt: the id is content-addressed over the
  // semantic seed, so a re-capture re-derives the same id and the upsert must be a BYTE-STABLE
  // no-op (the entry's origin time is when it was FIRST staged — rewriting it would churn the
  // shard bytes and break the ifHash stability of anything fingerprinting the queue).
  const merged = existing !== undefined ? { ...entry, proposedAt: existing.proposedAt } : entry;
  store.upsertEntry('outbox', merged); // write gate: validate + secret-scan
  return { id: merged.id, idempotent: existing !== undefined, status: 'pending' };
}

/**
 * Mark a capture distilled — the LAST step of a successful drain, after the distiller's durable
 * result (its staging entry / receipt) is on disk. Idempotent: marking `done` twice is a no-op, and
 * a crash between the durable result and this call leaves a `pending` entry that redrains into the
 * same content-addressed result (at-least-once, deduped by id). The clock is deliberately absent —
 * nothing here feeds an id, and the entry's `proposedAt` already carries its origin time.
 */
export function markCaptureDone(
  store: MemoryStore,
  capId: string,
  opts: { candidateId?: string } = {},
): CaptureOutboxEntry | undefined {
  const existing = readCaptureOutboxEntry(store, capId);
  if (!existing) return undefined;
  const done: CaptureOutboxEntry = {
    ...existing,
    status: 'done',
    ...(opts.candidateId !== undefined
      ? { meta: { ...existing.meta, candidateId: opts.candidateId } }
      : {}),
  };
  store.upsertEntry('outbox', done);
  return done;
}

/**
 * Record one failed distillation attempt. ATTEMPT-STYLE APPEND: an {@link AttemptEvent} on the
 * existing `attempts` collection with `attemptId` = the `cap:` id (the attempt schema deliberately
 * has no prefix constraint on `attemptId`) and phase `outcome`. The attempt COUNT rides inside
 * `outcome` — part of the `att:` seed — so distinct attempts get distinct content-addressed ids
 * instead of colliding into one. Pure append: the outbox entry itself is untouched (a retry is not
 * yet a terminal transition).
 */
export function recordCaptureRetry(
  store: MemoryStore,
  entry: CaptureOutboxEntry,
  attempt: number,
  reason: string,
  ts: string,
): AttemptEvent {
  const event = buildAttemptEvent({
    id: attemptEventId({
      attemptId: entry.id,
      phase: 'outcome',
      subject: entry.subject,
      outcome: { status: 'failure', attempt, errorFingerprint: reason },
    }),
    attemptId: entry.id,
    phase: 'outcome',
    ts,
    subject: entry.subject,
    outcome: { status: 'failure', attempt, errorFingerprint: reason },
  });
  store.upsertEntry('attempts', event);
  return event;
}

/** The failed-distillation attempt events recorded for one `cap:` id, in attempt order. */
export function captureRetries(store: MemoryStore, capId: string): AttemptEvent[] {
  return (store.readCollection('attempts').entries as AttemptEvent[])
    .filter(
      (e) =>
        e.attemptId === capId &&
        e.phase === 'outcome' &&
        e.outcome?.status === 'failure' &&
        typeof (e.outcome as { attempt?: unknown }).attempt === 'number',
    )
    .sort((a, b) => {
      const an = (a.outcome as unknown as { attempt: number }).attempt;
      const bn = (b.outcome as unknown as { attempt: number }).attempt;
      return an - bn;
    });
}

/** How many failed distillation attempts a `cap:` id has consumed. */
export function captureRetryCount(store: MemoryStore, capId: string): number {
  return captureRetries(store, capId).length;
}

/** Pure retry-limit decision (the distiller asks, this decides — no I/O). */
export function shouldDeadLetterCapture(
  retryCount: number,
  maxAttempts: number = DEFAULT_MAX_CAPTURE_ATTEMPTS,
): boolean {
  return retryCount >= maxAttempts;
}

/**
 * Dead-letter a capture — a LIFECYCLE TRANSITION, never a delete (the team-ledger rule applied to
 * the queue: the entry's history stays readable in the `dead` collection; a future operator can
 * audit WHY a capture never distilled). Crash-safe ordering: the dead-status entry is upserted into
 * `dead` FIRST, then removed from `outbox` — a crash between the two heals idempotently (the next
 * call re-writes the same dead entry; the removal no-ops; readers let `dead` win via
 * {@link pendingCaptures}).
 */
export function deadLetterCapture(
  store: MemoryStore,
  capId: string,
  reason: string,
): { deadLettered: boolean } {
  const existing = readCaptureOutboxEntry(store, capId) ?? readDeadCapture(store, capId);
  if (!existing) return { deadLettered: false };
  const dead: CaptureOutboxEntry = {
    ...existing,
    status: 'dead',
    meta: { ...existing.meta, deadLetterReason: reason },
  };
  store.upsertEntry('dead', dead); // durable terminal state first …
  store.removeEntry('outbox', capId); // … then dequeue (a crash between heals on the next call)
  return { deadLettered: true };
}

/**
 * The drain view: every `pending` outbox entry that is NOT dead-lettered. Dead WINS over outbox —
 * the dead-letter transition writes `dead` before removing from `outbox`, so the crash window
 * between them must not resurrect a dead-lettered capture as work to do. Sorted by id for a
 * deterministic drain order.
 */
export function pendingCaptures(store: MemoryStore): CaptureOutboxEntry[] {
  const deadIds = new Set(
    (store.readCollection('dead').entries as CaptureOutboxEntry[]).map((e) => e.id),
  );
  return (store.readCollection('outbox').entries as CaptureOutboxEntry[])
    .filter((e) => e.status === 'pending' && !deadIds.has(e.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
