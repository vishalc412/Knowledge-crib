/**
 * Go structural parser — turns the token stream into a declaration tree (func / method / struct /
 * interface / typedef / typealias) plus a flat list of call sites + imports + the package path. NOT
 * a full expression parser: the symbol graph only needs declaration spans + nesting (interface
 * methods nest in their interface; everything else is top-level — Go has NO nested type decls) and
 * call-site heads (for `calls`), so a tolerant brace-level descent is enough.
 *
 * Go vs Java differences baked in:
 *   - Generic type/param lists use SQUARE brackets `[T any]` (not `<T>`), so there is NO `<`/`>`
 *     split ambiguity — `[...]` is balanced like `(...)`. Methods on generic types carry the type
 *     args on the receiver (`func (s Stack[T]) Push(v T)`), NOT after the method name.
 *   - Struct fields are NOT emitted as symbols (parity with Java/Python: only types + funcs +
 *     methods). Struct EMBEDDING (`type S struct { Base }`) IS captured into `bases` so the resolver
 *     can emit `inherits`. Interface EMBEDDING (`type I interface { B }`) is captured into `bases`
 *     too (interface-extends-interface, an `inherits`). Go's IMPLICIT interface satisfaction is NOT
 *     statically detectable without full type info → never captured as `implements` (honest).
 *   - Params use Go order (name then type, shared-type groups); the param-name heuristic is
 *     Go-specific (see {@link parseParamList}).
 *   - The lexer's automatic-semicolon insertion feeds real `;` terminators into every decl line.
 *
 * Never throws: a parse error degrades to an empty module so the extractor falls back to a file node.
 */
import { EXPR_MAX_CHARS } from '../types.js';
import { tokenize } from './lexer.js';
import type { Token } from './lexer.js';

export type GoKind = 'func' | 'method' | 'struct' | 'interface' | 'typedef' | 'typealias';

export interface GoDef {
  kind: GoKind;
  name: string;
  /** 1-based line of the first token of the declaration. */
  startLine: number;
  /** 1-based line of the declaration's last token (closing `}` for types, `}`/`;` for funcs). */
  endLine: number;
  modifiers: string[];
  annotations: string[];
  /** embedded types (struct) / embedded interfaces (interface) — INHERITS targets. */
  bases: string[];
  /** always empty for Go — implicit interface satisfaction is not statically detectable. */
  implements: string[];
  /** parameter names (funcs / methods / interface methods). */
  params: string[];
  /** generic type-param names (`[T any, U comparable]` → ["T","U"]); empty for non-generic decls. */
  typeParams: string[];
  /** method receiver type name, stripped of `*`/`[...]`/package qualifier; "" for non-methods. */
  receiverType: string;
  /** receiver variable name (e.g. `s` in `func (s *Server)`); "" when absent (`func (*Server)`). */
  receiverName: string;
  /** type-param names appearing on the receiver type (`Stack[T]` → ["T"]); "" for plain receivers. */
  receiverTypeParams: string[];
  /** interface methods (nested inside an interface decl); empty for all other kinds. */
  body: GoDef[];
  /** interface method flag — true for methods parsed inside an interface body. */
  interfaceMethod: boolean;
  /** return-type text for interface methods (e.g. "string", "(string, error)"); "" otherwise. */
  returns: string;
  /** underlying type text for typedef (`type Role int` → "int") / alias (`type N = X` → "X"). */
  underlying: string;
  /** func/method body statement tree (Track 3); empty for non-func kinds. */
  stmts: GoBodyStmt[];
}

export interface GoCallSite {
  /** callee head: a bare name or the first segment of a dotted chain. */
  head: string;
  /** dotted tail after the head (`fmt.Println` → ["Println"]). */
  tail: string[];
  /** last segment — the function/method name being invoked. */
  name: string;
  /** 1-based line of the call's opening `(`. */
  line: number;
}

export interface GoImport {
  /** import path as written (the quoted string content, e.g. "fmt", "auth/util"). */
  module: string;
  /** default package name (last path segment, e.g. "fmt", "util"); used for cross-pkg resolution. */
  name: string;
  /** local binding name: real alias | last segment (plain import) | "." (dot) | "_" (blank). */
  alias: string;
  line: number;
}

export interface GoModule {
  defs: GoDef[];
  calls: GoCallSite[];
  imports: GoImport[];
  /** package path (`package name`), or "" if absent. */
  pkg: string;
}

// ---------------------------------------------------------------------------------------------
// Body-statement AST (Track 3) — the compound-statement subset the extractor walks with a guard
// stack to emit condition/statement nodes + executes/calls/guarded-by edges. Tolerant + lossy: a
// malformed compound degrades to skipping its body (mirrors the PL/SQL posture). Spans are 1-based.
// ---------------------------------------------------------------------------------------------

/** A call's callee chain (mirrors {@link GoCallSite} for the body-walk's intra-file resolution). */
export interface GoCallee {
  /** callee head: a bare name or the first segment of a dotted chain. */
  head: string;
  /** dotted tail after the head (`c.service.Greet` → ["service","Greet"]). */
  tail: string[];
  /** last segment — the function/method name being invoked. */
  name: string;
  /** 1-based line of the callee's first NAME token (the call-site line). */
  line: number;
}

/** One `case`/`default` clause of a `switch` or `select`. */
export interface GoCaseClause {
  /** 1-based line of the `case`/`default` keyword — the condition-id key. */
  line: number;
  /** case predicate source text; undefined for `default`. */
  predicate?: string;
  isDefault: boolean;
  body: GoBodyStmt[];
}

export type GoBodyStmt =
  | GoIfStmt
  | GoForStmt
  | GoSwitchStmt
  | GoSelectStmt
  | GoReturnStmt
  | GoCallStmt
  | GoThrowStmt
  | GoAssignStmt
  | GoExprStmt
  | GoBlockStmt
  | GoDeferStmt;

interface GoBodyBase {
  /** 1-based line of the statement's first token. */
  line: number;
  /** 1-based line of the statement's last token (best-effort). */
  endLine: number;
  /** best-effort source text (≤200 chars). */
  text: string;
}

/** `if [init;] cond { } else if … { } else { }` — ONE condition per chain (keyed by `ifLine`). */
export interface GoIfStmt extends GoBodyBase {
  kind: 'if';
  ifLine: number;
  predicate: string;
  then: GoBodyStmt[];
  elseIfs: { line: number; predicate: string; body: GoBodyStmt[] }[];
  elseBody?: GoBodyStmt[];
}

/** `for … { }` — covers while/for-range/infinite (Go has only `for`). */
export interface GoForStmt extends GoBodyBase {
  kind: 'for';
  forLine: number;
  predicate: string;
  body: GoBodyStmt[];
}

/** `switch [expr] { case …: default: }` — one condition per case predicate (branch:'CASE'). */
export interface GoSwitchStmt extends GoBodyBase {
  kind: 'switch';
  switchLine: number;
  predicate: string;
  cases: GoCaseClause[];
}

/** `select { case <-ch: default: }` — one condition per case predicate (branch:'CASE'). */
export interface GoSelectStmt extends GoBodyBase {
  kind: 'select';
  selectLine: number;
  cases: GoCaseClause[];
}

export interface GoReturnStmt extends GoBodyBase {
  kind: 'return';
  /** return-expression text (best-effort). */
  expr?: string;
  /** if the return expression is a call, its callee (for intra-file `calls`). */
  callee?: GoCallee;
}

/** A call statement `f()` / `obj.m()` / `defer f()` / `go f()`. */
export interface GoCallStmt extends GoBodyBase {
  kind: 'call';
  callee: GoCallee;
}

