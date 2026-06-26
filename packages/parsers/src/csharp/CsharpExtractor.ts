/**
 * CsharpExtractor — emits `symbol` nodes (namespace / class / interface / struct / record / enum /
 * delegate / method / property / constructor / indexer / operator) with qualifiedName / span /
 * signature, `member-of` edges (symbol → enclosing symbol or file), and INTRA-FILE `calls` edges
 * (a call whose callee resolves to a symbol declared in the same file).
 *
 * Engine: the hand-rolled {@link parseCsharp} tokenizer + structural parser (pure-JS, offline,
 * deterministic) — same posture as the Java extractor. Cross-file resolution (usings / calls to
 * imported names / inherits / implements) is the CsharpResolver's job (Phase 3); this extractor never
 * guesses across files.
 *
 * Capability-honest: declares { imports:true, calls:true, inheritance:true, types:'none' }. The
 * extractor itself emits member-of + intra-file calls (`this.M()` / bare `M()` / `new Cls()` to a
 * same-file class); usings / cross-file calls / inherits / implements are produced by the resolver
 * against the global symbol table. `types:'none'` ⇒ ZERO type edges.
 *
 * Fields are NOT emitted as symbols (parity with the Java extractor's altitude). Properties are
 * emitted as ONE symbol (get/set/init accessors are NOT descended). Local functions inside method
 * bodies are NOT extracted (method bodies are consumed, not descended). Attributes preceding a
 * declaration are captured as `meta.attributes` (class + method + property level) so the graph can
 * carry `[ApiController]` / `[HttpGet]` / `[Route]` etc. as metadata — they are NOT resolved.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { clampExpr } from '../types.js';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import { collectComments } from './lexer.js';
import type { CsCommentBlock } from './lexer.js';
import type { CsharpCallSite, CsharpDef, CsharpStmt, CsharpSwitchCase } from './parser.js';
import { parseCsharp } from './parser.js';

/** Spread an `expr` field plus its `exprTruncated` honesty flag from a raw expression string. */
function exprFields(raw: string | undefined): { expr?: string; exprTruncated?: true } {
  if (!raw) return {};
  const { expr, truncated } = clampExpr(raw);
  return truncated ? { expr, exprTruncated: true } : { expr };
}

interface LocalSymbol {
  node: Node;
  keys: string[];
  simpleName: string;
  /** enclosing type qualified name ("" at file level) — used for `this.M()` / bare `M()` resolution. */
  parentQualifier: string;
}

const TYPE_KINDS = new Set<CsharpDef['kind']>([
  'namespace',
  'class',
  'interface',
  'struct',
  'record',
  'enum',
]);

/**
 * Control-flow / statement keywords that take a parenthesized expression (`if (…)`, `for (…)`,
 * `foreach (…)`, `while (…)`, `switch (…)`, `catch (…)`, `using (…)`, `lock (…)`, `fixed (…)`,
 * `checked (…)`, `unchecked (…)`). The whole-stream call-site collector records any `NAME (` —
 * these keywords are NOT call sites, so {@link CsharpExtractor.stampCallSites} filters them out of
 * `meta.calls`. Lowercase heads never collide with PascalCase C# method names.
 */
const PAREN_KEYWORDS = new Set<string>([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'using',
  'lock',
  'fixed',
  'checked',
  'unchecked',
]);

export class CsharpExtractor implements Extractor {
  name = 'lang:csharp';
  capabilities: Capabilities = { imports: true, calls: true, inheritance: true, types: 'none' };

  private static readonly SUPPORTED = ['.cs'];

  supports(file: FileMeta): boolean {
    return CsharpExtractor.SUPPORTED.some((e) => file.path.endsWith(e));
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    try {
      const text = await ctx.readText();
      const fileId = ctx.idFor('file', { path: file.path });
      return this.parse(file.path, fileId, text, ctx);
    } catch {
      return { nodes: [], edges: [] };
    }
  }

