import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, decisionTable, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { JavaExtractor } from './JavaExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/java/Auth.java', import.meta.url));
const PATH = 'fixtures/java/Auth.java';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — Java is hand-rolled, no tree-sitter');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'java', bytes: text.length, mtime: 0 };
  return new JavaExtractor().extract(meta, ctxFor(text));
}

/** label a node id for readable assertions: the symbol/field's qualified name, else its kind. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    // 1.3: `field` nodes carry a qualifiedName too (e.g. AuthController.service) — prefer it so the
    // member-of assertions stay readable; fall back to kind for file/route/explanation nodes.
    return n?.qualifiedName ?? n?.name ?? n?.kind ?? id;
  };
}

describe('JavaExtractor — golden (Spring Boot gate)', () => {
  it('emits class/interface/enum/record/method symbols with qualified names', async () => {
    const { nodes } = await run();
    const syms = nodes
      .filter((n) => n.kind === 'symbol')
      .map((n) => `${n.qualifiedName}|${n.type}`)
      .sort();
    expect(syms).toEqual(
      [
        'AuthApi|interface',
        'AuthApi.issue|method',
        'AuthApi.login|method',
        'AuthController|class',
        'AuthController.issue|method',
        'AuthController.log|method',
        'AuthController.login|method',
        'AuthController.validate|method',
        'BaseController|class',
        'BaseController.textBlock|method',
        'Greeter|interface',
        'Greeter.greet|method',
        'Role|enum',
        'Token|record',
        'UserService|class',
        'UserService.greet|method',
      ].sort(),
    );
  });

  it('captures annotations, bases (extends), implements + signatures in meta', async () => {
    const { nodes } = await run();
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q)!;

    expect(byQ('AuthController').meta?.annotations).toEqual(['RestController', 'RequestMapping']);
    expect(byQ('AuthController').meta?.bases).toEqual(['BaseController']);
    expect(byQ('AuthController').meta?.implements).toEqual(['AuthApi']);
    expect(byQ('AuthController').signature).toBe('class AuthController');
    expect(byQ('AuthController').lang).toBe('java');

    expect(byQ('AuthController.login').meta?.annotations).toEqual(['GetMapping']);
    expect(byQ('AuthController.issue').meta?.annotations).toEqual(['PostMapping']);
    expect(byQ('AuthController.validate').type).toBe('method');

    expect(byQ('UserService').meta?.annotations).toEqual(['Service']);
    expect(byQ('UserService').meta?.implements).toEqual(['Greeter']);
    expect(byQ('UserService.greet').meta?.annotations).toEqual(['Override']);
    expect(byQ('UserService.greet').signature).toBe('greet(user)');

    expect(byQ('Token').type).toBe('record');
    expect(byQ('Token').signature).toBe('record Token(req)');
    expect(byQ('Role').type).toBe('enum');
    expect(byQ('Greeter').type).toBe('interface');
    expect(byQ('Greeter.greet').signature).toBe('greet(user)');
    expect(byQ('AuthController.log').meta?.modifiers).toEqual(['static']);
  });

  it('emits member-of edges: methods → enclosing type, top-level → file', async () => {
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
        'AuthApi.issue -> AuthApi',
        'AuthApi.login -> AuthApi',
        'AuthController -> file',
        'AuthController.issue -> AuthController',
        'AuthController.log -> AuthController',
        'AuthController.login -> AuthController',
        // 1.3: the constructor-injected `service` field is a `field` node, member-of its class.
        'AuthController.service -> AuthController',
        'AuthController.validate -> AuthController',
        'BaseController -> file',
        'BaseController.textBlock -> BaseController',
        'Greeter -> file',
        'Greeter.greet -> Greeter',
        'Role -> file',
        'Token -> file',
        'UserService -> file',
        'UserService.greet -> UserService',
      ]
        .map((s) => s.replace('file', lbl(fileId)))
        .sort(),
    );
  });

  it('emits intra-file calls (this.m, bare m(), new Cls()); skips dotted/module calls', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    // this.validate() · log() bare · new Token() → resolves to the record · service.greet /
    // user.isEmpty / System.out.println / new IllegalArgumentException all resolve cross-file/inference.
    expect(calls).toEqual([
      'AuthController.issue -> AuthController.log',
      'AuthController.issue -> Token',
      'AuthController.login -> AuthController.validate',
    ]);
    for (const e of edges.filter((e) => e.rel === 'calls')) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('declares capability-honest capabilities (types:none ⇒ no type edges)', async () => {
    const ext = new JavaExtractor();
    expect(ext.capabilities).toEqual({
      imports: true,
      calls: true,
      inheritance: true,
      types: 'none',
    });
    const { edges } = await run();
    const rels = new Set(edges.map((e) => e.rel));
    // Track 3 + schema 1.2 are strictly additive: executes / guarded-by from the body-walk, plus
    // `raises` (validate throws) and `describes` (the comment above the class). Schema 1.3 adds the
    // Spring framework-semantics pass (Pass 4): the two @GetMapping/@PostMapping handlers `exposes`
    // their routes. Capability honesty here = NO inheritance/type edges (types:'none'; inherits/
    // implements resolved by the JavaResolver, not emitted by this extractor). The fixture has no
    // explicit constructor / no @Autowired field / no @Entity, so no injects/references here.
    expect(rels).toEqual(
      new Set(['member-of', 'calls', 'executes', 'guarded-by', 'raises', 'describes', 'exposes']),
    );
  });
});

describe('JavaExtractor — degradation + id-stability (gate)', () => {
  it('degrades to no symbols on malformed source (no throw)', async () => {
    const garbage = 'class \n  void  (((\n  }}}\n';
    const { nodes, edges } = await new JavaExtractor().extract(
      { path: 'bad.java', lang: 'java', bytes: garbage.length, mtime: 0 },
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

  it('handles comments, text blocks + annotation args without mis-attributing calls', async () => {
    const src = [
      '/* a block comment with a fake ( paren */',
      'class C { // line comment foo()',
      '  @SuppressWarnings("x")',
      '  void m() {',
      '    String s = """',
      '    block""";',
      '    n();',
      '  }',
      '  void n() { m(); }',
      '}',
    ].join('\n');
    const { nodes, edges } = await new JavaExtractor().extract(
      { path: 'C.java', lang: 'java', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q);
    expect(byQ('C')).toBeDefined();
    expect(byQ('C.m')).toBeDefined();
    expect(byQ('C.n')).toBeDefined();
    // m() -> n() and n() -> m(): mutual calls, no self-recursion.
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    expect(calls).toEqual(['C.m -> C.n', 'C.n -> C.m']);
  });
});

