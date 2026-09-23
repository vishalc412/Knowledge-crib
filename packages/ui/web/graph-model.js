(function installKnowledgeCribGraphModel(root) {
  'use strict';

  const ARCHITECTURAL_RELS = new Set([
    'calls',
    'imports',
    'inherits',
    'implements',
    'exposes',
    'injects',
    'renders',
    'produces',
  ]);

  function uniquePush(map, key, value) {
    const list = map[key] || (map[key] = []);
    if (!list.includes(value)) list.push(value);
  }

  function buildIndexes(nodes, edges) {
    const membersByCluster = Object.create(null);
    const incidentByNode = Object.create(null);
    const archAdj = Object.create(null);
    for (const node of nodes) {
      incidentByNode[node.id] = [];
      archAdj[node.id] = [];
      if (node.cluster) uniquePush(membersByCluster, node.cluster, node.id);
    }
    edges.forEach((edge, index) => {
      if (incidentByNode[edge.src]) incidentByNode[edge.src].push(index);
      if (incidentByNode[edge.dst]) incidentByNode[edge.dst].push(index);
      if (ARCHITECTURAL_RELS.has(edge.rel)) {
        if (archAdj[edge.src]) uniquePush(archAdj, edge.src, edge.dst);
        if (archAdj[edge.dst]) uniquePush(archAdj, edge.dst, edge.src);
      }
    });
    return { membersByCluster, incidentByNode, archAdj };
  }

  function rankIds(ids, byId) {
    return [...ids].sort((a, b) => {
      const an = byId[a] || {};
      const bn = byId[b] || {};
      return (
        (bn.importance || 0) - (an.importance || 0) ||
        String(an.qualified || an.label || a).localeCompare(String(bn.qualified || bn.label || b)) ||
        a.localeCompare(b)
      );
    });
  }

  function edgeIndexesForNodeIds(nodeIds, edges, indexes) {
    const edgeIndexes = new Set();
    for (const id of nodeIds) {
      for (const edgeIndex of indexes.incidentByNode[id] || []) edgeIndexes.add(edgeIndex);
    }
    return [...edgeIndexes].filter((index) => {
      const edge = edges[index];
      return edge && nodeIds.has(edge.src) && nodeIds.has(edge.dst);
    });
  }

  /** Discover actual architectural hops, then select a readable connected subset for each ring.
   *  A traversal limit is disclosed, never mistaken for the end of the graph. */
  function focusProjection(rootId, maxDepth, indexes, byId, caps = [60, 120, 80, 60], maxVisited = 5000) {
    const depth = Math.max(1, Math.min(4, maxDepth || 1));
    const rings = Array.from({ length: depth }, () => []);
    const countsByDepth = Array(depth + 1).fill(0);
    const hiddenByDepth = Array(depth + 1).fill(0);
    if (!byId[rootId]) return { rings, countsByDepth, hiddenByDepth, depthMap: new Map(), truncated: false, truncatedAtDepth: null };
    const discovered = new Map([[rootId, 0]]);
    const queue = [rootId];
    let truncated = false;
    let truncatedAtDepth = null;
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head];
      const hop = discovered.get(id);
      if (hop >= depth) continue;
      for (const neighbor of indexes.archAdj[id] || []) {
        if (!byId[neighbor] || discovered.has(neighbor)) continue;
        if (discovered.size >= maxVisited) { truncated = true; truncatedAtDepth = hop + 1; break; }
        discovered.set(neighbor, hop + 1);
        queue.push(neighbor);
      }
      if (truncated) break;
    }
    const byDepth = Array.from({ length: depth + 1 }, () => []);
    for (const [id, hop] of discovered) byDepth[hop].push(id);
    countsByDepth[0] = 1;
    let visiblePrevious = new Set([rootId]);
    for (let hop = 1; hop <= depth; hop++) {
      const connected = byDepth[hop].filter((id) =>
        (indexes.archAdj[id] || []).some((parent) => visiblePrevious.has(parent)));
      rings[hop - 1] = rankIds(connected, byId).slice(0, caps[hop - 1] || 60);
      visiblePrevious = new Set(rings[hop - 1]);
      countsByDepth[hop] = byDepth[hop].length;
      hiddenByDepth[hop] = Math.max(0, countsByDepth[hop] - rings[hop - 1].length);
    }
    return { rings, countsByDepth, hiddenByDepth, depthMap: discovered, truncated, truncatedAtDepth };
  }

  /** The spanning backbone positions nodes; every real architectural edge among those visible
   *  nodes remains in edgeIndexes, including sibling/cross-ring links. */
  function focusLayout(rootId, ring1Ids, ring2Ids, edges, indexes, extraRings = []) {
    const positions = Object.create(null);
    const parentById = Object.create(null);
    const backboneEdgeIndexes = [];
    const ring1 = [];
    const childrenByParent = Object.create(null);
    positions[rootId] = { x: 0, y: 0 };

    const connectingEdge = (a, b) => (indexes.incidentByNode[a] || []).find((index) => {
      const edge = edges[index];
      return edge && ARCHITECTURAL_RELS.has(edge.rel) &&
        ((edge.src === a && edge.dst === b) || (edge.src === b && edge.dst === a));
    });
    for (const id of ring1Ids) {
      const index = connectingEdge(rootId, id);
      if (index === undefined) continue;
      ring1.push(id);
      parentById[id] = rootId;
      childrenByParent[id] = [];
      backboneEdgeIndexes.push(index);
    }

    const innerX = Math.max(220, ring1.length * 14);
    const innerY = Math.max(260, ring1.length * 17);
    const outerX = innerX + 155;
    const outerY = innerY + 185;
    const angles = Object.create(null);
    ring1.forEach((id, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / ring1.length;
      angles[id] = angle;
      positions[id] = { x: Math.cos(angle) * innerX, y: Math.sin(angle) * innerY };
    });

    for (const id of ring2Ids) {
      for (const parent of ring1) {
        const index = connectingEdge(parent, id);
        if (index === undefined) continue;
        parentById[id] = parent;
        childrenByParent[parent].push(id);
        backboneEdgeIndexes.push(index);
        break;
      }
    }
    for (const parent of ring1) {
      const children = childrenByParent[parent];
      const wedge = Math.PI * 2 / Math.max(1, ring1.length);
      children.forEach((id, index) => {
        const angle = angles[parent] + ((index + 1) / (children.length + 1) - 0.5) * wedge * 0.88;
        positions[id] = { x: Math.cos(angle) * outerX, y: Math.sin(angle) * outerY };
      });
    }
    let previousRing = ring2Ids.filter((id) => positions[id]);
    for (let ringIndex = 0; ringIndex < extraRings.length; ringIndex++) {
      const nextRing = [];
      const descendants = Object.create(null);
      for (const id of extraRings[ringIndex]) {
        for (const parent of previousRing) {
          const index = connectingEdge(parent, id);
          if (index === undefined) continue;
          parentById[id] = parent;
          (descendants[parent] || (descendants[parent] = [])).push(id);
          backboneEdgeIndexes.push(index);
          nextRing.push(id);
          break;
        }
      }
      const radiusX = outerX + (ringIndex + 1) * 175;
      const radiusY = outerY + (ringIndex + 1) * 195;
      for (const parent of previousRing) {
        const siblings = descendants[parent] || [];
        const parentPoint = positions[parent];
        const parentAngle = Math.atan2(parentPoint.y / (outerY + ringIndex * 195),
          parentPoint.x / (outerX + ringIndex * 175));
        const wedge = Math.PI * 2 / Math.max(1, previousRing.length);
        siblings.forEach((id, index) => {
          const angle = parentAngle + ((index + 1) / (siblings.length + 1) - 0.5) * wedge * 0.8;
          positions[id] = { x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY };
        });
      }
      previousRing = nextRing;
    }
    const visibleIds = new Set(Object.keys(positions));
    const edgeIndexes = edgeIndexesForNodeIds(visibleIds, edges, indexes)
      .filter((index) => ARCHITECTURAL_RELS.has(edges[index].rel)).sort((a, b) => a - b);
    const backboneSet = new Set(backboneEdgeIndexes);
    const crossEdgeIndexes = edgeIndexes.filter((index) => !backboneSet.has(index));
    return { positions, parentById, edgeIndexes, backboneEdgeIndexes, crossEdgeIndexes };
  }

  function searchText(node) {
    return [
      node.label,
      node.name,
      node.qualified,
      node.file,
      node.signature,
      node.summary,
      node.kind,
      node.id,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
  }

  function searchRank(node, query) {
    const primary = [node.label, node.name, node.qualified]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    if (primary.some((value) => value === query)) return 0;
    if (primary.some((value) => value.startsWith(query))) return 1;
    if (primary.some((value) => value.includes(query))) return 2;
    return 3;
  }

  /**
   * Deterministic search projection shared by every graph size and UI state. Matches rank before
   * their architectural one-hop context, so search never inherits stale full-graph coordinates or
   * gets masked by a previously selected cluster.
   */
  function searchProjection(options, nodes, edges, byId, indexes) {
    const query = String(options.query || '').trim().toLowerCase();
    if (!query) {
      return {
        query,
        matchIds: [],
        allMatchIds: [],
        contextIds: [],
        nodeIds: new Set(),
        edgeIndexes: [],
        totalMatches: 0,
      };
    }

    const allMatches = nodes
      .filter((node) => searchText(node).some((value) => value.includes(query)))
      .sort((a, b) => {
        return (
          searchRank(a, query) - searchRank(b, query) ||
          (b.importance || 0) - (a.importance || 0) ||
          String(a.qualified || a.label || a.id).localeCompare(
            String(b.qualified || b.label || b.id),
          ) ||
          a.id.localeCompare(b.id)
        );
      });
    const matchIds = allMatches.slice(0, options.matchCap || 80).map((node) => node.id);
    const matchSet = new Set(matchIds);
    const contextCandidates = new Set();
    for (const id of matchIds) {
      for (const neighbor of indexes.archAdj[id] || []) {
        if (!matchSet.has(neighbor)) contextCandidates.add(neighbor);
      }
    }
    const contextIds = rankIds(contextCandidates, byId).slice(0, options.contextCap || 160);
    const nodeIds = new Set([...matchIds, ...contextIds]);
    return {
      query,
      matchIds,
      allMatchIds: allMatches.map((node) => node.id),
      contextIds,
      nodeIds,
      edgeIndexes: edgeIndexesForNodeIds(nodeIds, edges, indexes),
      totalMatches: allMatches.length,
    };
  }

  function clusterProjection(options, nodes, edges, byId, indexes) {
    const allMemberIds = [...(indexes.membersByCluster[options.clusterId] || [])];
    const filteredMemberIds = allMemberIds.filter(
      (id) => !options.kind || (byId[id] && byId[id].kind === options.kind),
    );
    const rankedCore = rankIds(filteredMemberIds, byId);
    const cap = options.coreCap || 200;
    let coreIds = rankedCore.slice(0, cap);
    if (
      options.promotedId &&
      filteredMemberIds.includes(options.promotedId) &&
      !coreIds.includes(options.promotedId)
    ) {
      coreIds = [...coreIds.slice(0, Math.max(0, cap - 1)), options.promotedId];
    }
    const coreSet = new Set(coreIds);
    let contextIds = [];
    if (options.showContext) {
      const candidates = new Set();
      for (const id of coreIds) {
        for (const neighbor of indexes.archAdj[id] || []) {
          if (!coreSet.has(neighbor)) candidates.add(neighbor);
        }
      }
      contextIds = rankIds(candidates, byId).slice(0, options.contextCap || 60);
    }
    const nodeIds = new Set([...coreIds, ...contextIds]);
    return {
      allMemberIds,
      filteredMemberIds,
      coreIds,
      contextIds,
      nodeIds,
      edgeIndexes: edgeIndexesForNodeIds(nodeIds, edges, indexes),
      totalCore: filteredMemberIds.length,
      hiddenCore: Math.max(0, filteredMemberIds.length - coreIds.length),
    };
  }

  root.KCGraphModel = {
    ARCHITECTURAL_RELS,
    buildIndexes,
    clusterProjection,
    edgeIndexesForNodeIds,
    focusLayout,
    focusProjection,
    searchProjection,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
