/**
 * DataWeave 2 scanner — a bounded tokenizer + structural scanner that lifts the parts of a `.dwl`
 * / inline DataWeave payload that matter for code intelligence: the header directives (`%dw`,
 * `import`, `var`, `fun`, `type`, `ns`), declared functions/variables, function-call sites, and the
 * **property/resource references** (`p('key')`, `Mule::p('key')`, `readUrl('classpath://…')`).
 *
 * SECURITY (locked constraint): this scanner resolves property keys and classpath resource names
 * ONLY when they are string literals. A dynamic reference (`p(someVar)`, `readUrl(f(x))`) is reported
 * as a diagnostic and never resolved into a key — the resolved value lives in a properties file /
 * keystore the indexer never opens. No DataWeave expression text carries a resolved secret.
 */
import type { ExtractDiagnostic } from '../types.js';
import { clampExpr } from '../types.js';

/** Cap on token count for a single DataWeave script — bounds the scan cost of a runaway document. */
const DW_MAX_TOKENS = 200_000;

/** Header directive declaration kinds. */
export type DwDeclarationKind = 'var' | 'fun' | 'type' | 'ns';

/** A header declaration (`var`/`fun`/`type`/`ns`). `expr` is the clamped right-hand text. */
export interface DwDeclaration {
  kind: DwDeclarationKind;
  name: string;
  line: number;
  expr?: string;
}

/** An `import <name> from <module>` directive. */
export interface DwImport {
  name: string;
  module: string;
  line: number;
}

/** A function-call site: an identifier directly followed by `(` (no intervening whitespace). */
export interface DwCall {
  name: string;
  line: number;
}

/** A reference to a declared variable, a property key, or a classpath resource. */
export interface DwReference {
  kind: 'variable' | 'property' | 'resource';
  name: string;
  line: number;
}

