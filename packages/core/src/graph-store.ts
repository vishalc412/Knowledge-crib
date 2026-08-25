/** Unified read model over canonical extracted + semantic graph layers. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { clusterContentHash } from './cluster-hash.js';
import { graphPaths } from './graph-layout.js';
import type { SoulStore } from './soul-store.js';

export type GraphOrigin = 'extracted' | 'semantic' | 'memory';

export type CompositeNode = (Node | Record<string, unknown>) & {
  id: string;
  kind: string;
  origin: GraphOrigin;
  targetId?: string;
  model?: string;
  freshness?: 'fresh';
};

export interface CompositeEdge {
  id: string;
  src: string;
  dst: string;
  rel: string;
  method: string;
  provenance: 'EXTRACTED' | 'INFERRED';
  confidence: number;
  origin: GraphOrigin;
  targetId?: string;
  model?: string;
  rationale?: string;
  evidence?: Record<string, unknown>;
}

export interface SemanticDiagnostics {
  artifacts: number;
  fresh: number;
  stale: number;
  orphaned: number;
  ungrounded: number;
}

export interface GraphSnapshot {
  nodes: CompositeNode[];
  edges: CompositeEdge[];
  diagnostics: SemanticDiagnostics;
}

export interface GraphFingerprint {
  graphGeneration: { extracted: number; semantic: number };
  schemaVersion: string;
  extractedHash: string;
  semanticHash: string;
  sourceFingerprint: string;
}

interface SemanticArtifact {
  layer: 'symbol' | 'file' | 'cluster' | 'system';
  targetId: string;
  nodeHash: string;
  schemaVersion: string;
  builtAt?: string;
  model?: string;
  grounded?: boolean;
  analysis?: { purpose?: string; confidence?: number; [key: string]: unknown };
  graph?: {
    nodes?: Array<Record<string, unknown> & { id?: string; localId?: string; kind?: string }>;
    edges?: Array<Record<string, unknown> & { from?: string; to?: string; rel?: string }>;
  };
}

/** Sole graph reader. Writers remain SoulStore (extracted) and EnrichmentStore (semantic). */
export class GraphStore {
  /**
   * W6 — the optional working overlay. When set, the EXTRACTED layer is read from the overlay store
   * (canonical + dirty swap, in memory) instead of the committed soul; the committed `.crib/graph` is
   * never touched. The semantic layer still reads from the committed soul — semantic artifacts are a
   * separate, independently-fresh layer, and the PRD (line 375) scopes watch to the extracted graph.
   */
  private overlay?: SoulStore;

  constructor(private readonly soul: SoulStore) {}

  /**
   * W6 — install or remove the working overlay. When set, every extracted read delegates to the
   * overlay store so edits become queryable through query/context/dossier/neighbors/shortestPath
   * without dirtying the committed `.crib/graph`. Pass `undefined` to return to committed-only reads.
   */
  setWorkingOverlay(overlay: SoulStore | undefined): void {
    this.overlay = overlay;
  }

  /** The soul backing the EXTRACTED layer — the overlay when active, else the committed soul. */
  private live(): SoulStore {
    return this.overlay ?? this.soul;
  }

  extracted(): GraphSnapshot {
    const live = this.live();
    const nodes = [...live.iterate()].map((node) => ({
      ...node,
      origin: 'extracted' as const,
    }));
    const edges = [...live.iterateEdges()].map((edge) => extractedEdge(edge));
    return { nodes, edges, diagnostics: emptyDiagnostics() };
  }

  semantic(): GraphSnapshot {
    return readSemantic(this.soul);
  }

  composite(): GraphSnapshot {
    // W6 — when an overlay is active, bypass the on-disk materialized composite cache (it reflects the
    // committed soul, not the working overlay) and always compute compositeLive so dirty edits are
    // visible. With no overlay, the materialized fast path is unchanged.
    if (!this.overlay) {
      const materialized = readMaterialized(this.soul);
      if (materialized) return materialized;
    }
    return this.compositeLive();
  }

