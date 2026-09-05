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
import {
  type ContinuationChoice,
  type IntakeProjection,
  buildContinuation,
  projectIntakes,
} from './intake-projection.js';
import type {
  IntakeCheckpoint,
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
}

/** A still-good claim worth carrying across the gap. */
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
  /** every gathered record paired with its EFFECTIVE verdicts (post decision + freshness overlay). */
  records: readonly { record: MemoryRecord | MemoryRecordVersioned; verdicts: Verdicts }[];
  intakeRequirements?: readonly IntakeRequirement[];
  intakeCheckpoints?: readonly IntakeCheckpoint[];
  repository?: IntakeCheckpoint['repository'];
  /**
   * Lifecycle events the hook recorded, newest-last. Structurally typed so this module stays
   * independent of the journal's shape — handoff reads coordinates, not the event schema.
   */
  lifecycle?: readonly {
    occurredAt: string;
    source?: { clientId?: string; sessionId?: string };
    payload?: Record<string, unknown>;
  }[];
  limits?: { openWork?: number; pending?: number; attention?: number; recent?: number };
}

/**
 * Reconstruct the previous session's coordinates from the newest lifecycle event carrying a
 * repository anchor.
 *
 * Newest-with-an-anchor rather than simply newest: a hook installed before this field existed still
 * appends events, and picking the newest unconditionally would report a session with no coordinates
 * and look like the feature is broken. Skipping to the newest event that HAS an anchor degrades to
 * older-but-useful instead of newer-but-empty.
 */
function lastSessionOf(
  lifecycle: HandoffInput['lifecycle'],
  now: IntakeCheckpoint['repository'] | undefined,
): HandoffLastSession | undefined {
  if (!lifecycle || lifecycle.length === 0) return undefined;
  for (let i = lifecycle.length - 1; i >= 0; i -= 1) {
    const event = lifecycle[i]!;
    const repo = event.payload?.repository as
      | { branch?: string; head?: string; changedPaths?: string[] }
      | undefined;
    if (!repo || (repo.branch === undefined && repo.head === undefined)) continue;
    const eventName = typeof event.payload?.event === 'string' ? event.payload.event : undefined;
    // "Moved since" is the question a returning agent actually needs answered before it trusts
    // these coordinates: resuming against a branch you have since left is worse than not resuming.
    const movedSince =
      now !== undefined &&
      ((now.head !== undefined && repo.head !== undefined && now.head !== repo.head) ||
        (now.branch !== undefined && repo.branch !== undefined && now.branch !== repo.branch));
    return {
      ...(event.source?.sessionId !== undefined ? { sessionId: event.source.sessionId } : {}),
      ...(event.source?.clientId !== undefined ? { clientId: event.source.clientId } : {}),
      lastActivity: event.occurredAt,
      ...(eventName !== undefined ? { event: eventName } : {}),
      ...(repo.branch !== undefined ? { branch: repo.branch } : {}),
      ...(repo.head !== undefined ? { head: repo.head } : {}),
      changedPaths: Array.isArray(repo.changedPaths) ? repo.changedPaths : [],
      movedSince,
    };
  }
  return undefined;
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
  const limits = { ...DEFAULTS, ...(input.limits ?? {}) };

  // ── open work: fold events per attempt, drop the ones that reached a terminal phase ──
  const byAttempt = new Map<string, HandoffOpenWork & { terminal: boolean }>();
  for (const event of input.attempts) {
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
  const pendingAll = [...input.pending].sort((a, b) => a.id.localeCompare(b.id));
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
  );

  const lastSession = lastSessionOf(input.lifecycle, input.repository);

  return {
    openWork,
    pendingCaptures,
    needsAttention,
    recent,
    intakes,
    continuation: buildContinuation(intakes),
    ...(lastSession ? { lastSession } : {}),
    counts: {
      openWork: openWorkAll.length,
      pendingCaptures: pendingAll.length,
      needsAttention: attentionAll.length,
      active,
    },
  };
}
