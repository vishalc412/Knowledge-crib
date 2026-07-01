import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, decisionTable, extractRules, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { RustExtractor } from './RustExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/rust/auth.rs', import.meta.url));
const PATH = 'fixtures/rust/auth.rs';
const RULES_FIXTURE = fileURLToPath(new URL('../../fixtures/rust/rules.rs', import.meta.url));
const RULES_PATH = 'fixtures/rust/rules.rs';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — Rust is hand-rolled, no tree-sitter');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'rust', bytes: text.length, mtime: 0 };
  return new RustExtractor().extract(meta, ctxFor(text));
}

/** label a node id for readable assertions: the symbol's qualified name. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    return n?.kind === 'symbol' ? (n.qualifiedName ?? n.name ?? id) : (n?.kind ?? id);
  };
}

describe('RustExtractor — golden (Rust symbol graph)', () => {
  it('emits struct/enum/trait/impl/fn/method/macro symbols with `::` qualified names', async () => {
    const { nodes } = await run();
    const syms = nodes
      .filter((n) => n.kind === 'symbol')
      .map((n) => `${n.qualifiedName}|${n.type}`)
      .sort();
    expect(syms).toEqual(
      [
        'AuthApi|trait',
        'AuthApi::issue|method',
        'AuthApi::login|method',
        'AuthController|struct',
        'AuthController::issue|method',
        'AuthController::login|method',
        'AuthController::validate|method',
        'Greeter|trait',
        'Greeter::greet|method',
        'Role|enum',
        'Token|struct',
        'UserService|struct',
        'UserService::greet|method',
        'impl AuthApi for AuthController|impl',
        'impl AuthController|impl',
        'impl Greeter for UserService|impl',
        'log|fn',
        'make_map|fn',
        'vec2|macro',
      ].sort(),
    );
  });

  it('captures attributes, modifiers, supertrait bases, impl meta + signatures', async () => {
    const { nodes } = await run();
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q)!;

    // struct: pub + #[derive(Debug)] + #[doc = r#"a raw doc"#]
    expect(byQ('Token').meta?.attributes).toEqual(['derive', 'doc']);
    expect(byQ('Token').meta?.modifiers).toEqual(['pub']);
    expect(byQ('Token').signature).toBe('struct Token');
    expect(byQ('Token').lang).toBe('rust');

    // trait with supertrait → bases (Rust has no class inheritance; bases = supertraits)
    expect(byQ('AuthApi').meta?.bases).toEqual(['Greeter']);
    expect(byQ('AuthApi').signature).toBe('trait AuthApi: Greeter');
    expect(byQ('Greeter').signature).toBe('trait Greeter');
    expect(byQ('Role').type).toBe('enum');
    expect(byQ('Role').signature).toBe('enum Role');

    // impl blocks carry meta.impl = {trait?, type} so the resolver can emit implements edges
    expect(byQ('impl AuthApi for AuthController').meta?.impl).toEqual({
      trait: 'AuthApi',
      type: 'AuthController',
    });
    expect(byQ('impl AuthController').meta?.impl).toEqual({ type: 'AuthController' });
    expect(byQ('impl AuthController').type).toBe('impl');
    expect(byQ('impl AuthApi for AuthController').signature).toBe(
      'impl AuthApi for AuthController',
    );

    // methods (hasSelf) vs free fn
    expect(byQ('AuthController::login').type).toBe('method');
    expect(byQ('AuthController::login').meta?.hasSelf).toBe(true);
    expect(byQ('AuthController::login').signature).toBe('fn login(user)');
    expect(byQ('AuthController::validate').type).toBe('method');
    expect(byQ('log').type).toBe('fn');
    expect(byQ('log').signature).toBe('fn log(msg)');
    expect(byQ('make_map').type).toBe('fn');
    expect(byQ('vec2').type).toBe('macro');
    expect(byQ('vec2').signature).toBe('macro vec2');
  });

  it('emits member-of edges: methods → impl symbol, trait fns → trait, top-level → file', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const memberOf = edges
      .filter((e) => e.rel === 'member-of')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    const fileId = idFor({ kind: 'file', path: PATH });
    expect(memberOf).toEqual(
      [
        'AuthApi -> file',
        'AuthApi::issue -> AuthApi',
        'AuthApi::login -> AuthApi',
        'AuthController -> file',
        'AuthController::issue -> impl AuthApi for AuthController',
        'AuthController::login -> impl AuthApi for AuthController',
        'AuthController::validate -> impl AuthController',
        'Greeter -> file',
        'Greeter::greet -> Greeter',
        'Role -> file',
        'Token -> file',
        'UserService -> file',
        'UserService::greet -> impl Greeter for UserService',
        'impl AuthApi for AuthController -> file',
        'impl AuthController -> file',
        'impl Greeter for UserService -> file',
        'log -> file',
        'make_map -> file',
        'vec2 -> file',
      ]
        .map((s) => s.replace('file', lbl(fileId)))
        .sort(),
    );
  });

  it('emits intra-file calls (bare fn); drops receiver calls, macro calls, external path calls', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    // `log("issued")` inside AuthController::issue resolves to the free fn `log`.
    // `self.validate()` / `self.service.greet()` / `user.is_empty()` — receiver calls → dropped.
    // `panic!()` / `format!()` / `println!()` — macro calls to non-extracted macros → dropped.
    // `HashMap::new()` — external path call → dropped (HashMap is imported, not a symbol).
    // `Token { req: req.req }` — struct literal, not a call.
    expect(calls).toEqual(['AuthController::issue -> log']);
    for (const e of edges.filter((e) => e.rel === 'calls')) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('declares capability-honest capabilities (types:none ⇒ no type edges)', async () => {
    const ext = new RustExtractor();
    expect(ext.capabilities).toEqual({
      imports: true,
      calls: true,
      inheritance: true,
      types: 'none',
    });
    const { edges } = await run();
    // Track 3 + schema 1.2 (additive): member-of/calls/executes/guarded-by are now joined by
    // `raises` (panic! in AuthController::validate) — the Rust error-model fidelity edge. Type
    // edges (reads/writes/inherits/implements/imports/references) stay absent (types:'none').
    const rels = new Set(edges.map((e) => e.rel));
    const present: Rel[] = ['member-of', 'calls', 'executes', 'guarded-by'];
    for (const r of present) {
      expect(rels.has(r)).toBe(true);
    }
    const absentRels: Rel[] = [
      'reads',
      'writes',
      'inherits',
      'implements',
      'imports',
      'references',
    ];
    for (const absent of absentRels) {
      expect(rels.has(absent)).toBe(false);
    }
  });
});

describe('RustExtractor — degradation + id-stability + lexer traps (gate)', () => {
  it('degrades to no symbols on malformed source (no throw)', async () => {
    const garbage = 'struct \n  impl  (((\n  }}}\n';
    const { nodes, edges } = await new RustExtractor().extract(
      { path: 'bad.rs', lang: 'rust', bytes: garbage.length, mtime: 0 },
      ctxFor(garbage),
    );
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('is id-stable: re-running yields byte-identical ids + hashes', async () => {
    const a = await run();
    const b = await run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('handles nested block comments, raw strings, lifetimes + `>>` generics without mis-attributing calls', async () => {
    const src = [
      '// line comment foo()',
      '/* outer /* inner */ outer */',
      'mod m {',
      "  fn f<'a>(x: &'a str) -> u32 { 0 }",
      '  fn g() -> u32 { f("a") }',
      '}',
      'struct S<T> { v: Vec<Vec<T>> }',
      'const C: &str = r#"contains a " and ( paren "#;',
      'fn h() { g() }',
    ].join('\n');
    const { nodes, edges } = await new RustExtractor().extract(
      { path: 'traps.rs', lang: 'rust', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q);
    expect(byQ('m')).toBeDefined();
    expect(byQ('m::f')).toBeDefined();
    expect(byQ('m::g')).toBeDefined();
    expect(byQ('S')).toBeDefined();
    expect(byQ('h')).toBeDefined();
    // nested block comment + raw string must not produce phantom symbols/calls; the only resolvable
    // intra-file calls are bare `g()` inside g (→ m::f) and bare `g()` inside h (→ m::g).
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    expect(calls).toEqual(['h -> m::g', 'm::g -> m::f']);
  });
});

