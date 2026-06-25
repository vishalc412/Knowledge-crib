import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
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
    // the extractor never emits imports/inherits (resolver's job) or any type edges.
    const rels = new Set(edges.map((e) => e.rel));
    expect(rels).toEqual(new Set(['member-of', 'calls']));
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
