/**
 * WP-G5 — `memory_graph` serving laws over a real local store: per-op behavior, principal
 * isolation through every op, generation-bound cursors, traversal bounds, and the explicit
 * unavailable fallback.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  type GraphAssertion,
  MemoryApi,
  type MemoryGraphPredicate,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  createGraphAssertion,
  createGraphEntity,
} from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Verbs } from './verbs.js';

const REPO = 'r-verbs-mem-graph';
const ALPHA = 'principal:alpha';
const BETA = 'principal:beta';
const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-05T00:00:00.000Z';
const T3 = '2026-09-10T00:00:00.000Z';

let repo: string;
let home: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let local: MemoryStore;
let previousPrincipal: string | undefined;

function provenance(principalId: string) {
  return { principalId, deviceId: 'device:graph', actorId: 'agent:graph', clientId: 'vitest' };
}

function support(principalId: string) {
  return createGraphEntity({
    kind: 'concept',
    name: `support-${principalId.slice('principal:'.length)}`,
    namespace: { principalId },
    scope: { boundary: 'global' },
    provenance: provenance(principalId),
  });
}

function edge(
  principalId: string,
  predicate: MemoryGraphPredicate,
  subject: string,
  object: string,
  supporter: string,
  at = T1,
): GraphAssertion {
  return createGraphAssertion({
    predicate,
    subject,
    object,
    namespace: { principalId },
    scope: { boundary: 'global' },
    validAt: at,
    knownAt: at,
    supportedBy: [supporter],
    provenance: provenance(principalId),
  });
}

function as(principal: string): void {
  process.env.KCRIB_PRINCIPAL_ID = principal;
}

function verbs(): Verbs {
  return new Verbs({ soul, index, repoRoot: repo, memory: { local } });
}

type Res = Record<string, unknown>;

let alphaSupport: ReturnType<typeof support>;
let about: GraphAssertion;
let appliesTo: GraphAssertion;
let supersedes: GraphAssertion;

beforeEach(() => {
  previousPrincipal = process.env.KCRIB_PRINCIPAL_ID;
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-mem-graph-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  home = mkdtempSync(join(tmpdir(), 'mem-home-graph-'));
  __resetMemoryLockGuardForTest();
  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: T1 }) });
  soul.load();
  soul.commit(T1);
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  local = MemoryStore.local(REPO, {
    env: { ...process.env, KCRIB_MEMORY_DIR: home },
    now: () => T1,
    repoRoot: repo,
  });

  alphaSupport = support(ALPHA);
  const betaSupport = support(BETA);
  about = edge(ALPHA, 'about', 'mem:d1', 'topic:retry', alphaSupport.ref);
  appliesTo = edge(ALPHA, 'applies-to', 'topic:retry', 'sym:ledger#settle', alphaSupport.ref);
  supersedes = edge(ALPHA, 'supersedes', 'mem:d2', 'mem:d1', alphaSupport.ref, T3);
  const foreign = edge(BETA, 'about', 'mem:d1', 'topic:beta-secret', betaSupport.ref);
  local.submitGraphEntries([alphaSupport, betaSupport, about, appliesTo, supersedes, foreign]);
  as(ALPHA);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousPrincipal === undefined) Reflect.deleteProperty(process.env, 'KCRIB_PRINCIPAL_ID');
  else process.env.KCRIB_PRINCIPAL_ID = previousPrincipal;
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('memory_graph op contracts', () => {
  it('refuses requests an op cannot answer honestly', () => {
    const v = verbs();
    const code = (r: Res) => (r.error as { code?: string } | undefined)?.code;
    expect(code(v.memoryConnectedGraph({ op: 'neighbors' }))).toBe('BAD_REQUEST');
    expect(code(v.memoryConnectedGraph({ op: 'history' }))).toBe('BAD_REQUEST');
    expect(code(v.memoryConnectedGraph({ op: 'path', refs: ['mem:d1'] }))).toBe('BAD_REQUEST');
    expect(
      code(v.memoryConnectedGraph({ op: 'search', refs: ['mem:d1'], predicates: ['likes'] })),
    ).toBe('BAD_REQUEST');
    expect(code(v.memoryConnectedGraph({ op: 'context', q: 'x', cursor: 'abc' }))).toBe(
      'BAD_REQUEST',
    );
    expect(
      code(v.memoryConnectedGraph({ op: 'bogus' as unknown as 'search', refs: ['mem:d1'] })),
    ).toBe('BAD_REQUEST');
  });

  it('neighbors expands only the authorized graph and reports foreign refs as unresolved input', () => {
    const res = verbs().memoryConnectedGraph({
      op: 'neighbors',
      refs: ['mem:d1', 'topic:beta-secret'],
    });
    const refs = (res.expansions as { ref: string }[]).map((e) => e.ref);
    expect(refs).toContain('mem:d1');
    expect(refs).toContain('topic:retry');
    expect(refs).toContain('sym:ledger#settle');
    expect(refs).not.toContain('topic:beta-secret');
    expect(res.unresolvedRefs).toEqual(['topic:beta-secret']);
    expect(res.unavailable).toBe(false);
    expect(typeof res.generation).toBe('string');
    const { unresolvedRefs: _echo, ...rest } = res;
    expect(JSON.stringify(rest)).not.toContain('beta');
  });

  it('path returns the authorized assertion chain, and null toward a foreign node', () => {
    const v = verbs();
    const found = v.memoryConnectedGraph({ op: 'path', refs: ['mem:d1', 'sym:ledger#settle'] });
    expect((found.path as { assertionId: string }[]).map((s) => s.assertionId)).toEqual([
      about.id,
      appliesTo.id,
    ]);
    const bounded = v.memoryConnectedGraph({
      op: 'path',
      refs: ['mem:d1', 'sym:ledger#settle'],
      hops: 1,
    });
    expect(bounded.path).toBeNull();
    const foreign = v.memoryConnectedGraph({ op: 'path', refs: ['mem:d1', 'topic:beta-secret'] });
    expect(foreign.path).toBeNull();
    expect(foreign.unresolvedRefs).toEqual(['topic:beta-secret']);
  });

  it('history labels what is current and what is only historical at a point in time', () => {
    const res = verbs().memoryConnectedGraph({ op: 'history', refs: ['mem:d1'], at: T2 });
    const timeline = res.timeline as { assertionId: string; state: string }[];
    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assertionId: about.id, state: 'current' }),
        expect.objectContaining({ assertionId: supersedes.id, state: 'historical' }),
      ]),
    );
    expect(JSON.stringify(res)).not.toContain('beta');
  });

  it('context returns an assembled pack citing each assertion once and no foreign content', () => {
    const res = verbs().memoryConnectedGraph({ op: 'context', refs: ['mem:d1'] });
    const context = res.context as {
      items: { ref: string; state: string }[];
      assertions: { id: string; supportedBy: string[]; status: string }[];
      relations: string[];
      budgetTokens: number;
    };
    expect(context.items[0]).toMatchObject({ ref: 'mem:d1', state: 'current' });
    const ids = context.assertions.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([about.id, appliesTo.id]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(context.assertions.every((a) => a.supportedBy.includes(alphaSupport.ref))).toBe(true);
    expect(context.budgetTokens).toBe(2000);
    expect(JSON.stringify(res)).not.toContain('beta');
  });

  it('search seeds from the caller’s own graph by text and cites relations between seeds', () => {
    const res = verbs().memoryConnectedGraph({ op: 'search', q: 'retry ledger settle' });
    expect(res.seedScorer).toBe('graph-seed-v1:term-overlap');
    const seeds = (res.seeds as { ref: string; channel: string }[]).map((s) => s.ref);
    expect(seeds).toEqual(expect.arrayContaining(['topic:retry', 'sym:ledger#settle']));
    expect(res.relations as { assertionId: string }[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ assertionId: appliesTo.id })]),
    );
    as(BETA);
    const foreign = verbs().memoryConnectedGraph({ op: 'search', q: 'retry ledger settle' });
    expect(foreign.seeds).toEqual([]);
  });

  it('beta sees none of alpha through any op, count, or diagnostic', () => {
    as(BETA);
    const v = verbs();
    for (const res of [
      v.memoryConnectedGraph({ op: 'neighbors', refs: ['mem:d1', 'topic:retry'] }),
      v.memoryConnectedGraph({ op: 'path', refs: ['mem:d1', 'sym:ledger#settle'] }),
      v.memoryConnectedGraph({ op: 'history', refs: ['mem:d1'] }),
      v.memoryConnectedGraph({ op: 'context', refs: ['mem:d1'] }),
    ]) {
      const { unresolvedRefs: _echo, from: _f, to: _t, ...rest } = res;
      const text = JSON.stringify(rest);
      expect(text).not.toContain('topic:retry');
      expect(text).not.toContain('sym:ledger');
      expect(text).not.toContain(about.id);
      expect(text).not.toContain(supersedes.id);
    }
  });
});

describe('memory_graph bounds and cursors', () => {
  it('applies the hop bound and says it bit', () => {
    const res = verbs().memoryConnectedGraph({ op: 'neighbors', refs: ['mem:d1'], hops: 0 });
    expect((res.expansions as unknown[]).length).toBe(1);
    const report = res.report as { truncated: boolean; truncationReasons: string[] };
    expect(report.truncated).toBe(true);
    expect(report.truncationReasons).toContain('hops');
  });

  it('binds continuation cursors to the generation, the query, and the principal', () => {
    const v = verbs();
    const first = v.memoryConnectedGraph({ op: 'neighbors', refs: ['mem:d1'], maxTokens: 120 });
    expect(typeof first.nextCursor).toBe('string');
    const cursor = first.nextCursor as string;

    const second = v.memoryConnectedGraph({
      op: 'neighbors',
      refs: ['mem:d1'],
      maxTokens: 120,
      cursor,
    });
    expect(second.error).toBeUndefined();
    expect(second.generation).toBe(first.generation);
    const firstRefs = (first.expansions as { ref: string }[]).map((e) => e.ref);
    const secondRefs = (second.expansions as { ref: string }[]).map((e) => e.ref);
    expect(secondRefs.some((r) => firstRefs.includes(r))).toBe(false);

    const otherQuery = v.memoryConnectedGraph({ op: 'neighbors', refs: ['topic:retry'], cursor });
    expect((otherQuery.error as { code: string }).code).toBe('CURSOR_STALE');

    as(BETA);
    const otherPrincipal = verbs().memoryConnectedGraph({
      op: 'neighbors',
      refs: ['mem:d1'],
      maxTokens: 120,
      cursor,
    });
    expect((otherPrincipal.error as { code: string }).code).toBe('CURSOR_STALE');

    as(ALPHA);
    local.submitGraphEntries([edge(ALPHA, 'about', 'mem:d1', 'topic:late', alphaSupport.ref)]);
    const moved = verbs().memoryConnectedGraph({
      op: 'neighbors',
      refs: ['mem:d1'],
      maxTokens: 120,
      cursor,
    });
    expect((moved.error as { code: string }).code).toBe('CURSOR_STALE');
    expect(moved.generation).not.toBe(first.generation);

    const garbage = verbs().memoryConnectedGraph({
      op: 'neighbors',
      refs: ['mem:d1'],
      cursor: '!!',
    });
    expect((garbage.error as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('names the same generation for the same authorized view', () => {
    const v = verbs();
    const a = v.memoryConnectedGraph({ op: 'neighbors', refs: ['mem:d1'] });
    const b = v.memoryConnectedGraph({ op: 'history', refs: ['topic:retry'] });
    expect(a.generation).toBe(b.generation);
  });
});

describe('memory_graph unavailable fallback', () => {
  it('falls back to plain recall with an explicit unavailable state and no generation', () => {
    vi.spyOn(MemoryApi.prototype, 'graphProjection').mockImplementation(() => {
      throw new Error('graph journal unreadable');
    });
    const res = verbs().memoryConnectedGraph({ op: 'search', q: 'retry' });
    expect(res.unavailable).toBe(true);
    expect(res.graph).toEqual({ state: 'unavailable', reason: 'graph journal unreadable' });
    expect(res.generation).toBeUndefined();
    expect(res.expansions).toBeUndefined();
    expect(res.recall).toBeDefined();

    const path = verbs().memoryConnectedGraph({ op: 'path', refs: ['mem:d1', 'topic:retry'] });
    expect(path.unavailable).toBe(true);
    expect(path.recall).toBeUndefined();
  });
});
