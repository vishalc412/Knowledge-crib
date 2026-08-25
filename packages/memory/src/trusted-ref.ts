/**
 * W4 Slice 3 — trusted-ref derivation + the `crib memory check` CI gate (PRD lines 250–280, 340–350).
 *
 * Team trust is NOT a claim an agent can stamp — it is **derived** from exact record + decision blobs
 * being present in a configured trusted Git ref (PRD line 279: "Team trust is derived from exact record
 * and decision blobs being present in a configured trusted Git ref. Default to
 * `refs/remotes/origin/HEAD`"). This module is the PURE core: given the merge-base policy, the PR
 * policy, the trusted ref's record/decision ids, and the PR's team records/decisions/receipts, it
 * produces the check report. The git I/O (merge-base, `git show <ref>:<path>`, `ls-tree`) lives in the
 * CLI — this module never shells out, so it is unit-testable without a repo.
 *
 * The check enforces the W4 exit gate (PRD line 350):
 *   - an untrusted PR cannot inject or alter a command CI executes → the self-authoring guard
 *     (a policy-changing PR cannot authorize memories introduced by the same PR; PRD line 276);
 *   - an agent cannot self-assert a pass → team records with `invalid` evidence are refused (PRD 346);
 *   - branch-only memory is not team-trusted → a record absent from the trusted ref is `pending`, never
 *     `already-trusted` (PRD line 279);
 *   - exact merged records become team-trusted without a cloud service → a record whose exact id is in
 *     the trusted ref's record set + has an accept decision in the trusted ref is `already-trusted`.
 */
import { type MemoryPolicy, policyHash } from './policy.js';
import type { GateReceipt, MemoryRecord } from './types.js';

// ─── trusted-ref presence ────────────────────────────────────────────────────

/** Why a team record is or is not trusted against the trusted ref. */
export type TeamTrustReason =
  | 'present' // exact record id + accept decision both in the trusted ref → trusted
  | 'record-absent' // record id not in the trusted ref → branch-only, pending
  | 'decision-absent' // record present but its accept decision is not → incomplete, pending
  | 'no-trusted-ref'; // no trusted ref configured → pending (PRD: never implicitly trusted)

/** A per-record trusted-ref verdict. */
export interface TeamTrustVerdict {
  id: string;
  trusted: boolean;
  reason: TeamTrustReason;
}

/**
 * The subject-indexed form the CLI builds from the trusted ref: which record ids have an `accept`
 * decision whose `subject` is the record id. This is the unambiguous trusted-ref predicate (PRD line
 * 279: "exact record AND decision blobs").
 */
export interface TrustedTeamPresence {
  /** record ids present in the trusted ref's team records shards. */
  recordIds: Set<string>;
  /** record ids that ALSO have an `accept` decision (subject === record id) in the trusted ref. */
  acceptedRecordIds: Set<string>;
}

/**
 * Derive team trust for a set of team records against the trusted ref (PRD line 279). A record is
 * `trusted` iff (a) a trusted ref is configured AND (b) its exact `mem:` id is in the ref's record set
 * AND (c) an `accept` decision for it is in the ref's decision set. Otherwise it is pending
 * (`trusted:false`). `undefined` presence ⇒ no trusted ref ⇒ every record is `no-trusted-ref` pending.
 */
export function deriveTeamTrust(
  records: MemoryRecord[],
  presence: TrustedTeamPresence | undefined,
): TeamTrustVerdict[] {
  if (!presence) {
    return records.map((r) => ({ id: r.id, trusted: false, reason: 'no-trusted-ref' }));
  }
  return records.map((r) => {
    if (!presence.recordIds.has(r.id)) {
      return { id: r.id, trusted: false, reason: 'record-absent' };
    }
    if (!presence.acceptedRecordIds.has(r.id)) {
      return { id: r.id, trusted: false, reason: 'decision-absent' };
    }
    return { id: r.id, trusted: true, reason: 'present' };
  });
}

// ─── the CI check gate ───────────────────────────────────────────────────────

