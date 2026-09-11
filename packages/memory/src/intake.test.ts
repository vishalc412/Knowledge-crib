import { describe, expect, it } from 'vitest';
import {
  type IntakeRequirementInput,
  createIntakeCheckpoint,
  createIntakeRequirement,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';

function fixture(overrides: Partial<IntakeRequirementInput> = {}): IntakeRequirementInput {
  return {
    namespace: {
      principalId: 'principal-1',
      workspaceId: 'workspace-1',
      projectId: 'repo-1',
      agentProfileId: 'default',
    },
    original: '  Continue   the parser migration safely.  ',
    interpretation: {
      outcome: 'Finish the parser migration',
      scope: ['packages/parsers'],
      constraints: ['Keep backwards compatibility'],
      acceptanceCriteria: ['All parser tests pass'],
    },
    sensitivity: 'internal',
    retentionPolicyId: 'default',
    provenance: {
      principalId: 'principal-1',
      deviceId: 'device-1',
      actorId: 'actor-1',
      agentId: 'codex',
      clientId: 'codex',
      sessionId: 'session-1',
      tool: 'intake_create',
    },
    createdAt: NOW,
    ...overrides,
  };
}

describe('intake requirement', () => {
  it('creates a stable id while excluding timestamps', () => {
    const a = createIntakeRequirement(fixture({ createdAt: NOW }));
    const b = createIntakeRequirement(fixture({ createdAt: '2026-02-01T00:00:00.000Z' }));

    expect(a.id).toBe(b.id);
    expect(a.original).toBe('Continue the parser migration safely.');
  });

  it('rejects empty original wording and interpreted outcomes', () => {
    expect(() => createIntakeRequirement(fixture({ original: '  ' }))).toThrow(/original/i);
    expect(() =>
      createIntakeRequirement(
        fixture({ interpretation: { ...fixture().interpretation, outcome: '\n' } }),
      ),
    ).toThrow(/outcome/i);
  });
});

describe('intake checkpoint', () => {
  it('requires a safe next action for non-terminal checkpoints', () => {
    const intake = createIntakeRequirement(fixture());
    expect(() =>
      createIntakeCheckpoint({
        intakeId: intake.id,
        kind: 'progress',
        phase: 'executing',
        summary: 'Parser fixtures are migrated',
        repository: { head: 'abc123', branch: 'feature/parser', dirty: true },
        actor: 'codex',
        recordedAt: NOW,
      }),
    ).toThrow(/nextSafeAction/i);
  });

  it('creates a stable id while excluding recordedAt', () => {
    const intake = createIntakeRequirement(fixture());
    const input = {
      intakeId: intake.id,
      kind: 'progress' as const,
      phase: 'executing' as const,
      nextSafeAction: 'Run parser tests',
      summary: 'Parser fixtures are migrated',
      repository: { head: 'abc123', branch: 'feature/parser', dirty: true },
      actor: 'codex',
      recordedAt: NOW,
    };
    const a = createIntakeCheckpoint(input);
    const b = createIntakeCheckpoint({
      ...input,
      recordedAt: '2026-02-01T00:00:00.000Z',
    });

    expect(a.id).toBe(b.id);
  });

  it('persists only the checkpoint repository anchor, not lifecycle changed paths', () => {
    const intake = createIntakeRequirement(fixture());
    // Lifecycle anchors carry a bounded path list for a returning session. A durable checkpoint
    // intentionally stores only its digest: paths belong to the lifecycle projection, while the
    // checkpoint schema stays a compact, privacy-preserving resume fingerprint.
    const repository = {
      head: 'abc123',
      branch: 'feature/parser',
      dirty: true,
      changedPathsDigest: 'blake3:dirty-tree',
      changedPaths: ['packages/memory/src/intake.ts'],
    };

    const checkpoint = createIntakeCheckpoint({
      intakeId: intake.id,
      kind: 'resumed',
      phase: 'executing',
      nextSafeAction: 'Run the focused recovery tests',
      summary: 'Resumed after repository drift',
      repository,
      actor: 'codex',
      recordedAt: NOW,
    });

    expect(checkpoint.repository).toEqual({
      head: 'abc123',
      branch: 'feature/parser',
      dirty: true,
      changedPathsDigest: 'blake3:dirty-tree',
    });
  });
});