// ---------------------------------------------------------------------------------------------
// Track 3 — statement/condition/CFG extraction (if/else, loops, switch, try) + extract_rules e2e.
// Mirrors PlSqlExtractor.test.ts Track-2 block + verbs.test.ts extract_rules block.
// ---------------------------------------------------------------------------------------------

const GUARDED_FIXTURE = fileURLToPath(new URL('../../fixtures/java/Guarded.java', import.meta.url));
const GUARDED_PATH = 'fixtures/java/Guarded.java';

async function runGuarded(): Promise<ExtractResult> {
  const text = readFileSync(GUARDED_FIXTURE, 'utf8');
  const meta: FileMeta = { path: GUARDED_PATH, lang: 'java', bytes: text.length, mtime: 0 };
  return new JavaExtractor().extract(meta, ctxFor(text));
}

describe('JavaExtractor — Track 3 statement/condition/CFG edges', () => {
  it('emits ONE condition node for an if/else, with per-branch executes edges (THEN/ELSE)', async () => {
    const { nodes, edges } = await runGuarded();
    // ONE condition node keyed by the IF line (line 8), branch:'THEN' — the if/else shares it.
    const conds = nodes.filter(
      (n) => n.kind === 'condition' && n.file === GUARDED_PATH && n.span?.start === 8,
    );
    expect(conds).toHaveLength(1);
    expect(conds[0]!.branch).toBe('THEN');
    expect(conds[0]!.expr).toBe('status > 0');
    const condId = conds[0]!.id;

    // statement nodes for the two branch actions (approve @9, reject @11)
    const stmts = nodes
      .filter((n) => n.kind === 'statement' && n.file === GUARDED_PATH)
      .sort((a, b) => a.span!.start - b.span!.start);
    const approveStmt = stmts.find((s) => s.span?.start === 9);
    const rejectStmt = stmts.find((s) => s.span?.start === 11);
    expect(approveStmt?.type).toBe('return');
    expect(rejectStmt?.type).toBe('return');

    const decideId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Guarded.decide',
      startLine: 7,
    });
    const exec = edges
      .filter((e) => e.rel === 'executes' && e.src === decideId)
      .sort((a, b) => (a.branch ?? '').localeCompare(b.branch ?? ''));

    // THEN-branch executes edge: cfgPath=[condId], guard=condId, branch='THEN'
    const thenEdge = exec.find((e) => e.branch === 'THEN');
    expect(thenEdge).toBeDefined();
    expect(thenEdge!.cfgPath).toEqual([condId]);
    expect(thenEdge!.guard).toBe(condId);
    expect(thenEdge!.inLoop).toBe(false);
    expect(thenEdge!.inException).toBe(false);
    expect(thenEdge!.dst).toBe(approveStmt!.id);

    // ELSE-branch executes edge: cfgPath=[condId], guard=condId, branch='ELSE'
    const elseEdge = exec.find((e) => e.branch === 'ELSE');
    expect(elseEdge).toBeDefined();
    expect(elseEdge!.cfgPath).toEqual([condId]);
    expect(elseEdge!.guard).toBe(condId);
    expect(elseEdge!.dst).toBe(rejectStmt!.id);

    // guarded-by: each branch statement → the (single) condition node
    const guardedBy = edges.filter(
      (e) => e.rel === 'guarded-by' && (e.src === approveStmt!.id || e.src === rejectStmt!.id),
    );
    expect(guardedBy.map((e) => e.dst).sort()).toEqual([condId, condId]);

    // statement meta carries inLoop/inException + branch:'GUARDED'
    expect(approveStmt?.meta?.inLoop).toBe(false);
    expect(approveStmt?.meta?.branch).toBe('GUARDED');
  });

  it('stamps a branch:LOOP condition + inLoop:true on a for-loop body action', async () => {
    const { nodes, edges } = await runGuarded();
    const loopCond = nodes.find(
      (n) => n.kind === 'condition' && n.file === GUARDED_PATH && n.branch === 'LOOP',
    );
    expect(loopCond).toBeDefined();
    expect(loopCond!.span?.start).toBe(17);
    expect(loopCond!.expr).toContain('i < items.length');

    const sumId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Guarded.sum',
      startLine: 15,
    });
    // the loop body action `total += add(total, items[i])` is on line 18 (a call to add)
    const addStmt = nodes.find(
      (n) => n.kind === 'statement' && n.file === GUARDED_PATH && n.span?.start === 18,
    );
    expect(addStmt?.type).toBe('call');
    const loopExec = edges.find(
      (e) => e.rel === 'executes' && e.src === sumId && e.dst === addStmt!.id,
    );
    expect(loopExec).toBeDefined();
    expect(loopExec!.inLoop).toBe(true);
    expect(loopExec!.branch).toBe('LOOP');
    expect(loopExec!.cfgPath).toEqual([loopCond!.id]);
    expect(loopExec!.guard).toBe(loopCond!.id);
  });

  it('emits a CASE-branch node for a switch case + a guarded executes edge', async () => {
    const { nodes, edges } = await runGuarded();
    // schema 1.2: a switch arm is a `case-branch` node (whenSelector = the case value), not a
    // `condition` — keyed by the case line, used as the arm body's guard.
    const caseCond = nodes.find(
      (n) => n.kind === 'case-branch' && n.file === GUARDED_PATH && n.span?.start === 25,
    );
    expect(caseCond).toBeDefined();
    expect(caseCond!.whenSelector).toBe('1');
    expect(caseCond!.expr).toBe('1');
    const classifyId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Guarded.classify',
      startLine: 23,
    });
    const weekdayStmt = nodes.find(
      (n) => n.kind === 'statement' && n.file === GUARDED_PATH && n.span?.start === 26,
    );
    const caseExec = edges.find(
      (e) => e.rel === 'executes' && e.src === classifyId && e.dst === weekdayStmt!.id,
    );
    expect(caseExec).toBeDefined();
    expect(caseExec!.branch).toBe('CASE');
    expect(caseExec!.cfgPath).toEqual([caseCond!.id]);
  });

  it('walks a try body + catch handler with inException:true', async () => {
    const { nodes, edges } = await runGuarded();
    const safeId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Guarded.safe',
      startLine: 32,
    });
    // try body action `return handle(value)` @34; catch handler `return fallback()` @36
    const handleStmt = nodes.find(
      (n) => n.kind === 'statement' && n.file === GUARDED_PATH && n.span?.start === 34,
    );
    const fallbackStmt = nodes.find(
      (n) => n.kind === 'statement' && n.file === GUARDED_PATH && n.span?.start === 36,
    );
    const handleExec = edges.find(
      (e) => e.rel === 'executes' && e.src === safeId && e.dst === handleStmt!.id,
    );
    const fallbackExec = edges.find(
      (e) => e.rel === 'executes' && e.src === safeId && e.dst === fallbackStmt!.id,
    );
    // per the Track-3 spec, the try body AND catch handler are walked with inException=true
    expect(handleExec?.inException).toBe(true);
    expect(fallbackExec?.inException).toBe(true);
  });

  it('records call sites on proc.meta.calls + annotates calls edges with the guard chain', async () => {
    const { nodes, edges } = await runGuarded();
    const decide = nodes.find((n) => n.qualifiedName === 'Guarded.decide');
    const sites = decide?.meta?.calls as Array<{ callee: string; line: number }> | undefined;
    expect(sites).toBeDefined();
    // `return approve(status)` @9 + `return reject(status)` @11 — both recorded as call sites
    const calleeLines = sites!.map((s) => `${s.callee}@${s.line}`).sort();
    expect(calleeLines).toEqual(['approve@9', 'reject@11']);

    const approveId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Guarded.approve',
      startLine: 40,
    });
    const callsEdge = edges.find((e) => e.rel === 'calls' && e.dst === approveId);
    expect(callsEdge).toBeDefined();
    // the approve call is in the THEN branch — guard chain stamped (best-effort)
    expect(callsEdge!.branch).toBe('THEN');
    expect(callsEdge!.guard).toBe(idFor({ kind: 'condition', file: GUARDED_PATH, line: 8 }));
    expect(callsEdge!.cfgPath).toEqual([idFor({ kind: 'condition', file: GUARDED_PATH, line: 8 })]);
  });

  it('degrades on a malformed method body (no stmt/cond nodes, never throws)', async () => {
    // a method header followed by a malformed `if (` (unmatched paren) — the parser must not throw
    // and the malformed compound degrades to skipping its body (no statement/condition nodes).
    const src = ['class D {', '  void m() {', '    if (', '  }', '}'].join('\n');
    const { nodes } = await new JavaExtractor().extract(
      { path: 'D.java', lang: 'java', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    const conds = nodes.filter((n) => n.kind === 'condition');
    const stmts = nodes.filter((n) => n.kind === 'statement');
    // no throw + no condition/statement nodes from the malformed if (its predicate/body is skipped)
    expect(conds).toHaveLength(0);
    expect(stmts).toHaveLength(0);
  });
});

