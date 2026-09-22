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
  memoryRecordId,
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
  scope: { boundary: 'global' } | { boundary: 'repo'; repoId: string } = { boundary: 'global' },
): GraphAssertion {
  return createGraphAssertion({
    predicate,
    subject,
    object,
    namespace: { principalId },
    scope,
    validAt: at,
    knownAt: at,
    supportedBy: [supporter],
    provenance: provenance(principalId),
  });
}

/** A minimal content-bearing record (claim + subject) the graph can seed from. */
function graphRecord(input: { subject: string; claim: string }) {
  const base = {
    kind: 'fact' as const,
    subject: input.subject,
    claim: input.claim,
    scope: { boundary: 'global' as const },
    appliesTo: [input.subject],
    evidence: [
      {
        kind: 'committed-policy' as const,
        verdict: 'valid' as const,
        checkedAt: T1,
        artifactId: 'artifact:docs/graph-seeds.md',
        anchor: 'docs/graph-seeds.md',
      },
    ],
    authorship: { actor: 'vitest', kind: 'agent' as const, tool: 'vitest' },
  };
  return {
    id: memoryRecordId(base),
    schemaVersion: '1' as const,
    ...base,
    verdicts: {
      trust: 'local' as const,
      evidence: 'valid' as const,
      applicability: 'current' as const,
      lifecycle: 'active' as const,
    },
    createdAt: T1,
  };
}

function as(principal: string): void {
  process.env.KCRIB_PRINCIPAL_ID = principal;
}

function verbs(): Verbs {
  const global = MemoryStore.global({
    env: { ...process.env, KCRIB_MEMORY_DIR: home },
    now: () => T1,
  });
  return new Verbs({ soul, index, repoRoot: repo, memory: { local, global } });
}

type Res = Record<string, unknown>;

let alphaSupport: ReturnType<typeof support>;
let about: GraphAssertion;
let appliesTo: GraphAssertion;
let supersedes: GraphAssertion;
let r1: ReturnType<typeof graphRecord>;
let r2: ReturnType<typeof graphRecord>;
let derived: GraphAssertion;

