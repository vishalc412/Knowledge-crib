import type {
  IntakeAudience,
  IntakeCheckpoint,
  IntakePhase,
  IntakeRequirement,
  IntakeStatus,
} from './types.js';

export interface ResumeBrief {
  intakeId: string;
  original: string;
  interpretation: IntakeRequirement['interpretation'];
  phase: IntakePhase;
  status: IntakeStatus;
  nextSafeAction?: string;
  completedStepIds: string[];
  blockers: string[];
  audience: IntakeAudience;
  repositoryDrift: boolean;
  conflicts: Array<{ field: string; values: string[] }>;
  lastActivity: string;
  /** Present only when projected with a clock: whole days since the last recorded activity. */
  idleDays?: number;
  /**
   * Unfinished, but idle past the staleness threshold. Stale work is set apart from "work to
   * resume" so abandoned intakes stop crowding the continue prompt — and it is NEVER closed
   * automatically: only a person or agent completing or cancelling it retires it.
   */
  stale?: true;
}

/** Days without a checkpoint after which unfinished work is shown as stale rather than resumable. */
export const STALE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

export interface IntakeProjection {
  primary?: ResumeBrief;
  choices: ResumeBrief[];
  /** Every intake in the projection, finished ones included — the full history. */
  count: number;
  /**
   * Intakes that can actually be RESUMED — `completed` and `cancelled` excluded.
   *
   * Distinct from `count` because a surface that offers "work to resume" must not count work that
   * is done. The memory home read `count` and told the operator there were 3 things to resume when
   * some of them had been finished, which is the kind of wrong number that teaches people to
   * distrust every other number on the page.
   */
  resumableCount: number;
  /** Present only when projected with a clock: unfinished intakes idle past the threshold. */
  staleCount?: number;
}

function checkpointStatus(checkpoint: IntakeCheckpoint | undefined): IntakeStatus {
  if (!checkpoint) return 'draft';
  if (checkpoint.kind === 'completed') return 'completed';
  if (checkpoint.kind === 'cancelled') return 'cancelled';
  if (checkpoint.kind === 'blocked' || checkpoint.phase === 'blocked') return 'blocked';
  return 'active';
}

function repositoryDrifted(
  saved: IntakeCheckpoint['repository'] | undefined,
  current: IntakeCheckpoint['repository'],
): boolean {
  if (!saved) return false;
  if (saved.dirty !== current.dirty) return true;
  for (const field of ['head', 'branch', 'changedPathsDigest'] as const) {
    const before = saved[field];
    const now = current[field];
    if (before !== undefined && now !== undefined && before !== now) return true;
  }
  return false;
}

