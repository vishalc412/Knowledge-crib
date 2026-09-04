/**
 * PDG layer (Gate 5.2) — per-callable control-flow reconstruction + post-dominator analysis.
 *
 * WHY a fresh CFG walk over the SAME TypeScript compiler the parsers package uses (`createSourceFile`,
 * syntactic only, no type-checker, no network): the persisted graph deliberately keeps a LEAN
 * behavior layer (action lines only — call / return / throw / assignment), so call-free
 * declarations (`const q = req.query.q`) never reach the graph and identifier-level def-use is
 * impossible from committed artifacts alone. Rather than weaken def-use until it misses the
 * canonical `const x = <source>; sink(x)` shape, the PDG re-reads the file ON DEMAND with the
 * existing compiler and reconstructs the structured CFG itself (if/else, loops, switch,
 * try/catch/finally, return/break/continue/throw). Nothing here runs at index time.
 *
 * Control dependence is the Ferrante-Ottenstein-Warren rule computed on this CFG: B is
 * control-dependent on A iff A has ≥2 successors and B post-dominates some successor of A but not
 * A itself. Self-dependence (a loop condition depending on itself) is kept — it is the standard
 * result for loop predicates and it is what lets taint flow into loop bodies.
 */
import ts from 'typescript';

/** One node of the reconstructed CFG. `defs`/`uses` feed the data-dependence pass; `text` is the
 *  raw statement text the taint rule table is matched against. */
export interface PdgNode {
  id: number;
  kind: 'entry' | 'exit' | 'stmt' | 'cond';
  /** 1-based source line (0 for entry/exit, which are synthetic). */
  line: number;
  text: string;
  defs: readonly string[];
  uses: readonly string[];
}

/** A CFG-flow or dependence edge. `rel` doubles as the taint-path label. */
export interface PdgEdge {
  src: number;
  dst: number;
  rel: 'flow' | 'back' | 'branch' | 'exception' | 'control';
}

/** The CFG + control-dependence half of the PDG; the reaching-definitions pass (defuse.ts) adds
 *  `data` and `reaching` on top of this shape to complete the graph. */
export interface ControlPdg {
  nodes: readonly PdgNode[];
  succ: ReadonlyMap<number, readonly number[]>;
  /** every CFG edge with its relation (`control` excluded — see `control`) */
  edges: readonly PdgEdge[];
  entry: number;
  exit: number;
  /** control-dependence edges (branch node → node whose execution it decides) */
  control: readonly PdgEdge[];
  /** node ids reachable from entry; unreachable syntax is excluded from every result */
  reachable: ReadonlySet<number>;
}

/** Node id → variable → node ids of the definitions of that variable that reach the node. */
export type Reaching = ReadonlyMap<number, ReadonlyMap<string, readonly number[]>>;

/** The complete per-callable PDG: CFG flow edges + control- and data-dependence edges. */
export interface Pdg extends ControlPdg {
  /** data-dependence edges (def site → use site), from the reaching-definitions pass */
  data: readonly PdgEdge[];
  /** per-node reaching definitions from the same pass */
  reaching: Reaching;
}

interface Fragment {
  /** first node, or null when the statement cannot fall through (return/throw/break/continue) */
  entry: number | null;
  /**
   * Node ids whose outgoing edge is still open — chained to the next fragment / loop exit. A
   * loop/switch fragment lists its body's `break` ids here too: the parent chain wires every open
   * exit to whatever follows, which for a break IS the loop exit. That single invariant replaces
   * separate break-bubbling machinery.
   */
  exits: number[];
}

/** Build the CFG + control dependence for one function-like body. */
export function buildControlPdg(fn: ts.FunctionLikeDeclaration): ControlPdg {
  const b = new Builder(fn);
  const frag =
    fn.body && !ts.isBlock(fn.body)
      ? (() => {
          // arrow / function-expression with an expression body: one synthetic statement node
          const n = b.exprBody(fn.body);
          return { entry: n as number | null, exits: [n] } as Fragment;
        })()
      : b.seq(fn.body ? [...(fn.body as ts.Block).statements] : []);
  if (frag.entry !== null) b.edge(b.entryId, frag.entry, 'flow');
  for (const e of frag.exits) b.edge(e, b.exitId, 'flow');
  return analyze(b.nodes, b.succ, b.edges(), b.entryId, b.exitId);
}

