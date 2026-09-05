import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, decisionTable, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { TypeScriptExtractor } from './TypeScriptExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/ts-min/auth.ts', import.meta.url));
const PATH = 'fixtures/ts-min/auth.ts';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'typescript', bytes: text.length, mtime: 0 };
  return new TypeScriptExtractor().extract(meta, ctxFor(text));
}

describe('TypeScriptExtractor — golden (M2 gate)', () => {
  it('emits the exact symbol set with correct types', async () => {
    const { nodes } = await run();
    const types: Record<string, string | undefined> = {};
    for (const n of nodes) if (n.qualifiedName) types[n.qualifiedName] = n.type;
    expect(types).toEqual({
      AuthService: 'class',
      'AuthService.login': 'method',
      'AuthService.issue': 'method',
      makeSession: 'function',
      Session: 'interface',
    });
  });

  it('emits member-of edges to the enclosing symbol or file', async () => {
    const { nodes, edges } = await run();
    const id = (q: string) => nodes.find((n) => n.qualifiedName === q)?.id;
    const fileId = idFor({ kind: 'file', path: PATH });
    const memberOf = edges
      .filter((e) => e.rel === 'member-of')
      .map(
        (e) =>
          `${nodes.find((n) => n.id === e.src)?.qualifiedName} -> ${e.dst === fileId ? 'FILE' : nodes.find((n) => n.id === e.dst)?.qualifiedName}`,
      )
      .sort();
    expect(memberOf).toEqual(
      [
        'AuthService -> FILE',
        'AuthService.login -> AuthService',
        'AuthService.issue -> AuthService',
        'makeSession -> FILE',
        'Session -> FILE',
      ].sort(),
    );
    expect(id('AuthService.login')).toBeDefined();
  });

  it('emits intra-file calls (this.issue, makeSession) and nothing cross-file', async () => {
    const { nodes, edges } = await run();
    const q = (id: string) => nodes.find((n) => n.id === id)?.qualifiedName;
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${q(e.src)} -> ${q(e.dst)}`)
      .sort();
    expect(calls).toEqual([
      'AuthService.issue -> makeSession',
      'AuthService.login -> AuthService.issue',
    ]);
    for (const e of edges) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.confidence).toBe(1);
    }
  });

  it('uses the canonical id grammar', async () => {
    const { nodes } = await run();
    const login = nodes.find((n) => n.qualifiedName === 'AuthService.login');
    expect(login?.id).toMatch(/^sym:fixtures\/ts-min\/auth\.ts#AuthService\.login@L\d+$/);
  });

  it('degrades on a malformed file (no symbols, no throw)', async () => {
    const res = await run('class {{{ broken (((');
    expect(res).toBeDefined();
    // TS is lenient; the contract is "no throw". Symbols may be empty or partial.
    expect(Array.isArray(res.nodes)).toBe(true);
  });

  it('is id-stable across runs', async () => {
    const a = await run();
    const b = await run();
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.nodes.map((n) => n.hash)).toEqual(b.nodes.map((n) => n.hash));
  });
});

// ---------------------------------------------------------------------------
// Track 3 — statement/condition/CFG body-walk. Fixture: fixtures/ts/rules.ts
// ---------------------------------------------------------------------------

const RULES_FIXTURE = fileURLToPath(new URL('../../fixtures/ts/rules.ts', import.meta.url));
const RULES_PATH = 'fixtures/ts/rules.ts';

async function runRules(
  text: string = readFileSync(RULES_FIXTURE, 'utf8'),
  path: string = RULES_PATH,
): Promise<ExtractResult> {
  const meta: FileMeta = { path, lang: 'typescript', bytes: text.length, mtime: 0 };
  return new TypeScriptExtractor().extract(meta, ctxFor(text));
}

describe('TypeScriptExtractor — Track 3 statement/condition/CFG', () => {
  it('emits ONE condition node per IF (keyed by IF line) with THEN/ELSE polarity on the edges', async () => {
    const { nodes, edges } = await runRules();
    const approveId = nodes.find((n) => n.qualifiedName === 'approve')?.id;
    expect(approveId).toBeDefined();

    // one condition node for the IF at line 2, branch THEN (first branch wins).
    const conds = nodes.filter((n) => n.kind === 'condition');
    const ifCond = conds.find((c) => c.span?.start === 2);
    expect(ifCond).toBeDefined();
    expect(ifCond?.branch).toBe('THEN');
    const condId = ifCond!.id;
    // no other condition duplicates this IF line
    expect(conds.filter((c) => c.span?.start === 2)).toHaveLength(1);

    const exec = edges.filter((e) => e.rel === 'executes' && e.src === approveId);
    // then-branch action at line 3 (call log) — cfgPath=[cond], guard=cond, branch THEN
    const thenEdge = exec.find((e) => nodes.find((n) => n.id === e.dst)?.span?.start === 3);
    expect(thenEdge).toBeDefined();
    expect(thenEdge?.cfgPath).toEqual([condId]);
    expect(thenEdge?.guard).toBe(condId);
    expect(thenEdge?.branch).toBe('THEN');
    expect(thenEdge?.inLoop).toBe(false);
    // else-branch action at line 6 (call deny) — SAME condId, branch ELSE
    const elseEdge = exec.find((e) => nodes.find((n) => n.id === e.dst)?.span?.start === 6);
    expect(elseEdge).toBeDefined();
    expect(elseEdge?.cfgPath).toEqual([condId]);
    expect(elseEdge?.guard).toBe(condId);
    expect(elseEdge?.branch).toBe('ELSE');
  });

  it('emits guarded-by edges from guarded statements to the innermost condition', async () => {
    const { nodes, edges } = await runRules();
    const approveId = nodes.find((n) => n.qualifiedName === 'approve')?.id;
    const condId = nodes.find((n) => n.kind === 'condition' && n.span?.start === 2)?.id;
    // the then-branch statements (line 3 call, line 4 return) + else-branch (line 6 call) are
    // all guarded-by cond:L2.
    const guarded = edges
      .filter((e) => e.rel === 'guarded-by' && e.dst === condId)
      .map((e) => nodes.find((n) => n.id === e.src)?.span?.start)
      .sort();
    expect(guarded).toEqual([3, 4, 6]);
    // approve is the source of the executes edges to those guarded statements
    expect(approveId).toBeDefined();
  });

  it('emits a branch:LOOP condition + inLoop:true on the executes edge for a for-of body action', async () => {
    const { nodes, edges } = await runRules();
    const reviewId = nodes.find((n) => n.qualifiedName === 'review')?.id;
    expect(reviewId).toBeDefined();
    const loopCond = nodes.find((n) => n.kind === 'condition' && n.span?.start === 11);
    expect(loopCond).toBeDefined();
    expect(loopCond?.branch).toBe('LOOP');

    const loopExec = edges.find(
      (e) =>
        e.rel === 'executes' &&
        e.src === reviewId &&
        nodes.find((n) => n.id === e.dst)?.span?.start === 12,
    );
    expect(loopExec).toBeDefined();
    expect(loopExec?.inLoop).toBe(true);
    expect(loopExec?.branch).toBe('LOOP');
    expect(loopExec?.cfgPath).toEqual([loopCond!.id]);
    expect(loopExec?.guard).toBe(loopCond!.id);
  });

  it('records call sites on proc.meta.calls + annotates the deduped calls edges with guard fields', async () => {
    const { nodes, edges } = await runRules();
    const approve = nodes.find((n) => n.qualifiedName === 'approve');
    const sites = approve?.meta?.calls as Array<{ callee: string; line: number }> | undefined;
    expect(sites).toEqual([
      { callee: 'log', line: 3 },
      { callee: 'issue', line: 4 },
      { callee: 'deny', line: 6 },
    ]);
    // calls edges exist + carry the guard chain (best-effort, last-wins per callee).
    const logId = nodes.find((n) => n.qualifiedName === 'log')?.id;
    const denyId = nodes.find((n) => n.qualifiedName === 'deny')?.id;
    const callToLog = edges.find(
      (e) => e.rel === 'calls' && e.src === approve?.id && e.dst === logId,
    );
    const callToDeny = edges.find(
      (e) => e.rel === 'calls' && e.src === approve?.id && e.dst === denyId,
    );
    expect(callToLog?.branch).toBe('THEN');
    expect(callToDeny?.branch).toBe('ELSE');
    expect(callToLog?.guard).toBeDefined();
  });

  it('keeps existing declaration/member-of/calls behavior strictly additive (golden still holds)', async () => {
    const { nodes, edges } = await runRules();
    // declaration set unchanged
    const types: Record<string, string | undefined> = {};
    for (const n of nodes) if (n.qualifiedName) types[n.qualifiedName] = n.type;
    expect(types).toEqual({
      approve: 'function',
      review: 'function',
      log: 'function',
      issue: 'function',
      deny: 'function',
      makeToken: 'function',
    });
    // member-of edges present; every edge still EXTRACTED/static/confidence 1.
    expect(edges.some((e) => e.rel === 'member-of')).toBe(true);
    for (const e of edges) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.method).toBe('static');
      expect(e.confidence).toBe(1);
    }
  });

  it('degrades on a malformed body (no throw, no condition/statement nodes for an action-less body)', async () => {
    // a body with only a non-action declaration emits no statement/condition nodes (lean graph).
    const lean = await runRules(
      'export function empty() {\n  const x = 1;\n}\n',
      'fixtures/ts/lean.ts',
    );
    expect(lean.nodes.filter((n) => n.kind === 'statement' || n.kind === 'condition')).toEqual([]);
    // a genuinely malformed body never throws the pipeline.
    const res = await runRules('export function broken( { if )) return;', 'fixtures/ts/broken.ts');
    expect(res).toBeDefined();
    expect(Array.isArray(res.nodes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extract_rules end-to-end: extractor → SoulStore → decisionTable (real core)
// ---------------------------------------------------------------------------

describe('TypeScriptExtractor — extract_rules e2e (Track 3)', () => {
  let dir: string;
  let soul: SoulStore;

  beforeEach(async () => {
    const res = await runRules();
    dir = mkdtempSync(join(tmpdir(), 'crib-ts-rules-e2e-'));
    soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.putNodes(res.nodes);
    soul.putEdges(res.edges);
    soul.commit('2026-01-01T00:00:00.000Z');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a non-empty decision table with correct conditions + actions for a guarded procedure', () => {
    const table = decisionTable(soul, 'approve');
    expect(table.rules.length).toBeGreaterThan(0);
    // one condition column — the IF predicate at line 2
    expect(table.conditions).toHaveLength(1);
    const condId = table.conditions[0]!;
    const condNode = soul.getNode(condId);
    expect(condNode?.kind).toBe('condition');
    expect(condNode?.expr).toContain('amount > 100');

    // a THEN-branch rule (call log at line 3) carries polarity THEN on the innermost condition.
    const thenRule = table.rules.find((r) => r.branch === 'THEN' && r.action.kind === 'executes');
    expect(thenRule).toBeDefined();
    expect(thenRule?.conditions[0]?.polarity).toBe('THEN');
    expect(thenRule?.guard).toBe(condId);
    expect(thenRule?.action.expr).toContain('log');

    // an ELSE-branch rule (call deny at line 6) carries polarity ELSE.
    const elseRule = table.rules.find((r) => r.branch === 'ELSE');
    expect(elseRule).toBeDefined();
    expect(elseRule?.conditions[0]?.polarity).toBe('ELSE');

    // a calls rule recovers the call-site line from meta.calls.
    const callsRule = table.rules.find((r) => r.action.kind === 'calls');
    expect(callsRule).toBeDefined();
    expect(callsRule?.action.line).toBeDefined();
  });

  it('surfaces inLoop on the loop-body action and a LOOP condition column', () => {
    const table = decisionTable(soul, 'review');
    expect(table.rules.length).toBeGreaterThan(0);
    const loopCond = table.conditions
      .map((id) => soul.getNode(id))
      .find((n) => n?.branch === 'LOOP');
    expect(loopCond).toBeDefined();
    const loopRule = table.rules.find((r) => r.inLoop);
    expect(loopRule).toBeDefined();
    expect(loopRule?.branch).toBe('LOOP');
  });
});

// ---------------------------------------------------------------------------
// Schema 1.2 — deep-extraction fidelity behavior nodes (Workstream B parity with PL/SQL).
// Source is inlined (not a .ts fixture) because biome 1.9.4's parser rejects typed catch clauses
// with custom types (`catch (e: PaymentError)`); the TS compiler accepts it and parses it at runtime.
// ---------------------------------------------------------------------------

const BEHAVIOR_PATH = 'fixtures/ts/behavior.ts';
const BEHAVIOR_SRC = `/** Process a payment: validates, classifies, and records.
 * Throws on invalid input.
 */
export function processPayment(amount: number, kind: string): string {
  let status = 'pending';
  try {
    if (amount <= 0) {
      throw new Error('invalid amount');
    }
    switch (kind) {
      case 'card':
        status = 'card-charged';
        break;
      case 'cash':
        status = 'cash-paid';
        break;
      default:
        status = 'unknown';
    }
  } catch (e: PaymentError) {
    status = 'failed';
    log(status);
  }
  return status;
}

class PaymentError extends Error {}

function log(x: string): void {
  return;
}
`;

async function runBehavior(
  text: string = BEHAVIOR_SRC,
  path: string = BEHAVIOR_PATH,
): Promise<ExtractResult> {
  const meta: FileMeta = { path, lang: 'typescript', bytes: text.length, mtime: 0 };
  return new TypeScriptExtractor().extract(meta, ctxFor(text));
}

describe('TypeScriptExtractor — schema 1.2 deep-extraction fidelity', () => {
  it('emits a `raise` node with errorMessage + a `raises` edge from the callable', async () => {
    const { nodes, edges } = await runBehavior();
    const procId = nodes.find((n) => n.qualifiedName === 'processPayment')?.id;
    expect(procId).toBeDefined();
    const raise = nodes.find((n) => n.kind === 'raise');
    expect(raise).toBeDefined();
    expect(raise?.errorMessage).toBe('invalid amount');
    // throw sits inside the try body → inException stamped on meta.
    expect(raise?.meta?.inException).toBe(true);
    expect(raise?.meta?.inLoop).toBe(false);
    const raises = edges.find((e) => e.rel === 'raises' && e.src === procId && e.dst === raise!.id);
    expect(raises).toBeDefined();
    expect(raises?.provenance).toBe('EXTRACTED');
    expect(raises?.confidence).toBe(1);
  });

  it('stamps guarded-by on the raise from the enclosing IF condition', async () => {
    const { nodes, edges } = await runBehavior();
    const raise = nodes.find((n) => n.kind === 'raise');
    const ifCond = nodes.find((n) => n.kind === 'condition');
    expect(raise).toBeDefined();
    expect(ifCond).toBeDefined();
    const gb = edges.find(
      (e) => e.rel === 'guarded-by' && e.src === raise!.id && e.dst === ifCond!.id,
    );
    expect(gb).toBeDefined();
  });

  it('emits an `exception-handler` node with the typed catch whenSelector + `handles` edges', async () => {
    const { nodes, edges } = await runBehavior();
    const exc = nodes.find((n) => n.kind === 'exception-handler');
    expect(exc).toBeDefined();
    expect(exc?.whenSelector).toBe('PaymentError');
    // handles edges point from the handler to each statement/assignment/raise inside the catch body.
    const handles = edges.filter((e) => e.rel === 'handles' && e.src === exc!.id);
    expect(handles.length).toBeGreaterThan(0);
    // the catch body contains an assignment (`status = 'failed'`) + a call (`log(status)`) — both
    // surface as nodes the handler `handles`.
    const handledKinds = handles.map((e) => nodes.find((n) => n.id === e.dst)?.kind).sort();
    expect(handledKinds).toContain('assignment');
  });

  it('emits one `case-branch` node per non-default case with whenSelector + executes edges', async () => {
    const { nodes, edges } = await runBehavior();
    const procId = nodes.find((n) => n.qualifiedName === 'processPayment')?.id;
    const cases = nodes.filter((n) => n.kind === 'case-branch');
    expect(cases).toHaveLength(2);
    const selectors = cases.map((c) => c.whenSelector).sort();
    expect(selectors).toEqual(['card', 'cash']);
    for (const c of cases) {
      const exec = edges.find((e) => e.rel === 'executes' && e.src === procId && e.dst === c.id);
      expect(exec).toBeDefined();
    }
  });

  it('emits an `assignment` node with assignTarget + executes + guarded-by the case-branch', async () => {
    const { nodes, edges } = await runBehavior();
    const procId = nodes.find((n) => n.qualifiedName === 'processPayment')?.id;
    const assigns = nodes.filter((n) => n.kind === 'assignment');
    expect(assigns.length).toBeGreaterThan(0);
    // every assignment's target is the `status` LHS.
    for (const a of assigns) expect(a.assignTarget).toBe('status');
    // executes: proc → assignment
    const exec = edges.find(
      (e) => e.rel === 'executes' && e.src === procId && e.dst === assigns[0]!.id,
    );
    expect(exec).toBeDefined();
    // the case-body assignments are guarded-by their case-branch node.
    const caseBranches = nodes.filter((n) => n.kind === 'case-branch');
    const guardedByCase = edges.filter(
      (e) =>
        e.rel === 'guarded-by' &&
        e.dst !== undefined &&
        caseBranches.some((c) => c.id === e.dst) &&
        assigns.some((a) => a.id === e.src),
    );
    expect(guardedByCase.length).toBeGreaterThan(0);
  });

  it('emits an `explanation` node with commentRef + meta.text + a `describes` edge to the symbol', async () => {
    const { nodes, edges } = await runBehavior();
    const procId = nodes.find((n) => n.qualifiedName === 'processPayment')?.id;
    const expl = nodes.find((n) => n.kind === 'explanation');
    expect(expl).toBeDefined();
    expect(expl?.commentRef).toEqual({ file: BEHAVIOR_PATH, span: { start: 1, end: 3 } });
    expect(typeof expl?.meta?.text).toBe('string');
    expect((expl?.meta?.text as string).length).toBeGreaterThan(0);
    const describes = edges.find(
      (e) => e.rel === 'describes' && e.src === expl!.id && e.dst === procId,
    );
    expect(describes).toBeDefined();
  });

  it('does NOT emit cursor nodes (TypeScript has no SQL cursors — capability-honest)', async () => {
    const { nodes, edges } = await runBehavior();
    expect(nodes.some((n) => n.kind === 'cursor')).toBe(false);
    expect(edges.some((e) => e.rel === 'iterates')).toBe(false);
    expect(edges.some((e) => e.rel === 'declares')).toBe(false);
  });

  it('keeps existing executes/calls/guarded-by/member-of edges (no regression)', async () => {
    const { nodes, edges } = await runBehavior();
    const procId = nodes.find((n) => n.qualifiedName === 'processPayment')?.id;
    const logId = nodes.find((n) => n.qualifiedName === 'log')?.id;
    // member-of present for every symbol; every edge EXTRACTED/static/confidence 1.
    expect(edges.some((e) => e.rel === 'member-of')).toBe(true);
    for (const e of edges) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.method).toBe('static');
      expect(e.confidence).toBe(1);
    }
    // intra-file call processPayment -> log still resolves (the call is inside the catch body).
    const callToLog = edges.find((e) => e.rel === 'calls' && e.src === procId && e.dst === logId);
    expect(callToLog).toBeDefined();
    // the IF still emits its condition node + guarded-by from the then-branch throw... but throw is
    // now a raise node, so guarded-by fires from the raise instead.
    const ifCond = nodes.find((n) => n.kind === 'condition');
    expect(ifCond).toBeDefined();
  });

  it('is id-stable across runs for the new behavior nodes', async () => {
    const a = await runBehavior();
    const b = await runBehavior();
    expect(a.nodes.map((n) => n.id).sort()).toEqual(b.nodes.map((n) => n.id).sort());
    expect(a.nodes.map((n) => n.hash).sort()).toEqual(b.nodes.map((n) => n.hash).sort());
  });
});

// ─── F11: call resolution must not fabricate confident edges ─────────────────
//
// The audit (docs/audits/2026-09-05) found `enqueueFreshness`'s `now` PARAMETER resolving, at
// confidence 1, to two unrelated symbols named `now` — one a class property in the same file, one a
// function in a different file. A deterministic graph can still be deterministically wrong, and a
// confident wrong edge is worse than an openly unresolved one: `gaps` reports the second, while the
// first silently corrupts blast-radius and rename planning.

describe('call resolution honesty (audit F11)', () => {
  const callEdges = async (src: string) => {
    const out = await run(src);
    return (
      out.edges
        .filter((e) => e.rel === 'calls')
        // ids carry an `@L<line>` suffix; compare on qualified names so the assertions read clearly
        .map((e) => {
          const name = (id: string) => (id.split('#')[1] ?? id).replace(/@L\d+$/, '');
          return `${name(e.src)} -> ${name(e.dst)}`;
        })
    );
  };

  it('does not resolve a call to a parameter as a call to a same-named class member', async () => {
    const calls = await callEdges(`
      export class Worker {
        now() { return 1; }
      }
      export function enqueue(now: () => number) {
        return now();
      }
    `);
    // `now()` inside enqueue targets the PARAMETER; Worker.now is unreachable from a bare call.
    expect(calls.filter((c) => c.includes('-> Worker.now'))).toEqual([]);
  });

  it('does not resolve a bare call to a class member even without shadowing', async () => {
    const calls = await callEdges(`
      export class Worker {
        helper() { return 1; }
      }
      export function run() {
        return helper();
      }
    `);
    // A bare `helper()` cannot reach `Worker.helper` — it would need a receiver.
    expect(calls.filter((c) => c.includes('-> Worker.helper'))).toEqual([]);
  });

  it('still resolves a genuine top-level call', async () => {
    const calls = await callEdges(`
      export function helper() { return 1; }
      export function run() { return helper(); }
    `);
    expect(calls).toContain('run -> helper');
  });

  it('still resolves a receiver call to a class member', async () => {
    const calls = await callEdges(`
      export class Worker {
        helper() { return 1; }
        run() { return this.helper(); }
      }
    `);
    expect(calls).toContain('Worker.run -> Worker.helper');
  });

  it('resolves typed receivers to the matching class instead of the first same-named method', async () => {
    const calls = await callEdges(`
      export class Alpha { ping() { return 'a'; } }
      export class Beta { ping() { return 'b'; } }
      export function run(alpha: Alpha, beta: Beta) {
        alpha.ping();
        beta.ping();
      }
    `);
    expect(calls).toContain('run -> Alpha.ping');
    expect(calls).toContain('run -> Beta.ping');
  });

  it('resolves receivers initialized with new and leaves unknown receivers unresolved', async () => {
    const calls = await callEdges(`
      export class Alpha { ping() { return 'a'; } }
      export class Beta { ping() { return 'b'; } }
      export function run(unknown: any) {
        const alpha = new Alpha();
        alpha.ping();
        unknown.ping();
      }
    `);
    expect(calls).toContain('run -> Alpha.ping');
    expect(calls.filter((c) => c === 'run -> Beta.ping')).toEqual([]);
  });

  it('resolves a typed this-property receiver', async () => {
    const calls = await callEdges(`
      export class Clock { now() { return 1; } }
      export class Worker {
        constructor(private readonly clock: Clock) {}
        run() { return this.clock.now(); }
      }
    `);
    expect(calls).toContain('Worker.run -> Clock.now');
  });

  it('does not resolve a call shadowed by a local variable or nested function', async () => {
    const shadowedByLocal = await callEdges(`
      export function helper() { return 1; }
      export function run() {
        const helper = () => 2;
        return helper();
      }
    `);
    expect(shadowedByLocal.filter((c) => c.includes('run -> helper'))).toEqual([]);

    const shadowedByDestructuring = await callEdges(`
      export function helper() { return 1; }
      export function run({ helper }: { helper: () => number }) {
        return helper();
      }
    `);
    expect(shadowedByDestructuring.filter((c) => c.includes('run -> helper'))).toEqual([]);
  });

  it('records the unresolved call site anyway, so the gap stays visible', async () => {
    const out = await run(`
      export function enqueue(now: () => number) {
        return now();
      }
    `);
    const fn = out.nodes.find((n) => n.name === 'enqueue');
    const sites = (fn?.meta?.calls ?? []) as Array<{ callee: string }>;
    // Dropping the EDGE must not drop the evidence that a call happened here.
    expect(sites.map((s) => s.callee)).toContain('now');
  });
});
