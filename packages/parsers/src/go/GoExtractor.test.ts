import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, decisionTable, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { GoExtractor } from './GoExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/go/auth.go', import.meta.url));
const PATH = 'fixtures/go/auth.go';
const GUARDED_FIXTURE = fileURLToPath(new URL('../../fixtures/go/guarded.go', import.meta.url));
const GUARDED_PATH = 'fixtures/go/guarded.go';
const DEEP_FIXTURE = fileURLToPath(new URL('../../fixtures/go/deep.go', import.meta.url));
const DEEP_PATH = 'fixtures/go/deep.go';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — Go is hand-rolled, no tree-sitter');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'go', bytes: text.length, mtime: 0 };
  return new GoExtractor().extract(meta, ctxFor(text));
}

async function runGuarded(text = readFileSync(GUARDED_FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: GUARDED_PATH, lang: 'go', bytes: text.length, mtime: 0 };
  return new GoExtractor().extract(meta, ctxFor(text));
}

async function runDeep(text = readFileSync(DEEP_FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: DEEP_PATH, lang: 'go', bytes: text.length, mtime: 0 };
  return new GoExtractor().extract(meta, ctxFor(text));
}

/** label a node id for readable assertions: symbol qualified name / stmt:L / cond:L / case:L / …. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    if (!n) return id;
    if (n.kind === 'symbol') return n.qualifiedName ?? n.name ?? id;
    if (n.kind === 'statement') return `stmt:L${n.span?.start}:${n.type}`;
    if (n.kind === 'condition') return `cond:L${n.span?.start}:${n.branch}`;
    if (n.kind === 'case-branch') return `case:L${n.span?.start}:${n.branch}`;
    if (n.kind === 'raise') return `raise:L${n.span?.start}`;
    if (n.kind === 'assignment') return `assign:L${n.span?.start}`;
    if (n.kind === 'exception-handler') return `exc:L${n.span?.start}`;
    if (n.kind === 'explanation') return `expl:L${n.span?.start}`;
    return n.kind;
  };
}

describe('GoExtractor — golden (Go gate)', () => {
  it('emits func/method/struct/interface/typedef symbols with qualified names', async () => {
    const { nodes } = await run();
    const syms = nodes
      .filter((n) => n.kind === 'symbol')
      .map((n) => `${n.qualifiedName}|${n.type}`)
      .sort();
    expect(syms).toEqual(
      [
        'AuthApi|interface',
        'AuthApi.Issue|method',
        'AuthApi.Login|method',
        'BaseController|struct',
        'BaseController.TextBlock|method',
        'Controller|struct',
        'Controller.Issue|method',
        'Controller.Login|method',
        'Controller.Validate|method',
        'Greeter|interface',
        'Greeter.Greet|method',
        'Log|func',
        'Role|typedef',
        'Service|struct',
        'Service.Greet|method',
        'Stack|struct',
        'Stack.Push|method',
        'Token|struct',
        'TokenReq|struct',
      ].sort(),
    );
  });

  it('captures struct embedding (bases), generics + signatures in meta', async () => {
    const { nodes } = await run();
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q)!;

    // struct embedding → bases (becomes `inherits` in the resolver)
    expect(byQ('Controller').meta?.bases).toEqual(['Base', 'AuthApi']);
    expect(byQ('Service').meta?.bases).toEqual(['Base']);
    expect(byQ('Token').meta?.bases).toBeUndefined();
    expect(byQ('Controller').signature).toBe('type Controller struct');
    expect(byQ('Controller').lang).toBe('go');

    // receiver methods: receiverType stripped of `*`, qualifiedName = TypeName.Method
    expect(byQ('Controller.Login').meta?.receiverType).toBe('Controller');
    expect(byQ('Controller.Login').signature).toBe('func (c Controller) Login(user)');
    expect(byQ('Controller.Issue').signature).toBe('func (c Controller) Issue(req)');
    expect(byQ('Controller.Validate').type).toBe('method');

    // top-level func
    expect(byQ('Log').type).toBe('func');
    expect(byQ('Log').signature).toBe('func Log(msg)');

    // typedef + alias signatures
    expect(byQ('Role').type).toBe('typedef');
    expect(byQ('Role').signature).toBe('type Role int');

    // interface + interface methods (nested, with return type in signature)
    expect(byQ('Greeter').type).toBe('interface');
    expect(byQ('Greeter').signature).toBe('interface Greeter');
    expect(byQ('Greeter.Greet').signature).toBe('Greet(user) string');
    expect(byQ('AuthApi.Login').signature).toBe('Login(user) string');
    expect(byQ('AuthApi.Issue').signature).toBe('Issue(req) Token');

    // generics: type params on the type + receiver type params on the method
    expect(byQ('Stack').meta?.typeParams).toEqual(['T']);
    expect(byQ('Stack.Push').meta?.receiverType).toBe('Stack');
    expect(byQ('Stack.Push').meta?.receiverTypeParams).toEqual(['T']);
    expect(byQ('Stack.Push').signature).toBe('func (s Stack) Push(v)');

    // raw string literal survives (TextBlock body) — method still parsed
    expect(byQ('BaseController.TextBlock')).toBeDefined();
    expect(byQ('BaseController.TextBlock').signature).toBe('func (b BaseController) TextBlock()');
  });

  it('emits member-of edges: methods → enclosing type, interface methods → interface, top-level → file', async () => {
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
        'AuthApi.Issue -> AuthApi',
        'AuthApi.Login -> AuthApi',
        'BaseController -> file',
        'BaseController.TextBlock -> BaseController',
        'Controller -> file',
        'Controller.Issue -> Controller',
        'Controller.Login -> Controller',
        'Controller.Validate -> Controller',
        'Greeter -> file',
        'Greeter.Greet -> Greeter',
        'Log -> file',
        'Role -> file',
        'Service -> file',
        'Service.Greet -> Service',
        'Stack -> file',
        'Stack.Push -> Stack',
        'Token -> file',
        'TokenReq -> file',
      ]
        .map((s) => s.replace('file', lbl(fileId)))
        .sort(),
    );
  });

  it('emits intra-file bare calls only (dotted / composite / builtin dropped)', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    // Only `Log("issued")` is a bare call to a same-file top-level func. `c.Validate(user)`,
    // `c.service.Greet(user)`, `fmt.Println`, `strings.TrimSpace`, `panic`, `append`, and the
    // `Token{...}` composite literal are all dotted / composite / builtin → dropped (honest).
    expect(calls).toEqual(['Controller.Issue -> Log']);
    for (const e of edges.filter((e) => e.rel === 'calls')) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('declares capability-honest capabilities (types:none ⇒ no type edges)', async () => {
    const ext = new GoExtractor();
    expect(ext.capabilities).toEqual({
      imports: true,
      calls: true,
      inheritance: true,
      types: 'none',
    });
    const { edges } = await run();
    const rels = new Set(edges.map((e) => e.rel));
    // types:none ⇒ ZERO type edges (no inherits/implements/type). The Track-3 body-walk adds
    // executes + guarded-by on top of member-of/calls. Schema 1.2 adds `raises` (Validate's
    // panic) + `describes` (the `// Auth controller` comment above the Controller struct).
    expect(rels).toEqual(
      new Set(['member-of', 'calls', 'executes', 'guarded-by', 'raises', 'describes']),
    );
    for (const e of edges) {
      expect(e.rel).not.toBe('inherits');
      expect(e.rel).not.toBe('implements');
    }
  });
});

describe('GoExtractor — degradation + id-stability (gate)', () => {
  it('degrades to no symbols on malformed source (no throw)', async () => {
    const garbage = 'func (((\n  type }}}\n';
    const { nodes, edges } = await new GoExtractor().extract(
      { path: 'bad.go', lang: 'go', bytes: garbage.length, mtime: 0 },
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

  it('handles comments, raw strings + struct tags without mis-attributing calls', async () => {
    const src = [
      'package x',
      '',
      '/* a block comment with a fake ( paren */',
      'type C struct { // line comment foo()',
      '  name string `json:"name"`',
      '}',
      '',
      'func (c *C) M() {',
      '  n(c)',
      '}',
      '',
      'func n(c *C) {',
      '  c.M()',
      '}',
    ].join('\n');
    const { nodes, edges } = await new GoExtractor().extract(
      { path: 'C.go', lang: 'go', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q);
    expect(byQ('C')).toBeDefined();
    expect(byQ('C.M')).toBeDefined();
    expect(byQ('n')).toBeDefined();
    // n(c) is a bare call to a same-file top-level func → M calls n.
    // c.M() is dotted → dropped (resolver/inference territory).
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    expect(calls).toEqual(['C.M -> n']);
  });
});

