/**
 * WP6.1/WP6.2 — the pending-queue READ projection: what a browser (or any surface) must show
 * before it can let an operator FINISH the pending-captures task.
 *
 * The queue is two honest sections, never one blended list:
 *   - `captures` — durable outbox entries awaiting distillation. Distillation runs an external
 *     model, so consent is structural (the operator names `--provider` on the command line);
 *     the browser NEVER invokes a provider. Each row carries the exact command instead.
 *   - `staged` — the admission queue: staged claims (`cand:` entries in the local store),
 *     classified by whether the SAME domain checks the CLI admission paths run would pass.
 *
 * Nothing here re-implements admission logic: the classification reuses
 * {@link admissibilityProblems} + {@link admissibleFor} — the evaluator's own write-time
 * pre-flight — so "ready in the browser" and "ready for `crib memory evaluate`" cannot drift.
 * The one deliberate divergence is terminal-attestation policy: a staged `human-attestation`
 * without `tty` is NOT a blocker here, it classifies the claim as `terminal` — `tty: true` is
 * minted only by a CLI call site that checked `process.stdin.isTTY`, and this projection must
 * never suggest a browser path around that (the plan's hard constraint).
 *
 * Display vocabulary: the ledger's law applies — internal staging vocabulary never leaks. The
 * `staged` section's `standing` axis (`ready`/`terminal`/`blocked`) is user-facing; raw trust
 * words do not appear in any user-facing surface fed by this projection.
 *
 * PURE over the local store: deterministic sort (proposedAt desc, then id), no wall clock, claim
 * text capped for scannability (detail views fetch the full claim separately).
 */
import { type MemoryRecordKind, isEvidenceKind } from './enums.js';
import { type AdmissibilityProblem, admissibilityProblems, admissibleFor } from './evaluator.js';
import { capClaim } from './ledger.js';
import { pendingCaptures } from './outbox.js';
import type { MemoryStore } from './store.js';
import type { CaptureOutboxEntry, MemoryCandidate, MemoryEvidence, MemoryScope } from './types.js';

/** The two queue sections — raw captures awaiting distillation, and claims staged for admission. */
export type PendingSection = 'captures' | 'staged';

/** Queue pagination budget (mirrors the ledger's defaults and hard cap). */
export const DEFAULT_PENDING_PAGE = 100;
export const MAX_PENDING_PAGE = 200;

/**
 * Whether one evidence item can be SATISFIED through a browser admission: its kind is admissible
 * for the claim kind AND its required fields are present AND it is not an unstamped human
 * attestation (only a real terminal stamps `tty: true` — `attestedAt`/`actor` are minted by the
 * same call site, so an unstamped attestation is terminal-only by construction).
 */
function browserSupportsEvidence(ev: MemoryEvidence): boolean {
  if (ev.kind === 'human-attestation') return ev.tty === true;
  if (ev.kind === 'source-quote') return typeof ev.soulId === 'string' && ev.soulId.length > 0;
  if (ev.kind === 'execution-assertion') return typeof ev.receiptId === 'string';
  if (ev.kind === 'receipt-pair') {
    return typeof ev.failingReceiptId === 'string' && typeof ev.passingReceiptId === 'string';
  }
  if (ev.kind === 'committed-policy') return typeof ev.artifactId === 'string';
  return false;
}

/** One evidence item, display-shaped: what it is, how it fared, and whether a browser can act on it. */
export interface PendingEvidenceView {
  kind: string;
  verdict: MemoryEvidence['verdict'];
  /** admissible for the claim's kind at all (the evaluator's own matrix). */
  admissible: boolean;
  /** satisfiable through browser admission (never true for an unstamped human attestation). */
  browserSupported: boolean;
  reason?: string;
}

/** The shared queue-row shape: everything a detail view needs to explain the item. */
export interface PendingQueueRow {
  /** `cap:` (captures) or `cand:` (staged) — the content-addressed id, also the revision token. */
  id: string;
  kind: MemoryRecordKind;
  subject: string;
  /** capped for the queue; detail fetches carry the full claim. */
  claim: string;
  scope: MemoryScope;
  appliesTo: readonly string[];
  origin: 'observe' | 'attempt';
  proposedAt: string;
  evidence: readonly PendingEvidenceView[];
  anchorStatus?: string;
}

/** A raw capture awaiting distillation — the browser shows the command, never runs a provider. */
export interface PendingCaptureRow extends PendingQueueRow {
  section: 'captures';
  /** the precise command; `<name>` stays a placeholder because consent is the operator's. */
  command: string;
}

/**
 * The terminal-only command the CLI exposes for admitting agent-staged attested claims. Positional
 * id; the `<id>` placeholder is replaced with the row's own content-addressed id. Kept free of the
 * internal admission vocabulary — this string serializes into a user-facing surface (ledger.ts law).
 */
