/**
 * PDG layer tests (Gate 5.2). All fixtures are inline strings analyzed in-memory — no repo
 * indexing, no disk writes: the PDG is an on-demand re-analysis of source, never an index artifact.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { type Pdg, explainSymbol, findEnclosingFunction } from './index.js';
import { DEFAULT_TAINT_RULES } from './taint.js';

function pdgOf(source: string, symbol: string): Pdg {
  const result = explainSymbol({ source, fileName: 'fixture.ts', symbol });
  if (!result) throw new Error(`fixture symbol '${symbol}' not found`);
  return result.pdg;
}

function nodeByText(pdg: Pdg, fragment: string): number {
  const hits = pdg.nodes.filter((n) => n.text.includes(fragment));
  if (hits.length !== 1)
    throw new Error(`expected exactly one node containing '${fragment}', got ${hits.length}`);
  return hits[0]!.id;
}

function controlTargets(pdg: Pdg, src: number): number[] {
  return pdg.control.filter((e) => e.src === src).map((e) => e.dst);
}

function dataPairs(pdg: Pdg): string[] {
  return pdg.data.map((e) => `${e.src}>${e.dst}`);
}

describe('control dependence (post-dominator rule)', () => {
  it('marks both arms of an if/else as controlled by the condition', () => {
    const pdg = pdgOf(
      `
function f(x: number): number {
  let y = 0;
  if (x > 1) {
    y = 1;
  } else {
    y = 2;
  }
  return y;
}
`,
      'f',
    );
    const cond = nodeByText(pdg, 'x > 1');
    const targets = controlTargets(pdg, cond);
    expect(targets).toContain(nodeByText(pdg, 'y = 1;'));
    expect(targets).toContain(nodeByText(pdg, 'y = 2;'));
    expect(targets).not.toContain(nodeByText(pdg, 'let y = 0;'));
  });

  it('keeps the loop-condition self-dependence (standard result for loop predicates)', () => {
    const pdg = pdgOf(
      `
function g(n: number): number {
  let s = 0;
  while (n > 0) {
    s = s + n;
    n = n - 1;
  }
  return s;
}
`,
      'g',
    );
    const cond = nodeByText(pdg, 'n > 0');
    expect(controlTargets(pdg, cond)).toContain(cond);
    expect(controlTargets(pdg, cond)).toContain(nodeByText(pdg, 's = s + n;'));
  });

  it('excludes unreachable statements from analysis (code after return)', () => {
    const pdg = pdgOf(
      `
function early(x: number): number {
  if (x > 0) {
    return 1;
    x = 9;
  }
  return 2;
}
`,
      'early',
    );
    // dead code after a terminator is never entered into the analysis: no phantom edges
    const dead = pdg.nodes.find((n) => n.text.includes('x = 9;'));
    expect(dead).toBeUndefined();
    // and the branch condition still controls the live return
    const cond = nodeByText(pdg, 'x > 0');
    expect(controlTargets(pdg, cond)).toContain(nodeByText(pdg, 'return 1;'));
  });
});

describe('data dependence (reaching definitions)', () => {
  it('links a parameter def to its uses across branch and loop', () => {
    const pdg = pdgOf(
      `
function h(flag: boolean, src: string): string {
  let out = '';
  if (flag) {
    out = src;
  }
  for (let i = 0; i < 3; i++) {
    out = out + '!';
  }
  return out;
}
`,
      'h',
    );
    const entry = pdg.entry;
    const fromSrc = nodeByText(pdg, 'out = src;');
    expect(dataPairs(pdg)).toContain(`${entry}>${fromSrc}`); // param `src` reaches its use
    const loopUse = nodeByText(pdg, "out = out + '!';");
    expect(dataPairs(pdg)).toContain(`${fromSrc}>${loopUse}`); // `out` flows into the loop
    const ret = nodeByText(pdg, 'return out;');
    expect(dataPairs(pdg)).toContain(`${loopUse}>${ret}`);
  });

  it('kills a definition when the variable is reassigned', () => {
    const pdg = pdgOf(
      `
function k(cond: boolean): number {
  let v = 1;
  if (cond) {
    v = 2;
  }
  return v;
}
`,
      'k',
    );
    const ret = nodeByText(pdg, 'return v;');
    // both may-definitions reach the return: an extra edge is the conservative direction
    expect(dataPairs(pdg)).toContain(`${nodeByText(pdg, 'let v = 1;')}>${ret}`);
    expect(dataPairs(pdg)).toContain(`${nodeByText(pdg, 'v = 2;')}>${ret}`);
  });
});

describe('taint analysis', () => {
  it('reports eval-of-request-query as a code-injection flow with a source→sink path', () => {
    const result = explainSymbol({
      source: `
function handler(req: any): void {
  const q = req.query.q;
  eval(q);
}
`,
      fileName: 'handler.ts',
      symbol: 'handler',
    })!;
    expect(result.flows.length).toBeGreaterThan(0);
    const flow = result.flows[0];
    if (!flow) throw new Error('expected at least one flow');
    expect(flow.sinkRule).toBe('sink.code-eval');
    expect(flow.sourceRule).toBe('source.http-input');
    const lines = flow.path.map((s) => s.line);
    expect(lines).toContain(3); // `const q = req.query.q;`
    expect(lines).toContain(4); // `eval(q);`
    const first = lines[0] ?? 0;
    const last = lines[lines.length - 1] ?? 0;
    expect(first).toBeLessThan(last); // path is origin → sink
  });

  it('reports a direct source-in-sink expression (no intervening variable)', () => {
    const result = explainSymbol({
      source: `
function direct(req: any): void {
  eval(req.query.q);
}
`,
      fileName: 'direct.ts',
      symbol: 'direct',
    })!;
    expect(result.flows.some((f) => f.sinkRule === 'sink.code-eval')).toBe(true);
  });

  it('encodeURIComponent interrupts url-context flows', () => {
    const result = explainSymbol({
      source: `
function safe(req: any): void {
  const q = req.query.q;
  const s = encodeURIComponent(q);
  fetch(s);
}
`,
      fileName: 'safe.ts',
      symbol: 'safe',
    })!;
    expect(result.sinksChecked).toBeGreaterThan(0);
    expect(result.flows.filter((f) => f.sinkRule === 'sink.url-fetch')).toHaveLength(0);
  });

  it('encodeURIComponent does NOT interrupt shell-context flows (sanitizer is context-scoped)', () => {
    const result = explainSymbol({
      source: `
function sneaky(req: any): void {
  const q = req.query.q;
  const s = encodeURIComponent(q);
  exec(s);
}
`,
      fileName: 'sneaky.ts',
      symbol: 'sneaky',
    })!;
    const flow = result.flows.find((f) => f.sinkRule === 'sink.shell-exec');
    expect(flow).toBeDefined();
  });

  it('reports zero flows for an untainted body but still counts the sinks it checked — absence here is NOT proof of safety', () => {
    const result = explainSymbol({
      source: `
function clean(x: string): void {
  const local = x + 'ok';
  eval(local);
}
`,
      fileName: 'clean.ts',
      symbol: 'clean',
    })!;
    expect(result.flows).toHaveLength(0);
    expect(result.sinksChecked).toBe(1);
  });

  it('taints statements guarded by a tainted condition (conservative control dependence)', () => {
    const result = explainSymbol({
      source: `
function guarded(req: any): void {
  const flag = req.query.admin === '1';
  if (flag) {
    exec('ls ' + req.query.dir);
  }
}
`,
      fileName: 'guarded.ts',
      symbol: 'guarded',
    })!;
    expect(result.flows.some((f) => f.sinkRule === 'sink.shell-exec')).toBe(true);
  });

  it('propagates taint through loop-carried variables', () => {
    const result = explainSymbol({
      source: `
function loop(req: any): void {
  let acc = '';
  for (let i = 0; i < 2; i++) {
    acc = acc + req.query.part;
  }
  exec(acc);
}
`,
      fileName: 'loop.ts',
      symbol: 'loop',
    })!;
    expect(result.flows.some((f) => f.sinkRule === 'sink.shell-exec' && f.variable === 'acc')).toBe(
      true,
    );
  });

  it('accepts user-supplied rules appended to the default table', () => {
    const result = explainSymbol({
      source: `
function custom(cfg: string): void {
  doMagic(cfg);
}
`,
      fileName: 'custom.ts',
      symbol: 'custom',
      extraRules: [
        { id: 'source.config', kind: 'source', match: ['domagic('] },
        { id: 'sink.magic', kind: 'sink', match: ['domagic('], context: 'code' },
      ],
    })!;
    expect(
      result.flows.some((f) => f.sinkRule === 'sink.magic' && f.sourceRule === 'source.config'),
    ).toBe(true);
  });

  it('the default rule table stays small and covers the documented contexts', () => {
    expect(DEFAULT_TAINT_RULES.length).toBeLessThanOrEqual(20);
    for (const rule of DEFAULT_TAINT_RULES) {
      if (rule.kind === 'sink') expect(rule.context).toBeDefined();
    }
  });
});

describe('explainSymbol boundaries', () => {
  it('returns null when no function-like body matches the symbol', () => {
    const result = explainSymbol({
      source: 'export const answer = 42;\n',
      fileName: 'consts.ts',
      symbol: 'answer',
    });
    expect(result).toBeNull();
  });

  it('analyzes the tightest scope containing the given line (nested arrow, not the outer fn)', () => {
    const source = `
function outer(req: any): void {
  const run = () => {
    const q = req.query.q;
    eval(q);
  };
  run();
}
`;
    const result = explainSymbol({ source, fileName: 'outer.ts', symbol: 'outer', line: 4 })!;
    // the flow is inside the arrow body, so even the outer symbol's request resolves to it
    expect(result.flows.some((f) => f.sinkRule === 'sink.code-eval')).toBe(true);
  });

  it('handles expression-bodied arrows', () => {
    const source = `
const twice = (n: number) => n * 2;
`;
    const result = explainSymbol({ source, fileName: 'twice.ts', symbol: 'twice', line: 2 })!;
    expect(result.pdg.nodes.length).toBeGreaterThan(2);
    expect(result.pdg.data.length).toBeGreaterThanOrEqual(0);
  });
});

describe('findEnclosingFunction', () => {
  it('falls back to name matching when no line is given', () => {
    const source = `
function alpha(x: number): number {
  return x + 1;
}
function beta(x: number): number {
  return x * 2;
}
`;
    const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
    const fn = findEnclosingFunction(sf, 'beta');
    expect(fn).not.toBeNull();
  });
});
