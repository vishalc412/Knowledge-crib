/**
 * PL/SQL AST (M10) — the migration-relevant subset.
 *
 * This is a hand-rolled, deliberately small AST: it captures exactly what the {@link PlSqlExtractor}
 * turns into soul nodes/edges AND what the M11 CFG pass needs to build a basic-block control-flow
 * graph + guard chain. It is NOT a full PL/SQL grammar — unknown constructs degrade to "skipped"
 * (the extractor never throws; capability-honesty, extractor-plugins §5).
 *
 * ── The M11 CFG contract (P1-4) ──────────────────────────────────────────────────────────────
 * M11 consumes the spans + markers below to build a CFG WITHOUT re-parsing source. The contract is:
 *
 *   • {@link Block} carries a `span` (start/end line, 1-based inclusive) — the range M11 turns into
 *     one basic block (or a sub-CFG for compound blocks). A procedure body is a `Block` of kind
 *     `procedure-body`; that is the CFG entry block.
 *   • {@link IfStmt} carries `branches: IfBranch[]` ordered as written (THEN, ELSIF…, ELSE). Each
 *     branch has a `condition` (undefined for ELSE) + a body `Block`. M11 emits one `condition` node
 *     per non-ELSE branch and a `THEN`/`ELSIF n`/`ELSE` {@link Edge.branch} label on the outgoing
 *     `executes`/`calls` edges of the statements inside it.
 *   • {@link LoopStmt} carries `kind` (`loop`/`while`/`for`) + optional `condition` (while) + body
 *     `Block`. M11 marks every edge inside the body `inLoop: true` (the M11 Edge additive bump).
 *   • {@link ExceptionBlock} carries `handlers: ExceptionHandler[]`; each handler has a `range` span
 *     + `condition` (the WHEN selector, or `"OTHERS"`). M11 marks edges inside a handler range
 *     `inException: true`.
 *   • {@link CallSite} carries the callee text + the 1-based `line` of the call. M11 records the
 *     call-site position on the `calls`/`executes` edge as `evidence.snippet` + a `meta.callLine`
 *     so the guard chain can attribute the call to its enclosing branch.
 *
 * Everything here is plain data (no methods, no parent pointers) so it serializes trivially and the
 * extractor can copy fields onto `statement`/`symbol` node `meta` without transformation.
 */

/** A 1-based inclusive line span. */
export interface AstSpan {
  start: number;
  end: number;
}

/** A top-level PL/SQL unit: a package (spec/body), standalone procedure/function, or anonymous block. */
export interface Unit {
  kind: 'package' | 'package-body' | 'procedure' | 'function' | 'anonymous';
  /** schema-qualified name, e.g. "claims" / "claims.process_claim". Empty for anonymous. */
  name: string;
  /** the parameters as written, e.g. "(p_id IN NUMBER)" — stored raw, not typed. */
  params?: string;
  /** return type for functions, e.g. "NUMBER". */
  returnType?: string;
  span: AstSpan;
  /** the unit's declaration body (locals + nested units) — present for procedures/functions. */
  declarations?: Decl[];
  /** the executable body; null for a package SPEC (specs declare, they don't execute). */
  body?: Block;
}

/** A declaration inside a unit's declarative part: a nested procedure/function or a local variable. */
export interface Decl {
  kind: 'procedure' | 'function' | 'variable';
  name: string;
  params?: string;
  returnType?: string;
  span: AstSpan;
  body?: Block;
  declarations?: Decl[];
}

/** A sequence of statements that forms one lexical block. The CFG basic-block unit. */
export interface Block {
  span: AstSpan;
  statements: Stmt[];
}

/** Discriminated statement union. `sqlKind`/`expr`/`tables`/`columns` drive reads/writes edges. */
export type Stmt = SqlStmt | IfStmt | LoopStmt | AssignStmt | CallStmt | PlainStmt;

export interface SqlStmt {
  kind: 'sql';
  /** select | insert | update | delete | merge */
  sqlKind: string;
  span: AstSpan;
  /** referenced tables as written, e.g. ["claims.claims"] (may be schema-qualified or bare). */
  tables: string[];
  /** referenced columns as written, e.g. ["status","amount"] (best-effort, may be empty). */
  columns: string[];
  /** the action verb, e.g. "SELECT … FROM claims.claims WHERE id = :1" (truncated snippet). */
  expr?: string;
}

export interface IfStmt {
  kind: 'if';
  branches: IfBranch[];
  span: AstSpan;
}

export interface IfBranch {
  /** "THEN" | "ELSIF" | "ELSE". THEN is the first; ELSIF repeats; ELSE is the trailing branch. */
  label: 'THEN' | 'ELSIF' | 'ELSE';
  /** the branch predicate; undefined for ELSE. */
  condition?: string;
  body: Block;
}

export interface LoopStmt {
  kind: 'loop';
  /** loop | while | for */
  loopKind: 'loop' | 'while' | 'for';
  /** while-condition or for-iterator text; undefined for a plain infinite LOOP. */
  condition?: string;
  body: Block;
  span: AstSpan;
}

/** An assignment `target := expr;`. Not data-flow-tracked beyond recording it exists. */
export interface AssignStmt {
  kind: 'assign';
  span: AstSpan;
  expr?: string;
}

/** A procedure/function call statement: `do_work(arg);` / `pkg.do_work(arg);`. */
export interface CallStmt {
  kind: 'call';
  /** callee as written, e.g. "log_event" / "claims.log_event". */
  callee: string;
  span: AstSpan;
}

/** A statement we recognize as a statement but don't model further (e.g. NULL;, RETURN). */
export interface PlainStmt {
  kind: 'plain';
  span: AstSpan;
  /** the leading keyword, e.g. "RETURN" / "NULL" / "COMMIT" / "ROLLBACK". */
  head: string;
}

/** An EXCEPTION block: `EXCEPTION WHEN <cond> THEN ... [WHEN OTHERS THEN ...]`. */
export interface ExceptionBlock {
  kind: 'exception';
  handlers: ExceptionHandler[];
  span: AstSpan;
}

export interface ExceptionHandler {
  /** the WHEN selector text, e.g. "NO_DATA_FOUND" or "OTHERS". */
  condition: string;
  body: Block;
  span: AstSpan;
}

/** A call site recorded on a unit/decl for cross-file `calls` resolution (extractor → resolver). */
export interface CallSite {
  callee: string;
  line: number;
}

// ── DDL (CREATE TABLE / columns) ───────────────────────────────────────────────────────────
// Tables live in `.sql` files AND inline in `.pkb/.pks` (the migration track must recover schema
// declared wherever it appears). A TableDef is NOT a `Unit` (it has no body) — it produces a
// `table` node + `column` nodes + `member-of` edges, nothing else.

export interface ColumnDef {
  name: string;
  /** the type as written, e.g. "NUMBER" / "VARCHAR2(20)". */
  dataType: string;
}

export interface TableDef {
  kind: 'table-ddl';
  /** owning schema as written, or '' if bare (`CREATE TABLE foo`). */
  schema: string;
  name: string;
  columns: ColumnDef[];
  span: AstSpan;
}

/** A top-level construct the parser can produce: an executable unit or a DDL table definition. */
export type TopLevel = Unit | TableDef;