export const TERMINAL_ADMIT_COMMAND = 'crib memory admit <id>';

/**
 * The CLI's supported-evidence admission command (same domain services the browser path runs):
 * positional id plus the REQUIRED trusted-base gate profile. `<name>` stays a placeholder — the
 * profile names the operator's gate configuration, which the browser never guesses.
 */
export const EVALUATE_COMMAND = 'crib memory evaluate <id> --profile <name>';

/** A staged claim, classified by the admission path it can actually take. */
export interface PendingStagedRow extends PendingQueueRow {
  section: 'staged';
  /** `ready` (browser can complete), `terminal` (needs a real TTY), `blocked` (fix first). */
  standing: 'ready' | 'terminal' | 'blocked';
  /** human-readable admission blockers, empty when nothing structural is wrong. */
  blockers: readonly string[];
  /** non-blocking notices (ignored evidence items) — never empties a `ready` row's actions. */
  notes: readonly string[];
  /** true only when a browser admission can legitimately complete for this row. */
  browserAdmissible: boolean;
  /** the precise next command for `terminal` and `blocked` rows; `ready` rows carry the CLI equivalent. */
  command: string;
}

export interface PendingSectionResult<Row extends PendingQueueRow> {
  total: number;
  offset: number;
  limit: number;
  rows: readonly Row[];
}

export interface PendingQueueResult {
  /**
   * A discriminating literal: this type is only produced when a local memory store IS wired. The
   * not-wired shape (`{ configured: false }`) is a separate union member, so a caller can narrow
   * with `if (!result.configured)` — the same law as the ledger's configured shape.
   */
  configured: true;
  counts: {
    captures: number;
    staged: number;
    ready: number;
    terminal: number;
    blocked: number;
  };
  /** present when `section` is `captures` or unset. */
  captures?: PendingSectionResult<PendingCaptureRow>;
  /** present when `section` is `staged` or unset. */
  staged?: PendingSectionResult<PendingStagedRow>;
}

export interface PendingQueueOpts {
  section?: PendingSection;
  offset?: number;
  limit?: number;
}

const problemText = (p: AdmissibilityProblem): string => p.problem;

/** Evidence, display-shaped — verdicts are the item's own stamps; admissibility is re-derived here. */
function evidenceViews(
  kind: MemoryRecordKind,
  evidence: readonly MemoryEvidence[],
): PendingEvidenceView[] {
  return evidence.map((ev) => ({
    kind: isEvidenceKind(ev.kind) ? ev.kind : String(ev.kind),
    verdict: ev.verdict,
    admissible: isEvidenceKind(ev.kind) && admissibleFor(ev.kind, kind),
    browserSupported:
      isEvidenceKind(ev.kind) && admissibleFor(ev.kind, kind) && browserSupportsEvidence(ev),
    ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
  }));
}

/**
 * Classify one staged claim for browser admission.
 *
 * Structural problems come from the evaluator's own {@link admissibilityProblems} (admission-time,
 * `staged: false`) — with two deliberate reinterpretations, both honest:
 *
 *  1. The human-attestation tty/actor/attestedAt missing-field trio is NOT a blocker — it is the
 *     terminal-only marker itself: those fields are minted only by a CLI call site that checked
 *     `process.stdin.isTTY`. Such a claim classifies `terminal`, pointing at `crib memory admit`.
 *  2. A `kind not admissible for claim kind` problem is not a blocker either — the evaluator
 *     IGNORES such items at admission (they neither count nor invalidate); the evidence view shows
 *     them with `admissible: false` instead.
 *
 * The pitfall cross-item combo rule (receipt-pair alone, or source-quote + human-attestation
 * together) is NOT covered by the per-item {@link admissibilityProblems} — it is encoded here so
 * `ready` can never disagree with the gate.
 */
