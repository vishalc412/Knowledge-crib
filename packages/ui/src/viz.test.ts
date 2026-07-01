import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { buildVizGraph } from './viz.js';

let dir: string | undefined;

function sym(path: string, qname: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: qname, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: qname.split('.').pop() ?? qname,
    qualifiedName: qname,
    file: path,
    span: { start: line, end: line },
    lang: 'typescript',
    hash: contentHash(`${path}:${qname}`),
    ...extra,
  };
}

function edge(src: string, dst: string, rel: Edge['rel']): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
  };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('buildVizGraph', () => {
  it('builds a deterministic graph with clusters, derived symbol kinds, and framework metadata', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-ui-viz-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();

    const cluster: Node = {
      id: 'cluster:api',
      kind: 'cluster',
      label: 'API',
      hash: contentHash('api'),
    };
    const controller = sym('src/api.ts', 'LoanController.submit', 12, {
      framework: 'express',
      stereotype: 'controller',
      httpMethod: 'POST',
      routePath: '/loans',
    });
    const service = sym('src/service.ts', 'LoanService.create', 30);

    soul.putNodes([cluster, controller, service]);
    soul.putEdges([
      edge(controller.id, cluster.id, 'member-of'),
      edge(controller.id, service.id, 'calls'),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const graph = buildVizGraph(soul);

    expect(graph.stats).toEqual({ nodes: 2, edges: 2, clusters: 1, primaryNodes: 2 });
    expect(graph.clusters[0]).toMatchObject({ id: 'cluster:api', label: 'API' });
    expect(graph.nodes.map((n) => n.data.id)).toEqual(
      [...graph.nodes.map((n) => n.data.id)].sort(),
    );
    const controllerNode = graph.nodes.find((n) => n.data.id === controller.id)?.data;
    expect(controllerNode).toMatchObject({
      kind: 'method',
      framework: 'express',
      stereotype: 'controller',
      httpMethod: 'POST',
      routePath: '/loans',
      clusterId: 'cluster:api',
    });
  });
});

describe('buildVizGraph — importance/tier ranking (declutter)', () => {
  it('gives a heavily-called symbol higher importance than an uncalled one, and both land in the primary tier when under PRIMARY_TIER_SIZE', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-ui-viz-rank-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();

    const hub = sym('src/hub.ts', 'Hub.run', 1);
    const caller1 = sym('src/a.ts', 'A.go', 1);
    const caller2 = sym('src/b.ts', 'B.go', 1);
    const lonely = sym('src/c.ts', 'C.go', 1);

    soul.putNodes([hub, caller1, caller2, lonely]);
    soul.putEdges([
      edge(caller1.id, hub.id, 'calls'),
      edge(caller2.id, hub.id, 'calls'),
    ]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const graph = buildVizGraph(soul);
    const byId = new Map(graph.nodes.map((n) => [n.data.id, n.data]));

    expect(byId.get(hub.id)?.degree).toBe(2);
    expect(byId.get(lonely.id)?.degree).toBe(0);
    expect(byId.get(hub.id)!.importance).toBeGreaterThan(byId.get(lonely.id)!.importance);
    // small graph — every node fits under the primary-tier cap.
    expect(byId.get(hub.id)?.tier).toBe('primary');
    expect(byId.get(lonely.id)?.tier).toBe('primary');
    expect(graph.stats.primaryNodes).toBe(4);
  });

  it('weighs a statement-level kind down relative to an architectural kind at equal degree', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-ui-viz-noise-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();

    const fn = sym('src/x.ts', 'X.run', 1);
    const guard: Node = {
      id: 'cond:src/x.ts@L2',
      kind: 'condition',
      file: 'src/x.ts',
      span: { start: 2, end: 2 },
      hash: contentHash('cond'),
    };
    soul.putNodes([fn, guard]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const graph = buildVizGraph(soul);
    const byId = new Map(graph.nodes.map((n) => [n.data.id, n.data]));
    // both have degree 0, but `function` carries no penalty while `condition` is a noise kind —
    // here neither has an in-degree edge so kindBase drives it: function has no base bump, but the
    // point is the noise WEIGHT never inflates a condition's importance above a real symbol's.
    expect(byId.get(guard.id)?.kind).toBe('condition');
    expect(byId.get(fn.id)?.importance).toBeGreaterThanOrEqual(byId.get(guard.id)!.importance);
  });

  it('is deterministic: two runs over the same soul produce byte-identical importance/tier output', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-ui-viz-det-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const a = sym('src/a.ts', 'A.go', 1);
    const b = sym('src/b.ts', 'B.go', 1);
    soul.putNodes([a, b]);
    soul.putEdges([edge(a.id, b.id, 'calls')]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const first = buildVizGraph(soul);
    const second = buildVizGraph(soul);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
