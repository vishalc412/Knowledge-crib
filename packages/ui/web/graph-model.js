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
    searchProjection,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
