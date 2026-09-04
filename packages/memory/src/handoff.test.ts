import { describe, expect, it } from 'vitest';
import type { Verdicts } from './enums.js';
import { type HandoffAttemptEvent, type HandoffInput, buildHandoff } from './handoff.js';
import { createIntakeCheckpoint, createIntakeRequirement } from './intake.js';
import type { MemoryRecord } from './types.js';

/**
 * Session handoff — the "where was I?" projection a returning agent calls FIRST.
 *
 * The contract under test is what makes cross-context continuity real: unfinished attempts survive
 * the gap, undistilled captures are not silently lost, claims that went stale are SURFACED (not
 * suppressed the way recall suppresses them), and the whole projection is deterministic so an
 * `ifHash` repeat collapses.
 */

const NOW = '2026-01-01T00:00:00.000Z';

function verdicts(over: Partial<Verdicts> = {}): Verdicts {
  return {
    trust: 'local',
    evidence: 'valid',
    applicability: 'current',
    lifecycle: 'active',
    ...over,
  };
}

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: `mem:${(over.claim ?? 'x').length}${over.subject ?? ''}`,
    schemaVersion: '1',
    kind: 'fact',
    subject: 'sym:src/a.ts#A.b',
    claim: 'A.b validates the token',
    scope: { boundary: 'repo', repoId: 'r1' },
    appliesTo: [],
    evidence: [],
    authorship: { actor: 'agent-1', kind: 'agent' },
    verdicts: verdicts(),
    createdAt: NOW,
    ...over,
  } as MemoryRecord;
}

function event(over: Partial<HandoffAttemptEvent> = {}): HandoffAttemptEvent {
  return { attemptId: 'att:1', phase: 'start', ts: NOW, ...over };
}

function input(over: Partial<HandoffInput> = {}): HandoffInput {
  return { attempts: [], pending: [], records: [], ...over };
}

describe('buildHandoff — unfinished work survives the context gap', () => {
  it('surfaces an attempt that started and never reached a terminal phase', () => {
    const out = buildHandoff(
      input({
        attempts: [
          event({ attemptId: 'att:1', phase: 'start', ts: '2026-01-01T00:00:00.000Z' }),
          event({
            attemptId: 'att:1',
            phase: 'action',
            ts: '2026-01-01T01:00:00.000Z',
            subject: 'sym:src/a.ts#A.b',
            action: { summary: 'rewriting the token check' },
          }),
        ],
      }),
    );
    expect(out.openWork).toHaveLength(1);
    expect(out.openWork[0]).toMatchObject({
      attemptId: 'att:1',
      lastPhase: 'action',
      subject: 'sym:src/a.ts#A.b',
      action: 'rewriting the token check',
    });
  });

  it('drops an attempt that reached a terminal phase — finished work is not a leftover', () => {
    const out = buildHandoff(
      input({
        attempts: [
          event({ attemptId: 'att:done', phase: 'start', ts: '2026-01-01T00:00:00.000Z' }),
          event({ attemptId: 'att:done', phase: 'promotion', ts: '2026-01-01T02:00:00.000Z' }),
        ],
      }),
    );
    expect(out.openWork).toHaveLength(0);
    expect(out.counts.openWork).toBe(0);
  });

  it('terminality is STICKY — a later non-terminal event cannot revive a promoted attempt', () => {
    // Guards the fold: `promotion` arrives, then a stray trailing event. Newest-wins on the
    // descriptive fields must not resurrect the attempt as open work.
    const out = buildHandoff(
      input({
        attempts: [
          event({ attemptId: 'att:x', phase: 'promotion', ts: '2026-01-01T01:00:00.000Z' }),
          event({ attemptId: 'att:x', phase: 'observation', ts: '2026-01-01T03:00:00.000Z' }),
        ],
      }),
    );
    expect(out.openWork).toHaveLength(0);
  });

  it('orders open work newest-first and reports the untruncated count', () => {
    const attempts = Array.from({ length: 4 }, (_, i) =>
      event({ attemptId: `att:${i}`, phase: 'action', ts: `2026-01-0${i + 1}T00:00:00.000Z` }),
    );
    const out = buildHandoff(input({ attempts, limits: { openWork: 2 } }));
    expect(out.openWork.map((w) => w.attemptId)).toEqual(['att:3', 'att:2']);
    expect(out.counts.openWork).toBe(4); // the page is limited; the COUNT stays honest
  });
});

