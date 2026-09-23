import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { vizAssetsDir } from './viz.js';

type Node = {
  id: string;
  kind: string;
  label: string;
  cluster: string;
  file?: string;
  importance?: number;
  summary?: string;
};
type Edge = { src: string; dst: string; rel: string };
type Row = { id: string; kind: string; hop?: number; relationship?: string; module?: string };
type Result = {
  scope: string;
  rows: Row[];
  total: number;
  page: number;
  pageCount: number;
  truncated: boolean;
  graphNote?: string;
};
type Explorer = { project: (options: Record<string, unknown>) => Result };
type Model = {
  buildIndexes: (nodes: Node[], edges: Edge[]) => unknown;
  searchProjection: (
    options: Record<string, unknown>,
    nodes: Node[],
    edges: Edge[],
    byId: Record<string, Node>,
    indexes: unknown,
  ) => { allMatchIds: string[]; matchIds: string[]; totalMatches: number };
};

function fixture() {
  const context: Record<string, unknown> = {};
  context.globalThis = context;
  for (const asset of ['graph-model.js', 'explorer-projection.js']) {
    runInNewContext(readFileSync(`${vizAssetsDir()}/${asset}`, 'utf8'), context);
  }
  const model = context.KCGraphModel as Model;
  const explorer = context.KCExplorerProjection as Explorer;
  const nodes: Node[] = [
    {
      id: 'root',
      kind: 'function',
      label: 'root',
      cluster: 'core',
      file: 'packages/core/root.ts',
      importance: 5,
    },
    {
      id: 'caller',
      kind: 'function',
      label: 'caller',
      cluster: 'cli',
      file: 'packages/cli/caller.ts',
      importance: 4,
    },
    {
      id: 'callee',
      kind: 'method',
      label: 'callee',
      cluster: 'core',
      file: 'packages/core/callee.ts',
      importance: 3,
    },
    {
      id: 'second',
      kind: 'function',
      label: 'second',
      cluster: 'cli',
      file: 'packages/cli/second.ts',
      importance: 2,
    },
    {
      id: 'note',
      kind: 'doc-section',
      label: 'root note',
      cluster: 'docs',
      file: 'docs/root.md',
      importance: 1,
    },
  ];
  const edges: Edge[] = [
    { src: 'caller', dst: 'root', rel: 'calls' },
    { src: 'root', dst: 'callee', rel: 'calls' },
    { src: 'second', dst: 'caller', rel: 'imports' },
    { src: 'note', dst: 'root', rel: 'describes' },
  ];
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const indexes = model.buildIndexes(nodes, edges);
  const modules = [
    { id: 'module:core', name: 'Core', pathPrefix: 'packages/core', clusterIds: ['core'] },
    { id: 'module:cli', name: 'CLI', pathPrefix: 'packages/cli', clusterIds: ['cli'] },
  ];
  const clusters = [
    { id: 'core', label: 'Core cluster' },
    { id: 'cli', label: 'CLI cluster' },
    { id: 'docs', label: 'Docs cluster' },
  ];
  const base = { nodes, edges, byId, indexes, modules, clusters };
  return { model, explorer, base };
}

describe('pure explorer projection', () => {
  it('keeps every ranked search match while the canvas remains capped', () => {
    const { model, explorer, base } = fixture();
    const search = model.searchProjection(
      { query: 'root', matchCap: 1, contextCap: 1 },
      base.nodes,
      base.edges,
      base.byId,
      base.indexes,
    );
    expect(search.matchIds).toEqual(['root']);
    expect(search.allMatchIds).toEqual(['root', 'note']);
    const result = explorer.project({ ...base, query: 'root', searchProjection: search });
    expect(result.rows.map((row) => row.id)).toEqual(['root', 'note']);
    expect(result.total).toBe(2);
    expect(result.graphNote).toMatch(/canvas.*1.*2/i);
  });

  it('filters both search rows and the reported total by node type', () => {
    const { explorer, base } = fixture();
    const result = explorer.project({ ...base, query: 'root', hiddenKinds: { function: true } });
    expect(result.total).toBe(1);
    expect(result.rows.map((row) => row.id)).toEqual(['note']);
  });

  it('walks module to cluster to ranked member without dropping filtered totals', () => {
    const { explorer, base } = fixture();
    expect(explorer.project(base).rows.map((row) => row.id)).toEqual(['module:core', 'module:cli']);
    expect(
      explorer.project({ ...base, moduleId: 'module:core' }).rows.map((row) => row.id),
    ).toEqual(['core']);
    const cluster = explorer.project({ ...base, clusterId: 'core', hiddenKinds: { method: true } });
    expect(cluster.rows.map((row) => row.id)).toEqual(['root']);
    expect(cluster.total).toBe(1);
  });

  it('opens a module with no clusters directly to its indexed symbols', () => {
    const { explorer, base } = fixture();
    const modules = [
      {
        id: 'module:core-file',
        name: 'Core file',
        pathPrefix: 'packages/core/root.ts',
        clusterIds: [],
      },
    ];
    const result = explorer.project({ ...base, modules, moduleId: 'module:core-file' });
    expect(result.scope).toBe('module-symbols');
    expect(result.rows.map((row) => row.id)).toEqual(['root']);
  });

  it('names direct Focus relationships in their actual direction and excludes nonarchitecture edges', () => {
    const { explorer, base } = fixture();
    const result = explorer.project({ ...base, selectedId: 'root', depth: 1 });
    expect(result.rows.map((row) => [row.id, row.relationship, row.hop])).toEqual([
      ['caller', 'called by', 1],
      ['callee', 'calls', 1],
    ]);
  });

  it('states a Focus canvas cap beside the full list total', () => {
    const { explorer, base } = fixture();
    const result = explorer.project({
      ...base,
      selectedId: 'root',
      depth: 1,
      canvasFocus: { rings: [['caller']], countsByDepth: [1, 2], truncated: false },
    });
    expect(result.total).toBe(2);
    expect(result.graphNote).toMatch(/canvas shows 1 of 2/i);
  });

  it('ranks reverse dependency Blast by hop and discloses truncation', () => {
    const { explorer, base } = fixture();
    const result = explorer.project({ ...base, selectedId: 'root', blast: true });
    expect(result.rows.map((row) => [row.id, row.hop])).toEqual([
      ['caller', 1],
      ['second', 2],
    ]);
    expect(result.rows[0]?.module).toBe('CLI');
    expect(result.graphNote).toMatch(/canvas.*focus context/i);
    const capped = explorer.project({ ...base, selectedId: 'root', blast: true, maxVisited: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(1);
    expect(capped.graphNote).toMatch(/limit/i);
  });

  it('pages at no more than 50 rows and clamps an out-of-range page', () => {
    const { explorer, base } = fixture();
    const nodes = Array.from({ length: 121 }, (_, i) => ({
      id: `n${i}`,
      kind: 'function',
      label: `item ${i}`,
      cluster: 'core',
      importance: 121 - i,
    }));
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const indexes = fixture().model.buildIndexes(nodes, []);
    const result = explorer.project({
      ...base,
      nodes,
      edges: [],
      byId,
      indexes,
      clusterId: 'core',
      page: 1,
      pageSize: 500,
    });
    expect(result.total).toBe(121);
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0]?.id).toBe('n50');
    expect(result.pageCount).toBe(3);
    const last = explorer.project({
      ...base,
      nodes,
      edges: [],
      byId,
      indexes,
      clusterId: 'core',
      page: 100,
    });
    expect(last.page).toBe(2);
    expect(last.rows).toHaveLength(21);
  });
});
