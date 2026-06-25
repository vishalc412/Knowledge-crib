/**
 * Python tokenizer (M8) — a tolerant, indentation-aware lexer for the symbol-graph subset. It is
 * hand-rolled and zero-dependency on purpose: the project keeps cold install offline + pure-JS +
 * deterministic (same call the TypeScript compiler API and the PL/SQL lexer answer). It NEVER
 * throws — a lex anomaly degrades to an OP token and lexing continues, so the extractor can fall
 * back to a file node rather than aborting the pipeline.
 *
 * Emits the CPython-style INDENT/DEDENT stream so the parser can see block structure without
 * re-deriving it. Logical-line breaks (NEWLINE) are distinguished from non-significant breaks (NL):
 * a NEWLINE inside brackets or a blank/comment-only line is NL and ignored by the parser.
 *
 * The token set is intentionally small: NAME, NUMBER, STRING, OP, NEWLINE, NL, INDENT, DEDENT,
 * ENDMARKER. Keywords are NAME tokens (the parser checks `.value`); classifying them here would
 * just move the same switch somewhere else.
 */
export type TokenType =
  | 'NAME'
  | 'NUMBER'
  | 'STRING'
  | 'OP'
  | 'NEWLINE'
  | 'NL'
  | 'INDENT'
  | 'DEDENT'
  | 'ENDMARKER';

export interface Token {
  type: TokenType;
  value: string;
  /** 1-based line of the token's first character. */
  line: number;
  /** 1-based column of the token's first character. */
  col: number;
}

