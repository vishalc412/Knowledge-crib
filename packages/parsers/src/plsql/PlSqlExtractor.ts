/**
 * PlSqlExtractor (M10) — turns ONE PL/SQL file (`.sql`/`.pkb`/`.pks`/`.pck`/`.pls`) into nodes +
 * INTRA-FILE edges. Cross-file resolution (proc→proc calls and statement→table/col reads/writes
 * across files) is the {@link SqlResolver}'s job (pipeline Phase 3), against a {@link SchemaCatalog}
 * built from the whole soul. This extractor never guesses across files (capability-honesty).
 *
 * Nodes emitted:
 *   • symbol (procedure/function/package) — qualifiedName, type, span, signature
 *   • symbol (type)            — CREATE TYPE AS OBJECT (meta.attributes) or collection (meta.collection)
 *   • table / column          (from CREATE TABLE, inline or in .sql)
 *   • table (view)            — CREATE VIEW (meta.kind:'view'); explicit columns modelled
 *   • statement               (one per DML; sqlKind + referenced tables/columns on meta)
 *   • condition               (one per IF/ELSIF/WHILE/for-condition predicate)
 *
 * Intra-file edges:
 *   • member-of   column→table, symbol→enclosing-symbol-or-file
 *   • executes    procedure symbol → each DML statement in its body
 *   • reads/writes statement → table/column declared in THIS file (cross-file → resolver)
 *   • calls       procedure symbol → procedure symbol resolved locally (cross-file → resolver)
 *   • guarded-by  statement → its innermost enclosing condition
 *
 * Degrades to no nodes on a parse failure (never throws the pipeline). Deterministic + offline.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import type {
  AssignStmt,
  Block,
  CallStmt,
  CaseStmt,
  ColumnDef,
  Decl,
  ExceptionBlock,
  IfStmt,
  LoopStmt,
  PlainStmt,
  RaiseStmt,
  SqlStmt,
  Stmt,
  TableDef,
  TopLevel,
  TypeDef,
  Unit,
  ViewDef,
} from './ast.js';
import { collectComments } from './lexer.js';
import type { CommentBlock } from './lexer.js';
import { parsePlSql } from './parser.js';
import { sqlRoles } from './parser.js';

interface ProcCtx {
  /** symbol id of the enclosing procedure/function (the `executes`/`calls` source). */
  procId: string;
  /** call sites recorded for cross-file resolution (extractor → resolver). */
  callSites: { callee: string; line: number }[];
}

export class PlSqlExtractor implements Extractor {
  name = 'lang:plsql';
  capabilities: Capabilities = {
    imports: false,
    calls: true,
    inheritance: false,
    types: 'partial',
  };

  private static readonly EXTS = ['.sql', '.pkb', '.pks', '.pck', '.pls', '.pkh', '.typ'];

  supports(file: FileMeta): boolean {
    return PlSqlExtractor.EXTS.some((e) => file.path.endsWith(e));
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    const text = await ctx.readText();
    const fileId = ctx.idFor('file', { path: file.path });
    try {
      return this.build(file.path, fileId, text, ctx);
    } catch {
      // Degrade: a parse failure yields no SQL nodes, never throws the pipeline.
      return { nodes: [], edges: [] };
    }
  }

  private build(path: string, fileId: string, text: string, ctx: ExtractCtx): ExtractResult {
    const tops = parsePlSql(text);
    const b = new Builder(path, fileId, ctx, collectComments(text));
    for (const top of tops) b.addTop(top);
    return b.finish();
  }
}

// ---------------------------------------------------------------------------------------------
// Builder — accumulates nodes + intra-file edges for one file.
// ---------------------------------------------------------------------------------------------

