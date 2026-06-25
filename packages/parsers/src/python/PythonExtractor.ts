/**
 * PythonExtractor (M8) — emits `symbol` nodes (class / function / method) with qualifiedName /
 * span / signature, `member-of` edges (symbol → enclosing symbol or file), and INTRA-FILE `calls`
 * edges (a call whose callee resolves to a symbol declared in the same file).
 *
 * Engine: the hand-rolled {@link parsePython} tokenizer + structural parser (pure-JS, offline,
 * deterministic) — same posture as the TypeScript compiler API and the PL/SQL lexer. Cross-file
 * resolution (`imports` / `calls` to imported names / `inherits` via class bases) is the
 * PythonResolver's job (Phase 3); this extractor never guesses across files.
 *
 * Capability-honest: declares { imports:true, calls:true, inheritance:true, types:'none' }. The
 * extractor itself only emits member-of + intra-file calls; imports / cross-file calls / inherits
 * are produced by the resolver against the global symbol table. `types:'none'` ⇒ ZERO type edges
 * from either side (there is no Python type-inference pass).
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import type { PyCallSite, PyDef } from './parser.js';
import { parsePython } from './parser.js';

interface LocalSymbol {
  node: Node;
  /** lookup keys this symbol answers to for intra-file call resolution. */
  keys: string[];
  /** `self`/`cls`-style method calls resolve against the simple name of methods in the same class. */
  simpleName: string;
}

export class PythonExtractor implements Extractor {
  name = 'lang:python';
  capabilities: Capabilities = { imports: true, calls: true, inheritance: true, types: 'none' };

  private static readonly EXTS = ['.py'];
  /** `.py` / `.pyi` stubs; `.pyc` is bytecode (skipped by discovery anyway). */
  private static readonly SUPPORTED = ['.py', '.pyi'];

  supports(file: FileMeta): boolean {
    return PythonExtractor.SUPPORTED.some((e) => file.path.endsWith(e));
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    try {
      // readText + idFor are inside the try so an I/O failure or exotic-path encoding throw degrades
      // to a file node instead of rejecting the extract promise (the pipeline never aborts on one file).
      const text = await ctx.readText();
      const fileId = ctx.idFor('file', { path: file.path });
      return this.parse(file.path, fileId, text, ctx);
    } catch {
      // Degrade: a parse/IO failure yields no symbols, never throws the pipeline.
      return { nodes: [], edges: [] };
    }
  }

  private parse(path: string, fileId: string, text: string, ctx: ExtractCtx): ExtractResult {
    const mod = parsePython(text);
    const symbols: LocalSymbol[] = [];
    const byKey = new Map<string, string>(); // qualifiedName | simpleName → symbol id

    // --- pass 1: declarations + member-of, walking the nesting tree ---
    const visit = (defs: PyDef[], qualifier: string[]): void => {
      for (const d of defs) {
        const qualifiedName = [...qualifier, d.name].join('.');
        const id = ctx.idFor('symbol', { path, qualifiedName, startLine: d.startLine });
        // A function nested directly under a class is a method; under a function/file it's a function.
        const parentQ = qualifier.join('.');
        const parentType = parentQ === '' ? undefined : this.typeOf(parentQ, symbols);
        const isMethod = d.kind === 'function' && parentType === 'class';
        const type = d.kind === 'class' ? 'class' : isMethod ? 'method' : 'function';
        const signature =
          d.kind === 'class'
            ? d.bases.length
              ? `class ${d.name}(${d.bases.join(', ')})`
              : `class ${d.name}`
            : `${d.name}(${d.params.join(', ')})`;
        const node: Node = {
          id,
          kind: 'symbol',
          type,
          name: d.name,
          qualifiedName,
          file: path,
          span: { start: d.startLine, end: d.endLine },
          lang: 'python',
          hash: ctx.hash(this.defText(d, text)),
          signature,
          meta: {
            parentQualifier: parentQ,
            ...(d.async ? { async: true } : {}),
            ...(d.decorators.length ? { decorators: d.decorators } : {}),
            ...(d.bases.length ? { bases: d.bases } : {}),
            ...(d.params.length ? { params: d.params } : {}),
          },
        };
        symbols.push({ node, keys: [qualifiedName, d.name], simpleName: d.name });
        for (const k of [qualifiedName, d.name]) if (!byKey.has(k)) byKey.set(k, id);
        // recurse: a class's children are methods (qualifier grows); a function's children are
        // nested functions (qualifier grows too, but they stay kind 'function').
        visit(d.body, [...qualifier, d.name]);
      }
    };
    visit(mod.defs, []);

    const nodes = symbols.map((s) => s.node);
    const edges: Edge[] = symbols.map((s) =>
      this.memberOf(s.node, this.parentIdFor(s, byKey, fileId)),
    );

    // --- pass 2: intra-file calls (self.method / bare fn; module.fn is the resolver's job) ---
    this.collectCalls(mod.calls, symbols, byKey, edges);

    return { nodes, edges };
  }

