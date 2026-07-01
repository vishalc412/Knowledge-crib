/**
 * Java tokenizer — tolerant, zero-dependency, offline, deterministic. Same posture as the Python
 * lexer: a small token set (NAME / NUMBER / STRING / CHAR / OP / EOF), keywords are NAME tokens the
 * parser checks by `.value`, and a lex anomaly degrades to an OP token rather than throwing so the
 * extractor can fall back to a file node.
 *
 * Caters to the symbol-graph subset: comments (//, /* *​/ — Java block comments do NOT nest),
 * string literals ("..." with escapes), Java 15+ text blocks ("""..."""), char literals ('...'), the
 * full numeric menagerie (0x/0b/0, decimals with `_` separators and L/F/D suffixes), identifiers
 * (incl. `$`, Unicode), and the multi-char operators the structural parser needs for generic / arrow
 * disambiguation (`>>`, `>>>`, `<<`, `->`, `::`, `...` — tokenized longuest-first so the header
 * skipper can split `List<List<X>>` into balanced `>` closers).
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

// ---------------------------------------------------------------------------------------------
// Comment blocks (schema 1.2) — a maximal run of contiguous `//` lines (no blank line between) OR
// a single slash-star block comment, reduced to a 1-based inclusive line span + cleaned text. Used
// by the extractor to attach a preceding comment to a class/method/field as an `explanation` node
// (mirrors PlSqlLexer.collectComments for `--` and slash-star).
// ---------------------------------------------------------------------------------------------

/** One retained Java comment block with its 1-based inclusive line span + cleaned text. */
export interface CommentBlock {
  start: number;
  end: number;
  text: string;
  /** true for a Javadoc block (opening slash-star-star). */
  javadoc: boolean;
}

/**
 * Collect Java comment blocks. Contiguous `//` lines merge into one block; each slash-star block
 * comment is its own block. Leading comment markers (slash-slash, slash-star, star-slash, and the
 * per-line star) are stripped and each line is trimmed; the block text is the lines joined by a
 * newline. Never throws.
 */
export function collectComments(src: string): CommentBlock[] {
  const out: CommentBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim();
    // line comment `//` — merge a maximal contiguous run (no blank line between).
    if (trimmed.startsWith('//')) {
      const start = i + 1;
      const parts: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('//')) {
        parts.push(
          (lines[i] ?? '')
            .trim()
            .replace(/^\/\/\s?/, '')
            .trim(),
        );
        i++;
      }
      out.push({ start, end: i, text: parts.join('\n'), javadoc: false });
      continue;
    }
    // block comment `/* … */` (may span lines; `/** … */` is Javadoc).
    if (trimmed.startsWith('/*')) {
      const start = i + 1;
      const javadoc = trimmed.startsWith('/**') && !trimmed.startsWith('/**/');
      const parts: string[] = [];
      // single-line block comment closes on the same line.
      if (trimmed.endsWith('*/') && trimmed.length > 2) {
        const inner = trimmed
          .replace(/^\/\*+\s?/, '')
          .replace(/\*+\/$/, '')
          .trim();
        if (inner) parts.push(inner);
        out.push({ start, end: start, text: parts.join('\n'), javadoc });
        i++;
        continue;
      }
      // multi-line: first line (after `/*`) then until a line ending with `*/`.
      const firstInner = trimmed.replace(/^\/\*+\s?/, '').trim();
      if (firstInner) parts.push(firstInner);
      i++;
      while (i < lines.length) {
        const l = (lines[i] ?? '').trim();
        if (l.endsWith('*/')) {
          const inner = l
            .replace(/\*+\/$/, '')
            .replace(/^\s*\*\s?/, '')
            .trim();
          if (inner) parts.push(inner);
          i++;
          break;
        }
        const inner = l.replace(/^\s*\*\s?/, '').trim();
        if (inner) parts.push(inner);
        i++;
      }
      out.push({ start, end: i, text: parts.join('\n'), javadoc });
      continue;
    }
    i++;
  }
  return out;
}

/** Java reserved words; classified as NAME (the parser inspects `.value`). */
const KEYWORDS = new Set<string>([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'record',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  // contextual keywords the parser must also treat as kind/type identifiers
  'var',
  'yield',
  'sealed',
  'permits',
  // literals
  'true',
  'false',
  'null',
]);

export function isKeyword(value: string): boolean {
  return KEYWORDS.has(value);
}

/** Java modifiers + soft keywords that may legitimately appear as a name (var, yield, record). */
const MODIFIERS = new Set<string>([
  'public',
  'private',
  'protected',
  'static',
  'final',
  'abstract',
  'synchronized',
  'native',
  'transient',
  'volatile',
  'strictfp',
  'default',
]);

export function isModifier(value: string): boolean {
  return MODIFIERS.has(value);
}

/** Tokenize Java source → a flat token stream (never throws). */
export function tokenize(src: string): Token[] {
  return new Lexer(src).tokens();
}

/** Longuest-match multi-char operators. Order matters: 4-char → 3-char → 2-char. */
const MULTI_OPS: readonly string[] = [
  '>>>=',
  '...',
  '>>>',
  '<<=',
  '>>=',
  '&&=',
  '||=',
  '->',
  '::',
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
  '>>',
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
      // block comment (NOT nested in Java)
      if (ch === '/' && this.peek(1) === '*') {
        this.skipBlockComment();
        continue;
      }
      // string literal
      if (ch === '"') {
        this.scanString();
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
      // identifier / keyword
      if (this.isIdentStart(ch)) {
        this.scanIdent();
        continue;
      }
      // operator (longuest match)
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
    // tolerant: hex/bin/oct/decimal, underscores, exponent, L/F/D suffix — eat the legal run.
    while (this.pos < this.src.length && this.isNumberPart(this.peek())) this.advance();
    this.emit('NUMBER', this.src.slice(start, this.pos), sl, sc);
  }

  private scanString(): void {
    const sl = this.line;
    const sc = this.col;
    this.advance(); // opening "
    // text block: """ possibly followed by newline, closes with """
    if (this.peek() === '"' && this.peek(1) === '"') {
      this.scanTextBlock(sl, sc);
      return;
    }
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

  /** A Java text block begins with `"""` (already consumed opener) optionally a newline, ends `"""`. */
  private scanTextBlock(sl: number, sc: number): void {
    this.advance(); // 2nd "
    this.advance(); // 3rd "
    let value = '"""';
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
      if (c === '"' && this.peek(1) === '"' && this.peek(2) === '"') {
        value += '"""';
        this.advance();
        this.advance();
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
    // longuest multi-char op match
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
      c === '$' ||
      c.charCodeAt(0) > 127
    );
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