  private parse(path: string, fileId: string, text: string, ctx: ExtractCtx): ExtractResult {
    const mod = parseCsharp(text);
    const comments = collectComments(text);
    const symbols: LocalSymbol[] = [];
    const byKey = new Map<string, string>(); // qualifiedName | simpleName → symbol id
    const methods: { procId: string; stmts: CsharpStmt[] }[] = [];

    // --- pass 1: declarations + member-of, walking the nesting tree ---
    const visit = (defs: CsharpDef[], qualifier: string[]): void => {
      for (const d of defs) {
        const qualifiedName = [...qualifier, d.name].join('.');
        const id = ctx.idFor('symbol', { path, qualifiedName, startLine: d.startLine });
        const parentQ = qualifier.join('.');
        const node: Node = {
          id,
          kind: 'symbol',
          type: d.kind,
          name: d.name,
          qualifiedName,
          file: path,
          span: { start: d.startLine, end: d.endLine },
          lang: 'csharp',
          hash: ctx.hash(this.defText(d, text)),
          signature: this.signature(d),
          meta: {
            parentQualifier: parentQ,
            ...(d.modifiers.length ? { modifiers: d.modifiers } : {}),
            ...(d.attributes.length ? { attributes: d.attributes } : {}),
            ...(d.bases.length ? { bases: d.bases } : {}),
            ...(d.implements.length ? { implements: d.implements } : {}),
            ...(d.params.length ? { params: d.params } : {}),
          },
        };
        symbols.push({
          node,
          keys: [qualifiedName, d.name],
          simpleName: d.name,
          parentQualifier: parentQ,
        });
        for (const k of [qualifiedName, d.name]) if (!byKey.has(k)) byKey.set(k, id);
        // only TYPE/NAMESPACE declarations nest further (methods/properties have empty body).
        if (TYPE_KINDS.has(d.kind)) {
          visit(d.body, [...qualifier, d.name]);
        } else if (
          (d.kind === 'method' || d.kind === 'constructor' || d.kind === 'operator') &&
          d.stmts &&
          d.stmts.length > 0
        ) {
          // collect method bodies for the Track 3 body-walk (statement/condition/CFG emission).
          methods.push({ procId: id, stmts: d.stmts });
        }
      }
    };
    visit(mod.defs, []);

    const nodes: Node[] = symbols.map((s) => s.node);
    const edges: Edge[] = symbols.map((s) =>
      this.memberOf(s.node, this.parentIdFor(s, byKey, fileId)),
    );

    // --- pass 2: intra-file calls (this.M / bare M / new SameFileCls()) — unchanged ---
    this.collectCalls(mod.calls, symbols, byKey, edges);

    // --- pass 2b (schema 1.2): attach preceding doc comments as `explanation` nodes + `describes`
    // edges to each non-namespace symbol (class/method/property/etc.). Strictly additive. ---
    this.attachComments(symbols, comments, nodes, edges, ctx, path);

    // --- pass 3 (Track 3): body-walk — STRICTLY ADDITIVE. Emits statement + condition nodes,
    // executes + guarded-by edges, annotates the pass-2 `calls` edges with the guard chain
    // (cfgPath/guard/branch/inLoop/inException), and records call sites on proc.meta.calls. ---
    const edgeById = new Map<string, Edge>();
    for (const e of edges) edgeById.set(e.id, e);
    const walker = new BodyWalker(path, ctx, byKey, symbols, nodes, edgeById);
    for (const m of methods) walker.walkMethod(m.stmts, m.procId);
    this.stampCallSites(mod.calls, symbols, nodes);

    // the walker mutates pass-2 calls edges in place (annotation) and adds new executes/guarded-by
    // edges to the map — return the map's values so the new edges are included.
    return { nodes, edges: Array.from(edgeById.values()) };
  }

  private signature(d: CsharpDef): string {
    switch (d.kind) {
      case 'namespace':
        return `namespace ${d.name}`;
      case 'class':
        return `class ${d.name}`;
      case 'interface':
        return `interface ${d.name}`;
      case 'struct':
        return `struct ${d.name}`;
      case 'record':
        return `record ${d.name}(${d.params.join(', ')})`;
      case 'enum':
        return `enum ${d.name}`;
      case 'delegate':
        return `delegate ${d.name}(${d.params.join(', ')})`;
      case 'property':
        return d.name;
      case 'indexer':
        return `this[${d.params.join(', ')}]`;
      case 'operator':
        return d.name;
      case 'method':
      case 'constructor':
        return `${d.name}(${d.params.join(', ')})`;
    }
  }

