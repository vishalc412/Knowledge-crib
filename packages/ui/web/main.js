// M7 web-viz renderer — vanilla JS, no build step. Loads the /graph.json snapshot produced
// server-side by buildVizGraph and renders it with Cytoscape.js. Clusters are compound parent
// nodes (data.parent) → Cytoscape nests the member symbols inside them.
/* global cytoscape */
(function () {
  'use strict';

  var KIND_COLOR = {
    symbol: '#4a78d6',
    file: '#6b7280',
    'doc-section': '#0f9d58',
    cluster: '#f59e0b',
    table: '#8b5cf6',
    column: '#a78bfa',
    statement: '#14b8a6',
    condition: '#ef4444',
    'media-seg': '#ec4899',
    explanation: '#64748b',
  };
  var REL_COLOR = {
    calls: '#4a78d6',
    imports: '#6b7280',
    describes: '#0f9d58',
    references: '#34d399',
    'member-of': '#f59e0b',
    inherits: '#8b5cf6',
    implements: '#a78bfa',
    executes: '#14b8a6',
    reads: '#0ea5e9',
    writes: '#0284c7',
    'guarded-by': '#ef4444',
    'derived-from': '#94a3b8',
  };

  fetch('graph.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (g) {
      document.getElementById('stats').textContent =
        g.stats.nodes + ' nodes · ' + g.stats.edges + ' edges · ' + g.stats.clusters + ' clusters';

      var cy = cytoscape({
        container: document.getElementById('cy'),
        elements: [].concat(g.nodes, g.edges),
        style: [
          {
            selector: 'node',
            style: {
              'background-color': function (n) {
                return KIND_COLOR[n.data('kind')] || '#888';
              },
              label: 'data(label)',
              'text-valign': 'center',
              'text-halign': 'center',
              'text-wrap': 'ellipsis',
              'text-max-width': '90px',
              'font-size': '9px',
              color: '#fff',
              width: 28,
              height: 28,
              'text-outline-color': '#000',
              'text-outline-width': 1.5,
            },
          },
          {
            selector: 'node[kind = "cluster"]',
            style: {
              'background-color': '#f59e0b22',
              'border-color': '#f59e0b',
              'border-width': 2,
              'border-style': 'dashed',
              color: '#f59e0b',
              'font-size': '11px',
              'text-valign': 'top',
              'text-halign': 'center',
              'text-outline-width': 0,
              padding: 24,
            },
          },
          {
            selector: 'node[kind = "file"]',
            style: { 'background-color': '#6b728055', 'border-width': 1, 'border-color': '#6b7280' },
          },
          {
            selector: 'edge',
            style: {
              width: 1,
              'line-color': function (e) {
                return REL_COLOR[e.data('rel')] || '#aaa';
              },
              'target-arrow-color': function (e) {
                return REL_COLOR[e.data('rel')] || '#aaa';
              },
              'target-arrow-shape': 'triangle',
              'arrow-scale': 0.7,
              'curve-style': 'bezier',
              opacity: 0.6,
              label: 'data(label)',
              'font-size': '7px',
              'text-rotation': 'autorotate',
              color: '#888',
            },
          },
          {
            selector: 'edge[rel = "member-of"]',
            style: { 'line-style': 'dashed', 'target-arrow-shape': 'none', opacity: 0.35 },
          },
          {
            selector: 'edge[method = "semantic"]',
            style: { 'line-style': 'dotted', opacity: 0.4 },
          },
        ],
        layout: {
          name: 'cose',
          animate: false,
          nodeRepulsion: function () {
            return 8000;
          },
          idealEdgeLength: 60,
          nodeOverlap: 12,
          padding: 30,
        },
      });

      // expose for debugging / future panel
      window.cribCy = cy;
    })
    .catch(function (err) {
      document.getElementById('stats').textContent = 'error: ' + err.message;
      console.error(err);
    });
})();