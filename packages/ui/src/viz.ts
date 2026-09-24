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
import {
  type CompositeEdge,
  type CompositeNode,
  type DerivedKind,
  GraphStore,
  buildFunctionalMap,
  computeImportance,
  deriveNodeKind,
  readLlmOverlay,
  validateClusterIntegrity,
} from '@knowledge-crib/core';
import type { SoulStore } from '@knowledge-crib/core';
import type { Node, Provenance, Rel } from '@knowledge-crib/soul-schema';
import type { Method } from '@knowledge-crib/soul-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type VizNodeKind = DerivedKind | string;

export interface VizNodeData {
  id: string;
  label: string;
  kind: VizNodeKind;
  name?: string;
  qualified?: string;
  file?: string;
  span?: { start: number; end: number };
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
  origin?: 'extracted' | 'semantic' | 'memory';
  targetId?: string;
  model?: string;
  /** W3 — memory-layer only: the record's effective trust verdict (candidate|local|team). */
  trust?: string;
  /** W3 — memory-layer only: the store the record was gathered from (team|local|global). */
  source?: string;
}

export interface VizEdgeData {
  id: string;
  source: string;
  target: string;
  label: string;
  rel: Rel | string;
  method: Method | string;
  provenance: Provenance;
  confidence: number;
  evidence?: { snippet?: string; by?: string };
  origin?: 'extracted' | 'semantic' | 'memory';
  targetId?: string;
  model?: string;
  /** W3 — memory-layer only: why an inferred `applies-to`/`supported-by`/`conflicts-with` edge exists. */
  rationale?: string;
}

export interface VizCluster {
  id: string;
  label: string;
  color: string;
  blurb: string;
  /** Exact number of validated structural members in this functionality cluster. */
  memberCount: number;
  /** LLM-authored cluster name (from the read-time overlay); present only when an enrichment saved
   *  one. The UI prefers this over the heuristic `label`. */
  llmLabel?: string;
  /** LLM-authored one-line purpose for the cluster, when an enrichment saved one. */
  purpose?: string;
  /** True when the cluster's LLM artifact is stale (content drifted since the analysis was saved). */
  llmStale?: boolean;
}

/** A functional module for the overview pane — the module-segmented view from `buildFunctionalMap`,
 *  colored by palette index so the UI can render module cards + per-module cluster filtering. */
export interface VizModule {
  id: string;
  name: string;
  pathPrefix: string;
  purpose?: string;
  counts: { files: number; symbols: number; clusters: number; routes: number; docSections: number };
  topSymbols: Array<{
    id: string;
    name?: string;
    qualifiedName?: string;
    file?: string;
    importance: number;
    stereotype?: string;
  }>;
  clusterIds: string[];
  color: string;
}

export interface VizOverview {
  schemaVersion: string;
  source: 'workspace' | 'directory';
  stats: {
    codeNodes: number;
    codeEdges: number;
    semanticNodes: number;
    semanticEdges: number;
    clusters: number;
  };
  modules: VizModule[];
}

/** One cluster card inside a module drill-in (the overview's second level). */
export interface VizModuleViewCluster {
  id: string;
  label: string;
  color: string;
  count: number;
  degree: number;
  importance: number;
  kinds: Record<string, number>;
  topMembers: Array<{ id: string; kind: string; label: string }>;
  /** LLM-authored purpose for the cluster, when an enrichment saved one. */
  purpose?: string;
}

/** Everything the overview needs to open one module without downloading `/graph.json`. */
export interface VizModuleView {
  moduleId: string;
  totalClusters: number;
  clusters: VizModuleViewCluster[];
  edges: Array<{ src: string; dst: string; count: number; rel: string }>;
}

