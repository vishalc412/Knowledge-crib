/**
 * GoExtractor — emits `symbol` nodes (func / method / struct / interface / typedef / typealias,
 * incl. interface methods as nested method symbols + receiver methods) with qualifiedName / span /
 * signature, `member-of` edges (symbol → enclosing symbol or file), and INTRA-FILE `calls` edges
 * (a bare call whose callee resolves to a same-file top-level func/type).
 *
 * Engine: the hand-rolled {@link parseGo} tokenizer + structural parser (pure-JS, offline,
 * deterministic) — same posture as the Java/Python extractors. Cross-file resolution (imports /
 * cross-file calls / inherits via embedding / interface-extends-interface) is the GoResolver's
 * job (Phase 3); this extractor never guesses across files.
 *
 * Capability-honest: declares { imports:true, calls:true, inheritance:true, types:'none' }. The
 * extractor itself emits ONLY `member-of` + intra-file bare `calls` (conservative: dotted /
 * composite-literal / `obj.method()` calls are dropped — the resolver handles cross-file
 * `pkg.Func()` against imported bindings; `obj.method()` is inference's job). `types:'none'` ⇒
 * ZERO type edges.
 *
 * Honest Go limitations:
 *   - NO nested type declarations exist in Go (all types are package-level); methods are declared
 *     at top level with a receiver, so a receiver method becomes a member-of edge to its receiver
 *     type symbol if that type is declared in the same file, else member-of → file.
 *   - Implicit interface satisfaction is NOT statically detectable → never captured as `implements`.
 *     Only EXPLICIT embedding (struct embeds struct/interface; interface embeds interface) is
 *     captured into `bases` (→ `inherits` in the resolver).
 *   - Struct fields are NOT emitted as symbols (parity with Java/Python altitude). Struct tags
 *     (backtick raw strings) lex cleanly but are not captured as metadata.
 *   - Methods on types defined in OTHER files: extracted as top-level symbols with qualifiedName
 *     `TypeName.MethodName` and member-of → file (the receiver type node lives in another file).
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { clampExpr } from '../types.js';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import { collectComments } from './lexer.js';
import type {
  GoBodyStmt,
  GoCallSite,
  GoCallee,
  GoDef,
  GoDeferStmt,
  GoForStmt,
  GoIfStmt,
  GoSelectStmt,
  GoSwitchStmt,
} from './parser.js';
import { parseGo } from './parser.js';

/** Spread an `expr` field plus its `exprTruncated` honesty flag from a raw expression string. */
function exprFields(raw: string | undefined): { expr?: string; exprTruncated?: true } {
  if (!raw) return {};
  const { expr, truncated } = clampExpr(raw);
  return truncated ? { expr, exprTruncated: true } : { expr };
}

interface LocalSymbol {
  node: Node;
  simpleName: string;
  /** enclosing type qualified name ("" at file level) — used for member-of + same-type resolution. */
  parentQualifier: string;
}

/** Per-procedure accumulator for the body-walk: call sites recorded on the proc node meta + the
 *  proc node so meta.calls can be stamped after the walk. */
interface ProcCtx {
  procId: string;
  procNode: Node;
  callSites: { callee: string; line: number }[];
}

/** The guard-chain fields stamped on executes/calls edges at emission time (Track 3 single pass). */
interface GuardFields {
  cfgPath: string[];
  guard?: string;
  branch?: string;
  inLoop: boolean;
  inException: boolean;
}

export class GoExtractor implements Extractor {
  name = 'lang:go';
  capabilities: Capabilities = { imports: true, calls: true, inheritance: true, types: 'none' };

  private static readonly SUPPORTED = ['.go'];

