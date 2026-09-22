/**
 * WP-G5 items 5–8 — context assembly: turning a ranked expansion into the grouped, deduplicated,
 * provenance-carrying pack a caller can put in front of a model.
 *
 * This module does the GROUPING and the DEDUPLICATION. It deliberately does NOT do the token
 * arithmetic: the serving layer already owns a proven response-wide budget (`fitTokenBudget` over
 * a chars/4 estimator), and a second estimator here would be a second answer to the same question.
 * What this module guarantees is that whatever prefix the budget keeps is still a coherent pack —
 * ordered by rank, with every group labelled, so a trim shortens the answer without changing what
 * the answer claims.
 *
 * The laws:
 *
 *  - **Every assertion is listed once.** Items, relations, history and conflicts cite assertion
 *    ids; the bodies live in one `assertions` table. A pack that repeated each assertion inside
 *    every path that crossed it would spend its token budget on repetition and trim away answers.
 *
 *  - **Deduplication is by assertion, not by text (item 5).** Two expansions reached through
 *    different paths routinely rest on the SAME assertions and supporters; each assertion (with
 *    its supporter refs) and each producer is listed once, so a caller paying for a claim pays
 *    for it once however many paths lead to it. Items themselves are already unique per canonical
 *    ref (the expansion's own law), and are never merged further.
 *
 *  - **A disagreement is presented as a disagreement (item 6).** Conflicting assertions are
 *    carried in their own group, whole, with every member — never the most recent, never the
 *    highest-ranked. The projection refused to resolve it; the pack refuses to hide it. A
 *    conflict is included when the pack contains ANY of its members, because showing one side of
 *    a disagreement without saying a disagreement exists is worse than showing neither.
 *
 *  - **History is labelled, never interleaved (item 8).** Assertions that are in the projection's
 *    supported timeline but NOT in its current view (superseded, or outside the time window) go in
 *    an explicitly `historical` group. They never appear among the current items, so a caller
 *    cannot mistake what WAS true for what IS.
 *
 *  - **Relationships among the answer are cited, not implied.** A path explains how ONE item was
 *    reached; two items retrieved directly (both seeds) have no path between them even when an
 *    assertion connects them. `relations` lists every current assertion whose endpoints are both
 *    in the pack, so a connection the answer depends on is always stated with its supporters.
 *
 *  - **An item says whether it is current.** A superseded record reached through a `supersedes`
 *    edge is part of the answer's history, and its item is labelled `historical` — never passed
 *    off as a current claim.
 *
 *  - **Provenance travels with the claim (item 7).** Every item carries the path it was reached
 *    by — assertion ids, predicates, endpoints — and every cited supporter carries the provenance
 *    of the assertions that rest on it. A pack a caller cannot audit is a pack that has to be
 *    trusted, and this system does not ask to be trusted.
 */
import type { GraphConflictGroup, GraphProjection } from './graph-projection.js';
import type {
  GraphExpansion,
  GraphExpansionResult,
  GraphPathStep,
  GraphTraversalReport,
} from './graph-retrieval.js';
import type { GraphAssertion } from './types.js';

/** §2's default context budget, in tokens. Applied by the serving layer, stated here as the law. */
export const GRAPH_DEFAULT_CONTEXT_TOKENS = 2000;

export interface GraphContextItem {
  /** The canonical ref this item is about. */
  ref: string;
  /** `historical` when the ref is superseded work or a superseded record that only supports history. */
  state: 'current' | 'historical';
  /** Hops from the nearest seed; 0 means retrieval found it directly (a seed). */
  distance: number;
  /** Deterministic ordering score, 4 decimal places. NOT a calibrated confidence. */
  rank: number;
  /** The retriever's own score for the seed this item was reached from — kept distinct from rank. */
  seedScore: number;
  seedChannel: GraphExpansion['seedChannel'];
  /** Present (and `false`) only when some edge on the path lacks a recall-eligible supporter. */
  evidenceEligible?: false;
  /** How this ref was reached: assertion ids in traversal order (bodies in `assertions`). */
  path: string[];
}

/** One assertion the pack cites, listed once. */
export interface GraphContextAssertion {
  id: string;
  predicate: string;
  subject: string;
  object: string;
  supportedBy: string[];
  validAt: string;
  knownAt: string;
  /** `historical` when it is known at the read point but not in the current view. */
  status: 'current' | 'historical';
  /** Index into the pack's `producers` table — who asserted it. */
  producer: number;
}

/** One producer of cited assertions, listed once — the provenance a caller needs to audit. */
export interface GraphContextProducer {
  principalId: string;
  actorId: string;
  clientId: string;
}

export interface GraphContextPack {
  /** The items, ordered by rank — the order a budget trim shortens. */
  items: GraphContextItem[];
  /**
   * Every cited assertion, once, sorted by id: item paths, relations among items, conflict
   * members, and known history touching an item (`status: 'historical'`, item 8). Each carries
   * its `supportedBy` evidence refs (item 5) and a `producer` index (item 7).
   */
  assertions: GraphContextAssertion[];
  /** Ids of current assertions whose canonical endpoints are both items, sorted. */
  relations: string[];
  /** Disagreements touching this pack, whole (item 6). */
  conflicts: GraphConflictGroup[];
  /** The distinct producers the assertions cite by index, in first-cited order. */
  producers: GraphContextProducer[];
  /** The traversal bounds that produced the candidate items, carried through unchanged. */
  traversal: GraphTraversalReport;
  /** Explicit degradation reasons. Empty means nothing was degraded — never inferred from silence. */
  degraded: string[];
  /** The token budget the serving layer should apply to this pack. */
  budgetTokens: number;
}