/** Fold immutable intake/checkpoint entries into the deterministic state shown to a new session. */
export function projectIntakes(
  requirements: readonly IntakeRequirement[],
  checkpoints: readonly IntakeCheckpoint[],
  repository: IntakeCheckpoint['repository'],
  /**
   * `now` turns on staleness. Without it the projection stays a pure function of the entries (no
   * wall clock), exactly as before — surfaces that show work to a person pass the current time.
   */
  opts: { now?: string; staleAfterDays?: number } = {},
): IntakeProjection {
  const nowMs = opts.now !== undefined ? Date.parse(opts.now) : Number.NaN;
  const staleAfterDays = opts.staleAfterDays ?? STALE_AFTER_DAYS;
  const staleness = (
    status: IntakeStatus,
    lastActivity: string,
  ): Pick<ResumeBrief, 'idleDays' | 'stale'> => {
    const since = Date.parse(lastActivity);
    if (Number.isNaN(nowMs) || Number.isNaN(since)) return {};
    const idleDays = Math.max(0, Math.floor((nowMs - since) / DAY_MS));
    const open = status !== 'completed' && status !== 'cancelled';
    return { idleDays, ...(open && idleDays >= staleAfterDays ? { stale: true as const } : {}) };
  };
  const uniqueRequirements = new Map(requirements.map((entry) => [entry.id, entry]));
  const byIntake = new Map<string, IntakeCheckpoint[]>();
  for (const checkpoint of checkpoints) {
    if (!uniqueRequirements.has(checkpoint.intakeId)) continue;
    const bucket = byIntake.get(checkpoint.intakeId);
    if (bucket) bucket.push(checkpoint);
    else byIntake.set(checkpoint.intakeId, [checkpoint]);
  }

  const choices = [...uniqueRequirements.values()].map((requirement): ResumeBrief => {
    const events = [...(byIntake.get(requirement.id) ?? [])].sort((a, b) => {
      if (a.recordedAt !== b.recordedAt) return a.recordedAt.localeCompare(b.recordedAt);
      return a.id.localeCompare(b.id);
    });
    const latest = events.at(-1);
    const terminalStatuses = new Set<IntakeStatus>();
    const completedStepIds = new Set<string>();
    const blockers = new Set<string>();
    for (const event of events) {
      if (event.kind === 'completed') terminalStatuses.add('completed');
      if (event.kind === 'cancelled') terminalStatuses.add('cancelled');
      for (const step of event.completedStepIds ?? []) completedStepIds.add(step);
      if (event.kind === 'blocked') blockers.add(event.summary);
    }
    const conflicts: ResumeBrief['conflicts'] = [];
    if (terminalStatuses.size > 1) {
      conflicts.push({ field: 'status', values: [...terminalStatuses].sort() });
    }
    const status = checkpointStatus(latest);
    const lastActivity = latest?.recordedAt ?? requirement.createdAt;
    return {
      intakeId: requirement.id,
      original: requirement.original,
      interpretation: requirement.interpretation,
      phase: latest?.phase ?? 'intake',
      status,
      ...(latest?.nextSafeAction ? { nextSafeAction: latest.nextSafeAction } : {}),
      completedStepIds: [...completedStepIds].sort(),
      blockers: [...blockers].sort(),
      audience: latest?.audience ?? 'private',
      repositoryDrift: repositoryDrifted(latest?.repository, repository),
      conflicts,
      lastActivity,
      ...staleness(status, lastActivity),
    };
  });

  choices.sort((a, b) => {
    if (a.lastActivity !== b.lastActivity) return b.lastActivity.localeCompare(a.lastActivity);
    return a.intakeId.localeCompare(b.intakeId);
  });
  const resumable = choices.filter(
    (choice) => choice.status !== 'completed' && choice.status !== 'cancelled' && !choice.stale,
  );
  return {
    ...(resumable.length === 1 ? { primary: resumable[0] } : {}),
    choices,
    count: choices.length,
    resumableCount: resumable.length,
    ...(Number.isNaN(nowMs) ? {} : { staleCount: choices.filter((c) => c.stale).length }),
  };
}

// ─── the continue-or-start-fresh decision ────────────────────────────────────

/** One selectable way to begin a session. `optionId` is stable so a caller can name its choice. */
export interface ContinuationOption {
  /** `resume:<intakeId>` or `fresh` — stable across sessions for the same intake. */
  optionId: string;
  kind: 'resume' | 'fresh';
  /** present on `resume` options only. */
  intakeId?: string;
  /** one line naming what this option does. */
  label: string;
  /** the concrete next step, when the intake recorded one. */
  detail?: string;
  /**
   * Why this option needs a deliberate look before it is taken: repository drift since the saved
   * checkpoint, recorded blockers, or conflicting fields. Never a reason to hide the option — a
   * caution is information, not a veto.
   */
  cautions: string[];
}

