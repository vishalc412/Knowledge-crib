/**
 * WP-G2 — the authorized temporal projection: a PURE read model over the canonical graph
 * entries (WP-G1 contracts) that answers "what could an authorized viewer see, now or at a
 * moment in the past?" — see graph-projection.test.ts for the law-per-test mapping.
 *
 * Every law here is a direct reading of the plan's WP-G2 items 1–4 and 6:
 *
 *  - **Authorization (item 2).** A viewer is a `(principalId, scope)` pair. An assertion is
 *    visible only if BOTH hold: its `namespace.principalId` is the viewer's (zero foreign
 *    disclosure — a withheld assertion contributes a COUNT to `diagnostics.excludedForeign`,
 *    never its content, so the diagnostic channel cannot become a leak), and its scope is
 *    visible from the viewer's scope (a global viewer sees global entries only; a repo viewer
 *    sees its own repo plus the global scope, never another repo's — the same placement law
 *    `isWellFormedGraphScope` enforces at write time, applied to reads).
 *
 *  - **Temporal views (item 1).** Both time axes window the CURRENT view: `at` bounds valid
 *    time (relationships that had not yet held are absent), `knownBy` bounds transaction time
 *    (relationships the store had not yet learned are absent, however long ago they held).
 *    `knownBy` also bounds the alias fold — a decision recorded after the bound has no effect
 *    on a historical view — so `projectGraph(input, viewer, {knownBy: T})` reconstructs
 *    exactly the projection an authorized viewer would have computed at T. The TIMELINE view
 *    is the full supported history of the visible slice, every version kept (assertions are
 *    versioned by `validAt`, and versions are never folded), ordered by (instant, id).
 *
 *  - **Contradiction preservation (item 3).** Nothing in this module resolves a disagreement:
 *    two supported assertions with the same canonical subject + predicate and different
 *    objects BOTH stay in the current view and BOTH stay traversable. The projection only
 *    GROUPS the disagreement in `conflicts` so the owner can see it. Last-write-wins is
 *    structurally impossible here — the only dedupe is by id, and the id already encodes the
 *    scoped content identity.
 *
 *  - **Aliases (item 4).** `establish`/`reverse` decisions fold, in (ts, id) order, into an
 *    undirected binding table. Canonical resolution is deterministic: the representative of
 *    a component is its lexicographically LEAST ref, so the same decision set yields the same
 *    resolution regardless of array order. An `establish` that would connect two refs already
 *    in one component (closing a cycle, making "the canonical ref" ambiguous) is REJECTED —
 *    reported with reason `alias-cycle`, never applied. A `reverse` with no matching binding
 *    is a reported no-op (`reverse-without-establish`). Reversibility is the fold itself:
 *    establish → reverse → re-establish leaves exactly one binding.
 *
 *  - **Unsupported exclusion (item 6).** A supporter is RESOLVABLE when it names a record id
 *    in `records`, an entity ref or id in `entities`, or a caller-known ref in `knownRefs`
 *    (gate receipts and other anchors live outside the memory store; the caller states its
 *    universe, the projection never guesses). An assertion NONE of whose supporters resolve
 *    is excluded from EVERY trusted surface — current, timeline, traversal, counts, export —
 *    and retained in `diagnostics.unsupported` (which assertion, which supporters missed) so
 *    the owner keeps diagnostic visibility without the relationship ever being traversed as
 *    trusted.
 *
 * The module is pure: no IO, no store, no clock — the caller passes the entries it gathered
 * and the instants it wants. Traversal helpers (`graphNeighbors`, `graphPath`) and the JSONL
 * export operate ONLY over the authorized, supported, windowed view, which is what makes
 * repeated projections of the same inputs byte-identical (the WP-G2 exit surface: paths,
 * counts, and exports).
 */
