/**
 * Python structural parser (M8) — turns the INDENT/DEDENT token stream into a declaration tree
 * (classes / functions / methods) plus a flat list of call sites. It is deliberately NOT a full
 * Python expression parser: the symbol graph only needs declaration spans + nesting (for
 * member-of + qualified names) and call-site heads (for intra-file `calls`), so a structural
 * descent over compound statements is enough — and far less surface area to get wrong.
 *
 * Tolerant: a malformed header degrades to skipping the logical line (no declaration emitted),
 * never throws. The extractor wraps the whole call in try/catch anyway and falls back to a file
 * node, but this parser aims to never need that.
 *
 * Call-site detection is a separate pass over the tokens (see {@link collectCallSites}) so it is
 * robust to arbitrary nesting: a `NAME (.NAME)* (` pattern is a call, attributed to the enclosing
 * declaration by line range (mirrors the TypeScript extractor's `enclosingSymbol`).
 */
import { EXPR_MAX_CHARS } from '../types.js';
import { isKeyword, tokenize } from './lexer.js';
import type { Token } from './lexer.js';

export type DefKind = 'class' | 'function' | 'method';

export interface PyDef {
  kind: DefKind;
  name: string;
  /** 1-based line of the `class`/`def` keyword. */
  startLine: number;
  /** 1-based line of the last token inside the suite (inclusive end). */
  endLine: number;
  async: boolean;
  decorators: string[];
  /** base-expression head names (`class C(Base, mix.Mixin)` → ["Base", "Mixin"]). */
  bases: string[];
  /** parameter names (for signatures). */
  params: string[];
  /** nested declarations in source order (flattened from the statement tree, includes defs nested
   *  under compound statements — preserves the pre-Track-3 splice behavior). */
  body: PyDef[];
  /** Track 3: the statement tree of this def's suite (compound statements + action lines), walked
   *  by the extractor with a guard stack to emit condition/statement/executes/guarded-by. */
  statements: PyStmt[];
  /** Schema 1.2: the docstring of this def/class (the first statement of the suite when it is a
   *  bare string literal) — surfaced as an `explanation` node by the extractor. Undefined when the
   *  suite has no leading string expression. */
  docstring?: { startLine: number; endLine: number; text: string };
}

// ---------------------------------------------------------------------------------------------
// Statement tree (Track 3) — one node per logical line / compound header in a function suite.
// Tolerant + lossy: a malformed compound degrades to skipping its body (never throws). Predicate
// text is a best-effort source slice between the header keyword and its `:`.
// ---------------------------------------------------------------------------------------------

/** One branch of an `if`/`elif`/`else` chain. */
export interface PyIfBranch {
  /** 'then' (the `if` branch) | 'elif' | 'else'. */
  polarity: 'then' | 'elif' | 'else';
  /** 1-based line of the branch header keyword (`if`/`elif`/`else`). */
  line: number;
  /** predicate source text (best-effort); undefined for `else`. */
  predicate?: string;
  /** statement tree of the branch body. */
  body: PyStmt[];
}

/** One `except` handler of a `try` statement. */
export interface PyExceptHandler {
  line: number;
  /** exception-type source text (best-effort, e.g. `ValueError as e`); empty for bare `except:`. */
  predicate?: string;
  body: PyStmt[];
}

/** One `case` of a `match` statement. */
export interface PyMatchCase {
  line: number;
  /** case-pattern source text (best-effort). */
  predicate?: string;
  body: PyStmt[];
}

export type PyStmtKind = 'def' | 'if' | 'loop' | 'try' | 'with' | 'match' | 'action';

/** Action subtype for a simple-statement line (the decision-table row kind). */
export type PyActionType = 'call' | 'return' | 'throw' | 'assign' | 'expr' | 'plain';

export interface PyStmt {
  kind: PyStmtKind;
  /** 1-based start line (the header keyword line, or the action line). */
  line: number;
  /** 1-based end line (inclusive). */
  endLine: number;
  /** 'def': the parsed declaration (class/function). */
  def?: PyDef;
  /** 'if': the branches (then/elif/else). */
  branches?: PyIfBranch[];
  /** 'loop': 'for' | 'while'. */
  loopKind?: 'for' | 'while';
  /** predicate text for if/loop/with/match. */
  predicate?: string;
  /** body for loop/with/try. */
  body?: PyStmt[];
  /** except handlers for try. */
  handlers?: PyExceptHandler[];
  /** finally body for try. */
  finallyBody?: PyStmt[];
  /** match cases. */
  cases?: PyMatchCase[];
  /** 'action': the action subtype. */
  action?: PyActionType;
  /** 'action': best-effort source text of the line (≤200 chars). */
  text?: string;
  /** 'action': callee simple name when the action's primary type is 'call' (last segment). */
  head?: string;
  /** 'action': ALL call chains found on the line (a `return foo()` carries a call even though its
   *  type is 'return'); used by the extractor to record call sites + annotate `calls` edges. */
  calls?: PyCallRef[];
  /** 'action':'throw' (raise): the exception type name (`raise ValueError(...)` → `ValueError`);
   *  undefined for a bare re-`raise`. */
  raiseName?: string;
  /** 'action':'throw' (raise): the first string-literal argument's inner text, when identifiable
   *  (`raise ValueError("bad")` → `bad`); undefined when no string literal is given. */
  raiseMessage?: string;
  /** 'action':'assign': the cleaned assignment target (LHS), e.g. `result` / `self.foo` / `a, b`. */
  assignTarget?: string;
}