/**
 * The explicit choice a starting session is offered.
 *
 * Crib already computed which intakes were resumable, but it never offered "start fresh" as a
 * first-class option and gave no way to name a selection — so an agent had to infer the decision
 * from a `primary` field, and a session that legitimately wanted new work had no vocabulary for
 * saying so. Making both options explicit is the point: the caller chooses, rather than guessing
 * what the absence of a `primary` meant.
 *
 * `recommended` is deliberately sparse. It is set ONLY when exactly one intake is resumable and
 * nothing about it warrants a second look. Several resumable intakes produce no recommendation (the
 * protocol forbids inventing a primary), and neither does a lone intake carrying drift or blockers
 * — those are precisely the cases where continuing blindly is the wrong move.
 */
export interface ContinuationChoice {
  /** the question to put to the user or agent, already phrased for the current state. */
  question: string;
  options: ContinuationOption[];
  /** `optionId` of the default, when one is defensible. Absent means: choose deliberately. */
  recommended?: string;
  /** why there is, or is not, a recommendation — never a bare default. */
  rationale: string;
}

/** `fresh` is always offered: starting new work is a legitimate choice, not a fallback. */
const FRESH_OPTION: ContinuationOption = {
  optionId: 'fresh',
  kind: 'fresh',
  label: 'Start fresh — begin new work',
  detail: 'Any unfinished intake stays open and resumable; nothing is discarded.',
  cautions: [],
};

/**
 * Build the continue-or-start-fresh choice from an intake projection. PURE and deterministic: the
 * same projection always yields the same options in the same order.
 */
export function buildContinuation(projection: IntakeProjection): ContinuationChoice {
  const resumable = projection.choices.filter(
    (choice) => choice.status !== 'completed' && choice.status !== 'cancelled' && !choice.stale,
  );
  // Stale work is not offered as an option (continuing month-old work blindly is the wrong default),
  // but it is never hidden either: the rationale names it and how to close it.
  const staleCount = projection.choices.filter((choice) => choice.stale).length;
  const staleNote =
    staleCount > 0
      ? ` — ${staleCount} idle intake(s) set aside as stale; close them with \`crib intake complete <id>\` or \`crib intake cancel <id>\``
      : '';
  const options: ContinuationOption[] = resumable.map((choice) => {
    const cautions: string[] = [];
    if (choice.repositoryDrift) {
      cautions.push(
        'the repository moved since this checkpoint — re-check the plan against the current tree',
      );
    }
    for (const blocker of choice.blockers) cautions.push(`blocked: ${blocker}`);
    for (const conflict of choice.conflicts) {
      cautions.push(`conflicting ${conflict.field}: ${conflict.values.join(' | ')}`);
    }
    return {
      optionId: `resume:${choice.intakeId}`,
      kind: 'resume' as const,
      intakeId: choice.intakeId,
      label: `Continue — ${choice.interpretation.outcome}`,
      ...(choice.nextSafeAction ? { detail: choice.nextSafeAction } : {}),
      cautions,
    };
  });
  options.push(FRESH_OPTION);

  if (resumable.length === 0) {
    return {
      question:
        staleCount > 0
          ? 'No active work is saved — only stale work that went idle. Start fresh?'
          : 'No unfinished work is saved for this project. Start fresh?',
      options,
      recommended: 'fresh',
      rationale: `nothing is resumable, so there is nothing to continue${staleNote}`,
    };
  }
  if (resumable.length === 1) {
    const only = options[0]!;
    const clean = only.cautions.length === 0;
    return {
      question: 'Continue the unfinished work, or start fresh?',
      options,
      // A lone clean intake is a defensible default. One carrying drift or blockers is not: that is
      // exactly the state where resuming without looking produces work against a stale plan.
      ...(clean ? { recommended: only.optionId } : {}),
      rationale: `${
        clean
          ? 'exactly one intake is resumable and nothing about it needs re-checking'
          : 'one intake is resumable but needs a deliberate look first — see its cautions'
      }${staleNote}`,
    };
  }
  return {
    question: `${resumable.length} unfinished intakes are saved. Continue one, or start fresh?`,
    options,
    rationale: `several intakes are resumable, so no default is offered — naming the wrong one silently resumes the wrong work${staleNote}`,
  };
}
