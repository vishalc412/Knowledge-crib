/**
 * G5.4 — the memory-ledger READ projection helpers: anchor staleness correlation + the ledger
 * grouping vocabulary. The verdict folding itself is NEVER re-implemented here — the API's
 * `ledger()` op computes every row's verdicts through the SAME {@link effectiveVerdicts} decision
 * fold `get()`/`audit()` use; this module owns only the parts those ops do not already project:
 *
 *   - **anchor correlation** (the "what went stale when the code moved" signal): each record's
 *     evidence/applies-to soul anchors are resolved against the LIVE soul node list — exactly
 *     resolved (`current`), reattached elsewhere via the stable locator (exactly one candidate,
 *     `moved`), or unresolvable (`gone`). Ambiguous multi-matches are reported, never guessed
 *     (the same exactly-one rule the revalidation path enforces). PURE over the node list.
 *   - **row/group shapes** the viz ledger endpoint serializes.
 *
 * Display vocabulary: the verdict axis values are the evaluator's own; only the admission axis is
 * renamed for display (`trust: 'candidate'` → `standing: 'staged'`) — the raw axis name and its
 * staging value are internal vocabulary that must not leak into user-facing surfaces.
 */
import type { Node } from '@knowledge-crib/soul-schema';
import type { EvidenceKind, EvidenceVerdict } from './enums.js';
import type { EffectiveVerdicts } from './evaluator.js';
import { bestLocatorMatches, buildLocatorFromEvidence, parseSoulId } from './locator.js';
import type { MemorySource } from './recall.js';
import {
  type MemoryRecord,
  type MemoryRecordV2,
  type MemoryVisibility,
  isMemoryRecordV2,
} from './types.js';

// ─── anchors ─────────────────────────────────────────────────────────────────

/** How one anchor ref fares against the live soul (the staleness signal, per anchor). */
export type LedgerAnchorState = 'current' | 'moved' | 'gone' | 'ambiguous' | 'uncheckable';

/** What kind of target an anchor ref points at (drives the ledger's anchor icons). */
export type LedgerAnchorKind = 'symbol' | 'doc' | 'artifact' | 'file' | 'path' | 'other';

export interface LedgerAnchor {
  /** the anchor ref verbatim (soul id, artifact id, or path). */
  ref: string;
  kind: LedgerAnchorKind;
  state: LedgerAnchorState;
  /** the repo-relative path the ref parses to, when it carries one. */
  file?: string;
  /** where the anchor lives NOW (resolved id), when the ref moved and exactly one match exists. */
  nowAt?: string;
  /** why the state was assigned (ambiguous match count, no graph bound, …). */
  reason?: string;
}

/** The record-level anchor verdict — the worst anchor state wins, `unanchored` when none exist. */
export type LedgerAnchorStatus = 'current' | 'moved' | 'stale' | 'unanchored' | 'unverified';

/** The ledger groups, in the order the UI renders them (stale first — they demand attention). */
export type LedgerGroup = 'stale' | 'moved' | 'current' | 'unanchored' | 'retracted';

export const LEDGER_GROUPS: readonly LedgerGroup[] = [
  'stale',
  'moved',
  'current',
  'unanchored',
  'retracted',
];

/** The display name for the admission axis: `staged` = not yet admitted to any store's recall. */
export type LedgerStanding = 'staged' | 'local' | 'team';

/** Map the evaluator's admission verdict onto the display vocabulary (see module doc). */
export function standingOf(trust: EffectiveVerdicts['trust']): LedgerStanding {
  return trust === 'team' ? 'team' : trust === 'local' ? 'local' : 'staged';
}

function anchorKindOf(prefix: string | undefined, hasPath: boolean): LedgerAnchorKind {
  switch (prefix) {
    case 'sym':
    case 'field':
    case 'comp':
      return 'symbol';
    case 'doc':
      return 'doc';
    case 'art':
      return 'artifact';
    case 'file':
      return 'file';
    default:
      return hasPath ? 'path' : 'other';
  }
}

/**
 * The code/doc anchor refs a record carries: v1 reads `appliesTo` (the reattachment targets) plus
 * every evidence item's soul/artifact anchor; v2 reads the same evidence anchors plus its subject
 * when the subject IS a soul id (a v2 envelope has no appliesTo — the evidence items carry the
 * anchors). Deduped, order-stable (first-seen). PURE.
 */