/** One team record's check outcome. */
export interface CheckedRecord {
  id: string;
  /** `already-trusted` (in the trusted ref), `newly-proposed` (pending until merge), or `refused`. */
  status: 'already-trusted' | 'newly-proposed' | 'refused';
  reason: string;
}

/** The `crib memory check` report (PRD lines 275–280, 350). */
export interface MemoryCheckReport {
  /** the merge-base policy hash (the trusted policy CI loads — never the PR version). */
  mergeBasePolicyHash: string | undefined;
  /** the PR's policy hash (the untrusted working-tree policy). */
  prPolicyHash: string | undefined;
  /** true iff the PR changes the policy vs the merge base (self-authoring guard trigger). */
  policyChanged: boolean;
  /** true iff no trusted ref is configured / resolvable (committed memories remain pending). */
  withoutTrustedRef: boolean;
  checked: number;
  alreadyTrusted: number;
  newlyProposed: number;
  refused: number;
  /** record ids whose receipt pins the PR-introduced policy (PRD line 276 self-authoring violation). */
  selfAuthoringViolations: string[];
  /** team records missing a gating receipt (no `meta.receiptId` resolvable to a receipt). */
  missingReceipts: string[];
  perRecord: CheckedRecord[];
  /** human-readable violation lines (empty ⇒ gate passes). */
  violations: string[];
  /** true iff the gate passes (no violations). */
  ok: boolean;
}

/** Inputs to {@link runMemoryCheck}. All git I/O is resolved by the CLI before calling. */
export interface MemoryCheckContext {
  /** the trusted-base policy at the merge base (PRD line 275). `undefined` if absent at merge base. */
  mergeBasePolicy: MemoryPolicy | undefined;
  /** the PR's policy (working tree). `undefined` if the PR has no policy. */
  prPolicy: MemoryPolicy | undefined;
  /** trusted-ref presence (undefined ⇒ no trusted ref configured → all team records pending). */
  presence: TrustedTeamPresence | undefined;
  /** the PR's team records (records claiming `trust: 'team'`). */
  records: MemoryRecord[];
  /** receipts referenced by the proposals (team + local), keyed by id. */
  receipts: Map<string, GateReceipt>;
}

/**
 * Run the CI check gate over the PR's team proposals (PRD W4 exit gate, line 350). PURE — no git, no
 * model. The caller (CLI) resolves the merge-base policy, the trusted-ref presence, and the receipts,
 * then this function decides:
 *
 *   - **already-trusted**: the record's exact id (+ accept decision) is in the trusted ref → idempotent
 *     re-proposal, no further validation needed (PRD line 347 idempotence).
 *   - **newly-proposed**: the record is NOT in the trusted ref → pending until the PR merges; it MUST
 *     carry admissible evidence (`verdicts.evidence !== 'invalid'`) + a gating receipt whose
 *     `policyHash` is the MERGE-BASE policy hash. A receipt pinning the PR's (changed) policy is a
 *     self-authoring violation (PRD line 276). A missing receipt is a hard violation (PRD line 346).
 *   - **refused**: the record's evidence is `invalid` → an agent cannot self-assert a pass (PRD 346).
 *
 * The gate passes (`ok:true`) iff there are no self-authoring violations, no missing receipts, and no
 * refused records. `withoutTrustedRef` is reported but does NOT fail the gate (the repo simply has no
 * team-trusted memory yet — PRD line 279: memories "remain pending rather than being trusted implicitly").
 */
