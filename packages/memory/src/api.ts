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
 *   - **`sync` is honest.** The Gate-4 engine runs over an INJECTED {@link SyncObjectStore} port;
 *     an unconfigured repo reports not-configured and names the seeding command — nothing is
 *     pretended, and nothing is invented to fill a missing port.
 *
 * Store-backed, not IO-abstracted: the ops read/write through {@link MemoryStore}'s locked +
 * atomic + validated + secret-scanned write gate. The pure helpers ({@link believedLifecycle},
 * {@link validTimeHoldsAt}, {@link validityOf}, {@link visibilityOf}, {@link syncNotConfigured},
 * {@link isCleanGitTree}, {@link gitLogSHits}) are exported separately for unit testing and for SDK
 * ports that need the same semantics without a store. NO wall-clock read inside any id/hash/pure
 * function — the clock enters only through the caller-supplied `now` port.
 */
import { spawnSync } from 'node:child_process';
import { type RehydratedBody, type SoulStore, rehydrateBody } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import {
  type AliasIndex,
  bridgedDecisions,
  buildAliasIndex,
  conservativeVerdicts,
} from './aliases.js';
import { type CapturePolicyViolation, checkCapturePolicy } from './capture-policy.js';
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
  admissibilityProblems,
  conflictGroups,
  effectiveVerdicts,
  isRecallEligible,
  recordSortTime,
  supersedeDecision,
} from './evaluator.js';
import {
  type DependencyGenerations,
  type GenerationCache,
  UNVERSIONED,
  attachVolatileFreshness,
  entrySetFingerprint,
  evaluationCacheFor,
} from './generation-cache.js';
import { verifyQuote } from './grounding.js';
import {
  type HandoffAttemptEvent,
  type HandoffInput,
  type HandoffResponse,
  buildHandoff,
} from './handoff.js';
import type { AgentProfileDirectory } from './identity-directory.js';
import {
  decisionId,
  derivePropositionKey,
  memoryCandidateId,
  memoryRecordV2Id,
  memoryShard,
} from './ids.js';
import { type IntakeProjection, projectIntakes } from './intake-projection.js';
import {
  type IntakeCheckpointInput,
  type IntakeRequirementInput,
  createIntakeCheckpoint,
  createIntakeRequirement,
} from './intake.js';
import { type IntelligenceEventJournal, resolveServerIdentity } from './intelligence-events.js';
import type { ProjectionCheckpointStore } from './intelligence-projections.js';
import {
  DEFAULT_LEDGER_PAGE,
  LEDGER_GROUPS,
  type LedgerGroup,
  type LedgerOpts,
  type LedgerResult,
  type LedgerRow,
  MAX_LEDGER_PAGE,
  capClaim,
  correlateAnchors,
  ledgerGroupOf,
  standingOf,
} from './ledger.js';
import {
  DEFAULT_MIGRATION_PRINCIPAL_ID,
  DEFAULT_RETENTION_POLICY_ID,
  migrationProvenance,
} from './migrations.js';
import { buildCaptureOutboxEntry, pendingCaptures, stageCaptureOutboxEntry } from './outbox.js';
import { readRepoId } from './paths.js';
import { type CapturePolicySection, loadPolicy, trustedRefOf } from './policy.js';
import {
  DEFAULT_RECALL_SOURCES,
  type GatheredRecall,
  type LexicalScorer,
  type MemorySource,
  type RecallScore,
  type RecallStores,
  gatherRecall,
  recallProjection,
} from './recall.js';
import { assertNoMemorySecrets } from './secrets.js';
import type { MemoryCollection, MemoryStore } from './store.js';
import { TeamPrivateVisibilityError } from './store.js';
import type { SyncObjectStore } from './sync/adapter.js';
import { type SeedBaselineResult, seedSyncBaseline } from './sync/bootstrap.js';
import { keyFingerprint, resolveSyncKey, routeKeyFor } from './sync/crypto.js';
import {
  type SyncConfigFile,
  type SyncPullResult,
  type SyncPushResult,
  type SyncStatusResult,
  pullSync,
  pushSync,
  readSyncConfig,
  syncConfigPath,
  syncEngineStatus,
  writeSyncConfig,
} from './sync/engine.js';
import { type SyncEventPayload, type SyncStoreScope, deriveEventId } from './sync/event.js';
import { type ConflictRecord, loadSyncState, saveSyncState } from './sync/queue.js';
import { type SyncStageContext, stageSyncableWrite } from './sync/stage.js';
import type {
  CaptureOutboxEntry,
  IntakeCheckpoint,
  IntakeRequirement,
  MemoryAlias,
  MemoryCandidate,
  MemoryDecision,
  MemoryEntry,
  MemoryEvidence,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordV2,
  MemoryRecordV3,
  MemoryScope,
  MemorySensitivity,
  MemoryVisibility,
} from './types.js';
import { isMemoryRecordV2, isMemoryRecordVersioned } from './types.js';