class Builder {
  // exposed to buildControlPdg's analyze() call: same-module construction data, not a public API
  readonly nodes: PdgNode[] = [];
  readonly succ = new Map<number, number[]>();
  private readonly edgeList: PdgEdge[] = [];
  private nextId = 0;
  readonly entryId: number;
  readonly exitId: number;
  /** loop scopes: `continue` jumps to the innermost loop's resume point */
  private continueTargets: number[][] = [];
  /** `break` jumps to the innermost loop-or-switch's exit */
  private breakTargets: number[][] = [];

  constructor(fn: ts.FunctionLikeDeclaration) {
    this.entryId = this.add(
      'entry',
      0,
      'entry',
      fn.parameters.flatMap((p) => collectBindingNames(p.name)),
      [],
    );
    this.exitId = this.add('exit', 0, 'exit', [], []);
  }

  private add(
    kind: PdgNode['kind'],
    line: number,
    text: string,
    defs: readonly string[],
    uses: readonly string[],
  ): number {
    const id = this.nextId++;
    this.nodes.push({ id, kind, line, text, defs, uses });
    this.succ.set(id, []);
    return id;
  }

  edge(src: number, dst: number, rel: PdgEdge['rel']): void {
    if (src === dst) return; // degenerate self-edge from an empty loop body; never useful
    const out = this.succ.get(src);
    if (out && !out.includes(dst)) {
      out.push(dst);
      this.edgeList.push({ src, dst, rel });
    }
  }

  /** All edges built so far (with relations); call once, after the body walk. */
  edges(): readonly PdgEdge[] {
    return this.edgeList;
  }

  /** Build a statement sequence, chaining each fragment's open exits into the next. A terminator
   *  (return/throw/break/continue) closes the straight-line run: whatever follows is unreachable,
   *  is not wired, and the reachability filter drops it. */
  seq(stmts: readonly ts.Statement[]): Fragment {
    let entry: number | null = null;
    let pending: number[] = [];
    let closed = false;
    for (const s of stmts) {
      if (closed) continue; // dead code after a terminator: parsed, deliberately not analyzed
      const f = this.stmt(s);
      if (f.entry === null) continue; // empty block
      if (entry === null) entry = f.entry;
      else for (const e of pending) this.edge(e, f.entry, 'flow');
      pending = f.exits;
      if (pending.length === 0) closed = true; // cannot fall through
    }
    return { entry, exits: pending };
  }

