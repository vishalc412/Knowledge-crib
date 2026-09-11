/**
 * Pending backlog maintenance. Reported from real use: the memory home's Pending count only grew —
 * learnings captured before they could be verified were never looked at again, and the only
 * suggested action needed an LLM provider nobody had configured. `recheckPending` re-runs today's
 * gate over the backlog; `dismissPending` retires what the operator does not want (a dead-letter
 * transition, never a delete).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type GroundingPort,
  MemoryApi,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryRecord,
  type MemorySoulPort,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  pendingCaptures,
} from './index.js';

const T0 = '2026-09-11T00:00:00.000Z';
const REPO = 'r-pending-maintenance';
const FILE = 'src/team.ts';
const SYMBOL = `sym:${FILE}#Team.displayNumber@L10`;

const NODES: Node[] = [
  {
    id: SYMBOL,
    kind: 'symbol',
    name: 'displayNumber',
    file: FILE,
    span: { start: 10, end: 14 },
    hash: 'blake3:5b01',
  } as Node,
];

function port(): GroundingPort & MemorySoulPort {
  return {
    getNode: (id: string) => NODES.find((n) => n.id === id),
    allNodes: () => NODES,
    findByLocator: () => [],
    rehydrate: () => ({
      text: 'get displayNumber() {\n  return this.cached;\n}',
      truncated: false,
      totalLines: 1,
      startLine: 10,
    }),
  } as unknown as GroundingPort & MemorySoulPort;
}

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-pending-maint-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

/** A writer with no evaluator — how captures piled up before the gate existed. */
function writer(local: MemoryStore) {
  return new MemoryApi({ stores: { local }, env, now: () => T0, soul: port() });
}

function maintainer(local: MemoryStore) {
  const soul = port();
  return new MemoryApi({
    stores: { local },
    env,
    now: () => T0,
    soul,
    evaluator: new MemoryEvaluator(),
    evalCtx: { soul },
  });
}

const groundedFact = {
  kind: 'fact' as const,
  subject: SYMBOL,
  claim: 'Team.displayNumber returns the cached value',
  actor: 'claude-code',
  repoId: REPO,
  evidence: [
    {
      kind: 'source-quote',
      path: FILE,
      line: 11,
      quote: 'return this.cached;',
    } as unknown as MemoryEvidence,
  ],
};

describe('recheckPending', () => {
  it('admits a backlog capture that verifies today, and removes it from the queue', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const staged = writer(local).observe(groundedFact);
    if (!staged.ok) throw new Error(staged.error);
    expect(staged.status).toBe('pending');
    expect(pendingCaptures(local)).toHaveLength(1);

    const result = maintainer(local).recheckPending();
    expect(result.checked).toBe(1);
    expect(result.admitted).toHaveLength(1);
    expect(result.held).toEqual([]);
    expect(result.remaining).toBe(0);
    expect(local.readCollection('candidates').entries).toEqual([]);
    const active = local.readCollection('active').entries as MemoryRecord[];
    expect(active.map((r) => r.id)).toEqual([result.admitted[0]?.recordId]);
    expect(active[0]?.verdicts.trust).toBe('local');
  });

  it('admits a relayed user preference from the backlog', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const staged = writer(local).observe({
      kind: 'convention',
      subject: 'topic:package-manager',
      claim: 'Use pnpm for every install command',
      evidence: [
        { kind: 'human-attestation', quote: 'always pnpm, never npm' } as unknown as MemoryEvidence,
      ],
      actor: 'claude-code',
      repoId: REPO,
    });
    if (!staged.ok) throw new Error(staged.error);
    const result = maintainer(local).recheckPending();
    expect(result.admitted).toHaveLength(1);
    expect(result.admitted[0]?.reason).toMatch(/relayed/);
  });

  it('holds what still does not verify, with the reason, and leaves it pending', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    writer(local).observe({
      kind: 'fact',
      subject: 'topic:ci',
      claim: 'CI runs on ubuntu',
      actor: 'claude-code',
      repoId: REPO,
    });
    const result = maintainer(local).recheckPending();
    expect(result.admitted).toEqual([]);
    expect(result.held).toHaveLength(1);
    expect(result.held[0]?.reason).toMatch(/no evidence/);
    expect(result.remaining).toBe(1);
  });

  it('is idempotent — a second pass finds nothing left to admit', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    writer(local).observe(groundedFact);
    maintainer(local).recheckPending();
    const again = maintainer(local).recheckPending();
    expect(again.checked).toBe(0);
    expect((local.readCollection('active').entries as MemoryRecord[]).length).toBe(1);
  });

  it('reports why it skipped when no evaluator is wired', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    writer(local).observe(groundedFact);
    const result = writer(local).recheckPending();
    expect(result.checked).toBe(0);
    expect(result.skipped).toMatch(/evaluator/);
    expect(result.remaining).toBe(1);
  });
});

describe('dismissPending', () => {
  it('dead-letters the capture with who dismissed it and withdraws its staged claim', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const staged = writer(local).observe({
      kind: 'fact',
      subject: 'topic:ci',
      claim: 'CI runs on ubuntu',
      actor: 'claude-code',
      repoId: REPO,
    });
    if (!staged.ok) throw new Error(staged.error);
    const result = writer(local).dismissPending(staged.outboxId, {
      actor: 'human:vishal',
      reason: 'not useful',
    });
    expect(result).toEqual({ ok: true, dismissed: true });
    expect(pendingCaptures(local)).toEqual([]);
    expect(local.readCollection('candidates').entries).toEqual([]);
    const dead = local.readCollection('dead').entries as Array<{ meta?: Record<string, unknown> }>;
    expect(String(dead[0]?.meta?.deadLetterReason)).toMatch(
      /dismissed by human:vishal: not useful/,
    );
  });

  it('is a harmless no-op for an id that is not pending', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    expect(writer(local).dismissPending('cap:nope', { actor: 'human:vishal' })).toEqual({
      ok: true,
      dismissed: false,
    });
  });

  it('requires an actor', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    expect(writer(local).dismissPending('cap:nope', { actor: ' ' }).ok).toBe(false);
  });
});
