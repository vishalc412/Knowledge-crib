/**
 * Go tokenizer — tolerant, zero-dependency, offline, deterministic. Same posture as the Java/Python
 * lexers: a small token set (NAME / NUMBER / STRING / CHAR / OP / EOF), keywords are NAME tokens the
 * parser checks by `.value`, and a lex anomaly degrades to an OP token rather than throwing so the
 * extractor can fall back to a file node.
 *
 * Caters to the symbol-graph subset: comments (`//` line + slash-star block — Go block comments do NOT
 * nest), interpreted string literals (`"..."` with `\` escapes, no newlines), RAW string literals
 * (`` `...` `` backtick — no escapes, may span lines, no interpolation; this is also what struct tags
 * use, so tags lex as STRING and never break scanning), rune literals (`'...'`), the full numeric
 * menagerie (decimal, `0x` hex, `0o` octal, `0b` binary, `0`-octal legacy, floats, exponents, `_`
 * separators, imaginary `i` suffix), identifiers (incl. `_`, Unicode), and the multi-char operators
 * the structural parser needs (`:=`, `<-`, `&^`, `&^=`, `<<=`, `>>=`, `<<`, `>>`, `...` — tokenized
 * longest-first).
 *
 * CRITICAL — Go automatic semicolon insertion (the #1 Go lexer trap): the Go spec inserts a `;`
 * before a newline when the last token is an identifier / literal / one of `break` `continue`
 * `fallthrough` `return` / one of `++` `--` `)` `}` `]`. This lexer emits a synthetic `;` OP token at
 * those points so the structural parser sees real statement terminators and `return x\n}` /
 * multi-line decls / struct fields parse correctly. Without it the parser collapses.
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

/** Go reserved words; classified as NAME (the parser inspects `.value`). */
const KEYWORDS = new Set<string>([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  // predeclared identifiers / literals — NAME, parser checks by value
  'bool',
  'nil',
  'true',
  'false',
  'iota',
  'any',
  'comparable',
  'byte',
  'rune',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'float32',
  'float64',
  'complex64',
  'complex128',
  'string',
  'error',
  'len',
  'cap',
  'make',
  'new',
  'append',
  'copy',
  'delete',
  'close',
  'panic',
  'recover',
  'print',
  'println',
]);

export function isKeyword(value: string): boolean {
  return KEYWORDS.has(value);
}

/** Go has no access modifiers; this set is empty but kept for parity with the Java lexer API. */
const MODIFIERS = new Set<string>([]);

export function isModifier(value: string): boolean {
  return MODIFIERS.has(value);
}

// ---------------------------------------------------------------------------------------------
// Comment blocks (schema 1.2 — explanation nodes) — a maximal run of contiguous `//` lines (a
// leading `//` on each line, no blank line between) OR a single `/* … */` block comment. Pure
// deterministic line-scanning; mirrors PlSqlLexer.collectComments with `//` instead of `--`.
// ---------------------------------------------------------------------------------------------

/** One retained Go comment block with its 1-based inclusive line span + cleaned text. */
export interface GoCommentBlock {
  start: number;
  end: number;
  text: string;
}

/**
 * Collect comment blocks from Go source. Contiguous `//` lines merge into one block; each
 * slash-star block comment is its own block. The leading comment markers (`//`, `/*`, and leading
 * `*`) are stripped and each line is trimmed; the block text is the non-empty lines joined by `\n`.
 * Never throws.
 */
