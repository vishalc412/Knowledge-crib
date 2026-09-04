/**
 * PDG layer (Gate 5.2) — public surface.
 *
 * Pipeline-side orchestration: reconstruct the CFG for one function-like body, add control
 * dependence (Ferrante-Ottenstein-Warren on post-dominators), add data dependence from reaching
 * definitions, then run the taint rule table over the union. Nothing here is invoked at index
 * time — the CLI and MCP surfaces call `pipelinePdg.explain` on demand and only for
 * TypeScript/JavaScript files, which is why the capability flag exists (see docs/pdg-taint.md).
 */
import ts from 'typescript';
import { type ControlPdg, type Pdg, type Reaching, buildControlPdg } from './cfg.js';
import { withDataDependence } from './defuse.js';
import { DEFAULT_TAINT_RULES, type TaintFlow, type TaintRule, analyzeTaint } from './taint.js';

export {
  buildControlPdg,
  collectBindingNames,
  collectDefs,
  collectUses,
  type ControlPdg,
  type Pdg,
  type PdgEdge,
  type PdgNode,
  type Reaching,
} from './cfg.js';
export { withDataDependence } from './defuse.js';
export {
  ALL_CONTEXTS,
  analyzeTaint,
  DEFAULT_TAINT_RULES,
  dependenceEdges,
  type TaintContext,
  type TaintFlow,
  type TaintPathStep,
  type TaintResult,
  type TaintRule,
} from './taint.js';

/** Input to the explain port: the file content (read on demand, never at index time), the symbol
 *  to analyze and — when known — the 1-based line of its declaration. */
export interface PdgExplainRequest {
  source: string;
  fileName: string;
  symbol: string;
  line?: number;
  /** extra user rules appended to {@link DEFAULT_TAINT_RULES} */
  extraRules?: readonly TaintRule[];
}

/** Everything the query surface reports about one symbol's PDG. */
export interface PdgExplainResult {
  symbol: string;
  fileName: string;
  nodes: number;
  controlEdges: number;
  dataEdges: number;
  flows: readonly TaintFlow[];
  /** how many sink occurrences the rule table checked in this body */
  sinksChecked: number;
  /** the complete graph, for advanced callers (UI rendering, tests) */
  pdg: Pdg;
}

/** Build the complete PDG (control + data dependence) for one function-like body. */
export function buildPdg(fn: ts.FunctionLikeDeclaration): Pdg {
  const cfg: ControlPdg = buildControlPdg(fn);
  const pdg: Pdg = { ...cfg, data: [], reaching: new Map() as Reaching };
  return withDataDependence(cfg, pdg);
}

/**
 * The on-demand analysis entry point the CLI and MCP surfaces share. Returns null when no
 * function-like body matching the symbol can be located — the caller decides how to phrase that
 * (unsupported language, declaration-only symbol, etc.).
 */
export function explainSymbol(req: PdgExplainRequest): PdgExplainResult | null {
  const sf = ts.createSourceFile(
    req.fileName,
    req.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(req.fileName),
  );
  const fn = findEnclosingFunction(sf, req.symbol, req.line);
  if (!fn) return null;
  const pdg = buildPdg(fn);
  const taint = analyzeTaint(pdg, [...DEFAULT_TAINT_RULES, ...(req.extraRules ?? [])]);
  return {
    symbol: req.symbol,
    fileName: req.fileName,
    nodes: pdg.nodes.length,
    controlEdges: pdg.control.length,
    dataEdges: pdg.data.length,
    flows: taint.flows,
    sinksChecked: taint.sinksChecked,
    pdg,
  };
}

/** The injected port the MCP layer consumes (the CLI supplies this object; tests supply stubs). */
export const pipelinePdg = {
  explain: (req: PdgExplainRequest): PdgExplainResult | null => explainSymbol(req),
};

function scriptKindOf(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Locate the function-like to analyze: prefer a body that CONTAINS the given line (the graph
 * node's line); otherwise the first one whose declared name matches the symbol's leaf name.
 * Nested arrows match before their enclosing function when they contain the line — the tightest
 * scope is the one whose def-use the caller is asking about.
 */
export function findEnclosingFunction(
  sf: ts.SourceFile,
  symbol: string,
  line?: number,
): ts.FunctionLikeDeclaration | null {
  let byLine: ts.FunctionLikeDeclaration | null = null;
  let byName: ts.FunctionLikeDeclaration | null = null;
  const visit = (n: ts.Node): void => {
    if (isFunctionLikeBody(n)) {
      const start = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
      if (line !== undefined && line >= start && line <= end && byLine === null) byLine = n;
      const name = declaredNameOf(n);
      if (name !== null && name === leafName(symbol) && byName === null) byName = n;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return byLine ?? byName;
}

/** ts.isFunctionLike also matches signatures (call signatures have no body); we need bodies. */
function isFunctionLikeBody(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

function leafName(symbol: string): string {
  const parts = symbol.split('.');
  return parts[parts.length - 1] ?? symbol;
}

/** The declared name of a function-like, if any (declaration, method, property, bound variable). */
function declaredNameOf(fn: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) {
    return fn.name && ts.isIdentifier(fn.name) ? fn.name.text : null;
  }
  const p = fn.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}
