/**
 * Content-addressed memory ids (PRD §2: "Memory IDs are content-addressed from semantic content—
 * kind, subject, normalized claim, scope, applicability, and evidence—excluding timestamps and
 * mutable status. Repeated observations therefore deduplicate.").
 *
 * The id is blake3 of a **canonical** (key-sorted, whitespace-normalized) JSON form of the record's
 * SEMANTIC content only — every mutable field (verdicts, check results, reasons, timestamps, meta)
 * is stripped before hashing. Two agents observing the same claim therefore produce the same id, so
 * the W0 strict merge driver unions them by id instead of flagging a conflict. This mirrors the
 * soul's `edgeId` (blake3 of `src|dst|rel`) and the W0 merge driver's "same id ⟹ same content"
 * invariant.
 */
import { blake3Hex } from '@knowledge-crib/soul-schema';
import type {
  AttemptEvent,
  GateReceipt,
  MemoryCandidate,
  MemoryDecision,
  MemoryEvidence,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordV2,
  MemoryRecordV3,
  MemoryScope,
  IntakeCheckpoint,
  IntakeRequirement,
} from './types.js';

// ─── canonical serialization (key-sorted, matches merge.ts / memory-merge.ts) ─

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/** Stable canonical JSON for hashing (key-sorted, no whitespace reformatting of strings). */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Collapse internal whitespace + trim (the "normalized claim" the PRD content-ids over). */
export function normalizeClaim(claim: string): string {
  return claim.replace(/\s+/g, ' ').trim();
}

// ─── evidence fingerprint (strip mutable check results; sort for order-independence) ──

/** The mutable fields stamped by the admissibility checker — never part of the content id. */
const EVIDENCE_MUTABLE = new Set(['verdict', 'checkedAt', 'reason']);

/** Reduce one evidence item to its semantic identity (kind + the kind-specific refs). */
function evidenceFingerprint(ev: MemoryEvidence): string {
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (EVIDENCE_MUTABLE.has(k)) continue;
    stripped[k] = v;
  }
  return canonical(stripped);
}

/** A claim's evidence identity is the sorted list of per-item fingerprints (order-independent). */
function evidenceHash(evidence: MemoryEvidence[]): string {
  const prints = evidence.map(evidenceFingerprint).sort();
  return canonical(prints);
}

/** Scope identity (boundary + repoId). */
function scopeHash(scope: MemoryScope): string {
  return canonical({ boundary: scope.boundary, repoId: scope.repoId });
}

// ─── the shared record/candidate semantic body ───────────────────────────────

/**
 * The semantic content a {@link MemoryRecord} and its staging {@link MemoryCandidate} share — the
 * claim's identity. `appliesTo` is sorted; the claim is normalized; evidence is fingerprinted.
 * Verdicts, timestamps, authorship-tool, and meta are EXCLUDED (mutable / non-semantic).
 *
 * Authorship is included ONLY as `actor` + `kind` (who first made the claim) — NOT `tool` (a
 * different agent re-observing the same claim should dedupe, but a human vs agent attestation of
 * the same claim are distinct claims, so `kind` stays). This is the conservative reading of the
 * PRD's "semantic content" list.
 */
function claimBody(input: {
  kind: string;
  subject: string;
  claim: string;
  scope: MemoryScope;
  appliesTo: string[];
  evidence: MemoryEvidence[];
  authorship: { actor: string; kind: string };
}): string {
  return canonical({
    kind: input.kind,
    subject: input.subject,
    claim: normalizeClaim(input.claim),
    scope: scopeHash(input.scope),
    appliesTo: [...input.appliesTo].sort(),
    evidence: evidenceHash(input.evidence),
    authorship: { actor: input.authorship.actor, kind: input.authorship.kind },
  });
}

// ─── memory-2: proposition key + record id (G1.1) ─────────────────────────────

/**
 * The v2 proposition key: WHAT the claim is about — the real conflict key (G1.1). Derived purely
 * from the whitespace-normalized `subject`; the claim TEXT is deliberately excluded, because two
 * records about the same proposition must share the key for conflict detection to ask whether their
 * claims are mutually exclusive — folding the claim in would hand every distinct claim its own
 * proposition and no pair could ever conflict. A non-empty explicit `propositionKey` override wins
 * (trimmed, verbatim) so callers with a richer notion of "about" (e.g. `topic:<slug>`) can pin it.
 *
 * Pure: no Date.now(), no randomness — the same subject (or the same override) always derives the
 * same key, across writers and across processes.
 */
export function derivePropositionKey(input: {
  subject: string;
  propositionKey?: string;
}): string {
  if (typeof input.propositionKey === 'string' && input.propositionKey.trim().length > 0) {
    return input.propositionKey.trim();
  }
  return `prop:${blake3Hex(canonical({ subject: normalizeClaim(input.subject) }))}`;
}

