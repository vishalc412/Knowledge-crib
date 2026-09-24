(function installKnowledgeCribExplorerProjection(root) {
  const MODEL = root.KCGraphModel;
  const REVERSE = {
    calls: 'called by',
    imports: 'imported by',
    inherits: 'extended by',
    implements: 'implemented by',
    exposes: 'exposed by',
    injects: 'injected by',
    renders: 'rendered by',
    produces: 'produced by',
  };
  const FORWARD = {
    calls: 'calls',
    imports: 'imports',
    inherits: 'inherits from',
    implements: 'implements',
    exposes: 'exposes',
    injects: 'injects',
    renders: 'renders',
    produces: 'produces',
  };
  const DEPENDENCY_RELS = new Set([
    'calls',
    'imports',
    'reads',
    'writes',
    'executes',
    'implements',
    'inherits',
  ]);

  function rankNodes(nodes) {
    return [...nodes].sort(
      (a, b) =>
        (b.importance || 0) - (a.importance || 0) ||
        String(a.qualified || a.label || a.id).localeCompare(
          String(b.qualified || b.label || b.id),
        ) ||
        a.id.localeCompare(b.id),
    );
  }

  function moduleForNode(node, modules) {
    if (!node || !node.file) return null;
    let best = null;
    for (const module of modules || []) {
      const prefix = module.pathPrefix;
      if (
        prefix &&
        (node.file === prefix || node.file.startsWith(`${prefix}/`)) &&
        (!best || prefix.length > best.pathPrefix.length)
      )
        best = module;
    }
    return best || (modules || []).find((module) => module.pathPrefix === '') || null;
  }

  function nodeRow(node, modules, more = {}) {
    const module = moduleForNode(node, modules);
    return {
      id: node.id,
      kind: node.kind,
      label: node.label || node.name || node.id,
      qualified: node.qualified || node.label || node.id,
      path: node.file || '',
      summary: node.summary || '',
      module: module ? module.name || module.label || module.id : '',
      ...more,
    };
  }

  function relationship(from, to, edges, indexes) {
    const labels = new Set();
    for (const index of indexes.incidentByNode[from] || []) {
      const edge = edges[index];
      if (!edge || !MODEL.ARCHITECTURAL_RELS.has(edge.rel)) continue;
      if (edge.src === from && edge.dst === to) labels.add(FORWARD[edge.rel] || edge.rel);
      if (edge.dst === from && edge.src === to) labels.add(REVERSE[edge.rel] || `${edge.rel} by`);
    }
    return [...labels].join(', ');
  }

  function focusRows(options) {
    const { selectedId, indexes, byId, edges, modules, hiddenKinds } = options;
    const depth = Math.max(1, Math.min(4, Number(options.depth) || 1));
    const maxVisited = Math.max(1, Number(options.maxVisited) || 5000);
    const seen = new Set([selectedId]);
    const queue = [{ id: selectedId, hop: 0 }];
    const rows = [];
    let truncated = false;
    for (let head = 0; head < queue.length && !truncated; head++) {
      const current = queue[head];
      if (current.hop >= depth) continue;
      for (const id of indexes.archAdj[current.id] || []) {
        if (!byId[id] || seen.has(id)) continue;
        if (seen.size >= maxVisited) {
          truncated = true;
          break;
        }
        seen.add(id);
        const hop = current.hop + 1;
        queue.push({ id, hop });
        if (!hiddenKinds[byId[id].kind])
          rows.push(
            nodeRow(byId[id], modules, {
              hop,
              relationship: relationship(current.id, id, edges, indexes),
            }),
          );
      }
    }
    rows.sort(
      (a, b) =>
        a.hop - b.hop ||
        (byId[b.id].importance || 0) - (byId[a.id].importance || 0) ||
        a.qualified.localeCompare(b.qualified) ||
        a.id.localeCompare(b.id),
    );
    return { rows, truncated };
  }

  function blastRows(options) {
    const { selectedId, indexes, byId, edges, modules, hiddenKinds } = options;
    const maxVisited = Math.max(1, Number(options.maxVisited) || 5000);
    const seen = new Set([selectedId]);
    const queue = [{ id: selectedId, hop: 0 }];
    const rows = [];
    let truncated = false;
    for (let head = 0; head < queue.length && !truncated; head++) {
      const current = queue[head];
      for (const index of indexes.incidentByNode[current.id] || []) {
        const edge = edges[index];
        if (!edge || edge.dst !== current.id || !DEPENDENCY_RELS.has(edge.rel)) continue;
        const id = edge.src;
        if (!byId[id] || seen.has(id)) continue;
        if (seen.size >= maxVisited) {
          truncated = true;
          break;
        }
        seen.add(id);
        const hop = current.hop + 1;
        queue.push({ id, hop });
        if (!hiddenKinds[byId[id].kind])
          rows.push(
            nodeRow(byId[id], modules, {
              hop,
              relationship: relationship(current.id, id, edges, indexes),
            }),
          );
      }
    }
    rows.sort(
      (a, b) =>
        a.hop - b.hop ||
        a.module.localeCompare(b.module) ||
        (byId[b.id].importance || 0) - (byId[a.id].importance || 0) ||
        a.qualified.localeCompare(b.qualified) ||
        a.id.localeCompare(b.id),
    );
    return { rows, truncated };
  }

  function prepare(options) {
    const nodes = options.nodes || [];
    const edges = options.edges || [];
    const byId = options.byId || {};
    const indexes = options.indexes || MODEL.buildIndexes(nodes, edges);
    const modules = options.modules || [];
    const clusters = options.clusters || [];
    const hiddenKinds = options.hiddenKinds || {};
    const query = String(options.query || '').trim();
    let scope = 'overview';
    let rows = [];
    let truncated = false;
    let graphNote = '';

    if (options.selectedId && byId[options.selectedId]) {
      scope = options.blast ? 'blast' : 'focus';
      const result = (options.blast ? blastRows : focusRows)({
        ...options,
        indexes,
        modules,
        hiddenKinds,
      });
      rows = result.rows;
      truncated = result.truncated;
      if (scope === 'blast') {
        graphNote =
          'The canvas highlights only its focus context; this table lists discovered affected nodes.';
        if (truncated) graphNote += ' Traversal reached its limit; more nodes may be affected.';
      } else {
        const canvasIds = (options.canvasFocus?.rings || []).flat();
        const canvasShown = canvasIds.filter(
          (id) => byId[id] && !hiddenKinds[byId[id].kind],
        ).length;
        if (options.canvasFocus && canvasShown < rows.length) {
          graphNote = `The canvas shows ${canvasShown} of ${rows.length} discovered neighbors; the list pages through them.`;
        }
        if (truncated) graphNote += ' Traversal reached its limit; more neighbors may exist.';
      }
    } else if (query) {
      scope = 'search';
      const search =
        options.searchProjection ||
        MODEL.searchProjection(
          { query, matchCap: 24, contextCap: 48 },
          nodes,
          edges,
          byId,
          indexes,
        );
      rows = (search.allMatchIds || [])
        .map((id) => byId[id])
        .filter((node) => node && !hiddenKinds[node.kind])
        .map((node) => nodeRow(node, modules));
      const canvasShown = search.matchIds.filter(
        (id) => byId[id] && !hiddenKinds[byId[id].kind],
      ).length;
      if (rows.length > canvasShown)
        graphNote = `The canvas shows ${canvasShown} of ${rows.length} ranked matches under current filters; the list pages through every match.`;
    } else if (options.clusterId) {
      scope = 'cluster';
      rows = rankNodes(
        (indexes.membersByCluster[options.clusterId] || [])
          .map((id) => byId[id])
          .filter((node) => node && !hiddenKinds[node.kind]),
      ).map((node) => nodeRow(node, modules));
      if (rows.length > 200)
        graphNote = `The canvas displays at most 200 cluster nodes; the list pages through ${rows.length}.`;
    } else if (options.moduleId) {
      scope = 'module';
      const module = modules.find((item) => item.id === options.moduleId);
      const ids = new Set(module?.clusterIds || []);
      rows = clusters
        .filter((cluster) => ids.has(cluster.id))
        .map((cluster) => ({
          id: cluster.id,
          kind: 'cluster',
          label: cluster.label || cluster.id,
          qualified: cluster.label || cluster.id,
          path: '',
          summary: cluster.blurb || '',
          module: module ? module.name || module.label || module.id : '',
        }));
      if (!rows.length && module) {
        scope = 'module-symbols';
        rows = rankNodes(
          nodes.filter(
            (node) => moduleForNode(node, modules)?.id === module.id && !hiddenKinds[node.kind],
          ),
        ).map((node) => nodeRow(node, modules));
      }
    } else if (modules.length) {
      rows = modules.map((module) => ({
        id: module.id,
        kind: 'module',
        label: module.name || module.label || module.id,
        qualified: module.name || module.label || module.id,
        path: module.pathPrefix || '',
        summary: module.purpose || '',
        module: '',
      }));
    } else {
      // Only clusters with indexed members are results: the viewer's synthetic fallback cluster
      // (which anchors orphan nodes) must not turn an empty index into a phantom result.
      rows = clusters
        .filter((cluster) => (indexes.membersByCluster[cluster.id] || []).length > 0)
        .map((cluster) => ({
          id: cluster.id,
          kind: 'cluster',
          label: cluster.label || cluster.id,
          qualified: cluster.label || cluster.id,
          path: '',
          summary: cluster.blurb || '',
          module: '',
        }));
    }

    if ((scope === 'overview' || scope === 'module') && options.overviewOverflow > 0) {
      graphNote = `The canvas hides ${options.overviewOverflow} cards at this size; the list includes every ${scope === 'module' ? 'cluster' : 'module'}.`;
    }

    return { scope, allRows: rows, total: rows.length, truncated, graphNote };
  }

  function paginate(prepared, requestedPage = 0, pageSize = 50) {
    const { scope, allRows, total, truncated, graphNote } = prepared;
    const size = Math.max(1, Math.min(50, Number(pageSize) || 50));
    const pageCount = Math.max(1, Math.ceil(total / size));
    const page = Math.max(0, Math.min(pageCount - 1, Number(requestedPage) || 0));
    return {
      scope,
      rows: allRows.slice(page * size, (page + 1) * size),
      total,
      page,
      pageCount,
      truncated,
      graphNote,
    };
  }

  function project(options) {
    return paginate(prepare(options), options.page, options.pageSize);
  }

  root.KCExplorerProjection = { prepare, paginate, project, DEPENDENCY_RELS };
})(typeof globalThis !== 'undefined' ? globalThis : window);
