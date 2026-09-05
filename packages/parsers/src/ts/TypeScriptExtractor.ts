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
import { EXPR_MAX_CHARS, clampExpr } from '../types.js';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import { extractExpressRoutes } from './express.js';
import { extractHttpClients } from './http-client.js';
import { extractNestSemantics } from './nest.js';
import { extractReactSemantics } from './react.js';

interface LocalSymbol {
  node: Node;
  /** lookup keys this symbol answers to for intra-file call resolution. */
  keys: string[];
  /** the original TS declaration node (for body-walking). */
  tsNode: ts.Node;
  /** the function-like body to walk (Block or expression body), if this symbol has one. */
  body?: ts.Node;
}

export class TypeScriptExtractor implements Extractor {
  name = 'lang:typescript';
  capabilities: Capabilities = { imports: true, calls: true, inheritance: true, types: 'partial' };

  // M2.5 — the TS extractor's syntactic `createSourceFile` engine parses JS/JSX/MJS/CJS just as
  // well as TS (no type-checker, no program, no `allowJs` flag needed — `createSourceFile` honors a
  // `scriptKind`). Admitting the JS family here means plain-JS repos get the same symbol/edge
  // coverage as TS repos instead of being dropped at Phase 2 (`if (!extractor) continue`).
  private static readonly EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

  supports(file: FileMeta): boolean {
    return TypeScriptExtractor.EXTS.some((e) => file.path.endsWith(e));
  }

  /** TS-family exts tag `lang: 'typescript'`; JS-family exts tag `lang: 'javascript'`. */
  private static langFor(path: string): 'typescript' | 'javascript' {
    return /\.(mjs|cjs|js|jsx)$/.test(path) ? 'javascript' : 'typescript';
  }

  /** `createSourceFile` scriptKind per extension — `.tsx`→TSX, `.jsx`→JSX, `.js`/`.mjs`/`.cjs`→JS. */
  private static scriptKindFor(path: string): ts.ScriptKind {
    if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs'))
      return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
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
    const lang = TypeScriptExtractor.langFor(path);
    const scriptKind = TypeScriptExtractor.scriptKindFor(path);
    const sf = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      scriptKind,
    );

    const symbols: LocalSymbol[] = [];
    const byKey = new Map<string, string>(); // lookup key → symbol id
    // Bare `foo()` may only reach a TOP-LEVEL symbol. `byKey` also answers to the bare name of a
    // class member (so `this.foo()` resolves), which is why a separate map is needed rather than a
    // filter at lookup time — see calleeIdentifier for the shape distinction this enforces.
    const bareCallable = new Map<string, string>();

    const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

    // --- pass 1: declarations + member-of ---
    const visit = (node: ts.Node, qualifier: string[], parentId: string): void => {
      const decl = this.declarationOf(node, qualifier, path, fileId, lineOf, ctx, lang);
      if (decl) {
        symbols.push(decl.local);
        for (const k of decl.local.keys) if (!byKey.has(k)) byKey.set(k, decl.local.node.id);
        if ((decl.local.node.meta?.parentQualifier ?? '') === '') {
          const bare = decl.local.node.name;
          if (bare && !bareCallable.has(bare)) bareCallable.set(bare, decl.local.node.id);
        }
        ts.forEachChild(node, (c) => visit(c, decl.childQualifier, decl.local.node.id));
      } else {
        ts.forEachChild(node, (c) => visit(c, qualifier, parentId));
      }
    };
    ts.forEachChild(sf, (c) => visit(c, [], fileId));

    const nodes: Node[] = symbols.map((s) => s.node);
    const edges: Edge[] = symbols.map((s) =>
      this.memberOf(s.node, this.parentIdFor(s, symbols, fileId)),
    );

    // --- pass 1.5 (1.2): preceding comment block → `explanation` node + `describes` edge,
    //     so a symbol's intent survives into the graph. Pure line-association, never throws. ---
    this.attachExplanations(
      path,
      ctx,
      collectTsComments(text),
      symbols,
      lineOf,
      nodes,
      edges,
      lang,
    );

    // --- pass 2: intra-file calls (deduped proc→callee, no guard fields yet) ---
    this.collectCalls(sf, symbols, byKey, bareCallable, lineOf, edges);

    // --- pass 3: body-walk — condition/statement nodes + executes/guarded-by edges,
    //     call-site recording (meta.calls) + guard-field annotation on the calls edges.
    //     1.2: also emits raise/exception-handler/assignment/case-branch behavior nodes. ---
    this.walkBodies(path, ctx, symbols, byKey, bareCallable, lineOf, nodes, edges, lang);