  supports(file: FileMeta): boolean {
    return GoExtractor.SUPPORTED.some((e) => file.path.endsWith(e));
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
    const mod = parseGo(text);
    const symbols: LocalSymbol[] = [];
    const byKey = new Map<string, string>(); // qualifiedName | simpleName → symbol id
    /** func/method defs that have a body, paired with their symbol id (for the body-walk). */
    const bodies: { def: GoDef; symId: string }[] = [];

    // --- pass 1: declarations + member-of, walking the nesting tree ---
    // Only interfaces nest further (their body holds method specs). Struct/func/method/typedef/
    // typealias bodies carry no nested decls. Receiver methods are top-level defs whose
    // parentQualifier is the receiver type name (resolved via byKey below).
    const visitTop = (defs: GoDef[]): void => {
      for (const d of defs) {
        const parentQ = d.receiverType ? d.receiverType : '';
        const qualifiedName = this.qualifiedName(d, parentQ);
        const id = ctx.idFor('symbol', { path, qualifiedName, startLine: d.startLine });
        const node: Node = {
          id,
          kind: 'symbol',
          type: d.kind,
          name: d.name,
          qualifiedName,
          file: path,
          span: { start: d.startLine, end: d.endLine },
          lang: 'go',
          hash: ctx.hash(this.defText(d, text)),
          signature: this.signature(d),
          meta: {
            parentQualifier: parentQ,
            ...(d.modifiers.length ? { modifiers: d.modifiers } : {}),
            ...(d.bases.length ? { bases: d.bases } : {}),
            ...(d.implements.length ? { implements: d.implements } : {}),
            ...(d.params.length ? { params: d.params } : {}),
            ...(d.typeParams.length ? { typeParams: d.typeParams } : {}),
            ...(d.receiverType ? { receiverType: d.receiverType } : {}),
            ...(d.receiverTypeParams.length ? { receiverTypeParams: d.receiverTypeParams } : {}),
          },
        };
        symbols.push({
          node,
          simpleName: d.name,
          parentQualifier: parentQ,
        });
        for (const k of [qualifiedName, d.name]) if (!byKey.has(k)) byKey.set(k, id);
        if (d.kind === 'interface') visitIface(d.body, d.name);
        if ((d.kind === 'func' || d.kind === 'method') && d.stmts.length > 0)
          bodies.push({ def: d, symId: id });
      }
    };
    // interface methods are nested → visit with qualifier = [ifaceName]
    const visitIface = (defs: GoDef[], ifaceName: string): void => {
      for (const d of defs) {
        const parentQ = ifaceName;
        const qualifiedName = `${parentQ}.${d.name}`;
        const id = ctx.idFor('symbol', { path, qualifiedName, startLine: d.startLine });
        const node: Node = {
          id,
          kind: 'symbol',
          type: d.kind,
          name: d.name,
          qualifiedName,
          file: path,
          span: { start: d.startLine, end: d.endLine },
          lang: 'go',
          hash: ctx.hash(this.defText(d, text)),
          signature: this.signature(d),
          meta: {
            parentQualifier: parentQ,
            ...(d.params.length ? { params: d.params } : {}),
            ...(d.returns ? { returns: d.returns } : {}),
          },
        };
        symbols.push({ node, simpleName: d.name, parentQualifier: parentQ });
        for (const k of [qualifiedName, d.name]) if (!byKey.has(k)) byKey.set(k, id);
      }
    };
    visitTop(mod.defs);

    const nodes = symbols.map((s) => s.node);
    const edges: Edge[] = symbols.map((s) =>
      this.memberOf(s.node, this.parentIdFor(s, byKey, fileId)),
    );

    // --- pass 1b (schema 1.2): attach a preceding comment block (lines immediately above a func/
    //      type) as an `explanation` node + `describes` edge so the symbol's intent survives. ---
    const comments = collectComments(text);
    const explSeen = new Set<string>();
    const attachComment = (symId: string, startLine: number): void => {
      const block = comments.find((c) => c.end === startLine - 1);
      if (!block || !block.text) return;
      const id = ctx.idFor('explanation', { path, startLine: block.start });
      if (explSeen.has(id)) return;
      explSeen.add(id);
      nodes.push({
        id,
        kind: 'explanation',
        commentRef: { file: path, span: { start: block.start, end: block.end } },
        file: path,
        span: { start: block.start, end: block.end },
        lang: 'go',
        hash: ctx.hash(`${path}:${block.start}:${block.text}`),
        meta: { text: block.text },
      });
      edges.push({
        id: edgeId(id, symId, 'describes'),
        src: id,
        dst: symId,
        rel: 'describes',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name, snippet: 'COMMENT' },
      });
    };
    for (const s of symbols) {
      const start = s.node.span?.start;
      if (start !== undefined) attachComment(s.node.id, start);
    }

