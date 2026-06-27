/**
 * Agent-driven LLM graph enrichment.
 *
 * The MCP server never calls a model. It exposes a deterministic work queue (`enrich_next`) and a
 * persistence/validation surface (`enrich_save`) so the host IDE's selected agent model can author a
 * semantic graph grounded in the deterministic soul. The LLM layer lives beside the soul under
 * `.crib/llm/`; deterministic nodes/edges/dossiers remain byte-stable.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { buildDossier, computeCoverage, decisionTable } from '@knowledge-crib/core';
import type { SoulStore } from '@knowledge-crib/core';
import { blake3Hex, contentHash } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';

export type EnrichLayer = 'symbol' | 'file' | 'cluster' | 'system';

const LAYERS: readonly EnrichLayer[] = ['symbol', 'file', 'cluster', 'system'];
/** Layers that can be path-scoped. The system layer is whole-repo only. */
const LAYERS_SCOPED: readonly EnrichLayer[] = ['symbol', 'file', 'cluster'];
const LLM_VERSION = 1;
const SYSTEM_TARGET = 'system:repo';
const SHARD_HEX = 2;

/**
 * Pending-target count above which `/crib-enrich` shows a graphify-style scope picker instead of
 * blindly looping. Each enrich target authors a deep analysis (~10x a graphify file extraction), so
 * 200 pending ≈ graphify's 500-file threshold in effort. On PENDING (not total) so a fresh large repo
 * never nags. Tunable in one place.
 */
export const ENRICH_SCOPE_THRESHOLD = 200;

export interface EnrichScope {
  /** Repo-relative path prefix, e.g. `packages/cli`. Trailing-slash-safe startsWith match. */
  pathPrefix?: string;
  /** Optional cluster refinement inside the prefix: cluster id or slug (`c:...` or bare slug). */
  cluster?: string;
}

export interface EnrichLayerCounts {
  total: number;
  missing: number;
  stale: number;
  fresh: number;
}

export interface EnrichScopeInfo {
  pathPrefix: string;
  label: string;
  pending: number;
  symbols: number;
  files: number;
  clusters: number;
}

export interface EnrichStatus {
  model: string | null;
  builtAgainstHead?: string;
  layers: Record<EnrichLayer, EnrichLayerCounts>;
  nextLayer?: EnrichLayer;
  done: boolean;
  /** Present when `scopes:true` and no active scope: ranked path-prefix scopes for the picker. */
  totalPending?: number;
  threshold?: number;
  scopes?: EnrichScopeInfo[];
  /** Present when a scope is active. */
  scopeEcho?: EnrichScope;
  /** True when the active scope matched zero in-scope targets (typo / empty prefix). */
  scopeEmpty?: boolean;
  /** Under a scope the system layer is whole-repo only; report its pending count separately. */
  wholeRepoPending?: { system: number };
}

export interface EnrichStatusArgs {
  layer?: EnrichLayer;
  scope?: EnrichScope;
  /** When true and no scope is set, return ranked scopes + totalPending + threshold for the picker. */
  scopes?: boolean;
}

export interface EnrichNextArgs {
  layer?: EnrichLayer;
  limit?: number;
  scope?: EnrichScope;
}

export interface EnrichOverviewArgs {
  scope?: EnrichScope;
}

export interface EnrichWorkItem {
  targetId: string;
  seed: Record<string, unknown>;
  lowerLayer: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  instructions: string;
}

export interface EnrichNextBatch {
  batchId: string;
  layer: EnrichLayer;
  items: EnrichWorkItem[];
  remaining: number;
  /** Echo of the selected target ids — lets the caller detect a zero-progress re-issue. */
  selectedTargetIds: string[];
  scopeEcho?: EnrichScope;
  scopeEmpty?: boolean;
  /** The batchId previously issued for this (layer, scope), if any. Server-side source of truth so a
   * context-compacted host (or a headless driver that forgot `lastBatchId`) can still detect a
   * zero-progress re-issue without relying on its own memory. */
  previousBatchId?: string;
  /** True when this batchId equals the previously-issued one for this (layer, scope) — i.e. the same
   * pending set was returned twice with no save landing in between. The server-derived signal that the
   * old 6m27s churn trap is recurring; a driver MUST break on this. */
  zeroProgress?: boolean;
}

export interface LlmAnalysis {
  purpose?: string;
  responsibilities?: string[];
  businessRules?: Array<Record<string, unknown>>;
  inputs?: unknown[];
  outputs?: unknown[];
  sideEffects?: unknown[];
  errorBehavior?: unknown[];
  invariants?: unknown[];
  preconditions?: unknown[];
  postconditions?: unknown[];
  risks?: unknown[];
  whatToDistrust?: unknown[];
  confidence?: number;
  [key: string]: unknown;
}

export interface LlmGraphNode {
  localId: string;
  kind: string;
  name: string;
  summary?: string;
  attributes?: Record<string, unknown>;
}

