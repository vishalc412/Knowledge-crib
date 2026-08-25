import { contentHash } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
/**
 * Cluster membership + content hash — extracted verbatim from `mcp/src/enrichment.ts` so the
 * `core`-resident functional map / LLM overlay can compute cluster staleness without a dependency
 * on the MCP layer, and so the enrich queue's cluster targeting stays byte-identical to the
 * EnrichmentStore's own `clusterHash`. A mismatch here would mark every cluster artifact stale, so
 * `cluster-hash.parity.test.ts` guards the byte-equality end-to-end.
 */
import type { SoulStore } from './soul-store.js';

/**
 * Symbols grouped by their stamped `clusterId`, cached per SoulStore.
 *
 * The back-compat `clusterId` lookup used to be a full scan of every symbol, run once per cluster —
 * O(clusters x symbols), i.e. ~3M comparisons over this repo's 666 clusters, and the dominant cost
 * in `enrich_next`. One grouping pass replaces all of them.
 *
 * Keyed weakly by soul so the cache dies with the store, and versioned by `soul.nodeGeneration` so
 * any node mutation invalidates it exactly — no heuristic staleness check.
 */
const clusterIdBuckets = new WeakMap<
  SoulStore,
  { generation: number; buckets: Map<string, Node[]> }
>();

function symbolsByClusterId(soul: SoulStore): Map<string, Node[]> {
  const generation = soul.nodeGeneration;
  const cached = clusterIdBuckets.get(soul);
  if (cached !== undefined && cached.generation === generation) return cached.buckets;
  const buckets = new Map<string, Node[]>();
  for (const node of soul.iterate('symbol')) {
    const key = node.clusterId;
    if (key === undefined) continue;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [node]);
    else bucket.push(node);
  }
  clusterIdBuckets.set(soul, { generation, buckets });
  return buckets;
}

/** Members of a cluster — resolved from the `members` array (the pipeline's stamp) with a
 *  `clusterId` back-compat path for souls that stamp it onto symbols. Sorted by id. */
export function clusterMembers(soul: SoulStore, cluster: Node): Node[] {
  const slug = cluster.id.startsWith('c:') ? cluster.id.slice(2) : cluster.id;
  // Deduped by id: a symbol listed in `members` AND stamped with `clusterId` appeared once under
  // the old single-pass filter, and must still appear once here.
  const found = new Map<string, Node>();
  for (const id of cluster.members ?? []) {
    const node = soul.getNode(id);
    // Kind check preserves the old semantics: the scan only ever considered `symbol` nodes, so a
    // `members` entry pointing at anything else was silently skipped.
    if (node !== undefined && node.kind === 'symbol') found.set(node.id, node);
  }
  const byClusterId = symbolsByClusterId(soul);
  for (const key of slug === cluster.id ? [cluster.id] : [cluster.id, slug]) {
    for (const node of byClusterId.get(key) ?? []) found.set(node.id, node);
  }
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Per-soul cache of computed cluster hashes, versioned by `soul.nodeGeneration`. `readLlmOverlay`
 *  hashes every cluster to decide staleness, so without this the same 666 blake3 digests were
 *  recomputed on each overlay read. */
const clusterHashCache = new WeakMap<
  SoulStore,
  { generation: number; hashes: Map<string, string> }
>();

/** Content hash of a cluster: blake3 of `cluster.hash|<sorted member hashes>`. Changes iff the
 *  cluster node OR any member's content changes — the staleness signal for cluster LLM artifacts.
 *  Byte-identical to `EnrichmentStore.clusterHash`. */
export function clusterContentHash(soul: SoulStore, cluster: Node): string {
  const generation = soul.nodeGeneration;
  let entry = clusterHashCache.get(soul);
  if (entry === undefined || entry.generation !== generation) {
    entry = { generation, hashes: new Map<string, string>() };
    clusterHashCache.set(soul, entry);
  }
  // Keyed by the cluster node's own hash as well as its id: `replaceClusters` bumps the generation,
  // but a caller passing a detached cluster object with the same id must not get a stale digest.
  const key = `${cluster.id}\u0000${cluster.hash}`;
  const memo = entry.hashes.get(key);
  if (memo !== undefined) return memo;
  const memberHashes = clusterMembers(soul, cluster)
    .map((n) => n.hash)
    .sort();
  const digest = contentHash([cluster.hash, ...memberHashes].join('|'));
  entry.hashes.set(key, digest);
  return digest;
}

export interface ClusterIntegrityReport {
  valid: boolean;
  issues: string[];
}

/** Validate persisted cluster topology without mutating it. Used by viz to detect legacy souls whose
 * global reclustering accumulated obsolete communities instead of replacing them. */
export function validateClusterIntegrity(soul: SoulStore): ClusterIntegrityReport {
  const clusters = [...soul.iterate('cluster')].sort((a, b) => a.id.localeCompare(b.id));
  const clusterIds = new Set(clusters.map((cluster) => cluster.id));
  const edgeMembers = new Map<string, Set<string>>();
  const ownerByMember = new Map<string, string>();
  const issues: string[] = [];

  for (const edge of soul.iterateEdges('member-of')) {
    if (!clusterIds.has(edge.dst)) continue;
    const members = edgeMembers.get(edge.dst) ?? new Set<string>();
    members.add(edge.src);
    edgeMembers.set(edge.dst, members);
  }

  for (const cluster of clusters) {
    const declared = new Set<string>();
    for (const memberId of cluster.members ?? []) {
      if (declared.has(memberId)) issues.push(`${cluster.id}: duplicate member ${memberId}`);
      declared.add(memberId);
      const member = soul.getNode(memberId);
      if (!member) issues.push(`${cluster.id}: missing member ${memberId}`);
      else if (member.kind !== 'symbol') {
        issues.push(`${cluster.id}: non-symbol member ${memberId} (${member.kind})`);
      }
      const previous = ownerByMember.get(memberId);
      if (previous && previous !== cluster.id) {
        issues.push(`${memberId}: multiple clusters ${previous}, ${cluster.id}`);
      } else ownerByMember.set(memberId, cluster.id);
    }
    const linked = edgeMembers.get(cluster.id) ?? new Set<string>();
    for (const memberId of declared) {
      if (!linked.has(memberId))
        issues.push(`${cluster.id}: missing member-of edge for ${memberId}`);
    }
    for (const memberId of linked) {
      if (!declared.has(memberId))
        issues.push(`${cluster.id}: undeclared member-of source ${memberId}`);
    }
  }

  return { valid: issues.length === 0, issues };
}