describe('GoExtractor — Track 3 (statement/condition/CFG)', () => {
  it('if/else emits ONE condition node + per-branch statement nodes with cfgPath/guard/branch', async () => {
    const { nodes, edges } = await runGuarded();
    const lbl = label({ nodes, edges } as ExtractResult);
    const condIf = idFor({ kind: 'condition', file: GUARDED_PATH, line: 5 });
    // exactly one condition for the if (keyed by the if line), branch='THEN'
    const conds = nodes.filter((n) => n.kind === 'condition' && n.span?.start === 5);
    expect(conds).toHaveLength(1);
    expect(conds[0]!.branch).toBe('THEN');
    expect(conds[0]!.expr).toBe('score > 0');

    // executes edges from classify carry the guard chain: THEN for then-branch, ELSE for else.
    const exec = edges
      .filter((e) => e.rel === 'executes' && e.src.startsWith('sym:'))
      .map(
        (e) =>
          `${lbl(e.dst)} | cfg=${JSON.stringify(e.cfgPath)} guard=${e.guard === condIf ? 'condIf' : e.guard} branch=${e.branch}`,
      )
      .sort();
    expect(exec).toContain(`stmt:L6:call | cfg=["${condIf}"] guard=condIf branch=THEN`);
    expect(exec).toContain(`stmt:L7:return | cfg=["${condIf}"] guard=condIf branch=THEN`);
    expect(exec).toContain(`stmt:L9:call | cfg=["${condIf}"] guard=condIf branch=ELSE`);
    expect(exec).toContain(`stmt:L10:return | cfg=["${condIf}"] guard=condIf branch=ELSE`);

    // guarded-by: each branch action → the (single) innermost condition. Filter to classify's
    // own statement lines (the file also contains loopit/switchy guarded-by edges).
    const classifyLines = new Set([6, 7, 9, 10]);
    const guarded = edges
      .filter((e) => {
        if (e.rel !== 'guarded-by') return false;
        const n = nodes.find((x) => x.id === e.src);
        return n?.kind === 'statement' && classifyLines.has(n.span?.start ?? -1);
      })
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    expect(guarded).toEqual(
      [
        'stmt:L10:return -> cond:L5:THEN',
        'stmt:L6:call -> cond:L5:THEN',
        'stmt:L7:return -> cond:L5:THEN',
        'stmt:L9:call -> cond:L5:THEN',
      ].sort(),
    );

    // the then-branch call statement node carries the call head + GUARDED meta.
    const callStmt = nodes.find(
      (n) => n.kind === 'statement' && n.type === 'call' && n.span?.start === 6,
    );
    expect(callStmt?.meta?.head).toBe('Log');
    expect(callStmt?.meta?.branch).toBe('GUARDED');
    expect(callStmt?.meta?.inLoop).toBe(false);

    // intra-file calls edge classify→Log is annotated (best-effort last-wins: the else-site).
    const logSym = nodes.find((n) => n.qualifiedName === 'Log');
    const callsEdge = edges.find((e) => e.rel === 'calls' && e.dst === logSym?.id);
    expect(callsEdge).toBeDefined();
    expect(callsEdge?.cfgPath).toEqual([condIf]);
    expect(callsEdge?.inLoop).toBe(false);
    // call sites recorded on the proc meta for cross-file resolution.
    const classify = nodes.find((n) => n.qualifiedName === 'classify');
    expect(classify?.meta?.calls).toEqual([
      { callee: 'Log', line: 6 },
      { callee: 'Log', line: 9 },
    ]);
  });

  it('for loop → inLoop:true on the body action + a branch:LOOP condition', async () => {
    const { nodes, edges } = await runGuarded();
    const lbl = label({ nodes, edges } as ExtractResult);
    const loopCond = idFor({ kind: 'condition', file: GUARDED_PATH, line: 16 });
    // one condition with branch:'LOOP', predicate = the continuation cond.
    const loopConds = nodes.filter((n) => n.kind === 'condition' && n.span?.start === 16);
    expect(loopConds).toHaveLength(1);
    expect(loopConds[0]!.branch).toBe('LOOP');
    expect(loopConds[0]!.expr).toBe('i < len(items)');
    // the body call carries inLoop:true + branch:LOOP on its executes edge.
    const iterExec = edges.find(
      (e) =>
        e.rel === 'executes' &&
        e.dst === idFor({ kind: 'statement', file: GUARDED_PATH, line: 17 }),
    );
    expect(iterExec?.inLoop).toBe(true);
    expect(iterExec?.branch).toBe('LOOP');
    expect(iterExec?.cfgPath).toEqual([loopCond]);
    expect(iterExec?.guard).toBe(loopCond);
    // the loop call statement node meta flags inLoop.
    const iterStmt = nodes.find((n) => n.kind === 'statement' && n.span?.start === 17);
    expect(iterStmt?.meta?.inLoop).toBe(true);
    // loopit→Log calls edge carries the loop guard (inLoop:true).
    const logSym = nodes.find((n) => n.qualifiedName === 'Log');
    const loopitLog = edges.find(
      (e) =>
        e.rel === 'calls' && e.src.startsWith('sym:') && e.dst === logSym?.id && e.inLoop === true,
    );
    expect(loopitLog).toBeDefined();
    // loopit's call sites include the in-loop Log call.
    const loopit = nodes.find((n) => n.qualifiedName === 'loopit');
    expect(loopit?.meta?.calls).toEqual([{ callee: 'Log', line: 17 }]);
  });

  it('switch emits one case-branch per case (incl. default); case bodies are guarded by them', async () => {
    const { nodes, edges } = await runGuarded();
    // Schema 1.2: each case (incl. default) becomes a `case-branch` node (replaces the pre-1.2
    // `condition` node). whenSelector = the case expr; omitted for default.
    const branches = nodes
      .filter((n) => n.kind === 'case-branch')
      .map((n) => `${n.span?.start}:${n.branch}:${n.whenSelector ?? ''}`)
      .sort();
    expect(branches).toEqual(['24:CASE:1', '27:CASE:2', '30:DEFAULT:']);
    // case 1 (line 25) action guarded by case-branch@24 with branch:CASE.
    const oneExec = edges.find(
      (e) =>
        e.rel === 'executes' &&
        e.dst === idFor({ kind: 'statement', file: GUARDED_PATH, line: 25 }),
    );
    expect(oneExec?.branch).toBe('CASE');
    expect(oneExec?.cfgPath).toEqual([
      idFor({ kind: 'case-branch', file: GUARDED_PATH, line: 24 }),
    ]);
    // default branch actions (line 31/32) are now guarded by the default case-branch@30
    // (schema 1.2 — default is a real branch, parity with PL/SQL's ELSE case-branch).
    const defExec = edges.find(
      (e) =>
        e.rel === 'executes' &&
        e.dst === idFor({ kind: 'statement', file: GUARDED_PATH, line: 31 }),
    );
    expect(defExec?.cfgPath).toEqual([
      idFor({ kind: 'case-branch', file: GUARDED_PATH, line: 30 }),
    ]);
    expect(defExec?.guard).toBe(idFor({ kind: 'case-branch', file: GUARDED_PATH, line: 30 }));
    expect(defExec?.branch).toBe('DEFAULT');
  });

  it('extract_rules e2e: a non-empty decision table with correct conditions + actions (real SoulStore)', async () => {
    const r = await runGuarded();
    const dir = mkdtempSync(join(tmpdir(), 'crib-go-e2e-'));
    try {
      const soul = new SoulStore(join(dir, '.crib'), { manifest: newManifest({ root: '.' }) });
      soul.load();
      const fileId = idFor({ kind: 'file', path: GUARDED_PATH });
      soul.putNodes([
        { id: fileId, kind: 'file', file: GUARDED_PATH, hash: contentHash(GUARDED_PATH) },
        ...r.nodes,
      ]);
      soul.putEdges(r.edges);
      soul.commit('2026-01-01T00:00:00.000Z');

      // Pass the symbol ID (not the name): core's findProcedure only resolves by NAME for
      // type 'procedure'|'function' — Go symbols are 'func'/'method', so name lookup misses.
      // findProcedure tries soul.getNode(id) FIRST, which returns the node regardless of type.
      const classifySym = r.nodes.find((n) => n.qualifiedName === 'classify');
      expect(classifySym).toBeDefined();
      const dt = decisionTable(soul, classifySym!.id);
      // non-empty: the if has 4 statement actions (2 calls + 2 returns) + 1 calls edge = 5 rules.
      expect(dt.rules.length).toBeGreaterThanOrEqual(4);
      // exactly one condition column (the if), with the right expression.
      expect(dt.conditions).toHaveLength(1);
      const condNode = soul.getNode(dt.conditions[0]!);
      expect(condNode?.kind).toBe('condition');
      expect(condNode?.expr).toBe('score > 0');
      // the innermost condition is tagged with polarity THEN (then-branch) and ELSE (else-branch).
      const polarities = new Set(
        dt.rules.map((rule) => {
          const last = rule.conditions[rule.conditions.length - 1];
          return last?.polarity;
        }),
      );
      expect(polarities.has('THEN')).toBe(true);
      expect(polarities.has('ELSE')).toBe(true);
      // at least one rule is an executes action whose expr carries the call text.
      const execRule = dt.rules.find((rule) => rule.action.kind === 'executes');
      expect(execRule).toBeDefined();
      expect(execRule!.action.expr).toMatch(/Log/);
      // the calls action resolves to the Log callee.
      const callsRule = dt.rules.find((rule) => rule.action.kind === 'calls');
      expect(callsRule?.action.expr).toBe('Log');
      // all classify rules are non-loop, non-exception.
      for (const rule of dt.rules) {
        expect(rule.inLoop).toBe(false);
        expect(rule.inException).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extract_rules e2e: a looped procedure surfaces inLoop on its rule', async () => {
    const r = await runGuarded();
    const dir = mkdtempSync(join(tmpdir(), 'crib-go-loop-e2e-'));
    try {
      const soul = new SoulStore(join(dir, '.crib'), { manifest: newManifest({ root: '.' }) });
      soul.load();
      const fileId = idFor({ kind: 'file', path: GUARDED_PATH });
      soul.putNodes([
        { id: fileId, kind: 'file', file: GUARDED_PATH, hash: contentHash(GUARDED_PATH) },
        ...r.nodes,
      ]);
      soul.putEdges(r.edges);
      soul.commit('2026-01-01T00:00:00.000Z');

      // Pass the symbol ID: findProcedure's name resolution excludes Go 'func'/'method' types.
      const loopitSym = r.nodes.find((n) => n.qualifiedName === 'loopit');
      expect(loopitSym).toBeDefined();
      const dt = decisionTable(soul, loopitSym!.id);
      expect(dt.rules.length).toBeGreaterThan(0);
      expect(dt.conditions).toHaveLength(1);
      expect(soul.getNode(dt.conditions[0]!)?.branch).toBe('LOOP');
      for (const rule of dt.rules) expect(rule.inLoop).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades on a malformed body (no stmt/cond nodes, never throws)', async () => {
    // A func with an unbalanced body: the parser tolerates it (never throws); no statement/condition
    // nodes are emitted for the malformed body, and the file still yields its symbol.
    const src = ['package x', '', 'func broken() {', '  if {', '    Log("oops")', '  }', '}'].join(
      '\n',
    );
    const r = await new GoExtractor().extract(
      { path: 'bad.go', lang: 'go', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    expect(r.nodes.some((n) => n.kind === 'statement')).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'condition')).toBe(false);
    // the func symbol is still emitted.
    expect(r.nodes.some((n) => n.kind === 'symbol' && n.name === 'broken')).toBe(true);
  });

  it('every Track-3 edge is EXTRACTED/static/confidence 1 with lang:go evidence', async () => {
    const { edges } = await runGuarded();
    const track3 = edges.filter(
      (e) =>
        e.rel === 'executes' ||
        e.rel === 'guarded-by' ||
        (e.rel === 'calls' && e.cfgPath !== undefined),
    );
    expect(track3.length).toBeGreaterThan(0);
    for (const e of track3) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.method).toBe('static');
      expect(e.confidence).toBe(1);
      expect(e.evidence?.by).toBe('lang:go');
    }
  });

  it('existing golden behavior is unchanged (id-stable + member-of/calls still present)', async () => {
    const a = await runGuarded();
    const b = await runGuarded();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // the strictly-additive body-walk never dropped member-of or intra-file calls.
    const rels = new Set(a.edges.map((e) => e.rel));
    expect(rels.has('member-of')).toBe(true);
    expect(rels.has('calls')).toBe(true);
    // Log is member-of the file; classify/loopit/switchy call Log. The extractor stamps
    // member-of dst as the file id (no file node is emitted in the per-file result set).
    const fileId = idFor({ kind: 'file', path: GUARDED_PATH });
    expect(a.edges.some((e) => e.rel === 'member-of' && e.dst === fileId)).toBe(true);
  });
});

describe('GoExtractor — schema 1.2 deep-extraction fidelity (deep.go)', () => {
  it('emits a raise node for panic with errorMessage + a raises edge (proc → raise)', async () => {
    const { nodes, edges } = await runDeep();
    // exactly one raise node, from the `panic("unknown kind")` at line 17.
    const raises = nodes.filter((n) => n.kind === 'raise');
    expect(raises).toHaveLength(1);
    expect(raises[0]!.span?.start).toBe(17);
    expect(raises[0]!.errorMessage).toBe('unknown kind');
    expect(raises[0]!.name).toBe('panic');
    expect(raises[0]!.errorCode).toBeUndefined();
    // raises edge: deepGuard → raise@17.
    const deepGuard = nodes.find((n) => n.qualifiedName === 'deepGuard');
    const raisesEdge = edges.find((e) => e.rel === 'raises');
    expect(raisesEdge).toBeDefined();
    expect(raisesEdge?.src).toBe(deepGuard?.id);
    expect(raisesEdge?.dst).toBe(raises[0]!.id);
    expect(raisesEdge?.method).toBe('static');
    expect(raisesEdge?.provenance).toBe('EXTRACTED');
    expect(raisesEdge?.confidence).toBe(1);
    // the raise sits in the default case-branch → guarded-by that case-branch + branch:DEFAULT.
    const defaultCase = idFor({ kind: 'case-branch', file: DEEP_PATH, line: 16 });
    expect(raisesEdge?.cfgPath).toEqual([defaultCase]);
    expect(raisesEdge?.guard).toBe(defaultCase);
    expect(raisesEdge?.branch).toBe('DEFAULT');
    expect(raises[0]!.meta?.inException).toBe(false);
    // guarded-by: raise@17 → case-branch@16.
    const gb = edges.find((e) => e.rel === 'guarded-by' && e.src === raises[0]!.id);
    expect(gb?.dst).toBe(defaultCase);
  });

  it('emits an exception-handler node for recover-in-defer + handles edge to the recovery action', async () => {
    const { nodes, edges } = await runDeep();
    // exactly one exception-handler node, at the defer line (6), whenSelector='recover'.
    const excs = nodes.filter((n) => n.kind === 'exception-handler');
    expect(excs).toHaveLength(1);
    expect(excs[0]!.span?.start).toBe(6);
    expect(excs[0]!.whenSelector).toBe('recover');
    // handles edge: exc@6 → assignment@8 (the `x = "recovered"` recovery statement).
    const assign8 = nodes.find((n) => n.kind === 'assignment' && n.span?.start === 8);
    expect(assign8).toBeDefined();
    expect(assign8?.meta?.inException).toBe(true);
    const handles = edges.filter((e) => e.rel === 'handles');
    expect(handles).toHaveLength(1);
    expect(handles[0]!.src).toBe(excs[0]!.id);
    expect(handles[0]!.dst).toBe(assign8?.id);
    expect(handles[0]!.method).toBe('static');
    expect(handles[0]!.provenance).toBe('EXTRACTED');
    // capability-honest: no invented handlers for returned errors (only the explicit recover).
    expect(edges.every((e) => e.rel !== 'handles' || e.src === excs[0]!.id)).toBe(true);
  });

  it('emits a case-branch node per switch case (value + type) with whenSelector = expr/type', async () => {
    const { nodes } = await runDeep();
    const branches = nodes
      .filter((n) => n.kind === 'case-branch')
      .map((n) => `${n.span?.start}:${n.branch}:${n.whenSelector ?? ''}`)
      .sort();
    // value switch: case 1 (L12), case 2 (L14), default (L16); type switch: int (L20), string (L22),
    // default (L24). default omits whenSelector; type-switch cases carry the type as whenSelector.
    expect(branches).toEqual([
      '12:CASE:1',
      '14:CASE:2',
      '16:DEFAULT:',
      '20:CASE:int',
      '22:CASE:string',
      '24:DEFAULT:',
    ]);
  });

  it('emits assignment nodes with assignTarget for each plain assignment in the body', async () => {
    const { nodes, edges } = await runDeep();
    const assigns = nodes
      .filter((n) => n.kind === 'assignment')
      .map((n) => `${n.span?.start}:target=${n.assignTarget}`)
      .sort();
    // x := "init" (L5, unguarded); x = "recovered" (L8, in defer-recover, inException);
    // x = "one" (L13, case 1); x = "two" (L15, case 2).
    expect(assigns).toEqual(['13:target=x', '15:target=x', '5:target=x', '8:target=x']);
    // each assignment has an executes edge from deepGuard carrying the guard chain.
    const deepGuard = nodes.find((n) => n.qualifiedName === 'deepGuard');
    const exec5 = edges.find(
      (e) =>
        e.rel === 'executes' && e.dst === idFor({ kind: 'assignment', file: DEEP_PATH, line: 5 }),
    );
    expect(exec5?.src).toBe(deepGuard?.id);
    expect(exec5?.cfgPath).toEqual([]); // top-level assignment — no guard
    expect(exec5?.inLoop).toBe(false);
    // the case-1 assignment is guarded by case-branch@12 with branch:CASE.
    const exec13 = edges.find(
      (e) =>
        e.rel === 'executes' && e.dst === idFor({ kind: 'assignment', file: DEEP_PATH, line: 13 }),
    );
    const case12 = idFor({ kind: 'case-branch', file: DEEP_PATH, line: 12 });
    expect(exec13?.cfgPath).toEqual([case12]);
    expect(exec13?.guard).toBe(case12);
    expect(exec13?.branch).toBe('CASE');
  });

  it('emits an explanation node for the // doc comment above the func + a describes edge', async () => {
    const { nodes, edges } = await runDeep();
    const deepGuard = nodes.find((n) => n.qualifiedName === 'deepGuard');
    const expls = nodes.filter((n) => n.kind === 'explanation');
    expect(expls).toHaveLength(1);
    const expl = expls[0]!;
    expect(expl.span?.start).toBe(3);
    expect(expl.commentRef).toEqual({ file: DEEP_PATH, span: { start: 3, end: 3 } });
    expect(expl.meta?.text).toBe(
      'deepGuard demonstrates schema-1.2 behavior nodes: panic, recover, switch, assignment.',
    );
    const describes = edges.filter((e) => e.rel === 'describes');
    expect(describes).toHaveLength(1);
    expect(describes[0]!.src).toBe(expl.id);
    expect(describes[0]!.dst).toBe(deepGuard?.id);
    expect(describes[0]!.method).toBe('static');
    expect(describes[0]!.provenance).toBe('EXTRACTED');
  });

  it('preserves existing executes/guarded-by/calls/member-of edges (strictly additive)', async () => {
    const { nodes, edges } = await runDeep();
    const rels = new Set(edges.map((e) => e.rel));
    // existing Track-3 + structural edges are all still present alongside the 1.2 additions.
    expect(rels.has('member-of')).toBe(true);
    expect(rels.has('executes')).toBe(true);
    expect(rels.has('guarded-by')).toBe(true);
    // schema-1.2 additions.
    expect(rels.has('raises')).toBe(true);
    expect(rels.has('handles')).toBe(true);
    expect(rels.has('describes')).toBe(true);
    // the 3 return statements (lines 21/23/25) are still emitted as statement nodes with executes.
    const returns = nodes.filter((n) => n.kind === 'statement' && n.type === 'return');
    expect(returns.map((n) => n.span?.start).sort()).toEqual([21, 23, 25]);
    // the if inside the defer-recover still emits a condition node (Track-3 unchanged).
    const cond = nodes.find((n) => n.kind === 'condition' && n.span?.start === 7);
    expect(cond).toBeDefined();
    expect(cond?.branch).toBe('THEN');
  });

  it('is id-stable across runs (deterministic ids + hashes for the 1.2 nodes)', async () => {
    const a = await runDeep();
    const b = await runDeep();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('every schema-1.2 edge is EXTRACTED/static/confidence 1 with lang:go evidence', async () => {
    const { edges } = await runDeep();
    const deep = edges.filter(
      (e) => e.rel === 'raises' || e.rel === 'handles' || e.rel === 'describes',
    );
    expect(deep.length).toBeGreaterThan(0);
    for (const e of deep) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.method).toBe('static');
      expect(e.confidence).toBe(1);
      expect(e.evidence?.by).toBe('lang:go');
    }
  });

  it('return errors.New / fmt.Errorf is modelled as an additional raise (error-as-value honesty)', async () => {
    const src = [
      'package x',
      '',
      'func bad(msg string) error {',
      '  return errors.New(msg)',
      '}',
      '',
      'func wrap(msg string) error {',
      '  return fmt.Errorf("wrap: %s", msg)',
      '}',
    ].join('\n');
    const { nodes, edges } = await new GoExtractor().extract(
      { path: 'err.go', lang: 'go', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    const raises = nodes.filter((n) => n.kind === 'raise');
    // one raise per direct return-of-new-error: errors.New (L4) + fmt.Errorf (L8).
    expect(raises.map((n) => `${n.span?.start}:${n.name}`).sort()).toEqual([
      '4:errors.New',
      '8:fmt.Errorf',
    ]);
    // the fmt.Errorf raise carries the first string literal as errorMessage.
    const fmtRaise = raises.find((n) => n.name === 'fmt.Errorf');
    expect(fmtRaise?.errorMessage).toBe('wrap: %s');
    // both raises have a `raises` edge from their enclosing func.
    const raisesEdges = edges.filter((e) => e.rel === 'raises');
    expect(raisesEdges).toHaveLength(2);
    // the return statements are STILL emitted (the control flow is real — strictly additive).
    const returns = nodes.filter((n) => n.kind === 'statement' && n.type === 'return');
    expect(returns.map((n) => n.span?.start).sort()).toEqual([4, 8]);
  });

  it('capability-honest: cursor nodes are never emitted (Go has no SQL cursors)', async () => {
    const { nodes } = await runDeep();
    expect(nodes.some((n) => n.kind === 'cursor')).toBe(false);
  });
});