class Builder {
  readonly nodes: Node[] = [];
  readonly edges: Edge[] = [];
  /** local symbol lookup: simple name + qualified name → symbol id (for intra-file calls). */
  private readonly symbols = new Map<string, string>();
  /** local table lookup: "schema.name", "name" → table id. */
  private readonly tables = new Map<string, string>();
  /** local column lookup: "schema.table.col", "table.col" → column id. */
  private readonly columns = new Map<string, string>();
  /** local cursor lookup: name → cursor node id (for `iterates` edges from OPEN / cursor FOR-loops). */
  private readonly cursors = new Map<string, string>();
  /** condition ids created, to dedupe by (file,line). */
  private readonly condSeen = new Set<string>();
  /** case-branch ids created, to dedupe by (file,line). */
  private readonly caseBranchSeen = new Set<string>();
  /** exception-handler ids created, to dedupe by (file,line). */
  private readonly excSeen = new Set<string>();
  /** explanation ids created, to dedupe by (file,line). */
  private readonly explSeen = new Set<string>();
  /** retained comment blocks, for preceding-block → symbol association. */
  private readonly comments: CommentBlock[];

  constructor(
    private readonly path: string,
    private readonly fileId: string,
    private readonly ctx: ExtractCtx,
    comments: CommentBlock[],
  ) {
    this.comments = comments;
  }

  finish(): ExtractResult {
    return { nodes: this.nodes, edges: this.edges };
  }

  addTop(top: TopLevel): void {
    if (top.kind === 'table-ddl') {
      this.addTable(top);
      return;
    }
    if (top.kind === 'view-ddl') {
      this.addView(top);
      return;
    }
    if (top.kind === 'type-def') {
      this.addType(top);
      return;
    }
    this.addUnit(top, /*enclosingId*/ this.fileId, /*qualifier*/ '');
  }

  private addTable(def: TableDef): void {
    const id = this.ctx.idFor('table', { schema: def.schema, name: def.name });
    const tableNode: Node = {
      id,
      kind: 'table',
      schema: def.schema,
      name: def.name,
      file: this.path,
      span: def.span,
      lang: 'plsql',
      hash: this.ctx.hash(`${def.schema}.${def.name}`),
      meta: { columns: def.columns.map((c) => c.name) },
    };
    this.nodes.push(tableNode);
    this.indexTable(def.schema, def.name, id);
    for (const col of def.columns) this.addColumn(def.schema, def.name, col, def.span.start, id);
  }

  private addColumn(
    schema: string,
    table: string,
    col: ColumnDef,
    line: number,
    tableId: string,
  ): void {
    const id = this.ctx.idFor('column', { schema, table, column: col.name });
    const node: Node = {
      id,
      kind: 'column',
      schema,
      table,
      name: col.name,
      dataType: col.dataType,
      file: this.path,
      span: { start: line, end: line },
      lang: 'plsql',
      hash: this.ctx.hash(`${schema}.${table}.${col.name}`),
    };
    this.nodes.push(node);
    this.edges.push(this.memberOf(id, tableId));
    this.indexColumn(schema, table, col.name, id);
  }

  /**
   * Emit a `symbol` (type:'type') node for a CREATE TYPE: an object type with `meta.attributes`
   * (the full field list — the deep context that was previously missing for types like
   * T_APPLICANT_CTX_OBJ), or a collection with `meta.collection`. Indexed as a symbol so local and
   * cross-file references to the type name resolve against it.
   */
  private addType(def: TypeDef): void {
    const qualifiedName = def.schema ? `${def.schema}.${def.name}` : def.name;
    const id = this.ctx.idFor('symbol', {
      path: this.path,
      qualifiedName,
      startLine: def.span.start,
    });
    const meta: Record<string, unknown> = {};
    let signature: string;
    if (def.collection) {
      meta.collection = def.collection;
      signature = `${qualifiedName} AS ${def.collection.kind === 'table' ? 'TABLE' : 'VARRAY'} OF ${def.collection.elementType}`;
    } else {
      meta.attributes = def.attributes.map((a) => ({ name: a.name, dataType: a.dataType }));
      signature = `${qualifiedName} AS OBJECT (${def.attributes.length} attrs)`;
    }
    const node: Node = {
      id,
      kind: 'symbol',
      type: 'type',
      name: def.name,
      qualifiedName,
      file: this.path,
      span: def.span,
      lang: 'plsql',
      hash: this.ctx.hash(qualifiedName),
      signature,
      meta,
    };
    this.nodes.push(node);
    this.edges.push(this.memberOf(id, this.fileId));
    this.indexSymbol(def.name, qualifiedName, id);
  }

