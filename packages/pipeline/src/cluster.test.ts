import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { edgeId } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGraph, louvain } from './cluster/index.js';
import { indexRepo } from './pipeline.js';

let repo: string;
function soulFor(): SoulStore {
  const s = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  s.load();
  return s;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-cluster-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('Louvain (pure algorithm)', () => {
  it('splits two cliques joined by a single bridge into two communities', () => {
    // clique A: 0-1-2 fully connected; clique B: 3-4-5 fully connected; bridge 2-3.
    const edges: Array<[number, number, number]> = [
      [0, 1, 1],
      [0, 2, 1],
      [1, 2, 1],
      [3, 4, 1],
      [3, 5, 1],
      [4, 5, 1],
      [2, 3, 1],
    ];
    const g = buildGraph(6, edges);
    const labels = louvain(g);
    const a = new Set([0, 1, 2].map((i) => labels[i]));
    const b = new Set([3, 4, 5].map((i) => labels[i]));
    // within-clique nodes share a label; the two cliques differ.
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
    expect([...a][0]).not.toBe([...b][0]);
  });

  it('is deterministic — identical input yields identical labels', () => {
    const edges: Array<[number, number, number]> = [
      [0, 1, 1],
      [1, 2, 1],
      [2, 0, 1],
      [3, 4, 1],
      [4, 5, 1],
      [5, 3, 1],
      [2, 3, 1],
    ];
    const a = louvain(buildGraph(6, edges));
    const b = louvain(buildGraph(6, edges));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('runCluster (M7 structural clustering)', () => {
  function tsRepo(): string {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'auth.ts'),
      [
        'export class AuthService {',
        '  login(): void { this.issue(); }',
        '  issue(): void { log(); }',
        '}',
        'export function log(): void {}',
      ].join('\n'),
    );
    return repo;
  }

  it('emits cluster nodes + member-of edges for connected symbols', async () => {
    const soul = soulFor();
    await indexRepo(soul, tsRepo(), { now: '2026-01-01T00:00:00.000Z' });

    const clusters = [...soul.iterate('cluster')];
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const memberOf = [...soul.iterateEdges('member-of')].filter((e) => {
      // symbol → cluster member-of (dst is a cluster node), distinct from column→table member-of
      return soul.getNode(e.dst)?.kind === 'cluster';
    });
    expect(memberOf.length).toBeGreaterThanOrEqual(2);
    // every member-of edge is EXTRACTED, static, confidence 1.0
    for (const e of memberOf) {
      expect(e.rel).toBe('member-of');
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.method).toBe('static');
      expect(e.confidence).toBe(1);
    }
    // cluster node carries a deterministic slug id + a members list matching its edges
    const c = clusters[0]!;
    expect(c.id).toMatch(/^c:auto-[0-9a-f]{12}$/);
    expect(c.members?.length).toBeGreaterThanOrEqual(2);
    for (const memberId of c.members ?? []) {
      expect(soul.getEdge(edgeId(memberId, c.id, 'member-of'))).toBeDefined();
    }
  });

  it('is byte-identical across runs (deterministic cluster ids + member-of)', async () => {
    const a = soulFor();
    await indexRepo(a, tsRepo(), { now: '2026-01-01T00:00:00.000Z' });
    const aClusters = [...a.iterate('cluster')].sort((x, y) => (x.id < y.id ? -1 : 1));
    const aEdges = [...a.iterateEdges('member-of')]
      .filter((e) => a.getNode(e.dst)?.kind === 'cluster')
      .map((e) => e.id)
      .sort();

    const b = soulFor();
    await indexRepo(b, tsRepo(), { now: '2026-02-02T00:00:00.000Z' }); // different timestamp
    const bClusters = [...b.iterate('cluster')].sort((x, y) => (x.id < y.id ? -1 : 1));
    const bEdges = [...b.iterateEdges('member-of')]
      .filter((e) => b.getNode(e.dst)?.kind === 'cluster')
      .map((e) => e.id)
      .sort();

    expect(bClusters.map((c) => c.id)).toEqual(aClusters.map((c) => c.id));
    expect(bClusters.map((c) => c.members)).toEqual(aClusters.map((c) => c.members));
    expect(bEdges).toEqual(aEdges);
  });

  it('co-clusters symbols joined by calls/imports', async () => {
    const soul = soulFor();
    await indexRepo(soul, tsRepo(), { now: '2026-01-01T00:00:00.000Z' });
    // AuthService.login calls AuthService.issue (member-of same cluster).
    const login = [...soul.iterate('symbol')].find((n) => n.qualifiedName === 'AuthService.login')!;
    const issue = [...soul.iterate('symbol')].find((n) => n.qualifiedName === 'AuthService.issue')!;
    const clusters = [...soul.iterate('cluster')];
    const loginCluster = clusters.find((c) => c.members?.includes(login.id));
    expect(loginCluster?.members).toContain(issue.id);
  });

  it('opts out cleanly when cluster: false', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, tsRepo(), {
      now: '2026-01-01T00:00:00.000Z',
      cluster: false,
    });
    expect(report.cluster.communities).toBe(0);
    expect([...soul.iterate('cluster')]).toHaveLength(0);
  });
});