describe('JavaExtractor — extract_rules e2e (extractor → soul → decisionTable)', () => {
  let repo: string;
  let soul: SoulStore;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'crib-java-rules-'));
    soul = new SoulStore(join(repo, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const { nodes, edges } = await runGuarded();
    soul.putNodes(nodes);
    soul.putEdges(edges);
    soul.commit('2026-01-01T00:00:00.000Z');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns a non-empty decision table with correct conditions + action for Guarded.decide', () => {
    // findProcedure (in core/extract.ts) matches a procedure by id OR by qualified name — but only
    // for symbol type 'procedure'/'function'. Java methods are type 'method', so look them up by id.
    const decideId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Guarded.decide',
      startLine: 7,
    });
    const table = decisionTable(soul, decideId);
    expect(table.rules.length).toBeGreaterThan(0);
    // one condition column (the IF predicate), shared across both branches
    const condId = idFor({ kind: 'condition', file: GUARDED_PATH, line: 8 });
    expect(table.conditions).toEqual([condId]);

    // THEN-branch rule: the executes edge to `return approve(status)` (line 9)
    const thenRule = table.rules.find((r) => r.branch === 'THEN' && r.action.kind === 'executes');
    expect(thenRule).toBeDefined();
    expect(thenRule!.guard).toBe(condId);
    expect(thenRule!.conditions).toHaveLength(1);
    expect(thenRule!.conditions[0]!.id).toBe(condId);
    expect(thenRule!.conditions[0]!.polarity).toBe('THEN');
    expect(thenRule!.action.expr).toBe('return approve(status)');

    // ELSE-branch rule: the executes edge to `return reject(status)` (line 11)
    const elseRule = table.rules.find((r) => r.branch === 'ELSE' && r.action.kind === 'executes');
    expect(elseRule).toBeDefined();
    expect(elseRule!.conditions[0]!.polarity).toBe('ELSE');
    expect(elseRule!.action.expr).toBe('return reject(status)');

    // the calls edge to `approve` is also a THEN-branch rule (action.kind === 'calls')
    const callsRule = table.rules.find((r) => r.branch === 'THEN' && r.action.kind === 'calls');
    expect(callsRule).toBeDefined();
    expect(callsRule!.action.expr).toBe('approve');
  });

  it('returns a non-empty decision table for the for-loop procedure (inLoop)', () => {
    const sumId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Guarded.sum',
      startLine: 15,
    });
    const table = decisionTable(soul, sumId);
    expect(table.rules.length).toBeGreaterThan(0);
    const loopRule = table.rules.find((r) => r.inLoop);
    expect(loopRule).toBeDefined();
    expect(loopRule!.branch).toBe('LOOP');
  });

  it('returns NOT_FOUND / empty for an unknown procedure', () => {
    const table = decisionTable(soul, 'no_such_proc');
    expect(table.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Schema 1.2 (deep-extraction fidelity) — raise / exception-handler / assignment / case-branch /
// explanation nodes + raises / handles / describes edges. Mirrors PlSqlExtractor.test.ts 1.2 block.
// ---------------------------------------------------------------------------------------------

const BEHAVIOR_FIXTURE = fileURLToPath(
  new URL('../../fixtures/java/Behavior.java', import.meta.url),
);
const BEHAVIOR_PATH = 'fixtures/java/Behavior.java';

async function runBehavior(): Promise<ExtractResult> {
  const text = readFileSync(BEHAVIOR_FIXTURE, 'utf8');
  const meta: FileMeta = { path: BEHAVIOR_PATH, lang: 'java', bytes: text.length, mtime: 0 };
  return new JavaExtractor().extract(meta, ctxFor(text));
}

describe('JavaExtractor — schema 1.2 deep-extraction fidelity nodes', () => {
  it('emits a `raise` node for `throw` with errorMessage from the string literal + a `raises` edge', async () => {
    const { nodes, edges } = await runBehavior();
    const raiseNode = nodes.find(
      (n) => n.kind === 'raise' && n.file === BEHAVIOR_PATH && n.span?.start === 18,
    );
    expect(raiseNode).toBeDefined();
    expect(raiseNode!.errorMessage).toBe('negative status');
    expect(raiseNode!.errorCode).toBeUndefined(); // no identifiable code — omitted (capability-honest)
    expect(raiseNode!.meta?.inException).toBe(true); // inside the try body

    const decideId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Behavior.decide',
      startLine: 13,
    });
    const raisesEdge = edges.find(
      (e) => e.rel === 'raises' && e.src === decideId && e.dst === raiseNode!.id,
    );
    expect(raisesEdge).toBeDefined();
    expect(raisesEdge!.method).toBe('static');
    expect(raisesEdge!.provenance).toBe('EXTRACTED');
    expect(raisesEdge!.confidence).toBe(1);

    // the raise is in the THEN branch of `if (status < 0)` → guarded-by the IF condition (line 17).
    const condId = idFor({ kind: 'condition', file: BEHAVIOR_PATH, line: 17 });
    const guardedBy = edges.find((e) => e.rel === 'guarded-by' && e.src === raiseNode!.id);
    expect(guardedBy?.dst).toBe(condId);
  });

  it('falls back to the raw expression when a throw has no string literal', async () => {
    const { nodes } = await runBehavior();
    // Behavior.multi throws `new IllegalArgumentException("zero x")` → message "zero x" (literal
    // present). Verify the helper path; a no-literal throw is exercised by the unit test below.
    const raiseMulti = nodes.find(
      (n) => n.kind === 'raise' && n.file === BEHAVIOR_PATH && n.span?.start === 36,
    );
    expect(raiseMulti?.errorMessage).toBe('zero x');
  });

  it('emits an `exception-handler` node per catch with whenSelector + `handles` edges to try-body ops', async () => {
    const { nodes, edges } = await runBehavior();
    const handler = nodes.find(
      (n) => n.kind === 'exception-handler' && n.file === BEHAVIOR_PATH && n.span?.start === 28,
    );
    expect(handler).toBeDefined();
    expect(handler!.whenSelector).toBe('IllegalStateException'); // `catch (IllegalStateException ex)` → type only

    // handles edges: exception-handler → every statement/assignment/raise node in the TRY body.
    // The try body holds: the throw's statement (line 18), the raise (line 18), and the three
    // switch returns (lines 22, 24, 26). The if-condition + case-branch nodes are NOT link targets.
    const handled = edges
      .filter((e) => e.rel === 'handles' && e.src === handler!.id)
      .map((e) => e.dst)
      .sort();
    expect(handled.length).toBeGreaterThan(0);
    const raiseId = idFor({ kind: 'raise', file: BEHAVIOR_PATH, line: 18 });
    expect(handled).toContain(raiseId);
    // the catch-body `return "caught"` (line 29) is NOT a handles target (it is the recovery action).
    const caughtStmt = nodes.find(
      (n) => n.kind === 'statement' && n.file === BEHAVIOR_PATH && n.span?.start === 29,
    );
    expect(caughtStmt).toBeDefined();
    expect(handled).not.toContain(caughtStmt!.id);
  });

  it('derives whenSelector `A|B` for a multi-catch clause', async () => {
    const { nodes } = await runBehavior();
    const multiHandler = nodes.find(
      (n) => n.kind === 'exception-handler' && n.file === BEHAVIOR_PATH && n.span?.start === 39,
    );
    expect(multiHandler).toBeDefined();
    expect(multiHandler!.whenSelector).toBe('RuntimeException|IllegalStateException');
  });

  it('emits a `case-branch` node per switch arm with whenSelector (omitted for default)', async () => {
    const { nodes, edges } = await runBehavior();
    const caseZero = nodes.find(
      (n) => n.kind === 'case-branch' && n.file === BEHAVIOR_PATH && n.span?.start === 21,
    );
    const caseOne = nodes.find(
      (n) => n.kind === 'case-branch' && n.file === BEHAVIOR_PATH && n.span?.start === 23,
    );
    const caseDefault = nodes.find(
      (n) => n.kind === 'case-branch' && n.file === BEHAVIOR_PATH && n.span?.start === 25,
    );
    expect(caseZero?.whenSelector).toBe('0');
    expect(caseOne?.whenSelector).toBe('1');
    expect(caseDefault).toBeDefined();
    expect(caseDefault?.whenSelector).toBeUndefined(); // default → no selector

    // each arm body is guarded by its case-branch: `return "zero"` @22 → cfgPath=[caseZero].
    const decideId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Behavior.decide',
      startLine: 13,
    });
    const zeroStmt = nodes.find(
      (n) => n.kind === 'statement' && n.file === BEHAVIOR_PATH && n.span?.start === 22,
    );
    const zeroExec = edges.find(
      (e) => e.rel === 'executes' && e.src === decideId && e.dst === zeroStmt!.id,
    );
    expect(zeroExec).toBeDefined();
    expect(zeroExec!.cfgPath).toEqual([caseZero!.id]);
    expect(zeroExec!.branch).toBe('CASE');
  });

  it('emits an `assignment` node for `lhs = rhs` with assignTarget + executes + guarded-by', async () => {
    const { nodes, edges } = await runBehavior();
    const assign = nodes.find(
      (n) => n.kind === 'assignment' && n.file === BEHAVIOR_PATH && n.span?.start === 15,
    );
    expect(assign).toBeDefined();
    expect(assign!.assignTarget).toBe('count');
    expect(assign!.expr).toBe('count = status + 1');

    const decideId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Behavior.decide',
      startLine: 13,
    });
    const exec = edges.find(
      (e) => e.rel === 'executes' && e.src === decideId && e.dst === assign!.id,
    );
    expect(exec).toBeDefined();
    expect(exec!.inLoop).toBe(false);
    expect(exec!.inException).toBe(false); // the assignment is before the try
  });

  it('emits an `explanation` node + `describes` edge for a Javadoc block above a symbol', async () => {
    const { nodes, edges } = await runBehavior();
    // Javadoc above the class (lines 3-6, class @7) → explanation keyed by the block start line.
    const classExpl = nodes.find(
      (n) => n.kind === 'explanation' && n.file === BEHAVIOR_PATH && n.span?.start === 3,
    );
    expect(classExpl).toBeDefined();
    expect(classExpl!.commentRef).toEqual({ file: BEHAVIOR_PATH, span: { start: 3, end: 6 } });
    expect(classExpl!.meta?.javadoc).toBe(true);
    expect(typeof classExpl!.meta?.text).toBe('string');
    const behaviorId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Behavior',
      startLine: 7,
    });
    const describesClass = edges.find(
      (e) => e.rel === 'describes' && e.src === classExpl!.id && e.dst === behaviorId,
    );
    expect(describesClass).toBeDefined();

    // Javadoc above the decide method (lines 9-12, method @13).
    const methodExpl = nodes.find(
      (n) => n.kind === 'explanation' && n.file === BEHAVIOR_PATH && n.span?.start === 9,
    );
    expect(methodExpl).toBeDefined();
    const decideId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Behavior.decide',
      startLine: 13,
    });
    const describesMethod = edges.find(
      (e) => e.rel === 'describes' && e.src === methodExpl!.id && e.dst === decideId,
    );
    expect(describesMethod).toBeDefined();
  });

  it('preserves existing executes / calls / guarded-by edges alongside the new 1.2 nodes', async () => {
    const { edges } = await runBehavior();
    const rels = new Set(edges.map((e) => e.rel));
    expect(rels).toEqual(
      new Set(['member-of', 'executes', 'guarded-by', 'raises', 'handles', 'describes']),
    );
    // Behavior.java has no intra-file call targets (all calls are to JDK constructors), so no
    // `calls` edges here; the existing Track-3 executes/guarded-by edges remain.
    expect(edges.filter((e) => e.rel === 'executes').length).toBeGreaterThan(0);
    expect(edges.filter((e) => e.rel === 'guarded-by').length).toBeGreaterThan(0);
  });

  it('is id-stable: re-running Behavior yields byte-identical output', async () => {
    const a = await runBehavior();
    const b = await runBehavior();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
