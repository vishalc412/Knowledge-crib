import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, decisionTable, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { CsharpExtractor } from './CsharpExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/csharp/Auth.cs', import.meta.url));
const PATH = 'fixtures/csharp/Auth.cs';
const GUARDED = fileURLToPath(new URL('../../fixtures/csharp/Guarded.cs', import.meta.url));
const GUARDED_PATH = 'fixtures/csharp/Guarded.cs';
const BEHAVIOR = fileURLToPath(new URL('../../fixtures/csharp/Behavior.cs', import.meta.url));
const BEHAVIOR_PATH = 'fixtures/csharp/Behavior.cs';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — C# is hand-rolled, no tree-sitter');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'csharp', bytes: text.length, mtime: 0 };
  return new CsharpExtractor().extract(meta, ctxFor(text));
}

/** Run the extractor on the Track 3 guarded-procedure fixture (if/else + foreach). */
async function runGuarded(text = readFileSync(GUARDED, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: GUARDED_PATH, lang: 'csharp', bytes: text.length, mtime: 0 };
  return new CsharpExtractor().extract(meta, ctxFor(text));
}

/** Run the extractor on the schema-1.2 behavior fixture (throw / try-catch+when / switch / assignment / /// doc). */
async function runBehavior(text = readFileSync(BEHAVIOR, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: BEHAVIOR_PATH, lang: 'csharp', bytes: text.length, mtime: 0 };
  return new CsharpExtractor().extract(meta, ctxFor(text));
}

