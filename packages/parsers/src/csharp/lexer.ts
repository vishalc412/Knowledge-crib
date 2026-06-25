/**
 * C# tokenizer — tolerant, zero-dependency, offline, deterministic. Same posture as the Java lexer:
 * a small token set (NAME / NUMBER / STRING / CHAR / OP / EOF), keywords are NAME tokens the parser
 * inspects by `.value`, and a lex anomaly degrades to an OP token rather than throwing so the
 * extractor can fall back to a file node.
 *
 * Caters to the symbol-graph subset: comments (`//` and `/* *​/` — C# block comments do NOT nest),
 * the FOUR C# string families (regular `"..."`, verbatim `@"..."`, interpolated `$"..."` /
 * `$@"..."` / `@$"..."`, and raw `"""..."""` / `$"""..."""` from C# 11), char literals `'...'`,
 * the full numeric menagerie (0x/0b/decimal with `_` separators and suffixes), identifiers (incl.
 * `@` verbatim identifiers, `_`, Unicode), and the multi-char operators the structural parser needs.
 *
 * `<` and `>` are emitted as SINGLE tokens (C# has NO `>>` split rule like Java — `>>` is just two
 * `>` ops / a shift; generics balance `<...>` by counting single `<`/`>`). `>>`/`<<` are still
 * tokenized as multi-char ops for the call-collector / expression skipper, but the parser's generic
 * balancing only decrements one level per `>` token, so `List<List<X>>` is handled by treating the
 * `>>` op as two closers in the generic skipper.
 */
export type TokenType = 'NAME' | 'NUMBER' | 'STRING' | 'CHAR' | 'OP' | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  /** 1-based line of the token's first character. */
  line: number;
  /** 1-based column of the token's first character. */
  col: number;
}

/** C# reserved words; classified as NAME (the parser inspects `.value`). */
const KEYWORDS = new Set<string>([
  'abstract',
  'as',
  'base',
  'bool',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'checked',
  'class',
  'const',
  'continue',
  'decimal',
  'default',
  'delegate',
  'do',
  'double',
  'else',
  'enum',
  'event',
  'explicit',
  'extern',
  'false',
  'finally',
  'fixed',
  'float',
  'for',
  'foreach',
  'goto',
  'if',
  'implicit',
  'in',
  'int',
  'interface',
  'internal',
  'is',
  'lock',
  'long',
  'namespace',
  'new',
  'null',
  'object',
  'operator',
  'out',
  'override',
  'params',
  'private',
  'protected',
  'public',
  'readonly',
  'ref',
  'return',
  'sbyte',
  'sealed',
  'short',
  'sizeof',
  'stackalloc',
  'static',
  'string',
  'struct',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'uint',
  'ulong',
  'unchecked',
  'unsafe',
  'ushort',
  'using',
  'virtual',
  'void',
  'volatile',
  'while',
  // contextual keywords the parser must also treat as kind/type identifiers
  'var',
  'yield',
  'partial',
  'async',
  'await',
  'record',
  'global',
  'nameof',
  'when',
  'where',
  'select',
  'from',
  'let',
  'orderby',
  'group',
  'by',
  'into',
  'join',
  'on',
  'equals',
  'ascending',
  'descending',
  'dynamic',
  'make',
  'get',
  'set',
  'init',
  'value',
  'add',
  'remove',
]);

export function isKeyword(value: string): boolean {
  return KEYWORDS.has(value);
}

/** C# modifiers + soft keywords that may legitimately appear as a name (var, yield, record, async). */
const MODIFIERS = new Set<string>([
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'sealed',
  'abstract',
  'virtual',
  'override',
  'async',
  'extern',
  'partial',
  'new',
  'unsafe',
  'volatile',
  'synchronized',
  'const',
]);

export function isModifier(value: string): boolean {
  return MODIFIERS.has(value);
}

/** Tokenize C# source → a flat token stream (never throws). */
export function tokenize(src: string): Token[] {
  return new Lexer(src).tokens();
}

