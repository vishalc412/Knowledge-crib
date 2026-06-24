/**
 * @knowledge-crib/parsers — extractor plugins + registry. TypeScript ships first; tree-sitter/ANTLR
 * languages (M8) and the Markdown format extractor (M4) register through the same contract.
 */
export * from './types.js';
export * from './registry.js';
export { TypeScriptExtractor } from './ts/TypeScriptExtractor.js';