/** `panic(…)` — modelled as a throw (Go has no `throw` keyword). */
export interface GoThrowStmt extends GoBodyBase {
  kind: 'throw';
  head: string;
}

/** An assignment `x = …` / `x := …` / `x += …`; `callee` set when the RHS is a call (for `calls`).
 *  1.2: `target` carries the LHS text so an `assignment` node can record the provenance target. */
export interface GoAssignStmt extends GoBodyBase {
  kind: 'assign';
  /** the LHS target text (best-effort), e.g. "x" / "s.items"; "" if not recovered. */
  target?: string;
  callee?: GoCallee;
}

/** `defer func() { … }()` (a func literal) or `defer f()` (a bare/dotted call). 1.2: a defer of a
 *  func literal whose body contains a `recover()` call is Go's closest exception-handler analog —
 *  `hasRecover` flags it so the extractor emits an `exception-handler` node + `handles` edges. */
export interface GoDeferStmt extends GoBodyBase {
  kind: 'defer';
  /** the deferred func-literal body statements; empty for a defer of a plain call. */
  body: GoBodyStmt[];
  /** true iff the func-literal body contains a `recover()` call (scanned at parse time). */
  hasRecover: boolean;
  /** true iff this is `defer func(){…}()`; false for `defer f()` (modeled as a `call` stmt). */
  isFuncLiteral: boolean;
}

/** A bare expression statement that carries a call (otherwise plain exprs are skipped). */
export interface GoExprStmt extends GoBodyBase {
  kind: 'expr';
  callee?: GoCallee;
}

/** A bare nested block `{ … }`. */
export interface GoBlockStmt extends GoBodyBase {
  kind: 'block';
  body: GoBodyStmt[];
}

/** Parse Go source into a declaration tree + call sites + imports + package (never throws). */
export function parseGo(src: string): GoModule {
  try {
    const tokens = tokenize(src);
    const p = new Parser(tokens, src);
    const { defs, excluded } = p.parseProgram();
    const calls = collectCallSites(tokens, excluded);
    const { pkg, imports } = collectImports(tokens);
    return { defs, calls, imports, pkg };
  } catch {
    return { defs: [], calls: [], imports: [], pkg: '' };
  }
}

class Parser {
  private readonly t: Token[];
  private readonly src: string;
  /** 1-based line → code-unit offset of that line's first char (for source-text slicing). */
  private readonly lineStarts: number[] = [];
  private i = 0;
  /** token indices of definition `(` openers — call sites at these indices are NOT calls. */
  private readonly excluded = new Set<number>();

  constructor(tokens: Token[], src: string) {
    this.t = tokens;
    this.src = src;
    // Precompute line-start offsets (code-unit based, matching the lexer's `col` counting) so the
    // body parser can slice exact best-effort source text for predicates / statements.
    this.lineStarts.push(0);
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.lineStarts.push(i + 1);
  }

  parseProgram(): { defs: GoDef[]; excluded: Set<number> } {
    const { defs } = this.parseDecls(true);
    return { defs, excluded: this.excluded };
  }

  /**
   * Parse declarations at one brace level. `topLevel` ⇒ stop at EOF (a stray `}` is left).
   * Returns the nested defs plus `closeLine` — the 1-based line of the closing `}` that ended a
   * non-top-level block (0 for top level), used to size the enclosing type's `endLine`.
   */
  private parseDecls(topLevel: boolean): { defs: GoDef[]; closeLine: number } {
    const defs: GoDef[] = [];
    let closeLine = 0;
    while (!this.atEnd()) {
      if (this.isOp('}')) {
        closeLine = this.peek().line;
        if (!topLevel) this.next();
        break;
      }
      if (this.isOp('{')) {
        this.skipBraces(); // bare block — skip
        continue;
      }
      if (this.isOp(';') || this.isOp(',')) {
        this.next(); // stray terminator
        continue;
      }
      const before = this.i;
      const d = this.parseDecl();
      if (d) {
        if (Array.isArray(d)) defs.push(...d);
        else defs.push(d);
      } else if (this.i === before && !this.atEnd()) this.next(); // progress guard
    }
    return { defs, closeLine };
  }

  /**
   * Parse one top-level declaration: `func`, `type` (incl. `type ( ... )` block), or a skipped
   * `const` / `var` / `package` / `import` / stray token. Returns a def, an array of defs (type
   * block), or null (skipped).
   */
  private parseDecl(): GoDef | GoDef[] | null {
    const startLine = this.peek().line;
    if (this.isName('func')) return this.parseFunc(startLine);
    if (this.isName('type')) return this.parseType(startLine);
    // const / var: skip a single decl or a `( ... )` block; package / import are handled by
    // collectImports but also tolerate them here by skipping to `;`.
    if (this.isName('const') || this.isName('var')) {
      this.next();
      if (this.isOp('(')) this.skipBalancedParens();
      else this.skipToSemi();
      return null;
    }
    if (this.isName('package') || this.isName('import')) {
      this.skipToSemi();
      return null;
    }
    // any other stray token at top level: skip to `;`
    this.skipToSemi();
    return null;
  }

  /** Parse `func [receiver] Name[tparams](params) (rets) {body}` → func or method def. */
  private parseFunc(startLine: number): GoDef | null {
    this.next(); // func
    let receiverType = '';
    let receiverName = '';
    let receiverTypeParams: string[] = [];
    if (this.isOp('(')) {
      this.excluded.add(this.i); // receiver `(` is NOT a call
      const recv = this.parseReceiver();
      receiverType = recv.type;
      receiverName = recv.name;
      receiverTypeParams = recv.typeParams;
    }
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    let typeParams: string[] = [];
    if (this.isOp('[')) typeParams = this.parseTypeParams();
    let params: string[] = [];
    if (this.isOp('(')) {
      this.excluded.add(this.i); // param `(` is NOT a call
      params = this.parseParamList();
    }
    // return type — skip to `{` or `;` (not captured for funcs/methods; interface methods capture)
    this.skipReturnType();
    let endLine = this.peek().line;
    let stmts: GoBodyStmt[] = [];
    if (this.isOp('{')) {
      const blk = this.parseBlock();
      stmts = blk.stmts;
      endLine = blk.closeLine;
    } else if (this.isOp(';')) {
      this.next();
    }
    return {
      kind: receiverType ? 'method' : 'func',
      name,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers: [],
      annotations: [],
      bases: [],
      implements: [],
      params,
      typeParams,
      receiverType,
      receiverName,
      receiverTypeParams,
      body: [],
      interfaceMethod: false,
      returns: '',
      underlying: '',
      stmts,
    };
  }

