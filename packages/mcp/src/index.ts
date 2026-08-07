/**
 * @knowledge-crib/mcp — the product surface: token-bounded, provenance-tagged verbs + one stdio
 * MCP server. Deterministic verbs only; enrichment is opt-in and off the hot path.
 */
export * from './verbs.js';
export * from './token-budget.js';
export {
  rehydrate,
  rehydrateBody,
  DEFAULT_BODY_MAX_CHARS,
  DEFAULT_BODY_MAX_LINES,
  type RehydratedBody,
} from './snippet.js';
export { buildServer, serveStdio } from './server.js';
export { Stats, trackCall, type StatsSnapshot, type VerbStat } from './stats.js';
export { EnrichmentStore, llmProjection, ENRICH_SCOPE_THRESHOLD, qualityOf } from './enrichment.js';
export {
  collectStrings,
  redactSecrets,
  scanSecrets,
  type SecretHit,
  type StringField,
} from './secrets.js';
export type {
  EnrichAccepted,
  EnrichLayer,
  EnrichLayerCounts,
  EnrichNextArgs,
  EnrichNextBatch,
  EnrichOverviewArgs,
  EnrichRejected,
  EnrichSaveArgs,
  EnrichSaveItem,
  EnrichSaveResult,
  EnrichScope,
  EnrichScopeInfo,
  EnrichStatus,
  EnrichStatusArgs,
  EnrichWorkItem,
  LlmAnalysis,
  LlmArtifact,
  LlmEvidence,
  LlmGraphEdge,
  LlmGraphNode,
  LlmRead,
  QualityTier,
} from './enrichment.js';
