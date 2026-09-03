/**
 * G1.3 — the portable memory API core: ONE contract every client (MCP verbs, CLI, a future
 * REST/OpenAPI surface, the TypeScript SDK, a Python SDK) adapts to.
 *
 *   `capture` · `search` · `get` · `supersede` · `delete` · `history` · `sync` · `audit`
 *
 * Design rules this module enforces (Gate 1 plan + the wave-2 review findings):
 *
 *   - **`search` REUSES the recall projection** ({@link gatherRecall} + {@link recallProjection}) —
 *     the 6-criterion priority-ordered ranking, the alias bridging (conservative verdict snapshots +
 *     multi-alias decision/feedback bridges) and the conflict grouping are NEVER re-implemented
 *     here; the rich response only ENRICHES the projection's hits.
 *   - **Storage placement is never conflated with semantic scope.** Every hit/get result carries
 *     `placement` (which stores physically hold the record) SEPARATELY from `scope` (v1's semantic
 *     boundary) and `visibility` (v2's semantic visibility).
 *   - **Legacy ids keep resolving.** `get` follows the alias map exactly like `MemoryStore.findEntry`
 *     (direct hit wins, alias chases a migrated twin) and reports WHICH binding was followed, so a
 *     decision/feedback keyed on a pre-migration id still finds its record after `migrateToV2`.
 *   - **Bi-temporal history is a read projection, never a rewrite.** `history(key, {asOf})` overlays
 *     decision events whose transaction time is ≤ `asOf` and reports what was believed then —
 *     including the as-believed v1 state a local/global migration carried in the alias binding
 *     (scope/appliesTo/meta/verdicts), because after the replacement the binding is the only place
 *     those bytes survive.
 *   - **`delete` is a tombstone.** Memory is append-only: delete appends a `retract` decision (the
 *     record line stays), so search excludes the record while history/audit still see it.
 *   - **`sync` is honest.** It reports not-available and names Gate 4; no engine is stubbed.
 *
 * Store-backed, not IO-abstracted: the ops read/write through {@link MemoryStore}'s locked +
 * atomic + validated + secret-scanned write gate. The pure helpers ({@link believedLifecycle},
 * {@link validTimeHoldsAt}, {@link validityOf}, {@link visibilityOf}, {@link syncNotAvailable}) are
 * exported separately for unit testing and for SDK ports that need the same semantics without a
 * store. NO wall-clock read inside any id/hash/pure function — the clock enters only through the
 * caller-supplied `now` port.
 */
import { type RehydratedBody, type SoulStore, rehydrateBody } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import {
  type AliasIndex,
  bridgedDecisions,
  buildAliasIndex,
  conservativeVerdicts,
} from './aliases.js';
import {
  type EvidenceKind,
  type EvidenceVerdict,
  type FeedbackSignal,
  type LifecycleVerdict,
  type MemoryDecisionKind,
  type MemoryRecordKind,
  type TrustVerdict,
  type Verdicts,
  isMemoryRecordKind,
} from './enums.js';
import {
  type EffectiveVerdicts,
  type MemoryEvalContext,
  type MemoryEvaluator,
  effectiveVerdicts,
  supersedeDecision,
} from './evaluator.js';
import { verifyQuote } from './grounding.js';
import {
  decisionId,
  derivePropositionKey,
  memoryCandidateId,
  memoryRecordV2Id,
  memoryShard,
} from './ids.js';
import { DEFAULT_RETENTION_POLICY_ID, migrationProvenance } from './migrations.js';
import { readRepoId } from './paths.js';
import {
  DEFAULT_RECALL_SOURCES,
  type LexicalScorer,
  type MemorySource,
  type RecallScore,
  type RecallStores,
  gatherRecall,
  recallProjection,
} from './recall.js';
import type { MemoryCollection, MemoryStore } from './store.js';
import type {
  MemoryAlias,
  MemoryCandidate,
  MemoryDecision,
  MemoryEntry,
  MemoryEvidence,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordV2,
  MemoryScope,
  MemorySensitivity,
  MemoryVisibility,
} from './types.js';
import { isMemoryRecordV2 } from './types.js';

// ─── the anchor port (capture's loose-name resolution) ────────────────────────

/**
 * The soul read-port {@link capture} anchors against: node lookup, a full node scan (loose
 * symbol/file names are resolved by scanning — there is no name index), and span rehydration for
 * the lifted source-quote evidence. `SoulStore` satisfies the first two structurally; the adapter
 * below adds rehydration. Tests fake the port (the API is PURE over it — no disk required).
 */
export interface MemoryAnchorPort {
  getNode(id: string): Node | undefined;
  /** every node in the soul, in stable iteration order (loose-name resolution scans these). */
  allNodes(): readonly Node[];
  /** Rehydrate a node's on-disk span (the source of the lifted capture quote). */
  rehydrate(node: Node, opts?: { maxChars?: number; startLine?: number }): RehydratedBody;
}

/** Adapter wrapping a live `SoulStore` + repo root as a {@link MemoryAnchorPort}. */
export class SoulStoreAnchorPort implements MemoryAnchorPort {
  constructor(
    private readonly soul: SoulStore,
    private readonly repoRoot: string,
  ) {}

  getNode(id: string): Node | undefined {
    return this.soul.getNode(id);
  }

  allNodes(): readonly Node[] {
    return Array.from(this.soul.iterate());
  }

  rehydrate(node: Node, opts?: { maxChars?: number; startLine?: number }): RehydratedBody {
    return rehydrateBody(this.repoRoot, node, {
      maxLines: Number.MAX_SAFE_INTEGER,
      ...(opts?.maxChars ? { maxChars: opts.maxChars } : {}),
      ...(opts?.startLine ? { startLine: opts.startLine } : {}),
    });
  }
}

// ─── pure record views (shared by search/get/history/audit) ───────────────────

/** The longest source-quote {@link capture} lifts from an anchor span (mirrors the MCP verb). */
export const CAPTURE_QUOTE_MAX_CHARS = 240;

/**
 * The ranking-version id stamped on every search response ({@link SearchHit.rankingVersion}). The
 * recall projection ranks with a 6-criterion PRIORITY-ORDERED comparator (recall.ts); this id
 * names that comparator so a cached/consumed response can be invalidated when ranking changes.
 * Bump when the comparator, its criterion order, or its weights change.
 */
export const RANKING_VERSION = 'recall-v1:priority-order';

/** The validity interval every result carries, whatever envelope the record is in. */
export interface ValidityInterval {
  /** when the claim held in the world: `from` inclusive, `to` exclusive (absent = still true). */
  validTime: { from: string; to?: string };
  /** when the store learned the claim (bi-temporal transaction time). */
  transactionTime: { observedAt: string; recordedAt: string };
}

/**
 * A record's validity interval, derived per version: memory-2 carries it verbatim; memory-1 has no
 * bi-temporal fields, so both axes derive from `createdAt` (the same mapping the G1.2 migration
 * stamps — the store learned the claim when the record was written; nothing is fabricated). PURE.
 */
export function validityOf(record: MemoryRecord | MemoryRecordV2): ValidityInterval {
  if (isMemoryRecordV2(record)) {
    return { validTime: record.validTime, transactionTime: record.transactionTime };
  }
  return {
    validTime: { from: record.createdAt },
    transactionTime: { observedAt: record.createdAt, recordedAt: record.createdAt },
  };
}

/**
 * A record's semantic visibility: memory-2 carries it; memory-1 has no visibility field, so it
 * derives through the same rule the G1.2 migration stamps ('workspace' — a memory-store record was
 * shared within its scope by construction). PURE; the derivation is a documented mapping, never a
 * per-call guess.
 */
export function visibilityOf(record: MemoryRecord | MemoryRecordV2): MemoryVisibility {
  return isMemoryRecordV2(record) ? record.visibility : 'workspace';
}

/**
 * Whether a validity interval covers `at`: half-open `[from, to)` — `at === to` is OUTSIDE (the
 * claim stopped holding). An unparseable bound is not a window (the write gate rejects those, so
 * this only guards hand-built inputs). PURE string parsing — never the clock.
 */
export function validTimeHoldsAt(validTime: { from: string; to?: string }, at: string): boolean {
  const a = Date.parse(at);
  const from = Date.parse(validTime.from);
  if (Number.isNaN(a) || Number.isNaN(from)) return false;
  if (a < from) return false;
  if (validTime.to === undefined) return true; // open-ended: still true from `from` onwards
  const to = Date.parse(validTime.to);
  if (Number.isNaN(to)) return false;
  return a < to;
}

/**
 * The SHAPE of a validity window, independent of any instant: `valid` = parseable bounds with
 * `to > from` (or open-ended), `inverted` = an empty or backwards window, `unparseable` = a bound
 * that is not an ISO instant. This distinguishes a BROKEN window from mere non-coverage —
 * `validTimeHoldsAt` returning false is silent about WHY. PURE; the write gate rejects broken
 * windows, so this is a surfaced marker for hand-built or already-persisted inputs. PURE.
 */