export interface GraphContextOpts {
  /** The budget the serving layer will apply; recorded on the pack, never enforced here. */
  budgetTokens?: number;
  /** Include the historical group. Default true — a caller asking for context wants the change. */
  includeHistorical?: boolean;
  /** Degradation reasons the caller already knows about (a stale index, an unavailable channel). */
  degraded?: readonly string[];
}

/**
 * Build a pack from ranked expansions. Everything but the item list is DERIVED from the items and
 * the projection, so a pack built from a budget-trimmed prefix is still coherent: it never cites a
 * relation, history entry, conflict or supporter that no kept item touches.
 */
export function buildGraphContextPack(
  projection: GraphProjection,
  expansions: readonly GraphExpansion[],
  traversal: GraphTraversalReport,
  opts: GraphContextOpts = {},
): GraphContextPack {
  const canonicalOf = (ref: string): string => projection.aliases.canonical[ref] ?? ref;
  const historicalRefs = new Set(projection.historicalRefs);
  const round = (n: number): number => Math.round(n * 10_000) / 10_000;
  const items: GraphContextItem[] = expansions.map((e) => ({
    ref: e.ref,
    state: historicalRefs.has(e.ref) ? 'historical' : 'current',
    distance: e.distance,
    rank: round(e.rank),
    seedScore: round(e.seedScore),
    seedChannel: e.seedChannel,
    ...(e.evidenceEligible ? {} : { evidenceEligible: false as const }),
    path: e.path.map((step) => step.assertionId),
  }));
  const itemRefs = new Set(items.map((i) => i.ref));
  const touches = (a: GraphAssertion): boolean =>
    itemRefs.has(canonicalOf(a.subject)) || itemRefs.has(canonicalOf(a.object));

  const current = new Map(projection.current.map((a) => [a.id, a]));
  const pathIds = new Set(items.flatMap((i) => i.path));
  const relations = projection.current
    .filter((a) => itemRefs.has(canonicalOf(a.subject)) && itemRefs.has(canonicalOf(a.object)))
    .map((a) => a.id)
    .sort();
  const historicalAssertions =
    opts.includeHistorical === false ? [] : projection.historical.filter(touches);
  const conflicts = projection.conflicts.filter(
    (group) =>
      group.assertionIds.some((id) => pathIds.has(id)) ||
      itemRefs.has(canonicalOf(group.subject)) ||
      group.objects.some((object) => itemRefs.has(canonicalOf(object))),
  );

  const cited = new Map<string, { assertion: GraphAssertion; status: 'current' | 'historical' }>();
  for (const id of [...pathIds, ...relations, ...conflicts.flatMap((g) => g.assertionIds)]) {
    const assertion = current.get(id);
    if (assertion !== undefined) cited.set(id, { assertion, status: 'current' });
  }
  for (const assertion of historicalAssertions) {
    cited.set(assertion.id, { assertion, status: 'historical' });
  }
  const producers: GraphContextProducer[] = [];
  const producerIndex = new Map<string, number>();
  const assertions = [...cited.values()]
    .sort((a, b) => (a.assertion.id < b.assertion.id ? -1 : 1))
    .map(({ assertion: a, status }) => {
      const { principalId, actorId, clientId } = a.provenance;
      const key = `${principalId} ${actorId} ${clientId}`;
      let producer = producerIndex.get(key);
      if (producer === undefined) {
        producer = producers.length;
        producerIndex.set(key, producer);
        producers.push({ principalId, actorId, clientId });
      }
      return {
        id: a.id,
        predicate: a.predicate,
        subject: a.subject,
        object: a.object,
        supportedBy: [...a.supportedBy],
        validAt: a.validAt,
        knownAt: a.knownAt,
        status,
        producer,
      };
    });

  return {
    items,
    assertions,
    relations,
    conflicts,
    producers,
    traversal,
    degraded: [...(opts.degraded ?? [])],
    budgetTokens: opts.budgetTokens ?? GRAPH_DEFAULT_CONTEXT_TOKENS,
  };
}

/**
 * Assemble the pack from a projection and the result of one expansion over it.
 *
 * The whole {@link GraphExpansionResult} is taken, not just its list, so the traversal report
 * travels WITH the items it bounded — the truncation signal is exactly the thing that must not be
 * able to drift from the list it describes. The expansion layer's rank order is preserved
 * verbatim; everything else is derived from the projection, so a pack can never cite an assertion
 * the viewer was not authorized to see.
 */
export function assembleGraphContext(
  projection: GraphProjection,
  expansion: GraphExpansionResult,
  opts: GraphContextOpts = {},
): GraphContextPack {
  return buildGraphContextPack(projection, expansion.expansions, expansion.report, opts);
}

/** Current assertions whose canonical endpoints are both in `refs` — the relationships an answer
 *  made of those refs rests on. Sorted by id; deterministic for the same projection. */
export function graphRelationsAmong(
  projection: GraphProjection,
  refs: ReadonlySet<string>,
): GraphPathStep[] {
  const canonicalOf = (ref: string): string => projection.aliases.canonical[ref] ?? ref;
  return projection.current
    .filter((a) => refs.has(canonicalOf(a.subject)) && refs.has(canonicalOf(a.object)))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((a) => ({
      assertionId: a.id,
      predicate: a.predicate,
      subject: a.subject,
      object: a.object,
      supportedBy: [...a.supportedBy],
    }));
}