/** One call chain found on an action line: `self.issue(`, `helper(`, `a.login(`, … */
export interface PyCallRef {
  /** first segment of the chain (`self` / `cls` / a bare name / an object/module name). */
  head: string;
  /** full dotted chain (`self.issue` → ["self", "issue"]). */
  chain: string[];
  /** last segment — the callee simple name being invoked. */
  callee: string;
  /** 1-based line of the call's head token (the call-site line). */
  line: number;
}

export interface PyCallSite {
  /** callee head: `self` / `cls` / a bare name / an imported module name. */
  head: string;
  /** dotted tail after the head (`self.issue` → ["issue"]). */
  tail: string[];
  /** last segment — the function/method name being invoked. */
  name: string;
  /** 1-based line of the call's opening `(`. */
  line: number;
}

/** One name bound by an import: `from m import a as b` → local `b`, original `a`. */
export interface PyImportName {
  local: string;
  original: string;
}

export interface PyImport {
  /** dotted module path as written (`a.b`); empty for `from . import x`. */
  module: string;
  /** number of leading dots (0 = absolute, 1 = `.` current package, 2 = parent …). */
  relative: number;
  /** bound names; for `import M` this is the module binding (local = the bound alias). */
  names: PyImportName[];
  /** `from M import *`. */
  star: boolean;
  /** `import M` (module binding) vs `from M import N` (name binding). */
  isImportStmt: boolean;
  line: number;
}

export interface PyModule {
  defs: PyDef[];
  calls: PyCallSite[];
  imports: PyImport[];
}

/** Parse Python source into a declaration tree + call sites + imports (never throws). */
export function parsePython(src: string): PyModule {
  try {
    const tokens = tokenize(src);
    const p = new Parser(tokens, src);
    const defs = p.parseModule();
    const calls = collectCallSites(tokens);
    const imports = collectImports(tokens);
    return { defs, calls, imports };
  } catch {
    return { defs: [], calls: [], imports: [] };
  }
}

class Parser {
  private readonly t: Token[];
  private i = 0;
  /** line of the last NAME/OP/STRING/NUMBER consumed — the real "content" cursor (DEDENT is lazy). */
  private lastContentLine = 1;
  /** original source, for best-effort predicate/action text slicing. */
  private readonly src: string;
  /** char offset of the start of each 1-based line (lineOffsets[i] = start of line i+1). */
  private readonly lineOffsets: number[];