/**
 * The semantic content a memory-2 record content-addresses over — the v2 analogue of
 * {@link claimBody}. Seeds EXACTLY: `kind`, normalized `subject`, `propositionKey`, normalized
 * `claim`, and the order-independent `evidence` fingerprint. Everything else in the v2 envelope is
 * deliberately EXCLUDED, each for a stated reason:
 *   - `validTime` / `transactionTime` — time is not identity: the same claim observed twice (at
 *     different times, by different watchers) must collapse to one id;
 *   - `provenance` — cross-writer dedupe: a different agent/device/client re-observing the same
 *     claim dedupes (mirrors v1's exclusion of `authorship.tool`);
 *   - `visibility` / `sensitivity` / `retentionPolicyId` — placement + governance, not meaning
 *     (G1.1: visibility and storage placement are independent);
 *   - `lineage` — mutable relationship state, stamped per observation.
 *
 * The v1 seed (claimBody) is UNCHANGED: v1 ids stay byte-identical, preserving the measured
 * cross-writer duplicate-collapse invariant (docs/bench/memory.md) and the `cand:`↔`mem:` shared-id
 * contract until the G1.2 migration takes over.
 */
function claimBodyV2(input: {
  kind: string;
  subject: string;
  propositionKey: string;
  claim: string;
  evidence: MemoryEvidence[];
}): string {
  return canonical({
    kind: input.kind,
    subject: normalizeClaim(input.subject),
    propositionKey: input.propositionKey,
    claim: normalizeClaim(input.claim),
    evidence: evidenceHash(input.evidence),
  });
}

/**
 * `mem:<blake3>` — a memory-2 record's content id. Shares the `mem:` prefix with v1 (validation
 * dispatches on `schemaVersion`, not the prefix) but seeds the v2 body above, so a v2 record and the
 * v1 record of the same raw content have DIFFERENT ids by design — reconciling them is the G1.2
 * legacy-ID alias map's job, never this function's.
 */
export function memoryRecordV2Id(record: {
  kind: MemoryRecordV2['kind'];
  subject: string;
  propositionKey: string;
  claim: string;
  evidence: MemoryEvidence[];
}): string {
  return `mem:${blake3Hex(claimBodyV2(record))}`;
}

/**
 * `mem:<blake3>` for memory-3. Unlike v2, namespace is part of identity: a claim owned by two
 * principals or profiles must never collapse into one syncable record. Mutable provenance and time
 * remain outside the seed so repeat observations within the same namespace still deduplicate.
 */
export function memoryRecordV3Id(record: {
  kind: MemoryRecordV3['kind'];
  subject: string;
  propositionKey: string;
  claim: string;
  evidence: MemoryEvidence[];
  namespace: MemoryRecordV3['namespace'];
}): string {
  return `mem:${blake3Hex(
    canonical({
      kind: record.kind,
      subject: normalizeClaim(record.subject),
      propositionKey: record.propositionKey,
      claim: normalizeClaim(record.claim),
      evidence: evidenceHash(record.evidence),
      namespace: record.namespace,
    }),
  )}`;
}

// ─── public id builders ──────────────────────────────────────────────────────

/** `mem:<blake3>` — a record's content id. */
export function memoryRecordId(record: {
  kind: MemoryRecord['kind'];
  subject: string;
  claim: string;
  scope: MemoryScope;
  appliesTo: string[];
  evidence: MemoryEvidence[];
  authorship: MemoryRecord['authorship'];
}): string {
  return `mem:${blake3Hex(claimBody(record))}`;
}

/** `cand:<blake3>` — a candidate's content id. Shares the claim body with its would-be record, so
 *  promotion of an identical claim collapses to one `mem:` id (dedupe). */
export function memoryCandidateId(candidate: {
  kind: MemoryCandidate['kind'];
  subject: string;
  claim: string;
  scope: MemoryScope;
  appliesTo: string[];
  evidence: MemoryEvidence[];
  authorship: MemoryCandidate['authorship'];
}): string {
  return `cand:${blake3Hex(claimBody(candidate))}`;
}

/**
 * `cap:<blake3>` — the durable capture-outbox entry's content id (G2.2). The seed is the capture's
 * semantic identity — idempotency key, session/event offsets, kind, subject, normalized
 * observation, actor — and NOTHING else: `proposedAt`, status, retries, and meta are mutable
 * queue-lifecycle state and are excluded, so a re-capture re-derives the SAME `cap:` id and the
 * upsert is a no-op (idempotent dedupe), and a `pending` entry can transition to `done`/`dead`
 * in place without its id moving. THE SEED IS FROZEN once landed: changing it re-ids every
 * existing outbox entry and breaks crash-recovery dedupe across deploys.
 */
export function captureEntryId(entry: {
  idempotencyKey?: string;
  sessionId?: string;
  sessionOffset?: number;
  eventOffset?: number;
  kind: string;
  subject: string;
  claim: string;
  actor: string;
}): string {
  return `cap:${blake3Hex(
    canonical({
      idempotencyKey: entry.idempotencyKey,
      sessionId: entry.sessionId,
      sessionOffset: entry.sessionOffset,
      eventOffset: entry.eventOffset,
      kind: entry.kind,
      subject: entry.subject,
      claim: normalizeClaim(entry.claim),
      actor: entry.actor,
    }),
  )}`;
}

