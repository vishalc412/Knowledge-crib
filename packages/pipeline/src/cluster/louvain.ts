/**
 * Pure-JS multi-level Louvain community detection (Blondel et al.), deterministic.
 *
 * Determinism contract (the M7 gate — byte-identical cluster membership across runs): nodes are
 * processed in stable index order (callers pass a sorted, reproducible node ordering), and every
 * tie in modularity gain is broken by (gain desc, community index asc) — never by insertion order
 * or hash. The graph is undirected with non-negative integer weights; `2m` = sum of all degrees.
 *
 * No soul dependency: this operates on a plain {@link LouvainGraph}. The cluster.ts adapter builds
 * that graph from the soul's structural edges and maps communities back to node ids.
 */

export interface LouvainGraph {
  /** number of nodes (indices 0..n-1) */
  n: number;
  /** weighted degree per node (Σ of incident edge weights, both directions) */
  degrees: Float64Array;
  /** per-node neighbor → weight (undirected; each edge stored on both endpoints) */
  adj: Map<number, number>[];
  /** 2m = Σ degrees */
  m2: number;
}

/** Build an undirected weighted graph from weighted edges [a, b, weight]. */
export function buildGraph(
  n: number,
  edges: ReadonlyArray<[number, number, number]>,
): LouvainGraph {
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>());
  const degrees = new Float64Array(n);
  for (const [a, b, w] of edges) {
    if (a === b) {
      // self-loop: contributes 2w to the degree, w to the adjacency (once)
      adj[a]!.set(a, (adj[a]!.get(a) ?? 0) + w);
      degrees[a] = degrees[a]! + 2 * w;
    } else {
      adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w);
      adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + w);
      degrees[a] = degrees[a]! + w;
      degrees[b] = degrees[b]! + w;
    }
  }
  let m2 = 0;
  for (let i = 0; i < n; i++) m2 += degrees[i]!;
  return { n, degrees, adj, m2 };
}

/**
 * Run multi-level Louvain. Returns the community label for each node (0..n-1). Nodes in the same
 * community share a label; labels are dense (relabelled 0..k-1) for a stable output.
 */
export function louvain(graph: LouvainGraph): Int32Array {
  // `communities[i]` = the FINAL community label of original node i, composed across levels.
  let communities = new Int32Array(graph.n);
  for (let i = 0; i < graph.n; i++) communities[i] = i;

  let g: LouvainGraph = graph;
  let improved = true;
  while (improved) {
    const level = oneLevel(g);
    improved = level.moved;
    // Compose across levels: `communities[i]` holds original node i's CURRENT-level node index
    // (a dense supernode index from the prior level). The next level's graph is indexed by those
    // supernodes, so node i's new community = node2supernode[ communities[i] ] — NOT [i], which
    // would read out of range once the graph shrinks and collapse every node to 0.
    const next = new Int32Array(graph.n);
    for (let i = 0; i < graph.n; i++) next[i] = level.node2supernode[communities[i]!]!;
    communities = next;
    if (level.moved) g = level.aggregated;
    else break;
  }
  return relabel(communities);
}

