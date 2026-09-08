/**
 * Surviving an IDE session TIMEOUT.
 *
 * Reported from real use: a Copilot/Cursor session times out, and the context is gone — there is
 * nothing to resume from. Handoff had plenty to say about intakes, checkpoints and pending
 * captures, and every one of those requires the agent to have WRITTEN something before it stopped.
 * An agent whose session was killed had no chance to. The lifecycle hook returned
 * `status: checkpoint-requested`, which is a request to the agent to write a checkpoint — the
 * design depended on precisely the thing that had just died.
 *
 * The repository anchor is the part a hook can observe on its own, so it survives a timeout, a
 * crash, or a closed laptop with no agent cooperation at all. These tests pin that it is surfaced,
 * that it degrades honestly when absent, and that it warns when the coordinates have gone stale —
 * resuming against a branch you have since left is worse than not resuming.
 */
import { describe, expect, it } from 'vitest';
import { buildHandoff } from './handoff.js';
import type { HandoffInput } from './handoff.js';
import { DEFAULT_MIGRATION_PRINCIPAL_ID } from './migrations.js';

// The trusted caller defaults to the principal that owns unscoped legacy data; tests that need a
// foreign principal pass their own.
const BASE: HandoffInput = {
  attempts: [],
  pending: [],
  records: [],
  callerPrincipal: DEFAULT_MIGRATION_PRINCIPAL_ID,
};

function lifecycleEvent(
  over: {
    occurredAt?: string;
    sessionId?: string;
    clientId?: string;
    event?: string;
    principalId?: string;
    branch?: string;
    head?: string;
    changedPaths?: string[];
    noAnchor?: boolean;
    id?: string;
  } = {},
) {
  return {
    ...(over.id !== undefined ? { id: over.id } : {}),
    occurredAt: over.occurredAt ?? '2026-09-05T10:00:00.000Z',
    source: {
      clientId: over.clientId ?? 'copilot',
      ...(over.sessionId !== undefined ? { sessionId: over.sessionId } : {}),
    },
    ...(over.principalId !== undefined ? { identity: { principalId: over.principalId } } : {}),
    payload: {
      event: over.event ?? 'turn-end',
      action: 'checkpoint-requested',
      hasOutcome: false,
      ...(over.noAnchor
        ? {}
        : {
            repository: {
              branch: over.branch ?? 'feature/payments',
              head: over.head ?? 'a'.repeat(40),
              dirty: true,
              changedPaths: over.changedPaths ?? ['src/billing/account.ts'],
            },
          }),
    },
  };
}

describe('handoff.lastSession — resuming after a timeout', () => {
  it('recovers where the session was, with NO agent checkpoint of any kind', () => {
    // The whole point: `attempts`, `pending` and `records` are all empty, exactly as they are when
    // a session is killed mid-turn. The coordinates still come back.
    const out = buildHandoff({ ...BASE, lifecycle: [lifecycleEvent({ sessionId: 'sess-A' })] });
    expect(out.lastSession).toMatchObject({
      sessionId: 'sess-A',
      clientId: 'copilot',
      event: 'turn-end',
      branch: 'feature/payments',
      changedPaths: ['src/billing/account.ts'],
    });
  });

  it('is ABSENT when no hook ever ran — "no hook" must not look like "no prior work"', () => {
    expect(buildHandoff(BASE).lastSession).toBeUndefined();
    expect(buildHandoff({ ...BASE, lifecycle: [] }).lastSession).toBeUndefined();
  });

  it('warns when the repository has MOVED since — stale coordinates are worse than none', () => {
    const out = buildHandoff({
      ...BASE,
      lifecycle: [lifecycleEvent({ branch: 'feature/payments' })],
      repository: { dirty: false, branch: 'main', head: 'b'.repeat(40) },
    });
    expect(out.lastSession?.movedSince).toBe(true);
  });

  it('does not warn when the repository is where the session left it', () => {
    const out = buildHandoff({
      ...BASE,
      lifecycle: [lifecycleEvent({ branch: 'feature/payments', head: 'a'.repeat(40) })],
      repository: { dirty: true, branch: 'feature/payments', head: 'a'.repeat(40) },
    });
    expect(out.lastSession?.movedSince).toBe(false);
  });

  it('takes the newest event that HAS an anchor, not simply the newest', () => {
    // A hook installed before the anchor existed still appends events. Taking the newest
    // unconditionally would report a session with no coordinates and read as a broken feature;
    // older-but-useful beats newer-but-empty.
    const out = buildHandoff({
      ...BASE,
      lifecycle: [
        lifecycleEvent({ occurredAt: '2026-09-05T09:00:00.000Z', branch: 'feature/payments' }),
        lifecycleEvent({ occurredAt: '2026-09-05T11:00:00.000Z', noAnchor: true }),
      ],
    });
    expect(out.lastSession?.branch).toBe('feature/payments');
    expect(out.lastSession?.lastActivity).toBe('2026-09-05T09:00:00.000Z');
  });

  it('prefers the newest anchored event when several carry coordinates', () => {
    const out = buildHandoff({
      ...BASE,
      lifecycle: [
        lifecycleEvent({ occurredAt: '2026-09-05T09:00:00.000Z', branch: 'old-branch' }),
        lifecycleEvent({ occurredAt: '2026-09-05T11:00:00.000Z', branch: 'new-branch' }),
      ],
    });
    expect(out.lastSession?.branch).toBe('new-branch');
  });

  it("returns only the calling principal's previous session", () => {
    const out = buildHandoff({
      ...BASE,
      callerPrincipal: 'principal:A',
      currentSessionId: 'server-now',
      lifecycle: [
        lifecycleEvent({
          occurredAt: '2026-09-05T09:00:00.000Z',
          sessionId: 'owner-old',
          principalId: 'principal:A',
          branch: 'owner-branch',
        }),
        lifecycleEvent({
          occurredAt: '2026-09-05T10:00:00.000Z',
          sessionId: 'foreign-newest',
          principalId: 'principal:B',
          branch: 'private-branch',
        }),
        lifecycleEvent({
          occurredAt: '2026-09-05T11:00:00.000Z',
          sessionId: 'server-now',
          principalId: 'principal:A',
          branch: 'current-server-branch',
        }),
      ],
    });
    expect(out.lastSession).toMatchObject({ sessionId: 'owner-old', branch: 'owner-branch' });
  });

  it('does not expose an unscoped legacy session to a non-default principal', () => {
    const out = buildHandoff({
      ...BASE,
      callerPrincipal: 'principal:other-user',
      lifecycle: [lifecycleEvent({ sessionId: 'legacy', branch: 'legacy-branch' })],
    });
    expect(out.lastSession).toBeUndefined();
  });

  it('bounds a persisted session anchor to twenty paths', () => {
    const out = buildHandoff({
      ...BASE,
      lifecycle: [
        lifecycleEvent({
          principalId: 'principal:local',
          changedPaths: Array.from({ length: 21 }, (_, i) => `src/${i}.ts`),
        }),
      ],
    });
    expect(out.lastSession?.changedPaths).toHaveLength(20);
  });

  it('carries coordinates only — never a transcript', () => {
    // The capture policy excludes prompts, transcripts and tool IO. A resume is a set of
    // coordinates: where you were, not what was said.
    const out = buildHandoff({ ...BASE, lifecycle: [lifecycleEvent()] });
    const keys = Object.keys(out.lastSession ?? {});
    expect(keys.sort()).toEqual(
      ['branch', 'changedPaths', 'clientId', 'event', 'head', 'lastActivity', 'movedSince'].sort(),
    );
  });
});