  constructor(tokens: Token[], src: string) {
    this.t = tokens;
    this.src = src;
    const offsets = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) offsets.push(i + 1);
    this.lineOffsets = offsets;
  }

  parseModule(): PyDef[] {
    const stmts = this.parseBlock(/*stopAtDedent*/ false);
    return collectDefs(stmts);
  }

  /** Parse a block of statements until DEDENT (suite) or ENDMARKER (top level). Returns the tree. */
  private parseBlock(stopAtDedent: boolean): PyStmt[] {
    const stmts: PyStmt[] = [];
    while (!this.atEnd()) {
      if (stopAtDedent && this.is('DEDENT')) break;
      if (this.is('NEWLINE') || this.is('NL')) {
        this.next();
        continue;
      }
      if (this.is('ENDMARKER')) break;
      const before = this.i;
      const s = this.parseStatement();
      if (s) stmts.push(s);
      else if (this.i === before && !this.atEnd() && !(stopAtDedent && this.is('DEDENT'))) {
        // parseStatement made no progress (unrecognized token) — skip to avoid a loop.
        this.next();
      }
    }
    return stmts;
  }

  /** Parse one statement: a declaration (class/function), a compound (if/for/while/try/with/match),
   *  or a simple-statement action line. Returns a statement-tree node, or null on a skipped line. */
  private parseStatement(): PyStmt | null {
    this.skipDecorators();
    if (this.isName('class')) {
      const def = this.parseClass();
      return def ? this.defStmt(def) : null;
    }
    if (this.isName('def')) {
      const def = this.parseFunction(false);
      return def ? this.defStmt(def) : null;
    }
    if (this.isName('async') && this.peekName(1) === 'def') {
      this.next(); // consume 'async'
      const def = this.parseFunction(true);
      return def ? this.defStmt(def) : null;
    }
    if (this.isName('if')) return this.parseIf();
    if (this.isName('for') || this.isName('while')) return this.parseLoop();
    if (this.isName('try')) return this.parseTry();
    if (this.isName('with')) return this.parseWith();
    if (this.isName('match')) return this.parseMatch();
    // stray elif/else/except/finally/case at the top of a block (shouldn't happen if the enclosing
    // compound consumed them) — tolerate by skipping the line so we never throw or loop.
    if (
      this.isName('elif') ||
      this.isName('else') ||
      this.isName('except') ||
      this.isName('finally') ||
      this.isName('case')
    ) {
      this.skipToNewline();
      return null;
    }
    return this.parseAction();
  }

  /** Wrap a parsed def as a statement-tree node. */
  private defStmt(def: PyDef): PyStmt {
    return { kind: 'def', def, line: def.startLine, endLine: def.endLine };
  }

  private parseClass(): PyDef | null {
    const startLine = this.peek().line;
    this.next(); // 'class'
    if (!this.is('NAME')) return null;
    const name = this.peek().value;
    this.next();
    const bases: string[] = [];
    if (this.is('OP') && this.peek().value === '(') {
      bases.push(...this.parseBaseList());
    }
    // pop decorators NOW, before descending into the suite — otherwise the first child def would
    // steal this def's pending decorators via its own popDecorators().
    const decorators = this.popDecorators();
    if (!this.consumeColon()) return null;
    const statements = this.parseSuite();
    const endLine = stmtsEnd(statements, this.lastContentLine, startLine);
    return {
      kind: 'class',
      name,
      startLine,
      endLine,
      async: false,
      decorators,
      bases,
      params: [],
      body: collectDefs(statements),
      statements,
      ...extractDocstring(statements),
    };
  }

  private parseFunction(async: boolean): PyDef | null {
    const startLine = this.peek().line;
    this.next(); // 'def'
    if (!this.is('NAME')) return null;
    const name = this.peek().value;
    this.next();
    const params: string[] = [];
    if (this.is('OP') && this.peek().value === '(') {
      params.push(...this.parseParamList());
    }
    const decorators = this.popDecorators();
    if (!this.consumeColon()) return null;
    const statements = this.parseSuite();
    const endLine = stmtsEnd(statements, this.lastContentLine, startLine);
    return {
      // kind is refined by the extractor (method vs function) using the nesting context.
      kind: 'function',
      name,
      startLine,
      endLine,
      async,
      decorators,
      bases: [],
      params,
      body: collectDefs(statements),
      statements,
      ...extractDocstring(statements),
    };
  }

  /** Parse a class base list up to the closing `)`; returns head names of each base expression. */
  private parseBaseList(): string[] {
    this.next(); // '('
    const bases: string[] = [];
    let depth = 1;
    let head: string | null = null;
    while (!this.atEnd() && depth > 0) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') {
        depth++;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ')') {
        depth--;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ',') {
        if (head) bases.push(head);
        head = null;
        this.next();
        continue;
      }
      if (tk.type === 'NAME' && head === null && !isKeyword(tk.value)) head = tk.value;
      this.next();
    }
    if (head) bases.push(head);
    return bases;
  }

  /** Parse a parameter list up to `)`; returns the param names (skips defaults, annotations, *args). */
  private parseParamList(): string[] {
    this.next(); // '('
    const params: string[] = [];
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') {
        depth++;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ')') {
        depth--;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && (tk.value === ',' || tk.value === ':')) {
        this.next();
        continue;
      }
      if (tk.type === 'OP' && (tk.value === '*' || tk.value === '/')) {
        this.next();
        continue;
      }
      if (tk.type === 'NAME' && !isKeyword(tk.value)) {
        params.push(tk.value);
        // skip to the next `,` / `)` / `:` (covers `= default` and `: annotation`)
        while (
          !this.atEnd() &&
          !(this.is('OP') && (this.peek().value === ',' || this.peek().value === ')'))
        ) {
          this.next();
        }
        continue;
      }
      this.next();
    }
    return params;
  }

  /**
   * Parse a suite following a `:` (the colon was consumed by the caller). Returns the statement
   * tree of the suite. A multi-line suite (INDENT…DEDENT) is parsed via {@link parseBlock}; a
   * one-liner suite (`if x: return f()`) parses a single statement on the same line. Lossy: a
   * malformed one-liner degrades to skipping the line.
   */
  private parseSuite(): PyStmt[] {
    while (this.is('NEWLINE') || this.is('NL')) this.next();
    if (this.is('INDENT')) {
      this.next();
      const stmts = this.parseBlock(/*stopAtDedent*/ true);
      if (this.is('DEDENT')) this.next();
      return stmts;
    }
    // one-liner suite: parse a single statement on the same line (best-effort).
    if (!this.atEnd() && !this.is('NEWLINE') && !this.is('NL') && !this.is('ENDMARKER')) {
      const s = this.parseStatement();
      if (s) return [s];
      this.skipToNewline();
    }
    return [];
  }

  // --- compound statements (Track 3) --------------------------------------------

  /** Parse `if cond: … / elif cond: … / else: …` into a statement node with branches. */
  private parseIf(): PyStmt | null {
    const ifLine = this.peek().line;
    this.next(); // 'if'
    const pred = this.capturePredicate();
    if (!pred.ok) {
      this.skipToNewline();
      return null; // malformed header — degrade to skipping
    }
    const body = this.parseSuite();
    const branches: PyIfBranch[] = [{ polarity: 'then', line: ifLine, predicate: pred.text, body }];
    let endLine = stmtsEnd(body, this.lastContentLine, ifLine);
    while (this.isName('elif')) {
      const elLine = this.peek().line;
      this.next(); // 'elif'
      const ep = this.capturePredicate();
      if (!ep.ok) {
        this.skipToNewline();
        break;
      }
      const eb = this.parseSuite();
      branches.push({ polarity: 'elif', line: elLine, predicate: ep.text, body: eb });
      endLine = Math.max(endLine, stmtsEnd(eb, this.lastContentLine, elLine));
    }
    if (this.isName('else')) {
      const elLine = this.peek().line;
      this.next(); // 'else'
      if (!this.consumeColon()) {
        this.skipToNewline();
      } else {
        const eb = this.parseSuite();
        branches.push({ polarity: 'else', line: elLine, body: eb });
        endLine = Math.max(endLine, stmtsEnd(eb, this.lastContentLine, elLine));
      }
    }
    return { kind: 'if', line: ifLine, endLine, branches };
  }

  /** Parse `for … :` / `while … :` into a loop statement node (predicate → one LOOP condition). */
  private parseLoop(): PyStmt | null {
    const loopKind = this.peek().value === 'for' ? 'for' : 'while';
    const line = this.peek().line;
    this.next(); // 'for'/'while'
    const pred = this.capturePredicate();
    if (!pred.ok) {
      this.skipToNewline();
      return null;
    }
    const body = this.parseSuite();
    return {
      kind: 'loop',
      line,
      endLine: stmtsEnd(body, this.lastContentLine, line),
      loopKind,
      predicate: pred.text,
      body,
    };
  }

  /** Parse `with … :` — a context manager; no condition node, body walked under the same guard. */
  private parseWith(): PyStmt | null {
    const line = this.peek().line;
    this.next(); // 'with'
    const pred = this.capturePredicate();
    if (!pred.ok) {
      this.skipToNewline();
      return null;
    }
    const body = this.parseSuite();
    return { kind: 'with', line, endLine: stmtsEnd(body, this.lastContentLine, line), body };
  }

  /** Parse `try: … except …: … finally: …` — no condition nodes; bodies walked inException=true. */
  private parseTry(): PyStmt | null {
    const line = this.peek().line;
    this.next(); // 'try'
    if (!this.consumeColon()) {
      this.skipToNewline();
      return null;
    }
    const body = this.parseSuite();
    const handlers: PyExceptHandler[] = [];
    let finallyBody: PyStmt[] | undefined;
    let endLine = stmtsEnd(body, this.lastContentLine, line);
    while (this.isName('except')) {
      const hLine = this.peek().line;
      this.next(); // 'except'
      const hp = this.capturePredicate(); // `except:`, `except ValueError as e:` → text up to colon
      if (!hp.ok) {
        this.skipToNewline();
        break;
      }
      const hb = this.parseSuite();
      handlers.push({ line: hLine, predicate: hp.text, body: hb });
      endLine = Math.max(endLine, stmtsEnd(hb, this.lastContentLine, hLine));
    }
    if (this.isName('finally')) {
      const fLine = this.peek().line;
      this.next(); // 'finally'
      if (!this.consumeColon()) {
        this.skipToNewline();
      } else {
        finallyBody = this.parseSuite();
        endLine = Math.max(endLine, stmtsEnd(finallyBody, this.lastContentLine, fLine));
      }
    }
    return { kind: 'try', line, endLine, body, handlers, finallyBody };
  }

  /**
   * Parse `match expr: / case pat: …` — one CASE condition per case predicate. The case arms form
   * an INDENT…DEDENT suite under `match expr:` (just like an if-body), so the NEWLINE + INDENT must
   * be consumed before the first `case` and the trailing DEDENT after the last arm; without that the
   * arms were silently dropped (the `while isName('case')` saw NEWLINE first and bailed). Each arm's
   * own suite is parsed by {@link parseSuite} as usual.
   */
  private parseMatch(): PyStmt | null {
    const line = this.peek().line;
    this.next(); // 'match'
    const pred = this.capturePredicate();
    if (!pred.ok) {
      this.skipToNewline();
      return null;
    }
    const cases: PyMatchCase[] = [];
    let endLine = line;
    // the case arms live in an indented suite under `match expr:` — skip the NEWLINE + INDENT.
    while (this.is('NEWLINE') || this.is('NL')) this.next();
    if (this.is('INDENT')) {
      this.next();
      while (this.isName('case')) {
        const cLine = this.peek().line;
        this.next(); // 'case'
        const cp = this.capturePredicate();
        if (!cp.ok) {
          this.skipToNewline();
          break;
        }
        const cb = this.parseSuite();
        cases.push({ line: cLine, predicate: cp.text, body: cb });
        endLine = Math.max(endLine, stmtsEnd(cb, this.lastContentLine, cLine));
        // tolerate blank lines between arms before the next `case` / the closing DEDENT.
        while (this.is('NEWLINE') || this.is('NL')) this.next();
      }
      if (this.is('DEDENT')) this.next();
    }
    return { kind: 'match', line, endLine, predicate: pred.text, cases };
  }

  // --- simple statements (Track 3 action lines) --------------------------------

  /**
   * Parse a simple-statement line into an action node (call/return/throw/assign/expr) or null (skip
   * plain expressions — keep the graph lean per spec §2). Best-effort: the line text is a source
   * slice; the callee simple name is the last segment of the first call chain found.
   *
   * Schema 1.2: `raise <Ex>(...)` surfaces the exception name + first string-literal message;
   * `lhs = rhs` / `lhs := rhs` / augmented assigns surface the cleaned LHS target; a bare leading
   * string literal (the docstring convention) surfaces as 'expr' so {@link parseFunction} can
   * capture it onto {@link PyDef.docstring}. Pure exprs without a call still return null.
   */
  private parseAction(): PyStmt | null {
    if (
      this.atEnd() ||
      this.is('NEWLINE') ||
      this.is('NL') ||
      this.is('DEDENT') ||
      this.is('ENDMARKER')
    ) {
      return null;
    }
    const toks = this.collectLineTokens();
    if (toks.length === 0) return null;
    const first = toks[0]!;
    const last = toks[toks.length - 1]!;
    const line = first.line;
    // collect EVERY call chain on the line (a `return foo()` carries a call even though its type is
    // 'return'); the extractor records call sites + annotates calls edges from these.
    const calls = findAllCallChains(toks);
    const text = truncate(
      this.sliceSrc(first.line, first.col, last.line, last.col + last.value.length),
      EXPR_MAX_CHARS,
    );
    // shared shape for every action line; each branch spreads `base` + its action subtype + extras.
    const base = {
      kind: 'action' as const,
      line,
      endLine: last.line,
      text,
      ...(calls.length ? { calls } : {}),
    };

    // raise <Exception>(...) / bare raise → 'throw' with the exception name + message (schema 1.2).
    if (first.type === 'NAME' && first.value === 'raise') {
      const { name, message } = parseRaise(toks);
      return {
        ...base,
        action: 'throw',
        ...(name ? { raiseName: name } : {}),
        ...(message !== undefined ? { raiseMessage: message } : {}),
      };
    }
    // assignment `lhs = rhs` / `lhs := rhs` / augmented `lhs += rhs` (any `=` or `:=` at bracket
    // depth 0) → 'assign' with the cleaned LHS target; the RHS call (if any) is still recorded.
    const assign = findAssignOp(toks);
    if (assign) {
      const lhsText = this.sliceSrc(first.line, first.col, assign.opStartLine, assign.opStartCol);
      return { ...base, action: 'assign', assignTarget: cleanAssignTarget(lhsText) };
    }
    if (first.type === 'NAME' && first.value === 'return') return { ...base, action: 'return' };
    if (calls.length > 0) return { ...base, action: 'call', head: calls[0]!.callee };
    // a bare string expression (docstring convention: first statement of a suite) → 'expr' carrying
    // the raw literal; multiline triple-quoted literals derive endLine from embedded newlines.
    if (first.type === 'STRING') {
      return { ...base, action: 'expr', endLine: first.line + countNewlines(first.value) };
    }
    return null;
  }

  /** Gather tokens of one logical line (across bracket-continuation lines) up to NEWLINE at
   *  bracket-depth 0; advance the cursor past the NEWLINE. */
  private collectLineTokens(): Token[] {
    const out: Token[] = [];
    let depth = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP' && (tk.value === '(' || tk.value === '[' || tk.value === '{')) depth++;
      else if (tk.type === 'OP' && (tk.value === ')' || tk.value === ']' || tk.value === '}')) {
        depth = Math.max(0, depth - 1);
      }
      if (tk.type === 'NEWLINE' && depth === 0) {
        this.next();
        break;
      }
      if (tk.type === 'ENDMARKER') break;
      if (tk.type === 'NL' && depth === 0) {
        this.next();
        continue;
      }
      out.push(tk);
      this.next();
    }
    return out;
  }

  /**
   * Scan from the current token to the `:` at bracket-depth 0, consuming it. Returns the predicate
   * source text (best-effort) sliced from the original source. On a malformed header (NEWLINE before
   * the colon), returns `{ ok: false }` and leaves the cursor at the NEWLINE.
   */
  private capturePredicate(): { text: string; ok: boolean } {
    const startLine = this.peek().line;
    const startCol = this.peek().col;
    let depth = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') {
        depth++;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ')') {
        depth = Math.max(0, depth - 1);
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ':' && depth === 0) {
        const text = this.sliceSrc(startLine, startCol, tk.line, tk.col);
        this.next(); // consume ':'
        return { text: text.trim(), ok: true };
      }
      if (tk.type === 'NEWLINE' && depth === 0) return { text: '', ok: false }; // malformed
      this.next();
    }
    return { text: '', ok: false };
  }

  /** Slice the original source by 1-based (line, col) start..end (end exclusive). */
  private sliceSrc(startLine: number, startCol: number, endLine: number, endCol: number): string {
    const start = (this.lineOffsets[startLine - 1] ?? 0) + (startCol - 1);
    const end = (this.lineOffsets[endLine - 1] ?? 0) + (endCol - 1);
    return start < end ? this.src.slice(start, end) : '';
  }

  // --- decorators ---------------------------------------------------------------

  private pendingDecorators: string[] = [];

  private skipDecorators(): void {
    while (this.is('OP') && this.peek().value === '@') {
      this.next();
      const names: string[] = [];
      while (!this.atEnd() && !this.is('NEWLINE') && !this.is('NL')) {
        if (this.is('NAME')) names.push(this.peek().value);
        else if (this.is('OP') && this.peek().value === '.') {
          // dotted decorator — keep only the head for honesty
        }
        // stop at the decorator's argument list
        if (this.is('OP') && this.peek().value === '(') {
          this.skipParens();
          continue;
        }
        this.next();
      }
      this.pendingDecorators.push(names[0] ?? '<anon>');
      while (this.is('NEWLINE') || this.is('NL')) this.next();
    }
  }

  private popDecorators(): string[] {
    const d = this.pendingDecorators;
    this.pendingDecorators = [];
    return d;
  }

  // --- small utilities ----------------------------------------------------------

  private skipParens(): void {
    if (!(this.is('OP') && this.peek().value === '(')) return;
    let depth = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') depth++;
      else if (tk.type === 'OP' && tk.value === ')') {
        depth--;
        this.next();
        if (depth === 0) return;
        continue;
      }
      this.next();
    }
  }

  private consumeColon(): boolean {
    while (this.is('NEWLINE') || this.is('NL')) this.next();
    if (this.is('OP') && this.peek().value === ':') {
      this.next();
      return true;
    }
    return false;
  }

  private skipToNewline(): void {
    while (!this.atEnd() && !this.is('NEWLINE')) this.next();
    if (this.is('NEWLINE')) this.next();
  }

  private next(): Token {
    const tk = this.t[this.i++] ?? { type: 'ENDMARKER', value: '', line: 0, col: 0 };
    // track the last *content* line so a def's endLine is the real last statement line, not the
    // lazy DEDENT (which is emitted at the following line's start, possibly after blank lines).
    if (tk.type === 'NAME' || tk.type === 'OP' || tk.type === 'STRING' || tk.type === 'NUMBER') {
      // a STRING token's `.line` is its START line; a triple-quoted string may span many lines, so
      // advance lastContentLine by the newlines inside the literal (the closer's line). Without this
      // a def/class whose last statement is a multiline docstring gets endLine = docstring start.
      const endLine = tk.type === 'STRING' ? tk.line + countNewlines(tk.value) : tk.line;
      if (endLine > this.lastContentLine) this.lastContentLine = endLine;
    }
    return tk;
  }

  private is(type: Token['type']): boolean {
    return this.peek().type === type;
  }
  private isName(value: string): boolean {
    return this.is('NAME') && this.peek().value === value;
  }
  private peek(offset = 0): Token {
    return this.t[this.i + offset] ?? { type: 'ENDMARKER', value: '', line: 0, col: 0 };
  }
  private peekName(offset: number): string | undefined {
    const tk = this.peek(offset);
    return tk.type === 'NAME' ? tk.value : undefined;
  }
  private atEnd(): boolean {
    return this.i >= this.t.length || this.peek().type === 'ENDMARKER';
  }
}

