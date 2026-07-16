import { dirname } from 'node:path';
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
  if (symbols.length === 0) {
    soul.replaceClusters([], []);
    return { communities: 0, members: 0 };
  }
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

    // Heuristic label (outcome E): "<longestCommonDirPrefix(memberFiles)> · <dominantStereotypeOrType>".
    // Falls back to the highest-degree member's qualified name when members span roots (no common
    // directory prefix). Deterministic — alphabetical tie-breaks throughout. The cluster `id` and
    // `hash` are untouched, so this never cascades artifact staleness. An LLM cluster name surfaces
    // later via the read-time overlay (consumers prefer `overlay.name`); this heuristic is the
    // pre-enrichment default.
    const memberNodes = members.map((id) => soul.getNode(id)).filter((n): n is Node => !!n);
    const label =
      heuristicClusterLabel(memberNodes) ??
      fallbackQualifiedName(members, idxOf, degreeByNode, soul, slug);

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

  soul.replaceClusters(clusterNodes, memberEdges);
  return { communities, members: memberEdges.length };
}

/**
 * Heuristic cluster label: `"<longestCommonDirPrefix(memberFiles)> · <dominantStereotypeOrType>"`.
 * Returns `undefined` when the members span roots (no shared directory prefix), so the caller falls
 * back to the highest-degree member's qualified name. Deterministic: stereotype/type tallies use
 * alphabetical tie-breaks; the directory prefix is mechanical.
 */
function heuristicClusterLabel(members: Node[]): string | undefined {
  const files = members.map((m) => m.file).filter((f): f is string => !!f);
  const prefix = longestCommonDirPrefix(files);
  if (prefix === undefined) return undefined; // members span roots → caller falls back
  const dominant = dominantStereotypeOrType(members);
  return `${prefix} · ${dominant}`;
}

/** Longest common leading directory prefix across a set of file paths. Returns `undefined` when
 *  there is no shared first segment (members live under different roots). */
function longestCommonDirPrefix(files: string[]): string | undefined {
  const dirs = files.map((f) => dirname(f)).filter((d) => d !== '.' && d !== '');
  if (dirs.length === 0) return undefined;
  const split = dirs.map((d) => d.split('/'));
  const common: string[] = [];
  const first = split[0]!;
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]!;
    if (split.every((parts) => parts[i] === seg)) common.push(seg);
    else break;
  }
  return common.length > 0 ? common.join('/') : undefined;
}

/** The most common stereotype among the members, else the most common `type`, else `'symbol'`.
 *  Alphabetical tie-breaks so the label is deterministic run-to-run. */
function dominantStereotypeOrType(members: Node[]): string {
  const stereotypes = new Map<string, number>();
  const types = new Map<string, number>();
  for (const m of members) {
    if (m.stereotype) stereotypes.set(m.stereotype, (stereotypes.get(m.stereotype) ?? 0) + 1);
    if (m.type) types.set(m.type, (types.get(m.type) ?? 0) + 1);
  }
  const best = (counts: Map<string, number>): string | undefined => {
    let bestKey: string | undefined;
    let bestN = 0;
    for (const [k, n] of counts) {
      if (n > bestN || (n === bestN && (bestKey === undefined || k < bestKey))) {
        bestKey = k;
        bestN = n;
      }
    }
    return bestKey;
  };
  return best(stereotypes) ?? best(types) ?? 'symbol';
}

/** Fallback label: the highest-degree member's qualified name (the pre-E behavior). */
function fallbackQualifiedName(
  members: string[],
  idxOf: Map<string, number>,
  degreeByNode: Float64Array,
  soul: SoulStore,
  slug: string,
): string {
  const topId = members
    .map((id) => idxOf.get(id)!)
    .reduce((best, idx) => (degreeByNode[idx]! > degreeByNode[best]! ? idx : best));
  const topNode = soul.getNode(members.find((id) => idxOf.get(id) === topId)!)!;
  return topNode?.qualifiedName ?? topNode?.name ?? slug;
}