    // --- pass 4 (1.3): framework semantics — NestJS (decorators) + Express (imperative routes) +
    //     React (components/hooks/renders). Derives routes/DI/module-producers/entity-relations/
    //     columns/exception-filters + the React component composition tree above the syntactic
    //     graph. A non-framework file is a no-op for each. Shares the 1.3 kinds/rels with the
    //     Java/Spring track; no schema change. ---
    const classSyms = symbols
      .filter((s) => ts.isClassDeclaration(s.tsNode))
      .map((s) => ({
        tsNode: s.tsNode as ts.ClassDeclaration,
        id: s.node.id,
        qualifiedName: s.node.qualifiedName ?? '',
      }));
    if (classSyms.length) {
      extractNestSemantics({ classSyms, byKey, nodes, edges, ctx, path, lineOf, lang });
    }
    extractExpressRoutes({ sf, byKey, symbols, nodes, edges, ctx, path, lineOf, lang });
    extractReactSemantics({ symbols, byKey, nodes, edges, ctx, path, lineOf, lang });
    // --- pass 4b (1.5): outbound HTTP client calls → `http-call` nodes + enclosing `calls` edges.
    //     The repo-A side of cross-repo federation. A non-client file is a no-op. ---
    const symbolByNode = new Map<ts.Node, string>();
    for (const s of symbols) symbolByNode.set(s.tsNode, s.node.id);
    extractHttpClients({ sf, symbolByNode, nodes, edges, ctx, path, lineOf, lang });