export interface LlmGraphEdge {
  from: string;
  to: string;
  rel: string;
  rationale?: string;
  confidence?: number;
}

export interface LlmEvidence {
  soulId: string;
  why?: string;
}

export interface EnrichSaveItem {
  targetId: string;
  model?: string;
  analysis: LlmAnalysis;
  graph: {
    nodes: LlmGraphNode[];
    edges: LlmGraphEdge[];
  };
  evidence: LlmEvidence[];
}

export interface EnrichSaveArgs {
  batchId: string;
  items: EnrichSaveItem[];
}

export interface EnrichAccepted {
  targetId: string;
  path: string;
  droppedEdges?: Array<{ edge: LlmGraphEdge; reason: string }>;
}

export interface EnrichRejected {
  targetId: string;
  reason: string;
}

export interface EnrichSaveResult {
  accepted: EnrichAccepted[];
  rejected: EnrichRejected[];
}

export interface LlmArtifact {
  version: number;
  layer: EnrichLayer;
  targetId: string;
  nodeHash: string;
  schemaVersion: string;
  builtAt: string;
  model?: string;
  analysis: LlmAnalysis;
  graph: {
    nodes: Array<LlmGraphNode & { id: string; targetId: string }>;
    edges: Array<LlmGraphEdge & { from: string; to: string; targetId: string }>;
  };
  evidence: LlmEvidence[];
}

export interface LlmRead {
  artifact?: LlmArtifact;
  missing: boolean;
  stale: boolean;
}

export class EnrichmentStore {
  constructor(
    private readonly soul: SoulStore,
    private readonly repoRoot: string,
  ) {}

  status(args: EnrichStatusArgs = {}): EnrichStatus {
    const manifest = this.readManifest();

    // Picker-discovery mode: no active scope, caller wants the ranked scopes for the picker.
    if (args.scopes && !args.scope) {
      const layers = Object.fromEntries(
        LAYERS.map((layer) => [layer, this.countLayer(layer)]),
      ) as Record<EnrichLayer, EnrichLayerCounts>;
      const totalPending = Object.values(layers).reduce((n, l) => n + l.missing + l.stale, 0);
      const nextLayer = args.layer
        ? layers[args.layer].missing + layers[args.layer].stale > 0
          ? args.layer
          : undefined
        : LAYERS.find((layer) => layers[layer].missing + layers[layer].stale > 0);
      return {
        model: manifest?.model ?? null,
        ...(manifest?.builtAgainstHead ? { builtAgainstHead: manifest.builtAgainstHead } : {}),
        layers,
        ...(nextLayer ? { nextLayer } : {}),
        done: !nextLayer,
        totalPending,
        threshold: ENRICH_SCOPE_THRESHOLD,
        scopes: this.scopes(),
      };
    }

    // Scoped mode: counts/nextLayer/done are over in-scope targets only; system is whole-repo.
    if (args.scope) {
      const scope = args.scope;
      const layers = Object.fromEntries(
        LAYERS_SCOPED.map((layer) => [layer, this.countLayer(layer, scope)]),
      ) as Record<EnrichLayer, EnrichLayerCounts>;
      // Report the whole-repo system layer separately so the user knows the bible still needs it.
      (layers as Record<EnrichLayer, EnrichLayerCounts>).system = this.countLayer('system');
      const reqLayer =
        args.layer && args.layer !== 'system' ? (args.layer as EnrichLayer) : undefined;
      const nextLayer = reqLayer
        ? layers[reqLayer].missing + layers[reqLayer].stale > 0
          ? reqLayer
          : undefined
        : LAYERS_SCOPED.find((layer) => layers[layer].missing + layers[layer].stale > 0);
      const scopeEmpty = LAYERS_SCOPED.every((layer) => layers[layer].total === 0);
      const wholeSystem = layers.system.missing + layers.system.stale;
      return {
        model: manifest?.model ?? null,
        ...(manifest?.builtAgainstHead ? { builtAgainstHead: manifest.builtAgainstHead } : {}),
        layers,
        ...(nextLayer ? { nextLayer } : {}),
        done: !nextLayer,
        scopeEcho: scope,
        scopeEmpty,
        wholeRepoPending: { system: wholeSystem },
      };
    }

    // Unscoped (current behavior).
    const layers = Object.fromEntries(
      LAYERS.map((layer) => [layer, this.countLayer(layer)]),
    ) as Record<EnrichLayer, EnrichLayerCounts>;
    const nextLayer = args.layer
      ? layers[args.layer].missing + layers[args.layer].stale > 0
        ? args.layer
        : undefined
      : LAYERS.find((layer) => layers[layer].missing + layers[layer].stale > 0);
    return {
      model: manifest?.model ?? null,
      ...(manifest?.builtAgainstHead ? { builtAgainstHead: manifest.builtAgainstHead } : {}),
      layers,
      ...(nextLayer ? { nextLayer } : {}),
      done: !nextLayer,
    };
  }

