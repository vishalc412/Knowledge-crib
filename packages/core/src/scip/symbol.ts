/**
 * The SCIP symbol-string grammar — parsing and formatting.
 *
 * A SCIP symbol is a URI-like string that identifies one entity across a whole package ecosystem,
 * for example:
 *
 *   scip-typescript npm @knowledge-crib/core 0.1.0 src/scip/symbol.ts/parseScipSymbol().
 *   semanticdb maven com.example lib 1.2.3 com/example/Service#run().
 *   local 4
 *
 * The grammar is quoted verbatim from `scip.proto` so the two never drift:
 *
 *   <symbol>               ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
 *   <package>              ::= <manager> ' ' <package-name> ' ' <version>
 *   <scheme>               ::= any UTF-8, escape spaces with double space
 *   <descriptor>           ::= <namespace> | <type> | <term> | <method> | <type-parameter>
 *                            | <parameter> | <meta> | <macro>
 *   <namespace>            ::= <name> '/'
 *   <type>                 ::= <name> '#'
 *   <term>                 ::= <name> '.'
 *   <meta>                 ::= <name> ':'
 *   <macro>                ::= <name> '!'
 *   <method>               ::= <name> '(' (<method-disambiguator>)? ').'
 *   <type-parameter>       ::= '[' <name> ']'
 *   <parameter>            ::= '(' <name> ')'
 *   <identifier>           ::= <simple-identifier> | <escaped-identifier>
 *   <identifier-character> ::= '_' | '+' | '-' | '$' | ASCII letter or digit
 *   <escaped-identifier>   ::= '`' (<escaped-character>)+ '`'  (backticks escaped by doubling)
 *
 * TWO PLACES A NAIVE PARSER GOES WRONG, both handled below:
 *
 *  - SPLITTING ON SPACES. A double space is an ESCAPED space inside a field, not a separator, so
 *    `scip-java maven com.example my  lib 1.0 Foo#` has package name `my lib`, not fields `my` and
 *    `lib`. Splitting on /\s+/ silently shifts every later field by one.
 *  - SUFFIX SCANNING. A descriptor name may be backtick-escaped and then contains ARBITRARY UTF-8 —
 *    including `/`, `#`, `.` and `(`. Scanning for the next suffix character without tracking
 *    backtick state truncates any symbol whose name needed escaping, which in practice means
 *    operators, unicode identifiers, and anything with a dot in it.
 */

/** Descriptor suffixes, named as `scip.proto`'s `Descriptor.Suffix` enum names them. */
export type ScipSuffix =
  | 'namespace'
  | 'type'
  | 'term'
  | 'method'
  | 'type-parameter'
  | 'parameter'
  | 'meta'
  | 'macro'
  | 'local';

export interface ScipDescriptor {
  name: string;
  suffix: ScipSuffix;
  /** The method disambiguator between `(` and `)` — present only on overloaded methods. */
  disambiguator?: string;
}

export interface ScipSymbol {
  scheme: string;
  package: { manager: string; name: string; version: string };
  descriptors: ScipDescriptor[];
  /** True for `local <id>` symbols, which are Document-scoped and never cross a file boundary. */
  local: boolean;
}

const IDENT_CHAR = /[_+\-$A-Za-z0-9]/;

/**
 * Split a symbol string on UNESCAPED single spaces, un-escaping doubled spaces in place.
 *
 * Returns at most `limit` leading fields plus the entire unconsumed remainder as the last element,
 * because the descriptor run is not space-separated and must be handed to {@link parseDescriptors}
 * intact — a descriptor name can itself contain an escaped space.
 */
function splitEscaped(input: string, limit: number): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < input.length) {
    if (out.length === limit) break;
    if (input[i] === ' ') {
      if (input[i + 1] === ' ') {
        current += ' '; // an escaped space: consume both, keep one
        i += 2;
        continue;
      }
      out.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += input[i];
    i += 1;
  }
  out.push(current + input.slice(i));
  return out;
}

/** Re-escape a field for output: a literal space becomes a double space; empty becomes `.`. */
function escapeField(value: string): string {
  return value === '' ? '.' : value.replace(/ /g, '  ');
}

/**
 * Read one identifier at `pos` — either a simple run of identifier characters, or a backtick-escaped
 * name in which `` `` `` denotes a literal backtick. Returns the DECODED name.
 */
function readIdentifier(input: string, pos: number): [name: string, next: number] | undefined {
  if (input[pos] === '`') {
    let name = '';
    let i = pos + 1;
    while (i < input.length) {
      if (input[i] === '`') {
        if (input[i + 1] === '`') {
          name += '`';
          i += 2;
          continue;
        }
        return [name, i + 1];
      }
      name += input[i];
      i += 1;
    }
    return undefined; // unterminated escape
  }
  let i = pos;
  while (i < input.length && IDENT_CHAR.test(input[i] as string)) i += 1;
  return i === pos ? undefined : [input.slice(pos, i), i];
}

