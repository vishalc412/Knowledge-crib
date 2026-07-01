/**
 * C# structural parser — turns the token stream into a declaration tree (namespace / class /
 * interface / struct / record / enum / delegate / method / property / constructor / indexer / operator)
 * plus a flat list of call sites + usings + the file's namespace. NOT a full expression parser: the
 * symbol graph only needs declaration spans + nesting (member-of + qualified names) and call-site
 * heads (for `calls`), so a tolerant brace-level descent is enough.
 *
 * Field declarations are intentionally NOT emitted as symbols (parity with the Java extractor's
 * altitude: types + methods + properties, not fields); their call sites ARE still captured by the
 * whole-stream call collector. Local functions inside method bodies are NOT extracted (method bodies
 * are consumed, not descended) — an honest, documented limitation. Properties are emitted as ONE
 * symbol; the get/set/init accessor bodies are NOT descended (no separate accessor symbols).
 *
 * Generic angle-bracket balancing counts single `<`/`>` tokens; a `>>` op is treated as TWO closers
 * (C# has NO Java-style `>>` split rule — `>>` is just two `>` ops that happen to be lexed as one
 * token, so the generic skipper decrements by 2 when it sees `>>`).
 *
 * The `:` clause (`class C : Base, I1, I2`) carries BOTH the base class AND the interface list. A
 * same-file type-kind pre-scan classifies each target: if the name is declared as `interface` in this
 * file → `implements`; otherwise → `bases` (inherits). External (cross-file) targets default to
 * `bases` — the resolver does the authoritative split against the global symbol table and emits the
 * `inherits` / `implements` edges; the extractor's `meta` split is only a same-file hint.
 */
import { tokenize } from './lexer.js';
import type { Token } from './lexer.js';

export type CsharpKind =
  | 'namespace'
  | 'class'
  | 'interface'
  | 'struct'
  | 'record'
  | 'enum'
  | 'delegate'
  | 'method'
  | 'property'
  | 'constructor'
  | 'indexer'
  | 'operator';

export interface CsharpDef {
  kind: CsharpKind;
  name: string;
  /** 1-based line of the first token of the declaration (leading attribute/modifier). */
  startLine: number;
  /** 1-based line of the declaration's last token (closing `}` for types, `}`/`;` for methods). */
  endLine: number;
  modifiers: string[];
  /** attribute simple names preceding the declaration (`[ApiController]` → ["ApiController"]). */
  attributes: string[];
  /** `:` targets classified as base classes / records (`class C : Base` → ["Base"]). */
  bases: string[];
  /** `:` targets classified as interfaces (`class C : IFoo` → ["IFoo"]). */
  implements: string[];
  /** parameter names (methods / constructors / delegates / record primary ctors). */
  params: string[];
  /** nested TYPE/NAMESPACE declarations only (methods/properties are not recursed). */
  body: CsharpDef[];
  /** file-scoped `namespace X;` flag — the extractor treats its body as the file's top-level defs. */
  fileScoped?: boolean;
  /**
   * Statement tree of a method/constructor/operator body (Track 3 CFG extraction). Absent/empty for
   * types, namespaces, properties (accessors not descended), expression-bodied members, and
   * abstract/interface methods. The extractor walks it with a guard stack.
   */
  stmts?: CsharpStmt[];
}

export interface CsharpCallSite {
  /** callee head: a bare name or the first segment of a dotted chain. */
  head: string;
  /** dotted tail after the head (`obj.M` → ["M"]). */
  tail: string[];
  /** last segment — the function/method name being invoked. */
  name: string;
  /** 1-based line of the call's opening `(`. */
  line: number;
}

export interface CsharpImport {
  /** dotted module path as written (`using A.B.C;` → "A.B"; `using A = B.C.D;` → "B.C.D" target). */
  module: string;
  /** simple name bound locally (`using A.B.C;` → "C"; `using A = B.C.D;` → "A" the alias). */
  name: string;
  /** `using static`. */
  static: boolean;
  /** `using A = B;` alias. */
  alias: boolean;
  /** for an alias, the full target dotted name (`using A = B.C.D;` → "B.C.D"). */
  target: string;
  /** `global using`. */
  global: boolean;
  line: number;
}

export interface CsharpModule {
  defs: CsharpDef[];
  calls: CsharpCallSite[];
  imports: CsharpImport[];
  /** the file's outermost namespace name (file-scoped or first block), or "" if absent. */
  pkg: string;
}

// ── Statement tree (Track 3: CFG / condition / guard-chain extraction) ──────────────────────
// The declaration tree above captures WHAT is declared; this statement tree captures the
// COMPOUND-STATEMENT STRUCTURE of each method body (if/else/for/foreach/while/do/switch/try/catch +
// leaf actions: return/throw/call). The extractor walks it with a guard stack, stamping
// cfgPath/guard/branch/inLoop/inException on the executes/calls edges it emits — the language-
// agnostic `extract_rules` decision-table verb consumes those fields. Tolerant + lossy: a malformed
// compound degrades to skipping its body; predicate text is a best-effort source slice.

/** A statement in a method body. Compound kinds recurse via `branches`/`body`/`cases`/`handlers`. */
export interface CsharpStmt {
  kind: 'if' | 'loop' | 'switch' | 'try' | 'return' | 'throw' | 'call' | 'assign' | 'plain';
  /** 1-based line of the statement's first token. */
  startLine: number;
  /** 1-based line of the statement's last token. */
  endLine: number;
  // --- if ---
  /** the `if` line — ONE condition node per IF is keyed by (file, ifLine) so all branches share it. */
  ifLine?: number;
  branches?: CsharpIfBranch[];
  // --- loop (for/foreach/while/do) ---
  loopKind?: 'for' | 'foreach' | 'while' | 'do';
  /** for/foreach/while/do predicate text (the `(...)` contents, best-effort). */
  predicate?: string;
  body?: CsharpStmt[];
  // --- switch ---
  cases?: CsharpSwitchCase[];
  // --- try ---
  tryBody?: CsharpStmt[];
  handlers?: CsharpCatchHandler[];
  // --- leaf actions ---
  /** best-effort source text of the action (≤200 chars at the extractor). */
  expr?: string;
  /** callee simple name for a call; leading keyword for return/throw. */
  head?: string;
  /** the primary call site of a call/return/throw leaf, for intra-file `calls` edge annotation. */
  callSite?: CsharpCallSite;
  // --- schema 1.2 deep-extraction fields ---
  /** `assign` leaf: the LHS target identifier (e.g. `label` from `label = "x"`). */
  assignTarget?: string;
  /** switch-expression arms lifted out of a return/throw/assign/call leaf (`e switch { … }`). */
  switchArms?: CsharpSwitchCase[];
}

export interface CsharpIfBranch {
  /** THEN is the first; ELSIF repeats (else-if); ELSE is the trailing branch. */
  label: 'THEN' | 'ELSIF' | 'ELSE';
  /** predicate text; undefined for ELSE. */
  predicate?: string;
  body: CsharpStmt[];
}

export interface CsharpSwitchCase {
  /** case predicate text; undefined for `default`. */
  predicate?: string;
  /** 1-based line of the `case`/`default` keyword (the condition node line). */
  condLine: number;
  body: CsharpStmt[];
}

