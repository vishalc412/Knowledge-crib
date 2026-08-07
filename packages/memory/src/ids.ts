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
  MemoryScope,
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
