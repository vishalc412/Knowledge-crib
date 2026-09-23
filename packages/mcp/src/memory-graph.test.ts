/**
 * A memory write reaches the graph — in the same process, with no reindex.
 *
 * Reported from real use: reading memory worked, writing did not. An agent's `memory_observe`
 * staged a candidate nobody admitted, recall came back empty, and nothing in `context` or `impact`
 * showed the claim was about the code at all. These tests pin the full loop an agent sees:
 * write → recallable → linked to the symbol it cites → counted by status — plus the pending path,
 * where a claim crib will not vouch for is still visible in the graph and labelled untrusted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  MemoryEvaluator,
  MemoryStore,
  SoulStoreSoulPort,
  __resetMemoryLockGuardForTest,
  buildGraphContextPack,
  createGraphAssertion,
  expandFromSeeds,
  projectGraph,
} from '@knowledge-crib/memory';
import type { GraphAssertion, GraphProjection, MemoryGraphPredicate } from '@knowledge-crib/memory';
import { type Node, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fitGraphContext, recallSeeds, timeBoundRecallSeeds } from './memory-graph.js';
import { estimateTokens } from './token-budget.js';
import { Verbs } from './verbs.js';

const NOW = '2026-09-11T00:00:00.000Z';
const REPO_ID = 'r-memory-graph';
const FILE = 'src/team.ts';
const SOURCE = [
  'export class Team {',
  '  get displayNumber() {',
  '    return this.cached;',
  '  }',
  '}',
  'export const TEAM_LIMIT = 8;',
  '',
].join('\n');

/** The file node the indexer emits for every file — span-less; its hash is the content hash. */
const FILE_NODE: Node = {
  id: idFor({ kind: 'file', path: FILE }),
  kind: 'file',
  file: FILE,
  lang: 'typescript',
  hash: `blake3:${'c'.repeat(64)}`,
} as Node;

const SYMBOL: Node = {
  id: idFor({ kind: 'symbol', path: FILE, qualifiedName: 'Team.displayNumber', startLine: 2 }),
  kind: 'symbol',
  type: 'method',
  name: 'displayNumber',
  qualifiedName: 'Team.displayNumber',
  file: FILE,
  span: { start: 2, end: 4 },
  lang: 'typescript',
  hash: `blake3:${'b'.repeat(64)}`,
} as Node;