/** label a node id for readable assertions: the symbol's qualified name. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    return n?.kind === 'symbol' ? (n.qualifiedName ?? n.name ?? id) : (n?.kind ?? id);
  };
}

describe('CsharpExtractor — golden (ASP.NET-style gate)', () => {
  it('emits namespace/class/interface/struct/record/enum/method symbols with qualified names', async () => {
    const { nodes } = await run();
    const syms = nodes
      .filter((n) => n.kind === 'symbol')
      .map((n) => `${n.qualifiedName}|${n.type}`)
      .sort();
    expect(syms).toEqual(
      [
        'Crib.Auth|namespace',
        'Crib.Auth.AuthController|class',
        'Crib.Auth.AuthController.Issue|method',
        'Crib.Auth.AuthController.Log|method',
        'Crib.Auth.AuthController.Login|method',
        'Crib.Auth.AuthController.Validate|method',
        'Crib.Auth.BaseController|class',
        'Crib.Auth.BaseController.Banner|method',
        'Crib.Auth.IAuthApi|interface',
        'Crib.Auth.IAuthApi.Issue|method',
        'Crib.Auth.IAuthApi.Login|method',
        'Crib.Auth.IGreeter|interface',
        'Crib.Auth.IGreeter.Greet|method',
        'Crib.Auth.Role|enum',
        'Crib.Auth.Token|record',
        'Crib.Auth.UserService|class',
        'Crib.Auth.UserService.Greet|method',
      ].sort(),
    );
  });

  it('captures attributes, bases (`:` split), implements + signatures in meta', async () => {
    const { nodes } = await run();
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q)!;

    expect(byQ('Crib.Auth.AuthController').meta?.attributes).toEqual(['ApiController', 'Route']);
    expect(byQ('Crib.Auth.AuthController').meta?.bases).toEqual(['BaseController']);
    expect(byQ('Crib.Auth.AuthController').meta?.implements).toEqual(['IAuthApi']);
    expect(byQ('Crib.Auth.AuthController').signature).toBe('class AuthController');
    expect(byQ('Crib.Auth.AuthController').lang).toBe('csharp');

    expect(byQ('Crib.Auth.AuthController.Login').meta?.attributes).toEqual(['HttpGet']);
    expect(byQ('Crib.Auth.AuthController.Issue').meta?.attributes).toEqual(['HttpPost']);
    expect(byQ('Crib.Auth.AuthController.Validate').type).toBe('method');

    expect(byQ('Crib.Auth.UserService').meta?.attributes).toEqual(['Service']);
    expect(byQ('Crib.Auth.UserService').meta?.implements).toEqual(['IGreeter']);
    expect(byQ('Crib.Auth.UserService.Greet').meta?.modifiers).toEqual(['public', 'override']);
    expect(byQ('Crib.Auth.UserService.Greet').signature).toBe('Greet(user)');

    expect(byQ('Crib.Auth.Token').type).toBe('record');
    expect(byQ('Crib.Auth.Token').signature).toBe('record Token(req)');
    expect(byQ('Crib.Auth.Role').type).toBe('enum');
    expect(byQ('Crib.Auth.IGreeter').type).toBe('interface');
    expect(byQ('Crib.Auth.IGreeter.Greet').signature).toBe('Greet(user)');
    expect(byQ('Crib.Auth.AuthController.Log').meta?.modifiers).toEqual(['static']);
  });

  it('emits member-of edges: methods → enclosing type, types → namespace, namespace → file', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const memberOf = edges
      .filter((e) => e.rel === 'member-of')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    const fileId = idFor({ kind: 'file', path: PATH });
    expect(memberOf).toEqual(
      [
        'Crib.Auth -> file',
        'Crib.Auth.AuthController -> Crib.Auth',
        'Crib.Auth.AuthController.Issue -> Crib.Auth.AuthController',
        'Crib.Auth.AuthController.Log -> Crib.Auth.AuthController',
        'Crib.Auth.AuthController.Login -> Crib.Auth.AuthController',
        'Crib.Auth.AuthController.Validate -> Crib.Auth.AuthController',
        'Crib.Auth.BaseController -> Crib.Auth',
        'Crib.Auth.BaseController.Banner -> Crib.Auth.BaseController',
        'Crib.Auth.IAuthApi -> Crib.Auth',
        'Crib.Auth.IAuthApi.Issue -> Crib.Auth.IAuthApi',
        'Crib.Auth.IAuthApi.Login -> Crib.Auth.IAuthApi',
        'Crib.Auth.IGreeter -> Crib.Auth',
        'Crib.Auth.IGreeter.Greet -> Crib.Auth.IGreeter',
        'Crib.Auth.Role -> Crib.Auth',
        'Crib.Auth.Token -> Crib.Auth',
        'Crib.Auth.UserService -> Crib.Auth',
        'Crib.Auth.UserService.Greet -> Crib.Auth.UserService',
      ]
        .map((s) => s.replace('file', lbl(fileId)))
        .sort(),
    );
  });

  it('emits intra-file calls (this.M, bare M(), new Cls()); skips dotted/module calls', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    // this.Validate() · Log() bare · new Token() → resolves to the record · service.Greet /
    // user.Length / System.Console.WriteLine / new System.ArgumentException all resolve cross-file /
    // inference / dotted-tail → dropped.
    expect(calls).toEqual([
      'Crib.Auth.AuthController.Issue -> Crib.Auth.AuthController.Log',
      'Crib.Auth.AuthController.Issue -> Crib.Auth.Token',
      'Crib.Auth.AuthController.Login -> Crib.Auth.AuthController.Validate',
    ]);
    for (const e of edges.filter((e) => e.rel === 'calls')) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('declares capability-honest capabilities (types:none ⇒ no type edges)', async () => {
    const ext = new CsharpExtractor();
    expect(ext.capabilities).toEqual({
      imports: true,
      calls: true,
      inheritance: true,
      types: 'none',
    });
    const { edges } = await run();
    const rels = new Set(edges.map((e) => e.rel));
    // Track 3 adds executes + guarded-by (statement/condition CFG emission); schema 1.2 adds
    // `raises` (Validate throws) + `describes` (the class doc comment) — strictly additive. The
    // capability-honesty intent (types:'none' ⇒ no reads/writes/inherits type edges) still holds.
    expect(rels).toEqual(
      new Set(['member-of', 'calls', 'executes', 'guarded-by', 'raises', 'describes']),
    );
  });
});

describe('CsharpExtractor — degradation + id-stability (gate)', () => {
  it('degrades to no symbols on malformed source (no throw)', async () => {
    const garbage = 'class \n  void  (((\n  }}}\n';
    const { nodes, edges } = await new CsharpExtractor().extract(
      { path: 'bad.cs', lang: 'csharp', bytes: garbage.length, mtime: 0 },
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

  it('handles comments, verbatim strings + attribute args without mis-attributing calls', async () => {
    const src = [
      '/* a block comment with a fake ( paren */',
      'class C { // line comment Foo()',
      '  [Suppress("x")]',
      '  void M() {',
      '    string s = @"verbatim "" with fake ( paren";',
      '    N();',
      '  }',
      '  void N() { M(); }',
      '}',
    ].join('\n');
    const { nodes, edges } = await new CsharpExtractor().extract(
      { path: 'C.cs', lang: 'csharp', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q);
    expect(byQ('C')).toBeDefined();
    expect(byQ('C.M')).toBeDefined();
    expect(byQ('C.N')).toBeDefined();
    // M() -> N() and N() -> M(): mutual calls, no self-recursion.
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    expect(calls).toEqual(['C.M -> C.N', 'C.N -> C.M']);
  });
});

