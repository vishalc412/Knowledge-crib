/**
 * PhpExtractor — emits `symbol` nodes (function / class / interface / trait / method) with
 * qualifiedName / span / signature, `member-of` edges (symbol → enclosing symbol or file), and
 * INTRA-FILE `calls` edges (a bare `foo()` call whose callee resolves to a same-file top-level
 * function).
 *
 * Engine: the vendored `tree-sitter-php` WASM grammar via `ctx.treeSitter('php')` (see
 * tree-sitter-pool.ts) — the FIRST tree-sitter-backed extractor in this codebase; every other
 * language extractor is a hand-rolled pure-JS parser. This is a proof-of-concept for that pattern:
 * a real CST walk against a real grammar, not a hand-tuned tokenizer, kept to the same
 * capability-honest altitude as the hand-rolled extractors (symbols + member-of + intra-file
 * bare-calls only — no CFG/statement body-walk, no cross-file resolution).
 *
 * Capability-honest: declares { imports:false, calls:true, inheritance:false, types:'none' }.
 * `extends`/`implements` targets ARE captured (in `meta.bases` / `meta.implements`, matching the
 * Go/Rust extractors' convention) so a future PhpResolver can turn them into cross-file `inherits`
 * edges — but since no such resolver exists yet, `inheritance` stays honestly `false` (the
 * capability describes what actually gets RESOLVED, not what's merely captured).
 *
 * Honest PHP limitations (mirrors the other extractors' conservative posture):
 *   - `$obj->method()` / `Class::method()` calls are NOT resolved (only bare `foo()` calls) —
 *     receiver resolution is inference's job, same stance as Go's `obj.method()`.
 *   - Anonymous classes/functions/closures are not emitted as symbols (parity with the other
 *     extractors' altitude — only named, top-level-addressable declarations are).
 *   - No per-statement CFG (executes/guarded-by) walk — out of scope for this proof-of-concept;
 *     the hand-rolled extractors' deeper Track-3 body-walk is a possible fast-follow, not required
 *     for capability-honest symbol + member-of + intra-file-calls coverage.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type Parser from 'web-tree-sitter';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';

type SyntaxNode = Parser.SyntaxNode;

/** Grammar node type → the symbol `type` we emit for it. */
const CONTAINER_TYPES: Readonly<Record<string, string>> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
};

interface LocalSymbol {
  node: Node;
  startLine: number;
  endLine: number;
}

export class PhpExtractor implements Extractor {
  name = 'lang:php';
  capabilities: Capabilities = { imports: false, calls: true, inheritance: false, types: 'none' };

  private static readonly SUPPORTED = ['.php'];

  supports(file: FileMeta): boolean {
    return PhpExtractor.SUPPORTED.some((e) => file.path.endsWith(e));
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    try {
      const text = await ctx.readText();
      const handle = ctx.treeSitter('php');
      const tree = handle.parse(text) as Parser.Tree;
      return this.walk(file.path, text, tree.rootNode, ctx);
    } catch {
      // malformed file / grammar unavailable — degrade to the Phase-1 file node only, never throw.
      return { nodes: [], edges: [] };
    }
  }

  private walk(path: string, text: string, root: SyntaxNode, ctx: ExtractCtx): ExtractResult {
    const fileId = ctx.idFor('file', { path });
    const symbols: LocalSymbol[] = [];
    const edges: Edge[] = [];
    // simple name → symbol id, for both member-of parent lookup and intra-file call resolution.
    const byName = new Map<string, string>();
    const topLevelFunctionNames = new Set<string>();

    const startLineOf = (n: SyntaxNode): number => n.startPosition.row + 1;
    const endLineOf = (n: SyntaxNode): number => n.endPosition.row + 1;

    const paramList = (params: SyntaxNode | null): string => {
      if (!params) return '';
      return params.namedChildren
        .map((p) => p.childForFieldName('name')?.text ?? p.text)
        .join(', ');
    };

    const makeSymbol = (
      n: SyntaxNode,
      qualifiedName: string,
      simpleName: string,
      type: string,
      signature: string,
      meta?: Record<string, unknown>,
    ): Node => {
      const startLine = startLineOf(n);
      return {
        id: ctx.idFor('symbol', { path, qualifiedName, startLine }),
        kind: 'symbol',
        type,
        name: simpleName,
        qualifiedName,
        file: path,
        span: { start: startLine, end: endLineOf(n) },
        lang: 'php',
        hash: ctx.hash(n.text),
        signature,
        ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      };
    };

    const memberOf = (childId: string, parentId: string): Edge => ({
      id: edgeId(childId, parentId, 'member-of'),
      src: childId,
      dst: parentId,
      rel: 'member-of',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name },
    });