  /** The `type` of an already-emitted symbol by qualifiedName (parent-type check for methods). */
  private typeOf(qualifiedName: string, all: LocalSymbol[]): string | undefined {
    return all.find((s) => s.node.qualifiedName === qualifiedName)?.node.type;
  }

  private parentIdFor(sym: LocalSymbol, byKey: Map<string, string>, fileId: string): string {
    const parentQualifier = (sym.node.meta?.parentQualifier as string) ?? '';
    if (parentQualifier === '') return fileId;
    // the parent was emitted before its children, so its qualifiedName is in byKey already.
    return byKey.get(parentQualifier) ?? fileId;
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

  /** Emit `calls` edges for call sites whose callee resolves to a same-file symbol. */
  private collectCalls(
    calls: PyCallSite[],
    symbols: LocalSymbol[],
    byKey: Map<string, string>,
    edges: Edge[],
  ): void {
    const seen = new Set<string>();
    for (const c of calls) {
      let dstId: string | undefined;
      if (c.head === 'self' || c.head === 'cls') {
        // method call within the enclosing class → resolve by simple name.
        dstId = byKey.get(c.name);
      } else if (c.tail.length === 0) {
        // bare call `foo()` → same-file symbol by simple or qualified name.
        dstId = byKey.get(c.name);
      } else {
        // `module.fn()` or `obj.fn()` — cross-file / needs inference; leave to the resolver.
        continue;
      }
      if (!dstId) continue;
      const caller = enclosingSymbolId(c.line, symbols);
      if (!caller || caller === dstId) continue; // skip self-recursion (mirrors TS extractor)
      const calleeText = c.tail.length ? `${c.head}.${c.tail.join('.')}` : c.head;
      const e = {
        id: edgeId(caller, dstId, 'calls'),
        src: caller,
        dst: dstId,
        rel: 'calls' as const,
        method: 'static' as const,
        provenance: 'EXTRACTED' as const,
        confidence: 1,
        evidence: { by: this.name, snippet: calleeText },
      };
      if (!seen.has(e.id)) {
        seen.add(e.id);
        edges.push(e);
      }
    }
  }

  /** Best-effort source text for a def — used only for hashing (change detection), needs no precision. */
  private defText(d: PyDef, src: string): string {
    const lines = src.split('\n');
    return lines.slice(d.startLine - 1, d.endLine).join('\n');
  }
}

/** Innermost symbol whose span contains `line`; the narrowest wins. */
function enclosingSymbolId(line: number, symbols: LocalSymbol[]): string | undefined {
  let best: LocalSymbol | undefined;
  for (const s of symbols) {
    const span = s.node.span;
    if (!span || line < span.start || line > span.end) continue;
    if (
      !best ||
      (best.node.span && span.start >= best.node.span.start && span.end <= best.node.span.end)
    )
      best = s;
  }
  return best?.node.id;
}