// ── Track 3: statement / condition / CFG extraction (extract_rules decision-table verb) ──────
// The body-walk emits statement + condition nodes, executes/guarded-by edges (annotated with the
// guard chain cfgPath/guard/branch/inLoop/inException), and annotates intra-file `calls` edges with
// the same guard fields — the language-agnostic `extract_rules`/`decisionTable` consumes those.

describe('CsharpExtractor — Track 3 if/else + loops (guarded procedure)', () => {
  it('emits ONE condition node per IF (keyed by the if-line) + per-branch statement nodes', async () => {
    const { nodes, edges } = await runGuarded();
    const conds = nodes.filter((n) => n.kind === 'condition');
    // one condition for the IF (line 7, branch THEN, predicate "x > 0")
    const ifCond = conds.find((c) => c.span?.start === 7);
    expect(ifCond).toBeDefined();
    expect(ifCond?.branch).toBe('THEN');
    expect(ifCond?.expr).toBe('x > 0');
    // all IF branches share the SAME condition id (one condition node per IF, not per branch)
    expect(conds.filter((c) => c.span?.start === 7)).toHaveLength(1);

    // statement nodes for the THEN (Approve), ELSE (Reject), and post-if return
    const stmts = nodes.filter((n) => n.kind === 'statement');
    const approve = stmts.find((s) => s.span?.start === 9 && s.type === 'call');
    const reject = stmts.find((s) => s.span?.start === 13 && s.type === 'call');
    const ret = stmts.find((s) => s.span?.start === 15 && s.type === 'return');
    expect(approve?.meta?.head).toBe('Approve');
    expect(reject?.meta?.head).toBe('Reject');
    expect(ret?.expr).toBe('return "done"');
  });

  it('stamps executes edges with cfgPath=[condId], guard=condId, branch THEN/ELSE for each branch', async () => {
    const { nodes, edges } = await runGuarded();
    const procId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Crib.Guarded.GuardService.Decide',
      startLine: 5,
    });
    const ifCondId = idFor({ kind: 'condition', file: GUARDED_PATH, line: 7 });
    const exec = edges.filter((e) => e.rel === 'executes' && e.src === procId);
    // THEN-branch action (Approve at L9): guarded by cond7, branch THEN
    const thenEdge = exec.find(
      (e) => e.dst.startsWith('stmt:') && nodes.find((n) => n.id === e.dst)?.span?.start === 9,
    );
    expect(thenEdge?.cfgPath).toEqual([ifCondId]);
    expect(thenEdge?.guard).toBe(ifCondId);
    expect(thenEdge?.branch).toBe('THEN');
    expect(thenEdge?.inLoop).toBe(false);
    // ELSE-branch action (Reject at L13): same cond7, branch ELSE
    const elseEdge = exec.find((e) => nodes.find((n) => n.id === e.dst)?.span?.start === 13);
    expect(elseEdge?.cfgPath).toEqual([ifCondId]);
    expect(elseEdge?.guard).toBe(ifCondId);
    expect(elseEdge?.branch).toBe('ELSE');
    // post-if return (L15): top level — empty cfgPath, no guard/branch
    const retEdge = exec.find((e) => nodes.find((n) => n.id === e.dst)?.span?.start === 15);
    expect(retEdge?.cfgPath).toEqual([]);
    expect(retEdge?.guard).toBeUndefined();
    expect(retEdge?.branch).toBeUndefined();
  });

  it('emits guarded-by edges from each guarded statement to its innermost condition', async () => {
    const { nodes, edges } = await runGuarded();
    const lbl = (id: string) => {
      const n = nodes.find((x) => x.id === id);
      return n?.kind === 'condition'
        ? `cond:L${n.span?.start}`
        : n?.kind === 'statement'
          ? `stmt:L${n.span?.start}`
          : id;
    };
    const guarded = edges
      .filter((e) => e.rel === 'guarded-by')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    // THEN (L9) + ELSE (L13) guarded by the IF condition (L7); the post-if return is NOT guarded.
    expect(guarded).toContain('stmt:L9 -> cond:L7');
    expect(guarded).toContain('stmt:L13 -> cond:L7');
    expect(guarded.find((g) => g.includes('stmt:L15'))).toBeUndefined();
  });

  it('annotates the intra-file calls edges with the guard chain (THEN/ELSE)', async () => {
    const { nodes, edges } = await runGuarded();
    const lbl = (id: string) => nodes.find((x) => x.id === id)?.qualifiedName ?? id;
    const ifCondId = idFor({ kind: 'condition', file: GUARDED_PATH, line: 7 });
    const decideToApprove = edges.find(
      (e) => e.rel === 'calls' && lbl(e.src).endsWith('Decide') && lbl(e.dst).endsWith('Approve'),
    );
    expect(decideToApprove?.cfgPath).toEqual([ifCondId]);
    expect(decideToApprove?.guard).toBe(ifCondId);
    expect(decideToApprove?.branch).toBe('THEN');
    const decideToReject = edges.find(
      (e) => e.rel === 'calls' && lbl(e.src).endsWith('Decide') && lbl(e.dst).endsWith('Reject'),
    );
    expect(decideToReject?.branch).toBe('ELSE');
  });

  it('records every call site on proc.meta.calls (callee + line)', async () => {
    const { nodes } = await runGuarded();
    const decide = nodes.find((n) => n.qualifiedName === 'Crib.Guarded.GuardService.Decide');
    expect(decide?.meta?.calls).toEqual([
      { callee: 'Approve', line: 9 },
      { callee: 'Reject', line: 13 },
    ]);
  });
});