export function extractAnchors(record: MemoryRecord | MemoryRecordV2): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (ref: unknown): void => {
    if (typeof ref !== 'string' || ref.length === 0 || seen.has(ref)) return;
    seen.add(ref);
    out.push(ref);
  };
  if (!isMemoryRecordV2(record)) for (const ref of record.appliesTo) push(ref);
  // A v2 subject only anchors when it IS a resolvable soul id (a real path payload) — `topic:…`
  // subjects parse as a bare prefix with no target, and pretending they resolve would report
  // session-lifecycle captures `gone` against a graph they never pointed at.
  else if (parseSoulId(record.subject)?.path) push(record.subject);
  for (const ev of record.evidence) {
    push(ev.soulId);
    push(ev.artifactId);
  }
  return out;
}

/**
 * Resolve one anchor ref against the live node list. `byId` is the id→node index over the same
 * list (built once per ledger pass). Resolution ladder: exact id → `current`; else locator
 * reattachment (exactly one candidate → `moved` with the new location; several → `ambiguous` —
 * the evaluator's exactly-one rule, never guessed); none → `gone`. A ref with no soul-id grammar
 * and no path is `uncheckable` (a bare topic key has nothing to resolve against). PURE.
 */
export function correlateAnchor(
  ref: string,
  byId: ReadonlyMap<string, Node>,
  nodes: readonly Node[],
): LedgerAnchor {
  const parsed = parseSoulId(ref);
  const kind = anchorKindOf(parsed?.prefix, (parsed?.path ?? ref).includes('/'));
  // An unparsed ref still anchors by path when it LOOKS like one ('src/a.ts') — only soul-id
  // grammar yields parsed.path, so bare paths must fall back to the ref itself.
  const file = parsed?.path ?? (parsed ? undefined : ref.includes('/') ? ref : undefined);
  const base: LedgerAnchor = { ref, kind, state: 'gone', ...(file ? { file } : {}) };
  if (byId.has(ref)) return { ...base, state: 'current' };
  if (!parsed) {
    // A bare path (no soul-id grammar): anchorable iff any live node still sits in that file.
    if (file && nodes.some((n) => n.file === file)) return { ...base, state: 'current' };
    return { ...base, state: 'gone' };
  }
  const locator = buildLocatorFromEvidence({ soulId: ref });
  if (!locator || locator.pathHints.length === 0) {
    // A prefix with no path/name/anchor payload has nothing to reattach against — report it
    // uncheckable rather than let a kind-only sweep call it `gone`.
    return { ...base, state: 'uncheckable', reason: 'no resolvable anchor signals' };
  }
  const matches = bestLocatorMatches(nodes, locator, 2);
  if (matches.length === 1) {
    const hit = matches[0]!;
    return {
      ...base,
      state: 'moved',
      nowAt: hit.id,
      ...(hit.file ? { file: hit.file } : {}),
      reason: 'reattached to exactly one live node',
    };
  }
  if (matches.length > 1) {
    return { ...base, state: 'ambiguous', reason: 'multiple reattachment candidates' };
  }
  // Gone — but say whether the FILE it lived in still exists (a moved file vs a deleted symbol).
  const fileGone = file !== undefined && !nodes.some((n) => n.file === file);
  return {
    ...base,
    state: 'gone',
    ...(fileGone ? { reason: 'file no longer in the graph' } : { reason: 'symbol not found' }),
  };
}

/**
 * Correlate EVERY anchor of `record` against the live node list and fold the per-anchor states
 * into the record-level {@link LedgerAnchorStatus} (worst anchor wins: stale > moved > current;
 * no anchors at all → `unanchored`). PURE.
 */
export function correlateAnchors(
  record: MemoryRecord | MemoryRecordV2,
  byId: ReadonlyMap<string, Node>,
  nodes: readonly Node[],
): { anchors: LedgerAnchor[]; status: LedgerAnchorStatus } {
  const refs = extractAnchors(record);
  if (refs.length === 0) return { anchors: [], status: 'unanchored' };
  const anchors = refs.map((ref) => correlateAnchor(ref, byId, nodes));
  if (anchors.some((a) => a.state === 'gone' || a.state === 'ambiguous')) {
    return { anchors, status: 'stale' };
  }
  if (anchors.some((a) => a.state === 'moved')) return { anchors, status: 'moved' };
  if (anchors.every((a) => a.state === 'uncheckable')) return { anchors, status: 'unverified' };
  return { anchors, status: 'current' };
}

