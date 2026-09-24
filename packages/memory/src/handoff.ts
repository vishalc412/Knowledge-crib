/**
 * Session handoff — the "where was I?" projection.
 *
 * Recall answers a QUESTION. Handoff answers the question a returning agent cannot yet phrase:
 * *what was being done here, what is unfinished, and what stopped being true while I was away.*
 * A new context window, a different IDE, a different agent, or the same agent tomorrow all start
 * from the same call and get the same picture — that is the whole point of a shared memory
 * substrate, and it is the one thing a conversation-scoped memory cannot do, because it has no
 * ground truth to diff against.
 *
 * Four inputs, each already modeled elsewhere — this module composes, it does not invent:
 *   - **openWork** — attempts with events but no terminal `promotion`/`outcome`. `attempt.ts`
 *     already models the lifecycle; an attempt that started and never finished IS the leftover item.
 *   - **pendingCaptures** — the durable outbox: raw observations captured but not yet distilled
 *     into claims. These are the things the last session saw but never wrote down properly.
 *   - **needsAttention** — records whose EFFECTIVE verdict is no longer `valid`/`current`. This is
 *     the differentiator: the code moved, so a claim that used to hold is now degraded or orphaned,
 *     and the returning agent is told BEFORE it acts on a stale belief.
 *   - **recent** — the newest still-good claims, so intent and conventions carry across the gap.
 *
 * PURE over its inputs: no IO, no clock beyond the supplied `now`, no store handles. `MemoryApi`
 * supplies the reads. Determinism matters here for the same reason it does in recall — the response
 * feeds an `ifHash` projection, so two handoffs over identical state must be byte-identical.
 */
import type { AttemptPhase, Verdicts } from './enums.js';
import type { ItemReason } from './evaluator.js';
import {
  type ContinuationChoice,
  type IntakeProjection,
  buildContinuation,
  projectIntakes,
} from './intake-projection.js';
import { DEFAULT_MIGRATION_PRINCIPAL_ID } from './migrations.js';
import type {
  IntakeCheckpoint,
  IntakePhase,
  IntakeRequirement,
  MemoryRecord,
  MemoryRecordVersioned,
} from './types.js';
import { isMemoryRecordVersioned } from './types.js';

/** An attempt that started and never reached a terminal phase — the literal leftover item. */
export interface HandoffOpenWork {
  attemptId: string;
  /** the soul id / topic the attempt was about, from the newest event that named one. */
  subject?: string;
  lastPhase: AttemptPhase;
  lastActivity: string;
  /** newest structured observation/action text, trimmed — the "what I was doing" line. */
  observation?: string;
  action?: string;
}

/** A raw capture the last session made but never distilled into a claim. */
export interface HandoffPendingCapture {
  id: string;
  subject: string;
  observation: string;
}

/** A claim that stopped holding while the session was away. */
export interface HandoffAttention {
  id: string;
  subject: string;
  claim: string;
  /** why it needs attention: the non-current axis, in verdict terms. */
  evidence: Verdicts['evidence'];
  applicability: Verdicts['applicability'];
  /**
   * WP5 §7.1 — WHY it stopped holding, in the evaluator's own vocabulary ({@link ItemReason}):
   * which evidence item failed, how, and with what consequence. `evidence`/`applicability` say
   * THAT the claim is no longer current; this says what moved.
   *
   * Empty is a real state, not a missing one: it means the handoff was read WITHOUT revalidating
   * (`HandoffOpts.revalidate`), so the axes are the verdicts stamped on the record rather than
   * recomputed against the tree. A caller that renders this must render the distinction — an empty
   * reason list beside a degraded axis is "not revalidated", never "no reason to be degraded".
   *
   * This is the field the Home view needs and the axes alone could not supply: `needsAttention` is
   * where an operator asks "why is this here", and before this landed the answer was a verdict with
   * no account of itself.
   */
  reasons: readonly ItemReason[];
}

/**
 * A still-good claim worth carrying across the gap.
 *
 * Deliberately carries NO `reasons`, and that is a proof rather than an omission. A record reaches
 * this list only when `degraded` is false — `evidence === 'valid'` AND `applicability === 'current'`.
 * `aggregateEvidence` returns `valid` only when every counted item is `valid` (a single `degraded`
 * or `invalid` item forces the aggregate down), and every return site that yields
 * `evidence: 'valid'` yields `reason: 'ok'` — so {@link ItemReason} collection, which skips `ok` and
 * `ignored`, is empty by construction. A `reasons` field here would be permanently `[]`: not a
 * missing explanation but a structurally impossible one, and an always-empty field reads as a bug
 * to every future maintainer. The `needsAttention` row is the one that has something to explain.
 */