export function validTimeWindowOf(validTime: {
  from: string;
  to?: string;
}): 'valid' | 'inverted' | 'unparseable' {
  const from = Date.parse(validTime.from);
  if (Number.isNaN(from)) return 'unparseable';
  if (validTime.to === undefined) return 'valid';
  const to = Date.parse(validTime.to);
  if (Number.isNaN(to)) return 'unparseable';
  return to > from ? 'valid' : 'inverted';
}

/**
 * The lifecycle + quarantine a set of decision events projects, using the SAME precedence as
 * {@link effectiveVerdicts}: `retract` beats `supersede` (a later retract wins); `quarantine` is an
 * independent exclusion flag. PURE and order-independent — call `history` filters the decisions by
 * `ts <= asOf` BEFORE calling this, so "what was believed then" is a function of the filtered SET.
 *
 * The fold starts from `baseLifecycle` — the record's STAMPED lifecycle (v1 `record.verdicts.lifecycle`,
 * or the v2 conservative alias snapshot), the same base {@link effectiveVerdicts} starts from. No
 * first-party writer stamps a non-active v1 lifecycle (promotion always stamps 'active'; supersede/
 * delete append decisions without re-stamping), but a hand-edited shard can — starting from the
 * stamp keeps get/audit/history reporting ONE lifecycle instead of three. Defaults to 'active', so
 * callers with no stamp keep the historical behaviour.
 */
export function believedLifecycle(
  decisions: readonly MemoryDecision[],
  baseLifecycle: LifecycleVerdict = 'active',
): {
  lifecycle: LifecycleVerdict;
  quarantined: boolean;
} {
  let lifecycle: LifecycleVerdict = baseLifecycle;
  let quarantined = false;
  for (const d of decisions) {
    if (d.kind === 'retract') lifecycle = 'retracted';
    else if (d.kind === 'supersede' && lifecycle !== 'retracted') lifecycle = 'superseded';
    else if (d.kind === 'quarantine') quarantined = true;
  }
  return { lifecycle, quarantined };
}

// ─── the sync non-capability (declared, honestly unavailable) ─────────────────

/** The honest response shape for {@link MemoryApi.sync}: a declared capability with no engine. */
export interface SyncResult {
  ok: false;
  available: false;
  capability: 'sync';
  status: 'not-implemented';
  /** the plan gate that owns the sync engine — named so the caller knows where to look. */
  gate: 'Gate 4';
  message: string;
  /** the request echoed back, untouched: nothing was read, written, or transferred. */
  request: Record<string, unknown>;
}

/**
 * The declared-but-not-implemented sync capability. `sync` is in the portable contract so every
 * adapter can REGISTER the name, but no sync engine exists in this release — returning an
 * engineered success or a silent no-op would be the dishonest version of this function. PURE.
 */
export function syncNotAvailable(request: Record<string, unknown> = {}): SyncResult {
  return {
    ok: false,
    available: false,
    capability: 'sync',
    status: 'not-implemented',
    gate: 'Gate 4',
    message:
      'cross-device / cross-store memory sync ships in Gate 4; no sync engine exists in this release — nothing was read, written, or transferred',
    request,
  };
}

// ─── shared result shapes ────────────────────────────────────────────────────

/** One evidence item's checkable summary (kind + verdict + anchor refs; never the raw span). */
export interface EvidenceSummary {
  kind: EvidenceKind;
  verdict: EvidenceVerdict;
  checkedAt: string;
  soulId?: string;
  receiptId?: string;
  reason?: string;
}

/** A conflict group as the search/get surfaces it (ids only — the records ride along elsewhere). */
export interface ConflictSummary {
  key: string;
  subject: string;
  /** memory-2 only: the shared proposition key (the real conflict key, G1.1). */
  propositionKey?: string;
  /** memory-1 only: the shared semantic scope. Never a storage placement. */
  scope?: { boundary: string; repoId?: string };
  recordIds: readonly string[];
}

/** A successor that retired (or claims to retire) a record, and whether it resolves. */
export interface SupersededAlternative {
  /** the successor record id. */
  id: string;
  /** `decision` = a `supersede` decision names it; `lineage` = a v2 record's `lineage.supersedes`
   *  declares it (a declaration ranking alone would not surface). */
  via: 'decision' | 'lineage';
  /** whether the successor id resolves to a record in any store (the link may dangle honestly). */
  found: boolean;
  subject?: string;
  claim?: string;
}

function evidenceSummaries(record: MemoryRecord | MemoryRecordV2): EvidenceSummary[] {
  return record.evidence.map((ev) => ({
    kind: ev.kind,
    verdict: ev.verdict,
    checkedAt: ev.checkedAt,
    ...(ev.soulId !== undefined ? { soulId: ev.soulId } : {}),
    ...(ev.receiptId !== undefined ? { receiptId: ev.receiptId } : {}),
    ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
  }));
}

// ─── capture ─────────────────────────────────────────────────────────────────

/** The loose capture input (mirrors the MCP `memory{op:'capture'}` verb's arguments). */
export interface CaptureInput {
  /** the claim's topic key — a soul id, `art:` id, or `topic:<slug>`. */
  subject: string;
  /** what was attempted / what happened, as free text. Becomes the candidate's claim verbatim. */
  observation: string;
  /** defaults to `fact` — the least presumptuous kind for a loose observation. */
  kind?: string;
  /** loose file paths touched — resolved to file nodes when they exist. */
  files?: string[];
  /** loose symbol names touched — resolved to soul ids; the first spanned one backs the evidence. */
  symbols?: string[];
  actor: string;
  tool?: string;
  scopeBoundary?: 'repo' | 'global';
  /**
   * Explicit repoId for a repo-scoped capture. When absent the API resolves it from `cribDir`
   * (soul manifest → registry, see `readRepoId`); a repo-scoped capture without a resolvable
   * repoId FAILS — a content id keyed on an unstable repo id would not dedupe across machines.
   */
  repoId?: string;
}

/** How checkable the captured candidate came out (mirrors the MCP verb's `anchorStatus`). */
export type CaptureAnchorStatus = 'anchored' | 'ambiguous' | 'unresolvable' | 'unanchored';

/** A successful {@link MemoryApi.capture}. */
export interface CaptureSuccess {
  ok: true;
  /** `cand:<blake3>` — content-addressed; a repeat capture of the same observation upserts here. */
  id: string;
  status: 'pending';
  origin: 'observe';
  scope: MemoryScope;
  anchorStatus: CaptureAnchorStatus;
  evidenceAttached: boolean;
  /** soul ids the observation anchored to (symbols first, then files). */
  anchors: readonly string[];
  /** names that matched more than one node — reported, never guessed. */
  ambiguous: readonly string[];
  /** names with no node at all, in caller order — the candidate is still written, just unanchored. */
  unresolvable: readonly string[];
  /** true iff this content id was already pending (the idempotence signal). */
  duplicate: boolean;
}

