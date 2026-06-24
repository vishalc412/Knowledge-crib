/**
 * @knowledge-crib/parsers — extractor plugins + registry. TypeScript ships first; tree-sitter/ANTLR
 * languages (M8) and the Markdown format extractor (M4) register through the same contract.
 * PL/SQL (M10, migration track) ships hand-rolled — no tree-sitter needed.
 */
export * from './types.js';
export * from './registry.js';
export { TypeScriptExtractor } from './ts/TypeScriptExtractor.js';
export { MarkdownExtractor } from './md/MarkdownExtractor.js';
export { parseMarkdownSections } from './md/markdown.js';
export type { MdSection } from './md/markdown.js';
export { PlSqlExtractor } from './plsql/PlSqlExtractor.js';
export { parsePlSql, sqlRoles } from './plsql/parser.js';
export type {
  TopLevel,
  Unit,
  TableDef,
  ColumnDef,
  Block,
  Stmt,
  SqlStmt,
  IfStmt,
  LoopStmt,
  CallSite,
} from './plsql/ast.js';
