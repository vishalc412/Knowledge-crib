import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { vizAssetsDir } from './viz.js';

type Model = {
  buildIndexes: (nodes: NodeLike[], edges: EdgeLike[]) => Indexes;
  focusLayout: (
    rootId: string,
    ring1Ids: string[],
    ring2Ids: string[],
    edges: EdgeLike[],
    indexes: Indexes,
    extraRings?: string[][],
  ) => FocusLayout;
  focusProjection: (
    rootId: string,
    maxDepth: number,
    indexes: Indexes,
    byId: Record<string, NodeLike>,
    caps?: number[],
    maxVisited?: number,
  ) => FocusProjection;
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
type FocusLayout = {
  positions: Record<string, { x: number; y: number }>;
  edgeIndexes: number[];
  backboneEdgeIndexes: number[];
  crossEdgeIndexes: number[];
  parentById: Record<string, string>;
};
type FocusProjection = {
  rings: string[][];
  countsByDepth: number[];
  hiddenByDepth: number[];
  truncated: boolean;
  truncatedAtDepth: number | null;
};

function loadModel(): Model {
  const context: Record<string, unknown> = {};
  context.globalThis = context;
  runInNewContext(readFileSync(`${vizAssetsDir()}/graph-model.js`, 'utf8'), context);
  return context.KCGraphModel as Model;
}

describe('selected-node focus layout', () => {
  it('lays out a stable radial backbone but retains every real visible architectural edge', () => {
    const root = 'root';
    const direct = Array.from({ length: 16 }, (_, i) => `direct-${i}`);
    const outer = Array.from({ length: 53 }, (_, i) => `outer-${i}`);
    const nodes = [root, ...direct, ...outer].map((id) => ({ id, kind: 'function' }));
    const edges: EdgeLike[] = [
      ...direct.map((id) => ({ src: root, dst: id, rel: 'calls' })),
      ...outer.map((id, i) => ({ src: direct[i % direct.length]!, dst: id, rel: 'calls' })),
      ...direct.slice(1).map((id) => ({ src: direct[0]!, dst: id, rel: 'calls' })),
      ...outer.map((id) => ({ src: root, dst: id, rel: 'references' })),
    ];
    const model = loadModel();
    const indexes = model.buildIndexes(nodes, edges);
    const layout = model.focusLayout(root, direct, outer, edges, indexes);

    expect(Object.keys(layout.positions)).toHaveLength(70);
    expect(layout.positions[root]).toEqual({ x: 0, y: 0 });
    expect(layout.backboneEdgeIndexes).toHaveLength(69);
    expect(layout.crossEdgeIndexes).toHaveLength(15);
    expect(layout.edgeIndexes).toHaveLength(84);
    expect(new Set(layout.edgeIndexes).size).toBe(84);
    expect(layout.edgeIndexes.every((index) => index < 84)).toBe(true);
    for (const id of direct) {
      expect(layout.parentById[id]).toBe(root);
      expect(Math.hypot(layout.positions[id]!.x, layout.positions[id]!.y)).toBeGreaterThan(200);
    }
    for (const id of outer) {
      expect(direct).toContain(layout.parentById[id]);
      const parent = layout.positions[layout.parentById[id]!]!;
      const point = layout.positions[id]!;
      expect(Math.hypot(point.x, point.y)).toBeGreaterThan(Math.hypot(parent.x, parent.y));
    }
    expect(model.focusLayout(root, direct, outer, edges, indexes)).toEqual(layout);
  });

  it('never invents a connection for outer nodes whose only parent was hidden', () => {
    const nodes = ['root', 'shown', 'hidden', 'orphan'].map((id) => ({ id, kind: 'function' }));
    const edges: EdgeLike[] = [
      { src: 'root', dst: 'shown', rel: 'calls' },
      { src: 'hidden', dst: 'orphan', rel: 'calls' },
    ];
    const model = loadModel();
    const layout = model.focusLayout(
      'root',
      ['shown'],
      ['orphan'],
      edges,
      model.buildIndexes(nodes, edges),
    );

    expect(layout.positions.orphan).toBeUndefined();
    expect(layout.parentById.orphan).toBeUndefined();
    expect(layout.edgeIndexes).toEqual([0]);
  });

  it('includes the exact real sibling cross-link in the visible edge set', () => {
    const nodes = ['benchHash', 'emitTopics', 'buildR2Heldout', 'buildEvalFixture'].map((id) => ({
      id,
      kind: 'function',
    }));
    const edges: EdgeLike[] = [
      { src: 'emitTopics', dst: 'benchHash', rel: 'calls' },
      { src: 'buildR2Heldout', dst: 'benchHash', rel: 'calls' },
      { src: 'buildEvalFixture', dst: 'benchHash', rel: 'calls' },
      { src: 'buildR2Heldout', dst: 'emitTopics', rel: 'calls' },
    ];
    const model = loadModel();
    const layout = model.focusLayout(
      'benchHash',
      ['emitTopics', 'buildR2Heldout', 'buildEvalFixture'],
      [],
      edges,
      model.buildIndexes(nodes, edges),
    );

    expect(layout.backboneEdgeIndexes).toEqual([0, 1, 2]);
    expect(layout.crossEdgeIndexes).toEqual([3]);
    expect(layout.edgeIndexes).toEqual([0, 1, 2, 3]);
  });

  it('projects capped, connected rings through four hops and lays out the deeper parent links', () => {
    const ids = ['root', 'a', 'b', 'c', 'd', 'e'];
    const nodes = ids.map((id, i) => ({ id, kind: 'function', importance: ids.length - i }));
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const edges: EdgeLike[] = [
      { src: 'root', dst: 'a', rel: 'calls' },
      { src: 'a', dst: 'b', rel: 'calls' },
      { src: 'b', dst: 'c', rel: 'calls' },
      { src: 'c', dst: 'd', rel: 'calls' },
      { src: 'root', dst: 'e', rel: 'calls' },
    ];
    const model = loadModel();
    const indexes = model.buildIndexes(nodes, edges);
    const projection = model.focusProjection('root', 4, indexes, byId, [1, 1, 1, 1]);
    expect(projection.rings).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(projection.countsByDepth).toEqual([1, 2, 1, 1, 1]);
    expect(projection.hiddenByDepth).toEqual([0, 1, 0, 0, 0]);
    expect(projection.truncated).toBe(false);
    expect(projection.truncatedAtDepth).toBeNull();
    const layout = model.focusLayout(
      'root',
      projection.rings[0]!,
      projection.rings[1]!,
      edges,
      indexes,
      projection.rings.slice(2),
    );
    expect(layout.parentById.c).toBe('b');
    expect(layout.parentById.d).toBe('c');
    expect(layout.edgeIndexes).toEqual([0, 1, 2, 3]);
    expect(Math.hypot(layout.positions.d!.x, layout.positions.d!.y)).toBeGreaterThan(
      Math.hypot(layout.positions.c!.x, layout.positions.c!.y),
    );
  });

  it('reports the exact hop where a bounded traversal stops', () => {
    const ids = ['root', 'a', 'b', 'c', 'outer'];
    const nodes = ids.map((id) => ({ id, kind: 'function' }));
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const edges: EdgeLike[] = [
      { src: 'root', dst: 'a', rel: 'calls' },
      { src: 'root', dst: 'b', rel: 'calls' },
      { src: 'root', dst: 'c', rel: 'calls' },
      { src: 'a', dst: 'outer', rel: 'calls' },
    ];
    const model = loadModel();
    const projection = model.focusProjection(
      'root',
      2,
      model.buildIndexes(nodes, edges),
      byId,
      [3, 3],
      4,
    );

    expect(projection.countsByDepth).toEqual([1, 3, 0]);
    expect(projection.truncated).toBe(true);
    expect(projection.truncatedAtDepth).toBe(2);
  });
});

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
