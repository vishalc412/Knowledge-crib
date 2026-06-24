/**
 * PlSqlExtractor (M10) — turns ONE PL/SQL file (`.sql`/`.pkb`/`.pks`/`.pck`/`.pls`) into nodes +
 * INTRA-FILE edges. Cross-file resolution (proc→proc calls and statement→table/col reads/writes
 * across files) is the {@link SqlResolver}'s job (pipeline Phase 3), against a {@link SchemaCatalog}
 * built from the whole soul. This extractor never guesses across files (capability-honesty).
 *
 * Nodes emitted:
 *   • symbol (procedure/function/package) — qualifiedName, type, span, signature
 *   • table / column          (from CREATE TABLE, inline or in .sql)
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
  Block,
  CallStmt,
  ColumnDef,
  IfStmt,
  LoopStmt,
  SqlStmt,
  Stmt,
  TableDef,
  TopLevel,
  Unit,
} from './ast.js';
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
    const b = new Builder(path, fileId, ctx);
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
  /** condition ids created, to dedupe by (file,line). */
  private readonly condSeen = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly fileId: string,
    private readonly ctx: ExtractCtx,
  ) {}

  finish(): ExtractResult {
    return { nodes: this.nodes, edges: this.edges };
  }

  addTop(top: TopLevel): void {
    if (top.kind === 'table-ddl') {
      this.addTable(top);
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

    // nested declarations (procedures/functions inside a package or another proc)
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
        }
      }
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
        this.addPlainLike(s.span, proc, env, 'assign');
        break;
      case 'plain':
        this.addPlainLike(s.span, proc, env, s.head);
        break;
      case 'if':
        this.walkIf(s, proc, env);
        break;
      case 'loop':
        this.walkLoop(s, proc, env);
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
      meta: {
        tables: s.tables,
        columns: s.columns,
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
    }
    if (env.guard) {
      // a call inside a guarded branch is itself guarded-by the condition.
      const callNodeId = this.ctx.idFor('statement', { file: this.path, line: s.span.start });
      this.edges.push(this.edge(callNodeId, env.guard, 'guarded-by', 'CALL'));
    }
  }

  /** A plain/assign statement still executes under its proc; record executes + guarded-by. */
  private addPlainLike(
    span: { start: number; end: number },
    proc: ProcCtx,
    env: { inLoop: boolean; inException: boolean; guard: string | undefined },
    head: string,
  ): void {
    const id = this.ctx.idFor('statement', { file: this.path, line: span.start });
    const node: Node = {
      id,
      kind: 'statement',
      type: 'plain',
      file: this.path,
      span,
      lang: 'plsql',
      hash: this.ctx.hash(`${this.path}:${span.start}:${head}`),
      meta: { head, inLoop: env.inLoop, inException: env.inException },
    };
    this.nodes.push(node);
    this.edges.push(this.edge(proc.procId, id, 'executes', head));
    if (env.guard) this.edges.push(this.edge(id, env.guard, 'guarded-by', head));
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
    this.walkBlock(s.body, proc, loopEnv);
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