export interface CsharpCatchHandler {
  /** exception type + binding text (`System.ArgumentException ex`), or undefined for catch-all. */
  predicate?: string;
  /** `catch (…) when (filter)` — the filter paren text, e.g. "score < -10". */
  filter?: string;
  /** 1-based line of the `catch`/`finally` keyword (the exception-handler node line). */
  line: number;
  /** `finally { … }` block (not a catch — walked inException but no handler node is emitted). */
  finally?: boolean;
  body: CsharpStmt[];
}

/** Parse C# source into a declaration tree + call sites + usings + namespace (never throws). */
export function parseCsharp(src: string): CsharpModule {
  try {
    const tokens = tokenize(src);
    const p = new Parser(tokens, src);
    const { defs, excluded } = p.parseProgram();
    const calls = collectCallSites(tokens, excluded);
    const { pkg, imports } = collectImports(tokens);
    // wrap a file-scoped namespace: all other top-level defs become its body.
    const fsIdx = defs.findIndex((d) => d.kind === 'namespace' && d.fileScoped);
    if (fsIdx >= 0) {
      const ns = defs[fsIdx]!;
      ns.body = defs.filter((_, i) => i !== fsIdx);
      ns.endLine = Math.max(ns.endLine, ...ns.body.map((b) => b.endLine), ns.startLine);
      return { defs: [ns], calls, imports, pkg: pkg || ns.name };
    }
    return { defs, calls, imports, pkg };
  } catch {
    return { defs: [], calls: [], imports: [], pkg: '' };
  }
}

class Parser {
  private readonly t: Token[];
  private i = 0;
  /** token indices of definition / attribute `(` openers — call sites at these indices are NOT calls. */
  private readonly excluded = new Set<number>();
  /** same-file type-kind map for `:` disambiguation (interfaces vs class-likes). */
  private readonly typeKinds: { interfaces: Set<string>; classLikes: Set<string> };
  /** the source text, for best-effort predicate/expression slices in the statement tree. */
  private readonly src: string;
  /** char offset of the start of each 1-based line (lineStarts[n-1] = offset of line n). */
  private readonly lineStarts: number[];

  constructor(tokens: Token[], src: string) {
    this.t = tokens;
    this.src = src;
    this.typeKinds = collectTypeKinds(tokens);
    this.lineStarts = computeLineStarts(src);
  }

  parseProgram(): { defs: CsharpDef[]; excluded: Set<number> } {
    const { defs } = this.parseDecls(true);
    return { defs, excluded: this.excluded };
  }

  /**
   * Parse declarations at one brace level. `topLevel` ⇒ stop at EOF (a stray `}` is left).
   * Returns the nested defs plus `closeLine` — the 1-based line of the closing `}` that ended a
   * non-top-level block (0 for top level), used to size the enclosing type's `endLine`.
   */
  private parseDecls(topLevel: boolean): { defs: CsharpDef[]; closeLine: number } {
    const defs: CsharpDef[] = [];
    let closeLine = 0;
    while (!this.atEnd()) {
      if (this.isOp('}')) {
        closeLine = this.peek().line;
        if (!topLevel) this.next();
        break;
      }
      if (this.isOp('{')) {
        // bare block (stray initializer) — skip it.
        this.skipBraces();
        continue;
      }
      if (this.isOp(';') || this.isOp(',')) {
        this.next(); // stray terminator
        continue;
      }
      const before = this.i;
      const d = this.parseDecl();
      if (d) defs.push(d);
      else if (this.i === before && !this.atEnd()) this.next(); // progress guard
    }
    return { defs, closeLine };
  }

  /** Parse one declaration; returns a def (type / namespace / method / property / etc.) or null. */
  private parseDecl(): CsharpDef | null {
    const startLine = this.peek().line;
    const attributes: string[] = [];
    const modifiers: string[] = [];
    // consume leading attributes + modifiers (they may interleave)
    while (!this.atEnd()) {
      if (this.isOp('[')) {
        this.consumeAttribute(attributes);
        continue;
      }
      if (this.isNameAnyOf(MODIFIER_NAMES)) {
        modifiers.push(this.peek().value);
        this.next();
        continue;
      }
      break;
    }
    if (this.atEnd()) return null;
    const kw = this.peek().value;
    if (this.isName('namespace')) return this.parseNamespace(startLine, attributes, modifiers);
    if (this.isName('class')) return this.parseType('class', startLine, attributes, modifiers);
    if (this.isName('interface'))
      return this.parseType('interface', startLine, attributes, modifiers);
    if (this.isName('struct')) return this.parseType('struct', startLine, attributes, modifiers);
    if (this.isName('record')) return this.parseRecord(startLine, attributes, modifiers);
    if (this.isName('enum')) return this.parseType('enum', startLine, attributes, modifiers);
    if (this.isName('delegate')) return this.parseDelegate(startLine, attributes, modifiers);
    return this.parseMember(startLine, attributes, modifiers);
  }

  /** Parse a namespace — block `namespace A.B { ... }` or file-scoped `namespace A.B;`. */
  private parseNamespace(
    startLine: number,
    attributes: string[],
    modifiers: string[],
  ): CsharpDef | null {
    this.next(); // 'namespace'
    const name = this.parseDottedName();
    if (!name) return null;
    let body: CsharpDef[] = [];
    let endLine = startLine;
    let fileScoped = false;
    if (this.isOp('{')) {
      this.next();
      const res = this.parseDecls(false);
      body = res.defs;
      endLine = res.closeLine || this.peek().line;
    } else if (this.isOp(';')) {
      this.next();
      endLine = this.peek().line;
      fileScoped = true;
    } else {
      // tolerate: malformed namespace — bail
      return null;
    }
    endLine = Math.max(endLine, ...body.map((b) => b.endLine), startLine);
    return {
      kind: 'namespace',
      name,
      startLine,
      endLine,
      modifiers,
      attributes,
      bases: [],
      implements: [],
      params: [],
      body,
      fileScoped,
    };
  }

  /** Parse `record` / `record class` / `record struct` — all classified as kind 'record'. */
  private parseRecord(
    startLine: number,
    attributes: string[],
    modifiers: string[],
  ): CsharpDef | null {
    this.next(); // 'record'
    // `record struct Name` / `record class Name` — consume the secondary kind keyword.
    if (this.isName('struct') || this.isName('class')) this.next();
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    this.skipGenericAngle();
    const params: string[] = [];
    if (this.isOp('(')) {
      this.excluded.add(this.i);
      params.push(...this.parseParamList());
    }
    const { bases, impls } = this.parseBaseClause();
    this.skipWhereClauses();
    let body: CsharpDef[] = [];
    let endLine = startLine;
    if (this.isOp('{')) {
      this.next();
      const res = this.parseDecls(false);
      body = res.defs;
      endLine = res.closeLine || this.peek().line;
    } else if (this.isOp(';')) {
      this.next();
      endLine = this.peek().line;
    }
    endLine = Math.max(endLine, ...body.map((b) => b.endLine), startLine);
    return {
      kind: 'record',
      name,
      startLine,
      endLine,
      modifiers,
      attributes,
      bases,
      implements: impls,
      params,
      body,
    };
  }

