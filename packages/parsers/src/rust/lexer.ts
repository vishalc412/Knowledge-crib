/**
 * Rust tokenizer — tolerant, zero-dependency, offline, deterministic. Same posture as the Java /
 * Python lexers: a small token set (NAME / NUMBER / STRING / CHAR / LIFETIME / OP / EOF), keywords are
 * NAME tokens the parser inspects by `.value`, and a lex anomaly degrades to an OP token rather than
 * throwing so the extractor can fall back to a file node.
 *
 * Caters to the symbol-graph subset plus the three Rust lexer traps:
 *
 *   1. NESTED block comments — Rust block comments nest to arbitrary depth (unlike Java/C): the
 *      open-comment token increments a depth counter and the close-comment token decrements it; the
 *      comment ends only at depth 0 (an outer comment with an inner comment inside is ONE comment).
 *
 *   2. Raw strings with a SYMMETRIC `#` count — `r".."`, `r#".."#`, `r##".."##` (0–255 `#`). The
 *      closing sequence is `"` followed by the SAME number of `#`s that followed the opening `r`; no
 *      escapes are processed inside. Byte strings `b".."` / `br".."#` and C-strings `c".."` /
 *      `cr".."#` use the same scanners. A `"` inside a raw body is NOT a terminator unless it is
 *      followed by ≥ the opening `#` count — so mis-lexing a `"` inside a raw string as a string
 *      boundary (the classic trap) is avoided by counting `#`s.
 *
 *   3. Lifetime labels vs char literals — `'a` / `'static` (lifetime) look like an unclosed `'x'`
 *      (char). Disambiguation: after `'`, read the identifier run; if the very next char is a closing
 *      `'` it was a single-char char literal (`'a'`), otherwise it is a lifetime (`'a`). An escape
 *      (`'\n'`, `'\u{1F600}'`) is always a char literal. Byte chars `b'A'` are scanned as chars.
 *
 * `>>` is emitted as ONE OP token; the parser's generic-angle balancer splits it into 2 `>` closes
 * (Rust has no `>>>` operator, but the lexer would emit `>>` then `>` if three `>` appear, which the
 * balancer handles). Numbers are scanned tolerantly (hex/oct/bin/decimal, `_` separators, suffixes,
 * exponents) — boundaries don't matter for symbol extraction, only that identifiers / strings aren't
 * mis-tokenized.
 */
export type TokenType = 'NAME' | 'NUMBER' | 'STRING' | 'CHAR' | 'LIFETIME' | 'OP' | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  /** 1-based line of the token's first character. */
  line: number;
  /** 1-based column of the token's first character. */
  col: number;
}

/** Rust reserved + contextual keywords; classified as NAME (the parser inspects `.value`). */
const KEYWORDS = new Set<string>([
  'as',
  'async',
  'await',
  'become',
  'box',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'macro',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'try',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'yield',
  // reserved (2018+) — treated as NAME; the parser still accepts them as identifiers where valid
  'abstract',
  'become',
  'do',
  'final',
  'override',
  'priv',
  'typeof',
  'unsized',
  'virtual',
]);

export function isKeyword(value: string): boolean {
  return KEYWORDS.has(value);
}

/** Visibility + fn/modifier keywords that precede items; the parser consumes these into modifiers. */
const MODIFIERS = new Set<string>(['pub', 'unsafe', 'async', 'const', 'static', 'extern', 'mut']);

export function isModifier(value: string): boolean {
  return MODIFIERS.has(value);
}

/** Tokenize Rust source → a flat token stream (never throws). */
export function tokenize(src: string): Token[] {
  return new Lexer(src).tokens();
}

/**
 * Longest-match multi-char operators. Order matters: 3-char → 2-char. `>>` is ONE token so the
 * parser's generic-angle balancer can split it into 2 `>` closers (Rust has no `>>>` op; `>>>` lexes
 * as `>>` then `>`).
 */
