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

/**
 * memory-1 + memory-2 schema + format version constants (see migrations.ts for the gate).
 *
 * `LIVE_MEMORY_SCHEMA_VERSIONS` are validated in place by the loader — no migration. memory-2 (the
 * G1.1 v2 envelope) is live ALONGSIDE memory-1 until the G1.2 migration retires v1: a mixed store
 * reads both. `SUPPORTED_MEMORY_SCHEMA_VERSIONS` is the fail-closed gate; every version in it must
 * be either live here or reachable by the migrator chain in migrations.ts.
 */
export const MEMORY_FORMAT_VERSION = '1';
export const MEMORY_SCHEMA_VERSION = '1';
export const TOOL_NAME = 'knowledge-crib';
export const LIVE_MEMORY_SCHEMA_VERSIONS = ['1', '2'] as const;
export const SUPPORTED_MEMORY_SCHEMA_VERSIONS = ['1', '2'] as const;

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
 * The durable capture-outbox entry (G2.2). Written BEFORE the {@link MemoryCandidate} it stages, so
 * a crash mid-capture leaves a durable replay record: the distiller drains `pending` entries
 * at-least-once, and a re-capture re-derives the SAME `cap:` id (semantic seed in
 * {@link captureEntryId}) so a re-capture is an idempotent upsert. Carries the FULL capture payload
 * (scope/appliesTo/evidence/authorship) so distillation can rebuild the staging entry without
 * re-anchoring — but never a raw transcript: prose lives only as the structured claim text
 * (the {@link StructuredSummary}-only law).
 */
