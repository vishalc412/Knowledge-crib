/**
 * ADR-003 (Gate 4) D10 — the sync admission matrix. Pure, table-driven, no I/O: which entries may
 * leave the device, per target class. Ambiguous policy is a REFUSAL, not a warning — an unknown
 * retention-policy id means no committed schedule governs the record's handling, and refusing is
 * the honest posture (D10: "ambiguous policy is a refusal, not a warning").
 *
 * The only refusal class that ABORTS a run is a secret-scan hit (D10); an admission refusal merely
 * skips that event and is reported.
 */
import { visibilityOf } from '../api.js';
import { DEFAULT_RETENTION_POLICY_ID } from '../migrations.js';
import { isMemoryRecordVersioned } from '../types.js';
import type { MemoryVisibility } from '../types.js';
import { verifyPayloadId } from './event.js';

/** The sync target classes (D10). `git-shard` is a later gate's adapter — the class exists so the
 *  filter matrix is complete and testable now. */
export type SyncTargetClass = 'git-shard' | 'encrypted-remote';

/** Typed refusal reasons (reported per event; never a warning). */
export type SyncAdmissionReason =
  | 'id-derivation'
  | 'private-visibility'
  | 'sensitivity'
  | 'ambiguous-policy';

export interface SyncAdmission {
  admitted: boolean;
  reason?: SyncAdmissionReason;
}

/**
 * The retention ids any code actually issues today. `migrations.ts` owns the constant (policy.ts
 * holds gate profiles, not retention schedules — no committed retention registry exists yet), so an
 * id outside this set is AMBIGUOUS: nobody can yet say whether it is git-eligible or remote-safe,
 * and D10 refuses rather than guessing.
 */
const KNOWN_RETENTION_POLICY_IDS: readonly string[] = [DEFAULT_RETENTION_POLICY_ID];

// The admission matrix (D10), table-driven so every cell is reviewable against the ADR text.
const GIT_SHARD_VISIBILITY: readonly MemoryVisibility[] = ['workspace'];
const GIT_SHARD_SENSITIVITY: readonly string[] = ['public', 'internal'];
const REMOTE_VISIBILITY: readonly MemoryVisibility[] = ['private', 'workspace'];
const REMOTE_SENSITIVITY: readonly string[] = ['public', 'internal', 'confidential'];

/**
 * A record's semantic visibility — exactly `visibilityOf`'s semantics (memory-2 carries the field;
 * memory-1 derives 'workspace', a memory-store record was shared within its scope by construction).
 * Reused rather than re-implemented so the sync filter and the read paths can never drift.
 */
function visibilityOfEntry(entry: { id: string }): MemoryVisibility {
  return visibilityOf(entry as unknown as Parameters<typeof visibilityOf>[0]);
}

/**
 * A record's sensitivity: memory-2 carries it; memory-1 has no field, so it derives the same way
 * `visibilityOf`'s memory-1 mapping does — a record that was ADMITTED to a memory store was
 * workspace-visible, and its handling class is the non-restricted default ('internal'). Documented
 * derivation, never a per-call guess.
 */
function sensitivityOfEntry(entry: { id: string }): string {
  const rec = entry as unknown as Record<string, unknown>;
  if (isMemoryRecordVersioned(rec)) return rec.sensitivity as string;
  return 'internal';
}

/**
 * A record's governing retention id: memory-2 carries it; memory-1 records were written before the
 * field existed, so the migration's default (the only id any writer issues today) applies.
 */
function retentionPolicyIdOfEntry(entry: { id: string }): string {
  const rec = entry as unknown as Record<string, unknown>;
  if (isMemoryRecordVersioned(rec) && typeof rec.retentionPolicyId === 'string') {
    return rec.retentionPolicyId as string;
  }
  return DEFAULT_RETENTION_POLICY_ID;
}

/**
 * The pure admission decision (D10).
 *
 *   - `git-shard`      admits a record iff visibility is 'workspace', sensitivity is public/internal,
 *                      and the retention id is a KNOWN git-eligible id (else 'ambiguous-policy').
 *                      Private memory never enters Git — the whole point of the gate.
 *   - `encrypted-remote` admits iff visibility is private/workspace, sensitivity is up to
 *                      'confidential' (never 'restricted'), and the retention id is known.
 *
 * Both classes additionally refuse on an id-derivation mismatch (D8 step 2: a payload whose content
 * id does not re-derive from its own bytes is refused, not synced). A `dec:`/`fb:` payload is a
 * LIFECYCLE or feedback event keyed on its subject record: its own admission rides the record's
 * record.upsert event, and a tombstone must always be able to sync (blocking a retract would
 * strand a private claim across devices), so non-record payloads are admitted here.
 */
export function admissionForSync(
  entry: { id: string },
  targetClass: SyncTargetClass,
): SyncAdmission {
  // D8 step 2 — a payload whose declared id does not re-derive from its bytes is refused outright.
  if (!verifyPayloadId(entry).ok) return { admitted: false, reason: 'id-derivation' };
  if (entry.id.startsWith('intake:')) {
    const intake = entry as unknown as { sensitivity?: string; retentionPolicyId?: string };
    if (
      typeof intake.retentionPolicyId !== 'string' ||
      !KNOWN_RETENTION_POLICY_IDS.includes(intake.retentionPolicyId)
    ) {
      return { admitted: false, reason: 'ambiguous-policy' };
    }
    const allowed = targetClass === 'git-shard' ? GIT_SHARD_SENSITIVITY : REMOTE_SENSITIVITY;
    if (typeof intake.sensitivity !== 'string' || !allowed.includes(intake.sensitivity)) {
      return { admitted: false, reason: 'sensitivity' };
    }
    return { admitted: true };
  }
  if (!entry.id.startsWith('mem:')) return { admitted: true };
  const visibility = visibilityOfEntry(entry);
  const sensitivity = sensitivityOfEntry(entry);
  const retentionPolicyId = retentionPolicyIdOfEntry(entry);
  const known = KNOWN_RETENTION_POLICY_IDS.includes(retentionPolicyId);
  if (!known) return { admitted: false, reason: 'ambiguous-policy' };
  if (targetClass === 'git-shard') {
    if (visibility !== 'workspace') return { admitted: false, reason: 'private-visibility' };
    if (!GIT_SHARD_SENSITIVITY.includes(sensitivity)) {
      return { admitted: false, reason: 'sensitivity' };
    }
    return { admitted: true };
  }
  if (!REMOTE_VISIBILITY.includes(visibility) || !REMOTE_SENSITIVITY.includes(sensitivity)) {
    return { admitted: false, reason: 'sensitivity' };
  }
  return { admitted: true };
}