  /**
   * Emit a `table` node (meta.kind:'view') for a CREATE VIEW + column nodes for any explicit column
   * list. The SELECT body is not parsed, so a view with no explicit column list has columns:[]. The
   * view is addressable as a table so queries/reads resolve to it.
   */
  private addView(def: ViewDef): void {
    const id = this.ctx.idFor('table', { schema: def.schema, name: def.name });
    const tableNode: Node = {
      id,
      kind: 'table',
      schema: def.schema,
      name: def.name,
      file: this.path,
      span: def.span,
      lang: 'plsql',
      hash: this.ctx.hash(`${def.schema}.${def.name}`),
      meta: { kind: 'view', columns: def.columns.map((c) => c.name) },
    };
    this.nodes.push(tableNode);
    this.indexTable(def.schema, def.name, id);
    for (const col of def.columns) this.addColumn(def.schema, def.name, col, def.span.start, id);
  }

  private addUnit(u: Unit, enclosingId: string, qualifier: string): void {
    const qualifiedName = qualifier ? `${qualifier}.${u.name}` : u.name;
    const symId = this.ctx.idFor('symbol', {
      path: this.path,
      qualifiedName,
      startLine: u.span.start,
    });
    const signature = u.params ? `${u.name}${u.params}` : u.name;
    const node: Node = {
      id: symId,
      kind: 'symbol',
      type: u.kind === 'package' ? 'package' : u.kind === 'function' ? 'function' : 'procedure',
      name: u.name,
      qualifiedName,
      file: this.path,
      span: u.span,
      lang: 'plsql',
      hash: this.ctx.hash(qualifiedName),
      signature,
      ...(u.returnType ? { meta: { returnType: u.returnType } } : {}),
    };
    this.nodes.push(node);
    this.edges.push(this.memberOf(symId, enclosingId));
    this.indexSymbol(u.name, qualifiedName, symId);
    // 1.2: associate a preceding comment block (lines immediately above the unit) as an
    // `explanation` node + `describes` edge so the unit's intent survives into the graph.
    this.attachComment(symId, u.span.start);

    // nested declarations (procedures/functions/cursors/variables inside a package or another proc)
    const variables: { name: string; dataType?: string }[] = [];
    if (u.declarations) {
      for (const d of u.declarations) {
        if (d.kind === 'procedure' || d.kind === 'function') {
          const nested: Unit = {
            kind: d.kind,
            name: d.name,
            params: d.params,
            returnType: d.returnType,
            span: d.span,
            declarations: d.declarations,
            body: d.body,
          };
          this.addUnit(nested, symId, qualifiedName);
        } else if (d.kind === 'cursor') {
          this.addCursor(d, symId);
        } else if (d.kind === 'variable') {
          variables.push({ name: d.name, dataType: d.dataType });
        }
      }
    }
    if (variables.length > 0) {
      node.meta = { ...(node.meta ?? {}), variables };
    }

    // executable body: statements, executes edges, conditions, guarded-by, local reads/writes/calls.
    if (u.body) {
      const ctx: ProcCtx = { procId: symId, callSites: [] };
      this.walkBlock(u.body, ctx, { inLoop: false, inException: false, guard: undefined });
      // stamp call sites on the proc node meta so the resolver can resolve cross-file calls.
      if (ctx.callSites.length > 0) {
        const sym = this.nodes.find((n) => n.id === symId);
        if (sym) sym.meta = { ...(sym.meta ?? {}), calls: ctx.callSites };
      }
    }
  }

