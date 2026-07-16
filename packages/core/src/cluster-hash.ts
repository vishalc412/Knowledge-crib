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

/** Members of a cluster — resolved from the `members` array (the pipeline's stamp) with a
 *  `clusterId` back-compat path for souls that stamp it onto symbols. Sorted by id. */
export function clusterMembers(soul: SoulStore, cluster: Node): Node[] {
  const ids = new Set(cluster.members ?? []);
  const slug = cluster.id.startsWith('c:') ? cluster.id.slice(2) : cluster.id;
  return [...soul.iterate('symbol')]
    .filter((n) => ids.has(n.id) || n.clusterId === cluster.id || n.clusterId === slug)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Content hash of a cluster: blake3 of `cluster.hash|<sorted member hashes>`. Changes iff the
 *  cluster node OR any member's content changes — the staleness signal for cluster LLM artifacts.
 *  Byte-identical to `EnrichmentStore.clusterHash`. */
export function clusterContentHash(soul: SoulStore, cluster: Node): string {
  const memberHashes = clusterMembers(soul, cluster)
    .map((n) => n.hash)
    .sort();
  return contentHash([cluster.hash, ...memberHashes].join('|'));
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