  next(args: EnrichNextArgs = {}): EnrichNextBatch {
    const limit = Math.max(1, Math.min(args.limit ?? 4, 25));
    const scope = args.scope;
    // Under a scope, the system layer is never offered; default to the scoped nextLayer. If a caller
    // explicitly asks for system under a scope, fall back to the scoped nextLayer (preserving bottom-up
    // order) rather than jumping back to a hardcoded 'symbol' that may already be fresh.
    let layer =
      args.layer ??
      (scope
        ? (this.status({ scope }).nextLayer ?? 'symbol')
        : (this.status().nextLayer ?? 'system'));
    if (scope && layer === 'system') layer = this.status({ scope }).nextLayer ?? 'symbol';
    const all = this.targets(layer, scope);
    const pending = all.filter((target) => {
      const read = this.read(target.layer, target.id, target.hash);
      return read.missing || read.stale;
    });
    const selected = pending.slice(0, limit);
    // Deterministic batchId over the FULL pending set (not the limit-bounded slice): same pending set
    // => same id => idempotent re-calls, and the id is stable regardless of `limit`. No Date.now() —
    // the old time-based id re-issued the same targets under a fresh batchId forever (the churn trap).
    const batchId = `llm:${layer}:${blake3Hex(
      pending
        .map((t) => t.id)
        .sort()
        .join('|'),
    ).slice(0, 12)}`;
    // Server-side zero-progress detection: persist the last-issued batchId per (layer, scope) so a
    // context-compacted host or a headless driver can detect a re-issue without remembering anything.
    const key = this.lastIssuedKey(layer, scope);
    const manifest = this.readManifest();
    const previousBatchId = manifest?.lastIssued?.[key]?.batchId;
    const zeroProgress = previousBatchId !== undefined && previousBatchId === batchId;
    const lastIssued = { ...(manifest?.lastIssued ?? {}), [key]: { batchId } };
    this.writeManifest(manifest?.model ?? null, lastIssued);
    return {
      batchId,
      layer,
      items: selected.map((target) => this.workItem(target)),
      remaining: Math.max(0, pending.length - selected.length),
      selectedTargetIds: selected.map((target) => target.id),
      ...(scope ? { scopeEcho: scope, scopeEmpty: all.length === 0 } : {}),
      ...(previousBatchId !== undefined ? { previousBatchId } : {}),
      ...(zeroProgress ? { zeroProgress: true } : {}),
    };
  }

  /** Stable key under which the last-issued batchId is persisted for zero-progress detection. */
  private lastIssuedKey(layer: EnrichLayer, scope?: EnrichScope): string {
    return `${layer}:${scope?.pathPrefix ?? ''}|${scope?.cluster ?? ''}`;
  }

  save(args: EnrichSaveArgs): EnrichSaveResult {
    const accepted: EnrichAccepted[] = [];
    const rejected: EnrichRejected[] = [];
    const knownLocalIds = this.knownLlmNodeIds();
    const model = args.items.find((i) => i.model)?.model ?? this.readManifest()?.model;

    for (const item of args.items) {
      const target = this.targetFor(item.targetId);
      if (!target) {
        rejected.push({ targetId: item.targetId, reason: 'unknown targetId' });
        continue;
      }
      const malformed = validateSaveItem(item);
      if (malformed) {
        rejected.push({ targetId: item.targetId, reason: malformed });
        continue;
      }

      const localIds = new Set(item.graph.nodes.map((node) => node.localId));
      const droppedEdges: Array<{ edge: LlmGraphEdge; reason: string }> = [];
      const keptEdges: Array<LlmGraphEdge & { from: string; to: string; targetId: string }> = [];
      for (const edge of item.graph.edges) {
        const from = this.resolveEndpoint(edge.from, item.targetId, localIds, knownLocalIds);
        const to = this.resolveEndpoint(edge.to, item.targetId, localIds, knownLocalIds);
        if (!from || !to) {
          droppedEdges.push({ edge, reason: 'unresolved endpoint' });
          continue;
        }
        keptEdges.push({ ...edge, from, to, targetId: item.targetId });
      }

      const artifact: LlmArtifact = {
        version: LLM_VERSION,
        layer: target.layer,
        targetId: item.targetId,
        nodeHash: target.hash,
        schemaVersion: this.soul.getManifest().schemaVersion,
        builtAt: new Date().toISOString(),
        ...(item.model ? { model: item.model } : {}),
        analysis: item.analysis,
        graph: {
          nodes: item.graph.nodes.map((node) => ({
            ...node,
            id: llmNodeId(item.targetId, node.localId),
            targetId: item.targetId,
          })),
          edges: keptEdges,
        },
        evidence: item.evidence,
      };
      const path = this.writeArtifact(artifact);
      this.writeGraphProjection(artifact);
      for (const node of artifact.graph.nodes) knownLocalIds.add(node.id);
      accepted.push({
        targetId: item.targetId,
        path,
        ...(droppedEdges.length > 0 ? { droppedEdges } : {}),
      });
    }

    this.writeManifest(model ?? null);
    this.writeOverview();
    return { accepted, rejected };
  }

