/**
 * Outbound HTTP client-call extraction (schema 1.5) — the repo-A side of cross-repo federation.
 *
 * A `route` node (Spring `@GetMapping` / Express `app.get` / Nest `@Get`) is the INBOUND endpoint —
 * "this repo serves `GET /api/loans`". This pass emits the OUTBOUND counterpart: an `http-call`
 * node for a call site that hits an HTTP endpoint — `fetch('/api/x')`, `axios.get('/api/x')`,
 * `axios('/api/x')`. It carries the SAME `{httpMethod, routePath, framework}` fields a `route`
 * node carries, so a runtime federation layer can match a repo-A call to a repo-B route by
 * method+path WITHOUT committing a cross-repo edge (each soul stays independent, deterministic,
 * committed-clean — the bridge is a runtime computation, not persisted state).
 *
 * Detection (deliberately narrow — false positives here become phantom cross-repo links):
 *   - `fetch(path)` / `fetch(path, init)` — global `fetch`. Method GET by default; `init.method`
 *     string literal overrides (`fetch(u, { method: 'POST' })`). `framework: 'fetch'`.
 *   - `axios.<verb>(path, ...)` / `axios(path)` — verb from the property name
 *     (get/post/put/delete/patch/head/options); `axios(path)` defaults GET. `framework: 'axios'`.
 *     The receiver must be an `Identifier` (`axios`) or `PropertyAccessExpression` resolving to one
 *     (`http.axios` — rare) so `res.get('/x')` (a DB result-set accessor) is NOT mistaken for HTTP.
 *
 * Path capture (deterministic — the shape that lets a templated call match a templated route):
 *   - String literal  → as written: `'/api/loans'`.
 *   - Template literal → `${expr}` spans become `:exprName` placeholders, so
 *     `` `/api/loans/${id}` `` → `/api/loans/:id` — the EXACT shape an Express `app.get('/api/loans/:id')`
 *     route emits. A concrete call (`` `/api/loans/${id}` ``) thus matches a templated route, and a
 *     templated call matches a templated route by string equality (the federation fast path).
 *   - Anything else (a bare identifier, a non-literal concat, a function call) → the path is
 *     unknown, so NO node is emitted. We do not fabricate a path we cannot read off the source.
 *
 * Enclosing link: a `calls` edge (enclosing callable symbol → http-call node) is emitted when the
 * call site sits inside a known function/method/arrow declared in this file — so a `down` impact
 * from the enclosing function reaches the call site, and the federation hop then crosses to the
 * serving route in repo B. A top-level call with no enclosing callable emits the node only.
 *
 * Pure + additive: appends `http-call` nodes + `calls` edges only. Shares the 1.5 `http-call` kind
 * + the existing `calls` rel — no other schema change. EXTRACTED, confidence 1, method `static`
 * (a file-derived fact, same as `route`/`exposes`).
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import ts from 'typescript';
import type { ExtractCtx } from '../types.js';

/** axios verb properties → HTTP verb. `fetch` + bare `axios()` default to GET. */
const AXIOS_VERBS: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  delete: 'DELETE',
  patch: 'PATCH',
  head: 'HEAD',
  options: 'OPTIONS',
  request: 'GET', // axios.request({method}) — method is in the config, not the verb; default GET.
};

/** Enclosing-callable lookup: TS declaration node → the symbol id we minted in pass 1. */
export interface HttpClientPassInput {
  sf: ts.SourceFile;
  /** declaration-node → symbol id, for enclosing-callable resolution. Built by the TS extractor. */
  symbolByNode: ReadonlyMap<ts.Node, string>;
  nodes: Node[];
  edges: Edge[];
  ctx: ExtractCtx;
  path: string;
  lineOf: (pos: number) => number;
  /** M2.5 — `lang` tag for emitted nodes ('typescript' | 'javascript'). */
  lang: 'typescript' | 'javascript';
}

