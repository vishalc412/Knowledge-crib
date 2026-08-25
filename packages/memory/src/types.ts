/**
 * The memory-1 record types (PRD §2 "Memory records").
 *
 * Every memory record is **immutable, append-only, and content-addressed** (PRD boundary #2 + W0
 * merge driver): a record is never edited or deleted at the storage layer; its lifecycle changes
 * only by appending a {@link MemoryDecision} event. This mirrors the soul's broad-interface style
 * (one interface with optional per-kind fields) so Ajv draft-07 validation + round-trip stay simple,
 * and so the W0 strict merge driver can treat every line as an opaque `{ id, ... }` JSON object.
 *
 * One claim per record (PRD: "MemoryRecord: one claim per record"). Each record carries the four
 * verdicts as-of save/last-evaluation; the read projection (Slice 3) overlays decision events +
 * freshness revalidation to compute the *effective* verdicts.
 */
import type {
  AttemptPhase,
  EvidenceKind,
  EvidenceVerdict,
  FeedbackSignal,
  MemoryDecisionKind,
  MemoryRecordKind,
  RunnerType,
  Verdicts,
} from './enums.js';

/** memory-1 schema + format version constants (see versions.ts). */
export const MEMORY_FORMAT_VERSION = '1';
export const MEMORY_SCHEMA_VERSION = '1';
export const TOOL_NAME = 'knowledge-crib';
export const SUPPORTED_MEMORY_SCHEMA_VERSIONS = ['1'] as const;

// ─── shared sub-shapes ───────────────────────────────────────────────────────

/** The boundary a claim is admitted within. `repo`-scoped claims carry the registry `repoId`. */
export interface MemoryScope {
  /** 'repo' = per-repository (local or team); 'global' = cross-repo explicit memory. */
  boundary: 'repo' | 'global';
  /** The registry-supplied stable repoId (PRD: "the registry already supplies a stable repoId").
   *  Present iff boundary === 'repo'. */
  repoId?: string;
}

/** Who authored the claim. An agent authored it; a human attested it. An agent assertion alone is
 *  never evidence (PRD), but authorship records provenance regardless. */
export interface Authorship {
  actor: string;
  kind: 'agent' | 'human';
  /** the agent/tool that produced the claim (e.g. 'claude-code', 'codex'); absent for humans. */
  tool?: string;
}

/**
 * One admissibility-checked evidence item. Discriminated by `kind`; per-kind fields are optional.
 * Each item carries its OWN `verdict` (PRD: "every claim is checked independently") — the record's
 * Evidence verdict is the aggregate (valid ⟺ all valid; invalid if any invalid; degraded otherwise).
 *
 * `source-quote` reuses the grounding.ts quote-overlap-as-substring check (PRD §2 admissibility):
 * `quote` must be a normalized substring of the rehydrated `soulId` anchor span, and `targetHash`
 * must match the live node hash (else degraded/orphaned at revalidation).
 */
export interface MemoryEvidence {
  kind: EvidenceKind;
  /** this item's independent check result, stamped at save and re-runnable at revalidation. */
  verdict: EvidenceVerdict;
  checkedAt: string;

  // source-quote
  soulId?: string;
  quote?: string;
  targetHash?: string;
  startLine?: number;

  // execution-assertion (allowlisted assertion from a sanitized receipt — never raw output)
  receiptId?: string;
  assertion?: string;

  // committed-policy (tracked agent-artifact anchor)
  artifactId?: string;
  anchor?: string;

  // human-attestation
  actor?: string;
  tty?: true;
  attestedAt?: string;

  // receipt-pair (Pitfall: failing + subsequent passing)
  failingReceiptId?: string;
  passingReceiptId?: string;

  /** why the check returned this verdict (revalidation reason, missing anchor, etc.). */
  reason?: string;
  [k: string]: unknown;
}

/** A structured summary — the ONLY prose an attempt carries. Never raw prompts/transcripts/CoT (PRD). */
export interface StructuredSummary {
  summary: string;
  fileRefs?: string[];
  targetRefs?: string[];
  errorFingerprint?: string;
  receiptIds?: string[];
  [k: string]: unknown;
}

/** The outcome of an attempt, structured. `errorFingerprint` deduplicates repeat failures. */
export interface AttemptOutcome {
  status: 'success' | 'failure' | 'partial';
  errorFingerprint?: string;
  /** the sanitized receipt that captured this outcome, if the attempt was gated. */
  receiptId?: string;
  [k: string]: unknown;
}

// ─── the six record kinds ────────────────────────────────────────────────────

/** A single immutable, content-addressed claim. */
export interface MemoryRecord {
  /** `mem:<blake3>` — content-addressed from semantic content (see ids.ts). */
  id: string;
  schemaVersion: '1';
  kind: MemoryRecordKind;
  /** the claim's topic key: a soul id, `art:…` artifact id, or `topic:<slug>`. */
  subject: string;
  /** one normalized claim (whitespace-collapsed + trimmed). */
  claim: string;
  scope: MemoryScope;
  /** soul/artifact ids or paths the claim governs (the reattachment targets). */
  appliesTo: string[];
  evidence: MemoryEvidence[];
  authorship: Authorship;
  /** the four verdicts as-of save/last-evaluation. */
  verdicts: Verdicts;
  createdAt: string;
  meta?: Record<string, unknown>;
}