  private parentIdFor(sym: LocalSymbol, byKey: Map<string, string>, fileId: string): string {
    const parentQualifier = sym.node.meta?.parentQualifier as string | undefined;
    if (!parentQualifier) return fileId;
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
    calls: CsharpCallSite[],
    symbols: LocalSymbol[],
    byKey: Map<string, string>,
    edges: Edge[],
  ): void {
    const seen = new Set<string>();
    for (const c of calls) {
      let dstId: string | undefined;
      if (c.head === 'base') {
        continue; // parent-class member / ctor-call — resolver's job
      }
      if (c.head === 'this') {
        // `this.M()` → a method of the enclosing class by simple name.
        // `this(...)` ctor-call → no method named 'this' → dropped (can't resolve overload).
        dstId = methodInEnclosingClass(c.line, c.name, symbols);
      } else if (c.tail.length === 0) {
        // bare `M()` or `new Cls()` → same-file symbol by simple / qualified name.
        dstId = byKey.get(c.name) ?? byKey.get(c.head);
      } else {
        // `obj.M()` / `Type.M()` — needs inference / cross-file; leave to the resolver.
        continue;
      }
      if (!dstId) continue;
      const caller = enclosingSymbolId(c.line, symbols);
      if (!caller || caller === dstId) continue; // skip self-recursion
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

  /**
   * Stamp each procedure symbol's `meta.calls` with every call site whose line falls inside its
   * span (Track 3). The flat whole-stream {@link collectCallSites} list already has every call
   * site; grouping by the narrowest enclosing symbol gives per-procedure call-site lists. The
   * language-agnostic `extract_rules` reads `meta.calls` (via `callLineIndex`) to recover the
   * call-site line for a deduped `calls` edge (the edge's dst is the callee's DEFINITION line, not
   * the call site). Only method/constructor/operator symbols are stamped (classes/properties are
   * not procedures). Strictly additive — `meta.calls` is new; existing meta fields are preserved.
   */
  private stampCallSites(calls: CsharpCallSite[], symbols: LocalSymbol[], nodes: Node[]): void {
    const byProc = new Map<string, { callee: string; line: number }[]>();
    for (const c of calls) {
      // the whole-stream collector records any `NAME (` — including control-flow keywords that take
      // a parenthesized expression (`if (…)`, `for (…)`, `foreach (…)`, `switch (…)`, `catch (…)`,
      // `using (…)`, `lock (…)`, `while (…)`). These are NOT call sites; skip them. C# methods are
      // PascalCase, so a lowercase keyword head never collides with a real method call.
      if (PAREN_KEYWORDS.has(c.head)) continue;
      const caller = enclosingSymbolId(c.line, symbols);
      if (!caller) continue;
      const arr = byProc.get(caller) ?? [];
      arr.push({ callee: c.name, line: c.line });
      byProc.set(caller, arr);
    }
    const nodeById = new Map<string, Node>();
    for (const n of nodes) nodeById.set(n.id, n);
    for (const [procId, sites] of byProc) {
      const node = nodeById.get(procId);
      if (!node) continue;
      const t = node.type as CsharpDef['kind'];
      if (t !== 'method' && t !== 'constructor' && t !== 'operator') continue;
      node.meta = { ...(node.meta ?? {}), calls: sites };
    }
  }

  /** Best-effort source text for a def — used only for hashing (change detection), needs no precision. */
  private defText(d: CsharpDef, src: string): string {
    const lines = src.split('\n');
    return lines.slice(d.startLine - 1, d.endLine).join('\n');
  }

  /**
   * 1.2: for each non-namespace symbol, if a comment block ends on the line immediately above the
   * declaration's first token (attributes/modifiers included in `startLine`), emit an `explanation`
   * node (carrying the comment text in `meta.text` + `commentRef` span) + a `describes` edge
   * (explanation → symbol). Deduped by explanation id (comment start line). Strictly additive.
   */
  private attachComments(
    symbols: LocalSymbol[],
    comments: CsCommentBlock[],
    nodes: Node[],
    edges: Edge[],
    ctx: ExtractCtx,
    path: string,
  ): void {
    const seen = new Set<string>();
    for (const s of symbols) {
      if (s.node.type === 'namespace') continue; // namespaces: doc comments are not symbol docs
      const startLine = s.node.span?.start;
      if (startLine === undefined) continue;
      const block = comments.find((c) => c.end === startLine - 1);
      if (!block || !block.text) continue;
      const id = ctx.idFor('explanation', { path, startLine: block.start });
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        kind: 'explanation',
        commentRef: { file: path, span: { start: block.start, end: block.end } },
        file: path,
        span: { start: block.start, end: block.end },
        lang: 'csharp',
        hash: ctx.hash(`${path}:${block.start}:${block.text}`),
        meta: { text: block.text },
      });
      edges.push({
        id: edgeId(id, s.node.id, 'describes'),
        src: id,
        dst: s.node.id,
        rel: 'describes',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name, snippet: 'COMMENT' },
      });
    }
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

/** Innermost TYPE symbol (class / interface / struct / record / enum) whose span contains `line`. */
function enclosingTypeId(line: number, symbols: LocalSymbol[]): LocalSymbol | undefined {
  let best: LocalSymbol | undefined;
  for (const s of symbols) {
    if (!TYPE_KINDS.has(s.node.type as CsharpDef['kind'])) continue;
    const span = s.node.span;
    if (!span || line < span.start || line > span.end) continue;
    if (
      !best ||
      (best.node.span && span.start >= best.node.span.start && span.end <= best.node.span.end)
    )
      best = s;
  }
  return best;
}

/**
 * Resolve `this.M()` to a method of the enclosing class: find the narrowest CLASS whose span
 * contains the call line, then a method of that class with simple name `name`. Avoids cross-class
 * simple-name collisions that a global byKey lookup would hit. Shared by {@link CsharpExtractor}
 * (pass-2 intra-file calls) and {@link BodyWalker} (pass-3 calls-edge annotation).
 */
function methodInEnclosingClass(
  line: number,
  name: string,
  symbols: LocalSymbol[],
): string | undefined {
  const cls = enclosingTypeId(line, symbols);
  if (!cls) return undefined;
  const enclosingQ = cls.node.qualifiedName;
  const match = symbols.find(
    (s) =>
      s.simpleName === name &&
      s.parentQualifier === enclosingQ &&
      (s.node.type === 'method' || s.node.type === 'constructor'),
  );
  return match?.node.id;
}

// ---------------------------------------------------------------------------------------------
// BodyWalker (Track 3) — walks one method's statement tree with a guard stack, emitting the
// statement/condition nodes + executes/guarded-by edges and annotating intra-file `calls` edges
// with the guard chain. Mirrors PlSqlExtractor.walkBlock/walkIf/walkLoop/condition/addCall but with
// the SIMPLIFICATION from the Track 3 spec: the FULL guard stack is tracked inline and stamped
// DIRECTLY on the executes/calls/guarded-by edges at emission time — no separate CFG pass.
// ---------------------------------------------------------------------------------------------

/** The guard context carried through the body-walk (passed by VALUE so siblings don't pollute). */
interface WalkEnv {
  /** condition ids outer→inner — the materialized cfgPath. */
  guardStack: string[];
  inLoop: boolean;
  inException: boolean;
  /** polarity of the INNERMOST condition on the path: THEN/ELSIF/ELSE/LOOP/CASE; undefined at top level. */
  branch: string | undefined;
}

class BodyWalker {
  /** condition ids already emitted, deduped by (file, line) — one condition node per IF/loop. */
  private readonly condSeen = new Set<string>();
  /** 1.2: case-branch ids already emitted, deduped by (file, line). */
  private readonly caseBranchSeen = new Set<string>();
  /** 1.2: exception-handler ids already emitted, deduped by (file, line). */
  private readonly excSeen = new Set<string>();
  /** 1.2: raise ids already emitted, deduped by (file, line). */
  private readonly raiseSeen = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly ctx: ExtractCtx,
    private readonly byKey: Map<string, string>,
    private readonly symbols: LocalSymbol[],
    private readonly nodes: Node[],
    private readonly edgeById: Map<string, Edge>,
  ) {}

