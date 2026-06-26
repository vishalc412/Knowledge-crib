/**
 * Java structural parser (M8-style) — turns the token stream into a declaration tree (class /
 * interface / enum / record / method / constructor) plus a flat list of call sites + imports + the
 * package path. NOT a full expression parser: the symbol graph only needs declaration spans + nesting
 * (member-of + qualified names) and call-site heads (for `calls`), so a tolerant brace-level descent
 * is enough.
 *
 * Field declarations are intentionally NOT emitted as symbols (parity with the Python extractor's
 * altitude: classes + functions + methods, not attributes); their call sites ARE still captured by
 * the whole-stream call collector. Local/anonymous classes inside method bodies are not extracted
 * (method bodies are consumed, not descended) — an honest, documented limitation.
 *
 * Generic angle-bracket balancing uses the Java lexer split rule (`>>`/`>>>` close 2/3 open `<`s) so
 * `List<Map<K,V>>` headers are skipped without mistaking a `>` inside a type for a comparison.
 */
import { isModifier } from './lexer.js';
import { tokenize } from './lexer.js';
import type { Token } from './lexer.js';

export type JavaKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'record'
  | 'method'
  | 'constructor'
  | 'field';

/** An annotation with its raw argument text (1.3 framework-semantics): `@GetMapping("/x")` →
 *  {name:'GetMapping', args:'"/x"'}; `@RestController` → {name:'RestController'}. */
export interface JavaAnno {
  name: string;
  /** raw text inside the annotation's `(...)`, trimmed; undefined for a marker annotation. */
  args?: string;
}

export interface JavaDef {
  kind: JavaKind;
  name: string;
  /** 1-based line of the first token of the declaration (leading annotation/modifier). */
  startLine: number;
  /** 1-based line of the declaration's last token (closing `}` for types, `}`/`;` for methods). */
  endLine: number;
  modifiers: string[];
  /** annotation simple names preceding the declaration (`@RestController` → ["RestController"]). */
  annotations: string[];
  /** 1.3: annotations WITH their argument text — the route paths / HTTP methods / DI qualifiers a
   *  framework-semantics extractor needs. Parallel to `annotations` (same order). */
  annos?: JavaAnno[];
  /** 1.3: for a `field` def, the declared type head — the LAST dotted segment of the declared type
   *  before the field name (`UserRepo userRepo` → "UserRepo"; `com.example.UserRepo r` → "UserRepo";
   *  `java.util.List<User> users` → "List"). The DI layer keys on this (the injected bean type). */
  fieldType?: string;
  /** 1.3: for a `field` def whose declared type is a parameterized collection
   *  (`List<User> users` → "User"; `Set<Tag> tags` → "Tag"; `Map<K,V> m` → "V" — last generic arg),
   *  the generic element/value type — the related type for a JPA `@OneToMany`/`@ManyToMany` field.
   *  Undefined for non-generic fields. */
  fieldElementType?: string;
  /** 1.3: parameter type heads, parallel to `params` (the DI graph reads constructor param types). */
  paramTypes?: string[];
  /** 1.3: per-parameter annotation simple names, parallel to `params`/`paramTypes`. The Spring
   *  route-param contract reads these — `@PathVariable String id, @RequestBody Loan loan` →
   *  [['PathVariable'], ['RequestBody']]. Empty arrays for unannotated params. */
  paramAnnos?: string[][];
  /** 1.3: for a `method` def, the declared return-type head — the LAST dotted segment of the return
   *  type before the method name (`Payment make()` → "Payment"; `List<Payment> all()` → "List"). The
   *  @Bean producer graph reads this — a `@Bean`-annotated method PRODUCES its return type. */
  returnType?: string;
  /** 1.3: for a `method` def whose return type is a parameterized collection
   *  (`List<Payment> all()` → "Payment"; `Map<K,V> m()` → "V" — last generic arg), the generic element
   *  type — the produced type for a collection-returning `@Bean`. Undefined for non-generic returns. */
  returnElementType?: string;
  /** `extends` head names — INHERITS targets (`class C extends B` → ["B"]; interface `extends A,B`). */
  bases: string[];
  /** `implements` head names — IMPLEMENTS targets (`class C implements I1, I2`). */
  implements: string[];
  /** parameter names (methods / constructors / records). */
  params: string[];
  /** nested TYPE declarations only (methods/fields are not recursed). */
  body: JavaDef[];
  /**
   * Compound-statement tree for a method/constructor body (Track 3). Empty for types, fields, and
   * abstract methods. Tolerant + lossy: a malformed compound degrades to skipping its body.
   */
  stmts: JavaStmt[];
}

// ---------------------------------------------------------------------------------------------
// Statement tree (Track 3) — a tolerant, lossy view of a method body's compound statements.
// Captured so the extractor can walk it with a guard stack and emit condition/statement/executes
// /guarded-by edges. Predicate text is best-effort (a source-text slice). Never throws.
// ---------------------------------------------------------------------------------------------

export type JavaStmtKind =
  | 'if'
  | 'for'
  | 'while'
  | 'do'
  | 'switch'
  | 'try'
  | 'return'
  | 'throw'
  | 'call'
  | 'expr'
  | 'assign';

/** One branch of an if-chain (then / else-if / else). */
export interface JavaIfBranch {
  /** 'then' | 'elseif' | 'else'. */
  role: 'then' | 'elseif' | 'else';
  /** predicate source text (undefined for `else`). */
  predicate?: string;
  /** 1-based line of the branch's `if`/`else if`/`else` keyword. */
  line: number;
  body: JavaStmt[];
}

/** One `case`/`default` arm of a switch. */
export interface JavaCase {
  /** `case X:` predicate text; undefined for `default`. */
  predicate?: string;
  /** 1-based line of the `case`/`default` label. */
  line: number;
  body: JavaStmt[];
}

/** One `catch` handler of a try. */
export interface JavaCatch {
  /** exception type + var text, best-effort; undefined for `finally`. */
  predicate?: string;
  line: number;
  body: JavaStmt[];
}

