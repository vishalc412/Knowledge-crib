/**
 * Rust structural parser (M8-style) — turns the token stream into a declaration tree (mod / struct /
 * enum / trait / impl / fn / method / associated_fn / typealias / macro) plus a flat list of call
 * sites + `use` imports. NOT a full expression parser: the symbol graph only needs declaration spans +
 * nesting (member-of + qualified names) and call-site heads (for `calls`), so a tolerant brace-level
 * descent is enough.
 *
 * Altitude parity with the Java extractor: types (struct / enum / trait / impl / mod) + functions
 * (free `fn`, impl methods, trait fns) + type aliases + macro names are symbols; struct fields, enum
 * variants, `const`/`static` items, and `use` statements are NOT emitted as symbols — their call
 * sites are still captured by the whole-stream {@link collectCallSites}. `macro_rules!` bodies are
 * NOT descended (skipped as a brace block) — an honest limitation. Trait default-impl fns vs
 * required fns are both extracted as `method`/`associated_fn`; the presence of a body is not used to
 * distinguish them (documented).
 *
 * Generic angle-bracket balancing uses the Rust split rule: the lexer emits `>>` as ONE token and the
 * balancer here splits it into 2 `>` closes (`>>>` lexes as `>>` then `>` and closes 3). Where-clauses
 * (`where T: Bound`) are skipped wholesale. Attributes (`#[...]` / `#![...]`) preceding an item are
 * captured as simple names (`#[derive(Debug)]` → ["derive"]) into `meta.attributes`, parity with Java
 * annotations.
 */
import { tokenize } from './lexer.js';
import type { Token } from './lexer.js';

export type RustKind =
  | 'mod'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'impl'
  | 'fn'
  | 'method'
  | 'associated_fn'
  | 'typealias'
  | 'macro';

export interface RustImplInfo {
  /** trait name when `impl Trait for Type`; absent for inherent `impl Type`. */
  trait?: string;
  /** the type being implemented (simple name; used to build method qualifiedNames `Type::method`). */
  type: string;
}

export interface RustDef {
  kind: RustKind;
  name: string;
  /** 1-based line of the first token of the declaration (leading attribute/modifier). */
  startLine: number;
  /** 1-based line of the declaration's last token (closing `}` for containers, `}`/`;` for fns). */
  endLine: number;
  modifiers: string[];
  /** attribute simple names preceding the declaration (`#[derive(Debug)]` → ["derive"]). */
  attributes: string[];
  /** supertraits for traits (`trait T: A + B` → ["A", "B"]); [] for all other kinds (no inheritance). */
  bases: string[];
  /** impl context ({trait?, type}); undefined for non-impl kinds. */
  impl?: RustImplInfo;
  /** generic type-param names (`<T, U: Clone>` → ["T", "U"]). */
  typeParams: string[];
  /** fn parameter names (fns / methods / associated_fns); excludes `self`/`&self`/`&mut self`. */
  params: string[];
  /** true if the first param was `self`/`&self`/`&mut self`/`mut self` (method vs associated_fn). */
  hasSelf: boolean;
  /** nested defs (mod / trait / impl bodies); empty for leaf kinds (fn bodies are NOT descended). */
  body: RustDef[];
  /**
   * Compound-statement tree of a fn body (Track 3): if/else, for/while/loop, match, return, call,
   * throw (panic). Present ONLY on `fn` defs whose `{ ... }` body was parsed into statements;
   * undefined for non-fn kinds and required-trait fns (no body). Tolerant + lossy: a malformed
   * compound degrades to skipping its body (empty / partial stmts), never throws.
   */
  stmts?: RustStmt[];
}

// ---------------------------------------------------------------------------------------------
// Statement tree (Track 3) — a tolerant, lossy compound-statement tree for fn bodies. The
// extractor walks this with a guard stack to emit statement/condition/executes/guarded-by edges.
// Predicates are best-effort source-text slices; spans are 1-based start lines.
// ---------------------------------------------------------------------------------------------

/** An if/else-if/else chain. ONE condition node per chain (keyed by the IF line, PL/SQL convention). */
export interface RustIfStmt {
  kind: 'if';
  line: number;
  predicate: string;
  then: RustStmt[];
  elifs: { predicate: string; body: RustStmt[] }[];
  else?: RustStmt[];
}

/** `for` / `while` / `loop`. `predicate` is empty for `loop { }` (no condition). */
export interface RustLoopStmt {
  kind: 'loop';
  line: number;
  loopKind: 'for' | 'while' | 'loop';
  predicate: string;
  body: RustStmt[];
}

/** `match scrutinee { arms }` — one condition per arm predicate (branch:'CASE'). */
export interface RustMatchStmt {
  kind: 'match';
  line: number;
  predicate: string;
  arms: { line: number; pat: string; body: RustStmt[] }[];
}

/** An action statement: a call, return, or throw (panic). `callee` is the first call's chain.
 *
 * 1.2 (capability-honest Rust error model):
 *   - `throw` (panic!) carries `errorMessage` when a string literal is the first arg of `panic!(…)`.
 *   - `return` with `isErrReturn` is `return Err(…)` / `return Result::Err(…)` (Rust's closest throw
 *     analog) and carries `errorMessage` when the Err payload is an identifiable string literal.
 *   - A plain `?` propagation is NOT modeled as a raise (only explicit panic!/return Err). */
export interface RustActionStmt {
  kind: 'return' | 'call' | 'throw';
  line: number;
  text: string;
  callee?: string;
  /** panic!("msg") / return Err("msg"): the first string literal payload, if identifiable. */
  errorMessage?: string;
  /** true when `return Err(…)` / `return Result::Err(…)` — the extractor emits a `raise` node. */
  isErrReturn?: boolean;
}

/** 1.2: a `let name = …` (with initializer) or `name = …` reassignment. `target` is the LHS binding
 *  (`x` for `let x`/`let mut x`). `callee` is the first call in the RHS, if any, so the walker can
 *  still record a guarded call site for `calls`-edge annotation. Conservative: only simple `let
 *  [mut] name = …` and bare `name = …` bindings — destructuring / field reassignment are skipped. */
export interface RustAssignStmt {
  kind: 'assign';
  line: number;
  target: string;
  text: string;
  callee?: string;
}

/** A passthrough block (`unsafe { ... }` / bare `{ ... }`) — walked with the SAME guard stack. */
export interface RustBlockStmt {
  kind: 'block';
  line: number;
  body: RustStmt[];
}

export type RustStmt =
  | RustIfStmt
  | RustLoopStmt
  | RustMatchStmt
  | RustActionStmt
  | RustBlockStmt
  | RustAssignStmt;