/** End line of a suite = max(last content line, deepest last-statement end line, start). */
function stmtsEnd(stmts: PyStmt[], lastContentLine: number, startLine: number): number {
  let end = Math.max(lastContentLine, startLine);
  for (const s of stmts) end = Math.max(end, s.endLine);
  return end;
}

/**
 * Flatten a statement tree into the nested-declaration list (preserves the pre-Track-3 splice
 * behavior: a def nested under a compound statement is collected into the enclosing body). Used
 * to populate {@link PyDef.body} from {@link PyDef.statements} so the existing symbol/member-of
 * emission is unchanged.
 */
function collectDefs(stmts: PyStmt[]): PyDef[] {
  const out: PyDef[] = [];
  for (const s of stmts) {
    switch (s.kind) {
      case 'def':
        if (s.def) out.push(s.def);
        break;
      case 'if':
        for (const b of s.branches ?? []) out.push(...collectDefs(b.body));
        break;
      case 'loop':
      case 'with':
        out.push(...collectDefs(s.body ?? []));
        break;
      case 'try':
        out.push(...collectDefs(s.body ?? []));
        for (const h of s.handlers ?? []) out.push(...collectDefs(h.body));
        if (s.finallyBody) out.push(...collectDefs(s.finallyBody));
        break;
      case 'match':
        for (const c of s.cases ?? []) out.push(...collectDefs(c.body));
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Find every call chain `NAME (.NAME)* (` in a line's tokens (skipping control keywords), in source
 * order. Each match yields the head (first name), the full chain, the callee simple name (last
 * segment), and the call-site line (the head token's line). Mirrors the flat
 * {@link collectCallSites} scan so the body-walk resolves calls the same way the call-graph pass
 * does.
 */
function findAllCallChains(toks: Token[]): PyCallRef[] {
  const out: PyCallRef[] = [];
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i]!;
    if (tk.type !== 'NAME' || isKeyword(tk.value)) {
      i++;
      continue;
    }
    const chain = [tk.value];
    let j = i + 1;
    while (
      j < toks.length &&
      toks[j]!.type === 'OP' &&
      toks[j]!.value === '.' &&
      toks[j + 1]?.type === 'NAME'
    ) {
      chain.push(toks[j + 1]!.value);
      j += 2;
    }
    if (j < toks.length && toks[j]!.type === 'OP' && toks[j]!.value === '(') {
      out.push({ head: chain[0]!, chain, callee: chain[chain.length - 1]!, line: tk.line });
      i = j + 1; // resume after this call's `(` to find further calls (e.g. `foo() + bar()`)
      continue;
    }
    i++;
  }
  return out;
}

/** Truncate a statement source text to a cap (spec §2: ≤200 chars) with an ellipsis marker. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Number of `\n` in a string literal's raw token value (for multiline triple-quoted span math). */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Schema 1.2 helpers — raise/assignment/docstring surface extraction (best-effort, lossy).
// ---------------------------------------------------------------------------------------------

/** True for a single char that can prefix a Python string literal (r/b/f/u, any case). */
function isStringPrefixChar(c: string): boolean {
  const l = c.toLowerCase();
  return l === 'r' || l === 'b' || l === 'f' || l === 'u';
}

/**
 * Strip the prefix + surrounding quotes (single or triple) of a STRING token's raw value and return
 * the inner literal text. Tolerant: if the shape is unexpected, returns the value minus any prefix.
 * Used for `raise Ex("msg")` → `msg` and for docstring `meta.text`.
 */
export function stringLiteralInner(v: string): string {
  let i = 0;
  while (i < v.length && isStringPrefixChar(v[i]!)) i++;
  const rest = v.slice(i);
  if (rest.length < 2) return rest;
  const q = rest[0]!;
  if (q !== '"' && q !== "'") return rest;
  // triple-quoted: opening + closing run of three
  if (rest.length >= 6 && rest[1] === q && rest[2] === q && rest.endsWith(q.repeat(3))) {
    return rest.slice(3, rest.length - 3);
  }
  // single-quoted
  if (rest.endsWith(q)) return rest.slice(1, rest.length - 1);
  return rest; // unterminated — return what we have
}

/**
 * From the tokens of a `raise` line (toks[0] === 'raise'), recover the exception type name (the
 * next NAME, if any) and the first STRING literal inside the following `(...)` (the message). Both
 * are optional — a bare re-`raise` yields neither; `raise Foo()` yields a name but no message.
 */
function parseRaise(toks: Token[]): { name?: string; message?: string } {
  let i = 1;
  const nameTk = toks[i];
  let name: string | undefined;
  if (nameTk && nameTk.type === 'NAME' && !isKeyword(nameTk.value)) {
    name = nameTk.value;
    i++;
  }
  let message: string | undefined;
  const open = toks[i];
  if (open && open.type === 'OP' && open.value === '(') {
    for (let j = i + 1; j < toks.length; j++) {
      const tk = toks[j]!;
      if (tk.type === 'OP' && tk.value === ')') break;
      if (tk.type === 'STRING') {
        message = stringLiteralInner(tk.value);
        break;
      }
    }
  }
  const out: { name?: string; message?: string } = {};
  if (name) out.name = name;
  if (message !== undefined) out.message = message;
  return out;
}

/** Single-char OPs that combine with `=` to form an augmented assignment (`+=`, `<<=`, `**=`, …). */
const AUGMENT_PREFIXES = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '@',
  '<',
  '>',
  '<<',
  '>>',
  '**',
  '//',
]);