export interface JavaStmt {
  kind: JavaStmtKind;
  /** 1-based line of the statement's first token. */
  startLine: number;
  /** 1-based line of the statement's last token (before the terminating `;`/`}`). */
  endLine: number;
  /** source text of the statement (best-effort, for return/throw/call/expr). */
  text?: string;
  /** for a call/return/throw that contains a call: the callee chain (`obj.m` → ["obj","m"]). */
  callChain?: string[];
  /** for if: branches (then + elseif* + else?). */
  branches?: JavaIfBranch[];
  /** for loops: predicate text + line. */
  predicate?: string;
  predicateLine?: number;
  /** loop body. */
  body?: JavaStmt[];
  /** for switch: cases. */
  cases?: JavaCase[];
  /** for try: body + catches + finally. */
  tryBody?: JavaStmt[];
  catches?: JavaCatch[];
  finallyBody?: JavaStmt[];
  /** for assign: the LHS target text (`lhs = rhs` → "lhs"). */
  assignTarget?: string;
}

export interface JavaCallSite {
  /** callee head: a bare name or the first segment of a dotted chain. */
  head: string;
  /** dotted tail after the head (`Collections.sort` → ["sort"]). */
  tail: string[];
  /** last segment — the function/method name being invoked. */
  name: string;
  /** 1-based line of the call's opening `(`. */
  line: number;
}

export interface JavaImport {
  /** dotted module path as written (`a.b` / `a.b.C` for static); the package the import brings in. */
  module: string;
  /** simple name bound locally (`import a.b.C` → "C"; `.*` → ""). */
  name: string;
  /** `.*` wildcard. */
  star: boolean;
  /** `import static`. */
  static: boolean;
  line: number;
}

export interface JavaModule {
  defs: JavaDef[];
  calls: JavaCallSite[];
  imports: JavaImport[];
  /** dotted package path (`package a.b;`), or "" if absent. */
  pkg: string;
}

