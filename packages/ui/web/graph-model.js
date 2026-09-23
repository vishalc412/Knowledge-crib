(function installKnowledgeCribGraphModel(root) {
  // A browser CLASSIC script (`<script src="./graph-model.js">`, no type="module"), so the file is
  // NOT a module and the whole-file strictness the linter assumes does not apply to it: this
  // directive is what makes the IIFE body strict in the page. Keep it.
  // biome-ignore lint/suspicious/noRedundantUseStrict: browser classic script, not a module — see above
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
    let list = map[key];
    if (!list) {
      list = [];
      map[key] = list;
    }
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
        String(an.qualified || an.label || a).localeCompare(
          String(bn.qualified || bn.label || b),
        ) ||
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
    const query = String(options.query || '')
      .trim()
      .toLowerCase();
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

  // --- Pure rendering helpers, extracted from the x-dc component (WP3-H4) ---------------------
  // These four were methods on the component class inside `index.html` even though not one of them
  // reads component state or the DOM: each is a function of its arguments alone. Sitting in the
  // asset made them unreachable by any test — the served asset is asserted by string match, so a
  // change to the ellipsize search or the channel extraction below could only be caught by eye.
  // Moved here they are ordinary behaviour, covered by graph-model.test.ts.

  /** `#rrggbb` plus an alpha -> `rgba(...)`. Anything that is not a `#` colour passes through. */
  function hex(c, a) {
    if (c[0] !== '#') return c;
    const n = Number.parseInt(c.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }

  /**
   * Escape dynamic node text before splicing it into the tooltip's innerHTML. `qualified` / `label` /
   * `summary` flow from extracted source text — signatures carry `<T>` generics and docstrings carry
   * HTML characters, so unescaped they corrupt the tooltip DOM or inject markup. `null` renders as
   * the empty string rather than the text "null".
   */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Truncate `text` to `maxWidth` as measured by `ctx`, appending an ellipsis. Binary search over
   * the prefix length rather than a linear scan: this runs once per drawn label per frame and labels
   * can be hundreds of characters. `ctx` is any object exposing `measureText` — the canvas 2D
   * context in the browser, a stub in the tests. The result may still exceed `maxWidth` when one
   * character plus the ellipsis already does; callers assume labels are not narrower than that.
   */
  function ellipsize(ctx, text, maxWidth) {
    const s = String(text || '');
    if (ctx.measureText(s).width <= maxWidth) return s;
    const ell = '…';
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(s.slice(0, mid) + ell).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return s.slice(0, Math.max(0, lo)) + ell;
  }

  /** Rounded-rect subpath on `ctx`. Emits path commands only; the caller chooses fill or stroke. */
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  root.KCGraphModel = {
    ARCHITECTURAL_RELS,
    buildIndexes,
    clusterProjection,
    edgeIndexesForNodeIds,
    ellipsize,
    esc,
    hex,
    rr,
    searchProjection,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
