/**
 * RustExtractor — emits `symbol` nodes (mod / struct / enum / trait / impl / fn / method /
 * associated_fn / typealias / macro) with qualifiedName / span / signature, `member-of` edges
 * (symbol → enclosing symbol or file), and INTRA-FILE `calls` edges (a call whose callee resolves
 * to a symbol declared in the same file).
 *
 * Engine: the hand-rolled {@link parseRust} tokenizer + structural parser (pure-JS, offline,
 * deterministic) — same posture as the Java / Python extractors. Cross-file resolution (imports /
 * cross-file calls / `implements` via `impl Trait for Type` / `inherits` via trait supertraits) is
 * the RustResolver's job (Phase 3); this extractor never guesses across files.
 *
 * Capability-honest: declares { imports:true, calls:true, inheritance:true, types:'none' }. The
 * extractor itself emits ONLY `member-of` + intra-file `calls` — imports / cross-file calls /
 * implements / inherits are produced by the resolver against the global symbol table. The
 * `implements`/`inherits` data is captured here in `meta.impl` (impl blocks) and `meta.bases`
 * (trait supertraits) so the resolver can emit those edges.
 *
 * Qualified names use `::` (Rust's path separator), mirroring Rust convention:
 *   - top-level fn `log` → `log`; struct `Token` → `Token`
 *   - trait fn `greet` in trait `Greeter` → `Greeter::greet`
 *   - impl method `login` in `impl AuthApi for AuthController` → `AuthController::login`
 *     (the impl's TYPE, not the impl's full string, so method refs like `Type::method` resolve)
 *   - the impl block itself is a container symbol: qualifiedName `impl Trait for Type` (or
 *     `impl Type`); its methods are member-of the impl symbol, and the impl symbol is member-of
 *     the file — mirroring how Java nests methods under their class.
 *
 * Honest limitations (documented):
 *   - `macro_rules!` bodies are NOT descended (the parser skips the `{...}`); the macro name is the
 *     only symbol. Macro call sites (`m!()`) resolve only if a macro symbol exists in this file.
 *   - enum variants + struct fields are NOT symbols (parity with Java's field altitude); their call
 *     sites are still captured whole-stream.
 *   - `obj.method()` receiver calls are DROPPED (receiver resolution is inference's job).
 *   - `impl Trait for Type` where `Type` is an external / non-path type is not extracted as an impl
 *     container (the parser tolerates and skips).
 *   - trait default-impl fns vs required fns are not distinguished (both are `method`/`associated_fn`).
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { clampExpr } from '../types.js';
import type { Capabilities, ExtractCtx, ExtractResult, Extractor, FileMeta } from '../types.js';
import { collectRustComments } from './lexer.js';
import type { RustCommentBlock } from './lexer.js';
import type { RustCallSite, RustDef, RustStmt } from './parser.js';
import { parseRust } from './parser.js';

/** Spread an `expr` field plus its `exprTruncated` honesty flag from a raw expression string. */
function exprFields(raw: string | undefined): { expr?: string; exprTruncated?: true } {
  if (!raw) return {};
  const { expr, truncated } = clampExpr(raw);
  return truncated ? { expr, exprTruncated: true } : { expr };
}

interface LocalSymbol {
  node: Node;
  keys: string[];
  simpleName: string;
  /** enclosing container qualified name ("" at file level) — used for member-of resolution. */
  parentQualifier: string;
}

/** One frame on the guard stack: a condition id + its branch polarity (THEN/ELSIF/ELSE/LOOP/CASE). */
interface GuardFrame {
  condId: string;
  branch: string;
}

/** A call site recorded during the body-walk, with its guard-chain fields for edge annotation. */
interface GuardedCallSite {
  callee: string;
  line: number;
  cfgPath: string[];
  guard?: string;
  branch?: string;
  inLoop: boolean;
  inException: boolean;
}

/** kinds that nest further declarations (their `body` is recursed). */
const CONTAINER_KINDS = new Set<RustDef['kind']>(['mod', 'trait', 'impl']);