export interface VizGraph {
  schemaVersion: string;
  stats: {
    nodes: number;
    edges: number;
    clusters: number;
    primaryNodes: number;
    codeNodes: number;
    semanticNodes: number;
    memoryNodes: number;
    codeEdges: number;
    semanticEdges: number;
    memoryEdges: number;
  };
  clusters: VizCluster[];
  nodes: Array<{ data: VizNodeData }>;
  edges: Array<{ data: VizEdgeData }>;
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
    if (node.sqlKind) return `${node.sqlKind} statement`;
    // Statement nodes come from every parser; only SQL-family sources are SQL. A Java or
    // TypeScript statement labelled "SQL" misleads the reader about what the node is.
    const sql = /sql/i.test(node.lang ?? '');
    return node.expr
      ? `${sql ? 'SQL' : 'Statement'}: ${node.expr}`
      : sql
        ? 'SQL statement'
        : 'Statement';
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
export function buildVizGraph(
  soul: SoulStore,
  /** W3 — the optional virtual memory composite layer (PRD lines 212–224): `mem:` nodes +
   *  `applies-to`/`supported-by`/`conflicts-with` edges produced by the `memory` package's
   *  `memoryComposite(recall)`. Passed in (not built here) so `ui` keeps no `memory` dependency —
   *  the caller decides whether to fold memory into the viz. Memory nodes are tier:'detail' (the
   *  architecture layer is the soul's extracted symbols); their `kind` is `'memory'`. */
  memory?: { nodes: CompositeNode[]; edges: CompositeEdge[] },
): VizGraph {
  const parentOf = new Map<string, string>();
  const clusterCounts = new Map<string, number>();
  const integrity = validateClusterIntegrity(soul);
  if (!integrity.valid) {
    throw new Error(
      `cluster integrity failed: ${integrity.issues.slice(0, 5).join('; ')}. Run \`crib reindex\`.`,
    );
  }

  const clusterNodes = [...soul.iterate('cluster')].sort(SORT_BY_ID);
  for (const cluster of clusterNodes) {
    const members = cluster.members ?? [];
    clusterCounts.set(cluster.id, members.length);
    for (const memberId of members) parentOf.set(memberId, cluster.id);
  }

  // Importance/degree now come from the shared core ranking (value-identical to the old inline
  // computation — `viz.test.ts` tier assertions guard the parity). Computed once over the whole
  // soul so the client never re-derives it from the full edge list.
  const importance = computeImportance(soul);
  // LLM cluster labels surface via the read-time overlay (no soul write-back — preserves
  // `cache:stability`). Prefer the LLM-authored name; the heuristic `label` is the fallback.
  const overlay = readLlmOverlay(soul);

  const clusterIds = clusterNodes.map((n) => n.id);

  const clusters: VizCluster[] = clusterNodes.map((cluster) => {
    const entry = overlay.entries.get(cluster.id);
    const llmName = entry?.name;
    return {
      id: cluster.id,
      label: llmName ?? cluster.label ?? cluster.id,
      color: clusterColor(cluster.id, clusterIds),
      blurb: clusterBlurb(cluster, clusterCounts.get(cluster.id) ?? 0),
      memberCount: clusterCounts.get(cluster.id) ?? 0,
      ...(llmName ? { llmLabel: llmName } : {}),
      ...(entry?.purpose ? { purpose: entry.purpose } : {}),
      ...(entry?.stale ? { llmStale: true } : {}),
    };
  });

  const nodes = [...soul.iterate()]
    .filter((node) => node.kind !== 'cluster')
    .sort(SORT_BY_ID)
    .map((node) => {
      const kind = deriveNodeKind(node);
      const entry = importance.get(node.id);
      const degree = entry?.degree ?? 0;
      const data: VizNodeData = {
        id: node.id,
        label: node.label ?? node.qualifiedName ?? node.name ?? node.id,
        kind,
        summary: makeSummary(node, kind),
        degree,
        importance: entry?.importance ?? 0,
        tier: 'detail', // placeholder — the top-K pass below promotes the primary tier
        origin: 'extracted',
      };
      if (node.name) data.name = node.name;
      if (node.qualifiedName) data.qualified = node.qualifiedName;
      if (node.file) data.file = node.file;
      if (node.span) data.span = { ...node.span };
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
      origin: 'extracted' as const,
    };
    if (edge.evidence) {
      data.evidence = {
        snippet: edge.evidence.snippet,
        by: edge.evidence.by,
      };
    }
    return { data };
  });