export function collectComments(src: string): GoCommentBlock[] {
  const out: GoCommentBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    // line comment `//` (contiguous run = one block)
    if (trimmed.startsWith('//')) {
      const start = i + 1;
      const parts: string[] = [];
      while (i < lines.length) {
        const l = (lines[i] ?? '').trim();
        if (!l.startsWith('//')) break;
        parts.push(l.replace(/^\/\/\s?/, '').trim());
        i++;
      }
      out.push({ start, end: i, text: parts.join('\n') });
      continue;
    }
    // block comment `/* … */` (may span lines; does NOT nest in Go)
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

/** Tokenize Go source into a flat token stream (never throws). */
export function tokenize(src: string): Token[] {
  return new Lexer(src).tokens();
}

/**
 * Longest-match multi-char operators. Order matters: 3-char (`<<=`, `>>=`, `&^=`, `...`) before
 * 2-char. Go does NOT have `->` / `::` / `>>>` (those are Java/C++). It DOES have `<-` (channel send),
 * `:=` (short decl), `&^` (bit clear), `<<`/`>>` (shifts), and the compound-assign forms.
 */
const MULTI_OPS: readonly string[] = [
  '<<=',
  '>>=',
  '&^=',
  '...',
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
  '&^',
  '<-',
  '<<',
  '>>',
  ':=',
];

/**
 * Tokens whose presence immediately before a newline triggers automatic-semicolon insertion
 * (Go spec "Semicolons"). A NAME covers identifiers AND keywords (`return`, `break`, `continue`,
 * `fallthrough`); the literal types cover all numeric/rune/string literals.
 */
function triggersSemicolon(t: Token | undefined): boolean {
  if (!t) return false;
  if (t.type === 'NAME' || t.type === 'NUMBER' || t.type === 'STRING' || t.type === 'CHAR')
    return true;
  if (t.type === 'OP')
    return (
      t.value === '++' || t.value === '--' || t.value === ')' || t.value === '}' || t.value === ']'
    );
  return false;
}

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
      // whitespace — but newline may trigger automatic-semicolon insertion
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') {
        this.advance();
        continue;
      }
      if (ch === '\n') {
        if (triggersSemicolon(this.lastTok())) {
          // emit the synthetic `;` at the current line (the line of the triggering token)
          this.emit('OP', ';', this.line, this.col);
        }
        this.advance();
        continue;
      }
      // line comment (// ..., including //go:build / // +build pragmas — skipped as comments)
      if (ch === '/' && this.peek(1) === '/') {
        this.skipLineComment();
        continue;
      }
      // block comment (/* */ — NOT nested in Go)
      if (ch === '/' && this.peek(1) === '*') {
        this.skipBlockComment();
        continue;
      }
      // interpreted string literal "..." (with \ escapes; no raw newlines)
      if (ch === '"') {
        this.scanString();
        continue;
      }
      // raw string literal `...` (backtick — no escapes, may span lines; also covers struct tags)
      if (ch === '`') {
        this.scanRawString();
        continue;
      }
      // rune (char) literal '...' (with escapes)
      if (ch === "'") {
        this.scanChar();
        continue;
      }
      // number
      if (this.isNumberStart(ch)) {
        this.scanNumber();
        continue;
      }
      // identifier / keyword
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
    while (this.pos < this.src.length && this.isIdentPart(this.peek())) this.advance();
    this.emit('NAME', this.src.slice(start, this.pos), sl, sc);
  }

  private scanNumber(): void {
    const start = this.pos;
    const sl = this.line;
    const sc = this.col;
    // tolerant: hex/bin/oct/decimal, underscores, exponent, imaginary `i` suffix — eat the legal run
    while (this.pos < this.src.length && this.isNumberPart(this.peek())) this.advance();
    this.emit('NUMBER', this.src.slice(start, this.pos), sl, sc);
  }

  private scanString(): void {
    const sl = this.line;
    const sc = this.col;
    this.advance(); // opening "
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

  /** Raw string literal: backtick-delimited, no escapes, may span lines. Also matches struct tags. */
  private scanRawString(): void {
    const sl = this.line;
    const sc = this.col;
    this.advance(); // opening `
    let value = '`';
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '`') {
        value += c;
        this.advance();
        break;
      }
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

  private lastTok(): Token | undefined {
    return this.out.length ? this.out[this.out.length - 1] : undefined;
  }

  private isIdentStart(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) > 127;
  }
  private isIdentPart(c: string): boolean {
    return this.isIdentStart(c) || (c >= '0' && c <= '9');
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