export class RustExtractor implements Extractor {
  name = 'lang:rust';
  capabilities: Capabilities = { imports: true, calls: true, inheritance: true, types: 'none' };

  private static readonly SUPPORTED = ['.rs'];

  supports(file: FileMeta): boolean {
    return RustExtractor.SUPPORTED.some((e) => file.path.endsWith(e));
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    try {
      const text = await ctx.readText();
      const fileId = ctx.idFor('file', { path: file.path });
      return this.parse(file.path, fileId, text, ctx);
    } catch {
      return { nodes: [], edges: [] };
    }
  }

  private parse(path: string, fileId: string, text: string, ctx: ExtractCtx): ExtractResult {
    const mod = parseRust(text);
    const symbols: LocalSymbol[] = [];
    const byKey = new Map<string, string>(); // qualifiedName | simpleName → symbol id
    /** fn defs with a parsed statement tree (Track 3 body-walk targets). */
    const fnProcs: { procId: string; stmts: RustStmt[] }[] = [];

    // 1.2: collect comment blocks once + attach a preceding block as an `explanation` node + a
    // `describes` edge (explanation → symbol) for every symbol whose startLine immediately follows
    // a block. Deduped by explanation id (file+startLine). The comment text is carried inline on
    // meta.text (a doc, not code) — parity with PlSqlExtractor.attachComment.
    const comments: RustCommentBlock[] = collectRustComments(text);
    const explNodes: Node[] = [];
    const explEdges: Edge[] = [];
    const explSeen = new Set<string>();
    const attachComment = (symId: string, startLine: number): void => {
      const block = comments.find((c) => c.end === startLine - 1);
      if (!block || !block.text) return;
      const id = ctx.idFor('explanation', { path, startLine: block.start });
      if (explSeen.has(id)) return;
      explSeen.add(id);
      explNodes.push({
        id,
        kind: 'explanation',
        commentRef: { file: path, span: { start: block.start, end: block.end } },
        file: path,
        span: { start: block.start, end: block.end },
        lang: 'rust',
        hash: ctx.hash(`${path}:${block.start}:${block.text}`),
        meta: { text: block.text },
      });
      explEdges.push({
        id: edgeId(id, symId, 'describes'),
        src: id,
        dst: symId,
        rel: 'describes',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name, snippet: 'COMMENT' },
      });
    };

