/**
 * JavaExtractor — emits `symbol` nodes (class / interface / enum / record / method / constructor)
 * with qualifiedName / span / signature, `member-of` edges (symbol → enclosing symbol or file), and
 * INTRA-FILE `calls` edges (a call whose callee resolves to a symbol declared in the same file).
 *
 * Engine: the hand-rolled {@link parseJava} tokenizer + structural parser (pure-JS, offline,
 * deterministic) — same posture as the Python extractor and the PL/SQL lexer. Cross-file resolution
 * (imports / calls to imported names / inherits via `extends` / implements) is the JavaResolver's
 * job (Phase 3); this extractor never guesses across files.
 *
 * Capability-honest: declares { imports:true, calls:true, inheritance:true, types:'none' }. The
 * extractor itself emits member-of + intra-file calls (`this.m()`, bare `m()`, `new Cls()` to a
 * same-file class); imports / cross-file calls / inherits / implements are produced by the resolver
 * against the global symbol table. `types:'none'` ⇒ ZERO type edges.
 *
 * Fields are NOT emitted as symbols (parity with the Python extractor's altitude). Spring Boot
 * annotations preceding a declaration are captured as `meta.annotations` (class + method level) so
 * the graph can carry `@RestController` / `@GetMapping` / `@Transactional` etc. as metadata — they
 * are NOT resolved.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import { collectComments } from './lexer.js';
import type { CommentBlock } from './lexer.js';
import type { JavaCallSite, JavaDef, JavaStmt } from './parser.js';
import { parseJava } from './parser.js';

interface LocalSymbol {
  node: Node;
  keys: string[];
  simpleName: string;
  /** enclosing type qualified name ("" at file level) — used for `this.m()` / bare `m()` resolution. */
  parentQualifier: string;
}

const TYPE_KINDS = new Set<JavaDef['kind']>(['class', 'interface', 'enum', 'record']);

export class JavaExtractor implements Extractor {
  name = 'lang:java';
  capabilities: Capabilities = { imports: true, calls: true, inheritance: true, types: 'none' };

  private static readonly SUPPORTED = ['.java'];

  supports(file: FileMeta): boolean {
    return JavaExtractor.SUPPORTED.some((e) => file.path.endsWith(e));
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
    const mod = parseJava(text);
    const symbols: LocalSymbol[] = [];
    const byKey = new Map<string, string>(); // qualifiedName | simpleName → symbol id
    /** method/constructor defs whose body gets a Track-3 statement/condition/CFG walk. */
    const procDefs: { def: JavaDef; procId: string }[] = [];

    // --- pass 1: declarations + member-of, walking the nesting tree ---
    const visit = (defs: JavaDef[], qualifier: string[]): void => {
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
          lang: 'java',
          hash: ctx.hash(this.defText(d, text)),
          signature: this.signature(d),
          meta: {
            parentQualifier: parentQ,
            ...(d.modifiers.length ? { modifiers: d.modifiers } : {}),
            ...(d.annotations.length ? { annotations: d.annotations } : {}),
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
        if (d.kind === 'method' || d.kind === 'constructor') procDefs.push({ def: d, procId: id });
        // only TYPE declarations nest further (methods/constructors have empty body).
        if (TYPE_KINDS.has(d.kind)) visit(d.body, [...qualifier, d.name]);
      }
    };
    visit(mod.defs, []);

    const nodes = symbols.map((s) => s.node);
    const edges: Edge[] = symbols.map((s) =>
      this.memberOf(s.node, this.parentIdFor(s, byKey, fileId)),
    );

    // --- pass 1.5 (schema 1.2): attach a preceding comment block to each class/method/field symbol
    // as an `explanation` node + `describes` edge so the symbol's intent survives into the graph. ---
    this.attachComments(symbols, nodes, edges, ctx, path, collectComments(text));

    // --- pass 2: intra-file calls (this.m / bare m / new SameFileCls()) ---
    // Tracked in a map so the Track-3 body-walk can annotate each calls edge with its guard chain
    // (best-effort, last-wins) without emitting a duplicate.
    const callsEdgeById = new Map<string, Edge>();
    this.collectCalls(mod.calls, symbols, byKey, edges, callsEdgeById);

    // --- pass 3 (Track 3): per-method body-walk — emit condition/statement/executes/guarded-by and
    // annotate calls edges with the guard chain + record call sites on the proc node meta.calls. ---
    for (const { def, procId } of procDefs) {
      if (def.stmts.length === 0) continue;
      const callSites: { callee: string; line: number }[] = [];
      const walker = new BodyWalker(
        path,
        ctx,
        symbols,
        byKey,
        callSites,
        nodes,
        edges,
        callsEdgeById,
      );
      walker.walkBody(def.stmts, procId, [], undefined, false, false);
      if (callSites.length > 0) {
        const proc = nodes.find((n) => n.id === procId);
        if (proc) proc.meta = { ...(proc.meta ?? {}), calls: callSites };
      }
    }

    return { nodes, edges };
  }