/** A failed {@link MemoryApi.capture} (validation / configuration — nothing was written). */
export interface CaptureFailure {
  ok: false;
  error: string;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

/** One loose-name anchoring outcome (internal to {@link capture}, shared by both resolvers). */
interface AnchorHit {
  id?: string;
  ambiguous: boolean;
}

/** Resolve one loose symbol name: id → qualified name → simple name, AMBIGUITY over silent pick. */
function resolveSymbolAnchor(port: MemoryAnchorPort, name: string): AnchorHit {
  if (port.getNode(name)) return { id: name, ambiguous: false };
  const needle = name.toLowerCase();
  const qualified: string[] = [];
  const simple: string[] = [];
  for (const n of port.allNodes()) {
    if (n.qualifiedName?.toLowerCase() === needle) qualified.push(n.id);
    else if (n.name?.toLowerCase() === needle) simple.push(n.id);
  }
  if (qualified.length === 1) return { id: qualified[0], ambiguous: false };
  if (qualified.length > 1) return { ambiguous: true };
  if (simple.length === 1) return { id: simple[0], ambiguous: false };
  return { ambiguous: simple.length > 1 };
}

/** Resolve one loose file path to its file node. More than one hit is an index anomaly → ambiguous. */
function resolveFileAnchor(port: MemoryAnchorPort, path: string): AnchorHit {
  const matches: string[] = [];
  for (const n of port.allNodes()) {
    if (n.kind === 'file' && n.file === path) matches.push(n.id);
  }
  if (matches.length === 1) return { id: matches[0], ambiguous: false };
  return { ambiguous: matches.length > 1 };
}

/** The capture-anchoring outcome over every loose name the caller supplied. */
function resolveCaptureAnchors(
  port: MemoryAnchorPort,
  symbols: readonly string[],
  files: readonly string[],
): {
  resolved: string[];
  ambiguous: string[];
  unresolvable: string[];
  spanNodes: Node[];
} {
  const resolved: string[] = [];
  const ambiguous: string[] = [];
  const unresolvable: string[] = [];
  const spanNodes: Node[] = [];
  for (const name of symbols) {
    const hit = resolveSymbolAnchor(port, name);
    if (hit.id) {
      resolved.push(hit.id);
      const node = port.getNode(hit.id);
      // Only symbol nodes with a real on-disk span can back a source-quote evidence item.
      if (node?.file && node.span) spanNodes.push(node);
    } else if (hit.ambiguous) ambiguous.push(name);
    else unresolvable.push(name);
  }
  for (const path of files) {
    const hit = resolveFileAnchor(port, path);
    if (hit.id) resolved.push(hit.id);
    else if (hit.ambiguous) ambiguous.push(path);
    else unresolvable.push(path);
  }
  return { resolved, ambiguous, unresolvable, spanNodes };
}

// ─── search ──────────────────────────────────────────────────────────────────

/** Options for {@link MemoryApi.search}; every field optional, mirroring {@link recallProjection}. */
export interface SearchOpts {
  /** soul ids / paths / subject keys to exact-match against (criterion 1 target match). */
  targetIds?: readonly string[];
  /** which stores to gather; defaults to all three (team + local + global). */
  sources?: readonly MemorySource[];
  /** lexical scorer; defaults to the exact-match scorer (an FTS scorer plugs in here). */
  lexicalScorer?: LexicalScorer;
  /** feedback bound (criterion 6). */
  feedbackBound?: number;
  /** fresh-revalidation ports; defaults to the constructor-supplied evaluator/context. BOTH must
   *  be present for a fresh evaluation (the projection ignores a lone evaluator). */
  evaluator?: MemoryEvaluator;
  evalCtx?: MemoryEvalContext;
  /** the code HEAD this search ran against; defaults to the constructor-supplied head. */
  codeHead?: string;
}

/** The freshness block every search hit carries. */
export interface FreshnessState {
  /** `fresh` = a revalidation pass ran this search; `unevaluated` = stamped verdicts only. */
  state: 'fresh' | 'unevaluated';
  /** ALWAYS null — a wall-clock stamp here would make two identical searches hash differently and
   *  break ifHash stability (the response must be a pure function of its inputs). The `state`
   *  boolean carries the freshness signal; nothing about WHEN is fabricated. */
  evaluatedAt: string | null;
  /** the code HEAD the evaluation/search ran against, when the serving layer supplied one. */
  codeHead: string | null;
}

/** One search result — the recall projection's hit ENRICHED with the G1.3 rich contract. */
export interface SearchHit {
  /** the record itself (v1 or v2 envelope), so an SDK consumer never re-reads by id. */
  record: MemoryRecord | MemoryRecordV2;
  id: string;
  schemaVersion: '1' | '2';
  kind: MemoryRecordKind;
  subject: string;
  claim: string;
  visibility: MemoryVisibility;
  /** v1 only — the SEMANTIC scope. NEVER the storage placement (see `placement`). */
  scope?: MemoryScope;
  /** v2 only — what the claim is about (the real conflict key, G1.1). */
  propositionKey?: string;
  /** the EFFECTIVE store this hit was resolved from — the store whose verdict overlay governs
   *  (the same per-source field recallProjection reports). NOT placement[0]: a record placed in
   *  local+team yields one hit per source, and placement is local-first. */
  source: MemorySource;
  /** STORAGE PLACEMENT — which stores physically hold this record id. Independent of scope. */
  placement: readonly MemorySource[];
  /** the effective (read-projection) verdicts, alias snapshot + decision overlay included. */
  verdicts: EffectiveVerdicts;
  evidence: readonly EvidenceSummary[];
  freshness: FreshnessState;
  validity: ValidityInterval;
  /** v2: the record's own lineage. v1 has no lineage field — `{}` (supersession rides on `supersededBy`). */
  lineage: { derivedFrom?: string[]; supersedes?: string[]; contradicts?: string[] };
  /** the ranking components (priority-ordered, NOT a weighted sum — see recall.ts). */
  score: RecallScore;
  /** which ranking comparator produced `score` (see {@link RANKING_VERSION}). */
  rankingVersion: typeof RANKING_VERSION;
  /** the conflict groups this record participates in (empty = no live contradiction). */
  conflicts: readonly ConflictSummary[];
  /** successors that retired (or declare they retire) this record, whether or not ranking saw it. */
  supersededBy: readonly SupersededAlternative[];
}

/** The search provenance block (deterministic caller-stable fields; no volatile per-hit data). */
export interface SearchProvenance {
  rankingVersion: typeof RANKING_VERSION;
  sources: readonly MemorySource[];
  counts: {
    team: number;
    local: number;
    global: number;
    considered: number;
    eligible: number;
    conflicts: number;
  };
  fresh: boolean;
  /** ALWAYS null — the response is a pure function of its inputs (ifHash-stable). */
  evaluatedAt: string | null;
  codeHead: string | null;
  errors: readonly string[];
}

/** The full search response: ranked rich hits + every conflict group + provenance. */
export interface SearchResponse {
  query: string;
  hits: readonly SearchHit[];
  conflicts: readonly ConflictSummary[];
  provenance: SearchProvenance;
}

// ─── get ─────────────────────────────────────────────────────────────────────

/** The rich single-record view {@link MemoryApi.get} returns. */
export interface GetResult {
  found: boolean;
  /** the id the caller asked for (a legacy id when an alias was followed). */
  requestedId: string;
  /** the resolved record id (=== requestedId on a direct hit; the twin's id via alias). */
  id?: string;
  /** the alias binding that was followed, when the request was a legacy id. */
  resolvedViaAlias?: MemoryAlias;
  record?: MemoryRecord | MemoryRecordV2;
  /** every legacy id bound to this record across all stores' alias maps. */
  legacyIds: readonly string[];
  /** the alias bindings verbatim — the as-believed v1 state (scope/appliesTo/meta/verdicts). */
  legacy: readonly MemoryAlias[];
  /** STORAGE PLACEMENT — which stores physically hold this record id. */
  placement: readonly MemorySource[];
  /** the store the record was located in (direct hit wins; local → team → global order). */
  source?: MemorySource;
  visibility?: MemoryVisibility;
  validity?: ValidityInterval;
  /** the effective verdicts (alias snapshot + every store's decision overlay, no-poison honoured). */
  verdicts?: EffectiveVerdicts;
  evidence?: readonly EvidenceSummary[];
  lineage?: { derivedFrom?: string[]; supersedes?: string[]; contradicts?: string[] };
  /** v1 only — the SEMANTIC scope. */
  scope?: MemoryScope;
  /** v2 only. */
  propositionKey?: string;
  supersededBy?: readonly SupersededAlternative[];
}

// ─── supersede ───────────────────────────────────────────────────────────────

/** A NEW successor claim, written as a memory-2 record by {@link MemoryApi.supersede}. */
export interface SupersedePayload {
  /** the superseding claim (required). */
  claim: string;
  /** defaults to the superseded record's subject. */
  subject?: string;
  /** defaults to the superseded record's kind. */
  kind?: MemoryRecordKind;
  /** carried verbatim (empty is honest — an unsupported claim is not recall-eligible). */
  evidence?: MemoryEvidence[];
  /** defaults to 'private' (the v2 NEW-observation default; migration stamps 'workspace' instead). */
  visibility?: MemoryVisibility;
  /** explicit proposition key; defaults to the derived key of the (possibly defaulted) subject. */
  propositionKey?: string;
  sensitivity?: MemorySensitivity;
}

export interface SupersedeOpts {
  actor: string;
  reason?: string;
  /** the authoring client tool (provenance only — never an access boundary). */
  tool?: string;
}

/** A successful {@link MemoryApi.supersede}. */
export interface SupersedeSuccess {
  ok: true;
  /** the RESOLVED id of the retired record (the twin's id when a legacy id was requested). */
  supersededId: string;
  successorId: string;
  /** `dec:<blake3>` — content-addressed; a repeat supersede with the same inputs is a no-op. */
  decisionId: string;
  /** whether the successor record was created by this call (false = it already existed). */
  successorCreated: boolean;
  /** which store the decision was appended to (team decisions are authoritative across stores). */
  decisionSource: MemorySource;
}

export type SupersedeResult = SupersedeSuccess | { ok: false; error: string };

// ─── delete ──────────────────────────────────────────────────────────────────

export interface DeleteOpts {
  actor: string;
  reason?: string;
}

/** A successful {@link MemoryApi.delete} — always a tombstone; the record line is never removed. */
export interface DeleteSuccess {
  ok: true;
  /** the RESOLVED id of the tombstoned record. */
  id: string;
  decisionId: string;
  mode: 'tombstone';
  decisionSource: MemorySource;
}

export type DeleteResult = DeleteSuccess | { ok: false; error: string };

// ─── history ─────────────────────────────────────────────────────────────────

/** The point-in-time / full-timeline options for {@link MemoryApi.history}. */
export interface HistoryOpts {
  /**
   * The transactionTime instant to project: only records recorded ≤ `asOf` are included, and only
   * decision events with `ts <= asOf` are overlaid — the result is what was believed then, not
   * what is believed now. Absent = the full belief timeline.
   */
  asOf?: string;
}

/** What was (or is) believed about one record — the history projection's per-record unit. */
export interface RecordBelief {
  record: MemoryRecord | MemoryRecordV2;
  id: string;
  schemaVersion: '1' | '2';
  subject: string;
  claim: string;
  /** when the store learned this record (transactionTime.recordedAt / v1 createdAt). */
  recordedAt: string;
  validTime: { from: string; to?: string };
  /** every alias binding — the as-believed v1 state a replacement migration preserved. */
  legacy: readonly MemoryAlias[];
  /** the lifecycle the (as-of-filtered) decisions project. */
  lifecycle: LifecycleVerdict;
  quarantined: boolean;
  /** present only with `asOf`: whether the validTime window covers the instant (half-open [from,to)). */
  validTimeHolds?: boolean;
  /** present only with `asOf`: the window's SHAPE — distinguishes a broken window (inverted /
   *  unparseable) from mere non-coverage (`valid` with validTimeHolds false). */
  validTimeWindow?: 'valid' | 'inverted' | 'unparseable';
  placement: readonly MemorySource[];
}

/** One ordered timeline event. `type` is the decision kind for decision events. */
export type HistoryEvent =
  | {
      at: string;
      type: 'recorded';
      recordId: string;
      source: MemorySource;
      validTime: { from: string; to?: string };
    }
  | {
      at: string;
      type: MemoryDecisionKind;
      recordId: string;
      source: MemorySource;
      actor: string;
      reason?: string;
      successor?: string;
    }
  | {
      at: string;
      type: 'feedback';
      recordId: string;
      source: MemorySource;
      actor: string;
      signal: FeedbackSignal;
    };

/** The history projection: the belief state per record + the ordered event timeline. */
export interface HistoryResult {
  key: string;
  asOf?: string;
  records: readonly RecordBelief[];
  events: readonly HistoryEvent[];
}

// ─── audit ───────────────────────────────────────────────────────────────────

/** One verdict-axis transition in an audit trail. */
export interface AuditTransition {
  at: string;
  /** which axis changed: lifecycle, trust (a promotion), or the quarantine flag. */
  kind: 'lifecycle' | 'trust' | 'quarantine';
  from: string;
  to: string;
  actor: string;
  reason?: string;
  decisionId: string;
  source: MemorySource;
}

/** The audit trail for one record. */
export interface AuditRecordView {
  record: MemoryRecord | MemoryRecordV2;
  id: string;
  schemaVersion: '1' | '2';
  kind: MemoryRecordKind;
  subject: string;
  claim: string;
  placement: readonly MemorySource[];
  legacy: readonly MemoryAlias[];
  /** the stamped (as-of save / migration-snapshot) verdicts, when any exist. */
  stamped?: Verdicts;
  /** the current effective (read-projection) verdicts. */
  verdicts: EffectiveVerdicts;
  visibility: MemoryVisibility;
  validity: ValidityInterval;
  transitions: readonly AuditTransition[];
  /**
   * Trust promotions: `accept` decisions (the team-proposal pipeline writes them → trust 'team')
   * and `activate` decisions (→ trust 'local'). The kind→trust mapping is the promotion
   * pipeline's own convention, reported as such — the decision line is the source of truth.
   */
  promotions: readonly {
    at: string;
    actor: string;
    to: TrustVerdict;
    decisionId: string;
    source: MemorySource;
  }[];
  /** every supersession recorded against this record (the successor links ride on the decisions). */
  supersessions: readonly {
    at: string;
    successor?: string;
    actor: string;
    reason?: string;
    decisionId: string;
    source: MemorySource;
  }[];
  quarantines: readonly {
    at: string;
    actor: string;
    reason?: string;
    decisionId: string;
    source: MemorySource;
  }[];
  feedback: readonly { at: string; signal: FeedbackSignal; actor: string; source: MemorySource }[];
}

export interface AuditResult {
  requested: string;
  found: boolean;
  records: readonly AuditRecordView[];
}

// ─── the API ─────────────────────────────────────────────────────────────────

/** Constructor dependencies for {@link MemoryApi}. Every port is optional; ops degrade honestly. */
export interface MemoryApiDeps {
  /** the three stores, any of which may be absent (a fresh repo has no local store yet). */
  stores: RecallStores;
  /** env override (tests relocate `~/.crib/memory` via `KCRIB_MEMORY_DIR`). */
  env?: NodeJS.ProcessEnv;
  /** fixed clock for determinism (tests). Defaults to the wall clock. The clock never enters an id. */
  now?: () => string;
  /** the repo's `.crib` dir — resolves the repoId for repo-scoped capture (`readRepoId`). */
  cribDir?: string;
  /** the soul port {@link capture} auto-anchors against (absent → capture refuses loose refs). */
  soul?: MemoryAnchorPort;
  /** fresh-revaluation ports for `search` (both must be present for a fresh evaluation). */
  evaluator?: MemoryEvaluator;
  evalCtx?: MemoryEvalContext;
  /** the code HEAD search provenance reports (the serving layer knows git HEAD). */
  codeHead?: string;
}

/** Which record collection a store role holds its records in (local calls its bucket `active`). */
function recordCollectionOf(store: MemoryStore): MemoryCollection {
  return store.role === 'local' ? 'active' : 'records';
}

/** A gathered record tagged with the store it came from (history/audit gather across all stores). */
interface SourcedRecord {
  record: MemoryRecord | MemoryRecordV2;
  source: MemorySource;
  store: MemoryStore;
}

/** A gathered decision/feedback tagged with the store it was read from. */
interface SourcedDecision {
  decision: MemoryDecision;
  source: MemorySource;
}
interface SourcedFeedback {
  feedback: MemoryFeedback;
  source: MemorySource;
}

function isRecordEntry(e: { id?: unknown }): e is MemoryRecord | MemoryRecordV2 {
  return typeof e.id === 'string' && e.id.startsWith('mem:');
}
function isDecisionEntry(e: { id?: unknown }): e is MemoryDecision {
  return typeof e.id === 'string' && e.id.startsWith('dec:');
}
function isFeedbackEntry(e: { id?: unknown }): e is MemoryFeedback {
  return typeof e.id === 'string' && e.id.startsWith('fb:');
}

/**
 * The portable memory API (G1.3). Construct directly or via {@link createMemoryApi}. All ops are
 * store-backed: writes go through `MemoryStore`'s locked + atomic + validated + secret-scanned
 * gate, reads are lock-free. History is a READ projection — no op rewrites or removes an existing
 * record line (the only writes are new candidates, new successor records, and decision events).
 */
export class MemoryApi {
  private readonly deps: MemoryApiDeps;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nowFn: () => string;