type ReadableMemoryRecord = MemoryRecord | MemoryRecordV2 | MemoryRecordV3;

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
export function validityOf(record: ReadableMemoryRecord): ValidityInterval {
  if (isMemoryRecordVersioned(record)) {
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
export function visibilityOf(
  record: MemoryRecord | MemoryRecordV2 | MemoryRecordV3,
): MemoryVisibility {
  return isMemoryRecordVersioned(record) ? record.visibility : 'workspace';
}

/** One supersedes-index per gathered-records array, for the life of that array. */
const supersedesIndexes = new WeakMap<object, Map<string, string[]>>();

/**
 * PERF — reverse index of memory-2 `lineage.supersedes`: superseded-id → successor ids.
 *
 * `supersededBy` previously answered "which record supersedes this one?" by scanning the WHOLE
 * gathered pool per hit, making `search` O(hits × records) — at 10k records that scan was ~27% of
 * the entire call. The index is built once per gathered array and memoized on that array's identity
 * (the same WeakMap-on-a-long-lived-object pattern {@link evaluationCacheFor} uses), so no signature
 * threading is needed and other `supersededBy` callers keep working unchanged.
 *
 * Only memory-2 records carry lineage, so memory-1 rows are skipped exactly as the scan did. PURE.
 */
function supersedesIndexFor(records: readonly ReadableMemoryRecord[]): Map<string, string[]> {
  const cached = supersedesIndexes.get(records);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  for (const record of records) {
    if (!isMemoryRecordVersioned(record)) continue;
    for (const supersededId of record.lineage.supersedes ?? []) {
      const successors = index.get(supersededId);
      if (successors) successors.push(record.id);
      else index.set(supersededId, [record.id]);
    }
  }
  supersedesIndexes.set(records, index);
  return index;
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

// ─── sync (Gate 4 — the port-injected engine surface, ADR-003 D12) ───────────

/** The honest response when sync is not configured for the requested stores: nothing was read,
 *  written, or transferred. */
export interface SyncResult {
  ok: false;
  available: false;
  capability: 'sync';
  status: 'not-configured';
  message: string;
  /** the request echoed back, untouched. */
  request: Record<string, unknown>;
}

/** The honest not-configured shape (ADR-003 D12: reworded from the Gate-4 placeholder — the engine
 *  EXISTS now; what is missing is this repo's configuration). PURE. */
export function syncNotConfigured(request: Record<string, unknown> = {}): SyncResult {
  return {
    ok: false,
    available: false,
    capability: 'sync',
    status: 'not-configured',
    message:
      'sync is not configured for this repo; run `crib memory init-sync` to seed a store before pushing or pulling',
    request,
  };
}

/**
 * D11's clean-tree gate for the team opt-in: `git status --porcelain` with NO output. Not git —
 * spawnSync is read-only. An unreadable repo (no git, no .git) is NOT clean — fail closed.
 */
export function isCleanGitTree(repoRoot: string): boolean {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  if (res.error !== undefined || res.status !== 0) return false;
  return (res.stdout ?? '').trim().length === 0;
}

/**
 * D11's `--history-scan`: the read-only `git log -S<id>` sweep over the memory directory — which
 * commits ever carried the id. NEVER rewrites history; the report is advisory.
 */
export function gitLogSHits(id: string, repoRoot: string): string[] {
  const res = spawnSync('git', ['log', `-S${id}`, '--format=%h %s', '--', '.crib/memory'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.error !== undefined || res.status !== 0) return [];
  return (res.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The {@link MemoryApi.sync} request (D12): the backend port is INJECTED — memory stays pure over
 *  it, mirroring MemorySoulPort. `backend` is required for push/pull, optional for status. */
export interface SyncApiRequest {
  op: 'push' | 'pull' | 'status';
  backend?: SyncObjectStore;
  /** which stores to run (default: every configured participant — local and global; team is never
   *  a participant, D2). */
  stores?: SyncStoreScope[];
  dryRun?: boolean;
  /** push only: cap the events pushed this run. */
  maxEvents?: number;
  /** push only: D5 — stage every live entry even if the init baseline acked it. */
  backfill?: boolean;
  /** pull only: D8 — quarantine an offending event instead of halting. */
  skip?: boolean;
  /** the key BYTES, pre-resolved + fingerprint-verified by the caller (D7). When absent the API
   *  re-resolves fail-closed from the sync config — but a caller that already verified the key
   *  passes it here so the run uses EXACTLY the verified bytes (no re-resolution divergence). */
  key?: Uint8Array;
  /** the stable cross-clone sync id override (the sync config's `syncRepoId`) for the local
   *  scope; when absent the engine falls back to each store's manifest `repo.id`. */
  syncRepoId?: string;
}

/** One store's outcome inside a {@link SyncRunResult}. */
export interface SyncStoreRun {
  store: SyncStoreScope;
  ok: boolean;
  push?: SyncPushResult;
  pull?: SyncPullResult;
  error?: string;
}

/** A push/pull run across the participant stores. */
export interface SyncRunResult {
  ok: boolean;
  op: 'push' | 'pull';
  dryRun: boolean;
  stores: SyncStoreRun[];
  message?: string;
}

/** A status report: honest empty shapes — an un-initialized store reports not-initialized. */
export interface SyncStatusReport {
  ok: true;
  op: 'status';
  stores: SyncStatusResult[];
}

export type SyncResponse = SyncRunResult | SyncStatusReport | SyncResult;

/** {@link MemoryApi.syncInit} — the config is the FILE's shape minus key material: the config
 *  stores only a REFERENCE to the key source + the fingerprint (D7 — never key bytes). */
export interface SyncInitInput {
  scope: SyncStoreScope;
  deviceId: string;
  /** the key BYTES (used to derive the fingerprint and to verify resolution — never persisted). */
  key: Uint8Array;
  /** where the key lives (recorded as a reference; the file never carries the bytes). */
  keySource?: 'env' | 'keyfile';
  /** D5 — seed the baseline as a FULL backfill instead of "all current entries acked". */
  backfill?: boolean;
  /** the env-var NAME the key resolves from (a reference, never the value — D7). */
  keyEnv?: string;
  /** the keyfile PATH the key resolves from (a reference, never the bytes — D7). */
  keyFile?: string;
  /** the user-owned backend target (D6) recorded so a later push/pull resolves the port. */
  backend?: SyncConfigFile['backend'];
  /** the stable cross-clone sync id for the LOCAL scope (init-sync `--sync-id`), recorded in the
   *  config as a reference and threaded into every later push/pull/purge derivation. */
  syncRepoId?: string;
}

export interface SyncInitResult {
  ok: boolean;
  scope: SyncStoreScope;
  /** the sync-state seeding result (undefined when the store is not configured). */
  baseline?: SeedBaselineResult;
  configPath?: string;
  keyFingerprint?: string;
  keyEpoch?: number;
  error?: string;
}

/** The resolution a human appends to a same-id-different-bytes conflict (D8: append-only). */
export interface ConflictResolution {
  /** append a supersede decision naming this successor. */
  successor?: string;
  /** append a retract decision. */
  retract?: boolean;
}

/** The D11 purge request. No wildcards; `confirmIds` must repeat the exact purge list. */
export interface PurgeOpts {
  actor: string;
  confirmIds: string[];
  /** which stores to purge (default local + global). `team` only when EXPLICITLY listed. */
  stores?: MemorySource[];
  dryRun?: boolean;
  /** read-only `git log -S<id> -- .crib/memory/` report — the honest irreversible-deletion limit. */
  historyScan?: boolean;
  /** when supplied, the remote blobs for the purged ids are deleted (terminal state first) and the
   *  purge-ack recorded in sync-state LAST (D11). */
  backend?: SyncObjectStore;
  /** the sync key, required with `backend` to derive the routed blob keys. */
  syncKey?: Uint8Array;
  /** per-scope routes: each purged scope resolves its OWN backend + key (a global-scope sync
   *  config has a different backend/key than a local-scope one — one shared route misroutes the
   *  remote deletes). `backend`/`syncKey` remain the fallback applying to both scopes. */
  routes?: Partial<Record<SyncStoreScope, { backend: SyncObjectStore; syncKey: Uint8Array }>>;
  /** the stable cross-clone sync id override for the local scope's purge-tombstone derivation. */
  syncRepoId?: string;
}

export interface PurgeStoreReport {
  store: MemorySource;
  /** the retract decision id (the synced, replayable part — D9). */
  decisionId?: string;
  /** whether the physical line was removed (team is append-only — never removed). */
  removed: boolean;
  /** same-seed twins physically swept with the record (cand:, feedback, capture outbox/dead). */
  twins: string[];
  /** a DESIGNED-SUCCESS team outcome (append-only held, tombstone synced) — a non-error note so
   *  the CLI exits 0 on a team purge that did exactly what D11 says a team purge does. */
  teamOutcome?: 'retract-only';
  error?: string;
}

export interface PurgeTargetReport {
  /** the requested memory id. */
  id: string;
  found: boolean;
  stores: PurgeStoreReport[];
  /** the alias-resolved twin purged alongside (alias lines RETAINED — deliberate audit history). */
  resolvedTwin?: string;
  /** historyScan hits: commits whose diff still contains the id. */
  commits?: string[];
  error?: string;
}

export interface PurgeResult {
  ok: boolean;
  dryRun: boolean;
  purged: PurgeTargetReport[];
  message?: string;
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

function evidenceSummaries(record: ReadableMemoryRecord): EvidenceSummary[] {
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
  // ── G2.2 durable-outbox capture-input fields (part of the `cap:` id seed, never the `cand:` seed) ──
  /**
   * Caller-supplied dedupe key. A re-capture with the same key (and same offsets/kind/subject/
   * observation/actor) re-derives the same `cap:` id, so the durable outbox upsert is a no-op.
   */
  idempotencyKey?: string;
  /** capture-input stream position — carried on the outbox entry, part of the `cap:` id seed. */
  sessionId?: string;
  sessionOffset?: number;
  eventOffset?: number;
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
  /** `cap:<blake3>` — the durable outbox entry written BEFORE the staging entry (G2.2). */
  outboxId: string;
  /** true iff the durable outbox upsert was a re-derive of an existing entry (idempotent replay). */
  idempotent: boolean;
}

/** A failed {@link MemoryApi.capture} / {@link MemoryApi.observe} (nothing was written). */
export interface CaptureFailure {
  ok: false;
  error: string;
  /**
   * The capture-policy violations, when the failure was a policy refusal (G2.2). Static reasons
   * only — never the refused content. Absent for non-policy failures (validation/configuration).
   */
  violations?: readonly CapturePolicyViolation[];
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

// ─── observe (G2.2 — the disciplined twin, staged through the same funnel) ────

/**
 * The disciplined observation input ({@link MemoryApi.observe}): the agent has ALREADY decided what
 * is worth recording and supplies explicit evidence — no auto-anchoring, no kind defaulting.
 * Everything else mirrors {@link CaptureInput} minus the loose refs.
 */
export interface ObserveInput {
  kind: string;
  subject: string;
  claim: string;
  appliesTo?: string[];
  /** proposed evidence items (loose — the store schema-validates + secret-scans on write). */
  evidence?: MemoryEvidence[];
  actor: string;
  authorKind?: 'agent' | 'human';
  tool?: string;
  scopeBoundary?: 'repo' | 'global';
  attemptId?: string;
  repoId?: string;
  idempotencyKey?: string;
  sessionId?: string;
  sessionOffset?: number;
  eventOffset?: number;
}

/** A successful {@link MemoryApi.observe} — the W4 response contract plus the outbox fields. */
export interface ObserveSuccess {
  ok: true;
  /** `cand:<blake3>` — content-addressed; a repeat observation upserts the same id. */
  id: string;
  status: 'pending';
  origin: 'observe' | 'attempt';
  scope: MemoryScope;
  /** true iff this content id was already staged (the idempotence signal). */
  duplicate: boolean;
  /** `cap:<blake3>` — the durable outbox entry written BEFORE the staging entry (G2.2). */
  outboxId: string;
  /** true iff the durable outbox upsert was a re-derive of an existing entry. */
  idempotent: boolean;
}

export type ObserveResult = ObserveSuccess | CaptureFailure;

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
  /**
   * Max ENRICHED hits to return (ranked order). Absent = enrich every eligible record.
   *
   * Enrichment is per-hit work (supersession lookup, alias resolution, verdict overlay), so
   * enriching a whole 10k ledger to hand back five rows is the dominant avoidable cost in
   * `search`. `conflicts` and `provenance.counts` come from the PROJECTION, not from `hits`, so
   * limiting narrows only the enriched page — never the conflict set or the counts.
   */
  limit?: number;
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
  /**
   * G3.3 — the volatile freshness trio rides on this object NON-ENUMERABLY when a generation-keyed
   * pass ran (`attachVolatileFreshness`): the canonical ifHash form walks enumerable keys only, so
   * the response stays a pure function of its inputs, while a display layer reading
   * `hit.freshness.generation` / `.ageMs` explicitly gets the live values. `generation`
   * (deterministic) is ALSO carried enumerable on `SearchProvenance`, where no pinned shape
   * assertion exists. These three are `undefined` when no generation-keyed pass bound.
   */
  generation?: string | null;
  evaluatedAtMs?: number;
  ageMs?: number;
}

/** One search result — the recall projection's hit ENRICHED with the G1.3 rich contract. */
export interface SearchHit {
  /** the record itself (v1 or v2 envelope), so an SDK consumer never re-reads by id. */
  record: ReadableMemoryRecord;
  id: string;
  schemaVersion: '1' | '2' | '3';
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
  /**
   * G3.3 — the dependency-generation fingerprint every fresh verdict in this response is proven
   * current against, or null when no generation-keyed cache was bound. Deterministic (ifHash-safe);
   * the wall-clock AGE rides alongside non-enumerably (`ageMs`/`evaluatedAtMs`).
   */
  generation: string | null;
  /**
   * G3.2 (red line #6) — the versioned scorer id (embedder + scorer version + fusion strategy)
   * behind the criterion-1 lexical order, when a versioned scorer was supplied. Absent for the
   * built-in exact scorer. Deterministic → ifHash-stable.
   */
  scorerVersion?: string;
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
  record?: ReadableMemoryRecord;
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
  record: ReadableMemoryRecord;
  id: string;
  schemaVersion: '1' | '2' | '3';
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
  record: ReadableMemoryRecord;
  id: string;
  schemaVersion: '1' | '2' | '3';
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
  /**
   * How this API instance is being driven, which decides whether a `tty: true` attestation may be
   * accepted from the caller. `'terminal'` is set ONLY by a CLI path that has itself checked
   * `process.stdin.isTTY`; every other construction (the MCP server above all) leaves it unset and
   * therefore cannot mint a human attestation. Defaulting to the restrictive value means a new
   * call site is safe until it deliberately opts in.
   */
  attestationSource?: 'terminal';
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
  /**
   * G3.3 — the display-only clock for the volatile freshness age (`ageMs`/`evaluatedAtMs` attached
   * NON-enumerably to search results). Never enters an id, hash, or ifHash projection — the
   * enumerable response stays a pure function of its inputs.
   */
  nowMs?: () => number;
  /**
   * G3.3 — an explicit generation-keyed evaluation cache. When absent, one is bound per eval
   * context via `evaluationCacheFor` (a WeakMap keyed on the context object), so the cache survives
   * per-call API construction as long as the CONTEXT object is long-lived.
   */
  evaluationCache?: GenerationCache;
  /** the code HEAD search provenance reports (the serving layer knows git HEAD). */
  codeHead?: string;
  /**
   * G2.2 — the capture-tightening policy section, injected directly (DI/tests). When absent it is
   * loaded from `<cribDir>/memory/policy.json`'s `capture` section; a CORRUPT policy file fails the
   * capture closed (a typed refusal, never a silent pass).
   */
  capturePolicy?: CapturePolicySection;
  /**
   * Optional shared event journal. When supplied, an observation is acknowledged only after its
   * candidate/outbox staging AND its replayable `memory.observed` event are durable.
   */
  eventJournal?: IntelligenceEventJournal;
  /** Derived freshness checkpoints for event-driven materializations. */
  projectionCheckpoints?: ProjectionCheckpointStore;
  /** Optional host-owned vendor-alias resolver for event profile attribution. */
  identityDirectory?: AgentProfileDirectory;
}

export type IntakeShareResult =
  | {
      ok: true;
      audience: 'devices' | 'team';
      localWritten: true;
      teamWritten: boolean;
      checkpoint: IntakeCheckpoint;
    }
  | {
      ok: false;
      audience: 'devices' | 'team';
      localWritten: boolean;
      teamWritten: false;
      error: string;
      checkpoint?: IntakeCheckpoint;
    };

/** A team mirror failed after the local checkpoint was already durable. */
export class IntakeTeamMirrorError extends Error {
  readonly localWritten = true;
  readonly teamWritten = false;

  constructor(
    message: string,
    public readonly checkpoint: IntakeCheckpoint,
  ) {
    super(message);
    this.name = 'IntakeTeamMirrorError';
  }
}

/** Which record collection a store role holds its records in (local calls its bucket `active`). */
function recordCollectionOf(store: MemoryStore): MemoryCollection {
  return store.role === 'local' ? 'active' : 'records';
}

/** A gathered record tagged with the store it came from (history/audit gather across all stores). */
interface SourcedRecord {
  record: ReadableMemoryRecord;
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

function isRecordEntry(e: { id?: unknown }): e is ReadableMemoryRecord {
  return typeof e.id === 'string' && e.id.startsWith('mem:');
}
function isDecisionEntry(e: { id?: unknown }): e is MemoryDecision {
  return typeof e.id === 'string' && e.id.startsWith('dec:');
}
function isFeedbackEntry(e: { id?: unknown }): e is MemoryFeedback {
  return typeof e.id === 'string' && e.id.startsWith('fb:');
}

/** Stable, de-duplicated event references — evidence bodies never enter the operational journal. */
function observationEvidenceRefs(evidence: readonly MemoryEvidence[]): string[] {
  const refs = new Set<string>();
  for (const item of evidence) {
    if (typeof item.soulId === 'string') refs.add(item.soulId);
    if (typeof item.artifactId === 'string') refs.add(item.artifactId);
  }
  return [...refs].sort();
}

/**
 * G3.3 — bind a generation-keyed evaluation pass over one read: the WeakMap-backed cache hangs off
 * the LONG-LIVED eval context (not the throwaway call), the seven dependency slots are fingerprinted
 * from the context ports + the gathered decision/feedback sets, and the returned eval context carries
 * the pass scratch memos + cache port. A dependency that cannot be versioned (unit-fake soul port,
 * receipts without a generation, an undefined policy hash) refuses the bind and the caller evaluates
 * fresh — the pre-G3.3 behaviour, exactly.
 *
 * Extracted so EVERY projection surface shares one binding (red line #1: never revalidate every
 * record to answer one query): `MemoryApi.search` and the CLI/MCP `recallProjection` adapters both
 * call this — a second binding implementation would silently fork the cache semantics.
 */
export function bindEvaluationPass(
  baseCtx: MemoryEvalContext | undefined,
  gathered: Pick<GatheredRecall, 'decisions' | 'localDecisions' | 'feedback'>,
  opts: { nowMs?: () => number; cache?: GenerationCache } = {},
): { evalCtx?: MemoryEvalContext; generation: string | null; cache?: GenerationCache } {
  if (!baseCtx) return { generation: null };
  const cache =
    opts.cache ?? evaluationCacheFor(baseCtx, { ...(opts.nowMs ? { nowMs: opts.nowMs } : {}) });
  const generations: Partial<DependencyGenerations> = {
    code: baseCtx.soul.generation?.() ?? UNVERSIONED,
    decisions: entrySetFingerprint([...gathered.decisions, ...gathered.localDecisions]),
    feedback: entrySetFingerprint(gathered.feedback),
  };
  if (baseCtx.policy) generations.policy = baseCtx.policy.policyHash() ?? UNVERSIONED;
  if (baseCtx.receipts) generations.receipts = baseCtx.receipts.generation?.() ?? UNVERSIONED;
  const cachePort = cache.bind(generations);
  if (!cachePort) return { generation: null };
  return {
    evalCtx: {
      ...baseCtx,
      pass: { locatorMatches: new Map(), quoteChecks: new Map() },
      cache: cachePort,
    },
    generation: cachePort.generation(),
    cache,
  };
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
  /** G3.3 — display-only clock for the volatile freshness age. Never feeds an id/hash/ifHash. */
  private readonly nowMsFn: () => number;
  /** See {@link MemoryApiDeps.attestationSource}. Defaults to the restrictive value. */
  private readonly attestationSource: 'terminal' | 'caller';

  constructor(deps: MemoryApiDeps) {
    this.deps = deps;
    this.attestationSource = deps.attestationSource === 'terminal' ? 'terminal' : 'caller';
    this.env = deps.env ?? process.env;
    this.nowFn = deps.now ?? (() => new Date().toISOString());
    this.nowMsFn = deps.nowMs ?? Date.now;
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
   * content id: a repeat capture of the same observation upserts the same `cand:` id. G2.2: the
   * capture ALSO lands a durable `cap:` outbox entry (written first, via the shared
   * {@link stageCandidate} funnel) so a crash before the staging write is recoverable at-least-once.
   */
  capture(input: CaptureInput): CaptureResult {
    if (!this.deps.stores.local) {
      return { ok: false, error: 'no local memory store is configured for capture' };
    }
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
    const staged = this.stageCandidate({
      ...candidateInput,
      origin: 'observe',
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.sessionOffset !== undefined ? { sessionOffset: input.sessionOffset } : {}),
      ...(input.eventOffset !== undefined ? { eventOffset: input.eventOffset } : {}),
      anchorStatus,
    });
    if (!staged.ok) return staged;
    return {
      ok: true,
      id: staged.id,
      status: 'pending',
      origin: 'observe',
      scope: candidateInput.scope,
      anchorStatus,
      evidenceAttached: evidence.length > 0,
      anchors: anchors.resolved,
      ambiguous: anchors.ambiguous,
      unresolvable: anchors.unresolvable,
      duplicate: staged.duplicate,
      outboxId: staged.outboxId,
      idempotent: staged.idempotent,
    };
  }

  // ── G2.2 — the unified staging funnel ───────────────────────────────────────

  /**
   * The ONE funnel every capture lane runs through (G2.2): capture (auto-anchored) and observe
   * (disciplined) both end here, so the policy gate + durable outbox write + staging write cannot
   * drift apart between lanes. Ordering is the whole point:
   *
   * 1. POLICY BEFORE ID — `checkCapturePolicy` runs before `memoryCandidateId`, because the
   *    `cand:`/`cap:` ids are derived from the same claim content the policy reads: a redaction or
   *    normalization applied after id computation would break idempotent dedupe (a re-capture of
   *    the sanitized text would derive a DIFFERENT id than the refused one) and the cand↔cap
   *    pairing. The check is pure and lock-free; a refusal writes NOTHING (never a silent drop —
   *    the caller gets typed violations). The store's own `assertWritable` (schema + secret scan)
   *    remains the unchanged last-line hard gate inside the upserts.
   * 2. OUTBOX BEFORE STAGING — the durable `cap:` entry lands first, so a crash before the staging
   *    entry is written leaves a replayable queue row; the re-capture re-derives the same id and
   *    upserts no-op-ly.
   * 3. ONE LOCK HOLD — both writes happen under a single same-store `withLock` hold (all sync, so
   *    the process-global no-cross-store-nesting guard is never crossed with an async gap).
   */
  private stageCandidate(args: {
    kind: MemoryCandidate['kind'];
    subject: string;
    claim: string;
    scope: MemoryScope;
    appliesTo: string[];
    evidence: MemoryEvidence[];
    authorship: MemoryCandidate['authorship'];
    origin: 'observe' | 'attempt';
    attemptId?: string;
    idempotencyKey?: string;
    sessionId?: string;
    sessionOffset?: number;
    eventOffset?: number;
    anchorStatus?: CaptureAnchorStatus;
  }):
    | { ok: true; id: string; duplicate: boolean; outboxId: string; idempotent: boolean }
    | { ok: false; error: string; violations?: readonly CapturePolicyViolation[] } {
    const local = this.deps.stores.local;
    if (!local) return { ok: false, error: 'no local memory store is configured for capture' };

    // 1. Policy — BEFORE any id is computed. An injected section wins; else the committed
    //    policy.json's `capture` section; absence is the documented defaulted-open posture. A
    //    corrupt policy file fails CLOSED here (typed refusal, nothing written).
    let policy: CapturePolicySection | undefined;
    if (this.deps.capturePolicy) {
      policy = this.deps.capturePolicy;
    } else if (this.deps.cribDir) {
      try {
        policy = loadPolicy(this.deps.cribDir)?.capture;
      } catch (e) {
        return {
          ok: false,
          error: `capture policy failed to load — refusing to capture (fail closed): ${(e as Error).message}`,
        };
      }
    }
    const verdict = checkCapturePolicy(
      { kind: args.kind, subject: args.subject, claim: args.claim, boundary: args.scope.boundary },
      policy,
    );
    if (!verdict.ok) {
      return {
        ok: false,
        error: 'capture refused by policy — fix the input or adjust the capture policy',
        violations: verdict.violations,
      };
    }

    // 2. Ids (pure) — the staging id and the outbox id derive from disjoint seeds and neither is
    //    polluted by the policy pass (which read but never rewrote the input).
    const candidate: MemoryCandidate = {
      id: memoryCandidateId({
        kind: args.kind,
        subject: args.subject,
        claim: args.claim,
        scope: args.scope,
        appliesTo: args.appliesTo,
        evidence: args.evidence,
        authorship: args.authorship,
      }),
      schemaVersion: '1',
      kind: args.kind,
      subject: args.subject,
      claim: args.claim,
      scope: args.scope,
      appliesTo: args.appliesTo,
      evidence: args.evidence,
      authorship: args.authorship,
      origin: args.origin,
      ...(args.attemptId !== undefined ? { attemptId: args.attemptId } : {}),
      proposedAt: this.now(),
      ...(args.anchorStatus !== undefined ? { meta: { anchorStatus: args.anchorStatus } } : {}),
    };
    const outboxEntry = buildCaptureOutboxEntry(
      {
        kind: args.kind,
        subject: args.subject,
        claim: args.claim,
        scope: args.scope,
        appliesTo: args.appliesTo,
        evidence: args.evidence,
        authorship: args.authorship,
        origin: args.origin,
        ...(args.attemptId !== undefined ? { attemptId: args.attemptId } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
        ...(args.sessionOffset !== undefined ? { sessionOffset: args.sessionOffset } : {}),
        ...(args.eventOffset !== undefined ? { eventOffset: args.eventOffset } : {}),
      },
      candidate.proposedAt,
    );

    // 3. Durable outbox first, staging entry second — both under one same-store lock hold
    //    (re-entrant: the upserts re-take it), never across an await.
    const staged = local.withLock(() => {
      const outbox = stageCaptureOutboxEntry(local, outboxEntry);
      const duplicate = this.holdsDirect(local, candidate.id, 'candidates');
      local.upsertEntry('candidates', candidate); // write gate: validate + secret-scan
      return { ...outbox, duplicate };
    });
    return {
      ok: true,
      id: candidate.id,
      duplicate: staged.duplicate,
      outboxId: outboxEntry.id,
      idempotent: staged.idempotent,
    };
  }

  /**
   * G2.2 — the disciplined observation ({@link ObserveInput} → staging tier), now routed through
   * the same {@link stageCandidate} funnel as capture: same policy gate, same durable outbox write,
   * same content-addressed dedupe. Unlike capture it defaults NOTHING (no kind fallback) and
   * anchors NOTHING — the caller supplies explicit evidence and authorship; `origin` becomes
   * `attempt` when an attemptId is supplied. Validation messages mirror the MCP verb's W4 contract.
   */
  observe(input: ObserveInput): ObserveResult {
    const local = this.deps.stores.local;
    if (!local) return { ok: false, error: 'no local memory store is configured for capture' };
    const kind = input.kind;
    if (!isMemoryRecordKind(kind)) {
      return {
        ok: false,
        error: `invalid kind '${kind}' — expected one of fact, procedure, decision, pitfall, convention`,
      };
    }
    if (typeof input.subject !== 'string' || input.subject.length === 0) {
      return { ok: false, error: 'subject is required' };
    }
    if (typeof input.claim !== 'string' || input.claim.length === 0) {
      return { ok: false, error: 'claim is required' };
    }
    if (typeof input.actor !== 'string' || input.actor.length === 0) {
      return { ok: false, error: 'actor is required' };
    }
    // WRITE-TIME ADMISSIBILITY. Structural admissibility is decidable here, and here is the only
    // moment the author can still fix it. Staging evidence that could never support the claim —
    // `type` where `kind` belongs, a human attestation with no `tty`/`actor`/`attestedAt`, an
    // evidence kind the claim kind does not admit — produced an `ok: true` acknowledgement for a
    // record that was dead on arrival: it could never be activated, never recalled, and nothing
    // said so. Failing loudly here costs one corrected call; failing silently cost the user their
    // trust in the whole store.
    //
    // Only claims that SUPPLY evidence are checked. Empty evidence stays legal: the episodic
    // capture path stages claims whose evidence is attached later by distillation.
    const proposedEvidence = input.evidence ?? [];
    // A CALLER MAY NOT MINT A TERMINAL IT NEVER SAW.
    //
    // `tty: true` is the one field that distinguishes a human attestation from an agent asserting
    // one, and it is what receipt-free local admission (`admitAttested`) is grounded in. It was
    // accepted verbatim from caller-supplied evidence, so any agent could stamp it and self-grant
    // the trust the flag represents. Crib stamps it ONLY where it observed a real terminal itself
    // (`crib memory remember`, which reads `process.stdin.isTTY`); over an MCP call there is no
    // terminal to have witnessed, so the claim is refused rather than quietly downgraded — a
    // silently-stripped attestation would stage a candidate that can never be admitted, which is
    // the same dead-on-arrival failure this validation exists to end.
    const forgedTty = proposedEvidence.findIndex(
      (e) => (e as unknown as Record<string, unknown>).tty === true,
    );
    if (forgedTty !== -1 && this.attestationSource !== 'terminal') {
      return {
        ok: false,
        error: `evidence[${forgedTty}] sets \`tty: true\`, which asserts a human attested this at a terminal. That flag is stamped by crib when it observes a real terminal, never accepted from a caller. To record a human attestation run \`crib memory remember\` in a terminal; to stage an agent observation, omit \`tty\`.`,
      };
    }
    if (proposedEvidence.length > 0) {
      // Staged: attestation timestamps are stamped by crib at admission, not supplied by a caller.
      const problems = admissibilityProblems(kind, proposedEvidence, { staged: true });
      if (problems.length > 0) {
        return {
          ok: false,
          error: `evidence cannot support a '${kind}' claim, so this memory could never be recalled: ${problems
            .map((p) => p.problem)
            .join('; ')}`,
        };
      }
    }
    const boundary = input.scopeBoundary ?? 'repo';
    const scope: MemoryScope = { boundary };
    if (boundary === 'repo') {
      const repoId = this.resolveRepoId(input.repoId);
      if (!repoId) {
        return {
          ok: false,
          error:
            'could not resolve a stable repoId for this repo — run `crib index` to register it before observing repo-scoped memory',
        };
      }
      scope.repoId = repoId;
    }
    const origin: 'observe' | 'attempt' = input.attemptId ? 'attempt' : 'observe';
    const staged = this.stageCandidate({
      kind,
      subject: input.subject,
      claim: input.claim,
      scope,
      appliesTo: input.appliesTo ?? [],
      evidence: input.evidence ?? [],
      authorship: {
        actor: input.actor,
        kind: input.authorKind ?? 'agent',
        ...(input.tool ? { tool: input.tool } : {}),
      },
      origin,
      ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.sessionOffset !== undefined ? { sessionOffset: input.sessionOffset } : {}),
      ...(input.eventOffset !== undefined ? { eventOffset: input.eventOffset } : {}),
    });
    if (!staged.ok) return staged;
    // The candidate remains the memory source of truth; this records the operational fact that an
    // agent observed it. A retry reuses the journal idempotency key and therefore cannot create a
    // second lifecycle event after a transport failure.
    try {
      const source = {
        clientId: input.tool ?? 'memory-api',
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.eventOffset !== undefined ? { eventOffset: input.eventOffset } : {}),
      };
      const identity =
        this.deps.identityDirectory?.resolve(resolveServerIdentity(this.env), {
          clientId: source.clientId,
          agentId: input.actor,
        }) ?? resolveServerIdentity(this.env);
      const journaled = this.deps.eventJournal?.append({
        kind: 'memory.observed',
        idempotencyKey: input.idempotencyKey ?? `candidate:${staged.id}`,
        source,
        identity,
        payload: {
          candidateId: staged.id,
          kind,
          subject: input.subject,
          scopeBoundary: boundary,
          origin,
        },
        evidenceRefs: observationEvidenceRefs(input.evidence ?? []),
        occurredAt: this.now(),
      });
      const checkpoints = this.deps.projectionCheckpoints;
      if (
        journaled !== undefined &&
        checkpoints !== undefined &&
        checkpoints.read('memory-capture')?.sourceWatermark !== journaled.event.id
      ) {
        checkpoints.recordSuccess({
          projector: 'memory-capture',
          sourceWatermark: journaled.event.id,
          pendingCount: 0,
          deadLetterCount: 0,
          replayVersion: '1',
          completedAt: this.now(),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `observation staged but intelligence event was not recorded: ${message}`,
      };
    }
    return {
      ok: true,
      id: staged.id,
      status: 'pending',
      origin,
      scope,
      duplicate: staged.duplicate,
      outboxId: staged.outboxId,
      idempotent: staged.idempotent,
    };
  }

  // ── search ─────────────────────────────────────────────────────────────────

  /**
   * The rich search over the recall projection. Ranking, alias bridging, conflict grouping and
   * eligibility are ALL delegated to {@link recallProjection} — this method only enriches each hit
   * with the G1.3 contract (visibility, effective verdicts + evidence, freshness, validity,
   * lineage, score + ranking version, conflicts, superseded alternatives, placement).
   */
  /**
   * The session-handoff projection — "where was I?" for a returning agent.
   *
   * This is the call a NEW context window makes first. It needs no question, because a returning
   * agent cannot yet phrase one: it asks what was in flight, what was captured but never written
   * down, what stopped being true while it was away, and what conventions still hold. Every input
   * already exists (attempt lifecycle, durable outbox, verdict overlay) — this composes them.
   *
   * `needsAttention` intentionally surfaces records that {@link search} SUPPRESSES. A degraded or
   * orphaned claim is excluded from ranking because it must not be acted on — but a returning agent
   * still has to be told it went bad, or the context simply disappears between sessions.
   */
  createIntake(input: IntakeRequirementInput): IntakeRequirement {
    const local = this.deps.stores.local;
    if (!local) throw new Error('creating an intake requires a local repository memory store');
    const requirement = createIntakeRequirement(input);
    local.upsertEntry('intakes', requirement);
    return requirement;
  }

  checkpointIntake(input: IntakeCheckpointInput): IntakeCheckpoint {
    const local = this.deps.stores.local;
    if (!local) throw new Error('checkpointing an intake requires a local repository memory store');
    const history = this.getIntake(input.intakeId);
    if (!history) throw new Error(`unknown intake: ${input.intakeId}`);
    const checkpoint = createIntakeCheckpoint(input);
    local.upsertEntry('intakes', checkpoint);
    if (history.checkpoints.some((entry) => entry.audience === 'team')) {
      const team = this.deps.stores.team;
      if (!team) {
        throw new IntakeTeamMirrorError(
          'checkpoint is durable locally, but no team memory store is configured',
          checkpoint,
        );
      }
      try {
        team.upsertEntry('intakes', checkpoint);
      } catch (error) {
        throw new IntakeTeamMirrorError(
          `checkpoint is durable locally, but the team mirror failed: ${(error as Error).message}`,
          checkpoint,
        );
      }
    }
    return checkpoint;
  }

  /**
   * Explicitly widen one intake's audience. Device sharing appends a local marker that the normal
   * encrypted derive-and-diff sweep will pick up. Team sharing is a separate, deliberate promotion:
   * preflight the complete history, persist the marker locally, then copy the exact immutable set
   * into Git-backed team memory. The two stores are written under separate locks.
   */
  shareIntake(
    intakeId: string,
    opts: {
      audience: 'devices' | 'team';
      actor: string;
      repository: IntakeCheckpoint['repository'];
      nextSafeAction?: string;
      summary?: string;
    },
  ): IntakeShareResult {
    const local = this.deps.stores.local;
    if (!local) {
      return {
        ok: false,
        audience: opts.audience,
        localWritten: false,
        teamWritten: false,
        error: 'sharing an intake requires a local repository memory store',
      };
    }
    const history = this.getIntake(intakeId);
    if (!history) {
      return {
        ok: false,
        audience: opts.audience,
        localWritten: false,
        teamWritten: false,
        error: `unknown intake: ${intakeId}`,
      };
    }
    if (opts.audience === 'team' && !this.deps.stores.team) {
      return {
        ok: false,
        audience: 'team',
        localWritten: false,
        teamWritten: false,
        error: 'team sharing requires a Git-backed team memory store',
      };
    }

    const projection = projectIntakes([history.requirement], history.checkpoints, opts.repository)
      .choices[0];
    if (!projection) {
      return {
        ok: false,
        audience: opts.audience,
        localWritten: false,
        teamWritten: false,
        error: `could not project intake: ${intakeId}`,
      };
    }
    const latest = history.checkpoints.at(-1);
    const terminalKind =
      latest?.kind === 'completed' || latest?.kind === 'cancelled' ? latest.kind : undefined;
    const nextSafeAction = opts.nextSafeAction?.trim() || projection.nextSafeAction;
    if (!terminalKind && !nextSafeAction) {
      return {
        ok: false,
        audience: opts.audience,
        localWritten: false,
        teamWritten: false,
        error: 'a resumable intake must have a next safe action before it can be shared',
      };
    }
    const checkpoint = createIntakeCheckpoint({
      intakeId,
      kind: terminalKind ?? 'shared',
      phase: projection.phase,
      ...(nextSafeAction ? { nextSafeAction } : {}),
      summary: opts.summary?.trim() || `Shared intake continuation with ${opts.audience}`,
      ...(projection.completedStepIds.length > 0
        ? { completedStepIds: projection.completedStepIds }
        : {}),
      audience: opts.audience,
      repository: opts.repository,
      ...(latest?.artifactPaths ? { artifactPaths: latest.artifactPaths } : {}),
      ...(latest?.receiptIds ? { receiptIds: latest.receiptIds } : {}),
      actor: opts.actor,
      recordedAt: this.now(),
    });
    const completeHistory: MemoryEntry[] = [
      history.requirement,
      ...history.checkpoints,
      checkpoint,
    ];
    try {
      for (const entry of completeHistory) assertNoMemorySecrets(entry);
    } catch (error) {
      return {
        ok: false,
        audience: opts.audience,
        localWritten: false,
        teamWritten: false,
        error: (error as Error).message,
      };
    }

    local.upsertEntry('intakes', checkpoint);
    if (opts.audience === 'devices') {
      return { ok: true, audience: 'devices', localWritten: true, teamWritten: false, checkpoint };
    }
    try {
      this.deps.stores.team!.upsertEntries('intakes', completeHistory);
      return { ok: true, audience: 'team', localWritten: true, teamWritten: true, checkpoint };
    } catch (error) {
      return {
        ok: false,
        audience: 'team',
        localWritten: true,
        teamWritten: false,
        error: (error as Error).message,
        checkpoint,
      };
    }
  }

  listIntakes(repository: IntakeCheckpoint['repository'] = { dirty: false }): IntakeProjection {
    const { requirements, checkpoints } = this.intakeEntries();
    return projectIntakes(requirements, checkpoints, repository);
  }

  getIntake(
    intakeId: string,
  ): { requirement: IntakeRequirement; checkpoints: IntakeCheckpoint[] } | undefined {
    const { requirements, checkpoints } = this.intakeEntries();
    const requirement = requirements.find((entry) => entry.id === intakeId);
    if (!requirement) return undefined;
    return {
      requirement,
      checkpoints: checkpoints
        .filter((entry) => entry.intakeId === intakeId)
        .sort((a, b) =>
          a.recordedAt === b.recordedAt
            ? a.id.localeCompare(b.id)
            : a.recordedAt.localeCompare(b.recordedAt),
        ),
    };
  }

  handoff(
    opts: {
      limits?: HandoffInput['limits'];
      repository?: IntakeCheckpoint['repository'];
    } = {},
  ): HandoffResponse {
    const pinned = [this.deps.stores.team, this.deps.stores.local, this.deps.stores.global].filter(
      (s): s is MemoryStore => s !== undefined,
    );
    for (const store of pinned) store.pinGeneration();
    try {
      const gathered = gatherRecall(this.deps.stores, {
        principal: this.env.KCRIB_PRINCIPAL_ID ?? DEFAULT_MIGRATION_PRINCIPAL_ID,
      });
      const aliasIndex = buildAliasIndex(gathered.aliases ?? []);
      const allDecisions = [...gathered.decisions, ...gathered.localDecisions];
      const records = gathered.records.map(({ record, source }) => {
        const legacy = aliasIndex.aliasesFor(record.id);
        // NO-POISON, the same pool split `get`/`search` apply: a LOCAL tombstone never retires the
        // same-id team record.
        const pool = source === 'local' ? allDecisions : gathered.decisions;
        const bridged = bridgedDecisions(legacy, record.id, pool);
        return {
          record,
          verdicts: effectiveVerdicts(record, bridged, undefined, conservativeVerdicts(legacy)),
        };
      });
      const local = this.deps.stores.local;
      const attempts = local
        ? (local.readCollection('attempts').entries as unknown as HandoffAttemptEvent[])
        : [];
      const pending = local ? pendingCaptures(local) : [];
      const { requirements, checkpoints } = this.intakeEntries();
      // Lifecycle events are what make a TIMED-OUT session recoverable: they are the only signal
      // here the agent did not have to write itself. Read defensively — a repo with no journal, or
      // an unreadable one, degrades to a handoff without `lastSession` rather than failing the
      // whole projection.
      let lifecycle: Parameters<typeof buildHandoff>[0]['lifecycle'];
      try {
        lifecycle = this.deps.eventJournal
          ?.read()
          .filter((event) => event.kind === 'agent.lifecycle');
      } catch {
        lifecycle = undefined;
      }
      return buildHandoff({
        attempts,
        pending,
        records,
        intakeRequirements: requirements,
        intakeCheckpoints: checkpoints,
        ...(lifecycle ? { lifecycle } : {}),
        ...(opts.repository ? { repository: opts.repository } : {}),
        ...(opts.limits ? { limits: opts.limits } : {}),
      });
    } finally {
      for (const store of pinned) store.unpinGeneration();
    }
  }

  /**
   * R03 — is this intake requirement readable by the CALLING principal?
   *
   * Two ways in, and only two:
   *   - the caller owns it (`namespace.principalId` is the caller), or
   *   - it reached the TEAM store, which happens only through the deliberate `shareIntake` team
   *     promotion. Presence in Git-backed team memory IS the explicit authorization.
   *
   * A requirement carrying no principal is treated as legacy-readable, exactly as `acceptsRecord`
   * treats a memory-1 record with no principal column — migration compatibility, not a loophole:
   * `createIntakeRequirement` always stamps a namespace.
   */
  private acceptsIntake(requirement: IntakeRequirement, teamShared: boolean): boolean {
    if (teamShared) return true;
    const owner = requirement.namespace?.principalId;
    if (typeof owner !== 'string' || owner.trim().length === 0) return true;
    return owner === this.callerPrincipal();
  }

  /**
   * Gather the intake requirements and checkpoints the CALLER is authorized to see.
   *
   * The audited defect (R03) was that this merged every entry from every store with no principal or
   * audience policy at all. Because `listIntakes`, `getIntake`, `handoff` and — through `getIntake`
   * — `checkpointIntake` all funnel through here, one unguarded merge exposed another principal's
   * `private` durable intake to reads, listings, handoff, and APPENDS. The repair belongs here
   * rather than on the four public verbs, for the same reason `acceptsRecord` lives at the gather
   * point: a future intake-returning verb must inherit the boundary instead of re-deriving it.
   *
   * Checkpoints have no principal of their own — they are events ON a requirement — so a checkpoint
   * is visible exactly when its requirement is. A checkpoint whose requirement is not visible
   * (foreign, or absent entirely) is dropped rather than orphan-exposed: `nextSafeAction` and
   * `summary` describe the private work just as directly as the requirement does.
   */
  private intakeEntries(): {
    requirements: IntakeRequirement[];
    checkpoints: IntakeCheckpoint[];
  } {
    const entries = new Map<string, IntakeRequirement | IntakeCheckpoint>();
    // Ids present in TEAM memory. Tracked SEPARATELY from the entry map because the map is
    // last-wins and local is read second (deliberately — the local copy is the freshest). Judging
    // authorization by the surviving copy's store would therefore deny every shared intake the
    // owner also holds locally, which is all of them: `shareIntake` writes both.
    const teamShared = new Set<string>();
    for (const [source, store] of [
      ['team', this.deps.stores.team],
      ['local', this.deps.stores.local],
    ] as const) {
      if (!store || !store.collections.includes('intakes')) continue;
      for (const entry of store.readCollection('intakes').entries) {
        if (entry.id.startsWith('intake:') || entry.id.startsWith('icp:')) {
          entries.set(entry.id, entry as IntakeRequirement | IntakeCheckpoint);
          if (source === 'team') teamShared.add(entry.id);
        }
      }
    }
    const requirements: IntakeRequirement[] = [];
    const visibleIntakeIds = new Set<string>();
    for (const entry of entries.values()) {
      if (!entry.id.startsWith('intake:')) continue;
      const requirement = entry as IntakeRequirement;
      if (!this.acceptsIntake(requirement, teamShared.has(requirement.id))) continue;
      requirements.push(requirement);
      visibleIntakeIds.add(requirement.id);
    }
    const checkpoints: IntakeCheckpoint[] = [];
    for (const entry of entries.values()) {
      if (!entry.id.startsWith('icp:')) continue;
      const checkpoint = entry as IntakeCheckpoint;
      if (!visibleIntakeIds.has(checkpoint.intakeId)) continue;
      checkpoints.push(checkpoint);
    }
    return { requirements, checkpoints };
  }

  search(query: string, opts: SearchOpts = {}): SearchResponse {
    // PERF — pin every store's mutation generation for this pass. `enrichHit` → `locate` runs
    // per hit and each lookup validates the shard memo, so an unpinned pass re-stat'ed the
    // sidecar hundreds of times. Pinning also makes the pass a single consistent snapshot
    // rather than one that can straddle a concurrent write.
    const pinned = [this.deps.stores.team, this.deps.stores.local, this.deps.stores.global].filter(
      (s): s is MemoryStore => s !== undefined,
    );
    for (const store of pinned) store.pinGeneration();
    try {
      return this.searchPinned(query, opts);
    } finally {
      for (const store of pinned) store.unpinGeneration();
    }
  }

  /** {@link search}'s body, run inside a pinned-generation pass. */
  private searchPinned(query: string, opts: SearchOpts = {}): SearchResponse {
    const gathered = gatherRecall(this.deps.stores, {
      sources: opts.sources ?? DEFAULT_RECALL_SOURCES,
      // G7 principal boundary: scope the gather against THIS api's resolved principal (the same
      // ownership default the migration/sync staging paths stamp), so a caller that unions store
      // sets across principals still gets a principal-scoped pool. The gather would resolve the
      // same value from process.env; passing it explicitly keeps the boundary on the API's OWN
      // env (tests inject one) rather than the process's.
      principal: this.env.KCRIB_PRINCIPAL_ID ?? DEFAULT_MIGRATION_PRINCIPAL_ID,
    });
    const baseCtx = opts.evalCtx ?? this.deps.evalCtx;
    // G3.3 — bind the generation-keyed evaluation cache for THIS pass via the SHARED helper (the
    // same binding the CLI/MCP recall adapters use — one implementation, no forked semantics).
    const bound = bindEvaluationPass(baseCtx, gathered, {
      nowMs: this.nowMsFn,
      ...(this.deps.evaluationCache ? { cache: this.deps.evaluationCache } : {}),
    });
    const boundCache = bound.cache;
    const passCtx = bound.evalCtx;
    const projection = recallProjection(gathered, {
      query,
      ...(opts.targetIds ? { targetIds: opts.targetIds } : {}),
      ...(opts.lexicalScorer ? { lexicalScorer: opts.lexicalScorer } : {}),
      ...(opts.feedbackBound !== undefined ? { feedbackBound: opts.feedbackBound } : {}),
      evaluator: opts.evaluator ?? this.deps.evaluator,
      ...((passCtx ?? opts.evalCtx ?? this.deps.evalCtx)
        ? { evalCtx: (passCtx ?? opts.evalCtx ?? this.deps.evalCtx) as MemoryEvalContext }
        : {}),
    });
    const aliasIndex = buildAliasIndex(gathered.aliases ?? []);
    // DETERMINISTIC by construction: no wall clock enters the ENUMERABLE response — `state` carries
    // the freshness signal, so two identical searches over identical inputs are byte-equal and
    // ifHash can collapse the second call (a `this.now()` stamp here would break that permanently).
    // The wall-clock AGE of the cached generation rides alongside NON-enumerably (below).
    const evaluatedAt: string | null = null;
    const codeHead: string | null = opts.codeHead ?? this.deps.codeHead ?? null;
    const generation: string | null = bound.generation;
    const freshness: FreshnessState = {
      state: projection.provenance.fresh ? 'fresh' : 'unevaluated',
      evaluatedAt,
      codeHead,
    };
    /**
     * R02 — the freshness a hit reports is a fact about THAT RECORD, not about the pass.
     *
     * `projection.provenance.fresh` says only that an evaluator was bound for this search. Stamping
     * it on every hit is how a migrated record whose evidence was never revalidated came back
     * labelled `fresh`. A record the projection did not evaluate reports `unevaluated`, whatever the
     * pass as a whole did — so the label can never again outrun the work.
     */
    const unevaluatedFreshness: FreshnessState = { state: 'unevaluated', evaluatedAt, codeHead };
    const freshnessFor = (scored: { evaluated: boolean }): FreshnessState =>
      scored.evaluated ? freshness : unevaluatedFreshness;
    const allDecisions = [...gathered.decisions, ...gathered.localDecisions];
    // PERF: hoisted out of the per-hit map below. `enrichHit` → `supersededBy` scans this pool
    // linearly for every hit, so rebuilding the array inside the map made `search` O(hits × records)
    // — at 10k records it dominated the whole call. The ledger path (`ledgerRows`) already hoists
    // the identical projection; this keeps the two paths consistent. Same array, computed once.
    const gatheredRecords = gathered.records.map((t) => t.record);
    // Enrich only the page the caller will read (see SearchOpts.limit).
    const ranked =
      opts.limit !== undefined && opts.limit >= 0
        ? projection.memories.slice(0, Math.trunc(opts.limit))
        : projection.memories;
    const hits: SearchHit[] = ranked.map((scored) =>
      this.enrichHit(scored.record, scored.source, scored.score, scored.verdicts, {
        aliasIndex,
        // NO-POISON, the same pool split get() applies: LOCAL decisions name successors of
        // LOCAL-sourced records only. The hit's VERDICTS above already come from the projection
        // (which holds the line); supersededBy must not leak around it — a team-sourced hit
        // listing a local successor would be self-inconsistent within one response (lifecycle
        // 'active' while supersededBy names a retiree the team store never accepted).
        allDecisions: scored.source === 'local' ? allDecisions : gathered.decisions,
        gatheredRecords,
        conflicts: projection.conflicts,
        freshness: freshnessFor(scored),
      }),
    );
    // G3.3 — attach the volatile freshness trio NON-enumerably (shared freshness object across
    // hits — one attach per response). canonicalStringify walks enumerable keys only, so ifHash
    // never sees these; a display layer reading `hit.freshness.generation` / `.ageMs` explicitly
    // gets the live values.
    const volatile = {
      generation,
      ...(boundCache && boundCache.evaluatedAt !== null
        ? { evaluatedAtMs: boundCache.evaluatedAt }
        : {}),
    };
    attachVolatileFreshness(freshness, volatile, this.nowMsFn());
    // The unevaluated variant carries the same generation/age trio so a display layer reading it
    // sees one consistent shape — the honest difference between the two is `state`, nothing else.
    attachVolatileFreshness(unevaluatedFreshness, volatile, this.nowMsFn());
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
        generation,
        // G3.2 (red line #6) — the versioned scorer id when the caller supplied a versioned scorer
        // (the built-in exact scorer leaves the field absent). Traceable to configuration, not clock.
        ...(projection.provenance.scorerVersion !== undefined
          ? { scorerVersion: projection.provenance.scorerVersion }
          : {}),
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
      ...(isMemoryRecordVersioned(record) ? { propositionKey: record.propositionKey } : {}),
      ...(!isMemoryRecordVersioned(record) ? { scope: record.scope } : {}),
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
          try {
            successor.store.upsertEntry(recordCollectionOf(successor.store), updated);
          } catch (err) {
            // D10 — the store's write gate refuses a private record at the team store; surface the
            // refusal instead of crashing (no partial supersede: the decision never lands either).
            if (err instanceof TeamPrivateVisibilityError) return { ok: false, error: err.message };
            throw err;
          }
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
      try {
        decisionStore.upsertEntry(recordCollectionOf(decisionStore), successor);
      } catch (err) {
        // D10 — the store's write gate refuses a private successor at the team store; surface the
        // refusal instead of crashing (no partial supersede: the decision never lands either).
        if (err instanceof TeamPrivateVisibilityError) return { ok: false, error: err.message };
        throw err;
      }
    }

    const decision = supersedeDecision(
      { id: supersededId },
      { id: successorId },
      opts.actor,
      opts.reason ?? 'superseded via the portable memory API',
      this.now(),
    );
    // The write and its sync stage are ONE lock hold (D4): a crash after the write but before the
    // stage heals on the next push's sweep — but staging here makes the tombstone visible to peers
    // on THIS push, not only on the next one.
    decisionStore.withLock(() => {
      decisionStore.upsertEntry('decisions', decision);
      this.stageWrite(decisionStore, 'decision.append', decision, opts.actor);
    });
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
    // Same one-lock-hold law as supersede: the tombstone stages for sync the moment it lands.
    store.withLock(() => {
      store.upsertEntry('decisions', decision);
      this.stageWrite(store, 'decision.append', decision, opts.actor);
    });
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
      const stampedBase: LifecycleVerdict = isMemoryRecordVersioned(record)
        ? (conservativeVerdicts(legacy)?.lifecycle ?? 'active')
        : record.verdicts.lifecycle;
      const { lifecycle, quarantined } = believedLifecycle(bridged, stampedBase);
      beliefs.push({
        record,
        id: record.id,
        schemaVersion: record.schemaVersion,
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

  // ── sync (Gate 4 — the port-injected engine surface, ADR-003 D12) ─────────

  /**
   * Run the sync engine across the participant stores (local + global — team is never a
   * participant, D2). The backend port is INJECTED per call; the key resolves fail-closed from the
   * env/keyfile (D7). Unconfigured stores return the honest not-configured shape — nothing is
   * pretended. `status` needs no backend and reports the sidecar + remote state read-only.
   */
  async sync(request: SyncApiRequest): Promise<SyncResponse> {
    const participants = this.syncParticipants(request.stores);
    const asRequest = request as unknown as Record<string, unknown>;
    if (participants.length === 0) return syncNotConfigured(asRequest);
    if (request.op === 'status') {
      const key = this.syncKeyOrUndefined();
      const stores: SyncStatusResult[] = [];
      for (const p of participants) {
        stores.push(
          await syncEngineStatus(p.store, {
            backend: request.backend,
            ...(request.backend !== undefined && key ? { key } : {}),
          }),
        );
      }
      return { ok: true, op: 'status', stores };
    }
    if (request.backend === undefined) {
      return {
        ok: false,
        available: false,
        capability: 'sync',
        status: 'not-configured',
        message: `op '${request.op}' requires a backend object-store port (SyncObjectStore)`,
        request: asRequest,
      };
    }
    // A caller-supplied key (pre-resolved + fingerprint-verified — the CLI does exactly this) wins:
    // the run uses EXACTLY the verified bytes instead of re-resolving and hoping the two agree.
    const key = request.key ?? this.syncKeyOrUndefined();
    if (!key) {
      return {
        ok: false,
        op: request.op,
        dryRun: request.dryRun === true,
        stores: [],
        message:
          'no sync key resolved (set KCRIB_SYNC_KEY or a 0600 keyfile) — sync fails closed (D7)',
      };
    }
    const principalId = this.env.KCRIB_PRINCIPAL_ID ?? DEFAULT_MIGRATION_PRINCIPAL_ID;
    // A bound closure, not the bare method reference — the engine calls `now()` unbound, and an
    // unbound `this.now()` reaches for `this.nowFn` on `undefined`.
    const now = () => this.now();
    const stores: SyncStoreRun[] = [];
    for (const p of participants) {
      try {
        if (request.op === 'push') {
          const push = await pushSync(p.store, request.backend, {
            key,
            principalId,
            now,
            dryRun: request.dryRun,
            maxEvents: request.maxEvents,
            backfill: request.backfill,
            ...(p.scope === 'local' && request.syncRepoId !== undefined
              ? { syncRepoId: request.syncRepoId }
              : {}),
          });
          stores.push({ store: p.scope, ok: push.ok, push });
        } else {
          const pull = await pullSync(p.store, request.backend, {
            key,
            principalId,
            now,
            dryRun: request.dryRun,
            skip: request.skip,
            ...(p.scope === 'local' && request.syncRepoId !== undefined
              ? { syncRepoId: request.syncRepoId }
              : {}),
          });
          stores.push({ store: p.scope, ok: pull.ok, pull });
        }
      } catch (err) {
        stores.push({ store: p.scope, ok: false, error: (err as Error).message });
      }
    }
    return {
      ok: stores.every((s) => s.ok),
      op: request.op,
      dryRun: request.dryRun === true,
      stores,
    };
  }

  /** The status half of {@link sync} as its own op (honest empty shapes when unconfigured). */
  async syncStatus(
    opts: { backend?: SyncObjectStore; stores?: SyncStoreScope[] } = {},
  ): Promise<SyncStatusReport> {
    const participants = this.syncParticipants(opts.stores);
    const key = this.syncKeyOrUndefined();
    const stores: SyncStatusResult[] = [];
    for (const p of participants) {
      stores.push(
        await syncEngineStatus(p.store, {
          backend: opts.backend,
          ...(opts.backend !== undefined && key ? { key } : {}),
        }),
      );
    }
    return { ok: true, op: 'status', stores };
  }

  /**
   * `init-sync` (D5/D7): seed the sync-state baseline for one store AND write its config file —
   * the config carries a keySource REFERENCE + fingerprint + epoch, NEVER key bytes. Idempotent:
   * a re-init returns the existing baseline unchanged (repair paths are the sweep, never a re-seed).
   */
  async syncInit(input: SyncInitInput): Promise<SyncInitResult> {
    const p = this.syncParticipants([input.scope])[0];
    if (!p) {
      return { ok: false, scope: input.scope, error: `no ${input.scope} store is configured` };
    }
    const baseline = seedSyncBaseline(p.store, {
      deviceId: input.deviceId,
      backfill: input.backfill,
      // The override must be threaded into the SEED too: the baseline acks the derived ids, so a
      // later push (deriving under the same override) must re-derive the SAME ids (D5).
      ...(input.syncRepoId !== undefined ? { repoId: input.syncRepoId } : {}),
    });
    const store = p.store;
    const id = p.scope === 'local' ? (store.readManifest()?.repo?.id ?? 'unknown-repo') : 'global';
    const config: SyncConfigFile = {
      schemaVersion: '1',
      scope: p.scope,
      id,
      keySource: input.keySource ?? 'env',
      keyFingerprint: keyFingerprint(input.key),
      keyEpoch: loadSyncState(store.rootDir)?.keyEpoch ?? 1,
      ...(input.keyEnv !== undefined ? { keyEnv: input.keyEnv } : {}),
      ...(input.keyFile !== undefined ? { keyFile: input.keyFile } : {}),
      ...(input.backend !== undefined ? { backend: input.backend } : {}),
      ...(input.syncRepoId !== undefined ? { syncRepoId: input.syncRepoId } : {}),
    };
    writeSyncConfig(config, this.env);
    return {
      ok: true,
      scope: p.scope,
      baseline,
      configPath: syncConfigPath(p.scope, id, this.env),
      keyFingerprint: config.keyFingerprint,
      keyEpoch: config.keyEpoch,
    };
  }

  /** The conflicts ledgers across the participant stores (D8: digests only — never payload bytes). */
  listSyncConflicts(): { ok: boolean; conflicts: (ConflictRecord & { store: SyncStoreScope })[] } {
    const out: (ConflictRecord & { store: SyncStoreScope })[] = [];
    for (const p of this.syncParticipants()) {
      const state = loadSyncState(p.store.rootDir);
      if (!state) continue;
      for (const row of state.conflicts) out.push({ ...row, store: p.scope });
    }
    return { ok: true, conflicts: out };
  }

  /**
   * Append-only conflict resolution (D8): a human decides, the ledger records. Exactly one of
   * `successor` / `retract` must be given — the resolving decision is content-addressed and itself
   * syncs, so the resolution converges across devices like any other belief change.
   */
  resolveConflict(
    recordId: string,
    resolution: ConflictResolution,
    actor: string,
    reason?: string,
  ): {
    ok: boolean;
    id?: string;
    decisionId?: string;
    decisionSource?: MemorySource;
    error?: string;
  } {
    const given =
      (resolution.successor !== undefined ? 1 : 0) + (resolution.retract === true ? 1 : 0);
    if (actor.length === 0) return { ok: false, error: 'actor is required' };
    if (recordId.length === 0) return { ok: false, error: 'recordId is required' };
    if (resolution.successor !== undefined && resolution.retract === true) {
      return { ok: false, error: 'give exactly one of successor / retract' };
    }
    if (given === 0) {
      return { ok: false, error: 'resolution requires a successor or retract' };
    }
    if (resolution.successor !== undefined) {
      const r = this.supersede(recordId, resolution.successor, {
        actor,
        reason: reason ?? `conflict resolved: superseded by ${resolution.successor}`,
      });
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        id: r.supersededId,
        decisionId: r.decisionId,
        decisionSource: r.decisionSource,
      };
    }
    const r = this.delete(recordId, {
      actor,
      reason: reason ?? 'conflict resolved: retracted',
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: r.id, decisionId: r.decisionId, decisionSource: r.decisionSource };
  }

  /**
   * The D11 physical purge: logical tombstone FIRST (the synced, replayable part), then the
   * physical shard rewrite via `removeEntry` (NEVER a raw file write — FTS notices fire and BM25's
   * IDF stays correct), then the same-seed twin sweep (`cand:`, feedback, capture outbox/dead),
   * then the alias-resolved twin — with alias lines RETAINED as deliberate audit history. Team is
   * append-only even when explicitly opted-in: only the retract decision lands, and only on a
   * CLEAN working tree. With a backend: remote blobs are deleted (terminal state first) and the
   * purge-ack recorded LAST. `--dry-run` computes everything and writes nothing.
   */
  async purgeRecords(memIds: string[], opts: PurgeOpts): Promise<PurgeResult> {
    const dryRun = opts.dryRun === true;
    if (!Array.isArray(memIds) || memIds.length === 0) {
      return { ok: false, dryRun, purged: [], message: 'no memory ids given' };
    }
    if (typeof opts.actor !== 'string' || opts.actor.length === 0) {
      return { ok: false, dryRun, purged: [], message: 'actor is required' };
    }
    // D11 — the exact-confirm law: no wildcards, the exact list repeated.
    const want = [...memIds].sort();
    const confirm = [...(opts.confirmIds ?? [])].sort();
    if (want.length !== confirm.length || want.some((id, i) => id !== confirm[i])) {
      return {
        ok: false,
        dryRun,
        purged: [],
        message: 'confirmIds must repeat the exact purge list — refusing (no wildcards)',
      };
    }
    for (const id of memIds) {
      if (!id.startsWith('mem:')) {
        return {
          ok: false,
          dryRun,
          purged: [],
          message: `purge takes record ids (mem:…) — '${id}' is not one`,
        };
      }
    }
    const wanted = opts.stores ?? ['local', 'global'];
    const repoRoot = this.repoRootForGit();
    const reports: PurgeTargetReport[] = [];
    // One store at a time — the no-cross-store-nesting guard is honored by sequencing, not by
    // holding two locks.
    for (const { source, store } of this.orderedStores()) {
      if (!wanted.includes(source)) continue;
      if (source === 'team') {
        // D11 — the clean-tree gate runs BEFORE any store interaction: a dirty tree refuses the
        // team purge outright (no tombstone, no twin sweep, no decision appended), because a purge
        // that mutated the memory home would itself dirty the tree it is gated on.
        const clean = isCleanGitTree(repoRoot);
        if (!clean) {
          for (const id of memIds) {
            reports.push({
              id,
              found: false,
              stores: [
                {
                  store: 'team',
                  removed: false,
                  twins: [],
                  error:
                    'team purge requires a clean git working tree (D11) — commit or stash first',
                },
              ],
              error: 'team purge requires a clean git working tree (D11)',
            });
          }
          continue;
        }
        for (const id of memIds) {
          reports.push(await this.purgeFromStore(store, source, id, opts, repoRoot));
        }
        continue;
      }
      for (const id of memIds) {
        reports.push(await this.purgeFromStore(store, source, id, opts, repoRoot));
      }
    }
    return { ok: reports.every((r) => r.stores.every((s) => !s.error)), dryRun, purged: reports };
  }

  /** Purge ONE id from ONE store: tombstone → physical removal → twin sweep → remote delete. */
  private async purgeFromStore(
    store: MemoryStore,
    source: MemorySource,
    id: string,
    opts: PurgeOpts,
    repoRoot: string,
  ): Promise<PurgeTargetReport> {
    const dryRun = opts.dryRun === true;
    const scope: SyncStoreScope | undefined =
      source === 'local' ? 'local' : source === 'global' ? 'global' : undefined;
    const report: PurgeTargetReport = { id, found: false, stores: [] };
    const storeReport: PurgeStoreReport = { store: source, removed: false, twins: [] };
    report.stores.push(storeReport);
    // D11 step 4 — follow the alias resolution both ways: a legacy id purges its v2 twin, a v2 id
    // purges the legacy twin bound to it. Alias lines are RETAINED (audit history).
    const aliases = store.readAliases();
    const legacyIds = aliases.filter((a) => a.resolvedId === id).map((a) => a.legacyId);
    const resolvedTwin = store.resolveId(id);
    const recordIds = [
      ...new Set([id, ...legacyIds, ...(resolvedTwin !== id ? [resolvedTwin] : [])]),
    ];
    if (resolvedTwin !== id) report.resolvedTwin = resolvedTwin;
    const collection = recordCollectionOf(store);
    const purgedEntries: { recordId: string; entry: MemoryEntry }[] = [];
    for (const recordId of recordIds) {
      const shardRead = store.readShard(collection, memoryShard(recordId));
      const entry = shardRead.entries.find((e) => e.id === recordId);
      if (!entry) continue;
      report.found = true;
      purgedEntries.push({ recordId, entry });
      // (1) the logical tombstone FIRST — the synced, replayable part (D9/D11).
      const decision: MemoryDecision = {
        id: decisionId({
          kind: 'retract',
          subject: recordId,
          actor: opts.actor,
          reason: 'physically purged via crib memory purge (D11)',
        }),
        schemaVersion: '1',
        kind: 'retract',
        subject: recordId,
        actor: opts.actor,
        reason: 'physically purged via crib memory purge (D11)',
        ts: this.now(),
      };
      storeReport.decisionId = decision.id;
      if (!dryRun) {
        // The tombstone write + its sync stage: ONE lock hold (D4), same law as supersede/delete.
        store.withLock(() => {
          store.upsertEntry('decisions', decision);
          this.stageWrite(store, 'decision.append', decision, opts.actor);
        });
      }
      // (2) the physical rewrite — store-mediated only (FTS removed-id notices fire). Team is
      // append-only by DESIGN (D11): the retract decision landed above and nothing else happens —
      // a non-error outcome, not a failure, so the CLI exits 0.
      if (source === 'team') {
        storeReport.teamOutcome = 'retract-only';
      } else if (!dryRun) {
        store.removeEntry(collection, recordId);
        storeReport.removed = true;
      } else {
        storeReport.removed = false; // computed, not written
      }
    }
    // (3) the same-seed twin sweep — staging twin, feedback rows, capture outbox/dead rows. It runs
    // over EVERY purged id, not only the ones still physically present: a legacy id whose line was
    // already migrated to its v2 twin still owns its `cand:` staging twin and its capture rows, and
    // missing them would leave orphaned staging state behind a purged claim. One read-only scan
    // collects the targets; the removal runs only on a real run, so a dry-run reports exactly what
    // WOULD be removed.
    {
      const twins: string[] = [];
      const queueTargets: { queue: 'outbox' | 'dead'; id: string }[] = [];
      // A `mem:` id's staging twin is the `cand:` id with the same claim-body hash suffix.
      const candTwins = [
        ...new Set(
          recordIds
            .filter((rid) => rid.startsWith('mem:'))
            .map((rid) => `cand:${rid.slice('mem:'.length)}`),
        ),
      ];
      if (store.collections.includes('candidates')) {
        for (const candTwin of candTwins) {
          if (this.holdsDirect(store, candTwin, 'candidates')) twins.push(candTwin);
        }
      }
      if (store.collections.includes('feedback')) {
        for (const fb of store.readCollection('feedback').entries) {
          if (isFeedbackEntry(fb) && recordIds.includes(fb.subject)) twins.push(fb.id);
        }
      }
      for (const q of ['outbox', 'dead'] as const) {
        if (!store.collections.includes(q)) continue;
        // The queue collections hold capture entries only (same cast idiom as outbox.ts).
        for (const cap of store.readCollection(q).entries as CaptureOutboxEntry[]) {
          // The capture lane correlates on the staging twin (meta.candidateId) — every purged
          // record id maps to the same-seed `cand:` twin.
          const capCand = cap.meta?.candidateId;
          if (
            capCand !== undefined &&
            (candTwins.includes(String(capCand)) || recordIds.includes(String(capCand)))
          ) {
            queueTargets.push({ queue: q, id: cap.id });
          }
        }
      }
      // The physical twin removal never runs on the team store (removeEntry throws there — team is
      // append-only, D11); team still REPORTS the twins it would sweep.
      if (!dryRun && source !== 'team') {
        for (const candTwin of candTwins) {
          if (twins.includes(candTwin)) store.removeEntry('candidates', candTwin);
        }
        for (const tw of twins) {
          if (tw.startsWith('fb:')) store.removeEntry('feedback', tw);
        }
        for (const t of queueTargets) store.removeEntry(t.queue, t.id);
      }
      // The queue targets are swept too — they are part of what the purge removes, so the report
      // carries them alongside the staging twin and the feedback rows (a dry-run must show them).
      storeReport.twins.push(...twins, ...queueTargets.map((t) => t.id));
    }
    // (4) the remote side — terminal state first, bookkeeping last (D11). Team is never a sync
    // participant (D2), so `scope` is undefined there and the remote leg never runs. Each scope
    // routes through ITS OWN backend + key (the per-scope `routes` map; the shared
    // `backend`/`syncKey` are the fallback applying to both) — a global-scope sync config has a
    // different backend/key than a local-scope one, and routing a global delete through the local
    // route deletes the WRONG key.
    const route = scope !== undefined ? opts.routes?.[scope] : undefined;
    const remoteBackend = route?.backend ?? opts.backend;
    const remoteKey = route?.syncKey ?? opts.syncKey;
    if (scope !== undefined && remoteBackend !== undefined && purgedEntries.length > 0) {
      if (remoteKey === undefined) {
        storeReport.error = 'backend given without a sync key — remote blobs cannot be routed';
      } else if (!dryRun) {
        const repoId =
          scope === 'local' ? (opts.syncRepoId ?? store.readManifest()?.repo?.id) : undefined;
        const state = loadSyncState(store.rootDir);
        const acks: string[] = [];
        for (const { recordId, entry } of purgedEntries) {
          // The record collections hold only record envelopes (validated on write), so the payload
          // narrowing holds by construction — the matched entry IS the previously-pushed payload.
          const evtId = deriveEventId(
            'record.upsert',
            scope,
            repoId,
            entry as unknown as SyncEventPayload,
          );
          await remoteBackend.deleteObject(routeKeyFor(evtId, remoteKey));
          acks.push(evtId);
        }
        if (state) {
          // LAST (D11), under the store's lock: merged over the LATEST on-disk state so a
          // concurrent writer's acks survive this purge-ack save.
          store.withLock(() => {
            const latest = loadSyncState(store.rootDir) ?? state;
            const next = { ...latest, purgeAcks: [...latest.purgeAcks, ...acks] };
            saveSyncState(store.rootDir, next);
          });
        }
      }
    }
    // (5) the honest limit — read-only git history scan (D11), over EVERY record id the purge
    // touches (the legacy/v2 twin commits are just as irreversible as the requested id's).
    if (opts.historyScan === true) {
      report.commits = [...new Set(recordIds.flatMap((rid) => gitLogSHits(rid, repoRoot)))];
    }
    return report;
  }

  // ── sync internals ────────────────────────────────────────────────────────

  /** The configured sync participants in stable order (team is NEVER a participant, D2). */
  private syncParticipants(
    stores?: SyncStoreScope[],
  ): { scope: SyncStoreScope; store: MemoryStore }[] {
    const out: { scope: SyncStoreScope; store: MemoryStore }[] = [];
    for (const scope of ['local', 'global'] as const) {
      if (stores !== undefined && !stores.includes(scope)) continue;
      const store = scope === 'local' ? this.deps.stores.local : this.deps.stores.global;
      if (store) out.push({ scope, store });
    }
    return out;
  }

  /** Fail-closed key resolution; `undefined` on failure (the caller reports, never falls open). */
  private syncKeyOrUndefined(): Uint8Array | undefined {
    try {
      return resolveSyncKey({ env: this.env }).key;
    } catch {
      return undefined;
    }
  }

  /** The git working root the purge history-scan + clean-tree check run against. */
  private repoRootForGit(): string {
    const local = this.deps.stores.local;
    return local?.readManifest()?.repo?.root ?? process.cwd();
  }

  /** The stable cross-clone sync id (the local sync config's `syncRepoId`), read from the config
   *  this machine wrote at init-sync. `undefined` = derive from the manifest as before. */
  private syncRepoIdOverride(): string | undefined {
    const manifestId = this.deps.stores.local?.readManifest()?.repo?.id;
    if (manifestId === undefined) return undefined;
    return readSyncConfig('local', manifestId, this.env)?.syncRepoId;
  }

  /** The stageSyncableWrite context this API supplies at its own write sites. `now` feeds only
   *  envelope metadata. */
  private stageCtx(principalId: string): SyncStageContext {
    const syncRepoId = this.syncRepoIdOverride();
    return {
      principalId,
      env: this.env,
      now: () => this.now(),
      ...(syncRepoId !== undefined ? { syncRepoId } : {}),
    };
  }

  /** Stage the sync event for a decision/feedback entry THIS call just wrote — the caller's lock
   *  hold covers both the write and the stage (D4: one unit, one store). */
  private stageWrite(
    store: MemoryStore,
    kind: 'decision.append' | 'feedback.append',
    payload: MemoryEntry,
    principalId: string,
  ): void {
    stageSyncableWrite(store, kind, payload, this.stageCtx(principalId));
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
      const stamped: Verdicts | undefined = isMemoryRecordVersioned(record)
        ? conservativeVerdicts(legacy)
        : record.verdicts;
      const verdicts = effectiveVerdicts(record, bridged, undefined, stamped);
      views.push(this.auditView(record, legacy, stamped, verdicts, mine, feedback, legacyIds));
    }
    return { requested: idOrSubject, found: true, records: views };
  }

  // ── ledger (G5.4 — the viz UI's read-only inspector projection) ─────────────

  /**
   * The full memory ledger, paginated and grouped — ONE projection over every gathered record
   * that REUSES the existing read truth end-to-end: verdicts fold through the SAME
   * {@link effectiveVerdicts} + alias-bridge + no-poison rule `get()` applies; conflicts come from
   * the evaluator's own {@link conflictGroups}; staleness comes from the stable-locator
   * correlation ({@link correlateAnchors}); supersession from the shared {@link supersededBy}.
   * Nothing here re-implements a projection.
   *
   * Deterministic: rows sort by group rank, then recorded/created time desc, then id — no wall
   * clock anywhere in the response (the ledger view is a pure function of store + soul state).
   * Retracted/superseded/quarantined records are VISIBLE (group `retracted`), never hidden — the
   * tombstone is part of the ledger, not an omission. Paginated because a ledger can be large.
   */
  ledger(opts: LedgerOpts = {}): LedgerResult {
    const sourced = this.gatherAllRecords();
    const aliasIndex = this.buildAliasIndex();
    const decisions = this.allDecisions();
    const gatheredRecords = sourced.map((s) => s.record);
    // Anchors correlate against the live soul the API was wired with (the viz always binds one);
    // with no soul bound every anchor reports `uncheckable` honestly instead of a fake verdict.
    const nodes = this.deps.soul ? this.deps.soul.allNodes() : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Verdicts fold FIRST: conflictGroups consumes `{record, verdicts}` entries, so every row's
    // effective verdicts must exist before conflicts are grouped (the get()/audit() fold, shared).
    const folded = sourced.map(({ record, source }) => ({
      record,
      source,
      ...this.foldedVerdicts(record, source, aliasIndex, decisions),
    }));
    const conflicts = conflictGroups(folded).map((c) => conflictSummaryOf(c));
    // Sort-time per id, built once — a comparator calling back into the records would be O(n²).
    const sortTimeById = new Map(gatheredRecords.map((r) => [r.id, recordSortTime(r)]));
    const rows = folded
      .map((f) =>
        this.ledgerRow(f.record, f.source, f, aliasIndex, gatheredRecords, byId, nodes, conflicts),
      )
      .sort(
        (a, b) =>
          LEDGER_GROUPS.indexOf(a.group) - LEDGER_GROUPS.indexOf(b.group) ||
          (sortTimeById.get(b.id) ?? '').localeCompare(sortTimeById.get(a.id) ?? '') ||
          a.id.localeCompare(b.id),
      );
    const counts: Record<LedgerGroup, number> & { conflicts: number } = {
      stale: 0,
      moved: 0,
      current: 0,
      unanchored: 0,
      retracted: 0,
      conflicts: conflicts.length,
    };
    for (const row of rows) counts[row.group] += 1;
    const filtered = opts.group ? rows.filter((r) => r.group === opts.group) : rows;
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
    const limit = Math.min(
      MAX_LEDGER_PAGE,
      Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LEDGER_PAGE)),
    );
    const capturePolicy = this.capturePolicyView();
    return {
      configured: true,
      total: filtered.length,
      offset,
      limit,
      counts,
      conflicts,
      ...(capturePolicy ? { capturePolicy } : {}),
      // The gather paths are fail-loud (a corrupt shard throws, exactly as get()/audit() do) —
      // there is no silent per-store degradation to report, so this stays empty, never fake.
      errors: [],
      rows: filtered.slice(offset, offset + limit),
    };
  }

  /**
   * The effective-verdict fold `get()`/`audit()` apply, extracted so the ledger REUSES the same
   * decision truth instead of re-implementing it. Returns the folded verdicts plus the no-poison
   * decision pool the row's supersession projection reuses.
   */
  private foldedVerdicts(
    record: ReadableMemoryRecord,
    source: MemorySource,
    aliasIndex: AliasIndex,
    decisions: readonly SourcedDecision[],
  ): { verdicts: EffectiveVerdicts; pool: readonly MemoryDecision[] } {
    const legacy = aliasIndex.aliasesFor(record.id);
    const legacyIds = new Set(legacy.map((a) => a.legacyId));
    const mine = decisions.filter(
      (d) => d.decision.subject === record.id || legacyIds.has(d.decision.subject),
    );
    // No-poison, the same pool split get()/audit() apply: local decisions fold into LOCAL records
    // only — a local quarantine must never retire the same-content team record.
    const pool = (source === 'local' ? mine : mine.filter((d) => d.source !== 'local')).map(
      (d) => d.decision,
    );
    const bridged = bridgedDecisions(legacy, record.id, pool);
    const verdicts = effectiveVerdicts(record, bridged, undefined, conservativeVerdicts(legacy));
    return { verdicts, pool };
  }

  /** Build one ledger row (the per-record projection — see {@link MemoryApi.ledger}). */
  private ledgerRow(
    record: ReadableMemoryRecord,
    source: MemorySource,
    folded: { verdicts: EffectiveVerdicts; pool: readonly MemoryDecision[] },
    aliasIndex: AliasIndex,
    gatheredRecords: readonly ReadableMemoryRecord[],
    byId: ReadonlyMap<string, Node>,
    nodes: readonly Node[],
    conflicts: readonly ConflictSummary[],
  ): LedgerRow {
    const { verdicts, pool } = folded;
    const { anchors, status } = correlateAnchors(
      record as MemoryRecord | MemoryRecordV2,
      byId,
      nodes,
    );
    const isV1 = !isMemoryRecordVersioned(record);
    return {
      id: record.id,
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      subject: record.subject,
      claim: capClaim(record.claim),
      visibility: visibilityOf(record),
      source,
      placement: this.placementsOf(record.id),
      standing: standingOf(verdicts.trust),
      evidenceVerdict: verdicts.evidence,
      applicability: verdicts.applicability,
      lifecycle: verdicts.lifecycle,
      quarantined: verdicts.quarantined,
      eligible: isRecallEligible(verdicts),
      evidence: evidenceSummaries(record),
      validity: validityOf(record).validTime,
      ...(isV1
        ? { createdAt: record.createdAt, scope: record.scope }
        : {
            observedAt: record.transactionTime.observedAt,
            recordedAt: record.transactionTime.recordedAt,
            retentionPolicyId: record.retentionPolicyId,
          }),
      lineage: lineageOf(record),
      supersededBy: this.supersededBy(record, aliasIndex, pool, gatheredRecords).map(
        ({ id, via, found }) => ({ id, via, found }),
      ),
      conflicts: conflicts.filter((c) => c.recordIds.includes(record.id)),
      anchors,
      anchorStatus: status,
      group: ledgerGroupOf(verdicts, status),
    };
  }

  /** The capture policy in force, as the ledger reports it (corrupt policy → surfaced, not thrown). */
  private capturePolicyView(): LedgerResult['capturePolicy'] {
    if (!this.deps.cribDir) return undefined;
    try {
      const policy = loadPolicy(this.deps.cribDir);
      if (!policy) return undefined;
      return { trustedRef: trustedRefOf(policy), profiles: Object.keys(policy.profiles).sort() };
    } catch (err) {
      return {
        trustedRef: 'unreadable policy',
        profiles: [`error: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
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
        record: ReadableMemoryRecord;
        source: MemorySource;
        store: MemoryStore;
        viaAlias?: MemoryAlias;
      }
    | undefined {
    for (const { source, store } of this.orderedStores()) {
      const collection = recordCollectionOf(store);
      const direct = this.directEntry(store, collection, id);
      if (direct && isRecordEntry(direct) && this.acceptsRecord(direct)) {
        return { record: direct, source, store };
      }
      const alias = this.readAliasSafe(store, id);
      if (alias && alias.resolvedId !== id) {
        const twin = this.directEntry(store, collection, alias.resolvedId);
        if (twin && isRecordEntry(twin) && this.acceptsRecord(twin)) {
          return { record: twin, source, store, viaAlias: alias };
        }
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
    const entry = this.directEntry(store, collection, id);
    return entry !== undefined && (!isRecordEntry(entry) || this.acceptsRecord(entry));
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
        if (!isRecordEntry(entry) || !this.acceptsRecord(entry)) continue;
        if (!byId.has(entry.id)) byId.set(entry.id, { record: entry, source, store });
      }
    }
    return [...byId.values()];
  }

  /**
   * The direct-read counterpart to `gatherRecall`'s G7 boundary. Versioned records are private to
   * their stamped principal; v1 has no principal column and remains readable for migration
   * compatibility. Keep this guard at locate/gather rather than individual public verbs so a new
   * record-returning API cannot accidentally bypass principal isolation.
   */
  private acceptsRecord(record: ReadableMemoryRecord): boolean {
    return (
      !isMemoryRecordVersioned(record) || record.provenance.principalId === this.callerPrincipal()
    );
  }

  private callerPrincipal(): string {
    const principal = this.env.KCRIB_PRINCIPAL_ID ?? DEFAULT_MIGRATION_PRINCIPAL_ID;
    return principal.trim().length > 0 ? principal : DEFAULT_MIGRATION_PRINCIPAL_ID;
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
    record: ReadableMemoryRecord,
    source: MemorySource,
    score: RecallScore,
    verdicts: EffectiveVerdicts,
    ctx: {
      aliasIndex: AliasIndex;
      allDecisions: readonly MemoryDecision[];
      gatheredRecords: readonly ReadableMemoryRecord[];
      conflicts: readonly {
        key: string;
        subject: string;
        scope?: { boundary: string; repoId?: string };
        propositionKey?: string;
        records: ReadableMemoryRecord[];
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
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      subject: record.subject,
      claim: record.claim,
      visibility: visibilityOf(record),
      ...(isMemoryRecordVersioned(record) ? { propositionKey: record.propositionKey } : {}),
      ...(!isMemoryRecordVersioned(record) ? { scope: record.scope } : {}),
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
    record: ReadableMemoryRecord,
    aliasIndex: AliasIndex,
    decisions: readonly MemoryDecision[],
    gatheredRecords: readonly ReadableMemoryRecord[],
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
    // O(1) lookup against the hoisted lineage index instead of a full pool scan per hit.
    for (const successorId of supersedesIndexFor(gatheredRecords).get(record.id) ?? []) {
      if (successorId === record.id) continue;
      if (!out.has(successorId)) {
        out.set(successorId, { id: successorId, via: 'lineage', found: false });
      }
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
    record: ReadableMemoryRecord,
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
      schemaVersion: record.schemaVersion,
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
function lineageOf(record: ReadableMemoryRecord): {
  derivedFrom?: string[];
  supersedes?: string[];
  contradicts?: string[];
} {
  return isMemoryRecordVersioned(record) ? record.lineage : {};
}

/** Reduce a projection conflict group to its id-only summary. */
function conflictSummaryOf(c: {
  key: string;
  subject: string;
  scope?: { boundary: string; repoId?: string };
  propositionKey?: string;
  records: readonly ReadableMemoryRecord[];
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
    if (isMemoryRecordVersioned(record) && record.propositionKey === key) return true;
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
