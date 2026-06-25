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
import { newManifest } from './manifest.js';
import { pathFromId, shardKeyForEdge, shardKeyForNode, shardOf } from './shard.js';
import { assertValidEdge, assertValidManifest, assertValidNode } from './validate.js';

const MANIFEST_FILE = 'crib.json';
const CLUSTERS_FILE = join('clusters', 'clusters.jsonl');

export interface SoulStoreOpts {
  /** Manifest to seed a fresh soul; ignored if a manifest already exists on disk. */
  manifest?: Manifest;
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
  }

  /** Read the manifest and hydrate the graph from existing chunks. Returns the manifest. */
  load(): Manifest {
    const manifestPath = join(this.cribDirPrivate, MANIFEST_FILE);
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
  commit(now = new Date().toISOString()): void {
    this.pruneDangling();
    this.writeVendoredSchemas();
    this.writeGitignore();

    for (const shard of this.dirtyNodeShards) this.writeNodeShard(shard);
    this.writeClusters(); // cluster nodes live in their own file
    for (const shard of this.dirtyEdgeShards) this.writeEdgeShard(shard);

    this.refreshStats(now);
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

  private refreshStats(now: string): void {
    let clusters = 0;
    for (const n of this.nodes.values()) if (n.kind === 'cluster') clusters++;
    this.manifest.stats = {
      ...this.manifest.stats,
      nodes: this.nodes.size,
      edges: this.edges.size,
      clusters,
      lastUpdated: now,
    };
  }

  // --- hydration ---

  private hydrateNodes(): void {
    const nodesRoot = join(this.cribDirPrivate, 'nodes');
    for (const file of this.walkJsonl(nodesRoot)) {
      for (const node of this.readRecords<Node>(file)) this.nodes.set(node.id, node);
    }
    const clustersPath = join(this.cribDirPrivate, CLUSTERS_FILE);
    if (existsSync(clustersPath)) {
      for (const node of this.readRecords<Node>(clustersPath)) this.nodes.set(node.id, node);
    }
  }

  private hydrateEdges(): void {
    const edgesRoot = join(this.cribDirPrivate, 'edges');
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
    this.writeShardChunks(join(this.cribDirPrivate, 'nodes', shard), records);
  }

  private writeEdgeShard(shard: string): void {
    const records = [...this.edges.values()]
      .filter((e) => shardOf(shardKeyForEdge(e), this.shardDigits) === shard)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.writeShardChunks(join(this.cribDirPrivate, 'edges', shard), records);
  }

  private writeClusters(): void {
    if (!this.clustersDirty) return;
    const records = [...this.nodes.values()]
      .filter((n) => n.kind === 'cluster')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const path = join(this.cribDirPrivate, CLUSTERS_FILE);
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
    assertValidManifest(this.manifest);
    this.atomicWrite(
      join(this.cribDirPrivate, MANIFEST_FILE),
      `${JSON.stringify(this.manifest, null, 2)}\n`,
    );
  }

  /** Write-temp → rename, so a reader never sees a half-written file. */
  private atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  }
}
