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
  /** nested declarations in source order. */
  body: PyDef[];
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
    const p = new Parser(tokens);
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

  constructor(tokens: Token[]) {
    this.t = tokens;
  }

  parseModule(): PyDef[] {
    const defs: PyDef[] = [];
    while (!this.atEnd()) {
      if (this.is('DEDENT')) {
        this.next();
        continue;
      }
      if (this.is('NEWLINE') || this.is('NL')) {
        this.next();
        continue;
      }
      if (this.is('ENDMARKER')) break;
      const before = this.i;
      const d = this.parseStatement();
      if (d) {
        if (Array.isArray(d)) for (const x of d) defs.push(x);
        else defs.push(d);
      } else if (this.i === before && !this.atEnd()) {
        // parseStatement made no progress (e.g. an unrecognized token) — skip it to avoid a loop.
        this.next();
      }
    }
    return defs;
  }

  /** Parse one statement; returns a def (class/function) or null. Compound bodies recurse. */
  private parseStatement(): PyDef | PyDef[] | null {
    this.skipDecorators();
    if (this.isName('class')) return this.parseClass();
    if (this.isName('def')) return this.parseFunction(false);
    if (this.isName('async') && this.peekName(1) === 'def') {
      this.next(); // consume 'async'
      return this.parseFunction(true);
    }
    // compound statements (if/elif/else/for/while/try/except/finally/with/match/case): descend into
    // the suite and RETURN its defs so they splice into the enclosing body (parseModule/parseSuite
    // handle a PyDef[] via the Array.isArray branch). Without this, any def nested under a compound
    // statement would be silently dropped.
    if (this.isCompound()) {
      this.skipHeaderToColon();
      return this.parseSuite();
    }
    // anything else: a simple statement — skip to NEWLINE.
    this.skipToNewline();
    return null;
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
    const body = this.parseSuite();
    const endLine = bodyEnd(body, this.lastContentLine, startLine);
    return {
      kind: 'class',
      name,
      startLine,
      endLine,
      async: false,
      decorators,
      bases,
      params: [],
      body,
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
    const body = this.parseSuite();
    const endLine = bodyEnd(body, this.lastContentLine, startLine);
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
      body,
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
   * Parse a suite following a `:`. Returns nested declarations. Sets lastSuiteLine so the caller
   * can compute the enclosing def's endLine even when the suite is empty.
   */
  private parseSuite(): PyDef[] {
    // expect NEWLINE after the colon
    while (this.is('NEWLINE') || this.is('NL')) this.next();
    if (this.is('INDENT')) {
      this.next();
      const defs: PyDef[] = [];
      while (!this.atEnd() && !this.is('DEDENT')) {
        if (this.is('NEWLINE') || this.is('NL')) {
          this.next();
          continue;
        }
        const before = this.i;
        const d = this.parseStatement();
        if (d) {
          if (Array.isArray(d)) for (const x of d) defs.push(x);
          else defs.push(d);
        } else if (this.i === before && !this.is('DEDENT') && !this.atEnd()) {
          this.next();
        }
      }
      if (this.is('DEDENT')) this.next();
      return defs;
    }
    // one-liner suite: a simple statement on the same line — no nested defs.
    this.skipToNewline();
    return [];
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

  private isCompound(): boolean {
    const v = this.peek().value;
    return (
      this.is('NAME') &&
      (v === 'if' ||
        v === 'elif' ||
        v === 'else' ||
        v === 'for' ||
        v === 'while' ||
        v === 'try' ||
        v === 'except' ||
        v === 'finally' ||
        v === 'with' ||
        v === 'match' ||
        v === 'case')
    );
  }

  /** Skip a compound header (`if cond:`, `for x in y:`, `with ctx:`, `try:`) up to its `:`. */
  private skipHeaderToColon(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') depth++;
      else if (tk.type === 'OP' && tk.value === ')') depth--;
      else if (tk.type === 'OP' && tk.value === ':' && depth === 0) {
        this.next();
        return;
      } else if (tk.type === 'NEWLINE' && depth === 0) return; // malformed header
      this.next();
    }
  }

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

/** End line of a def = max(last content line in the suite, deepest last-child end line, start). */
function bodyEnd(body: PyDef[], lastContentLine: number, startLine: number): number {
  let end = Math.max(lastContentLine, startLine);
  for (const d of body) end = Math.max(end, d.endLine);
  return end;
}

/** Number of `\n` in a string literal's raw token value (for multiline triple-quoted span math). */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
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
