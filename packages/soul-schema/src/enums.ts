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
  | 'condition';

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
  | 'guarded-by';

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