    // --- pass 1: declarations + member-of, walking the nesting tree ---
    // `memberCtx` is the enclosing container kind for fn classification:
    //   'impl' | 'trait' ⇒ fns become method/associated_fn; 'mod' | 'none' ⇒ fns stay 'fn'.
    const visit = (
      defs: RustDef[],
      qualifier: string[],
      parentQ: string,
      memberCtx: 'impl' | 'trait' | 'mod' | 'none',
    ): void => {
      for (const d of defs) {
        if (d.kind === 'impl') {
          const implQ = d.name; // "impl Trait for Type" or "impl Type"
          const id = ctx.idFor('symbol', { path, qualifiedName: implQ, startLine: d.startLine });
          const parentQForImpl = parentQ;
          const node: Node = {
            id,
            kind: 'symbol',
            type: d.kind,
            name: d.name,
            qualifiedName: implQ,
            file: path,
            span: { start: d.startLine, end: d.endLine },
            lang: 'rust',
            hash: ctx.hash(this.defText(d, text)),
            signature: d.name,
            meta: {
              parentQualifier: parentQForImpl,
              ...(d.modifiers.length ? { modifiers: d.modifiers } : {}),
              ...(d.attributes.length ? { attributes: d.attributes } : {}),
              ...(d.typeParams.length ? { typeParams: d.typeParams } : {}),
              ...(d.impl ? { impl: d.impl } : {}),
            },
          };
          symbols.push({
            node,
            keys: [implQ],
            simpleName: d.name,
            parentQualifier: parentQForImpl,
          });
          if (!byKey.has(implQ)) byKey.set(implQ, id);
          attachComment(id, d.startLine);
          // recurse into the impl body: methods get qualifiedName `${impl.type}::${method}`,
          // parentQualifier = implQ (member-of the impl symbol).
          const implType = d.impl?.type ?? '';
          visitImplBody(d.body, implType, implQ);
        } else {
          const qn = [...qualifier, d.name].join('::');
          const id = ctx.idFor('symbol', { path, qualifiedName: qn, startLine: d.startLine });
          const finalType = this.finalType(d, memberCtx);
          const node: Node = {
            id,
            kind: 'symbol',
            type: finalType,
            name: d.name,
            qualifiedName: qn,
            file: path,
            span: { start: d.startLine, end: d.endLine },
            lang: 'rust',
            hash: ctx.hash(this.defText(d, text)),
            signature: this.signature(d, finalType),
            meta: {
              parentQualifier: parentQ,
              ...(d.modifiers.length ? { modifiers: d.modifiers } : {}),
              ...(d.attributes.length ? { attributes: d.attributes } : {}),
              ...(d.bases.length ? { bases: d.bases } : {}),
              ...(d.typeParams.length ? { typeParams: d.typeParams } : {}),
              ...(d.params.length ? { params: d.params } : {}),
              ...(d.hasSelf ? { hasSelf: true } : {}),
            },
          };
          symbols.push({
            node,
            keys: [qn, d.name],
            simpleName: d.name,
            parentQualifier: parentQ,
          });
          for (const k of [qn, d.name]) if (!byKey.has(k)) byKey.set(k, id);
          attachComment(id, d.startLine);
          // Track 3: a fn with a parsed statement tree is a body-walk target.
          if (d.kind === 'fn' && d.stmts && d.stmts.length > 0) {
            fnProcs.push({ procId: id, stmts: d.stmts });
          }
          if (CONTAINER_KINDS.has(d.kind)) {
            const childCtx: 'impl' | 'trait' | 'mod' | 'none' =
              d.kind === 'trait' ? 'trait' : d.kind === 'mod' ? 'mod' : 'none';
            visit(d.body, [...qualifier, d.name], qn, childCtx);
          }
        }
      }
    };

    /** Visit an impl body: methods get `Type::method` qualified names, parented to the impl symbol. */
    const visitImplBody = (defs: RustDef[], implType: string, implQ: string): void => {
      for (const d of defs) {
        // impl bodies contain fns (methods/associated_fns), type aliases, consts (skipped). Any
        // container kind here is invalid Rust; treat as a leaf with `Type::name` qualified name.
        const qn = implType ? `${implType}::${d.name}` : d.name;
        const id = ctx.idFor('symbol', { path, qualifiedName: qn, startLine: d.startLine });
        const finalType = this.finalType(d, 'impl');
        const node: Node = {
          id,
          kind: 'symbol',
          type: finalType,
          name: d.name,
          qualifiedName: qn,
          file: path,
          span: { start: d.startLine, end: d.endLine },
          lang: 'rust',
          hash: ctx.hash(this.defText(d, text)),
          signature: this.signature(d, finalType),
          meta: {
            parentQualifier: implQ,
            ...(d.modifiers.length ? { modifiers: d.modifiers } : {}),
            ...(d.attributes.length ? { attributes: d.attributes } : {}),
            ...(d.typeParams.length ? { typeParams: d.typeParams } : {}),
            ...(d.params.length ? { params: d.params } : {}),
            ...(d.hasSelf ? { hasSelf: true } : {}),
          },
        };
        symbols.push({ node, keys: [qn, d.name], simpleName: d.name, parentQualifier: implQ });
        for (const k of [qn, d.name]) if (!byKey.has(k)) byKey.set(k, id);
        attachComment(id, d.startLine);
        if (d.kind === 'fn' && d.stmts && d.stmts.length > 0) {
          fnProcs.push({ procId: id, stmts: d.stmts });
        }
      }
    };