export interface RustCallSite {
  /** callee head: the first NAME of the chain. */
  head: string;
  /** tail segments after the head. */
  segments: string[];
  /** separator before each segment (`::` for paths, `.` for method/field access). */
  seps: string[];
  /** last segment (or head if no segments) — the function/method being invoked. */
  name: string;
  /** 1-based line of the head NAME of the call. */
  line: number;
  /** `macro!()` invocation (a `!` immediately precedes the `(`). */
  macro: boolean;
}

export interface RustImport {
  /** `::`-separated module path before the bound name ("" if just a name). */
  module: string;
  /** bound local simple name ("" for glob; the alias if `as`). */
  name: string;
  /** the ORIGINAL imported name (= name unless aliased); the symbol to look up in the target file. */
  original: string;
  /** `use a::b::*;` wildcard. */
  star: boolean;
  /** alias if `use a::b::C as D;` (name = "D", alias = "D", original = "C"). */
  alias?: string;
  line: number;
}

export interface RustModule {
  defs: RustDef[];
  calls: RustCallSite[];
  imports: RustImport[];
  /** crate path — Rust has no package declaration; always "" (module paths come from `mod`/files). */
  crate: string;
}

/** Parse Rust source into a declaration tree + call sites + imports (never throws). */
export function parseRust(src: string): RustModule {
  try {
    const tokens = tokenize(src);
    const p = new Parser(tokens, src);
    const { defs } = p.parseProgram();
    const calls = collectCallSites(tokens, p.excluded);
    const imports = collectImports(tokens);
    return { defs, calls, imports, crate: '' };
  } catch {
    return { defs: [], calls: [], imports: [], crate: '' };
  }
}

const CONTAINER_KINDS = new Set<RustKind>(['mod', 'trait', 'impl']);

class Parser {
  private readonly t: Token[];
  private i = 0;
  /** token indices of definition / attribute `(` openers — call sites at these indices are NOT calls. */
  readonly excluded = new Set<number>();
  /** source text (for best-effort predicate slicing via token line/col). */
  private readonly src: string;
  /** char offset of the start of each 1-based line (index 0 = line 1 start = 0). */
  private readonly lineOff: number[];

  constructor(tokens: Token[], src: string) {
    this.t = tokens;
    this.src = src;
    // build a line-start offset index so token (line,col) → char offset is O(1)
    const off: number[] = [0];
    for (let k = 0; k < src.length; k++) if (src[k] === '\n') off.push(k + 1);
    this.lineOff = off;
  }

  parseProgram(): { defs: RustDef[] } {
    const { defs } = this.parseDecls(true);
    return { defs };
  }