  readForTarget(targetId: string): LlmRead {
    const target = this.targetFor(targetId);
    if (!target) return { missing: true, stale: false };
    return this.read(target.layer, target.id, target.hash);
  }

  allArtifacts(): LlmArtifact[] {
    const root = join(this.root(), 'analysis');
    if (!existsSync(root)) return [];
    const files = walkFiles(root).filter((p) => p.endsWith('.json'));
    const artifacts: LlmArtifact[] = [];
    for (const file of files) {
      const artifact = readJson<LlmArtifact>(file);
      if (artifact) artifacts.push(artifact);
    }
    return artifacts.sort((a, b) => a.targetId.localeCompare(b.targetId));
  }

  overview(args: EnrichOverviewArgs = {}): Record<string, unknown> {
    const scope = args.scope;
    // Unscoped: serve the cached whole-repo overview.json, rebuilding only if absent OR stale (the
    // soul was rebuilt against a new vcsHead — the cached bible no longer reflects the code).
    if (!scope) {
      const overviewPath = join(this.root(), 'overview.json');
      const cached = readJson<{ builtAgainstHead?: string }>(overviewPath);
      const currentHead = this.soul.getManifest().repo.vcsHead ?? null;
      if (cached && cached.builtAgainstHead === currentHead)
        return cached as Record<string, unknown>;
      const rebuilt = this.buildOverview(undefined);
      writeJsonAtomic(overviewPath, rebuilt);
      return rebuilt;
    }
    // Scoped: a module bible is computed live (never cached on disk beside the whole-repo one).
    return this.buildOverview(scope);
  }

  neighbors(id: string): Record<string, unknown> {
    const resolved = this.soul.getNode(id) ? id : this.resolveLlmId(id);
    if (!resolved)
      return { error: { code: 'NOT_FOUND', message: `no soul or LLM node with id ${id}` } };
    const edges = this.allArtifacts()
      .flatMap((a) => a.graph.edges)
      .filter((e) => e.from === resolved || e.to === resolved)
      .sort((a, b) => `${a.from}:${a.to}:${a.rel}`.localeCompare(`${b.from}:${b.to}:${b.rel}`));
    return { id: resolved, edges };
  }

  matchText(q: string, limit: number): LlmArtifact[] {
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (terms.length === 0) return [];
    return this.allArtifacts()
      .filter((a) => !this.isStale(a) && terms.some((term) => artifactText(a).includes(term)))
      .slice(0, limit);
  }

  hasAnyFresh(): boolean {
    return this.allArtifacts().some((a) => !this.isStale(a));
  }

  private countLayer(layer: EnrichLayer, scope?: EnrichScope): EnrichLayerCounts {
    const targets = this.targets(layer, scope);
    const counts: EnrichLayerCounts = { total: targets.length, missing: 0, stale: 0, fresh: 0 };
    for (const target of targets) {
      const read = this.read(layer, target.id, target.hash);
      if (read.missing) counts.missing++;
      else if (read.stale) counts.stale++;
      else counts.fresh++;
    }
    return counts;
  }

  private targets(
    layer: EnrichLayer,
    scope?: EnrichScope,
  ): Array<{ layer: EnrichLayer; id: string; hash: string; node?: Node }> {
    if (layer === 'system') {
      // The system layer is whole-repo only — never scoped.
      if (scope) return [];
      const any = [...this.soul.iterate()].length > 0;
      return any ? [{ layer, id: SYSTEM_TARGET, hash: this.systemHash() }] : [];
    }
    if (layer === 'cluster') {
      return [...this.soul.iterate('cluster')]
        .sort(byId)
        .map((node) => ({ layer, id: node.id, hash: this.clusterHash(node), node }))
        .filter((target) => this.matchesScope(target.node!, layer, scope));
    }
    return [...this.soul.iterate(layer)]
      .sort(byId)
      .map((node) => ({ layer, id: node.id, hash: node.hash, node }))
      .filter((target) => this.matchesScope(target.node!, layer, scope));
  }

