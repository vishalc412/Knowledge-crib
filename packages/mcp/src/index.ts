/**
 * @knowledge-crib/mcp — the product surface: token-bounded, provenance-tagged verbs + one stdio
 * MCP server. Deterministic verbs only; enrichment is opt-in and off the hot path.
 */
export * from './verbs.js';
export * from './token-budget.js';
export { rehydrate } from './snippet.js';
export { buildServer, serveStdio } from './server.js';
export { Enricher, enricherFromEnv } from './enrichment.js';
export type { EnrichOp, EnricherConfig } from './enrichment.js';