describe('handoff.lastSession — WP3: trusted caller context and determinism', () => {
  it('REFUSES to project lifecycle events without a trusted caller principal', () => {
    // WP3.2: the missing-principal behavior used to show EVERY event in the journal. The type
    // makes this a compile error; the runtime guard makes it an explicit error for callers that
    // bypass types — never a silent all-events fallback.
    expect(() =>
      buildHandoff({
        attempts: [],
        pending: [],
        records: [],
        lifecycle: [lifecycleEvent({ sessionId: 'anyone' })],
        // Deliberately untyped: the runtime guard is the thing under test, so the compile-time
        // requirement must be bypassed the way a non-TypeScript caller would.
      } as unknown as HandoffInput),
    ).toThrow(/callerPrincipal/);
    expect(() => buildHandoff({ ...BASE, callerPrincipal: '  ' })).toThrow(/callerPrincipal/);
  });

  it('resolves equal timestamps by event identity, independent of the order events arrive in', () => {
    // WP3.4: two anchored events, identical occurredAt. Event identity — not array position —
    // decides, so a caller that passes the same events in a different order gets the SAME
    // lastSession rather than a different one.
    const a = lifecycleEvent({ id: 'evt:aa', occurredAt: '2026-09-05T10:00:00.000Z', branch: 'b-aa' });
    const b = lifecycleEvent({ id: 'evt:bb', occurredAt: '2026-09-05T10:00:00.000Z', branch: 'b-bb' });
    const forward = buildHandoff({ ...BASE, lifecycle: [a, b] });
    const reversed = buildHandoff({ ...BASE, lifecycle: [b, a] });
    expect(forward.lastSession?.branch).toBe('b-bb');
    expect(reversed.lastSession?.branch).toBe('b-bb');
  });

  it('still prefers the newest timestamp when timestamps differ', () => {
    const out = buildHandoff({
      ...BASE,
      lifecycle: [
        lifecycleEvent({ id: 'evt:zz', occurredAt: '2026-09-05T09:00:00.000Z', branch: 'older' }),
        lifecycleEvent({ id: 'evt:aa', occurredAt: '2026-09-05T11:00:00.000Z', branch: 'newer' }),
      ],
    });
    expect(out.lastSession?.branch).toBe('newer');
  });

  it('marks the changed-path list as truncated when the hook recorded more than twenty', () => {
    // WP3.7: a bounded list without metadata is indistinguishable from a complete one.
    const out = buildHandoff({
      ...BASE,
      lifecycle: [
        lifecycleEvent({
          principalId: 'principal:local',
          changedPaths: Array.from({ length: 21 }, (_, i) => `src/${i}.ts`),
        }),
      ],
    });
    expect(out.lastSession?.changedPaths).toHaveLength(20);
    expect(out.lastSession?.changedPathsTruncated).toBe(true);
  });

  it('does NOT mark truncation when every recorded path fits', () => {
    const out = buildHandoff({
      ...BASE,
      lifecycle: [
        lifecycleEvent({ principalId: 'principal:local', changedPaths: ['src/a.ts'] }),
      ],
    });
    expect(out.lastSession?.changedPathsTruncated).toBeUndefined();
  });

  it('reports an unreadable journal as an explicit degraded state, never as "no prior work"', () => {
    // WP3.8: `degraded` is the channel that separates "the journal could not be read" from
    // "no hook ever ran". Silent absence taught returning agents to distrust the projection.
    const out = buildHandoff({ ...BASE, lifecycleUnreadable: true });
    expect(out.degraded).toEqual(['lifecycle-journal-unreadable']);
    const clean = buildHandoff(BASE);
    expect(clean.degraded).toEqual([]);
  });
});