  /**
   * 1.2: emit a `cursor` node for a CURSOR declaration + a `declares` edge (unit → cursor) + a
   * `member-of` edge (cursor → unit) and index it by name for local `iterates` resolution.
   */
  private addCursor(d: Decl, ownerId: string): void {
    if (!d.name) return;
    const id = this.ctx.idFor('cursor', { file: this.path, name: d.name, line: d.span.start });
    const node: Node = {
      id,
      kind: 'cursor',
      name: d.name,
      file: this.path,
      span: d.span,
      lang: 'plsql',
      hash: this.ctx.hash(`${this.path}:${d.name}:${d.span.start}`),
      ...(d.cursorQuery ? { cursorQuery: d.cursorQuery } : {}),
      ...(d.exprTruncated ? { exprTruncated: true } : {}),
    };
    this.nodes.push(node);
    this.edges.push(this.edge(ownerId, id, 'declares', d.name));
    this.edges.push(this.memberOf(id, ownerId));
    this.cursors.set(d.name, id);
  }

  /**
   * 1.2: if a comment block ends on the line immediately above `startLine`, emit an `explanation`
   * node carrying the comment text + a `describes` edge (explanation → symbol). Deduped by line.
   */
  private attachComment(symId: string, startLine: number): void {
    const block = this.comments.find((c) => c.end === startLine - 1);
    if (!block || !block.text) return;
    const id = this.ctx.idFor('explanation', { path: this.path, startLine: block.start });
    if (this.explSeen.has(id)) return;
    this.explSeen.add(id);
    this.nodes.push({
      id,
      kind: 'explanation',
      commentRef: { file: this.path, span: { start: block.start, end: block.end } },
      file: this.path,
      span: { start: block.start, end: block.end },
      lang: 'plsql',
      hash: this.ctx.hash(`${this.path}:${block.start}:${block.text}`),
      meta: { text: block.text }, // the comment text is carried inline (a doc, not code ref)
    });
    this.edges.push(this.edge(id, symId, 'describes', 'COMMENT'));
  }

  private walkBlock(
    block: Block,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    for (const s of block.statements) this.walkStmt(s, proc, env);
  }

  private walkStmt(
    s: Stmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    switch (s.kind) {
      case 'sql':
        this.addSql(s, proc, env);
        break;
      case 'call':
        this.addCall(s, proc, env);
        break;
      case 'assign':
        this.addAssign(s, proc, env);
        break;
      case 'raise':
        this.addRaise(s, proc, env);
        break;
      case 'plain':
        this.addPlain(s, proc, env);
        break;
      case 'if':
        this.walkIf(s, proc, env);
        break;
      case 'loop':
        this.walkLoop(s, proc, env);
        break;
      case 'case':
        this.walkCase(s, proc, env);
        break;
      case 'exception':
        this.walkException(s, proc, env);
        break;
      // no other kinds (nested anonymous blocks are wrapped as 'plain')
    }
  }

  private addSql(
    s: SqlStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    const id = this.ctx.idFor('statement', { file: this.path, line: s.span.start });
    const node: Node = {
      id,
      kind: 'statement',
      sqlKind: s.sqlKind,
      file: this.path,
      span: s.span,
      lang: 'plsql',
      hash: this.ctx.hash(`${this.path}:${s.span.start}:${s.sqlKind}`),
      ...(s.expr ? { expr: s.expr } : {}),
      ...(s.exprTruncated ? { exprTruncated: true } : {}),
      meta: {
        tables: s.tables,
        columns: s.columns,
        ...(s.intoTarget ? { intoTarget: s.intoTarget } : {}),
        branch: env.guard ? 'GUARDED' : undefined,
        inLoop: env.inLoop,
        inException: env.inException,
      },
    };
    this.nodes.push(node);
    // executes: procedure → statement
    this.edges.push(this.edge(proc.procId, id, 'executes', s.sqlKind.toUpperCase()));
    // local reads/writes to tables/columns declared in THIS file (cross-file → resolver).
    const { reads, writes } = sqlRoles(s.sqlKind, s.tables);
    for (const t of reads) this.linkTable(id, t, 'reads');
    for (const t of writes) this.linkTable(id, t, 'writes');
    for (const c of s.columns) this.linkColumn(id, c, s.sqlKind);
    // guarded-by: statement → innermost enclosing condition (M11 chains the full path).
    if (env.guard) this.edges.push(this.edge(id, env.guard, 'guarded-by', 'IF'));
  }