  /** Walk one method body at procedure top level (empty guard stack, no loop, no exception). */
  walkMethod(stmts: CsharpStmt[], procId: string): void {
    this.walkBody(stmts, procId, {
      guardStack: [],
      inLoop: false,
      inException: false,
      branch: undefined,
    });
  }

  private walkBody(stmts: CsharpStmt[], procId: string, env: WalkEnv): void {
    for (const s of stmts) this.walkStmt(s, procId, env);
  }

  private walkStmt(s: CsharpStmt, procId: string, env: WalkEnv): void {
    switch (s.kind) {
      case 'if':
        this.walkIf(s, procId, env);
        break;
      case 'loop':
        this.walkLoop(s, procId, env);
        break;
      case 'switch':
        this.walkSwitch(s, procId, env);
        break;
      case 'try':
        this.walkTry(s, procId, env);
        break;
      case 'return':
      case 'throw':
        this.addStatement(s, procId, env);
        break;
      case 'call':
        this.addCallStatement(s, procId, env);
        break;
      case 'assign':
        this.addAssignStatement(s, procId, env);
        break;
      // 'plain' carries only switch-expression arms (no action line) — emit the arms, nothing else.
      case 'plain':
        if (s.switchArms) this.emitSwitchArms(s.switchArms);
        break;
      default:
        break;
    }
  }

