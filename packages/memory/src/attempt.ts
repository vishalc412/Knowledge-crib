/**
 * W5 Slice 1 — the structured attempt-lifecycle recorder + compaction + unpromoted-attempt GC
 * (PRD lines 354–360).
 *
 * An *attempt* is the lifecycle of one agent action that may produce a memory: it moves through the
 * phases `start → observation → action → outcome → candidate → evaluation → promotion → compaction`
 * (PRD line 354). Each phase is one immutable, content-addressed {@link AttemptEvent} (`att:`) in the
 * LOCAL store's `attempts` collection. The events are the crash trail (PRD line 348: a crash after the
 * shared write but before cleanup leaves a resumable trail); on SUCCESS the trail is compacted to a
 * single `compaction` summary (PRD line 359: "compact successful attempts immediately").
 *
 * What an attempt NEVER carries (PRD line 355 + W5 exit gate): raw prompts, transcripts, model
 * chain-of-thought, or raw command output — only structured summaries, file/target refs, error
 * fingerprints, and receipt ids (enforced by {@link StructuredSummary} + the sanitized {@link GateReceipt}).
 *
 * Failed / unevaluated attempts never enter recall: their candidate stays in `candidates` (trust
 * `candidate`, excluded by `isRecallEligible`) and their events stay in `attempts` (not a recall
 * collection) until GC reaps unpromoted attempts older than 30 days (PRD line 359). Team records and
 * decisions are NEVER garbage-collected (PRD line 360) — this module only touches the LOCAL store.
 *
 * PURE core + thin store wrappers: the pure functions operate over `AttemptEvent[]` so they are
 * unit-testable without a real store; {@link appendAttemptEvent} / {@link compactAttempt} /
 * {@link gcUnpromotedAttempts} are the thin store-coupled wrappers the CLI calls.
 */
import type { AttemptPhase } from './enums.js';
import type { MemoryStore } from './store.js';
import type { AttemptEvent, AttemptOutcome, StructuredSummary } from './types.js';

// ─── pure core ───────────────────────────────────────────────────────────────

/** The events of one attempt, in phase order. */
export function attemptEventsFor(
  events: readonly AttemptEvent[],
  attemptId: string,
): AttemptEvent[] {
  return events.filter((e) => e.attemptId === attemptId);
}

/** True iff an attempt has a `promotion` phase event (it reached team/local promotion). */
export function isAttemptPromoted(events: readonly AttemptEvent[], attemptId: string): boolean {
  return events.some((e) => e.attemptId === attemptId && e.phase === 'promotion');
}

/**
 * The newest event timestamp for an attempt (lexicographic max of ISO `ts`). `undefined` if the
 * attempt has no events — used to decide whether an unpromoted attempt is old enough to GC.
 */
export function attemptLastActivity(
  events: readonly AttemptEvent[],
  attemptId: string,
): string | undefined {
  let newest: string | undefined;
  for (const e of events) {
    if (e.attemptId !== attemptId) continue;
    if (newest === undefined || e.ts > newest) newest = e.ts;
  }
  return newest;
}

/**
 * The attempt ids (from a flat event list) that are UNPROMOTED (no `promotion` event) AND whose last
 * activity is older than `maxAgeMs` (PRD line 359: "garbage-collect unpromoted attempts after 30 days
 * by default"). Promoted attempts are never reaped (their compaction summary is a reusable success);
 * an attempt with no events is ignored. PURE.
 */
export function unpromotedAttemptIds(
  events: readonly AttemptEvent[],
  maxAgeMs: number,
  now: string,
): string[] {
  const byAttempt = new Map<string, string>(); // attemptId → newest ts
  const promoted = new Set<string>();
  for (const e of events) {
    if (e.phase === 'promotion') promoted.add(e.attemptId);
    const prev = byAttempt.get(e.attemptId);
    if (prev === undefined || e.ts > prev) byAttempt.set(e.attemptId, e.ts);
  }
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) return [];
  const cutoff = nowMs - maxAgeMs;
  const reaped: string[] = [];
  for (const [attemptId, newest] of byAttempt) {
    if (promoted.has(attemptId)) continue;
    const t = Date.parse(newest);
    if (Number.isNaN(t)) continue;
    if (t < cutoff) reaped.push(attemptId);
  }
  return reaped.sort();
}

