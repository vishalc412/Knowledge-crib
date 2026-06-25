/**
 * M12 rules extraction — pure-over-soul decision-table materialization (see {@link './extract.js'}).
 * The renderers (mermaid / graph.json / report) live in @knowledge-crib/pipeline.
 */
export {
  CALLABLE_SYMBOL_TYPES,
  extractRules,
  decisionTable,
  findProcedure,
} from './extract.js';
export type {
  RuleRecord,
  RuleAction,
  RuleCondition,
  DecisionTable,
  ExtractRulesOpts,
} from './extract.js';