beforeEach(() => {
  previousPrincipal = process.env.KCRIB_PRINCIPAL_ID;
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-mem-graph-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  home = mkdtempSync(join(tmpdir(), 'mem-home-graph-'));
  __resetMemoryLockGuardForTest();
  // A FIXED repo id so repo-scope fixtures can name their placement deterministically.
  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: T1, repoId: REPO }) });
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
  // Two content-bearing records joined by an edge — the graph's only seedable content.
  r1 = graphRecord({
    subject: 'topic:retry',
    claim: 'Ledger retries must settle through the idempotent journal',
  });
  r2 = graphRecord({ subject: 'sym:ledger#charge', claim: 'Ledger charges must be idempotent' });
  local.upsertEntry('active', r1);
  local.upsertEntry('active', r2);
  derived = edge(ALPHA, 'affects', r1.id, r2.id, alphaSupport.ref);
  local.submitGraphEntries([
    alphaSupport,
    betaSupport,
    about,
    appliesTo,
    supersedes,
    foreign,
    derived,
  ]);
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

  it('search seeds only from content-bearing placed records and cites relations between seeds', () => {
    const res = verbs().memoryConnectedGraph({ op: 'search', q: 'retry ledger settle' });
    expect(res.seedScorer).toBe(
      'graph-seed-v3:placement-eligible+content-bearing+historical-traversal+pack-completion',
    );
    // No embedder is wired in this fixture: the missing channel is stated, never silent.
    expect(res.degraded).toEqual(['semantic-seed-channel-unavailable']);
    const seeds = (res.seeds as { ref: string; channel: string }[]).map((s) => s.ref);
    // WP2 S2 — the content-bearing records seed. The bare refs topic:retry and sym:ledger#settle
    // match this query only through ref fragments, and an identifier is not content.
    expect(seeds).toEqual(expect.arrayContaining([r1.id, r2.id]));
    expect(seeds).not.toContain('topic:retry');
    expect(seeds).not.toContain('sym:ledger#settle');
    expect(res.relations as { assertionId: string }[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ assertionId: derived.id })]),
    );
    as(BETA);
    const foreign = verbs().memoryConnectedGraph({ op: 'search', q: 'retry ledger settle' });
    expect(foreign.seeds).toEqual([]);
  });

  it('fuses a semantic seed channel when an embedder is installed, over authorized nodes only', () => {
    // A toy embedder whose one axis treats "finality" as "settle". The query 'finality' matches
    // no node text lexically and no FTS token, so the semantic channel is the ONLY channel that
    // can rank the record — the fuse label below is therefore deterministic.
    const embedder = {
      id: 'toy-embedder',
      dim: () => 2,
      embed: (text: string) => embedder.embedBatch([text])[0] as Float32Array,
      embedBatch: (texts: string[]) =>
        texts.map((text) =>
          /settle|finality/i.test(text) ? Float32Array.of(1, 0) : Float32Array.of(0, 1),
        ),
    };
    const v = new Verbs({ soul, index, repoRoot: repo, memory: { local, embedder } });
    const res = v.memoryConnectedGraph({ op: 'search', q: 'finality' });
    expect(res.degraded).toEqual([]);
    const seeds = res.seeds as { ref: string; channel: string }[];
    expect(seeds[0]).toMatchObject({ ref: r1.id, channel: 'semantic' });
    expect(seeds.some((s) => s.channel === 'semantic')).toBe(true);
    expect(JSON.stringify(res)).not.toContain('beta');
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

describe('memory graph_propose (WP-G4 explicit proposals)', () => {
  it('admits an authorized proposal, stamps the server principal, and serves it at once', () => {
    const v = verbs();
    const res = v.memoryGraphPropose({
      predicate: 'affects',
      subject: 'topic:retry',
      object: 'sym:ledger#charge',
      supportedBy: [alphaSupport.ref],
      actor: 'agent:proposer',
      scopeBoundary: 'global',
      validAt: T2,
    });
    expect(res).toMatchObject({ ok: true, admitted: true, idempotent: false });
    const again = v.memoryGraphPropose({
      predicate: 'affects',
      subject: 'topic:retry',
      object: 'sym:ledger#charge',
      supportedBy: [alphaSupport.ref],
      actor: 'agent:proposer',
      scopeBoundary: 'global',
      validAt: T2,
    });
    expect(again).toMatchObject({ ok: true, id: res.id });

    const neighbors = v.memoryConnectedGraph({ op: 'neighbors', refs: ['topic:retry'], hops: 1 });
    expect(JSON.stringify(neighbors)).toContain('sym:ledger#charge');
    const stored = MemoryStore.global({ env: { ...process.env, KCRIB_MEMORY_DIR: home } })
      .readCollection('graph')
      .entries.find((e) => e.id === res.id) as GraphAssertion | undefined;
    expect(stored?.namespace.principalId).toBe(ALPHA);
    expect(stored?.provenance.actorId).toBe('agent:proposer');

    as(BETA);
    expect(
      JSON.stringify(verbs().memoryConnectedGraph({ op: 'neighbors', refs: ['topic:retry'] })),
    ).not.toContain('sym:ledger#charge');
  });

  it('refuses unauthorized support, unknown predicates, non-refs and self-edges without writing', () => {
    const before = local.readCollection('graph').entries.length;
    const problems = (res: Record<string, unknown>) =>
      (res.error as { problems: string[] } | undefined)?.problems ?? [];
    as(BETA);
    const foreign = verbs().memoryGraphPropose({
      predicate: 'about',
      subject: 'mem:d1',
      object: 'topic:stolen',
      supportedBy: [alphaSupport.ref],
      actor: 'agent:beta',
      scopeBoundary: 'global',
    });
    expect(foreign.ok).toBe(false);
    expect(problems(foreign)).toContain(`supporter-not-authorized:${alphaSupport.ref}`);

    as(ALPHA);
    const bad = verbs().memoryGraphPropose({
      predicate: 'likes',
      subject: 'not a ref',
      object: 'not a ref',
      supportedBy: [],
      actor: 'agent:alpha',
      scopeBoundary: 'global',
    });
    expect(problems(bad)).toEqual(
      expect.arrayContaining([
        'unknown-predicate:likes',
        'not-a-graph-ref:subject',
        'not-a-graph-ref:object',
        'self-edge',
        'no-supporting-evidence',
      ]),
    );
    // An entity carries no recorded time, so valid time must be stated — never invented.
    const timeless = verbs().memoryGraphPropose({
      predicate: 'about',
      subject: 'mem:d1',
      object: 'topic:timeless',
      supportedBy: [alphaSupport.ref],
      actor: 'agent:alpha',
      scopeBoundary: 'global',
    });
    expect(problems(timeless)).toEqual(['valid-at-required']);
    expect(local.readCollection('graph').entries.length).toBe(before);
  });
});

describe('memory_graph view cache', () => {
  it('never serves a retracted supporter from a warm cache', () => {
    const input = {
      kind: 'fact' as const,
      subject: 'topic:cache',
      claim: 'the cache must drop retracted support at once',
      scope: { boundary: 'global' as const },
      appliesTo: ['topic:cache'],
      evidence: [
        {
          kind: 'committed-policy' as const,
          verdict: 'valid' as const,
          checkedAt: T1,
          artifactId: 'artifact:docs/cache.md',
          anchor: 'docs/cache.md',
        },
      ],
      authorship: { actor: 'vitest', kind: 'agent' as const, tool: 'vitest' },
    };
    const supporter = {
      id: memoryRecordId(input),
      schemaVersion: '1' as const,
      ...input,
      verdicts: {
        trust: 'local' as const,
        evidence: 'valid' as const,
        applicability: 'current' as const,
        lifecycle: 'active' as const,
      },
      createdAt: T1,
    };
    local.upsertEntry('active', supporter);
    local.submitGraphEntries([
      edge(ALPHA, 'affects', 'topic:cache', 'sym:cached#fn', supporter.id),
    ]);
    const v = verbs();
    const warm = v.memoryConnectedGraph({ op: 'neighbors', refs: ['topic:cache'] });
    expect(JSON.stringify(warm)).toContain('sym:cached#fn');
    expect(v.memoryConnectedGraph({ op: 'neighbors', refs: ['topic:cache'] }).generation).toBe(
      warm.generation,
    );

    expect(v.memoryDelete({ id: supporter.id, actor: 'agent:vitest' }).ok).toBe(true);
    const after = v.memoryConnectedGraph({ op: 'neighbors', refs: ['sym:cached#fn'] });
    expect(JSON.stringify(after)).not.toContain('topic:cache');
    expect(after.unresolvedRefs).toEqual(['sym:cached#fn']);
  });
});

describe('memory_graph WP2 placement laws (S2/S3)', () => {
  it('the recall channel cannot seed a foreign-placed record at repo scope (S2 fuse is not vacuous)', () => {
    // This is the gate the frozen corpora cannot exercise. There, every fixture is a memory-3
    // record and the only thing that makes one recall-eligible is a bound legacy alias, so the
    // recall channel's seed set is redundant with the lexical channel's — a regression that broke
    // ONLY this gate would move no measured number. So the gate is proven here instead.
    //
    // The recall channel is a THIRD channel into the seed funnel, and its hits are the least
    // trustworthy: they come from plain recall, which answers by PLACEMENT (a repo query lawfully
    // returns global records). Pre-fix, every recall hit became a distance-0 seed with no scope or
    // content check, so a global decoy reached repo answers directly.
    const foreign = graphRecord({
      subject: 'topic:foreign',
      claim: 'Foreign settlement idempotency lore',
    });
    const repoWork = graphRecord({
      subject: 'topic:repo-2',
      claim: 'Repo two settlement retries the ledger',
    });
    local.upsertEntry('active', foreign);
    local.upsertEntry('active', repoWork);
    local.submitGraphEntries([
      // Global placement only — nothing repo-scoped names it.
      edge(ALPHA, 'about', foreign.id, 'topic:foreign', alphaSupport.ref),
      edge(ALPHA, 'applies-to', 'topic:repo-2', repoWork.id, alphaSupport.ref, T1, {
        boundary: 'repo',
        repoId: REPO,
      }),
    ]);

    const v = verbs();
    const real = v.memorySearch.bind(v);
    // Inject the foreign record at RANK 1 of the recall channel — above any threshold, so no
    // floor can be what excludes it. Real behavior is preserved for every other hit.
    vi.spyOn(v, 'memorySearch').mockImplementation((args) => {
      const response = real(args) as { hits?: unknown[] };
      return { ...response, hits: [{ id: foreign.id, score: 99 }, ...(response.hits ?? [])] };
    });

    const res = v.memoryConnectedGraph({
      op: 'context',
      q: 'settlement retries idempotency ledger',
      scope: 'repo',
    });
    const seeds = (res.seeds as { ref: string }[]).map((s) => s.ref);
    // The lawful repo seed survives; the foreign record is dropped AT THE FUSE, before expansion.
    expect(seeds).toContain(repoWork.id);
    expect(seeds).not.toContain(foreign.id);
    expect(JSON.stringify(res)).not.toContain(foreign.id);

    // Same record, same recall hit, GLOBAL scope: now it IS placed here, so the channel admits it.
    // (Proof the drop is the placement law and not a blanket refusal of recall seeds.)
    const globalSeeds = (
      v.memoryConnectedGraph({ op: 'context', q: 'settlement retries idempotency ledger' })
        .seeds as { ref: string }[]
    ).map((s) => s.ref);
    expect(globalSeeds).toContain(foreign.id);
  });

  it('repo-scope context excludes a visible-but-unconnected global decoy; plain search keeps it', () => {
    // The decoy is a global record joined to its topic by a global edge: VISIBLE at repo scope,
    // but nothing repo-scoped places it there. The repo record is placed by a repo-scoped edge.
    const decoy = graphRecord({ subject: 'topic:decoy', claim: 'The decoy settlement journal' });
    const repoWork = graphRecord({
      subject: 'topic:repo-work',
      claim: 'Repo work retries the ledger',
    });
    const decoyEdge = edge(ALPHA, 'about', decoy.id, 'topic:decoy', alphaSupport.ref);
    const repoEdge = edge(
      ALPHA,
      'applies-to',
      'topic:repo-work',
      repoWork.id,
      alphaSupport.ref,
      T1,
      {
        boundary: 'repo',
        repoId: REPO,
      },
    );
    local.upsertEntry('active', decoy);
    local.upsertEntry('active', repoWork);
    local.submitGraphEntries([decoyEdge, repoEdge]);

    const v = verbs();
    const res = v.memoryConnectedGraph({
      op: 'context',
      q: 'decoy settlement retries ledger',
      scope: 'repo',
    });
    const seeds = (res.seeds as { ref: string }[]).map((s) => s.ref);
    const context = res.context as { items: { ref: string }[]; assertions: { id: string }[] };
    expect(seeds).toEqual([repoWork.id]);
    expect(context.items.map((i) => i.ref)).toEqual([repoWork.id, 'topic:repo-work']);
    expect(context.assertions.map((a) => a.id)).toEqual([repoEdge.id]);
    expect(JSON.stringify(res)).not.toContain(decoy.id);

    // The law bounds the GRAPH channel, not recall: plain memorySearch still returns the decoy.
    const search = v.memorySearch({ q: 'decoy settlement' });
    const hits = (search.hits as { id: string }[]).map((h) => h.id);
    expect(hits).toContain(decoy.id);
  });

  it('an explicit authorized global ref still seeds neighbors and path at repo scope', () => {
    // The documented S2/S3 bypass: explicit refs name what the caller wants, so the seed itself is
    // exempt — but the repo view still refuses to CARRY arrivals no repo-scoped edge places there.
    const decoy = graphRecord({ subject: 'topic:decoy', claim: 'The decoy settlement journal' });
    const decoyEdge = edge(ALPHA, 'about', decoy.id, 'topic:decoy', alphaSupport.ref);
    local.upsertEntry('active', decoy);
    local.submitGraphEntries([decoyEdge]);

    const v = verbs();
    const neighbors = v.memoryConnectedGraph({ op: 'neighbors', refs: [decoy.id], scope: 'repo' });
    const refs = (neighbors.expansions as { ref: string }[]).map((e) => e.ref);
    expect(refs).toEqual([decoy.id]);
    expect(neighbors.unavailable).toBe(false);

    // path answers over the whole authorized projection — it is not item-filtered.
    const path = v.memoryConnectedGraph({
      op: 'path',
      refs: [decoy.id, 'topic:decoy'],
      scope: 'repo',
    });
    expect((path.path as { assertionId: string }[]).map((s) => s.assertionId)).toEqual([
      decoyEdge.id,
    ]);
  });

  it('a shared topic resolves to the record placed in the caller scope, not its global twin', () => {
    // applies-to is not functional (two assertions may target the same subject), so the repo-placed
    // and globally-placed twins coexist without a conflict — placement alone separates them.
    const repoShared = graphRecord({
      subject: 'topic:shared',
      claim: 'The repo record about shared settlement',
    });
    const globalShared = graphRecord({
      subject: 'topic:shared',
      claim: 'The global record about shared settlement',
    });
    local.upsertEntry('active', repoShared);
    local.upsertEntry('active', globalShared);
    local.submitGraphEntries([
      edge(ALPHA, 'applies-to', 'topic:shared', repoShared.id, alphaSupport.ref, T1, {
        boundary: 'repo',
        repoId: REPO,
      }),
      edge(ALPHA, 'applies-to', 'topic:shared', globalShared.id, alphaSupport.ref),
    ]);

    const v = verbs();
    const repoView = v.memoryConnectedGraph({
      op: 'context',
      q: 'shared settlement',
      scope: 'repo',
    });
    const repoItems = ((repoView.context as { items: { ref: string }[] }).items ?? []).map(
      (i) => i.ref,
    );
    expect(repoItems).toContain(repoShared.id);
    expect(JSON.stringify(repoView)).not.toContain(globalShared.id);

    // The mirror at global scope: only the GLOBAL twin is seed-eligible — the repo twin's only
    // edge is repo-scoped, invisible here, so the global view never carries it at all (S2 Law A).
    const globalView = v.memoryConnectedGraph({ op: 'context', q: 'shared settlement' });
    const globalSeeds = (globalView.seeds as { ref: string }[]).map((s) => s.ref);
    expect(globalSeeds).toContain(globalShared.id);
    expect(globalSeeds).not.toContain(repoShared.id);
    expect(JSON.stringify(globalView)).not.toContain(repoShared.id);
  });
});