/**
 * Find the first assignment operator at bracket depth 0 in a line's tokens: a lone `=` or `:=`. The
 * lexer emits `==`/`>=`/`!=`/`<=` as single tokens, so a lone `=` is unambiguously assignment. For
 * augmented forms (`x += 5` lexes as NAME OP(+) OP(=)), the operator start is the preceding prefix
 * token so the LHS slice excludes it. Returns the operator's start (line, col) or null.
 */
function findAssignOp(toks: Token[]): { opStartLine: number; opStartCol: number } | null {
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i]!;
    if (tk.type === 'OP' && (tk.value === '(' || tk.value === '[' || tk.value === '{')) depth++;
    else if (tk.type === 'OP' && (tk.value === ')' || tk.value === ']' || tk.value === '}')) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && tk.type === 'OP' && (tk.value === '=' || tk.value === ':=')) {
      const prev = toks[i - 1];
      if (prev && prev.type === 'OP' && AUGMENT_PREFIXES.has(prev.value)) {
        return { opStartLine: prev.line, opStartCol: prev.col };
      }
      return { opStartLine: tk.line, opStartCol: tk.col };
    }
  }
  return null;
}

/**
 * Clean an assignment LHS slice: strip a top-level type annotation (`x: int = …` → `x`) without
 * touching subscript-slice colons (`x[0:5] = …` → `x[0:5]`), and trim whitespace. Tuple/unpacking
 * targets (`a, b = …`) and attribute targets (`self.foo = …`) are returned verbatim.
 */