  private stmt(s: ts.Statement): Fragment {
    if (ts.isIfStatement(s)) return this.ifStmt(s);
    if (ts.isWhileStatement(s)) return this.whileLoop(s);
    if (ts.isDoStatement(s)) return this.doLoop(s);
    if (ts.isForStatement(s)) return this.forLoop(s);
    if (ts.isForInStatement(s) || ts.isForOfStatement(s)) return this.forEachLoop(s);
    if (ts.isSwitchStatement(s)) return this.switchStmt(s);
    if (ts.isTryStatement(s)) return this.tryStmt(s);
    if (ts.isBlock(s)) return this.seq([...s.statements]);
    if (ts.isLabeledStatement(s)) return this.stmt(s.statement); // label semantics unsupported; walk through
    if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return this.exitStmt(s);
    if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) return this.jumpStmt(s);
    return this.plain(s);
  }

  /** A plain statement: variable declarations, expression statements, etc. */
  private plain(s: ts.Statement): Fragment {
    const n = this.add('stmt', lineOf(s), s.getText(), collectDefs(s), collectUses(s));
    return { entry: n, exits: [n] };
  }

  /** The single-statement node for an arrow/function-expression expression body. */
  exprBody(e: ts.Expression): number {
    return this.add('stmt', lineOf(e), e.getText(), [], collectUses(e));
  }

  /** return/throw: the node IS entered (a branch may target it) but nothing falls through. */
  private exitStmt(s: ts.ReturnStatement | ts.ThrowStatement): Fragment {
    const n = this.add('stmt', lineOf(s), s.getText(), [], collectUses(s));
    this.edge(n, this.exitId, ts.isThrowStatement(s) ? 'exception' : 'flow');
    return { entry: n, exits: [] };
  }

  private jumpStmt(s: ts.BreakStatement | ts.ContinueStatement): Fragment {
    const n = this.add('stmt', lineOf(s), s.getText(), [], []);
    const targets = ts.isBreakStatement(s) ? this.breakTargets : this.continueTargets;
    const top = targets[targets.length - 1];
    if (top) top.push(n);
    else this.edge(n, this.exitId, 'flow'); // invalid JS outside any loop; parse-tolerant
    return { entry: n, exits: [] };
  }

  private ifStmt(s: ts.IfStatement): Fragment {
    const cond = this.add(
      'cond',
      lineOf(s.expression),
      s.expression.getText(),
      [],
      collectUses(s.expression),
    );
    const thenF = this.seq(branchBlock(s.thenStatement));
    if (thenF.entry !== null) this.edge(cond, thenF.entry, 'branch');
    const exits = [...thenF.exits];
    if (s.elseStatement) {
      const elseF = this.seq(branchBlock(s.elseStatement));
      if (elseF.entry !== null) this.edge(cond, elseF.entry, 'branch');
      exits.push(...elseF.exits);
    } else {
      exits.push(cond); // the false path falls through to whatever follows
    }
    return { entry: cond, exits };
  }

  private whileLoop(s: ts.WhileStatement): Fragment {
    const cond = this.add(
      'cond',
      lineOf(s.expression),
      s.expression.getText(),
      [],
      collectUses(s.expression),
    );
    this.continueTargets.push([]);
    this.breakTargets.push([]);
    const bodyF = this.seq(branchBlock(s.statement));
    for (const c of this.continueTargets.pop() ?? []) this.edge(c, cond, 'back');
    const breakIds = this.breakTargets.pop() ?? [];
    if (bodyF.entry !== null) {
      this.edge(cond, bodyF.entry, 'flow');
      for (const e of bodyF.exits) this.edge(e, cond, 'back');
    }
    // exits = the cond fall-through + every break: the parent chain wires them all to the loop exit
    return { entry: cond, exits: [cond, ...breakIds] };
  }

  private doLoop(s: ts.DoStatement): Fragment {
    this.continueTargets.push([]);
    this.breakTargets.push([]);
    const bodyF = this.seq(branchBlock(s.statement));
    const cond = this.add(
      'cond',
      lineOf(s.expression),
      s.expression.getText(),
      [],
      collectUses(s.expression),
    );
    for (const c of this.continueTargets.pop() ?? []) this.edge(c, cond, 'back');
    const breakIds = this.breakTargets.pop() ?? [];
    for (const e of bodyF.exits) this.edge(e, cond, 'back');
    if (bodyF.entry !== null) this.edge(cond, bodyF.entry, 'back');
    return { entry: bodyF.entry ?? cond, exits: [cond, ...breakIds] };
  }

  /** `for (init; cond; incr)` — init and increment become their own def/use nodes. */
  private forLoop(s: ts.ForStatement): Fragment {
    const init = s.initializer ? this.headerNode(s.initializer) : null;
    const cond = s.condition
      ? this.add('cond', lineOf(s.condition), s.condition.getText(), [], collectUses(s.condition))
      : null;
    this.continueTargets.push([]);
    this.breakTargets.push([]);
    const bodyF = this.seq(branchBlock(s.statement));
    const continues = this.continueTargets.pop() ?? [];
    const breakIds = this.breakTargets.pop() ?? [];
    const incr = s.incrementor ? this.headerNode(s.incrementor) : null;
    const resume = incr ?? cond ?? bodyF.entry; // where `continue` re-enters the loop
    const loopBack = incr ?? cond ?? bodyF.entry; // where the body ends up each pass
    if (init !== null) this.edge(init, cond ?? incr ?? bodyF.entry ?? this.exitId, 'flow');
    if (cond !== null && bodyF.entry !== null) this.edge(cond, bodyF.entry, 'flow');
    for (const e of bodyF.exits) if (loopBack !== null) this.edge(e, loopBack, 'back');
    for (const c of continues) if (resume !== null) this.edge(c, resume, 'back');
    if (incr !== null) this.edge(incr, cond ?? bodyF.entry ?? this.exitId, 'back');
    return {
      entry: init ?? cond ?? bodyF.entry,
      exits: cond ? [cond, ...breakIds] : [...breakIds],
    };
  }

  private forEachLoop(s: ts.ForInOrOfStatement): Fragment {
    const header = this.headerNode(s.initializer, s.expression);
    this.continueTargets.push([]);
    this.breakTargets.push([]);
    const bodyF = this.seq(branchBlock(s.statement));
    for (const c of this.continueTargets.pop() ?? []) this.edge(c, header, 'back');
    const breakIds = this.breakTargets.pop() ?? [];
    if (bodyF.entry !== null) {
      this.edge(header, bodyF.entry, 'flow');
      for (const e of bodyF.exits) this.edge(e, header, 'back');
    }
    return { entry: header, exits: [header, ...breakIds] };
  }

  private switchStmt(s: ts.SwitchStatement): Fragment {
    const disc = this.add(
      'cond',
      lineOf(s.expression),
      s.expression.getText(),
      [],
      collectUses(s.expression),
    );
    this.breakTargets.push([]);
    let pending: number[] = [];
    let hasDefault = false;
    for (const c of s.caseBlock.clauses) {
      let first: number | null = null;
      const open: number[] = [];
      if (ts.isCaseClause(c)) {
        const g = this.add(
          'cond',
          lineOf(c),
          `case ${c.expression?.getText() ?? ''}`,
          [],
          c.expression ? collectUses(c.expression) : [],
        );
        this.edge(disc, g, 'branch');
        const bodyF = this.seq([...c.statements]);
        if (bodyF.entry !== null) this.edge(g, bodyF.entry, 'flow');
        first = g;
        open.push(g); // the guard's false path flows onward to the next clause
        open.push(...bodyF.exits); // body fall-through
      } else {
        hasDefault = true;
        const bodyF = this.seq([...c.statements]);
        if (bodyF.entry !== null) this.edge(disc, bodyF.entry, 'flow');
        first = bodyF.entry;
        open.push(...bodyF.exits);
      }
      // conservative fall-through: the previous clause's open exits enter this clause
      if (first !== null) for (const e of pending) this.edge(e, first, 'flow');
      // an empty default clause falls through to the switch exit; keep the pending flow open
      pending = first === null ? pending : open;
    }
    const breakIds = this.breakTargets.pop() ?? [];
    return { entry: disc, exits: [...pending, ...(hasDefault ? [] : [disc]), ...breakIds] };
  }

  private tryStmt(s: ts.TryStatement): Fragment {
    const tryF = this.seq([...(s.tryBlock?.statements ?? [])]);
    let catchF: Fragment | null = null;
    if (s.catchClause) {
      const bind = s.catchClause.variableDeclaration;
      const head = bind
        ? this.add(
            'stmt',
            lineOf(s.catchClause),
            `catch (${bind.name.getText()})`,
            collectBindingNames(bind.name),
            [],
          )
        : null;
      const bodyF = this.seq([...(s.catchClause.block?.statements ?? [])]);
      if (head !== null && bodyF.entry !== null) this.edge(head, bodyF.entry, 'flow');
      catchF = {
        entry: head ?? bodyF.entry,
        exits: bodyF.entry !== null ? bodyF.exits : head ? [head] : [],
      };
    }
    const finF = s.finallyBlock ? this.seq([...s.finallyBlock.statements]) : null;
    // the exception path into the handler is conservative: ANY try exit may throw
    if (catchF?.entry != null) for (const e of tryF.exits) this.edge(e, catchF.entry, 'exception');
    if (finF?.entry != null) {
      for (const e of tryF.exits) this.edge(e, finF.entry, 'flow');
      for (const e of catchF?.exits ?? []) this.edge(e, finF.entry, 'flow');
    }
    const exits = finF ? [...finF.exits] : [...tryF.exits, ...(catchF?.exits ?? [])];
    return { entry: tryF.entry ?? finF?.entry ?? null, exits };
  }

  /** A for-initializer / for-increment pseudo-statement: defs and uses only. */
  private headerNode(init: ts.ForInitializer, extra?: ts.Expression): number {
    const defs = ts.isVariableDeclarationList(init)
      ? init.declarations.flatMap((d) => collectBindingNames(d.name))
      : collectDefs(init);
    const text = extra ? `${init.getText()} ${extra.getText()}` : init.getText();
    const uses = [
      ...(ts.isVariableDeclarationList(init) ? [] : collectUses(init)),
      ...(extra ? collectUses(extra) : []),
    ];
    return this.add('stmt', lineOf(init), text, defs, uses);
  }
}