  const codeNodes = nodes.length;
  const codeEdges = edges.length;
  // Mandatory composite view: append only fresh, grounded semantic records. Heavy analysis and
  // evidence blobs remain in canonical artifacts; viz receives lightweight graph metadata.
  const semantic = new GraphStore(soul).semantic();
  for (const node of semantic.nodes.sort(SORT_BY_ID)) {
    const raw = node as Record<string, unknown>;
    nodes.push({
      data: {
        id: node.id,
        label: String(raw.name ?? raw.label ?? node.id),
        kind: node.kind,
        summary: typeof raw.summary === 'string' ? raw.summary : undefined,
        importance: 0,
        degree: 0,
        tier: 'detail',
        origin: 'semantic',
        ...(node.targetId ? { targetId: node.targetId } : {}),
        ...(node.model ? { model: node.model } : {}),
      },
    });
  }
  for (const edge of semantic.edges.sort(SORT_BY_ID)) {
    edges.push({
      data: {
        id: edge.id,
        source: edge.src,
        target: edge.dst,
        label: edge.rel,
        rel: edge.rel,
        method: edge.method,
        provenance: edge.provenance,
        confidence: edge.confidence,
        origin: 'semantic',
        ...(edge.targetId ? { targetId: edge.targetId } : {}),
        ...(edge.model ? { model: edge.model } : {}),
      },
    });
  }
  const semanticNodes = nodes.length - codeNodes;
  const semanticEdges = edges.length - codeEdges;

  // W3 — append the virtual memory composite layer (origin 'memory'). Memory nodes are VIRTUAL
  // (`mem:` ids, kind 'memory') — they are NOT soul symbols, so they skip the cluster/importance
  // passes above and land as tier:'detail' with origin 'memory'. Their `applies-to`/
  // `supported-by`/`conflicts-with` edges are runtime strings outside the soul's closed `Rel` enum;
  // `mergeComposite`'s valid-endpoint filter already dropped edges to absent nodes, so every edge
  // here points at a node present in the merged set (a soul symbol or a `mem:` node).
  if (memory) {
    for (const node of memory.nodes.sort(SORT_BY_ID)) {
      const raw = node as Record<string, unknown>;
      nodes.push({
        data: {
          id: node.id,
          label: String(raw.label ?? raw.claim ?? raw.subject ?? node.id),
          kind: node.kind,
          summary: typeof raw.claim === 'string' ? raw.claim : undefined,
          importance: 0,
          degree: 0,
          tier: 'detail',
          origin: 'memory',
          ...(node.targetId ? { targetId: node.targetId } : {}),
          ...(raw.trust ? { trust: String(raw.trust) } : {}),
          ...(raw.source ? { source: String(raw.source) } : {}),
        },
      });
    }
    for (const edge of memory.edges.sort(SORT_BY_ID)) {
      edges.push({
        data: {
          id: edge.id,
          source: edge.src,
          target: edge.dst,
          label: edge.rel,
          rel: edge.rel,
          method: edge.method,
          provenance: edge.provenance,
          confidence: edge.confidence,
          origin: 'memory',
          ...(edge.targetId ? { targetId: edge.targetId } : {}),
          ...(edge.rationale ? { rationale: edge.rationale } : {}),
        },
      });
    }
  }

  return {
    schemaVersion: soul.getManifest().schemaVersion,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      clusters: clusters.length,
      primaryNodes,
      codeNodes,
      semanticNodes,
      memoryNodes: nodes.length - codeNodes - semanticNodes,
      codeEdges,
      semanticEdges,
      memoryEdges: edges.length - codeEdges - semanticEdges,
    },
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

/**
 * Build the viz OVERVIEW snapshot — the module-segmented view (outcome F) for the overview pane.
 * Combines `buildFunctionalMap` (modules from the soul) with the read-time LLM overlay (purpose) and
 * the cluster palette (per-module color). Deterministic: modules arrive sorted by summed importance
 * then id, so two runs produce byte-identical `/overview.json`. This is served at `/overview.json`
 * BESIDE `/graph.json`; the graph stays byte-stable (no modules added to it).
 */
export function buildVizOverview(soul: SoulStore): VizOverview {
  const map = buildFunctionalMap(soul);
  const semantic = new GraphStore(soul).semantic();
  const modules: VizModule[] = map.modules.map((m, i) => ({
    id: m.id,
    name: m.name,
    pathPrefix: m.pathPrefix,
    ...(m.purpose ? { purpose: m.purpose.text } : {}),
    counts: m.counts,
    topSymbols: m.topSymbols,
    clusterIds: m.clusterIds,
    color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.length] ?? '#64748b',
  }));
  return {
    schemaVersion: soul.getManifest().schemaVersion,
    source: map.source,
    stats: {
      codeNodes: [...soul.iterate()].filter((node) => node.kind !== 'cluster').length,
      codeEdges: [...soul.iterateEdges()].length,
      semanticNodes: semantic.nodes.length,
      semanticEdges: semantic.edges.length,
      clusters: [...soul.iterate('cluster')].length,
    },
    modules,
  };
}