    visit(mod.defs, [], '', 'none');

    const nodes: Node[] = symbols.map((s) => s.node);
    const edges: Edge[] = symbols.map((s) =>
      this.memberOf(s.node, this.parentIdFor(s, byKey, fileId)),
    );

    // --- pass 2 (Track 3): body-walk — emit statement/condition/executes/guarded-by +
    // collect guarded call sites (cfgPath/guard/branch/inLoop/inException per call site) for
    // calls-edge annotation + proc.meta.calls. Mirrors PlSqlExtractor.walkBlock/walkIf/walkLoop
    // but stamps the guard fields DIRECTLY on the executes edges at emission time (no CFG pass).
    const guardByCaller = new Map<string, GuardedCallSite[]>();
    const walker = new BodyWalker(path, ctx, nodes, edges);
    for (const fn of fnProcs) {
      const sites: GuardedCallSite[] = [];
      walker.walkBody(fn.stmts, fn.procId, [], false, false, sites);
      if (sites.length > 0) {
        guardByCaller.set(fn.procId, sites);
        // stamp call sites on the proc node meta so extract_rules can recover call-site lines
        // (the `calls` edge's dst is the callee's DEFINITION, not the call site).
        const procNode = nodes.find((n) => n.id === fn.procId);
        if (procNode) {
          procNode.meta = {
            ...(procNode.meta ?? {}),
            calls: sites.map((s) => ({ callee: s.callee, line: s.line })),
          };
        }
      }
    }

    // --- pass 3: intra-file calls (bare fn / Type::method / path fn / macro!() that resolve) ---
    // Annotate each deduped `calls` edge with the guard-chain fields of its first matching call
    // site (best-effort, last-wins — one edge per (proc,callee) is documented lossy).
    this.collectCalls(mod.calls, symbols, byKey, edges, guardByCaller);

    // 1.2: merge `explanation` nodes + `describes` edges (collected during pass 1).
    for (const n of explNodes) nodes.push(n);
    for (const e of explEdges) edges.push(e);

