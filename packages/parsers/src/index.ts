/**
 * @knowledge-crib/parsers — extractor plugins + registry. All extractors are pure-JS, offline, and
 * deterministic: TypeScript (compiler API), PL/SQL (hand-rolled), Python (hand-rolled, M8), and the
 * Markdown format extractor (M4) register through the same contract. No tree-sitter / ANTLR runtime.
 */
export * from './types.js';
export * from './registry.js';
export { TypeScriptExtractor } from './ts/TypeScriptExtractor.js';
export { PythonExtractor } from './python/PythonExtractor.js';
export { tokenize as tokenizePython } from './python/lexer.js';
export type { Token as PythonToken } from './python/lexer.js';
export { parsePython, collectCallSites, collectImports } from './python/parser.js';
export type {
  PyDef,
  PyCallSite,
  PyModule,
  PyImport,
  PyImportName,
  DefKind as PyDefKind,
} from './python/parser.js';
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
  IfBranch,
  LoopStmt,
  CallStmt,
  AssignStmt,
  PlainStmt,
  AstSpan,
  CallSite,
} from './plsql/ast.js';
