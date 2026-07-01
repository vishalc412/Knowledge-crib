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
  /** Framework-semantics 1.3 identity — surfaced so the detail panel can show the framework role
   *  (controller/service/entity, spring/express/react) without re-querying the soul. */
  framework?: string;
  stereotype?: string;
  httpMethod?: string;
  routePath?: string;
  /**
   * Server-computed importance (P5 declutter): directed in-degree over ARCHITECTURAL_RELS only,
   * scaled by a kind weight so a heavily-called function outranks a heavily-called statement.
   * Computed once here so the client never re-derives it from the full edge list — "show
   * everything, but rank hard" needs a ranking signal the client can trust without recomputing
   * over 32k edges per frame.
   */
  importance: number;
  /** Raw directed in-degree over ARCHITECTURAL_RELS (undecorated by kind weight) — the client uses
   *  this for "N callers" style copy; `importance` is for sort/rank/fade decisions. */
  degree: number;
  /** 'primary' = top-K by importance (the architecture layer); 'detail' = the long tail (still
   *  shipped — nothing is hidden — but the client renders/labels primary first and reveals detail
   *  on demand, e.g. on focus-expand). */
  tier: 'primary' | 'detail';
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
  stats: { nodes: number; edges: number; clusters: number; primaryNodes: number };
  clusters: VizCluster[];
  nodes: Array<{ data: VizNodeData }>;
  edges: Array<{ data: VizEdgeData }>;
}

/**
 * Edges that carry architectural signal (who calls/imports/inherits/exposes/injects/renders/
 * produces whom) — the relationships an architecture-altitude view cares about. Deliberately
 * excludes `member-of` (near-universal, would swamp the signal) and statement-level control-flow
 * rels (`executes`/`reads`/`writes`/`guarded-by`/`raises`/`handles`/`iterates`/`declares`).
 */
const ARCHITECTURAL_RELS: ReadonlySet<Rel> = new Set([
  'calls',
  'imports',
  'inherits',
  'implements',
  'exposes',
  'injects',
  'renders',
  'produces',
]);

/** Statement-level / control-flow node kinds — real signal, but not architecture. Never hidden
 *  (see "show everything, rank hard"), just weighted down so they don't drown out the module map. */
const NOISE_KINDS: ReadonlySet<VizNodeKind> = new Set([
  'assignment',
  'case-branch',
  'condition',
  'cursor',
  'raise',
  'exception-handler',
]);

/** A baseline importance floor for structural container kinds, so a file/class/interface/route/
 *  table still ranks above the noise floor even when it happens to have zero incoming
 *  calls/imports edges (e.g. a leaf file with no reverse dependents is still a real module). */
function kindBase(kind: VizNodeKind): number {
  switch (kind) {
    case 'file':
      return 2;
    case 'class':
    case 'interface':
    case 'route':
    case 'table':
      return 3;
    default:
      return 0;
  }
}

/** Top-K nodes by importance are tier:'primary' (the architecture layer the UI renders/labels by
 *  default); the rest are tier:'detail' — still shipped in full, just deprioritized for display. */
const PRIMARY_TIER_SIZE = 1500;

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
  // framework-semantics 1.3 — richer summaries for the API/DI/component surface so a route reads
  // as `POST /api/loans` (not `route: POST /api/loans`), an entity field names its column, and a
  // component names its framework. Symbols prefix their stereotype when present
  // (`controller: LoanController`) so the graph distinguishes a controller from a plain class.
  if (kind === 'route') {
    return node.httpMethod && node.routePath
      ? `${node.httpMethod} ${node.routePath}`
      : (node.name ?? node.label ?? node.id);
  }
  if (kind === 'field') {
    const col = (node.meta as { column?: { name?: string } } | undefined)?.column;
    return col?.name ? `Field ${node.name ?? ''} → column ${col.name}` : `Field ${node.name ?? ''}`;
  }
  if (kind === 'component') {
    return node.framework
      ? `${node.framework} component ${node.name ?? ''}`
      : `Component ${node.name ?? ''}`;
  }
  if (kind === 'symbol' || kind === 'class' || kind === 'method' || kind === 'function') {
    const role = node.stereotype ? `${node.stereotype}: ` : '';
    return `${role}${node.name ?? node.qualifiedName ?? node.label ?? node.id}`;
  }
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
  // Directed in-degree over ARCHITECTURAL_RELS only — the raw signal `importance` is built from.
  const inDegree = new Map<string, number>();

  for (const edge of soul.iterateEdges('member-of')) {
    const dst = soul.getNode(edge.dst);
    if (dst?.kind !== 'cluster') continue;
    parentOf.set(edge.src, edge.dst);
    clusterCounts.set(edge.dst, (clusterCounts.get(edge.dst) ?? 0) + 1);
  }

  for (const edge of soul.iterateEdges()) {
    if (!ARCHITECTURAL_RELS.has(edge.rel)) continue;
    inDegree.set(edge.dst, (inDegree.get(edge.dst) ?? 0) + 1);
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
      const degree = inDegree.get(node.id) ?? 0;
      const weight = NOISE_KINDS.has(kind) ? 0.1 : 1;
      const data: VizNodeData = {
        id: node.id,
        label: node.label ?? node.qualifiedName ?? node.name ?? node.id,
        kind,
        summary: makeSummary(node, kind),
        degree,
        importance: kindBase(kind) + degree * weight,
        tier: 'detail', // placeholder — the top-K pass below promotes the primary tier
      };
      if (node.name) data.name = node.name;
      if (node.qualifiedName) data.qualified = node.qualifiedName;
      if (node.file) data.file = node.file;
      if (node.lang) data.lang = node.lang;
      if (node.signature) data.signature = node.signature;
      if (node.type) data.type = node.type;
      // framework-semantics 1.3 identity — surfaced for the detail panel (no re-query needed).
      if (node.framework) data.framework = node.framework;
      if (node.stereotype) data.stereotype = node.stereotype;
      if (node.httpMethod) data.httpMethod = node.httpMethod;
      if (node.routePath) data.routePath = node.routePath;
      const clusterId = parentOf.get(node.id);
      if (clusterId) data.clusterId = clusterId;
      return { data };
    });

  // Promote the top-K nodes by importance to tier:'primary' (the architecture layer the UI
  // renders/labels by default). Tie-break by id so the split is deterministic run-to-run — same
  // discipline as SORT_BY_ID for the node/edge/cluster arrays themselves.
  const byImportance = [...nodes].sort(
    (a, b) => b.data.importance - a.data.importance || a.data.id.localeCompare(b.data.id),
  );
  let primaryNodes = 0;
  for (const { data } of byImportance.slice(0, PRIMARY_TIER_SIZE)) {
    data.tier = 'primary';
    primaryNodes++;
  }

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
    stats: { nodes: nodes.length, edges: edges.length, clusters: clusters.length, primaryNodes },
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