  /** Emit a condition node (deduped by file+line) and return its id. The first branch sets `branch`. */
  private condition(expr: string, line: number, branch: string): string {
    const id = this.ctx.idFor('condition', { file: this.path, line });
    if (!this.condSeen.has(id)) {
      this.condSeen.add(id);
      const c = clampExpr(expr);
      this.nodes.push({
        id,
        kind: 'condition',
        branch,
        expr: c.expr,
        ...(c.truncated ? { exprTruncated: true } : {}),
        file: this.path,
        span: { start: line, end: line },
        lang: 'csharp',
        hash: this.ctx.hash(`${this.path}:${line}:${expr}`),
      });
    }
    return id;
  }

  /**
   * IF: ONE condition node per IF (keyed by the `if` line, deduped) — all branches share the same
   * condition id; the per-branch polarity (THEN/ELSIF/ELSE) is carried on each branch's EDGE `branch`
   * field, not as separate condition nodes (the M11/Track 3 convention, matching PlSqlExtractor).
   */
  private walkIf(s: CsharpStmt, procId: string, env: WalkEnv): void {
    if (!s.branches || s.ifLine === undefined) return;
    const condId = this.condition(s.branches[0]?.predicate ?? '', s.ifLine, 'THEN');
    for (const b of s.branches) {
      const branchEnv: WalkEnv = {
        ...env,
        guardStack: [...env.guardStack, condId],
        branch: b.label,
      };
      this.walkBody(b.body, procId, branchEnv);
    }
  }

  /** for/foreach/while/do: one condition (branch:'LOOP'); body runs inLoop:true. 1.2: a
   *  `foreach (T x in coll)` whose `coll` is a bare identifier resolving to a same-file symbol
   *  emits an `iterates` edge (loop condition → that symbol) — deterministic intra-file only;
   *  a `coll` that is a parameter/local/dotted/call is skipped (capability-honest). */
  private walkLoop(s: CsharpStmt, procId: string, env: WalkEnv): void {
    if (!s.body) return;
    const condId = s.predicate ? this.condition(s.predicate, s.startLine, 'LOOP') : undefined;
    if (s.loopKind === 'foreach' && condId && s.predicate) {
      const coll = foreachCollection(s.predicate);
      if (coll) {
        const targetId = this.byKey.get(coll);
        if (targetId) this.addEdge(condId, targetId, 'iterates', coll);
      }
    }
    const loopEnv: WalkEnv = {
      ...env,
      guardStack: condId ? [...env.guardStack, condId] : env.guardStack,
      branch: condId ? 'LOOP' : env.branch,
      inLoop: true,
    };
    this.walkBody(s.body, procId, loopEnv);
  }

  /** switch: one `case-branch` node per `case`/`default` (whenSelector = predicate; omitted for
   *  default); each case body is walked under that case-branch as its guard (consistent with if-walk). */
  private walkSwitch(s: CsharpStmt, procId: string, env: WalkEnv): void {
    if (!s.cases) return;
    for (const c of s.cases) {
      const isDefault = !c.predicate; // parser omits predicate for `default:`
      const condId = this.caseBranch(c.predicate ?? '', c.condLine, isDefault);
      const caseEnv: WalkEnv = { ...env, guardStack: [...env.guardStack, condId], branch: 'CASE' };
      this.walkBody(c.body, procId, caseEnv);
    }
  }

  /** try/catch/finally: try body + every handler run inException:true. 1.2: each `catch (T e)
   *  [when (f)]` emits an `exception-handler` node (whenSelector = `T`[` when f`]) + `handles` edges
   *  to every statement/assignment/raise node emitted in its body (the actions this handler runs).
   *  `finally` is walked inException but emits no handler node (it is cleanup, not a catch). */
  private walkTry(s: CsharpStmt, procId: string, env: WalkEnv): void {
    if (s.tryBody) this.walkBody(s.tryBody, procId, { ...env, inException: true });
    if (!s.handlers) return;
    for (const h of s.handlers) {
      if (h.finally) {
        this.walkBody(h.body, procId, { ...env, inException: true });
        continue;
      }
      const selector = catchSelector(h.predicate, h.filter);
      const handlerId = this.exceptionHandler(selector, h.line);
      const before = this.nodes.length;
      this.walkBody(h.body, procId, { ...env, inException: true });
      const handled = this.nodes
        .slice(before)
        .filter((n) => n.kind === 'statement' || n.kind === 'assignment' || n.kind === 'raise');
      for (const target of handled)
        this.addEdge(handlerId, target.id, 'handles', selector || 'CATCH');
    }
  }