const MULTI_OPS: readonly string[] = [
  '..=',
  '<<=',
  '>>=',
  '->',
  '=>',
  '::',
  '..',
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
      // line comment: //, /// (doc), //! (inner doc) — all line comments to the lexer
      if (ch === '/' && this.peek(1) === '/') {
        this.skipLineComment();
        continue;
      }
      // block comment — NESTED in Rust (depth-counted). `/*` opens, `*/` closes at depth 0.
      if (ch === '/' && this.peek(1) === '*') {
        this.skipBlockComment();
        continue;
      }
      // string / char / raw string prefixes + regular string/char starts
      if (ch === '"') {
        this.scanString();
        continue;
      }
      if (ch === "'") {
        this.scanCharOrLifetime();
        continue;
      }
      if (this.isNumberStart(ch)) {
        this.scanNumber();
        continue;
      }
      if (this.isIdentStart(ch)) {
        // raw / byte / c-string prefixes begin with an ident-start char (r, b, c)
        if (this.tryScanStringish()) continue;
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
    // tolerant: hex/bin/oct/decimal, underscores, exponents, suffixes (1u32, 1.0f64) — eat the run.
    while (this.pos < this.src.length && this.isNumberPart(this.peek())) this.advance();
    this.emit('NUMBER', this.src.slice(start, this.pos), sl, sc);
  }

  /** Regular `"..."` with `\` escapes (also used for `b"..."` byte + `c"..."` C-string bodies). */
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

  /**
   * Raw string `r".."` / `r#".."#` / `r##".."##` (and raw byte `br".."#` / raw C-string `cr".."#`).
   * `prefixLen` is the number of prefix chars already to consume (1 for `r`, 2 for `br`/`cr`).
   * `hashCount` is the symmetric `#` count between the prefix and the opening `"`. No escapes.
   */
  private scanRawString(prefixLen: number, hashCount: number): void {
    const sl = this.line;
    const sc = this.col;
    for (let i = 0; i < prefixLen; i++) this.advance(); // r / br / cr
    for (let i = 0; i < hashCount; i++) this.advance(); // opening #s
    this.advance(); // opening "
    let value = '"';
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\n' || c === '\r') break; // CR not allowed in raw body — tolerate as end
      value += c;
      this.advance();
      if (c === '"') {
        // close iff followed by exactly `hashCount` `#`s
        let matched = 0;
        for (let i = 0; i < hashCount; i++) {
          if (this.peek(i) === '#') matched++;
          else break;
        }
        if (matched === hashCount) {
          for (let i = 0; i < hashCount; i++) this.advance(); // closing #s
          value += '#'.repeat(hashCount);
          break;
        }
      }
    }
    this.emit('STRING', value, sl, sc);
  }

  /**
   * Disambiguate `'x'` (char) from `'a` (lifetime/label). After `'`:
   *   - `\\` → char with escape (`'\n'`, `'\u{1F600}'`); scan escapes until closing `'`.
   *   - ident-start → read the ident run; if the very next char is `'` it was `'x'` (char), else it is
   *     a lifetime `'ident` (no closing quote). This is the #3 Rust lexer trap.
   *   - otherwise (digit/symbol) → char literal; scan until closing `'`.
   * Byte chars `b'A'` are dispatched here with the `b` already consumed by the caller.
   */
  private scanCharOrLifetime(byte = false): void {
    const sl = this.line;
    const sc = this.col;
    this.advance(); // opening '
    const next = this.peek();
    if (next === '\\') {
      // char with escape — scan `\X` (incl. `\u{...}`) until closing `'`
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
      return;
    }
    if (this.isIdentStart(next)) {
      // could be `'a'` (char) or `'a` (lifetime). Read the ident run and peek the next char.
      const start = this.pos;
      while (this.pos < this.src.length && this.isIdentPart(this.peek())) this.advance();
      const ident = this.src.slice(start, this.pos);
      if (this.peek() === "'") {
        // `'a'` — single ident-char char literal (tolerant: also catches invalid `'abc'`)
        this.advance(); // closing '
        this.emit('CHAR', `'${ident}'`, sl, sc);
      } else {
        // `'a` with no closing quote → lifetime / label
        this.emit('LIFETIME', `'${ident}`, sl, sc);
      }
      return;
    }
    // any other char (`'1'`, `'_'`? no — `_` is ident-start) → char literal, scan to closing `'`
    let value = "'";
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === '\n' || c === '\r') break; // unterminated — tolerate
      value += c;
      this.advance();
      if (c === "'") break;
    }
    if (byte) value = `b${value}`;
    this.emit('CHAR', value, sl, sc);
  }

  /** Try to scan a string/char literal prefixed by `r` / `b` / `c`; returns true if it consumed one. */
  private tryScanStringish(): boolean {
    const c = this.peek();
    if (c === 'r') {
      const hashCount = this.countRawHashes(1);
      if (hashCount !== undefined) {
        this.scanRawString(1, hashCount);
        return true;
      }
      return false; // `r#ident` (raw identifier) or plain `r` ident — let scanIdent handle it
    }
    if (c === 'b') {
      const c1 = this.peek(1);
      if (c1 === '"') {
        this.advance(); // b
        this.scanString();
        return true;
      }
      if (c1 === "'") {
        this.advance(); // b
        this.scanCharOrLifetime(true);
        return true;
      }
      if (c1 === 'r') {
        const hashCount = this.countRawHashes(2);
        if (hashCount !== undefined) {
          this.scanRawString(2, hashCount);
          return true;
        }
      }
      return false; // plain `b` / `br` ident
    }
    if (c === 'c') {
      const c1 = this.peek(1);
      if (c1 === '"') {
        this.advance(); // c
        this.scanString();
        return true;
      }
      if (c1 === 'r') {
        const hashCount = this.countRawHashes(2);
        if (hashCount !== undefined) {
          this.scanRawString(2, hashCount);
          return true;
        }
      }
      return false; // plain `c` / `cr` ident
    }
    return false;
  }

  /**
   * Count the `#`s after a raw-string prefix at offset `from`; returns the hash count iff the run is
   * followed by `"` (a raw string opener), else undefined (so the caller falls back to an ident).
   */
  private countRawHashes(from: number): number | undefined {
    let j = from;
    let n = 0;
    while (this.peek(j) === '#') {
      j++;
      n++;
    }
    return this.peek(j) === '"' ? n : undefined;
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

  /**
   * Nested block comment — depth counted. The open token increments, the close token decrements;
   * ends at depth 0. This is the #1 Rust lexer trap (Java/C block comments do NOT nest; Rust's DO).
   */
  private skipBlockComment(): void {
    this.advance(); // /
    this.advance(); // *
    let depth = 1;
    while (this.pos < this.src.length && depth > 0) {
      if (this.peek() === '/' && this.peek(1) === '*') {
        this.advance();
        this.advance();
        depth++;
        continue;
      }
      if (this.peek() === '*' && this.peek(1) === '/') {
        this.advance();
        this.advance();
        depth--;
        continue;
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
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) > 127;
  }
  private isIdentPart(c: string): boolean {
    return this.isIdentStart(c) || (c >= '0' && c <= '9');
  }
  private isNumberStart(c: string): boolean {
    return c >= '0' && c <= '9';
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

// ---------------------------------------------------------------------------------------------
// 1.2 — comment-block collection (for `explanation` nodes). A "block" is a maximal run of
// contiguous `//`-family line comments (`//`, `///` doc, `//!` inner doc) OR a single `/* … */`
// block comment (Rust block comments NEST; the depth is counted so `/* a /* b */ c */` is ONE
// block). The leading comment markers (`//`, `///`, `//!`, `/*`, `/**`, `/*!`, leading `*`) are
// stripped and each line is trimmed; the block text is the lines joined by `\n`. Pure deterministic,
// never throws — used to associate a comment block ending on the line immediately above a symbol
// with an `explanation` node + `describes` edge.
// ---------------------------------------------------------------------------------------------

/** One retained Rust comment block with its 1-based inclusive line span + cleaned text. */
export interface RustCommentBlock {
  start: number;
  end: number;
  text: string;
}

/** Strip a `//` / `///` / `//!` line-comment prefix and surrounding whitespace from one line. */
function stripLineComment(line: string): string {
  return line.replace(/^\/\/[!/!]?\s?/, '').trim();
}

/** Strip a slash-star open marker (with optional extra `/`,`*`,`!`), a star-slash close marker,
 *  and a leading `*` on continuation lines. */
function stripBlockLine(line: string): string {
  let t = line;
  t = t.replace(/^\/\*+[!*]?/, '');
  t = t.replace(/\*+\/$/, '');
  t = t.replace(/^\s*\*\s?/, '');
  return t.trim();
}

/** Update a block-comment depth by scanning one raw line for slash-star (+1) / star-slash (-1). */
function updateBlockDepth(line: string, depth: number): number {
  let d = depth;
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '/' && line[k + 1] === '*') {
      d++;
      k++;
    } else if (line[k] === '*' && line[k + 1] === '/') {
      d--;
      k++;
    }
  }
  return d;
}

/**
 * Collect comment blocks from Rust source. Contiguous `//`-family lines merge into one block; each
 * slash-star block comment (nesting-aware) is its own block. Inline trailing comments (code before
 * the comment on the same line) are NOT collected — only blocks whose first commented line begins
 * the line (the common case for doc comments above a symbol). Never throws.
 */
export function collectRustComments(src: string): RustCommentBlock[] {
  const out: RustCommentBlock[] = [];
  const lines = src.split('\n');
  let i = 0;
  let blockDepth = 0;
  let blockStart = 0;
  let blockParts: string[] = [];
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (blockDepth > 0) {
      // inside a nested block comment — append this line (leading `*` stripped) and update depth
      blockParts.push(stripBlockLine(trimmed));
      blockDepth = updateBlockDepth(raw, blockDepth);
      if (blockDepth === 0) {
        const text = blockParts.filter((p) => p.length > 0).join('\n');
        out.push({ start: blockStart, end: i + 1, text });
        blockParts = [];
      }
      i++;
      continue;
    }
    if (trimmed.startsWith('//')) {
      const start = i + 1;
      const parts: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('//')) {
        parts.push(stripLineComment((lines[i] ?? '').trim()));
        i++;
      }
      out.push({ start, end: i, text: parts.join('\n') });
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const start = i + 1;
      blockStart = start;
      blockParts = [stripBlockLine(trimmed)];
      blockDepth = updateBlockDepth(raw, 0);
      if (blockDepth === 0) {
        out.push({ start, end: i + 1, text: blockParts[0]! });
        blockParts = [];
      }
      i++;
      continue;
    }
    i++;
  }
  // unterminated block comment — tolerate (lossy) so a malformed source never throws
  if (blockDepth > 0) {
    out.push({
      start: blockStart,
      end: lines.length,
      text: blockParts.filter((p) => p.length > 0).join('\n'),
    });
  }
  return out;
}