let repo: string;
let home: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memgraph-'));
  home = mkdtempSync(join(tmpdir(), 'crib-memgraph-home-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, FILE), SOURCE);
  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.putNodes([FILE_NODE, SYMBOL]);
  soul.commit(NOW);
  writeFileSync(
    join(repo, '.crib', 'crib.json'),
    JSON.stringify({ repo: { id: REPO_ID, root: '.' } }),
  );
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  __resetMemoryLockGuardForTest();
  const local = MemoryStore.local(REPO_ID, {
    repoRoot: repo,
    env: { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home },
    now: () => NOW,
  });
  verbs = new Verbs({
    soul,
    index,
    repoRoot: repo,
    memory: {
      local,
      evaluator: new MemoryEvaluator(),
      evalCtx: { soul: new SoulStoreSoulPort(soul, repo) },
    },
  });
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** The observation an agent writes: cite the code by path + line + the exact text. */
function observeGrounded(): Record<string, unknown> {
  return verbs.memoryObserve({
    kind: 'fact',
    subject: SYMBOL.id,
    claim: 'Team.displayNumber returns the cached value without recomputing it',
    appliesTo: [FILE],
    evidence: [{ kind: 'source-quote', path: FILE, line: 3, quote: 'return this.cached;' }],
    actor: 'claude-code',
    tool: 'test',
  });
}

describe('memory write → graph, same process, no reindex', () => {
  it('admits a grounded observation and says it is recallable', () => {
    const ack = observeGrounded();
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('active');
    expect(ack.recallable).toBe(true);
    expect(String(ack.recordId)).toMatch(/^mem:/);
  });

  it('context on the cited symbol lists the memory, linked through its evidence', () => {
    const ack = observeGrounded();
    const ctx = verbs.context({ id: SYMBOL.id });
    const memories = ctx.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ id: ack.recordId, status: 'active', trust: 'local' });
    expect(memories[0]?.via).toContain('supported-by');
  });

  it('impact on the symbol carries the memory an edit there could stale', () => {
    const ack = observeGrounded();
    const blast = verbs.impact({ id: SYMBOL.id, dir: 'up' });
    expect((blast.memories as Array<{ id: string }>).map((m) => m.id)).toEqual([ack.recordId]);
  });

  it('neighbors over the composite graph include the memory edges', () => {
    const ack = observeGrounded();
    const res = verbs.neighbors({ id: SYMBOL.id, includeLlm: true });
    const edges = res.edges as Array<Record<string, unknown>>;
    expect(edges.some((e) => e.src === ack.recordId && e.rel === 'supported-by')).toBe(true);
  });

  it('status counts the memory layer', () => {
    observeGrounded();
    const graph = verbs.status().graph as { memory?: { nodes: number; pending: number } };
    expect(graph.memory).toMatchObject({ nodes: 1, pending: 0 });
  });

  it('a claim crib will not vouch for is still in the graph — labelled pending and untrusted', () => {
    const ack = verbs.memoryObserve({
      kind: 'convention',
      subject: SYMBOL.id,
      claim: 'Never recompute displayNumber on read',
      appliesTo: [SYMBOL.id],
      actor: 'claude-code',
      tool: 'test',
    });
    expect(ack.status).toBe('pending');
    expect(ack.recallable).toBe(false);
    const memories = verbs.context({ id: SYMBOL.id }).memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ status: 'pending', trust: 'untrusted' });
    expect(memories[0]?.via).toEqual(['applies-to']);
    expect((verbs.status().graph as { memory: { pending: number } }).memory.pending).toBe(1);
  });

  it('admits a quote from a top-level declaration no symbol span covers, anchored to the file', () => {
    const ack = verbs.memoryObserve({
      kind: 'fact',
      subject: 'topic:team-limit',
      claim: 'Teams are capped at eight members by a module-level constant',
      appliesTo: [FILE],
      evidence: [
        { kind: 'source-quote', path: FILE, line: 6, quote: 'export const TEAM_LIMIT = 8;' },
      ],
      actor: 'claude-code',
      tool: 'test',
    });
    expect(ack.status).toBe('active');
    const memories = verbs.context({ id: FILE_NODE.id }).memories as Array<{ id: string }>;
    expect(memories.map((m) => m.id)).toContain(ack.recordId);
  });

  it('says a cited file is not indexed instead of claiming the quote was not found', () => {
    const ack = verbs.memoryObserve({
      kind: 'fact',
      subject: 'topic:new-file',
      claim: 'A file written after the last index',
      evidence: [{ kind: 'source-quote', path: 'src/brand-new.ts', line: 1, quote: 'export {}' }],
      actor: 'claude-code',
      tool: 'test',
    });
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toMatch(/not in the index/);
  });

  it('remembers a preference the user stated, relayed by the agent — recallable, labelled unconfirmed', () => {
    const ack = verbs.memoryObserve({
      kind: 'convention',
      subject: 'topic:package-manager',
      claim: 'Use pnpm instead of npm for every install command in this repository',
      evidence: [{ kind: 'human-attestation', quote: 'always use pnpm, never npm' }],
      actor: 'claude-code',
      tool: 'test',
    });
    expect(ack.status).toBe('active');
    expect(String((ack.admission as { reason: string }).reason)).toMatch(/relayed/);
    const recall = verbs.memoryRecall({ q: 'pnpm npm install command package manager' });
    const hit = (recall.memories as Array<Record<string, unknown>>).find((m) =>
      String(m.claim).includes('pnpm'),
    );
    expect(hit).toBeDefined();
    expect(JSON.stringify(hit)).toContain('degraded');
  });

  it('context carries no memories key when nothing was written about the code', () => {
    expect(verbs.context({ id: SYMBOL.id }).memories).toBeUndefined();
  });

  it('a context with no eligible seed answers an empty pack, never the unavailable shape', () => {
    const res = verbs.memoryConnectedGraph({ op: 'context', q: 'zzzz qqqq' });
    expect(res.unavailable).toBe(false);
    expect(res.graph).toBeUndefined();
    expect(typeof res.generation).toBe('string');
    expect(res.seedScorer).toBe(
      'graph-seed-v3:placement-eligible+content-bearing+historical-traversal+pack-completion',
    );
    const context = res.context as { items: unknown[]; assertions: unknown[] };
    expect(context.items).toEqual([]);
    expect(context.assertions).toEqual([]);
  });
});

