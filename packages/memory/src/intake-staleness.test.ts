/**
 * Stale work. Reported from real use: the memory home showed "3 Work to resume" for intakes nobody
 * had touched in weeks, next to live work, with no way to tell them apart. Idle unfinished work is
 * now set apart as stale — never closed automatically, and only when projected with a clock, so the
 * pure projection every other caller relies on is unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
  type IntakeCheckpoint,
  type IntakeRequirement,
  STALE_AFTER_DAYS,
  buildContinuation,
  createIntakeCheckpoint,
  createIntakeRequirement,
  projectIntakes,
} from './index.js';

const REPOSITORY = { head: 'head-1', branch: 'feature/work', dirty: false };

function intake(label: string, createdAt: string): IntakeRequirement {
  return createIntakeRequirement({
    namespace: { principalId: 'principal-1', projectId: 'repo-1' },
    original: label,
    interpretation: {
      outcome: label,
      scope: ['packages/memory'],
      constraints: [],
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
  recordedAt: string,
  kind: IntakeCheckpoint['kind'] = 'progress',
): IntakeCheckpoint {
  const terminal = kind === 'completed' || kind === 'cancelled';
  return createIntakeCheckpoint({
    intakeId: requirement.id,
    kind,
    phase: terminal ? 'complete' : 'executing',
    ...(!terminal ? { nextSafeAction: 'Continue' } : {}),
    summary: `Checkpoint ${kind}`,
    completedStepIds: [],
    repository: REPOSITORY,
    actor: 'codex',
    recordedAt,
  });
}

const NOW = '2026-03-01T00:00:00.000Z';

describe('projectIntakes — staleness', () => {
  it('adds nothing when projected without a clock (the pure projection is unchanged)', () => {
    const old = intake('old work', '2025-01-01T00:00:00.000Z');
    const result = projectIntakes([old], [checkpoint(old, '2025-01-02T00:00:00.000Z')], REPOSITORY);
    expect(result.choices[0]?.stale).toBeUndefined();
    expect(result.choices[0]?.idleDays).toBeUndefined();
    expect(result.staleCount).toBeUndefined();
    expect(result.resumableCount).toBe(1);
  });

  it('sets unfinished work idle past the threshold apart as stale — not resumable', () => {
    const old = intake('old work', '2026-01-01T00:00:00.000Z');
    const result = projectIntakes(
      [old],
      [checkpoint(old, '2026-02-01T00:00:00.000Z')],
      REPOSITORY,
      { now: NOW },
    );
    expect(result.choices[0]).toMatchObject({ stale: true, idleDays: 28 });
    expect(result.resumableCount).toBe(0);
    expect(result.staleCount).toBe(1);
    expect(result.primary).toBeUndefined();
  });

  it('keeps live work resumable next to stale work, and makes it the primary', () => {
    const old = intake('old work', '2026-01-01T00:00:00.000Z');
    const live = intake('live work', '2026-02-26T00:00:00.000Z');
    const result = projectIntakes(
      [old, live],
      [checkpoint(old, '2026-01-02T00:00:00.000Z'), checkpoint(live, '2026-02-28T00:00:00.000Z')],
      REPOSITORY,
      { now: NOW },
    );
    expect(result.resumableCount).toBe(1);
    expect(result.staleCount).toBe(1);
    expect(result.primary?.intakeId).toBe(live.id);
  });

  it('never marks finished work stale', () => {
    const done = intake('done work', '2025-01-01T00:00:00.000Z');
    const result = projectIntakes(
      [done],
      [checkpoint(done, '2025-01-02T00:00:00.000Z', 'completed')],
      REPOSITORY,
      { now: NOW },
    );
    expect(result.choices[0]?.stale).toBeUndefined();
    expect(result.staleCount).toBe(0);
  });

  it('honours a custom threshold', () => {
    const recent = intake('recent work', '2026-02-20T00:00:00.000Z');
    const events = [checkpoint(recent, '2026-02-26T00:00:00.000Z')];
    expect(projectIntakes([recent], events, REPOSITORY, { now: NOW }).staleCount).toBe(0);
    expect(
      projectIntakes([recent], events, REPOSITORY, { now: NOW, staleAfterDays: 3 }).staleCount,
    ).toBe(1);
    expect(STALE_AFTER_DAYS).toBe(14);
  });
});

describe('buildContinuation — stale work', () => {
  it('does not offer stale work as an option, and names how to close it', () => {
    const old = intake('old work', '2026-01-01T00:00:00.000Z');
    const projection = projectIntakes(
      [old],
      [checkpoint(old, '2026-01-02T00:00:00.000Z')],
      REPOSITORY,
      { now: NOW },
    );
    const choice = buildContinuation(projection);
    expect(choice.options.map((o) => o.optionId)).toEqual(['fresh']);
    expect(choice.question).toMatch(/stale/);
    expect(choice.rationale).toMatch(/crib intake cancel/);
  });
});
