/**
 * TypeScriptExtractor — emits `symbol` nodes (class/interface/enum/function/method/property) with
 * qualifiedName/span/signature, `member-of` edges (symbol → enclosing symbol or file), and
 * INTRA-FILE `calls` edges (a call whose callee resolves to a symbol declared in the same file).
 *
 * Engine: the TypeScript compiler API (syntactic `createSourceFile`, no type-checker, no network) —
 * pure-JS and deterministic, so cold install is offline. Cross-file resolution is the resolver's
 * job (Phase 3); this extractor never guesses across files.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import ts from 'typescript';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';

interface LocalSymbol {
  node: Node;
  /** lookup keys this symbol answers to for intra-file call resolution. */
  keys: string[];
}

export class TypeScriptExtractor implements Extractor {
  name = 'lang:typescript';
  capabilities: Capabilities = { imports: true, calls: true, inheritance: true, types: 'partial' };

  private static readonly EXTS = ['.ts', '.tsx', '.mts', '.cts'];

  supports(file: FileMeta): boolean {
    return TypeScriptExtractor.EXTS.some((e) => file.path.endsWith(e));
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    const text = await ctx.readText();
    const fileId = ctx.idFor('file', { path: file.path });
    try {
      return this.parse(file.path, fileId, text, ctx);
    } catch {
      // Degrade: a parse failure yields no symbols, never throws the pipeline.
      return { nodes: [], edges: [] };
    }
  }

  private parse(path: string, fileId: string, text: string, ctx: ExtractCtx): ExtractResult {
    const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      scriptKind,
    );

    const symbols: LocalSymbol[] = [];
    const byKey = new Map<string, string>(); // lookup key → symbol id

    const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

    // --- pass 1: declarations + member-of ---
    const visit = (node: ts.Node, qualifier: string[], parentId: string): void => {
      const decl = this.declarationOf(node, qualifier, path, fileId, lineOf, ctx);
      if (decl) {
        symbols.push(decl.local);
        for (const k of decl.local.keys) if (!byKey.has(k)) byKey.set(k, decl.local.node.id);
        ts.forEachChild(node, (c) => visit(c, decl.childQualifier, decl.local.node.id));
      } else {
        ts.forEachChild(node, (c) => visit(c, qualifier, parentId));
      }
    };
    ts.forEachChild(sf, (c) => visit(c, [], fileId));

    const nodes = symbols.map((s) => s.node);
    const edges: Edge[] = symbols.map((s) =>
      this.memberOf(s.node, this.parentIdFor(s, symbols, fileId)),
    );

    // --- pass 2: intra-file calls ---
    this.collectCalls(sf, symbols, byKey, lineOf, edges);

