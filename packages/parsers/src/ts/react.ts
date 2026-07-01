/**
 * React framework-semantics extraction (schema 1.3) — the third framework track (Java → Node →
 * React → Angular), the direct counterpart of {@link extractNestSemantics} for the Node track and
 * {@link extractSpringSemantics} for Java. On top of the syntactic symbol/CFG graph the TS compiler
 * API already built it derives the artifacts that let a team understand a React component tree
 * WITHOUT reading it:
 *
 *   1. COMPONENTS — every function/arrow that RETURNS JSX (PascalCase name) + every class extending
 *      `Component`/`PureComponent` is tagged `framework:'react'` + `stereotype:'component'`. This
 *      lets a consumer filter the graph by architectural role — "show me the UI" — and is the entry
 *      point for the renders graph.
 *   2. HOOKS — every `useX`-named function (custom hook, by the React naming convention) that CALLS a
 *      hook is tagged `stereotype:'hook'`. The rule-of-hooks signal (body contains a `useX` call) is
 *      the honest gate — a `useFoo` that calls no hooks is mis-named, not a hook.
 *   3. RENDERS — the component composition tree, the React analog of NestJS routes / Spring @Bean
 *      graph / JPA relations. `<Foo/>` / `<Foo.Bar/>` JSX tags AND `React.createElement(Foo,…)` /
 *      `createElement(Foo,…)` calls become `renders` edges (component → child component). Intra-file
 *      child components resolve here; cross-file child names are recorded on `meta.renders` (honest
 *      unresolved — parity with `meta.injects`/`meta.produces`). The dossier surfaces these in the
 *      Renders section (framework.ts CLASS-scope `collectRenders` — a `component`-stereotype symbol
 *      is CLASS scope, so its own outgoing `renders` edges aggregate into the section).
 *   4. HOOKS USAGE — every `useState`/`useEffect`/`useRef`/`useMemo`/…/custom-`useX` call in a
 *      component's render body is recorded on `meta.hooks` (sorted unique names) — the component's
 *      state/side-effect contract.
 *   5. PROPS / STATE TYPES — a function component's first-param type (`(props: FooProps) => …`) and a
 *      class component's `Component<FooProps, FooState>` type args are recorded on `meta.propsType` /
 *      `meta.stateType` — the component's data contract, surfaced via `publicNode`.
 *
 * Pure + additive: mutates component/hook symbol nodes (stereotype/framework + meta) and appends
 * `renders` edges. A non-React file is a no-op. Shares the 1.3 `renders` rel + `component`/`hook`
 * stereotypes with the other tracks — no schema change. (The base extractor symbolizes function
 * declarations and arrow/function-const initializers; `forwardRef(...)`/`memo(...)` const-wrapped
 * components have a CallExpression initializer and so get NO base symbol — an honest limitation, not
 * patched here: creating symbols is the base extractor's job, not the framework pass's.)
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import ts from 'typescript';
import type { ExtractCtx } from '../types.js';

/** Class-component base simple names (`Component`, `PureComponent`; also matches `React.Component`
 *  via the property-access branch in {@link extendsReactBase}). */
const REACT_BASES = new Set(['Component', 'PureComponent']);

/** Structural symbol shape — avoids exporting the extractor's private {@link LocalSymbol}. The
 *  `body` is the extractor's `functionBodyOf` result (a function/arrow body to walk for JSX/hooks). */
interface ReactSymbolLike {
  node: Node;
  keys: readonly string[];
  tsNode: ts.Node;
  body?: ts.Node;
}

export interface ReactPassInput {
  symbols: readonly ReactSymbolLike[];
  byKey: Map<string, string>;
  nodes: Node[];
  edges: Edge[];
  ctx: ExtractCtx;
  path: string;
  lineOf: (pos: number) => number;
}

export function extractReactSemantics(input: ReactPassInput): void {
  const { symbols, byKey, nodes, edges } = input;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const s of symbols) {
    const cls = classify(s);
    if (!cls) continue;
    const symNode = nodeById.get(s.node.id);
    if (!symNode) continue;

    if (cls.kind === 'hook') {
      symNode.framework = 'react';
      symNode.stereotype = 'hook';
      const hooks = collectHooks(cls.body);
      if (hooks.length) symNode.meta = { ...(symNode.meta ?? {}), hooks: dedupe(hooks) };
      continue;
    }

    // component
    symNode.framework = 'react';
    symNode.stereotype = 'component';
    const rendered: string[] = [];
    const hooks: string[] = [];
    collectRendersAndHooks(cls.body, byKey, s.node.id, edges, rendered, hooks);
    const meta: Record<string, unknown> = { ...(symNode.meta ?? {}) };
    if (rendered.length) meta.renders = dedupe(rendered);
    if (hooks.length) meta.hooks = dedupe(hooks);
    if (cls.propsType) meta.propsType = cls.propsType;
    if (cls.stateType) meta.stateType = cls.stateType;
    if (Object.keys(meta).length) symNode.meta = meta;
  }
}