  compositeLive(): GraphSnapshot {
    const extracted = this.extracted();
    const semantic = this.semantic();
    const nodes = new Map(extracted.nodes.map((node) => [node.id, node]));
    for (const node of semantic.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    const valid = new Set(nodes.keys());
    const edges = [
      ...extracted.edges,
      ...semantic.edges.filter((edge) => valid.has(edge.src) && valid.has(edge.dst)),
    ];
    return { nodes: [...nodes.values()], edges, diagnostics: semantic.diagnostics };
  }

  /**
   * W3 — fold a VIRTUAL sub-graph (the memory composite layer, origin `'memory'`) into a base
   * snapshot WITHOUT touching the soul. Mirrors {@link compositeLive}'s extracted+semantic merge:
   * extra nodes are unioned by id (base wins on collision — a soul node is never overwritten by a
   * virtual one), then extra edges are kept only where BOTH endpoints are in the merged node set
   * (so a memory `applies-to` edge to a soul id that no longer exists is dropped, exactly like
   * semantic edges to absent extracted nodes). Pure + standalone so the viz builder (`ui`, which
   * depends on `core` but not `memory`) and the MCP `brief` verb can both call it with the memory
   * composite produced by the `memory` package — `core` never takes a `memory` dependency.
   */
  mergeComposite(
    base: GraphSnapshot,
    extra: { nodes: CompositeNode[]; edges: CompositeEdge[] },
  ): GraphSnapshot {
    const nodes = new Map(base.nodes.map((node) => [node.id, node]));
    for (const node of extra.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    const valid = new Set(nodes.keys());
    const edges = [
      ...base.edges,
      ...extra.edges.filter((edge) => valid.has(edge.src) && valid.has(edge.dst)),
    ];
    return { nodes: [...nodes.values()], edges, diagnostics: base.diagnostics };
  }

  neighbors(id: string, includeSemantic = false): CompositeEdge[] {
    const graph = includeSemantic ? this.composite() : this.extracted();
    return graph.edges.filter((edge) => edge.src === id || edge.dst === id);
  }

  shortestPath(from: string, to: string, maxHops = 6): { path: string[]; edges: CompositeEdge[] } {
    const graph = this.composite();
    const outgoing = new Map<string, CompositeEdge[]>();
    for (const edge of graph.edges) {
      const list = outgoing.get(edge.src);
      if (list) list.push(edge);
      else outgoing.set(edge.src, [edge]);
    }
    const queue: Array<{ id: string; path: string[]; edges: CompositeEdge[] }> = [
      { id: from, path: [from], edges: [] },
    ];
    const seen = new Set([from]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id === to) return { path: current.path, edges: current.edges };
      if (current.edges.length >= maxHops) continue;
      for (const edge of outgoing.get(current.id) ?? []) {
        if (seen.has(edge.dst)) continue;
        seen.add(edge.dst);
        queue.push({
          id: edge.dst,
          path: [...current.path, edge.dst],
          edges: [...current.edges, edge],
        });
      }
    }
    return { path: [], edges: [] };
  }
}

export function graphSourceFingerprint(soul: SoulStore): string {
  return graphFingerprint(soul).sourceFingerprint;
}

export function graphFingerprint(soul: SoulStore): GraphFingerprint {
  const paths = graphPaths(soul.cribDir);
  const manifest = soul.getManifest();
  const artifacts = existsSync(paths.artifacts)
    ? paths.artifacts
    : join(soul.cribDir, 'llm', 'analysis');
  const extractedHash = hashFiles(walkFiles(paths.extracted));
  const semanticFiles = walkFiles(artifacts);
  if (existsSync(paths.state)) semanticFiles.push(paths.state);
  const semanticHash = hashFiles(semanticFiles);
  const graphGeneration = manifest.generation ?? { extracted: 0, semantic: 0 };
  const schemaVersion = manifest.schemaVersion;
  const sourceFingerprint = `blake3:${blake3Hex(
    JSON.stringify({ graphGeneration, schemaVersion, extractedHash, semanticHash }),
  )}`;
  return { graphGeneration, schemaVersion, extractedHash, semanticHash, sourceFingerprint };
}

function readMaterialized(soul: SoulStore): GraphSnapshot | undefined {
  const root = join(soul.cribDir, 'index', 'composite');
  const manifest = readJson<{ sourceFingerprint?: string }>(join(root, 'manifest.json'));
  if (!manifest || manifest.sourceFingerprint !== graphSourceFingerprint(soul)) return undefined;
  return readJson<GraphSnapshot>(join(root, 'graph.json'));
}

function readSemantic(soul: SoulStore): GraphSnapshot {
  const canonical = graphPaths(soul.cribDir);
  const artifactsRoot = existsSync(canonical.artifacts)
    ? canonical.artifacts
    : join(soul.cribDir, 'llm', 'analysis');
  const statePath = existsSync(canonical.state)
    ? canonical.state
    : join(soul.cribDir, 'llm', 'manifest.json');
  const state = readJson<{ builtAgainstHead?: string | null }>(statePath);
  const diagnostics = emptyDiagnostics();
  const candidates = new Map<string, SemanticArtifact>();
  for (const file of walkJson(artifactsRoot)) {
    const artifact = readJson<SemanticArtifact>(file);
    if (!artifact?.targetId || !artifact.layer) continue;
    diagnostics.artifacts++;
    const verdict = freshness(soul, artifact, state?.builtAgainstHead ?? null);
    if (verdict === 'orphaned') diagnostics.orphaned++;
    else if (verdict === 'stale') diagnostics.stale++;
    else if (verdict === 'ungrounded') diagnostics.ungrounded++;
    else {
      diagnostics.fresh++;
      const previous = candidates.get(artifact.targetId);
      if (!previous || (artifact.builtAt ?? '') > (previous.builtAt ?? '')) {
        candidates.set(artifact.targetId, artifact);
      }
    }
  }

  const nodes: CompositeNode[] = [];
  const edges: CompositeEdge[] = [];
  for (const artifact of candidates.values()) {
    const localIds = new Map<string, string>();
    for (const raw of artifact.graph?.nodes ?? []) {
      const localId = String(raw.localId ?? raw.id ?? '');
      if (!localId) continue;
      const id = String(raw.id ?? `llm:${artifact.targetId}#${localId}`);
      localIds.set(localId, id);
      nodes.push({
        ...raw,
        id,
        kind: String(raw.kind ?? 'concept'),
        origin: 'semantic',
        targetId: artifact.targetId,
        ...(artifact.model ? { model: artifact.model } : {}),
        freshness: 'fresh',
      });
    }
    for (const raw of artifact.graph?.edges ?? []) {
      const from = resolveEndpoint(String(raw.from ?? ''), artifact.targetId, localIds);
      const to = resolveEndpoint(String(raw.to ?? ''), artifact.targetId, localIds);
      const rel = String(raw.rel ?? '');
      if (!from || !to || !rel) continue;
      const confidence =
        typeof raw.confidence === 'number'
          ? Math.max(0, Math.min(1, raw.confidence))
          : (artifact.analysis?.confidence ?? 0.5);
      edges.push({
        id: `llm-edge:${blake3Hex(`${from}|${to}|${rel}|${artifact.targetId}`)}`,
        src: from,
        dst: to,
        rel,
        method: 'inferred',
        provenance: 'INFERRED',
        confidence,
        origin: 'semantic',
        targetId: artifact.targetId,
        ...(artifact.model ? { model: artifact.model } : {}),
        ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale } : {}),
      });
    }
  }
  return { nodes, edges, diagnostics };
}