    /** extends/implements targets on a class_declaration, for meta.bases / meta.implements. */
    const extendsAndImplements = (
      container: SyntaxNode,
    ): { bases: string[]; implements: string[] } => {
      const bases: string[] = [];
      const implementsList: string[] = [];
      for (const child of container.namedChildren) {
        if (child.type === 'base_clause') bases.push(...child.namedChildren.map((c) => c.text));
        if (child.type === 'class_interface_clause') {
          implementsList.push(...child.namedChildren.map((c) => c.text));
        }
      }
      return { bases, implements: implementsList };
    };

    /** Methods declared directly in a class/interface/trait's declaration_list body. */
    const walkMethods = (container: SyntaxNode, parentId: string, parentName: string): void => {
      const body = container.childForFieldName('body');
      if (!body) return;
      for (const child of body.namedChildren) {
        if (child.type !== 'method_declaration') continue;
        const nameNode = child.childForFieldName('name');
        if (!nameNode) continue;
        const simpleName = nameNode.text;
        const qualifiedName = `${parentName}.${simpleName}`;
        const params = paramList(child.childForFieldName('parameters'));
        const node = makeSymbol(
          child,
          qualifiedName,
          simpleName,
          'method',
          `${simpleName}(${params})`,
        );
        symbols.push({ node, startLine: startLineOf(child), endLine: endLineOf(child) });
        edges.push(memberOf(node.id, parentId));
        if (!byName.has(qualifiedName)) byName.set(qualifiedName, node.id);
      }
    };

    // --- pass 1: top-level declarations ---
    for (const top of root.namedChildren) {
      if (top.type === 'function_definition') {
        const nameNode = top.childForFieldName('name');
        if (!nameNode) continue;
        const simpleName = nameNode.text;
        const params = paramList(top.childForFieldName('parameters'));
        const node = makeSymbol(
          top,
          simpleName,
          simpleName,
          'function',
          `${simpleName}(${params})`,
        );
        symbols.push({ node, startLine: startLineOf(top), endLine: endLineOf(top) });
        edges.push(memberOf(node.id, fileId));
        byName.set(simpleName, node.id);
        topLevelFunctionNames.add(simpleName);
        continue;
      }
      const containerType = CONTAINER_TYPES[top.type];
      if (containerType) {
        const nameNode = top.childForFieldName('name');
        if (!nameNode) continue;
        const simpleName = nameNode.text;
        const { bases, implements: impls } = extendsAndImplements(top);
        const node = makeSymbol(
          top,
          simpleName,
          simpleName,
          containerType,
          `${containerType} ${simpleName}`,
          {
            ...(bases.length ? { bases } : {}),
            ...(impls.length ? { implements: impls } : {}),
          },
        );
        symbols.push({ node, startLine: startLineOf(top), endLine: endLineOf(top) });
        edges.push(memberOf(node.id, fileId));
        byName.set(simpleName, node.id);
        walkMethods(top, node.id, simpleName);
      }
    }

    // --- pass 2: intra-file bare calls (`foo()` → same-file top-level function only; `$o->m()` /
    // `Class::m()` are different grammar node types entirely and never enter this walk). ---
    const seenCalls = new Set<string>();
    const enclosingSymbolId = (line: number): string | undefined => {
      let best: LocalSymbol | undefined;
      for (const s of symbols) {
        if (s.startLine <= line && line <= s.endLine) {
          if (!best || s.startLine > best.startLine) best = s;
        }
      }
      return best?.node.id;
    };
    const walkCalls = (n: SyntaxNode): void => {
      if (n.type === 'function_call_expression') {
        const fn = n.childForFieldName('function');
        if (fn?.type === 'name' && topLevelFunctionNames.has(fn.text)) {
          const dstId = byName.get(fn.text);
          const callerId = enclosingSymbolId(startLineOf(n));
          if (dstId && callerId && callerId !== dstId) {
            const e: Edge = {
              id: edgeId(callerId, dstId, 'calls'),
              src: callerId,
              dst: dstId,
              rel: 'calls',
              method: 'static',
              provenance: 'EXTRACTED',
              confidence: 1,
              evidence: { by: this.name, snippet: fn.text },
            };
            if (!seenCalls.has(e.id)) {
              seenCalls.add(e.id);
              edges.push(e);
            }
          }
        }
      }
      for (const child of n.namedChildren) walkCalls(child);
    };
    walkCalls(root);

    return { nodes: symbols.map((s) => s.node), edges };
  }
}