import { MEMORY_GRAPH_PREDICATES, compareGraphInstants, isMemoryGraphPredicate } from './graph.js';
import type { MemoryGraphPredicate } from './graph.js';
import { DEFAULT_MIGRATION_PRINCIPAL_ID } from './migrations.js';
import {
  type GraphAssertion,
  type GraphEntity,
  type GraphResolutionDecision,
  type MemoryScope,
  isGraphResolutionDecisionV2,
} from './types.js';

/** Who is asking: the authorization pair every visible entry must match. */
export interface GraphViewer {
  principalId: string;
  /** The placement the query runs from — a repo viewer sees its repo + global, nothing else. */
  scope: MemoryScope;
}

/** The gathered universe a projection runs over. All fields are the caller's to supply. */
export interface GraphProjectionInput {
  assertions: readonly GraphAssertion[];
  /** Alias resolution decisions, folded in (ts, id) order. */
  decisions?: readonly GraphResolutionDecision[];
  /**
   * Records the caller gathered — supporters naming a present record id resolve. `knownAt` is when
   * the record itself was recorded: an assertion cannot be known before BOTH of its record
   * endpoints are, so a `knownBy` read excludes an edge toward a record not yet recorded.
   */
  records?: readonly GraphRecordRef[];
  /**
   * Retained records that are no longer current (superseded as of the read point). An assertion
   * supported ONLY by these stays in the supported `timeline` as history and never enters
   * `current` — supersession changes what IS true, not what WAS. Retracted, quarantined, or
   * purged records must never be passed here: they support nothing, not even history.
   */
  historicalRecords?: readonly GraphRecordRef[];
  /** Entities the caller gathered — supporters naming a present entity ref or id resolve. */
  entities?: readonly GraphEntity[];
  /** Refs the caller knows are addressable but which live outside the memory store (receipts). */
  knownRefs?: readonly string[];
}

/** A gathered record as the projection needs it: its id, and when it was recorded if known. */
export interface GraphRecordRef {
  id: string;
  knownAt?: string;
}

/** The time window: `at` bounds valid time, `knownBy` bounds transaction time (and the alias fold). */
export interface GraphProjectionOpts {
  at?: string;
  knownBy?: string;
}

/** An assertion excluded for missing support — the owner's diagnostic, never a trusted edge. */
export interface GraphUnsupportedAssertion {
  id: string;
  /** The supporters that did not resolve, exactly as the assertion stated them. */
  missingSupporters: string[];
}

/** A resolution decision the fold refused — reported with a reason, never applied. */
export interface GraphRejectedDecision {
  id: string;
  reason: 'alias-cycle' | 'reverse-without-establish';
}

/** One surfaced disagreement: same canonical subject + predicate, distinct canonical objects. */
export interface GraphConflictGroup {
  /** The canonical subject the assertions disagree about. */
  subject: string;
  predicate: string;
  /** The distinct canonical objects, sorted — what the disagreement is between. */
  objects: string[];
  /** Every assertion in the group, sorted by id — all of them still traversable. */
  assertionIds: string[];
}

/** The effective alias state after the decision fold. */
export interface GraphAliasView {
  /** Effective undirected bindings as ordered `(min, max)` pairs, sorted. */
  bindings: { entityA: string; entityB: string }[];
  /** ref → its component's canonical representative (the lexicographically least member). */
  canonical: Record<string, string>;
}

export interface GraphProjectionDiagnostics {
  /** Always zero to avoid disclosing the presence of foreign assertions through diagnostics. */
  excludedForeign: number;
  /** Assertions no supporter of which resolves in the gathered universe. */
  unsupported: GraphUnsupportedAssertion[];
  /** Resolution decisions the fold refused (cycle / unmatched reverse). */
  rejectedDecisions: GraphRejectedDecision[];
  /** Decisions recorded after the `knownBy` bound — not applied to this (historical) view. */
  deferredDecisions: number;
}

export interface GraphProjectionCounts extends Record<MemoryGraphPredicate, number> {
  total: number;
}