/** Write an identifier back out, backtick-escaping it when it is not a simple identifier. */
function formatIdentifier(name: string): string {
  if (name.length > 0 && [...name].every((ch) => IDENT_CHAR.test(ch))) return name;
  return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * Write a NAMESPACE name, which is the one position where a bare dot is idiomatic.
 *
 * Strictly, `app.ts` needs backticks — `.` is not an <identifier-character>. But every indexer emits
 * `src/app.ts/` bare, and {@link readPathSegment} reads it bare, so escaping it on the way out would
 * break the round trip and emit symbols that differ character-for-character from the ones the same
 * index came in with. Dots are therefore left bare here and ONLY here; any other character that needs
 * escaping still goes through {@link formatIdentifier}.
 */
function formatNamespaceName(name: string): string {
  const pathLike = name.length > 0 && [...name].every((ch) => ch === '.' || IDENT_CHAR.test(ch));
  return pathLike ? name : formatIdentifier(name);
}

/**
 * Match a bare, dotted path segment terminated by `/` — the unescaped namespace form indexers emit.
 *
 * Returns undefined unless the run reaching the next `/` consists only of identifier characters and
 * dots AND contains at least one dot (a dot-free run is an ordinary simple identifier, already
 * handled), so this never shadows a legitimate term or type descriptor.
 */
function readPathSegment(input: string, pos: number): [name: string, next: number] | undefined {
  let i = pos;
  let sawDot = false;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === '/') break;
    if (ch === '.') {
      sawDot = true;
      i += 1;
      continue;
    }
    if (!IDENT_CHAR.test(ch)) return undefined;
    i += 1;
  }
  if (!sawDot || input[i] !== '/' || i === pos) return undefined;
  return [input.slice(pos, i), i + 1];
}

/**
 * Parse the descriptor run.
 *
 * Returns `undefined` on a malformed run rather than a partial list: a half-parsed symbol would
 * produce a plausible-looking wrong qualified name, and a wrong name silently becomes a wrong node
 * id. Callers treat `undefined` as "skip this symbol and count it", which `crib scip import` reports.
 */
export function parseDescriptors(input: string): ScipDescriptor[] | undefined {
  const out: ScipDescriptor[] = [];
  let pos = 0;
  while (pos < input.length) {
    // TOLERANCE FOR WHAT INDEXERS ACTUALLY EMIT, not only what the grammar permits.
    //
    // `.` is not an <identifier-character>, so a path segment like `main.ts` is required to be
    // backtick-escaped. Every deployed indexer emits it bare anyway — real scip-typescript output
    // reads `scip-typescript npm pkg 0.1.0 src/main.ts/main().`. Parsed strictly, `main.ts/` becomes
    // a TERM `main` followed by a NAMESPACE `ts`, and the symbol's qualified name comes out as
    // `src.main.ts.main` instead of `main`. Since a qualified name becomes part of a node id, that is
    // not a cosmetic difference: it would put imported nodes on ids that never match the native ones,
    // defeating the merge this importer exists for.
    //
    // So a dotted run that terminates in `/` — and contains no other suffix character — is accepted
    // as a single namespace name. Strictly-escaped input still parses through the normal path below.
    const dotted = readPathSegment(input, pos);
    if (dotted) {
      out.push({ name: dotted[0], suffix: 'namespace' });
      pos = dotted[1];
      continue;
    }
    // The two bracketed forms lead with their delimiter, so they are recognised before the name.
    if (input[pos] === '[') {
      const read = readIdentifier(input, pos + 1);
      if (!read || input[read[1]] !== ']') return undefined;
      out.push({ name: read[0], suffix: 'type-parameter' });
      pos = read[1] + 1;
      continue;
    }
    if (input[pos] === '(') {
      const read = readIdentifier(input, pos + 1);
      if (!read || input[read[1]] !== ')') return undefined;
      out.push({ name: read[0], suffix: 'parameter' });
      pos = read[1] + 1;
      continue;
    }
    const read = readIdentifier(input, pos);
    if (!read) return undefined;
    const [name, afterName] = read;
    const suffixChar = input[afterName];
    if (suffixChar === '(') {
      // method: `name(disambiguator?).` — the disambiguator is a simple identifier or empty.
      let i = afterName + 1;
      let disambiguator = '';
      while (i < input.length && input[i] !== ')') {
        disambiguator += input[i];
        i += 1;
      }
      if (input[i] !== ')' || input[i + 1] !== '.') return undefined;
      out.push({
        name,
        suffix: 'method',
        ...(disambiguator ? { disambiguator } : {}),
      });
      pos = i + 2;
      continue;
    }
    const suffix = SUFFIX_OF.get(suffixChar ?? '');
    if (!suffix) return undefined;
    out.push({ name, suffix });
    pos = afterName + 1;
  }
  return out.length > 0 ? out : undefined;
}