export interface HandoffRecent {
  id: string;
  kind: string;
  subject: string;
  claim: string;
  createdAt: string;
}

/**
 * Where the previous session physically was, reconstructed from lifecycle events alone.
 *
 * This exists for the case the rest of handoff cannot serve: an IDE session that TIMED OUT. Every
 * other signal here — intakes, checkpoints, captures — requires the agent to have written something
 * before it stopped, and an agent whose session was killed had no chance to. The lifecycle hook
 * records the repository anchor on every turn without the agent's involvement, so this survives a
 * timeout, a crash, or a closed laptop.
 *
 * It is deliberately NOT a substitute for an intake checkpoint: it says where you were, never what
 * you were trying to do. A checkpoint carries intent; this carries coordinates.
 */
export interface HandoffLastSession {
  /** The client-supplied session id, when the hook received one. */
  sessionId?: string;
  clientId?: string;
  /** ISO timestamp of the last lifecycle event from that session. */
  lastActivity: string;
  /** Which lifecycle event it was (`turn-end`, `session-start`, `tool-use`). */
  event?: string;
  branch?: string;
  head?: string;
  /** Files that were modified but uncommitted when the session ended (bounded by the hook). */
  changedPaths: string[];
  /** True when this session ended on a DIFFERENT branch/HEAD than the repository is on now. */
  movedSince: boolean;
  /**
   * Present when the hook recorded MORE than twenty changed paths and the list was cut. Without it,
   * a bounded list is indistinguishable from a complete one — a returning agent would trust an
   * inventory that is actually a sample (WP3.7).
   */
  changedPathsTruncated?: true;
  /**
   * A short, human-readable answer to "what was that session about" — the progress note that was
   * CURRENT when the session ended, i.e. the newest intake checkpoint recorded at or before
   * {@link lastActivity}.
   *
   * Deliberately NOT claimed to be authored by that session. Checkpoints carry `recordedAt` but no
   * session id, so a link cannot be proven, and inventing one would put a confident wrong label on
   * the most-read line in the memory home. "The note that was current when this session ended" is
   * exactly true whichever session wrote it, and is the thing an operator actually wants.
   *
   * Absent when no checkpoint predates the session — a repository whose work was never checkpointed
   * has nothing to summarize, and an empty string would read like a missing value rather than an
   * absent one.
   */
  summary?: string;
  /** Which intake that summary came from, so a reader can open the full work item. */
  summaryIntakeId?: string;
  /** The phase that note was recorded at (`executing`, `blocked`, `verifying`, …). */
  summaryPhase?: IntakePhase;
  /** ISO timestamp of that note, so a stale summary is visibly stale rather than silently old. */
  summaryRecordedAt?: string;
}

export interface HandoffResponse {
  openWork: HandoffOpenWork[];
  pendingCaptures: HandoffPendingCapture[];
  needsAttention: HandoffAttention[];
  recent: HandoffRecent[];
  intakes: IntakeProjection;
  /**
   * The previous session's coordinates, when a lifecycle hook recorded any. Absent when no hook is
   * installed — reported as absence rather than invented, so "no hook" and "no prior work" stay
   * distinguishable.
   */
  lastSession?: HandoffLastSession;
  /**
   * The explicit continue-or-start-fresh decision for this session. Derived from `intakes`, so it
   * never disagrees with it — but stated as named options a caller can choose between, rather than
   * a `primary` field whose absence the caller has to interpret.
   */
  continuation: ContinuationChoice;
  /**
   * Explicit degraded-state markers (WP3.8) — reported rather than swallowed, so "the journal could
   * not be read" is never mistaken for "no previous work existed". Absent capabilities stay absent;
   * failed reads say WHY here.
   */
  degraded: string[];
  counts: {
    openWork: number;
    pendingCaptures: number;
    needsAttention: number;
    active: number;
  };
}

/** A flat attempt event, structurally typed so this module does not depend on the store's shape. */
export interface HandoffAttemptEvent {
  attemptId: string;
  phase: AttemptPhase;
  subject?: string;
  ts: string;
  observation?: { summary?: string } | undefined;
  action?: { summary?: string } | undefined;
}