/** Classify a symbol as a React class component / function component / hook, with the body to walk
 *  and the props/state type names. Returns null for a non-React symbol. */
function classify(s: ReactSymbolLike): {
  kind: 'class' | 'function' | 'hook';
  body?: ts.Node;
  propsType?: string;
  stateType?: string;
} | null {
  const name = s.node.name ?? '';
  const { tsNode, body } = s;

  // hook: useX name + body calls a hook (the rule-of-hooks signal — not just naming convention).
  if (isHookName(name) && bodyContainsHookCall(body)) {
    return { kind: 'hook', body };
  }
  // class component: extends Component / PureComponent (incl. React.Component).
  if (ts.isClassDeclaration(tsNode) && extendsReactBase(tsNode)) {
    const { propsType, stateType } = classTypeArgs(tsNode);
    return { kind: 'class', body: renderMethodBody(tsNode), propsType, stateType };
  }
  // function component: PascalCase name + body returns JSX (the common case) OR a
  // `createElement(…)`/`React.createElement(…)` call (raw form — JSX is sugar for it).
  if (isComponentName(name) && (containsJsx(body) || containsCreateElementCall(body))) {
    return { kind: 'function', body, propsType: firstParamType(tsNode) };
  }
  return null;
}

/** Collect `renders` edges (component → child) + hook-call names from a render body. Intra-file
 *  child components resolve via byKey; cross-file child names accumulate on `recorded` (→ meta.renders).
 *  Descends fully EXCEPT into a nested named PascalCase function declaration (a nested component
 *  definition whose own renders belong to IT, not this parent — cuts double-attribution). */
function collectRendersAndHooks(
  body: ts.Node | undefined,
  byKey: Map<string, string>,
  srcId: string,
  edges: Edge[],
  recorded: string[],
  hooks: string[],
): void {
  if (!body) return;
  const visit = (node: ts.Node): void => {
    // JSX element → a child component render (uppercase tag) or a DOM tag (lowercase → skip).
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const tag = ts.isJsxSelfClosingElement(node) ? node.tagName : node.openingElement.tagName;
      const child = jsxComponentName(tag);
      if (child) emitRender(srcId, child, byKey, edges, recorded);
    }
    // React.createElement(Foo, …) / createElement(Foo, …) → a child render.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeText = identifierText(callee);
      if (calleeText === 'createElement' || calleeText === 'React.createElement') {
        const first = node.arguments[0];
        if (first && ts.isIdentifier(first) && isComponentName(first.text)) {
          emitRender(srcId, first.text, byKey, edges, recorded);
        }
      }
      const hook = hookCallName(node);
      if (hook) hooks.push(hook);
    }
    ts.forEachChild(node, (c) => {
      // skip a nested named PascalCase function declaration (a nested component — its renders are its own).
      if (ts.isFunctionDeclaration(c) && c.name && isComponentName(c.name.text)) return;
      visit(c);
    });
  };
  visit(body);
}

/** Collect every hook-call name in a body (for hook-tagging + meta.hooks on components). */
function collectHooks(body: ts.Node | undefined): string[] {
  if (!body) return [];
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const h = hookCallName(node);
      if (h) out.push(h);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/** Emit a `renders` edge (component → child) when the child resolves intra-file; always record the
 *  child name (for meta.renders — the cross-file resolver / unresolved surfacing). Self-render skipped. */
function emitRender(
  srcId: string,
  childName: string,
  byKey: Map<string, string>,
  edges: Edge[],
  recorded: string[],
): void {
  recorded.push(childName);
  const dstId = byKey.get(childName);
  if (dstId && dstId !== srcId) {
    edges.push({
      id: edgeId(srcId, dstId, 'renders'),
      src: srcId,
      dst: dstId,
      rel: 'renders',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'lang:typescript/react', snippet: childName },
    });
  }
}

// ---------------------------------------------------------------------------
// classifiers + helpers
// ---------------------------------------------------------------------------

/** PascalCase: first char is an uppercase letter (a React component's required convention). */
function isComponentName(name: string): boolean {
  return name.length > 0 && /^[A-Z]/.test(name);
}