  private addCall(
    s: CallStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    // record the call site for cross-file resolution (extractor → resolver).
    proc.callSites.push({ callee: s.callee, line: s.span.start });
    // intra-file resolution: simple name or dotted last segment against local symbols.
    const calleeId = this.resolveLocalSymbol(s.callee);
    if (calleeId && calleeId !== proc.procId) {
      this.edges.push(this.edge(proc.procId, calleeId, 'calls', s.callee));
    } else if (calleeId === proc.procId) {
      // self-recursion: by convention we do NOT emit a self-call edge — it would be a graph cycle,
      // and the cross-file SqlResolver skips self-calls for the same reason. Instead flag the proc
      // `meta.recursive` so the dossier/context surface can report that this procedure recurses
      // (the recursive call site is already recorded in `meta.calls`). This is what makes a
      // recursive resolver like RESOLVE_AND_EVALUATE_RULES visible in the graph without inventing a
      // cycle: the flag + the rehydrated body (base case + recursive call) carry the algorithm.
      this.markRecursive(proc.procId);
    }
    if (env.guard) {
      // a call inside a guarded branch is itself guarded-by the condition.
      const callNodeId = this.ctx.idFor('statement', { file: this.path, line: s.span.start });
      this.edges.push(this.edge(callNodeId, env.guard, 'guarded-by', 'CALL'));
    }
  }

  /** A plain statement (RETURN/NULL/COMMIT/OPEN/CLOSE/FETCH/…) executes under its proc. 1.2: an
   *  `OPEN <cursor>` additionally emits an `iterates` edge to the cursor node. */
  private addPlain(
    s: PlainStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    const id = this.ctx.idFor('statement', { file: this.path, line: s.span.start });
    const node: Node = {
      id,
      kind: 'statement',
      type: 'plain',
      file: this.path,
      span: s.span,
      lang: 'plsql',
      hash: this.ctx.hash(`${this.path}:${s.span.start}:${s.head}`),
      meta: { head: s.head, inLoop: env.inLoop, inException: env.inException },
    };
    this.nodes.push(node);
    this.edges.push(this.edge(proc.procId, id, 'executes', s.head));
    if (env.guard) this.edges.push(this.edge(id, env.guard, 'guarded-by', s.head));
    if (s.cursorName) this.linkCursor(id, s.cursorName);
  }

  /** 1.2: an assignment emits an `assignment` node (with the LHS target) + executes + guarded-by. */
  private addAssign(
    s: AssignStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    const id = this.ctx.idFor('assignment', { file: this.path, line: s.span.start });
    const node: Node = {
      id,
      kind: 'assignment',
      file: this.path,
      span: s.span,
      lang: 'plsql',
      hash: this.ctx.hash(`${this.path}:${s.span.start}:assign`),
      ...(s.target ? { assignTarget: s.target } : {}),
      ...(s.expr ? { expr: s.expr } : {}),
      ...(s.exprTruncated ? { exprTruncated: true } : {}),
      meta: { inLoop: env.inLoop, inException: env.inException },
    };
    this.nodes.push(node);
    this.edges.push(this.edge(proc.procId, id, 'executes', 'assign'));
    if (env.guard) this.edges.push(this.edge(id, env.guard, 'guarded-by', 'assign'));
  }

  /** 1.2: a RAISE emits a `raise` node + a `raises` edge (proc → raise). RAISE_APPLICATION_ERROR
   *  carries the split errorCode/errorMessage. A raise inside a guarded branch is also guarded-by. */
  private addRaise(
    s: RaiseStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    const id = this.ctx.idFor('raise', { file: this.path, line: s.span.start });
    const node: Node = {
      id,
      kind: 'raise',
      name: s.name,
      file: this.path,
      span: s.span,
      lang: 'plsql',
      hash: this.ctx.hash(`${this.path}:${s.span.start}:raise:${s.name}`),
      ...(s.errorCode ? { errorCode: s.errorCode } : {}),
      ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
      meta: { inLoop: env.inLoop, inException: env.inException },
    };
    this.nodes.push(node);
    this.edges.push(this.edge(proc.procId, id, 'raises', s.name || 'RAISE'));
    if (env.guard) this.edges.push(this.edge(id, env.guard, 'guarded-by', 'RAISE'));
  }

