/**
 * M7 clustering — pure-JS Louvain over structural symbol adjacency → cluster nodes + member-of
 * edges. {@link runCluster} is wired into the pipeline after Phase 4 (link) and before commit.
 */
export { runCluster } from './cluster.js';
export type { ClusterStats } from './cluster.js';
export { louvain, buildGraph } from './louvain.js';
export type { LouvainGraph } from './louvain.js';
