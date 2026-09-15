/**
 * The connected-memory-graph domain (WP-G1): the bounded predicate vocabulary, the canonical
 * traversal-ref grammar, and the factories that build validated graph entries.
 *
 * Layering law: this module is the PRODUCTION vocabulary; the WP-G0 corpus
 * (graph-corpus/corpus.ts) is a FROZEN pre-registration fixture that declares its own copy of
 * the same eight predicates. The domain deliberately does NOT import the corpus — a production
 * path must not depend on an evaluation fixture — so the two lists are pinned equal by
 * `graph-contracts.test.ts`. If that pin fails, the domain vocabulary drifted; fix the domain
 * (or version the corpus), never the test.
 */
import { graphAssertionId, graphEntityId, graphResolutionId } from './ids.js';
import type {
  GraphAssertion,
  GraphEntity,
  GraphEntityKind,
  GraphResolutionDecision,
  MemoryNamespace,
  MemoryProvenance,
  MemoryScope,
} from './types.js';
import {
  MemorySchemaError,
  assertValidGraphAssertion,
  assertValidGraphEntity,
  assertValidGraphResolutionDecision,
} from './validate.js';

// ─── the bounded predicate vocabulary ─────────────────────────────────────────

/**
 * The eight-predicate relation vocabulary the launch plan fixes (§2 "Domain model"). Named
 * `MEMORY_GRAPH_PREDICATES` (not `GRAPH_PREDICATES`) so the package index can star-export both
 * this module and the corpus without an ambiguous-name collision.
 */
export const MEMORY_GRAPH_PREDICATES = [
  'about',
  'applies-to',
  'supported-by',
  'derived-from',
  'supersedes',
  'contradicts',
  'part-of',
  'affects',
] as const;

export type MemoryGraphPredicate = (typeof MEMORY_GRAPH_PREDICATES)[number];

/** Type guard for the bounded predicate vocabulary (unknown values fail closed everywhere). */
export function isMemoryGraphPredicate(value: string): value is MemoryGraphPredicate {
  return (MEMORY_GRAPH_PREDICATES as readonly string[]).includes(value);
}

// ─── the traversal-ref grammar ───────────────────────────────────────────────

/**
 * The id prefixes a graph assertion endpoint may carry — exactly the node kinds the WP-G0
 * corpus universe pre-registers: claims (`mem:`), work references (`intake:`), topics
 * (`topic:`), code symbols (`sym:`), entities (`entity:`), policy anchors (`artifact:`),
 * attestations (`attestation:`), and gate receipts (`rcpt:`). Anything else fails closed:
 * an assertion endpoint the universe cannot name is an invented link.
 */
export const GRAPH_REF_PREFIXES = [
  'mem',
  'intake',
  'topic',
  'sym',
  'entity',
  'artifact',
  'attestation',
  'rcpt',
] as const;

/** The prefix token before the first `:`, or `undefined` for a non-ref. */
function refPrefix(ref: string): string | undefined {
  const i = ref.indexOf(':');
  return i > 0 ? ref.slice(0, i) : undefined;
}

/** Is `ref` a well-formed graph traversal ref (known prefix, non-empty local part)? */
export function isGraphRef(ref: string): boolean {
  const prefix = refPrefix(ref);
  return (
    prefix !== undefined &&
    (GRAPH_REF_PREFIXES as readonly string[]).includes(prefix) &&
    ref.length > prefix.length + 1
  );
}

/**
 * Is `value` a legal single ref/scope SEGMENT — the grammar the graph schemas pin
 * (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `/`)? A record's `namespace.projectId` is only
 * minLength-1 in record-v3, so a caller placing records into graph scopes (the backfill)
 * must verify the segment grammar itself: a repoId like `org/repo` would fail graph
 * validation only at entry creation, aborting the caller's whole derivation.
 */
export function isGraphSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

// ─── the entity ref convention ────────────────────────────────────────────────

/**
 * The canonical traversal node id for an entity — the vocabulary the corpus pre-registers and
 * every assertion speaks:
 *  - global scope → `entity:<name>` (device-global concepts);
 *  - repo scope, `repository` kind → `entity:<repoId>` (the repository is its own node);
 *  - repo scope, any other kind → `entity:<repoId>/<name>` (names stay repo-qualified, so the
 *    same-named `OrderService` in two repos can never silently merge — the no-silent-merge law).
 *
 * INJECTIVITY (review-confirmed law): `name` and `scope.repoId` are pinned to the single ref
 * SEGMENT grammar (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `/`) in the graph schemas, so the `/`
 * between repoId and name is the ONLY slash a repo ref can carry — a global `entity:<name>` can
 * never collide with a repo-qualified `entity:<repoId>/<name>`, and no two repo pairs can fold
 * onto one ref. Relax those schema patterns and refs silently merge across scopes.
 */
export function graphEntityRef(input: {
  kind: GraphEntityKind;
  name: string;
  scope: MemoryScope;
}): string {
  const { kind, name, scope } = input;
  if (scope.boundary === 'global') return `entity:${name}`;
  const repoId = scope.repoId;
  if (!repoId) {
    // The scope law is enforced by validation; the factory path should never get here.
    throw new Error('graphEntityRef: repo scope requires a repoId');
  }
  return kind === 'repository' ? `entity:${repoId}` : `entity:${repoId}/${name}`;
}