/** Longest-match multi-char operators. Order matters: 4-char → 3-char → 2-char. */
const MULTI_OPS: readonly string[] = [
  '>>>:', // C# 11 unsigned shift assignment is `>>>=`; we don't need it but tolerate
  '>>>=',
  '...',
  '>>>', // shift right unsigned (C# 11) — single op, but parser treats as 3 closers in generics
  '<<=',
  '>>=', // shift assignment
  '&&=',
  '||=',
  '??=',
  '->',
  '??',
  '=>',
  '++',
  '--',
  '==',
  '!=',
  '>=',
  '<=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>', // shift — parser's generic skipper treats `>>` as TWO `>` closers
  '?:',
];

class Lexer {
  private readonly src: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly out: Token[] = [];

  constructor(src: string) {
    this.src = src;
  }

  tokens(): Token[] {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      // whitespace
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f') {
        this.advance();
        continue;
      }
      // line comment
      if (ch === '/' && this.peek(1) === '/') {
        this.skipLineComment();
        continue;
      }
      // block comment (NOT nested in C#)
      if (ch === '/' && this.peek(1) === '*') {
        this.skipBlockComment();
        continue;
      }
      // string literal — four families, dispatched by the preceding `@`/`$` flags
      if (ch === '@' && this.peek(1) === '"') {
        this.scanVerbatimString(1, false);
        continue;
      }
      if (ch === '$' && this.peek(1) === '"') {
        this.scanInterpolatedString(1);
        continue;
      }
      if (ch === '@' && this.peek(1) === '$' && this.peek(2) === '"') {
        this.scanVerbatimString(2, true);
        continue;
      }
      if (ch === '$' && this.peek(1) === '@' && this.peek(2) === '"') {
        this.scanVerbatimString(2, true);
        continue;
      }
      if (ch === '"') {
        this.scanRegularOrRawString();
        continue;
      }
      // char literal
      if (ch === "'") {
        this.scanChar();
        continue;
      }
      // number
      if (this.isNumberStart(ch)) {
        this.scanNumber();
        continue;
      }
      // identifier / keyword (incl. `@` verbatim identifiers like `@class`)
      if (this.isIdentStart(ch)) {
        this.scanIdent();
        continue;
      }
      // operator (longest match)
      this.scanOp();
    }
    this.out.push({ type: 'EOF', value: '', line: this.line, col: this.col });
    return this.out;
  }

  // --- scanners -----------------------------------------------------------------

  private scanIdent(): void {
    const start = this.pos;
    const sl = this.line;
    const sc = this.col;
    // a leading `@` makes a verbatim identifier (`@class`); strip it from the NAME value so the
    // parser can compare against keyword sets by bare name.
    if (this.peek() === '@') this.advance();
    while (this.pos < this.src.length && this.isIdentPart(this.peek())) this.advance();
    this.emit('NAME', this.src.slice(start, this.pos), sl, sc);
  }

  private scanNumber(): void {
    const start = this.pos;
    const sl = this.line;
    const sc = this.col;
    // tolerant: hex/bin/decimal, underscores, exponents, L/F/D/M/U/u suffixes — eat the legal run.
    while (this.pos < this.src.length && this.isNumberPart(this.peek())) this.advance();
    this.emit('NUMBER', this.src.slice(start, this.pos), sl, sc);
  }

  /** Regular `"..."` or raw `"""..."""` (C# 11). Dispatched when the current char is `"`. */
  private scanRegularOrRawString(): void {
    const sl = this.line;
    const sc = this.col;
    // raw string: 3+ opening `"`s (C# 11). Count the opening run (advancing pos); close with the same count.
    let quoteRun = 0;
    while (this.peek() === '"') {
      quoteRun++;
      this.advance();
    }
    if (quoteRun >= 3) {
      this.scanRawStringBody(quoteRun, sl, sc); // opening run already consumed
      return;
    }
    if (quoteRun === 2) {
      this.emit('STRING', '""', sl, sc); // empty regular string
      return;
    }
    // quoteRun === 1: opening `"` consumed; scan the body.
    this.scanRegularStringBody(sl, sc);
  }

  /** Regular `"..."` body with `\` escapes; the opening `"` has already been consumed. */
  private scanRegularStringBody(sl: number, sc: number): void {
    let value = '"';
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\\') {
        value += c;
        this.advance();
        if (this.pos < this.src.length) {
          value += this.peek();
          this.advance();
        }
        continue;
      }
      if (c === '\n' || c === '\r') break; // unterminated — tolerate
      value += c;
      this.advance();
      if (c === '"') break;
    }
    this.emit('STRING', value, sl, sc);
  }

  /**
   * Verbatim `@"..."` / `$@"..."` — escapes are `""` for a literal `"`, NO `\` processing, may span
   * lines. `prefixLen` is the number of prefix chars already at `pos` (`@` or `$@`); we start at the
   * opening `"`.
   */
  private scanVerbatimString(prefixLen: number, interpolated: boolean): void {
    const sl = this.line;
    const sc = this.col;
    // consume the prefix (`@`, `$@`, `@$`)
    for (let k = 0; k < prefixLen; k++) this.advance();
    this.advance(); // opening "
    const prefix = interpolated ? '$@"' : '@"';
    let value = prefix;
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '"') {
        // `""` is an escaped `"` inside a verbatim string; a lone `"` closes it.
        if (this.peek(1) === '"') {
          value += '""';
          this.advance();
          this.advance();
          continue;
        }
        value += '"';
        this.advance();
        break;
      }
      // in an interpolated verbatim string, `{` opens an interpolation hole; `{{` is an escaped `{`.
      // We do NOT lex the hole's expression precisely — we just need to skip the string body to the
      // closing `"`. Tracking brace depth prevents a `"` inside a hole from closing the literal.
      if (interpolated && c === '{') {
        if (this.peek(1) === '{') {
          value += '{{';
          this.advance();
          this.advance();
          continue;
        }
        // a `{` interpolation hole — consume balanced `{ ... }` so a `"` inside it doesn't close.
        value += this.scanInterpolationHole();
        continue;
      }
      value += c;
      this.advance();
    }
    this.emit('STRING', value, sl, sc);
  }

  /**
   * Interpolated `$"..."` (NOT verbatim) — `\` escapes apply, `{{`/`}}` are escaped braces, `{...}`
   * is an interpolation hole that may itself contain a string. We consume to the closing `"` while
   * tracking brace depth so a `"` inside a hole doesn't terminate the literal.
   */
  private scanInterpolatedString(prefixLen: number): void {
    const sl = this.line;
    const sc = this.col;
    for (let k = 0; k < prefixLen; k++) this.advance(); // `$`
    this.advance(); // opening "
    let value = '$"';
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\\') {
        value += c;
        this.advance();
        if (this.pos < this.src.length) {
          value += this.peek();
          this.advance();
        }
        continue;
      }
      if (c === '\n' || c === '\r') break; // unterminated — tolerate
      if (c === '{') {
        if (this.peek(1) === '{') {
          value += '{{';
          this.advance();
          this.advance();
          continue;
        }
        value += this.scanInterpolationHole();
        continue;
      }
      if (c === '}') {
        if (this.peek(1) === '}') {
          value += '}}';
          this.advance();
          this.advance();
          continue;
        }
        value += c;
        this.advance();
        continue;
      }
      value += c;
      this.advance();
      if (c === '"') break;
    }
    this.emit('STRING', value, sl, sc);
  }

  /**
   * Consume a balanced `{ ... }` interpolation hole (possibly nested, possibly containing a string
   * or a conditional `condition ? a : b`). Returns the consumed source so the caller can append it.
   * The opening `{` is consumed here; the matching `}` is consumed here.
   */
  private scanInterpolationHole(): string {
    const start = this.pos;
    this.advance(); // {
    let depth = 1;
    while (this.pos < this.src.length && depth > 0) {
      const c = this.peek();
      if (c === '"') {
        // an interpolation expression may contain a string literal — skip it whole.
        this.skipStringInHole();
        continue;
      }
      if (c === '{') {
        depth++;
        this.advance();
        continue;
      }
      if (c === '}') {
        depth--;
        this.advance();
        continue;
      }
      this.advance();
    }
    return this.src.slice(start, this.pos);
  }

  /** Skip a string literal that appears inside an interpolation hole (`$" { "x" } "`). */
  private skipStringInHole(): void {
    // We are at a `"`. Count the opening quote run (advancing pos) to dispatch raw vs regular.
    let quoteRun = 0;
    while (this.peek() === '"') {
      quoteRun++;
      this.advance();
    }
    if (quoteRun >= 3) {
      const need = quoteRun;
      while (this.pos < this.src.length) {
        if (this.peek() === '"') {
          let run = 0;
          while (this.peek() === '"') {
            run++;
            this.advance();
          }
          if (run >= need) return;
          continue; // not enough to close — accept as body content (already consumed)
        }
        this.advance();
      }
      return;
    }
    if (quoteRun === 2) return; // empty string, already consumed
    // quoteRun === 1: regular string with `\` escapes; opening `"` already consumed.
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\\') {
        this.advance();
        if (this.pos < this.src.length) this.advance();
        continue;
      }
      if (c === '\n' || c === '\r') break;
      this.advance();
      if (c === '"') break;
    }
  }

  /**
   * Raw string `"""..."""` (C# 11) — `quoteCount` opening `"`s already consumed (>=3); the closing
   * is a run of `"`s of the same (or greater) count. We tolerate: close when we see a run of `"`s
   * >= quoteCount. Multi-line; no escape processing. Pos is positioned AFTER the opening run.
   */
  private scanRawStringBody(quoteCount: number, sl: number, sc: number): void {
    let value = '"'.repeat(quoteCount);
    while (this.pos < this.src.length) {
      if (this.peek() === '"') {
        let run = 0;
        const runStart = this.pos;
        const runLine = this.line;
        const runCol = this.col;
        while (this.peek() === '"') {
          run++;
          this.advance();
        }
        if (run >= quoteCount) {
          value += '"'.repeat(quoteCount);
          // rewind to consume only `quoteCount` closing quotes.
          this.pos = runStart + quoteCount;
          this.line = runLine;
          this.col = runCol + quoteCount;
          break;
        }
        // not enough to close — accept the run as literal content (already advanced).
        value += '"'.repeat(run);
        continue;
      }
      const c = this.peek();
      value += c;
      this.advance();
    }
    this.emit('STRING', value, sl, sc);
  }

  private scanChar(): void {
    const sl = this.line;
    const sc = this.col;
    this.advance(); // opening '
    let value = "'";
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\\') {
        value += c;
        this.advance();
        if (this.pos < this.src.length) {
          value += this.peek();
          this.advance();
        }
        continue;
      }
      if (c === '\n' || c === '\r') break; // unterminated — tolerate
      value += c;
      this.advance();
      if (c === "'") break;
    }
    this.emit('CHAR', value, sl, sc);
  }

  private scanOp(): void {
    const sl = this.line;
    const sc = this.col;
    // longest multi-char op match
    for (const op of MULTI_OPS) {
      if (this.startsWith(op)) {
        for (let i = 0; i < op.length; i++) this.advance();
        this.emit('OP', op, sl, sc);
        return;
      }
    }
    const c = this.peek();
    this.advance();
    this.emit('OP', c, sl, sc);
  }

  private skipLineComment(): void {
    while (this.pos < this.src.length && this.peek() !== '\n' && this.peek() !== '\r')
      this.advance();
  }

  private skipBlockComment(): void {
    this.advance(); // /
    this.advance(); // *
    while (this.pos < this.src.length) {
      if (this.peek() === '*' && this.peek(1) === '/') {
        this.advance();
        this.advance();
        return;
      }
      this.advance();
    }
  }

  // --- helpers ------------------------------------------------------------------

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  private startsWith(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      if (this.src[this.pos + i] !== s[i]) return false;
    }
    return true;
  }

  private advance(): void {
    const c = this.src[this.pos];
    this.pos++;
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
  }

  private emit(type: TokenType, value: string, line: number, col: number): void {
    this.out.push({ type, value, line, col });
  }

  private isIdentStart(c: string): boolean {
    return (
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      c === '_' ||
      c === '@' ||
      c.charCodeAt(0) > 127
    );
  }
  private isIdentPart(c: string): boolean {
    return (
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c === '_' ||
      c.charCodeAt(0) > 127
    );
  }
  private isNumberStart(c: string): boolean {
    return (c >= '0' && c <= '9') || (c === '.' && this.peek(1) >= '0' && this.peek(1) <= '9');
  }
  private isNumberPart(c: string): boolean {
    return (
      (c >= '0' && c <= '9') ||
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      c === '_' ||
      c === '.' ||
      c === '+' ||
      c === '-'
    );
  }
}

