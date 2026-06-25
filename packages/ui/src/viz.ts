/**
 * M7/M13 web-viz graph builder — converts a SoulStore into a plain JSON snapshot for the
 * professional canvas UI. Clusters are emitted separately in `g.clusters`; symbol nodes are
 * refined into derived kinds (class, method, function, …) and every node carries summary,
 * signature, file, language, and cluster membership.
 *
 * The output is deterministic: clusters, nodes, and edges are sorted by id, so two runs over
 * the same soul produce byte-identical `/graph.json`.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SoulStore } from '@knowledge-crib/core';
import type { Node, NodeKind, Provenance, Rel } from '@knowledge-crib/soul-schema';
import type { Method } from '@knowledge-crib/soul-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type VizNodeKind =
  | NodeKind
  | 'class'
  | 'method'
  | 'function'
  | 'interface'
  | 'enum'
  | 'type'
  | 'getter'
  | 'setter'
  | 'property';

export interface VizNodeData {
  id: string;
  label: string;
  kind: VizNodeKind;
  name?: string;
  qualified?: string;
  file?: string;
  lang?: string;
  signature?: string;
  summary?: string;
  clusterId?: string;
  type?: string;
}

export interface VizEdgeData {
  id: string;
  source: string;
  target: string;
  label: string;
  rel: Rel;
  method: Method;
  provenance: Provenance;
  confidence: number;
  evidence?: { snippet?: string; by?: string };
}

export interface VizCluster {
  id: string;
  label: string;
  color: string;
  blurb: string;
}

export interface VizGraph {
  schemaVersion: string;
  stats: { nodes: number; edges: number; clusters: number };
  clusters: VizCluster[];
  nodes: Array<{ data: VizNodeData }>;
  edges: Array<{ data: VizEdgeData }>;
}

const CLUSTER_PALETTE: readonly string[] = [
  '#5b8cff',
  '#c084fc',
  '#34d399',
  '#f59e0b',
  '#94a3b8',
  '#f87171',
  '#38bdf8',
  '#a78bfa',
  '#fbbf24',
  '#2dd4bf',
  '#64748b',
];

const SORT_BY_ID = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

function deriveNodeKind(node: Node): VizNodeKind {
  if (node.kind !== 'symbol') return node.kind;
  const t = (node.type ?? '').toLowerCase();
  if (t.includes('class')) return 'class';
  if (t.includes('method')) return 'method';
  if (t.includes('function')) return 'function';
  if (t.includes('interface')) return 'interface';
  if (t.includes('enum')) return 'enum';
  if (t.includes('type')) return 'type';
  if (t.includes('getter')) return 'getter';
  if (t.includes('setter')) return 'setter';
  if (t.includes('property')) return 'property';
  return 'symbol';
}

function makeSummary(node: Node, kind: VizNodeKind): string {
  if (node.signature) return node.signature;
  if (kind === 'file') return node.file ? `Source file ${node.file}` : 'Source file';
  if (kind === 'doc-section')
    return node.heading ? `Section: ${node.heading}` : 'Documentation section';
  if (kind === 'table')
    return node.table
      ? `Table: ${node.table}`
      : node.schema
        ? `Schema: ${node.schema}`
        : 'Database table';
  if (kind === 'column') {
    return node.table ? `Column ${node.name ?? ''} in ${node.table}` : `Column ${node.name ?? ''}`;
  }
  if (kind === 'statement') {
    return node.sqlKind
      ? `${node.sqlKind} statement`
      : node.expr
        ? `SQL: ${node.expr}`
        : 'SQL statement';
  }
  if (kind === 'condition') {
    return node.expr
      ? `Condition: ${node.expr}`
      : node.branch
        ? `Branch: ${node.branch}`
        : 'Guard condition';
  }
  if (kind === 'media-seg') return 'Media segment';
  if (kind === 'explanation') return node.textRef ? `Explanation: ${node.textRef}` : 'Explanation';
  return [kind, node.name ?? node.label ?? node.id].filter(Boolean).join(': ');
}

function clusterColor(id: string, sortedIds: readonly string[]): string {
  const idx = sortedIds.indexOf(id);
  return CLUSTER_PALETTE[(idx === -1 ? 0 : idx) % CLUSTER_PALETTE.length] ?? '#64748b';
}

function clusterBlurb(cluster: Node, memberCount: number): string {
  const label = cluster.label ?? cluster.id;
  return `${label} — ${memberCount} member${memberCount === 1 ? '' : 's'}`;
}

/**
 * Build the viz snapshot. Clusters are pulled out of the node list; symbols are mapped to derived
 * kinds; nodes and edges carry provenance metadata so the UI can render detail panels without
 * re-querying the soul.
 */
export function buildVizGraph(soul: SoulStore): VizGraph {
  const parentOf = new Map<string, string>();
  const clusterCounts = new Map<string, number>();

  for (const edge of soul.iterateEdges('member-of')) {
    const dst = soul.getNode(edge.dst);
    if (dst?.kind !== 'cluster') continue;
    parentOf.set(edge.src, edge.dst);
    clusterCounts.set(edge.dst, (clusterCounts.get(edge.dst) ?? 0) + 1);
  }

  const clusterNodes = [...soul.iterate('cluster')].sort(SORT_BY_ID);
  const clusterIds = clusterNodes.map((n) => n.id);

  const clusters: VizCluster[] = clusterNodes.map((cluster) => ({
    id: cluster.id,
    label: cluster.label ?? cluster.id,
    color: clusterColor(cluster.id, clusterIds),
    blurb: clusterBlurb(cluster, clusterCounts.get(cluster.id) ?? 0),
  }));

  const nodes = [...soul.iterate()]
    .filter((node) => node.kind !== 'cluster')
    .sort(SORT_BY_ID)
    .map((node) => {
      const kind = deriveNodeKind(node);
      const data: VizNodeData = {
        id: node.id,
        label: node.label ?? node.qualifiedName ?? node.name ?? node.id,
        kind,
        summary: makeSummary(node, kind),
      };
      if (node.name) data.name = node.name;
      if (node.qualifiedName) data.qualified = node.qualifiedName;
      if (node.file) data.file = node.file;
      if (node.lang) data.lang = node.lang;
      if (node.signature) data.signature = node.signature;
      if (node.type) data.type = node.type;
      const clusterId = parentOf.get(node.id);
      if (clusterId) data.clusterId = clusterId;
      return { data };
    });

  const edges = [...soul.iterateEdges()].sort(SORT_BY_ID).map((edge) => {
    const data: VizEdgeData = {
      id: edge.id,
      source: edge.src,
      target: edge.dst,
      label: edge.rel,
      rel: edge.rel,
      method: edge.method,
      provenance: edge.provenance,
      confidence: edge.confidence,
    };
    if (edge.evidence) {
      data.evidence = {
        snippet: edge.evidence.snippet,
        by: edge.evidence.by,
      };
    }
    return { data };
  });

  return {
    schemaVersion: soul.getManifest().schemaVersion,
    stats: { nodes: nodes.length, edges: edges.length, clusters: clusters.length },
    clusters,
    nodes,
    edges,
  };
}

/** Absolute path to the static web assets dir (index.html, main.js, vendor/). */
export function vizAssetsDir(): string {
  // src/viz.ts → ../web  (works against source at dev time; the CLI resolves via the built dist too)
  return `${dirname(__dirname)}/web`;
}