export function extractHttpClients(input: HttpClientPassInput): void {
  const { sf, symbolByNode, nodes, edges, ctx, path, lineOf, lang } = input;
  // A bare `fetch(`/`axios(` callee is only the global HTTP client if no LOCAL definition shadows it
  // in this file. Without this, `function fetch(url) { return 'mock' }` + `fetch('/z')` emits a
  // phantom http-call (a false positive — the worst class under the honest-over-noise invariant,
  // since it would mint a phantom cross-repo link). File-scoped + deterministic: a shadow ANYWHERE
  // in the file suppresses global detection (a false negative we accept over a phantom link).
  // Imports are deliberately NOT collected — `import fetch from 'node-fetch'` is plausibly an HTTP
  // client, so we keep emitting there.
  const shadowed = collectShadowedCallNames(sf);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const match = matchHttpCall(node, lineOf, shadowed);
      if (match) {
        const { method, routePath, framework, callLine, callEnd } = match;
        const callId = ctx.idFor('http-call', {
          httpMethod: method,
          routePath,
          file: path,
          line: callLine,
        });
        // De-dupe by id: an identical `fetch('/x')` emitted twice on the same line keeps one node.
        if (!nodes.some((n) => n.id === callId)) {
          nodes.push({
            id: callId,
            kind: 'http-call',
            name: `${method} ${routePath}`,
            httpMethod: method,
            routePath,
            framework,
            file: path,
            span: { start: callLine, end: callEnd },
            lang,
            hash: ctx.hash(`${path}:http-call:${method}:${routePath}:${callLine}`),
          });
        }
        const callerId = enclosingCallableId(node, symbolByNode);
        if (callerId) {
          edges.push(edge(callerId, callId, 'calls', `${method} ${routePath}`));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Match an outbound HTTP client call. Returns method+path+framework+line span, or undefined. */
function matchHttpCall(
  call: ts.CallExpression,
  lineOf: (pos: number) => number,
  shadowed: ReadonlySet<string>,
):
  | {
      method: string;
      routePath: string;
      framework: string;
      callLine: number;
      callEnd: number;
    }
  | undefined {
  // --- `fetch(path, init?)` — the global; callee is a bare Identifier `fetch`. ---
  const fetchHit = matchFetch(call, shadowed);
  if (fetchHit) {
    return { ...fetchHit, callLine: lineOf(call.getStart()), callEnd: lineOf(call.getEnd()) };
  }
  // --- `axios.<verb>(path, ...)` / `axios(path)` — receiver is `axios`. ---
  const axiosHit = matchAxios(call, shadowed);
  if (axiosHit) {
    return { ...axiosHit, callLine: lineOf(call.getStart()), callEnd: lineOf(call.getEnd()) };
  }
  return undefined;
}

/** `fetch(path, init?)` → { method, routePath, framework:'fetch' }. method from init.method literal. */
function matchFetch(
  call: ts.CallExpression,
  shadowed: ReadonlySet<string>,
): { method: string; routePath: string; framework: string } | undefined {
  const callee = call.expression;
  if (!ts.isIdentifier(callee) || callee.text !== 'fetch') return undefined;
  if (shadowed.has('fetch')) return undefined; // a local `function fetch` shadows the global.
  if (call.arguments.length < 1) return undefined;
  const routePath = pathOf(call.arguments[0]!);
  if (routePath === undefined) return undefined; // unreadable path → no fabricated node.
  let method = 'GET'; // fetch defaults to GET.
  if (call.arguments.length >= 2) {
    const init = call.arguments[1]!;
    const m = initMethodLiteral(init);
    if (m) method = m;
  }
  return { method, routePath, framework: 'fetch' };
}

/** `axios.<verb>(path, ...)` / `axios(path)` → { method, routePath, framework:'axios' }. */
function matchAxios(
  call: ts.CallExpression,
  shadowed: ReadonlySet<string>,
): { method: string; routePath: string; framework: string } | undefined {
  const callee = call.expression;
  // `axios('/x')` — bare call.
  if (ts.isIdentifier(callee) && callee.text === 'axios') {
    if (shadowed.has('axios')) return undefined; // a local `const axios = …` shadows the import.
    if (call.arguments.length < 1) return undefined;
    const routePath = pathOf(call.arguments[0]!);
    if (routePath === undefined) return undefined;
    return { method: 'GET', routePath, framework: 'axios' };
  }
  // `axios.<verb>(path, ...)` — receiver must resolve to an `axios` Identifier (so `res.get` is
  // not mistaken for HTTP). Allow `axios.create(...).get(...)`? That is a chained receiver — the
  // head is a CallExpression, not an Identifier; we skip it rather than guess. Honest over noise.
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    const verb = AXIOS_VERBS[callee.name.text];
    if (!verb) return undefined;
    if (!isAxiosReceiver(callee.expression)) return undefined;
    if (shadowed.has('axios')) return undefined; // local shadow — the receiver isn't the npm axios.
    if (call.arguments.length < 1) return undefined;
    // `axios.request({url, method})` — the url rides in a config object at `.url`, not arg0, so
    // pathOf(arg0) is undefined (an object, not a path string) and we cannot read the url
    // deterministically → no node. Reject explicitly so the `request` verb never emits a phantom.
    if (callee.name.text === 'request') return undefined;
    const routePath = pathOf(call.arguments[0]!);
    if (routePath === undefined) return undefined;
    return { method: verb, routePath, framework: 'axios' };
  }
  return undefined;
}

/** Whether `expr` is an `axios` Identifier (the only receiver we accept for `axios.<verb>`). */
function isAxiosReceiver(expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) && expr.text === 'axios';
}

/**
 * The deterministic path of a call's first argument, or undefined when it is not readable off the
 * source. String literal → as written; template literal → `${expr}` spans become `:exprName`
 * placeholders (so `` `/api/loans/${id}` `` → `/api/loans/:id`); everything else → undefined.
 */
function pathOf(arg: ts.Expression): string | undefined {
  if (ts.isStringLiteral(arg)) return arg.text;
  // A template literal WITHOUT substitutions (`` `/api/loans` ``) is a NoSubstitutionTemplateLiteral
  // — its cooked text lives at `.text`. WITH substitutions (`` `/api/loans/${id}` ``) it is a
  // TemplateExpression — `.head.text` + per-span `.literal.text` with `.expression` between.
  if (ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    let out = arg.head.text;
    for (const span of arg.templateSpans) {
      const name = exprPlaceholderName(span.expression);
      out += `:${name}`;
      out += span.literal.text;
    }
    return out;
  }
  return undefined;
}

/** A stable placeholder name for a template-span expression: the identifier text, else `_`. */
function exprPlaceholderName(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  return '_';
}

/** Read `init.method` / `config.method` off an object-literal second arg, when it is a string
 *  literal. Returns undefined for `{method: var}` / computed keys — never guesses. */
function initMethodLiteral(init: ts.Expression): string | undefined {
  if (!ts.isObjectLiteralExpression(init)) return undefined;
  for (const prop of init.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name) || prop.name.text !== 'method') continue;
    if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text.toUpperCase();
  }
  return undefined;
}