const SUFFIX_OF = new Map<string, ScipSuffix>([
  ['/', 'namespace'],
  ['#', 'type'],
  ['.', 'term'],
  [':', 'meta'],
  ['!', 'macro'],
]);

const SUFFIX_CHAR: Record<ScipSuffix, string> = {
  namespace: '/',
  type: '#',
  term: '.',
  meta: ':',
  macro: '!',
  method: '',
  'type-parameter': '',
  parameter: '',
  local: '',
};

/**
 * Parse a SCIP symbol string. Returns `undefined` when the string does not satisfy the grammar —
 * never a best guess, for the reason given on {@link parseDescriptors}.
 */
export function parseScipSymbol(input: string): ScipSymbol | undefined {
  if (input === '') return undefined;
  if (input.startsWith('local ')) {
    const id = input.slice('local '.length);
    if (id === '') return undefined;
    return {
      scheme: 'local',
      package: { manager: '', name: '', version: '' },
      descriptors: [{ name: id, suffix: 'local' }],
      local: true,
    };
  }
  const parts = splitEscaped(input, 4);
  if (parts.length < 5) return undefined;
  const [scheme, manager, name, version, rest] = parts as [string, string, string, string, string];
  if (scheme === '') return undefined;
  const descriptors = parseDescriptors(rest);
  if (!descriptors) return undefined;
  // '.' is the documented placeholder for an empty package field, so it round-trips to ''.
  const unplaceholder = (v: string) => (v === '.' ? '' : v);
  return {
    scheme,
    package: {
      manager: unplaceholder(manager),
      name: unplaceholder(name),
      version: unplaceholder(version),
    },
    descriptors,
    local: false,
  };
}

/** Format one descriptor back into its wire form. */
export function formatDescriptor(d: ScipDescriptor): string {
  switch (d.suffix) {
    case 'method':
      return `${formatIdentifier(d.name)}(${d.disambiguator ?? ''}).`;
    case 'type-parameter':
      return `[${formatIdentifier(d.name)}]`;
    case 'parameter':
      return `(${formatIdentifier(d.name)})`;
    case 'local':
      return d.name;
    case 'namespace':
      return `${formatNamespaceName(d.name)}/`;
    default:
      return `${formatIdentifier(d.name)}${SUFFIX_CHAR[d.suffix]}`;
  }
}

/** Format a symbol back into its string form. Round-trips {@link parseScipSymbol}. */
export function formatScipSymbol(symbol: ScipSymbol): string {
  if (symbol.local) return `local ${symbol.descriptors[0]?.name ?? ''}`;
  const pkg = [symbol.package.manager, symbol.package.name, symbol.package.version]
    .map(escapeField)
    .join(' ');
  const descriptors = symbol.descriptors.map(formatDescriptor).join('');
  return `${escapeField(symbol.scheme)} ${pkg} ${descriptors}`;
}

/**
 * The human-readable qualified name for a symbol — what a crib node's `qualifiedName` holds.
 *
 * Namespace descriptors are dropped when they look like PATH segments (a SCIP indexer emits one
 * namespace descriptor per directory, so keeping them would make `src/scip/symbol.ts/parse().` the
 * "name"), and the remaining descriptors join on `.` to match how the native extractors spell a
 * nested name (`Class.method`). Parameters and type parameters are not part of a name.
 */
export function qualifiedNameOf(symbol: ScipSymbol): string {
  const naming = symbol.descriptors.filter(
    (d) => d.suffix !== 'parameter' && d.suffix !== 'type-parameter',
  );
  // Every LEADING namespace descriptor is the enclosing path or package — `src/`, `main.ts/`,
  // `com/example/` — never part of the entity's name. Dropping them is what makes
  // `com/example/Service#run().` come out as `Service.run`, matching how the native extractors spell
  // a nested name. A namespace that appears AFTER a type or term is kept: there it is a real
  // structural parent, not a directory.
  const first = naming.findIndex((d) => d.suffix !== 'namespace');
  const named = first === -1 ? [] : naming.slice(first);
  if (named.length > 0) return named.map((d) => d.name).join('.');
  // A symbol made only of namespaces IS a module or file; its own last segment is its name.
  return naming.at(-1)?.name ?? symbol.descriptors.at(-1)?.name ?? '';
}

/** The suffix of the last naming descriptor — the basis for a crib node `type`. */
export function terminalSuffix(symbol: ScipSymbol): ScipSuffix | undefined {
  return symbol.descriptors.at(-1)?.suffix;
}
