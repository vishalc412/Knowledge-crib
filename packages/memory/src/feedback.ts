import type { EvidenceKind, MemoryRecordKind } from './enums.js';
/**
 * W5 Slice 3 — contradicted-feedback suppression (PRD W5 line 361):
 *
 *   "Make `contradicted` feedback suppress the record locally only when supported by admissible
 *    counter-evidence; otherwise apply a bounded penalty and surface it for review."
 *
 * and PRD line 242 (`memory_feedback`): "Writes a local feedback event; one negative event cannot
 * retract team memory."
 *
 * A `contradicted` feedback signal is a LOCAL assertion that a record's claim is wrong. On its own it
 * is a single negative event — it does NOT retract team memory (PRD line 242) and it does NOT, by
 * itself, suppress anything: it only nudges ranking via the bounded feedback adjustment in
 * {@link recallProjection} (±{@link DEFAULT_FEEDBACK_BOUND}). Suppression (quarantine — exclusion from
 * normal recall, NOT deletion) requires ADMISSIBLE COUNTER-EVIDENCE: at least one counter-evidence
 * item whose kind is admissible for the record's claim kind (PRD §2 matrix — {@link admissibleFor}) AND
 * whose independent check verdict is `valid`. With admissible+valid counter-evidence the local record
 * is quarantined LOCALLY; without it the record stays recall-eligible, takes the bounded penalty, and
 * is surfaced for review (`crib memory audit` / `memory_audit` list it as `contradictedForReview`).
 *
 * **Local-only (the no-poison rule).** The quarantine decision is written to the LOCAL `decisions`
 * collection ONLY — never team, never global. {@link gatherRecall} gathers local decisions into a
 * separate `localDecisions` pool that {@link recallProjection} folds into a record's effective verdicts
 * ONLY when the record's source is `local`. A team record sharing the same content-addressed `mem:` id
 * therefore never sees the local quarantine → team memory is not retracted by one local negative event.
 * This module's tests pin that invariant.
 *
 * PURE selectors + a thin store wrapper. No IO of its own in the selectors; the wrapper writes the
 * feedback event (always) and, on suppression, the local quarantine decision.
 */
import { admissibleFor } from './evaluator.js';
import { decisionId, feedbackId } from './ids.js';
import type { MemoryStore } from './store.js';
import type { MemoryDecision, MemoryEvidence, MemoryFeedback } from './types.js';

// ─── admissible counter-evidence ──────────────────────────────────────────────

/**
 * True iff `evidence` is ADMISSIBLE COUNTER-EVIDENCE for a claim of `claimKind`: its kind is in the
 * PRD §2 admissibility matrix for that claim kind ({@link admissibleFor}) AND its independent check
 * verdict is `valid` (a `degraded`/`invalid`/`orphaned` item does not support suppression — PRD W5 line
 * 361 requires "admissible counter-evidence", and admissibility at revalidation requires a valid
 * anchor). PURE.
 */
export function isAdmissibleCounterEvidence(
  evidence: MemoryEvidence,
  claimKind: MemoryRecordKind,
): boolean {
  return evidence.verdict === 'valid' && admissibleFor(evidence.kind as EvidenceKind, claimKind);
}

/**
 * True iff ANY item in `counterEvidence` is admissible counter-evidence for `claimKind` (PRD W5 line
 * 361: suppression requires "supported by admissible counter-evidence"). PURE.
 */
export function hasAdmissibleCounterEvidence(
  counterEvidence: readonly MemoryEvidence[],
  claimKind: MemoryRecordKind,
): boolean {
  return counterEvidence.some((e) => isAdmissibleCounterEvidence(e, claimKind));
}

// ─── the suppression verdict (pure) ───────────────────────────────────────────

/** The record being contradicted (only its id + claim kind drive the suppression verdict). */
export interface ContradictedRecord {
  id: string;
  kind: MemoryRecordKind;
}