  /**
   * Parse declarations at one brace level. `topLevel` ⇒ stop at EOF (a stray `}` is left for the
   * caller). Returns the nested defs plus `closeLine` — the 1-based line of the `}` that ended a
   * non-top-level block (0 at top level), used to size the enclosing item's `endLine`.
   */
  private parseDecls(topLevel: boolean): { defs: RustDef[]; closeLine: number } {
    const defs: RustDef[] = [];
    let closeLine = 0;
    while (!this.atEnd()) {
      if (this.isOp('}')) {
        closeLine = this.peek().line;
        if (!topLevel) this.next();
        break;
      }
      if (this.isOp('{')) {
        this.skipBraces(); // bare block — skip it
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

  /** Parse one declaration; returns a def or null (field / const / use / unknown → skip). */
  private parseDecl(): RustDef | null {
    const startLine = this.peek().line;
    const attributes: string[] = [];
    const modifiers: string[] = [];
    // consume leading attributes + modifiers (they may interleave)
    while (!this.atEnd()) {
      if (this.isOp('#') && this.peek1().value === '[') {
        this.consumeAttribute(attributes);
        continue;
      }
      if (this.isOp('#') && this.peek1().value === '!') {
        // `#![inner]` inner attribute — capture + skip, same handling
        this.consumeAttribute(attributes);
        continue;
      }
      if (this.isName('pub')) {
        modifiers.push(this.consumeVisibility());
        continue;
      }
      if (this.isNameAnyOf(['unsafe', 'async'])) {
        modifiers.push(this.peek().value);
        this.next();
        continue;
      }
      if (this.isName('extern')) {
        // `extern fn ...` ⇒ modifier; `extern "C" { }` / `extern crate foo;` handled below.
        if (this.peek1().type === 'NAME' && this.peek1().value === 'fn') {
          modifiers.push('extern');
          this.next();
          continue;
        }
        break; // extern block / extern crate — dispatch below
      }
      if (this.isName('const')) {
        // `const fn` ⇒ modifier; `const X: T = ...;` ⇒ const item (skip below)
        if (this.peek1().type === 'NAME' && this.peek1().value === 'fn') {
          modifiers.push('const');
          this.next();
          continue;
        }
        break; // const item — dispatch to skip
      }
      if (this.isName('static')) {
        break; // static item — dispatch to skip
      }
      break;
    }
    if (this.atEnd()) return null;

    const kw = this.peek().value;
    if (this.isName('mod')) return this.parseMod(startLine, attributes, modifiers);
    if (this.isName('struct')) return this.parseStruct(startLine, attributes, modifiers, 'struct');
    if (this.isName('enum')) return this.parseStruct(startLine, attributes, modifiers, 'enum');
    if (this.isName('union')) return this.parseStruct(startLine, attributes, modifiers, 'struct'); // treat union like struct
    if (this.isName('trait')) return this.parseTrait(startLine, attributes, modifiers);
    if (this.isName('impl')) return this.parseImpl(startLine, attributes, modifiers);
    if (this.isName('fn')) return this.parseFn(startLine, attributes, modifiers);
    if (this.isName('type')) return this.parseTypeAlias(startLine, attributes, modifiers);
    if (this.isName('use')) {
      this.skipToSemi();
      return null; // imports collected separately by collectImports
    }
    if (this.isName('macro_rules')) return this.parseMacroRules(startLine, attributes, modifiers);
    if (this.isName('const') || this.isName('static')) {
      this.skipToSemi();
      return null; // const/static item — not a symbol; call sites still captured whole-stream
    }
    if (this.isName('extern')) {
      // extern block `extern "C" { ... }` or `extern crate foo;`
      this.next(); // extern
      if (this.isOp('{')) {
        this.skipBraces(); // skip extern block contents (FFN decls — honest limitation)
        return null;
      }
      this.skipToSemi(); // extern crate ...
      return null;
    }
    // unknown member (e.g. a field in a struct body, or a stray) — skip to ; / }
    this.skipToSemiOrClose();
    return null;
  }

  /** `pub` / `pub(crate)` / `pub(super)` / `pub(in path)` → returns the visibility token string. */
  private consumeVisibility(): string {
    const tok = this.peek();
    this.next(); // pub
    if (this.isOp('(')) {
      // capture the parens content as `pub(...)`
      const start = this.i; // at '('
      this.skipBalancedParens(); // advances past ')'
      const end = this.i; // past ')'
      // slice(start+1, end-1) excludes the '(' and ')' themselves
      const inner = this.t
        .slice(start + 1, end - 1)
        .map((x) => x.value)
        .join('');
      return `pub(${inner})`;
    }
    return tok.value;
  }

  private parseMod(startLine: number, attributes: string[], modifiers: string[]): RustDef | null {
    this.next(); // mod
    if (!this.isNameToken()) return null;
    const name = this.peek().value;
    this.next();
    let body: RustDef[] = [];
    let endLine = startLine;
    if (this.isOp('{')) {
      this.next();
      const res = this.parseDecls(false);
      body = res.defs;
      endLine = res.closeLine || this.peek().line;
    } else if (this.isOp(';')) {
      this.next();
      endLine = this.peek().line; // `mod foo;` (file-module declaration)
    }
    endLine = Math.max(endLine, ...body.map((b) => b.endLine), startLine);
    return {
      kind: 'mod',
      name,
      startLine,
      endLine,
      modifiers,
      attributes,
      bases: [],
      typeParams: [],
      params: [],
      hasSelf: false,
      body,
    };
  }

  /** struct / enum / union — name + generics + where + body (fields/variants skipped, NOT recursed). */
  private parseStruct(
    startLine: number,
    attributes: string[],
    modifiers: string[],
    kind: 'struct' | 'enum',
  ): RustDef | null {
    this.next(); // kind keyword
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    const typeParams = this.skipGenericAngle();
    this.skipWhereClause();
    let endLine = startLine;
    if (this.isOp('{')) {
      endLine = this.skipBraces(); // struct/enum body — fields/variants are not symbols
    } else if (this.isOp('(')) {
      this.skipBalancedParens(); // tuple struct / tuple-variant `struct Foo(...);`
      if (this.isOp(';')) {
        this.next();
        endLine = this.peek().line;
      }
    } else if (this.isOp(';')) {
      this.next();
      endLine = this.peek().line; // unit struct `struct Foo;`
    }
    return {
      kind,
      name,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers,
      attributes,
      bases: [],
      typeParams,
      params: [],
      hasSelf: false,
      body: [],
    };
  }

  private parseTrait(startLine: number, attributes: string[], modifiers: string[]): RustDef | null {
    this.next(); // trait
    if (!this.isNameToken()) return null;
    const name = this.peek().value;
    this.next();
    const typeParams = this.skipGenericAngle();
    // supertraits: `trait T: A + B` (stop at `where` / `{` / `;`)
    const bases: string[] = [];
    if (this.isOp(':')) {
      this.next();
      bases.push(...this.parsePathSum());
    }
    this.skipWhereClause();
    let body: RustDef[] = [];
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
      kind: 'trait',
      name,
      startLine,
      endLine,
      modifiers,
      attributes,
      bases,
      typeParams,
      params: [],
      hasSelf: false,
      body,
    };
  }

  private parseImpl(startLine: number, attributes: string[], modifiers: string[]): RustDef | null {
    this.next(); // impl
    const typeParams = this.skipGenericAngle();
    // first type (the trait if `for` follows, else the inherent type)
    const first = this.readTypePath();
    if (!first) return null; // malformed `impl {` / `impl (` — no type to anchor the impl
    let trait: string | undefined;
    let type = first;
    if (this.isName('for')) {
      this.next();
      trait = first;
      type = this.readTypePath();
    }
    this.skipWhereClause();
    let body: RustDef[] = [];
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
    const implName = trait ? `impl ${trait} for ${type}` : `impl ${type}`;
    return {
      kind: 'impl',
      name: implName,
      startLine,
      endLine,
      modifiers,
      attributes,
      bases: [],
      typeParams,
      params: [],
      hasSelf: false,
      impl: trait ? { trait, type } : { type },
      body,
    };
  }

  private parseFn(startLine: number, attributes: string[], modifiers: string[]): RustDef | null {
    this.next(); // fn
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    const typeParams = this.skipGenericAngle();
    let params: string[] = [];
    let hasSelf = false;
    if (this.isOp('(')) {
      this.excluded.add(this.i);
      const res = this.parseParamList();
      params = res.params;
      hasSelf = res.hasSelf;
    }
    this.skipReturnType(); // `-> RetType`
    this.skipWhereClause();
    let endLine = this.peek().line;
    let stmts: RustStmt[] | undefined;
    if (this.isOp('{')) {
      // Track 3: descend into the fn body and parse a compound-statement tree (tolerant + lossy).
      // The body is walked by the extractor with a guard stack to emit statement/condition/executes/
      // guarded-by edges. A malformed compound degrades to skipping its body (no throw).
      this.next(); // {
      const res = this.parseStmtBlock();
      stmts = res.stmts;
      endLine = res.closeLine || this.peek().line;
    } else if (this.isOp(';')) {
      this.next(); // required trait fn (no body)
    }
    // provisional kind 'fn' for all fn items — the Extractor re-classifies to method/associated_fn
    // based on the enclosing context (free fn vs impl/trait body).
    return {
      kind: 'fn',
      name,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers,
      attributes,
      bases: [],
      typeParams,
      params,
      hasSelf,
      body: [],
      ...(stmts ? { stmts } : {}),
    };
  }

  private parseTypeAlias(
    startLine: number,
    attributes: string[],
    modifiers: string[],
  ): RustDef | null {
    this.next(); // type
    if (!this.isNameToken()) return null;
    const name = this.peek().value;
    this.next();
    this.skipGenericAngle();
    let endLine = startLine;
    // `type Name = ...;` or in traits `type Name: Bound;` / `type Name = default;`
    while (!this.atEnd() && !this.isOp(';') && !this.isOp('{')) this.next();
    if (this.isOp('{')) {
      endLine = this.skipBraces(); // `type Name<T> = where ... { ... }`? tolerate
    } else if (this.isOp(';')) {
      this.next();
      endLine = this.peek().line;
    }
    return {
      kind: 'typealias',
      name,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers,
      attributes,
      bases: [],
      typeParams: [],
      params: [],
      hasSelf: false,
      body: [],
    };
  }

  /**
   * `macro_rules! name { ... }` — capture the macro name as a `macro` symbol, then SKIP the body
   * (do NOT descend into macro rules; honest limitation).
   */
  private parseMacroRules(
    startLine: number,
    attributes: string[],
    modifiers: string[],
  ): RustDef | null {
    this.next(); // macro_rules
    if (this.isOp('!')) this.next();
    let name = '<anon>';
    if (this.isNameToken()) {
      name = this.peek().value;
      this.next();
    }
    let endLine = startLine;
    if (this.isOp('{')) {
      endLine = this.skipBraces();
    } else if (this.isOp('(')) {
      this.skipBalancedParens();
      if (this.isOp(';')) this.next();
      endLine = this.peek().line;
    }
    return {
      kind: 'macro',
      name,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers,
      attributes,
      bases: [],
      typeParams: [],
      params: [],
      hasSelf: false,
      body: [],
    };
  }

  /**
   * Parse a parameter list from the current `(`; returns non-self param names + whether a `self`
   * param was present. Rust params are `pattern: Type` (name FIRST, then `:`, then type) — the
   * FIRST NAME of each param is the param name, the opposite of Java's `Type name`. `self` /
   * `&self` / `&mut self` / `mut self` as the first param sets `hasSelf` and is excluded from names.
   */
  private parseParamList(): { params: string[]; hasSelf: boolean } {
    if (!this.isOp('(')) return { params: [], hasSelf: false };
    this.next(); // (
    const params: string[] = [];
    let pdepth = 1;
    let paramName: string | undefined;
    let hasSelf = false;
    let atStart = true; // at the start of a param (initially + after ',')
    const flush = (): void => {
      if (paramName) {
        params.push(paramName);
        paramName = undefined;
      }
    };
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
        if (pdepth === 0) flush();
        continue;
      }
      if (pdepth === 1 && tk.type === 'OP' && tk.value === ',') {
        flush();
        atStart = true;
        this.next();
        continue;
      }
      if (pdepth === 1 && tk.type === 'OP' && tk.value === '&') {
        // `&self` / `&mut self` prefix — keep the param-start window open
        this.next();
        continue;
      }
      if (pdepth === 1 && tk.type === 'LIFETIME') {
        this.next();
        continue;
      }
      if (pdepth === 1 && tk.type === 'NAME') {
        if (atStart) {
          if (tk.value === 'self' || tk.value === 'Self') {
            hasSelf = true;
            atStart = false;
          } else if (tk.value === 'mut' || tk.value === 'ref') {
            // `mut x` / `ref x` binding prefix — keep the param-start window open
          } else {
            paramName = tk.value;
            atStart = false;
          }
        }
        this.next();
        continue;
      }
      if (pdepth === 1) atStart = false; // any other token ends the param-start window
      this.next();
    }
    return { params, hasSelf };
  }