/** Parse Java source into a declaration tree + call sites + imports + package (never throws). */
export function parseJava(src: string): JavaModule {
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
  /** char offset of the start of each 1-based line (lineStarts[0] = 0 = start of line 1). */
  private readonly lineStarts: number[];
  private i = 0;
  /** token indices of definition / annotation `(` openers — call sites at these indices are NOT calls. */
  private readonly excluded = new Set<number>();

  constructor(tokens: Token[], src: string) {
    this.t = tokens;
    this.src = src;
    this.lineStarts = computeLineStarts(src);
  }

  parseProgram(): { defs: JavaDef[]; excluded: Set<number> } {
    const { defs } = this.parseDecls(true);
    return { defs, excluded: this.excluded };
  }

  /**
   * Parse declarations at one brace level. `topLevel` ⇒ stop at EOF (a stray `}` is left).
   * Returns the nested defs plus `closeLine` — the 1-based line of the closing `}` that ended a
   * non-top-level block (0 for top level), used to size the enclosing type's `endLine`.
   */
  private parseDecls(topLevel: boolean): { defs: JavaDef[]; closeLine: number } {
    const defs: JavaDef[] = [];
    let closeLine = 0;
    while (!this.atEnd()) {
      if (this.isOp('}')) {
        closeLine = this.peek().line;
        if (!topLevel) this.next();
        break;
      }
      if (this.isOp('{')) {
        // bare block (array init / stray initializer) — skip it.
        this.skipBraces();
        continue;
      }
      if (this.isOp(';') || this.isOp(',')) {
        this.next(); // stray terminator
        continue;
      }
      // `package a.b;` / `import [static] a.b.C [. *];` are NOT declarations — collectImports scans
      // them separately. Skip to the terminating `;` so they never become spurious top-level `field`
      // defs (which would pollute the resolver's FQN→file map and the extractor's byKey).
      if (this.isName('package') || this.isName('import')) {
        while (!this.atEnd() && !this.isOp(';')) this.next();
        if (!this.atEnd()) this.next(); // consume `;`
        continue;
      }
      const before = this.i;
      const d = this.parseDecl();
      if (d) defs.push(d);
      else if (this.i === before && !this.atEnd()) this.next(); // progress guard
    }
    return { defs, closeLine };
  }

  /** Parse one declaration; returns a def (type / method / constructor) or null (field / init / skip). */
  private parseDecl(): JavaDef | null {
    const startLine = this.peek().line;
    const annotations: string[] = [];
    const annos: JavaAnno[] = [];
    const modifiers: string[] = [];
    // consume leading annotations + modifiers (they may interleave)
    while (!this.atEnd()) {
      if (this.isOp('@')) {
        this.consumeAnnotation(annotations, annos);
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
    if (this.isName('class'))
      return this.parseType('class', startLine, annotations, modifiers, annos);
    if (this.isName('interface'))
      return this.parseType('interface', startLine, annotations, modifiers, annos);
    if (this.isName('enum'))
      return this.parseType('enum', startLine, annotations, modifiers, annos);
    if (this.isName('record'))
      return this.parseType('record', startLine, annotations, modifiers, annos);
    return this.parseMember(startLine, annotations, modifiers, annos);
  }

  /** Parse a type declaration (class / interface / enum / record) + recurse into its body. */
  private parseType(
    kind: 'class' | 'interface' | 'enum' | 'record',
    startLine: number,
    annotations: string[],
    modifiers: string[],
    annos: JavaAnno[] = [],
  ): JavaDef | null {
    this.next(); // kind keyword
    // a type name must be a NAME that is NOT a hard-reserved keyword (`class void {` is malformed).
    if (!this.isNameToken() || HARD_KEYWORDS.has(this.peek().value)) return null;
    const name = this.peek().value;
    this.next();
    this.skipGenericAngle(); // type params <T extends ...>

    const bases: string[] = [];
    const impls: string[] = [];
    // record has params before extends/implements: `record Name(TYPE p) implements I {}`. A record's
    // header params ARE its canonical constructor — Spring treats a single-ctor bean's compact ctor as
    // an autowire point — so capture BOTH names (params) and type heads (paramTypes) for the DI graph.
    // Pre-fix this used parseParamList (names only), so `@Service record Tx(Repo r)` got zero injects.
    let params: string[] = [];
    let paramTypes: string[] | undefined;
    if (kind === 'record' && this.isOp('(')) {
      const typed = this.parseParamListTyped();
      params = typed.map((p) => p.name);
      paramTypes = typed.map((p) => p.type ?? '');
    }
    // extends / implements clauses (order: extends then implements)
    while (!this.atEnd() && !this.isOp('{') && !this.isOp(';')) {
      if (this.isName('extends')) {
        this.next();
        bases.push(...this.parseDottedNameList(['implements']));
        continue;
      }
      if (this.isName('implements')) {
        this.next();
        impls.push(...this.parseDottedNameList([]));
        continue;
      }
      this.next(); // tolerate stray tokens in the header
    }

    let body: JavaDef[] = [];
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
      annotations,
      annos,
      bases,
      implements: impls,
      params,
      ...(paramTypes ? { paramTypes } : {}),
      body,
      stmts: [],
    };
  }

  /**
   * Parse a member that is not a type: a method, a constructor, or (skipped) a field / init block.
   * Scans the header tracking generic/paren/bracket depth to find the declared name and decide
   * method-vs-constructor (≥2 NAMEs at depth 0 before `(` ⇒ method; exactly 1 ⇒ constructor).
   */
  private parseMember(
    startLine: number,
    annotations: string[],
    modifiers: string[],
    annos: JavaAnno[] = [],
  ): JavaDef | null {
    let gdepth = 0;
    let pdepth = 0;
    let bdepth = 0;
    let nameCount = 0;
    let firstName: string | undefined;
    let lastName: string | undefined;
    // 1.3: `prevLastName` is the depth-0 name immediately before the field name — the declared
    // type's simple head (`UserService service` → "UserService"; `com.acme.X x` → "X"). More
    // accurate than `firstName` (the FIRST name, which is `com` for a dotted type). `elementType`
    // is the last NAME inside the type's generics (`List<Payment>` → "Payment") — the related type
    // for a JPA collection-valued association. Both are captured during the type scan, before the
    // field name (which is the final depth-0 name).
    let prevLastName: string | undefined;
    let elementType: string | undefined;
    let kind: 'method' | 'constructor' | 'field' | 'init' = 'field';

    while (!this.atEnd()) {
      const tk = this.peek();
      if (pdepth === 0 && gdepth === 0 && bdepth === 0) {
        if (this.isOp('(')) {
          kind = nameCount >= 2 ? 'method' : 'constructor';
          break;
        }
        if (this.isOp(';') || this.isOp('=') || this.isOp(',')) {
          kind = 'field';
          break;
        }
        if (this.isOp('{')) {
          kind = 'init';
          break;
        }
        if (this.isOp('}')) return null; // end of enclosing block — caller handles
      }
      if (tk.type === 'NAME') {
        if (pdepth === 0 && gdepth === 0 && bdepth === 0) {
          nameCount++;
          if (firstName === undefined) firstName = tk.value;
          prevLastName = lastName; // type-head candidate = the name before the field name
          lastName = tk.value;
        } else if (pdepth === 0 && gdepth >= 1) {
          elementType = tk.value; // last name inside the type's generics (the element / value type)
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

    if (kind === 'field') {
      const fieldLine = this.peek().line;
      this.consumeField();
      // 1.3: emit the field as a def (type + name + annotations) so the framework-semantics layer can
      // model entity columns (@Column/@Id), injected fields (@Autowired), and component props. A
      // multi-declarator field (`int a, b;`) yields only the first name (tolerant, documented).
      // `prevLastName` is the type head (last dotted segment before the field name), `lastName` the
      // field name; require a distinct type+name pair. `elementType` carries the generic arg of a
      // collection type (`List<Payment>` → "Payment") for JPA association resolution.
      if (firstName && lastName && firstName !== lastName && !HARD_KEYWORDS.has(lastName)) {
        return {
          kind: 'field',
          name: lastName,
          startLine,
          endLine: Math.max(fieldLine, startLine),
          modifiers,
          annotations,
          annos,
          fieldType: prevLastName,
          ...(elementType ? { fieldElementType: elementType } : {}),
          bases: [],
          implements: [],
          params: [],
          body: [],
          stmts: [],
        };
      }
      return null;
    }
    if (kind === 'init') {
      this.skipBraces();
      return null;
    }
    // a method/constructor name that is a hard-reserved keyword (`void(`) is malformed — skip.
    if (!lastName || HARD_KEYWORDS.has(lastName)) return null;
    // method / constructor — `this.i` is at the param-list `(`; record it so the call collector skips it.
    this.excluded.add(this.i);
    const typedParams = this.parseParamListTyped();
    const params = typedParams.map((p) => p.name);
    const paramTypes = typedParams.map((p) => p.type ?? '');
    const paramAnnos = typedParams.map((p) => p.annotations ?? []);
    // optional `throws X, Y` — skip a dotted-name list until `{` or `;`.
    if (this.isName('throws')) {
      this.next();
      this.parseDottedNameList([], ['{', ';']);
    }
    let endLine = this.peek().line;
    let stmts: JavaStmt[] = [];
    if (this.isOp('{')) {
      const openIdx = this.i;
      endLine = this.skipBraces();
      // Track 3: parse the compound-statement tree of the body (tolerant + lossy — never throws).
      stmts = parseBodyStmts(this.t, this.src, this.lineStarts, openIdx);
    } else if (this.isOp(';')) {
      this.next();
    }
    return {
      kind,
      name: lastName,
      startLine,
      endLine: Math.max(endLine, startLine),
      modifiers,
      annotations,
      annos,
      bases: [],
      implements: [],
      params,
      paramTypes,
      paramAnnos,
      // 1.3: for a method, `prevLastName` is the return-type head (the name before the method name)
      // and `elementType` is its generic arg (`List<Payment> all()` → "List" / "Payment"). A @Bean
      // producer method PRODUCES its return type — captured here so the @Bean pass can emit `produces`.
      ...(kind === 'method'
        ? {
            returnType: prevLastName,
            ...(elementType ? { returnElementType: elementType } : {}),
          }
        : {}),
      body: [],
      stmts,
    };
  }

  /**
   * Like {@link parseParamList} but also captures each parameter's TYPE head (the first NAME of the
   * parameter, before generics/array dims) AND its preceding annotations. `UserRepo repo` →
   * {name:'repo', type:'UserRepo'}; `final List<User> us` → {name:'us', type:'List'};
   * `@RequestBody Loan loan` → {name:'loan', type:'Loan', annotations:['RequestBody']}. The DI graph
   * reads the types; the Spring route-param contract reads the annotations.
   */
  private parseParamListTyped(): Array<{
    name: string;
    type?: string;
    annotations?: string[];
  }> {
    if (!this.isOp('(')) return [];
    this.next(); // (
    const out: Array<{ name: string; type?: string; annotations?: string[] }> = [];
    let pdepth = 1;
    let firstName: string | undefined;
    let lastName: string | undefined;
    let paramAnnos: string[] = [];
    const flush = (): void => {
      if (lastName)
        out.push(
          firstName && firstName !== lastName
            ? {
                name: lastName,
                type: firstName,
                ...(paramAnnos.length ? { annotations: paramAnnos } : {}),
              }
            : { name: lastName, ...(paramAnnos.length ? { annotations: paramAnnos } : {}) },
        );
      firstName = undefined;
      lastName = undefined;
      paramAnnos = [];
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
        this.next();
        continue;
      }
      // parameter annotation (`@RequestBody`, `@PathVariable("id")`, `@Valid`): capture the annotation
      // simple name (for the Spring route-param contract), skip the dotted qualifier + any `(...)`
      // args, then reset firstName/lastName so the TYPE is the next plain NAME. Pre-fix
      // `@RequestBody Loan loan` mis-captured the type as 'RequestBody'.
      if (pdepth === 1 && tk.type === 'OP' && tk.value === '@') {
        this.next(); // '@'
        let annoName: string | undefined;
        if (this.isNameToken()) {
          annoName = this.peek().value;
          this.next(); // annotation simple name
        }
        while (this.isOp('.')) {
          // dotted qualifier (`@org.springframework...`)
          this.next();
          if (this.isNameToken()) {
            annoName = this.peek().value;
            this.next();
          } else break;
        }
        if (this.isOp('(')) this.skipBalancedParens(); // annotation args
        if (annoName) paramAnnos.push(annoName);
        firstName = undefined;
        lastName = undefined;
        continue;
      }
      if (pdepth === 1 && tk.type === 'NAME' && !isModifier(tk.value)) {
        if (firstName === undefined) firstName = tk.value;
        lastName = tk.value;
        this.next();
        continue;
      }
      this.next();
    }
    return out;
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

  /**
   * Parse a parameter list from the current `(` up to its matching `)`. Captures the LAST name of
   * each parameter as its name (skips types, annotations, generics, array dims, `final`, varargs).
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
        // a `)` at param-depth 0 ends the current param (no more names); reset handled below.
        continue;
      }
      if (pdepth === 1 && tk.type === 'OP' && tk.value === ',') {
        if (lastName) params.push(lastName);
        lastName = undefined;
        this.next();
        continue;
      }
      if (pdepth === 1 && tk.type === 'NAME' && !isModifier(tk.value)) {
        // a bare name at param-depth 1 — the last one before `,`/`)`/`[`/`...` is the param name.
        lastName = tk.value;
        this.next();
        continue;
      }
      this.next();
    }
    return params;
  }

  /** Parse a comma-separated list of dotted type names (bases / implements / throws). */
  private parseDottedNameList(stopKeywords: string[], stopOps: string[] = ['{', ';']): string[] {
    const out: string[] = [];
    while (!this.atEnd()) {
      // one dotted name: NAME (. NAME)* then optional generic <...>
      let name: string | undefined;
      while (this.isNameToken() || this.isOp('.')) {
        if (this.isNameToken()) name = this.peek().value;
        this.next();
        if (this.isOp('.')) {
          this.next();
          continue;
        }
        break;
      }
      if (name) out.push(name);
      this.skipGenericAngle();
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.isNameAnyOf(stopKeywords) || (stopOps.length && this.isOpAnyOf(stopOps))) break;
      // tolerate stray tokens until a `,`/stop
      if (this.atEnd()) break;
      this.next();
    }
    return out;
  }

  /** Skip a generic argument list `<...>` balanced on `<`/`>`/`>>`/`>>>` (the Java split rule). */
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

  /** Skip the enum-constant list `A, B(args) {body}, C;` up to the terminating `;` (or before `}`). */
  private skipEnumConstants(): void {
    while (!this.atEnd()) {
      if (this.isOp('@')) {
        this.skipAnnotationNoCapture();
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
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      this.next(); // constant name or stray token
    }
  }

  // --- annotations --------------------------------------------------------------

  private consumeAnnotation(out: string[], rich?: JavaAnno[]): void {
    this.next(); // '@'
    let name: string | undefined;
    // dotted annotation name NAME (. NAME)*
    if (this.isNameToken()) {
      name = this.peek().value;
      this.next();
      while (this.isOp('.')) {
        this.next();
        if (this.isNameToken()) {
          name = this.peek().value;
          this.next();
        } else break;
      }
    }
    const simple = name ?? '<anon>';
    out.push(simple);
    let args: string | undefined;
    if (this.isOp('(')) {
      this.excluded.add(this.i);
      // capture the raw argument text between the matching parens (1.3: route paths / HTTP methods /
      // DI qualifiers live here). skipBalancedParens consumes THROUGH the matching `)`, so the open
      // is the token at the current index and the close is the last consumed token.
      const openTok = this.peek();
      this.skipBalancedParens();
      const closeTok = this.t[this.i - 1];
      if (openTok && closeTok) {
        const from = this.offOf(openTok) + 1;
        const to = this.offOf(closeTok);
        args = from < to ? this.src.slice(from, to).trim() : '';
      }
    }
    rich?.push(args !== undefined ? { name: simple, args } : { name: simple });
  }

  /** Source byte offset of a token's first char, from its 1-based line/col + the lineStarts table. */
  private offOf(tk: Token): number {
    return (this.lineStarts[tk.line - 1] ?? 0) + (tk.col - 1);
  }

  private skipAnnotationNoCapture(): void {
    this.next(); // '@'
    while (this.isNameToken() || this.isOp('.')) {
      this.next();
      if (this.isOp('.')) {
        this.next();
        continue;
      }
      break;
    }
    if (this.isOp('(')) this.skipBalancedParens();
  }

  // --- balanced skip helpers -----------------------------------------------------

  /** From a `(` skip to its matching `)`; returns the close-`)` line. */
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
  private isOpAnyOf(vs: string[]): boolean {
    const v = this.peek().value;
    return this.peek().type === 'OP' && vs.includes(v);
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
  private atEnd(): boolean {
    return this.i >= this.t.length || this.peek().type === 'EOF';
  }
}

const MODIFIER_NAMES = [
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
];

/**
 * Assignment operators (schema 1.2): a depth-0 token from this set marks a statement as an
 * assignment (`lhs = rhs` / `lhs += rhs` / …). `==`/`!=`/`>=`/`<=` are distinct lexer tokens and
 * are intentionally absent so comparisons never classify as assignments.
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
  '&&=',
  '||=',
]);

/**
 * Hard-reserved keywords that can NEVER be a declaration name (primitives + control flow + literals).
 * Contextual keywords (`record`, `var`, `yield`, `sealed`, `permits`) ARE valid identifiers and are
 * excluded so a class named e.g. `record Foo` is still parsed correctly.
 */
const HARD_KEYWORDS = new Set<string>([
  'void',
  'int',
  'long',
  'short',
  'byte',
  'float',
  'double',
  'boolean',
  'char',
  'class',
  'interface',
  'enum',
  'extends',
  'implements',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'this',
  'super',
  'try',
  'catch',
  'finally',
  'throw',
  'throws',
  'import',
  'package',
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
  'instanceof',
  'true',
  'false',
  'null',
  'assert',
  'const',
  'goto',
]);

/**
 * Scan the token stream for call expressions `NAME (.NAME)* (` whose `(` is NOT a definition or
 * annotation arg-list (excluded set). `new Foo()` falls out naturally: `new` (no `(` after it) is
 * skipped, then `Foo` + `(` records a constructor call. Method references (`::`) and array-creation
 * brackets never produce a `(` directly after the chain, so they are ignored.
 */
export function collectCallSites(tokens: Token[], excluded: Set<number>): JavaCallSite[] {
  const calls: JavaCallSite[] = [];
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
    // a `(` immediately after the chain (and not an excluded def/annotation paren) ⇒ a call
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

/** Scan the token stream for `package a.b;` and `import [static] a.b.C [. *];` statements. */
export function collectImports(tokens: Token[]): { pkg: string; imports: JavaImport[] } {
  const imports: JavaImport[] = [];
  let pkg = '';
  let i = 0;
  const isNameVal = (k: number, v: string) => tokens[k]?.type === 'NAME' && tokens[k]?.value === v;
  const isOp = (k: number, v: string) => tokens[k]?.type === 'OP' && tokens[k]?.value === v;
  const atLineEnd = (k: number) => !tokens[k] || isOp(k, ';');
  const consumeDotted = (k: number): { parts: string[]; j: number; star: boolean } => {
    const parts: string[] = [];
    let j = k;
    let star = false;
    while (j < tokens.length && tokens[j]!.type === 'NAME') {
      parts.push(tokens[j]!.value);
      j++;
      if (isOp(j, '.')) {
        // `.*` wildcard: dot then `*` (OP)
        if (tokens[j + 1]?.type === 'OP' && tokens[j + 1]?.value === '*') {
          j += 2;
          star = true;
          break;
        }
        j++;
        continue;
      }
      break;
    }
    return { parts, j, star };
  };

  while (i < tokens.length) {
    const tk = tokens[i]!;
    if (tk.type !== 'NAME') {
      i++;
      continue;
    }
    if (tk.value === 'package') {
      const { parts, j } = consumeDotted(i + 1);
      pkg = parts.join('.');
      i = atLineEnd(j) ? j + 1 : j;
      continue;
    }
    if (tk.value === 'import') {
      const line = tk.line;
      let j = i + 1;
      const isStatic = isNameVal(j, 'static');
      if (isStatic) j++;
      const { parts, j: j2, star } = consumeDotted(j);
      j = j2;
      // For `.*` the last segment is part of the package, not a name; for a plain import the last
      // segment is the bound name and the module is everything before it.
      const last = parts[parts.length - 1] ?? '';
      const module = star
        ? parts.join('.')
        : parts.length > 1
          ? parts.slice(0, -1).join('.')
          : isStatic
            ? ''
            : (parts[0] ?? '');
      imports.push({
        module,
        name: star ? '' : last,
        star,
        static: isStatic,
        line,
      });
      i = atLineEnd(j) ? j + 1 : j;
      continue;
    }
    i++;
  }
  return { pkg, imports };
}

// ---------------------------------------------------------------------------------------------
// BodyParser (Track 3) — a tolerant, lossy statement-tree parser for ONE method body.
// Given the index of the body's opening `{`, produces a JavaStmt[] capturing if / else if / else /
// for / while / do-while / switch-case / try-catch-finally / return / throw / call compound structure
// with predicates (source-text spans) + nested bodies. Never throws: a malformed compound degrades
// to skipping its body. Predicate text is a best-effort source slice (line/col → char offset).
// ---------------------------------------------------------------------------------------------

/** Parse a method body's compound statements. `openIdx` is the index of the body's opening `{`. */
export function parseBodyStmts(
  tokens: Token[],
  src: string,
  lineStarts: number[],
  openIdx: number,
): JavaStmt[] {
  try {
    return new BodyParser(tokens, src, lineStarts).parseBody(openIdx);
  } catch {
    return [];
  }
}

/** Character offset of the start of each 1-based line. lineStarts[0] = 0 (start of line 1). */
function computeLineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

class BodyParser {
  private readonly t: Token[];
  private readonly src: string;
  private readonly lineStarts: number[];
  /** cursor into the token stream. */
  private i = 0;
  /** exclusive upper bound of the current block (index of the closing `}`). */
  private end = 0;

  constructor(tokens: Token[], src: string, lineStarts: number[]) {
    this.t = tokens;
    this.src = src;
    this.lineStarts = lineStarts;
  }

  /** Parse the body whose `{` is at `openIdx`; returns its direct statements. */
  parseBody(openIdx: number): JavaStmt[] {
    const closeIdx = this.matchBrace(openIdx);
    if (closeIdx < 0) return []; // unterminated body — degrade to no statements
    this.i = openIdx + 1;
    this.end = closeIdx;
    return this.parseStmts();
  }

  private parseStmts(): JavaStmt[] {
    const out: JavaStmt[] = [];
    while (this.i < this.end) {
      const tk = this.peek();
      if (this.isOp(';') || this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.isOp('{')) {
        // bare nested block (e.g. a brace-wrapped scope) — skip its contents, not modelled.
        this.skipBraces();
        continue;
      }
      if (this.isOp('}')) break;
      const before = this.i;
      const s = this.parseStmt();
      if (s) out.push(s);
      else if (this.i === before) this.next(); // progress guard
    }
    return out;
  }

  private parseStmt(): JavaStmt | null {
    const tk = this.peek();
    if (tk.type !== 'NAME') {
      this.skipToSemi();
      return null;
    }
    const startLine = tk.line;
    switch (tk.value) {
      case 'if':
        return this.parseIf(startLine);
      case 'for':
        return this.parseLoop(startLine, 'for');
      case 'while':
        return this.parseLoop(startLine, 'while');
      case 'do':
        return this.parseDo(startLine);
      case 'switch':
        return this.parseSwitch(startLine);
      case 'try':
        return this.parseTry(startLine);
      case 'return':
        return this.parseAction(startLine, 'return');
      case 'throw':
        return this.parseAction(startLine, 'throw');
      case 'break':
      case 'continue':
        this.skipToSemi();
        return null;
      default:
        return this.parseSimple(startLine);
    }
  }

  // --- compound statements --------------------------------------------------------

  /**
   * Parse `if (pred) {…} else if (pred2) {…} else {…}` as one statement with branches.
   * Returns null for a malformed `if` (no/unmatched predicate paren) so the body degrades cleanly.
   */
  private parseIf(startLine: number): JavaStmt | null {
    this.next(); // if
    const predicate = this.readParenText();
    if (predicate === undefined) return null; // malformed if — readParenText already bailed the block
    const body = this.parseBlockOrStmt();
    const branches: JavaIfBranch[] = [{ role: 'then', predicate, line: startLine, body }];
    let endLine = this.branchEnd(body);
    // else / else-if chain
    while (this.peek().type === 'NAME' && this.peek().value === 'else') {
      const elseLine = this.peek().line;
      this.next(); // else
      if (this.peek().type === 'NAME' && this.peek().value === 'if') {
        const elseifLine = this.peek().line;
        this.next(); // if
        const pred2 = this.readParenText();
        if (pred2 === undefined) break; // malformed else-if — stop the chain
        const body2 = this.parseBlockOrStmt();
        branches.push({ role: 'elseif', predicate: pred2, line: elseifLine, body: body2 });
        endLine = this.branchEnd(body2);
      } else {
        const body3 = this.parseBlockOrStmt();
        branches.push({ role: 'else', line: elseLine, body: body3 });
        endLine = this.branchEnd(body3);
        break;
      }
    }
    return { kind: 'if', startLine, endLine, branches };
  }

  /** Parse `for (…) body` / `while (…) body`. Returns null for a malformed predicate paren. */
  private parseLoop(startLine: number, kind: 'for' | 'while'): JavaStmt | null {
    this.next(); // for/while
    const predicate = this.readParenText();
    if (predicate === undefined) return null; // malformed — readParenText already bailed the block
    const body = this.parseBlockOrStmt();
    return {
      kind,
      startLine,
      endLine: this.branchEnd(body),
      predicate,
      predicateLine: startLine,
      body,
    };
  }

  /** Parse `do body while (cond);`. */
  private parseDo(startLine: number): JavaStmt {
    this.next(); // do
    const body = this.parseBlockOrStmt();
    let predicate: string | undefined;
    if (this.peek().type === 'NAME' && this.peek().value === 'while') {
      this.next(); // while
      predicate = this.readParenText();
    }
    if (this.isOp(';')) this.next();
    return {
      kind: 'do',
      startLine,
      endLine: this.branchEnd(body),
      predicate,
      predicateLine: startLine,
      body,
    };
  }

  /** Parse `switch (expr) { case A: … default: … }`. */
  private parseSwitch(startLine: number): JavaStmt {
    this.next(); // switch
    this.readParenText(); // switch subject — conditions are per-case
    const cases: JavaCase[] = [];
    if (this.isOp('{')) {
      const openIdx = this.i;
      const closeIdx = this.matchBrace(openIdx, this.end);
      if (closeIdx < 0) {
        this.i = this.end; // unterminated switch — bail
        return { kind: 'switch', startLine, endLine: startLine, cases };
      }
      this.next(); // {
      const saveEnd = this.end;
      this.end = closeIdx;
      while (this.i < closeIdx) {
        const tk = this.peek();
        if (this.isOp('}')) break;
        if (tk.type === 'NAME' && tk.value === 'case') {
          const caseLine = tk.line;
          this.next(); // case
          const predicate = this.readUntilColon(closeIdx);
          const body = this.parseCaseBody(closeIdx);
          cases.push({ predicate, line: caseLine, body });
        } else if (tk.type === 'NAME' && tk.value === 'default') {
          const defLine = tk.line;
          this.next(); // default
          this.readUntilColon(closeIdx);
          const body = this.parseCaseBody(closeIdx);
          cases.push({ predicate: undefined, line: defLine, body });
        } else if (this.isOp(';') || this.isOp(',')) {
          this.next();
        } else {
          this.next(); // stray token
        }
      }
      this.end = saveEnd;
      this.i = closeIdx + 1; // past }
    }
    return { kind: 'switch', startLine, endLine: startLine, cases };
  }

  /** Parse `try [(…)] {…} catch (E e) {…} finally {…}`. */
  private parseTry(startLine: number): JavaStmt {
    this.next(); // try
    if (this.isOp('(')) this.readParenText(); // try-with-resources
    const tryBody = this.parseBlockOrStmt();
    const catches: JavaCatch[] = [];
    let finallyBody: JavaStmt[] | undefined;
    while (true) {
      const tk = this.peek();
      if (tk.type === 'NAME' && tk.value === 'catch') {
        const catchLine = tk.line;
        this.next(); // catch
        const predicate = this.readParenText(); // (Type e | Type1 | Type2 e)
        const body = this.parseBlockOrStmt();
        catches.push({ predicate, line: catchLine, body });
      } else if (tk.type === 'NAME' && tk.value === 'finally') {
        this.next(); // finally
        finallyBody = this.parseBlockOrStmt();
        break;
      } else {
        break;
      }
    }
    return {
      kind: 'try',
      startLine,
      endLine: this.branchEnd(tryBody),
      tryBody,
      catches,
      finallyBody,
    };
  }

  /** Parse a case body: statements up to the next `case`/`default`/`}`/end. */
  private parseCaseBody(closeIdx: number): JavaStmt[] {
    const out: JavaStmt[] = [];
    while (this.i < closeIdx) {
      const tk = this.peek();
      if (this.isOp('}')) break;
      if (
        (tk.type === 'NAME' && (tk.value === 'case' || tk.value === 'default')) ||
        this.isOp('{')
      ) {
        if (this.isOp('{')) {
          this.skipBraces();
          continue;
        }
        break;
      }
      if (this.isOp(';') || this.isOp(',')) {
        this.next();
        continue;
      }
      const before = this.i;
      const s = this.parseStmt();
      if (s) out.push(s);
      else if (this.i === before) this.next();
    }
    return out;
  }

  // --- simple statements ----------------------------------------------------------

  /** Parse `return …;` / `throw …;` — captures the statement text + any embedded call. */
  private parseAction(startLine: number, kind: 'return' | 'throw'): JavaStmt {
    const startIdx = this.i;
    const scan = this.scanSimple(startIdx);
    this.i = scan.endIdx + 1; // past `;` (or end)
    const endLine = scan.lastLine ?? startLine;
    return {
      kind,
      startLine,
      endLine,
      text: scan.text,
      ...(scan.callChain ? { callChain: scan.callChain } : {}),
    };
  }

  /**
   * Parse a non-keyword statement up to its terminating `;`. Emits a node if it carries a call OR is
   * an assignment (`lhs = rhs` / `lhs += rhs` / …); otherwise returns null to keep the graph lean.
   * A call-bearing assignment stays a `call` (the call is the interesting part); a plain assignment
   * with no call becomes an `assign` so the extractor can emit a schema-1.2 `assignment` node.
   * `new Foo()` is detected because `new` is a NAME keyword that is NOT followed by `(` — the
   * following `Foo(` is the call.
   */
  private parseSimple(startLine: number): JavaStmt | null {
    const startIdx = this.i;
    const scan = this.scanSimple(startIdx);
    this.i = scan.endIdx + 1; // past `;` (or end)
    const endLine = scan.lastLine ?? startLine;
    if (scan.assignOp && !scan.callChain) {
      return {
        kind: 'assign',
        startLine,
        endLine,
        text: scan.text,
        assignTarget: scan.assignTarget,
      };
    }
    if (!scan.callChain) return null; // no call + no assignment → skip (declaration / plain expression)
    return {
      kind: 'call',
      startLine,
      endLine,
      text: scan.text,
      callChain: scan.callChain,
    };
  }

  // --- scanning helpers -----------------------------------------------------------

  /**
   * Scan a simple statement from `startIdx` to its terminating `;` (or `}`/end) at depth 0, balancing
   * `()`/`[]`/`{}`. Returns the source text, the terminator index, the last-token line, the first
   * call chain (`NAME (.NAME)* (`) found at depth 0, and — for an assignment statement — the LHS
   * target text + a flag. The assignment operator is the FIRST depth-0 token in {@link ASSIGN_OPS}
   * (so `==`/`!=`/`>=`/`<=`, distinct tokens, never match).
   */
  private scanSimple(startIdx: number): {
    endIdx: number;
    text: string;
    lastLine: number | undefined;
    callChain: string[] | undefined;
    assignOp: boolean;
    assignTarget: string | undefined;
  } {
    let j = startIdx;
    let depth = 0;
    let callChain: string[] | undefined;
    let lastLine: number | undefined;
    let assignOpIdx = -1;
    for (; j < this.end; j++) {
      const tk = this.t[j]!;
      if (tk.type === 'EOF') break;
      if (depth === 0 && tk.type === 'OP' && (tk.value === ';' || tk.value === '}')) break;
      lastLine = tk.line;
      if (tk.type === 'OP') {
        if (tk.value === '(' || tk.value === '[' || tk.value === '{') depth++;
        else if (tk.value === ')' || tk.value === ']' || tk.value === '}')
          depth = Math.max(0, depth - 1);
        else if (depth === 0 && assignOpIdx < 0 && ASSIGN_OPS.has(tk.value)) assignOpIdx = j;
      }
      if (callChain === undefined && depth === 0 && tk.type === 'NAME') {
        const chain = this.detectCall(j);
        if (chain) callChain = chain;
      }
    }
    const textEnd = j > startIdx ? j - 1 : startIdx;
    const text = this.sliceText(startIdx, textEnd).trim();
    const assignTarget =
      assignOpIdx > startIdx ? this.sliceText(startIdx, assignOpIdx - 1).trim() : undefined;
    return { endIdx: j, text, lastLine, callChain, assignOp: assignOpIdx >= 0, assignTarget };
  }

  /**
   * At a NAME, read `NAME (.NAME)*` and return the chain IFF a `(` immediately follows (a call).
   * `new` → no `(` after it (next is the type NAME) → returns null; the type NAME's own `(` is caught.
   */
  private detectCall(j: number): string[] | null {
    let k = j;
    const chain: string[] = [this.t[k]!.value];
    k++;
    while (
      k < this.t.length &&
      this.t[k]!.type === 'OP' &&
      this.t[k]!.value === '.' &&
      this.t[k + 1]?.type === 'NAME'
    ) {
      chain.push(this.t[k + 1]!.value);
      k += 2;
    }
    if (k < this.t.length && this.t[k]!.type === 'OP' && this.t[k]!.value === '(') return chain;
    return null;
  }

  /**
   * Read a `(…)` group and return its inner source text (trimmed); advances past the matching `)`.
   * Bounded by `this.end`: an unmatched `(` (malformed) bails the rest of the block and returns
   * undefined so the caller can degrade (skip the malformed compound) without over-consuming.
   */
  private readParenText(): string | undefined {
    if (!this.isOp('(')) return undefined;
    const openIdx = this.i;
    const closeIdx = this.matchParen(openIdx, this.end);
    if (closeIdx < 0) {
      this.i = this.end; // malformed — bail the rest of the block
      return undefined;
    }
    const text = closeIdx > openIdx + 1 ? this.sliceText(openIdx + 1, closeIdx - 1).trim() : '';
    this.i = closeIdx + 1; // past )
    return text;
  }

  /** Read a `case` predicate up to its `:`; advances past the `:`. Returns undefined if no `:`. */
  private readUntilColon(closeIdx: number): string | undefined {
    const startIdx = this.i;
    let depth = 0;
    let j = this.i;
    for (; j < closeIdx; j++) {
      const tk = this.t[j]!;
      if (tk.type === 'EOF') break;
      if (tk.type === 'OP') {
        if (tk.value === '(' || tk.value === '[' || tk.value === '{') depth++;
        else if (tk.value === ')' || tk.value === ']' || tk.value === '}')
          depth = Math.max(0, depth - 1);
        else if (depth === 0 && tk.value === ':') break;
      }
    }
    if (j >= closeIdx) return undefined;
    const text = j > startIdx ? this.sliceText(startIdx, j - 1).trim() : '';
    this.i = j + 1; // past :
    return text;
  }

  /** Parse a body that is either a `{…}` block or a single (braceless) statement. */
  private parseBlockOrStmt(): JavaStmt[] {
    if (this.isOp('{')) {
      const openIdx = this.i;
      const closeIdx = this.matchBrace(openIdx, this.end);
      if (closeIdx < 0) {
        this.i = this.end; // unterminated block — bail
        return [];
      }
      const saveEnd = this.end;
      this.i = openIdx + 1;
      this.end = closeIdx;
      const stmts = this.parseStmts();
      this.end = saveEnd;
      this.i = closeIdx + 1; // past }
      return stmts;
    }
    const stmt = this.parseStmt();
    return stmt ? [stmt] : [];
  }

  /** Skip a `{…}` block (advances past the matching `}`), bounded by `this.end`. */
  private skipBraces(): void {
    if (!this.isOp('{')) return;
    const closeIdx = this.matchBrace(this.i, this.end);
    this.i = closeIdx < 0 ? this.end : closeIdx + 1;
  }

  /** Skip to the next `;` at the statement's own depth 0 (or the block close) — bounded by `this.end`. */
  private skipToSemi(): void {
    let p = 0;
    let b = 0;
    let br = 0;
    while (this.i < this.end) {
      const tk = this.peek();
      if (tk.type === 'EOF') return;
      if (p === 0 && b === 0 && br === 0 && this.isOp(';')) {
        this.next();
        return;
      }
      if (p === 0 && b === 0 && br === 0 && this.isOp('}')) return;
      if (tk.type === 'OP') {
        if (tk.value === '(') p++;
        else if (tk.value === ')') p = Math.max(0, p - 1);
        else if (tk.value === '[') br++;
        else if (tk.value === ']') br = Math.max(0, br - 1);
        else if (tk.value === '{') b++;
        else if (tk.value === '}') b = Math.max(0, b - 1);
      }
      this.next();
    }
  }

  // --- brace / paren matchers (pure, do not advance) ------------------------------

  /**
   * Index of the `}` matching the `{` at `openIdx` (balanced; strings/chars are already tokens).
   * Returns -1 if no match is found within `maxIdx` (a malformed/unterminated block) so callers can
   * degrade by bailing to the enclosing block end instead of over-consuming into sibling code.
   */
  private matchBrace(openIdx: number, maxIdx: number = this.t.length): number {
    let depth = 0;
    for (let j = openIdx; j < maxIdx; j++) {
      const tk = this.t[j]!;
      if (tk.type === 'EOF') return -1;
      if (tk.type === 'OP' && tk.value === '{') depth++;
      else if (tk.type === 'OP' && tk.value === '}') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  }

  /** Index of the `)` matching the `(` at `openIdx`, or -1 if unmatched within `maxIdx`. */
  private matchParen(openIdx: number, maxIdx: number = this.t.length): number {
    let depth = 0;
    for (let j = openIdx; j < maxIdx; j++) {
      const tk = this.t[j]!;
      if (tk.type === 'EOF') return -1;
      if (tk.type === 'OP' && tk.value === '(') depth++;
      else if (tk.type === 'OP' && tk.value === ')') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  }

  /** Source text spanning tokens [startIdx..endIdx] inclusive (via line/col → char offset). */
  private sliceText(startIdx: number, endIdx: number): string {
    const sTok = this.t[startIdx]!;
    const eTok = this.t[endIdx]!;
    const startOff = (this.lineStarts[sTok.line - 1] ?? 0) + (sTok.col - 1);
    const endOff = (this.lineStarts[eTok.line - 1] ?? 0) + (eTok.col - 1) + eTok.value.length;
    return this.src.slice(startOff, endOff);
  }

  /** 1-based end line of the last statement in a block (for the enclosing compound's endLine). */
  private branchEnd(body: JavaStmt[]): number {
    if (body.length === 0) return 0;
    return body[body.length - 1]!.endLine;
  }

  // --- token helpers --------------------------------------------------------------

  private peek(): Token {
    return this.t[this.i] ?? { type: 'EOF', value: '', line: 0, col: 0 };
  }
  private next(): Token {
    const tk = this.t[this.i] ?? { type: 'EOF', value: '', line: 0, col: 0 };
    if (this.i < this.t.length) this.i++;
    return tk;
  }
  private isOp(v: string): boolean {
    return this.peek().type === 'OP' && this.peek().value === v;
  }
}