  /**
   * Emit a statement node (return/throw) + the executes edge proc→stmt carrying the guard chain,
   * + a guarded-by edge to the innermost condition when guarded. Returns/throws always fire as
   * action lines. 1.2: a `throw` additionally emits a `raise` node + `raises` edge (proc → raise)
   * + guarded-by on the raise; switch-expression arms on the leaf are lifted to `case-branch` nodes.
   */
  private addStatement(s: CsharpStmt, procId: string, env: WalkEnv): void {
    const id = this.ctx.idFor('statement', { file: this.path, line: s.startLine });
    const node: Node = {
      id,
      kind: 'statement',
      type: s.kind,
      ...exprFields(s.expr),
      file: this.path,
      span: { start: s.startLine, end: s.endLine },
      lang: 'csharp',
      hash: this.ctx.hash(`${this.path}:${s.startLine}:${s.kind}`),
      meta: {
        ...(s.head ? { head: s.head } : {}),
        inLoop: env.inLoop,
        inException: env.inException,
        branch: env.guardStack.length ? 'GUARDED' : undefined,
      },
    };
    this.nodes.push(node);
    this.emitExecutes(procId, id, s, env);
    if (env.guardStack.length) {
      this.emitGuardedBy(id, env.guardStack[env.guardStack.length - 1]!, s.kind.toUpperCase());
    }
    if (s.callSite) this.annotateCallEdge(s.callSite, procId, env);
    if (s.kind === 'throw') this.addRaise(s, procId, env);
    if (s.switchArms) this.emitSwitchArms(s.switchArms);
  }

  /**
   * Emit a `call` statement node (an action line whose notable action is a call) + executes +
   * guarded-by, AND annotate the intra-file `calls` edge (emitted in pass 2) with the guard chain.
   * `head` is the callee simple name (the decision-table action's head).
   */
  private addCallStatement(s: CsharpStmt, procId: string, env: WalkEnv): void {
    const id = this.ctx.idFor('statement', { file: this.path, line: s.startLine });
    const node: Node = {
      id,
      kind: 'statement',
      type: 'call',
      ...exprFields(s.expr),
      file: this.path,
      span: { start: s.startLine, end: s.endLine },
      lang: 'csharp',
      hash: this.ctx.hash(`${this.path}:${s.startLine}:call`),
      meta: {
        head: s.head ?? '',
        inLoop: env.inLoop,
        inException: env.inException,
        branch: env.guardStack.length ? 'GUARDED' : undefined,
      },
    };
    this.nodes.push(node);
    this.emitExecutes(procId, id, s, env);
    if (env.guardStack.length) {
      this.emitGuardedBy(id, env.guardStack[env.guardStack.length - 1]!, 'CALL');
    }
    if (s.callSite) this.annotateCallEdge(s.callSite, procId, env);
    if (s.switchArms) this.emitSwitchArms(s.switchArms);
  }

  /** 1.2: an `assign` leaf emits an `assignment` node (assignTarget = LHS identifier) + executes +
   *  guarded-by, AND annotates the intra-file `calls` edge when the RHS contains a call (so
   *  `x = Foo()` still gets the guard chain on its calls edge). Switch-expression arms are lifted. */
  private addAssignStatement(s: CsharpStmt, procId: string, env: WalkEnv): void {
    const id = this.ctx.idFor('assignment', { file: this.path, line: s.startLine });
    const node: Node = {
      id,
      kind: 'assignment',
      ...(s.assignTarget ? { assignTarget: s.assignTarget } : {}),
      ...exprFields(s.expr),
      file: this.path,
      span: { start: s.startLine, end: s.endLine },
      lang: 'csharp',
      hash: this.ctx.hash(`${this.path}:${s.startLine}:assign`),
      meta: {
        inLoop: env.inLoop,
        inException: env.inException,
        branch: env.guardStack.length ? 'GUARDED' : undefined,
      },
    };
    this.nodes.push(node);
    this.emitExecutes(procId, id, s, env);
    if (env.guardStack.length) {
      this.emitGuardedBy(id, env.guardStack[env.guardStack.length - 1]!, 'ASSIGN');
    }
    if (s.callSite) this.annotateCallEdge(s.callSite, procId, env);
    if (s.switchArms) this.emitSwitchArms(s.switchArms);
  }