  constructor(deps: MemoryApiDeps) {
    this.deps = deps;
    this.env = deps.env ?? process.env;
    this.nowFn = deps.now ?? (() => new Date().toISOString());
  }

  private now(): string {
    return this.nowFn();
  }

  // ── capture ────────────────────────────────────────────────────────────────

  /**
   * Loose observation → candidate tier (mirrors the MCP `memory{op:'capture'}` verb). Writes a
   * {@link MemoryCandidate} to the LOCAL `candidates` collection — never a record, never recall —
   * promotion stays a separate CLI/CI gate. Auto-anchored: the loose `symbols`/`files` refs
   * resolve to soul ids, and the first spanned symbol backs a self-checked `source-quote` evidence
   * item. Anchoring NEVER fails the capture; the result reports `anchorStatus`. Idempotent by
   * content id: a repeat capture of the same observation upserts the same `cand:` id.
   */
  capture(input: CaptureInput): CaptureResult {
    const local = this.deps.stores.local;
    if (!local) return { ok: false, error: 'no local memory store is configured for capture' };
    const kind = input.kind ?? 'fact';
    if (!isMemoryRecordKind(kind)) {
      return {
        ok: false,
        error: `invalid kind '${kind}' — expected one of fact, procedure, decision, pitfall, convention`,
      };
    }
    if (typeof input.subject !== 'string' || input.subject.length === 0) {
      return { ok: false, error: 'subject is required' };
    }
    if (typeof input.observation !== 'string' || input.observation.length === 0) {
      return { ok: false, error: 'observation is required' };
    }
    if (typeof input.actor !== 'string' || input.actor.length === 0) {
      return { ok: false, error: 'actor is required' };
    }
    const boundary = input.scopeBoundary ?? 'repo';
    const scope: MemoryScope = { boundary };
    if (boundary === 'repo') {
      const repoId = this.resolveRepoId(input.repoId);
      if (!repoId) {
        return {
          ok: false,
          error:
            'could not resolve a stable repoId for this repo — run `crib index` to register it before capturing repo-scoped memory',
        };
      }
      scope.repoId = repoId;
    }
    const hasRefs = (input.symbols?.length ?? 0) + (input.files?.length ?? 0) > 0;
    const port = this.deps.soul;
    if (!port && hasRefs) {
      return {
        ok: false,
        error:
          'capture anchoring requires a soul port — omit symbols/files or wire MemoryAnchorPort',
      };
    }
    const anchors = port
      ? resolveCaptureAnchors(port, input.symbols ?? [], input.files ?? [])
      : { resolved: [], ambiguous: [], unresolvable: [], spanNodes: [] };
    const anchorStatus: CaptureAnchorStatus =
      anchors.resolved.length > 0
        ? 'anchored'
        : anchors.ambiguous.length > 0
          ? 'ambiguous'
          : hasRefs
            ? 'unresolvable'
            : 'unanchored';
    // Ground the first spanned symbol with a lifted, self-checked quote (the 'valid' stamp is
    // earned through the SAME quote-overlap gate the enrich path uses — never assumed).
    const evidence: MemoryEvidence[] = [];
    if (port && anchors.spanNodes.length > 0) {
      const node = anchors.spanNodes[0];
      if (node) {
        const body = port.rehydrate(node);
        const quote = body.text.trim().slice(0, CAPTURE_QUOTE_MAX_CHARS);
        if (quote.length > 0 && verifyQuote(port, node, quote).verdict === 'grounded') {
          evidence.push({
            kind: 'source-quote',
            verdict: 'valid',
            checkedAt: this.now(),
            soulId: node.id,
            quote,
            targetHash: node.hash,
            ...(node.span ? { startLine: node.span.start } : {}),
          });
        }
      }
    }
    const appliesTo = [...new Set([...anchors.resolved, ...anchors.unresolvable])];
    const candidateInput = {
      kind,
      subject: input.subject,
      claim: input.observation,
      scope,
      appliesTo,
      evidence,
      authorship: {
        actor: input.actor,
        kind: 'agent' as const,
        ...(input.tool ? { tool: input.tool } : {}),
      },
    };
    const candidate: MemoryCandidate = {
      id: memoryCandidateId(candidateInput),
      schemaVersion: '1',
      ...candidateInput,
      origin: 'observe',
      proposedAt: this.now(),
      meta: { anchorStatus },
    };
    const duplicate = this.holdsDirect(local, candidate.id, 'candidates');
    local.upsertEntry('candidates', candidate); // write gate: validate + secret-scan
    return {
      ok: true,
      id: candidate.id,
      status: 'pending',
      origin: 'observe',
      scope: candidate.scope,
      anchorStatus,
      evidenceAttached: evidence.length > 0,
      anchors: anchors.resolved,
      ambiguous: anchors.ambiguous,
      unresolvable: anchors.unresolvable,
      duplicate,
    };
  }

