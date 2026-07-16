# Large Project Viz Design

## Goal

Make `crib viz` presentable for large projects by replacing the default all-nodes canvas with a readable architecture overview and focused drill-down behavior.

## Problem

For large repos, the current viz renders tens of thousands of nodes and edges at once. The page technically loads, but the visual result is a dense mesh where blocks, labels, and meaningful relationships cannot be seen.

## Approved Direction

Use a combined Architecture Map + Focus Explorer:

- Default large-graph mode shows module/cluster blocks, not every node.
- Blocks are sized by node count and colored by cluster/module color.
- Only high-signal cross-cluster links are shown in overview.
- Clicking a block switches to focused graph mode for that module and its immediate neighbors.
- Search switches to focused graph mode around matching nodes.
- Existing node inspector, blast radius, theme, and filters remain available.

## Scope

The first implementation stays inside the existing static DC runtime page at `packages/ui/web/index.html`. It does not change the soul schema, graph builder, CLI server, or stored `.crib` output.

## User Experience

When the graph has more than roughly 1,800 nodes, `crib viz` opens in Overview mode. The user sees a dashboard-style map of the top modules/clusters with count labels and a small set of cross-module dependencies. The top bar exposes a mode toggle so the user can switch between Overview and Focus.

Clicking a module block selects it, shows its summary in the inspector, and enters Focus mode. Focus mode draws only nodes in that cluster plus directly connected neighbors, keeping the canvas navigable. Search results should also narrow the view rather than leaving the full project graph visible.

## Testing

Add static regression tests against `packages/ui/web/index.html` to ensure:

- Large graph overview state exists.
- Overview model construction exists.
- Overview mode is the default for large graphs.
- The old full-graph-first behavior does not remain the only path.