// ─── WP2 S2/S5: recall seeds and pack completion, pure over a small projection ────────────────

const SF_ALPHA = 'principal:sf';
const SF_T1 = '2026-09-01T00:00:00.000Z';
const SF_T3 = '2026-09-10T00:00:00.000Z';
const SF_VIEWER = { principalId: SF_ALPHA, scope: { boundary: 'global' as const } };

function sfEdge(
  predicate: MemoryGraphPredicate,
  subject: string,
  object: string,
  supporter: string,
  at = SF_T1,
): GraphAssertion {
  return createGraphAssertion({
    predicate,
    subject,
    object,
    namespace: { principalId: SF_ALPHA },
    scope: { boundary: 'global' },
    validAt: at,
    knownAt: at,
    supportedBy: [supporter],
    provenance: {
      principalId: SF_ALPHA,
      deviceId: 'device:sf',
      actorId: 'agent:sf',
      clientId: 'vitest',
    },
  });
}

/** The S5 fixtures never filter by scope: seeds are explicit, so eligibility is not in play. */
function sfProjection(edges: GraphAssertion[]): GraphProjection {
  return projectGraph(
    {
      assertions: edges,
      records: [
        { id: 'mem:a' },
        { id: 'mem:b' },
        { id: 'mem:c' },
        { id: 'mem:d1' },
        { id: 'mem:late' },
      ],
    },
    SF_VIEWER,
  );
}

describe('WP2 recall seed laws (S2)', () => {
  it('recallSeeds admits only string ids carrying a positive numeric score', () => {
    const recalled = {
      hits: [
        { id: 'mem:good', score: 2 },
        { id: 'mem:zero', score: 0 },
        { id: 'mem:negative', score: -1 },
        { id: 42, score: 2 },
        { score: 1 },
      ],
    };
    expect(recallSeeds(recalled)).toEqual([{ ref: 'mem:good', score: 2, channel: 'semantic' }]);
    expect(recallSeeds(undefined)).toEqual([]);
    expect(recallSeeds({})).toEqual([]);
    expect(recallSeeds({ hits: 'not-an-array' })).toEqual([]);
  });

  it('timeBoundRecallSeeds passes recall through at a live read and walls a historical one', () => {
    const past = sfEdge('about', 'mem:d1', 'topic:retry', 'mem:d1');
    // Recorded only after the read point: a recall hit for it must not re-enter a T-windowed view.
    const late = sfEdge('about', 'mem:late', 'topic:retry', 'mem:late', SF_T3);
    const live = projectGraph({ assertions: [past], records: [{ id: 'mem:d1' }] }, SF_VIEWER);
    const seeds = [{ ref: 'mem:d1', score: 1, channel: 'semantic' as const }];
    expect(timeBoundRecallSeeds(live, seeds)).toBe(seeds);

    const windowed = projectGraph(
      { assertions: [past, late], records: [{ id: 'mem:d1' }, { id: 'mem:late' }] },
      SF_VIEWER,
      { at: '2026-09-05T00:00:00.000Z' },
    );
    const recall = [
      { ref: 'mem:d1', score: 1, channel: 'semantic' as const },
      { ref: 'mem:late', score: 0.5, channel: 'semantic' as const },
    ];
    expect(timeBoundRecallSeeds(windowed, recall)).toEqual([recall[0]]);
  });
});