  /**
   * Parse a `+`-separated sum of type paths (trait supertraits). Each path is `NAME (:: NAME)*` with
   * optional `<...>` generics; the LAST segment is kept as the bound name. Stops at `where` / `{` /
   * `;`.
   */
  private parsePathSum(): string[] {
    const out: string[] = [];
    while (!this.atEnd()) {
      const path = this.readTypePath();
      if (path) out.push(path);
      if (this.isOp('+')) {
        this.next();
        continue;
      }
      break;
    }
    return out;
  }

  /**
   * Read a type path `NAME (:: NAME)*` with optional generic `<...>` (skipped); returns the LAST
   * segment as the simple name, or "" if the next token isn't a NAME. Tolerates `&`/`(`/`[...]` type
   * starts by returning "" (the caller then skips the rest via the header loop).
   */
  private readTypePath(): string {
    let simple = '';
    if (this.isNameToken()) {
      simple = this.peek().value;
      this.next();
      while (this.isOp('::') && this.peek1().type === 'NAME') {
        this.next(); // ::
        simple = this.peek().value;
        this.next();
      }
      if (this.isOp('<')) this.skipGenericAngle();
    }
    return simple;
  }

  /** Skip the `-> RetType` of a fn; balances `<>` / `()` / `[]`, stops at `{` / `;` / `where`. */
  private skipReturnType(): void {
    if (!this.isOp('->')) return;
    this.next();
    this.skipTypeUntilBody();
  }