    return { nodes, edges };
  }

  /**
   * 1.2: for each symbol, if a comment block ends on the line immediately above the symbol's start
   * line, emit an `explanation` node carrying the comment text + a `describes` edge. Deduped by
   * (path, comment-start-line). Mirrors PlSqlExtractor.attachComment.
   */
  private attachExplanations(
    path: string,
    ctx: ExtractCtx,
    comments: CommentBlock[],
    symbols: LocalSymbol[],
    lineOf: (pos: number) => number,
    nodes: Node[],
    edges: Edge[],
    lang: 'typescript' | 'javascript',
  ): void {
    const seen = new Set<string>();
    for (const s of symbols) {
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
        lang,
        hash: ctx.hash(`${path}:${block.start}:${block.text}`),
        meta: { text: block.text }, // the comment text is carried inline (a doc, not code ref)
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

  /** Build a symbol node for a declaration node, or null if `node` isn't a declaration we capture. */
  private declarationOf(
    node: ts.Node,
    qualifier: string[],
    path: string,
    _fileId: string,
    lineOf: (pos: number) => number,
    ctx: ExtractCtx,
    lang: 'typescript' | 'javascript',
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
      lang,
      hash: ctx.hash(node.getText()),
      ...(info.signature ? { signature: info.signature } : {}),
      meta: { parentQualifier: qualifier.join('.') },
    };
    const keys = [qualifiedName, info.name];
    return {
      local: { node: snnode, keys, tsNode: node, body: functionBodyOf(node) },
      childQualifier: [...qualifier, info.name],
    };
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
    bareCallable: Map<string, string>,
    lineOf: (pos: number) => number,
    edges: Edge[],
  ): void {
    const seen = new Set<string>();
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = calleeIdentifier(node.expression);
        if (callee) {
          const dstId = resolveCallee(callee, node, byKey, bareCallable);
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

  // --- pass 3: body-walk (Track 3) -----------------------------------------------------------
  // Walks each function-like symbol's body once, tracking the FULL guard stack inline and stamping
  // cfgPath/guard/branch/inLoop/inException directly on the executes/calls edges at emission time.
  // Mirrors PlSqlExtractor.walkBlock/walkIf/walkLoop/condition but in a single pass (no CFG re-parse).

  /** Guard-chain fields stamped onto an executes/calls edge for one action under a path. */
  private static guardFields(
    guardStack: string[],
    branch: string | undefined,
    inLoop: boolean,
    inException: boolean,
  ): { cfgPath: string[]; guard?: string; branch?: string; inLoop: boolean; inException: boolean } {
    const guard = guardStack.length > 0 ? guardStack[guardStack.length - 1] : undefined;
    return {
      cfgPath: guardStack.slice(),
      ...(guard !== undefined ? { guard } : {}),
      ...(guard !== undefined && branch !== undefined ? { branch } : {}),
      inLoop,
      inException,
    };
  }

  private walkBodies(
    path: string,
    ctx: ExtractCtx,
    symbols: LocalSymbol[],
    byKey: Map<string, string>,
    bareCallable: Map<string, string>,
    lineOf: (pos: number) => number,
    nodes: Node[],
    edges: Edge[],
    lang: 'typescript' | 'javascript',
  ): void {
    // one entry per procedure that has a body, holding the call-site records + per-callee guard
    // annotations collected during its body-walk (calls edges are deduped per (proc,callee), so
    // if the same callee is called in two branches the LAST site's guard fields win — honest).
    const procAnnots = new Map<string, Map<string, GuardFields>>();
    const procCallSites = new Map<string, Array<{ callee: string; line: number }>>();
    const condSeen = new Set<string>();
    const stmtSeen = new Set<string>();
    // 1.2: dedup set for behavior-bearing nodes (raise/exception-handler/assignment/case-branch),
    // keyed by their deterministic id (file+line). Shared across all bodies in one file.
    const behaviorSeen = new Set<string>();

    for (const s of symbols) {
      if (!s.body) continue;
      // only function-like symbols (function/method/getter/setter/arrow-var) have an executable body
      // whose actions we surface as decision-table rows.
      if (!isFunctionLikeSymbol(s.tsNode)) continue;
      const procId = s.node.id;
      const calls = new Map<string, GuardFields>();
      const sites: Array<{ callee: string; line: number }> = [];
      procAnnots.set(procId, calls);
      procCallSites.set(procId, sites);

      const stmts = ts.isBlock(s.body) ? [...s.body.statements] : [s.body as ts.Statement];
      this.walkBody(stmts, {
        procId,
        byKey,
        bareCallable,
        lineOf,
        nodes,
        edges,
        calls,
        sites,
        condSeen,
        stmtSeen,
        behaviorSeen,
        path,
        ctx,
        guardStack: [],
        branch: undefined,
        inLoop: false,
        inException: false,
        lang,
      });
    }

    // stamp meta.calls on each procedure node + annotate its deduped calls edges (last-wins).
    for (const s of symbols) {
      const procId = s.node.id;
      const sites = procCallSites.get(procId);
      if (sites && sites.length > 0) {
        s.node.meta = { ...(s.node.meta ?? {}), calls: sites };
      }
    }
    const callsAnnot = procAnnots;
    for (const e of edges) {
      if (e.rel !== 'calls') continue;
      const annots = callsAnnot.get(e.src);
      if (!annots) continue;
      const gf = annots.get(e.dst);
      if (!gf) continue;
      Object.assign(e, gf);
    }
  }

  private walkBody(stmts: readonly ts.Statement[], env: BodyEnv): void {
    for (const stmt of stmts) this.walkStmt(stmt, env);
  }

  private walkStmt(stmt: ts.Statement, env: BodyEnv): void {
    try {
      if (ts.isIfStatement(stmt)) {
        this.walkIf(stmt, env);
      } else if (ts.isForStatement(stmt)) {
        this.walkLoop(stmt, env, stmt.condition);
      } else if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
        this.walkLoop(stmt, env, stmt.expression);
      } else if (ts.isWhileStatement(stmt)) {
        this.walkLoop(stmt, env, stmt.expression);
      } else if (ts.isDoStatement(stmt)) {
        this.walkLoop(stmt, env, stmt.expression);
      } else if (ts.isTryStatement(stmt)) {
        this.walkTry(stmt, env);
      } else if (ts.isSwitchStatement(stmt)) {
        this.walkSwitch(stmt, env);
      } else if (ts.isBlock(stmt)) {
        this.walkBody([...stmt.statements], env);
      } else if (ts.isThrowStatement(stmt)) {
        // 1.2: a throw emits a `raise` node + `raises` edge (not a plain statement node).
        this.addRaise(stmt, env);
      } else if (isAssignmentStatement(stmt)) {
        // 1.2: a binary assignment (`lhs = rhs`, `+=`, …) emits an `assignment` node. Variable
        // declarations (`let x = …`) stay on the addStatement path (don't over-emit on inits).
        this.addAssignment(stmt, env);
      } else {
        this.addStatement(stmt, env);
      }
    } catch {
      // Tolerant + lossy: a malformed compound statement degrades to skipping its body, never throws.
    }
  }

  private walkIf(stmt: ts.IfStatement, env: BodyEnv): void {
    const ifLine = env.lineOf(stmt.getStart());
    const condId = this.condition(stmt.expression.getText(), ifLine, 'THEN', env);
    // THEN branch
    this.walkBody(
      ts.isBlock(stmt.thenStatement) ? [...stmt.thenStatement.statements] : [stmt.thenStatement],
      this.pushGuard(env, condId, 'THEN'),
    );
    // ELSE branch (same condId — one IF contributes ONE condition node; edge carries 'ELSE').
    if (stmt.elseStatement) {
      this.walkBody(
        ts.isBlock(stmt.elseStatement) ? [...stmt.elseStatement.statements] : [stmt.elseStatement],
        this.pushGuard(env, condId, 'ELSE'),
      );
    }
  }

  private walkLoop(stmt: ts.Statement, env: BodyEnv, predicate: ts.Expression | undefined): void {
    const line = env.lineOf(stmt.getStart());
    const condId = predicate ? this.condition(predicate.getText(), line, 'LOOP', env) : undefined;
    const loopEnv: BodyEnv = {
      ...env,
      ...(condId ? this.pushGuard(env, condId, 'LOOP') : {}),
      inLoop: true,
    };
    // IterationStatement stores its body as `.statement` (not `.body`) in the TS compiler AST.
    const body = (stmt as ts.IterationStatement).statement;
    if (body) {
      this.walkBody(ts.isBlock(body) ? [...body.statements] : [body], loopEnv);
    }
  }

  private walkTry(stmt: ts.TryStatement, env: BodyEnv): void {
    // try/catch/finally sets inException=true on every body (try + catch + finally); no condition is
    // pushed (try has no predicate). Mirrors PlSqlExtractor.walkException's env choice.
    const tryEnv: BodyEnv = { ...env, inException: true };
    if (stmt.tryBlock) this.walkBody([...stmt.tryBlock.statements], tryEnv);
    // TS models a single catchClause per try (best-effort: one typed handler — lossy but never throws).
    if (stmt.catchClause) {
      const catchLine = env.lineOf(stmt.catchClause.getStart());
      const selector = catchSelector(stmt.catchClause);
      const excId = this.exceptionHandler(catchLine, selector, env);
      // capture nodes emitted inside the handler so we can link `handles` to each (statement/
      // assignment/raise) — same shape as PlSqlExtractor.walkException.
      const before = env.nodes.length;
      if (stmt.catchClause.block) {
        this.walkBody([...stmt.catchClause.block.statements], tryEnv);
      }
      const handled = env.nodes
        .slice(before)
        .filter((n) => n.kind === 'statement' || n.kind === 'assignment' || n.kind === 'raise');
      for (const target of handled) {
        env.edges.push({
          id: edgeId(excId, target.id, 'handles'),
          src: excId,
          dst: target.id,
          rel: 'handles',
          method: 'static',
          provenance: 'EXTRACTED',
          confidence: 1,
          evidence: { by: this.name, snippet: selector ?? 'catch' },
        });
      }
    }
    if (stmt.finallyBlock) this.walkBody([...stmt.finallyBlock.statements], tryEnv);
  }

  private walkSwitch(stmt: ts.SwitchStatement, env: BodyEnv): void {
    // 1.2: each `case <expr>:` emits a `case-branch` node (whenSelector = the case expression text)
    // + an `executes` edge (proc → case-branch) and becomes the guard for its body. The `default`
    // clause walks under the inherited guard (no case-branch node, mirroring PL/SQL's ELSE).
    for (const c of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(c) && c.expression) {
        const caseLine = env.lineOf(c.getStart());
        const selector = caseSelector(c.expression);
        const branchId = this.caseBranch(caseLine, selector, env);
        this.walkBody([...c.statements], this.pushGuard(env, branchId, 'CASE'));
      } else if (ts.isDefaultClause(c)) {
        this.walkBody([...c.statements], env);
      }
    }
  }

  /** Emit a statement node for an action line (call/return/throw/assign-with-call) + executes edge. */
  private addStatement(stmt: ts.Statement, env: BodyEnv): void {
    const line = env.lineOf(stmt.getStart());
    const info = actionInfo(stmt);
    if (!info) return; // not an action line — keep the graph lean (no node for plain declarations)
    const id = env.ctx.idFor('statement', { file: env.path, line });
    if (!env.stmtSeen.has(id)) {
      env.stmtSeen.add(id);
      env.nodes.push({
        id,
        kind: 'statement',
        type: info.type,
        expr: info.expr,
        file: env.path,
        span: { start: line, end: line },
        lang: env.lang,
        hash: env.ctx.hash(`${env.path}:${line}:${info.type}`),
        meta: {
          head: info.head,
          inLoop: env.inLoop,
          inException: env.inException,
          branch: env.guardStack.length > 0 ? 'GUARDED' : undefined,
        },
      });
    }
    // executes: proc → statement, carrying the full guard chain.
    const gf = TypeScriptExtractor.guardFields(
      env.guardStack,
      env.branch,
      env.inLoop,
      env.inException,
    );
    env.edges.push({
      id: edgeId(env.procId, id, 'executes'),
      src: env.procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name, snippet: info.head },
      ...gf,
    });
    // record + annotate every call expression within this action (best-effort, last-wins per callee).
    for (const call of callsWithin(stmt)) {
      this.recordCall(call, env, gf);
    }
    // guarded-by: statement → innermost enclosing condition.
    if (env.guardStack.length > 0) {
      const guard = env.guardStack[env.guardStack.length - 1];
      if (guard !== undefined) {
        env.edges.push({
          id: edgeId(id, guard, 'guarded-by'),
          src: id,
          dst: guard,
          rel: 'guarded-by',
          method: 'static',
          provenance: 'EXTRACTED',
          confidence: 1,
          evidence: { by: this.name, snippet: info.head },
        });
      }
    }
  }

  /** Record a call site on the proc's meta.calls + annotate the (proc→callee) calls edge. */
  private recordCall(call: ts.CallExpression, env: BodyEnv, gf: GuardFields): void {
    const callee = calleeIdentifier(call.expression);
    if (!callee) return;
    const line = env.lineOf(call.getStart());
    // The call SITE is recorded regardless of whether it resolves: an unresolved call is real
    // information (it is what `gaps` reports), and suppressing it would hide the very coverage
    // limit this fix makes honest.
    env.sites.push({ callee: callee.name, line });
    const calleeId = resolveCallee(callee, call, env.byKey, env.bareCallable);
    if (calleeId && calleeId !== env.procId) {
      // last-wins: a callee called in two branches keeps the last site's guard fields.
      env.calls.set(calleeId, gf);
    }
  }

  // --- 1.2 behavior-bearing nodes (raise / exception-handler / assignment / case-branch) --------
  // Each mirrors the PlSqlExtractor counterpart: deterministic id via ctx.idFor(kind, {file,line}),
  // method:'static', provenance:'EXTRACTED', confidence:1, guard-chain stamped from env.

  /** 1.2: a `throw <expr>` emits a `raise` node + a `raises` edge (proc → raise). errorMessage is
   *  the best-effort thrown text (`new Error("x")` → `x`); errorCode only if a literal 2nd arg is
   *  identifiable (rare in TS). Guarded-by the innermost condition when inside a guarded branch. */
  private addRaise(stmt: ts.ThrowStatement, env: BodyEnv): void {
    const line = env.lineOf(stmt.getStart());
    const id = env.ctx.idFor('raise', { file: env.path, line });
    const expr = stmt.expression;
    const message = expr ? throwMessage(expr) : undefined;
    const code = expr ? throwCode(expr) : undefined;
    if (!env.behaviorSeen.has(id)) {
      env.behaviorSeen.add(id);
      env.nodes.push({
        id,
        kind: 'raise',
        file: env.path,
        span: { start: line, end: line },
        lang: env.lang,
        hash: env.ctx.hash(`${env.path}:${line}:raise:${message ?? ''}`),
        ...(message !== undefined ? { errorMessage: message } : {}),
        ...(code !== undefined ? { errorCode: code } : {}),
        meta: { inLoop: env.inLoop, inException: env.inException },
      });
    }
    // raises: proc → raise node (the error this action can raise).
    env.edges.push({
      id: edgeId(env.procId, id, 'raises'),
      src: env.procId,
      dst: id,
      rel: 'raises',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name, snippet: message ?? 'throw' },
    });
    // guarded-by the innermost enclosing condition (consistent with addStatement).
    this.linkGuard(id, 'throw', env);
  }

  /** 1.2: a binary assignment (`lhs = rhs`, `+=`, …) emits an `assignment` node (assignTarget = LHS
   *  text) + an `executes` edge carrying the guard chain + guarded-by. Calls on the RHS are still
   *  recorded so `calls` edges fire. Variable declarations are NOT routed here (capability-honest). */
  private addAssignment(stmt: ts.ExpressionStatement, env: BodyEnv): void {
    const line = env.lineOf(stmt.getStart());
    const id = env.ctx.idFor('assignment', { file: env.path, line });
    const bin = stmt.expression as ts.BinaryExpression;
    const target = truncate(bin.left.getText(), EXPR_MAX_CHARS);
    // capture the FULL assignment text (`lhs op rhs`) as `expr` so the scoring formula on the RHS
    // survives into the graph — parity with PL/SQL, which captures the RHS. Without this a TS
    // assignment carried only its LHS target and the formula was lost.
    if (!env.behaviorSeen.has(id)) {
      env.behaviorSeen.add(id);
      env.nodes.push({
        id,
        kind: 'assignment',
        assignTarget: target,
        ...exprFields(stmt.getText()),
        file: env.path,
        span: { start: line, end: line },
        lang: env.lang,
        hash: env.ctx.hash(`${env.path}:${line}:assign:${target}`),
        meta: { inLoop: env.inLoop, inException: env.inException },
      });
    }
    const gf = TypeScriptExtractor.guardFields(
      env.guardStack,
      env.branch,
      env.inLoop,
      env.inException,
    );
    env.edges.push({
      id: edgeId(env.procId, id, 'executes'),
      src: env.procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name, snippet: target },
      ...gf,
    });
    // record every call on the RHS so calls edges + meta.calls still fire for `x = foo()`.
    for (const call of callsWithin(stmt)) this.recordCall(call, env, gf);
    this.linkGuard(id, target, env);
  }

  /** 1.2: emit a deduped `case-branch` node (whenSelector = the case expression) + an `executes`
   *  edge (proc → case-branch) and return its id for use as the body's guard. */
  private caseBranch(line: number, selector: string, env: BodyEnv): string {
    const id = env.ctx.idFor('case-branch', { file: env.path, line });
    if (!env.behaviorSeen.has(id)) {
      env.behaviorSeen.add(id);
      env.nodes.push({
        id,
        kind: 'case-branch',
        branch: 'CASE',
        ...exprFields(selector),
        whenSelector: truncate(selector, EXPR_MAX_CHARS),
        file: env.path,
        span: { start: line, end: line },
        lang: env.lang,
        hash: env.ctx.hash(`${env.path}:case:${line}:${selector}`),
      });
      // executes: proc → case-branch (the callable dispatches into this branch).
      env.edges.push({
        id: edgeId(env.procId, id, 'executes'),
        src: env.procId,
        dst: id,
        rel: 'executes',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name, snippet: selector },
      });
    }
    return id;
  }

  /** 1.2: emit a deduped `exception-handler` node (whenSelector = the caught type if annotated) and
   *  return its id. The selector is omitted for an untyped `catch (e)` / `catch {` (capability-honest). */
  private exceptionHandler(line: number, selector: string | undefined, env: BodyEnv): string {
    const id = env.ctx.idFor('exception-handler', { file: env.path, line });
    if (!env.behaviorSeen.has(id)) {
      env.behaviorSeen.add(id);
      env.nodes.push({
        id,
        kind: 'exception-handler',
        ...(selector !== undefined ? { whenSelector: selector } : {}),
        file: env.path,
        span: { start: line, end: line },
        lang: env.lang,
        hash: env.ctx.hash(`${env.path}:exc:${line}:${selector ?? ''}`),
      });
    }
    return id;
  }

  /** Stamp a `guarded-by` edge from a behavior node to the innermost enclosing condition. */
  private linkGuard(srcId: string, snippet: string, env: BodyEnv): void {
    if (env.guardStack.length === 0) return;
    const guard = env.guardStack[env.guardStack.length - 1];
    if (guard === undefined) return;
    env.edges.push({
      id: edgeId(srcId, guard, 'guarded-by'),
      src: srcId,
      dst: guard,
      rel: 'guarded-by',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name, snippet },
    });
  }

  /** Emit a deduped condition node (keyed by file+line) and return its id. */
  private condition(expr: string, line: number, branch: string, env: BodyEnv): string {
    const id = env.ctx.idFor('condition', { file: env.path, line });
    if (!env.condSeen.has(id)) {
      env.condSeen.add(id);
      env.nodes.push({
        id,
        kind: 'condition',
        branch,
        ...exprFields(expr),
        file: env.path,
        span: { start: line, end: line },
        lang: env.lang,
        hash: env.ctx.hash(`${env.path}:${line}:${expr}`),
      });
    }
    return id;
  }

  /** Push a guard onto the stack by VALUE so sibling branches don't pollute each other. */
  private pushGuard(env: BodyEnv, condId: string, branch: string): BodyEnv {
    return { ...env, guardStack: [...env.guardStack, condId], branch };
  }
}

