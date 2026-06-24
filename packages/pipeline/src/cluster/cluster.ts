/**
 * M7 structural clustering — builds an undirected weighted graph over symbol↔symbol structural
 * edges (calls / imports / inherits / implements), runs {@link louvain}, and emits `cluster` nodes
 * + `member-of` edges (symbol → cluster, EXTRACTED, conf 1.0).
 *
 * Determinism (the M7 gate — byte-identical cluster ids + member-of across runs): node indices are
 * assigned in sorted symbol-id order; Louvain tie-breaks deterministically; each community's slug
 * is `auto-<blake3(sorted member ids)>`, so identical membership ⇒ identical cluster node id. The
 * human `label` is a graceful fallback (the highest-degree member's name) — an enricher may later
 * overwrite it without touching the id.
 *
 * Communities of size 1 are not emitted (isolated symbols stay unclustered). Communities of size ≥ 2
 * become a cluster node with one `member-of` edge per member.
 */
import type { SoulStore } from '@knowledge-crib/core';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import { buildGraph, louvain } from './louvain.js';

/** Structural relations that define symbol↔symbol adjacency for clustering. */
const STRUCTURAL_RELS: ReadonlySet<Rel> = new Set<Rel>([
  'calls',
  'imports',
  'inherits',
  'implements',
]);

export interface ClusterStats {
  /** communities emitted as cluster nodes (size ≥ 2) */
  communities: number;
  /** total member-of edges emitted */
  members: number;
}

/**
 * Phase 4b (M7): cluster symbols by structural adjacency and persist cluster nodes + member-of
 * edges. Idempotent: re-running on an unchanged soul reproduces byte-identical cluster ids + edges.
 */
export function runCluster(soul: SoulStore): ClusterStats {
  // 1. assign deterministic indices to every symbol, sorted by id.
  const symbols = [...soul.iterate('symbol')].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (symbols.length === 0) return { communities: 0, members: 0 };
  const idxOf = new Map<string, number>();
  for (let i = 0; i < symbols.length; i++) idxOf.set(symbols[i]!.id, i);

  // 2. collect weighted undirected edges between symbols (multiplicity → weight).
  const edgeMap = new Map<string, number>();
  for (const e of soul.iterateEdges()) {
    if (!STRUCTURAL_RELS.has(e.rel)) continue;
    const a = idxOf.get(e.src);
    const b = idxOf.get(e.dst);
    if (a === undefined || b === undefined) continue; // edge touches a non-symbol node
    const key = a <= b ? `${a}:${b}` : `${b}:${a}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
  }
  const edges: Array<[number, number, number]> = [];
  for (const [key, w] of edgeMap) {
    const [a, b] = key.split(':').map(Number) as [number, number];
    edges.push([a, b, w]);
  }

  // 3. run Louvain (no structural edges ⇒ every node its own community ⇒ nothing to emit).
  const graph = buildGraph(symbols.length, edges);
  const labels = louvain(graph);

  // 4. group members by community label.
  const byCom = new Map<number, string[]>();
  const degreeByNode = new Float64Array(symbols.length);
  for (let i = 0; i < symbols.length; i++) {
    for (const w of graph.adj[i]!.values()) degreeByNode[i] = degreeByNode[i]! + w;
  }
  for (let i = 0; i < symbols.length; i++) {
    const c = labels[i]!;
    const list = byCom.get(c) ?? [];
    list.push(symbols[i]!.id);
    byCom.set(c, list);
  }

  const clusterNodes: Node[] = [];
  const memberEdges: Edge[] = [];
  let communities = 0;
  for (const members of byCom.values()) {
    if (members.length < 2) continue; // singleton → unclustered
    members.sort(); // deterministic membership order
    const slug = `auto-${contentHash(members.join('\n')).slice(7, 19)}`;
    const clusterId = idFor({ kind: 'cluster', slug });

    // graceful label fallback: the highest-degree member (tie-break by id, already sorted).
    const topId = members
      .map((id) => idxOf.get(id)!)
      .reduce((best, idx) => (degreeByNode[idx]! > degreeByNode[best]! ? idx : best));
    const topNode = soul.getNode(members.find((id) => idxOf.get(id) === topId)!)!;
    const label = topNode?.qualifiedName ?? topNode?.name ?? slug;

    clusterNodes.push({
      id: clusterId,
      kind: 'cluster',
      label,
      members,
      hash: contentHash(`${slug}|${members.join(',')}`),
    });
    for (const memberId of members) {
      memberEdges.push({
        id: edgeId(memberId, clusterId, 'member-of'),
        src: memberId,
        dst: clusterId,
        rel: 'member-of',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'louvain', community: members.length },
      });
    }
    communities++;
  }

  if (clusterNodes.length > 0) soul.putNodes(clusterNodes);
  if (memberEdges.length > 0) soul.putEdges(memberEdges);
  return { communities, members: memberEdges.length };
}