// ---------------------------------------------------------------------------------------------
// Track 3 — statement / condition / CFG edges (the extract_rules decision-table input).
// Mirrors PlSqlExtractor.test.ts Track-2 + verbs.test.ts extract_rules: a guarded procedure emits
// ONE condition node (keyed by the IF line) + per-branch statement nodes with cfgPath/guard/branch
// on the executes edges; a loop body action carries inLoop:true + branch:'LOOP'; and the real
// SoulStore + decisionTable materializes a non-empty decision table with correct conditions.
// ---------------------------------------------------------------------------------------------

async function runRules(text = readFileSync(RULES_FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: RULES_PATH, lang: 'rust', bytes: text.length, mtime: 0 };
  return new RustExtractor().extract(meta, ctxFor(text));
}

describe('RustExtractor — Track 3 statement/condition/CFG edges', () => {
  it('if/else → ONE condition node + per-branch statement nodes + executes edges with cfgPath/guard/branch', async () => {
    const { nodes, edges } = await runRules();
    // authorize's IF → ONE condition node (branch='THEN'), predicate text best-effort.
    const conds = nodes.filter((n) => n.kind === 'condition' && n.expr?.includes('is_empty'));
    expect(conds).toHaveLength(1);
    const condId = conds[0]!.id;
    expect(conds[0]?.branch).toBe('THEN');

    // authorize → two executes edges (deny THEN, grant ELSE), both guarded by the one IF condition.
    const authorize = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'authorize')!;
    const execs = edges.filter((e) => e.rel === 'executes' && e.src === authorize.id);
    expect(execs).toHaveLength(2);
    const thenExec = execs.find((e) => e.branch === 'THEN');
    const elseExec = execs.find((e) => e.branch === 'ELSE');
    expect(thenExec).toBeDefined();
    expect(elseExec).toBeDefined();
    expect(thenExec?.cfgPath).toEqual([condId]);
    expect(thenExec?.guard).toBe(condId);
    expect(thenExec?.inLoop).toBe(false);
    expect(elseExec?.cfgPath).toEqual([condId]);
    expect(elseExec?.guard).toBe(condId);

    // statement node meta carries head + branch:'GUARDED'
    const thenStmt = nodes.find((n) => n.id === thenExec!.dst);
    expect(thenStmt?.type).toBe('call');
    expect(thenStmt?.meta?.head).toBe('deny');
    expect(thenStmt?.meta?.branch).toBe('GUARDED');
    const elseStmt = nodes.find((n) => n.id === elseExec!.dst);
    expect(elseStmt?.meta?.head).toBe('grant');

    // guarded-by: each branch's statement → the IF condition
    expect(
      edges.some((e) => e.rel === 'guarded-by' && e.src === thenExec!.dst && e.dst === condId),
    ).toBe(true);
    expect(
      edges.some((e) => e.rel === 'guarded-by' && e.src === elseExec!.dst && e.dst === condId),
    ).toBe(true);

    // calls edges (authorize → deny / grant) are annotated with the SAME guard chain (best-effort)
    const denySym = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'deny')!;
    const grantSym = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'grant')!;
    const denyCall = edges.find(
      (e) => e.rel === 'calls' && e.src === authorize.id && e.dst === denySym.id,
    );
    const grantCall = edges.find(
      (e) => e.rel === 'calls' && e.src === authorize.id && e.dst === grantSym.id,
    );
    expect(denyCall).toBeDefined();
    expect(denyCall?.cfgPath).toEqual([condId]);
    expect(denyCall?.branch).toBe('THEN');
    expect(grantCall).toBeDefined();
    expect(grantCall?.cfgPath).toEqual([condId]);
    expect(grantCall?.branch).toBe('ELSE');

    // proc.meta.calls records both call sites (so extract_rules recovers call-site lines)
    const sites = authorize.meta?.calls as Array<{ callee: string; line: number }> | undefined;
    expect(sites).toBeDefined();
    expect(sites?.map((s) => s.callee).sort()).toEqual(['deny', 'grant']);
  });

  it('for loop body action → inLoop:true + branch:LOOP condition', async () => {
    const { nodes, edges } = await runRules();
    // validate's `for` → one LOOP condition node, predicate text best-effort.
    const loopConds = nodes.filter((n) => n.kind === 'condition' && n.branch === 'LOOP');
    expect(loopConds).toHaveLength(1);
    const loopCondId = loopConds[0]!.id;
    expect(loopConds[0]?.expr).toContain('roles');

    // loop body: check(role) → executes inLoop:true, branch:'LOOP', cfgPath=[loopCondId]
    const validate = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'validate')!;
    const loopExecs = edges.filter((e) => e.rel === 'executes' && e.src === validate.id);
    expect(loopExecs.length).toBeGreaterThanOrEqual(1);
    const loopExec = loopExecs.find((e) => e.inLoop === true);
    expect(loopExec).toBeDefined();
    expect(loopExec?.branch).toBe('LOOP');
    expect(loopExec?.cfgPath).toEqual([loopCondId]);
    expect(loopExec?.guard).toBe(loopCondId);

    // calls edge validate → check is annotated with inLoop:true + branch:'LOOP'
    const checkSym = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'check')!;
    const checkCall = edges.find(
      (e) => e.rel === 'calls' && e.src === validate.id && e.dst === checkSym.id,
    );
    expect(checkCall).toBeDefined();
    expect(checkCall?.inLoop).toBe(true);
    expect(checkCall?.branch).toBe('LOOP');
    expect(checkCall?.cfgPath).toEqual([loopCondId]);
  });

  it('degradation: a malformed fn body yields no statement/condition nodes, never throws', async () => {
    const src = ['fn bad() {', '    let x = ( missing', '}'].join('\n');
    const { nodes, edges } = await new RustExtractor().extract(
      { path: 'bad.rs', lang: 'rust', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    // the fn symbol is still extracted (well-formed header). 1.2: a well-formed `let x =` prefix
    // still emits an `assignment` node + `executes` edge (the binding is parseable even when the
    // RHS is malformed), but the malformed body produces NO statement/condition/case-branch/raise
    // nodes and NO guarded-by/raises edges (lossy degradation, no throw).
    expect(
      nodes.some(
        (n) =>
          n.kind === 'statement' ||
          n.kind === 'condition' ||
          n.kind === 'case-branch' ||
          n.kind === 'raise',
      ),
    ).toBe(false);
    expect(edges.some((e) => e.rel === 'guarded-by' || e.rel === 'raises')).toBe(false);
    expect(nodes.some((n) => n.kind === 'symbol' && n.name === 'bad')).toBe(true);
  });
});

