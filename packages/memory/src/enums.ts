/**
 * The memory-1 enumerations (PRD §2 "Memory records" + "Claim-level admissibility").
 *
 * Memory is NOT the soul. These enums live outside the soul's closed `NodeKind`/`Rel` enums (PRD
 * boundary #2). The claim `kind` and lifecycle `decision` kinds already shipped in W0
 * (`@knowledge-crib/core` `memory-kinds.ts`) because the W0 strict merge driver needs them and the
 * driver lives in `core` — moving them here would create a `core → memory` edge that cycles with
 * `memory → core` (the stores need `core`'s lock + atomic-write + SoulStore read API). So they stay
 * in `core` and are re-exported here for a single import surface; the verdict axes, evidence kinds,
 * feedback, attempt phases, and runner types are new to `memory-1` and defined here.
 */
export {
  type MemoryRecordKind,
  MEMORY_RECORD_KINDS,
  type MemoryDecisionKind,
  MEMORY_DECISION_KINDS,
  isMemoryRecordKind,
  isMemoryDecisionKind,
} from '@knowledge-crib/core';

// ─── the four independent verdict axes (PRD §2 verdict table) ────────────────

/** Trust axis: where the claim is admitted. `candidate` = untrusted staging, never in normal recall. */
export type TrustVerdict = 'candidate' | 'local' | 'team';

export const TRUST_VERDICTS: readonly TrustVerdict[] = ['candidate', 'local', 'team'];

/** Evidence axis: whether the claim's evidence survives admissibility + revalidation. */
export type EvidenceVerdict = 'valid' | 'degraded' | 'invalid';

export const EVIDENCE_VERDICTS: readonly EvidenceVerdict[] = ['valid', 'degraded', 'invalid'];

/** Applicability axis: whether the claim still attaches to a live code/doc target. */
export type ApplicabilityVerdict = 'current' | 'needs-review' | 'orphaned';

export const APPLICABILITY_VERDICTS: readonly ApplicabilityVerdict[] = [
  'current',
  'needs-review',
  'orphaned',
];

/** Lifecycle axis: whether the claim has been retired by a decision event. */
export type LifecycleVerdict = 'active' | 'superseded' | 'retracted';

export const LIFECYCLE_VERDICTS: readonly LifecycleVerdict[] = [
  'active',
  'superseded',
  'retracted',
];

/** The four verdicts stamped on a record (as-of save/last-evaluation). The READ PROJECTION overlays
 *  decision events + freshness revalidation to compute the effective verdicts (Slice 3). */
export interface Verdicts {
  trust: TrustVerdict;
  evidence: EvidenceVerdict;
  applicability: ApplicabilityVerdict;
  lifecycle: LifecycleVerdict;
}

export function isTrustVerdict(v: unknown): v is TrustVerdict {
  return typeof v === 'string' && (TRUST_VERDICTS as readonly string[]).includes(v);
}
export function isEvidenceVerdict(v: unknown): v is EvidenceVerdict {
  return typeof v === 'string' && (EVIDENCE_VERDICTS as readonly string[]).includes(v);
}
export function isApplicabilityVerdict(v: unknown): v is ApplicabilityVerdict {
  return typeof v === 'string' && (APPLICABILITY_VERDICTS as readonly string[]).includes(v);
}
export function isLifecycleVerdict(v: unknown): v is LifecycleVerdict {
  return typeof v === 'string' && (LIFECYCLE_VERDICTS as readonly string[]).includes(v);
}

// ─── evidence kinds (PRD §2 admissibility matrix) ────────────────────────────

/**
 * The admissible evidence kinds, one per `MemoryEvidence` item. Each is checked INDEPENDENTLY
 * (PRD: "every claim is checked independently"). An agent assertion is never evidence (PRD), so
 * there is no `agent-assertion` kind.
 *
 *   - `source-quote`        — a verified quote from a committed source span (Fact / Procedure).
 *   - `execution-assertion` — an allowlisted assertion from a sanitized GateReceipt (Fact / Procedure).
 *   - `committed-policy`    — a reference to a tracked agent-artifact (instruction/rule/skill) anchor (Procedure / Decision / Convention).
 *   - `human-attestation`   — a human TTY attestation (Decision / Convention / Pitfall reproduction).
 *   - `receipt-pair`        — a failing receipt plus a subsequent passing receipt (Pitfall).
 *
 * `receipt-pair` and `reproduction` (source-quote + human-attestation) compose the Pitfall evidence.
 */
export type EvidenceKind =
  | 'source-quote'
  | 'execution-assertion'
  | 'committed-policy'
  | 'human-attestation'
  | 'receipt-pair';

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'source-quote',
  'execution-assertion',
  'committed-policy',
  'human-attestation',
  'receipt-pair',
];

export function isEvidenceKind(v: unknown): v is EvidenceKind {
  return typeof v === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(v);
}

// ─── feedback (PRD §2 MemoryFeedback) ────────────────────────────────────────

export type FeedbackSignal = 'useful' | 'unhelpful' | 'contradicted';

export const FEEDBACK_SIGNALS: readonly FeedbackSignal[] = ['useful', 'unhelpful', 'contradicted'];

export function isFeedbackSignal(v: unknown): v is FeedbackSignal {
  return typeof v === 'string' && (FEEDBACK_SIGNALS as readonly string[]).includes(v);
}

// ─── attempt lifecycle phases (PRD W5 line 354; the type lands in the schema) ─

export type AttemptPhase =
  | 'start'
  | 'observation'
  | 'action'
  | 'outcome'
  | 'candidate'
  | 'evaluation'
  | 'promotion'
  | 'compaction';

export const ATTEMPT_PHASES: readonly AttemptPhase[] = [
  'start',
  'observation',
  'action',
  'outcome',
  'candidate',
  'evaluation',
  'promotion',
  'compaction',
];

export function isAttemptPhase(v: unknown): v is AttemptPhase {
  return typeof v === 'string' && (ATTEMPT_PHASES as readonly string[]).includes(v);
}

// ─── receipt runner type (PRD §2 GateReceipt) ────────────────────────────────

/** Who executed the gate. `cli` and `ci` produce trusted receipts; `mcp` never executes (PRD: "Do
 *  not execute commands or models through MCP"). */
export type RunnerType = 'cli' | 'ci';

export const RUNNER_TYPES: readonly RunnerType[] = ['cli', 'ci'];

export function isRunnerType(v: unknown): v is RunnerType {
  return typeof v === 'string' && (RUNNER_TYPES as readonly string[]).includes(v);
}