  /**
   * True when the node is in-scope for the given layer. Absent scope => true for all (except system,
   * which targets() short-circuits). Trailing-slash-safe: `packages/core` matches `packages/core` and
   * `packages/core/x.ts` but not `packages/core-extra/x.ts`.
   */
  private matchesScope(node: Node, layer: EnrichLayer, scope?: EnrichScope): boolean {
    if (!scope) return true;
    const { pathPrefix, cluster } = scope;
    if (layer === 'symbol' || layer === 'file') {
      const p = node.file;
      if (pathPrefix && (!p || !(p === pathPrefix || p.startsWith(`${pathPrefix}/`)))) return false;
      if (cluster) {
        // Cluster refinement: resolve the cluster node (by id or slug) and check membership via the
        // cluster's `members` array — what the pipeline actually stamps. The pipeline never stamps
        // `clusterId` onto symbols, so reading `node.clusterId` alone (the old code) excluded every
        // symbol and dropped the primary layer of a cluster-scoped run. `node.clusterId` is still
        // honored when present for back-compat with any soul that does stamp it.
        const clusterNode = this.resolveCluster(cluster);
        if (!clusterNode) return false;
        if (layer === 'symbol') {
          if (!this.symbolInCluster(node, clusterNode)) return false;
        } else {
          // A file is in the cluster if any cluster member symbol lives in that file.
          if (!this.fileInCluster(p, clusterNode)) return false;
        }
      }
      return true;
    }
    if (layer === 'cluster') {
      const members = this.clusterMembers(node);
      if (
        pathPrefix &&
        !members.some(
          (m) => m.file && (m.file === pathPrefix || m.file.startsWith(`${pathPrefix}/`)),
        )
      ) {
        return false;
      }
      if (cluster) {
        const slug = node.id.startsWith('c:') ? node.id.slice(2) : node.id;
        if (node.id !== cluster && slug !== cluster && `c:${slug}` !== cluster) return false;
      }
      return true;
    }
    return true;
  }

  /** Find a cluster node by id or slug (`c:slug` or bare `slug`). */
  private resolveCluster(ref: string): Node | undefined {
    const norm = (x: string): string => (x.startsWith('c:') ? x.slice(2) : x);
    const r = norm(ref);
    return [...this.soul.iterate('cluster')].find((c) => norm(c.id) === r);
  }

  /** True when the symbol node belongs to the cluster (via members array, with clusterId back-compat). */
  private symbolInCluster(symbol: Node, cluster: Node): boolean {
    const memberIds = new Set(cluster.members ?? []);
    if (memberIds.has(symbol.id)) return true;
    const slug = cluster.id.startsWith('c:') ? cluster.id.slice(2) : cluster.id;
    return symbol.clusterId === cluster.id || symbol.clusterId === slug;
  }

  /** True when the file path contains any member symbol of the cluster. */
  private fileInCluster(file: string | undefined, cluster: Node): boolean {
    if (!file) return false;
    const memberIds = new Set(cluster.members ?? []);
    return [...this.soul.iterate('symbol')].some((n) => memberIds.has(n.id) && n.file === file);
  }

  /**
   * Rank the top-5 repo path prefixes by pending symbol count for the graphify-style picker.
   * Monorepo descent: if the largest first-component bucket holds >80% of symbols (e.g. every target
   * under `packages/`), re-group by the first TWO components so `packages/cli`, `packages/core` show
   * as distinct rows instead of one useless `packages` row.
   */
  private scopes(): EnrichScopeInfo[] {
    const symbols = [...this.soul.iterate('symbol')];
    if (symbols.length === 0) return [];

    // Precompute pending symbol ids once (one disk read per symbol) — scopes() runs once per run.
    const pendingIds = new Set<string>();
    for (const s of symbols) {
      const r = this.read('symbol', s.id, s.hash);
      if (r.missing || r.stale) pendingIds.add(s.id);
    }

    const buckets = this.groupByPathPrefix(symbols, 1);
    if (buckets.length === 0) return [];
    const total = symbols.length;
    const largest = [...buckets].sort((a, b) => b.symbols.length - a.symbols.length)[0];
    const effective =
      largest && largest.symbols.length > total * 0.8
        ? this.groupByPathPrefix(symbols, 2)
        : buckets;

    const files = [...this.soul.iterate('file')];
    const clusters = [...this.soul.iterate('cluster')];

    const infos = effective.map((bucket) => {
      const { pathPrefix, symbols: syms } = bucket;
      const pending = syms.filter((s) => pendingIds.has(s.id)).length;
      const fileCount = files.filter(
        (f) => f.file && (f.file === pathPrefix || f.file.startsWith(`${pathPrefix}/`)),
      ).length;
      const clusterCount = clusters.filter((c) =>
        this.clusterMembers(c).some(
          (m) => m.file && (m.file === pathPrefix || m.file.startsWith(`${pathPrefix}/`)),
        ),
      ).length;
      const label = pathPrefix.split('/').pop() || '(root)';
      return {
        pathPrefix,
        label,
        pending,
        symbols: syms.length,
        files: fileCount,
        clusters: clusterCount,
      };
    });

    return infos
      .sort((a, b) => b.pending - a.pending || a.pathPrefix.localeCompare(b.pathPrefix))
      .slice(0, 5);
  }

  private groupByPathPrefix(
    symbols: Node[],
    depth: number,
  ): Array<{ pathPrefix: string; symbols: Node[] }> {
    const map = new Map<string, Node[]>();
    for (const n of symbols) {
      const p = n.file;
      if (!p) continue;
      const parts = p.split('/');
      const prefix = parts.slice(0, depth).join('/');
      if (!prefix || parts.length < depth) continue;
      if (!map.has(prefix)) map.set(prefix, []);
      map.get(prefix)!.push(n);
    }
    return [...map.entries()].map(([pathPrefix, syms]) => ({ pathPrefix, symbols: syms }));
  }