describe('RustExtractor — extract_rules e2e (extractor → soul → decisionTable)', () => {
  let crib: string;
  let soul: SoulStore;

  beforeEach(() => {
    crib = mkdtempSync(join(tmpdir(), 'crib-rust-rules-'));
    soul = new SoulStore(join(crib, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
  });

  afterEach(() => {
    rmSync(crib, { recursive: true, force: true });
  });

  it('returns a non-empty decision table with correct conditions + actions for a guarded procedure', async () => {
    const { nodes, edges } = await runRules();
    soul.putNodes(nodes);
    soul.putEdges(edges);
    soul.commit('2026-01-01T00:00:00.000Z');

    // Rust fns are typed 'fn'/'method' (not 'procedure'/'function'), so core's findProcedure does
    // not match them by qualified name — pass the proc NODE ID, which findProcedure resolves
    // directly via getNode(id). (No change to core per the spec; this is a documented impedance.)
    const authorize = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'authorize')!;
    const validate = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'validate')!;

    const table = decisionTable(soul, authorize.id);
    expect(table.rules.length).toBeGreaterThan(0);

    // the IF condition (line 7) is the one decision-table column
    const condId = idFor({ kind: 'condition', file: RULES_PATH, line: 7 });
    expect(table.conditions).toContain(condId);

    // a THEN-branch rule whose action is the `calls` edge to `deny`, with the innermost polarity THEN
    const rules = extractRules(soul, authorize.id);
    const thenCall = rules.find(
      (r) => r.branch === 'THEN' && r.action.kind === 'calls' && r.action.expr === 'deny',
    );
    expect(thenCall).toBeDefined();
    expect(thenCall?.guard).toBe(condId);
    expect(thenCall?.conditions[0]?.id).toBe(condId);
    expect(thenCall?.conditions[0]?.polarity).toBe('THEN');
    expect(thenCall?.inLoop).toBe(false);

    // an ELSE-branch rule whose action is the `calls` edge to `grant`, with polarity ELSE
    const elseCall = rules.find(
      (r) => r.branch === 'ELSE' && r.action.kind === 'calls' && r.action.expr === 'grant',
    );
    expect(elseCall).toBeDefined();
    expect(elseCall?.guard).toBe(condId);
    expect(elseCall?.conditions[0]?.polarity).toBe('ELSE');

    // the loop procedure's `check` call surfaces as an inLoop rule with a LOOP condition
    const loopRules = extractRules(soul, validate.id);
    const loopCondId = idFor({ kind: 'condition', file: RULES_PATH, line: 15 });
    const loopCall = loopRules.find(
      (r) => r.inLoop && r.action.kind === 'calls' && r.action.expr === 'check',
    );
    expect(loopCall).toBeDefined();
    expect(loopCall?.guard).toBe(loopCondId);
    expect(loopCall?.branch).toBe('LOOP');
    expect(loopCall?.conditions[0]?.id).toBe(loopCondId);
  });
});