    return { nodes, edges };
  }

  /** Build a symbol node for a declaration node, or null if `node` isn't a declaration we capture. */
  private declarationOf(
    node: ts.Node,
    qualifier: string[],
    path: string,
    _fileId: string,
    lineOf: (pos: number) => number,
    ctx: ExtractCtx,
  ): { local: LocalSymbol; childQualifier: string[] } | null {
    const info = symbolInfo(node);
    if (!info) return null;
    const startLine = lineOf(node.getStart());
    const endLine = lineOf(node.getEnd());
    const qualifiedName = [...qualifier, info.name].join('.');
    const id = ctx.idFor('symbol', { path, qualifiedName, startLine });
    const snnode: Node = {
      id,
      kind: 'symbol',
      type: info.type,
      name: info.name,
      qualifiedName,
      file: path,
      span: { start: startLine, end: endLine },
      lang: 'typescript',
      hash: ctx.hash(node.getText()),
      ...(info.signature ? { signature: info.signature } : {}),
      meta: { parentQualifier: qualifier.join('.') },
    };
    const keys = [qualifiedName, info.name];
    return { local: { node: snnode, keys }, childQualifier: [...qualifier, info.name] };
  }

  /** Resolve a symbol's `member-of` parent id: the nearest enclosing symbol, else the file. */
  private parentIdFor(sym: LocalSymbol, all: LocalSymbol[], fileId: string): string {
    const parentQualifier = (sym.node.meta?.parentQualifier as string) ?? '';
    if (parentQualifier === '') return fileId;
    const parent = all.find((s) => s.node.qualifiedName === parentQualifier);
    return parent?.node.id ?? fileId;
  }

  private memberOf(child: Node, parentId: string): Edge {
    return {
      id: edgeId(child.id, parentId, 'member-of'),
      src: child.id,
      dst: parentId,
      rel: 'member-of',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name },
    };
  }

  /** Emit `calls` edges for call expressions whose callee resolves to a same-file symbol. */
  private collectCalls(
    sf: ts.SourceFile,
    symbols: LocalSymbol[],
    byKey: Map<string, string>,
    lineOf: (pos: number) => number,
    edges: Edge[],
  ): void {
    const seen = new Set<string>();
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const calleeName = calleeIdentifier(node.expression);
        if (calleeName) {
          const dstId = byKey.get(calleeName);
          const caller = enclosingSymbol(node, symbols, lineOf);
          if (dstId && caller && caller !== dstId) {
            const e = {
              id: edgeId(caller, dstId, 'calls'),
              src: caller,
              dst: dstId,
              rel: 'calls' as const,
              method: 'static' as const,
              provenance: 'EXTRACTED' as const,
              confidence: 1,
              evidence: { by: this.name, snippet: node.expression.getText() },
            };
            if (!seen.has(e.id)) {
              seen.add(e.id);
              edges.push(e);
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(sf, walk);
  }
}

// ---------------------------------------------------------------------------
// helpers (module-scope, no `this`)
// ---------------------------------------------------------------------------

interface SymInfo {
  name: string;
  type: string;
  signature?: string;
}

/** Map a TS AST declaration to a symbol name/type/signature, or null if not captured. */
function symbolInfo(node: ts.Node): SymInfo | null {
  if (ts.isClassDeclaration(node) && node.name) {
    return { name: node.name.text, type: 'class', signature: classHeading(node) };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { name: node.name.text, type: 'interface' };
  }
  if (ts.isEnumDeclaration(node)) {
    return { name: node.name.text, type: 'enum' };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { name: node.name.text, type: 'type' };
  }
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { name: node.name.text, type: 'function', signature: funcSignature(node) };
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    return { name: node.name.text, type: 'method', signature: funcSignature(node) };
  }
  if ((ts.isGetAccessor(node) || ts.isSetAccessor(node)) && ts.isIdentifier(node.name)) {
    return { name: node.name.text, type: ts.isGetAccessor(node) ? 'getter' : 'setter' };
  }
  if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
    return { name: node.name.text, type: 'property' };
  }
  // const foo = () => {} / const foo = function(){}
  if (ts.isVariableStatement(node)) {
    const d = node.declarationList.declarations[0];
    if (d && ts.isIdentifier(d.name) && d.initializer && isFunctionLike(d.initializer)) {
      return { name: d.name.text, type: 'function', signature: `${d.name.text}(…)` };
    }
  }
  return null;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function classHeading(node: ts.ClassDeclaration): string | undefined {
  const heritage = node.heritageClauses?.map((h) => h.getText()).join(' ');
  return heritage ? `class ${node.name?.text ?? ''} ${heritage}`.trim() : undefined;
}

function funcSignature(node: ts.FunctionDeclaration | ts.MethodDeclaration): string {
  const name = node.name && ts.isIdentifier(node.name) ? node.name.text : 'anonymous';
  const params = node.parameters.map((p) => p.getText()).join(', ');
  const ret = node.type ? `: ${node.type.getText()}` : '';
  return `${name}(${params})${ret}`;
}

/** The simple callee name for `foo()`, `this.foo()`, `obj.foo()` → "foo"; otherwise undefined. */
function calleeIdentifier(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** The id of the symbol whose span encloses `node`'s position; the innermost wins. */
function enclosingSymbol(
  node: ts.Node,
  symbols: LocalSymbol[],
  lineOf: (pos: number) => number,
): string | undefined {
  const line = lineOf(node.getStart());
  let best: LocalSymbol | undefined;
  for (const s of symbols) {
    const span = s.node.span;
    if (!span) continue;
    if (line >= span.start && line <= span.end) {
      if (
        !best ||
        (best.node.span && span.start >= best.node.span.start && span.end <= best.node.span.end)
      ) {
        best = s;
      }
    }
  }
  return best?.node.id;
}