/** Walk parents to the nearest enclosing callable declaration WITH a minted symbol, return its id.
 *  Never halts on an unminted callable — keeps walking up — so a call wrapped in an anonymous
 *  `.forEach`/`.map`/`.then` callback arrow still links to the outer minted function (the dominant
 *  real-world client pattern), instead of getting no `calls` edge and silently breaking the
 *  federation `down` hop. Also probes the VariableStatement for `const f = () => {}` (the symbol is
 *  minted on the VariableStatement, not the ArrowFunction). */
function enclosingCallableId(
  call: ts.CallExpression,
  symbolByNode: ReadonlyMap<ts.Node, string>,
): string | undefined {
  let cur: ts.Node | undefined = call.parent;
  while (cur) {
    if (isCallableDeclaration(cur)) {
      const direct = symbolByNode.get(cur);
      if (direct) return direct;
      const viaVar = callableSymbolViaVariableStatement(cur, symbolByNode);
      if (viaVar) return viaVar;
      // No symbol at this callable (e.g. an anonymous callback arrow). Keep walking up to the next
      // enclosing callable rather than halting — see the doc comment above.
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Is `node` a callable declaration (the kinds that can enclose a call site)? */
function isCallableDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** For `const f = () => {}` / `const f = function(){}`, the symbol is minted on the VariableStatement
 *  (declarationOf in TypeScriptExtractor keys symbolByNode by the VariableStatement it visits), not
 *  the callable itself. The parent chain is ArrowFunction → VariableDeclaration →
 *  VariableDeclarationList → VariableStatement — TWO levels up from the VariableDeclaration, not one
 *  (VariableDeclaration.parent is the list, not the statement). Returns undefined for callables not
 *  assigned to a variable. */
function callableSymbolViaVariableStatement(
  callable: ts.Node,
  symbolByNode: ReadonlyMap<ts.Node, string>,
): string | undefined {
  if (!ts.isArrowFunction(callable) && !ts.isFunctionExpression(callable)) return undefined;
  const decl = callable.parent;
  if (!decl || !ts.isVariableDeclaration(decl)) return undefined;
  const declList = decl.parent;
  if (!declList || !ts.isVariableDeclarationList(declList)) return undefined;
  const stmt = declList.parent;
  if (!stmt || !ts.isVariableStatement(stmt)) return undefined;
  return symbolByNode.get(stmt);
}

/** Names of locally-DEFINED `fetch`/`axios` bindings in this file (a `function fetch(){}` or
 *  `const fetch = () => {}`), which shadow the global HTTP client and would otherwise mint phantom
 *  http-call nodes. Imports are NOT collected — an `import fetch from 'node-fetch'` is plausibly an
 *  HTTP client, so we keep emitting there. */
function collectShadowedCallNames(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && SHADOW_NAMES.has(node.name.text)) {
      out.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      SHADOW_NAMES.has(node.name.text) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      out.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const SHADOW_NAMES = new Set(['fetch', 'axios']);

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
    evidence: { by: 'lang:typescript/http-client', snippet },
  };
}