  /**
   * Skip a type/header run until `{` / `;` / `where` at depth 0, balancing `<`/`>`/`>>`/`>>>` (the
   * split rule) and `()`/`[]`. Used for return types and stray header tokens.
   */
  private skipTypeUntilBody(): void {
    let gdepth = 0;
    let pdepth = 0;
    let bdepth = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (gdepth === 0 && pdepth === 0 && bdepth === 0) {
        if (this.isOp('{') || this.isOp(';')) return;
        if (this.isName('where')) return;
      }
      if (tk.type === 'OP') {
        if (tk.value === '<') gdepth++;
        else if (tk.value === '>') gdepth = Math.max(0, gdepth - 1);
        else if (tk.value === '>>') gdepth = Math.max(0, gdepth - 2);
        else if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
      }
      this.next();
    }
  }

  /** Skip a `where T: Bound, U: Bound` clause until `{` / `;` at depth 0. */
  private skipWhereClause(): void {
    if (!this.isName('where')) return;
    this.next();
    while (!this.atEnd()) {
      if (this.isOp('{') || this.isOp(';')) return;
      // a `where` bound ends at the body; balance `<...>` so `Vec<T>:` doesn't confuse us
      if (this.isOp('<')) {
        this.skipGenericAngle();
        continue;
      }
      this.next();
    }
  }

  /** Skip a generic `<...>` balanced on `<`/`>`/`>>`/`>>>` (the Rust split rule); returns param names. */
  private skipGenericAngle(): string[] {
    if (!this.isOp('<')) return [];
    let depth = 0;
    const params: string[] = [];
    let lastName: string | undefined;
    const flush = (): void => {
      if (lastName) {
        params.push(lastName);
        lastName = undefined;
      }
    };
    while (!this.atEnd()) {
      const tk = this.peek();
      if (tk.type === 'OP') {
        if (tk.value === '<') {
          depth++;
          this.next();
          continue;
        }
        if (tk.value === '>') {
          depth--;
          this.next();
          if (depth <= 0) {
            flush();
            return params;
          }
          continue;
        }
        if (tk.value === '>>') {
          depth -= 2;
          this.next();
          if (depth <= 0) {
            flush();
            return params;
          }
          continue;
        }
        if (tk.value === '>>>') {
          depth -= 3;
          this.next();
          if (depth <= 0) {
            flush();
            return params;
          }
          continue;
        }
        // a `:` bound or `=` default ends the current param name (don't capture bound names)
        if (depth === 1 && (tk.value === ':' || tk.value === '=')) {
          this.next();
          continue;
        }
        if (depth === 1 && tk.value === ',') {
          flush();
          this.next();
          continue;
        }
        if (tk.value === ';' || tk.value === '{') return params; // malformed; bail
      } else if (tk.type === 'NAME' && depth === 1) {
        // a top-level generic param name (before `:`/`,`/`=`); only the first name per segment
        if (!lastName) lastName = tk.value;
        this.next();
        continue;
      } else if (tk.type === 'LIFETIME' && depth === 1) {
        // lifetime param `'a` — capture as a param name (with the leading ')
        if (!lastName) lastName = tk.value;
        this.next();
        continue;
      }
      this.next();
    }
    flush();
    return params;
  }

  // --- attributes ---------------------------------------------------------------

  /** Consume `#[...]` or `#![...]`; capture the first NAME inside as the attribute simple name. */
  private consumeAttribute(out: string[]): void {
    this.next(); // #
    if (this.isOp('!')) this.next(); // inner `#![...]`
    if (this.isOp('[')) {
      this.attrBuf.length = 0;
      this.skipBalancedBrackets();
      if (this.attrBuf.length) out.push(this.attrBuf[0]!);
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

  /** From a `[` skip to its matching `]`; captures the first NAME inside as an attribute name. */
  private skipBalancedBrackets(): void {
    if (!this.isOp('[')) return;
    this.next(); // [
    let depth = 1;
    let name: string | undefined;
    while (!this.atEnd() && depth > 0) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '[') {
        depth++;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ']') {
        depth--;
        this.next();
        continue;
      }
      if (!name && tk.type === 'NAME') {
        name = tk.value; // first NAME = attribute name (`derive`, `cfg`, `inline`, `doc`, ...)
      }
      this.next();
    }
    if (name) this.attrBuf.push(name);
  }

  /** attribute names captured during consumeAttribute via skipBalancedBrackets. */
  private readonly attrBuf: string[] = [];

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

  /** Skip to the next `;` at depth 0 (for const/static/use/extern-crate items). */
  private skipToSemi(): void {
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
          else break; // end of enclosing block
        }
      }
      this.next();
    }
  }

  /** Skip to the next `;` or `}` at depth 0 (unknown member bail-out). */
  private skipToSemiOrClose(): void {
    let pdepth = 0;
    let bdepth = 0;
    let brace = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && bdepth === 0 && brace === 0 && (this.isOp(';') || this.isOp('}'))) return;
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
        else if (tk.value === '{') brace++;
        else if (tk.value === '}') {
          if (brace > 0) brace--;
          else return;
        }
      }
      this.next();
    }
  }

  // --- statement tree (Track 3) -----------------------------------------------------
  //
  // A tolerant, lossy compound-statement parser. It never throws: a malformed compound degrades
  // to skipping its body (empty / partial stmts). Only action lines (calls/returns/throws) and
  // compound statements (if/for/while/loop/match) become RustStmt nodes; plain declarations / pure
  // expressions are skipped to keep the graph lean (matches the spec's "emit only if it carries a
  // call" guidance).

  /**
   * Parse a statement block whose `{` has already been consumed, until the matching `}` (consuming
   * it). Returns the statements + the close-`}` line (0 if EOF reached first).
   */
  private parseStmtBlock(): { stmts: RustStmt[]; closeLine: number } {
    const stmts: RustStmt[] = [];
    let closeLine = 0;
    while (!this.atEnd()) {
      if (this.isOp('}')) {
        closeLine = this.peek().line;
        this.next();
        return { stmts, closeLine };
      }
      if (this.isOp(';')) {
        this.next(); // empty statement
        continue;
      }
      const before = this.i;
      const s = this.parseStmt();
      if (s) stmts.push(s);
      if (this.i === before && !this.atEnd()) this.next(); // progress guard (never loop)
    }
    return { stmts, closeLine };
  }

  private parseStmt(): RustStmt | null {
    // consume a leading label `'name:` (loop labels) — dropped, not captured
    if (this.peek().type === 'LIFETIME' && this.peek1().value === ':') {
      this.next(); // 'name
      this.next(); // :
    }
    const line = this.peek().line;
    if (this.isName('if')) return this.parseIf(line);
    if (this.isName('for')) return this.parseFor(line);
    if (this.isName('while')) return this.parseWhile(line);
    if (this.isName('loop')) return this.parseLoopStmt(line);
    if (this.isName('match')) return this.parseMatch(line);
    if (this.isName('return')) return this.parseReturn(line);
    // `break` / `continue` — not action lines we care about; skip the statement
    if (this.isName('break') || this.isName('continue')) {
      this.skipToSemiOrClose();
      return null;
    }
    // `unsafe { ... }` / `safe { ... }` — descend as a passthrough block (same guard stack)
    if (this.isName('unsafe') || this.isName('safe')) {
      this.next();
      if (this.isOp('{')) {
        this.next();
        const res = this.parseStmtBlock();
        return { kind: 'block', line, body: res.stmts };
      }
      // `unsafe <expr>;` (rare) — fall through to expression scanning
    }
    // bare block `{ ... }` as a statement — descend as a passthrough block
    if (this.isOp('{')) {
      this.next();
      const res = this.parseStmtBlock();
      return { kind: 'block', line, body: res.stmts };
    }
    // `let ... = ...;` or an expression statement — scan to `;`/`}` and classify (call/throw/plain)
    return this.parseExprStmt(line);
  }

  /** `if cond { .. } else if cond2 { .. } else { .. }` — ONE condition per chain (IF line). */
  private parseIf(line: number): RustStmt {
    this.next(); // if
    const predicate = this.readUntilBlock();
    const then = this.parseBlockBody();
    const elifs: { predicate: string; body: RustStmt[] }[] = [];
    let els: RustStmt[] | undefined;
    while (this.isName('else')) {
      this.next(); // else
      if (this.isName('if')) {
        this.next(); // if
        const elifPred = this.readUntilBlock();
        elifs.push({ predicate: elifPred, body: this.parseBlockBody() });
      } else {
        els = this.parseBlockBody();
      }
    }
    return { kind: 'if', line, predicate, then, elifs, ...(els ? { else: els } : {}) };
  }

  private parseFor(line: number): RustStmt {
    this.next(); // for
    const predicate = this.readUntilBlock();
    return { kind: 'loop', line, loopKind: 'for', predicate, body: this.parseBlockBody() };
  }

  private parseWhile(line: number): RustStmt {
    this.next(); // while
    const predicate = this.readUntilBlock();
    return { kind: 'loop', line, loopKind: 'while', predicate, body: this.parseBlockBody() };
  }

  private parseLoopStmt(line: number): RustStmt {
    this.next(); // loop
    // `loop { body }` has no predicate (infinite loop) — condition left empty; inLoop is the signal.
    return { kind: 'loop', line, loopKind: 'loop', predicate: '', body: this.parseBlockBody() };
  }

  /** `match scrutinee { arms }` — each arm is `pat => body`, body is a block or expression. */
  private parseMatch(line: number): RustStmt {
    this.next(); // match
    const predicate = this.readUntilBlock();
    const arms: { line: number; pat: string; body: RustStmt[] }[] = [];
    if (!this.isOp('{')) {
      this.skipToSemiOrClose(); // malformed match — degrade
      return { kind: 'match', line, predicate, arms };
    }
    this.next(); // {
    while (!this.atEnd() && !this.isOp('}')) {
      const before = this.i;
      const arm = this.parseMatchArm();
      if (arm) arms.push(arm);
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.isOp('}') || this.atEnd()) break;
      if (this.i === before) this.next(); // progress guard
    }
    if (this.isOp('}')) this.next();
    return { kind: 'match', line, predicate, arms };
  }

  /** One match arm: `pat => body`. `body` is a block (parsed as stmts) or an expression (one 'expr'
   * stmt if it carries a call — but we only emit action stmts, so an expression arm becomes a single
   * call/throw action if it contains a call, else empty). */
  private parseMatchArm(): { line: number; pat: string; body: RustStmt[] } | null {
    if (this.isOp('}') || this.atEnd()) return null;
    const armLine = this.peek().line;
    const patStart = this.i;
    let pdepth = 0;
    let bdepth = 0;
    // pattern runs until `=>` at depth 0 (balance `()` / `[]` so `Pat(a => b)` doesn't fool us)
    while (!this.atEnd() && !this.isOp('}')) {
      if (pdepth === 0 && bdepth === 0 && this.isOp('=>')) break;
      const tk = this.peek();
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
      }
      this.next();
    }
    const pat = this.sliceTokens(patStart, this.i).trim();
    if (!this.isOp('=>')) {
      // malformed arm — skip to next `,`/`}` and degrade
      this.skipToCommaOrClose();
      if (this.isOp(',')) this.next();
      return null;
    }
    this.next(); // =>
    let body: RustStmt[];
    if (this.isOp('{')) {
      this.next();
      const res = this.parseStmtBlock();
      body = res.stmts;
    } else {
      // expression arm — scan to `,` at depth 0 (or `}`); classify as a call/throw action if present
      const exprStart = this.i;
      this.skipToCommaOrClose();
      body = this.exprToAction(this.peek().line, exprStart, this.i);
    }
    return { line: armLine, pat, body };
  }

  /** `return [expr];` — type 'return'; `callee` = the first call in the returned expression (if any).
   *  1.2: `return Err(…)` / `return Result::Err(…)` is flagged `isErrReturn` so the extractor emits a
   *  `raise` node (Rust's closest throw analog). The first string literal in the Err payload becomes
   *  `errorMessage`; a non-string payload leaves it unset (the raw expr text is the fallback). */
  private parseReturn(line: number): RustStmt {
    this.next(); // return
    const startIdx = this.i;
    this.skipToSemiOrClose();
    const text = this.sliceTokens(startIdx, this.i).trim();
    const call = this.findFirstCall(startIdx, this.i);
    const text2 = text ? `return ${text}` : 'return';
    const errIdx = this.findErrCall(startIdx, this.i);
    if (errIdx >= 0) {
      const msg = this.findFirstString(errIdx + 1, this.i);
      return {
        kind: 'return',
        line,
        text: text2.slice(0, 200),
        ...(call ? { callee: call.callee } : {}),
        isErrReturn: true,
        ...(msg ? { errorMessage: msg } : {}),
      };
    }
    return {
      kind: 'return',
      line,
      text: text2.slice(0, 200),
      ...(call ? { callee: call.callee } : {}),
    };
  }

  /**
   * A `let` or expression statement. 1.2: a simple `let [mut] name = …` (with initializer) or a
   * bare `name = …` reassignment becomes an `assign` stmt (target = the LHS binding); if the RHS
   * carries a call, `callee` is captured so the walker still records a guarded call site for
   * `calls`-edge annotation. Destructuring / `let name: Type;` (no initializer) / field-reassignment
   * (`x.y = …`) are skipped (conservative + capability-honest). A pure expression statement with a
   * call stays a 'call' action (so the decision table surfaces the call); `panic!(…)` → 'throw'.
   * A plain expr / pure assignment with no call produces NO stmt (lean graph).
   */
  private parseExprStmt(line: number): RustStmt | null {
    const startIdx = this.i;
    if (this.isName('let')) {
      this.next(); // let
      // only simple `let [mut|ref] name [: Type] = …` — conservative (skip patterns/struct lits)
      if (this.isName('mut') || this.isName('ref')) this.next();
      if (this.peek().type === 'NAME') {
        const target = this.peek().value;
        this.next();
        if (this.isOp(':')) this.skipTypeUntilAssign(); // optional `: Type` annotation
        if (this.isOp('=')) {
          this.next(); // =
          const rhsStart = this.i;
          this.skipToSemiOrClose();
          const action = this.exprToAction(line, rhsStart, this.i)[0];
          return {
            kind: 'assign',
            line,
            target,
            text: this.sliceTokens(startIdx, this.i).trim().slice(0, 200),
            ...(action && 'callee' in action && action.callee ? { callee: action.callee } : {}),
          };
        }
      }
      // not a simple `let name = …` — fall through to skip
      this.skipToSemiOrClose();
      return null;
    }
    // reassignment `name = …` (NAME followed by a lone `=`, not `==`/`+=`/etc.) — conservative
    if (this.peek().type === 'NAME' && this.peek1().type === 'OP' && this.peek1().value === '=') {
      const target = this.peek().value;
      this.next(); // NAME
      this.next(); // =
      const rhsStart = this.i;
      this.skipToSemiOrClose();
      const action = this.exprToAction(line, rhsStart, this.i)[0];
      return {
        kind: 'assign',
        line,
        target,
        text: this.sliceTokens(startIdx, this.i).trim().slice(0, 200),
        ...(action && 'callee' in action && action.callee ? { callee: action.callee } : {}),
      };
    }
    this.skipToSemiOrClose();
    return this.exprToAction(line, startIdx, this.i)[0] ?? null;
  }

  /** Classify a token run as at most one action stmt (call/throw); empty if no call present.
   *  1.2: `panic!("msg")` captures the first string literal as `errorMessage`. */
  private exprToAction(line: number, start: number, end: number): RustStmt[] {
    const text = this.sliceTokens(start, end).trim();
    if (!text) return [];
    const call = this.findFirstCall(start, end);
    if (!call) return []; // plain expr / pure assignment — skip (lean graph)
    if (call.macro && call.callee === 'panic') {
      const msg = this.findFirstString(start, end);
      return [
        {
          kind: 'throw',
          line: call.line,
          text: text.slice(0, 200),
          ...(msg ? { errorMessage: msg } : {}),
        },
      ];
    }
    return [{ kind: 'call', line: call.line, text: text.slice(0, 200), callee: call.callee }];
  }

  /**
   * Read a predicate (the tokens between a compound keyword and its `{` body). Balances `()` / `[]`
   * only (NOT `<>`: a `<` in a predicate is a comparison, not a generic). Returns the source slice.
   */
  private readUntilBlock(): string {
    const startIdx = this.i;
    let pdepth = 0;
    let bdepth = 0;
    while (!this.atEnd()) {
      if (pdepth === 0 && bdepth === 0 && this.isOp('{')) break;
      const tk = this.peek();
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
      }
      this.next();
    }
    return this.sliceTokens(startIdx, this.i).trim();
  }

  /** Parse a block body: expects `{`, consumes it + the matching `}`, returns the body stmts. */
  private parseBlockBody(): RustStmt[] {
    if (!this.isOp('{')) {
      // malformed body (no brace) — skip to `;`/`}` and degrade to an empty body (lossy, no throw)
      this.skipToSemiOrClose();
      return [];
    }
    this.next(); // {
    const res = this.parseStmtBlock();
    return res.stmts;
  }

  /** Skip to the next `,` or `}` at depth 0 (match-arm expression end); does not consume it. */
  private skipToCommaOrClose(): void {
    let pdepth = 0;
    let bdepth = 0;
    let brace = 0;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && bdepth === 0 && brace === 0 && (this.isOp(',') || this.isOp('}'))) return;
      if (tk.type === 'OP') {
        if (tk.value === '(') pdepth++;
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else if (tk.value === '[') bdepth++;
        else if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
        else if (tk.value === '{') brace++;
        else if (tk.value === '}') brace = Math.max(0, brace - 1);
      }
      this.next();
    }
  }

  /** 1.2: the first string literal in tokens [start, end), with surrounding quotes stripped. Used
   *  to extract `errorMessage` from `panic!("msg")` / `Err("msg")`. Returns undefined if none. */
  private findFirstString(start: number, end: number): string | undefined {
    for (let k = start; k < end; k++) {
      const tk = this.t[k]!;
      if (tk.type === 'STRING') {
        const v = tk.value;
        // the lexer emits string tokens whose value starts and ends with `"` (raw bodies too)
        if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
        return v;
      }
    }
    return undefined;
  }

  /** 1.2: index of a `Err(…)` call (`Err` NAME immediately followed by `(`) in [start, end), covering
   *  bare `Err(…)` and qualified `Result::Err(…)` / `Foo::Err(…)`. -1 if absent. */
  private findErrCall(start: number, end: number): number {
    for (let k = start; k < end; k++) {
      const tk = this.t[k]!;
      if (tk.type === 'NAME' && tk.value === 'Err') {
        const next = this.t[k + 1];
        if (next?.type === 'OP' && next.value === '(') return k;
      }
    }
    return -1;
  }

  /** 1.2: skip a `: Type` annotation after a `let` binding name until `=` / `;` at depth 0, balancing
   *  `<`/`>`/`>>` (Rust split rule), `()`/`[]`/`{}` so `Vec<(u32, &str)>` doesn't fool us. */
  private skipTypeUntilAssign(): void {
    if (!this.isOp(':')) return;
    this.next(); // :
    let g = 0;
    let p = 0;
    let b = 0;
    let br = 0;
    while (!this.atEnd()) {
      if (g === 0 && p === 0 && b === 0 && br === 0 && (this.isOp('=') || this.isOp(';'))) return;
      const tk = this.peek();
      if (tk.type === 'OP') {
        if (tk.value === '<') g++;
        else if (tk.value === '>') g = Math.max(0, g - 1);
        else if (tk.value === '>>') g = Math.max(0, g - 2);
        else if (tk.value === '(') p++;
        else if (tk.value === ')') p = Math.max(0, p - 1);
        else if (tk.value === '[') b++;
        else if (tk.value === ']') b = Math.max(0, b - 1);
        else if (tk.value === '{') br++;
        else if (tk.value === '}') br = Math.max(0, br - 1);
      }
      this.next();
    }
  }

  /**
   * Find the first call expression in tokens [start, end): a NAME (not a control keyword) followed
   * by `::NAME`/`.NAME` segments, then `(` (regular) or `!` `(` (macro). Returns the callee chain
   * (joined with `::` or `.` per the separators), the head line, and whether it is a macro call.
   */
  private findFirstCall(
    start: number,
    end: number,
  ): { callee: string; line: number; macro: boolean } | undefined {
    let k = start;
    while (k < end) {
      const tk = this.t[k]!;
      if (tk.type !== 'NAME' || STMT_KEYWORDS.has(tk.value)) {
        k++;
        continue;
      }
      const segs: string[] = [tk.value];
      const seps: string[] = [];
      let j = k + 1;
      while (j < end) {
        const op = this.t[j]!;
        if (op.type === 'OP' && op.value === '::' && this.t[j + 1]?.type === 'NAME') {
          seps.push('::');
          segs.push(this.t[j + 1]!.value);
          j += 2;
          continue;
        }
        if (op.type === 'OP' && op.value === '.' && this.t[j + 1]?.type === 'NAME') {
          seps.push('.');
          segs.push(this.t[j + 1]!.value);
          j += 2;
          continue;
        }
        break;
      }
      const macro =
        this.t[j]?.type === 'OP' &&
        this.t[j]?.value === '!' &&
        this.t[j + 1]?.type === 'OP' &&
        this.t[j + 1]?.value === '(';
      const regular = this.t[j]?.type === 'OP' && this.t[j]?.value === '(';
      if (macro || regular) {
        const sep = seps.includes('.') ? '.' : '::';
        return { callee: segs.join(sep), line: tk.line, macro };
      }
      k++;
    }
    return undefined;
  }

  /** char offset of a token's first character (from its 1-based line/col + the line-start index). */
  private tokOff(tk: Token): number {
    return (this.lineOff[tk.line - 1] ?? 0) + (tk.col - 1);
  }

  /** Best-effort source text spanned by tokens [startIdx, endIdx) — for predicates/expressions. */
  private sliceTokens(startIdx: number, endIdx: number): string {
    if (startIdx >= endIdx || startIdx >= this.t.length) return '';
    const first = this.t[startIdx]!;
    const last = this.t[endIdx - 1] ?? first;
    const s = this.tokOff(first);
    const e = this.tokOff(last) + last.value.length;
    return this.src.slice(s, Math.max(s, e));
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
  private peek(): Token {
    return this.t[this.i] ?? { type: 'EOF', value: '', line: 0, col: 0 };
  }
  private peek1(): Token {
    return this.t[this.i + 1] ?? { type: 'EOF', value: '', line: 0, col: 0 };
  }
  private atEnd(): boolean {
    return this.i >= this.t.length || this.peek().type === 'EOF';
  }
}

