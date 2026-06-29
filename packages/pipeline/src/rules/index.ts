/**
 * M12 rules renderers — mermaid / graph.json / report, consuming the pure decision-table
 * extraction that lives in @knowledge-crib/core (so the MCP verb can depend on extraction without
 * pulling the pipeline). The CLI `crib export` command delegates here via {@link renderExport}.
 */
export type {
  RuleRecord,
  RuleAction,
  RuleCondition,
  DecisionTable,
  ExtractRulesOpts,
} from '@knowledge-crib/core';
export { renderMermaid } from './mermaid.js';
export { exportGraph, renderReport, renderExport, surprisingConnections } from './export.js';
export type { GraphJson, SurprisingConnection } from './export.js';
