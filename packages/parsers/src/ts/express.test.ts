/**
 * Express framework-semantics (schema 1.3) — dedicated coverage of {@link extractExpressRoutes}
 * driven through the {@link TypeScriptExtractor} end-to-end (Pass 4). Express routes are imperative
 * `app.<verb>(path, handler)` calls (no decorators); this suite covers route emission, multi-path,
 * the inline-vs-identifier handler distinction (inline → no exposes; named → exposes), and the
 * no-op gates that cut middleware mounts and unresolvable handlers. Inline source, deterministic.
 */
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { TypeScriptExtractor } from './TypeScriptExtractor.js';

const PATH = 'express.ts';

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

/** label a node id by qualified name, else name, else kind. */
function label(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    return n?.qualifiedName ?? n?.name ?? n?.kind ?? id;
  };
}

/** all route surfaces as `METHOD /path`, sorted. */
const routes = (r: ExtractResult): string[] =>
  r.nodes
    .filter((n) => n.kind === 'route')
    .map((n) => `${n.httpMethod} ${n.routePath}`)
    .sort();

/** all route nodes carry framework:'express'. */
const allExpress = (r: ExtractResult): boolean =>
  r.nodes.filter((n) => n.kind === 'route').every((n) => n.framework === 'express');

/** all `exposes` edges: handler → `METHOD /path`. */
const exposes = (r: ExtractResult): string[] => {
  const lbl = label(r);
  const routeById = new Map(r.nodes.filter((n) => n.kind === 'route').map((n) => [n.id, n]));
  return r.edges
    .filter((e) => e.rel === 'exposes')
    .map((e) => `${lbl(e.src)} -> ${routeById.get(e.dst)?.name ?? e.dst}`)
    .sort();
};

describe('Express routes', () => {
  it('emits a route for app.<verb> with an inline handler and tags framework:express', async () => {
    const src = [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (req, res) => { res.send('ok'); });",
      "app.post('/items', (req, res) => { res.end(); });",
    ].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual(['GET /health', 'POST /items']);
    expect(allExpress(r)).toBe(true);
    // inline arrow handlers have no symbol → no exposes edge.
    expect(exposes(r)).toEqual([]);
  });

  it('emits exposes for a named (identifier) handler resolving intra-file', async () => {
    const src = [
      'function listHandler(req: any, res: any) { res.end(); }',
      'const app = {} as any;',
      "app.get('/list', listHandler);",
    ].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual(['GET /list']);
    expect(exposes(r)).toEqual(['listHandler -> GET /list']);
  });

  it('emits one route per path in a multi-path array arg', async () => {
    const src = [
      'function h(req: any, res: any) {}',
      'const router = {} as any;',
      "router.get(['/a', '/b'], h);",
    ].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual(['GET /a', 'GET /b']);
    // both exposes edges target the same handler, distinct routes.
    expect(exposes(r)).toEqual(['h -> GET /a', 'h -> GET /b']);
  });

  it('supports every verb', async () => {
    const src = [
      'const app = {} as any;',
      'function h(req: any, res: any) {}',
      "app.get('/g', h);",
      "app.post('/p', h);",
      "app.put('/u', h);",
      "app.delete('/d', h);",
      "app.patch('/pa', h);",
      "app.head('/he', h);",
      "app.options('/o', h);",
      "app.all('/a', h);",
    ].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual([
      'ANY /a',
      'DELETE /d',
      'GET /g',
      'HEAD /he',
      'OPTIONS /o',
      'PATCH /pa',
      'POST /p',
      'PUT /u',
    ]);
  });
});

describe('Express no-op gates', () => {
  it('does not emit a route for app.use (a middleware mount, not a route)', async () => {
    const src = [
      'const app = {} as any;',
      'const router = {} as any;',
      "app.use('/api', router);",
    ].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual([]);
  });

  it('does not emit a route when the last arg is an unresolvable identifier (cuts noise)', async () => {
    const src = ['const app = {} as any;', "app.get('/x', someImportedMiddleware);"].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual([]);
  });

  it('does not emit a route when the receiver is not a plain identifier', async () => {
    const src = [
      "import express from 'express';",
      'const app = express();',
      // express().get(...) — receiver is a CallExpression, not an Identifier.
      "express().get('/nope', (req: any, res: any) => {});",
    ].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual([]);
  });

  it('does not emit a route when there is no path arg (single handler arg)', async () => {
    const src = ['const app = {} as any;', 'app.get((req: any, res: any) => {});'].join('\n');
    const r = await run(src);
    expect(routes(r)).toEqual([]);
  });
});