/**
 * Hard-reserved keywords that can NEVER be an item / fn name (primitives + control flow + literals).
 * Contextual / soft keywords (`type`, `union`, `dyn`, `async`, `await`, `raw`) ARE valid identifiers
 * in item position and are excluded so e.g. `fn type()` (weird but legal) parses.
 */
const HARD_KEYWORDS = new Set<string>([
  'as',
  'break',
  'const',
  'continue',
  'crate',
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
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'async',
  'await',
  'dyn',
]);

/**
 * Control-flow / item keywords that can never be a call head in a statement expression. Used by
 * {@link Parser.findFirstCall} to skip `if`/`for`/`while`/`match`/`return`/`let`/etc. as callees.
 * `self`/`Self`/`crate`/`super` are deliberately NOT excluded — they can start a call chain.
 */
const STMT_KEYWORDS = new Set<string>([
  'if',
  'for',
  'while',
  'loop',
  'match',
  'return',
  'let',
  'else',
  'break',
  'continue',
  'unsafe',
  'safe',
  'move',
  'as',
  'in',
  'fn',
  'where',
  'async',
  'await',
  'struct',
  'enum',
  'union',
  'impl',
  'trait',
  'mod',
  'use',
  'type',
  'const',
  'static',
  'pub',
  'extern',
  'dyn',
  'ref',
  'mut',
  'true',
  'false',
]);