function freshness(
  soul: SoulStore,
  artifact: SemanticArtifact,
  builtAgainstHead: string | null,
): 'fresh' | 'stale' | 'orphaned' | 'ungrounded' {
  if (artifact.grounded !== true) return 'ungrounded';
  if (artifact.schemaVersion !== soul.getManifest().schemaVersion) return 'stale';
  if (artifact.layer === 'system') {
    const head = soul.getManifest().repo.vcsHead ?? null;
    return head === builtAgainstHead ? 'fresh' : 'stale';
  }
  const target = soul.getNode(artifact.targetId);
  if (!target) return 'orphaned';
  const liveHash = artifact.layer === 'cluster' ? clusterContentHash(soul, target) : target.hash;
  return liveHash === artifact.nodeHash ? 'fresh' : 'stale';
}

function resolveEndpoint(
  endpoint: string,
  targetId: string,
  localIds: Map<string, string>,
): string {
  if (localIds.has(endpoint)) return localIds.get(endpoint)!;
  if (endpoint.startsWith('llm:') || endpoint.includes(':')) return endpoint;
  return `llm:${targetId}#${endpoint}`;
}

function extractedEdge(edge: Edge): CompositeEdge {
  return { ...edge, origin: 'extracted' };
}

function emptyDiagnostics(): SemanticDiagnostics {
  return { artifacts: 0, fresh: 0, stale: 0, orphaned: 0, ungrounded: 0 };
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function* walkJson(root: string): Iterable<string> {
  for (const path of walkFiles(root)) if (path.endsWith('.json')) yield path;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else files.push(path);
    }
  }
  return files;
}

function hashFiles(files: string[]): string {
  const contents = files
    .sort()
    .map((path) => `${path}\0${readFileSync(path, 'utf8')}`)
    .join('\0');
  return `blake3:${blake3Hex(contents)}`;
}
