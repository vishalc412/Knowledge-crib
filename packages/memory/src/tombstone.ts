/**
 * W5 Slice 2 — the team-promotion tombstone (PRD W5: "tombstone the local copy, don't leave a
 * duplicate").
 *
 * A local `active` record and the team record that promotes it share the SAME content-addressed `mem:`
 * id (the id is blake3 of the claim body, which excludes `trust`/`meta`/`createdAt` — see {@link
 * memoryRecordId}). Once that id is **team-trusted** — present (record + `accept` decision) in the
 * configured trusted Git ref (PRD line 279) — the local copy is redundant: recall would otherwise surface
 * BOTH the team record (trust `team`) and the local record (trust `local`) for the same id, a duplicate
 * the PRD forbids. The tombstone retires the local copy:
 *
 *   1. **remove** the local `active` record (by id), AND
 *   2. **append** a local `supersede` decision (subject = record id, successor = record id — the team
 *      copy is content-identical) recording WHY the local copy vanished, so `crib memory audit` can
 *      explain it. Idempotent by content id (re-tombstoning reproduces the same `dec:` id → no-op
 *      upsert; `removeEntry` is a no-op once the record is gone).
 *
 * **The no-poison rule (critical).** {@link effectiveVerdicts} overlays lifecycle from decisions matched
 * by `d.subject === record.id`, and `supersede` is a terminal transition → `lifecycle: 'superseded'`,
 * which {@link isRecallEligible} EXCLUDES. A local tombstone decision has `subject = recordId` — the SAME
 * id as the team record — so if recall gathered local decisions, the tombstone would mark the team record
 * superseded and drop it from recall (defeating the whole point). Recall therefore deliberately gathers
 * decisions from `team.decisions` + `global.decisions` ONLY (see {@link gatherRecall}); local decisions
 * are audit-only and never enter the recall decision pool. This module's tests pin that invariant.
 *
 * Team records/decisions are NEVER touched here (PRD line 360) — the tombstone operates on the LOCAL
 * store only. PURE selectors + a thin store wrapper.
 */
import { decisionId } from './ids.js';
import type { MemoryStore } from './store.js';
import type { TrustedTeamPresence } from './trusted-ref.js';
import type { MemoryDecision, MemoryRecord } from './types.js';

// ─── pure selectors ───────────────────────────────────────────────────────────

/**
 * True iff `recordId` is team-trusted against the trusted-ref presence (PRD line 279): a trusted ref is
 * configured (`presence !== undefined`) AND the exact `mem:` id is in the ref's record set AND an
 * `accept` decision for it is in the ref's decision set. PURE.
 */
export function isTeamTrustedRecord(
  recordId: string,
  presence: TrustedTeamPresence | undefined,
): boolean {
  return Boolean(presence?.recordIds.has(recordId) && presence?.acceptedRecordIds.has(recordId));
}

/**
 * The local `active` records whose content is now team-trusted — i.e. the records to tombstone. PURE
 * over the local active records + the trusted-ref presence.
 */
export function localRecordsToTombstone(
  localActive: readonly MemoryRecord[],
  presence: TrustedTeamPresence | undefined,
): MemoryRecord[] {
  return localActive.filter((r) => isTeamTrustedRecord(r.id, presence));
}

// ─── thin store wrapper ───────────────────────────────────────────────────────

/** A tombstone result: whether the local active record was removed + the audit decision id. */
export interface TombstoneResult {
  /** true iff the local active record was present and removed (false on a re-run where it was gone). */
  removed: boolean;
  /** the `dec:` id of the tombstone (supersede) decision (idempotent — same id on re-tombstone). */
  decisionId: string;
}

/**
 * Tombstone a local active record whose content is now team-trusted (PRD W5). Removes the local `active`
 * record by id AND appends a local `supersede` decision (subject = record id, successor = record id)
 * recording the tombstone. Idempotent: re-tombstoning reproduces the same `dec:` id (no-op upsert) and
 * `removeEntry` is a no-op once the record is gone. NEVER touches the team store (PRD line 360).
 *
 * The decision is AUDIT-ONLY — recall does not gather local decisions, so it cannot poison the same-id
 * team record (see the module header's no-poison rule).
 */
export function tombstoneLocalForTeamPromotion(
  local: MemoryStore,
  recordId: string,
  actor: string,
  now: () => string,
): TombstoneResult {
  const reason = 'promoted to team trust — local copy tombstoned (W5 Slice 2)';
  const decision: MemoryDecision = {
    id: decisionId({ kind: 'supersede', subject: recordId, successor: recordId, actor, reason }),
    schemaVersion: '1',
    kind: 'supersede',
    subject: recordId,
    successor: recordId,
    actor,
    reason,
    ts: now(),
  };
  local.upsertEntry('decisions', decision);
  const removed = local.removeEntry('active', recordId);
  return { removed, decisionId: decision.id };
}