/** `att:<blake3>` — an attempt event's content id (excludes `ts`/`meta`). */
export function attemptEventId(event: {
  attemptId: string;
  phase: AttemptEvent['phase'];
  subject?: string;
  observation?: AttemptEvent['observation'];
  action?: AttemptEvent['action'];
  outcome?: AttemptEvent['outcome'];
  candidateId?: string;
  evaluationId?: string;
}): string {
  return `att:${blake3Hex(
    canonical({
      attemptId: event.attemptId,
      phase: event.phase,
      subject: event.subject,
      observation: event.observation,
      action: event.action,
      outcome: event.outcome,
      candidateId: event.candidateId,
      evaluationId: event.evaluationId,
    }),
  )}`;
}

/**
 * `attgrp:<blake3>` — the stable grouping id for one attempt's events, derived from a caller-chosen
 * seed (typically the target subject + actor + start timestamp + origin). Events reference this as
 * `attemptId` so a re-emitted `start`/`outcome`/`compaction` for the same attempt collide-by-id.
 */
export function attemptGroupId(seed: {
  subject?: string;
  actor: string;
  startedAt: string;
  origin: 'observe' | 'attempt';
}): string {
  return `attgrp:${blake3Hex(canonical(seed))}`;
}

/** `rcpt:<blake3>` — a gate receipt's content id (excludes `ts`/`durationMs`/`meta`). */
export function receiptId(receipt: {
  policyHash: string;
  profileHash: string;
  executable: string;
  args: string[];
  head: string;
  worktreeDigest: string;
  exitCode: number;
  outputDigest: string;
  assertions: GateReceipt['assertions'];
  runner: GateReceipt['runner'];
}): string {
  return `rcpt:${blake3Hex(
    canonical({
      policyHash: receipt.policyHash,
      profileHash: receipt.profileHash,
      executable: receipt.executable,
      args: receipt.args,
      head: receipt.head,
      worktreeDigest: receipt.worktreeDigest,
      exitCode: receipt.exitCode,
      outputDigest: receipt.outputDigest,
      assertions: receipt.assertions,
      runner: receipt.runner,
    }),
  )}`;
}

/** `dec:<blake3>` — a decision event's content id (excludes `ts`/`meta`). */
export function decisionId(decision: {
  kind: MemoryDecision['kind'];
  subject: string;
  successor?: string;
  actor: string;
  reason?: string;
}): string {
  return `dec:${blake3Hex(
    canonical({
      kind: decision.kind,
      subject: decision.subject,
      successor: decision.successor,
      actor: decision.actor,
      reason: decision.reason,
    }),
  )}`;
}

/** `fb:<blake3>` — a feedback signal's content id (excludes `ts`/`meta`). */
export function feedbackId(feedback: {
  signal: MemoryFeedback['signal'];
  subject: string;
  actor: string;
  context?: string;
}): string {
  return `fb:${blake3Hex(
    canonical({
      signal: feedback.signal,
      subject: feedback.subject,
      actor: feedback.actor,
      context: feedback.context,
    }),
  )}`;
}

/**
 * `alias:<blake3>` — a legacy-ID alias's content id (G1.2). Seeds EXACTLY `{ legacyId, resolvedId }`:
 * the binding IS the alias's meaning, so re-migrating the same memory-1 record re-derives the same
 * memory-2 id and the alias upsert is a byte-stable no-op (idempotent migration). The carried
 * `verdicts` snapshot is deliberately EXCLUDED — it is migration-time input to the read projection,
 * never identity.
 */
export function memoryAliasId(alias: { legacyId: string; resolvedId: string }): string {
  return `alias:${blake3Hex(canonical({ legacyId: alias.legacyId, resolvedId: alias.resolvedId }))}`;
}

/** Stable intake identity. Observation time is deliberately not semantic identity. */
export function intakeRequirementId(
  intake: Omit<IntakeRequirement, 'id' | 'schemaVersion' | 'createdAt'>,
): string {
  return `intake:${blake3Hex(canonical(intake))}`;
}

/** Stable checkpoint identity. Recording time is deliberately not semantic identity. */
export function intakeCheckpointId(
  checkpoint: Omit<IntakeCheckpoint, 'id' | 'schemaVersion' | 'recordedAt'>,
): string {
  return `icp:${blake3Hex(canonical(checkpoint))}`;
}

/** The id-prefix token for a memory entry (the run before `:`), or `undefined` for a non-string. */
export function memoryIdPrefix(id: unknown): string | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const i = id.indexOf(':');
  return i > 0 ? id.slice(0, i) : undefined;
}

/** Which collection shard a memory entry lives in (mirrors the soul's `shardFor` but over the id). */
export function memoryShard(id: string, digits = 2): string {
  return blake3Hex(id).slice(0, digits);
}