// ---------------------------------------------------------------------------
// body-walk helpers (module-scope, no `this`)
// ---------------------------------------------------------------------------

interface GuardFields {
  cfgPath: string[];
  guard?: string;
  branch?: string;
  inLoop: boolean;
  inException: boolean;
}

interface BodyEnv {
  procId: string;
  byKey: Map<string, string>;
  /** top-level-only name map: what a BARE `foo()` is allowed to reach (see resolveCallee). */
  bareCallable: Map<string, string>;
  lineOf: (pos: number) => number;
  nodes: Node[];
  edges: Edge[];
  calls: Map<string, GuardFields>;
  sites: Array<{ callee: string; line: number }>;
  condSeen: Set<string>;
  stmtSeen: Set<string>;
  /** 1.2: dedup set for raise/exception-handler/assignment/case-branch node ids. */
  behaviorSeen: Set<string>;
  path: string;
  ctx: ExtractCtx;
  guardStack: string[];
  /** polarity of the INNERMOST condition on the stack (THEN/ELSIF/ELSE/LOOP/CASE), or undefined. */
  branch: string | undefined;
  inLoop: boolean;
  inException: boolean;
  /** M2.5 — `lang` tag stamped on every body-walk node ('typescript' | 'javascript'). */
  lang: 'typescript' | 'javascript';
}

