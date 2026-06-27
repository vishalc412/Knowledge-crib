/**
 * Express framework-semantics extraction (schema 1.3) — the imperative-route counterpart of
 * {@link extractNestSemantics}. Express has no decorators: routes are registered imperatively as
 * `app.<verb>('/path', handler)` / `router.<verb>(...)` calls. Where NestJS derives the route from a
 * method decorator (the handler IS a named class method, linked by `exposes`), an Express handler is
 * usually an INLINE arrow/function expression — there is no separate symbol to link. So:
 *
 *   - Every `app.<verb>(path, ...handlers)` call emits a `route` node (`GET /api/users`), tagged
 *     `framework:'express'`, with the call's line. One route per path (a multi-path array arg
 *     `['/a','/b']` emits one route per path — parity with NestJS `@Get('/a','/b')`).
 *   - When the LAST handler argument is an IDENTIFIER that resolves intra-file to a known callable
 *     symbol (a function declared in this file), an `exposes` edge links handler → route — the
 *     Express analog of NestJS's method→route edge, and the only honest way to connect a named
 *     handler to its route. Inline arrow/function handlers have no symbol, so no `exposes` edge is
 *     emitted (the route node alone is the truth — the handler lives in the call, not the graph).
 *
 * The receiver must be an `Identifier` (the conventional `app`/`router`/`api`). This deliberately
 * rejects `express()(...)` application-call chains and `.use('/x', router)` mount calls (the latter
 * is a middleware mount, not a route — `router` is not a handler body). The last arg must be a
 * function expression OR an identifier resolving to a callable: this is the cut that drops
 * `app.get('/x', middlewareFn)` false positives where `middlewareFn` is a side-effect import.
 *
 * Pure + additive: appends route nodes + exposes edges only. Shares the 1.3 `route` kind + `exposes`
 * rel with Spring/NestJS — no schema change.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import ts from 'typescript';
import type { ExtractCtx } from '../types.js';

/** Express route-registration verbs → HTTP verb. `all` maps to ANY (matches every verb). */
const EXPRESS_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
  all: 'ANY',
  head: 'HEAD',
  options: 'OPTIONS',
};

/** Structural symbol shape — avoids exporting the extractor's private {@link LocalSymbol}. */
interface SymbolLike {
  node: Node;
  keys: readonly string[];
}

export interface ExpressPassInput {
  sf: ts.SourceFile;
  byKey: Map<string, string>;
  symbols: readonly SymbolLike[];
  nodes: Node[];
  edges: Edge[];
  ctx: ExtractCtx;
  path: string;
  lineOf: (pos: number) => number;
}

export function extractExpressRoutes(input: ExpressPassInput): void {
  const { sf, byKey, nodes, edges, ctx, path, lineOf } = input;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const match = matchRouteCall(node, byKey, lineOf);
      if (match) {
        const { verb, paths, handlerId, callLine, callEnd } = match;
        for (const p of paths) {
          const routeId = ctx.idFor('route', {
            httpMethod: verb,
            routePath: p,
            file: path,
            line: callLine,
          });
          // De-dupe by id: an identical `app.get('/x', h)` emitted twice on the same line keeps one
          // node. The route id is content-addressed on (verb, path, file, line), so a second call on
          // a different line gets its own route — correct, two registrations are two routes.
          if (!nodes.some((n) => n.id === routeId)) {
            nodes.push({
              id: routeId,
              kind: 'route',
              name: `${verb} ${p}`,
              httpMethod: verb,
              routePath: p,
              framework: 'express',
              file: path,
              span: { start: callLine, end: callEnd },
              lang: 'typescript',
              hash: ctx.hash(`${path}:route:${verb}:${p}:${callLine}`),
            });
          }
          if (handlerId) {
            edges.push(edge(handlerId, routeId, 'exposes', `${verb} ${p}`));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Match an `app.<verb>(pathArg, ...handlerArg)` call. Returns the verb, resolved paths, an optional
 *  intra-file handler id, and the call's line span — or undefined if the call is not a route. */
function matchRouteCall(
  call: ts.CallExpression,
  byKey: Map<string, string>,
  lineOf: (pos: number) => number,
):
  | {
      verb: string;
      paths: string[];
      handlerId: string | undefined;
      callLine: number;
      callEnd: number;
    }
  | undefined {
  const callee = call.expression;
  // Must be `<Identifier>.<verb>` — the receiver is the Express app/router/api instance.
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (!ts.isIdentifier(callee.name)) return undefined;
  const verb = EXPRESS_VERBS[callee.name.text];
  if (!verb) return undefined;
  if (!ts.isIdentifier(callee.expression)) return undefined; // receiver must be a plain Identifier

  const args = call.arguments;
  if (args.length < 2) return undefined; // need at least a path + a handler

  const paths = stringPaths(args[0]!);
  if (paths.length === 0) return undefined; // first arg must be a path string/array-of-strings

  const handlerArg = args[args.length - 1]!;
  // The handler must be an inline function OR an identifier resolving to a known callable.
  let handlerId: string | undefined;
  if (isHandlerLike(handlerArg)) {
    handlerId = undefined; // inline function: no symbol to link.
  } else if (ts.isIdentifier(handlerArg)) {
    const id = byKey.get(handlerArg.text);
    if (!id) return undefined; // identifier that resolves to nothing known → not a route (cuts noise).
    handlerId = id;
  } else {
    return undefined; // non-callable last arg (e.g. another route config object) → not a route.
  }

  return {
    verb,
    paths,
    handlerId,
    callLine: lineOf(call.getStart()),
    callEnd: lineOf(call.getEnd()),
  };
}

/** The path strings of a route's first argument: a string literal, or an array of string literals.
 *  `'/api/users'` → ['/api/users']; `['/a','/b']` → ['/a','/b']; anything else → []. */
function stringPaths(arg: ts.Expression): string[] {
  if (ts.isStringLiteral(arg)) return [arg.text];
  if (ts.isArrayLiteralExpression(arg)) {
    const out: string[] = [];
    for (const el of arg.elements) {
      if (ts.isStringLiteral(el)) out.push(el.text);
    }
    return out;
  }
  return [];
}

/** Whether an expression is an inline handler body: an arrow function or function expression. */
function isHandlerLike(e: ts.Expression): boolean {
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e);
}

/** Edge factory. `by` = the lang extractor id; provenance EXTRACTED, confidence 1 (static graph). */
function edge(src: string, dst: string, rel: Edge['rel'], snippet: string): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by: 'lang:typescript/express', snippet },
  };
}