/** Input to {@link contradictedSuppression}. */
export interface ContradictedSuppressionInput {
  /** the record the `contradicted` feedback is about. */
  record: ContradictedRecord;
  /** the `contradicted` feedback event (signal must be `contradicted`). */
  feedback: MemoryFeedback;
  /** counter-evidence supporting the contradiction (admissibility checked per item). */
  counterEvidence: readonly MemoryEvidence[];
  /** who is recording the quarantine decision (defaults to the feedback actor). */
  actor?: string;
  /** the canonical "now" used for the decision `ts` (the decision id excludes `ts` → idempotent). */
  now: () => string;
  /**
   * The sync-staging port (ADR-003 D3/D4): when supplied, each store write this wrapper performs
   * is staged for cross-device sync INSIDE the same lock hold — a `feedback.append` event for the
   * feedback row, and (on suppression) a `decision.append` event for the quarantine decision.
   * Callers inject it by closing over {@link stageSyncableWrite} with their principal/env — the
   * memory package stays pure over the port, mirroring the backend ports. Without the port the
   * writes stay local-only (the push sweep still heals them on the next push).
   */
  syncStage?: {
    stageWrite(collection: 'decisions' | 'feedback', entry: MemoryFeedback | MemoryDecision): void;
  };
}

/**
 * The suppression verdict for a `contradicted` feedback event (PRD W5 line 361). PURE over the input.
 *
 * - `suppress: true` — admissible+valid counter-evidence exists → a LOCAL `quarantine` decision
 *   (subject = record id) that {@link effectiveVerdicts} folds into the local record's effective
 *   verdicts (`quarantined: true` → {@link isRecallEligible} excludes it). The decision id is
 *   content-addressed ({@link decisionId} excludes `ts`/`meta`) → re-suppression is an idempotent
 *   upsert. NEVER written to team/global by this function (the wrapper writes local-only).
 * - `suppress: false, surfacedForReview: true` — no admissible counter-evidence → the record is NOT
 *   suppressed; it keeps the bounded feedback penalty ({@link recallProjection}) and is surfaced for
 *   review by `memory_audit` / `crib memory audit` (a `contradicted` feedback whose subject is not
 *   quarantined). `reason` explains why suppression did not fire.
 */
export type ContradictedSuppression =
  | { suppress: true; decision: MemoryDecision }
  | { suppress: false; surfacedForReview: true; reason: string };

const QUARANTINE_REASON =
  'contradicted by admissible counter-evidence (W5 Slice 3 local quarantine)';

/**
 * Decide whether a `contradicted` feedback suppresses (quarantines) its record locally (PRD W5 line
 * 361). Returns the quarantine decision to write when suppressing, or a surfaced-for-review signal
 * otherwise. PURE (no store mutation — the {@link applyContradictedFeedback} wrapper does the writes).
 */
export function contradictedSuppression(
  input: ContradictedSuppressionInput,
): ContradictedSuppression {
  const { record, feedback, counterEvidence, now } = input;
  if (feedback.signal !== 'contradicted') {
    // A non-contradicted signal never suppresses — it is just a bounded feedback nudge.
    return {
      suppress: false,
      surfacedForReview: true,
      reason: `signal '${feedback.signal}' is not 'contradicted' — no suppression, bounded feedback only`,
    };
  }
  if (hasAdmissibleCounterEvidence(counterEvidence, record.kind)) {
    const actor = input.actor ?? feedback.actor;
    const decision: MemoryDecision = {
      id: decisionId({
        kind: 'quarantine',
        subject: record.id,
        actor,
        reason: QUARANTINE_REASON,
      }),
      schemaVersion: '1',
      kind: 'quarantine',
      subject: record.id,
      actor,
      reason: QUARANTINE_REASON,
      ts: now(),
    };
    return { suppress: true, decision };
  }
  return {
    suppress: false,
    surfacedForReview: true,
    reason:
      'contradicted feedback without admissible+valid counter-evidence — bounded penalty applied, surfaced for review',
  };
}

// ─── thin store wrapper ───────────────────────────────────────────────────────