// ─── analysis: reachability, post-dominators, control dependence ─────────────────────────────

function analyze(
  nodes: readonly PdgNode[],
  succ: ReadonlyMap<number, number[]>,
  edges: readonly PdgEdge[],
  entry: number,
  exit: number,
): ControlPdg {
  const reachable = reachableFrom(entry, succ);
  const pdom = postDominators(succ, entry, exit, reachable);
  const control = controlDependence(succ, pdom, reachable);
  return { nodes, succ, edges, entry, exit, control, reachable };
}

function reachableFrom(start: number, succ: ReadonlyMap<number, number[]>): Set<number> {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const n = stack.pop()!;
    for (const s of succ.get(n) ?? []) {
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  return seen;
}

/**
 * Iterative post-dominator sets: pdom(n) = {n} ∪ ⋂ pdom(s) over successors s, iterated to a fix
 * point. Nodes with no onward path (infinite loops) post-dominate only themselves — intersecting
 * over an empty successor set would make them post-dominated by everything and poison the
 * control rule, so the empty case is clamped to {n}.
 */
function postDominators(
  succ: ReadonlyMap<number, number[]>,
  entry: number,
  exit: number,
  reachable: ReadonlySet<number>,
): Map<number, Set<number>> {
  const universe = [...reachable];
  const pdom = new Map<number, Set<number>>();
  for (const n of reachable) pdom.set(n, n === exit ? new Set([exit]) : new Set(universe));
  const order = postOrder(entry, succ, reachable).reverse();
  for (let pass = 0; pass < universe.length + 2; pass++) {
    let changed = false;
    for (const n of order) {
      if (n === exit) continue;
      const succs = (succ.get(n) ?? []).filter((s) => reachable.has(s));
      const merged = new Set<number>([n]);
      if (succs.length > 0) {
        let inter: Set<number> | null = null;
        for (const s of succs) {
          const sp = pdom.get(s) ?? new Set(universe);
          if (inter === null) {
            inter = new Set<number>(sp);
          } else {
            const next = new Set<number>();
            for (const x of inter) if (sp.has(x)) next.add(x);
            inter = next;
          }
        }
        for (const x of inter ?? []) merged.add(x);
      }
      const prev = pdom.get(n)!;
      if (prev.size !== merged.size || [...merged].some((x) => !prev.has(x))) {
        pdom.set(n, merged);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return pdom;
}

/** Post-order of the forward CFG; the caller reverses it for reverse-post-order iteration. */
function postOrder(
  start: number,
  succ: ReadonlyMap<number, number[]>,
  reachable: ReadonlySet<number>,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const visit = (n: number): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const s of succ.get(n) ?? []) if (reachable.has(s)) visit(s);
    out.push(n);
  };
  visit(start);
  return out;
}

/** Ferrante-Ottenstein-Warren control dependence over the post-dominator sets. */
function controlDependence(
  succ: ReadonlyMap<number, number[]>,
  pdom: ReadonlyMap<number, ReadonlySet<number>>,
  reachable: ReadonlySet<number>,
): PdgEdge[] {
  const edges: PdgEdge[] = [];
  const seen = new Set<string>();
  for (const a of reachable) {
    const succs = (succ.get(a) ?? []).filter((s) => reachable.has(s));
    if (succs.length < 2) continue; // control dependence only applies to branch nodes
    const candidates = new Set<number>();
    for (const s of succs) for (const b of pdom.get(s) ?? []) candidates.add(b);
    for (const b of candidates) {
      if (b !== a && (pdom.get(a)?.has(b) ?? false)) continue; // b post-dominates a: not dependent
      const key = `${a}>${b}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({ src: a, dst: b, rel: 'control' });
      }
    }
  }
  return edges;
}

// ─── identifier-level defs / uses (syntactic, conservative) ──────────────────────────────────

/** Names bound by a declaration target: identifiers, array/object destructuring patterns. */
export function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name)) {
    return name.elements.flatMap((e) =>
      ts.isOmittedExpression(e) ? [] : collectBindingNames(e.name),
    );
  }
  if (ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((e) =>
      ts.isBindingElement(e) ? collectBindingNames(e.name) : [],
    );
  }
  return [];
}

/** Variables a statement defines: declarations, assignments, compound assignments, `x++`. */
export function collectDefs(n: ts.Node): string[] {
  if (ts.isVariableStatement(n)) return collectDefs(n.declarationList);
  if (ts.isExpressionStatement(n) || ts.isParenthesizedExpression(n))
    return collectDefs(n.expression);
  if (ts.isVariableDeclarationList(n))
    return n.declarations.flatMap((d) => collectBindingNames(d.name));
  if (ts.isBinaryExpression(n) && isAssignmentOp(n.operatorToken.kind))
    return assignTargets(n.left);
  if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
    return n.operator === ts.SyntaxKind.PlusPlusToken ||
      n.operator === ts.SyntaxKind.MinusMinusToken
      ? assignTargets(n.operand)
      : [];
  }
  return [];
}

function isAssignmentOp(k: ts.SyntaxKind): boolean {
  return (
    k === ts.SyntaxKind.EqualsToken ||
    k === ts.SyntaxKind.PlusEqualsToken ||
    k === ts.SyntaxKind.MinusEqualsToken ||
    k === ts.SyntaxKind.AsteriskEqualsToken ||
    k === ts.SyntaxKind.SlashEqualsToken ||
    k === ts.SyntaxKind.PercentEqualsToken ||
    k === ts.SyntaxKind.AmpersandEqualsToken ||
    k === ts.SyntaxKind.BarEqualsToken ||
    k === ts.SyntaxKind.CaretEqualsToken ||
    k === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    k === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

/** Assignment targets: the identifier itself, the base object of a member write (conservative —
 *  `obj.f = v` is treated as redefining `obj`), or every bound name of a destructuring pattern. */
function assignTargets(lhs: ts.Expression): string[] {
  if (ts.isIdentifier(lhs)) return [lhs.text];
  if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs))
    return assignTargets(lhs.expression);
  if (ts.isParenthesizedExpression(lhs)) return assignTargets(lhs.expression);
  if (ts.isObjectLiteralExpression(lhs)) {
    return lhs.properties.flatMap((p) =>
      ts.isPropertyAssignment(p)
        ? assignTargets(p.initializer)
        : ts.isShorthandPropertyAssignment(p)
          ? [p.name.text]
          : ts.isSpreadAssignment(p)
            ? assignTargets(p.expression)
            : [],
    );
  }
  if (ts.isArrayLiteralExpression(lhs)) {
    return lhs.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : assignTargets(e)));
  }
  return [];
}

/** Identifiers READ anywhere in a node's subtree — declaration names, object keys, labels and
 *  type positions are excluded, everything else (including callee names) counts. Deliberately
 *  over-approximate: an extra use only adds a conservative edge. */
export function collectUses(root: ts.Node): string[] {
  const uses: string[] = [];
  const seen = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && isUseReference(n) && !seen.has(n.text)) {
      seen.add(n.text);
      uses.push(n.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(root);
  return uses;
}

function isUseReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.name === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (
    (ts.isMethodDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isFunctionExpression(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (
    ts.isBinaryExpression(p) &&
    p.left === id &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return false;
  if (ts.isTypeNode(p)) return false;
  if (ts.isBreakStatement(p) || ts.isContinueStatement(p) || ts.isLabeledStatement(p)) return false;
  return true;
}

function lineOf(n: ts.Node): number {
  return n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
}

/** A branch body may be a block or a single statement; normalize to a statement list. */
function branchBlock(s: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(s) ? [...s.statements] : [s];
}