  /** 1.2: a `throw` emits a `raise` node (name = exception type, errorMessage = string literal in
   *  `new XException("msg")` else the raw expr) + a `raises` edge (proc → raise) + guarded-by when
   *  guarded. Deduped by (file, line). `throw;` (rethrow) → empty name/message (honest). */
  private addRaise(s: CsharpStmt, procId: string, env: WalkEnv): void {
    const id = this.ctx.idFor('raise', { file: this.path, line: s.startLine });
    if (this.raiseSeen.has(id)) return;
    this.raiseSeen.add(id);
    const { name, errorMessage } = parseThrowExpr(s.expr ?? '');
    const node: Node = {
      id,
      kind: 'raise',
      ...(name ? { name } : {}),
      ...(errorMessage ? { errorMessage: clampExpr(errorMessage).expr } : {}),
      file: this.path,
      span: { start: s.startLine, end: s.endLine },
      lang: 'csharp',
      hash: this.ctx.hash(`${this.path}:${s.startLine}:raise:${name}`),
      meta: { inLoop: env.inLoop, inException: env.inException },
    };
    this.nodes.push(node);
    this.addEdge(procId, id, 'raises', name || 'THROW');
    if (env.guardStack.length) {
      this.emitGuardedBy(id, env.guardStack[env.guardStack.length - 1]!, 'RAISE');
    }
  }

  /** 1.2: emit a `case-branch` node (deduped by file+line) with whenSelector = predicate (omitted
   *  for `default`) and return its id; used as the guard for the case body. */
  private caseBranch(predicate: string, line: number, isDefault: boolean): string {
    const id = this.ctx.idFor('case-branch', { file: this.path, line });
    if (!this.caseBranchSeen.has(id)) {
      this.caseBranchSeen.add(id);
      this.nodes.push({
        id,
        kind: 'case-branch',
        branch: 'CASE',
        expr: predicate,
        ...(!isDefault && predicate ? { whenSelector: predicate } : {}),
        file: this.path,
        span: { start: line, end: line },
        lang: 'csharp',
        hash: this.ctx.hash(`${this.path}:case:${line}:${predicate}`),
      });
    }
    return id;
  }

  /** 1.2: emit an `exception-handler` node (deduped by file+line) with whenSelector = caught type
   *  (+ ` when filter` when present); whenSelector omitted for a catch-all `catch {}`. */
  private exceptionHandler(selector: string, line: number): string {
    const id = this.ctx.idFor('exception-handler', { file: this.path, line });
    if (!this.excSeen.has(id)) {
      this.excSeen.add(id);
      this.nodes.push({
        id,
        kind: 'exception-handler',
        ...(selector ? { whenSelector: selector } : {}),
        file: this.path,
        span: { start: line, end: line },
        lang: 'csharp',
        hash: this.ctx.hash(`${this.path}:exc:${line}:${selector}`),
      });
    }
    return id;
  }

  /** 1.2: lift switch-expression arms to `case-branch` nodes (predicate = pattern text; no body —
   *  the arms are selector patterns on the enclosing return/throw/assign action line). */
  private emitSwitchArms(arms: CsharpSwitchCase[]): void {
    for (const a of arms) {
      this.caseBranch(a.predicate ?? '', a.condLine, false);
    }
  }