export function classifyStaged(candidate: MemoryCandidate): PendingStagedRow {
  const admission = admissibilityProblems(candidate.kind, candidate.evidence, { staged: false });
  const structural = admission.filter(
    (p) =>
      !p.problem.includes("of kind 'human-attestation' is missing required field") &&
      !p.problem.includes('is not admissible for a'),
  );
  const views = evidenceViews(candidate.kind, candidate.evidence);
  const stamped = (kind: string) => views.some((v) => v.kind === kind && v.browserSupported);
  const ignoredInadmissible = views.filter((v) => !v.admissible).length;

  let browserSupported = views.some((v) => v.browserSupported);
  let terminalEligible =
    !browserSupported &&
    views.some((v) => v.admissible && v.kind === 'human-attestation' && !v.browserSupported);

  // Pitfall combo: receipt-pair alone, or source-quote + attestation together (a reproduction).
  // The attestation in a READY reproduction must itself be terminal-stamped — an unstamped one
  // still needs the terminal step, so such a claim is `terminal`, never browser-ready.
  if (candidate.kind === 'pitfall') {
    const pair = stamped('receipt-pair');
    const quote = stamped('source-quote');
    const stampedAttestation = views.some(
      (v) => v.kind === 'human-attestation' && v.browserSupported,
    );
    const unstampedAttestation = views.some(
      (v) => v.kind === 'human-attestation' && v.admissible && !v.browserSupported,
    );
    browserSupported = pair || (quote && stampedAttestation);
    terminalEligible = !browserSupported && quote && unstampedAttestation;
  }

  const blockers: string[] = structural.map(problemText);
  if (candidate.evidence.length === 0) {
    blockers.push('no evidence attached — distill the capture or attach evidence before admission');
  }
  if (
    candidate.kind === 'pitfall' &&
    !browserSupported &&
    !terminalEligible &&
    structural.length === 0
  ) {
    blockers.push(
      'a pitfall claim needs a receipt-pair, or a source-quote together with a human confirmation',
    );
  }
  const notes: string[] = [];
  if (ignoredInadmissible > 0) {
    notes.push(
      `${ignoredInadmissible} evidence item(s) will be ignored (wrong kind for this claim)`,
    );
  }

  let standing: PendingStagedRow['standing'];
  if (structural.length > 0 || (!browserSupported && !terminalEligible)) {
    standing = 'blocked';
  } else if (browserSupported) {
    standing = 'ready';
  } else {
    standing = 'terminal';
  }
  const command =
    standing === 'terminal'
      ? TERMINAL_ADMIT_COMMAND.replace('<id>', candidate.id)
      : EVALUATE_COMMAND.replace('<id>', candidate.id);
  return {
    id: candidate.id,
    kind: candidate.kind,
    subject: candidate.subject,
    claim: capClaim(candidate.claim),
    scope: candidate.scope,
    appliesTo: candidate.appliesTo,
    origin: candidate.origin,
    proposedAt: candidate.proposedAt,
    evidence: views,
    ...(typeof candidate.meta?.anchorStatus === 'string'
      ? { anchorStatus: candidate.meta.anchorStatus as string }
      : {}),
    section: 'staged',
    standing,
    blockers,
    notes,
    browserAdmissible: standing === 'ready',
    command,
  };
}

const baseRow = (entry: CaptureOutboxEntry): PendingQueueRow => ({
  id: entry.id,
  kind: entry.kind,
  subject: entry.subject,
  claim: capClaim(entry.claim),
  scope: entry.scope,
  appliesTo: entry.appliesTo,
  origin: entry.origin,
  proposedAt: entry.proposedAt,
  evidence: evidenceViews(entry.kind, entry.evidence),
  ...(typeof entry.meta?.anchorStatus === 'string'
    ? { anchorStatus: entry.meta.anchorStatus as string }
    : {}),
});

function page<T>(rows: readonly T[], offset: number, limit: number): { total: number; slice: T[] } {
  return { total: rows.length, slice: rows.slice(offset, offset + limit) };
}

/**
 * Project the pending queue from the local store: raw captures (outbox) + staged claims
 * (candidates), each classified through the evaluator's own admission pre-flight.
 */
export function projectPendingQueue(
  local: MemoryStore,
  opts: PendingQueueOpts = {},
): PendingQueueResult {
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  const limit = Math.min(
    MAX_PENDING_PAGE,
    Math.max(1, Math.trunc(opts.limit ?? DEFAULT_PENDING_PAGE)),
  );

  const captureEntries = pendingCaptures(local);
  const captureRows: PendingCaptureRow[] = captureEntries
    .map((entry) => ({
      ...baseRow(entry),
      section: 'captures' as const,
      command: 'crib memory distill --provider <name>',
    }))
    .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt) || a.id.localeCompare(b.id));

  const stagedRows: PendingStagedRow[] = (
    local.readCollection('candidates').entries as MemoryCandidate[]
  )
    .map(classifyStaged)
    .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt) || a.id.localeCompare(b.id));

  const counts = {
    captures: captureRows.length,
    staged: stagedRows.length,
    ready: stagedRows.filter((r) => r.standing === 'ready').length,
    terminal: stagedRows.filter((r) => r.standing === 'terminal').length,
    blocked: stagedRows.filter((r) => r.standing === 'blocked').length,
  };

  const wantCaptures = opts.section !== 'staged';
  const wantStaged = opts.section !== 'captures';
  const capturePage = page(captureRows, offset, limit);
  const stagedPage = page(stagedRows, offset, limit);
  return {
    configured: true,
    counts,
    ...(wantCaptures
      ? {
          captures: {
            total: capturePage.total,
            offset,
            limit,
            rows: capturePage.slice,
          },
        }
      : {}),
    ...(wantStaged
      ? {
          staged: {
            total: stagedPage.total,
            offset,
            limit,
            rows: stagedPage.slice,
          },
        }
      : {}),
  };
}
