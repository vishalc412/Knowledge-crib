/**
 * SoulStore — the source of truth.
 *
 * Chunked JSONL on disk under `.crib/`, an in-memory graph model in process. All pipeline writes
 * land here first; the IndexStore is derived from it. Single-writer. Writes are validated against
 * the vendored JSON Schema, routed to a shard by source path, and flushed atomically (temp→rename)
 * on `commit()`. On-disk records are sorted by id within each chunk so an unchanged source
 * re-indexes byte-identically (the determinism gate).
 *
 * Memory model: the store hydrates the full graph into Maps on `load()`. At the C4 default scale
 * (100k LOC / 10k files) this is comfortably in-memory; `iterate()` streams from the Maps.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { SUPPORTED_SCHEMA_VERSIONS, VENDORED_SCHEMAS } from '@knowledge-crib/soul-schema';
import type {
  Edge,
  Manifest,
  ManifestCapabilities,
  Node,
  NodeKind,
  Rel,
} from '@knowledge-crib/soul-schema';
import { resolveEdgeConflict } from './conflict-rule.js';
import { graphPaths, hasCanonicalGraph } from './graph-layout.js';
import { newManifest } from './manifest.js';
import { pathFromId, shardKeyForEdge, shardKeyForNode, shardOf } from './shard.js';
import { assertValidEdge, assertValidManifest, assertValidNode } from './validate.js';

export const MANIFEST_FILE = 'crib.json';
const CLUSTERS_FILE = join('clusters', 'clusters.jsonl');

export interface SoulStoreOpts {
  /** Manifest to seed a fresh soul; ignored if a manifest already exists on disk. */
  manifest?: Manifest;
  /**
   * W6 — mark this store EPHEMERAL: an in-memory working copy that mirrors a committed soul but must
   * never persist. `commit()` becomes a no-op (the dirty-shard flush, manifest write, and vendored
   * schema/gitignore writes are all skipped), so the overlay can `load()` from a canonical `.crib`
   * directory for a fast seed and then mutate freely in memory with ZERO risk of dirtying the
   * committed `.crib/graph` shards. This is the structural guard the PRD failure-audit (line 467)
   * demands: "Watch mode dirties committed soul → Separate working-tree overlay under ignored runtime
   * storage." `setVcsHead`/`setIncrementalSince`/`setCapabilities` still mutate the in-memory manifest
   * (harmless — never flushed) so readers that consult the manifest see consistent state.
   */
  ephemeral?: boolean;
}

/**
 * A guard-chain patch for {@link SoulStore.annotateEdges}. `id` selects an existing edge; the
 * remaining fields are the M11 CFG annotation. Only fields present (≠ `undefined`) are written.
 */
export interface EdgeAnnotation {
  id: string;
  guard?: string;
  cfgPath?: string[];
  branch?: string;
  inLoop?: boolean;
  inException?: boolean;
}

export class SoulStore {
  private readonly nodes = new Map<string, Node>();
  private readonly edges = new Map<string, Edge>();
  private manifest: Manifest;
  private readonly canonicalLayout: boolean;
  /** W6 — when true, `commit()` is a no-op so an in-memory overlay can never dirty a canonical `.crib`. */
  private readonly ephemeral: boolean;

  /** Node shards whose chunk files must be rewritten on commit. */
  private readonly dirtyNodeShards = new Set<string>();
  /** Edge shards whose chunk files must be rewritten on commit. */
  private readonly dirtyEdgeShards = new Set<string>();
  private clustersDirty = false;

  /**
   * @param cribDir absolute path to the `.crib` directory.
   */
  constructor(
    private readonly cribDirPrivate: string,
    opts: SoulStoreOpts = {},
  ) {
    this.manifest = opts.manifest ?? newManifest({ root: '.' });
    this.canonicalLayout =
      hasCanonicalGraph(cribDirPrivate) || !existsSync(join(cribDirPrivate, MANIFEST_FILE));
    this.ephemeral = opts.ephemeral === true;
  }