describe('CsharpExtractor — Track 3 loops (inLoop + branch LOOP)', () => {
  it('emits a LOOP condition + stamps inLoop:true and branch:LOOP on the loop-body executes edge', async () => {
    const { nodes, edges } = await runGuarded();
    const loopCond = nodes.find((n) => n.kind === 'condition' && n.span?.start === 20);
    expect(loopCond?.branch).toBe('LOOP');
    expect(loopCond?.expr).toBe('var x in xs');
    const procId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Crib.Guarded.GuardService.Loop',
      startLine: 18,
    });
    const loopCondId = idFor({ kind: 'condition', file: GUARDED_PATH, line: 20 });
    const exec = edges.find(
      (e) =>
        e.rel === 'executes' &&
        e.src === procId &&
        nodes.find((n) => n.id === e.dst)?.span?.start === 22,
    );
    expect(exec?.cfgPath).toEqual([loopCondId]);
    expect(exec?.guard).toBe(loopCondId);
    expect(exec?.branch).toBe('LOOP');
    expect(exec?.inLoop).toBe(true);
    // the call edge Loop -> Process is annotated with the LOOP guard + inLoop
    const calls = edges.find((e) => e.rel === 'calls' && e.src === procId);
    expect(calls?.cfgPath).toEqual([loopCondId]);
    expect(calls?.branch).toBe('LOOP');
    expect(calls?.inLoop).toBe(true);
  });
});