/** A statement's action descriptor: one per action line (call/return/throw/assign-with-call). */
interface ActionInfo {
  type: 'call' | 'return' | 'throw' | 'assign';
  expr: string;
  head: string;
}

/** Return the function-like body to walk for a declaration node, or undefined if not function-like. */
function functionBodyOf(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.body;
  }
  if (ts.isVariableStatement(node)) {
    const d = node.declarationList.declarations[0];
    if (d?.initializer && isFunctionLike(d.initializer)) {
      return d.initializer.body;
    }
  }
  return undefined;
}

/** Is this declaration a function-like symbol whose body we should walk for the decision table? */
function isFunctionLikeSymbol(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    (ts.isVariableStatement(node) &&
      (() => {
        const d = node.declarationList.declarations[0];
        return !!(d?.initializer && isFunctionLike(d.initializer));
      })())
  );
}

/** Classify a statement as an action line (call/return/throw/assign-with-call), or undefined. */
function actionInfo(stmt: ts.Statement): ActionInfo | undefined {
  const text = truncate(stmt.getText(), EXPR_MAX_CHARS);
  if (ts.isReturnStatement(stmt)) {
    return { type: 'return', expr: text, head: 'return' };
  }
  if (ts.isThrowStatement(stmt)) {
    return { type: 'throw', expr: text, head: 'throw' };
  }
  if (ts.isExpressionStatement(stmt)) {
    const expr = stmt.expression;
    if (ts.isCallExpression(expr)) {
      return { type: 'call', expr: text, head: calleeIdentifier(expr)?.name ?? 'call' };
    }
    // assignment with a call on the RHS (`x = foo()`, `x.y = foo()`) — surface the call.
    if (isAssignmentWithCall(expr)) {
      const callee = firstCallWithin(expr);
      return {
        type: 'assign',
        expr: text,
        head: callee ? (calleeIdentifier(callee)?.name ?? 'call') : 'assign',
      };
    }
  }
  if (ts.isVariableStatement(stmt)) {
    // `const x = foo();` — an assignment-with-call initializer; surface the call.
    const d = stmt.declarationList.declarations[0];
    if (d?.initializer && containsCall(d.initializer)) {
      const callee = firstCallWithin(d.initializer);
      return {
        type: 'assign',
        expr: text,
        head: callee ? (calleeIdentifier(callee)?.name ?? 'call') : 'assign',
      };
    }
  }
  return undefined;
}