  /** True when a saved artifact's target is in-scope (for the scoped overview). */
  private artifactInScope(a: LlmArtifact, scope: EnrichScope): boolean {
    if (a.layer === 'system') return false; // scoped overview excludes the whole-repo bible.
    const node = this.soul.getNode(a.targetId);
    if (!node) return false;
    return this.matchesScope(node, a.layer, scope);
  }

  private targetFor(
    targetId: string,
  ): { layer: EnrichLayer; id: string; hash: string; node?: Node } | undefined {
    if (targetId === SYSTEM_TARGET)
      return { layer: 'system', id: targetId, hash: this.systemHash() };
    const node = this.soul.getNode(targetId);
    if (!node) return undefined;
    if (node.kind === 'symbol' || node.kind === 'file' || node.kind === 'cluster') {
      const layer = node.kind;
      return {
        layer,
        id: targetId,
        hash: layer === 'cluster' ? this.clusterHash(node) : node.hash,
        node,
      };
    }
    return undefined;
  }

  private workItem(target: {
    layer: EnrichLayer;
    id: string;
    hash: string;
    node?: Node;
  }): EnrichWorkItem {
    return {
      targetId: target.id,
      seed: this.seed(target),
      lowerLayer: this.lowerLayer(target),
      outputSchema: outputSchema(target.layer),
      instructions: instructionsFor(target.layer),
    };
  }

  private seed(target: { layer: EnrichLayer; id: string; node?: Node }): Record<string, unknown> {
    if (target.layer === 'symbol' && target.node) {
      const manifest = this.soul.getManifest();
      const dossier = buildDossier(
        this.soul,
        this.repoRoot,
        target.id,
        manifest.stats.lastUpdated,
        {
          includeTables: true,
        },
      );
      return {
        node: target.node,
        sourceBody: dossier?.source,
        callers: dossier?.callers ?? [],
        callees: dossier?.callees ?? [],
        decisionTable: target.node.type
          ? decisionTable(this.soul, target.id, { includeTables: true })
          : undefined,
        controlFlow: dossier?.controlFlow,
        coverage: target.node.type ? computeCoverage(this.soul, target.id) : undefined,
        caveats: [
          'Respect only facts grounded in this seed and the supplied lower-layer analyses.',
        ],
      };
    }
    if (target.layer === 'file' && target.node) {
      const symbols = [...this.soul.iterate('symbol')]
        .filter((n) => n.file === target.node?.file)
        .sort(byId)
        .map((n) => ({
          id: n.id,
          name: n.name,
          qualifiedName: n.qualifiedName,
          type: n.type,
          hash: n.hash,
        }));
      return { node: target.node, symbols };
    }
    if (target.layer === 'cluster' && target.node) {
      return { node: target.node, members: this.clusterMembers(target.node).map((n) => n.id) };
    }
    return {
      repo: this.soul.getManifest().repo,
      stats: this.soul.getManifest().stats,
      entryPoints: [...this.soul.iterate('symbol')]
        .filter((n) => n.type && ['function', 'method', 'procedure'].includes(n.type))
        .slice(0, 50)
        .map((n) => ({ id: n.id, name: n.name, qualifiedName: n.qualifiedName, file: n.file })),
    };
  }

  private lowerLayer(target: { layer: EnrichLayer; node?: Node }): Record<string, unknown> {
    if (target.layer === 'symbol') return {};
    if (target.layer === 'file' && target.node) {
      return {
        symbols: this.freshArtifacts('symbol').filter(
          (a) => this.soul.getNode(a.targetId)?.file === target.node?.file,
        ),
      };
    }
    if (target.layer === 'cluster' && target.node) {
      const memberFiles = new Set(
        this.clusterMembers(target.node)
          .map((n) => n.file)
          .filter(Boolean),
      );
      return {
        files: this.freshArtifacts('file').filter((a) =>
          memberFiles.has(this.soul.getNode(a.targetId)?.file),
        ),
      };
    }
    return { clusters: this.freshArtifacts('cluster') };
  }

  private freshArtifacts(layer: EnrichLayer): LlmArtifact[] {
    return this.allArtifacts().filter((a) => a.layer === layer && !this.isStale(a));
  }