/**
 * Compact an attempt: return the event list with every event for `attemptId` REMOVED except the
 * supplied `compaction` event (which is added/kept). PRD line 359: "compact successful attempts
 * immediately" — the start/observation/action/outcome/candidate/evaluation/promotion trail collapses
 * to one structured summary. PURE (the caller persists the diff via {@link compactAttempt}).
 */
export function compactAttemptEvents(
  events: readonly AttemptEvent[],
  attemptId: string,
  compaction: AttemptEvent,
): AttemptEvent[] {
  const next = events.filter((e) => e.attemptId !== attemptId);
  next.push(compaction);
  return next;
}

// ─── event builders (structured-only; never raw prose) ───────────────────────

/** Build an {@link AttemptEvent} with its content-addressed id pre-stamped. PURE. */
export function buildAttemptEvent(input: {
  id: string;
  attemptId: string;
  phase: AttemptPhase;
  ts: string;
  subject?: string;
  observation?: StructuredSummary;
  action?: StructuredSummary;
  outcome?: AttemptOutcome;
  candidateId?: string;
  evaluationId?: string;
  meta?: Record<string, unknown>;
}): AttemptEvent {
  return {
    id: input.id,
    schemaVersion: '1',
    attemptId: input.attemptId,
    phase: input.phase,
    ts: input.ts,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.observation !== undefined ? { observation: input.observation } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
    ...(input.evaluationId !== undefined ? { evaluationId: input.evaluationId } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
}

// ─── thin store wrappers ─────────────────────────────────────────────────────

/** Append one attempt event to the LOCAL store's `attempts` collection (validates on write). */
export function appendAttemptEvent(store: MemoryStore, event: AttemptEvent): void {
  store.upsertEntry('attempts', event);
}

/**
 * Compact an attempt in the LOCAL store: remove every `attempts` event for `attemptId` and write the
 * single `compaction` event (PRD line 359). The intermediate crash-trail events are deleted; only the
 * structured compaction summary remains. Reads + removes are lock-free (`readCollection` /
 * `removeEntry`); the compaction event is upserted last so a crash mid-compaction leaves the trail
 * intact (the next compaction re-runs idempotently).
 */
export function compactAttempt(
  store: MemoryStore,
  attemptId: string,
  compaction: AttemptEvent,
): { removed: number } {
  const events = store.readCollection('attempts').entries as AttemptEvent[];
  const mine = attemptEventsFor(events, attemptId);
  let removed = 0;
  for (const e of mine) {
    if (e.id === compaction.id) continue; // the compaction event itself is (re)written below
    if (store.removeEntry('attempts', e.id)) removed += 1;
  }
  store.upsertEntry('attempts', compaction);
  return { removed };
}

/**
 * Garbage-collect UNPROMOTED attempts older than `maxAgeMs` from the LOCAL store (PRD line 359).
 * Removes every `attempts` event for each reaped attempt id AND the candidate it produced (if any, by
 * `candidateId` carried on a `candidate`-phase event). NEVER touches team records/decisions (PRD line
 * 360) — this operates on the local store only. Returns the reaped attempt ids + removed candidate ids.
 */
export function gcUnpromotedAttempts(
  store: MemoryStore,
  maxAgeMs: number,
  now: string,
): { reapedAttempts: string[]; removedCandidateIds: string[] } {
  const events = store.readCollection('attempts').entries as AttemptEvent[];
  const reaped = unpromotedAttemptIds(events, maxAgeMs, now);
  const removedCandidateIds: string[] = [];
  for (const attemptId of reaped) {
    const mine = attemptEventsFor(events, attemptId);
    for (const e of mine) {
      store.removeEntry('attempts', e.id);
      if (e.phase === 'candidate' && e.candidateId) {
        if (store.removeEntry('candidates', e.candidateId)) removedCandidateIds.push(e.candidateId);
      }
    }
  }
  return { reapedAttempts: reaped, removedCandidateIds };
}