  /**
   * Parse a receiver `( [name] [*]Type[.Sub][[T]] )` — returns the receiver type name (last NAME at
   * bracket depth 0, stripping `*`/qualification), the optional receiver variable name, and any
   * type params on the receiver type. NAMEs inside `[...]` are NOT collected (they are type args).
   */
  private parseReceiver(): { type: string; name: string; typeParams: string[] } {
    this.next(); // (
    let depth = 1;
    const names: string[] = [];
    let bdepth = 0;
    // type-param NAMEs collected inside the receiver's `[...]`
    const tparams: string[] = [];
    let inBracket = false;
    let segStart = true; // true when next NAME at depth 1/bracket 0 is the start of a param
    while (!this.atEnd() && depth > 0) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '(') {
        depth++;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ')') {
        depth--;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === '[') {
        bdepth++;
        inBracket = true;
        segStart = true;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ']') {
        bdepth = Math.max(0, bdepth - 1);
        inBracket = bdepth > 0;
        this.next();
        continue;
      }
      if (tk.type === 'NAME') {
        if (bdepth === 0) {
          names.push(tk.value);
        } else if (inBracket && segStart) {
          // first NAME after `[` or `,` inside the receiver's type-arg list is a type param
          tparams.push(tk.value);
          segStart = false;
        }
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ',' && bdepth > 0) {
        segStart = true;
        this.next();
        continue;
      }
      this.next();
    }
    if (names.length === 0) return { type: '', name: '', typeParams: [] };
    // `*Server` → 1 NAME → type=Server, name=''. `s *Server` → 2 → name=s, type=Server.
    // `pkg.Server` → 2 → type=Server (last), name='' (qualified — receiver name not first).
    // Heuristic: if the first token (after stripping *) is a lone NAME followed by a type token,
    // the first is the receiver var name. We approximate: 2+ names with the 2nd looking like a type
    // ⇒ first is the name; 1 name ⇒ type only. For `pkg.Server` (qualified) this picks Server as the
    // type and drops pkg — acceptable since receiver types are usually in-package.
    if (names.length >= 2) {
      return { type: names[names.length - 1] ?? '', name: names[0] ?? '', typeParams: tparams };
    }
    return { type: names[0] ?? '', name: '', typeParams: tparams };
  }

  /** Parse `type Name[tparams] (struct{...}|interface{...}|= X|OtherType)` or a `type ( ... )` block. */
  private parseType(startLine: number): GoDef | GoDef[] | null {
    this.next(); // type
    if (this.isOp('(')) {
      // type block: `type ( Name1 ... ; Name2 = X ; ... )` — parse each inner decl without `type`.
      this.next();
      const defs: GoDef[] = [];
      while (!this.atEnd()) {
        if (this.isOp(')')) {
          this.next();
          break;
        }
        if (this.isOp(';')) {
          this.next();
          continue;
        }
        const d = this.parseTypeDecl(this.peek().line);
        if (d) defs.push(d);
        else if (!this.atEnd() && !this.isOp(')') && !this.isOp(';')) this.next(); // progress
      }
      return defs;
    }
    return this.parseTypeDecl(startLine);
  }

  /** Parse a single type declaration body (`type` keyword already consumed by {@link parseType}). */
  private parseTypeDecl(startLine: number): GoDef | null {
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    let typeParams: string[] = [];
    if (this.isOp('[')) typeParams = this.parseTypeParams();
    // alias: `type Name = X`
    if (this.isOp('=')) {
      this.next();
      const underlying = this.collectUntilSemi();
      return {
        kind: 'typealias',
        name,
        startLine,
        endLine: Math.max(this.peek().line, startLine),
        modifiers: [],
        annotations: [],
        bases: [],
        implements: [],
        params: [],
        typeParams,
        receiverType: '',
        receiverName: '',
        receiverTypeParams: [],
        body: [],
        interfaceMethod: false,
        returns: '',
        underlying,
        stmts: [],
      };
    }
    // struct
    if (this.isName('struct') && this.peekAheadIsOp(1, '{')) {
      this.next(); // struct
      let endLine = startLine;
      let bases: string[] = [];
      if (this.isOp('{')) {
        this.next();
        const res = this.parseStructBody();
        bases = res.bases;
        endLine = res.closeLine;
      } else if (this.isOp(';')) {
        this.next();
      }
      return {
        kind: 'struct',
        name,
        startLine,
        endLine: Math.max(endLine, startLine),
        modifiers: [],
        annotations: [],
        bases,
        implements: [],
        params: [],
        typeParams,
        receiverType: '',
        receiverName: '',
        receiverTypeParams: [],
        body: [],
        interfaceMethod: false,
        returns: '',
        underlying: '',
        stmts: [],
      };
    }
    // interface
    if (this.isName('interface') && this.peekAheadIsOp(1, '{')) {
      this.next(); // interface
      let endLine = startLine;
      let body: GoDef[] = [];
      let bases: string[] = [];
      if (this.isOp('{')) {
        this.next();
        const res = this.parseInterfaceBody(name);
        body = res.methods;
        bases = res.bases;
        endLine = res.closeLine;
      } else if (this.isOp(';')) {
        this.next();
      }
      return {
        kind: 'interface',
        name,
        startLine,
        endLine: Math.max(endLine, startLine),
        modifiers: [],
        annotations: [],
        bases,
        implements: [],
        params: [],
        typeParams,
        receiverType: '',
        receiverName: '',
        receiverTypeParams: [],
        body,
        interfaceMethod: false,
        returns: '',
        underlying: '',
        stmts: [],
      };
    }
    // typedef: `type Name OtherType` — collect the underlying type text up to `;`
    const underlying = this.collectUntilSemi();
    return {
      kind: 'typedef',
      name,
      startLine,
      endLine: Math.max(this.peek().line, startLine),
      modifiers: [],
      annotations: [],
      bases: [],
      implements: [],
      params: [],
      typeParams,
      receiverType: '',
      receiverName: '',
      receiverTypeParams: [],
      body: [],
      interfaceMethod: false,
      returns: '',
      underlying,
      stmts: [],
    };
  }

  /** Parse a struct body `{ ... }` — capture embedded field type names into `bases`; skip fields. */
  private parseStructBody(): { bases: string[]; closeLine: number } {
    const bases: string[] = [];
    let closeLine = this.peek().line;
    let seg: Token[] = [];
    while (!this.atEnd()) {
      const tk = this.peek();
      if (this.isOp('}')) {
        closeLine = tk.line;
        this.analyzeStructSegment(seg, bases);
        this.next();
        break;
      }
      if (this.isOp(';')) {
        this.analyzeStructSegment(seg, bases);
        seg = [];
        this.next();
        continue;
      }
      seg.push(tk);
      this.next();
    }
    return { bases, closeLine };
  }

  /**
   * Decide whether a `;`-delimited struct segment is an embedded field (`Base` / `*Base` /
   * `pkg.Base` / `Base[T]`, optionally followed by a struct-tag STRING) — if so push the type name
   * to `bases`. Otherwise it is a named field (`name type [tag]`) — skip.
   */
  private analyzeStructSegment(seg: Token[], bases: string[]): void {
    if (seg.length === 0) return;
    let i = 0;
    if (seg[i]!.type === 'OP' && seg[i]!.value === '*') i++;
    if (i >= seg.length || seg[i]!.type !== 'NAME') return;
    let name = seg[i]!.value;
    i++;
    // dotted qualifier `pkg.Type`
    while (
      i + 1 < seg.length &&
      seg[i]!.type === 'OP' &&
      seg[i]!.value === '.' &&
      seg[i + 1]!.type === 'NAME'
    ) {
      name = seg[i + 1]!.value;
      i += 2;
    }
    // optional type-arg list `[...]` — skip balanced
    if (i < seg.length && seg[i]!.type === 'OP' && seg[i]!.value === '[') {
      let bd = 0;
      while (i < seg.length) {
        if (seg[i]!.type === 'OP' && seg[i]!.value === '[') {
          bd++;
          i++;
        } else if (seg[i]!.type === 'OP' && seg[i]!.value === ']') {
          bd--;
          i++;
          if (bd <= 0) break;
        } else {
          i++;
        }
      }
    }
    // skip trailing struct-tag STRING(s)
    while (i < seg.length && seg[i]!.type === 'STRING') i++;
    // anything non-STRING left ⇒ this was `name type` (a field), not an embedding
    if (i < seg.length) return;
    bases.push(name);
  }

  /** Parse an interface body `{ ... }` — extract method specs + embedded interfaces. */
  private parseInterfaceBody(ifaceName: string): {
    methods: GoDef[];
    bases: string[];
    closeLine: number;
  } {
    const methods: GoDef[] = [];
    const bases: string[] = [];
    let closeLine = this.peek().line;
    // segment as parallel arrays: tokens + their original indices in the token stream (so the
    // method-spec `(` can be added to `excluded` and the call collector skips it).
    let seg: Token[] = [];
    let segIdx: number[] = [];
    let segStartLine = this.peek().line;
    while (!this.atEnd()) {
      const tk = this.peek();
      if (this.isOp('}')) {
        closeLine = tk.line;
        this.analyzeIfaceSegment(seg, segIdx, segStartLine, ifaceName, methods, bases);
        this.next();
        break;
      }
      if (this.isOp(';')) {
        this.analyzeIfaceSegment(seg, segIdx, segStartLine, ifaceName, methods, bases);
        seg = [];
        segIdx = [];
        segStartLine = this.peek().line;
        this.next();
        continue;
      }
      if (seg.length === 0) segStartLine = tk.line;
      seg.push(tk);
      segIdx.push(this.i);
      this.next();
    }
    return { methods, bases, closeLine };
  }

  /**
   * Analyze one interface segment: a method spec `Name(params) (rets)` → method def (its `(` is
   * added to `excluded` so the call collector does NOT treat `Name(` as a call); a single embedded
   * interface name `Other` / `pkg.Other` → bases; a type-set constraint (`~int`, `T | U`) → skip.
   */
  private analyzeIfaceSegment(
    seg: Token[],
    segIdx: number[],
    startLine: number,
    ifaceName: string,
    methods: GoDef[],
    bases: string[],
  ): void {
    if (seg.length === 0) return;
    // type-set constraint: leading `~` or any `|` at depth 0 ⇒ skip
    if (seg[0]!.type === 'OP' && seg[0]!.value === '~') return;
    let hasPipe = false;
    for (const tk of seg) {
      if (tk.type === 'OP' && tk.value === '|') {
        hasPipe = true;
        break;
      }
    }
    if (hasPipe) return;
    // find a `(` preceded by a NAME at depth 0 ⇒ method
    let pdepth = 0;
    let bdepth = 0;
    for (let i = 0; i < seg.length; i++) {
      const tk = seg[i]!;
      if (tk.type === 'OP' && (tk.value === '(' || tk.value === '[')) {
        if (tk.value === '(') pdepth++;
        else bdepth++;
        continue;
      }
      if (tk.type === 'OP' && (tk.value === ')' || tk.value === ']')) {
        if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
        else bdepth = Math.max(0, bdepth - 1);
        continue;
      }
      if (tk.type === 'NAME' && pdepth === 0 && bdepth === 0) {
        const next = seg[i + 1];
        if (next && next.type === 'OP' && next.value === '(') {
          // method: Name(params) [rets] — exclude the spec `(` from call collection
          this.excluded.add(segIdx[i + 1]!);
          const name = tk.value;
          const params = this.parseParamTokens(seg, i + 1);
          // return-type text: tokens after the matching `)` until end of segment
          const ret = this.collectReturnsAfter(seg, i + 1);
          methods.push({
            kind: 'method',
            name,
            startLine,
            endLine: seg[seg.length - 1]!.line,
            modifiers: [],
            annotations: [],
            bases: [],
            implements: [],
            params,
            typeParams: [],
            receiverType: '',
            receiverName: '',
            receiverTypeParams: [],
            body: [],
            interfaceMethod: true,
            returns: ret,
            underlying: '',
            stmts: [],
          });
          return;
        }
      }
    }
    // no method `(` ⇒ a single embedded interface (dotted ok): `Other` / `pkg.Other`
    let i = 0;
    if (seg[i]!.type === 'OP' && seg[i]!.value === '*') i++; // rare pointer-embedded interface
    if (i >= seg.length || seg[i]!.type !== 'NAME') return;
    let name = seg[i]!.value;
    i++;
    while (
      i + 1 < seg.length &&
      seg[i]!.type === 'OP' &&
      seg[i]!.value === '.' &&
      seg[i + 1]!.type === 'NAME'
    ) {
      name = seg[i + 1]!.value;
      i += 2;
    }
    // must consume the entire segment (no trailing type) for a clean embedding
    if (i !== seg.length) return;
    bases.push(name);
  }

  /** Parse generic type params `[T any, U comparable]` → type-param names (first NAME after `[`/`,`). */
  private parseTypeParams(): string[] {
    if (!this.isOp('[')) return [];
    this.next(); // [
    const out: string[] = [];
    let depth = 1;
    let segStart = true;
    while (!this.atEnd() && depth > 0) {
      const tk = this.peek();
      if (tk.type === 'OP' && tk.value === '[') {
        depth++;
        segStart = true;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ']') {
        depth--;
        this.next();
        continue;
      }
      if (tk.type === 'NAME' && depth === 1 && segStart) {
        out.push(tk.value);
        segStart = false;
        this.next();
        continue;
      }
      if (tk.type === 'OP' && tk.value === ',' && depth === 1) {
        segStart = true;
        this.next();
        continue;
      }
      this.next();
    }
    return out;
  }

  /**
   * Parse a parameter list from the current `(` up to its matching `)`. Go order is name-then-type
   * (the OPPOSITE of Java), with shared-type groups (`a, b int`). Heuristic per top-level comma
   * segment: collect NAMEs at depth 0 (outside `[](){}{}`); if >= 2 NAMEs, the FIRST is the param
   * name; if <= 1, treat as anonymous (no name) — lone group-name segments like `a` in `a, b int`
   * are a known acceptable loss.
   */
  private parseParamList(): string[] {
    if (!this.isOp('(')) return [];
    const openIdx = this.i;
    this.next(); // (
    // parseParamTokens is a peek-only scan (shared with analyzeIfaceSegment's slice), so it does
    // NOT advance the cursor — advance this.i past the matching `)` ourselves, tracking only `()`
    // (any `{}` inside, e.g. `interface{}` / `struct{}` params, is braces-within-parens and does
    // not affect paren balance). Without this advance, skipReturnType would re-traverse the params
    // and mistake `interface{}`'s `{` for the func body opener (losing the body).
    const params = this.parseParamTokens(this.t, openIdx);
    let pdepth = 1;
    while (!this.atEnd() && pdepth > 0) {
      if (this.isOp('(')) pdepth++;
      else if (this.isOp(')')) {
        pdepth--;
        if (pdepth === 0) {
          this.next();
          break;
        }
      }
      this.next();
    }
    return params;
  }

  /**
   * Collect param names from a token slice starting at the `(` (index `openIdx` in `tokens`).
   * Shared by {@link parseParamList} (live stream) and {@link analyzeIfaceSegment} (segment slice).
   */
  private parseParamTokens(tokens: Token[], openIdx: number): string[] {
    const params: string[] = [];
    let i = openIdx + 1;
    let pdepth = 1;
    let bdepth = 0;
    let brdepth = 0;
    let cur: Token[] = [];
    while (i < tokens.length && pdepth > 0) {
      const tk = tokens[i]!;
      if (tk.type === 'OP') {
        if (tk.value === '(') {
          pdepth++;
        } else if (tk.value === ')') {
          pdepth--;
          if (pdepth === 0) {
            this.collectParamName(cur, params);
            break;
          }
        } else if (tk.value === '[') {
          bdepth++;
        } else if (tk.value === ']') {
          bdepth = Math.max(0, bdepth - 1);
        } else if (tk.value === '{') {
          brdepth++;
        } else if (tk.value === '}') {
          brdepth = Math.max(0, brdepth - 1);
        } else if (tk.value === ',' && pdepth === 1 && bdepth === 0 && brdepth === 0) {
          this.collectParamName(cur, params);
          cur = [];
          i++;
          continue;
        }
      }
      if (pdepth === 1 && bdepth === 0 && brdepth === 0) cur.push(tk);
      i++;
    }
    return params;
  }

  /** Count NAMEs in a segment at depth 0; if >= 2, the first is the Go param name. */
  private collectParamName(seg: Token[], params: string[]): void {
    const names: string[] = [];
    let bdepth = 0;
    let pdepth = 0;
    for (const tk of seg) {
      if (tk.type === 'OP' && (tk.value === '[' || tk.value === '(' || tk.value === '{')) {
        if (tk.value === '[') bdepth++;
        else if (tk.value === '(') pdepth++;
      } else if (tk.type === 'OP' && (tk.value === ']' || tk.value === ')' || tk.value === '}')) {
        if (tk.value === ']') bdepth = Math.max(0, bdepth - 1);
        else if (tk.value === ')') pdepth = Math.max(0, pdepth - 1);
      } else if (tk.type === 'NAME' && bdepth === 0 && pdepth === 0) {
        names.push(tk.value);
      }
    }
    if (names.length >= 2) params.push(names[0]!);
  }

  /** Collect the return-type text from a segment after the method `(` index (skipping the params). */
  private collectReturnsAfter(seg: Token[], openIdx: number): string {
    // skip balanced `(...)` starting at openIdx
    let i = openIdx + 1;
    let pdepth = 1;
    while (i < seg.length && pdepth > 0) {
      const tk = seg[i]!;
      if (tk.type === 'OP' && tk.value === '(') pdepth++;
      else if (tk.type === 'OP' && tk.value === ')') pdepth--;
      i++;
    }
    return seg
      .slice(i)
      .map((tk) => tk.value)
      .join('')
      .trim();
  }

  /** Skip a func/method return type up to `{` or `;` (returns can be `T`, `*T`, `[]T`, `(a, b)`).
   *  parseParamList advances the cursor past the param `)` (see below), so this only traverses the
   *  return-type tokens — a bare `{` here is the func body opener. */
  private skipReturnType(): void {
    let pdepth = 0;
    let bdepth = 0;
    while (!this.atEnd()) {
      if (pdepth === 0 && bdepth === 0 && (this.isOp('{') || this.isOp(';'))) return;
      if (this.isOp('(')) pdepth++;
      else if (this.isOp(')')) pdepth = Math.max(0, pdepth - 1);
      else if (this.isOp('[')) bdepth++;
      else if (this.isOp(']')) bdepth = Math.max(0, bdepth - 1);
      this.next();
    }
  }

  /** Collect token values from the current position up to (not consuming) `;` or `}` or EOF. */
  private collectUntilSemi(): string {
    const parts: string[] = [];
    let pdepth = 0;
    let bdepth = 0;
    let brdepth = 0;
    while (!this.atEnd()) {
      if (pdepth === 0 && bdepth === 0 && brdepth === 0 && (this.isOp(';') || this.isOp('}')))
        break;
      if (this.isOp('(')) pdepth++;
      else if (this.isOp(')')) pdepth = Math.max(0, pdepth - 1);
      else if (this.isOp('[')) bdepth++;
      else if (this.isOp(']')) bdepth = Math.max(0, bdepth - 1);
      else if (this.isOp('{')) brdepth++;
      else if (this.isOp('}')) brdepth = Math.max(0, brdepth - 1);
      parts.push(this.peek().value);
      this.next();
    }
    // drop a trailing synthetic `;` if present
    return parts.join('').trim().replace(/;$/, '').trim();
  }

  /** Skip tokens up to and consuming the next `;` at depth 0 (for const/var/package/import). */
  private skipToSemi(): void {
    let pdepth = 0;
    let bdepth = 0;
    let brdepth = 0;
    while (!this.atEnd()) {
      if (pdepth === 0 && bdepth === 0 && brdepth === 0 && this.isOp(';')) {
        this.next();
        return;
      }
      if (this.isOp('(')) pdepth++;
      else if (this.isOp(')')) pdepth = Math.max(0, pdepth - 1);
      else if (this.isOp('[')) bdepth++;
      else if (this.isOp(']')) bdepth = Math.max(0, bdepth - 1);
      else if (this.isOp('{')) brdepth++;
      else if (this.isOp('}')) brdepth = Math.max(0, brdepth - 1);
      this.next();
    }
  }

  // --- body-statement parsing (Track 3) ---------------------------------------------------------
  // Tolerant + lossy: a malformed compound degrades to skipping its body (never throws). The body
  // parser never advances past a `{` it does not consume via {@link parseBlock}, so the top-level
  // declaration structure is unaffected — a func body parses the same `{...}` {@link skipBraces}
  // would have skipped, just structurally.

  /** Parse a `{ ... }` block (assumes current token is `{`); consumes the closing `}`. */
  private parseBlock(): { stmts: GoBodyStmt[]; closeLine: number } {
    if (!this.isOp('{')) return { stmts: [], closeLine: this.peek().line };
    this.next(); // {
    const res = this.parseStmts(false);
    return { stmts: res.stmts, closeLine: res.closeLine };
  }

  /**
   * Parse statements at one brace level until the closing `}` (consumed when `!topLevel`) or EOF.
   * `closeLine` is the 1-based line of the `}` that ended the block (0 at top level / EOF).
   */
  private parseStmts(topLevel: boolean): { stmts: GoBodyStmt[]; closeLine: number } {
    const stmts: GoBodyStmt[] = [];
    let closeLine = this.peek().line;
    while (!this.atEnd()) {
      if (this.isOp('}')) {
        closeLine = this.peek().line;
        if (!topLevel) this.next();
        break;
      }
      if (this.isOp(';') || this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.isOp('{')) {
        // bare nested block — model as a block statement carrying its inner stmts
        const line = this.peek().line;
        const blk = this.parseBlock();
        stmts.push({ kind: 'block', line, endLine: blk.closeLine, text: '', body: blk.stmts });
        continue;
      }
      const tk = this.peek();
      if (tk.type === 'NAME') {
        if (tk.value === 'if') {
          stmts.push(this.parseIf());
          continue;
        }
        if (tk.value === 'for') {
          stmts.push(this.parseFor());
          continue;
        }
        if (tk.value === 'switch') {
          stmts.push(this.parseSwitch());
          continue;
        }
        if (tk.value === 'select') {
          stmts.push(this.parseSelect());
          continue;
        }
        if (tk.value === 'return') {
          stmts.push(this.parseReturn());
          continue;
        }
        if (tk.value === 'defer') {
          stmts.push(this.parseDefer());
          continue;
        }
        // local declarations / control-flow keywords are NOT action lines — skip them.
        if (
          tk.value === 'var' ||
          tk.value === 'const' ||
          tk.value === 'type' ||
          tk.value === 'break' ||
          tk.value === 'continue' ||
          tk.value === 'fallthrough' ||
          tk.value === 'goto'
        ) {
          this.skipToSemi();
          continue;
        }
      }
      const before = this.i;
      const s = this.parseSimpleStmt();
      if (s) stmts.push(s);
      else if (this.i === before && !this.atEnd() && !this.isOp('}')) this.next(); // progress guard
    }
    return { stmts, closeLine };
  }

  /** Parse `if [init;] cond { } else if … { } else { }` as ONE chain (one condition per chain). */
  private parseIf(): GoIfStmt {
    const ifLine = this.peek().line;
    this.next(); // if
    const predicate = this.collectPredicateUntilBrace();
    // `if { … }` (no condition) is malformed Go — degrade: skip the body, emit no nodes.
    if (predicate === '' && this.isOp('{')) {
      this.skipBraces();
      return {
        kind: 'if',
        line: ifLine,
        endLine: ifLine,
        ifLine,
        predicate,
        // biome-ignore lint/suspicious/noThenProperty: GoIfStmt.then is the if-then body array, not a Promise.then.
        then: [],
        elseIfs: [],
        text: '',
      };
    }
    let then: GoBodyStmt[] = [];
    let endLine = ifLine;
    if (this.isOp('{')) {
      const blk = this.parseBlock();
      then = blk.stmts;
      endLine = blk.closeLine;
    } else {
      // malformed (no `{`) — degrade: skip to `;`, no body walked.
      this.skipToSemi();
      return {
        kind: 'if',
        line: ifLine,
        endLine: Math.max(endLine, ifLine),
        ifLine,
        predicate,
        // biome-ignore lint/suspicious/noThenProperty: GoIfStmt.then is the if-then body array, not a Promise.then.
        then: [],
        elseIfs: [],
        text: predicate,
      };
    }
    const elseIfs: { line: number; predicate: string; body: GoBodyStmt[] }[] = [];
    let elseBody: GoBodyStmt[] | undefined;
    // `} else {` / `} else if … {` — Go requires `else` on the same line as the closing `}`, so no
    // synthetic `;` separates them. Loop to chain consecutive `else if` clauses.
    while (this.isName('else')) {
      this.next(); // else
      if (this.isName('if')) {
        const elifLine = this.peek().line;
        this.next(); // if
        const pred = this.collectPredicateUntilBrace();
        let body: GoBodyStmt[] = [];
        if (this.isOp('{')) {
          const blk = this.parseBlock();
          body = blk.stmts;
          endLine = blk.closeLine;
        } else {
          this.skipToSemi();
        }
        elseIfs.push({ line: elifLine, predicate: pred, body });
      } else if (this.isOp('{')) {
        const blk = this.parseBlock();
        elseBody = blk.stmts;
        endLine = blk.closeLine;
        break;
      } else {
        // malformed else — stop chain.
        break;
      }
    }
    return {
      kind: 'if',
      line: ifLine,
      endLine,
      ifLine,
      predicate,
      then,
      elseIfs,
      ...(elseBody ? { elseBody } : {}),
      text: predicate,
    };
  }

  /** Parse `for [init;] [cond;] [post] { }` / `for range x { }` / `for { }`. */
  private parseFor(): GoForStmt {
    const forLine = this.peek().line;
    this.next(); // for
    const predicate = this.collectPredicateUntilBrace();
    let body: GoBodyStmt[] = [];
    let endLine = forLine;
    if (this.isOp('{')) {
      const blk = this.parseBlock();
      body = blk.stmts;
      endLine = blk.closeLine;
    } else {
      this.skipToSemi();
    }
    return { kind: 'for', line: forLine, endLine, forLine, predicate, body, text: predicate };
  }

  /** Parse `switch [expr] { case …: default: }`. */
  private parseSwitch(): GoSwitchStmt {
    const switchLine = this.peek().line;
    this.next(); // switch
    const predicate = this.collectPredicateUntilBrace();
    const cases = this.parseCases();
    let endLine = switchLine;
    if (this.i > 0 && this.t[this.i - 1]?.type === 'OP' && this.t[this.i - 1]?.value === '}')
      endLine = this.t[this.i - 1]!.line;
    return {
      kind: 'switch',
      line: switchLine,
      endLine,
      switchLine,
      predicate,
      cases,
      text: predicate,
    };
  }

  /** Parse `select { case …: default: }`. */
  private parseSelect(): GoSelectStmt {
    const selectLine = this.peek().line;
    this.next(); // select
    const cases = this.parseCases();
    let endLine = selectLine;
    if (this.i > 0 && this.t[this.i - 1]?.type === 'OP' && this.t[this.i - 1]?.value === '}')
      endLine = this.t[this.i - 1]!.line;
    return { kind: 'select', line: selectLine, endLine, selectLine, cases, text: 'select' };
  }

  /** Parse the `{ case …: … default: … }` clause list of a switch/select (assumes current is `{`). */
  private parseCases(): GoCaseClause[] {
    const cases: GoCaseClause[] = [];
    if (!this.isOp('{')) return cases;
    this.next(); // {
    while (!this.atEnd()) {
      if (this.isOp('}')) {
        this.next();
        break;
      }
      if (this.isOp(';')) {
        this.next();
        continue;
      }
      if (this.isName('case') || this.isName('default')) {
        const isDefault = this.isName('default');
        const caseLine = this.peek().line;
        this.next(); // case/default
        let predicate: string | undefined;
        if (!isDefault) {
          predicate = this.collectPredicateUntilColon();
        } else if (this.isOp(':')) {
          this.next();
        }
        const body = this.collectCaseBody();
        cases.push({
          line: caseLine,
          ...(predicate !== undefined && predicate !== '' ? { predicate } : {}),
          isDefault,
          body,
        });
        continue;
      }
      // stray token in switch/select body — skip (progress guard)
      this.next();
    }
    return cases;
  }

  /** Collect a case predicate until the `:` at depth 0 (or `;`/`}` if malformed). */
  private collectPredicateUntilColon(): string {
    const run: Token[] = [];
    let pdepth = 0;
    let bdepth = 0;
    let brdepth = 0;
    while (!this.atEnd()) {
      if (pdepth === 0 && bdepth === 0 && brdepth === 0 && this.isOp(':')) {
        this.next();
        break;
      }
      if (pdepth === 0 && bdepth === 0 && brdepth === 0 && (this.isOp(';') || this.isOp('}')))
        break;
      if (this.isOp('(')) pdepth++;
      else if (this.isOp(')')) pdepth = Math.max(0, pdepth - 1);
      else if (this.isOp('[')) bdepth++;
      else if (this.isOp(']')) bdepth = Math.max(0, bdepth - 1);
      else if (this.isOp('{')) brdepth++;
      else if (this.isOp('}')) brdepth = Math.max(0, brdepth - 1);
      run.push(this.peek());
      this.next();
    }
    return this.tokensText(run);
  }

  /** Parse a case body until the next `case`/`default`/`}` at this switch level. */
  private collectCaseBody(): GoBodyStmt[] {
    const stmts: GoBodyStmt[] = [];
    while (!this.atEnd()) {
      if (this.isOp('}')) break;
      if (this.isName('case') || this.isName('default')) break;
      if (this.isOp(';') || this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.isOp('{')) {
        const line = this.peek().line;
        const blk = this.parseBlock();
        stmts.push({ kind: 'block', line, endLine: blk.closeLine, text: '', body: blk.stmts });
        continue;
      }
      const tk = this.peek();
      if (tk.type === 'NAME') {
        if (tk.value === 'if') {
          stmts.push(this.parseIf());
          continue;
        }
        if (tk.value === 'for') {
          stmts.push(this.parseFor());
          continue;
        }
        if (tk.value === 'switch') {
          stmts.push(this.parseSwitch());
          continue;
        }
        if (tk.value === 'select') {
          stmts.push(this.parseSelect());
          continue;
        }
        if (tk.value === 'return') {
          stmts.push(this.parseReturn());
          continue;
        }
        if (tk.value === 'defer') {
          stmts.push(this.parseDefer());
          continue;
        }
        if (
          tk.value === 'var' ||
          tk.value === 'const' ||
          tk.value === 'type' ||
          tk.value === 'break' ||
          tk.value === 'continue' ||
          tk.value === 'fallthrough' ||
          tk.value === 'goto'
        ) {
          this.skipToSemi();
          continue;
        }
      }
      const before = this.i;
      const s = this.parseSimpleStmt();
      if (s) stmts.push(s);
      else if (this.i === before && !this.atEnd() && !this.isOp('}')) this.next();
    }
    return stmts;
  }

  /** Parse `return [expr]`. */
  private parseReturn(): GoReturnStmt {
    const line = this.peek().line;
    this.next(); // return
    const { text, callee, isPanic } = this.collectSimpleUntilSemi();
    // `return panic(...)` is not valid Go, but if a panic appears, model the return as a throw.
    if (isPanic) {
      return { kind: 'return', line, endLine: this.peek().line, text };
    }
    return {
      kind: 'return',
      line,
      endLine: this.peek().line,
      ...(text ? { expr: text } : {}),
      ...(callee ? { callee } : {}),
      text,
    };
  }

  /**
   * Parse `defer …` — two forms:
   *   1. `defer func() (rets) { body }()` — a deferred func literal. The body is parsed as a block
   *      and scanned for a `recover()` call (`hasRecover`); the extractor emits an
   *      `exception-handler` node when hasRecover is true (Go's closest catch analog).
   *   2. `defer f()` / `defer pkg.F()` — a deferred bare/dotted call; modeled as a `call` statement
   *      (preserves the pre-1.2 behavior — defer prefixes a call, the call is the action).
   */
  private parseDefer(): GoBodyStmt {
    const line = this.peek().line;
    this.next(); // defer
    if (this.isName('func')) {
      this.next(); // func
      if (this.isOp('(')) {
        // the func-literal param `(` is NOT a call — exclude it from collectCallSites.
        this.excluded.add(this.i);
        this.parseParamList();
      }
      this.skipReturnType();
      if (this.isOp('{')) {
        const bodyStartIdx = this.i; // at `{` — capture for recover() scan
        const blk = this.parseBlock();
        const bodyEndIdx = this.i; // after `}`
        // skip the trailing `()` that invokes the func literal
        if (this.isOp('(')) this.skipBalancedParens();
        const hasRecover = this.rangeHasRecover(bodyStartIdx, bodyEndIdx);
        return {
          kind: 'defer',
          line,
          endLine: blk.closeLine,
          text: '',
          body: blk.stmts,
          hasRecover,
          isFuncLiteral: true,
        };
      }
      // malformed func literal — degrade: no body, no recover.
      return {
        kind: 'defer',
        line,
        endLine: line,
        text: '',
        body: [],
        hasRecover: false,
        isFuncLiteral: false,
      };
    }
    // defer of a bare/dotted call — collect the rest as a simple statement (sans the leading defer).
    const { text, callee, hasAssign } = this.collectSimpleUntilSemi();
    if (callee && !hasAssign) {
      return { kind: 'call', line, endLine: this.peek().line, callee, text };
    }
    // defer of a non-call (rare/malformed) — model as an empty defer so the walker drops it.
    return {
      kind: 'defer',
      line,
      endLine: this.peek().line,
      text,
      body: [],
      hasRecover: false,
      isFuncLiteral: false,
    };
  }

  /** Scan tokens [start, end) for a `recover` NAME immediately followed by a `(` OP (depth-blind). */
  private rangeHasRecover(start: number, end: number): boolean {
    for (let i = start; i < end && i < this.t.length; i++) {
      const tk = this.t[i]!;
      if (tk.type === 'NAME' && tk.value === 'recover') {
        const nx = this.t[i + 1];
        if (nx && nx.type === 'OP' && nx.value === '(') return true;
      }
    }
    return false;
  }

  /** Parse a simple (non-compound) statement: call / assign / panic / bare expression. */
  private parseSimpleStmt(): GoBodyStmt | null {
    const line = this.peek().line;
    const before = this.i;
    const { text, callee, hasAssign, isPanic, lhs } = this.collectSimpleUntilSemi();
    if (this.i === before) return null; // nothing consumed — let caller advance
    const endLine = this.peek().line;
    if (isPanic) {
      return { kind: 'throw', line, endLine: Math.max(endLine, line), head: 'panic', text };
    }
    if (callee && !hasAssign) {
      return { kind: 'call', line, endLine: Math.max(endLine, line), callee, text };
    }
    if (callee && hasAssign) {
      return {
        kind: 'assign',
        line,
        endLine: Math.max(endLine, line),
        ...(lhs ? { target: lhs } : {}),
        ...(callee ? { callee } : {}),
        text,
      };
    }
    if (hasAssign) {
      return {
        kind: 'assign',
        line,
        endLine: Math.max(endLine, line),
        ...(lhs ? { target: lhs } : {}),
        text,
      };
    }
    if (callee) {
      return {
        kind: 'expr',
        line,
        endLine: Math.max(endLine, line),
        ...(callee ? { callee } : {}),
        text,
      };
    }
    // plain expression with no call — skip (keep the graph lean).
    return null;
  }

  /**
   * Collect a simple-statement token run until `;` (or `}`/EOF at depth 0), classifying it. Detects a
   * leading `defer`/`go` prefix, an assignment operator (`:=`/`=`/`+=`/…), a `panic` head, the LHS
   * target of an assignment, and the first call expression (`NAME (.NAME)* (`) for the body-walk's
   * intra-file resolution.
   */
  private collectSimpleUntilSemi(): {
    text: string;
    callee?: GoCallee;
    hasAssign: boolean;
    isPanic: boolean;
    lhs: string;
  } {
    const run: Token[] = [];
    let pdepth = 0;
    let bdepth = 0;
    let brdepth = 0;
    let hasAssign = false;
    let isPanic = false;
    let lhs = '';
    // a leading `defer`/`go` prefixes a call — skip it so the call is the statement's action.
    // (`defer` of a func literal is handled earlier by parseDefer; this path only sees defer of a
    //  bare/dotted call, which still prefixes a call statement.)
    if (this.isName('defer') || this.isName('go')) this.next();
    if (this.isName('panic')) isPanic = true;
    while (!this.atEnd()) {
      if (pdepth === 0 && bdepth === 0 && brdepth === 0 && this.isOp(';')) {
        this.next();
        break;
      }
      if (pdepth === 0 && bdepth === 0 && brdepth === 0 && this.isOp('}')) break; // end of block
      if (this.isOp('(')) pdepth++;
      else if (this.isOp(')')) pdepth = Math.max(0, pdepth - 1);
      else if (this.isOp('[')) bdepth++;
      else if (this.isOp(']')) bdepth = Math.max(0, bdepth - 1);
      else if (this.isOp('{')) brdepth++;
      else if (this.isOp('}')) brdepth = Math.max(0, brdepth - 1);
      else if (
        pdepth === 0 &&
        bdepth === 0 &&
        brdepth === 0 &&
        this.peek().type === 'OP' &&
        ASSIGN_OPS.has(this.peek().value)
      ) {
        hasAssign = true;
        // capture the LHS text (tokens before the assignment operator) once
        if (!lhs) lhs = this.tokensText(run);
      }
      run.push(this.peek());
      this.next();
    }
    const text = this.tokensText(run).slice(0, EXPR_MAX_CHARS);
    const callee = isPanic ? undefined : this.findCallInRun(run);
    return { text, ...(callee ? { callee } : {}), hasAssign, isPanic, lhs };
  }

  /**
   * Collect a predicate token run until `{` at depth 0, splitting on `;` (the Go if/for init). For a
   * 3-part `for` header (`init; cond; post`) the continuation CONDITION is the middle part; for an
   * `if x := f(); cond` the predicate is the part after the init `;`; with no `;` the whole run is
   * the predicate. Best-effort — never throws.
   */
  private collectPredicateUntilBrace(): string {
    const run: Token[] = [];
    const semiAt: number[] = []; // indices in `run` where a depth-0 `;` was skipped
    let pdepth = 0;
    let bdepth = 0;
    while (!this.atEnd()) {
      if (pdepth === 0 && bdepth === 0 && this.isOp('{')) break;
      if (pdepth === 0 && bdepth === 0 && this.isOp('}')) break; // malformed
      if (pdepth === 0 && bdepth === 0 && this.isOp(';')) {
        semiAt.push(run.length);
        this.next();
        continue;
      }
      if (this.isOp('(')) pdepth++;
      else if (this.isOp(')')) pdepth = Math.max(0, pdepth - 1);
      else if (this.isOp('[')) bdepth++;
      else if (this.isOp(']')) bdepth = Math.max(0, bdepth - 1);
      run.push(this.peek());
      this.next();
    }
    let predTokens: Token[];
    if (semiAt.length >= 2) {
      // 3-part for: predicate is the cond (between the first and second `;`).
      predTokens = run.slice(semiAt[0]!, semiAt[1]!);
    } else if (semiAt.length === 1) {
      // if-init `x := f(); cond` — predicate is after the `;`.
      predTokens = run.slice(semiAt[0]!);
    } else {
      predTokens = run;
    }
    return this.tokensText(predTokens);
  }

  /** Find the first `NAME (.NAME)* (` call expression at depth 0 in a token run (best-effort). */
  private findCallInRun(run: Token[]): GoCallee | undefined {
    let i = 0;
    while (i < run.length) {
      const tk = run[i]!;
      if (tk.type !== 'NAME') {
        i++;
        continue;
      }
      const chain: string[] = [tk.value];
      let j = i + 1;
      while (
        j + 1 < run.length &&
        run[j]!.type === 'OP' &&
        run[j]!.value === '.' &&
        run[j + 1]!.type === 'NAME'
      ) {
        chain.push(run[j + 1]!.value);
        j += 2;
      }
      if (j < run.length && run[j]!.type === 'OP' && run[j]!.value === '(') {
        return {
          head: chain[0]!,
          tail: chain.slice(1),
          name: chain[chain.length - 1]!,
          line: tk.line,
        };
      }
      i++;
    }
    return undefined;
  }

  /** Exact best-effort source text for a token run (sliced from the original source by line/col). */
  private tokensText(run: Token[]): string {
    if (run.length === 0) return '';
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const startOff = this.offsetOf(first.line, first.col);
    const endOff = this.offsetOf(last.line, last.col) + last.value.length;
    return this.src.slice(startOff, Math.max(endOff, startOff)).trim();
  }

  /** Code-unit offset of a 1-based (line, col) in the source. */
  private offsetOf(line: number, col: number): number {
    return this.lineStarts[Math.max(0, line - 1)]! + (col - 1);
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

  // --- token helpers -------------------------------------------------------------

  private isOp(v: string): boolean {
    return this.peek().type === 'OP' && this.peek().value === v;
  }
  private isName(v: string): boolean {
    return this.peek().type === 'NAME' && this.peek().value === v;
  }
  private isNameToken(): boolean {
    return this.peek().type === 'NAME';
  }
  /** Is the token at `offset` ahead an OP with value `v`? */
  private peekAheadIsOp(offset: number, v: string): boolean {
    const tk = this.t[this.i + offset];
    return tk?.type === 'OP' && tk.value === v;
  }
  private next(): Token {
    const tk = this.t[this.i] ?? { type: 'EOF', value: '', line: 0, col: 0 };
    if (this.i < this.t.length) this.i++;
    return tk;
  }
  private peek(): Token {
    return this.t[this.i] ?? { type: 'EOF', value: '', line: 0, col: 0 };
  }
  private atEnd(): boolean {
    return this.i >= this.t.length || this.peek().type === 'EOF';
  }
}