/**
 * Untrusted staging for a proposed record (PRD: "MemoryCandidate: untrusted staging representation").
 * Trust is implicitly `candidate` — a candidate NEVER enters normal recall. Promotion runs the
 * admissibility gate and, if it passes, creates a {@link MemoryRecord} (content-addressed; an
 * identical claim collapses to the same `mem:` id → dedupe).
 */
export interface MemoryCandidate {
  /** `cand:<blake3>` — content-addressed from the proposed semantic content. */
  id: string;
  schemaVersion: '1';
  kind: MemoryRecordKind;
  subject: string;
  claim: string;
  scope: MemoryScope;
  appliesTo: string[];
  /** proposed evidence, NOT yet admissibility-checked. */
  evidence: MemoryEvidence[];
  authorship: Authorship;
  /** where the candidate came from. */
  origin: 'observe' | 'attempt';
  /** the attempt that produced it, when origin === 'attempt'. */
  attemptId?: string;
  proposedAt: string;
  meta?: Record<string, unknown>;
}

/**
 * A structured attempt-lifecycle event (PRD W5; the type lands in the schema). NEVER raw prompts,
 * transcripts, or chain-of-thought — only structured summaries, file/target refs, error
 * fingerprints, and receipt ids.
 */
export interface AttemptEvent {
  /** `att:<blake3>` — content-addressed from the event's semantic content. */
  id: string;
  schemaVersion: '1';
  /** groups the events of one attempt (content-addressed from the attempt seed). */
  attemptId: string;
  phase: AttemptPhase;
  subject?: string;
  observation?: StructuredSummary;
  action?: StructuredSummary;
  outcome?: AttemptOutcome;
  candidateId?: string;
  evaluationId?: string;
  ts: string;
  meta?: Record<string, unknown>;
}

/**
 * A sanitized validation receipt (PRD §2 GateReceipt). NEVER persists raw stdout/stderr — only the
 * `outputDigest` (blake3) and `assertions` (allowlisted named results). Produced ONLY by the CLI
 * and CI runner (`runner: 'cli' | 'ci'`); the MCP server never executes (PRD).
 */
export interface GateReceipt {
  /** `rcpt:<blake3>` — content-addressed from the receipt's semantic content. */
  id: string;
  schemaVersion: '1';
  /** blake3 of the resolved trusted-base policy. */
  policyHash: string;
  /** blake3 of the runner profile. */
  profileHash: string;
  /** the resolved executable (no shell, no PATH lookup ambiguity). */
  executable: string;
  /** fixed arguments — the exact argv, frozen at gate time. */
  args: string[];
  /** git HEAD the gate ran against. */
  head: string;
  /** blake3 digest of the worktree state the gate observed. */
  worktreeDigest: string;
  exitCode: number;
  durationMs: number;
  /** blake3 of stdout+stderr — the raw output is never persisted. */
  outputDigest: string;
  /** allowlisted named assertion results (no free-form output). */
  assertions: { name: string; passed: boolean }[];
  runner: RunnerType;
  ts: string;
  meta?: Record<string, unknown>;
}

/** A lifecycle decision event applied to a record (PRD §2 MemoryDecision). Immutable + append-only. */
export interface MemoryDecision {
  /** `dec:<blake3>` — content-addressed. */
  id: string;
  schemaVersion: '1';
  kind: MemoryDecisionKind;
  /** the MemoryRecord id being decided. */
  subject: string;
  /** for `supersede`: the successor record id. */
  successor?: string;
  actor: string;
  reason?: string;
  ts: string;
  meta?: Record<string, unknown>;
}

/** A local feedback signal on a record (PRD §2 MemoryFeedback). */
export interface MemoryFeedback {
  /** `fb:<blake3>` — content-addressed. */
  id: string;
  schemaVersion: '1';
  signal: FeedbackSignal;
  /** the MemoryRecord id the feedback is about. */
  subject: string;
  actor: string;
  context?: string;
  ts: string;
  meta?: Record<string, unknown>;
}

// ─── manifest ────────────────────────────────────────────────────────────────

/** Which store a manifest describes (mirrors the three stores from PRD §2 storage layout). */
export type MemoryStoreRole = 'local' | 'global' | 'team';

/** Per-collection counts (mirrors the soul manifest's `stats` shape). */
export interface MemoryCounts {
  records: number;
  candidates: number;
  attempts: number;
  receipts: number;
  decisions: number;
  feedback: number;
}

/**
 * The memory manifest (one per store: local repo, global, team). Mirrors the soul `Manifest` shape
 * (format + schema version + repo + counts + lastUpdated) but for `memory-1`.
 */
export interface MemoryManifest {
  memoryFormatVersion: '1';
  schemaVersion: '1';
  store: MemoryStoreRole;
  repo?: { id: string; root: string };
  counts: MemoryCounts;
  lastUpdated: string;
  meta?: Record<string, unknown>;
}

/** Any memory-1 record line (a JSONL shard line is one of these). */
export type MemoryEntry =
  | MemoryRecord
  | MemoryCandidate
  | AttemptEvent
  | GateReceipt
  | MemoryDecision
  | MemoryFeedback;