function cleanAssignTarget(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) return s.slice(0, i).trim();
  }
  return s.trim();
}

/**
 * If the first statement of a suite is a bare string expression (the docstring convention), return
 * `{ docstring: { startLine, endLine, text } }` so the extractor can emit an `explanation` node.
 * Returns `{}` otherwise. The raw literal (with quotes/prefix) is carried; the extractor cleans it.
 */
function extractDocstring(statements: PyStmt[]): { docstring?: PyDef['docstring'] } {
  const first = statements[0];
  if (!first || first.kind !== 'action' || first.action !== 'expr' || !first.text) return {};
  return { docstring: { startLine: first.line, endLine: first.endLine, text: first.text } };
}

/**
 * Scan the token stream for call expressions: `NAME (.NAME)* (`. The callee `name` is the last
 * NAME before the `(`; `head` is the first NAME; `tail` is the chain in between. Keyword-call
 * arguments (`foo(x=1)`) are fine — the `(` still follows `foo`.
 */
export function collectCallSites(tokens: Token[]): PyCallSite[] {
  const calls: PyCallSite[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME' || isKeyword(tk.value)) {
      i++;
      continue;
    }
    // gather a dotted chain NAME (. NAME)*
    const chain: string[] = [tk.value];
    const line = tk.line;
    let j = i + 1;
    while (
      j < tokens.length &&
      tokens[j]!.type === 'OP' &&
      tokens[j]!.value === '.' &&
      tokens[j + 1] &&
      tokens[j + 1]!.type === 'NAME'
    ) {
      chain.push(tokens[j + 1]!.value);
      j += 2;
    }
    if (j < tokens.length && tokens[j]!.type === 'OP' && tokens[j]!.value === '(') {
      // exclude `def name(` and `class name(` — those are definitions, not calls.
      if (!isDefKeywordAt(tokens, i - 1)) {
        calls.push({
          head: chain[0]!,
          tail: chain.slice(1),
          name: chain[chain.length - 1]!,
          line,
        });
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return calls;
}

/** True if the token at `idx` is `def`/`class` (so the following NAME is a definition, not a call). */
function isDefKeywordAt(tokens: Token[], idx: number): boolean {
  const tk = tokens[idx];
  if (!tk || tk.type !== 'NAME') return false;
  // tolerate `async def`: the NAME before `def` is `async` — so also check idx-1.
  return tk.value === 'def' || tk.value === 'class';
}

/**
 * Scan the token stream for import statements — `import M` (module binding) and `from M import N`
 * (name binding), including relative forms (`from .x import y`, `from . import z`), multi-module
 * `import a, b`, and aliases (`as`). Tolerant: a malformed import just yields fewer names, never
 * throws. `from <x>` without a following `import` (e.g. `yield from x`) is NOT an import and skipped.
 */
export function collectImports(tokens: Token[]): PyImport[] {
  const out: PyImport[] = [];
  let i = 0;
  const isName = (k: number) => tokens[k]?.type === 'NAME';
  const isNameVal = (k: number, v: string) => tokens[k]?.type === 'NAME' && tokens[k]?.value === v;
  const isOp = (k: number, v: string) => tokens[k]?.type === 'OP' && tokens[k]?.value === v;
  const atLineEnd = (k: number) =>
    !tokens[k] || tokens[k]!.type === 'NEWLINE' || tokens[k]!.type === 'ENDMARKER';

  /** Consume leading dots → relative count; return the new cursor. */
  const consumeDots = (k: number): { j: number; relative: number } => {
    let relative = 0;
    let j = k;
    while (isOp(j, '.')) {
      relative++;
      j++;
    }
    return { j, relative };
  };

  /** Consume a dotted module path (NAME (. NAME)*); return parts + new cursor. */
  const consumeModule = (k: number): { parts: string[]; j: number } => {
    const parts: string[] = [];
    let j = k;
    while (isName(j)) {
      parts.push(tokens[j]!.value);
      j++;
      if (isOp(j, '.')) {
        j++;
        continue;
      }
      break;
    }
    return { parts, j };
  };

  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME') {
      i++;
      continue;
    }

    if (tk.value === 'from') {
      const line = tk.line;
      let j = i + 1;
      const dots = consumeDots(j);
      j = dots.j;
      const relative = dots.relative;
      // `from . import x` (no module name) — module is empty; 'import' follows the dots directly.
      // Check this BEFORE consumeModule, otherwise 'import' (a NAME) would be swallowed into modParts.
      if (isNameVal(j, 'import')) {
        j++;
        out.push(...collectFromNames(tokens, j, '', relative, line));
        i = j;
        continue;
      }
      const mod = consumeModule(j);
      j = mod.j;
      if (!isNameVal(j, 'import')) {
        i++; // e.g. `yield from x` — not an import
        continue;
      }
      j++; // consume 'import'
      out.push(...collectFromNames(tokens, j, mod.parts.join('.'), relative, line));
      i = j;
      continue;
    }

    if (tk.value === 'import') {
      const line = tk.line;
      let j = i + 1;
      const dots = consumeDots(j);
      j = dots.j;
      // one or more comma-separated modules: `import a, b.c as d`
      while (!atLineEnd(j)) {
        const mod = consumeModule(j);
        j = mod.j;
        if (mod.parts.length === 0) break; // nothing valid to bind — stop
        const boundName = mod.parts[0] ?? '';
        let local = boundName;
        if (isNameVal(j, 'as')) {
          j++;
          if (isName(j)) {
            local = tokens[j]!.value;
            j++;
          }
        }
        out.push({
          module: mod.parts.join('.'),
          relative: dots.relative,
          names: [{ local, original: boundName }],
          star: false,
          isImportStmt: true,
          line,
        });
        if (isOp(j, ',')) {
          j++;
          continue;
        }
        break;
      }
      // skip any trailing tokens to NEWLINE (e.g. unmatched trailing comma / garbage)
      while (!atLineEnd(j)) j++;
      i = j;
      continue;
    }

    i++;
  }
  return out;
}