/**
 * Assignment operators (simple + compound). `==`/`<=`/`>=`/`!=`/`<-` are distinct OP tokens, so they
 * never match here. Used by collectSimpleUntilSemi to detect an assignment statement + its LHS.
 */
const ASSIGN_OPS = new Set<string>([
  ':=',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '&^=',
  '<<=',
  '>>=',
]);

/**
 * Hard-reserved keywords that can NEVER be a declaration name (control flow + literals). Go's
 * contextual identifiers (`any`, `comparable`, predeclared types like `int`) ARE valid as names in
 * some contexts and are excluded so a func/type named e.g. `func len(...)` is still parsed — but
 * `func`/`type`/`return`/`if`/etc. cannot be a name.
 */
const HARD_KEYWORDS = new Set<string>([
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
  'true',
  'false',
  'nil',
  'iota',
]);

/**
 * Scan the token stream for call expressions `NAME (.NAME)* (` whose `(` is NOT a definition /
 * receiver / annotation arg-list (excluded set). Composite literals `Type{...}` / `&Type{...}` use
 * `{`, not `(`, so they never produce a call here — they are dropped (construction; the resolver
 * does not pick them up either, honest). Method calls `obj.m()` and package calls `pkg.F()` are
 * captured as call sites; the EXTRACTOR resolves only bare-name calls to same-file top-level
 * funcs/types (byKey) and drops dotted calls; the RESOLVER resolves `pkg.F()` to a cross-file
 * top-level symbol when `pkg` is an imported binding.
 */