  /** Parse a type declaration (class / interface / struct / enum) + recurse into its body. */
  private parseType(
    kind: 'class' | 'interface' | 'struct' | 'enum',
    startLine: number,
    attributes: string[],
    modifiers: string[],
  ): CsharpDef | null {
    this.next(); // kind keyword
    // a type name must be a NAME that is NOT a hard-reserved keyword.
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    this.skipGenericAngle(); // type params <T>

    // primary constructor (C# 12): `class Foo(int x) { ... }` — capture params.
    const params: string[] = [];
    if (this.isOp('(')) {
      this.excluded.add(this.i);
      params.push(...this.parseParamList());
    }

    const { bases, impls } = this.parseBaseClause();
    this.skipWhereClauses();

    let body: CsharpDef[] = [];
    let endLine = startLine;
    if (this.isOp('{')) {
      this.next();
      if (kind === 'enum') this.skipEnumConstants();
      const res = this.parseDecls(false);
      body = res.defs;
      endLine = res.closeLine || this.peek().line;
    } else if (this.isOp(';')) {
      this.next();
      endLine = this.peek().line;
    }
    endLine = Math.max(endLine, ...body.map((b) => b.endLine), startLine);
    return {
      kind,
      name,
      startLine,
      endLine,
      modifiers,
      attributes,
      bases,
      implements: impls,
      params,
      body,
    };
  }

  /** Parse `delegate TYPE Name(params);` — no body, ends with `;`. */
  private parseDelegate(
    startLine: number,
    attributes: string[],
    modifiers: string[],
  ): CsharpDef | null {
    this.next(); // 'delegate'
    // return type (NAME, possibly dotted/generic) — skip it.
    if (this.isNameToken()) {
      this.next();
      this.skipGenericAngle();
      while (this.isOp('.') && this.peek(1).type === 'NAME') {
        this.next();
        this.next();
        this.skipGenericAngle();
      }
    }
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    this.skipGenericAngle();
    let params: string[] = [];
    let endLine = this.peek().line;
    if (this.isOp('(')) {
      this.excluded.add(this.i);
      params = this.parseParamList();
      endLine = this.peek().line;
    }
    if (this.isOp(';')) {
      this.next();
      endLine = this.peek().line;
    } else if (this.isOp('{')) {
      endLine = this.skipBraces(); // tolerate a body (non-standard)
    }
    return {
      kind: 'delegate',
      name,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers,
      attributes,
      bases: [],
      implements: [],
      params,
      body: [],
    };
  }