/** The bounded structural scan result. */
export interface DataWeaveResult {
  version?: string;
  declarations: DwDeclaration[];
  imports: DwImport[];
  calls: DwCall[];
  references: DwReference[];
  /** Deduplicated property keys referenced via `p('…')` / `Mule::p('…')` (literals only). */
  propertyKeys: string[];
  /** Deduplicated classpath resources referenced via `readUrl('classpath://…')` (literals only). */
  resources: string[];
  diagnostics: ExtractDiagnostic[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────────────────────

type DwTokenKind = 'ident' | 'string' | 'number' | 'symbol' | 'newline' | 'comment';

interface DwToken {
  kind: DwTokenKind;
  value: string;
  /** 1-based line. */
  line: number;
  /** 0-based column of the first char. */
  column: number;
  /** Char offset of the first char (for source slicing). */
  start: number;
  /** Char offset after the last char. */
  end: number;
  /** True if this is the first non-whitespace token on its line. */
  atLineStart: boolean;
  /** True if whitespace (space/tab) immediately preceded this token. */
  wsBefore: boolean;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const NUMBER_PART = /[0-9.]/;

interface TokenizeResult {
  tokens: DwToken[];
  diagnostics: ExtractDiagnostic[];
}

/** Tokenize a DataWeave source into a bounded token stream with line/column + adjacency flags. */
function tokenizeDw(source: string): TokenizeResult {
  const tokens: DwToken[] = [];
  const diagnostics: ExtractDiagnostic[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 1;
  let atLineStart = true;
  let wsBefore = false;
  let capped = false;

  const push = (t: DwToken): void => {
    if (tokens.length >= DW_MAX_TOKENS) {
      if (!capped) {
        capped = true;
        diagnostics.push({
          code: 'mule:dw-token-limit',
          severity: 'warning',
          message: `DataWeave token cap reached (${DW_MAX_TOKENS}); scan truncated`,
          span: { start: t.line, end: t.line },
        });
      }
      return;
    }
    tokens.push(t);
  };

  while (i < n) {
    const ch = source[i] ?? '';
    if (ch === '\n') {
      push({
        kind: 'newline',
        value: '\n',
        line,
        column: col,
        start: i,
        end: i + 1,
        atLineStart,
        wsBefore,
      });
      i++;
      line++;
      col = 1;
      atLineStart = true;
      wsBefore = false;
      continue;
    }
    if (ch === '\r') {
      i++;
      // A lone CR (or CRLF) also advances to the next line; \n (if present) is consumed above next loop.
      if (source[i] !== '\n') {
        line++;
        col = 1;
        atLineStart = true;
        wsBefore = false;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      i++;
      col++;
      wsBefore = true;
      continue;
    }
    // Line comment `//` … to end of line.
    if (ch === '/' && source[i + 1] === '/') {
      const start = i;
      const startLine = line;
      const startCol = col;
      while (i < n && source[i] !== '\n') {
        i++;
        col++;
      }
      push({
        kind: 'comment',
        value: source.slice(start, i),
        line: startLine,
        column: startCol,
        start,
        end: i,
        atLineStart,
        wsBefore,
      });
      atLineStart = false;
      wsBefore = false;
      continue;
    }
    // Block comment `/* … */`.
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      const startLine = line;
      const startCol = col;
      i += 2;
      col += 2;
      let closed = false;
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          col += 2;
          closed = true;
          break;
        }
        if (source[i] === '\n') {
          line++;
          col = 1;
        } else {
          col++;
        }
        i++;
      }
      if (!closed) {
        diagnostics.push({
          code: 'mule:dw-unterminated-comment',
          severity: 'warning',
          message: 'Unterminated block comment',
          span: { start: startLine, end: line },
        });
      }
      push({
        kind: 'comment',
        value: source.slice(start, i),
        line: startLine,
        column: startCol,
        start,
        end: i,
        atLineStart,
        wsBefore,
      });
      atLineStart = false;
      wsBefore = false;
      continue;
    }
    // String literal (single or double quote, backslash escapes; no raw multiline — a bare newline
    // terminates the string and emits an unterminated-string diagnostic).
    if (ch === "'" || ch === '"') {
      const start = i;
      const startLine = line;
      const startCol = col;
      const quote = ch;
      i++;
      col++;
      let closed = false;
      while (i < n) {
        const c = source[i];
        if (c === '\\' && i + 1 < n) {
          i += 2;
          col += 2;
          continue;
        }
        if (c === quote) {
          i++;
          col++;
          closed = true;
          break;
        }
        if (c === '\n') break;
        i++;
        col++;
      }
      if (!closed) {
        diagnostics.push({
          code: 'mule:dw-unterminated-string',
          severity: 'warning',
          message: 'Unterminated string literal',
          span: { start: startLine, end: line },
        });
      }
      const valueEnd = closed ? i - 1 : i;
      push({
        kind: 'string',
        value: source.slice(start + 1, valueEnd),
        line: startLine,
        column: startCol,
        start,
        end: i,
        atLineStart,
        wsBefore,
      });
      atLineStart = false;
      wsBefore = false;
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      const startLine = line;
      const startCol = col;
      while (i < n && IDENT_PART.test(source[i] ?? '')) {
        i++;
        col++;
      }
      push({
        kind: 'ident',
        value: source.slice(start, i),
        line: startLine,
        column: startCol,
        start,
        end: i,
        atLineStart,
        wsBefore,
      });
      atLineStart = false;
      wsBefore = false;
      continue;
    }
    if (DIGIT.test(ch)) {
      const start = i;
      const startLine = line;
      const startCol = col;
      while (i < n && NUMBER_PART.test(source[i] ?? '')) {
        i++;
        col++;
      }
      push({
        kind: 'number',
        value: source.slice(start, i),
        line: startLine,
        column: startCol,
        start,
        end: i,
        atLineStart,
        wsBefore,
      });
      atLineStart = false;
      wsBefore = false;
      continue;
    }
    // `::` qualified-name separator (e.g. `dw::core::Strings`, `Mule::p`).
    if (ch === ':' && source[i + 1] === ':') {
      push({
        kind: 'symbol',
        value: '::',
        line,
        column: col,
        start: i,
        end: i + 2,
        atLineStart,
        wsBefore,
      });
      i += 2;
      col += 2;
      atLineStart = false;
      wsBefore = false;
      continue;
    }
    // `---` header/body separator (three dashes). Detected here so the structural scanner can
    // treat it as a single symbol and stop directive parsing past it.
    if (ch === '-' && source[i + 1] === '-' && source[i + 2] === '-') {
      push({
        kind: 'symbol',
        value: '---',
        line,
        column: col,
        start: i,
        end: i + 3,
        atLineStart,
        wsBefore,
      });
      i += 3;
      col += 3;
      atLineStart = false;
      wsBefore = false;
      continue;
    }
    push({
      kind: 'symbol',
      value: ch,
      line,
      column: col,
      start: i,
      end: i + 1,
      atLineStart,
      wsBefore,
    });
    i++;
    col++;
    atLineStart = false;
    wsBefore = false;
  }
  return { tokens, diagnostics };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Structural scanner
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DIRECTIVE_KEYWORDS = new Set(['import', 'var', 'fun', 'type', 'ns', 'output', 'input']);

/** Find the offset just past the last char of a 1-based line (excludes the trailing `\n`). */
function lineEndOffset(lineStarts: number[], line: number, sourceLen: number): number {
  // lineStarts[L] = start offset of line (L+1); so line L ends at lineStarts[L] - 1 (the `\n`).
  const start = lineStarts[line];
  if (start !== undefined) return Math.max(start - 1, 0);
  return sourceLen;
}

/** Find the matching close paren for an open paren at `openIdx`, tracking nesting. Returns -1 if
 *  none is found on the same logical scan. */
function findMatchingParen(tokens: DwToken[], openIdx: number): number {
  let depth = 0;
  for (let j = openIdx; j < tokens.length; j++) {
    const t = tokens[j];
    if (!t || t.kind !== 'symbol') continue;
    if (t.value === '(') depth++;
    else if (t.value === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the first token strictly after the given 1-based line (or tokens.length). */
function skipLine(tokens: DwToken[], fromIdx: number, line: number): number {
  let j = fromIdx + 1;
  while (j < tokens.length && tokens[j]?.line === line) j++;
  return j;
}

/** Parse a DataWeave 2 source into a bounded {@link DataWeaveResult}. Never throws — malformed or
 *  hostile input degrades to diagnostics. */
export function parseDataWeave(source: string): DataWeaveResult {
  // Precompute per-line start offsets for source slicing + the header/body split.
  const lineStarts: number[] = [0];
  for (let k = 0; k < source.length; k++) {
    if (source[k] === '\n') lineStarts.push(k + 1);
  }
  const lineCount = lineStarts.length; // number of lines (1-based last line = lineCount)

  const { tokens, diagnostics } = tokenizeDw(source);

  const result: DataWeaveResult = {
    declarations: [],
    imports: [],
    calls: [],
    references: [],
    propertyKeys: [],
    resources: [],
    diagnostics,
  };

  const seenPropertyKeys = new Set<string>();
  const seenResources = new Set<string>();
  const seenCalls = new Set<string>();

  const addCall = (name: string, line: number): void => {
    const key = `${line}:${name}`;
    if (seenCalls.has(key)) return;
    seenCalls.add(key);
    result.calls.push({ name, line });
  };

  const addPropertyKey = (key: string, line: number): void => {
    if (!seenPropertyKeys.has(key)) {
      seenPropertyKeys.add(key);
      result.propertyKeys.push(key);
    }
    result.references.push({ kind: 'property', name: key, line });
  };

  const addResource = (name: string, line: number): void => {
    if (!seenResources.has(name)) {
      seenResources.add(name);
      result.resources.push(name);
    }
    result.references.push({ kind: 'resource', name, line });
  };

  // DW1 message-context variable references (flowVars.X / inboundProperties.X / outboundProperties.X)
  // are deduplicated by (line, name) — a repeated binding is one fact.
  const seenVarRefs = new Set<string>();
  const addVarRef = (name: string, line: number): void => {
    const key = `${line}:${name}`;
    if (seenVarRefs.has(key)) return;
    seenVarRefs.add(key);
    result.references.push({ kind: 'variable', name, line });
  };

  // Record a property reference `p(arg)`/`Mule::p(arg)`. Only string-literal args resolve to a key;
  // a dynamic arg is a diagnostic and never resolved (the resolved value lives in a properties file
  // the indexer never stores).
  const recordPropertyRef = (arg: DwToken | undefined, pLine: number): void => {
    if (arg && arg.kind === 'string') {
      addPropertyKey(arg.value, pLine);
      return;
    }
    result.diagnostics.push({
      code: 'mule:dynamic-property',
      severity: 'warning',
      message: 'Dynamic property reference in p() — key not statically resolvable',
      span: { start: pLine, end: pLine },
    });
    result.references.push({ kind: 'property', name: '(dynamic)', line: pLine });
  };

  const recordResourceRef = (arg: DwToken | undefined, pLine: number): void => {
    if (arg && arg.kind === 'string') {
      addResource(arg.value, pLine);
      return;
    }
    result.diagnostics.push({
      code: 'mule:dynamic-resource',
      severity: 'warning',
      message: 'Dynamic resource reference in readUrl() — path not statically resolvable',
      span: { start: pLine, end: pLine },
    });
    result.references.push({ kind: 'resource', name: '(dynamic)', line: pLine });
  };

  // Header = lines before the first `---` separator; directives are only parsed there. A script
  // with no separator is header-only (all lines are header).
  let headerEndLine = lineCount + 1;
  for (const t of tokens) {
    if (t.value === '---') {
      headerEndLine = t.line;
      break;
    }
  }

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    // `i` is bounded by length above; the guard satisfies noUncheckedIndexedAccess.
    if (!t) {
      i += 1;
      continue;
    }
    const next = tokens[i + 1];

    // Header directives: `%dw`, import, var, fun, type, ns — only before the `---` separator.
    if (t.line < headerEndLine && t.atLineStart) {
      if (t.kind === 'symbol' && t.value === '%' && next?.kind === 'ident' && next.value === 'dw') {
        const versionTok = tokens[i + 2];
        result.version = versionTok?.value;
        i += 3;
        continue;
      }
      // DW1 header directives are %-prefixed: %output / %input (valid in both dialects → skipLine),
      // and %var / %function (DW1-only → var/fun declarations). %var/%function are gated on the 1.x
      // version so a stray DW2 `%var` is not misparsed as a declaration.
      if (
        t.kind === 'symbol' &&
        t.value === '%' &&
        next?.kind === 'ident' &&
        (next.value === 'output' ||
          next.value === 'input' ||
          (result.version?.startsWith('1.') && (next.value === 'var' || next.value === 'function')))
      ) {
        // Parse starting at the keyword token (i + 1); parseDirective reads the name from startIdx + 1.
        i = parseDirective(tokens, i + 1, source, lineStarts, result);
        continue;
      }
      if (t.kind === 'ident' && DIRECTIVE_KEYWORDS.has(t.value)) {
        i = parseDirective(tokens, i, source, lineStarts, result);
        continue;
      }
    }

    // Property / resource references + generic calls — scanned across header AND body.
    if (t.kind === 'ident') {
      // DW1 message-context variable references: flowVars.X / inboundProperties.X / outboundProperties.X.
      const memberTok = tokens[i + 2];
      if (
        (t.value === 'flowVars' ||
          t.value === 'inboundProperties' ||
          t.value === 'outboundProperties') &&
        next?.kind === 'symbol' &&
        next.value === '.' &&
        memberTok?.kind === 'ident'
      ) {
        addVarRef(memberTok.value, t.line);
        i += 3;
        continue;
      }
      // `Mule::p('key')`
      if (
        t.value === 'Mule' &&
        next?.kind === 'symbol' &&
        next.value === '::' &&
        tokens[i + 2]?.kind === 'ident' &&
        tokens[i + 2]?.value === 'p' &&
        tokens[i + 3]?.kind === 'symbol' &&
        tokens[i + 3]?.value === '('
      ) {
        addCall('p', t.line);
        recordPropertyRef(tokens[i + 4], t.line);
        i += 3; // advance past Mule :: p; leave `(` for the main loop (its arg follows harmlessly)
        continue;
      }
      // `p('key')`
      if (t.value === 'p' && next?.kind === 'symbol' && next.value === '(' && !next.wsBefore) {
        addCall('p', t.line);
        recordPropertyRef(tokens[i + 2], t.line);
        i += 1;
        continue;
      }
      // `readUrl('classpath://…')`
      if (
        t.value === 'readUrl' &&
        next?.kind === 'symbol' &&
        next.value === '(' &&
        !next.wsBefore
      ) {
        addCall('readUrl', t.line);
        recordResourceRef(tokens[i + 2], t.line);
        i += 1;
        continue;
      }
      // Generic call: identifier directly followed by `(` (no whitespace) — catches `upper(…)`,
      // `total(…)`; infix `reduce (` (with a space) is intentionally NOT a call.
      if (next?.kind === 'symbol' && next.value === '(' && !next.wsBefore) {
        addCall(t.value, t.line);
        i += 1;
        continue;
      }
    }

    i += 1;
  }

  return result;
}

/** Parse one header directive starting at `startIdx` (a DIRECTIVE_KEYWORDS ident). Returns the new
 *  scan index. For `var`/`fun`/`type`, the directive name + (params) + `=` are consumed and the
 *  scan resumes ON the right-hand expression so its calls/property references are still detected;
 *  the function-declaration name's own `(params)` is NOT recorded as a call. `import`/`ns` consume
 *  to end of line (no calls in their operands). */
function parseDirective(
  tokens: DwToken[],
  startIdx: number,
  source: string,
  lineStarts: number[],
  result: DataWeaveResult,
): number {
  const kw = tokens[startIdx];
  // The caller only enters this for a real directive keyword token, so `kw` is present; the guard
  // keeps noUncheckedIndexedAccess honest without changing behavior.
  if (!kw) return startIdx + 1;
  const line = kw.line;

  switch (kw.value) {
    case 'output':
    case 'input':
      return skipLine(tokens, startIdx, line);

    case 'import': {
      const nameTok = tokens[startIdx + 1];
      // Find `from` on the same line.
      let j = startIdx + 2;
      while (j < tokens.length && tokens[j]?.line === line && tokens[j]?.value !== 'from') j++;
      const moduleStartTok = tokens[j + 1];
      const moduleStart = moduleStartTok?.start ?? kw.end;
      const moduleEnd = lineEndOffset(lineStarts, line, source.length);
      const module = source.slice(moduleStart, moduleEnd).trim();
      result.imports.push({ name: nameTok?.value ?? '', module, line });
      return skipLine(tokens, startIdx, line);
    }

    case 'var':
    case 'type': {
      const nameTok = tokens[startIdx + 1];
      // Advance to `=` on the same line.
      let j = startIdx + 2;
      while (j < tokens.length && tokens[j]?.line === line && tokens[j]?.value !== '=') j++;
      const eqIdx = j;
      const eqTok = tokens[eqIdx];
      const exprStartTok = tokens[eqIdx + 1];
      const exprStart = exprStartTok?.start ?? eqTok?.end ?? kw.end;
      const exprEnd = lineEndOffset(lineStarts, line, source.length);
      const rawExpr = source.slice(exprStart, exprEnd).trim();
      const decl: DwDeclaration = {
        kind: kw.value as 'var' | 'type',
        name: nameTok?.value ?? '',
        line,
      };
      if (rawExpr.length > 0) decl.expr = clampExpr(rawExpr).expr;
      result.declarations.push(decl);
      // Resume scanning ON the right-hand expression (after `=`) so p()/calls in it are detected.
      return eqIdx + 1;
    }

    case 'fun':
    case 'function': {
      const nameTok = tokens[startIdx + 1];
      // Skip the parameter list `( … )`.
      let j = startIdx + 2;
      while (j < tokens.length && tokens[j]?.line === line && tokens[j]?.value !== '(') j++;
      const openIdx = j;
      const openTok = tokens[openIdx];
      const closeIdx = openTok && openTok.value === '(' ? findMatchingParen(tokens, openIdx) : -1;
      j = closeIdx > 0 ? closeIdx + 1 : j;
      // Advance to `=` on the same line.
      while (j < tokens.length && tokens[j]?.line === line && tokens[j]?.value !== '=') j++;
      const eqIdx = j;
      const eqTok = tokens[eqIdx];
      const exprStartTok = tokens[eqIdx + 1];
      const exprStart = exprStartTok?.start ?? eqTok?.end ?? kw.end;
      const exprEnd = lineEndOffset(lineStarts, line, source.length);
      const rawExpr = source.slice(exprStart, exprEnd).trim();
      const decl: DwDeclaration = { kind: 'fun', name: nameTok?.value ?? '', line };
      if (rawExpr.length > 0) decl.expr = clampExpr(rawExpr).expr;
      result.declarations.push(decl);
      // The declaration name + `(params)` were consumed here, so `total(xs)` is NOT recorded as a
      // call; the body invocation `total(payload.lines)` (a later line) still is. Resume on the
      // right-hand expression.
      return eqIdx + 1;
    }

    case 'ns': {
      const prefixTok = tokens[startIdx + 1];
      result.declarations.push({ kind: 'ns', name: prefixTok?.value ?? '', line });
      return skipLine(tokens, startIdx, line);
    }

    default:
      return startIdx + 1;
  }
}