  // ── search ─────────────────────────────────────────────────────────────────

  /**
   * The rich search over the recall projection. Ranking, alias bridging, conflict grouping and
   * eligibility are ALL delegated to {@link recallProjection} — this method only enriches each hit
   * with the G1.3 contract (visibility, effective verdicts + evidence, freshness, validity,
   * lineage, score + ranking version, conflicts, superseded alternatives, placement).
   */
  search(query: string, opts: SearchOpts = {}): SearchResponse {
    const gathered = gatherRecall(this.deps.stores, {
      sources: opts.sources ?? DEFAULT_RECALL_SOURCES,
    });
    const projection = recallProjection(gathered, {
      query,
      ...(opts.targetIds ? { targetIds: opts.targetIds } : {}),
      ...(opts.lexicalScorer ? { lexicalScorer: opts.lexicalScorer } : {}),
      ...(opts.feedbackBound !== undefined ? { feedbackBound: opts.feedbackBound } : {}),
      evaluator: opts.evaluator ?? this.deps.evaluator,
      ...((opts.evalCtx ?? this.deps.evalCtx)
        ? { evalCtx: (opts.evalCtx ?? this.deps.evalCtx) as MemoryEvalContext }
        : {}),
    });
    const aliasIndex = buildAliasIndex(gathered.aliases ?? []);
    // DETERMINISTIC by construction: no wall clock enters the response — `state` carries the
    // freshness signal, so two identical searches over identical inputs are byte-equal and ifHash
    // can collapse the second call (a `this.now()` stamp here would break that permanently).
    const evaluatedAt: string | null = null;
    const codeHead: string | null = opts.codeHead ?? this.deps.codeHead ?? null;
    const freshness: FreshnessState = {
      state: projection.provenance.fresh ? 'fresh' : 'unevaluated',
      evaluatedAt,
      codeHead,
    };
    const allDecisions = [...gathered.decisions, ...gathered.localDecisions];
    const hits: SearchHit[] = projection.memories.map((scored) =>
      this.enrichHit(scored.record, scored.source, scored.score, scored.verdicts, {
        aliasIndex,
        // NO-POISON, the same pool split get() applies: LOCAL decisions name successors of
        // LOCAL-sourced records only. The hit's VERDICTS above already come from the projection
        // (which holds the line); supersededBy must not leak around it — a team-sourced hit
        // listing a local successor would be self-inconsistent within one response (lifecycle
        // 'active' while supersededBy names a retiree the team store never accepted).
        allDecisions: scored.source === 'local' ? allDecisions : gathered.decisions,
        gatheredRecords: gathered.records.map((t) => t.record),
        conflicts: projection.conflicts,
        freshness,
      }),
    );
    return {
      query,
      hits,
      conflicts: projection.conflicts.map((c) => conflictSummaryOf(c)),
      provenance: {
        rankingVersion: RANKING_VERSION,
        sources: projection.provenance.sources,
        counts: projection.provenance.counts,
        fresh: projection.provenance.fresh,
        evaluatedAt,
        codeHead,
        errors: gathered.errors,
      },
    };
  }

  // ── get ────────────────────────────────────────────────────────────────────

  /**
   * The rich single-record lookup. Resolves legacy v1 ids through the alias map exactly like
   * `MemoryStore.findEntry` (a DIRECT hit always wins over the alias — the team store retains live
   * v1 lines), reports which binding was followed, and carries the effective verdicts with the
   * no-poison rule honoured (local decisions fold into local-sourced records only).
   */
  get(idOrAlias: string): GetResult {
    const notFound = (requestedId: string): GetResult => ({
      found: false,
      requestedId,
      legacyIds: [],
      legacy: [],
      placement: [],
    });
    if (typeof idOrAlias !== 'string' || idOrAlias.length === 0) return notFound(idOrAlias);
    const located = this.locate(idOrAlias);
    if (!located) return notFound(idOrAlias);
    const { record, source, viaAlias } = located;
    const aliasIndex = this.buildAliasIndex();
    const legacy = aliasIndex.aliasesFor(record.id);
    const decisions = this.allDecisions();
    // No-poison: local decisions fold into LOCAL-sourced records only (a local quarantine must not
    // retract the same-id team record) — the same rule recallProjection applies.
    const pool = source === 'local' ? decisions : decisions.filter((d) => d.source !== 'local');
    const bridged = bridgedDecisions(
      legacy,
      record.id,
      pool.map((d) => d.decision),
    );
    const verdicts = effectiveVerdicts(record, bridged, undefined, conservativeVerdicts(legacy));
    return {
      found: true,
      requestedId: idOrAlias,
      id: record.id,
      ...(viaAlias ? { resolvedViaAlias: viaAlias } : {}),
      record,
      legacyIds: legacy.map((a) => a.legacyId),
      legacy,
      placement: this.placementsOf(record.id),
      source,
      visibility: visibilityOf(record),
      validity: validityOf(record),
      verdicts,
      evidence: evidenceSummaries(record),
      lineage: lineageOf(record),
      ...(isMemoryRecordV2(record) ? { propositionKey: record.propositionKey } : {}),
      ...(!isMemoryRecordV2(record) ? { scope: record.scope } : {}),
      supersededBy: this.supersededBy(
        record,
        aliasIndex,
        pool.map((d) => d.decision),
        // The gathered records (deduped by id, team bytes win) feed the lineage scan: a v2
        // record whose lineage.supersedes declares this record surfaces here exactly as it does
        // in search() — an empty pool made via:'lineage' unreachable from get().
        this.gatherAllRecords().map((r) => r.record),
      ),
    };
  }

  // ── supersede ──────────────────────────────────────────────────────────────

