/**
 * Outbound HTTP client-call extraction (schema 1.5) — dedicated coverage of {@link extractHttpClients}
 * driven through the {@link TypeScriptExtractor} end-to-end (Pass 4). An `http-call` node is the
 * repo-A side of cross-repo federation: the OUTBOUND counterpart to an INBOUND `route` node, carrying
 * the same {httpMethod, routePath, framework} fields so a runtime federation layer can match a
 * repo-A call to a repo-B route by method+path. This suite covers fetch + axios detection, the
 * template-literal → `:param` path shape, method override, the enclosing-callable `calls` edge, and
 * the no-op gates that cut false positives (non-axios receivers, unreadable paths, axios.request).
 * Inline source, deterministic.
 */
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { TypeScriptExtractor } from './TypeScriptExtractor.js';

const PATH = 'client.ts';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — TypeScript uses the TS compiler API');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(src: string): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'typescript', bytes: src.length, mtime: 0 };
  return new TypeScriptExtractor().extract(meta, ctxFor(src));
}

/** all http-call surfaces as `METHOD /path [framework]`, sorted. */
const httpCalls = (r: ExtractResult): string[] =>
  r.nodes
    .filter((n) => n.kind === 'http-call')
    .map((n) => `${n.httpMethod} ${n.routePath} [${n.framework}]`)
    .sort();

/** all `calls` edges whose dst is an http-call, as `caller -> METHOD /path`, sorted. */
const callsEdges = (r: ExtractResult): string[] => {
  const callById = new Map(r.nodes.filter((n) => n.kind === 'http-call').map((n) => [n.id, n]));
  const nameOf = (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    return n?.name ?? n?.qualifiedName ?? id;
  };
  return r.edges
    .filter((e) => e.rel === 'calls' && callById.has(e.dst))
    .map((e) => {
      const c = callById.get(e.dst)!;
      return `${nameOf(e.src)} -> ${c.httpMethod} ${c.routePath}`;
    })
    .sort();
};

describe('http-call — fetch detection', () => {
  it('emits GET for fetch("/api/loans") with framework:fetch', async () => {
    const src = ['export async function ping() {', '  await fetch("/api/loans");', '}', ''].join(
      '\n',
    );
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /api/loans [fetch]']);
  });

  it('turns a templated fetch(`/api/loans/${id}`) into /api/loans/:id (the route shape)', async () => {
    const src = [
      'export async function fetchLoan(id: string) {',
      '  const res = await fetch(`/api/loans/${id}`);',
      '  return res.json();',
      '}',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /api/loans/:id [fetch]']);
  });

  it('overrides the method from init.method string literal', async () => {
    const src = [
      'export async function createLoan(body: unknown) {',
      '  await fetch("/api/loans", { method: "POST", body: JSON.stringify(body) });',
      '}',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['POST /api/loans [fetch]']);
  });

  it('emits a calls edge from the enclosing function to the http-call (EXTRACTED, conf 1)', async () => {
    const src = [
      'export async function fetchLoan(id: string) {',
      '  await fetch(`/api/loans/${id}`);',
      '}',
      '',
    ].join('\n');
    const r = await run(src);
    expect(callsEdges(r)).toEqual(['fetchLoan -> GET /api/loans/:id']);
    const e = r.edges.find((x) => x.rel === 'calls' && x.dst.includes('http-call'));
    expect(e?.provenance).toBe('EXTRACTED');
    expect(e?.confidence).toBe(1);
    expect(e?.method).toBe('static');
  });
});

describe('http-call — axios detection', () => {
  it('emits axios.<verb> with the verb from the property name', async () => {
    const src = [
      'import axios from "axios";',
      'export async function postLoan(b: unknown) {',
      '  await axios.post("/api/loans", b);',
      '}',
      'export async function delLoan(id: string) {',
      '  await axios.delete(`/api/loans/${id}`);',
      '}',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['DELETE /api/loans/:id [axios]', 'POST /api/loans [axios]']);
  });

  it('bare axios("/x") defaults to GET', async () => {
    const src = [
      'import axios from "axios";',
      'export async function go() { await axios("/x"); }',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /x [axios]']);
  });
});

describe('http-call — no-op gates (honest over noise)', () => {
  it('does not emit for a non-axios receiver (res.get is a DB accessor, not HTTP)', async () => {
    const src = [
      'const res = {} as any;',
      'export function row() { return res.get("/x"); }',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual([]);
  });

  it('does not emit when the path is not readable (a bare identifier, not a literal)', async () => {
    const src = ['export async function go(url: string) { await fetch(url); }', ''].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual([]);
  });

  it('does not emit for axios.request (url rides in a config object we cannot read deterministically)', async () => {
    const src = [
      'import axios from "axios";',
      'export async function go() { await axios.request({ url: "/x", method: "POST" }); }',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual([]);
  });

  it('emits the node only (no calls edge) for a top-level call with no enclosing callable', async () => {
    const src = ['await fetch("/top");', ''].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /top [fetch]']);
    expect(callsEdges(r)).toEqual([]);
  });
});

describe('http-call — enclosing-callable across callback arrows (the dominant client pattern)', () => {
  it('links the calls edge to the outer function when fetch sits in a .forEach arrow callback', async () => {
    // The real-world pattern: the http-call is inside an anonymous `.forEach` arrow with no minted
    // symbol of its own. enclosingCallableId must walk PAST the unminted arrow up to the minted `go`
    // — otherwise the node emits with no calls edge and the federation `down` hop from `go` breaks.
    const src = [
      'export function go(ids: string[]) {',
      '  ids.forEach((id) => fetch(`/a/${id}`));',
      '}',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /a/:id [fetch]']);
    expect(callsEdges(r)).toEqual(['go -> GET /a/:id']);
  });

  it('links the calls edge to a const-arrow via its VariableStatement symbol', async () => {
    // `const f = () => {}` mints the symbol on the VariableStatement, not the ArrowFunction.
    // enclosingCallableId must probe the VariableStatement, not halt at the unminted ArrowFunction.
    const src = ['export const f = () => {', '  return fetch("/x");', '};', ''].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /x [fetch]']);
    expect(callsEdges(r)).toEqual(['f -> GET /x']);
  });

  it('links to the direct const-arrow when nested inside an outer function', async () => {
    const src = [
      'export function outer() {',
      '  const f = () => fetch("/x");',
      '  return f();',
      '}',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /x [fetch]']);
    expect(callsEdges(r)).toEqual(['f -> GET /x']);
  });
});

describe('http-call — local shadow suppression (honest over noise)', () => {
  it('does NOT emit when a local `function fetch` shadows the global', async () => {
    // A file-defined pure `fetch` is not the HTTP client. Emitting here would mint a phantom
    // cross-repo link — the worst class under the honest-over-noise invariant.
    const src = [
      'function fetch(url: string): string { return "mock"; }',
      'export const r = fetch("/z");',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual([]);
  });

  it('does NOT emit when a local const-arrow shadows fetch', async () => {
    const src = [
      'const fetch = (url: string): string => "mock";',
      'export const r = fetch("/z");',
      '',
    ].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual([]);
  });

  it('still emits a real global fetch in a file that does NOT shadow it', async () => {
    // Negative control: the shadow check must not suppress the legitimate global case.
    const src = ['export async function go() { await fetch("/real"); }', ''].join('\n');
    const r = await run(src);
    expect(httpCalls(r)).toEqual(['GET /real [fetch]']);
  });
});