describe('WP2 pack completion (S5)', () => {
  /** A cost oracle over the REBUILT pack — the same shape fitGraphContext serializes, with a
   * fixed five-digit budgetTokens so the measured maxTokens never changes the measured cost. */
  function sfCost(
    projection: GraphProjection,
    expanded: ReturnType<typeof expandFromSeeds>,
    refs: string[],
  ): number {
    const picked = expanded.expansions.filter((e) => refs.includes(e.ref));
    return estimateTokens(
      JSON.stringify({
        context: buildGraphContextPack(projection, picked, expanded.report, {
          budgetTokens: 99999,
        }),
        budgetExhausted: true,
      }),
    );
  }

  it("completion regains a trimmed partner's connection, skipping the expensive middle item", () => {
    const affects = sfEdge('affects', 'mem:a', 'mem:b', 'mem:a');
    const projection = sfProjection([affects]);
    const junkRef = `topic:${'j'.repeat(1200)}`;
    const expanded = expandFromSeeds(projection, [
      { ref: 'mem:a', score: 1, channel: 'explicit' as const },
      { ref: 'topic:j1', score: 0.9, channel: 'explicit' as const },
      { ref: 'topic:j2', score: 0.8, channel: 'explicit' as const },
      { ref: junkRef, score: 0.7, channel: 'explicit' as const },
      { ref: 'mem:b', score: 0.6, channel: 'explicit' as const },
    ]);
    expect(expanded.expansions.map((e) => e.ref)).toEqual([
      'mem:a',
      'topic:j1',
      'topic:j2',
      junkRef,
      'mem:b',
    ]);

    // The budget that fits [A, J1, J2, B] but NOT [A, J1, J2, junk]: the prefix fit must stop at
    // [A, J1, J2] — the junk wall — and completion must state the A→B connection over the junk.
    const maxTokens = sfCost(projection, expanded, ['mem:a', 'topic:j1', 'topic:j2', 'mem:b']);
    expect(
      sfCost(projection, expanded, ['mem:a', 'topic:j1', 'topic:j2', junkRef]),
    ).toBeGreaterThan(maxTokens);

    const done = fitGraphContext(projection, expanded, maxTokens);
    const context = done.context as {
      items: { ref: string }[];
      relations: string[];
      assertions: { id: string; status: string; supportedBy: string[]; producer: number }[];
      producers: { actorId: string }[];
    };
    // Round-2 order: appends run FIRST, so the partner itself is appended (stating the
    // connection as its relation, plus the item), and the citation channel then finds the
    // connection already stated. The junk wall stays out: the pack fits exactly.
    expect(context.items.map((i) => i.ref)).toEqual(['mem:a', 'topic:j1', 'topic:j2', 'mem:b']);
    expect(context.relations).toEqual([affects.id]);
    expect(context.assertions).toEqual([
      {
        id: affects.id,
        predicate: 'affects',
        subject: 'mem:a',
        object: 'mem:b',
        supportedBy: ['mem:a'],
        validAt: SF_T1,
        knownAt: SF_T1,
        status: 'current',
        producer: 0,
      },
    ]);
    expect(context.producers.map((p) => p.actorId)).toEqual(['agent:sf']);
    expect(done.budgetExhausted).toBe(true);

    const without = fitGraphContext(projection, expanded, maxTokens, { completion: false });
    const plain = without.context as { assertions: unknown[]; relations: string[] };
    expect(plain.assertions).toEqual([]);
    expect(plain.relations).toEqual([]);
    expect(without.budgetExhausted).toBe(true);
  });

  it('completion chains an append to the partner it unlocks and never reorders the prefix fit', () => {
    const affects = sfEdge('affects', 'mem:a', 'mem:m', 'mem:a');
    const applies = sfEdge('applies-to', 'mem:m', 'topic:q', 'mem:a');
    // Valid only after the view point: history M alone would newly state if M were appended.
    const later = sfEdge('about', 'mem:m', 'topic:old', 'mem:m', SF_T3);
    const projection = projectGraph(
      {
        assertions: [affects, applies, later],
        records: [
          { id: 'mem:a' },
          { id: 'mem:b' },
          { id: 'mem:c' },
          { id: 'mem:d1' },
          { id: 'mem:late' },
          { id: 'mem:m' },
        ],
      },
      SF_VIEWER,
      { at: '2026-09-05T00:00:00.000Z' },
    );
    const wallRef = `topic:${'x'.repeat(1600)}`;
    const expanded = expandFromSeeds(projection, [
      { ref: 'mem:a', score: 1, channel: 'explicit' as const },
      { ref: 'topic:x1', score: 0.9, channel: 'explicit' as const },
      { ref: wallRef, score: 0.8, channel: 'explicit' as const },
      { ref: 'topic:q', score: 0.7, channel: 'explicit' as const },
    ]);
    expect(expanded.expansions.map((e) => e.ref)).toEqual([
      'mem:a',
      'topic:x1',
      wallRef,
      'topic:q',
      'mem:m',
    ]);

    // The budget of the full four-item pack: [A, x1] prefix + M and Q if both were appended.
    // The wall breaks the prefix at [A, x1]; from there the round-2 queue appends M — its
    // history alone would newly state — and M being kept lets pass 1's citation channel state
    // the M→Q connection, which in turn makes Q's own append zero-information: the connection
    // is stated, the item is not. (Q's append is never queued in pass 1 — at queue-build time
    // M is not yet kept, so Q would state nothing new.)
    const maxTokens = sfCost(projection, expanded, ['mem:a', 'topic:x1', 'mem:m', 'topic:q']);
    expect(sfCost(projection, expanded, ['mem:a', 'topic:x1', wallRef])).toBeGreaterThan(maxTokens);

    const done = fitGraphContext(projection, expanded, maxTokens);
    const context = done.context as {
      items: { ref: string }[];
      relations: string[];
      assertions: { id: string; status: string }[];
    };
    // The prefix keeps its fit order; M appends at the end, Q is never an item.
    expect(context.items.map((i) => i.ref)).toEqual(['mem:a', 'topic:x1', 'mem:m']);
    expect(context.relations).toEqual([affects.id]);
    const byId = new Map(context.assertions.map((a) => [a.id, a]));
    expect(byId.get(affects.id)?.status).toBe('current');
    expect(byId.get(applies.id)?.status).toBe('current');
    expect(byId.get(later.id)?.status).toBe('historical');
    expect(done.budgetExhausted).toBe(true);

    const without = fitGraphContext(projection, expanded, maxTokens, { completion: false });
    const plain = without.context as { items: { ref: string }[]; relations: string[] };
    expect(plain.items.map((i) => i.ref)).toEqual(['mem:a', 'topic:x1']);
    expect(plain.relations).toEqual([]);
  });

  it('completion never overflows the budget it was given', () => {
    const affects = sfEdge('affects', 'mem:a', 'mem:b', 'mem:a');
    const projection = sfProjection([affects]);
    const expanded = expandFromSeeds(projection, [
      { ref: 'mem:a', score: 1, channel: 'explicit' as const },
      { ref: 'mem:b', score: 0.6, channel: 'explicit' as const },
    ]);
    const maxTokens = sfCost(projection, expanded, ['mem:a']);

    const done = fitGraphContext(projection, expanded, maxTokens);
    const context = done.context as { items: { ref: string }[]; relations: string[] };
    expect(context.items.map((i) => i.ref)).toEqual(['mem:a']);
    expect(context.relations).toEqual([]);
    expect(done.budgetExhausted).toBe(true);
  });

  it('completion is a no-op when the prefix fit kept everything', () => {
    const affects = sfEdge('affects', 'mem:a', 'mem:b', 'mem:a');
    const projection = sfProjection([affects]);
    const expanded = expandFromSeeds(projection, [
      { ref: 'mem:a', score: 1, channel: 'explicit' as const },
      { ref: 'mem:b', score: 0.6, channel: 'explicit' as const },
    ]);

    const done = fitGraphContext(projection, expanded, 100_000);
    const context = done.context as {
      items: { ref: string }[];
      relations: string[];
      traversal: { truncated: boolean };
    };
    expect(context.items.map((i) => i.ref)).toEqual(['mem:a', 'mem:b']);
    expect(context.relations).toEqual([affects.id]);
    expect(done.budgetExhausted).toBeUndefined();
    expect(context.traversal.truncated).toBe(false);
  });

  it('a zero-expansion read fits an empty pack without crashing', () => {
    const projection = sfProjection([]);
    const expanded = expandFromSeeds(projection, []);
    const done = fitGraphContext(projection, expanded, 2000);
    const context = done.context as { items: unknown[]; assertions: unknown[] };
    expect(context.items).toEqual([]);
    expect(context.assertions).toEqual([]);
    expect(done.budgetExhausted).toBeUndefined();
  });
});