export interface HandoffInput {
  attempts: readonly HandoffAttemptEvent[];
  /** Durable-outbox rows. The captured text lives on `claim` — the field a CaptureOutboxEntry
   *  actually carries; `observation` is accepted too so either shape may be passed. */
  pending: readonly { id: string; subject?: string; claim?: string; observation?: string }[];
  /**
   * every gathered record paired with its EFFECTIVE verdicts (post decision + freshness overlay).
   *
   * `reasons` is optional HERE and required on {@link HandoffAttention} because the two answer
   * different questions. Most callers hold a plain `Verdicts` and have not revalidated anything, so
   * demanding `reasons` would force every one of them to invent an empty list; a caller that DID
   * revalidate (`MemoryApi.handoff` with `revalidate`) has an `EffectiveVerdicts` and carries the
   * reasons through untouched. Absent on the way in therefore means "not revalidated", which the
   * row reports as `[]` rather than guessing.
   */
  records: readonly {
    record: MemoryRecord | MemoryRecordVersioned;
    verdicts: Verdicts & { reasons?: readonly ItemReason[] };
  }[];
  intakeRequirements?: readonly IntakeRequirement[];
  intakeCheckpoints?: readonly IntakeCheckpoint[];
  repository?: IntakeCheckpoint['repository'];
  /**
   * Lifecycle events the hook recorded, newest-last. Structurally typed so this module stays
   * independent of the journal's shape — handoff reads coordinates, not the event schema.
   */
  lifecycle?: readonly {
    /** content-addressed event identity — the final tie-break for equal timestamps (WP3.4). */
    id?: string;
    occurredAt: string;
    source?: { clientId?: string; sessionId?: string };
    identity?: { principalId?: string };
    payload?: Record<string, unknown>;
  }[];
  /**
   * Server-resolved caller identity — REQUIRED (WP3.2). Session provenance is never an
   * authorization credential, and a handoff without a trusted principal used to fall back to
   * showing EVERY lifecycle event in the journal. The projection now refuses to run without one:
   * callers reach here through `MemoryApi.handoff`, which resolves the principal from the hosting
   * process (`KCRIB_PRINCIPAL_ID`, else the default migration principal) — never from a request.
   */
  callerPrincipal: string;
  /** The server process requesting handoff; its activity is not a prior session to resume. */
  currentSessionId?: string;
  /**
   * Set when the lifecycle journal EXISTS but could not be read (WP3.8). Reported through
   * `degraded` instead of silently reading as "no previous work existed".
   */
  lifecycleUnreadable?: boolean;
  limits?: { openWork?: number; pending?: number; attention?: number; recent?: number };
  /** The current time — when present, unfinished intakes idle past the threshold are marked stale. */
  now?: string;
}

/**
 * Reconstruct the previous session's coordinates from the newest lifecycle event carrying a
 * repository anchor.
 *
 * Newest-with-an-anchor rather than simply newest: a hook installed before this field existed still
 * appends events, and picking the newest unconditionally would report a session with no coordinates
 * and look like the feature is broken. Skipping to the newest event that HAS an anchor degrades to
 * older-but-useful instead of newer-but-empty.
 *
 * The selection is a total order, not a scan (WP3.4): newest `occurredAt` first — the journal's
 * newest-last clock — with equal timestamps broken by event identity (`id`, content-addressed, so
 * it is stable whichever order a caller passes the same events in) and journal position as the
 * final fallback for a duplicated event id. The same journal therefore yields the same
 * `lastSession` whichever order events were appended in.
 */
const LAST_SESSION_PATHS_MAX = 20;

/**
 * The progress note that was current when `lastActivity` happened.
 *
 * Newest checkpoint with `recordedAt <= lastActivity`. Ties break on the checkpoint id so the choice
 * is deterministic — two notes at the same instant must not produce a different summary per call,
 * because the memory home is compared across reloads.
 */
function progressNoteAt(
  checkpoints: readonly IntakeCheckpoint[] | undefined,
  lastActivity: string,
): IntakeCheckpoint | undefined {
  if (!checkpoints || checkpoints.length === 0) return undefined;
  let best: IntakeCheckpoint | undefined;
  for (const cp of checkpoints) {
    if (typeof cp?.recordedAt !== 'string' || cp.recordedAt > lastActivity) continue;
    if (best === undefined) {
      best = cp;
      continue;
    }
    if (cp.recordedAt > best.recordedAt) best = cp;
    else if (cp.recordedAt === best.recordedAt && (cp.id ?? '') > (best.id ?? '')) best = cp;
  }
  return best;
}