export interface GraphProjection {
  viewer: GraphViewer;
  at?: string;
  knownBy?: string;
  /** The trusted current view: authorized, supported, and inside the time window, by id. */
  current: GraphAssertion[];
  /** The full supported history of the visible slice, ordered by (validAt instant, id). */
  timeline: GraphAssertion[];
  /** Record ids that are no longer current (superseded) but still support history, sorted. */
  historicalRefs: string[];
  /**
   * Supported assertions KNOWN at the read point that are not current: supported only by
   * historical records, or valid only after `at`. Ordered like `timeline`. Nothing recorded after
   * `knownBy` (or pointing at a record recorded after it) is ever here — history is what was known.
   */
  historical: GraphAssertion[];
  aliases: GraphAliasView;
  conflicts: GraphConflictGroup[];
  counts: GraphProjectionCounts;
  diagnostics: GraphProjectionDiagnostics;
}

// ─── authorization ────────────────────────────────────────────────────────────

/** The read-side placement law: mirrors `isWellFormedGraphScope`'s write-side placement. */
function visibleScope(scope: MemoryScope, viewer: GraphViewer): boolean {
  if (viewer.scope.boundary === 'global') return scope.boundary === 'global';
  if (scope.boundary === 'global') return true;
  return scope.repoId === viewer.scope.repoId;
}

function visibleTo(assertion: GraphAssertion, viewer: GraphViewer): boolean {
  return (
    assertion.namespace.principalId === viewer.principalId && visibleScope(assertion.scope, viewer)
  );
}

/** Legacy unscoped decisions may never alter a non-default principal's graph. */
function visibleDecision(decision: GraphResolutionDecision, viewer: GraphViewer): boolean {
  if (!isGraphResolutionDecisionV2(decision)) {
    return (
      viewer.principalId === DEFAULT_MIGRATION_PRINCIPAL_ID && viewer.scope.boundary === 'global'
    );
  }
  return (
    decision.namespace.principalId === viewer.principalId && visibleScope(decision.scope, viewer)
  );
}

// ─── the alias fold ───────────────────────────────────────────────────────────

/** The undirected binding table the decisions fold into — arrays kept sorted for determinism. */
class AliasTable {
  private readonly adjacent = new Map<string, Set<string>>();

  has(a: string, b: string): boolean {
    return this.adjacent.get(a)?.has(b) ?? false;
  }