// ---------------------------------------------------------------------------------------------
// schema 1.2 — behavior fidelity nodes (raise / case-branch / assignment / explanation).
// Mirrors PlSqlExtractor schema-1.2 tests but maps Rust's error model capability-honestly:
//   - raise  ← panic!("msg") (throw) + return Err("msg") (isErrReturn); `?` is NOT a raise.
//   - exception-handler ← SKIPPED (Rust has no try/catch; match-on-Result overlaps case-branch).
//   - cursor ← SKIPPED (Rust has no SQL cursors); iterates ← SKIPPED (non-deterministic for-loops).
// ---------------------------------------------------------------------------------------------

const BEHAVIOR_FIXTURE = fileURLToPath(new URL('../../fixtures/rust/behavior.rs', import.meta.url));
const BEHAVIOR_PATH = 'fixtures/rust/behavior.rs';

async function runBehavior(text = readFileSync(BEHAVIOR_FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: BEHAVIOR_PATH, lang: 'rust', bytes: text.length, mtime: 0 };
  return new RustExtractor().extract(meta, ctxFor(text));
}

describe('RustExtractor — schema 1.2 behavior nodes (raise/case-branch/assignment/explanation)', () => {
  it('emits raise nodes for panic!() and return Err(...) with errorMessage + raises edges + guard', async () => {
    const { nodes, edges } = await runBehavior();
    const classify = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'classify')!;
    const raisesEdges = edges.filter((e) => e.rel === 'raises' && e.src === classify.id);
    expect(raisesEdges).toHaveLength(2);
    // both edges are static + EXTRACTED + confidence 1 (parity with PL/SQL)
    for (const e of raisesEdges) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.confidence).toBe(1);
    }
    const raiseNodes = raisesEdges.map((e) => nodes.find((n) => n.id === e.dst)!);
    for (const n of raiseNodes) expect(n.kind).toBe('raise');
    // panic!("unexpected code") → errorMessage "unexpected code"; return Err("zero code") → "zero code"
    const msgs = raiseNodes.map((n) => n.errorMessage).sort();
    expect(msgs).toEqual(['unexpected code', 'zero code']);

    // the return Err is guarded by the `if code == 0` condition (line 5) — guarded-by + raises guard.
    const errRaise = raiseNodes.find((n) => n.errorMessage === 'zero code')!;
    const ifCondId = idFor({ kind: 'condition', file: BEHAVIOR_PATH, line: 5 });
    expect(errRaise.meta?.branch).toBe('THEN');
    expect(
      edges.some((e) => e.rel === 'guarded-by' && e.src === errRaise.id && e.dst === ifCondId),
    ).toBe(true);
    const errRaisesEdge = raisesEdges.find((e) => e.dst === errRaise.id)!;
    expect(errRaisesEdge.guard).toBe(ifCondId);
    expect(errRaisesEdge.branch).toBe('THEN');
    expect(errRaisesEdge.cfgPath).toEqual([ifCondId]);

    // the panic! raise sits inside the `_` match arm — guarded by the case-branch at line 11.
    const panicRaise = raiseNodes.find((n) => n.errorMessage === 'unexpected code')!;
    const armCaseId = idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 11 });
    expect(
      edges.some((e) => e.rel === 'guarded-by' && e.src === panicRaise.id && e.dst === armCaseId),
    ).toBe(true);
  });

  it('emits a case-branch node per match arm with whenSelector = arm pattern (incl. `_` default)', async () => {
    const { nodes } = await runBehavior();
    const arms = nodes.filter((n) => n.kind === 'case-branch');
    expect(arms).toHaveLength(3);
    const selectors = arms.map((n) => n.whenSelector).sort();
    expect(selectors).toEqual(['200', '404', '_']);
    for (const a of arms) {
      expect(a.branch).toBe('CASE');
      expect(a.lang).toBe('rust');
    }
  });

  it('emits an assignment node for `let label = ...` with assignTarget + executes edge', async () => {
    const { nodes, edges } = await runBehavior();
    const assign = nodes.find((n) => n.kind === 'assignment' && n.assignTarget === 'label');
    expect(assign).toBeDefined();
    expect(assign?.lang).toBe('rust');
    const classify = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'classify')!;
    const exec = edges.find(
      (e) => e.rel === 'executes' && e.src === classify.id && e.dst === assign!.id,
    );
    expect(exec).toBeDefined();
    expect(exec?.method).toBe('static');
    expect(exec?.provenance).toBe('EXTRACTED');
  });

  it('emits an explanation node for the /// doc comment + describes edge to classify', async () => {
    const { nodes, edges } = await runBehavior();
    const classify = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'classify')!;
    const expl = nodes.find((n) => n.kind === 'explanation');
    expect(expl).toBeDefined();
    expect(expl?.commentRef?.file).toBe(BEHAVIOR_PATH);
    expect(expl?.commentRef?.span).toEqual({ start: 1, end: 2 });
    expect(String(expl?.meta?.text ?? '')).toContain('Classify a status code');
    const describes = edges.find(
      (e) => e.rel === 'describes' && e.src === expl!.id && e.dst === classify.id,
    );
    expect(describes).toBeDefined();
    expect(describes?.method).toBe('static');
    expect(describes?.provenance).toBe('EXTRACTED');
  });

  it('existing executes/calls/guarded-by still present + intra-file call classify → mk_label resolves', async () => {
    const { nodes, edges } = await runBehavior();
    const rels = new Set(edges.map((e) => e.rel));
    expect(rels.has('executes')).toBe(true);
    expect(rels.has('calls')).toBe(true);
    expect(rels.has('guarded-by')).toBe(true);
    // the `let label = mk_label(code)` RHS call resolves to the mk_label symbol (intra-file).
    const classify = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'classify')!;
    const mkLabel = nodes.find((n) => n.kind === 'symbol' && n.qualifiedName === 'mk_label')!;
    const callEdge = edges.find(
      (e) => e.rel === 'calls' && e.src === classify.id && e.dst === mkLabel.id,
    );
    expect(callEdge).toBeDefined();
    expect(callEdge?.evidence?.snippet).toBe('mk_label');
  });

  it('is id-stable across re-runs (deterministic ids + hashes for the 1.2 additions)', async () => {
    const a = await runBehavior();
    const b = await runBehavior();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