  /**
   * Retire `id` in favour of a successor — `lineage.supersedes` on both sides + the lifecycle
   * change, with history preserved:
   *
   *   - the SUPERSEDED record is never rewritten (append-only): its lifecycle change is the
   *     `supersede` decision appended to the store that holds it (team decisions are authoritative
   *     across stores; a local decision retires the local copy only — the no-poison rule);
   *   - the SUCCESSOR carries `lineage.supersedes` (created with it for a payload successor;
   *     upserted onto an existing memory-2 successor — lineage is mutable relationship state,
   *     excluded from the content id, so the id never moves);
   *   - an existing memory-1 successor has no lineage field — the decision is the only link.
   *
   * Idempotent: the decision is content-addressed over `{kind, subject, successor, actor, reason}`
   * and a payload successor over its v2 content seed, so a repeat call re-upserts byte-stable ids.
   */
  supersede(
    id: string,
    byIdOrPayload: string | SupersedePayload,
    opts: SupersedeOpts,
  ): SupersedeResult {
    if (typeof opts.actor !== 'string' || opts.actor.length === 0) {
      return { ok: false, error: 'actor is required' };
    }
    const located = this.locate(id);
    if (!located) return { ok: false, error: `record '${id}' not found in any store` };
    const supersededId = located.record.id; // the RESOLVED id — decisions key on the live record
    const decisionStore = this.decisionStoreFor(supersededId, located.store);

    let successorId: string;
    let successorCreated = false;
    if (typeof byIdOrPayload === 'string') {
      const successor = this.locate(byIdOrPayload);
      if (!successor) {
        return { ok: false, error: `successor record '${byIdOrPayload}' not found in any store` };
      }
      successorId = successor.record.id;
      // Both sides for an existing memory-2 successor: stamp the forward lineage link (id-stable —
      // lineage is excluded from the v2 content seed). A memory-1 successor has no lineage field.
      if (isMemoryRecordV2(successor.record)) {
        const supersedes = new Set(successor.record.lineage.supersedes ?? []);
        if (!supersedes.has(supersededId)) {
          supersedes.add(supersededId);
          const updated: MemoryRecordV2 = {
            ...successor.record,
            lineage: { ...successor.record.lineage, supersedes: [...supersedes].sort() },
          };
          successor.store.upsertEntry(recordCollectionOf(successor.store), updated);
        }
      }
    } else {
      const payload = byIdOrPayload;
      if (typeof payload.claim !== 'string' || payload.claim.length === 0) {
        return { ok: false, error: 'supersede payload requires a claim' };
      }
      const subject = payload.subject ?? located.record.subject;
      const kind = payload.kind ?? located.record.kind;
      const propositionKey = derivePropositionKey({
        subject,
        ...(payload.propositionKey ? { propositionKey: payload.propositionKey } : {}),
      });
      const now = this.now();
      const successor: MemoryRecordV2 = {
        id: memoryRecordV2Id({
          kind,
          subject,
          propositionKey,
          claim: payload.claim,
          evidence: payload.evidence ?? [],
        }),
        schemaVersion: '2',
        visibility: payload.visibility ?? 'private',
        kind,
        subject,
        propositionKey,
        claim: payload.claim,
        validTime: { from: now },
        transactionTime: { observedAt: now, recordedAt: now },
        evidence: payload.evidence ?? [],
        provenance: migrationProvenance(
          { actor: opts.actor, kind: 'agent', ...(opts.tool ? { tool: opts.tool } : {}) },
          {},
          this.env,
        ),
        lineage: { supersedes: [supersededId] },
        sensitivity: payload.sensitivity ?? 'internal',
        retentionPolicyId: DEFAULT_RETENTION_POLICY_ID,
      };
      successorId = successor.id;
      successorCreated = !this.holdsDirect(
        decisionStore,
        successor.id,
        recordCollectionOf(decisionStore),
      );
      decisionStore.upsertEntry(recordCollectionOf(decisionStore), successor);
    }

    const decision = supersedeDecision(
      { id: supersededId },
      { id: successorId },
      opts.actor,
      opts.reason ?? 'superseded via the portable memory API',
      this.now(),
    );
    decisionStore.upsertEntry('decisions', decision);
    return {
      ok: true,
      supersededId,
      successorId,
      decisionId: decision.id,
      successorCreated,
      decisionSource: decisionStore.role,
    };
  }

  // ── delete (tombstone) ─────────────────────────────────────────────────────

  /**
   * Soft-delete: append a `retract` decision so search excludes the record while the record line —
   * and therefore history/audit — survives (the bi-temporal contract: memory is append-only, so
   * "delete" is a belief change, never a byte removal). Idempotent by decision content id.
   */
  delete(id: string, opts: DeleteOpts): DeleteResult {
    if (typeof opts.actor !== 'string' || opts.actor.length === 0) {
      return { ok: false, error: 'actor is required' };
    }
    const located = this.locate(id);
    if (!located) return { ok: false, error: `record '${id}' not found in any store` };
    const resolvedId = located.record.id;
    const store = this.decisionStoreFor(resolvedId, located.store);
    const reason = opts.reason ?? 'retracted (tombstoned) via the portable memory API';
    const decision: MemoryDecision = {
      id: decisionId({ kind: 'retract', subject: resolvedId, actor: opts.actor, reason }),
      schemaVersion: '1',
      kind: 'retract',
      subject: resolvedId,
      actor: opts.actor,
      reason,
      ts: this.now(),
    };
    store.upsertEntry('decisions', decision);
    return {
      ok: true,
      id: resolvedId,
      decisionId: decision.id,
      mode: 'tombstone',
      decisionSource: store.role,
    };
  }

  // ── history ───────────────────────────────────────────────────────────────

  /**
   * THE point-in-time projection. `key` matches a record id (legacy or v2 — the alias map
   * resolves), a subject key, or a proposition key. Without `asOf`: the full belief timeline —
   * every matching record's validity interval and every decision/feedback event, ordered. With
   * `asOf`: only records recorded ≤ `asOf`, only decision events with `ts <= asOf` overlaid — what
   * was believed then, including the as-believed v1 state recovered from the alias bindings.
   */
  history(key: string, opts: HistoryOpts = {}): HistoryResult {
    const asOf = opts.asOf;
    // asOf is NORMALIZED ONCE to a parsed instant: raw string compares mis-cut second-precision
    // asOf against millisecond-precision events ('.999Z' vs 'Z' ordering) and silently mis-filter
    // date-only / offset forms. Unparseable asOf is a rejected argument, never a silent filter.
    let asOfMs: number | undefined;
    if (asOf !== undefined) {
      const parsed = Date.parse(asOf);
      if (Number.isNaN(parsed)) {
        throw new Error(`asOf '${asOf}' is not a parseable ISO instant`);
      }
      asOfMs = parsed;
    }
    // Cut on PARSED instants; fall back to the string compare only when a side fails to parse
    // (persisted timestamps are ISO, so this is a belt-and-braces guard, never the main path).
    const atOrBefore = (ts: string): boolean => {
      if (asOfMs === undefined) return true;
      const t = Date.parse(ts);
      if (Number.isNaN(t)) return ts <= (asOf as string);
      return t <= asOfMs;
    };
    const records = this.gatherAllRecords();
    const aliasIndex = this.buildAliasIndex();
    const matched = matchKey(records, aliasIndex, key);
    const decisions = this.allDecisions();
    const feedback = this.allFeedback();

    const beliefs: RecordBelief[] = [];
    const events: HistoryEvent[] = [];
    for (const { record, source } of matched) {
      const recordedAt = validityOf(record).transactionTime.recordedAt;
      if (!atOrBefore(recordedAt)) continue; // not yet known then
      const legacy = aliasIndex.aliasesFor(record.id);
      const legacyIds = new Set(legacy.map((a) => a.legacyId));
      // The record's own decision/feedback events — RAW (subject = the record id OR a bound legacy
      // id); the bridge to the record id happens only inside the lifecycle computation below.
      const mine = decisions.filter(
        (d) => d.decision.subject === record.id || legacyIds.has(d.decision.subject),
      );
      const myFeedback = feedback.filter(
        (f) => f.feedback.subject === record.id || legacyIds.has(f.feedback.subject),
      );
      const asOfMine = asOfMs !== undefined ? mine.filter((d) => atOrBefore(d.decision.ts)) : mine;
      // The NO-POISON rule get()/search() already honour: local decisions fold into LOCAL-sourced
      // records only — a local quarantine must not retract the same-id team record. The RAW events
      // above keep every recorded decision; only the DERIVED belief fields use the filtered pool.
      const beliefPool = source === 'local' ? mine : mine.filter((d) => d.source !== 'local');
      const asOfBelief =
        asOfMs !== undefined ? beliefPool.filter((d) => atOrBefore(d.decision.ts)) : beliefPool;
      // Multi-alias bridge: decisions keyed on ANY bound legacy id attach as in-memory copies
      // re-subjected to the record id (the collapsed-twin rule — never a last-wins pick).
      const bridged = bridgedDecisions(
        legacy,
        record.id,
        asOfBelief.map((d) => d.decision),
      );
      // The belief folds from the SAME stamped base effectiveVerdicts uses — the v1 record's own
      // `verdicts.lifecycle`, the v2 conservative alias snapshot — so a hand-stamped shard reports
      // ONE lifecycle across get/audit/history (the divergent three-way state is not projected).
      const stampedBase: LifecycleVerdict = isMemoryRecordV2(record)
        ? (conservativeVerdicts(legacy)?.lifecycle ?? 'active')
        : record.verdicts.lifecycle;
      const { lifecycle, quarantined } = believedLifecycle(bridged, stampedBase);
      beliefs.push({
        record,
        id: record.id,
        schemaVersion: isMemoryRecordV2(record) ? '2' : '1',
        subject: record.subject,
        claim: record.claim,
        recordedAt,
        validTime: validityOf(record).validTime,
        legacy,
        lifecycle,
        quarantined,
        ...(asOf !== undefined
          ? {
              validTimeHolds: validTimeHoldsAt(validityOf(record).validTime, asOf),
              validTimeWindow: validTimeWindowOf(validityOf(record).validTime),
            }
          : {}),
        placement: this.placementsOf(record.id),
      });
      events.push({
        at: recordedAt,
        type: 'recorded',
        recordId: record.id,
        source,
        validTime: validityOf(record).validTime,
      });
      for (const { decision, source: dSource } of asOfMine) {
        events.push({
          at: decision.ts,
          type: decision.kind,
          recordId: record.id,
          source: dSource,
          actor: decision.actor,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.successor ? { successor: decision.successor } : {}),
        });
      }
      const asOfFeedback =
        asOfMs !== undefined ? myFeedback.filter((f) => atOrBefore(f.feedback.ts)) : myFeedback;
      for (const { feedback: fb, source: fSource } of asOfFeedback) {
        events.push({
          at: fb.ts,
          type: 'feedback',
          recordId: record.id,
          source: fSource,
          actor: fb.actor,
          signal: fb.signal,
        });
      }
    }
    events.sort((a, b) =>
      a.at === b.at ? stableEventKey(a).localeCompare(stableEventKey(b)) : a.at.localeCompare(b.at),
    );
    return {
      key,
      ...(asOf !== undefined ? { asOf } : {}),
      records: beliefs,
      events,
    };
  }