    // --- pass 2: intra-file calls (bare Func() → same-file top-level func/type) ---
    this.collectCalls(mod.calls, symbols, byKey, edges);

    // --- pass 3 (Track 3): body-walk each func/method, emitting condition/statement nodes +
    // executes/guarded-by edges + annotating calls edges with the guard chain. Strictly additive. ---
    const callsEdges = new Map<string, Edge>();
    for (const e of edges) if (e.rel === 'calls') callsEdges.set(e.id, e);
    const walker = new BodyWalker(path, ctx, byKey, nodes, edges, callsEdges);
    for (const { def, symId } of bodies) walker.walkProc(def, symId);

    return { nodes, edges };
  }

  /**
   * Qualified name: receiver method → `TypeName.MethodName`; interface method → `Iface.MethodName`;
   * top-level func/type → its own name. The receiver type's `[T]` params are NOT folded in (kept
   * simple, mirroring Java's flat qualified names; `receiverTypeParams` is in meta).
   */
  private qualifiedName(d: GoDef, parentQ: string): string {
    if (parentQ) return `${parentQ}.${d.name}`;
    return d.name;
  }

  private signature(d: GoDef): string {
    switch (d.kind) {
      case 'func':
        return `func ${d.name}(${d.params.join(', ')})`;
      case 'method':
        if (d.interfaceMethod) {
          return d.returns
            ? `${d.name}(${d.params.join(', ')}) ${d.returns}`
            : `${d.name}(${d.params.join(', ')})`;
        }
        return d.receiverName
          ? `func (${d.receiverName} ${d.receiverType}) ${d.name}(${d.params.join(', ')})`
          : `func (${d.receiverType}) ${d.name}(${d.params.join(', ')})`;
      case 'struct':
        return `type ${d.name} struct`;
      case 'interface':
        return `interface ${d.name}`;
      case 'typedef':
        return d.underlying ? `type ${d.name} ${d.underlying}` : `type ${d.name}`;
      case 'typealias':
        return d.underlying ? `type ${d.name} = ${d.underlying}` : `type ${d.name} =`;
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
   * Emit `calls` edges for BARE call sites (`Func()` / `Type()`) whose callee resolves to a
   * same-file top-level func/type. Dotted calls (`obj.m()`, `pkg.F()`), composite literals
   * (`Type{}`, `&Type{}`), and `new(Type)` are dropped — dotted cross-file calls are the resolver's
   * job; `obj.m()` receiver resolution is inference's job. This mirrors the Java extractor's
   * conservative intra-file stance.
   */
  private collectCalls(
    calls: GoCallSite[],
    symbols: LocalSymbol[],
    byKey: Map<string, string>,
    edges: Edge[],
  ): void {
    const seen = new Set<string>();
    for (const c of calls) {
      if (c.tail.length > 0) continue; // dotted — resolver / inference territory
      const dstId = byKey.get(c.name) ?? byKey.get(c.head);
      if (!dstId) continue;
      const caller = enclosingSymbolId(c.line, symbols);
      if (!caller || caller === dstId) continue; // skip self-recursion
      const e = {
        id: edgeId(caller, dstId, 'calls'),
        src: caller,
        dst: dstId,
        rel: 'calls' as const,
        method: 'static' as const,
        provenance: 'EXTRACTED' as const,
        confidence: 1,
        evidence: { by: this.name, snippet: c.head },
      };
      if (!seen.has(e.id)) {
        seen.add(e.id);
        edges.push(e);
      }
    }
  }

  /** Best-effort source text for a def — used only for hashing (change detection), needs no precision. */
  private defText(d: GoDef, src: string): string {
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

// ---------------------------------------------------------------------------------------------
// Schema-1.2 raise helpers — Go's error model is value-returning, not throwing. `panic()` is the
// closest throw analog; `return errors.New(...)` / `return fmt.Errorf(...)` construct a new error
// value at a return site. These helpers extract a best-effort errorMessage (the first string
// literal) and classify return-of-new-error sites (start-anchored, so `wrap(errors.New(...))` is
// NOT flagged — only a direct return of the new error).
// ---------------------------------------------------------------------------------------------

/** Extract the first interpreted string literal's content from `text` (best-effort, escapes kept). */
function extractStringLiteral(text: string): string | undefined {
  const m = text.match(/"((?:[^"\\]|\\.)*)"/);
  return m ? (m[1] ?? '') : undefined;
}

/** A panic's errorMessage: the first string literal if present, else the raw expr inside panic(…). */
function extractPanicMessage(text: string): string {
  const lit = extractStringLiteral(text);
  if (lit !== undefined) return lit;
  return text
    .replace(/^panic\s*\(/, '')
    .replace(/\s*\)\s*$/, '')
    .trim();
}

/** True iff the return expression is a direct `errors.New(…)` / `fmt.Errorf(…)` (start-anchored). */
function isReturnOfNewError(expr: string | undefined): boolean {
  if (!expr) return false;
  return /^\s*errors\.New\s*\(/.test(expr) || /^\s*fmt\.Errorf\s*\(/.test(expr);
}

/** The error-construction name for a return-of-new-error expr (`errors.New` / `fmt.Errorf`). */
function newErrorName(expr: string): string {
  if (/^\s*errors\.New\s*\(/.test(expr)) return 'errors.New';
  if (/^\s*fmt\.Errorf\s*\(/.test(expr)) return 'fmt.Errorf';
  return 'error';
}

// ---------------------------------------------------------------------------------------------
// BodyWalker (Track 3) — walks a func/method body with a guard stack and emits condition/statement
// nodes + executes/guarded-by edges + annotates intra-file calls edges. Mirrors PlSqlExtractor's
// walkBlock/walkIf/walkLoop/condition, but tracks the FULL guard stack inline and stamps
// cfgPath/guard/branch/inLoop/inException directly on the edges at emission time (single pass —
// no separate CFG pass, unlike PL/SQL's two-phase design).
// ---------------------------------------------------------------------------------------------
class BodyWalker {
  /** condition ids created, to dedupe by (file,line) — one condition per IF (all branches share it). */
  private readonly condSeen = new Set<string>();
  /** 1.2: case-branch ids created, to dedupe by (file,line). */
  private readonly caseBranchSeen = new Set<string>();
  /** 1.2: exception-handler ids created, to dedupe by (file,line). */
  private readonly excSeen = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly ctx: ExtractCtx,
    private readonly byKey: Map<string, string>,
    private readonly nodes: Node[],
    private readonly edges: Edge[],
    private readonly callsEdges: Map<string, Edge>,
  ) {}

  walkProc(def: GoDef, procId: string): void {
    const procNode = this.nodes.find((n) => n.id === procId);
    if (!procNode) return;
    const proc: ProcCtx = { procId, procNode, callSites: [] };
    this.walkBody(def.stmts, proc, [], undefined, false, false);
    // stamp call sites on the proc node meta so extract_rules can recover the call-site line.
    if (proc.callSites.length > 0) {
      procNode.meta = { ...(procNode.meta ?? {}), calls: proc.callSites };
    }
  }

  private walkBody(
    stmts: GoBodyStmt[],
    proc: ProcCtx,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    for (const s of stmts) this.walkStmt(s, proc, guardStack, branch, inLoop, inException);
  }

  private walkStmt(
    s: GoBodyStmt,
    proc: ProcCtx,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    switch (s.kind) {
      case 'if':
        this.walkIf(s, proc, guardStack, inLoop, inException);
        break;
      case 'for':
        this.walkFor(s, proc, guardStack, inLoop, inException);
        break;
      case 'switch':
        this.walkSwitch(s, proc, guardStack, inLoop, inException);
        break;
      case 'select':
        this.walkSelect(s, proc, guardStack, inLoop, inException);
        break;
      case 'return':
        this.addStatement(
          s.line,
          'return',
          s.expr ?? 'return',
          s.text,
          proc,
          guardStack,
          branch,
          inLoop,
          inException,
        );
        if (s.callee) this.addCall(s.callee, proc, guardStack, branch, inLoop, inException);
        // 1.2: a direct `return errors.New(…)` / `return fmt.Errorf(…)` constructs a new error at
        // the return site — model it ADDITIONALLY as a raise (Go's error-as-value analog). The
        // return statement is still emitted (the control flow is real); the raise captures the
        // error-creation. Start-anchored so a wrapped return (`wrap(errors.New(...))`) is NOT
        // flagged — only a direct return of a newly constructed error.
        if (isReturnOfNewError(s.expr)) {
          this.addRaise(
            s.line,
            newErrorName(s.expr ?? ''),
            extractStringLiteral(s.expr ?? '') ?? '',
            proc,
            guardStack,
            branch,
            inLoop,
            inException,
          );
        }
        break;
      case 'call':
        this.addStatement(
          s.line,
          'call',
          s.text,
          s.callee.name,
          proc,
          guardStack,
          branch,
          inLoop,
          inException,
        );
        this.addCall(s.callee, proc, guardStack, branch, inLoop, inException);
        break;
      case 'throw':
        // 1.2: `panic(…)` is Go's closest throw analog → emit a `raise` node + `raises` edge (replaces
        // the pre-1.2 `statement` node with type:'throw'). errorMessage = the first string literal in
        // the panic arg, else the raw expr. Guard chain stamped on the raises edge + guarded-by.
        this.addRaise(
          s.line,
          'panic',
          extractPanicMessage(s.text),
          proc,
          guardStack,
          branch,
          inLoop,
          inException,
        );
        break;
      case 'assign':
        // 1.2: an assignment emits an `assignment` node (kind:'assignment', assignTarget=LHS) + an
        // executes edge (proc → assignment) carrying the guard chain, + guarded-by when guarded.
        // Replaces the pre-1.2 `statement` node with type:'assign' (PL/SQL parity on the LHS target).
        this.addAssignment(
          s.line,
          s.target ?? '',
          s.text,
          proc,
          guardStack,
          branch,
          inLoop,
          inException,
          s.callee,
        );
        break;
      case 'expr':
        // a plain expression is only an action line when it carries a call; else skip (lean graph).
        if (s.callee) {
          this.addStatement(
            s.line,
            'call',
            s.text,
            s.callee.name,
            proc,
            guardStack,
            branch,
            inLoop,
            inException,
          );
          this.addCall(s.callee, proc, guardStack, branch, inLoop, inException);
        }
        break;
      case 'defer':
        // 1.2: `defer func(){…}()` with a recover() → exception-handler + handles; otherwise walk
        // the deferred body as plain actions. A defer of a bare call is parsed as a `call` stmt and
        // never reaches here.
        this.walkDefer(s, proc, guardStack, branch, inLoop, inException);
        break;
      case 'block':
        this.walkBody(s.body, proc, guardStack, branch, inLoop, inException);
        break;
    }
  }

  /**
   * `if/else if/else` contributes ONE condition node (keyed by the if line). All branches share the
   * same condId; the per-branch polarity (THEN/ELSIF/ELSE) is carried on the EDGE's `branch` field.
   */
  private walkIf(
    s: GoIfStmt,
    proc: ProcCtx,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    // Degraded `if {}` (empty predicate — malformed Go): the parser skipped the body; emit no
    // condition and walk nothing. Valid Go always has a predicate, so this only fires on junk.
    if (s.predicate === '') return;
    const condId = this.condition(s.predicate, s.ifLine, 'THEN');
    // THEN branch
    this.walkBody(s.then, proc, [...guardStack, condId], 'THEN', inLoop, inException);
    // ELSIF branches (same condId — one condition per IF chain)
    for (const elif of s.elseIfs) {
      this.walkBody(elif.body, proc, [...guardStack, condId], 'ELSIF', inLoop, inException);
    }
    // ELSE branch (same condId)
    if (s.elseBody) {
      this.walkBody(s.elseBody, proc, [...guardStack, condId], 'ELSE', inLoop, inException);
    }
  }

  /** `for` → one condition (branch:'LOOP'), body walked with inLoop=true. */
  private walkFor(
    s: GoForStmt,
    proc: ProcCtx,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    const condId = this.condition(s.predicate, s.forLine, 'LOOP');
    this.walkBody(s.body, proc, [...guardStack, condId], 'LOOP', true, inException);
  }

  /** `switch` → one `case-branch` node per case (incl. default) — whenSelector = the case expr/type
   *  (omitted for default); the body is walked under that guard with branch CASE/DEFAULT. Type-switch
   *  `case <Type>:` surfaces the type as the predicate (and thus as whenSelector). */
  private walkSwitch(
    s: GoSwitchStmt,
    proc: ProcCtx,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    for (const c of s.cases) {
      const condId = this.caseBranch(c.predicate ?? '', c.line, c.isDefault);
      const label = c.isDefault ? 'DEFAULT' : 'CASE';
      this.walkBody(c.body, proc, [...guardStack, condId], label, inLoop, inException);
    }
  }

  /** `select` → one condition per non-default case predicate (branch:'CASE'). */
  private walkSelect(
    s: GoSelectStmt,
    proc: ProcCtx,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
  ): void {
    for (const c of s.cases) {
      if (c.isDefault) {
        this.walkBody(c.body, proc, guardStack, undefined, inLoop, inException);
      } else {
        const condId = this.condition(c.predicate ?? '', c.line, 'CASE');
        this.walkBody(c.body, proc, [...guardStack, condId], 'CASE', inLoop, inException);
      }
    }
  }

  /** Emit a statement node + an executes edge proc→stmt carrying the full guard chain. */
  private addStatement(
    line: number,
    type: 'call' | 'return' | 'assign' | 'throw' | 'expr' | 'plain',
    expr: string,
    head: string,
    proc: ProcCtx,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    const id = this.ctx.idFor('statement', { file: this.path, line });
    this.nodes.push({
      id,
      kind: 'statement',
      type,
      ...exprFields(expr),
      file: this.path,
      span: { start: line, end: line },
      lang: 'go',
      hash: this.ctx.hash(`${this.path}:${line}:${type}`),
      meta: {
        ...(head ? { head } : {}),
        inLoop,
        inException,
        ...(guardStack.length > 0 ? { branch: 'GUARDED' } : {}),
      },
    });
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    this.edges.push({
      id: edgeId(proc.procId, id, 'executes'),
      src: proc.procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'lang:go', snippet: head || expr.slice(0, 40) },
      cfgPath: guardStack.slice(),
      ...(guard !== undefined ? { guard } : {}),
      ...(guard !== undefined && branch !== undefined ? { branch } : {}),
      inLoop,
      inException,
    });
    // guarded-by: statement → innermost enclosing condition (graph completeness).
    if (guard !== undefined) {
      this.edges.push({
        id: edgeId(id, guard, 'guarded-by'),
        src: id,
        dst: guard,
        rel: 'guarded-by',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'lang:go', snippet: branch ?? 'IF' },
      });
    }
  }

  /**
   * Record a call site + annotate the (proc→callee) intra-file calls edge with the guard chain
   * (best-effort, last-wins per callee). Dotted callees are recorded as call sites but get no edge
   * (cross-file resolution is the resolver's job). Mirrors PlSqlExtractor.addCall.
   */
  private addCall(
    callee: GoCallee,
    proc: ProcCtx,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    proc.callSites.push({ callee: callee.name, line: callee.line });
    // intra-file resolution: bare calls only (dotted → resolver). Match collectCalls' stance.
    if (callee.tail.length > 0) return;
    const dstId = this.byKey.get(callee.name) ?? this.byKey.get(callee.head);
    if (!dstId || dstId === proc.procId) return; // skip self-recursion
    const id = edgeId(proc.procId, dstId, 'calls');
    const gf: GuardFields = {
      cfgPath: guardStack.slice(),
      ...(guardStack.length > 0 ? { guard: guardStack[guardStack.length - 1] } : {}),
      ...(guardStack.length > 0 && branch !== undefined ? { branch } : {}),
      inLoop,
      inException,
    };
    const existing = this.callsEdges.get(id);
    if (existing) {
      // last-wins: overwrite the guard-chain fields (a callee called in two branches keeps the
      // last site's cfgPath — the documented lossy-but-honest behavior).
      existing.cfgPath = gf.cfgPath;
      if (gf.guard !== undefined) existing.guard = gf.guard;
      else existing.guard = undefined;
      if (gf.branch !== undefined) existing.branch = gf.branch;
      else existing.branch = undefined;
      existing.inLoop = gf.inLoop;
      existing.inException = gf.inException;
    } else {
      const e: Edge = {
        id,
        src: proc.procId,
        dst: dstId,
        rel: 'calls',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'lang:go', snippet: callee.head },
        cfgPath: gf.cfgPath,
        ...(gf.guard !== undefined ? { guard: gf.guard } : {}),
        ...(gf.branch !== undefined ? { branch: gf.branch } : {}),
        inLoop: gf.inLoop,
        inException: gf.inException,
      };
      this.callsEdges.set(id, e);
      this.edges.push(e);
    }
  }

  /** Emit a deduped condition node (keyed by file+line) and return its id. */
  private condition(expr: string, line: number, branch: string): string {
    const id = this.ctx.idFor('condition', { file: this.path, line });
    if (!this.condSeen.has(id)) {
      this.condSeen.add(id);
      this.nodes.push({
        id,
        kind: 'condition',
        branch,
        ...exprFields(expr),
        file: this.path,
        span: { start: line, end: line },
        lang: 'go',
        hash: this.ctx.hash(`${this.path}:${line}:${expr}`),
      });
    }
    return id;
  }

  /** 1.2: emit a deduped `case-branch` node (keyed by file+line) and return its id. `whenSelector`
   *  carries the case expr/type (omitted for default); `branch` is CASE/DEFAULT. */
  private caseBranch(expr: string, line: number, isDefault: boolean): string {
    const id = this.ctx.idFor('case-branch', { file: this.path, line });
    if (!this.caseBranchSeen.has(id)) {
      this.caseBranchSeen.add(id);
      this.nodes.push({
        id,
        kind: 'case-branch',
        branch: isDefault ? 'DEFAULT' : 'CASE',
        expr,
        file: this.path,
        span: { start: line, end: line },
        lang: 'go',
        hash: this.ctx.hash(`${this.path}:case:${line}:${expr}`),
        ...(!isDefault && expr ? { whenSelector: expr } : {}),
      });
    }
    return id;
  }

  /** 1.2: emit a deduped `exception-handler` node (keyed by file+line) for a defer-with-recover and
   *  return its id. `whenSelector` is `recover` (Go's closest catch selector). */
  private exceptionHandler(line: number): string {
    const id = this.ctx.idFor('exception-handler', { file: this.path, line });
    if (!this.excSeen.has(id)) {
      this.excSeen.add(id);
      this.nodes.push({
        id,
        kind: 'exception-handler',
        whenSelector: 'recover',
        file: this.path,
        span: { start: line, end: line },
        lang: 'go',
        hash: this.ctx.hash(`${this.path}:exc:${line}:recover`),
      });
    }
    return id;
  }

  /** 1.2: emit a `raise` node + a `raises` edge (proc → raise) carrying the full guard chain, + a
   *  guarded-by edge when guarded. Mirrors addStatement's edge stamping but with rel:'raises'. */
  private addRaise(
    line: number,
    name: string,
    errorMessage: string,
    proc: ProcCtx,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    const id = this.ctx.idFor('raise', { file: this.path, line });
    this.nodes.push({
      id,
      kind: 'raise',
      name,
      ...(errorMessage ? { errorMessage } : {}),
      file: this.path,
      span: { start: line, end: line },
      lang: 'go',
      hash: this.ctx.hash(`${this.path}:${line}:raise:${name}:${errorMessage}`),
      meta: { inLoop, inException },
    });
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    this.edges.push({
      id: edgeId(proc.procId, id, 'raises'),
      src: proc.procId,
      dst: id,
      rel: 'raises',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'lang:go', snippet: name },
      cfgPath: guardStack.slice(),
      ...(guard !== undefined ? { guard } : {}),
      ...(guard !== undefined && branch !== undefined ? { branch } : {}),
      inLoop,
      inException,
    });
    if (guard !== undefined) {
      this.edges.push({
        id: edgeId(id, guard, 'guarded-by'),
        src: id,
        dst: guard,
        rel: 'guarded-by',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'lang:go', snippet: branch ?? 'IF' },
      });
    }
  }

  /** 1.2: emit an `assignment` node (kind:'assignment', assignTarget=LHS) + an `executes` edge
   *  (proc → assignment) carrying the full guard chain, + guarded-by when guarded. If the RHS is a
   *  call, the call site is recorded + the intra-file calls edge annotated (preserves Track-3). */
  private addAssignment(
    line: number,
    target: string,
    expr: string,
    proc: ProcCtx,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
    callee?: GoCallee,
  ): void {
    const id = this.ctx.idFor('assignment', { file: this.path, line });
    this.nodes.push({
      id,
      kind: 'assignment',
      ...(target ? { assignTarget: target } : {}),
      ...exprFields(expr),
      file: this.path,
      span: { start: line, end: line },
      lang: 'go',
      hash: this.ctx.hash(`${this.path}:${line}:assign:${target}`),
      meta: {
        inLoop,
        inException,
        ...(guardStack.length > 0 ? { branch: 'GUARDED' } : {}),
      },
    });
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    this.edges.push({
      id: edgeId(proc.procId, id, 'executes'),
      src: proc.procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'lang:go', snippet: target || expr.slice(0, 40) },
      cfgPath: guardStack.slice(),
      ...(guard !== undefined ? { guard } : {}),
      ...(guard !== undefined && branch !== undefined ? { branch } : {}),
      inLoop,
      inException,
    });
    if (guard !== undefined) {
      this.edges.push({
        id: edgeId(id, guard, 'guarded-by'),
        src: id,
        dst: guard,
        rel: 'guarded-by',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'lang:go', snippet: branch ?? 'IF' },
      });
    }
    if (callee) this.addCall(callee, proc, guardStack, branch, inLoop, inException);
  }

  /** 1.2: walk a `defer func(){…}()` — if the body contains `recover()`, emit an `exception-handler`
   *  node + `handles` edges to every statement/assignment/raise node in the body, and walk the body
   *  with inException=true (under the outer guard — a defer is registered at the current point but
   *  handles panics from the whole enclosing function; the handler id is NOT pushed onto the guard
   *  stack, mirroring PL/SQL's EXCEPTION walk). A defer without recover is walked as plain deferred
   *  actions. Capability-honest: only an explicit recover() in defer models a handler. */
  private walkDefer(
    s: GoDeferStmt,
    proc: ProcCtx,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): void {
    if (s.hasRecover) {
      const excId = this.exceptionHandler(s.line);
      const before = this.nodes.length;
      this.walkBody(s.body, proc, guardStack, branch, inLoop, true);
      const handlerStmts = this.nodes
        .slice(before)
        .filter((n) => n.kind === 'statement' || n.kind === 'assignment' || n.kind === 'raise');
      for (const target of handlerStmts) {
        this.edges.push({
          id: edgeId(excId, target.id, 'handles'),
          src: excId,
          dst: target.id,
          rel: 'handles',
          method: 'static',
          provenance: 'EXTRACTED',
          confidence: 1,
          evidence: { by: 'lang:go', snippet: 'recover' },
        });
      }
      return;
    }
    // plain defer of a func literal (no recover) — walk the deferred body as ordinary actions.
    this.walkBody(s.body, proc, guardStack, branch, inLoop, inException);
  }
}
