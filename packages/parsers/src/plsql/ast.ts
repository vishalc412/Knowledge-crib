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

/** A declaration inside a unit's declarative part: a nested procedure/function, a local variable,
 *  or a cursor. 1.2 adds `cursor` (CURSOR c IS SELECT …) with `cursorQuery`, and `variable` carries
 *  `dataType` so package-level state is recoverable for migration. */
export interface Decl {
  kind: 'procedure' | 'function' | 'variable' | 'cursor';
  name: string;
  params?: string;
  returnType?: string;
  /** variable: the type as written, e.g. "NUMBER" / "VARCHAR2(20)". */
  dataType?: string;
  /** variable: the literal initializer text after `:=` (e.g. "30", "'PASSED'"), whitespace-collapsed
   *  + fidelity-clamped. Captured so package CONSTANT values survive into `meta.variables` for
   *  migration reconstruction (WS-6). Absent when the declaration has no initializer. */
  init?: string;
  /** variable: true iff declared with the CONSTANT keyword (`cname CONSTANT type := value;`). */
  constant?: boolean;
  /** cursor: the SELECT query text (everything after IS), whitespace-collapsed. */
  cursorQuery?: string;
  /** cursor: the FROM/JOIN/USING table refs mined from the cursor query (best-effort, as written).
   *  Drives a `reads` edge cursor → table so the data-flow graph records that the cursor's row source
   *  is read (WS-7 — without this, a cursor SELECT over a table is invisible to Plan A while Plan B
   *  sees it). Same tolerant contract as {@link SqlStmt.tables}: the resolver re-resolves against the
   *  schema catalog; the extractor emits same-file reads. */
  cursorTables?: string[];
  /** true iff `cursorQuery` or `init` was clipped at the fidelity cap. */
  exprTruncated?: boolean;
  span: AstSpan;
  body?: Block;
  declarations?: Decl[];
}

/** A sequence of statements that forms one lexical block. The CFG basic-block unit. */
export interface Block {
  span: AstSpan;
  statements: Stmt[];
}

/** Discriminated statement union. `sqlKind`/`expr`/`tables`/`columns` drive reads/writes edges.
 *  1.2 adds `CaseStmt` and `ExceptionBlock` (previously parsed-and-skipped) so guards and handlers
 *  survive into the graph. */
export type Stmt =
  | SqlStmt
  | IfStmt
  | LoopStmt
  | CaseStmt
  | ExceptionBlock
  | AssignStmt
  | CallStmt
  | RaiseStmt
  | PlainStmt;

export interface SqlStmt {
  kind: 'sql';
  /** select | insert | update | delete | merge */
  sqlKind: string;
  span: AstSpan;
  /** referenced tables as written, e.g. ["claims.claims"] (may be schema-qualified or bare). */
  tables: string[];
  /** referenced columns as written, e.g. ["status","amount"] (best-effort, may be empty). */
  columns: string[];
  /** the action verb, e.g. "SELECT … FROM claims.claims WHERE id = :1" (whitespace-collapsed,
   *  clipped only past the EXPR_MAX_CHARS fidelity cap). */
  expr?: string;
  /** true iff `expr` was clipped at the fidelity cap. */
  exprTruncated?: boolean;
  /** 1.2: SELECT … INTO <var> — the target variable (provenance), when present. */
  intoTarget?: string;
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
  /** 1.2: for a cursor FOR-loop (`FOR rec IN c LOOP`), the cursor name `c` — drives an `iterates`
   *  edge to the cursor node so the rule's row source is visible. */
  cursor?: string;
}

/** 1.2: a CASE statement. `operand` is the CASE selector (simple case `CASE x WHEN …`); a searched
 *  case (`CASE WHEN cond …`) has no operand. Each branch becomes a `case-branch` condition node. */
export interface CaseStmt {
  kind: 'case';
  /** the CASE selector expression, e.g. "v_status"; undefined for a searched CASE. */
  operand?: string;
  branches: CaseBranch[];
  span: AstSpan;
}

export interface CaseBranch {
  /** "WHEN" | "ELSE". */
  label: 'WHEN' | 'ELSE';
  /** the WHEN value (simple case) or predicate (searched case); undefined for ELSE. */
  condition?: string;
  body: Block;
  span: AstSpan;
}

/** An assignment `target := expr;`. 1.2 captures the LHS target so variable provenance is traceable. */
export interface AssignStmt {
  kind: 'assign';
  span: AstSpan;
  /** the assignment target (LHS) as written, e.g. "v_status" / "self.amount". */
  target?: string;
  /** the RHS expression as written (the scoring formula), clipped only past EXPR_MAX_CHARS. */
  expr?: string;
  /** true iff `expr` was clipped at the fidelity cap. */
  exprTruncated?: boolean;
}

/** A procedure/function call statement: `do_work(arg);` / `pkg.do_work(arg);`. */
export interface CallStmt {
  kind: 'call';
  /** callee as written, e.g. "log_event" / "claims.log_event". */
  callee: string;
  span: AstSpan;
}

