import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, decisionTable, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, Node, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { PythonExtractor } from './PythonExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/python/auth.py', import.meta.url));
const PATH = 'fixtures/python/auth.py';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — Python is hand-rolled, no tree-sitter');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'python', bytes: text.length, mtime: 0 };
  return new PythonExtractor().extract(meta, ctxFor(text));
}

/** label a node id for readable assertions: the symbol's qualified name. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    return n?.kind === 'symbol' ? (n.qualifiedName ?? n.name ?? id) : (n?.kind ?? id);
  };
}

describe('PythonExtractor — golden (M8 gate)', () => {
  it('emits class / function / method symbols with qualified names + spans', async () => {
    const { nodes } = await run();
    const syms = nodes
      .filter((n) => n.kind === 'symbol')
      .map((n) => ({
        q: n.qualifiedName ?? '',
        type: n.type,
        start: n.span?.start,
        end: n.span?.end,
      }))
      .sort((a, b) => (a.q < b.q ? -1 : 1));
    expect(syms).toEqual([
      { q: 'Auth', type: 'class', start: 12, end: 20 },
      { q: 'Auth.issue', type: 'method', start: 18, end: 20 },
      { q: 'Auth.login', type: 'method', start: 15, end: 16 },
      { q: 'helper', type: 'function', start: 7, end: 8 },
      { q: 'top_level', type: 'function', start: 23, end: 25 },
    ]);
  });

  it('captures bases, decorators, async, params + signatures in meta', async () => {
    const { nodes } = await run();
    const byQ = (q: string) => nodes.find((n) => n.qualifiedName === q);
    const auth = byQ('Auth');
    expect(auth?.meta?.bases).toEqual(['Base']);
    expect(auth?.meta?.decorators).toEqual(['log_calls']);
    expect(auth?.signature).toBe('class Auth(Base)');
    expect(auth?.lang).toBe('python');

    const issue = byQ('Auth.issue');
    expect(issue?.meta?.async).toBe(true);
    expect(issue?.meta?.params).toEqual(['self', 'user']);
    expect(issue?.signature).toBe('issue(self, user)');
    expect(issue?.type).toBe('method');

    const helper = byQ('helper');
    expect(helper?.type).toBe('function');
    expect(helper?.meta?.parentQualifier).toBe('');
  });

  it('emits member-of edges: methods → class, top-level → file', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const fileId = idFor({ kind: 'file', path: PATH });
    const memberOf = edges
      .filter((e) => e.rel === 'member-of')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    expect(memberOf).toEqual(
      [
        'Auth -> file',
        'Auth.issue -> Auth',
        'Auth.login -> Auth',
        'helper -> file',
        'top_level -> file',
      ].map((s) => s.replace('file', lbl(fileId))),
    );
  });

  it('emits intra-file calls (self.method, bare fn, constructor); skips module.fn', async () => {
    const { nodes, edges } = await run();
    const lbl = label({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${lbl(e.src)} -> ${lbl(e.dst)}`)
      .sort();
    // self.issue() in login · helper() in issue · Auth() constructor in top_level
    expect(calls).toEqual([
      'Auth.issue -> helper',
      'Auth.login -> Auth.issue',
      'top_level -> Auth',
    ]);
    // a.login("x") is head=`a` (a local var) → NOT resolved intra-file (left to inference/resolver).
    for (const e of edges.filter((e) => e.rel === 'calls')) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('declares capability-honest capabilities (types:none ⇒ no type edges)', async () => {
    const ext = new PythonExtractor();
    expect(ext.capabilities).toEqual({
      imports: true,
      calls: true,
      inheritance: true,
      types: 'none',
    });
    const { edges } = await run();
    // the extractor never emits imports/inherits (resolver's job) or any type edges. Track 3 adds
    // executes (statement/assignment nodes per action line); schema 1.2 adds `describes` for the
    // Auth class docstring. auth.py has no compound stmts, so no guarded-by/raises/handles/case.
    const rels = new Set(edges.map((e) => e.rel));
    expect(rels).toEqual(new Set(['member-of', 'calls', 'executes', 'describes']));
  });
});

describe('PythonExtractor — degradation + id-stability (M8 gate)', () => {
  it('degrades to no symbols on malformed source (no throw)', async () => {
    const garbage = 'class \n  def  (: \n   (((\n';
    const { nodes, edges } = await new PythonExtractor().extract(
      { path: 'bad.py', lang: 'python', bytes: garbage.length, mtime: 0 },
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

  it('handles triple-quoted + comment-heavy source without mis-attributing calls', async () => {
    const src = [
      '"""multi',
      'line',
      'docstring"""',
      'def f():',
      '    """inner',
      '    doc"""',
      '    # a comment with parens ()',
      '    return f()',
    ].join('\n');
    const { nodes, edges } = await new PythonExtractor().extract(
      { path: 't.py', lang: 'python', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    const f = nodes.find((n) => n.qualifiedName === 'f');
    expect(f?.span).toEqual({ start: 4, end: 8 });
    // f() is self-recursion → skipped (mirrors TS extractor). No calls edges.
    expect(edges.filter((e) => e.rel === 'calls')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Track 3 — statement/condition/CFG extraction (mirrors PlSqlExtractor.test.ts Track-2 block +
// verbs.test.ts extract_rules block). The gold-pattern reference is PlSqlExtractor; the consumer
// is packages/core/src/rules/extract.ts (cfgPath/guard/branch/inLoop/inException + condition id+expr).
// ---------------------------------------------------------------------------------------------

const RULES_FIX = fileURLToPath(new URL('../../fixtures/python/rules.py', import.meta.url));
const RULES_PATH = 'fixtures/python/rules.py';

async function runRules(): Promise<ExtractResult> {
  const text = readFileSync(RULES_FIX, 'utf8');
  const meta: FileMeta = { path: RULES_PATH, lang: 'python', bytes: text.length, mtime: 0 };
  return new PythonExtractor().extract(meta, ctxFor(text));
}

describe('PythonExtractor — Track 3 statement/condition/CFG', () => {
  it('emits ONE condition node per IF (keyed by ifLine) + per-branch statement nodes with the guard chain on executes edges', async () => {
    const { nodes, edges } = await runRules();
    const condId = idFor({ kind: 'condition', file: RULES_PATH, line: 21 });
    const gradeId = idFor({
      kind: 'symbol',
      path: RULES_PATH,
      qualifiedName: 'grade',
      startLine: 20,
    });

    // exactly one condition node for the whole if/elif/else, keyed by the IF line (21), branch THEN
    const conds = nodes.filter((n) => n.kind === 'condition' && n.span?.start === 21);
    expect(conds).toHaveLength(1);
    expect(conds[0]!.id).toBe(condId);
    expect(conds[0]!.branch).toBe('THEN');
    expect(conds[0]!.expr).toBe('score >= 90');

    // three statement nodes (return) in the then/elif/else branches (lines 22/24/26)
    const stmtLines = nodes
      .filter((n) => n.kind === 'statement' && n.span && [22, 24, 26].includes(n.span.start))
      .map((n) => n.span?.start)
      .sort();
    expect(stmtLines).toEqual([22, 24, 26]);

    // executes edges grade -> stmt carry cfgPath=[condId], guard=condId, branch THEN/ELSIF/ELSE
    const execs = edges
      .filter((e) => e.rel === 'executes' && e.src === gradeId)
      .map((e) => ({
        line: nodes.find((n) => n.id === e.dst)?.span?.start,
        branch: e.branch,
        guard: e.guard,
        cfgLen: e.cfgPath?.length,
      }));
    expect(execs).toContainEqual({ line: 22, branch: 'THEN', guard: condId, cfgLen: 1 });
    expect(execs).toContainEqual({ line: 24, branch: 'ELSIF', guard: condId, cfgLen: 1 });
    expect(execs).toContainEqual({ line: 26, branch: 'ELSE', guard: condId, cfgLen: 1 });

    // guarded-by edges stmt -> innermost cond (graph completeness, mirrors PlSqlExtractor)
    expect(edges.filter((e) => e.rel === 'guarded-by' && e.dst === condId)).toHaveLength(3);
  });

  it('emits a LOOP condition + inLoop:true on the loop body executes edge (top-level action unguarded)', async () => {
    const { nodes, edges } = await runRules();
    const loopCondId = idFor({ kind: 'condition', file: RULES_PATH, line: 31 });
    const loopId = idFor({
      kind: 'symbol',
      path: RULES_PATH,
      qualifiedName: 'loop_count',
      startLine: 29,
    });

    const conds = nodes.filter((n) => n.kind === 'condition' && n.span?.start === 31);
    expect(conds).toHaveLength(1);
    expect(conds[0]!.id).toBe(loopCondId);
    expect(conds[0]!.branch).toBe('LOOP');
    expect(conds[0]!.expr).toBe('x in items');

    // the in-loop call (line 32) executes edge: cfgPath=[condId], guard=condId, branch LOOP, inLoop
    const loopExec = edges.find((e) => {
      if (e.rel !== 'executes' || e.src !== loopId) return false;
      const n = nodes.find((x) => x.id === e.dst);
      return n?.span?.start === 32;
    });
    expect(loopExec).toBeDefined();
    expect(loopExec!.cfgPath).toEqual([loopCondId]);
    expect(loopExec!.guard).toBe(loopCondId);
    expect(loopExec!.branch).toBe('LOOP');
    expect(loopExec!.inLoop).toBe(true);

    // the top-level `return total` (line 33) executes edge has NO guard (cfgPath empty, inLoop false)
    const topReturn = edges.find((e) => {
      if (e.rel !== 'executes' || e.src !== loopId) return false;
      const n = nodes.find((x) => x.id === e.dst);
      return n?.span?.start === 33;
    });
    expect(topReturn).toBeDefined();
    expect(topReturn!.cfgPath).toEqual([]);
    expect(topReturn!.guard).toBeUndefined();
    expect(topReturn!.inLoop).toBe(false);
  });

  it('annotates intra-file calls edges with the guard chain (best-effort) + records meta.calls on the proc', async () => {
    const { nodes, edges } = await runRules();
    const condId = idFor({ kind: 'condition', file: RULES_PATH, line: 21 });
    const gradeId = idFor({
      kind: 'symbol',
      path: RULES_PATH,
      qualifiedName: 'grade',
      startLine: 20,
    });
    const honorsId = idFor({
      kind: 'symbol',
      path: RULES_PATH,
      qualifiedName: 'honors',
      startLine: 4,
    });

    // the calls edge grade -> honors carries the THEN-branch guard chain (best-effort, first-wins)
    const callsHonors = edges.find(
      (e) => e.rel === 'calls' && e.src === gradeId && e.dst === honorsId,
    );
    expect(callsHonors).toBeDefined();
    expect(callsHonors!.cfgPath).toEqual([condId]);
    expect(callsHonors!.guard).toBe(condId);
    expect(callsHonors!.branch).toBe('THEN');

    // meta.calls records every call site (recovered by extract_rules for the calls edge's line)
    const grade = nodes.find((n) => n.id === gradeId);
    expect(grade?.meta?.calls).toEqual([
      { callee: 'honors', line: 22 },
      { callee: 'passing', line: 24 },
      { callee: 'failing', line: 26 },
    ]);
  });

  it('extract_rules end-to-end (extractor → soul → decisionTable) returns a non-empty decision table with correct conditions + actions for a guarded procedure', async () => {
    const text = readFileSync(RULES_FIX, 'utf8');
    const r = await new PythonExtractor().extract(
      { path: RULES_PATH, lang: 'python', bytes: text.length, mtime: 0 } as FileMeta,
      ctxFor(text),
    );

    const repo = mkdtempSync(join(tmpdir(), 'crib-py-rules-'));
    try {
      const soul = new SoulStore(join(repo, '.crib'), {
        manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
      });
      soul.load();
      const fileNode: Node = {
        id: idFor({ kind: 'file', path: RULES_PATH }),
        kind: 'file',
        file: RULES_PATH,
        hash: contentHash(RULES_PATH),
      };
      soul.putNodes([fileNode, ...r.nodes]);
      soul.putEdges(r.edges);
      soul.commit('2026-01-01T00:00:00.000Z');

      // grade: one condition column (the IF at line 21); rules across THEN/ELSIF/ELSE branches
      const condId = idFor({ kind: 'condition', file: RULES_PATH, line: 21 });
      const dt = decisionTable(soul, 'grade');
      expect(dt.conditions).toEqual([condId]);
      expect(dt.rules.length).toBeGreaterThan(0);

      const polarities = new Set(dt.rules.map((rr) => rr.branch));
      expect(polarities).toContain('THEN');
      expect(polarities).toContain('ELSIF');
      expect(polarities).toContain('ELSE');

      // the THEN rule's innermost condition is tagged with polarity THEN + the right guard
      const thenRule = dt.rules.find((rr) => rr.branch === 'THEN');
      expect(thenRule).toBeDefined();
      expect(thenRule!.guard).toBe(condId);
      expect(thenRule!.conditions[thenRule!.conditions.length - 1]!.polarity).toBe('THEN');

      // at least one rule's action is an executes (a return statement carrying the call text)
      const execRules = dt.rules.filter((rr) => rr.action.kind === 'executes');
      expect(execRules.length).toBeGreaterThan(0);
      expect(execRules.some((rr) => rr.action.expr?.includes('honors'))).toBe(true);

      // loop_count: the in-loop action carries inLoop + a LOOP condition column
      const loopCondId = idFor({ kind: 'condition', file: RULES_PATH, line: 31 });
      const loopDt = decisionTable(soul, 'loop_count');
      expect(loopDt.conditions).toContain(loopCondId);
      const loopRule = loopDt.rules.find((rr) => rr.inLoop);
      expect(loopRule).toBeDefined();
      expect(loopRule!.branch).toBe('LOOP');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('degrades on a malformed body: no statement/condition nodes, never throws', async () => {
    // a valid def, but a malformed `if` (no colon) → the compound is skipped (no condition, no
    // guarded-by). The valid `y = 5` assignment still emits an `assignment` node + an UNGUARDED
    // executes edge (schema 1.2 surfaces assignments; the malformed compound alone degrades).
    const src = ['def g(x):', '    if x', '    y = 5', ''].join('\n');
    const { nodes, edges } = await new PythonExtractor().extract(
      { path: 'bad.py', lang: 'python', bytes: src.length, mtime: 0 },
      ctxFor(src),
    );
    expect(nodes.filter((n) => n.kind === 'statement')).toEqual([]);
    expect(nodes.filter((n) => n.kind === 'condition')).toEqual([]);
    expect(edges.filter((e) => e.rel === 'guarded-by')).toEqual([]);
    expect(nodes.filter((n) => n.kind === 'assignment' && n.assignTarget === 'y')).toHaveLength(1);
    // the def symbol itself is still emitted (the declaration is valid); only the body degrades
    expect(nodes.filter((n) => n.kind === 'symbol' && n.name === 'g')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Schema 1.2 — behavior-bearing fidelity nodes (raise / exception-handler / assignment /
// case-branch / explanation). Mirrors the canonical PlSqlExtractor pattern; the consumer is
// packages/core/src/rules/extract.ts (cfgPath/guard/branch/inLoop/inException + the new node kinds).
// ---------------------------------------------------------------------------------------------

const BEHAVIOR_FIX = fileURLToPath(new URL('../../fixtures/python/behavior.py', import.meta.url));
const BEHAVIOR_PATH = 'fixtures/python/behavior.py';

async function runBehavior(): Promise<ExtractResult> {
  const text = readFileSync(BEHAVIOR_FIX, 'utf8');
  const meta: FileMeta = { path: BEHAVIOR_PATH, lang: 'python', bytes: text.length, mtime: 0 };
  return new PythonExtractor().extract(meta, ctxFor(text));
}

describe('PythonExtractor — schema 1.2 behavior nodes', () => {
  it('emits a raise node with name + errorMessage, a raises edge, and guard-chain (guarded-by + inException)', async () => {
    const { nodes, edges } = await runBehavior();
    const raiseId = idFor({ kind: 'raise', file: BEHAVIOR_PATH, line: 9 });
    const condId = idFor({ kind: 'condition', file: BEHAVIOR_PATH, line: 8 });
    const processId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'process',
      startLine: 4,
    });

    const raise = nodes.find((n) => n.id === raiseId);
    expect(raise).toBeDefined();
    expect(raise!.kind).toBe('raise');
    expect(raise!.name).toBe('ValueError');
    expect(raise!.errorMessage).toBe('negative result');
    expect(raise!.span).toEqual({ start: 9, end: 9 });

    // raises edge process → raise, stamped with the IF guard chain + inException (inside the try body)
    const raisesEdge = edges.find(
      (e) => e.rel === 'raises' && e.src === processId && e.dst === raiseId,
    );
    expect(raisesEdge).toBeDefined();
    expect(raisesEdge!.cfgPath).toEqual([condId]);
    expect(raisesEdge!.guard).toBe(condId);
    expect(raisesEdge!.branch).toBe('THEN');
    expect(raisesEdge!.inException).toBe(true);
    expect(raisesEdge!.method).toBe('static');
    expect(raisesEdge!.provenance).toBe('EXTRACTED');

    // guarded-by: raise → innermost IF condition (graph completeness, mirrors PlSqlExtractor)
    expect(
      edges.find((e) => e.rel === 'guarded-by' && e.src === raiseId && e.dst === condId),
    ).toBeDefined();
  });

  it('emits an exception-handler node per except clause (typed + tuple) with whenSelector + handles edges to the try-body raise', async () => {
    const { nodes, edges } = await runBehavior();
    const handlerValueId = idFor({ kind: 'exception-handler', file: BEHAVIOR_PATH, line: 11 });
    const handlerTupleId = idFor({ kind: 'exception-handler', file: BEHAVIOR_PATH, line: 13 });
    const raiseId = idFor({ kind: 'raise', file: BEHAVIOR_PATH, line: 9 });

    const handlers = nodes.filter((n) => n.kind === 'exception-handler');
    expect(handlers).toHaveLength(2);

    const hValue = nodes.find((n) => n.id === handlerValueId);
    expect(hValue).toBeDefined();
    expect(hValue!.whenSelector).toBe('ValueError');
    expect(hValue!.span).toEqual({ start: 11, end: 11 });

    const hTuple = nodes.find((n) => n.id === handlerTupleId);
    expect(hTuple).toBeDefined();
    // tuple `except (TypeError, KeyError) as e:` → joined with `|`, `as <name>` dropped
    expect(hTuple!.whenSelector).toBe('TypeError|KeyError');

    // each handler `handles` the raise emitted in the try body (the things it catches)
    const handles = edges.filter((e) => e.rel === 'handles' && e.dst === raiseId);
    expect(handles.map((e) => e.src).sort()).toEqual([handlerTupleId, handlerValueId].sort());
    for (const e of handles) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.confidence).toBe(1);
    }
  });

  it('emits a case-branch node per match arm with whenSelector + guarded executes/guarded-by on the case bodies', async () => {
    const { nodes, edges } = await runBehavior();
    const classifyId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'classify',
      startLine: 17,
    });
    const cbOrigin = idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 20 });
    const cbYAxis = idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 22 });
    const cbDefault = idFor({ kind: 'case-branch', file: BEHAVIOR_PATH, line: 24 });

    const branches = nodes.filter((n) => n.kind === 'case-branch');
    expect(branches).toHaveLength(3);

    const byId = (id: string) => nodes.find((n) => n.id === id);
    expect(byId(cbOrigin)?.whenSelector).toBe('Point(x=0, y=0)');
    expect(byId(cbYAxis)?.whenSelector).toBe('Point(x=0, y=_)');
    expect(byId(cbDefault)?.whenSelector).toBe('_');
    for (const b of branches) {
      expect(b.branch).toBe('CASE');
      expect(b.lang).toBe('python');
    }

    // each case body's return statement executes under its case-branch guard (branch CASE)
    const returns = [21, 23, 25];
    const guardByCase = new Map<string, string>();
    for (const line of returns) {
      const stmtId = idFor({ kind: 'statement', file: BEHAVIOR_PATH, line });
      const exec = edges.find(
        (e) => e.rel === 'executes' && e.src === classifyId && e.dst === stmtId,
      );
      expect(exec).toBeDefined();
      expect(exec!.branch).toBe('CASE');
      expect(exec!.cfgPath).toHaveLength(1);
      guardByCase.set(String(line), exec!.guard!);
      // guarded-by: statement → its case-branch
      const gb = edges.find((e) => e.rel === 'guarded-by' && e.src === stmtId);
      expect(gb?.dst).toBe(exec!.guard);
    }
    // the three returns are guarded by three DISTINCT case-branches
    expect(new Set(guardByCase.values())).toEqual(new Set([cbOrigin, cbYAxis, cbDefault]));
  });

  it('emits an assignment node with assignTarget + an unguarded executes edge (and preserves the try-body return executes)', async () => {
    const { nodes, edges } = await runBehavior();
    const assignId = idFor({ kind: 'assignment', file: BEHAVIOR_PATH, line: 6 });
    const processId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'process',
      startLine: 4,
    });

    const assign = nodes.find((n) => n.id === assignId);
    expect(assign).toBeDefined();
    expect(assign!.kind).toBe('assignment');
    expect(assign!.assignTarget).toBe('result');
    expect(assign!.span).toEqual({ start: 6, end: 6 });

    const exec = edges.find(
      (e) => e.rel === 'executes' && e.src === processId && e.dst === assignId,
    );
    expect(exec).toBeDefined();
    expect(exec!.cfgPath).toEqual([]);
    expect(exec!.guard).toBeUndefined();
    expect(exec!.inLoop).toBe(false);

    // the try-body `return result` (line 10) still executes with inException=true (existing Track-3)
    const returnId = idFor({ kind: 'statement', file: BEHAVIOR_PATH, line: 10 });
    const returnExec = edges.find(
      (e) => e.rel === 'executes' && e.src === processId && e.dst === returnId,
    );
    expect(returnExec).toBeDefined();
    expect(returnExec!.inException).toBe(true);
  });

  it('emits explanation nodes for docstrings with commentRef + meta.text + describes edges (deduped by line)', async () => {
    const { nodes, edges } = await runBehavior();
    const processDocId = idFor({ kind: 'explanation', path: BEHAVIOR_PATH, startLine: 5 });
    const classifyDocId = idFor({ kind: 'explanation', path: BEHAVIOR_PATH, startLine: 18 });
    const processId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'process',
      startLine: 4,
    });
    const classifyId = idFor({
      kind: 'symbol',
      path: BEHAVIOR_PATH,
      qualifiedName: 'classify',
      startLine: 17,
    });

    const expls = nodes.filter((n) => n.kind === 'explanation');
    // process + classify docstrings (the module docstring has no enclosing def/class → no node)
    expect(expls).toHaveLength(2);

    const procDoc = nodes.find((n) => n.id === processDocId);
    expect(procDoc).toBeDefined();
    expect(procDoc!.meta?.text).toBe('Process a value, raising on invalid input.');
    expect(procDoc!.commentRef).toEqual({ file: BEHAVIOR_PATH, span: { start: 5, end: 5 } });
    expect(procDoc!.span).toEqual({ start: 5, end: 5 });

    const classifyDoc = nodes.find((n) => n.id === classifyDocId);
    expect(classifyDoc?.meta?.text).toBe('Classify a point via structural matching.');

    // describes: explanation → symbol
    expect(
      edges.find((e) => e.rel === 'describes' && e.src === processDocId && e.dst === processId),
    ).toBeDefined();
    expect(
      edges.find((e) => e.rel === 'describes' && e.src === classifyDocId && e.dst === classifyId),
    ).toBeDefined();
  });

  it('is id-stable across re-runs (schema 1.2 additions are deterministic)', async () => {
    const a = await runBehavior();
    const b = await runBehavior();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