/** Is `expr` an assignment (binary `=` or compound-assign) whose RHS contains a call? */
function isAssignmentWithCall(expr: ts.Expression): boolean {
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return containsCall(expr.right);
  }
  return false;
}

/** Does this expression tree contain any CallExpression? */
function containsCall(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) return true;
  let found = false;
  ts.forEachChild(node, (c) => {
    if (!found) found = containsCall(c);
  });
  return found;
}

/** The first CallExpression within this expression tree (pre-order), or undefined. */
function firstCallWithin(node: ts.Node): ts.CallExpression | undefined {
  if (ts.isCallExpression(node)) return node;
  let found: ts.CallExpression | undefined;
  ts.forEachChild(node, (c) => {
    if (!found) found = firstCallWithin(c);
  });
  return found;
}

/** All CallExpressions within a statement (used to record every call site on an action line). */
function callsWithin(stmt: ts.Statement): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(stmt, walk);
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Spread an `expr` field plus its `exprTruncated` honesty flag from a raw expression string. */
function exprFields(raw: string | undefined): { expr?: string; exprTruncated?: true } {
  if (!raw) return {};
  const { expr, truncated } = clampExpr(raw);
  return truncated ? { expr, exprTruncated: true } : { expr };
}

// ---------------------------------------------------------------------------
// 1.2 helpers — comment collection + throw/catch/assignment classification
// ---------------------------------------------------------------------------