/** `useX` hook name: `use` + an uppercase next char, or exactly `use` (the React 19 hook). */
function isHookName(name: string): boolean {
  return name === 'use' || /^use[A-Z]/.test(name);
}

/** The simple text of an expression if it's an Identifier (`useState`) or PropertyAccess
 *  (`React.useState` → "React.useState"; used for createElement + hook detection). */
function identifierText(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const obj = identifierText(e.expression);
    return obj ? `${obj}.${e.name.text}` : e.name.text;
  }
  return undefined;
}

/** The child component name from a JSX tag, or undefined for a DOM tag (lowercase) / namespaced tag.
 *  `<Foo/>` → "Foo"; `<div/>` → undefined; `<Foo.Bar/>` → undefined (namespaced tags like
 *  `React.Fragment` aren't component-graph targets). */
function jsxComponentName(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag) && isComponentName(tag.text)) return tag.text;
  return undefined;
}

/** The hook name called by a CallExpression (`useState(…)`/`React.useState(…)`), or undefined. */
function hookCallName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) name = callee.text;
  else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    name = callee.name.text;
  }
  return name && isHookName(name) ? name : undefined;
}

/** Does a body contain any JSX (the function-component signal — arrow expression body or a JSX
 *  *somewhere* in a block body, e.g. `const x = <div/>; return x;`)? */
function containsJsx(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
    return true;
  let found = false;
  ts.forEachChild(node, (c) => {
    if (!found) found = containsJsx(c);
  });
  return found;
}

/** Does a body contain a `createElement(…)` / `React.createElement(…)` call (the raw form of JSX —
 *  a function returning it is a component, and a child component arg is a render)? */
function containsCreateElementCall(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isCallExpression(node)) {
    const t = identifierText(node.expression);
    if (t === 'createElement' || t === 'React.createElement') return true;
  }
  let found = false;
  ts.forEachChild(node, (c) => {
    if (!found) found = containsCreateElementCall(c);
  });
  return found;
}

/** Does a body contain any hook call (the rule-of-hooks signal for hook-tagging a `useX` function)? */
function bodyContainsHookCall(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    let name: string | undefined;
    if (ts.isIdentifier(callee)) name = callee.text;
    else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name))
      name = callee.name.text;
    if (name && isHookName(name)) return true;
  }
  let found = false;
  ts.forEachChild(node, (c) => {
    if (!found) found = bodyContainsHookCall(c);
  });
  return found;
}

/** Does a class extend `Component` / `PureComponent` (incl. `React.Component`)? */
function extendsReactBase(cls: ts.ClassDeclaration): boolean {
  for (const h of cls.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const t of h.types) {
      const e = t.expression;
      if (ts.isIdentifier(e) && REACT_BASES.has(e.text)) return true;
      if (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.name) &&
        REACT_BASES.has(e.name.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** The props/state type-arg names of `class Foo extends Component<Props, State>` (text of each). */
function classTypeArgs(cls: ts.ClassDeclaration): { propsType?: string; stateType?: string } {
  for (const h of cls.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const t of h.types) {
      if (ts.isExpressionWithTypeArguments(t) && t.typeArguments) {
        const args = [...t.typeArguments];
        const props = args[0]?.getText();
        const state = args[1]?.getText();
        return {
          ...(props ? { propsType: props } : {}),
          ...(state ? { stateType: state } : {}),
        };
      }
    }
  }
  return {};
}

/** The body of a class component's `render()` method (where its JSX lives), or undefined. */
function renderMethodBody(cls: ts.ClassDeclaration): ts.Node | undefined {
  for (const m of cls.members) {
    if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'render') {
      return m.body;
    }
  }
  return undefined;
}

/** The first parameter's type-annotation text of a function component (`(props: FooProps) => …`),
 *  or undefined. Works for FunctionDeclaration and arrow-function const (via the VariableStatement
 *  initializer). */
function firstParamType(tsNode: ts.Node): string | undefined {
  let params: ts.NodeArray<ts.ParameterDeclaration> | undefined;
  if (ts.isFunctionDeclaration(tsNode)) params = tsNode.parameters;
  else if (ts.isVariableStatement(tsNode)) {
    const d = tsNode.declarationList.declarations[0];
    if (d?.initializer && ts.isArrowFunction(d.initializer)) params = d.initializer.parameters;
    else if (d?.initializer && ts.isFunctionExpression(d.initializer))
      params = d.initializer.parameters;
  }
  const first = params?.[0];
  return first?.type?.getText();
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}
