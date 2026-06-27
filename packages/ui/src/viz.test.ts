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

    expect(graph.stats).toEqual({ nodes: 2, edges: 2, clusters: 1 });
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