/** 1.2: a RAISE statement. Covers both `RAISE <name>;` (a named exception) and the re-raise `RAISE;`
 *  (empty `name`). `RAISE_APPLICATION_ERROR(code, msg)` is parsed as a raise with `name` set to
 *  `RAISE_APPLICATION_ERROR` and `errorCode`/`errorMessage` split out of the call args. */
export interface RaiseStmt {
  kind: 'raise';
  /** the raised exception name, or '' for a bare re-raise, or 'RAISE_APPLICATION_ERROR' for the
   *  call form. */
  name: string;
  /** raise_application_error only: the first arg (error code) as written. */
  errorCode?: string;
  /** raise_application_error only: the second arg (error message) as written, quotes stripped. */
  errorMessage?: string;
  span: AstSpan;
}

/** A statement we recognize as a statement but don't model further (e.g. NULL;, RETURN). 1.2: an
 *  `OPEN <cursor>` records the cursor name so an `iterates` edge can link it to the cursor node. */
export interface PlainStmt {
  kind: 'plain';
  span: AstSpan;
  /** the leading keyword, e.g. "RETURN" / "NULL" / "COMMIT" / "ROLLBACK" / "OPEN". */
  head: string;
  /** present when head is "OPEN": the cursor name being opened. */
  cursorName?: string;
  /** 1.2: present when head is "RAISE" and the raise targets a named exception (RAISE <name>); the
   *  raised name. RAISE_APPLICATION_ERROR is handled separately (parsed as a call). */
  raiseName?: string;
}

/** An EXCEPTION block: `EXCEPTION WHEN <cond> THEN ... [WHEN OTHERS THEN ...]`. 1.2: now actually
 *  instantiated by the parser (previously defined-but-dead); each handler becomes an
 *  `exception-handler` node with `whenSelector` + `handles` edges to the guarded statements. */
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
  /** 1.2: inline column constraints as written, e.g. ["NOT NULL","DEFAULT 0","PRIMARY KEY"]. */
  constraints?: string[];
}

export interface TableDef {
  kind: 'table-ddl';
  /** owning schema as written, or '' if bare (`CREATE TABLE foo`). */
  schema: string;
  name: string;
  columns: ColumnDef[];
  /** 1.2 (WS-7): foreign keys declared on this table — both inline column-level
   *  (`child_id NUMBER REFERENCES parent(id)`) and table-level
   *  (`CONSTRAINT fk FOREIGN KEY (cols) REFERENCES parent(ref_cols)`). Each drives a `references`
   *  edge child table → parent table so the schema's referential structure is in the graph (Plan B
   *  sees FKs in the DDL; Plan A must too). Best-effort: the resolver re-resolves `refTable` against
   *  the schema catalog; the extractor emits same-file references. */
  foreignKeys?: ForeignKey[];
  span: AstSpan;
}

/** 1.2 (WS-7): a foreign key on a table — the local columns and the referenced table (+ optional
 *  referenced columns). `refTable` is as written (may be schema-qualified or bare). */
export interface ForeignKey {
  /** the local (child) columns constrained by the FK. */
  columns: string[];
  /** the referenced (parent) table as written, e.g. "applicants" or "hr.applicants". */
  refTable: string;
  /** the referenced columns, when written `REFERENCES parent(ref_cols)`; else undefined. */
  refColumns?: string[];
}

/**
 * A `CREATE [OR REPLACE] TYPE [schema.]name AS OBJECT ( attr type, ... )` definition, or a
 * collection type (`AS TABLE OF <type>` / `AS VARRAY(n) OF <type>`). Object types (e.g. Oracle's
 * `T_APPLICANT_CTX_OBJ`) carry a rich attribute list — the migration-relevant "full DB context" — so
 * the extractor surfaces them as `symbol` (type:'type') nodes with `meta.attributes`. Collections
 * have an empty attribute list and `meta.collection: { kind, elementType }` instead. A view
 * (`CREATE VIEW`) reuses {@link TableDef} with `kind: 'view-ddl'`.
 */
export interface TypeDef {
  kind: 'type-def';
  schema: string;
  name: string;
  /** object-type attributes; empty for a collection type. */
  attributes: ColumnDef[];
  /** present iff this is a collection (TABLE OF / VARRAY OF), not an object type. */
  collection?: { kind: 'table' | 'varray'; elementType: string };
  span: AstSpan;
}

/** A `CREATE [OR REPLACE] VIEW [schema.]name [( c1, c2, ... )] AS SELECT ...` definition. The view
 * body (the SELECT) is NOT modelled — we capture the name + optional explicit column list so the
 * view is an addressable node, not silently dropped. */
export interface ViewDef {
  kind: 'view-ddl';
  schema: string;
  name: string;
  /** explicit column list if written `VIEW v (c1, c2) AS ...`; else [] (the projection isn't parsed). */
  columns: ColumnDef[];
  span: AstSpan;
}

/** A top-level construct the parser can produce: an executable unit, a table/view DDL, or a type. */
export type TopLevel = Unit | TableDef | ViewDef | TypeDef;
