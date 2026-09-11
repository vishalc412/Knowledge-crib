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
} from '@knowledge-crib/memory';
import { type Node, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