describe('CsharpExtractor — Track 3 degradation (malformed body)', () => {
  it('a malformed method body yields no statement/condition nodes and never throws', async () => {
    // a garbage body (stray operators only — no `if`/`for`/`while` keyword that would trigger
    // walkIf/walkLoop to mint a condition node) — the body-walk parses no recognisable action
    // statements, so no statement/condition nodes. The file still parses (class + method symbols
    // + the well-formed N body's call).
    const src = [
      'class C {',
      '  void M() {',
      '    = ;',
      '    + ;',
      '  }',
      '  void N() { K(); }',
      '}',
    ].join('\n');
    const { nodes, edges } = await new CsharpExtractor().extract(
      { path: 'bad.cs', lang: 'csharp', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    // never throws — symbols still extracted (M with the garbage body, N well-formed)
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q);
    const m = byQ('C.M');
    const n = byQ('C.N');
    expect(m).toBeDefined();
    expect(n).toBeDefined();
    // the malformed M body yields NO statement/condition nodes (within M's span) and no
    // executes/guarded-by edges out of M — the body-walk degraded to skipping it.
    const mSpan = m?.span;
    const mStmtConds = nodes.filter(
      (node) =>
        (node.kind === 'statement' || node.kind === 'condition') &&
        mSpan &&
        node.span &&
        node.span.start >= mSpan.start &&
        node.span.start <= mSpan.end,
    );
    expect(mStmtConds).toHaveLength(0);
    expect(edges.filter((e) => e.rel === 'executes' && e.src === m?.id)).toHaveLength(0);
    expect(edges.filter((e) => e.rel === 'guarded-by' && e.src === m?.id)).toHaveLength(0);
    // the well-formed N body AFTER M still parses — its K() call is extracted (regression: the
    // malformed M did not make the parser lose the rest of the file).
    expect(edges.filter((e) => e.rel === 'executes' && e.src === n?.id).length).toBeGreaterThan(0);
  });
});

// ── extract_rules end-to-end: extractor → real SoulStore → decisionTable (Track 3) ─────────────
// Mirrors packages/mcp/src/verbs.test.ts extract_rules describe block: load the extractor's output
// into a real SoulStore and assert the language-agnostic decisionTable materializes a non-empty
// table with the correct conditions + actions for a guarded procedure.

describe('CsharpExtractor — Track 3 extract_rules e2e (extractor → soul → decisionTable)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crib-csharp-rules-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('decisionTable for the guarded Decide procedure returns a non-empty table with THEN/ELSE conditions', async () => {
    const r = await runGuarded();
    const soul = new SoulStore(join(tmp, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.putNodes(r.nodes);
    soul.putEdges(r.edges);
    soul.commit('2026-01-01T00:00:00.000Z');

    // decisionTable accepts a node id OR a qualified name. C# methods are emitted as
    // type:'method'; core's findProcedure matches type:'procedure'|'function' on qualified-name
    // lookup but matches ANY type by node id, so pass the symbol id (the extractor's canonical id).
    const decideId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Crib.Guarded.GuardService.Decide',
      startLine: 5,
    });
    const table = decisionTable(soul, decideId);
    // non-empty decision table
    expect(table.rules.length).toBeGreaterThan(0);
    // the IF condition (line 7) is the one condition column
    const ifCondId = idFor({ kind: 'condition', file: GUARDED_PATH, line: 7 });
    expect(table.conditions).toContain(ifCondId);

    // at least one rule (THEN-branch action) has the innermost condition tagged polarity THEN
    const thenRule = table.rules.find((rule) => rule.conditions.some((c) => c.polarity === 'THEN'));
    expect(thenRule).toBeDefined();
    expect(thenRule?.branch).toBe('THEN');
    expect(thenRule?.guard).toBe(ifCondId);
    // the action is an executes or calls edge out of Decide
    expect(['executes', 'calls']).toContain(thenRule?.action.kind);

    // at least one rule (ELSE-branch action) has polarity ELSE
    const elseRule = table.rules.find((rule) => rule.conditions.some((c) => c.polarity === 'ELSE'));
    expect(elseRule).toBeDefined();
    expect(elseRule?.branch).toBe('ELSE');

    // a top-level return rule has NO conditions (empty cfgPath)
    const retRule = table.rules.find(
      (rule) => rule.conditions.length === 0 && rule.action.kind === 'executes',
    );
    expect(retRule).toBeDefined();
    expect(retRule?.inLoop).toBe(false);
  });

  it('decisionTable for the loop body tags inLoop:true + a LOOP condition', async () => {
    const r = await runGuarded();
    const soul = new SoulStore(join(tmp, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.putNodes(r.nodes);
    soul.putEdges(r.edges);
    soul.commit('2026-01-01T00:00:00.000Z');

    const loopId = idFor({
      kind: 'symbol',
      path: GUARDED_PATH,
      qualifiedName: 'Crib.Guarded.GuardService.Loop',
      startLine: 18,
    });
    const table = decisionTable(soul, loopId);
    expect(table.rules.length).toBeGreaterThan(0);
    const loopCondId = idFor({ kind: 'condition', file: GUARDED_PATH, line: 20 });
    expect(table.conditions).toContain(loopCondId);
    // the Process call inside the loop is inLoop:true with a LOOP-polarity condition
    const loopRule = table.rules.find((rule) => rule.inLoop === true);
    expect(loopRule).toBeDefined();
    expect(loopRule?.branch).toBe('LOOP');
    expect(loopRule?.conditions.some((c) => c.id === loopCondId && c.polarity === 'LOOP')).toBe(
      true,
    );
  });
});