export function collectCallSites(tokens: Token[], excluded: Set<number>): GoCallSite[] {
  const calls: GoCallSite[] = [];
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

/** Scan the token stream for `package name;` and `import [alias] "path";` / `import ( ... )`. */
export function collectImports(tokens: Token[]): { pkg: string; imports: GoImport[] } {
  const imports: GoImport[] = [];
  let pkg = '';
  let i = 0;
  const isOp = (k: number, v: string) => tokens[k]?.type === 'OP' && tokens[k]?.value === v;
  const isName = (k: number, v: string) => tokens[k]?.type === 'NAME' && tokens[k]?.value === v;

  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME') {
      i++;
      continue;
    }
    if (tk.value === 'package') {
      const nm = tokens[i + 1];
      if (nm?.type === 'NAME') pkg = nm.value;
      i += 2;
      continue;
    }
    if (tk.value === 'import') {
      let j = i + 1;
      if (isOp(j, '(')) {
        // paren block: `import ( [alias] "path" ; ... )`
        j++;
        while (j < tokens.length && !isOp(j, ')')) {
          if (isOp(j, ';') || isOp(j, ',')) {
            j++;
            continue;
          }
          const res = readImport(tokens, j);
          if (res) {
            imports.push(res.imp);
            j = res.next;
          } else {
            j++;
          }
        }
        if (isOp(j, ')')) j++;
        i = j;
        continue;
      }
      const res = readImport(tokens, j);
      if (res) {
        imports.push(res.imp);
        i = res.next;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { pkg, imports };
}

/** Read a single import spec `[alias|.|_] "path"` starting at index `i`; returns the import + next index. */
function readImport(tokens: Token[], i: number): { imp: GoImport; next: number } | undefined {
  let j = i;
  let alias = '';
  const line = tokens[i]?.line ?? 0;
  const tk = tokens[j];
  if (!tk) return undefined;
  if (tk.type === 'NAME') {
    alias = tk.value; // real alias: `import f "fmt"`
    j++;
  } else if (tk.type === 'OP' && tk.value === '.') {
    alias = '.'; // dot import: `import . "fmt"`
    j++;
  } else if (tk.type === 'OP' && tk.value === '_') {
    alias = '_'; // blank import: `import _ "fmt"`
    j++;
  }
  const strTok = tokens[j];
  if (!strTok || strTok.type !== 'STRING') return undefined;
  const module = stripQuotes(strTok.value);
  j++;
  const lastSeg = module.split('/').pop() ?? module;
  const name = lastSeg || module;
  const binding = alias === '' ? name : alias; // plain import binds the package name (last segment)
  return {
    imp: { module, name, alias: binding, line },
    next: j,
  };
}

/** Strip surrounding quotes/backticks from a string-literal token value. */
function stripQuotes(v: string): string {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1);
  if (v.length >= 2 && v[0] === '`' && v[v.length - 1] === '`') return v.slice(1, -1);
  return v;
}