  /** Read the manifest and hydrate the graph from existing chunks. Returns the manifest. */
  load(): Manifest {
    const manifestPath = this.manifestPath;
    if (existsSync(manifestPath)) {
      this.manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      // Loader gate (M11): refuse a soul whose schemaVersion we don't know how to read. A 1.0 soul
      // (pre-M11, no Edge.cfgPath) is accepted as-is — its absent cfgPath stays `undefined` (no
      // widening) and is preserved verbatim on the next commit.
      const v = this.manifest.schemaVersion;
      if (!SUPPORTED_SCHEMA_VERSIONS.includes(v as (typeof SUPPORTED_SCHEMA_VERSIONS)[number])) {
        throw new Error(
          `unsupported soul schemaVersion "${v}"; supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
        );
      }
    }
    this.nodes.clear();
    this.edges.clear();
    this.hydrateNodes();
    this.hydrateEdges();
    this.dirtyNodeShards.clear();
    this.dirtyEdgeShards.clear();
    this.clustersDirty = false;
    return this.manifest;
  }

  /**
   * Prepare for a clean FULL rebuild over a possibly-stale `.crib`: drop in-memory state and
   * schedule EVERY on-disk node/edge/cluster shard + the dossiers cache for rewrite-on-commit, so
   * orphan shards from a previous (older-schema) soul are pruned instead of layered upon. The
   * manifest is left untouched (the caller constructs a fresh one stamped with the current
   * SCHEMA_VERSION). This is the fix for `crib index` over an existing `.crib` — `load()` would
   * hydrate stale nodes AND overwrite the fresh manifest, so a full rebuild must NOT load().
   */
  resetForRebuild(): void {
    this.nodes.clear();
    this.edges.clear();
    const nodesRoot = this.nodesRoot;
    if (existsSync(nodesRoot)) for (const s of readdirSync(nodesRoot)) this.dirtyNodeShards.add(s);
    const edgesRoot = this.edgesRoot;
    if (existsSync(edgesRoot)) for (const s of readdirSync(edgesRoot)) this.dirtyEdgeShards.add(s);
    this.clustersDirty = true;
    // The dossier cache stays in place here. The post-commit runDossiers phase compares rebuilt
    // graph-dependent content while ignoring only `builtAt`, preserving byte stability for true
    // no-ops and pruning artifacts whose node disappeared.
  }

  /** Upsert nodes by id. Routes each to its shard and marks that shard dirty. */
  putNodes(ns: Node[]): void {
    for (const node of ns) {
      assertValidNode(node);
      this.nodes.set(node.id, node);
      this.markNodeDirty(node);
    }
  }

  /** Upsert edges by id, collapsing `(src,dst,rel)` collisions via the conflict rule. */
  putEdges(es: Edge[]): void {
    for (const edge of es) {
      assertValidEdge(edge);
      const existing = this.edges.get(edge.id);
      const winner = existing ? resolveEdgeConflict(existing, edge) : edge;
      this.edges.set(edge.id, winner);
      this.dirtyEdgeShards.add(shardOf(shardKeyForEdge(winner), this.shardDigits));
    }
  }

  /**
   * Atomically replace structural functionality clusters and their membership edges.
   *
   * Clustering is global: a topology change can change every community id. Plain upserts therefore
   * leave obsolete cluster nodes and `member-of` edges behind. Validate the complete replacement
   * before touching store state, then remove every edge incident to an old cluster and install the
   * new, internally-consistent topology.
   */
  replaceClusters(clusters: Node[], memberships: Edge[]): void {
    const clusterById = new Map<string, Node>();
    const ownerByMember = new Map<string, string>();
    const expectedEdges = new Set<string>();

    for (const cluster of clusters) {
      assertValidNode(cluster);
      if (cluster.kind !== 'cluster') {
        throw new Error(`replaceClusters expected cluster node, got ${cluster.kind}:${cluster.id}`);
      }
      if (clusterById.has(cluster.id)) {
        throw new Error(`replaceClusters duplicate cluster id: ${cluster.id}`);
      }
      clusterById.set(cluster.id, cluster);
      const declared = new Set<string>();
      for (const memberId of cluster.members ?? []) {
        if (declared.has(memberId)) {
          throw new Error(`cluster ${cluster.id} declares duplicate member ${memberId}`);
        }
        declared.add(memberId);
        const member = this.nodes.get(memberId);
        if (!member) {
          throw new Error(`cluster ${cluster.id} references missing member ${memberId}`);
        }
        if (member.kind !== 'symbol') {
          throw new Error(
            `cluster ${cluster.id} member ${memberId} is ${member.kind}, expected symbol`,
          );
        }
        const previous = ownerByMember.get(memberId);
        if (previous && previous !== cluster.id) {
          throw new Error(
            `cluster member ${memberId} belongs to both ${previous} and ${cluster.id}`,
          );
        }
        ownerByMember.set(memberId, cluster.id);
        expectedEdges.add(`${memberId}\0${cluster.id}`);
      }
    }

    const actualEdges = new Set<string>();
    for (const membership of memberships) {
      assertValidEdge(membership);
      if (membership.rel !== 'member-of' || !clusterById.has(membership.dst)) {
        throw new Error(
          `replaceClusters expected member-of edge into replacement cluster: ${membership.id}`,
        );
      }
      if (!this.nodes.has(membership.src)) {
        throw new Error(`cluster membership ${membership.id} has missing source ${membership.src}`);
      }
      const key = `${membership.src}\0${membership.dst}`;
      if (actualEdges.has(key)) {
        throw new Error(
          `replaceClusters duplicate membership ${membership.src} -> ${membership.dst}`,
        );
      }
      actualEdges.add(key);
    }
    if (
      actualEdges.size !== expectedEdges.size ||
      [...expectedEdges].some((key) => !actualEdges.has(key))
    ) {
      throw new Error('replaceClusters cluster members[] and membership edges do not match');
    }

    const oldClusterIds = new Set(
      [...this.nodes.values()].filter((node) => node.kind === 'cluster').map((node) => node.id),
    );
    for (const id of oldClusterIds) this.nodes.delete(id);
    if (oldClusterIds.size > 0 || clusters.length > 0) this.clustersDirty = true;
    for (const edge of [...this.edges.values()]) {
      if (!oldClusterIds.has(edge.src) && !oldClusterIds.has(edge.dst)) continue;
      this.edges.delete(edge.id);
      this.dirtyEdgeShards.add(shardOf(shardKeyForEdge(edge), this.shardDigits));
    }

    this.putNodes(clusters);
    this.putEdges(memberships);
  }

  /**
   * Annotate-existing (M11 CFG pass): overwrite the guard-chain fields on edges already in the
   * soul. This is the overwrite primitive the CFG pass uses to stamp `guard`/`cfgPath`/`branch`/
   * `inLoop`/`inException` onto `executes`/`calls` edges the extractor + resolver already emitted.
   * A field absent from an update is left untouched; an update whose edge id isn't present is
   * skipped (never invents an edge). The edge keeps its own provenance/method/confidence/evidence
   * — only the guard-chain fields are merged. Dirty shards are rewritten on the next `commit()`.
   */
  annotateEdges(updates: EdgeAnnotation[]): void {
    for (const u of updates) {
      const edge = this.edges.get(u.id);
      if (!edge) continue;
      let changed = false;
      if (u.guard !== undefined) {
        edge.guard = u.guard;
        changed = true;
      }
      if (u.cfgPath !== undefined) {
        edge.cfgPath = u.cfgPath;
        changed = true;
      }
      if (u.branch !== undefined) {
        edge.branch = u.branch;
        changed = true;
      }
      if (u.inLoop !== undefined) {
        edge.inLoop = u.inLoop;
        changed = true;
      }
      if (u.inException !== undefined) {
        edge.inException = u.inException;
        changed = true;
      }
      if (changed) this.dirtyEdgeShards.add(shardOf(shardKeyForEdge(edge), this.shardDigits));
    }
  }

  getNode(id: string): Node | undefined {
    return this.nodes.get(id);
  }

  getEdge(id: string): Edge | undefined {
    return this.edges.get(id);
  }

  *iterate(kind?: NodeKind): Iterable<Node> {
    for (const node of this.nodes.values()) {
      if (!kind || node.kind === kind) yield node;
    }
  }

  *iterateEdges(rel?: Rel): Iterable<Edge> {
    for (const edge of this.edges.values()) {
      if (!rel || edge.rel === rel) yield edge;
    }
  }

  /** Drop a file's nodes and any edge that touches the file (incremental re-extraction). */
  removeByFile(path: string): void {
    for (const node of [...this.nodes.values()]) {
      if (node.file === path || pathFromId(node.id) === path) {
        this.nodes.delete(node.id);
        this.markNodeDirty(node);
      }
    }
    for (const edge of [...this.edges.values()]) {
      if (pathFromId(edge.src) === path || pathFromId(edge.dst) === path) {
        this.edges.delete(edge.id);
        this.dirtyEdgeShards.add(shardOf(shardKeyForEdge(edge), this.shardDigits));
      }
    }
  }

  /** Flush dirty shards atomically, prune dangling edges, rewrite manifest + vendored schemas. */
  commit(now = new Date().toISOString(), preserveTimestamp = false): void {
    // W6 — an ephemeral (working-overlay) store is an in-memory mirror only; persisting would dirty
    // the canonical `.crib/graph` it loaded from. The PRD failure-audit (line 467) makes this a
    // hard structural guard, not a convention.
    if (this.ephemeral) return;
    const graphChanged =
      this.dirtyNodeShards.size > 0 || this.dirtyEdgeShards.size > 0 || this.clustersDirty;
    this.pruneDangling();
    this.writeVendoredSchemas();
    this.writeGitignore();

    for (const shard of this.dirtyNodeShards) this.writeNodeShard(shard);
    this.writeClusters(); // cluster nodes live in their own file
    for (const shard of this.dirtyEdgeShards) this.writeEdgeShard(shard);

    this.refreshStats(now, preserveTimestamp);
    if (this.canonicalLayout && graphChanged) {
      const generation = this.manifest.generation ?? { extracted: 0, semantic: 0 };
      this.manifest.generation = { ...generation, extracted: generation.extracted + 1 };
    }
    this.writeManifest();

    this.dirtyNodeShards.clear();
    this.dirtyEdgeShards.clear();
    this.clustersDirty = false;
  }

  getManifest(): Manifest {
    return this.manifest;
  }

  /** Absolute path to the `.crib` directory this store owns (where dossiers + shards live). */
  get cribDir(): string {
    return this.cribDirPrivate;
  }

  /**
   * Stamp the VCS anchor: the git sha an incremental update is anchored to (M6). Sets both
   * `repo.vcsHead` and `stats.incrementalSince` so the next `crib update` / `detect_changes` can diff
   * against it. Persisted on the next `commit()`.
   */
  setVcsHead(sha: string): void {
    this.manifest.repo = { ...this.manifest.repo, vcsHead: sha };
    this.manifest.stats = { ...this.manifest.stats, incrementalSince: sha };
  }

  /**
   * Advance only the incremental diff anchor (`stats.incrementalSince`) without touching the committed
   * `repo.vcsHead`. Used by dirty updates: the soul is refreshed to include uncommitted working-tree
   * changes, but `vcsHead` stays pinned to the last real commit so `crib status` can still detect and
   * report the dirty delta. Persisted on the next `commit()`.
   */
  setIncrementalSince(sha: string): void {
    this.manifest.stats = { ...this.manifest.stats, incrementalSince: sha };
  }

  /**
   * Record a derived capability (M13): `multimodal` flips true once media segments have been ingested,
   * `embeddings` once a vector index exists (M7+). Merge-in semantics — pass only the flags that
   * changed. Persisted on the next `commit()`. Readers (`status`, MCP) advertise capabilities so a
   * client knows whether media nodes / ANN search are available without scanning the soul.
   */
  setCapabilities(patch: Partial<ManifestCapabilities>): void {
    this.manifest.capabilities = { ...this.manifest.capabilities, ...patch };
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private get shardDigits(): number {
    return this.manifest.chunking.shardHexDigits;
  }

  private get maxChunkLines(): number {
    return this.manifest.chunking.maxChunkLines;
  }

  private get manifestPath(): string {
    return this.canonicalLayout
      ? graphPaths(this.cribDirPrivate).manifest
      : join(this.cribDirPrivate, MANIFEST_FILE);
  }

  private get extractedRoot(): string {
    return this.canonicalLayout ? graphPaths(this.cribDirPrivate).extracted : this.cribDirPrivate;
  }

  private get nodesRoot(): string {
    return join(this.extractedRoot, 'nodes');
  }

  private get edgesRoot(): string {
    return join(this.extractedRoot, 'edges');
  }

  private get clustersPath(): string {
    return join(this.extractedRoot, CLUSTERS_FILE);
  }

  /** Cluster nodes go to clusters/clusters.jsonl; all other nodes shard normally. */
  private markNodeDirty(node: Node): void {
    if (node.kind === 'cluster') {
      this.clustersDirty = true;
    } else {
      this.dirtyNodeShards.add(shardOf(shardKeyForNode(node), this.shardDigits));
    }
  }

  /** Enforce invariant #1: every edge endpoint resolves; drop danglers and dirty their shards. */
  private pruneDangling(): void {
    for (const edge of [...this.edges.values()]) {
      if (!this.nodes.has(edge.src) || !this.nodes.has(edge.dst)) {
        this.edges.delete(edge.id);
        this.dirtyEdgeShards.add(shardOf(shardKeyForEdge(edge), this.shardDigits));
      }
    }
  }

  private refreshStats(now: string, preserveTimestamp = false): void {
    let clusters = 0;
    for (const n of this.nodes.values()) if (n.kind === 'cluster') clusters++;
    // `lastUpdated` means "soul content last updated", not "manifest file last touched". A no-op
    // update that only advances the vcsHead anchor (no nodes/edges changed) must NOT bump it —
    // bumping it would (a) break crib.json byte-stability across idempotent re-runs (the
    // cache:stability gate's premise, per llm-overlay.ts's deliberate avoidance of soul.commit()
    // from the MCP server) and (b) make the M4.3 crib-soul-refresh GitHub Action emit a spurious
    // "refresh soul" commit on every merge even when the graph didn't change. preserveTimestamp
    // reuses the existing lastUpdated for those anchor-only catches.
    this.manifest.stats = {
      ...this.manifest.stats,
      nodes: this.nodes.size,
      edges: this.edges.size,
      clusters,
      lastUpdated: preserveTimestamp ? this.manifest.stats.lastUpdated : now,
    };
  }

  // --- hydration ---

  private hydrateNodes(): void {
    const nodesRoot = this.nodesRoot;
    for (const file of this.walkJsonl(nodesRoot)) {
      for (const node of this.readRecords<Node>(file)) this.nodes.set(node.id, node);
    }
    const clustersPath = this.clustersPath;
    if (existsSync(clustersPath)) {
      for (const node of this.readRecords<Node>(clustersPath)) this.nodes.set(node.id, node);
    }
  }

  private hydrateEdges(): void {
    const edgesRoot = this.edgesRoot;
    for (const file of this.walkJsonl(edgesRoot)) {
      for (const edge of this.readRecords<Edge>(file)) this.edges.set(edge.id, edge);
    }
  }

  private *walkJsonl(root: string): Iterable<string> {
    if (!existsSync(root)) return;
    for (const shard of readdirSync(root)) {
      const shardDir = join(root, shard);
      let entries: string[];
      try {
        entries = readdirSync(shardDir);
      } catch {
        continue; // not a directory
      }
      for (const f of entries) if (f.endsWith('.jsonl')) yield join(shardDir, f);
    }
  }

  private readRecords<T>(file: string): T[] {
    const text = readFileSync(file, 'utf8');
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      out.push(JSON.parse(line) as T);
    }
    return out;
  }

  // --- writing ---

  private writeNodeShard(shard: string): void {
    const records = [...this.nodes.values()]
      .filter(
        (n) => n.kind !== 'cluster' && shardOf(shardKeyForNode(n), this.shardDigits) === shard,
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.writeShardChunks(join(this.nodesRoot, shard), records);
  }

  private writeEdgeShard(shard: string): void {
    const records = [...this.edges.values()]
      .filter((e) => shardOf(shardKeyForEdge(e), this.shardDigits) === shard)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.writeShardChunks(join(this.edgesRoot, shard), records);
  }

  private writeClusters(): void {
    if (!this.clustersDirty) return;
    const records = [...this.nodes.values()]
      .filter((n) => n.kind === 'cluster')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const path = this.clustersPath;
    if (records.length === 0) {
      if (existsSync(path)) rmSync(path);
      return;
    }
    this.atomicWrite(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }

  /** Rewrite a shard directory into chunk files rolling at maxChunkLines; remove stale chunks. */
  private writeShardChunks(shardDir: string, records: (Node | Edge)[]): void {
    // Remove the whole shard dir if it now holds nothing.
    if (records.length === 0) {
      if (existsSync(shardDir)) rmSync(shardDir, { recursive: true, force: true });
      return;
    }
    mkdirSync(shardDir, { recursive: true });
    const written = new Set<string>();
    let chunkIndex = 0;
    for (let i = 0; i < records.length; i += this.maxChunkLines) {
      const slice = records.slice(i, i + this.maxChunkLines);
      const name = `${String(chunkIndex).padStart(4, '0')}.jsonl`;
      this.atomicWrite(join(shardDir, name), `${slice.map((r) => JSON.stringify(r)).join('\n')}\n`);
      written.add(name);
      chunkIndex++;
    }
    // Drop any leftover chunk files from a previous, larger generation.
    for (const f of readdirSync(shardDir)) {
      if (f.endsWith('.jsonl') && !written.has(f)) rmSync(join(shardDir, f));
    }
  }

  private writeVendoredSchemas(): void {
    const dir = join(this.cribDirPrivate, 'schema');
    mkdirSync(dir, { recursive: true });
    for (const [name, schema] of Object.entries(VENDORED_SCHEMAS)) {
      this.atomicWrite(join(dir, name), `${JSON.stringify(schema, null, 2)}\n`);
    }
  }

  private writeGitignore(): void {
    const path = join(this.cribDirPrivate, '.gitignore');
    if (!existsSync(path)) {
      this.atomicWrite(path, 'index/\nembeddings/\n');
    }
  }

  private writeManifest(): void {
    const stores = this.manifest.stores as Manifest['stores'] & {
      graph?: { path: string; format: string };
    };
    stores.graph = { path: '.crib/graph', format: 'layered-jsonl' };
    assertValidManifest(this.manifest);
    const content = `${JSON.stringify(this.manifest, null, 2)}\n`;
    this.atomicWrite(this.manifestPath, content);
    // Bootstrap/registry locator only. Graph state/stats exist solely in graph/manifest.json.
    if (this.canonicalLayout) {
      this.atomicWrite(
        join(this.cribDirPrivate, MANIFEST_FILE),
        `${JSON.stringify(
          {
            cribFormatVersion: this.manifest.cribFormatVersion,
            repo: { id: this.manifest.repo.id, root: this.manifest.repo.root },
            stores: { graph: this.manifest.stores.graph },
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  /** Write-temp → rename, so a reader never sees a half-written file. */
  private atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  }
}