  /** Add (or replace) an edge in the shared edge map. Used for raises/handles/iterates. */
  private addEdge(src: string, dst: string, rel: Edge['rel'], snippet: string): void {
    const e: Edge = {
      id: edgeId(src, dst, rel),
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'lang:csharp', snippet },
    };
    this.edgeById.set(e.id, e);
  }

  /** executes edge proc→stmt with cfgPath (always the array) + guard/branch when guarded. */
  private emitExecutes(procId: string, stmtId: string, s: CsharpStmt, env: WalkEnv): void {
    const e: Edge = {
      id: edgeId(procId, stmtId, 'executes'),
      src: procId,
      dst: stmtId,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'lang:csharp', snippet: s.head ?? s.kind },
      cfgPath: env.guardStack.slice(),
      inLoop: env.inLoop,
      inException: env.inException,
    };
    if (env.guardStack.length) {
      e.guard = env.guardStack[env.guardStack.length - 1];
      e.branch = env.branch;
    }
    this.edgeById.set(e.id, e);
  }

  /** guarded-by edge stmt→innermost condition (only when guardStack non-empty). */
  private emitGuardedBy(stmtId: string, guardId: string, snippet: string): void {
    const e: Edge = {
      id: edgeId(stmtId, guardId, 'guarded-by'),
      src: stmtId,
      dst: guardId,
      rel: 'guarded-by',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'lang:csharp', snippet },
    };
    this.edgeById.set(e.id, e);
  }

  /**
   * Resolve a call site intra-file (mirrors pass-2 {@link CsharpExtractor.collectCalls}: this.M →
   * enclosing-class method, bare M / new Cls → byKey, dotted → resolver's job) and annotate the
   * existing `calls` edge with the guard chain (best-effort, last-wins for a callee called in
   * multiple branches — one edge per (caller,callee) is the documented lossy-but-honest behavior).
   */
  private annotateCallEdge(c: CsharpCallSite, procId: string, env: WalkEnv): void {
    const dstId = this.resolveCall(c, procId);
    if (!dstId || dstId === procId) return;
    const e = this.edgeById.get(edgeId(procId, dstId, 'calls'));
    if (!e) return;
    e.cfgPath = env.guardStack.slice();
    e.inLoop = env.inLoop;
    e.inException = env.inException;
    if (env.guardStack.length) {
      e.guard = env.guardStack[env.guardStack.length - 1];
      e.branch = env.branch;
    }
  }

  /** Intra-file call resolution, matching {@link CsharpExtractor.collectCalls} exactly. */
  private resolveCall(c: CsharpCallSite, procId: string): string | undefined {
    if (c.head === 'base') return undefined; // parent-class member / ctor-call — resolver's job
    if (c.head === 'this') {
      if (c.tail.length === 0) return undefined; // this(...) ctor-call → no method named 'this'
      return methodInEnclosingClass(c.line, c.name, this.symbols);
    }
    if (c.tail.length === 0) {
      // bare `M()` or `new Cls()` → same-file symbol by simple / qualified name.
      return this.byKey.get(c.name) ?? this.byKey.get(c.head);
    }
    return undefined; // `obj.M()` / `Type.M()` — needs inference / cross-file; leave to the resolver.
  }
}

// ---------------------------------------------------------------------------------------------
// Schema 1.2 throw / catch / foreach helpers (best-effort, conservative, capability-honest).
// ---------------------------------------------------------------------------------------------

/**
 * Parse a `throw` expression text into an exception name + errorMessage. The name is the type in
 * `new A.B.C(…)` or a bare thrown identifier (`throw ex;`); errorMessage is the content of the first
 * regular string literal in the expression (the common `new XException("msg")` form), else the raw
 * expression text. `throw;` (rethrow) → empty name + empty message. Best-effort: verbatim/interpolated
 * strings are not fully parsed — a regular `"…"` literal is the common case for error messages.
 */
function parseThrowExpr(expr: string): { name: string; errorMessage: string } {
  const body = expr.replace(/^throw\s+/, '').trim();
  if (!body) return { name: '', errorMessage: '' }; // bare `throw;` rethrow
  const newMatch = /\bnew\s+([A-Za-z_][\w.]*)/.exec(body);
  const bareMatch = /^([A-Za-z_]\w*)/.exec(body);
  const name = newMatch ? (newMatch[1] ?? '') : bareMatch ? (bareMatch[1] ?? '') : '';
  const strMatch = /"((?:[^"\\]|\\.)*)"/.exec(body);
  const errorMessage = strMatch ? (strMatch[1] ?? '') : body;
  return { name, errorMessage };
}

/**
 * Build the `whenSelector` for a catch clause: the caught type (first dotted identifier of the
 * `(Type e)` predicate), with ` when <filter>` appended when an exception filter is present. A
 * catch-all `catch {}` (no predicate) → empty string (whenSelector omitted at the node). The filter
 * text is the inner paren text from `when (...)`, best-effort.
 */
function catchSelector(predicate: string | undefined, filter: string | undefined): string {
  if (!predicate) return ''; // catch-all — no selector
  const typeMatch = /^([A-Za-z_][\w.]*)/.exec(predicate);
  const type = typeMatch ? (typeMatch[1] ?? predicate) : predicate;
  return filter ? `${type} when ${filter}` : type;
}

/**
 * Extract the collection identifier from a `foreach` predicate text (`T x in coll` or `var x in coll`)
 * → `coll`. Returns undefined unless `coll` is a bare identifier (deterministic intra-file target);
 * dotted/call/indexed collections are skipped (capability-honest — they need inference/resolution).
 */
function foreachCollection(predicate: string): string | undefined {
  const m = /\bin\b\s+(.+)$/.exec(predicate);
  if (!m) return undefined;
  const coll = (m[1] ?? '').trim();
  return /^[A-Za-z_]\w*$/.test(coll) ? coll : undefined;
}