/** Card and edge caps shared with the browser's large-graph overview (`buildClusterOverview`). */
const MODULE_VIEW_MAX_CLUSTERS = 26;
const MODULE_VIEW_MAX_EDGES = 120;
/** Mirrors the browser's `DEPENDENCY_RELS`: an aggregated edge reports a dependency rel when one exists. */
const MODULE_VIEW_DEPENDENCY_RELS = new Set([
  'calls',
  'imports',
  'reads',
  'writes',
  'executes',
  'implements',
  'inherits',
]);

/**
 * Per-module drill-in projections over an already-built viz graph. Opening a module used to
 * require the browser to download, parse and index the whole graph (100+ MB on a real repository)
 * before the module's cluster cards could render. The server already holds that graph, so it
 * derives the cards once per module and serves a few kilobytes instead.
 *
 * The arithmetic matches the browser's own level-1 overview: members by `clusterId`, undirected
 * degree over edges whose endpoints are both graph nodes, summed server importance for ranking,
 * the three most important members per card, and cross-cluster edge counts among shown cards.
 */
export function createVizModuleViews(
  graph: VizGraph,
  overview: VizOverview,
): (moduleId: string) => VizModuleView | undefined {
  const memo = new Map<string, VizModuleView>();
  let shared:
    | {
        byId: Map<string, VizNodeData>;
        degree: Map<string, number>;
        members: Map<string, VizNodeData[]>;
      }
    | undefined;
  const index = () => {
    if (shared) return shared;
    const byId = new Map<string, VizNodeData>();
    const members = new Map<string, VizNodeData[]>();
    for (const { data } of graph.nodes) {
      byId.set(data.id, data);
      if (!data.clusterId) continue;
      const list = members.get(data.clusterId);
      if (list) list.push(data);
      else members.set(data.clusterId, [data]);
    }
    const degree = new Map<string, number>();
    for (const { data } of graph.edges) {
      if (!byId.has(data.source) || !byId.has(data.target)) continue;
      degree.set(data.source, (degree.get(data.source) ?? 0) + 1);
      degree.set(data.target, (degree.get(data.target) ?? 0) + 1);
    }
    shared = { byId, degree, members };
    return shared;
  };

  return (moduleId) => {
    const cached = memo.get(moduleId);
    if (cached) return cached;
    const module = overview.modules.find((m) => m.id === moduleId);
    if (!module) return undefined;
    const { byId, degree, members } = index();
    const clusterById = new Map(graph.clusters.map((c) => [c.id, c]));

    const ranked: VizModuleViewCluster[] = [];
    for (const clusterId of module.clusterIds) {
      const cluster = clusterById.get(clusterId);
      const inCluster = members.get(clusterId) ?? [];
      if (!cluster || inCluster.length === 0) continue;
      const kinds: Record<string, number> = {};
      let importance = 0;
      let clusterDegree = 0;
      for (const node of inCluster) {
        kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
        importance += node.importance;
        clusterDegree += degree.get(node.id) ?? 0;
      }
      const topMembers = [...inCluster]
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 3)
        .map((node) => ({
          id: node.id,
          kind: node.kind,
          label: node.qualified || node.label || node.id,
        }));
      ranked.push({
        id: cluster.id,
        label: cluster.label,
        color: cluster.color,
        count: inCluster.length,
        degree: clusterDegree,
        importance,
        kinds,
        topMembers,
        ...(cluster.purpose ? { purpose: cluster.purpose } : {}),
      });
    }
    ranked.sort((a, b) => b.importance - a.importance);
    const clusters = ranked.slice(0, MODULE_VIEW_MAX_CLUSTERS);

    const shown = new Set(clusters.map((c) => c.id));
    const aggregated = new Map<string, { src: string; dst: string; count: number; rel: string }>();
    for (const { data } of graph.edges) {
      const a = byId.get(data.source)?.clusterId;
      const b = byId.get(data.target)?.clusterId;
      if (!a || !b || a === b || !shown.has(a) || !shown.has(b)) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const current = aggregated.get(key) ?? { src: a, dst: b, count: 0, rel: data.rel };
      current.count++;
      if (MODULE_VIEW_DEPENDENCY_RELS.has(data.rel)) current.rel = data.rel;
      aggregated.set(key, current);
    }
    const edges = [...aggregated.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, MODULE_VIEW_MAX_EDGES);

    const view: VizModuleView = { moduleId, totalClusters: ranked.length, clusters, edges };
    memo.set(moduleId, view);
    return view;
  };
}