  /**
   * Parse the `: Base, I1, I2` clause. Returns a same-file-classified split: targets whose name is
   * declared as `interface` in this file → `implements`; the rest → `bases`.
   */
  private parseBaseClause(): { bases: string[]; impls: string[] } {
    const bases: string[] = [];
    const impls: string[] = [];
    if (!this.isOp(':')) return { bases, impls };
    this.next(); // ':'
    while (!this.atEnd()) {
      const name = this.parseDottedTypeName();
      if (name) {
        const last = lastSegment(name);
        if (this.typeKinds.interfaces.has(last)) impls.push(name);
        else bases.push(name);
      }
      this.skipGenericAngle();
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.isName('where') || this.isOp('{') || this.isOp(';')) break;
      if (this.atEnd()) break;
      this.next(); // tolerate stray tokens
    }
    return { bases, impls };
  }

  /** Skip `where T : constraint, ...` clauses (one or more) until `{` or `;`. */
  private skipWhereClauses(): void {
    while (this.isName('where')) {
      this.next(); // 'where'
      // the type parameter name
      if (this.isNameToken()) this.next();
      if (this.isOp(':')) this.next();
      // skip until `{`, `;`, or the next `where` — tracking paren/bracket depth so `new()` is skipped.
      let pdepth = 0;
      let bdepth = 0;
      while (!this.atEnd()) {
        if (pdepth === 0 && bdepth === 0 && (this.isOp('{') || this.isOp(';'))) return;
        if (pdepth === 0 && bdepth === 0 && this.isName('where')) break;
        if (this.isOp('(')) pdepth++;
        else if (this.isOp(')')) pdepth = Math.max(0, pdepth - 1);
        else if (this.isOp('[')) bdepth++;
        else if (this.isOp(']')) bdepth = Math.max(0, bdepth - 1);
        this.next();
      }
    }
  }

  /**
   * Parse a member that is not a type: a method, constructor, property, indexer, operator, or
   * (skipped) a field / init block. Scans the header tracking generic/paren/bracket depth to find the
   * declared name and decide method-vs-constructor-vs-property.
   */
  private parseMember(
    startLine: number,
    attributes: string[],
    modifiers: string[],
  ): CsharpDef | null {
    let gdepth = 0;
    let pdepth = 0;
    let bdepth = 0;
    let nameCount = 0;
    let lastName: string | undefined;
    let sawParen = false;
    let isIndexer = false;
    let isOperator = false;

    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && gdepth === 0 && bdepth === 0) {
        if (this.isOp('(')) {
          sawParen = true;
          break;
        }
        if (this.isOp('{')) {
          // property (auto or with accessors) if we have a name and no `(` seen; else init block.
          break;
        }
        if (this.isOp('=>')) {
          // expression-bodied property (no `(` seen) or method (handled after `(`).
          break;
        }
        if (this.isOp(';') || this.isOp('=') || this.isOp(',')) {
          // field
          break;
        }
        if (this.isOp('}')) return null; // end of enclosing block — caller handles
      }
      if (tk.type === 'NAME') {
        if (pdepth === 0 && gdepth === 0 && bdepth === 0) {
          // detect `operator <sym>` — the `operator` keyword is followed by the operator symbol.
          if (tk.value === 'operator' && nameCount >= 1) {
            isOperator = true;
            this.next();
            // the operator symbol: an OP (e.g. `==`, `+`) or a NAME (`true`/`false`/`explicit`/`implicit`).
            const sym = this.peek();
            if (sym.type === 'OP') {
              lastName = `operator ${sym.value}`;
            } else if (sym.type === 'NAME') {
              lastName = `operator ${sym.value}`;
            } else {
              lastName = 'operator';
            }
            this.next();
            nameCount = 2; // treat as method (has return type before `operator`)
            continue;
          }
          nameCount++;
          lastName = tk.value;
          // detect indexer: `Type this[...]` — `this` followed by `[`.
          if (tk.value === 'this' && this.peek(1).type === 'OP' && this.peek(1).value === '[') {
            isIndexer = true;
          }
        }
        this.next();
        continue;
      }
      if (tk.type === 'OP') {
        if (tk.value === '<') {
          gdepth++;
        } else if (tk.value === '>') {
          gdepth = Math.max(0, gdepth - 1);
        } else if (tk.value === '>>') {
          gdepth = Math.max(0, gdepth - 2);
        } else if (tk.value === '>>>') {
          gdepth = Math.max(0, gdepth - 3);
        } else if (tk.value === '(') {
          pdepth++;
        } else if (tk.value === ')') {
          pdepth = Math.max(0, pdepth - 1);
        } else if (tk.value === '[') {
          bdepth++;
        } else if (tk.value === ']') {
          bdepth = Math.max(0, bdepth - 1);
        }
      }
      this.next();
    }

    if (!sawParen) {
      // no `(` — property (if `{`/`=>`) or field (if `;`/`=`/`,`).
      if (this.isOp('{')) {
        if (!lastName || nameCount < 1) {
          this.skipBraces(); // init block
          return null;
        }
        // property — one symbol; skip the accessor body.
        this.excluded.add(this.i); // the `{` itself isn't a call, but mark to be safe
        const endLine = this.skipBraces();
        return {
          kind: isIndexer ? 'indexer' : 'property',
          name: lastName ?? '<anon>',
          startLine,
          endLine: Math.max(endLine, startLine),
          modifiers,
          attributes,
          bases: [],
          implements: [],
          params: [],
          body: [],
        };
      }
      if (this.isOp('=>')) {
        if (!lastName || nameCount < 1) {
          this.skipArrowBody();
          return null;
        }
        // expression-bodied property: `Type Name => expr;`
        this.next(); // =>
        const endLine = this.skipArrowBody();
        return {
          kind: 'property',
          name: lastName,
          startLine,
          endLine: Math.max(endLine, startLine),
          modifiers,
          attributes,
          bases: [],
          implements: [],
          params: [],
          body: [],
        };
      }
      // field
      this.consumeField();
      return null;
    }

    // sawParen === true → method / constructor / indexer / operator.
    if (!lastName || HARD_KEYWORDS.has(lastName)) return null;
    const kind: CsharpKind = isOperator
      ? 'operator'
      : isIndexer
        ? 'indexer'
        : nameCount >= 2
          ? 'method'
          : 'constructor';
    this.excluded.add(this.i);
    const params = this.parseParamList();
    // constructor initializer `: base(...)` / `: this(...)` — skip to `{` or `;`.
    if (this.isOp(':')) {
      // skip the initializer up to `{`/`;` tracking paren depth.
      let pd = 0;
      this.next(); // ':'
      while (!this.atEnd()) {
        if (pd === 0 && (this.isOp('{') || this.isOp(';'))) break;
        if (this.isOp('(')) pd++;
        else if (this.isOp(')')) pd = Math.max(0, pd - 1);
        this.next();
      }
    }
    let endLine = this.peek().line;
    let stmts: CsharpStmt[] = [];
    if (this.isOp('{')) {
      // method/constructor/operator body — capture the statement tree (Track 3) instead of just
      // skipping the braces. Tolerant: a malformed body degrades to whatever statements were parsed.
      const res = this.parseBody();
      stmts = res.stmts;
      endLine = res.endLine;
    } else if (this.isOp('=>')) {
      endLine = this.skipArrowBody();
      // expression-bodied member — no statement tree (the call sites are still captured by the
      // whole-stream collector, so intra-file calls edges are unaffected). Documented lossy.
    } else if (this.isOp(';')) {
      this.next();
    }
    return {
      kind,
      name: lastName,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers,
      attributes,
      bases: [],
      implements: [],
      params,
      body: [],
      stmts,
    };
  }

  /** Consume a field initializer up to the terminating `;` at depth 0 (handles lambdas/array inits). */
  private consumeField(): void {
    let pdepth = 0;
    let bdepth = 0;
    let brace = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && bdepth === 0 && brace === 0 && this.isOp(';')) {
        this.next();
        return;
      }
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
        else if (tk.value === '{') brace++;
        else if (tk.value === '}') {
          if (brace > 0) brace--;
          else break; // end of enclosing block — malformed field; let caller handle
        }
      }
      this.next();
    }
  }

  /** From a `=>` skip the expression body to its terminating `;`. Returns the `;` line. */
  private skipArrowBody(): number {
    if (!this.isOp('=>')) return this.peek().line;
    this.next();
    let pdepth = 0;
    let bdepth = 0;
    let brace = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && bdepth === 0 && brace === 0 && this.isOp(';')) {
        const line = tk.line;
        this.next();
        return line;
      }
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
        else if (tk.value === '{') brace++;
        else if (tk.value === '}') {
          if (brace > 0) brace--;
          else break;
        }
      }
      this.next();
    }
    return this.peek().line;
  }

  /**
   * Parse a parameter list from the current `(` up to its matching `)`. Captures the LAST name of
   * each parameter as its name (skips types, attributes, generics, array dims, ref/out/in/params).
   */
  private parseParamList(): string[] {
    if (!this.isOp('(')) return [];
    this.next(); // (
    const params: string[] = [];
    let pdepth = 1;
    let lastName: string | undefined;
    while (!this.atEnd() && pdepth > 0) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') {
        pdepth++;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ')') {
        pdepth--;
        this.next();
        if (pdepth === 0 && lastName) params.push(lastName);
        continue;
      }
      if (pdepth === 1 && tk.type === 'OP' && tk.value === ',') {
        if (lastName) params.push(lastName);
        lastName = undefined;
        this.next();
        continue;
      }
      // skip attribute brackets inside params ([FromQuery] int x).
      if (pdepth === 1 && tk.type === 'OP' && tk.value === '[') {
        let bd = 1;
        this.next();
        while (!this.atEnd() && bd > 0) {
          if (this.isOp('[')) bd++;
          else if (this.isOp(']')) bd--;
          this.next();
        }
        continue;
      }
      if (pdepth === 1 && tk.type === 'NAME' && !PARAM_SKIP.has(tk.value)) {
        // a bare name at param-depth 1 — the last one before `,`/`)` is the param name.
        lastName = tk.value;
        this.next();
        continue;
      }
      this.next();
    }
    return params;
  }

  /** Parse a dotted namespace/type name `A.B.C`. Returns the full dotted string or undefined. */
  private parseDottedName(): string | undefined {
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return undefined;
    const parts: string[] = [this.peek().value];
    this.next();
    while (this.isOp('.') && this.peek(1).type === 'NAME') {
      this.next(); // .
      parts.push(this.peek().value);
      this.next();
    }
    return parts.join('.');
  }

  /** Parse a dotted type name (bases/implements) — allows generic args, returns the dotted name. */
  private parseDottedTypeName(): string | undefined {
    if (!this.isNameToken()) return undefined;
    const parts: string[] = [this.peek().value];
    this.next();
    while (this.isOp('.') && this.peek(1).type === 'NAME') {
      this.next(); // .
      parts.push(this.peek().value);
      this.next();
    }
    return parts.join('.');
  }

  /** Skip a generic argument list `<...>` balanced on `<`/`>` (treating `>>` as 2 closers). */
  private skipGenericAngle(): void {
    if (!this.isOp('<')) return;
    let depth = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP') {
        if (tk.value === '<') depth++;
        else if (tk.value === '>') {
          depth--;
          this.next();
          if (depth <= 0) return;
          continue;
        } else if (tk.value === '>>') {
          depth -= 2;
          this.next();
          if (depth <= 0) return;
          continue;
        } else if (tk.value === '>>>') {
          depth -= 3;
          this.next();
          if (depth <= 0) return;
          continue;
        } else if (tk.value === ';' || tk.value === '{') return; // malformed; bail
      }
      this.next();
    }
  }

  /** Skip the enum-constant list `A, B(attrs); C;` up to the terminating `;` (or before `}`). */
  private skipEnumConstants(): void {
    while (!this.atEnd()) {
      if (this.isOp('[')) {
        this.skipAttributeBracket();
        continue;
      }
      if (this.isOp(';')) {
        this.next();
        return;
      }
      if (this.isOp('}')) return; // constants only — leave `}` for parseDecls
      if (this.isOp('(')) {
        this.skipBalancedParens();
        continue;
      }
      if (this.isOp('{')) {
        this.skipBraces();
        continue;
      }
      if (this.isOp('=')) {
        // enum constant initializer `A = 1` — skip to `,`/`;`
        while (!this.atEnd() && !this.isOp(',') && !this.isOp(';') && !this.isOp('}')) this.next();
        continue;
      }
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      this.next(); // constant name or stray token
    }
  }

  // --- attributes ---------------------------------------------------------------

  /** Consume one or more `[Attr]` / `[Attr(args)]` attribute sections, capturing simple names. */
  private consumeAttribute(out: string[]): void {
    while (this.isOp('[')) {
      this.next(); // [
      // optional target prefix `assembly:` / `module:` / `field:` etc.
      if (this.peek().type === 'NAME' && this.peek(1).type === 'OP' && this.peek(1).value === ':') {
        this.next(); // target
        this.next(); // :
      }
      // comma-separated attribute names, each with optional `(args)`.
      while (!this.atEnd() && !this.isOp(']')) {
        if (this.isOp(',')) {
          this.next();
          continue;
        }
        let name: string | undefined;
        if (this.isNameToken()) {
          name = this.peek().value;
          this.next();
          while (this.isOp('.') && this.peek(1).type === 'NAME') {
            this.next(); // .
            name = this.peek().value;
            this.next();
          }
        }
        if (name) out.push(name);
        if (this.isOp('(')) {
          this.excluded.add(this.i);
          this.skipBalancedParens();
        }
      }
      if (this.isOp(']')) this.next();
    }
  }

  private skipAttributeBracket(): void {
    if (!this.isOp('[')) return;
    let depth = 0;
    while (!this.atEnd()) {
      if (this.isOp('[')) depth++;
      else if (this.isOp(']')) {
        depth--;
        this.next();
        if (depth === 0) return;
        continue;
      }
      this.next();
    }
  }

  // --- balanced skip helpers -----------------------------------------------------

  /** From a `(` skip to its matching `)`. */
  private skipBalancedParens(): void {
    if (!this.isOp('(')) return;
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

  /** From a `{` skip to its matching `}`; returns the close-`}` line. */
  private skipBraces(): number {
    if (!this.isOp('{')) return this.peek().line;
    let depth = 0;
    let closeLine = this.peek().line;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '{') depth++;
      else if (tk.type === 'OP' && tk.value === '}') {
        closeLine = tk.line;
        depth--;
        this.next();
        if (depth === 0) return closeLine;
        continue;
      }
      this.next();
    }
    return closeLine;
  }

  // --- statement tree (method body) — Track 3 CFG extraction --------------------
  // Tolerant + lossy (matches the declaration parser's posture): a malformed compound statement
  // degrades to skipping its body; predicate/expr text is a best-effort source slice. Never throws
  // — the enclosing `parseCsharp` try/catch is the final safety net, but we aim to never need it.

  /** From a `{` (method body), parse a statement list through the matching `}`. */
  private parseBody(): { stmts: CsharpStmt[]; endLine: number } {
    if (!this.isOp('{')) return { stmts: [], endLine: this.peek().line };
    const openLine = this.peek().line;
    this.next(); // {
    const stmts = this.parseStmtList();
    let endLine = this.peek().line;
    if (this.isOp('}')) {
      endLine = this.peek().line;
      this.next();
    }
    return { stmts, endLine: Math.max(endLine, openLine) };
  }

  /** Parse statements until a depth-0 `}` or EOF (one lexical block). */
  private parseStmtList(): CsharpStmt[] {
    const out: CsharpStmt[] = [];
    while (!this.atEnd() && !this.isOp('}')) {
      const before = this.i;
      const s = this.parseStmt();
      if (s) out.push(s);
      else if (this.i === before && !this.atEnd()) this.next(); // progress guard
    }
    return out;
  }

  /**
   * Parse one statement: a compound (if/for/foreach/while/do/switch/try) or a leaf action
   * (return/throw/call/assign). Returns null for tokens that aren't statement starts (stray OPs,
   * flow-control like break/continue/goto that carry no action, or unrecognised constructs).
   */
  private parseStmt(): CsharpStmt | null {
    const tk = this.peek();
    if (tk.type !== 'NAME') {
      this.next(); // stray operator / punctuation
      return null;
    }
    const startLine = tk.line;
    switch (tk.value) {
      case 'if':
        return this.parseIf(startLine);
      case 'for':
        return this.parseFor('for', startLine);
      case 'foreach':
        return this.parseFor('foreach', startLine);
      case 'while':
        return this.parseWhile(startLine);
      case 'do':
        return this.parseDo(startLine);
      case 'switch':
        return this.parseSwitch(startLine);
      case 'try':
        return this.parseTry(startLine);
      case 'return':
        return this.parseLeafReturn('return', startLine);
      case 'throw':
        return this.parseLeafReturn('throw', startLine);
      // break/continue/goto are flow control, not action lines — skip them (no statement node).
      default:
        return this.parseLeafExpr(startLine);
    }
  }

  /**
   * Parse a statement body — either a braced block `{ ... }` or a single (unbraced) statement, e.g.
   * `if (x) DoIt();`. Returns a (possibly empty) statement list. C# allows single-statement bodies
   * for if/for/while/etc.; we capture them as a one-element list.
   */
  private parseStmtBody(): CsharpStmt[] {
    if (this.isOp('{')) {
      this.next(); // {
      const list = this.parseStmtList();
      if (this.isOp('}')) this.next();
      return list;
    }
    const s = this.parseStmt();
    return s ? [s] : [];
  }

  /** `if (pred) { ... } else if (pred2) { ... } else { ... }` — folds `else if` into ELSIF branches. */
  private parseIf(startLine: number): CsharpStmt {
    this.next(); // 'if'
    const predicate = this.readParenText();
    const thenBody = this.parseStmtBody();
    const branches: CsharpIfBranch[] = [{ label: 'THEN', predicate, body: thenBody }];
    while (this.isName('else')) {
      this.next(); // 'else'
      if (this.isName('if')) {
        // `else if` → an ELSIF branch of the same IF.
        this.next(); // 'if'
        const elifPred = this.readParenText();
        const elifBody = this.parseStmtBody();
        branches.push({ label: 'ELSIF', predicate: elifPred, body: elifBody });
      } else {
        const elseBody = this.parseStmtBody();
        branches.push({ label: 'ELSE', body: elseBody });
      }
    }
    return { kind: 'if', startLine, endLine: this.prevLine(), ifLine: startLine, branches };
  }

  /** `for (...) { ... }` / `foreach (...) { ... }`. The predicate is the `(...)` contents. */
  private parseFor(loopKind: 'for' | 'foreach', startLine: number): CsharpStmt {
    this.next(); // 'for'/'foreach'
    const predicate = this.readParenText();
    const body = this.parseStmtBody();
    return { kind: 'loop', loopKind, startLine, endLine: this.prevLine(), predicate, body };
  }

  /** `while (cond) { ... }`. */
  private parseWhile(startLine: number): CsharpStmt {
    this.next(); // 'while'
    const predicate = this.readParenText();
    const body = this.parseStmtBody();
    return {
      kind: 'loop',
      loopKind: 'while',
      startLine,
      endLine: this.prevLine(),
      predicate,
      body,
    };
  }

  /** `do { ... } while (cond);`. */
  private parseDo(startLine: number): CsharpStmt {
    this.next(); // 'do'
    const body = this.parseStmtBody();
    let predicate: string | undefined;
    if (this.isName('while')) {
      this.next(); // 'while'
      predicate = this.readParenText();
      if (this.isOp(';')) this.next();
    }
    return { kind: 'loop', loopKind: 'do', startLine, endLine: this.prevLine(), predicate, body };
  }

  /** `switch (expr) { case X: ...; default: ...; }` — one case predicate per `case`. */
  private parseSwitch(startLine: number): CsharpStmt {
    this.next(); // 'switch'
    this.readParenText(); // the switch expression (not modelled as a condition)
    const cases: CsharpSwitchCase[] = [];
    if (this.isOp('{')) {
      this.next(); // {
      while (!this.atEnd() && !this.isOp('}')) {
        if (this.isName('case')) {
          const caseLine = this.peek().line;
          this.next(); // 'case'
          const predStart = this.peek();
          const predOff = this.offset(predStart);
          let predEnd = predOff;
          while (!this.atEnd() && !this.isOp(':') && !this.isOp('{') && !this.isOp(';')) {
            predEnd = this.offsetAfter(this.peek());
            this.next();
          }
          const predicate = this.src.slice(predOff, predEnd).trim();
          if (this.isOp(':')) this.next();
          const body = this.parseStmtListUntilCase();
          cases.push({ predicate, condLine: caseLine, body });
        } else if (this.isName('default')) {
          const caseLine = this.peek().line;
          this.next(); // 'default'
          if (this.isOp(':')) this.next();
          const body = this.parseStmtListUntilCase();
          cases.push({ condLine: caseLine, body });
        } else {
          this.next(); // tolerate stray tokens
        }
      }
      if (this.isOp('}')) this.next();
    }
    return { kind: 'switch', startLine, endLine: this.prevLine(), cases };
  }

  /** Parse a switch case body until the next `case`/`default`/`}` (break/continue handled as leaf). */
  private parseStmtListUntilCase(): CsharpStmt[] {
    const out: CsharpStmt[] = [];
    while (!this.atEnd() && !this.isOp('}')) {
      if (this.isName('case') || this.isName('default')) break;
      const before = this.i;
      const s = this.parseStmt();
      if (s) out.push(s);
      else if (this.i === before && !this.atEnd()) this.next();
    }
    return out;
  }

  /** `try { ... } catch (...) { ... } finally { ... }` — try body + handlers all run inException. */
  private parseTry(startLine: number): CsharpStmt {
    this.next(); // 'try'
    const tryBody = this.parseStmtBody();
    const handlers: CsharpCatchHandler[] = [];
    while (this.isName('catch')) {
      const catchLine = this.peek().line;
      this.next(); // 'catch'
      let predicate: string | undefined;
      if (this.isOp('(')) predicate = this.readParenText();
      // 1.2: exception filter `catch (T e) when (cond)` — capture the filter paren text.
      let filter: string | undefined;
      if (this.isName('when')) {
        this.next(); // 'when'
        if (this.isOp('(')) filter = this.readParenText();
      }
      const body = this.parseStmtBody();
      handlers.push({ predicate, filter, body, line: catchLine });
    }
    if (this.isName('finally')) {
      const finLine = this.peek().line;
      this.next(); // 'finally'
      const body = this.parseStmtBody();
      handlers.push({ predicate: undefined, body, line: finLine, finally: true });
    }
    return { kind: 'try', startLine, endLine: this.prevLine(), tryBody, handlers };
  }

  /** `return expr;` / `throw expr;` — always an action line. Records nested call sites too. */
  private parseLeafReturn(kind: 'return' | 'throw', startLine: number): CsharpStmt {
    const startTok = this.peek(); // 'return'/'throw'
    const startOff = this.offset(startTok);
    this.next(); // consume keyword
    const scanStart = this.i; // token index after the keyword (for call-site detection)
    let endOff = startOff;
    let pdepth = 0;
    let bdepth = 0;
    let brace = 0;
    let lastLine = startLine;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && bdepth === 0 && brace === 0 && this.isOp(';')) {
        this.next();
        break;
      }
      if (pdepth === 0 && bdepth === 0 && brace === 0 && this.isOp('}')) break; // malformed
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
        else if (tk.value === '{') brace++;
        else if (tk.value === '}') {
          if (brace > 0) brace--;
          else break;
        }
      }
      endOff = this.offsetAfter(tk);
      lastLine = tk.line;
      this.next();
    }
    const expr = this.src.slice(startOff, endOff).trim();
    // call sites in the RHS (after the keyword) — for intra-file `calls` edge annotation.
    const callSite = this.firstCallSiteFrom(scanStart);
    // 1.2: switch-expression arms in the returned expression (`return e switch { … };`).
    const switchArms = this.extractSwitchArms(scanStart, this.i);
    return {
      kind,
      startLine,
      endLine: lastLine,
      expr,
      head: kind,
      ...(callSite ? { callSite } : {}),
      ...(switchArms ? { switchArms } : {}),
    };
  }

  /**
   * A general expression statement ending in `;` (or a stray `}`). 1.2: a top-level assignment
   * operator (`=`, `+=`, …) classifies the leaf as an `assign` statement (assignTarget = last
   * identifier of the LHS) so the extractor can emit an `assignment` node; a leaf with a call but
   * no assignment stays a `call`. A leaf with neither (e.g. a bare `x;`) is skipped — not an action
   * line. Switch-expression arms (`e switch { P => v, … }`) embedded in the RHS are lifted to
   * `switchArms` so the extractor can emit `case-branch` nodes for each arm. Best-effort + tolerant.
   */
  private parseLeafExpr(startLine: number): CsharpStmt | null {
    const startTok = this.peek();
    if (startTok.type === 'EOF') return null;
    const startIdx = this.i;
    const startOff = this.offset(startTok);
    let pdepth = 0;
    let bdepth = 0;
    let brace = 0;
    let endOff = startOff;
    let lastLine = startLine;
    let assignOpOff = -1; // char offset of the first top-level assignment operator
    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && bdepth === 0 && brace === 0 && this.isOp(';')) {
        this.next();
        break;
      }
      if (pdepth === 0 && bdepth === 0 && brace === 0 && this.isOp('}')) break;
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
        else if (tk.value === '{') brace++;
        else if (tk.value === '}') {
          if (brace > 0) brace--;
          else break;
        } else if (pdepth === 0 && bdepth === 0 && brace === 0 && ASSIGN_OPS.has(tk.value)) {
          if (assignOpOff < 0) assignOpOff = this.offset(tk);
        }
      }
      endOff = this.offsetAfter(tk);
      lastLine = tk.line;
      this.next();
    }
    const expr = this.src.slice(startOff, endOff).trim();
    const switchArms = this.extractSwitchArms(startIdx, this.i);
    if (assignOpOff >= 0) {
      const lhs = this.src.slice(startOff, assignOpOff).trim();
      const callSite = this.firstCallSiteFrom(startIdx);
      return {
        kind: 'assign',
        startLine,
        endLine: lastLine,
        expr,
        head: 'assign',
        assignTarget: lastIdentifier(lhs),
        ...(callSite ? { callSite } : {}),
        ...(switchArms ? { switchArms } : {}),
      };
    }
    const callSite = this.firstCallSiteFrom(startIdx);
    if (!callSite && !switchArms) return null; // no call, no switch expr → not an action line → skip
    if (!callSite) {
      return { kind: 'plain', startLine, endLine: lastLine, expr, head: 'plain', switchArms };
    }
    return {
      kind: 'call',
      startLine,
      endLine: lastLine,
      expr,
      head: callSite.name,
      callSite,
      ...(switchArms ? { switchArms } : {}),
    };
  }

  /**
   * Find the FIRST call in the token range [from, current) — reusing the whole-stream
   * {@link collectCallSites} on the sub-range (no `excluded` set: a body statement has no
   * declarations or attribute arg-lists). Used to (a) classify a leaf as a call and (b) drive
   * intra-file `calls` edge annotation. Returns undefined when the range has no call.
   */
  private firstCallSiteFrom(from: number): CsharpCallSite | undefined {
    const slice = this.t.slice(from, this.i);
    if (slice.length === 0) return undefined;
    const calls = collectCallSites(slice, new Set<number>());
    return calls[0];
  }

  /**
   * 1.2: detect a switch expression `<scrutinee> switch { arms }` in the token range [from, to) of
   * a leaf statement and lift its arms into {@link CsharpSwitchCase}s (predicate = pattern text,
   * condLine = the pattern's first token line, empty body). Non-mutating — reads `this.t`/`this.src`
   * without advancing the cursor. Returns undefined when no `switch {` is present. Best-effort:
   * wrapped in try/catch so a malformed arm scan can never zero the file (parseCsharp's safety net).
   */
  private extractSwitchArms(from: number, to: number): CsharpSwitchCase[] | undefined {
    let k = from;
    while (k < to) {
      const tk = this.t[k]!;
      if (
        tk.type === 'NAME' &&
        tk.value === 'switch' &&
        this.t[k + 1]?.type === 'OP' &&
        this.t[k + 1]?.value === '{'
      ) {
        try {
          return this.parseSwitchExprArms(k + 1);
        } catch {
          return undefined;
        }
      }
      k++;
    }
    return undefined;
  }

  /**
   * Parse switch-expression arms from the `{` at token index `braceIdx` up to its matching `}`,
   * WITHOUT moving the cursor. Each arm is `<pattern> => <value>`; the pattern text is the source
   * slice from the arm's first token to the `=>`. Commas at brace-depth 1 separate arms; `(` / `[`
   * are balanced so a comma inside a pattern's parenthesized sub-pattern or a value's call doesn't
   * split arms. Tolerant: a malformed arm scan bails with whatever arms were collected.
   */
  private parseSwitchExprArms(braceIdx: number): CsharpSwitchCase[] {
    const cases: CsharpSwitchCase[] = [];
    const n = this.t.length;
    let j = braceIdx + 1; // past the '{'
    let depth = 1;
    let armStart = j; // token index of the current arm's first token
    while (j < n && depth > 0) {
      const tk = this.t[j]!;
      if (tk.type === 'OP' && tk.value === '{') depth++;
      else if (tk.type === 'OP' && tk.value === '}') {
        depth--;
        if (depth === 0) break;
      } else if (tk.type === 'OP' && (tk.value === '(' || tk.value === '[')) {
        j = this.skipBalancedInSlice(j); // skip balanced (…) / […]
        continue;
      } else if (depth === 1 && tk.type === 'OP' && tk.value === '=>') {
        const patStart = this.t[armStart]!;
        const predicate = this.src.slice(this.offset(patStart), this.offset(tk)).trim();
        cases.push({ predicate, condLine: patStart.line, body: [] });
        j++;
        j = this.skipArmValue(j); // skip the value expression to top-level ',' or closing '}'
        armStart = j;
        continue;
      }
      j++;
    }
    return cases;
  }

  /** Skip a balanced `(...)` / `[...]` sub-range in `this.t` starting at the open token; returns the
   *  index just past the matching close. Used by {@link parseSwitchExprArms} so commas inside a
   *  pattern's parens or a value's call don't split arms. */
  private skipBalancedInSlice(openIdx: number): number {
    const open = this.t[openIdx]?.value;
    const close = open === '(' ? ')' : open === '[' ? ']' : '';
    let j = openIdx + 1;
    let d = 1;
    const n = this.t.length;
    while (j < n && d > 0) {
      const tk = this.t[j]!;
      if (tk.type === 'OP' && tk.value === open) d++;
      else if (tk.type === 'OP' && tk.value === close) d--;
      j++;
    }
    return j;
  }

  /** Skip an arm's value expression from `j` up to the top-level `,` (arm separator) or `}` (close). */
  private skipArmValue(j: number): number {
    const n = this.t.length;
    let pos = j; // local cursor — never reassign the parameter
    let depth = 1; // we are inside the switch-expression's `{ … }`
    while (pos < n && depth > 0) {
      const tk = this.t[pos]!;
      if (tk.type === 'OP') {
        if (tk.value === '{') depth++;
        else if (tk.value === '}') {
          depth--;
          if (depth === 0) return pos; // closing '}' — leave for the outer loop to break
        } else if (tk.value === '(' || tk.value === '[') {
          pos = this.skipBalancedInSlice(pos);
          continue;
        } else if (tk.value === ',') {
          return pos + 1; // past the comma → next arm start
        }
      }
      pos++;
    }
    return pos;
  }

  /**
   * From a `(`, capture the source text of the balanced `(...)` and advance past the matching `)`.
   * Returns the INNER text (without the enclosing parens), trimmed — best-effort predicate text.
   */
  private readParenText(): string | undefined {
    if (!this.isOp('(')) return undefined;
    const startTok = this.peek();
    const startOff = this.offset(startTok);
    let depth = 0;
    let endOff = startOff;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') {
        depth++;
        endOff = this.offsetAfter(tk);
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ')') {
        depth--;
        endOff = this.offsetAfter(tk);
        this.next();
        if (depth === 0) break;
        continue;
      }
      this.next();
    }
    // strip the outermost `(` ... `)` — startOff+1 to endOff-1.
    return this.src.slice(startOff + 1, endOff - 1).trim();
  }

  /** 1-based line of the token just before the cursor (the last consumed token). */
  private prevLine(): number {
    const tk = this.t[this.i - 1];
    return tk ? tk.line : this.peek().line;
  }

  /** char offset of a token's first character, from its 1-based line/col. */
  private offset(tk: Token): number {
    return (this.lineStarts[tk.line - 1] ?? 0) + (tk.col - 1);
  }

  /** char offset just past a token's last character. */
  private offsetAfter(tk: Token): number {
    return this.offset(tk) + tk.value.length;
  }

  // --- token helpers -------------------------------------------------------------

  private isOp(v: string): boolean {
    return this.peek().type === 'OP' && this.peek().value === v;
  }
  private isName(v: string): boolean {
    return this.peek().type === 'NAME' && this.peek().value === v;
  }
  private isNameAnyOf(vs: string[]): boolean {
    const v = this.peek().value;
    return this.peek().type === 'NAME' && vs.includes(v);
  }
  private isNameToken(): boolean {
    return this.peek().type === 'NAME';
  }
  private next(): Token {
    const tk = this.t[this.i] ?? { type: 'EOF', value: '', line: 0, col: 0 };
    if (this.i < this.t.length) this.i++;
    return tk;
  }
  private peek(offset = 0): Token {
    return this.t[this.i + offset] ?? { type: 'EOF', value: '', line: 0, col: 0 };
  }
  private atEnd(): boolean {
    return this.i >= this.t.length || this.peek().type === 'EOF';
  }
}

