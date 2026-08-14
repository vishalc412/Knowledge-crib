/**
 * @knowledge-crib/parsers — extractor plugins + registry. Extractors are deterministic and never
 * call an LLM. Most are pure-JS, offline, hand-rolled parsers: TypeScript (compiler API); PL/SQL,
 * Python, Java, C#, Go, Rust (M8/M14); and the Markdown format extractor (M4). PHP is the first
 * tree-sitter-backed extractor (vendored `grammars/tree-sitter-php.wasm` via `web-tree-sitter`),
 * proving the pattern the other extractors could migrate to over time.
 */
export * from './types.js';
export * from './registry.js';
export { PhpExtractor } from './php/PhpExtractor.js';
export { grammarsNeededFor, preloadGrammars, createParserHandle } from './tree-sitter-pool.js';
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
export { parseMarkdownSections, extractCodeRefs, extractLinks } from './md/markdown.js';
export type { MdSection } from './md/markdown.js';
// W1 — bounded frontmatter parser + per-file AI-artifact extraction (skill/agent/command/rule/
// instruction → one `agent-artifact` node + governs/requires/invokes refs). Pure + deterministic.
export { parseFrontmatter } from './agent/frontmatter.js';
export type { ParsedFrontmatter } from './agent/frontmatter.js';
export {
  classifyArtifact,
  artifactName,
  extractArtifact,
} from './agent/agent-graph.js';
export type { ArtifactRel, ArtifactRef, ArtifactExtract } from './agent/agent-graph.js';
export { JavaExtractor } from './java/JavaExtractor.js';
export { tokenize as tokenizeJava } from './java/lexer.js';
export type { Token as JavaToken } from './java/lexer.js';
export {
  parseJava,
  collectCallSites as collectJavaCalls,
  collectImports as collectJavaImports,
} from './java/parser.js';
export type {
  JavaDef,
  JavaCallSite,
  JavaImport,
  JavaModule,
  JavaKind,
} from './java/parser.js';
export { CsharpExtractor } from './csharp/CsharpExtractor.js';
export { tokenize as tokenizeCsharp } from './csharp/lexer.js';
export type { Token as CsharpToken } from './csharp/lexer.js';
export {
  parseCsharp,
  collectCallSites as collectCsharpCalls,
  collectImports as collectCsharpImports,
} from './csharp/parser.js';
export type {
  CsharpDef,
  CsharpCallSite,
  CsharpImport,
  CsharpModule,
  CsharpKind,
} from './csharp/parser.js';
export { GoExtractor } from './go/GoExtractor.js';
export { tokenize as tokenizeGo } from './go/lexer.js';
export type { Token as GoToken } from './go/lexer.js';
export {
  parseGo,
  collectCallSites as collectGoCalls,
  collectImports as collectGoImports,
} from './go/parser.js';
export type {
  GoDef,
  GoCallSite,
  GoImport,
  GoModule,
  GoKind,
} from './go/parser.js';
export { RustExtractor } from './rust/RustExtractor.js';
export { tokenize as tokenizeRust } from './rust/lexer.js';
export type { Token as RustToken } from './rust/lexer.js';
export {
  parseRust,
  collectCallSites as collectRustCalls,
  collectImports as collectRustImports,
} from './rust/parser.js';
export type {
  RustDef,
  RustCallSite,
  RustImport,
  RustModule,
  RustKind,
  RustImplInfo,
} from './rust/parser.js';
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
  CaseStmt,
  CaseBranch,
  ExceptionBlock,
  ExceptionHandler,
  RaiseStmt,
  Decl,
  AstSpan,
  CallSite,
} from './plsql/ast.js';

// MuleSoft — the first non-source-language extractor: it ingests a classified Mule 3/4 project
// file (config XML, DataWeave, RAML, descriptors, properties) and emits the same graph vocabulary
// the language extractors emit. Cross-file resolution is the resolver's job; this layer is
// intra-file facts only. Property VALUES are never stored (keys + references only).
export { MuleExtractor } from './mule/MuleExtractor.js';
export type { MuleReference } from './mule/MuleExtractor.js';
export { parseMule4 } from './mule/mule4.js';
export type { Mule4Document } from './mule/mule4.js';
export { parseDataWeave } from './mule/dataweave.js';
export { parseRaml } from './mule/raml.js';
export type { RamlResult, RamlResource, RamlReference } from './mule/raml.js';
export { parsePom, parseProperties, parseMuleArtifact } from './mule/descriptors.js';
export type {
  PomDependency,
  PomResult,
  MulePropertyResult,
  MuleArtifactResult,
} from './mule/descriptors.js';
export { parseMuleXml } from './mule/xml.js';
export { MuleXmlError } from './mule/xml.js';
export type { MuleXmlDocument, MuleXmlElement } from './mule/ast.js';

// M3.5 parser fuzzing — deterministic, seeded fast-check inputs over the extractor fleet, run in a
// worker pool with a per-call budget so a sync parse hang (the PL/SQL recover() class) is caught by
// worker termination. Exported so the `fuzz:check` / `fuzz:nightly` gates (scripts/fuzz-check.mjs)
// can drive the harness from the built dist. Not part of the MCP surface.
export { runFuzz, runFakeselfTest } from './fuzz/extractor-fuzz.js';
export type { FuzzOutcome, FuzzReproducer, RunFuzzOpts } from './fuzz/extractor-fuzz.js';
export { FUZZ_EXTRACTORS } from './fuzz/fuzz-extractors.js';
export type { FuzzExtractorSpec } from './fuzz/fuzz-extractors.js';
export { validateFuzzResult, nodeIsValid, edgeIsValid } from './fuzz/fuzz-validate.js';
export type { FuzzOutcomeKind } from './fuzz/fuzz-validate.js';
