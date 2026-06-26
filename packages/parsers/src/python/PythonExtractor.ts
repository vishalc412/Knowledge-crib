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
import { clampExpr } from '../types.js';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import { collectPythonComments } from './lexer.js';
import type { CommentBlock } from './lexer.js';
import { parsePython, stringLiteralInner } from './parser.js';
import type { PyCallRef, PyCallSite, PyDef, PyStmt } from './parser.js';

/** Spread an `expr` field plus its `exprTruncated` honesty flag from a raw expression string. */
function exprFields(raw: string | undefined): { expr?: string; exprTruncated?: true } {
  if (!raw) return {};
  const { expr, truncated } = clampExpr(raw);
  return truncated ? { expr, exprTruncated: true } : { expr };
}

interface LocalSymbol {
  node: Node;
  /** lookup keys this symbol answers to for intra-file call resolution. */
  keys: string[];
  /** `self`/`cls`-style method calls resolve against the simple name of methods in the same class. */
  simpleName: string;
}

/** Walk-time state shared across the body-walk of one file (Track 3). */
interface WalkCtx {
  path: string;
  ctx: ExtractCtx;
  nodes: Node[];
  edges: Edge[];
  /** qualifiedName | simpleName → symbol id (intra-file call resolution; shared with collectCalls). */
  byKey: Map<string, string>;
  /** edgeId → calls edge, so the body-walk can annotate the call-graph edges with the guard chain. */
  callsEdges: Map<string, Edge>;
  /** condition ids created, to dedupe by (file, line) — one condition node per IF/loop line. */
  condSeen: Set<string>;
  /** case-branch ids created, to dedupe by (file, line) — one per `case` arm (schema 1.2). */
  caseBranchSeen: Set<string>;
  /** exception-handler ids created, to dedupe by (file, line) — one per `except` clause (1.2). */
  excSeen: Set<string>;
  /** explanation ids created, to dedupe by (file, line) — one per docstring/comment block (1.2). */
  explSeen: Set<string>;
  /** procId → call sites recorded for the proc's `meta.calls` (recovered by extract_rules). */
  callSitesByProc: Map<string, Array<{ callee: string; line: number }>>;
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
    const comments = collectPythonComments(text);
    const symbols: LocalSymbol[] = [];
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const byKey = new Map<string, string>(); // qualifiedName | simpleName → symbol id
    /** walkable function/method defs (classes are skipped; their methods are recursed). */
    const walkable: Array<{ def: PyDef; procId: string }> = [];
    const explSeen = new Set<string>();