/**
 * Fold a record's effective verdicts + anchor correlation into its ledger group. Lifecycle
 * decisions win first (a retracted/superseded/quarantined record is visible in the `retracted`
 * group — NEVER hidden: the tombstone is part of the ledger), then the staleness signal, then
 * no-anchors records into `unanchored`. PURE.
 */
export function ledgerGroupOf(
  verdicts: EffectiveVerdicts,
  anchorStatus: LedgerAnchorStatus,
): LedgerGroup {
  if (
    verdicts.lifecycle === 'retracted' ||
    verdicts.lifecycle === 'superseded' ||
    verdicts.quarantined
  ) {
    return 'retracted';
  }
  if (anchorStatus === 'stale') return 'stale';
  if (anchorStatus === 'moved') return 'moved';
  if (anchorStatus === 'unanchored' || anchorStatus === 'unverified') return 'unanchored';
  return 'current';
}

// ─── ledger row shapes (the viz endpoint's serialization contract) ───────────

/** One evidence item's ledger summary (kind + verdict + anchor refs; never a raw span). */
export interface LedgerEvidenceView {
  kind: EvidenceKind;
  verdict: EvidenceVerdict;
  checkedAt: string;
  soulId?: string;
  receiptId?: string;
  reason?: string;
}

/** One conflict group as the ledger surfaces it (ids only — records are rows of their own). */
export interface LedgerConflictView {
  key: string;
  subject: string;
  propositionKey?: string;
  scope?: { boundary: string; repoId?: string };
  recordIds: readonly string[];
}

export interface LedgerRow {
  id: string;
  schemaVersion: '1' | '2' | '3';
  kind: string;
  subject: string;
  /** the claim, capped (`MAX_LEDGER_CLAIM_CHARS`) — the full text rides on the detail fetch. */
  claim: string;
  /** v2: private | workspace. v1 records have no visibility field and report `workspace`. */
  visibility: MemoryVisibility;
  /** the EFFECTIVE store the record was resolved from. */
  source: MemorySource;
  /** which stores physically hold this record id. */
  placement: readonly MemorySource[];
  /** display-named admission axis (`staged|local|team`) — see module doc for the rename. */
  standing: LedgerStanding;
  evidenceVerdict: EffectiveVerdicts['evidence'];
  applicability: EffectiveVerdicts['applicability'];
  lifecycle: EffectiveVerdicts['lifecycle'];
  quarantined: boolean;
  /** normal-recall eligibility under the CURRENT effective verdicts (the recall gate's own rule). */
  eligible: boolean;
  evidence: readonly LedgerEvidenceView[];
  /** the validTime window (`validityOf().validTime` — v1 derives it from createdAt). The
   *  transaction-time axis rides on createdAt/observedAt/recordedAt above. */
  validity: { from: string; to?: string };
  /** v1 `createdAt`; v2 `transactionTime.observedAt/recordedAt` — the bi-temporal read. */
  createdAt?: string;
  observedAt?: string;
  recordedAt?: string;
  lineage: { derivedFrom?: string[]; supersedes?: string[]; contradicts?: string[] };
  supersededBy: readonly { id: string; via: 'decision' | 'lineage'; found: boolean }[];
  conflicts: readonly LedgerConflictView[];
  /** v2 only — the committed retention policy governing this record. */
  retentionPolicyId?: string;
  /** v1 only — the semantic scope (placement is the `source` field, never conflated). */
  scope?: { boundary: string; repoId?: string };
  anchors: readonly LedgerAnchor[];
  anchorStatus: LedgerAnchorStatus;
  group: LedgerGroup;
  /** why an ACTIVE record needs a person's attention (empty when it does not, and for retired
   *  records, whose lifecycle already settled them). Blocking reasons come first. */
  reviewReasons: readonly LedgerReviewReason[];
}

/** The whole ledger response (paginated). Deterministic: no wall clock anywhere in the shape. */
export interface LedgerResult {
  /** false when no memory stores are wired for this repo — the UI degrades to that message. */
  configured: boolean;
  total: number;
  offset: number;
  limit: number;
  counts: Record<LedgerGroup, number> & { conflicts: number };
  /** whole-ledger counts of the two working views; they can overlap (see {@link LedgerView}). */
  views: { active: number; needsReview: number };
  conflicts: readonly LedgerConflictView[];
  /** the capture policy actually in force (absent when no policy.json exists). */
  capturePolicy?: { trustedRef: string; profiles: readonly string[] };
  errors: readonly string[];
  rows: readonly LedgerRow[];
}