  private read(layer: EnrichLayer, targetId: string, liveHash: string): LlmRead {
    const dir = join(this.root(), 'analysis', layer, shard(targetId));
    const prefix = `${safeName(targetId)}_`;
    if (!existsSync(dir)) return { missing: true, stale: false };
    const candidates = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort();
    if (candidates.length === 0) return { missing: true, stale: false };
    // Prefer the artifact whose nodeHash matches the live hash (the fresh one). After a re-index both
    // an old-hash and new-hash file coexist; picking by alphabetical-last could select the stale file
    // and report a freshly-saved target as stale forever (a false zero-progress stop).
    let artifact: LlmArtifact | undefined;
    for (const name of candidates) {
      const candidate = readJson<LlmArtifact>(join(dir, name));
      if (candidate?.nodeHash === liveHash) {
        artifact = candidate;
        break;
      }
      artifact ??= candidate;
    }
    if (!artifact) return { missing: true, stale: false };
    return {
      artifact,
      missing: false,
      stale:
        artifact.nodeHash !== liveHash ||
        artifact.schemaVersion !== this.soul.getManifest().schemaVersion,
    };
  }

  private writeArtifact(artifact: LlmArtifact): string {
    const path = artifactPath(this.root(), artifact.layer, artifact.targetId, artifact.nodeHash);
    writeJsonAtomic(path, artifact);
    return path;
  }

  private writeGraphProjection(artifact: LlmArtifact): void {
    const root = this.root();
    const s = shard(artifact.targetId);
    const name = `${safeName(artifact.targetId)}.jsonl`;
    writeJsonlAtomic(join(root, 'graph', 'nodes', s, name), artifact.graph.nodes);
    writeJsonlAtomic(join(root, 'graph', 'edges', s, name), artifact.graph.edges);
  }