  /** 1.2: resolve a cursor name locally and emit an `iterates` edge (stmt → cursor). */
  private linkCursor(stmtId: string, name: string): void {
    const cursorId = this.cursors.get(name);
    if (cursorId) this.edges.push(this.edge(stmtId, cursorId, 'iterates', name));
  }

  /** 1.2: stamp `meta.recursive:true` on a procedure that calls itself. The recursive call site is
   *  already in `meta.calls`; no self-edge is emitted (cycle avoidance, matching the SqlResolver). */
  private markRecursive(procId: string): void {
    const sym = this.nodes.find((n) => n.id === procId);
    if (!sym) return;
    sym.meta = { ...(sym.meta ?? {}), recursive: true };
  }

  private walkIf(
    s: IfStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    for (const branch of s.branches) {
      const condId = branch.condition
        ? this.condition(branch.condition, s.span.start, branch.label)
        : undefined;
      const branchEnv = {
        inLoop: env.inLoop,
        inException: env.inException,
        guard: condId ?? env.guard, // innermost condition, else inherit outer
      };
      this.walkBlock(branch.body, proc, branchEnv);
    }
  }

  private walkLoop(
    s: LoopStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    const condId = s.condition ? this.condition(s.condition, s.span.start, 'LOOP') : undefined;
    const loopEnv = {
      inLoop: true,
      inException: env.inException,
      guard: condId ?? env.guard,
    };
    // 1.2: a cursor FOR-loop (`FOR rec IN c LOOP`) iterates cursor `c` — emit an iterates edge
    // from the loop's condition node to the cursor so the row source is visible.
    if (s.cursor && condId) this.linkCursor(condId, s.cursor);
    this.walkBlock(s.body, proc, loopEnv);
  }

  /** 1.2: walk a CASE — each WHEN/ELSE branch emits a `case-branch` condition node (keyed by the
   *  branch's start line, matching the CFG pass) and its body is walked under that guard. */
  private walkCase(
    s: CaseStmt,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    for (const branch of s.branches) {
      const condId = this.caseBranch(branch.condition ?? '', branch.span.start, branch.label);
      const branchEnv = {
        inLoop: env.inLoop,
        inException: env.inException,
        guard: condId ?? env.guard,
      };
      this.walkBlock(branch.body, proc, branchEnv);
    }
  }

  /** 1.2: walk an EXCEPTION clause — each handler emits an `exception-handler` node + `handles`
   *  edges to every statement node in its body, and the body is walked with inException=true. */
  private walkException(
    s: ExceptionBlock,
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
  ): void {
    for (const handler of s.handlers) {
      const excId = this.exceptionHandler(handler.condition, handler.span.start);
      const handlerEnv = {
        inLoop: env.inLoop,
        inException: true,
        guard: env.guard, // inherit outer guard; an exception is not a new guarded branch
      };
      // capture the statement ids emitted inside the handler so we can link `handles` to each.
      const before = this.nodes.length;
      this.walkBlock(handler.body, proc, handlerEnv);
      const handlerStmts = this.nodes
        .slice(before)
        .filter((n) => n.kind === 'statement' || n.kind === 'assignment' || n.kind === 'raise');
      for (const target of handlerStmts) {
        this.edges.push(this.edge(excId, target.id, 'handles', handler.condition));
      }
    }
  }

  /** Emit a condition node (deduped by file+line) and return its id. */
  private condition(expr: string, line: number, branch: string): string {
    const id = this.ctx.idFor('condition', { file: this.path, line });
    if (!this.condSeen.has(id)) {
      this.condSeen.add(id);
      this.nodes.push({
        id,
        kind: 'condition',
        branch,
        expr,
        file: this.path,
        span: { start: line, end: line },
        lang: 'plsql',
        hash: this.ctx.hash(`${this.path}:${line}:${expr}`),
      });
    }
    return id;
  }