/** Claim cap for list rows — the ledger stays scannable; detail fetches carry the full claim. */
export const MAX_LEDGER_CLAIM_CHARS = 240;

/** Ledger pagination budget: default page size and the hard cap the serving layer enforces. */
export const DEFAULT_LEDGER_PAGE = 100;
export const MAX_LEDGER_PAGE = 200;

/** Options for the API's `ledger()` op — every field optional. */
export interface LedgerOpts {
  /** page start (default 0). */
  offset?: number;
  /** page size, capped at {@link MAX_LEDGER_PAGE} (default {@link DEFAULT_LEDGER_PAGE}). */
  limit?: number;
  /** return only this group's rows (counts always cover the WHOLE ledger). History only. */
  group?: LedgerGroup;
  /** return only one working view's rows; cannot be combined with `group`. */
  view?: LedgerView;
}

// ─── working views (Active / Needs review) ───────────────────────────────────

/**
 * The two working views over the ledger. `active` is exactly the recall gate
 * ({@link LedgerRow.eligible}). `needs-review` is every lifecycle-active record with at least one
 * {@link LedgerReviewReason}. They OVERLAP by design: a record with degraded evidence stays
 * recall-eligible (usable with caution) and still asks for review. History is the unfiltered
 * ledger, reached by omitting `view`.
 */
export type LedgerView = 'active' | 'needs-review';

export const LEDGER_VIEWS: readonly LedgerView[] = ['active', 'needs-review'];

export type LedgerReviewReasonCode =
  | 'not-admitted'
  | 'evidence-invalid'
  | 'applicability-needs-review'
  | 'applicability-orphaned'
  | 'quarantined'
  | 'not-recall-eligible'
  | 'evidence-degraded'
  | 'conflict'
  | 'concern';

export interface LedgerReviewReason {
  code: LedgerReviewReasonCode;
  /** true when this reason alone keeps the record out of normal recall. */
  blocking: boolean;
}

/** The row facts the review classifier reads — the ledger row's own effective verdicts. */
export interface ReviewInputs {
  standing: LedgerStanding;
  evidenceVerdict: EffectiveVerdicts['evidence'];
  applicability: EffectiveVerdicts['applicability'];
  lifecycle: EffectiveVerdicts['lifecycle'];
  quarantined: boolean;
  eligible: boolean;
  conflicts: readonly unknown[];
  /** a recorded concern (contradicted feedback) that no quarantine has settled yet. */
  concern: boolean;
}

/**
 * Why a lifecycle-active record needs review, blocking reasons first. PURE. Retired records
 * (superseded / retracted) return no reasons: their lifecycle already decided them. The
 * `not-recall-eligible` fallback exists only so an ineligible row can never classify as needing
 * nothing — every exclusion the recall gate applies has a named reason above it.
 */
export function reviewReasonsOf(row: ReviewInputs): LedgerReviewReason[] {
  if (row.lifecycle !== 'active') return [];
  const out: LedgerReviewReason[] = [];
  const add = (code: LedgerReviewReasonCode, blocking: boolean) => out.push({ code, blocking });
  if (row.standing === 'staged') add('not-admitted', true);
  if (row.evidenceVerdict === 'invalid') add('evidence-invalid', true);
  if (row.applicability === 'needs-review') add('applicability-needs-review', true);
  if (row.applicability === 'orphaned') add('applicability-orphaned', true);
  if (row.quarantined) add('quarantined', true);
  if (!row.eligible && out.length === 0) add('not-recall-eligible', true);
  if (row.evidenceVerdict === 'degraded') add('evidence-degraded', false);
  if (row.conflicts.length > 0) add('conflict', false);
  if (row.concern) add('concern', false);
  return out;
}

/** True when a row belongs to the working view. PURE — the same predicate counts and filters. */
export function inLedgerView(
  view: LedgerView,
  row: Pick<LedgerRow, 'eligible' | 'reviewReasons'>,
): boolean {
  return view === 'active' ? row.eligible : row.reviewReasons.length > 0;
}

/** Cap a claim for list display, deterministically (same input → same output, no ellipsis guess). */
export function capClaim(claim: string): string {
  if (claim.length <= MAX_LEDGER_CLAIM_CHARS) return claim;
  return `${claim.slice(0, MAX_LEDGER_CLAIM_CHARS)}…`;
}
