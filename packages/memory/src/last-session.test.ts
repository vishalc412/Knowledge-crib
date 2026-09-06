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

const BASE: HandoffInput = { attempts: [], pending: [], records: [] };

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
  } = {},
) {
  return {
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