  // ── sync (declared, honestly unavailable) ──────────────────────────────────

  /**
   * The declared sync capability. Returns an honest not-available response naming Gate 4 — the
   * contract registers the operation everywhere, but no sync engine exists in this release and
   * nothing is pretended. Do NOT implement the engine here (Gate 4 owns it).
   */
  sync(request: Record<string, unknown> = {}): SyncResult {
    return syncNotAvailable(request);
  }

  // ── audit ──────────────────────────────────────────────────────────────────

  /**
   * The audit trail for a record id, legacy id, subject key, or proposition key: stamped + effective
   * verdicts, verdict transitions (lifecycle / trust promotions / quarantines), supersessions, and
   * feedback, with timestamps — the tombstone-and-decide history the PRD's append-only ledger
   * makes possible. The RAW event lists (transitions/quarantines/promotions/supersessions) gather
   * decisions from EVERY store (audit is reporting — a recorded local quarantine stays visible).
   * The COMPUTED `verdicts` honour the same no-poison rule as get()/search(): local decisions fold
   * into local-SOURCED records only, so a local quarantine never retracts the same-id team record.
   */
  audit(idOrSubject: string): AuditResult {
    const records = this.gatherAllRecords();
    const aliasIndex = this.buildAliasIndex();
    const matched = matchKey(records, aliasIndex, idOrSubject);
    if (matched.length === 0) return { requested: idOrSubject, found: false, records: [] };
    const decisions = this.allDecisions();
    const feedback = this.allFeedback();
    const views: AuditRecordView[] = [];
    for (const { record, source } of matched) {
      const legacy = aliasIndex.aliasesFor(record.id);
      const legacyIds = new Set(legacy.map((a) => a.legacyId));
      const mine = decisions
        .filter((d) => d.decision.subject === record.id || legacyIds.has(d.decision.subject))
        .sort((a, b) => a.decision.ts.localeCompare(b.decision.ts));
      // The no-poison pool for the COMPUTED verdicts only — `mine` stays raw for the event lists.
      const beliefPool = source === 'local' ? mine : mine.filter((d) => d.source !== 'local');
      const bridged = bridgedDecisions(
        legacy,
        record.id,
        beliefPool.map((d) => d.decision),
      );
      const stamped: Verdicts | undefined = isMemoryRecordV2(record)
        ? conservativeVerdicts(legacy)
        : record.verdicts;
      const verdicts = effectiveVerdicts(record, bridged, undefined, stamped);
      views.push(this.auditView(record, legacy, stamped, verdicts, mine, feedback, legacyIds));
    }
    return { requested: idOrSubject, found: true, records: views };
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private resolveRepoId(explicit?: string): string | undefined {
    if (explicit !== undefined && explicit.length > 0) return explicit;
    if (this.deps.cribDir) return readRepoId(this.deps.cribDir, this.env);
    return undefined;
  }

  /** The present stores in locate order (local → team → global, mirroring the MCP verb). */
  private orderedStores(): { source: MemorySource; store: MemoryStore }[] {
    const { local, team, global } = this.deps.stores;
    const out: { source: MemorySource; store: MemoryStore }[] = [];
    if (local) out.push({ source: 'local', store: local });
    if (team) out.push({ source: 'team', store: team });
    if (global) out.push({ source: 'global', store: global });
    return out;
  }

  /**
   * Locate a record by id (or legacy id): per store, a DIRECT hit wins; otherwise the alias map is
   * followed to the migrated twin (mirroring `MemoryStore.findEntry`), reporting the binding.
   */
  private locate(id: string):
    | {
        record: MemoryRecord | MemoryRecordV2;
        source: MemorySource;
        store: MemoryStore;
        viaAlias?: MemoryAlias;
      }
    | undefined {
    for (const { source, store } of this.orderedStores()) {
      const collection = recordCollectionOf(store);
      const direct = this.directEntry(store, collection, id);
      if (direct && isRecordEntry(direct)) return { record: direct, source, store };
      const alias = this.readAliasSafe(store, id);
      if (alias && alias.resolvedId !== id) {
        const twin = this.directEntry(store, collection, alias.resolvedId);
        if (twin && isRecordEntry(twin)) return { record: twin, source, store, viaAlias: alias };
      }
    }
    return undefined;
  }

  /** The entry with EXACTLY this id in its shard (no alias chase) — the direct-presence check. */
  private directEntry(
    store: MemoryStore,
    collection: MemoryCollection,
    id: string,
  ): MemoryEntry | undefined {
    return store.readShard(collection, memoryShard(id)).entries.find((e) => e.id === id);
  }

  /** Whether the store physically holds this exact id in `collection` (no alias chase). */
  private holdsDirect(store: MemoryStore, id: string, collection: MemoryCollection): boolean {
    return this.directEntry(store, collection, id) !== undefined;
  }

  private readAliasSafe(store: MemoryStore, legacyId: string): MemoryAlias | undefined {
    try {
      return store.readAlias(legacyId);
    } catch {
      return undefined; // a corrupt alias shard fails the alias chase; a direct hit already won
    }
  }

  /** Which present stores physically hold this exact record id (storage placement). */
  private placementsOf(id: string): MemorySource[] {
    const out: MemorySource[] = [];
    for (const { source, store } of this.orderedStores()) {
      if (this.holdsDirect(store, id, recordCollectionOf(store))) out.push(source);
    }
    return out;
  }

  /**
   * The store a lifecycle decision for `recordId` belongs in: the most AUTHORITATIVE store holding
   * the record (team > local > global — a team decision retires the claim everywhere; a local
   * decision retires the local copy only, per the no-poison rule). Falls back to the located store.
   */
  private decisionStoreFor(recordId: string, located: MemoryStore): MemoryStore {
    const placement = this.placementsOf(recordId);
    for (const role of ['team', 'local', 'global'] as const) {
      if (!placement.includes(role)) continue;
      const store = this.orderedStores().find((s) => s.source === role)?.store;
      if (store) return store;
    }
    return located;
  }

  /** Every record across the present stores, deduped by id (team bytes win — authoritative). */
  private gatherAllRecords(): SourcedRecord[] {
    const order: MemorySource[] = ['team', 'local', 'global'];
    const byId = new Map<string, SourcedRecord>();
    for (const source of order) {
      const store = this.orderedStores().find((s) => s.source === source)?.store;
      if (!store) continue;
      const read = store.readCollection(recordCollectionOf(store));
      for (const entry of read.entries) {
        if (!isRecordEntry(entry)) continue;
        if (!byId.has(entry.id)) byId.set(entry.id, { record: entry, source, store });
      }
    }
    return [...byId.values()];
  }

  /** Every decision across the present stores (team, global, AND local — reporting sees all). */
  private allDecisions(): SourcedDecision[] {
    const out: SourcedDecision[] = [];
    for (const { source, store } of this.orderedStores()) {
      const read = store.readCollection('decisions');
      for (const entry of read.entries) {
        if (isDecisionEntry(entry)) out.push({ decision: entry, source });
      }
    }
    return out;
  }

  /** Every feedback event across the present stores that HOLD a feedback collection (team has none
   *  — its role holds records/decisions/receipts only, and readCollection throws for the rest). */
  private allFeedback(): SourcedFeedback[] {
    const out: SourcedFeedback[] = [];
    for (const { source, store } of this.orderedStores()) {
      if (!store.collections.includes('feedback')) continue; // team: no feedback collection
      const read = store.readCollection('feedback');
      for (const entry of read.entries) {
        if (isFeedbackEntry(entry)) out.push({ feedback: entry, source });
      }
    }
    return out;
  }

  /** The alias index over EVERY present store's alias map (fail-closed on a moved seed). */
  private buildAliasIndex(): AliasIndex {
    const aliases: MemoryAlias[] = [];
    for (const { store } of this.orderedStores()) {
      aliases.push(...store.readAliases());
    }
    return buildAliasIndex(aliases);
  }

  /**
   * Enrich one recall-projection hit into a {@link SearchHit}. Everything rank-related (score,
   * verdicts, source) comes from the projection itself — never recomputed here.
   */
  private enrichHit(
    record: MemoryRecord | MemoryRecordV2,
    source: MemorySource,
    score: RecallScore,
    verdicts: EffectiveVerdicts,
    ctx: {
      aliasIndex: AliasIndex;
      allDecisions: readonly MemoryDecision[];
      gatheredRecords: readonly MemoryRecord[];
      conflicts: readonly {
        key: string;
        subject: string;
        scope?: { boundary: string; repoId?: string };
        propositionKey?: string;
        records: (MemoryRecord | MemoryRecordV2)[];
      }[];
      freshness: FreshnessState;
    },
  ): SearchHit {
    const conflicts = ctx.conflicts
      .filter((c) => c.records.some((r) => r.id === record.id))
      .map((c) => conflictSummaryOf(c));
    return {
      record,
      id: record.id,
      schemaVersion: isMemoryRecordV2(record) ? '2' : '1',
      kind: record.kind,
      subject: record.subject,
      claim: record.claim,
      visibility: visibilityOf(record),
      ...(isMemoryRecordV2(record) ? { propositionKey: record.propositionKey } : {}),
      ...(!isMemoryRecordV2(record) ? { scope: record.scope } : {}),
      source,
      placement: this.placementsOf(record.id),
      verdicts,
      evidence: evidenceSummaries(record),
      freshness: ctx.freshness,
      validity: validityOf(record),
      lineage: lineageOf(record),
      score,
      rankingVersion: RANKING_VERSION,
      conflicts,
      supersededBy: this.supersededBy(
        record,
        ctx.aliasIndex,
        ctx.allDecisions,
        ctx.gatheredRecords,
      ),
    };
  }

  /**
   * The successors that retired (or declare they retire) `record`: `supersede` decisions naming it
   * (bridged from legacy ids) PLUS other gathered memory-2 records whose `lineage.supersedes`
   * declares it — a declaration the ranking does not read, surfaced here precisely because it
   * would otherwise be silent. Dangling links are reported `found: false`, never dropped.
   */
  private supersededBy(
    record: MemoryRecord | MemoryRecordV2,
    aliasIndex: AliasIndex,
    decisions: readonly MemoryDecision[],
    gatheredRecords: readonly (MemoryRecord | MemoryRecordV2)[],
  ): SupersededAlternative[] {
    const out = new Map<string, SupersededAlternative>();
    const bridged = bridgedDecisions(aliasIndex.aliasesFor(record.id), record.id, decisions);
    for (const d of bridged) {
      // Only decisions that NAME this record as their subject retire it (a bridged copy carries
      // subject = record.id). Without the subject filter, every supersede decision in the pool
      // would attach to EVERY record — a successor would even list itself.
      if (d.kind !== 'supersede' || !d.successor || d.subject !== record.id) continue;
      out.set(d.successor, { id: d.successor, via: 'decision', found: false });
    }
    for (const other of gatheredRecords) {
      if (other.id === record.id || !isMemoryRecordV2(other)) continue;
      if (!(other.lineage.supersedes ?? []).includes(record.id)) continue;
      if (!out.has(other.id)) out.set(other.id, { id: other.id, via: 'lineage', found: false });
    }
    for (const alt of out.values()) {
      const located = this.locate(alt.id);
      if (located) {
        alt.found = true;
        alt.subject = located.record.subject;
        alt.claim = located.record.claim;
      }
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Build one record's audit view (transitions walked in decision-time order). */
  private auditView(
    record: MemoryRecord | MemoryRecordV2,
    legacy: readonly MemoryAlias[],
    stamped: Verdicts | undefined,
    verdicts: EffectiveVerdicts,
    decisions: readonly SourcedDecision[],
    feedback: readonly SourcedFeedback[],
    legacyIds: ReadonlySet<string>,
  ): AuditRecordView {
    const transitions: AuditTransition[] = [];
    const promotions: {
      at: string;
      actor: string;
      to: TrustVerdict;
      decisionId: string;
      source: MemorySource;
    }[] = [];
    const supersessions: {
      at: string;
      successor?: string;
      actor: string;
      reason?: string;
      decisionId: string;
      source: MemorySource;
    }[] = [];
    const quarantines: {
      at: string;
      actor: string;
      reason?: string;
      decisionId: string;
      source: MemorySource;
    }[] = [];
    let lifecycle: LifecycleVerdict = stamped?.lifecycle ?? 'active';
    let trust: TrustVerdict = stamped?.trust ?? 'candidate';
    let quarantined = false;
    for (const { decision, source: dSource } of decisions) {
      const base = {
        at: decision.ts,
        actor: decision.actor,
        decisionId: decision.id,
        source: dSource,
      };
      if (decision.reason !== undefined) Object.assign(base, { reason: decision.reason });
      if (decision.kind === 'supersede') {
        supersessions.push({
          ...base,
          ...(decision.successor ? { successor: decision.successor } : {}),
        });
        if (lifecycle !== 'superseded' && lifecycle !== 'retracted') {
          transitions.push({ ...base, kind: 'lifecycle', from: lifecycle, to: 'superseded' });
          lifecycle = 'superseded';
        }
      } else if (decision.kind === 'retract') {
        if (lifecycle !== 'retracted') {
          transitions.push({ ...base, kind: 'lifecycle', from: lifecycle, to: 'retracted' });
          lifecycle = 'retracted';
        }
      } else if (decision.kind === 'quarantine') {
        quarantines.push({ ...base });
        if (!quarantined) {
          transitions.push({ ...base, kind: 'quarantine', from: 'false', to: 'true' });
          quarantined = true;
        }
      } else if (decision.kind === 'accept' || decision.kind === 'activate') {
        const to: TrustVerdict = decision.kind === 'accept' ? 'team' : 'local';
        promotions.push({
          at: decision.ts,
          actor: decision.actor,
          to,
          decisionId: decision.id,
          source: dSource,
        });
        if (trust !== to) {
          transitions.push({ ...base, kind: 'trust', from: trust, to });
          trust = to;
        }
      }
    }
    const myFeedback = feedback
      .filter((f) => f.feedback.subject === record.id || legacyIds.has(f.feedback.subject))
      .map((f) => ({
        at: f.feedback.ts,
        signal: f.feedback.signal,
        actor: f.feedback.actor,
        source: f.source,
      }))
      .sort((a, b) => a.at.localeCompare(b.at));
    return {
      record,
      id: record.id,
      schemaVersion: isMemoryRecordV2(record) ? '2' : '1',
      kind: record.kind,
      subject: record.subject,
      claim: record.claim,
      placement: this.placementsOf(record.id),
      legacy,
      ...(stamped ? { stamped } : {}),
      verdicts,
      visibility: visibilityOf(record),
      validity: validityOf(record),
      transitions,
      promotions,
      supersessions,
      quarantines,
      feedback: myFeedback,
    };
  }
}

/** Convenience factory (the MCP/CLI adapters construct the API the same way). */
export function createMemoryApi(deps: MemoryApiDeps): MemoryApi {
  return new MemoryApi(deps);
}

// ─── pure module helpers ─────────────────────────────────────────────────────

/** v2 lineage verbatim; v1 has no lineage field — `{}` (supersession is decision-driven there). */
function lineageOf(record: MemoryRecord | MemoryRecordV2): {
  derivedFrom?: string[];
  supersedes?: string[];
  contradicts?: string[];
} {
  return isMemoryRecordV2(record) ? record.lineage : {};
}

/** Reduce a projection conflict group to its id-only summary. */
function conflictSummaryOf(c: {
  key: string;
  subject: string;
  scope?: { boundary: string; repoId?: string };
  propositionKey?: string;
  records: readonly (MemoryRecord | MemoryRecordV2)[];
}): ConflictSummary {
  return {
    key: c.key,
    subject: c.subject,
    ...(c.propositionKey !== undefined ? { propositionKey: c.propositionKey } : {}),
    ...(c.scope !== undefined ? { scope: c.scope } : {}),
    recordIds: c.records.map((r) => r.id),
  };
}

/**
 * Match `key` against gathered records: by record id (v2 or v1), by subject, by proposition key,
 * OR through the alias map (a legacy id resolves to its twin; a record whose bound legacy ids
 * include the key matches). Deduped by id in gather order (team bytes win).
 */
function matchKey(
  records: readonly SourcedRecord[],
  aliasIndex: AliasIndex,
  key: string,
): SourcedRecord[] {
  const resolved = aliasIndex.resolve(key);
  const matched = records.filter(({ record }) => {
    if (record.id === key) return true;
    if (record.subject === key) return true;
    if (isMemoryRecordV2(record) && record.propositionKey === key) return true;
    if (resolved !== undefined && record.id === resolved) return true;
    return aliasIndex.aliasesFor(record.id).some((a) => a.legacyId === key);
  });
  return matched;
}

/** A stable secondary sort key so events with equal timestamps keep a deterministic order: the
 *  `recorded` event of a record precedes same-instant decision/feedback events about it (a belief
 *  must be recorded before anything can be decided about it), then type, then record id. */
function stableEventKey(e: HistoryEvent): string {
  const typeOrder = e.type === 'recorded' ? 0 : e.type === 'feedback' ? 2 : 1;
  return `${e.at}|${typeOrder}|${e.type}|${e.recordId}`;
}
