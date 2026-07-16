import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { vizAssetsDir } from './viz.js';

type Model = {
  buildIndexes: (nodes: NodeLike[], edges: EdgeLike[]) => Indexes;
  clusterProjection: (
    options: Record<string, unknown>,
    nodes: NodeLike[],
    edges: EdgeLike[],
    byId: Record<string, NodeLike>,
    indexes: Indexes,
  ) => Projection;
  searchProjection: (
    options: Record<string, unknown>,
    nodes: NodeLike[],
    edges: EdgeLike[],
    byId: Record<string, NodeLike>,
    indexes: Indexes,
  ) => SearchProjection;
};
type NodeLike = {
  id: string;
  cluster?: string;
  kind: string;
  importance?: number;
  label?: string;
  qualified?: string;
  file?: string;
  signature?: string;
  summary?: string;
};
type EdgeLike = { src: string; dst: string; rel: string };
type Indexes = {
  membersByCluster: Record<string, string[]>;
  incidentByNode: Record<string, number[]>;
  archAdj: Record<string, string[]>;
};
type Projection = {
  filteredMemberIds: string[];
  coreIds: string[];
  contextIds: string[];
  edgeIndexes: number[];
  totalCore: number;
};
type SearchProjection = {
  matchIds: string[];
  contextIds: string[];
  edgeIndexes: number[];
  totalMatches: number;
};

function loadModel(): Model {
  const context: Record<string, unknown> = {};
  context.globalThis = context;
  runInNewContext(readFileSync(`${vizAssetsDir()}/graph-model.js`, 'utf8'), context);
  return context.KCGraphModel as Model;
}

describe('cluster view projection', () => {
  it('isolates exact three functions until context is explicitly enabled', () => {
    const model = loadModel();
    const nodes: NodeLike[] = [
      { id: 'f1', cluster: 'c:rubric', kind: 'function', importance: 3 },
      { id: 'f2', cluster: 'c:rubric', kind: 'function', importance: 2 },
      { id: 'f3', cluster: 'c:rubric', kind: 'function', importance: 1 },
      ...Array.from({ length: 100 }, (_, i) => ({
        id: `n${i}`,
        cluster: 'other',
        kind: 'function',
        importance: i,
      })),
    ];
    const edges: EdgeLike[] = Array.from({ length: 100 }, (_, i) => ({
      src: 'f1',
      dst: `n${i}`,
      rel: 'calls',
    }));
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const indexes = model.buildIndexes(nodes, edges);

    const isolated = model.clusterProjection(
      { clusterId: 'c:rubric', kind: 'function' },
      nodes,
      edges,
      byId,
      indexes,
    );
    expect(isolated.totalCore).toBe(3);
    expect(new Set(isolated.coreIds)).toEqual(new Set(['f1', 'f2', 'f3']));
    expect(isolated.contextIds).toEqual([]);
    expect(isolated.edgeIndexes).toEqual([]);

    const contextual = model.clusterProjection(
      { clusterId: 'c:rubric', kind: 'function', showContext: true, contextCap: 60 },
      nodes,
      edges,
      byId,
      indexes,
    );
    expect(contextual.coreIds).toHaveLength(3);
    expect(contextual.contextIds).toHaveLength(60);
    expect(contextual.edgeIndexes).toHaveLength(60);
  });

  it('keeps full membership while capping canvas and promotes requested member', () => {
    const model = loadModel();
    const nodes: NodeLike[] = Array.from({ length: 205 }, (_, i) => ({
      id: `f${i}`,
      cluster: 'c:large',
      kind: 'function',
      importance: 205 - i,
    }));
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const indexes = model.buildIndexes(nodes, []);
    const projection = model.clusterProjection(
      { clusterId: 'c:large', coreCap: 200, promotedId: 'f204' },
      nodes,
      [],
      byId,
      indexes,
    );
    expect(projection.filteredMemberIds).toHaveLength(205);
    expect(projection.coreIds).toHaveLength(200);
    expect(projection.coreIds).toContain('f204');
  });
});

describe('search projection', () => {
  it('searches every graph size, ranks direct names first, and adds architectural context', () => {
    const model = loadModel();
    const nodes: NodeLike[] = [
      { id: 'exact', kind: 'function', label: 'cmdViz', importance: 1 },
      {
        id: 'summary',
        kind: 'function',
        label: 'startServer',
        summary: 'Starts cmdViz browser server',
        importance: 100,
      },
      { id: 'caller', kind: 'function', label: 'main', importance: 4 },
      { id: 'statement', kind: 'statement', label: 'cmdViz assignment', importance: 50 },
    ];
    const edges: EdgeLike[] = [
      { src: 'caller', dst: 'exact', rel: 'calls' },
      { src: 'statement', dst: 'exact', rel: 'member-of' },
    ];
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const indexes = model.buildIndexes(nodes, edges);

    const projection = model.searchProjection({ query: 'cmdviz' }, nodes, edges, byId, indexes);

    expect(projection.totalMatches).toBe(3);
    expect(projection.matchIds).toEqual(['exact', 'statement', 'summary']);
    expect(projection.contextIds).toEqual(['caller']);
    expect(projection.edgeIndexes).toEqual([0, 1]);
  });

  it('returns an explicit empty projection when nothing matches', () => {
    const model = loadModel();
    const nodes: NodeLike[] = [{ id: 'one', kind: 'file', label: 'README.md' }];
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const indexes = model.buildIndexes(nodes, []);

    const projection = model.searchProjection(
      { query: 'does-not-exist' },
      nodes,
      [],
      byId,
      indexes,
    );

    expect(projection.totalMatches).toBe(0);
    expect(projection.matchIds).toEqual([]);
    expect(projection.contextIds).toEqual([]);
  });
});