const KEYWORDS = new Set<string>([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

export function isKeyword(value: string): boolean {
  return KEYWORDS.has(value);
}

/** Tokenize Python source → a flat token stream (never throws). */
export function tokenize(src: string): Token[] {
  return new Lexer(src).tokens();
}

class Lexer {
  private readonly src: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  /** bracket depth > 0 ⇒ we are inside ()/[]/{}; NEWLINE is NL there. */
  private bracketDepth = 0;
  /** triple-quote state: the closing delimiter we are looking for, or '' when not in a string. */
  private triple = '';
  private readonly out: Token[] = [];
  /** current logical-line indent stack; level 0 is always present. */
  private readonly indents: number[] = [0];
  /** have we emitted the INDENT/DEDENT for the current line yet? */
  private atLineStart = true;

  constructor(src: string) {
    this.src = src;
  }

  tokens(): Token[] {
    while (this.pos < this.src.length) {
      if (this.triple) {
        this.scanInsideTriple();
        continue;
      }
      if (this.atLineStart && this.bracketDepth === 0) {
        this.handleLineStart();
        // handleLineStart may consume the whole line (blank/comment) and set atLineStart again.
        if (this.atLineStart) continue;
      }
      const ch = this.peek();
      if (ch === '\n') {
        this.advance();
        this.emit(this.bracketDepth > 0 ? 'NL' : 'NEWLINE', '\n');
        this.atLineStart = true;
        continue;
      }
      if (ch === '\r') {
        this.advance();
        if (this.peek() === '\n') this.advance();
        this.emit(this.bracketDepth > 0 ? 'NL' : 'NEWLINE', '\n');
        this.atLineStart = true;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\f') {
        this.advance();
        continue;
      }
      if (ch === '\\' && this.peek(1) === '\n') {
        // explicit line continuation — join the next line; no NEWLINE emitted.
        this.advance();
        this.advance();
        continue;
      }
      if (ch === '#') {
        this.skipComment();
        continue;
      }
      if (this.isStringStart()) {
        this.scanString();
        continue;
      }
      if (isDigit(ch) || (ch === '.' && isDigit(this.peek(1)))) {
        this.scanNumber();
        continue;
      }
      if (isIdentStart(ch)) {
        this.scanIdent();
        continue;
      }
      this.scanOp();
    }
    this.close();
    return this.out;
  }

  // --- line-start / indentation -------------------------------------------------

  private handleLineStart(): void {
    // Measure leading whitespace (tabs count as 1 — tolerant, not PEP-8-strict).
    let indent = 0;
    let p = this.pos;
    while (p < this.src.length) {
      const c = this.src[p]!;
      if (c === ' ') {
        indent++;
        p++;
      } else if (c === '\t') {
        indent++;
        p++;
      } else break;
    }
    // Blank line or comment-only line → NL, stay atLineStart for the next real line.
    if (
      p >= this.src.length ||
      this.src[p] === '\n' ||
      this.src[p] === '\r' ||
      this.src[p] === '#'
    ) {
      this.pos = p;
      if (this.pos < this.src.length && this.src[this.pos] === '#') this.skipComment();
      // consume the line break (if any) as NL; EOF leaves atLineStart and the outer loop ends.
      if (
        this.pos < this.src.length &&
        (this.src[this.pos] === '\n' || this.src[this.pos] === '\r')
      ) {
        if (this.src[this.pos] === '\r' && this.src[this.pos + 1] === '\n') this.advance();
        this.advance();
        this.emit('NL', '\n');
      }
      this.atLineStart = true;
      return;
    }
    // Real logical line: commit the skipped whitespace, emit INDENT/DEDENT.
    this.pos = p;
    this.col = indent + 1;
    this.emitIndents(indent);
    this.atLineStart = false;
  }

  /** Emit INDENT/DEDENT to move from the current stack to `indent`. */
  private emitIndents(indent: number): void {
    const top = this.indents[this.indents.length - 1]!;
    if (indent > top) {
      this.indents.push(indent);
      this.emit('INDENT', ''.padStart(indent));
      return;
    }
    if (indent < top) {
      while (this.indents.length > 1 && (this.indents[this.indents.length - 1] ?? 0) > indent) {
        this.indents.pop();
        this.emit('DEDENT', '');
      }
      // tolerant: if the indent doesn't match an existing level, just continue (no error token).
    }
  }

  // --- scanners -----------------------------------------------------------------

  private scanIdent(): void {
    const start = this.pos;
    const startLine = this.line;
    const startCol = this.col;
    while (this.pos < this.src.length && isIdentPart(this.peek())) this.advance();
    this.emit('NAME', this.src.slice(start, this.pos), startLine, startCol);
  }

  private scanNumber(): void {
    const start = this.pos;
    const startLine = this.line;
    const startCol = this.col;
    // tolerant number: digits, dot, exponent, hex/oct/bin prefix, underscores, j suffix.
    while (this.pos < this.src.length && isNumberPart(this.peek())) this.advance();
    this.emit('NUMBER', this.src.slice(start, this.pos), startLine, startCol);
  }

  private scanString(): void {
    const startLine = this.line;
    const startCol = this.col;
    // consume string prefix (r/b/f/u and combos, any case)
    let prefix = '';
    while (this.pos < this.src.length && isStringPrefix(this.peek())) {
      prefix += this.peek();
      this.advance();
    }
    const quote = this.matchQuote();
    if (!quote) {
      // prefix chars with no quote following — treat as NAME(s) already consumed? They were
      // consumed here; back out by emitting each as a NAME so we don't lose them.
      for (const c of prefix) this.emit('NAME', c, startLine, startCol);
      return;
    }
    const delim = quote.delim;
    if (quote.triple) {
      // enter triple state; finishString continues across newlines in a separate path.
      this.triple = delim;
      // record the string's start position token; we emit it once the closer is found. The opening
      // delimiter is THREE quotes (matchQuote consumed them but `delim` is the single-char quote), so
      // rebuild the full `"""`/`'''` opener — otherwise the token value (and any source slice derived
      // from value.length) is short by two chars and a docstring's closing quotes get clipped.
      this.scanInsideTriple(startLine, startCol, prefix + delim.repeat(3));
      return;
    }
    this.scanSingleString(delim, startLine, startCol, prefix);
  }

  /** Consume a single-line string until its matching quote (no embedded newline allowed). */
  private scanSingleString(
    delim: string,
    startLine: number,
    startCol: number,
    prefix: string,
  ): void {
    let value = prefix + delim;
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\\') {
        value += c;
        this.advance();
        if (this.pos < this.src.length) {
          value += this.peek();
          // an escaped newline joins lines but stays inside the string; keep line counter honest.
          if (this.peek() === '\n') this.advance();
          else this.advance();
        }
        continue;
      }
      if (c === '\n' || c === '\r') {
        // unterminated single-line string — tolerate: emit what we have and stop.
        break;
      }
      value += c;
      this.advance();
      if (c === delim) break;
    }
    this.emit('STRING', value, startLine, startCol);
  }

  /**
   * Continue scanning a triple-quoted string. Called both to start one (with a recorded start
   * position) and to resume one across newlines (when this.triple was set by a previous call).
   */
  private scanInsideTriple(startLine?: number, startCol?: number, openToken?: string): void {
    const sl = startLine ?? this.line;
    const sc = startCol ?? this.col;
    let value = openToken ?? '';
    // If resuming, the opening delim is already consumed and not in `value`; rebuild from src state.
    if (openToken === undefined) value = '';
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
      // check for the closing triple
      if (c === this.triple && this.peek(1) === this.triple && this.peek(2) === this.triple) {
        value += this.triple.repeat(3);
        this.advance();
        this.advance();
        this.advance();
        this.triple = '';
        this.emit('STRING', value, sl, sc);
        return;
      }
      value += c;
      this.advance();
    }
    // EOF inside a triple — tolerate (unterminated); emit the partial string.
    this.triple = '';
    this.emit('STRING', value, sl, sc);
  }

  private scanOp(): void {
    const c = this.peek();
    const startLine = this.line;
    const startCol = this.col;
    // brackets affect line-joining
    if (c === '(' || c === '[' || c === '{') {
      this.bracketDepth++;
      this.emit('OP', c, startLine, startCol);
      this.advance();
      return;
    }
    if (c === ')' || c === ']' || c === '}') {
      if (this.bracketDepth > 0) this.bracketDepth--;
      this.emit('OP', c, startLine, startCol);
      this.advance();
      return;
    }
    // multi-char operators we may care about (=> n/a in Python, but `**`, `//`, `->`, `:=` etc.)
    const two = c + (this.peek(1) ?? '');
    if (
      two === '**' ||
      two === '//' ||
      two === '->' ||
      two === ':=' ||
      two === '==' ||
      two === '!=' ||
      two === '>=' ||
      two === '<=' ||
      two === '<<' ||
      two === '>>' ||
      two === '&&' ||
      two === '||' ||
      two === '...'
    ) {
      this.emit('OP', two, startLine, startCol);
      this.advance();
      this.advance();
      return;
    }
    this.emit('OP', c, startLine, startCol);
    this.advance();
  }

  private skipComment(): void {
    while (this.pos < this.src.length && this.peek() !== '\n' && this.peek() !== '\r')
      this.advance();
  }

  // --- helpers ------------------------------------------------------------------

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
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

  private emit(type: TokenType, value: string, line?: number, col?: number): void {
    this.out.push({ type, value, line: line ?? this.line, col: col ?? this.col });
  }

  private isStringStart(): boolean {
    const c = this.peek();
    if (c === '"' || c === "'") return true;
    // prefix + quote
    if (isStringPrefix(c)) {
      let i = 1;
      while (isStringPrefix(this.peek(i))) i++;
      const q = this.peek(i);
      return q === '"' || q === "'";
    }
    return false;
  }

  private matchQuote(): { delim: string; triple: boolean } | null {
    if (
      this.peek() === this.peek(1) &&
      this.peek(1) === this.peek(2) &&
      (this.peek() === '"' || this.peek() === "'")
    ) {
      const d = this.peek();
      this.advance();
      this.advance();
      this.advance();
      return { delim: d!, triple: true };
    }
    const c = this.peek();
    if (c === '"' || c === "'") {
      this.advance();
      return { delim: c, triple: false };
    }
    return null;
  }

  private close(): void {
    // flush a trailing NEWLINE if the last token isn't one
    const last = this.out[this.out.length - 1];
    if (last && last.type !== 'NEWLINE' && last.type !== 'NL') this.emit('NEWLINE', '\n');
    while (this.indents.length > 1) {
      this.indents.pop();
      this.emit('DEDENT', '');
    }
    this.emit('ENDMARKER', '');
  }
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) > 127;
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
function isNumberPart(c: string): boolean {
  return (
    isDigit(c) ||
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    c === '.' ||
    c === '_' ||
    c === '+' ||
    c === '-'
  );
}
function isStringPrefix(c: string): boolean {
  const l = c.toLowerCase();
  return l === 'r' || l === 'b' || l === 'f' || l === 'u';
}

// ---------------------------------------------------------------------------------------------
// Schema 1.2 — `#` comment blocks for `explanation` nodes (mirrors PlSqlLexer.collectComments).
// ---------------------------------------------------------------------------------------------

/** One retained `#` comment block with its 1-based inclusive line span + cleaned text. */
export interface CommentBlock {
  start: number;
  end: number;
  text: string;
}

/**
 * Collect `#` comment blocks from Python source. A maximal run of contiguous `#` lines (no blank
 * line between) merges into one block; the leading `#` and one space are stripped from each line and
 * the line is trimmed; the block text is the lines joined by `\n`. Never throws.
 */
export function collectPythonComments(src: string): CommentBlock[] {
  const out: CommentBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.startsWith('#')) {
      const start = i + 1;
      const parts: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('#')) {
        parts.push((lines[i] ?? '').trim().replace(/^#\s?/, '').trim());
        i++;
      }
      out.push({ start, end: i, text: parts.join('\n') });
      continue;
    }
    i++;
  }
  return out;
}
