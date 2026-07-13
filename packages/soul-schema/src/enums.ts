/**
 * Closed enumerations for the Knowledge-crib graph.
 * Frozen at schemaVersion; unknown values → validation error (invariant #4).
 */

export type NodeKind =
  | 'file'
  | 'symbol'
  | 'doc-section'
  | 'media-seg'
  | 'explanation'
  | 'cluster'
  | 'table'
  | 'column'
  | 'statement'
  | 'condition'
  // 1.2 (deep-extraction fidelity): behavior-bearing constructs that migration needs but
  // the 1.1 soul collapsed to a `plain`/`call` statement or dropped entirely.
  | 'exception-handler' // one per EXCEPTION WHEN <selector> THEN …
  | 'raise' // RAISE_APPLICATION_ERROR(code,msg) / RAISE <ex>
  | 'cursor' // CURSOR c IS <query>
  | 'assignment' // target := expr  (provenance of a variable)
  | 'case-branch' // one per CASE WHEN <val> THEN …
  // 1.3 (framework-semantics layer): the app-framework equivalents of SQL's data-model/data-flow —
  // what makes a Java/Node/React/Angular graph REPLACE reading the code.
  | 'route' // an HTTP endpoint: httpMethod + routePath (Spring @GetMapping, Express app.get, Nest @Get)
  | 'field' // a class/entity/component field (JPA @Column, React prop/state, Angular @Input)
  | 'component' // a UI component (React function/class component, Angular @Component)
  // 1.4 (ownership layer): a git author — the person `git blame` attributes source lines to. The node
  // a symbol's `owned-by` edge points at, so "who do I ask about this code" is a graph query.
  | 'owner';

export type Rel =
  | 'calls'
  | 'imports'
  | 'inherits'
  | 'implements'
  | 'describes'
  | 'references'
  | 'derived-from'
  | 'member-of'
  | 'executes'
  | 'reads'
  | 'writes'
  | 'guarded-by'
  // 1.2 (deep-extraction fidelity):
  | 'raises' // action → raise node (the error this action can raise)
  | 'handles' // exception-handler → the statement(s)/block it guards
  | 'iterates' // loop/cursor-for → cursor (the row source a loop walks)
  | 'declares' // unit → cursor/variable/package-state it declares
  // 1.3 (framework-semantics layer):
  | 'exposes' // handler symbol → route (the endpoint a controller method serves)
  | 'injects' // consumer symbol → injected dependency type (the DI graph)
  | 'renders' // component → child component (the UI render tree)
  | 'produces' // producer symbol → produced type (a @Bean/@Factory method → its return type)
  // 1.4 (ownership layer): symbol → the `owner` node (git author) `git blame` attributes the
  // symbol's source lines to. EXTRACTED (a deterministic, file-derived fact), confidence 1, so the
  // graph answers "who do I ask about X" without a model. The reverse ("what does Y own") is the
  // walk over incoming `owned-by` edges.
  | 'owned-by';

/** HOW an edge was derived — also drives ranking: static > explicit > identifier > path > semantic > inferred */
export type Method = 'static' | 'explicit' | 'identifier' | 'path' | 'semantic' | 'inferred';

export type Provenance = 'EXTRACTED' | 'INFERRED';

export const NODE_KINDS: readonly NodeKind[] = [
  'file',
  'symbol',
  'doc-section',
  'media-seg',
  'explanation',
  'cluster',
  'table',
  'column',
  'statement',
  'condition',
  'exception-handler',
  'raise',
  'cursor',
  'assignment',
  'case-branch',
  'route',
  'field',
  'component',
  'owner',
];

export const RELS: readonly Rel[] = [
  'calls',
  'imports',
  'inherits',
  'implements',
  'describes',
  'references',
  'derived-from',
  'member-of',
  'executes',
  'reads',
  'writes',
  'guarded-by',
  'raises',
  'handles',
  'iterates',
  'declares',
  'exposes',
  'injects',
  'renders',
  'produces',
  'owned-by',
];

export const METHODS: readonly Method[] = [
  'static',
  'explicit',
  'identifier',
  'path',
  'semantic',
  'inferred',
];

export const PROVENANCES: readonly Provenance[] = ['EXTRACTED', 'INFERRED'];

/** Ranking order for `method` (higher index = weaker derivation). Used by the linker + conflict rule. */
export const METHOD_RANK: Record<Method, number> = {
  static: 0,
  explicit: 1,
  identifier: 2,
  path: 3,
  semantic: 4,
  inferred: 5,
};

export function isNodeKind(v: unknown): v is NodeKind {
  return typeof v === 'string' && (NODE_KINDS as readonly string[]).includes(v);
}
export function isRel(v: unknown): v is Rel {
  return typeof v === 'string' && (RELS as readonly string[]).includes(v);
}
export function isMethod(v: unknown): v is Method {
  return typeof v === 'string' && (METHODS as readonly string[]).includes(v);
}
export function isProvenance(v: unknown): v is Provenance {
  return typeof v === 'string' && (PROVENANCES as readonly string[]).includes(v);
}
