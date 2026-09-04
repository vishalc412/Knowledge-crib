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
}

export interface IntakeProjection {
  primary?: ResumeBrief;
  choices: ResumeBrief[];
  count: number;
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
): IntakeProjection {
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
    return {
      intakeId: requirement.id,
      original: requirement.original,
      interpretation: requirement.interpretation,
      phase: latest?.phase ?? 'intake',
      status: checkpointStatus(latest),
      ...(latest?.nextSafeAction ? { nextSafeAction: latest.nextSafeAction } : {}),
      completedStepIds: [...completedStepIds].sort(),
      blockers: [...blockers].sort(),
      audience: latest?.audience ?? 'private',
      repositoryDrift: repositoryDrifted(latest?.repository, repository),
      conflicts,
      lastActivity: latest?.recordedAt ?? requirement.createdAt,
    };
  });

  choices.sort((a, b) => {
    if (a.lastActivity !== b.lastActivity) return b.lastActivity.localeCompare(a.lastActivity);
    return a.intakeId.localeCompare(b.intakeId);
  });
  const resumable = choices.filter(
    (choice) => choice.status !== 'completed' && choice.status !== 'cancelled',
  );
  return {
    ...(resumable.length === 1 ? { primary: resumable[0] } : {}),
    choices,
    count: choices.length,
  };
}
