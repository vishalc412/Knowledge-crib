/**
 * PL/SQL lexer (M10) — zero-dependency, offline. Produces a token stream with 1-based line numbers.
 * PL/SQL is case-insensitive for keywords/identifiers; the lexer lower-cases the `text` of word
 * tokens so the parser can compare against lowercase keyword literals, and preserves the original
 * case only where needed (identifiers used as names keep their original form via `raw`).
 *
 * Skips `--` line comments and `/* … *​/` block comments. Handles `'…''…'` string literals (doubled
 * quote escape). Never throws on malformed input — it emits an `unknown` token and advances, so the
 * parser degrades gracefully (capability-honesty, extractor-plugins §5).
 */
export type TokenType =
  | 'word' // identifier or keyword (text lowercased; raw preserves case)
  | 'number'
  | 'string'
  | 'punct' // single-char punctuation: ( ) , ; . % *
  | 'op' // multi-char operators: := = <> != < > <= >= ||
  | 'unknown'
  | 'eof';

export interface Token {
  type: TokenType;
  /** lowercased for words; raw text otherwise. */
  text: string;
  /** original source text (preserves identifier case). */
  raw: string;
  line: number;
  /** char offset of the token's first character in the source (for snippet slicing). */
  off: number;
}

const PUNCT = new Set(['(', ')', ',', ';', '.', '%', '*', '/', '+', '-', ':', '@']);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const push = (type: TokenType, text: string, raw: string, off: number): void => {
    out.push({ type, text, raw, line, off });
  };

  while (i < n) {
    const startOff = i;
    const ch = src[i];

    // newline
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    // whitespace
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    // line comment --
    if (ch === '-' && src[i + 1] === '-') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue; // newline handled next loop
    }
    // block comment /* … */
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2; // consume */
      continue;
    }

    // string literal '…' (doubled '' is an escaped quote)
    if (ch === "'") {
      i++;
      let buf = '';
      while (i < n) {
        const c = src[i];
        if (c === "'") {
          if (src[i + 1] === "'") {
            buf += "'";
            i += 2;
            continue;
          }
          i++; // closing quote
          break;
        }
        if (c === '\n') line++;
        buf += c;
        i++;
      }
      push('string', buf, `'${buf}'`, startOff);
      continue;
    }

    // quoted identifier "…" (case-significant in PL/SQL)
    if (ch === '"') {
      i++;
      let buf = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\n') line++;
        buf += src[i];
        i++;
      }
      i++; // closing "
      push('word', buf.toLowerCase(), buf, startOff);
      continue;
    }

    // number
    if (isDigit(ch)) {
      let j = i + 1;
      while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;
      const raw = src.slice(i, j);
      push('number', raw, raw, startOff);
      i = j;
      continue;
    }

    // word (identifier/keyword)
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const raw = src.slice(i, j);
      push('word', raw.toLowerCase(), raw, startOff);
      i = j;
      continue;
    }

    // multi-char operators
    const two = src.slice(i, i + 2);
    if (
      two === ':=' ||
      two === '<>' ||
      two === '!=' ||
      two === '<=' ||
      two === '>=' ||
      two === '||'
    ) {
      push('op', two, two, startOff);
      i += 2;
      continue;
    }
    // single-char op/punct
    if (ch === '=' || ch === '<' || ch === '>') {
      push('op', ch, ch, startOff);
      i++;
      continue;
    }
    if (ch !== undefined && PUNCT.has(ch)) {
      push('punct', ch, ch, startOff);
      i++;
      continue;
    }

    // unknown — advance one char so we never loop forever (ch is defined: i < n).
    if (ch !== undefined) push('unknown', ch, ch, startOff);
    i++;
  }

  out.push({ type: 'eof', text: '', raw: '', line, off: n });
  return out;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}
function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
}
function isIdentPart(c: string | undefined): boolean {
  return isIdentStart(c) || isDigit(c) || c === '$' || c === '#';
}