  /** 1.2: emit a `case-branch` condition node (deduped by file+line) and return its id.
   *  `whenSelector` is the WHEN value/condition itself — `'APPROVED'` for a simple case
   *  (`CASE v_status WHEN 'APPROVED'`), the boolean condition for a searched case
   *  (`CASE WHEN v_amt > 50000`), and absent for the ELSE branch. */
  private caseBranch(expr: string, line: number, branch: string): string {
    const id = this.ctx.idFor('case-branch', { file: this.path, line });
    if (!this.caseBranchSeen.has(id)) {
      this.caseBranchSeen.add(id);
      this.nodes.push({
        id,
        kind: 'case-branch',
        branch,
        expr,
        file: this.path,
        span: { start: line, end: line },
        lang: 'plsql',
        hash: this.ctx.hash(`${this.path}:case:${line}:${expr}`),
        ...(expr ? { whenSelector: expr } : {}),
      });
    }
    return id;
  }

  /** 1.2: emit an `exception-handler` node (deduped by file+line) and return its id. */
  private exceptionHandler(selector: string, line: number): string {
    const id = this.ctx.idFor('exception-handler', { file: this.path, line });
    if (!this.excSeen.has(id)) {
      this.excSeen.add(id);
      this.nodes.push({
        id,
        kind: 'exception-handler',
        whenSelector: selector,
        file: this.path,
        span: { start: line, end: line },
        lang: 'plsql',
        hash: this.ctx.hash(`${this.path}:exc:${line}:${selector}`),
      });
    }
    return id;
  }

  // --- local resolution ---

  private linkTable(stmtId: string, ref: string, rel: 'reads' | 'writes'): void {
    const tableId = this.resolveLocalTable(ref);
    if (tableId) this.edges.push(this.edge(stmtId, tableId, rel, ref));
  }

  private linkColumn(stmtId: string, ref: string, verb: string): void {
    // ref may be "table.col" or a bare "col"; resolve against local columns.
    const colId = this.resolveLocalColumn(ref);
    if (colId) {
      const rel: 'reads' | 'writes' = verb === 'select' ? 'reads' : 'writes';
      this.edges.push(this.edge(stmtId, colId, rel, ref));
    }
  }

  private resolveLocalSymbol(callee: string): string | undefined {
    if (this.symbols.has(callee)) return this.symbols.get(callee);
    const last = callee.split('.').pop() ?? callee;
    return this.symbols.get(last);
  }

  private resolveLocalTable(ref: string): string | undefined {
    if (this.tables.has(ref)) return this.tables.get(ref);
    const last = ref.split('.').pop() ?? ref;
    return this.tables.get(last);
  }

  private resolveLocalColumn(ref: string): string | undefined {
    if (this.columns.has(ref)) return this.columns.get(ref);
    // bare col name → resolve only if unambiguous? We didn't index bare cols; skip (honest).
    return undefined;
  }

  private indexSymbol(name: string, qualifiedName: string, id: string): void {
    if (!this.symbols.has(name)) this.symbols.set(name, id);
    this.symbols.set(qualifiedName, id);
  }

  private indexTable(schema: string, name: string, id: string): void {
    this.tables.set(name, id);
    if (schema) this.tables.set(`${schema}.${name}`, id);
  }

  private indexColumn(schema: string, table: string, col: string, id: string): void {
    this.columns.set(`${table}.${col}`, id);
    if (schema) this.columns.set(`${schema}.${table}.${col}`, id);
  }

  // --- edge factories ---

  private memberOf(childId: string, parentId: string): Edge {
    return this.edge(childId, parentId, 'member-of', 'static');
  }

  private edge(src: string, dst: string, rel: Edge['rel'], snippet: string): Edge {
    return {
      id: edgeId(src, dst, rel),
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'plsql-extractor', snippet },
    };
  }
}