/** One Louvain level: local moving (phase 1) + aggregation (phase 2). */
function oneLevel(graph: LouvainGraph): {
  moved: boolean;
  node2supernode: Int32Array;
  aggregated: LouvainGraph;
} {
  const n = graph.n;
  const node2com = new Int32Array(n);
  for (let i = 0; i < n; i++) node2com[i] = i;

  // Σtot[com] = sum of degrees of nodes currently in com
  const sigmaTot = new Float64Array(n);
  for (let i = 0; i < n; i++) sigmaTot[i] = graph.degrees[i]!;

  let moved = false;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n; i++) {
      const curCom = node2com[i]!;
      const ki = graph.degrees[i]!;
      // Σ weight from i into each neighbouring community
      const comWeights = new Map<number, number>();
      for (const [nb, w] of graph.adj[i]!) {
        const c = node2com[nb]!;
        comWeights.set(c, (comWeights.get(c) ?? 0) + w);
      }
      const kiCur = comWeights.get(curCom) ?? 0; // includes the self-loop weight if any

      // remove i from its current community
      sigmaTot[curCom] = sigmaTot[curCom]! - ki;

      let bestCom = curCom;
      // gain baseline: staying put (gain = ki_in - sigmaTot*ki/m2, evaluated per candidate)
      // bestGain uses the standard ΔQ numerator form (the /m2 scaling is constant per node).
      let bestGain = gainFor(kiCur, sigmaTot[curCom]!, ki, graph.m2);
      const tried = new Set<number>([curCom]);
      // candidates in stable order: sorted community indices for deterministic tie-breaking
      const candidates = [...comWeights.keys()].filter((c) => c !== curCom).sort((a, b) => a - b);
      for (const c of candidates) {
        if (tried.has(c)) continue;
        tried.add(c);
        const kiIn = comWeights.get(c)!;
        const g = gainFor(kiIn, sigmaTot[c]!, ki, graph.m2);
        // tie-break: strictly greater gain, else lower community index keeps it (deterministic)
        if (g > bestGain || (g === bestGain && c < bestCom)) {
          bestGain = g;
          bestCom = c;
        }
      }
      // reinsert i into bestCom
      sigmaTot[bestCom] = sigmaTot[bestCom]! + ki;
      if (bestCom !== curCom) {
        node2com[i] = bestCom;
        moved = true;
        improved = true;
      }
    }
  }

  // phase 2: aggregate supernodes
  const supernodeOf = new Map<number, number>();
  let nextCom = 0;
  for (let i = 0; i < n; i++) {
    const c = node2com[i]!;
    if (!supernodeOf.has(c)) supernodeOf.set(c, nextCom++);
  }
  const node2supernode = new Int32Array(n);
  for (let i = 0; i < n; i++) node2supernode[i] = supernodeOf.get(node2com[i]!)!;

  return { moved, node2supernode, aggregated: aggregate(graph, node2com, supernodeOf, nextCom) };
}

/** ΔQ numerator for moving node with degree ki into a community with Σtot and ki_in shared weight. */
function gainFor(kiIn: number, sigmaTot: number, ki: number, m2: number): number {
  // gain ≈ kiIn - (sigmaTot * ki) / m2   (constant 1/m2 factor omitted for comparison)
  return kiIn - (sigmaTot * ki) / m2;
}

/** Build the aggregated graph: each community becomes one supernode; edges merged (self-loops kept). */
function aggregate(
  graph: LouvainGraph,
  node2com: Int32Array,
  supernodeOf: Map<number, number>,
  superN: number,
): LouvainGraph {
  const adj: Map<number, number>[] = Array.from(
    { length: superN },
    () => new Map<number, number>(),
  );
  for (let i = 0; i < graph.n; i++) {
    const ci = supernodeOf.get(node2com[i]!)!;
    for (const [nb, w] of graph.adj[i]!) {
      const cj = supernodeOf.get(node2com[nb]!)!;
      adj[ci]!.set(cj, (adj[ci]!.get(cj) ?? 0) + w);
    }
  }
  // degrees: cross edge contributes w per endpoint; self-loop (ci==cj stored once) contributes 2w.
  const deg = new Float64Array(superN);
  let m2 = 0;
  for (let i = 0; i < superN; i++) {
    for (const [nb, w] of adj[i]!) deg[i] = deg[i]! + (i === nb ? 2 * w : w);
    m2 += deg[i]!;
  }
  return { n: superN, degrees: deg, adj, m2 };
}

/** Relabel community labels to a dense 0..k-1 range in first-seen order (stable output). */
function relabel(communities: Int32Array): Int32Array {
  const map = new Map<number, number>();
  let next = 0;
  const out = new Int32Array(communities.length);
  for (let i = 0; i < communities.length; i++) {
    const c = communities[i]!;
    let v = map.get(c);
    if (v === undefined) {
      v = next++;
      map.set(c, v);
    }
    out[i] = v;
  }
  return out;
}
