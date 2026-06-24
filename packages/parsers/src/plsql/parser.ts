/**
 * PL/SQL recursive-descent parser (M10) — hand-rolled, zero-dependency, offline.
 *
 * Parses the migration-relevant subset into the {@link TopLevel} AST: DDL (CREATE TABLE), package
 * specs/bodies, standalone + nested procedures/functions, anonymous blocks, DML (SELECT/INSERT/
 * UPDATE/DELETE/MERGE), control flow (IF/ELSIF/ELSE, LOOP/WHILE/FOR), and EXCEPTION handlers.
 *
 * Tolerant by design: an unexpected token resyncs to the next `;` or block boundary and the parse
 * continues — the extractor never throws (capability-honesty, extractor-plugins §5). It is NOT a
 * validating PL/SQL parser; constructs outside the subset degrade to `PlainStmt` or are skipped.
 */
import type {
  AssignStmt,
  Block,
  CallStmt,
  ColumnDef,
  IfBranch,
  IfStmt,
  LoopStmt,
  PlainStmt,
  SqlStmt,
  Stmt,
  TableDef,
  TopLevel,
  Unit,
} from './ast.js';
import { tokenize } from './lexer.js';
import type { Token } from './lexer.js';

/** Sentinel returned when the cursor runs past the token stream's real EOF (never happens in
 *  practice — the lexer always appends a real `eof` token — but `noUncheckedIndexedAccess` can't
 *  prove it, so the accessors fall back to this). */
const EOF_TOKEN: Token = { type: 'eof', text: '', raw: '', line: 0, off: 0 };

const SQL_VERBS = new Set(['select', 'insert', 'update', 'delete', 'merge']);
const BLOCK_END = new Set(['end', 'exception', 'else', 'elsif', 'when']);
const STMT_HEAD_PLAIN = new Set([
  'return',
  'null',
  'commit',
  'rollback',
  'raise',
  'exit',
  'continue',
  'goto',
  'execute',
  'open',
  'close',
  'fetch',
]);

export function parsePlSql(src: string): TopLevel[] {
  const p = new Parser(src);
  return p.parseFile();
}