/** One retained TS comment block with its 1-based inclusive line span + cleaned text. */
interface CommentBlock {
  start: number;
  end: number;
  text: string;
}

/**
 * Collect TS comment blocks (`//` line runs and slash-star block comments, incl. JSDoc) from source.
 * Contiguous `//` lines merge into one block; each slash-star block is its own block. Markers
 * (`//`, `/*`, star-slash, leading `*`) are stripped and each line is trimmed; the block text is the
 * lines joined by a newline. Pure line-scan, deterministic, never throws. Mirrors PlSql lexer.
 */
function collectTsComments(src: string): CommentBlock[] {
  const out: CommentBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.startsWith('//')) {
      const start = i + 1;
      const parts: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('//')) {
        parts.push((lines[i] ?? '').trim().replace(/^\/\//, '').trim());
        i++;
      }
      out.push({ start, end: i, text: parts.join('\n') });
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const start = i + 1;
      // single-line block comment closes on the same line
      if (trimmed.endsWith('*/') && trimmed.length > 2) {
        out.push({ start, end: start, text: stripBlockLine(trimmed) });
        i++;
        continue;
      }
      const parts: string[] = [stripBlockLine(trimmed)];
      i++;
      while (i < lines.length) {
        const lt = (lines[i] ?? '').trim();
        if (lt.endsWith('*/')) {
          parts.push(stripBlockLine(lt));
          i++;
          break;
        }
        parts.push(stripBlockLine(lt));
        i++;
      }
      out.push({ start, end: i, text: parts.filter((p) => p.length > 0).join('\n') });
      continue;
    }
    i++;
  }
  return out;
}

/** Strip slash-star open, star-slash close, and a leading `*` (JSDoc continuation) from one line. */
function stripBlockLine(line: string): string {
  return line
    .replace(/^\/\*+\*?/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\s*\*/, '')
    .trim();
}

/** Best-effort error message for a `throw <expr>`: `new Error("x")` → "x"; `throw "m"` → "m"; else raw. */
function throwMessage(expr: ts.Expression): string {
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNewExpression(expr) && expr.arguments) {
    const first = expr.arguments[0];
    if (first && ts.isStringLiteral(first)) return first.text;
  }
  return truncate(expr.getText(), EXPR_MAX_CHARS);
}

/** Error code only when a literal 2nd arg to `new Error(msg, code)` is identifiable (rare in TS). */
function throwCode(expr: ts.Expression): string | undefined {
  if (ts.isNewExpression(expr) && expr.arguments && expr.arguments.length >= 2) {
    const second = expr.arguments[1];
    if (second && (ts.isStringLiteral(second) || ts.isNumericLiteral(second))) {
      return second.getText();
    }
  }
  return undefined;
}

/** The caught type's name for `catch (e: FooError)` → "FooError"; untyped `catch (e)`/`catch {` → undefined. */
function catchSelector(cc: ts.CatchClause): string | undefined {
  const p = cc.variableDeclaration;
  if (!p || !p.type) return undefined;
  if (ts.isTypeReferenceNode(p.type)) return p.type.typeName.getText();
  return undefined;
}

/** A switch case's selector value: `case 'card':` → `card` (string literal unquoted); else raw text. */
function caseSelector(expr: ts.Expression): string {
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return expr.text;
  return truncate(expr.getText(), EXPR_MAX_CHARS);
}

/** Is this statement a binary assignment (`lhs = rhs`, `+=`, …) at expression-statement level? */
function isAssignmentStatement(stmt: ts.Statement): stmt is ts.ExpressionStatement {
  if (!ts.isExpressionStatement(stmt)) return false;
  const e = stmt.expression;
  if (!ts.isBinaryExpression(e)) return false;
  return ASSIGN_OPS.has(e.operatorToken.kind);
}

/** TS compound-assignment + simple-assignment operator kinds. */
const ASSIGN_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

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

function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
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

/**
 * The callee name and receiver shape, which decide what it may legitimately resolve to.
 *
 * `foo()` and `this.foo()` are not interchangeable: a bare identifier can never reach a class
 * member, and a property access can never reach a local binding. Collapsing both to a bare name
 * (as this did) let a bare `now()` bind to a class property `FreshnessWorker.now` at confidence 1
 * — audit F11.
 */
function calleeIdentifier(
  expr: ts.Expression,
): { name: string; viaProperty: boolean; receiver?: ts.Expression } | undefined {
  if (ts.isIdentifier(expr)) return { name: expr.text, viaProperty: false };
  if (ts.isPropertyAccessExpression(expr)) {
    return { name: expr.name.text, viaProperty: true, receiver: expr.expression };
  }
  return undefined;
}

/**
 * Resolve one call to a same-file symbol id, or `undefined` when it cannot be resolved HONESTLY.
 *
 * Two rules, both of which the audited resolver lacked:
 *   - a bare `foo()` may only reach a top-level symbol, never a class member;
 *   - a bare `foo()` whose name is bound locally (parameter, local var, nested function) resolves
 *     to nothing, because the target is a value this syntactic pass cannot follow.
 *
 * Property calls resolve only when their receiver has a syntactically provable local type. This
 * covers `this.foo()`, `Class.foo()`, typed parameters, `new Class()` locals, and typed `this`
 * properties. Dynamic receivers deliberately remain unresolved rather than borrowing the first
 * same-named method from `byKey`.
 */