const MODIFIER_NAMES = [
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
];

/** Param-list modifiers that are NOT the param name (ref/out/in/params/this). */
const PARAM_SKIP = new Set<string>(['ref', 'out', 'in', 'params', 'this', '__arglist']);

/**
 * Hard-reserved keywords that can NEVER be a declaration name (primitives + control flow + literals).
 * Contextual keywords (`record`, `var`, `yield`, `partial`, `async`, `where`, `get`, `set`, `init`,
 * `value`) ARE valid identifiers and are excluded so a class/property named e.g. `value` parses.
 */
const HARD_KEYWORDS = new Set<string>([
  'void',
  'int',
  'long',
  'short',
  'byte',
  'float',
  'double',
  'decimal',
  'bool',
  'char',
  'string',
  'object',
  'uint',
  'ulong',
  'ushort',
  'sbyte',
  'class',
  'interface',
  'struct',
  'enum',
  'namespace',
  'delegate',
  'record',
  'return',
  'if',
  'else',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'this',
  'base',
  'try',
  'catch',
  'finally',
  'throw',
  'using',
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
  'unsafe',
  'volatile',
  'synchronized',
  'const',
  'is',
  'as',
  'typeof',
  'sizeof',
  'default',
  'true',
  'false',
  'null',
  'in',
  'out',
  'ref',
  'params',
  'operator',
  'explicit',
  'implicit',
  'checked',
  'unchecked',
  'fixed',
  'lock',
  'goto',
  'event',
  'stackalloc',
]);