export interface CaptureOutboxEntry {
  /** `cap:<blake3>` — content-addressed from the capture's semantic identity (id seed FROZEN). */
  id: string;
  schemaVersion: '1';
  kind: MemoryRecordKind;
  subject: string;
  /** what was observed — structured prose only, never a raw transcript. */
  claim: string;
  scope: MemoryScope;
  appliesTo: string[];
  evidence: MemoryEvidence[];
  authorship: Authorship;
  /** where the eventual staging entry came from (mirrors MemoryCandidate.origin). */
  origin: 'observe' | 'attempt';
  attemptId?: string;
  /** caller-supplied dedupe key (a re-capture with the same key re-derives the same `cap:` id). */
  idempotencyKey?: string;
  /** capture-input stream position — carried on the entry, part of the id seed. */
  sessionId?: string;
  sessionOffset?: number;
  eventOffset?: number;
  /** queue lifecycle: `pending` (drain me) → `done` (distilled) | `dead` (dead-lettered). */
  status: 'pending' | 'done' | 'dead';
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

// ─── memory-2: the v2 envelope (G1.1) ────────────────────────────────────────

/**
 * Who observed a claim and through which client (G1.1). `principalId` is OWNERSHIP; agentId /
 * clientId / sessionId are PROVENANCE, never access boundaries — any access decision derived from
 * them would let a session id become a security boundary. Tenancy fields are deliberately ABSENT
 * (local-first): until sync ships, the "global" store is device-global, not user-global.
 */
export interface MemoryProvenance {
  /** the owning principal (who this memory belongs to). */
  principalId: string;
  /** the device that observed the claim. */
  deviceId: string;
  /** the actor (human or agent identity) that made the observation. */
  actorId: string;
  /** the agent that authored the claim, when an agent did. */
  agentId?: string;
  /** the MCP/CLI client through which the claim was captured (e.g. 'claude-code', 'cursor'). */
  clientId: string;
  /** the client session that produced the claim (provenance only — never an access boundary). */
  sessionId?: string;
  /** the tool inside the client (e.g. 'memory_observe'); absent for humans. */
  tool?: string;
}

/** Visibility is semantic scope, SEPARATE from storage placement (a private memory may exist
 *  locally AND in encrypted sync storage without changing meaning). */
export type MemoryVisibility = 'private' | 'workspace';

/** Sensitivity classification for downstream handling (sync gating, redaction, retention). */
export type MemorySensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/**
 * A single immutable, content-addressed claim in the memory-2 envelope (G1.1). Fixes the memory-1
 * deficiencies the Gate 1 plan names: (a) conflict keyed by what the claim is ABOUT
 * (`propositionKey` + explicit `contradicts` lineage) instead of subject+scope, so complementary
 * facts sharing a subject stop colliding; (b) bi-temporal time — `validTime` (when the claim held in
 * the world) vs `transactionTime` (when the store learned it) — so "what did we believe on 12
 * August" is answerable without deleting history: the `history` operation's as-of projection (the
 * G1.3 read op) reads the store at a `transactionTime` point, overlays decision events as-of that
 * instant, and recovers the replaced v1 state (scope/appliesTo/meta) a local/global migration
 * carried in the alias binding (see {@link MemoryAlias}); (c) `provenance` replaces `authorship`,
 * `visibility` replaces scope placement, `sensitivity`/`retentionPolicyId` classify for handling.
 *
 * The v1 verdict axes are deliberately NOT re-stamped here: trust/evidence/applicability/lifecycle
 * are the v1 READ PROJECTION's derived view, and the G1.2 migration owns how a v2 record maps into
 * it (until then the read paths treat a v2 record as rank-ineligible but conflict-visible — see
 * effectiveVerdicts in evaluator.ts).
 */
export interface MemoryRecordV2 {
  /** `mem:<blake3>` — content-addressed from the v2 semantic seed (see ids.ts `memoryRecordV2Id`). */
  id: string;
  schemaVersion: '2';
  visibility: MemoryVisibility;
  kind: MemoryRecordKind;
  /** the claim's topic key: a soul id, `art:…` artifact id, or `topic:<slug>`. */
  subject: string;
  /** what the claim is ABOUT — the real conflict key (see ids.ts `derivePropositionKey`). */
  propositionKey: string;
  /** one normalized claim (whitespace-collapsed + trimmed). */
  claim: string;
  /** when the claim held in the world: `from` (inclusive), `to` (exclusive, absent = still true). */
  validTime: { from: string; to?: string };
  /** when the store learned the claim (bi-temporal transaction time). */
  transactionTime: { observedAt: string; recordedAt: string };
  evidence: MemoryEvidence[];
  provenance: MemoryProvenance;
  /** explicit relationships to other records — `contradicts` is the conflict signal (G1.1). */
  lineage: { derivedFrom?: string[]; supersedes?: string[]; contradicts?: string[] };
  sensitivity: MemorySensitivity;
  /** which committed retention policy governs this record (see policy.ts profiles). */
  retentionPolicyId: string;
}

/** Narrow `entry` to a memory-2 record. memory-1 records carry `schemaVersion: '1'`, so the two
 *  record shapes never overlap in the union. */
export function isMemoryRecordV2(entry: unknown): entry is MemoryRecordV2 {
  if (typeof entry !== 'object' || entry === null) return false;
  const obj = entry as Record<string, unknown>;
  return obj.schemaVersion === '2' && typeof obj.propositionKey === 'string';
}

// ─── the legacy-ID alias (the G1.2 migration's id binding) ────────────────────

/**
 * One legacy-ID alias: the durable v1→v2 id binding the G1.2 migration persists so existing
 * decisions, feedback, supersede `successor` links, and candidate→record promotions keep resolving
 * after a memory-1 record is re-addressed under its re-seeded memory-2 content id (the two seeds are
 * different BY DESIGN — see ids.ts `claimBody` vs `claimBodyV2` — so the binding is load-bearing,
 * not cosmetic: every pre-migration `dec:`/`fb:` event keys on the legacy id).
 *
 * `schemaVersion` is the ALIAS MAP's own format version, NOT the version of the records it maps: a
 * `'1'` alias binds a memory-1 record to a memory-2 record.
 *
 * `verdicts` carries the memory-1 record's four stamped axes across the migration. The v2 envelope
 * deliberately does not re-stamp them (see {@link MemoryRecordV2}), so without the snapshot the v1
 * read projection would rank a migrated record as `candidate`-trust and every migrated memory would
 * vanish from recall. The snapshot is the migration's input, never a live verdict: decision events
 * still overlay it through {@link effectiveVerdicts} (evaluator.ts).
 *
 * The optional `scope`/`appliesTo`/`meta` fields carry the v1 record's placement, reattachment
 * targets, and open `meta` (e.g. promotion's `meta.receiptId` linkage) across the migration. A
 * local/global migration REPLACES the v1 line with the twin, and the closed v2 envelope has no
 * counterpart for these fields — the binding is the only place the as-believed v1 state survives,
 * which is exactly what the `history` as-of read (see {@link MemoryRecordV2}) consumes. They are
 * ADDITIVE optional fields: aliases written before the enrichment (and hand-built fixtures) simply
 * omit them, which is why the alias schema version stays `'1'`; the alias id never moved (its seed
 * is `{ legacyId, resolvedId }` only).
 */
export interface MemoryAlias {
  /** `alias:<blake3>` — content-addressed from `{ legacyId, resolvedId }` (see ids.ts). */
  id: string;
  schemaVersion: '1';
  /** the memory-1 record id being aliased (the id every pre-migration decision/feedback keys on). */
  legacyId: string;
  /** the memory-2 record id that now owns the claim. */
  resolvedId: string;
  /** the memory-1 record's stamped verdicts at migration time (the read projection's base axes). */
  verdicts: Verdicts;
  /** the v1 placement (`visibility` replaced it in the envelope) — carried for the as-of read. */
  scope?: MemoryScope;
  /** the v1 reattachment targets (soul/artifact ids or paths) — not all are evidence soulIds. */
  appliesTo?: string[];
  /** the v1 open `meta` record (e.g. promotion's `receiptId`) — the closed v2 schema drops it. */
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

/** Any memory record line, v1 or v2, plus a migration alias (a JSONL shard line is one of these). */
export type MemoryEntry =
  | MemoryRecord
  | MemoryRecordV2
  | MemoryCandidate
  | CaptureOutboxEntry
  | AttemptEvent
  | GateReceipt
  | MemoryDecision
  | MemoryFeedback
  | MemoryAlias;