  private signature(d: JavaDef): string {
    switch (d.kind) {
      case 'class':
        return `class ${d.name}`;
      case 'interface':
        return `interface ${d.name}`;
      case 'enum':
        return `enum ${d.name}`;
      case 'record':
        return `record ${d.name}(${d.params.join(', ')})`;
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

  /**
   * 1.2: for each symbol, if a comment block ends on the line immediately above the symbol's
   * startLine, emit an `explanation` node (carrying the comment text) + a `describes` edge
   * (explanation → symbol). Deduped by the explanation id (comment start line). A symbol's
   * startLine includes leading annotations/modifiers, so a Javadoc above `@Override` attaches to
   * the method — the intent follows the declaration, not the annotation.
   */
  private attachComments(
    symbols: LocalSymbol[],
    nodes: Node[],
    edges: Edge[],
    ctx: ExtractCtx,
    path: string,
    comments: CommentBlock[],
  ): void {
    const seen = new Set<string>();
    for (const s of symbols) {
      const startLine = s.node.span?.start;
      if (!startLine) continue;
      const block = comments.find((c) => c.end === startLine - 1);
      if (!block || !block.text) continue;
      const id = ctx.idFor('explanation', { path, startLine: block.start });
      if (seen.has(id)) continue; // one explanation per comment block (dedupe by line)
      seen.add(id);
      nodes.push({
        id,
        kind: 'explanation',
        commentRef: { file: path, span: { start: block.start, end: block.end } },
        file: path,
        span: { start: block.start, end: block.end },
        lang: 'java',
        hash: ctx.hash(`${path}:${block.start}:${block.text}`),
        meta: { text: block.text, javadoc: block.javadoc },
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

  /** Emit `calls` edges for call sites whose callee resolves to a same-file symbol. */
  private collectCalls(
    calls: JavaCallSite[],
    symbols: LocalSymbol[],
    byKey: Map<string, string>,
    edges: Edge[],
    callsEdgeById: Map<string, Edge>,
  ): void {
    for (const c of calls) {
      let dstId: string | undefined;
      if (c.head === 'super') {
        continue; // parent-class member — resolver's job
      }
      if (c.head === 'this') {
        // `this.m()` → a method of the enclosing class by simple name.
        dstId = methodInEnclosingClass(c.line, c.name, symbols);
      } else if (c.tail.length === 0) {
        // bare `m()` or `new Cls()` → same-file symbol by simple / qualified name.
        dstId = byKey.get(c.name) ?? byKey.get(c.head);
      } else {
        // `obj.m()` / `Type.m()` — needs inference / cross-file; leave to the resolver.
        continue;
      }
      if (!dstId) continue;
      const caller = enclosingSymbolId(c.line, symbols);
      if (!caller || caller === dstId) continue; // skip self-recursion
      const calleeText = c.tail.length ? `${c.head}.${c.tail.join('.')}` : c.head;
      const id = edgeId(caller, dstId, 'calls');
      if (callsEdgeById.has(id)) continue; // dedupe per (caller,callee)
      const e: Edge = {
        id,
        src: caller,
        dst: dstId,
        rel: 'calls',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name, snippet: calleeText },
      };
      edges.push(e);
      callsEdgeById.set(id, e);
    }
  }

  /** Best-effort source text for a def — used only for hashing (change detection), needs no precision. */
  private defText(d: JavaDef, src: string): string {
    const lines = src.split('\n');
    return lines.slice(d.startLine - 1, d.endLine).join('\n');
  }
}

/**
 * 1.2: derive a catch handler's `whenSelector` from the raw `(Type e | Type2 e)` predicate text.
 * Strips `final`, splits on `|`, and drops the trailing variable name of the last segment (the only
 * place a catch var may appear). `catch (Exception e)` → "Exception"; `catch (A | B e)` → "A|B";
 * `catch (Map.Entry e)` → "Map.Entry". Falls back to the raw text (or "Throwable") if unparseable.
 */
function catchSelector(predicate: string | undefined): string {
  if (!predicate) return 'Throwable';
  const stripped = predicate.replace(/\bfinal\b/g, '').trim();
  const parts = stripped
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return stripped || 'Throwable';
  const last = parts.pop()!;
  // the variable name is the trailing identifier of the last segment; drop it to leave the type.
  const m = last.match(/^([\s\S]*?)([A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (m && m[1]!.trim().length > 0) parts.push(m[1]!.trim());
  else parts.push(last);
  return parts.join('|').replace(/\s+/g, ' ').trim();
}

/**
 * 1.2: extract a `raise` node's errorMessage from a `throw <expr>` statement's source text. If the
 * expression contains a string literal, use its (unescaped) contents; otherwise use the raw
 * expression after the `throw` keyword (capability-honest — no type resolution).
 */
function throwErrorMessage(text: string | undefined): string {
  if (!text) return '';
  const expr = text.replace(/^\s*throw\s+/, '').trim();
  const m = expr.match(/"((?:[^"\\]|\\.)*)"/);
  return m ? m[1]! : expr;
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

/** Innermost TYPE symbol (class / interface / enum / record) whose span contains `line`. */
function enclosingTypeId(line: number, symbols: LocalSymbol[]): LocalSymbol | undefined {
  let best: LocalSymbol | undefined;
  for (const s of symbols) {
    if (!TYPE_KINDS.has(s.node.type as JavaDef['kind'])) continue;
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
 * Resolve `this.m()` to a method of the enclosing class: find the narrowest CLASS whose span
 * contains the call line, then a method of that class with simple name `name`. Avoids cross-class
 * simple-name collisions that a global byKey lookup would hit.
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
// BodyWalker (Track 3) — walks one method's statement tree with a guard stack and emits the
// condition/statement/executes/guarded-by edges, mirroring PlSqlExtractor. The FULL guard stack is
// tracked inline and cfgPath/guard/branch/inLoop/inException are stamped DIRECTLY on the executes/
// calls edges at emission time (no separate CFG pass). Calls edges are deduped via callsEdgeById
// and annotated with the guard chain (best-effort, last-wins); call sites are recorded on the proc
// node's meta.calls for the resolver.
// ---------------------------------------------------------------------------------------------

class BodyWalker {
  private readonly condSeen = new Set<string>();
  /** 1.2: dedupe sets keyed by the deterministic node id (file,line). */
  private readonly caseBranchSeen = new Set<string>();
  private readonly excSeen = new Set<string>();
  private readonly raiseSeen = new Set<string>();
  private readonly assignSeen = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly ctx: ExtractCtx,
    private readonly symbols: LocalSymbol[],
    private readonly byKey: Map<string, string>,
    private readonly callSites: { callee: string; line: number }[],
    private readonly nodes: Node[],
    private readonly edges: Edge[],
    private readonly callsEdgeById: Map<string, Edge>,
  ) {}

  walkBody(
    stmts: JavaStmt[],
    procId: string,
    guardStack: string[],
    innerBranch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    for (const s of stmts) this.walkStmt(s, procId, guardStack, innerBranch, inLoop, inException);
  }

  private walkStmt(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    innerBranch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    switch (s.kind) {
      case 'call':
      case 'return':
        this.addAction(s, procId, guardStack, innerBranch, inLoop, inException);
        break;
      case 'throw':
        // keep the existing statement node (executes/guarded-by/calls) + add a 1.2 `raise` node.
        this.addAction(s, procId, guardStack, innerBranch, inLoop, inException);
        this.addRaise(s, procId, guardStack, inLoop, inException);
        break;
      case 'assign':
        this.addAssign(s, procId, guardStack, innerBranch, inLoop, inException);
        break;
      case 'if':
        this.walkIf(s, procId, guardStack, inLoop, inException);
        break;
      case 'for':
      case 'while':
      case 'do':
        this.walkLoop(s, procId, guardStack, inLoop, inException);
        break;
      case 'switch':
        this.walkSwitch(s, procId, guardStack, inLoop, inException);
        break;
      case 'try':
        this.walkTry(s, procId, guardStack, inLoop, inException);
        break;
      default:
        break;
    }
  }

  /** Emit one condition node keyed by (file,line), deduped — branch is the FIRST branch's label. */
  private condition(expr: string | undefined, line: number, branch: string): string {
    const id = this.ctx.idFor('condition', { file: this.path, line });
    if (!this.condSeen.has(id)) {
      this.condSeen.add(id);
      this.nodes.push({
        id,
        kind: 'condition',
        branch,
        ...(expr ? { expr } : {}),
        file: this.path,
        span: { start: line, end: line },
        lang: 'java',
        hash: this.ctx.hash(`${this.path}:${line}:${expr ?? ''}`),
      });
    }
    return id;
  }

  /** 1.2: emit a `case-branch` node (deduped by file+line) — whenSelector = the case value, omitted
   *  for `default`. Used as the guard for the arm's body, mirroring the if-walk guard logic. */
  private caseBranch(predicate: string | undefined, line: number): string {
    const id = this.ctx.idFor('case-branch', { file: this.path, line });
    if (!this.caseBranchSeen.has(id)) {
      this.caseBranchSeen.add(id);
      this.nodes.push({
        id,
        kind: 'case-branch',
        branch: 'CASE',
        ...(predicate ? { expr: predicate, whenSelector: predicate } : {}),
        file: this.path,
        span: { start: line, end: line },
        lang: 'java',
        hash: this.ctx.hash(`${this.path}:case:${line}:${predicate ?? ''}`),
      });
    }
    return id;
  }

  /** 1.2: emit an `exception-handler` node (deduped by file+line) — whenSelector = caught type(s). */
  private exceptionHandler(predicate: string | undefined, line: number): string {
    const id = this.ctx.idFor('exception-handler', { file: this.path, line });
    if (!this.excSeen.has(id)) {
      this.excSeen.add(id);
      const whenSelector = catchSelector(predicate);
      this.nodes.push({
        id,
        kind: 'exception-handler',
        whenSelector,
        file: this.path,
        span: { start: line, end: line },
        lang: 'java',
        hash: this.ctx.hash(`${this.path}:exc:${line}:${whenSelector}`),
      });
    }
    return id;
  }

  /** 1.2: a `throw` emits a `raise` node + a `raises` edge (proc → raise). errorMessage = the first
   *  string literal in the thrown expression if identifiable, else the raw expression text. A raise
   *  inside a guarded branch is also guarded-by; inLoop/inException stamped on meta. */
  private addRaise(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    const id = this.ctx.idFor('raise', { file: this.path, line: s.startLine });
    if (this.raiseSeen.has(id)) return;
    this.raiseSeen.add(id);
    const errorMessage = throwErrorMessage(s.text);
    this.nodes.push({
      id,
      kind: 'raise',
      file: this.path,
      span: { start: s.startLine, end: s.endLine },
      lang: 'java',
      hash: this.ctx.hash(`${this.path}:${s.startLine}:raise`),
      ...(errorMessage ? { errorMessage } : {}),
      meta: { inLoop, inException },
    });
    this.edges.push(this.edge(procId, id, 'raises', s.text ?? 'throw'));
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    if (guard) this.edges.push(this.edge(id, guard, 'guarded-by', 'THROW'));
  }

  /** 1.2: an `lhs = rhs` (no embedded call) emits an `assignment` node + executes + guarded-by,
   *  mirroring PlSqlExtractor.addAssign. Call-bearing assignments stay `call` statements (the call
   *  is the interesting part) so the graph stays lean and the existing Track-3 edges are preserved. */
  private addAssign(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    innerBranch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    const id = this.ctx.idFor('assignment', { file: this.path, line: s.startLine });
    if (this.assignSeen.has(id)) return;
    this.assignSeen.add(id);
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    this.nodes.push({
      id,
      kind: 'assignment',
      file: this.path,
      span: { start: s.startLine, end: s.endLine },
      lang: 'java',
      hash: this.ctx.hash(`${this.path}:${s.startLine}:assign`),
      ...(s.assignTarget ? { assignTarget: s.assignTarget } : {}),
      ...(s.text ? { expr: s.text } : {}),
      meta: { inLoop, inException, ...(guardStack.length > 0 ? { branch: 'GUARDED' } : {}) },
    });
    this.edges.push({
      id: edgeId(procId, id, 'executes'),
      src: procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'java-extractor', snippet: s.text ?? 'assign' },
      cfgPath: guardStack.slice(),
      ...(guard !== undefined ? { guard } : {}),
      ...(guardStack.length > 0 ? { branch: innerBranch } : {}),
      inLoop,
      inException,
    });
    if (guard) this.edges.push(this.edge(id, guard, 'guarded-by', 'assign'));
  }

  /** Edge factory (schema 1.2 rels): static + EXTRACTED + confidence 1, mirroring PlSqlExtractor. */
  private edge(src: string, dst: string, rel: Edge['rel'], snippet: string): Edge {
    return {
      id: edgeId(src, dst, rel),
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'java-extractor', snippet },
    };
  }

  /** IF: one condition node keyed by the IF line; each branch carries its own polarity on the edge. */
  private walkIf(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    const branches = s.branches ?? [];
    const first = branches[0];
    const condId = this.condition(first?.predicate, s.startLine, 'THEN');
    for (const b of branches) {
      const polarity = b.role === 'then' ? 'THEN' : b.role === 'elseif' ? 'ELSIF' : 'ELSE';
      this.walkBody(b.body, procId, [...guardStack, condId], polarity, inLoop, inException);
    }
  }

  /** FOR/WHILE/DO: one LOOP condition node; the body is walked with inLoop=true. */
  private walkLoop(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    const condId = this.condition(s.predicate, s.predicateLine ?? s.startLine, 'LOOP');
    this.walkBody(s.body ?? [], procId, [...guardStack, condId], 'LOOP', true, inException);
  }

  /**
   * SWITCH (1.2): each `case X:` / `default:` arm emits a `case-branch` node (whenSelector = X,
   * omitted for default) and its body is walked under guard = that case-branch id, consistent with
   * the if-walk guard logic. Replaces the 1.1 per-case `condition` node with the fidelity kind.
   */
  private walkSwitch(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    for (const c of s.cases ?? []) {
      const cbId = this.caseBranch(c.predicate, c.line);
      this.walkBody(c.body ?? [], procId, [...guardStack, cbId], 'CASE', inLoop, inException);
    }
  }

  /**
   * TRY/CATCH/FINALLY (1.2): the try body is walked with inException=true; each `catch (Type e)`
   * clause emits an `exception-handler` node (whenSelector = the caught type, `A|B` for multi-catch)
   * + `handles` edges to every statement/assignment/raise node emitted in the TRY body (the
   * operations this handler guards, including any explicit raise sources). Catch/finally bodies are
   * walked with inException=true (per Track-3 spec).
   */
  private walkTry(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    const before = this.nodes.length;
    this.walkBody(s.tryBody ?? [], procId, guardStack, undefined, inLoop, true);
    const tryNodes = this.nodes
      .slice(before)
      .filter((n) => n.kind === 'statement' || n.kind === 'assignment' || n.kind === 'raise');
    for (const c of s.catches ?? []) {
      const excId = this.exceptionHandler(c.predicate, c.line);
      for (const target of tryNodes) {
        this.edges.push(this.edge(excId, target.id, 'handles', c.predicate ?? 'catch'));
      }
      this.walkBody(c.body ?? [], procId, guardStack, undefined, inLoop, true);
    }
    if (s.finallyBody) {
      this.walkBody(s.finallyBody, procId, guardStack, undefined, inLoop, true);
    }
  }

  /** Emit a statement node + executes edge (+ guarded-by) for a call/return/throw action. */
  private addAction(
    s: JavaStmt,
    procId: string,
    guardStack: string[],
    innerBranch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    const id = this.ctx.idFor('statement', { file: this.path, line: s.startLine });
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    const head = s.callChain ? s.callChain[s.callChain.length - 1]! : s.kind;
    const node: Node = {
      id,
      kind: 'statement',
      type: s.kind,
      ...(s.text ? { expr: s.text } : {}),
      file: this.path,
      span: { start: s.startLine, end: s.endLine },
      lang: 'java',
      hash: this.ctx.hash(`${this.path}:${s.startLine}:${s.kind}`),
      meta: {
        head,
        inLoop,
        inException,
        ...(guardStack.length > 0 ? { branch: 'GUARDED' } : {}),
      },
    };
    this.nodes.push(node);

    // executes: procedure → statement, carrying the guard chain.
    this.edges.push({
      id: edgeId(procId, id, 'executes'),
      src: procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'java-extractor', snippet: s.text ?? head },
      cfgPath: guardStack.slice(),
      ...(guard !== undefined ? { guard } : {}),
      ...(guardStack.length > 0 ? { branch: innerBranch } : {}),
      inLoop,
      inException,
    });

    // calls edge + recorded call site for any embedded call (resolves intra-file; deduped).
    if (s.callChain) {
      const callee = s.callChain[s.callChain.length - 1]!;
      this.callSites.push({ callee, line: s.startLine });
      const calleeId = this.resolveCallee(s.callChain, s.startLine);
      if (calleeId && calleeId !== procId) {
        this.annotateCallsEdge(
          procId,
          calleeId,
          callee,
          guardStack,
          innerBranch,
          inLoop,
          inException,
        );
      }
    }

    // guarded-by: statement → innermost enclosing condition.
    if (guard !== undefined) {
      this.edges.push({
        id: edgeId(id, guard, 'guarded-by'),
        src: id,
        dst: guard,
        rel: 'guarded-by',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'java-extractor', snippet: s.kind.toUpperCase() },
      });
    }
  }

  /** Emit or annotate a deduped `calls` edge with the guard chain (best-effort, last-wins). */
  private annotateCallsEdge(
    procId: string,
    calleeId: string,
    calleeText: string,
    guardStack: string[],
    innerBranch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    const id = edgeId(procId, calleeId, 'calls');
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    const existing = this.callsEdgeById.get(id);
    if (existing) {
      // last-wins: stamp the guard chain of THIS call site onto the shared edge.
      existing.cfgPath = guardStack.slice();
      if (guard !== undefined) existing.guard = guard;
      else existing.guard = undefined;
      if (guardStack.length > 0) existing.branch = innerBranch;
      else existing.branch = undefined;
      existing.inLoop = inLoop;
      existing.inException = inException;
      return;
    }
    const e: Edge = {
      id,
      src: procId,
      dst: calleeId,
      rel: 'calls',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'java-extractor', snippet: calleeText },
      cfgPath: guardStack.slice(),
      ...(guard !== undefined ? { guard } : {}),
      ...(guardStack.length > 0 ? { branch: innerBranch } : {}),
      inLoop,
      inException,
    };
    this.edges.push(e);
    this.callsEdgeById.set(id, e);
  }

  /** Resolve a call chain to an intra-file symbol id (mirrors collectCalls resolution). */
  private resolveCallee(chain: string[], line: number): string | undefined {
    const head = chain[0]!;
    const name = chain[chain.length - 1]!;
    if (head === 'super') return undefined; // parent-class member — resolver's job
    if (head === 'this') return methodInEnclosingClass(line, name, this.symbols);
    if (chain.length === 1) return this.byKey.get(name) ?? this.byKey.get(head);
    return undefined; // dotted `obj.m()` / `Type.m()` — needs inference / cross-file
  }
}