describe('buildHandoff — what went stale is surfaced, not suppressed', () => {
  it('a degraded or orphaned claim lands in needsAttention, never in recent', () => {
    const good = record({ subject: 'ok', claim: 'still true' });
    const drifted = record({ subject: 'drift', claim: 'was true before the refactor' });
    const orphan = record({ subject: 'gone', claim: 'anchored to deleted code' });
    const out = buildHandoff(
      input({
        records: [
          { record: good, verdicts: verdicts() },
          { record: drifted, verdicts: verdicts({ evidence: 'degraded' }) },
          { record: orphan, verdicts: verdicts({ applicability: 'orphaned' }) },
        ],
      }),
    );
    expect(out.needsAttention.map((a) => a.subject).sort()).toEqual(['drift', 'gone']);
    expect(out.recent.map((r) => r.subject)).toEqual(['ok']);
    expect(out.counts.active).toBe(1);
    // this is the differentiator: recall HIDES these, handoff reports them
    expect(out.needsAttention.find((a) => a.subject === 'drift')?.evidence).toBe('degraded');
    expect(out.needsAttention.find((a) => a.subject === 'gone')?.applicability).toBe('orphaned');
  });

  it('a deliberately retired record is neither attention nor recent', () => {
    // superseded/retracted was a DECISION, not a silent breakage — surfacing it as "needs
    // attention" would nag the agent about work it already finished.
    const out = buildHandoff(
      input({
        records: [
          { record: record({ subject: 'old' }), verdicts: verdicts({ lifecycle: 'superseded' }) },
          { record: record({ subject: 'dead' }), verdicts: verdicts({ lifecycle: 'retracted' }) },
        ],
      }),
    );
    expect(out.needsAttention).toHaveLength(0);
    expect(out.recent).toHaveLength(0);
    expect(out.counts.active).toBe(0);
  });
});

describe('buildHandoff — undistilled captures are not lost', () => {
  it('reports pending captures with bounded observation text', () => {
    const out = buildHandoff(
      input({
        pending: [
          { id: 'cap:2', subject: 'sym:b', observation: 'looked at the retry path' },
          { id: 'cap:1', subject: 'sym:a', observation: `${'x'.repeat(500)}` },
        ],
      }),
    );
    expect(out.pendingCaptures.map((p) => p.id)).toEqual(['cap:1', 'cap:2']); // stable id order
    // raw-transcripts-off: a handoff is a briefing, so long text is trimmed, never echoed whole
    expect(out.pendingCaptures[0]?.observation.length).toBeLessThanOrEqual(240);
    expect(out.pendingCaptures[0]?.observation.endsWith('…')).toBe(true);
  });
});

describe('buildHandoff — determinism (the ifHash contract)', () => {
  it('two builds over identical input are byte-identical', () => {
    const shape = input({
      attempts: [event({ attemptId: 'att:1', phase: 'action', ts: NOW })],
      pending: [{ id: 'cap:1', subject: 's', observation: 'o' }],
      records: [{ record: record(), verdicts: verdicts() }],
    });
    expect(JSON.stringify(buildHandoff(shape))).toBe(JSON.stringify(buildHandoff(shape)));
  });

  it('an empty state is a valid, fully-zeroed handoff (a fresh repo must not throw)', () => {
    const out = buildHandoff(input());
    expect(out).toMatchObject({
      openWork: [],
      pendingCaptures: [],
      needsAttention: [],
      recent: [],
      counts: { openWork: 0, pendingCaptures: 0, needsAttention: 0, active: 0 },
      intakes: { choices: [], count: 0 },
    });
  });

  it('includes the deterministic intake resume projection without changing existing fields', () => {
    const requirement = createIntakeRequirement({
      namespace: { principalId: 'p1', projectId: 'r1' },
      original: 'Continue the migration',
      interpretation: {
        outcome: 'Finish the migration',
        scope: ['packages/memory'],
        constraints: [],
        acceptanceCriteria: ['Tests pass'],
      },
      sensitivity: 'internal',
      retentionPolicyId: 'default',
      provenance: { principalId: 'p1', deviceId: 'd1', actorId: 'a1', clientId: 'codex' },
      createdAt: NOW,
    });
    const checkpoint = createIntakeCheckpoint({
      intakeId: requirement.id,
      kind: 'progress',
      phase: 'executing',
      nextSafeAction: 'Run tests',
      summary: 'Implementation is in progress',
      repository: { head: 'abc', branch: 'feature/work', dirty: false },
      actor: 'codex',
      recordedAt: '2026-01-02T00:00:00.000Z',
    });
    const out = buildHandoff(
      input({
        intakeRequirements: [requirement],
        intakeCheckpoints: [checkpoint],
        repository: { head: 'abc', branch: 'feature/work', dirty: false },
      }),
    );
    expect(out.intakes.primary?.nextSafeAction).toBe('Run tests');
    expect(out.intakes.count).toBe(1);
  });
});
