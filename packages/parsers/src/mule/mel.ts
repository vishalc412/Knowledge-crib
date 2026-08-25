/**
 * MEL (Mule Expression Language) scanner — a NON-evaluating tokenizer that extracts variable,
 * property, and registry references plus call names from a Mule 3 `#[…]` expression. It never
 * evaluates arithmetic, ternaries, reflection, Java calls, or collection projections: static literal
 * names are facts, dynamic arguments produce a `mule:dynamic-reference` diagnostic.
 *
 * SECURITY (locked constraint): only property KEY NAMES are recorded — `p('db.password')` records
 * the key `db.password`, NEVER the resolved value (that lives in a properties file the indexer never
 * stores). The string argument to `p()` is a key reference, not a value.
 *
 * Reference kinds:
 *  - `variable`  — flowVars.X, sessionVars.X, message.inboundProperties.X, message.outboundProperties.X
 *  - `property`  — p('key') (the static string argument is a property KEY, not a value)
 *  - `registry`  — app.registry['x'] / app.registry.x / muleContext.registry['x']
 *  - `resource`  — reserved for future file-resource refs (none in this scanner yet)
 *
 * Calls: the identifier token immediately before `(` (so `StringUtils.reverse(` → call 'reverse',
 * `p(` → call 'p'). A non-string `p(...)` argument is flagged `mule:dynamic-reference` (the key is
 * computed at runtime, so no static key name can be extracted).
 */
import type { ExtractDiagnostic } from '../types.js';

/** A scanned MEL reference: a kind + the literal name it binds to. */
export interface MelReference {
  kind: 'variable' | 'property' | 'registry' | 'resource';
  name: string;
  line: number;
}

/** A function/method call observed in the expression (name only — arguments are not evaluated). */
export interface MelCall {
  name: string;
  line: number;
}

/** The non-evaluating scan result of a MEL expression. */
export interface MelResult {
  references: MelReference[];
  calls: MelCall[];
  diagnostics: ExtractDiagnostic[];
}

/** Internal token kinds produced by the char-scanner. */
type TokKind = 'ident' | 'str' | 'punct' | 'eof';
interface Token {
  kind: TokKind;
  /** For 'str' tokens, the UNESCAPED literal value (so `it\'s` → `it's`). For 'punct', the single
   *  punctuation char (`.` `[` `]` `(` `)` …). Empty for 'ident' (use `value`) and 'eof'. */
  value: string;
  line: number;
}

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

/** Strip the Mule `#[…]` wrapper if present, returning the inner expression text. */
function unwrap(source: string): string {
  const s = source.trim();
  if (s.startsWith('#[') && s.endsWith(']')) return s.slice(2, -1);
  return source;
}

/** Tokenize the (unwrapped) expression into identifiers, string literals, and punctuation. Strings
 *  carry their UNESCAPED value so `p('it\'s')` yields the key `it's`. Line (`//`) and block comments
 *  are skipped defensively (MEL `#[…]` rarely contains them, but they must not corrupt the token stream). */