export function runMemoryCheck(ctx: MemoryCheckContext): MemoryCheckReport {
  const mergeBasePolicyHash = ctx.mergeBasePolicy ? policyHash(ctx.mergeBasePolicy) : undefined;
  const prPolicyHash = ctx.prPolicy ? policyHash(ctx.prPolicy) : undefined;
  const policyChanged =
    mergeBasePolicyHash !== undefined || prPolicyHash !== undefined
      ? mergeBasePolicyHash !== prPolicyHash
      : false;
  const withoutTrustedRef = ctx.presence === undefined;

  const selfAuthoringViolations: string[] = [];
  const missingReceipts: string[] = [];
  const perRecord: CheckedRecord[] = [];
  let alreadyTrusted = 0;
  let newlyProposed = 0;
  let refused = 0;

  for (const r of ctx.records) {
    // only team-trust records are in scope for the check
    if (r.verdicts.trust !== 'team') continue;
    const inRef = ctx.presence?.recordIds.has(r.id) && ctx.presence.acceptedRecordIds.has(r.id);
    if (inRef) {
      alreadyTrusted++;
      perRecord.push({ id: r.id, status: 'already-trusted', reason: 'present in trusted ref' });
      continue;
    }
    // newly-proposed (or refused) — validate admissibility + receipt + self-authoring guard
    if (r.verdicts.evidence === 'invalid') {
      refused++;
      perRecord.push({
        id: r.id,
        status: 'refused',
        reason: 'invalid evidence — an agent cannot self-assert a pass (PRD line 346)',
      });
      continue;
    }
    // the gating receipt id is stamped on the activated record's meta at activation time
    const receiptId =
      typeof r.meta?.receiptId === 'string' ? (r.meta.receiptId as string) : undefined;
    const receipt = receiptId ? ctx.receipts.get(receiptId) : undefined;
    if (!receiptId || !receipt) {
      missingReceipts.push(r.id);
      perRecord.push({
        id: r.id,
        status: 'newly-proposed',
        reason: 'missing gating receipt (meta.receiptId unresolved)',
      });
      continue;
    }
    // self-authoring guard (PRD line 276): a policy-changing PR cannot authorize memories introduced
    // by the same PR. The receipt MUST pin the merge-base policy, not the PR-introduced policy.
    if (
      policyChanged &&
      prPolicyHash !== undefined &&
      receipt.policyHash === prPolicyHash &&
      receipt.policyHash !== mergeBasePolicyHash
    ) {
      selfAuthoringViolations.push(r.id);
      perRecord.push({
        id: r.id,
        status: 'newly-proposed',
        reason:
          'self-authoring violation — receipt pins the PR-introduced policy (PRD line 276): a policy-changing PR cannot authorize memories introduced by the same PR',
      });
      continue;
    }
    // if the receipt pins an unknown policy (neither merge-base nor PR) → violation
    if (
      mergeBasePolicyHash !== undefined &&
      receipt.policyHash !== mergeBasePolicyHash &&
      receipt.policyHash !== prPolicyHash
    ) {
      selfAuthoringViolations.push(r.id);
      perRecord.push({
        id: r.id,
        status: 'newly-proposed',
        reason: `receipt policyHash ${receipt.policyHash} matches neither the merge-base nor the PR policy`,
      });
      continue;
    }
    newlyProposed++;
    perRecord.push({
      id: r.id,
      status: 'newly-proposed',
      reason: 'admissible + receipt pins merge-base policy; pending until merge to the trusted ref',
    });
  }

  const violations: string[] = [];
  for (const id of selfAuthoringViolations) {
    violations.push(
      `self-authoring violation: record ${id} receipt pins a PR-introduced policy (PRD line 276)`,
    );
  }
  for (const id of missingReceipts) {
    violations.push(`missing gating receipt for team record ${id} (PRD line 346)`);
  }
  for (const rec of perRecord) {
    if (rec.status === 'refused') {
      violations.push(`refused team record ${rec.id}: ${rec.reason}`);
    }
  }
  if (withoutTrustedRef && newlyProposed > 0) {
    violations.push(
      `no trusted ref configured — ${newlyProposed} newly-proposed team record(s) will remain pending (PRD line 279)`,
    );
  }

  const ok = selfAuthoringViolations.length === 0 && missingReceipts.length === 0 && refused === 0;
  return {
    mergeBasePolicyHash,
    prPolicyHash,
    policyChanged,
    withoutTrustedRef,
    checked: perRecord.length,
    alreadyTrusted,
    newlyProposed,
    refused,
    selfAuthoringViolations,
    missingReceipts,
    perRecord,
    violations,
    ok,
  };
}