    return { nodes, edges };
  }

  /** Final symbol `type` for a fn item, given the enclosing container kind. */
  private finalType(d: RustDef, memberCtx: 'impl' | 'trait' | 'mod' | 'none'): string {
    if (d.kind !== 'fn') return d.kind;
    if (memberCtx === 'impl' || memberCtx === 'trait') {
      return d.hasSelf ? 'method' : 'associated_fn';
    }
    return 'fn';
  }

  private signature(d: RustDef, finalType: string): string {
    switch (d.kind) {
      case 'struct':
        return `struct ${d.name}`;
      case 'enum':
        return `enum ${d.name}`;
      case 'trait':
        return d.bases.length ? `trait ${d.name}: ${d.bases.join(' + ')}` : `trait ${d.name}`;
      case 'impl':
        return d.name; // "impl Trait for Type" / "impl Type"
      case 'typealias':
        return `type ${d.name}`;
      case 'macro':
        return `macro ${d.name}`;
      default:
        return `fn ${d.name}(${d.params.join(', ')})`;
    }
  }

  private parentIdFor(sym: LocalSymbol, byKey: Map<string, string>, fileId: string): string {
    const parentQualifier = sym.node.meta?.parentQualifier as string | undefined;
    if (!parentQualifier) return fileId;
    return byKey.get(parentQualifier) ?? fileId;
  }

  private memberOf(child: Node, parentId: string): Edge {
    return {
      id: edgeId(child.id, parentId, 'member-of'),
      src: child.id,
      dst: parentId,
      rel: 'member-of',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: this.name },
    };
  }

  /**
   * Emit `calls` edges for call sites whose callee resolves to a same-file symbol:
   *   - `m!()` macro call → macro symbol by simple name (if extracted).
   *   - `foo()` / `foo::bar()` / `Type::method()` → byKey.get(full chain) then byKey.get(head).
   *   - `obj.method()` (any `.` separator) → DROPPED (receiver resolution is inference's job).
   * `self`/`Self` heads are dropped (parent-class / Self-type — not resolvable here).
   *
   * Track 3 (additive): each deduped `calls` edge is annotated with the guard-chain fields
   * (cfgPath/guard/branch/inLoop/inException) of its first matching guarded call site. One edge
   * per (proc,callee) is documented lossy — if the same callee is called in two branches, the edge
   * carries the cfgPath of the FIRST site (matches extract.ts `callLineIndex` last-wins semantics).
   */
  private collectCalls(
    calls: RustCallSite[],
    symbols: LocalSymbol[],
    byKey: Map<string, string>,
    edges: Edge[],
    guardByCaller: Map<string, GuardedCallSite[]>,
  ): void {
    const idToSimple = new Map<string, string>();
    for (const s of symbols) idToSimple.set(s.node.id, s.simpleName);
    const seen = new Set<string>();
    for (const c of calls) {
      if (c.head === 'self' || c.head === 'Self') continue;
      if (c.seps.includes('.')) continue; // receiver call — dropped

      let dstId: string | undefined;
      if (c.macro) {
        dstId = byKey.get(c.head); // macro symbols keyed by simple name
      } else {
        const fullChain = [c.head, ...c.segments].join('::');
        dstId = byKey.get(fullChain) ?? byKey.get(c.head);
      }
      if (!dstId) continue;
      const caller = enclosingSymbolId(c.line, symbols);
      if (!caller || caller === dstId) continue; // skip self-recursion
      const calleeText = [c.head, ...c.segments].join(c.seps[0] === '.' ? '.' : '::');
      const e: Edge = {
        id: edgeId(caller, dstId, 'calls'),
        src: caller,
        dst: dstId,
        rel: 'calls',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: this.name, snippet: calleeText },
      };
      // Track 3: annotate with the guard chain of the first matching call site (best-effort).
      const calleeSimple = (idToSimple.get(dstId) ?? '').toLowerCase();
      const sites = guardByCaller.get(caller);
      if (calleeSimple && sites) {
        const site = sites.find((s) => lastSeg(s.callee).toLowerCase() === calleeSimple);
        if (site) {
          e.cfgPath = site.cfgPath;
          if (site.guard) {
            e.guard = site.guard;
            e.branch = site.branch;
          }
          e.inLoop = site.inLoop;
          e.inException = site.inException;
        }
      }
      if (!seen.has(e.id)) {
        seen.add(e.id);
        edges.push(e);
      }
    }
  }

  /** Best-effort source text for a def — used only for hashing (change detection), needs no precision. */
  private defText(d: RustDef, src: string): string {
    const lines = src.split('\n');
    return lines.slice(d.startLine - 1, d.endLine).join('\n');
  }
}

/** Innermost symbol whose span contains `line`; the narrowest wins. */
function enclosingSymbolId(line: number, symbols: LocalSymbol[]): string | undefined {
  let best: LocalSymbol | undefined;
  for (const s of symbols) {
    const span = s.node.span;
    if (!span || line < span.start || line > span.end) continue;
    if (
      !best ||
      (best.node.span && span.start >= best.node.span.start && span.end <= best.node.span.end)
    )
      best = s;
  }
  return best?.node.id;
}

/** Last `::`/`.`-separated segment of a callee chain (lowercased comparison happens at call sites). */
function lastSeg(callee: string): string {
  return callee.split(/::|\./).pop() ?? callee;
}

// ---------------------------------------------------------------------------------------------
// BodyWalker (Track 3) — walks a fn's compound-statement tree with a guard stack and emits
// statement / condition / executes / guarded-by nodes + edges, mirroring PlSqlExtractor's
// walkBlock/walkIf/walkLoop/condition/addSql/addCall. The simplification vs PL/SQL: the FULL guard
// stack is tracked inline and cfgPath/guard/branch/inLoop/inException are stamped DIRECTLY on the
// executes (and calls, via guarded call sites) edges at emission time — no separate CFG pass.
// ---------------------------------------------------------------------------------------------