// ── Comment collection (schema 1.2 explanation nodes) ──────────────────────────────────────
// Mirrors PlSqlLexer.collectComments: a line-based scan (independent of the tokenizer, which
// discards comments) that returns maximal comment blocks with 1-based inclusive line spans +
// cleaned text. Contiguous `//` / `///` lines merge into one block; each slash-star block comment
// is its own block (may span lines). The leading markers (`//`, `///`, slash-star, leading `*`)
// are stripped and each line is trimmed. Used by CsharpExtractor.attachComments to emit
// `explanation` nodes for doc comments immediately above a class/method/symbol. Never throws.

/** One retained C# comment block with its 1-based inclusive line span + cleaned text. */
export interface CsCommentBlock {
  start: number;
  end: number;
  text: string;
}

/**
 * Collect comment blocks from C# source. Contiguous `//`/`///` lines merge into one block; each
 * slash-star block comment is its own block. Markers are stripped, lines trimmed, joined by `\n`.
 * Deterministic + offline; never throws.
 */
export function collectComments(src: string): CsCommentBlock[] {
  const out: CsCommentBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    // line comment `//` or `///` (contiguous run merges into one block)
    if (trimmed.startsWith('//')) {
      const start = i + 1;
      const parts: string[] = [];
      while (i < lines.length) {
        const l = (lines[i] ?? '').trim();
        if (!l.startsWith('//')) break;
        parts.push(l.replace(/^\/{2,3}\s?/, '').trim());
        i++;
      }
      out.push({ start, end: i, text: parts.join('\n') });
      continue;
    }
    // block comment `/* … */` (may span lines; does NOT nest in C#)
    if (trimmed.startsWith('/*')) {
      const start = i + 1;
      const parts: string[] = [];
      // single-line block comment closes on the same line
      if (trimmed.endsWith('*/') && trimmed.length > 2) {
        parts.push(
          trimmed
            .replace(/^\/\*+\s?/, '')
            .replace(/\*+\/$/, '')
            .trim(),
        );
        out.push({ start, end: start, text: parts.join('\n') });
        i++;
        continue;
      }
      parts.push(trimmed.replace(/^\/\*+\s?/, '').trim());
      i++;
      while (i < lines.length) {
        const l = (lines[i] ?? '').trim();
        if (l.endsWith('*/')) {
          parts.push(
            l
              .replace(/\*+\/$/, '')
              .replace(/^\s*\*\s?/, '')
              .trim(),
          );
          i++;
          break;
        }
        parts.push(l.replace(/^\s*\*\s?/, '').trim());
        i++;
      }
      out.push({ start, end: i, text: parts.filter((p) => p.length > 0).join('\n') });
      continue;
    }
    i++;
  }
  return out;
}