// ── Schema 1.2 deep-extraction fidelity: raise / exception-handler / assignment / case-branch /
// explanation / iterates — mirrors the canonical PL/SQL behavior-node emission. ───────────────

describe('CsharpExtractor — schema 1.2 behavior nodes (raise / handler / case / assign / explanation)', () => {
  it('emits a raise node for `throw new XException("msg")` with errorMessage + name + raises edge', async () => {
    const { nodes, edges } = await runBehavior();
    const classifyId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Crib.Behavior.BehaviorService.Classify',
      startLine: 8,
    });
    const raiseId = idFor({ kind: 'raise', file: BEHAVIOR_PATH, line: 14 });
    const raise = nodes.find((n) => n.id === raiseId);
    expect(raise).toBeDefined();
    expect(raise?.kind).toBe('raise');
    expect(raise?.errorMessage).toBe('score must be non-negative');
    expect(raise?.name).toBe('System.ArgumentOutOfRangeException');
    // raises edge: Classify → raise(L14)
    const raisesEdge = edges.find(
      (e) => e.rel === 'raises' && e.src === classifyId && e.dst === raiseId,
    );
    expect(raisesEdge).toBeDefined();
    expect(raisesEdge?.method).toBe('static');
    expect(raisesEdge?.provenance).toBe('EXTRACTED');
  });

  it('stamps guarded-by on a guarded raise (throw inside `if (score < 0)`)', async () => {
    const { edges } = await runBehavior();
    const raiseId = idFor({ kind: 'raise', file: BEHAVIOR_PATH, line: 14 });
    const ifCondId = idFor({ kind: 'condition', file: BEHAVIOR_PATH, line: 12 });
    const gb = edges.find((e) => e.rel === 'guarded-by' && e.src === raiseId && e.dst === ifCondId);
    expect(gb).toBeDefined();
  });

  it('emits a raise node for `throw;` (rethrow) with empty name/message + inException meta', async () => {
    const { nodes, edges } = await runBehavior();
    const classifyId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Crib.Behavior.BehaviorService.Classify',
      startLine: 8,
    });
    const rethrowId = idFor({ kind: 'raise', file: BEHAVIOR_PATH, line: 34 });
    const raise = nodes.find((n) => n.id === rethrowId);
    expect(raise).toBeDefined();
    // `throw;` carries no type and no message — the fields are omitted (conditional spread).
    expect(raise?.name).toBeFalsy();
    expect(raise?.errorMessage).toBeFalsy();
    expect(raise?.meta?.inException).toBe(true);
    const raisesEdge = edges.find(
      (e) => e.rel === 'raises' && e.src === classifyId && e.dst === rethrowId,
    );
    expect(raisesEdge).toBeDefined();
  });

  it('emits an exception-handler node per catch clause with whenSelector (+ ` when f` for filters) + handles edges', async () => {
    const { nodes, edges } = await runBehavior();
    // catch (System.ArgumentOutOfRangeException ex) when (score < -10)  → line 31
    const handler1Id = idFor({ kind: 'exception-handler', file: BEHAVIOR_PATH, line: 31 });
    const handler1 = nodes.find((n) => n.id === handler1Id);
    expect(handler1).toBeDefined();
    expect(handler1?.kind).toBe('exception-handler');
    expect(handler1?.whenSelector).toBe('System.ArgumentOutOfRangeException when score < -10');
    // catch (System.Exception ex) → line 36
    const handler2Id = idFor({ kind: 'exception-handler', file: BEHAVIOR_PATH, line: 36 });
    const handler2 = nodes.find((n) => n.id === handler2Id);
    expect(handler2?.whenSelector).toBe('System.Exception');
    // handles edges: handler1 → Log call (L33) + raise (L34); handler2 → Log call (L38) + return (L39)
    const callL33 = idFor({ kind: 'statement', file: BEHAVIOR_PATH, line: 33 });
    const raiseL34 = idFor({ kind: 'raise', file: BEHAVIOR_PATH, line: 34 });
    const callL38 = idFor({ kind: 'statement', file: BEHAVIOR_PATH, line: 38 });
    const retL39 = idFor({ kind: 'statement', file: BEHAVIOR_PATH, line: 39 });
    const handles = edges.filter((e) => e.rel === 'handles');
    expect(handles.some((e) => e.src === handler1Id && e.dst === callL33)).toBe(true);
    expect(handles.some((e) => e.src === handler1Id && e.dst === raiseL34)).toBe(true);
    expect(handles.some((e) => e.src === handler2Id && e.dst === callL38)).toBe(true);
    expect(handles.some((e) => e.src === handler2Id && e.dst === retL39)).toBe(true);
    for (const e of handles) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('emits a case-branch node per switch case (whenSelector = predicate; omitted for default)', async () => {
    const { nodes } = await runBehavior();
    const case0 = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 19 }),
    );
    const case1 = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 22 }),
    );
    const def = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 25 }),
    );
    expect(case0?.kind).toBe('case-branch');
    expect(case0?.whenSelector).toBe('0');
    expect(case1?.whenSelector).toBe('1');
    // default: whenSelector omitted, expr empty
    expect(def).toBeDefined();
    expect(def?.whenSelector).toBeUndefined();
    expect(def?.expr).toBe('');
  });

  it('walks a switch case body under the case-branch guard (assignment guarded-by the case-branch)', async () => {
    const { edges } = await runBehavior();
    const case0Id = idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 19 });
    const assignL20 = idFor({ kind: 'assignment', file: BEHAVIOR_PATH, line: 20 });
    const gb = edges.find(
      (e) => e.rel === 'guarded-by' && e.src === assignL20 && e.dst === case0Id,
    );
    expect(gb).toBeDefined();
  });

  it('emits case-branch nodes for switch-expression arms (`=>` form) lifted from an assignment RHS', async () => {
    const { nodes } = await runBehavior();
    const arm1 = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 47 }),
    );
    const arm2 = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 48 }),
    );
    const armDiscard = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 49 }),
    );
    expect(arm1?.whenSelector).toBe('1');
    expect(arm2?.whenSelector).toBe('2');
    expect(armDiscard?.whenSelector).toBe('_');
  });

  it('emits an assignment node (assignTarget = LHS identifier) + executes edge for `lhs = rhs`', async () => {
    const { nodes, edges } = await runBehavior();
    const classifyId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Crib.Behavior.BehaviorService.Classify',
      startLine: 8,
    });
    const assignLow = nodes.find(
      (n) => n.id === idFor({ kind: 'assignment', file: BEHAVIOR_PATH, line: 16 }),
    );
    expect(assignLow?.kind).toBe('assignment');
    expect(assignLow?.assignTarget).toBe('label');
    // executes edge Classify → assignment(L16)
    const exec = edges.find(
      (e) => e.rel === 'executes' && e.src === classifyId && e.dst === assignLow?.id,
    );
    expect(exec).toBeDefined();
    // case-body assignments also carry assignTarget = label
    const assignZero = nodes.find(
      (n) => n.id === idFor({ kind: 'assignment', file: BEHAVIOR_PATH, line: 20 }),
    );
    expect(assignZero?.assignTarget).toBe('label');
    // the switch-expression assignment target is `result`
    const assignResult = nodes.find(
      (n) => n.id === idFor({ kind: 'assignment', file: BEHAVIOR_PATH, line: 45 }),
    );
    expect(assignResult?.assignTarget).toBe('result');
  });

  it('emits an explanation node for the `///` doc comment above the class + a describes edge', async () => {
    const { nodes, edges } = await runBehavior();
    const classId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Crib.Behavior.BehaviorService',
      startLine: 6,
    });
    const explId = idFor({ kind: 'explanation', path: BEHAVIOR_PATH, startLine: 3 });
    const expl = nodes.find((n) => n.id === explId);
    expect(expl?.kind).toBe('explanation');
    expect(expl?.commentRef).toEqual({ file: BEHAVIOR_PATH, span: { start: 3, end: 5 } });
    expect(String(expl?.meta?.text ?? '')).toContain('Behavior fixture');
    const describes = edges.find(
      (e) => e.rel === 'describes' && e.src === explId && e.dst === classId,
    );
    expect(describes).toBeDefined();
    expect(describes?.method).toBe('static');
    expect(describes?.provenance).toBe('EXTRACTED');
  });

  it('preserves existing executes / calls / guarded-by edges (Track 3 non-regression)', async () => {
    const { nodes, edges } = await runBehavior();
    const classifyId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Crib.Behavior.BehaviorService.Classify',
      startLine: 8,
    });
    const logId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'Crib.Behavior.BehaviorService.Log',
      startLine: 54,
    });
    // the IF condition (line 12) still emitted as a condition node
    const ifCond = nodes.find((n) => n.kind === 'condition' && n.span?.start === 12);
    expect(ifCond).toBeDefined();
    // executes edges out of Classify still present (return at L29, assignment at L16, etc.)
    const exec = edges.filter((e) => e.rel === 'executes' && e.src === classifyId);
    expect(exec.length).toBeGreaterThan(0);
    // intra-file calls edge Classify → Log (Log is a same-file method) preserved
    const callsEdge = edges.find(
      (e) => e.rel === 'calls' && e.src === classifyId && e.dst === logId,
    );
    expect(callsEdge).toBeDefined();
    // the throw statement node (line 14) still gets a guarded-by to the IF condition
    const stmtL14 = idFor({ kind: 'statement', file: BEHAVIOR_PATH, line: 14 });
    const ifCondId = idFor({ kind: 'condition', file: BEHAVIOR_PATH, line: 12 });
    const stmtGb = edges.find(
      (e) => e.rel === 'guarded-by' && e.src === stmtL14 && e.dst === ifCondId,
    );
    expect(stmtGb).toBeDefined();
  });

  it('is id-stable: re-running Behavior yields byte-identical output', async () => {
    const a = await runBehavior();
    const b = await runBehavior();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