  private writeManifest(
    model: string | null,
    lastIssued?: Record<string, { batchId: string }>,
  ): void {
    const status = Object.fromEntries(LAYERS.map((layer) => [layer, this.countLayer(layer)]));
    // Preserve the lastIssued zero-progress map across the save() path, which also writes the manifest.
    const preserved = lastIssued ?? this.readManifest()?.lastIssued;
    writeJsonAtomic(join(this.root(), 'manifest.json'), {
      version: LLM_VERSION,
      model,
      builtAgainstHead: this.soul.getManifest().repo.vcsHead ?? null,
      layerCounts: status,
      ...(presencedLastIssued(preserved) ? { lastIssued: preserved } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  private readManifest():
    | {
        model?: string | null;
        builtAgainstHead?: string | null;
        lastIssued?: Record<string, { batchId: string }>;
      }
    | undefined {
    return readJson(join(this.root(), 'manifest.json'));
  }

  private writeOverview(): void {
    writeJsonAtomic(join(this.root(), 'overview.json'), this.buildOverview());
  }

  private buildOverview(scope?: EnrichScope): Record<string, unknown> {
    let analyses = this.allArtifacts().filter((a) => !this.isStale(a));
    if (scope) analyses = analyses.filter((a) => this.artifactInScope(a, scope));
    // The whole-repo system bible is included only on an unscoped overview.
    const system = scope ? undefined : analyses.find((a) => a.layer === 'system');
    return {
      version: LLM_VERSION,
      model: this.readManifest()?.model ?? null,
      builtAgainstHead: this.soul.getManifest().repo.vcsHead ?? null,
      ...(system ? { system: system.analysis } : {}),
      ...(scope ? { scopeEcho: scope } : {}),
      analyses: analyses.map((a) => ({
        layer: a.layer,
        targetId: a.targetId,
        analysis: a.analysis,
        graph: a.graph,
        evidence: a.evidence,
      })),
    };
  }

  private resolveEndpoint(
    endpoint: string,
    targetId: string,
    localIds: Set<string>,
    knownLlmIds: Set<string>,
  ): string | undefined {
    if (this.soul.getNode(endpoint)) return endpoint;
    if (localIds.has(endpoint)) return llmNodeId(targetId, endpoint);
    if (knownLlmIds.has(endpoint)) return endpoint;
    const sameTarget = llmNodeId(targetId, endpoint);
    if (knownLlmIds.has(sameTarget)) return sameTarget;
    return undefined;
  }

  private knownLlmNodeIds(): Set<string> {
    return new Set(this.allArtifacts().flatMap((a) => a.graph.nodes.map((n) => n.id)));
  }

  private resolveLlmId(id: string): string | undefined {
    const ids = this.knownLlmNodeIds();
    if (ids.has(id)) return id;
    const matches = [...ids].filter((candidate) => candidate.endsWith(`#${id}`));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private isStale(artifact: LlmArtifact): boolean {
    const target = this.targetFor(artifact.targetId);
    return (
      !target ||
      target.hash !== artifact.nodeHash ||
      artifact.schemaVersion !== this.soul.getManifest().schemaVersion
    );
  }

  private clusterMembers(cluster: Node): Node[] {
    const ids = new Set(cluster.members ?? []);
    const slug = cluster.id.startsWith('c:') ? cluster.id.slice(2) : cluster.id;
    return [...this.soul.iterate('symbol')]
      .filter((n) => ids.has(n.id) || n.clusterId === cluster.id || n.clusterId === slug)
      .sort(byId);
  }

  private clusterHash(cluster: Node): string {
    const memberHashes = this.clusterMembers(cluster)
      .map((n) => n.hash)
      .sort();
    return contentHash([cluster.hash, ...memberHashes].join('|'));
  }

  private systemHash(): string {
    return contentHash(
      [...this.soul.iterate()]
        .map((n) => `${n.id}:${n.hash}`)
        .sort()
        .join('|'),
    );
  }

  private root(): string {
    return join(this.soul.cribDir, 'llm');
  }
}

export function llmProjection(read: LlmRead): Record<string, unknown> | undefined {
  if (!read.artifact) return undefined;
  return {
    provenance: 'LLM',
    model: read.artifact.model,
    stale: read.stale,
    confidence: read.artifact.analysis.confidence,
    analysis: read.artifact.analysis,
    graph: read.artifact.graph,
    evidence: read.artifact.evidence,
  };
}

function validateSaveItem(item: EnrichSaveItem): string | undefined {
  if (!isRecord(item.analysis)) return 'analysis must be an object';
  if (!isRecord(item.graph)) return 'graph must be an object';
  if (!Array.isArray(item.graph.nodes)) return 'graph.nodes must be an array';
  if (!Array.isArray(item.graph.edges)) return 'graph.edges must be an array';
  if (!Array.isArray(item.evidence)) return 'evidence must be an array';
  for (const node of item.graph.nodes) {
    if (!node.localId || !node.kind || !node.name)
      return 'graph.nodes require localId, kind, and name';
  }
  for (const edge of item.graph.edges) {
    if (!edge.from || !edge.to || !edge.rel) return 'graph.edges require from, to, and rel';
    if (edge.confidence !== undefined && (edge.confidence < 0 || edge.confidence > 1)) {
      return 'graph.edge confidence must be between 0 and 1';
    }
  }
  if (
    item.analysis.confidence !== undefined &&
    (item.analysis.confidence < 0 || item.analysis.confidence > 1)
  ) {
    return 'analysis confidence must be between 0 and 1';
  }
  return undefined;
}

function outputSchema(layer: EnrichLayer): Record<string, unknown> {
  return {
    type: 'object',
    required: ['targetId', 'analysis', 'graph', 'evidence'],
    properties: {
      targetId: { type: 'string' },
      model: { type: 'string' },
      analysis: {
        type: 'object',
        required: ['purpose', 'responsibilities', 'confidence'],
        properties: {
          purpose: { type: 'string' },
          responsibilities: { type: 'array', items: { type: 'string' } },
          businessRules: { type: 'array' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      graph: {
        type: 'object',
        required: ['nodes', 'edges'],
        properties: {
          nodes: { type: 'array' },
          edges: { type: 'array' },
        },
      },
      evidence: { type: 'array' },
    },
    additionalProperties: true,
    'x-crib-layer': layer,
  };
}

function instructionsFor(layer: EnrichLayer): string {
  const common =
    'Author detailed analysis plus semantic graph nodes/edges. Ground every claim in seed/lowerLayer evidence. Do not invent code facts. Edges may point only to real soul ids or localIds authored in this item or earlier saved items.';
  if (layer === 'symbol')
    return `${common} Focus on purpose, rules, invariants, IO, side effects, errors, and risks for this symbol.`;
  if (layer === 'file')
    return `${common} Synthesize the file purpose from its symbol analyses and identify feature/capability relationships.`;
  if (layer === 'cluster')
    return `${common} Name the module/cluster and describe responsibilities plus inter-module semantic dependencies.`;
  return `${common} Produce the whole-system bible: architecture, subsystems, cross-cutting flows, glossary, stack, and risk map.`;
}

function artifactPath(root: string, layer: EnrichLayer, targetId: string, hash: string): string {
  return join(
    root,
    'analysis',
    layer,
    shard(targetId),
    `${safeName(targetId)}_${safeName(hash)}.json`,
  );
}

function llmNodeId(targetId: string, localId: string): string {
  return `llm:${targetId}#${localId}`;
}

function shard(id: string): string {
  return blake3Hex(id).slice(0, SHARD_HEX);
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function byId(a: Node, b: Node): number {
  return a.id.localeCompare(b.id);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function writeJsonlAtomic(path: string, values: unknown[]): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    tmp,
    values.map((v) => JSON.stringify(v)).join('\n') + (values.length ? '\n' : ''),
    'utf8',
  );
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Narrows an unknown manifest `lastIssued` value into a typed map, or returns false. */
function presencedLastIssued(v: unknown): v is Record<string, { batchId: string }> {
  if (!isRecord(v)) return false;
  for (const entry of Object.values(v)) {
    if (!isRecord(entry) || typeof entry.batchId !== 'string') return false;
  }
  return true;
}

function artifactText(artifact: LlmArtifact): string {
  return JSON.stringify({
    analysis: artifact.analysis,
    nodes: artifact.graph.nodes.map((n) => ({ name: n.name, summary: n.summary, kind: n.kind })),
  }).toLowerCase();
}