function lastSessionOf(
  lifecycle: HandoffInput['lifecycle'],
  now: IntakeCheckpoint['repository'] | undefined,
  callerPrincipal: string,
  currentSessionId: string | undefined,
): HandoffLastSession | undefined {
  if (!lifecycle || lifecycle.length === 0) return undefined;
  type Candidate = { event: (typeof lifecycle)[number]; index: number };
  const isNewer = (a: Candidate, b: Candidate): boolean => {
    if (a.event.occurredAt !== b.event.occurredAt) return a.event.occurredAt > b.event.occurredAt;
    if ((a.event.id ?? '') !== (b.event.id ?? '')) return (a.event.id ?? '') > (b.event.id ?? '');
    return a.index > b.index;
  };
  let selected: Candidate | undefined;
  for (let i = 0; i < lifecycle.length; i += 1) {
    const event = lifecycle[i]!;
    if (currentSessionId !== undefined && event.source?.sessionId === currentSessionId) continue;
    const eventPrincipal = event.identity?.principalId;
    // Events created before identity existed belong only to the original local-only namespace.
    // Showing one to an arbitrary later principal would turn backwards compatibility into a leak.
    if (
      eventPrincipal === undefined
        ? callerPrincipal !== DEFAULT_MIGRATION_PRINCIPAL_ID
        : eventPrincipal !== callerPrincipal
    )
      continue;
    const repo = event.payload?.repository as
      | { branch?: string; head?: string; changedPaths?: string[] }
      | undefined;
    if (!repo || (repo.branch === undefined && repo.head === undefined)) continue;
    const candidate: Candidate = { event, index: i };
    if (selected === undefined || isNewer(candidate, selected)) selected = candidate;
  }
  if (selected === undefined) return undefined;
  const { event } = selected;
  const repo = event.payload!.repository as {
    branch?: string;
    head?: string;
    changedPaths?: string[];
  };
  const eventName = typeof event.payload?.event === 'string' ? event.payload.event : undefined;
  // "Moved since" is the question a returning agent actually needs answered before it trusts
  // these coordinates: resuming against a branch you have since left is worse than not resuming.
  const movedSince =
    now !== undefined &&
    ((now.head !== undefined && repo.head !== undefined && now.head !== repo.head) ||
      (now.branch !== undefined && repo.branch !== undefined && now.branch !== repo.branch));
  const changed = Array.isArray(repo.changedPaths)
    ? repo.changedPaths.filter((path): path is string => typeof path === 'string')
    : [];
  return {
    ...(event.source?.sessionId !== undefined ? { sessionId: event.source.sessionId } : {}),
    ...(event.source?.clientId !== undefined ? { clientId: event.source.clientId } : {}),
    lastActivity: event.occurredAt,
    ...(eventName !== undefined ? { event: eventName } : {}),
    ...(repo.branch !== undefined ? { branch: repo.branch } : {}),
    ...(repo.head !== undefined ? { head: repo.head } : {}),
    changedPaths: changed.slice(0, LAST_SESSION_PATHS_MAX),
    ...(changed.length > LAST_SESSION_PATHS_MAX ? { changedPathsTruncated: true } : {}),
    movedSince,
  };
}

const DEFAULTS = { openWork: 10, pending: 10, attention: 10, recent: 10 } as const;
/** Terminal phases — an attempt that reached one is finished work, not a leftover. */
const TERMINAL_PHASES: ReadonlySet<AttemptPhase> = new Set<AttemptPhase>([
  'promotion',
  'compaction',
]);
/** Keep summaries short: a handoff is a briefing, not a transcript (raw-transcripts-off law). */
const SUMMARY_MAX = 240;

