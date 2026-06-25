/**
 * @knowledge-crib/ui — the M7 web graph viz. `buildVizGraph` produces a Cytoscape.js snapshot
 * server-side; `vizAssetsDir` locates the static browser assets served by `crib viz`.
 */
export { buildVizGraph, vizAssetsDir } from './viz.js';
export type { VizGraph, VizNodeData, VizEdgeData } from './viz.js';