/**
 * Scan the token stream for call expressions `NAME (::NAME | .NAME)* (` whose `(` is NOT a definition
 * or attribute arg-list (excluded set). A `!` immediately before the `(` marks a `macro!()` call.
 * `foo()` / `foo::bar()` / `Type::method()` / `obj.method()` are all captured; the extractor decides
 * which resolve to a same-file symbol (receiver `.method()` and unknown paths are dropped).
 */
export function collectCallSites(tokens: Token[], excluded: Set<number>): RustCallSite[] {
  const calls: RustCallSite[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME') {
      i++;
      continue;
    }
    const head = tk.value;
    const line = tk.line;
    const segments: string[] = [];
    const seps: string[] = [];
    let j = i + 1;
    while (j < tokens.length) {
      const op = tokens[j]!;
      if (op.type === 'OP' && op.value === '::' && tokens[j + 1]?.type === 'NAME') {
        seps.push('::');
        segments.push(tokens[j + 1]!.value);
        j += 2;
        continue;
      }
      if (op.type === 'OP' && op.value === '.' && tokens[j + 1]?.type === 'NAME') {
        seps.push('.');
        segments.push(tokens[j + 1]!.value);
        j += 2;
        continue;
      }
      break;
    }
    const name = segments.length ? segments[segments.length - 1]! : head;
    // macro call: `!` immediately before `(`
    if (
      tokens[j]?.type === 'OP' &&
      tokens[j]?.value === '!' &&
      tokens[j + 1]?.type === 'OP' &&
      tokens[j + 1]?.value === '('
    ) {
      if (!excluded.has(j + 1)) {
        calls.push({ head, segments, seps, name, line, macro: true });
      }
      i = j + 2;
      continue;
    }
    // regular call: `(` immediately after the chain
    if (tokens[j]?.type === 'OP' && tokens[j]?.value === '(') {
      if (!excluded.has(j)) {
        calls.push({ head, segments, seps, name, line, macro: false });
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return calls;
}

/**
 * Scan the token stream for `use` statements and parse the use-tree into bindings (nested groups,
 * globs, aliases). `use std::collections::HashMap;` → {module:"std::collections", name:"HashMap"}.
 * `use std::{collections::HashMap, sync::Mutex};` → two imports. `use a::b::*;` → star. `use a::b::C
 * as D;` → {module:"a::b", name:"D", alias:"D"}. `use a::b::{self, C};` → {module:"a::b", name:"b"}
 * (self binds the path itself) and {module:"a::b", name:"C"}.
 */
export function collectImports(tokens: Token[]): RustImport[] {
  const imports: RustImport[] = [];
  let i = 0;
  const isNameVal = (k: number, v: string) => tokens[k]?.type === 'NAME' && tokens[k]?.value === v;
  const isOp = (k: number, v: string) => tokens[k]?.type === 'OP' && tokens[k]?.value === v;

  const parseTree = (start: number, prefix: string[], line: number): number => {
    let k = start;
    const segs: string[] = [];
    while (tokens[k]?.type === 'NAME' || (tokens[k]?.type === 'OP' && tokens[k]?.value === '*')) {
      // path segment (NAME; `*` only valid as a leaf handled below)
      if (isOp(k, '*')) break;
      segs.push(tokens[k]!.value);
      k++;
      if (isOp(k, '::')) {
        k++;
        continue;
      }
      break;
    }
    const path = [...prefix, ...segs];
    // group: `{ ... }`
    if (isOp(k, '{')) {
      k++; // {
      while (tokens[k] && !isOp(k, '}')) {
        if (isOp(k, ',')) {
          k++;
          continue;
        }
        k = parseTree(k, path, line);
      }
      if (isOp(k, '}')) k++; // }
      return k;
    }
    // glob: `*`
    if (isOp(k, '*')) {
      k++; // *
      imports.push({
        module: path.join('::'),
        name: '',
        original: '',
        star: true,
        line,
      });
      return k;
    }
    // alias: `as Name`
    if (isNameVal(k, 'as')) {
      k++; // as
      const alias = tokens[k]?.type === 'NAME' ? tokens[k]!.value : '';
      if (alias) k++;
      const original = segs[segs.length - 1] ?? '';
      const module = path.slice(0, -1).join('::');
      imports.push({
        module,
        name: alias || original,
        original,
        star: false,
        alias: alias || undefined,
        line,
      });
      return k;
    }
    // leaf path: the last segment is the bound name; everything before is the module
    if (segs.length === 0) return k; // stray `{`/`;` — bail
    // `self` as the last segment binds the path PREFIX (module) as the name
    const last = segs[segs.length - 1]!;
    if (last === 'self') {
      const module = path.slice(0, -1).join('::');
      const selfName = segs[segs.length - 2] ?? prefix[prefix.length - 1] ?? 'self';
      imports.push({ module, name: selfName, original: selfName, star: false, line });
      return k;
    }
    const module = path.slice(0, -1).join('::');
    imports.push({ module, name: last, original: last, star: false, line });
    return k;
  };

  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME') {
      i++;
      continue;
    }
    // `pub use ...` / `use ...` — a leading `pub` is a re-export; same binding
    if (tk.value === 'pub' && isNameVal(i + 1, 'use')) {
      i++;
    }
    if (tk.value === 'use') {
      const line = tk.line;
      let k = i + 1;
      // skip a leading `::` (use ::crate_root::...)
      if (isOp(k, '::')) k++;
      k = parseTree(k, [], line);
      i = k;
      // skip to `;`
      while (tokens[i] && !isOp(i, ';')) i++;
      if (isOp(i, ';')) i++;
      continue;
    }
    i++;
  }
  return imports;
}
