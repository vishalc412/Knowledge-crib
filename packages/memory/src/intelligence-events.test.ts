import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IntelligenceEventJournal,
  IntelligenceEventJournalError,
  resolveServerIdentity,
} from './intelligence-events.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T31 = '2026-02-01T00:00:00.000Z';
const roots: string[] = [];

function journal() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-crib-events-'));
  roots.push(root);
  return new IntelligenceEventJournal({ rootDir: root, now: () => T0 });
}

function journalWithRoot() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-crib-events-'));
  roots.push(root);
  return {
    root,
    events: new IntelligenceEventJournal({ rootDir: root, now: () => T0 }),
    path: join(root, 'intelligence-events.jsonl'),
  };
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

  it('recovers an incomplete trailing write: earlier events replay intact and a re-append deduplicates', () => {
    const { events, path } = journalWithRoot();
    const first = events.append({
      kind: 'memory.observed',
      idempotencyKey: 'codex:session-7:offset-1',
      source: { clientId: 'codex' },
      identity: { principalId: 'principal:alice' },
      payload: { subject: 'topic:event-plane' },
      occurredAt: T0,
    });
    events.append({
      kind: 'file.changed',
      idempotencyKey: 'watcher:2',
      source: { clientId: 'watcher' },
      identity: { principalId: 'principal:alice' },
      payload: { path: 'packages/memory/src/api.ts' },
      occurredAt: T0,
    });

    // A crash mid-append leaves a half-written final line with no trailing newline.
    appendFileSync(path, '{"id":"iev:torn","schemaVersio', 'utf8');

    const replayed = events.read({ includeExpired: true });
    expect(replayed.map((event) => event.idempotencyKey)).toEqual([
      'codex:session-7:offset-1',
      'watcher:2',
    ]);

    const repeated = events.append({
      kind: 'memory.observed',
      idempotencyKey: 'codex:session-7:offset-1',
      source: { clientId: 'codex' },
      identity: { principalId: 'principal:alice' },
      occurredAt: T0,
    });
    expect(repeated.duplicate).toBe(true);
    expect(repeated.event).toEqual(first.event);
    // The duplicate was never persisted: the journal still holds the two committed
    // events plus the torn line, and no complete third event exists.
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('{"id":"iev:torn","schemaVersio');
    expect(events.read({ includeExpired: true })).toHaveLength(2);
  });

  it('throws IntelligenceEventJournalError naming the line for a malformed interior line', () => {
    const { events, path } = journalWithRoot();
    const { event: committed } = events.append({
      kind: 'file.changed',
      idempotencyKey: 'watcher:1',
      source: { clientId: 'watcher' },
      identity: { principalId: 'principal:alice' },
      payload: { path: 'packages/memory/src/api.ts' },
      occurredAt: T0,
    });

    // Interior corruption: a malformed complete line followed by a valid one.
    appendFileSync(path, '{"id":"iev:corrupt"\n', 'utf8');
    appendFileSync(path, `${JSON.stringify(committed)}\n`, 'utf8');

    expect(() => events.read()).toThrow(IntelligenceEventJournalError);
    expect(() => events.read()).toThrow(/invalid intelligence event at line 2/);
  });
});
