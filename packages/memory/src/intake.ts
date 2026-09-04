import { intakeCheckpointId, intakeRequirementId, normalizeClaim } from './ids.js';
import type { IntakeCheckpoint, IntakeRequirement } from './types.js';
import {
  assertValidIntakeCheckpoint,
  assertValidIntakeRequirement,
} from './validate.js';

export type IntakeRequirementInput = Omit<IntakeRequirement, 'id' | 'schemaVersion'>;
export type IntakeCheckpointInput = Omit<IntakeCheckpoint, 'id' | 'schemaVersion'>;

function normalizedList(values: readonly string[]): string[] {
  return values.map(normalizeClaim).filter((value) => value.length > 0);
}

export function createIntakeRequirement(input: IntakeRequirementInput): IntakeRequirement {
  const original = normalizeClaim(input.original);
  const outcome = normalizeClaim(input.interpretation.outcome);
  if (!original) throw new Error('intake original must not be empty');
  if (!outcome) throw new Error('intake interpretation outcome must not be empty');

  const semantic = {
    namespace: input.namespace,
    original,
    interpretation: {
      outcome,
      scope: normalizedList(input.interpretation.scope),
      constraints: normalizedList(input.interpretation.constraints),
      acceptanceCriteria: normalizedList(input.interpretation.acceptanceCriteria),
    },
    sensitivity: input.sensitivity,
    retentionPolicyId: normalizeClaim(input.retentionPolicyId),
    provenance: input.provenance,
  };
  const requirement: IntakeRequirement = {
    id: intakeRequirementId(semantic),
    schemaVersion: '1',
    ...semantic,
    createdAt: input.createdAt,
  };
  assertValidIntakeRequirement(requirement);
  return requirement;
}

const TERMINAL_CHECKPOINTS = new Set<IntakeCheckpoint['kind']>(['completed', 'cancelled']);

export function createIntakeCheckpoint(input: IntakeCheckpointInput): IntakeCheckpoint {
  const summary = normalizeClaim(input.summary);
  const nextSafeAction = input.nextSafeAction
    ? normalizeClaim(input.nextSafeAction)
    : undefined;
  if (!summary) throw new Error('intake checkpoint summary must not be empty');
  if (!TERMINAL_CHECKPOINTS.has(input.kind) && !nextSafeAction) {
    throw new Error(`nextSafeAction is required for non-terminal checkpoint '${input.kind}'`);
  }

  const semantic = {
    intakeId: input.intakeId,
    kind: input.kind,
    phase: input.phase,
    ...(nextSafeAction ? { nextSafeAction } : {}),
    summary,
    ...(input.completedStepIds
      ? { completedStepIds: normalizedList(input.completedStepIds) }
      : {}),
    ...(input.audience ? { audience: input.audience } : {}),
    repository: input.repository,
    ...(input.artifactPaths ? { artifactPaths: normalizedList(input.artifactPaths) } : {}),
    ...(input.receiptIds ? { receiptIds: normalizedList(input.receiptIds) } : {}),
    actor: normalizeClaim(input.actor),
  };
  const checkpoint: IntakeCheckpoint = {
    id: intakeCheckpointId(semantic),
    schemaVersion: '1',
    ...semantic,
    recordedAt: input.recordedAt,
  };
  assertValidIntakeCheckpoint(checkpoint);
  return checkpoint;
}