  /** Is `b` reachable from `a` through the current bindings (connected ⇒ an establish would cycle)? */
  connected(a: string, b: string): boolean {
    if (a === b) return true;
    const seen = new Set<string>([a]);
    const queue = [a];
    while (queue.length > 0) {
      const ref = queue.pop() as string;
      for (const next of this.adjacent.get(ref) ?? []) {
        if (next === b) return true;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  }

  add(a: string, b: string): void {
    if (!this.adjacent.has(a)) this.adjacent.set(a, new Set());
    if (!this.adjacent.has(b)) this.adjacent.set(b, new Set());
    this.adjacent.get(a)?.add(b);
    this.adjacent.get(b)?.add(a);
  }

  remove(a: string, b: string): void {
    this.adjacent.get(a)?.delete(b);
    this.adjacent.get(b)?.delete(a);
  }

  /** Every ref named by any binding, sorted — the fold's output vocabulary. */
  refs(): string[] {
    const refs = new Set<string>();
    for (const [ref, peers] of this.adjacent) {
      if (peers.size > 0) refs.add(ref);
      for (const peer of peers) refs.add(peer);
    }
    return [...refs].sort();
  }

  peers(ref: string): string[] {
    return [...(this.adjacent.get(ref) ?? [])].sort();
  }
}

/** Fold decisions into the alias view. Decisions with ts > knownBy are DEFERRED, not rejected. */
function foldAliases(
  decisions: readonly GraphResolutionDecision[] | undefined,
  viewer: GraphViewer,
  knownBy: string | undefined,
): { view: GraphAliasView; rejected: GraphRejectedDecision[]; deferred: number } {
  const rejected: GraphRejectedDecision[] = [];
  const table = new AliasTable();
  let deferred = 0;

  // Deterministic fold order: (ts instant, id) — array order must never matter.
  const ordered = [...(decisions ?? [])]
    .filter((decision) => visibleDecision(decision, viewer))
    .sort((x, y) => compareGraphInstants(x.ts, y.ts) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  for (const d of ordered) {
    if (knownBy !== undefined && compareGraphInstants(d.ts, knownBy) > 0) {
      deferred += 1; // not yet KNOWN at this transaction time — absent, not refused
      continue;
    }
    const { entityA, entityB } = d;
    if (d.kind === 'establish') {
      if (table.connected(entityA, entityB)) {
        rejected.push({ id: d.id, reason: 'alias-cycle' });
        continue;
      }
      table.add(entityA, entityB);
    } else {
      if (!table.has(entityA, entityB)) {
        rejected.push({ id: d.id, reason: 'reverse-without-establish' });
        continue;
      }
      table.remove(entityA, entityB);
    }
  }

  // Canonical resolution: the component's least ref represents it — deterministic by construction.
  const canonical: Record<string, string> = {};
  for (const ref of table.refs()) {
    if (ref in canonical) continue;
    // The FULL component (transitive), not just direct peers — a chain a~b~c must canonize c to a.
    const component = [ref];
    const seen = new Set<string>([ref]);
    const queue = [ref];
    while (queue.length > 0) {
      const member = queue.pop() as string;
      for (const peer of table.peers(member)) {
        if (seen.has(peer)) continue;
        seen.add(peer);
        component.push(peer);
        queue.push(peer);
      }
    }
    const rep = component.reduce((least, r) => (r < least ? r : least), ref);
    for (const r of component) canonical[r] = rep;
  }

  const bindings: { entityA: string; entityB: string }[] = [];
  const emitted = new Set<string>();
  for (const ref of table.refs()) {
    for (const peer of table.peers(ref)) {
      const key = ref < peer ? `${ref} ${peer}` : `${peer} ${ref}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      bindings.push(ref < peer ? { entityA: ref, entityB: peer } : { entityA: peer, entityB: ref });
    }
  }
  bindings.sort((x, y) => x.entityA.localeCompare(y.entityA) || x.entityB.localeCompare(y.entityB));

  return { view: { bindings, canonical }, rejected, deferred };
}

// ─── the projection ───────────────────────────────────────────────────────────

/** Sort by (validAt instant, id) — the timeline order; stable for equal instants. */
function byInstantThenId(a: GraphAssertion, b: GraphAssertion): number {
  return compareGraphInstants(a.validAt, b.validAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Project the gathered graph universe into an authorized, supported, temporally-windowed view.
 * Pure and total: never throws, never mutates its inputs, deterministic for the same inputs.
 */
export function projectGraph(
  input: GraphProjectionInput,
  viewer: GraphViewer,
  opts: GraphProjectionOpts = {},
): GraphProjection {
  const resolvable = new Set<string>(input.knownRefs ?? []);
  for (const record of input.records ?? []) resolvable.add(record.id);
  for (const entity of input.entities ?? []) {
    resolvable.add(entity.ref);
    resolvable.add(entity.id);
  }

  const historicalSupport = new Set<string>();
  for (const record of input.historicalRecords ?? []) {
    if (!resolvable.has(record.id)) historicalSupport.add(record.id);
  }

  const unsupported: GraphUnsupportedAssertion[] = [];
  const supported: GraphAssertion[] = [];
  const historicalOnly = new Set<string>();

  for (const assertion of input.assertions) {
    if (!visibleTo(assertion, viewer)) {
      continue;
    }
    const missing = assertion.supportedBy.filter(
      (ref) => !resolvable.has(ref) && !historicalSupport.has(ref),
    );
    if (missing.length === assertion.supportedBy.length) {
      unsupported.push({ id: assertion.id, missingSupporters: missing });
      continue; // excluded from every trusted surface; the owner still sees it in diagnostics
    }
    if (!assertion.supportedBy.some((ref) => resolvable.has(ref))) historicalOnly.add(assertion.id);
    supported.push(assertion);
  }

  const {
    view: aliases,
    rejected: rejectedDecisions,
    deferred: deferredDecisions,
  } = foldAliases(input.decisions, viewer, opts.knownBy);

  const recordKnownAt = new Map<string, string>();
  for (const record of [...(input.records ?? []), ...(input.historicalRecords ?? [])]) {
    if (record.knownAt !== undefined) recordKnownAt.set(record.id, record.knownAt);
  }
  const endpointKnown = (ref: string, knownBy: string): boolean => {
    const at = recordKnownAt.get(ref);
    return at === undefined || compareGraphInstants(at, knownBy) <= 0;
  };
  const validOk = (a: GraphAssertion): boolean =>
    opts.at === undefined || compareGraphInstants(a.validAt, opts.at) <= 0;
  const knownOk = (a: GraphAssertion): boolean =>
    opts.knownBy === undefined ||
    (compareGraphInstants(a.knownAt, opts.knownBy) <= 0 &&
      endpointKnown(a.subject, opts.knownBy) &&
      endpointKnown(a.object, opts.knownBy));
  const inWindow = (a: GraphAssertion): boolean => validOk(a) && knownOk(a);

  const timeline = [...supported].sort(byInstantThenId);
  const historical = timeline.filter(
    (a) => knownOk(a) && (historicalOnly.has(a.id) || !validOk(a)),
  );
  const current = supported
    .filter((a) => inWindow(a) && !historicalOnly.has(a.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // Conflicts, grouped and NEVER resolved — every member stays in `current` and traversable:
  //  - a FUNCTIONAL predicate (a record is about one subject; a symbol is part of one entity) with
  //    distinct canonical objects for one canonical subject is a disagreement;
  //  - an explicit `contradicts` assertion is a disagreement between its two endpoints, grouped
  //    with every `contradicts` assertion between the same pair in either direction.
  // Multi-valued predicates (supported-by, applies-to, affects, derived-from, supersedes) naming
  // several objects are simply several facts, not a disagreement.
  const canonicalOf = (ref: string): string => aliases.canonical[ref] ?? ref;
  const groups = new Map<
    string,
    { subject: string; predicate: string; objects: Set<string>; ids: string[] }
  >();
  const addToGroup = (
    key: string,
    subject: string,
    predicate: string,
    objects: string[],
    id: string,
  ) => {
    let group = groups.get(key);
    if (!group) {
      group = { subject, predicate, objects: new Set<string>(), ids: [] };
      groups.set(key, group);
    }
    for (const object of objects) group.objects.add(object);
    group.ids.push(id);
  };
  for (const a of current) {
    const subject = canonicalOf(a.subject);
    const object = canonicalOf(a.object);
    if (GRAPH_FUNCTIONAL_PREDICATES.has(a.predicate)) {
      addToGroup(`${subject} ${a.predicate}`, subject, a.predicate, [object], a.id);
    } else if (a.predicate === 'contradicts' && subject !== object) {
      const [low, high] = subject < object ? [subject, object] : [object, subject];
      addToGroup(`${low} ${high} contradicts`, low, 'contradicts', [low, high], a.id);
    }
  }
  const conflicts: GraphConflictGroup[] = [];
  for (const group of groups.values()) {
    if (group.objects.size < 2) continue; // one object is a fact, not a disagreement
    conflicts.push({
      subject: group.subject,
      predicate: group.predicate,
      objects: [...group.objects].sort(),
      assertionIds: group.ids.sort(),
    });
  }
  conflicts.sort(
    (x, y) => x.subject.localeCompare(y.subject) || x.predicate.localeCompare(y.predicate),
  );

  const counts = { total: current.length } as GraphProjectionCounts;
  for (const predicate of MEMORY_GRAPH_PREDICATES) counts[predicate] = 0;
  for (const a of current) {
    // The schema admits only vocabulary predicates; a stray value still counts under `total`
    // (the window law is honest about size) but never invents a per-predicate bucket.
    if (isMemoryGraphPredicate(a.predicate)) counts[a.predicate] += 1;
  }

  return {
    viewer,
    ...(opts.at !== undefined ? { at: opts.at } : {}),
    ...(opts.knownBy !== undefined ? { knownBy: opts.knownBy } : {}),
    current,
    timeline,
    historicalRefs: [...historicalSupport].sort(),
    historical,
    aliases,
    conflicts,
    counts,
    diagnostics: { excludedForeign: 0, unsupported, rejectedDecisions, deferredDecisions },
  };
}

// ─── traversal over the projected view ────────────────────────────────────────

/** The canonical form of a ref inside a projection — itself unless an alias binds it. */
function canonicalRef(p: GraphProjection, ref: string): string {
  return p.aliases.canonical[ref] ?? ref;
}

/**
 * The assertions of the current view touching `ref` (alias-expanded: an edge of an alias is an
 * edge of the whole component). Sorted by id — deterministic for the same projection.
 */
export function graphNeighbors(
  p: GraphProjection,
  ref: string,
  opts: { predicate?: MemoryGraphPredicate } = {},
): GraphAssertion[] {
  const canonical = canonicalRef(p, ref);
  const edges = p.current.filter(
    (a) =>
      (canonicalRef(p, a.subject) === canonical || canonicalRef(p, a.object) === canonical) &&
      (opts.predicate === undefined || a.predicate === opts.predicate),
  );
  return edges.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Predicates with at most one object per subject — distinct objects are a disagreement. */
export const GRAPH_FUNCTIONAL_PREDICATES: ReadonlySet<string> = new Set(['about', 'part-of']);

/** The default hop bound — the plan's traversal law (two-hop default, max 4). */
export const GRAPH_PATH_MAX_HOPS = 4;

/**
 * The shortest path of current-view assertions from `from` to `to`, alias-expanded, at most
 * `maxHops` assertions (default {@link GRAPH_PATH_MAX_HOPS}); `null` when none exists. BFS
 * over canonical refs with id-sorted expansion — deterministic for the same projection. A
 * path between two aliases of one component is `[]` (they are the same canonical node).
 */
export function graphPath(
  p: GraphProjection,
  from: string,
  to: string,
  opts: { maxHops?: number } = {},
): GraphAssertion[] | null {
  const maxHops = opts.maxHops ?? GRAPH_PATH_MAX_HOPS;
  const start = canonicalRef(p, from);
  const goal = canonicalRef(p, to);
  if (start === goal) return [];

  const byId = new Map<string, GraphAssertion[]>();
  for (const a of p.current) {
    const subject = canonicalRef(p, a.subject);
    const object = canonicalRef(p, a.object);
    for (const [node, other] of [
      [subject, object],
      [object, subject],
    ] as const) {
      let edges = byId.get(node);
      if (!edges) {
        edges = [];
        byId.set(node, edges);
      }
      edges.push(a);
    }
  }
  for (const edges of byId.values()) edges.sort((a, b) => (a.id < b.id ? -1 : 1));

  const visited = new Set<string>([start]);
  let frontier: { node: string; path: GraphAssertion[] }[] = [{ node: start, path: [] }];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next: { node: string; path: GraphAssertion[] }[] = [];
    for (const { node, path } of frontier) {
      for (const edge of byId.get(node) ?? []) {
        const other =
          canonicalRef(p, edge.subject) === node
            ? canonicalRef(p, edge.object)
            : canonicalRef(p, edge.subject);
        if (visited.has(other)) continue;
        const extended = [...path, edge];
        if (other === goal) return extended;
        visited.add(other);
        next.push({ node: other, path: extended });
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The trusted current view as canonical JSONL — one assertion per line, sorted by id, stable
 * key order per line. Repeated projections of the same inputs export byte-identical text (the
 * WP-G2 exit surface: exports over the authorized, supported, windowed view).
 */
export function exportGraphProjection(p: GraphProjection): string {
  return `${p.current.map((a) => JSON.stringify(a)).join('\n')}\n`;
}
