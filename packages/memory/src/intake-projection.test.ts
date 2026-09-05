import { describe, expect, it } from 'vitest';
import {
  type IntakeCheckpoint,
  type IntakeRequirement,
  createIntakeCheckpoint,
  createIntakeRequirement,
  projectIntakes,
} from './index.js';

const REPOSITORY = { head: 'head-1', branch: 'feature/work', dirty: false };

function intake(createdAt = '2026-01-01T00:00:00.000Z'): IntakeRequirement {
  return createIntakeRequirement({
    namespace: { principalId: 'principal-1', projectId: 'repo-1' },
    original: `Continue migration created ${createdAt}`,
    interpretation: {
      outcome: 'Finish the migration',
      scope: ['packages/memory'],
      constraints: ['Preserve compatibility'],
      acceptanceCriteria: ['Tests pass'],
    },
    sensitivity: 'internal',
    retentionPolicyId: 'default',
    provenance: {
      principalId: 'principal-1',
      deviceId: 'device-1',
      actorId: 'actor-1',
      clientId: 'codex',
    },
    createdAt,
  });
}

function checkpoint(
  requirement: IntakeRequirement,
  kind: IntakeCheckpoint['kind'] = 'progress',
  recordedAt = '2026-01-02T00:00:00.000Z',
  overrides: Partial<Omit<IntakeCheckpoint, 'id' | 'schemaVersion' | 'intakeId' | 'kind'>> = {},
): IntakeCheckpoint {
  const terminal = kind === 'completed' || kind === 'cancelled';
  return createIntakeCheckpoint({
    intakeId: requirement.id,
    kind,
    phase: terminal ? 'complete' : kind === 'blocked' ? 'blocked' : 'executing',
    ...(!terminal ? { nextSafeAction: 'Run the parser tests' } : {}),
    summary: kind === 'blocked' ? 'Waiting for credentials' : `Checkpoint ${kind}`,
    completedStepIds: ['step-1'],
    audience: 'devices',
    repository: REPOSITORY,
    actor: 'codex',
    recordedAt,
    ...overrides,
  });
}

describe('projectIntakes', () => {
  it('selects the only active intake as the primary resume brief', () => {
    const requirement = intake();
    const result = projectIntakes([requirement], [checkpoint(requirement)], REPOSITORY);
    expect(result.primary?.intakeId).toBe(requirement.id);
    expect(result.primary?.nextSafeAction).toBe('Run the parser tests');
    expect(result.primary?.status).toBe('active');
  });

  it('does not guess when multiple intakes are active', () => {
    const older = intake('2026-01-01T00:00:00.000Z');
    const newer = intake('2026-02-01T00:00:00.000Z');
    const result = projectIntakes(
      [older, newer],
      [
        checkpoint(older, 'progress', '2026-01-02T00:00:00.000Z'),
        checkpoint(newer, 'progress', '2026-02-02T00:00:00.000Z'),
      ],
      REPOSITORY,
    );
    expect(result.primary).toBeUndefined();
    expect(result.choices.map((x) => x.intakeId)).toEqual([newer.id, older.id]);
  });

  it('surfaces incompatible terminal outcomes as a conflict', () => {
    const requirement = intake();
    const result = projectIntakes(
      [requirement],
      [
        checkpoint(requirement, 'completed', '2026-01-02T00:00:00.000Z'),
        checkpoint(requirement, 'cancelled', '2026-01-03T00:00:00.000Z'),
      ],
      REPOSITORY,
    );
    expect(result.choices[0]?.conflicts).toContainEqual({
      field: 'status',
      values: ['cancelled', 'completed'],
    });
  });

  it('unions completed steps, keeps blockers, and reports repository drift', () => {
    const requirement = intake();
    const result = projectIntakes(
      [requirement],
      [
        checkpoint(requirement, 'progress', '2026-01-02T00:00:00.000Z'),
        checkpoint(requirement, 'blocked', '2026-01-03T00:00:00.000Z', {
          completedStepIds: ['step-2'],
          nextSafeAction: 'Obtain credentials',
        }),
      ],
      { ...REPOSITORY, head: 'head-2' },
    );
    expect(result.primary).toMatchObject({
      status: 'blocked',
      completedStepIds: ['step-1', 'step-2'],
      blockers: ['Waiting for credentials'],
      repositoryDrift: true,
    });
  });
});