/**
 * Scan the token stream for `interface NAME` / `class NAME` / `struct NAME` / `record [class|struct]
 * NAME` to build a same-file type-kind map, used by the `:` disambiguator. Tolerant: a `class` that
 * appears as a generic constraint (`where T : class`) is followed by `,`/`{`, not a NAME, so it is
 * naturally skipped.
 */
function collectTypeKinds(tokens: Token[]): { interfaces: Set<string>; classLikes: Set<string> } {
  const interfaces = new Set<string>();
  const classLikes = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME') continue;
    if (
      tk.value === 'interface' ||
      tk.value === 'class' ||
      tk.value === 'struct' ||
      tk.value === 'record'
    ) {
      const next = tokens[i + 1];
      if (!next || next.type !== 'NAME' || HARD_KEYWORDS.has(next.value)) continue;
      // `record struct Name` / `record class Name` — the name is two tokens ahead.
      if (tk.value === 'record' && (next.value === 'struct' || next.value === 'class')) {
        const nn = tokens[i + 2];
        if (nn && nn.type === 'NAME' && !HARD_KEYWORDS.has(nn.value)) classLikes.add(nn.value);
        continue;
      }
      if (tk.value === 'interface') interfaces.add(next.value);
      else classLikes.add(next.value);
    }
  }
  return { interfaces, classLikes };
}