/**
 * Instant-order comparison for two schema-valid ISO stamps — `Date.parse`, NEVER a raw string
 * compare: the graph schemas admit offset (`+05:00`) and optional-fraction forms where
 * lexicographic order is NOT instant order (a `+14:00` wall-clock string sorts after a `Z`
 * stamp while naming an EARLIER instant). Returns <0 when `a` is the earlier instant, 0 for the
 * same instant (any spelling), >0 when `a` is later. Unparseable stamps fall back to the raw
 * compare (defensive — the schema gate already admitted both forms; the store's private
 * `laterTimestamp` carries the same law for merges).
 */
export function compareGraphInstants(a: string, b: string): number {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (!Number.isNaN(pa) && !Number.isNaN(pb)) return pa === pb ? 0 : pa < pb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── the scope law ───────────────────────────────────────────────────────────

/**
 * Enforce the placement law shared by every graph entry: a `repo` boundary REQUIRES a repoId
 * and a `global` boundary FORBIDS one (a global entry carrying a repoId would surface in
 * repo-scoped projections — an isolation leak). Pure structure; throws never — the caller
 * (assertValidGraph*) turns `false` into a MemorySchemaError.
 */
export function isWellFormedGraphScope(scope: MemoryScope): boolean {
  if (scope.boundary === 'repo') return typeof scope.repoId === 'string' && scope.repoId.length > 0;
  return scope.repoId === undefined;
}

// ─── factories ───────────────────────────────────────────────────────────────

/** Build a validated {@link GraphEntity}: derives `id` + `ref`, validates, returns it. */
export function createGraphEntity(
  input: {
    kind: GraphEntityKind;
    name: string;
    namespace: MemoryNamespace;
    scope: MemoryScope;
    provenance: MemoryProvenance;
    members?: string[];
    labels?: string[];
    meta?: Record<string, unknown>;
  } & Record<string, unknown>,
): GraphEntity {
  const entity: GraphEntity = {
    id: graphEntityId(input),
    schemaVersion: '1',
    kind: input.kind,
    name: input.name,
    ref: graphEntityRef(input),
    namespace: input.namespace,
    scope: input.scope,
    provenance: input.provenance,
    ...(input.members !== undefined ? { members: input.members } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
  assertValidGraphEntity(entity);
  return entity;
}

/**
 * Build a validated {@link GraphAssertion}: derives the id from the scoped content identity,
 * stamps `admission: 'proposed'`, validates, returns it. The input type deliberately has NO
 * `admission` field — the producer may never mint trust (the tty:true refusal law); a smuggled
 * key is dropped, not read, because the entity is constructed field-by-field.
 */
export function createGraphAssertion(
  input: {
    predicate: MemoryGraphPredicate;
    subject: string;
    object: string;
    namespace: MemoryNamespace;
    scope: MemoryScope;
    validAt: string;
    knownAt: string;
    supportedBy: readonly string[];
    provenance: MemoryProvenance;
    meta?: Record<string, unknown>;
  } & Record<string, unknown>,
): GraphAssertion {
  if (!Array.isArray(input.supportedBy)) {
    // A dynamic caller bypassing the TS type with a string would spread per-character — each
    // single char passes the schema's `items: {minLength: 1}` and launders garbage into the
    // supporters list. Fail closed BEFORE the spread (the schema alone cannot catch it).
    throw new MemorySchemaError('graph-assertion', [{ supportedByNotAnArray: true }]);
  }
  const assertion: GraphAssertion = {
    id: graphAssertionId(input),
    schemaVersion: '1',
    predicate: input.predicate,
    subject: input.subject,
    object: input.object,
    namespace: input.namespace,
    scope: input.scope,
    validAt: input.validAt,
    knownAt: input.knownAt,
    supportedBy: [...input.supportedBy],
    admission: 'proposed',
    provenance: input.provenance,
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
  assertValidGraphAssertion(assertion);
  return assertion;
}

/** Build a validated {@link GraphResolutionDecision}: derives the id, validates, returns it. */
export function createGraphResolutionDecision(
  input: {
    kind: 'establish' | 'reverse';
    entityA: string;
    entityB: string;
    namespace: MemoryNamespace;
    scope: MemoryScope;
    provenance: MemoryProvenance;
    actor: string;
    reason?: string;
    ts: string;
    meta?: Record<string, unknown>;
  } & Record<string, unknown>,
): GraphResolutionDecision {
  const decision: GraphResolutionDecision = {
    id: graphResolutionId({ ...input, schemaVersion: '2' }),
    schemaVersion: '2',
    kind: input.kind,
    entityA: input.entityA,
    entityB: input.entityB,
    namespace: input.namespace,
    scope: input.scope,
    provenance: input.provenance,
    actor: input.actor,
    ts: input.ts,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  };
  assertValidGraphResolutionDecision(decision);
  return decision;
}