function tokenize(src: string, baseLine: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = baseLine;
  const n = src.length;
  const ch = (k: number): string => src[k] ?? '';
  const push = (kind: TokKind, value: string): void => {
    tokens.push({ kind, value, line });
  };
  while (i < n) {
    const c = ch(i);
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    // line comment `//` → skip to end of line
    if (c === '/' && ch(i + 1) === '/') {
      i += 2;
      while (i < n && ch(i) !== '\n') i++;
      continue;
    }
    // block comment (slash-star … star-slash)
    if (c === '/' && ch(i + 1) === '*') {
      i += 2;
      while (i < n && !(ch(i) === '*' && ch(i + 1) === '/')) {
        if (ch(i) === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // string literal (single or double quoted) with `\` escapes → unescaped value
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let value = '';
      while (i < n && ch(i) !== quote) {
        if (ch(i) === '\\' && i + 1 < n) {
          const next = ch(i + 1);
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (ch(i) === '\n') line++;
        value += ch(i);
        i++;
      }
      i++; // closing quote
      push('str', value);
      continue;
    }
    if (isIdentStart(c)) {
      let value = '';
      while (i < n && isIdentPart(ch(i))) {
        value += ch(i);
        i++;
      }
      push('ident', value);
      continue;
    }
    // single-char punctuation (operators are not parsed; only structural tokens matter)
    push('punct', c);
    i++;
  }
  push('eof', '');
  return tokens;
}

/** Skip a balanced `(...)` group starting AT the `(` token at index `j`; return the index just past
 *  the matching `)`. */
function skipParens(tokens: Token[], start: number): number {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    const t = tokens[j];
    if (t?.kind === 'punct' && t.value === '(') depth++;
    else if (t?.kind === 'punct' && t.value === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return tokens.length; // unbalanced — consume the rest (outer loop ends on eof)
}

/** Classify a dotted member path (optionally followed by a bracket `[STRING]`) into a reference. */
function classifyPath(
  path: string[],
  bracket: string | undefined,
  line: number,
  out: MelReference[],
): void {
  const [head, second, third] = path;
  const tail = third ?? bracket;
  const flowName = second ?? bracket;
  if ((head === 'flowVars' || head === 'sessionVars') && flowName !== undefined) {
    out.push({ kind: 'variable', name: flowName, line });
    return;
  }
  if (
    head === 'message' &&
    (second === 'inboundProperties' || second === 'outboundProperties') &&
    tail !== undefined
  ) {
    out.push({ kind: 'variable', name: tail, line });
    return;
  }
  if ((head === 'app' || head === 'muleContext') && second === 'registry' && tail !== undefined) {
    out.push({ kind: 'registry', name: tail, line });
    return;
  }
  // Unknown binding (bare `payload`, a literal, a ternary operand, …) — do NOT fabricate a reference.
}

/** Scan a MEL expression. `source` may include the `#[…]` wrapper or be the bare inner expression.
 *  `baseLine` (default 1) is the source line stamped on every extracted reference/call. */
export function parseMel(source: string, baseLine = 1): MelResult {
  const inner = unwrap(source);
  const tokens = tokenize(inner, baseLine);
  const references: MelReference[] = [];
  const calls: MelCall[] = [];
  const diagnostics: ExtractDiagnostic[] = [];

  // Safe token accessor: out-of-range indices yield a sentinel 'eof' token so the loop below never
  // dereferences an undefined entry (noUncheckedIndexedAccess is on in this package).
  const at = (idx: number): Token => tokens[idx] ?? { kind: 'eof', value: '', line: baseLine };

  let i = 0;
  while (at(i).kind !== 'eof') {
    const tok = at(i);
    if (tok.kind !== 'ident') {
      i++;
      continue;
    }

    // Collect a dotted member chain: IDENT (. IDENT)*
    const path: string[] = [tok.value];
    let j = i + 1;
    while (at(j).kind === 'punct' && at(j).value === '.' && at(j + 1).kind === 'ident') {
      path.push(at(j + 1).value);
      j += 2;
    }
    // Optional bracket access: path[STRING]
    let bracket: string | undefined;
    if (
      at(j).kind === 'punct' &&
      at(j).value === '[' &&
      at(j + 1).kind === 'str' &&
      at(j + 2).kind === 'punct' &&
      at(j + 2).value === ']'
    ) {
      bracket = at(j + 1).value;
      j += 3;
    }

    // Is it a call? the next token after the (possibly bracketed) path is `(`.
    if (at(j).kind === 'punct' && at(j).value === '(') {
      const callName = path[path.length - 1];
      if (callName !== undefined) calls.push({ name: callName, line: tok.line });
      // `p()` special case: a static string arg is a property KEY (never a value); a non-string arg
      // is dynamic → flag it and record no property name.
      if (path.length === 1 && path[0] === 'p') {
        const firstArg = at(j + 1);
        if (firstArg.kind === 'str') {
          references.push({ kind: 'property', name: firstArg.value, line: tok.line });
        } else {
          diagnostics.push({
            code: 'mule:dynamic-reference',
            severity: 'warning',
            message:
              'Dynamic p() argument — property key not statically determinable; no key recorded.',
          });
        }
      }
      i = skipParens(tokens, j);
      continue;
    }

    // Not a call — classify the member path into a reference (if it matches a known binding).
    classifyPath(path, bracket, tok.line, references);
    i = j;
  }

  // Deduplicate references by (kind, name, line) — a repeated binding is one fact.
  const seen = new Set<string>();
  const deduped: MelReference[] = [];
  for (const r of references) {
    const key = `${r.kind}|${r.name}|${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  return { references: deduped, calls, diagnostics };
}
