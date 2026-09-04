import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IntelligenceEventJournal, resolveServerIdentity } from './intelligence-events.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T31 = '2026-02-01T00:00:00.000Z';
const roots: string[] = [];

function journal() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-crib-events-'));
  roots.push(root);
  return new IntelligenceEventJournal({ rootDir: root, now: () => T0 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('IntelligenceEventJournal', () => {
  it('resolves namespace ownership from the host environment and drops blank optional scopes', () => {
    expect(
      resolveServerIdentity({
        KCRIB_PRINCIPAL_ID: 'principal:alice',
        KCRIB_WORKSPACE_ID: 'workspace:product',
        KCRIB_PROJECT_ID: 'project:knowledge-crib',
        KCRIB_AGENT_PROFILE_ID: 'agent-profile:architect',
      }),
    ).toEqual({
      principalId: 'principal:alice',
      workspaceId: 'workspace:product',
      projectId: 'project:knowledge-crib',
      agentProfileId: 'agent-profile:architect',
    });
    expect(resolveServerIdentity({ KCRIB_PRINCIPAL_ID: '  ', KCRIB_WORKSPACE_ID: ' ' })).toEqual({
      principalId: 'principal:local',
    });
  });

  it('deduplicates an idempotency key and never persists forbidden raw payload fields', () => {
    const events = journal();
    const input = {
      kind: 'memory.observed' as const,
      idempotencyKey: 'codex:session-7:offset-1',
      source: { clientId: 'codex', sessionId: 'session-7', eventOffset: 1 },
      identity: {
        principalId: 'principal:alice',
        workspaceId: 'workspace:knowledge-crib',
        projectId: 'project:knowledge-crib',
        agentProfileId: 'agent-profile:architect',
      },
      payload: {
        subject: 'topic:event-plane',
        fullTranscript: 'this must not be stored',
        nested: { rawCommandOutput: 'nor this', keep: 'structured fact' },
      },
      evidenceRefs: ['file:docs/launch-readiness.md'],
      occurredAt: T0,
    };

    const first = events.append(input);
    const repeated = events.append(input);

    expect(first.duplicate).toBe(false);
    expect(repeated).toEqual({ event: first.event, duplicate: true });
    expect(events.read()).toEqual([
      expect.objectContaining({
        kind: 'memory.observed',
        idempotencyKey: input.idempotencyKey,
        identity: input.identity,
        payload: { subject: 'topic:event-plane', nested: { keep: 'structured fact' } },
      }),
    ]);
  });

  it('keeps expired events in the immutable audit journal while omitting them from the live view', () => {
    const events = journal();
    events.append({
      kind: 'file.changed',
      idempotencyKey: 'watcher:1',
      source: { clientId: 'watcher' },
      identity: { principalId: 'principal:alice' },
      payload: { path: 'packages/memory/src/api.ts' },
      occurredAt: T0,
    });

    expect(events.read({ now: T31 })).toEqual([]);
    expect(events.read({ now: T31, includeExpired: true })).toHaveLength(1);
  });

  it('retains pinned events beyond the default thirty-day live retention window', () => {
    const events = journal();
    events.append({
      kind: 'git.transition',
      idempotencyKey: 'git:abc123',
      source: { clientId: 'git-hook' },
      identity: { principalId: 'principal:alice' },
      payload: { ref: 'abc123' },
      occurredAt: T0,
      retention: { pinned: true },
    });

    expect(events.read({ now: T31 })).toHaveLength(1);
  });
});