/**
 * Collect the imported-name list of a `from M import ...` statement starting at cursor `j`, returning
 * one {@link PyImport} (name binding) — or a star import. Stops at NEWLINE/ENDMARKER. Parenthesized
 * multiline `from m import (a, b)` is handled because '(' / ')' are OP tokens that the scan skips.
 */
function collectFromNames(
  tokens: Token[],
  jIn: number,
  module: string,
  relative: number,
  line: number,
): PyImport[] {
  const isName = (k: number) => tokens[k]?.type === 'NAME';
  const isNameVal = (k: number, v: string) => tokens[k]?.type === 'NAME' && tokens[k]?.value === v;
  const isOp = (k: number, v: string) => tokens[k]?.type === 'OP' && tokens[k]?.value === v;
  const atLineEnd = (k: number) =>
    !tokens[k] || tokens[k]!.type === 'NEWLINE' || tokens[k]!.type === 'ENDMARKER';

  let j = jIn;
  const imp: PyImport = { module, relative, names: [], star: false, isImportStmt: false, line };
  if (isOp(j, '*')) {
    imp.star = true;
    return [imp];
  }
  while (!atLineEnd(j)) {
    if (isName(j) && !isNameVal(j, 'as')) {
      const original = tokens[j]!.value;
      let local = original;
      j++;
      if (isNameVal(j, 'as')) {
        j++;
        if (isName(j)) {
          local = tokens[j]!.value;
          j++;
        }
      }
      imp.names.push({ local, original });
      if (isOp(j, ',')) {
        j++;
        continue;
      }
      // no comma → end of name list; stop (don't drift past NEWLINE)
      break;
    }
    // skip parens / stray tokens (e.g. the '(' in `from m import (a, b)`)
    j++;
  }
  return [imp];
}
