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
  | 'owner'
  // 1.5 (cross-repo federation): an outbound HTTP client call site — `fetch('/api/x')`,
  // `axios.get(...)`, `restTemplate.getForObject(...)`. Carries {httpMethod, routePath, framework}
  // (the same fields a `route` node carries, so a runtime federation layer matches a repo-A call to
  // a repo-B route by method+path WITHOUT committing a cross-repo edge (each soul stays independent
  // + deterministic + committed-clean). The bridge is a runtime computation, not persisted state.)
  | 'http-call'
  // 1.6 (AI-artifact graph / PRD W1): a deterministic, tracked AI artifact — an instruction doc,
  // skill, agent definition, command, rule, or MCP-server declaration. These are EXTRACTED
  // repository facts (committed files), NOT memories (which live in the separate memory ledger
  // outside this enum). Carries `artifactType` + optional doc metadata (docType/audience/appliesTo).
  // Extracted by the committed artifact scanner + opt-in local overlay, never by the memory layer.
  | 'agent-artifact';

/**
 * The `agent-artifact` node's kind of artifact (PRD W1 / schema 1.6). Closed enum: unknown values
 * → validation error (invariant #4). Each value maps to a tracked AI-tool artifact class:
 * instruction docs, skills, agent definitions, slash commands, rules/policies, MCP-server decls.
 */
export type ArtifactType = 'instruction' | 'skill' | 'agent' | 'command' | 'rule' | 'mcp-server';

export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  'instruction',
  'skill',
  'agent',
  'command',
  'rule',
  'mcp-server',
];

export function isArtifactType(v: unknown): v is ArtifactType {
  return typeof v === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(v);
}

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
  | 'owned-by'
  // 1.6 (AI-artifact graph / PRD W1): relations between `agent-artifact` nodes and the symbols /
  // docs / other artifacts they touch. EXTRACTED from explicit references in the artifact body
  // (qualified names, paths, code spans, command/invocation references) — never from generic prose
  // identifier matches (PRD W1: "Remove path fan-out and prose-only describes").
  | 'governs' // artifact → symbol/doc it defines policy or instructions for
  | 'requires' // artifact → symbol/artifact it depends on (a skill that calls a command)
  | 'invokes'; // artifact → command/route/handler it triggers

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
  'http-call',
  'agent-artifact',
];

/**
 * Node kinds that are DETAIL of an enclosing symbol rather than answers in their own right.
 *
 * Two consumers, which is why this lives in the schema package rather than in either of them:
 * discovery ranking (`query` / `ask` / `brief` exclude these by default, because a short fragment
 * containing a query token outscores the function containing it under BM25) and vector building
 * (there is no reason to embed a node kind discovery never ranks — on the crib's own index these are
 * 38,286 of 48,459 nodes, or 79%, so embedding them was 79% of the cost of the vector build).
 *
 * Excluding them from discovery costs no CONTENT: a symbol's FTS body column holds its whole
 * rehydrated span, so a fragment's text is searchable through its enclosing symbol.
 */
export const DETAIL_NODE_KINDS: readonly NodeKind[] = [
  'statement',
  'condition',
  'assignment',
  'case-branch',
  'raise',
  'cursor',
  'exception-handler',
  'explanation',
];

/**
 * The kinds discovery ranks and the vector builder embeds: {@link NODE_KINDS} MINUS
 * {@link DETAIL_NODE_KINDS}.
 *
 * Derived by subtraction, never enumerated. A newly added NodeKind must default to being
 * DISCOVERABLE — a hand-written allowlist would silently exclude every future kind, and that failure
 * is invisible, because a kind that is never returned looks exactly like a corpus containing none.
 */
export const DISCOVERY_NODE_KINDS: readonly NodeKind[] = NODE_KINDS.filter(
  (k) => !DETAIL_NODE_KINDS.includes(k),
);

/** True when `kind` is sub-symbol detail (see {@link DETAIL_NODE_KINDS}). */
export function isDetailNodeKind(kind: NodeKind): boolean {
  return DETAIL_NODE_KINDS.includes(kind);
}

/**
 * PROSE discovery kinds — the nodes whose text is written for a human to read rather than for a
 * machine to execute.
 *
 * WHY THIS PARTITION EXISTS, measured rather than assumed. Blending prose and code into one BM25
 * ranking loses to prose for exactly the queries where code was wanted: a question phrased in English
 * matches a project's own documentation ABOUT a change more strongly than the code implementing it.
 * On 61 change-localisation tasks the blended ranking scored MRR 0.323 while code-only scored 0.611
 * (docs/bench/localisation.md). Documentation was not ranking badly — it was ranking correctly, for a
 * relevance judgement nobody asked for.
 *
 * `agent-artifact` belongs here: a skill, rule or instruction file is prose about the code, not code.
 * `media-seg` is a transcript segment, which is prose that was spoken.
 *
 * ENUMERATED, unlike {@link DISCOVERY_NODE_KINDS}, and deliberately so: a newly added kind must
 * default to being treated as CODE, because the failure mode of a wrong guess is asymmetric. A code
 * kind misfiled as prose disappears from the primary ranking and looks like a corpus that contains
 * none of it; a prose kind misfiled as code merely ranks alongside code, which is where it used to be.
 */
export const PROSE_NODE_KINDS: readonly NodeKind[] = ['doc-section', 'media-seg', 'agent-artifact'];

/**
 * CODE discovery kinds — every discoverable kind that is not prose. Derived by subtraction so the two
 * partitions cannot drift apart or overlap as kinds are added.
 */
export const CODE_NODE_KINDS: readonly NodeKind[] = DISCOVERY_NODE_KINDS.filter(
  (k) => !PROSE_NODE_KINDS.includes(k),
);

/** True when `kind` is prose written for a human rather than code (see {@link PROSE_NODE_KINDS}). */
export function isProseNodeKind(kind: NodeKind): boolean {
  return PROSE_NODE_KINDS.includes(kind);
}

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
  'governs',
  'requires',
  'invokes',
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