    // --- pass 1: declarations + member-of, walking the nesting tree; attach docstring + preceding
    //     comment block as `explanation` nodes (schema 1.2, mirrors PlSqlExtractor.attachComment). ---
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
        nodes.push(node);
        const sym: LocalSymbol = { node, keys: [qualifiedName, d.name], simpleName: d.name };
        symbols.push(sym);
        for (const k of [qualifiedName, d.name]) if (!byKey.has(k)) byKey.set(k, id);
        edges.push(this.memberOf(node, this.parentIdFor(sym, byKey, fileId)));
        // 1.2: docstring (suite's first string) + `#` block immediately above → explanation + describes.
        this.attachExplanation(id, d, path, ctx, nodes, edges, explSeen, comments);
        // a function/method (not a class) carries a procedure body the extractor walks for the CFG.
        if (d.kind === 'function') walkable.push({ def: d, procId: id });
        // recurse: a class's children are methods (qualifier grows); a function's children are
        // nested functions (qualifier grows too, but they stay kind 'function').
        visit(d.body, [...qualifier, d.name]);
      }
    };
    visit(mod.defs, []);

    // --- pass 2: intra-file calls (self.method / bare fn; module.fn is the resolver's job) ---
    this.collectCalls(mod.calls, symbols, byKey, edges);

    // --- pass 3 (Track 3): statement/condition/CFG body-walk. STRICTLY ADDITIVE — emits statement
    // nodes + executes/guarded-by edges, annotates the pass-2 calls edges with the guard chain, and
    // records call sites on each proc's meta.calls. The guard stack is tracked inline (one pass). ---
    const callsEdges = new Map<string, Edge>();
    for (const e of edges) if (e.rel === 'calls') callsEdges.set(e.id, e);
    const w: WalkCtx = {
      path,
      ctx,
      nodes,
      edges,
      byKey,
      callsEdges,
      condSeen: new Set(),
      caseBranchSeen: new Set(),
      excSeen: new Set(),
      explSeen,
      callSitesByProc: new Map(),
    };
    for (const { def, procId } of walkable) {
      this.walkBody(def.statements, procId, [], undefined, false, false, w);
      this.stampCallSites(procId, w);
    }

    return { nodes, edges };
  }

  // ---------------------------------------------------------------------------------------------
  // Body-walk (Track 3) — mirrors PlSqlExtractor.walkBlock/walkIf/walkLoop/condition/addSql/addCall
  // but tracks the FULL guard stack inline and stamps cfgPath/guard/branch/inLoop/inException
  // directly on the executes/calls edges at emission time (no separate CFG pass).
  // ---------------------------------------------------------------------------------------------

  /** Walk a statement list, emitting statement/condition nodes + executes/guarded-by edges. */
  private walkBody(
    stmts: PyStmt[],
    procId: string,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    for (const s of stmts) {
      switch (s.kind) {
        case 'def':
          // nested declarations are emitted in pass 1; the body-walk does not re-walk them (their
          // own body is walked when their own def entry is processed).
          break;
        case 'action':
          // schema 1.2: route raise/assign to their own node kinds; 'expr' (docstrings) + plain
          // expressions carry no behavior node (docstrings are surfaced via the def's docstring
          // field in pass 1, not the walk). 'call'/'return' keep the existing statement node.
          if (s.action === 'throw')
            this.addRaise(s, procId, guardStack, branch, inLoop, inException, w);
          else if (s.action === 'assign')
            this.addAssignment(s, procId, guardStack, branch, inLoop, inException, w);
          else if (s.action === 'call' || s.action === 'return')
            this.addStatement(s, procId, guardStack, branch, inLoop, inException, w);
          break;
        case 'if':
          this.walkIf(s, procId, guardStack, inLoop, inException, w);
          break;
        case 'loop':
          this.walkLoop(s, procId, guardStack, inLoop, inException, w);
          break;
        case 'with':
          // a context manager is not a guard — walk its body under the same env (no new condition).
          this.walkBody(s.body ?? [], procId, guardStack, branch, inLoop, inException, w);
          break;
        case 'try':
          this.walkTry(s, procId, guardStack, branch, inLoop, inException, w);
          break;
        case 'match':
          this.walkMatch(s, procId, guardStack, inLoop, inException, w);
          break;
      }
    }
  }

  /**
   * Walk an if/elif/else chain. ONE condition node per IF, keyed by `(file, ifLine)` — all branches
   * share the condId (the node's `branch` is 'THEN' from the first branch). The per-branch polarity
   * (THEN/ELSIF/ELSE) is carried on each EDGE's `branch` field, not as separate condition nodes.
   */
  private walkIf(
    s: PyStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    const branches = s.branches ?? [];
    if (branches.length === 0) return;
    const ifLine = branches[0]!.line;
    const condId = this.condition(w, branches[0]!.predicate ?? '', ifLine, 'THEN');
    for (const b of branches) {
      const polarity = b.polarity === 'then' ? 'THEN' : b.polarity === 'elif' ? 'ELSIF' : 'ELSE';
      this.walkBody(b.body, procId, [...guardStack, condId], polarity, inLoop, inException, w);
    }
  }

  /** Walk a for/while loop: one condition node (branch 'LOOP'), body walked with inLoop=true. */
  private walkLoop(
    s: PyStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    const condId = this.condition(w, s.predicate ?? '', s.line, 'LOOP');
    this.walkBody(s.body ?? [], procId, [...guardStack, condId], 'LOOP', true, inException, w);
  }

  /**
   * Walk a try/except/finally. The try body + each handler body + finally are walked with
   * inException=true (mirrors the existing semantics; a try body sits in an exception context).
   * Schema 1.2: each `except` clause emits an `exception-handler` node (whenSelector = the caught
   * type) and a `handles` edge from the handler to every `raise` node emitted in the try body —
   * i.e. the things this handler catches (capability-honest: no raises ⇒ no handles edges).
   */
  private walkTry(
    s: PyStmt,
    procId: string,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    const before = w.nodes.length;
    this.walkBody(s.body ?? [], procId, guardStack, branch, inLoop, true, w);
    const tryRaises = w.nodes.slice(before).filter((n) => n.kind === 'raise');
    for (const h of s.handlers ?? []) {
      const selector = whenSelectorOf(h.predicate ?? '');
      const hid = this.exceptionHandler(w, selector, h.line);
      this.walkBody(h.body, procId, guardStack, branch, inLoop, true, w);
      for (const r of tryRaises) w.edges.push(this.edge(hid, r.id, 'handles', selector));
    }
    if (s.finallyBody) {
      this.walkBody(s.finallyBody, procId, guardStack, branch, inLoop, true, w);
    }
  }

  /**
   * Walk a match/case (Python 3.10+ structural pattern matching). Each `case <pat>:` arm emits a
   * `case-branch` node (whenSelector = the pattern text; `_` for the default) and its body is
   * walked under that guard — consistent with the existing if-walk guard logic (schema 1.2).
   */
  private walkMatch(
    s: PyStmt,
    procId: string,
    guardStack: string[],
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    for (const c of s.cases ?? []) {
      const pat = c.predicate ?? '';
      const cbId = this.caseBranch(w, pat, c.line);
      this.walkBody(c.body, procId, [...guardStack, cbId], 'CASE', inLoop, inException, w);
    }
  }

  /**
   * Emit a statement node for one action line + an `executes` edge proc→stmt stamped with the guard
   * chain, a `guarded-by` edge to the innermost condition, record call sites on the proc's
   * meta.calls, and annotate the matching `calls` edge (best-effort, first-wins) with the guard.
   */
  private addStatement(
    s: PyStmt,
    procId: string,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    const line = s.line;
    const type = s.action ?? 'plain';
    const id = w.ctx.idFor('statement', { file: w.path, line });
    const inner = guardStack.length ? guardStack[guardStack.length - 1] : undefined;
    const node: Node = {
      id,
      kind: 'statement',
      type,
      file: w.path,
      span: { start: line, end: s.endLine },
      lang: 'python',
      hash: w.ctx.hash(`${w.path}:${line}:${type}`),
      ...exprFields(s.text),
      meta: {
        ...(s.head ? { head: s.head } : {}),
        inLoop,
        inException,
        ...(inner ? { branch: 'GUARDED' } : {}),
      },
    };
    w.nodes.push(node);

    // executes: procedure → statement, stamped with the full guard chain (the whole point).
    const e = this.edge(procId, id, 'executes', s.head ?? type);
    e.cfgPath = guardStack.slice();
    if (inner) {
      e.guard = inner;
      e.branch = branch; // polarity of the INNERMOST IF/loop/case on the path
    }
    e.inLoop = inLoop;
    e.inException = inException;
    w.edges.push(e);

    // guarded-by: statement → innermost enclosing condition (graph completeness, mirrors PlSqlExtractor).
    if (inner) w.edges.push(this.edge(id, inner, 'guarded-by', branch ?? 'IF'));

    // record call sites + annotate calls edges for every call chain on this line (a `return foo()`
    // carries a call; its calls edge is emitted by pass 2, here we annotate it best-effort).
    for (const c of s.calls ?? [])
      this.recordCall(c, procId, guardStack, branch, inLoop, inException, w);
  }

  /** Record a call site on the proc's meta.calls and annotate the intra-file calls edge (first-wins). */
  private recordCall(
    c: PyCallRef,
    procId: string,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    const sites = w.callSitesByProc.get(procId);
    if (sites) sites.push({ callee: c.callee, line: c.line });
    else w.callSitesByProc.set(procId, [{ callee: c.callee, line: c.line }]);

    // intra-file resolution mirrors collectCalls: self/cls → simple name; bare → simple/qualified;
    // dotted non-self (module.fn / obj.fn) → cross-file, left to the resolver.
    let dstId: string | undefined;
    if (c.head === 'self' || c.head === 'cls') dstId = w.byKey.get(c.callee);
    else if (c.chain.length === 1) dstId = w.byKey.get(c.callee);
    if (!dstId || dstId === procId) return; // unresolved or self-recursion — no calls edge to annotate

    const ce = w.callsEdges.get(edgeId(procId, dstId, 'calls'));
    if (ce && ce.cfgPath === undefined) {
      // first-wins: the first call site encountered in walk order annotates the deduped edge.
      ce.cfgPath = guardStack.slice();
      if (guardStack.length) {
        ce.guard = guardStack[guardStack.length - 1];
        ce.branch = branch;
      }
      ce.inLoop = inLoop;
      ce.inException = inException;
    }
  }

  /** Emit a condition node (deduped by file+line) and return its id. */
  private condition(w: WalkCtx, expr: string, line: number, branch: string): string {
    const id = w.ctx.idFor('condition', { file: w.path, line });
    if (!w.condSeen.has(id)) {
      w.condSeen.add(id);
      w.nodes.push({
        id,
        kind: 'condition',
        branch,
        ...exprFields(expr),
        file: w.path,
        span: { start: line, end: line },
        lang: 'python',
        hash: w.ctx.hash(`${w.path}:${line}:${expr}`),
      });
    }
    return id;
  }

  // ---------------------------------------------------------------------------------------------
  // Schema 1.2 emitters — raise / assignment / exception-handler / case-branch / explanation.
  // ---------------------------------------------------------------------------------------------

  /**
   * Emit a `raise` node for a `raise <Ex>(...)` / bare `raise` + a `raises` edge (proc → raise)
   * stamped with the guard chain, a `guarded-by` edge when guarded, and record RHS call sites.
   * `name` = the exception type; `errorMessage` = the first string-literal arg, when identifiable.
   */
  private addRaise(
    s: PyStmt,
    procId: string,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    const line = s.line;
    const id = w.ctx.idFor('raise', { file: w.path, line });
    const inner = guardStack.length ? guardStack[guardStack.length - 1] : undefined;
    const name = s.raiseName ?? '';
    const node: Node = {
      id,
      kind: 'raise',
      ...(name ? { name } : {}),
      file: w.path,
      span: { start: line, end: s.endLine },
      lang: 'python',
      hash: w.ctx.hash(`${w.path}:${line}:raise:${name}`),
      ...(s.raiseMessage !== undefined ? { errorMessage: s.raiseMessage } : {}),
      meta: { inLoop, inException },
    };
    w.nodes.push(node);
    const e = this.edge(procId, id, 'raises', name || 'RAISE');
    e.cfgPath = guardStack.slice();
    if (inner) {
      e.guard = inner;
      e.branch = branch;
    }
    e.inLoop = inLoop;
    e.inException = inException;
    w.edges.push(e);
    if (inner) w.edges.push(this.edge(id, inner, 'guarded-by', branch ?? 'RAISE'));
    for (const c of s.calls ?? [])
      this.recordCall(c, procId, guardStack, branch, inLoop, inException, w);
  }

  /**
   * Emit an `assignment` node for `lhs = rhs` / `:=` / augmented assigns + an `executes` edge
   * (proc → assignment) stamped with the guard chain + `guarded-by` when guarded, and record RHS
   * call sites. `assignTarget` = the cleaned LHS; `expr` = the full line text (decision-table row).
   */
  private addAssignment(
    s: PyStmt,
    procId: string,
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
    w: WalkCtx,
  ): void {
    const line = s.line;
    const id = w.ctx.idFor('assignment', { file: w.path, line });
    const inner = guardStack.length ? guardStack[guardStack.length - 1] : undefined;
    const node: Node = {
      id,
      kind: 'assignment',
      file: w.path,
      span: { start: line, end: s.endLine },
      lang: 'python',
      hash: w.ctx.hash(`${w.path}:${line}:assign`),
      ...(s.assignTarget ? { assignTarget: s.assignTarget } : {}),
      ...exprFields(s.text),
      meta: { inLoop, inException },
    };
    w.nodes.push(node);
    const e = this.edge(procId, id, 'executes', 'assign');
    e.cfgPath = guardStack.slice();
    if (inner) {
      e.guard = inner;
      e.branch = branch;
    }
    e.inLoop = inLoop;
    e.inException = inException;
    w.edges.push(e);
    if (inner) w.edges.push(this.edge(id, inner, 'guarded-by', branch ?? 'assign'));
    for (const c of s.calls ?? [])
      this.recordCall(c, procId, guardStack, branch, inLoop, inException, w);
  }

  /** Emit an `exception-handler` node (deduped by file+line) with `whenSelector` and return its id. */
  private exceptionHandler(w: WalkCtx, selector: string, line: number): string {
    const id = w.ctx.idFor('exception-handler', { file: w.path, line });
    if (!w.excSeen.has(id)) {
      w.excSeen.add(id);
      w.nodes.push({
        id,
        kind: 'exception-handler',
        whenSelector: selector,
        file: w.path,
        span: { start: line, end: line },
        lang: 'python',
        hash: w.ctx.hash(`${w.path}:exc:${line}:${selector}`),
      });
    }
    return id;
  }

  /** Emit a `case-branch` node (deduped by file+line) with `whenSelector` = the pattern and return id. */
  private caseBranch(w: WalkCtx, pattern: string, line: number): string {
    const id = w.ctx.idFor('case-branch', { file: w.path, line });
    if (!w.caseBranchSeen.has(id)) {
      w.caseBranchSeen.add(id);
      w.nodes.push({
        id,
        kind: 'case-branch',
        branch: 'CASE',
        expr: pattern,
        whenSelector: pattern || '_',
        file: w.path,
        span: { start: line, end: line },
        lang: 'python',
        hash: w.ctx.hash(`${w.path}:case:${line}:${pattern}`),
      });
    }
    return id;
  }

  /**
   * Attach an `explanation` node + `describes` edge to a symbol for (a) the symbol's docstring
   * (the suite's first string literal) and (b) a `#` comment block ending on the line immediately
   * above the symbol. Both are deduped by id (file, startLine). Docstrings are Python's primary
   * documentation; comments-above mirror PlSqlExtractor.attachComment. Inline body comments are
   * NOT attached (they are notes, not symbol docs) — capability-honest.
   */
  private attachExplanation(
    symId: string,
    def: PyDef,
    path: string,
    ctx: ExtractCtx,
    nodes: Node[],
    edges: Edge[],
    explSeen: Set<string>,
    comments: CommentBlock[],
  ): void {
    if (def.docstring) {
      const id = ctx.idFor('explanation', { path, startLine: def.docstring.startLine });
      if (!explSeen.has(id)) {
        explSeen.add(id);
        const inner = stringLiteralInner(def.docstring.text);
        nodes.push({
          id,
          kind: 'explanation',
          commentRef: {
            file: path,
            span: { start: def.docstring.startLine, end: def.docstring.endLine },
          },
          file: path,
          span: { start: def.docstring.startLine, end: def.docstring.endLine },
          lang: 'python',
          hash: ctx.hash(`${path}:${def.docstring.startLine}:${inner}`),
          meta: { text: inner },
        });
        edges.push(this.edge(id, symId, 'describes', 'DOCSTRING'));
      }
    }
    const block = comments.find((c) => c.end === def.startLine - 1);
    if (block?.text) {
      const id = ctx.idFor('explanation', { path, startLine: block.start });
      if (!explSeen.has(id)) {
        explSeen.add(id);
        nodes.push({
          id,
          kind: 'explanation',
          commentRef: { file: path, span: { start: block.start, end: block.end } },
          file: path,
          span: { start: block.start, end: block.end },
          lang: 'python',
          hash: ctx.hash(`${path}:${block.start}:${block.text}`),
          meta: { text: block.text },
        });
        edges.push(this.edge(id, symId, 'describes', 'COMMENT'));
      }
    }
  }

  /** Stamp accumulated call sites onto the proc node's meta.calls (extract_rules recovers the
   *  call-site line from this when the calls edge's dst is the callee's definition). */
  private stampCallSites(procId: string, w: WalkCtx): void {
    const sites = w.callSitesByProc.get(procId);
    if (!sites || sites.length === 0) return;
    const proc = w.nodes.find((n) => n.id === procId);
    if (proc) proc.meta = { ...(proc.meta ?? {}), calls: sites };
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

  /** Edge factory for the Track 3 body-walk (executes/guarded-by); guard-chain fields are stamped
   *  by the caller after construction. */
  private edge(src: string, dst: string, rel: Edge['rel'], snippet: string): Edge {
    return {
      id: edgeId(src, dst, rel),
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name, snippet },
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

/**
 * Derive the `whenSelector` for an `except` clause from its best-effort predicate text:
 *   • bare `except:` → `BaseException`
 *   • `except ValueError as e` → `ValueError` (drop the `as <name>`)
 *   • `except (A, B) as e` → `A|B` (drop parens + `as`, join with `|`)
 * Tolerant: any unrecognized shape returns the trimmed predicate verbatim.
 */
function whenSelectorOf(pred: string): string {
  const p = pred.trim();
  if (p === '') return 'BaseException';
  const asIdx = p.indexOf(' as ');
  let typePart = asIdx >= 0 ? p.slice(0, asIdx) : p;
  typePart = typePart.trim();
  if (typePart.startsWith('(') && typePart.endsWith(')')) {
    const inner = typePart.slice(1, -1);
    return inner
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join('|');
  }
  return typePart;
}