class BodyWalker {
  /** condition ids created, deduped by (file,line) — one condition node per IF line (PL/SQL). */
  private readonly condSeen = new Set<string>();
  /** 1.2: case-branch ids created, deduped by (file,line) — one per match arm (the arm line). */
  private readonly caseBranchSeen = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly ctx: ExtractCtx,
    private readonly nodes: Node[],
    private readonly edges: Edge[],
  ) {}

  /**
   * Walk a statement list, pushing action/call sites into `sites` (mutated). `guardStack` is the
   * outer→inner condition chain; each frame is `{ condId, branch }`. Passed by value via spread.
   */
  walkBody(
    stmts: RustStmt[],
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    for (const s of stmts) this.walkStmt(s, procId, guardStack, inLoop, inException, sites);
  }

  private walkStmt(
    s: RustStmt,
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    switch (s.kind) {
      case 'if':
        this.walkIf(s, procId, guardStack, inLoop, inException, sites);
        break;
      case 'loop':
        this.walkLoop(s, procId, guardStack, inLoop, inException, sites);
        break;
      case 'match':
        this.walkMatch(s, procId, guardStack, inLoop, inException, sites);
        break;
      case 'block':
        // passthrough block (`unsafe { ... }` / bare `{ ... }`) — same guard stack, same flags
        this.walkBody(s.body, procId, guardStack, inLoop, inException, sites);
        break;
      case 'call':
      case 'return':
      case 'throw':
        this.addAction(s, procId, guardStack, inLoop, inException, sites);
        break;
      case 'assign':
        this.addAssign(s, procId, guardStack, inLoop, inException, sites);
        break;
    }
  }

  /**
   * if/else-if/else — ONE condition node per chain, keyed by the IF line (PL/SQL convention: all
   * branches share the condId; the per-branch polarity THEN/ELSIF/ELSE rides on the EDGE.branch).
   */
  private walkIf(
    s: RustStmt & { kind: 'if' },
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    const condId = this.condition(s.predicate, s.line, 'THEN');
    this.walkBody(
      s.then,
      procId,
      [...guardStack, { condId, branch: 'THEN' }],
      inLoop,
      inException,
      sites,
    );
    for (const elif of s.elifs) {
      // elif shares the IF's condId (one-condition-per-IF); edge polarity = ELSIF.
      this.walkBody(
        elif.body,
        procId,
        [...guardStack, { condId, branch: 'ELSIF' }],
        inLoop,
        inException,
        sites,
      );
    }
    if (s.else) {
      this.walkBody(
        s.else,
        procId,
        [...guardStack, { condId, branch: 'ELSE' }],
        inLoop,
        inException,
        sites,
      );
    }
  }

  /** for/while/loop — one condition (branch:'LOOP') when a predicate exists; `loop {}` has none. */
  private walkLoop(
    s: RustStmt & { kind: 'loop' },
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    const condId = s.predicate ? this.condition(s.predicate, s.line, 'LOOP') : undefined;
    const frame: GuardFrame | undefined = condId ? { condId, branch: 'LOOP' } : undefined;
    const newStack = frame ? [...guardStack, frame] : guardStack;
    this.walkBody(s.body, procId, newStack, true, inException, sites);
  }

  /** match — 1.2: each arm emits a `case-branch` node (whenSelector = the arm pattern; `_` for the
   *  default arm) and the arm body is walked under that guard. Mirrors PlSqlExtractor.walkCase and
   *  the existing if-walk guard logic (one guard frame per arm, branch:'CASE'). */
  private walkMatch(
    s: RustStmt & { kind: 'match' },
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    for (const arm of s.arms) {
      const condId = this.caseBranch(arm.pat || '_', arm.line);
      this.walkBody(
        arm.body,
        procId,
        [...guardStack, { condId, branch: 'CASE' }],
        inLoop,
        inException,
        sites,
      );
    }
  }

  /**
   * Emit a statement node + executes edge (+ guarded-by) for a call/return action line. 1.2: a
   * `panic!()` throw or a `return Err(…)` (isErrReturn) is routed to {@link addRaise} instead —
   * Rust's closest throw analog gets a `raise` node + `raises` edge (PL/SQL parity), with the guard
   * chain stamped on the `raises` edge and a `guarded-by` edge to the innermost condition.
   */
  private addAction(
    s: RustStmt & { kind: 'call' | 'return' | 'throw' },
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    if (s.kind === 'throw' || (s.kind === 'return' && s.isErrReturn)) {
      this.addRaise(s, procId, guardStack, inLoop, inException, sites);
      return;
    }
    const line = s.line;
    const id = this.ctx.idFor('statement', { file: this.path, line });
    const cfgPath = guardStack.map((g) => g.condId);
    const last = guardStack[guardStack.length - 1];
    const node: Node = {
      id,
      kind: 'statement',
      type: s.kind,
      ...exprFields(s.text),
      file: this.path,
      span: { start: line, end: line },
      lang: 'rust',
      hash: this.ctx.hash(`${this.path}:${line}:${s.kind}`),
      meta: {
        ...(s.callee ? { head: s.callee } : {}),
        inLoop,
        inException,
        ...(last ? { branch: 'GUARDED' } : {}),
      },
    };
    this.nodes.push(node);
    // executes: procedure → statement, stamped with the guard chain (the whole point).
    this.edges.push({
      id: edgeId(procId, id, 'executes'),
      src: procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'rust-extractor', snippet: s.callee ?? s.text ?? s.kind },
      cfgPath,
      ...(last ? { guard: last.condId, branch: last.branch } : {}),
      inLoop,
      inException,
    });
    // guarded-by: statement → innermost condition (graph completeness, mirrors PlSqlExtractor).
    if (last) {
      this.edges.push({
        id: edgeId(id, last.condId, 'guarded-by'),
        src: id,
        dst: last.condId,
        rel: 'guarded-by',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'rust-extractor', snippet: last.branch },
      });
    }
    // record a guarded call site (for calls-edge annotation + proc.meta.calls). A `return foo()`
    // still has a call site `foo`; a `throw` (panic!()) has no resolvable callee, so skip it.
    if (s.callee && (s.kind === 'call' || s.kind === 'return')) {
      sites.push({
        callee: s.callee,
        line,
        cfgPath,
        ...(last ? { guard: last.condId, branch: last.branch } : {}),
        inLoop,
        inException,
      });
    }
  }

  /** Emit a condition node (deduped by file+line) and return its id. */
  private condition(expr: string, line: number, branch: string): string {
    const id = this.ctx.idFor('condition', { file: this.path, line });
    if (!this.condSeen.has(id)) {
      this.condSeen.add(id);
      this.nodes.push({
        id,
        kind: 'condition',
        branch,
        ...exprFields(expr),
        file: this.path,
        span: { start: line, end: line },
        lang: 'rust',
        hash: this.ctx.hash(`${this.path}:${line}:${expr}`),
      });
    }
    return id;
  }

  /** 1.2: emit a `case-branch` node (deduped by file+line) and return its id. `whenSelector` is the
   *  arm pattern (`200` / `Foo::A` / `_`); `expr` carries the same text for the decision table. */
  private caseBranch(pat: string, line: number): string {
    const id = this.ctx.idFor('case-branch', { file: this.path, line });
    if (!this.caseBranchSeen.has(id)) {
      this.caseBranchSeen.add(id);
      this.nodes.push({
        id,
        kind: 'case-branch',
        branch: 'CASE',
        expr: pat,
        file: this.path,
        span: { start: line, end: line },
        lang: 'rust',
        hash: this.ctx.hash(`${this.path}:case:${line}:${pat}`),
        whenSelector: pat,
      });
    }
    return id;
  }

  /** 1.2: emit a `raise` node for `panic!()` (throw) / `return Err(…)` (isErrReturn) + a `raises`
   *  edge (proc → raise) with the guard chain stamped inline, + a `guarded-by` edge when guarded.
   *  Capability-honest: a `?` propagation is NOT a raise (only explicit panic!/return Err). */
  private addRaise(
    s: RustStmt & { kind: 'call' | 'return' | 'throw' },
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    const line = s.line;
    const id = this.ctx.idFor('raise', { file: this.path, line });
    const cfgPath = guardStack.map((g) => g.condId);
    const last = guardStack[guardStack.length - 1];
    // `panic` for a throw, `Err` for a return-Err — the raise's "name" (no Rust exception type).
    const name = s.kind === 'throw' ? 'panic' : 'Err';
    const node: Node = {
      id,
      kind: 'raise',
      name,
      file: this.path,
      span: { start: line, end: line },
      lang: 'rust',
      hash: this.ctx.hash(`${this.path}:${line}:raise:${name}`),
      ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
      ...exprFields(s.text),
      meta: { inLoop, inException, ...(last ? { branch: last.branch } : {}) },
    };
    this.nodes.push(node);
    this.edges.push({
      id: edgeId(procId, id, 'raises'),
      src: procId,
      dst: id,
      rel: 'raises',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'rust-extractor', snippet: name },
      cfgPath,
      ...(last ? { guard: last.condId, branch: last.branch } : {}),
      inLoop,
      inException,
    });
    if (last) {
      this.edges.push({
        id: edgeId(id, last.condId, 'guarded-by'),
        src: id,
        dst: last.condId,
        rel: 'guarded-by',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'rust-extractor', snippet: last.branch },
      });
    }
    // a `return Err(foo())` still carries a resolvable call site for `calls`-edge annotation.
    if (s.callee) {
      sites.push({
        callee: s.callee,
        line,
        cfgPath,
        ...(last ? { guard: last.condId, branch: last.branch } : {}),
        inLoop,
        inException,
      });
    }
  }

  /** 1.2: emit an `assignment` node for `let name = …` / `name = …` + an `executes` edge (proc →
   *  assignment) with the guard chain stamped inline, + a `guarded-by` edge when guarded. If the
   *  RHS carries a call, record a guarded call site so the `calls` edge still gets guard-chain. */
  private addAssign(
    s: RustStmt & { kind: 'assign' },
    procId: string,
    guardStack: GuardFrame[],
    inLoop: boolean,
    inException: boolean,
    sites: GuardedCallSite[],
  ): void {
    const line = s.line;
    const id = this.ctx.idFor('assignment', { file: this.path, line });
    const cfgPath = guardStack.map((g) => g.condId);
    const last = guardStack[guardStack.length - 1];
    const node: Node = {
      id,
      kind: 'assignment',
      file: this.path,
      span: { start: line, end: line },
      lang: 'rust',
      hash: this.ctx.hash(`${this.path}:${line}:assign`),
      ...(s.target ? { assignTarget: s.target } : {}),
      ...exprFields(s.text),
      meta: { inLoop, inException, ...(last ? { branch: last.branch } : {}) },
    };
    this.nodes.push(node);
    this.edges.push({
      id: edgeId(procId, id, 'executes'),
      src: procId,
      dst: id,
      rel: 'executes',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'rust-extractor', snippet: 'assign' },
      cfgPath,
      ...(last ? { guard: last.condId, branch: last.branch } : {}),
      inLoop,
      inException,
    });
    if (last) {
      this.edges.push({
        id: edgeId(id, last.condId, 'guarded-by'),
        src: id,
        dst: last.condId,
        rel: 'guarded-by',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'rust-extractor', snippet: last.branch },
      });
    }
    if (s.callee) {
      sites.push({
        callee: s.callee,
        line,
        cfgPath,
        ...(last ? { guard: last.condId, branch: last.branch } : {}),
        inLoop,
        inException,
      });
    }
  }
}