/**
 * Scan the token stream for call expressions `NAME (.NAME)* (` whose `(` is NOT a definition or
 * attribute arg-list (excluded set). `new Foo()` falls out naturally: `new` (no `(` after it) is
 * skipped, then `Foo` + `(` records a constructor call.
 */
export function collectCallSites(tokens: Token[], excluded: Set<number>): CsharpCallSite[] {
  const calls: CsharpCallSite[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME') {
      i++;
      continue;
    }
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
      if (!excluded.has(j)) {
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

/** Scan the token stream for `using` statements and the file's outermost namespace. */
export function collectImports(tokens: Token[]): { pkg: string; imports: CsharpImport[] } {
  const imports: CsharpImport[] = [];
  let pkg = '';
  let i = 0;
  const isNameVal = (k: number, v: string) => tokens[k]?.type === 'NAME' && tokens[k]?.value === v;
  const isOp = (k: number, v: string) => tokens[k]?.type === 'OP' && tokens[k]?.value === v;
  const atLineEnd = (k: number) => !tokens[k] || isOp(k, ';');
  const consumeDotted = (k: number): { parts: string[]; j: number } => {
    const parts: string[] = [];
    let j = k;
    while (j < tokens.length && tokens[j]!.type === 'NAME') {
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
    if (tk.value === 'namespace' && !pkg) {
      // capture the outermost namespace name (block or file-scoped) for the resolver's pkgPrefix.
      const { parts, j } = consumeDotted(i + 1);
      if (parts.length) pkg = parts.join('.');
      i = j;
      continue;
    }
    if (tk.value === 'using') {
      const line = tk.line;
      let j = i + 1;
      let global = false;
      // `global using` (and `global using X = Y`)
      if (isNameVal(i + 1, 'global') && tokens[i + 2]?.type === 'NAME') {
        // `global` here is the `global using` keyword, not the global namespace alias `global::`.
        // Only treat as global-using when followed by another NAME (the import).
        global = true;
        j++;
      }
      // `using static A.B.C;`
      const isStatic = isNameVal(j, 'static');
      if (isStatic) j++;
      const { parts, j: j2 } = consumeDotted(j);
      j = j2;
      // `using A = B.C.D;` alias — `parts` is the alias name (single segment), then `=`, then target.
      if (isOp(j, '=')) {
        const alias = parts[parts.length - 1] ?? '';
        j++; // =
        const { parts: tparts, j: j3 } = consumeDotted(j);
        j = j3;
        const target = tparts.join('.');
        imports.push({
          module: '',
          name: alias,
          static: isStatic,
          alias: true,
          target,
          global,
          line,
        });
        i = atLineEnd(j) ? j + 1 : j;
        continue;
      }
      const last = parts[parts.length - 1] ?? '';
      const module = parts.length > 1 ? parts.slice(0, -1).join('.') : '';
      imports.push({
        module,
        name: last,
        static: isStatic,
        alias: false,
        target: '',
        global,
        line,
      });
      i = atLineEnd(j) ? j + 1 : j;
      continue;
    }
    i++;
  }
  return { pkg, imports };
}

function lastSegment(dotted: string): string {
  const i = dotted.lastIndexOf('.');
  return i === -1 ? dotted : dotted.slice(i + 1);
}

/**
 * C# assignment operators (compound + simple). Used by {@link parseLeafExpr} to classify a leaf as
 * an `assign` statement. `=>` (lambda/expression-body) and the comparison ops (`==`, `!=`, `>=`,
 * `<=`) are deliberately excluded — they are not assignments.
 */
const ASSIGN_OPS = new Set<string>([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
  '??=',
  '||=',
  '&&=',
]);

/**
 * Best-effort LHS target for an `assignment` node: the last identifier of the LHS text. For
 * `Token t = …` → `t`; for `x = …` → `x`; for `a.b = …` → `b`; for `a[i] = …` → `a` (the indexed
 * target). Falls back to the trimmed LHS when no identifier is found. Conservative + lossy.
 */
function lastIdentifier(lhs: string): string {
  const m = /([A-Za-z_]\w*)\s*$/.exec(lhs);
  if (m) return m[1] ?? lhs;
  // indexed target `a[i] = …` → return the indexer root `a`
  const idx = /([A-Za-z_]\w*)\s*\[/.exec(lhs);
  return idx ? (idx[1] ?? lhs) : lhs;
}

/**
 * Precompute the char offset of the start of each 1-based line (`lineStarts[n-1]` = offset of line
 * n+1... actually line n — `lineStarts[0]` = 0 for line 1). Used by the statement parser to slice
 * best-effort predicate/expression text from the source by token line/col.
 */
function computeLineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}
