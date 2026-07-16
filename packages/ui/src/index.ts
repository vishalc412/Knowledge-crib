/**
 * @knowledge-crib/ui — the M7 web graph viz. `buildVizGraph` produces a client-side snapshot
 * for the Claude Design DC runtime; `buildVizOverview` produces the module-segmented overview
 * snapshot served at `/overview.json`; `vizAssetsDir` locates the static browser assets served by
 * `crib viz`.
 */
export { buildVizGraph, buildVizOverview, vizAssetsDir } from './viz.js';
export type {
  VizGraph,
  VizNodeData,
  VizEdgeData,
  VizCluster,
  VizOverview,
  VizModule,
} from './viz.js';