function resolveCallee(
  callee: { name: string; viaProperty: boolean; receiver?: ts.Expression },
  node: ts.Node,
  byKey: Map<string, string>,
  bareCallable: Map<string, string>,
): string | undefined {
  if (callee.viaProperty) {
    const receiverType = callee.receiver
      ? receiverTypeName(node, callee.receiver, byKey)
      : undefined;
    return receiverType ? byKey.get(`${receiverType}.${callee.name}`) : undefined;
  }
  if (isLocallyBound(node, callee.name)) return undefined;
  return bareCallable.get(callee.name);
}

/** Infer the simple same-file type of a property-call receiver from syntax alone. */
function receiverTypeName(
  node: ts.Node,
  receiver: ts.Expression,
  byKey: Map<string, string>,
): string | undefined {
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return enclosingClassName(node);

  if (ts.isIdentifier(receiver)) {
    const local = localBindingType(node, receiver.text);
    if (local) return local;
    // `Clock.now()` is safe only when `Clock` names a same-file class and is not shadowed locally.
    if (!isLocallyBound(node, receiver.text) && byKey.has(receiver.text)) return receiver.text;
    return undefined;
  }

  // `this.clock.now()` — infer `clock` from a property or constructor parameter declaration.
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return classPropertyType(node, receiver.name.text);
  }
  return undefined;
}

function enclosingClassName(node: ts.Node): string | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if ((ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) && cur.name) {
      return cur.name.text;
    }
  }
  return undefined;
}

/** Find a visible parameter or direct block variable and extract its explicit/initializer type. */
function localBindingType(node: ts.Node, name: string): string | undefined {
  const callPos = node.getStart();
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) {
      const param = cur.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (param) return declaredTypeName(param.type, param.initializer);
    }
    if (ts.isBlock(cur) || ts.isSourceFile(cur)) {
      for (const statement of cur.statements) {
        if (statement.getStart() >= callPos || !ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return declaredTypeName(declaration.type, declaration.initializer);
          }
        }
      }
    }
  }
  return undefined;
}

/** Resolve `this.member` from a class property or a constructor parameter property. */
function classPropertyType(node: ts.Node, name: string): string | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isClassDeclaration(cur) && !ts.isClassExpression(cur)) continue;
    for (const member of cur.members) {
      if (ts.isPropertyDeclaration(member) && member.name?.getText() === name) {
        return declaredTypeName(member.type, member.initializer);
      }
      if (ts.isConstructorDeclaration(member)) {
        const param = member.parameters.find(
          (p) => ts.isIdentifier(p.name) && p.name.text === name,
        );
        if (param) return declaredTypeName(param.type, param.initializer);
      }
    }
    return undefined;
  }
  return undefined;
}

function declaredTypeName(
  type: ts.TypeNode | undefined,
  initializer: ts.Expression | undefined,
): string | undefined {
  if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    return type.typeName.text;
  }
  if (initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
    return initializer.expression.text;
  }
  if (
    initializer &&
    (ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer)) &&
    ts.isTypeReferenceNode(initializer.type) &&
    ts.isIdentifier(initializer.type.typeName)
  ) {
    return initializer.type.typeName.text;
  }
  return undefined;
}

/**
 * Is `name` bound by a LOCAL declaration enclosing `node` (parameter, local var/const/let, nested
 * function, catch binding, or an import alias)?
 *
 * A call to a locally bound name targets a VALUE, and knowing which function that value holds needs
 * type inference this syntactic extractor does not do. The honest answer is therefore "unresolved"
 * — the call still appears in `meta.calls` and in the `gaps` report — rather than a confident edge
 * to whatever file-level symbol happens to share the name. That was the audited defect: the `now`
 * PARAMETER of `enqueueFreshness` produced a confidence-1 edge to two unrelated `now` symbols.
 *
 * The walk stops before the SourceFile: top-level declarations are the file's real symbols and are
 * exactly what a bare call SHOULD resolve to.
 */
function isLocallyBound(node: ts.Node, name: string): boolean {
  for (let cur = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
    if (declaresName(cur, name)) return true;
  }
  return false;
}

/** Does this single scope-bearing node declare `name`? */
function declaresName(scope: ts.Node, name: string): boolean {
  // function-like: parameters and (for a named function expression) its own name
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) {
      if (ts.isIdentifier(p.name) && p.name.text === name) return true;
      // destructured parameters bind names too: ({ now }) => now()
      if (!ts.isIdentifier(p.name) && bindingDeclares(p.name, name)) return true;
    }
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    const v = scope.variableDeclaration.name;
    if (ts.isIdentifier(v) ? v.text === name : bindingDeclares(v, name)) return true;
  }
  // statement lists: local variable and nested function declarations
  const statements = ts.isBlock(scope)
    ? scope.statements
    : ts.isSourceFile(scope)
      ? scope.statements
      : undefined;
  if (statements) {
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) ? d.name.text === name : bindingDeclares(d.name, name)) {
            return true;
          }
        }
      }
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return true;
    }
  }
  return false;
}

/** Does a destructuring pattern bind `name`? */
function bindingDeclares(pattern: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(pattern)) return pattern.text === name;
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (bindingDeclares(el.name, name)) return true;
  }
  return false;
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