function trim(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/** Newest-first by timestamp, id as the stable tiebreak (determinism, never the clock). */
function byNewest(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  if (a.ts !== b.ts) return b.ts.localeCompare(a.ts);
  return a.id.localeCompare(b.id);
}

const CARRY_OVER_NOTES_MAX = 3;

/**
 * Put the previous session's context into the continuation itself. Agents are told to read the
 * continuation first and follow it, and it is derived from intakes alone — so a session that left
 * coordinates and notes but no intake (the Claude hooks path, read later from another IDE) was
 * announced as "No unfinished work is saved", and the next agent started from zero.
 */
function withCarryOver(
  continuation: ContinuationChoice,
  lastSession: HandoffLastSession | undefined,
  pendingCaptures: readonly HandoffPendingCapture[],
  counts: { pending: number; recent: number },
): ContinuationChoice {
  const carryOver: string[] = [];
  if (lastSession !== undefined) {
    const who = lastSession.clientId ? ` (${lastSession.clientId})` : '';
    const where = lastSession.branch ? ` on branch ${lastSession.branch}` : '';
    const moved = lastSession.movedSince ? ' — the repository has moved since' : '';
    carryOver.push(
      `Previous session${who} last active ${lastSession.lastActivity}${where}${moved}.`,
    );
    if (lastSession.summary) carryOver.push(`Progress note then: ${lastSession.summary}`);
    if (lastSession.changedPaths.length > 0) {
      const more = lastSession.changedPathsTruncated ? ', …' : '';
      carryOver.push(`It was editing: ${lastSession.changedPaths.join(', ')}${more}`);
    }
  }
  for (const capture of pendingCaptures.slice(0, CARRY_OVER_NOTES_MAX)) {
    if (capture.observation) carryOver.push(`Note (not yet verified): ${capture.observation}`);
  }
  if (counts.pending > CARRY_OVER_NOTES_MAX) {
    carryOver.push(
      `${counts.pending - CARRY_OVER_NOTES_MAX} more note(s) in pendingCaptures; ${counts.recent} verified claim(s) in recent.`,
    );
  }
  if (carryOver.length === 0) return continuation;
  const resumable = continuation.options.some((option) => option.kind === 'resume');
  if (resumable) return { ...continuation, carryOver };
  return {
    ...continuation,
    question:
      'No intake is open, but the previous session left context (see carryOver). Continue from it, or start fresh?',
    rationale:
      'no intake is resumable, so "fresh" is the default option — but read carryOver, lastSession, pendingCaptures and recent first and carry that context forward; do not treat this project as having no memory',
    carryOver,
  };
}

/**
 * Build the handoff projection. PURE.
 *
 * `needsAttention` deliberately surfaces records that normal recall SUPPRESSES: a degraded or
 * orphaned claim is excluded from ranking precisely because it should not be acted on, but a
 * returning agent still needs to know it went bad — otherwise the claim simply vanishes and the
 * agent silently loses context it had last session. Suppressed-from-recall is not the same as
 * irrelevant-to-a-human.
 */
export function buildHandoff(input: HandoffInput): HandoffResponse {
  // WP3.2 — fail closed. A missing principal used to mean "show every lifecycle event in the
  // journal"; the type makes it a compile error, and this guard makes it a runtime error for
  // callers that bypass types. Refusing is the honest behavior: there is no defensible
  // unauthenticated view of another session's coordinates.
  if (typeof input.callerPrincipal !== 'string' || input.callerPrincipal.trim().length === 0) {
    throw new Error(
      'buildHandoff requires a server-resolved callerPrincipal — refusing to project lifecycle events without one',
    );
  }
  const limits = { ...DEFAULTS, ...(input.limits ?? {}) };

  // ── legacy ownership (WP3.5): attempts and pending captures are memory-1 records with no
  // principal column, so they belong to the default migration principal's namespace. A caller
  // with any other principal sees none of them — filtered BEFORE the fold, so counts and
  // previews never contain another principal's work either (WP3.3).
  const unscopedVisible = input.callerPrincipal === DEFAULT_MIGRATION_PRINCIPAL_ID;
  const attempts = unscopedVisible ? input.attempts : [];
  const pending = unscopedVisible ? input.pending : [];

  // ── open work: fold events per attempt, drop the ones that reached a terminal phase ──
  const byAttempt = new Map<string, HandoffOpenWork & { terminal: boolean }>();
  for (const event of attempts) {
    const existing = byAttempt.get(event.attemptId);
    const terminal = (existing?.terminal ?? false) || TERMINAL_PHASES.has(event.phase);
    // fold newest-wins for the descriptive fields, but `terminal` is sticky across every event
    if (existing === undefined || event.ts > existing.lastActivity) {
      byAttempt.set(event.attemptId, {
        attemptId: event.attemptId,
        ...(event.subject !== undefined ? { subject: event.subject } : {}),
        lastPhase: event.phase,
        lastActivity: event.ts,
        ...(trim(event.observation?.summary) !== undefined
          ? { observation: trim(event.observation?.summary) }
          : {}),
        ...(trim(event.action?.summary) !== undefined
          ? { action: trim(event.action?.summary) }
          : {}),
        terminal,
      });
    } else if (terminal !== existing.terminal) {
      byAttempt.set(event.attemptId, { ...existing, terminal });
    }
  }
  const openWorkAll = [...byAttempt.values()]
    .filter((a) => !a.terminal)
    .sort((a, b) =>
      byNewest({ ts: a.lastActivity, id: a.attemptId }, { ts: b.lastActivity, id: b.attemptId }),
    );
  const openWork: HandoffOpenWork[] = openWorkAll.slice(0, limits.openWork).map((a) => {
    const { terminal: _terminal, ...rest } = a;
    return rest;
  });

  // ── pending captures: raw observations the last session never distilled ──
  const pendingAll = [...pending].sort((a, b) => a.id.localeCompare(b.id));
  const pendingCaptures: HandoffPendingCapture[] = pendingAll.slice(0, limits.pending).map((p) => ({
    id: p.id,
    subject: p.subject ?? '',
    // `claim` FIRST: that is the field a CaptureOutboxEntry actually carries. Reading only
    // `observation` rendered every pending capture with an empty line — caught by running this
    // against the repo's own ledger, not by a test.
    observation: trim(p.claim ?? p.observation) ?? '',
  }));

  // ── needs attention + recent, from the same verdict-tagged pool ──
  const attentionAll: Array<HandoffAttention & { ts: string }> = [];
  const recentAll: Array<HandoffRecent & { ts: string }> = [];
  let active = 0;
  for (const { record, verdicts } of input.records) {
    const createdAt = isMemoryRecordVersioned(record)
      ? record.transactionTime.recordedAt
      : record.createdAt;
    const degraded = verdicts.evidence !== 'valid' || verdicts.applicability !== 'current';
    // a retired record is not "attention" — it was deliberately retired, not silently broken
    const retired = verdicts.lifecycle !== 'active';
    if (retired) continue;
    if (degraded) {
      attentionAll.push({
        id: record.id,
        subject: record.subject,
        claim: record.claim,
        evidence: verdicts.evidence,
        applicability: verdicts.applicability,
        // Absent ⇒ this handoff was read without revalidating. `[]` is the honest report of that:
        // the axes above are the record's STAMP, and a stale stamp has no reason to show for itself.
        reasons: verdicts.reasons ?? [],
        ts: createdAt,
      });
      continue;
    }
    active += 1;
    recentAll.push({
      id: record.id,
      kind: record.kind,
      subject: record.subject,
      claim: record.claim,
      createdAt,
      ts: createdAt,
    });
  }
  attentionAll.sort(byNewest);
  recentAll.sort(byNewest);

  const needsAttention: HandoffAttention[] = attentionAll
    .slice(0, limits.attention)
    .map(({ ts: _ts, ...rest }) => rest);
  const recent: HandoffRecent[] = recentAll
    .slice(0, limits.recent)
    .map(({ ts: _ts, ...rest }) => rest);
  const intakes = projectIntakes(
    input.intakeRequirements ?? [],
    input.intakeCheckpoints ?? [],
    input.repository ?? { dirty: false },
    input.now !== undefined ? { now: input.now } : {},
  );

  const lastSession = lastSessionOf(
    input.lifecycle,
    input.repository,
    input.callerPrincipal,
    input.currentSessionId,
  );
  // Attach the progress note that was current when that session ended. Done HERE rather than inside
  // `lastSessionOf` so that function keeps its single job — reconstructing coordinates from the
  // lifecycle journal — and the checkpoint correlation stays visibly separate from it.
  if (lastSession !== undefined) {
    const note = progressNoteAt(input.intakeCheckpoints, lastSession.lastActivity);
    if (note?.summary) {
      lastSession.summary = note.summary;
      lastSession.summaryIntakeId = note.intakeId;
      lastSession.summaryPhase = note.phase;
      lastSession.summaryRecordedAt = note.recordedAt;
    }
  }

  return {
    openWork,
    pendingCaptures,
    needsAttention,
    recent,
    intakes,
    continuation: withCarryOver(buildContinuation(intakes), lastSession, pendingCaptures, {
      pending: pendingAll.length,
      recent: active,
    }),
    ...(lastSession ? { lastSession } : {}),
    degraded: input.lifecycleUnreadable === true ? ['lifecycle-journal-unreadable'] : [],
    counts: {
      openWork: openWorkAll.length,
      pendingCaptures: pendingAll.length,
      needsAttention: attentionAll.length,
      active,
    },
  };
}