/** What {@link applyContradictedFeedback} did: the feedback id (always written) + the suppression verdict. */
export interface ApplyContradictedFeedbackResult {
  /** the `fb:` id of the recorded feedback event (idempotent — same content → same id). */
  feedbackId: string;
  /** whether the record was quarantined locally + the audit decision id, or surfaced for review. */
  suppression: ContradictedSuppression;
}

/**
 * Record a local feedback event and, when it is a `contradicted` signal supported by admissible
 * counter-evidence, quarantine the record LOCALLY (PRD W5 line 361 + line 242). The feedback event is
 * ALWAYS written to `local.feedback` (content-addressed → idempotent). When suppressing, the local
 * `quarantine` decision is written to `local.decisions` (idempotent; LOCAL-ONLY — never team/global,
 * so one negative event cannot retract team memory). The record itself is NOT deleted (quarantine is
 * exclusion-from-recall, not removal — the record stays for audit/review).
 *
 * PURE verdict via {@link contradictedSuppression}; this wrapper performs the store writes. `now`
 * stamps the feedback `ts` + the decision `ts` (the ids exclude `ts` → both are idempotent).
 */
export function applyContradictedFeedback(
  local: MemoryStore,
  input: ContradictedSuppressionInput,
): ApplyContradictedFeedbackResult {
  const fbId = feedbackId({
    signal: input.feedback.signal,
    subject: input.feedback.subject,
    actor: input.feedback.actor,
    context: input.feedback.context,
  });
  const feedback: MemoryFeedback = {
    id: fbId,
    schemaVersion: '1',
    signal: input.feedback.signal,
    subject: input.feedback.subject,
    actor: input.feedback.actor,
    ...(input.feedback.context ? { context: input.feedback.context } : {}),
    ts: input.now(),
    ...(input.feedback.meta ? { meta: input.feedback.meta } : {}),
  };
  // The verdict is computed FIRST (pure) so the lock hold covers only the writes + their sync
  // stages — the store write and its sidecar stage are ONE lock hold (ADR-003 D4).
  const suppression = contradictedSuppression(input);
  local.withLock(() => {
    local.upsertEntry('feedback', feedback);
    input.syncStage?.stageWrite('feedback', feedback);
    if (suppression.suppress) {
      // LOCAL-ONLY quarantine decision (no-poison: recall folds local decisions into local records only).
      local.upsertEntry('decisions', suppression.decision);
      input.syncStage?.stageWrite('decisions', suppression.decision);
    }
  });
  return { feedbackId: fbId, suppression };
}

// ─── audit surfacing (pure) ───────────────────────────────────────────────────

/**
 * The contradicted feedback events whose subject record is NOT quarantined — i.e. the records
 * SURFACED FOR REVIEW (PRD W5 line 361: "surface it for review"). A `contradicted` feedback whose
 * subject was quarantined is already suppressed (not "for review"); a `contradicted` feedback whose
 * subject is still recall-eligible took only the bounded penalty and awaits admissible counter-evidence.
 *
 * PURE over the local feedback + the set of quarantined record ids (the ids a `quarantine` decision
 * was applied to). Returns the feedback events to surface, deduped by subject.
 */
export function contradictedForReview(
  localFeedback: readonly MemoryFeedback[],
  quarantinedIds: ReadonlySet<string>,
): MemoryFeedback[] {
  const seen = new Set<string>();
  const out: MemoryFeedback[] = [];
  for (const fb of localFeedback) {
    if (fb.signal !== 'contradicted') continue;
    if (quarantinedIds.has(fb.subject)) continue; // already suppressed — not "for review"
    if (seen.has(fb.subject)) continue; // dedupe by subject (one review row per record)
    seen.add(fb.subject);
    out.push(fb);
  }
  return out;
}

// ─── helpers for callers ──────────────────────────────────────────────────────

/** The set of record ids a `quarantine` decision has been applied to (PURE over the decisions). */
export function quarantinedRecordIds(decisions: readonly MemoryDecision[]): Set<string> {
  const ids = new Set<string>();
  for (const d of decisions) {
    if (d.kind === 'quarantine') ids.add(d.subject);
  }
  return ids;
}