class Parser {
  private readonly toks: Token[];
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
    this.toks = tokenize(src);
  }

  // --- cursor helpers ---
  private peek(): Token {
    return this.toks[this.pos] ?? EOF_TOKEN;
  }
  private at(): Token {
    return this.toks[this.pos] ?? EOF_TOKEN;
  }
  private next(): Token {
    return this.toks[this.pos++] ?? EOF_TOKEN;
  }
  private isWord(...ws: string[]): boolean {
    const t = this.at();
    return t.type === 'word' && ws.includes(t.text);
  }
  private isPunct(c: string): boolean {
    const t = this.at();
    return t.type === 'punct' && t.text === c;
  }
  private eatWord(w: string): boolean {
    if (this.isWord(w)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private eatPunct(c: string): boolean {
    if (this.isPunct(c)) {
      this.pos++;
      return true;
    }
    return false;
  }
  private lineOf(): number {
    return this.at().line;
  }

  /** Resync: skip tokens until a `;` (consumed) or a block boundary keyword, or EOF. */
  private recover(): void {
    while (this.at().type !== 'eof') {
      if (this.isPunct(';')) {
        this.pos++;
        return;
      }
      if (BLOCK_END.has(this.at().text)) return;
      this.pos++;
    }
  }

  // --- entry ---
  parseFile(): TopLevel[] {
    const out: TopLevel[] = [];
    while (this.at().type !== 'eof') {
      // skip stray semicolons / stray tokens between units
      if (this.isPunct('/') || this.isPunct(';')) {
        this.pos++;
        continue;
      }
      if (this.isWord('create')) {
        const unit = this.parseCreate();
        if (unit) out.push(unit);
        continue;
      }
      if (this.isWord('begin')) {
        const blk = this.parseAnonymousBlock();
        if (blk) out.push(blk);
        continue;
      }
      if (this.isWord('declare')) {
        // DECLARE <decls> BEGIN ... END; — anonymous block with declarations
        this.pos++;
        const blk = this.parseAnonymousBlock();
        if (blk) out.push(blk);
        continue;
      }
      if (this.at().type === 'word') {
        // A bare SQL statement at top level (typical .sql file) or stray construct.
        if (SQL_VERBS.has(this.at().text)) {
          const stmt = this.parseSqlStmt();
          if (stmt) out.push(stmtToUnit(stmt));
          continue;
        }
        // Unknown top-level construct: skip to next `;` to avoid swallowing the file.
        this.recover();
        continue;
      }
      this.pos++; // punctuation we don't model at top level
    }
    return out;
  }

  // --- CREATE ...
  private parseCreate(): TopLevel | null {
    const startLine = this.lineOf();
    this.eatWord('create');
    this.eatWord('or');
    this.eatWord('replace');
    // optional schema prefix already handled as part of the name below.
    if (this.isWord('table')) {
      return this.parseCreateTable(startLine);
    }
    if (this.isWord('package')) {
      return this.parsePackage(startLine, /*body*/ false);
    }
    if (this.isWord('procedure')) {
      return this.parseProcOrFunc('procedure', startLine);
    }
    if (this.isWord('function')) {
      return this.parseProcOrFunc('function', startLine);
    }
    // CREATE TYPE/VIEW/INDEX/etc. — not modelled; skip to terminator.
    this.recover();
    return null;
  }

  private parseCreateTable(startLine: number): TableDef {
    this.eatWord('table');
    const { schema, name } = this.parseQualifiedName();
    const columns: ColumnDef[] = [];
    // ( col type [, col type] ... )
    if (this.isPunct('(')) {
      this.pos++;
      let depth = 1;
      // simple column list: name type [constraints]; table-level constraints (PRIMARY KEY…)
      // begin with a keyword and have no type; tolerate by stopping at depth 0.
      while (this.at().type !== 'eof' && depth > 0) {
        // table-level constraint clause starts with a keyword like primary/unique/foreign/check/constraint
        if (
          this.at().type === 'word' &&
          ['primary', 'unique', 'foreign', 'check', 'constraint', 'key'].includes(this.at().text)
        ) {
          // skip until , or closing ) at depth 1
          this.skipUntilDepthZero();
          continue;
        }
        if (this.isPunct(',')) {
          this.pos++;
          continue;
        }
        if (this.isPunct('(')) {
          depth++;
          this.pos++;
          continue;
        }
        if (this.isPunct(')')) {
          depth--;
          this.pos++;
          if (depth === 0) break;
          continue;
        }
        // a column def: name type ...
        if (this.at().type === 'word') {
          const colName = this.next().raw;
          // read the type until , or ) or EOF (one or more words, possibly (n) )
          const typeParts: string[] = [];
          while (
            this.at().type !== 'eof' &&
            !this.isPunct(',') &&
            !this.isPunct(')') &&
            !this.isPunct(';')
          ) {
            if (this.at().type === 'word' || this.at().type === 'number') {
              typeParts.push(this.at().raw);
            }
            this.pos++;
          }
          columns.push({ name: colName, dataType: typeParts.join(' ') });
          continue;
        }
        this.pos++; // stray
      }
    }
    // skip to terminating ;
    this.recover();
    return {
      kind: 'table-ddl',
      schema,
      name,
      columns,
      span: { start: startLine, end: this.lineOf() },
    };
  }

  /** Skip tokens until the paren depth returns to zero (relative to entry), then stop. */
  private skipUntilDepthZero(): void {
    let depth = 0;
    while (this.at().type !== 'eof') {
      if (this.isPunct('(')) depth++;
      else if (this.isPunct(')')) {
        if (depth === 0) return; // caller's closing paren
        depth--;
      } else if (this.isPunct(',') && depth === 0) {
        return;
      }
      this.pos++;
    }
  }

  private parsePackage(startLine: number, body: boolean): Unit | null {
    this.eatWord('package');
    this.eatWord('body'); // CREATE PACKAGE BODY
    const { schema, name } = this.parseQualifiedName();
    const unitName = schema ? `${schema}.${name}` : name;
    // IS | AS
    if (this.isWord('is')) this.pos++;
    else if (this.isWord('as')) this.pos++;
    else {
      this.recover();
      return null;
    }
    // spec: procedure/function signatures until END. body: declarations + bodies until END.
    const declarations: Unit['declarations'] = [];
    while (this.at().type !== 'eof' && !this.isWord('end')) {
      if (this.isWord('procedure')) {
        const d = this.parseProcOrFunc('procedure', this.lineOf());
        if (d) declarations.push(unitToDecl(d));
        continue;
      }
      if (this.isWord('function')) {
        const d = this.parseProcOrFunc('function', this.lineOf());
        if (d) declarations.push(unitToDecl(d));
        continue;
      }
      // other spec/body members (TYPE, CURSOR, variable decls) — skip to next ; (depth 0)
      this.skipToSemicolon();
    }
    this.eatWord('end');
    // optional name after END
    if (this.at().type === 'word') this.pos++;
    this.eatPunct(';');
    // A package body's executable behavior lives in its nested procedures (declarations[]). Each
    // nested proc carries its own `body`; the package unit itself has no body block.
    return {
      kind: body ? 'package-body' : 'package',
      name: unitName,
      span: { start: startLine, end: this.lineOf() },
      declarations,
      body: undefined,
    };
  }

  private parseProcOrFunc(kind: 'procedure' | 'function', startLine: number): Unit | null {
    this.eatWord(kind);
    const name = this.at().type === 'word' ? this.next().raw : '';
    if (!name) {
      this.recover();
      return null;
    }
    let params: string | undefined;
    if (this.isPunct('(')) {
      params = this.readBalancedParens();
    }
    let returnType: string | undefined;
    if (kind === 'function') {
      // RETURN <type>
      if (this.isWord('return')) {
        this.pos++;
        const parts: string[] = [];
        while (
          this.at().type !== 'eof' &&
          !this.isWord('is') &&
          !this.isWord('as') &&
          !this.isPunct(';')
        ) {
          if (this.at().type === 'word' || this.at().type === 'number') parts.push(this.at().raw);
          this.pos++;
        }
        returnType = parts.join(' ');
      }
    }
    // IS | AS  (presence means a body follows; absence = spec-only signature)
    if (!this.eatWord('is') && !this.eatWord('as')) {
      // signature only (e.g. in a package spec) — skip to ;
      this.recover();
      return {
        kind,
        name,
        params,
        returnType,
        span: { start: startLine, end: this.lineOf() },
        declarations: [],
        body: { span: { start: startLine, end: this.lineOf() }, statements: [] },
      };
    }
    // declarative part: nested proc/func + locals until BEGIN
    const declarations: Unit['declarations'] = [];
    while (this.at().type !== 'eof' && !this.isWord('begin') && !this.isWord('end')) {
      if (this.isWord('procedure')) {
        const d = this.parseProcOrFunc('procedure', this.lineOf());
        if (d) declarations.push(unitToDecl(d));
        continue;
      }
      if (this.isWord('function')) {
        const d = this.parseProcOrFunc('function', this.lineOf());
        if (d) declarations.push(unitToDecl(d));
        continue;
      }
      // PRAGMA / TYPE / CURSOR / var decl — skip to ;
      this.skipToSemicolon();
    }
    // BEGIN <body> END — consume the BEGIN keyword first so parseBlock doesn't read it as a
    // nested-anonymous-block statement head (which would swallow the whole body).
    let body: Block | undefined = undefined;
    if (this.isWord('begin')) {
      this.pos++;
      body = this.parseBlock(BLOCK_END);
    }
    this.eatWord('end');
    if (this.at().type === 'word') this.pos++; // optional name
    this.eatPunct(';');
    return {
      kind,
      name,
      params,
      returnType,
      span: { start: startLine, end: this.lineOf() },
      declarations,
      body,
    };
  }

  private parseAnonymousBlock(): Unit | null {
    const startLine = this.lineOf();
    this.eatWord('begin');
    const body = this.parseBlock(BLOCK_END);
    this.eatWord('end');
    if (this.at().type === 'word') this.pos++;
    this.eatPunct(';');
    return {
      kind: 'anonymous',
      name: '',
      span: { start: startLine, end: this.lineOf() },
      body,
    };
  }

  // --- blocks & statements ---
  private parseBlock(stop: Set<string>): Block {
    const startLine = this.lineOf();
    const statements: Stmt[] = [];
    while (this.at().type !== 'eof' && !stop.has(this.at().text)) {
      const s = this.parseStmt();
      if (s) statements.push(s);
      else this.pos++;
    }
    return { span: { start: startLine, end: this.lineOf() }, statements };
  }

  private parseStmt(): Stmt | null {
    const t = this.at();
    if (t.type !== 'word') {
      // a leading `(` opens a sub-expression statement; recover to ;
      if (t.type === 'punct' || t.type === 'op' || t.type === 'unknown') {
        this.recover();
        return null;
      }
      return null;
    }
    const head = t.text;
    if (head === 'if') return this.parseIf();
    if (head === 'for' || head === 'while' || head === 'loop') return this.parseLoop();
    if (head === 'begin') {
      // nested anonymous block as a statement
      const startLine = this.lineOf();
      const inner = this.parseAnonymousBlock();
      if (inner?.body) return this.wrapBlockAsPlain(inner.body, startLine);
      return null;
    }
    if (head === 'exception') {
      // handled at block level; bail so the enclosing block stops here.
      return null;
    }
    if (SQL_VERBS.has(head)) return this.parseSqlStmt();
    if (STMT_HEAD_PLAIN.has(head)) return this.parsePlain();
    // otherwise: a name-led statement — call or assignment.
    return this.parseNameStmt();
  }

  private parseIf(): IfStmt {
    const startLine = this.lineOf();
    this.eatWord('if');
    const cond = this.readUntilKeyword('then');
    this.eatWord('then');
    const branches: IfBranch[] = [];
    const thenBody = this.parseBlock(BLOCK_END);
    branches.push({ label: 'THEN', condition: cond, body: thenBody });
    while (this.isWord('elsif')) {
      this.pos++;
      const c = this.readUntilKeyword('then');
      this.eatWord('then');
      const b = this.parseBlock(BLOCK_END);
      branches.push({ label: 'ELSIF', condition: c, body: b });
    }
    if (this.isWord('else')) {
      this.pos++;
      const b = this.parseBlock(BLOCK_END);
      branches.push({ label: 'ELSE', body: b });
    }
    this.eatWord('end');
    this.eatWord('if');
    this.eatPunct(';');
    return { kind: 'if', branches, span: { start: startLine, end: this.lineOf() } };
  }

  private parseLoop(): LoopStmt {
    const startLine = this.lineOf();
    let loopKind: 'loop' | 'while' | 'for' = 'loop';
    let condition: string | undefined;
    if (this.eatWord('while')) {
      loopKind = 'while';
      condition = this.readUntilKeyword('loop');
    } else if (this.eatWord('for')) {
      loopKind = 'for';
      condition = this.readUntilKeyword('loop');
    }
    this.eatWord('loop');
    const body = this.parseBlock(BLOCK_END);
    this.eatWord('end');
    this.eatWord('loop');
    this.eatPunct(';');
    return {
      kind: 'loop',
      loopKind,
      condition,
      body,
      span: { start: startLine, end: this.lineOf() },
    };
  }

  private parseSqlStmt(): SqlStmt {
    const t = this.at();
    const startOff = t.off;
    const startLine = t.line;
    const verb = t.text;
    this.pos++;
    const sqlKind = verb; // select/insert/update/delete/merge
    // Collect tokens until the terminating `;` at paren depth 0.
    const inner: Token[] = [];
    let depth = 0;
    while (this.at().type !== 'eof') {
      if (this.isPunct('(')) {
        depth++;
        inner.push(this.at());
        this.pos++;
        continue;
      }
      if (this.isPunct(')')) {
        depth--;
        inner.push(this.at());
        this.pos++;
        continue;
      }
      if (this.isPunct(';') && depth === 0) {
        this.pos++;
        break;
      }
      inner.push(this.at());
      this.pos++;
    }
    const { tables, columns } = extractSqlRefs(verb, inner);
    const endOff = this.at().type !== 'eof' ? this.at().off : this.src.length;
    const expr = this.src
      .slice(startOff, Math.min(endOff, startOff + 120))
      .replace(/\s+/g, ' ')
      .trim();
    return {
      kind: 'sql',
      sqlKind,
      tables,
      columns,
      expr,
      span: { start: startLine, end: this.at().line },
    };
  }

  private parsePlain(): PlainStmt {
    const head = this.at().raw.toUpperCase();
    const startLine = this.lineOf();
    // consume until ; (depth 0)
    this.skipToSemicolon();
    return { kind: 'plain', head, span: { start: startLine, end: this.lineOf() } };
  }

  /** A name-led statement: `name[(args)];` (call) or `name := expr;` (assign) or `name.prop := ...`. */
  private parseNameStmt(): Stmt | null {
    const startLine = this.lineOf();
    const name = this.readDottedName();
    if (!name) {
      this.recover();
      return null;
    }
    if (this.isPunct('(')) {
      // call statement: consume balanced parens, then ;
      this.readBalancedParens();
      this.eatPunct(';');
      return {
        kind: 'call',
        callee: name,
        span: { start: startLine, end: this.lineOf() },
      } satisfies CallStmt;
    }
    if (this.at().type === 'op' && this.at().text === ':=') {
      // assignment
      this.pos++;
      const exprStart = this.at().off;
      this.skipToSemicolon();
      const expr = this.src
        .slice(exprStart, Math.min(this.at().off, exprStart + 120))
        .replace(/\s+/g, ' ')
        .trim();
      return {
        kind: 'assign',
        expr,
        span: { start: startLine, end: this.lineOf() },
      } satisfies AssignStmt;
    }
    // something else (e.g. a label, or a bare identifier) — skip to ;
    this.recover();
    return {
      kind: 'plain',
      head: name.toUpperCase(),
      span: { start: startLine, end: this.lineOf() },
    };
  }

  private wrapBlockAsPlain(_b: Block, startLine: number): Stmt {
    this.skipToSemicolon();
    return { kind: 'plain', head: 'BLOCK', span: { start: startLine, end: this.lineOf() } };
  }

  // --- low-level readers ---

  /** Read a qualified name `schema.name` or `name`; returns schema ('' if none) + name. */
  private parseQualifiedName(): { schema: string; name: string } {
    if (this.at().type !== 'word') return { schema: '', name: '' };
    const first = this.next().raw;
    if (this.isPunct('.')) {
      this.pos++;
      if (this.at().type === 'word') {
        const second = this.next().raw;
        return { schema: first, name: second };
      }
      return { schema: '', name: first };
    }
    return { schema: '', name: first };
  }

  /** Read a dotted name `a.b.c` (used for call targets). Returns '' if the first token isn't a word. */
  private readDottedName(): string | null {
    if (this.at().type !== 'word') return null;
    const parts: string[] = [this.next().raw];
    while (this.isPunct('.')) {
      this.pos++;
      if (this.at().type === 'word') parts.push(this.next().raw);
      else break;
    }
    return parts.join('.');
  }

  /** Read raw source until a keyword (depth-0), returning the trimmed snippet. Consumes up to (not) the keyword. */
  private readUntilKeyword(kw: string): string {
    const startOff = this.at().off;
    let depth = 0;
    while (this.at().type !== 'eof') {
      if (this.isPunct('(')) depth++;
      else if (this.isPunct(')')) depth--;
      else if (depth === 0 && this.isWord(kw)) break;
      this.pos++;
    }
    const endOff = this.at().off;
    return this.src.slice(startOff, endOff).replace(/\s+/g, ' ').trim();
  }

  /** Consume a balanced `(...)` and return its raw inner text (excluding outer parens). */
  private readBalancedParens(): string {
    if (!this.isPunct('(')) return '';
    this.pos++;
    let depth = 1;
    const startOff = this.at().off;
    while (this.at().type !== 'eof' && depth > 0) {
      if (this.isPunct('(')) depth++;
      else if (this.isPunct(')')) {
        depth--;
        if (depth === 0) {
          const endOff = this.at().off;
          this.pos++;
          return this.src.slice(startOff, endOff).replace(/\s+/g, ' ').trim();
        }
      }
      this.pos++;
    }
    return '';
  }

  /** Skip tokens until a depth-0 `;` (consumed) or EOF. */
  private skipToSemicolon(): void {
    let depth = 0;
    while (this.at().type !== 'eof') {
      if (this.isPunct('(')) depth++;
      else if (this.isPunct(')')) depth = Math.max(0, depth - 1);
      else if (this.isPunct(';') && depth === 0) {
        this.pos++;
        return;
      }
      this.pos++;
    }
  }
}

// --- helpers ---

/** Turn a single SQL statement into a trivial anonymous unit so the extractor treats it uniformly. */
function stmtToUnit(stmt: SqlStmt): Unit {
  return {
    kind: 'anonymous',
    name: '',
    span: stmt.span,
    body: { span: stmt.span, statements: [stmt] },
  };
}

function unitToDecl(u: Unit): import('./ast.js').Decl {
  return {
    kind: u.kind === 'function' ? 'function' : 'procedure',
    name: u.name,
    params: u.params,
    returnType: u.returnType,
    span: u.span,
    body: u.body,
    declarations: u.declarations,
  };
}

/** Keywords that terminate a table reference (alias, next clause, or keyword column). */
const REF_STOP = new Set([
  'where',
  'set',
  'values',
  'select',
  'group',
  'order',
  'having',
  'on',
  'and',
  'or',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'union',
  'minus',
  'intersect',
  'returning',
  'when',
  'into',
  'from',
]);

/** Safe token accessor: returns the token at `k` or undefined (noUncheckedIndexedAccess-safe). */
function tokAt(toks: Token[], k: number): Token | undefined {
  return toks[k];
}

/** Read a qualified table ref starting at index `i`: skip leading punct, then `name` or `schema.name`. */
function readTableRef(toks: Token[], i: number): { name: string; next: number } | null {
  let j = i;
  // skip leading punctuation (except '.', which is part of a qualified name)
  for (let t = tokAt(toks, j); t && t.type === 'punct' && t.text !== '.'; t = tokAt(toks, j)) j++;
  const head = tokAt(toks, j);
  if (!head || head.type !== 'word') return null;
  const parts: string[] = [head.raw];
  j++;
  const dot = tokAt(toks, j);
  const second = tokAt(toks, j + 1);
  if (dot && dot.type === 'punct' && dot.text === '.' && second && second.type === 'word') {
    parts.push(second.raw);
    j += 2;
  }
  return { name: parts.join('.'), next: j };
}

/** Push the table following a FROM/JOIN/USING anchor at index `i` (reads sources for any verb). */
function pushFromTable(toks: Token[], i: number, tables: string[]): void {
  const ref = readTableRef(toks, i + 1);
  if (ref && !tables.includes(ref.name)) tables.push(ref.name);
}

/**
 * Best-effort extraction of table + column references from a DML token list. Tolerant: misses are
 * acceptable (the resolver re-resolves tables against the schema catalog; columns are advisory).
 *
 * Verb-aware and ORDER-sensitive: the WRITE target is always pushed first so {@link sqlRoles} can
 * split a single ordered list into (writes, reads). The verb has already been consumed by the
 * caller, so `toks` begins at the first token AFTER the verb.
 *
 *   select → reads FROM/JOIN tables (INTO target is a variable, NOT a table)
 *   insert → writes the INTO table (first), reads any FROM source (INSERT…SELECT)
 *   update → writes the target (first token), reads any FROM source, columns = SET cols
 *   delete → writes the FROM table
 *   merge  → writes the INTO target (first), reads the USING source
 */
function extractSqlRefs(verb: string, toks: Token[]): { tables: string[]; columns: string[] } {
  const tables: string[] = [];
  const columns: string[] = [];

  // collect every table referenced by a FROM/JOIN/USING anchor (read sources)
  const collectFromTables = (): void => {
    for (let i = 0; i < toks.length; i++) {
      const t = tokAt(toks, i);
      if (!t || t.type !== 'word') continue;
      if (t.text === 'from' || t.text === 'join' || t.text === 'using')
        pushFromTable(toks, i, tables);
    }
  };

  if (verb === 'select') {
    // tables: FROM/JOIN only. SELECT…INTO <var> is NOT a table — skip the INTO target.
    collectFromTables();
    // columns: the select list (words before the first FROM/WHERE at depth 0; stop at INTO).
    let depth = 0;
    let pastInto = false;
    for (let i = 0; i < toks.length; i++) {
      const t = tokAt(toks, i);
      if (!t) break;
      if (t.type === 'punct' && t.text === '(') depth++;
      else if (t.type === 'punct' && t.text === ')') depth--;
      if (depth !== 0) continue;
      if (t.type === 'word' && (t.text === 'from' || t.text === 'where')) break;
      if (t.type === 'word' && t.text === 'into') {
        pastInto = true;
        continue;
      }
      if (!pastInto && t.type === 'word' && !['distinct', 'all', 'as'].includes(t.text)) {
        columns.push(t.raw);
      }
    }
  } else if (verb === 'insert' || verb === 'merge') {
    // target: the table right after the first INTO (write target, pushed first).
    for (let i = 0; i < toks.length; i++) {
      const t = tokAt(toks, i);
      if (t && t.type === 'word' && t.text === 'into') {
        const ref = readTableRef(toks, i + 1);
        if (ref && !tables.includes(ref.name)) tables.push(ref.name);
        break;
      }
    }
    // source: FROM/JOIN (INSERT…SELECT) or USING (MERGE…USING) — reads.
    collectFromTables();
  } else if (verb === 'update') {
    // target: the first word token (right after the UPDATE verb). Write target, pushed first.
    const ref = readTableRef(toks, 0);
    if (ref && !tables.includes(ref.name)) tables.push(ref.name);
    collectFromTables();
    // columns: SET col = …
    for (let i = 0; i < toks.length; i++) {
      const t = tokAt(toks, i);
      if (!t || t.type !== 'word' || t.text !== 'set') continue;
      let j = i + 1;
      while (j < toks.length) {
        const c = tokAt(toks, j);
        if (!c || c.type === 'eof' || c.text === 'where') break;
        if (c.type === 'word' && !REF_STOP.has(c.text)) {
          columns.push(c.raw);
          // skip to the next ',' or '='
          while (j < toks.length) {
            const s = tokAt(toks, j);
            if (!s || s.text === ',' || (s.type === 'op' && s.text === '=') || s.text === 'where')
              break;
            j++;
          }
          const sep = tokAt(toks, j);
          if (sep && sep.text === ',') {
            j++;
            continue;
          }
          break;
        }
        j++;
      }
      break;
    }
  } else if (verb === 'delete') {
    // DELETE FROM <target> — the FROM table is the write target.
    collectFromTables();
  }

  return { tables: dedupe(tables), columns: dedupe(columns) };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Map a DML verb + its ordered table refs (as captured by {@link extractSqlRefs}) to read/write
 * roles. Used by BOTH the extractor (local refs) and the resolver (cross-file refs) so the same
 * statement never produces conflicting roles.
 *
 *   select → reads all
 *   insert → writes the INTO table (first), reads any source (rest)
 *   update → writes the target table (first), reads joined sources (rest)
 *   delete → writes the FROM table (first)
 *   merge  → writes the INTO target (first), reads the USING source (rest)
 */
export function sqlRoles(verb: string, tables: string[]): { reads: string[]; writes: string[] } {
  switch (verb) {
    case 'select':
      return { reads: [...tables], writes: [] };
    case 'insert':
    case 'merge':
      return { writes: tables.slice(0, 1), reads: tables.slice(1) };
    case 'update':
      return { writes: tables.slice(0, 1), reads: tables.slice(1) };
    case 'delete':
      return { writes: tables.slice(0, 1), reads: [] };
    default:
      return { reads: [], writes: [] };
  }
}
