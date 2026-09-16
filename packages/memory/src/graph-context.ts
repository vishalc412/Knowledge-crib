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
 *  - **Deduplication is by evidence, not by text (item 5).** Two expansions reached through
 *    different paths routinely rest on the SAME supporting record. The pack lists each supporting
 *    record once, in an `evidence` table keyed by ref, and items cite it by ref — so a caller
 *    paying for a claim pays for it once however many paths lead to it. Items themselves are
 *    already unique per canonical ref (the expansion's own law), and are never merged further:
 *    two refs that genuinely differ stay two entries even when they share every supporter.
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
  /** `seed` when retrieval found it directly, `connected` when the graph reached it. */
  origin: 'seed' | 'connected';
  distance: number;
  rank: number;
  /** The retriever's own score for the seed this item was reached from — kept distinct from rank. */
  seedScore: number;
  seedChannel: GraphExpansion['seedChannel'];
  evidenceEligible: boolean;
  /** The graph explanation: how this ref was reached. Empty for a seed. */
  path: GraphPathStep[];
  /** Supporter refs cited by this item's path, deduplicated — look them up in `evidence`. */
  evidenceRefs: string[];
}

/** One supporting record, listed once however many items rest on it. */
export interface GraphContextEvidence {
  /** The supporter ref exactly as the assertions stated it. */
  ref: string;
  /** Ids of the assertions in this pack that rest on it. */
  assertionIds: string[];
  /** The distinct producers of those assertions — the provenance a caller needs to audit. */
  producers: { principalId: string; actorId: string; clientId: string }[];
}

/** An assertion that was true but is not in the current view — always in its own group. */
export interface GraphHistoricalItem {
  assertionId: string;
  predicate: string;
  subject: string;
  object: string;
  validAt: string;
  knownAt: string;
  supportedBy: string[];
  /** Why it is historical: superseded within the window, or outside it. */
  reason: 'not-in-current-view';
}

export interface GraphContextPack {
  /** The current, trusted items, ordered by rank — the order a budget trim shortens. */
  items: GraphContextItem[];
  /** Supporting records cited by `items`, each listed once (item 5). */
  evidence: GraphContextEvidence[];
  /** Disagreements touching this pack, whole (item 6). */
  conflicts: GraphConflictGroup[];
  /** Supported history of the visible slice that is NOT current (item 8). */
  historical: GraphHistoricalItem[];
  /** The traversal bounds that produced `items`, carried through unchanged. */
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

function producerOf(a: GraphAssertion): GraphContextEvidence['producers'][number] {
  return {
    principalId: a.provenance.principalId,
    actorId: a.provenance.actorId,
    clientId: a.provenance.clientId,
  };
}

/**
 * Assemble the pack from a projection and the result of one expansion over it.
 *
 * The whole {@link GraphExpansionResult} is taken, not just its list, so the traversal report
 * travels WITH the items it bounded — a pack whose budget report could be supplied separately
 * could be assembled with someone else's report, and the truncation signal is exactly the thing
 * that must not be able to drift from the list it describes.
 *
 * The expansion layer's rank order is preserved verbatim; re-sorting here would make the pack's
 * order depend on two places instead of one. Everything else — evidence, conflicts, history — is
 * derived from the projection, so a pack can never cite an assertion the viewer was not
 * authorized to see.
 */
export function assembleGraphContext(
  projection: GraphProjection,
  expansion: GraphExpansionResult,
  opts: GraphContextOpts = {},
): GraphContextPack {
  const expansions: readonly GraphExpansion[] = expansion.expansions;
  const byId = new Map(projection.current.map((a) => [a.id, a]));

  const items: GraphContextItem[] = [];
  // ref → the evidence entry being accumulated. Insertion order is first-cited order, which follows
  // the rank order of `items` — so a budget trim drops the LEAST relevant evidence last.
  const evidence = new Map<
    string,
    { assertionIds: Set<string>; producers: Map<string, GraphContextEvidence['producers'][number]> }
  >();
  const citedAssertionIds = new Set<string>();

  for (const expansion of expansions) {
    const evidenceRefs: string[] = [];
    const seen = new Set<string>();
    for (const step of expansion.path) {
      citedAssertionIds.add(step.assertionId);
      const assertion = byId.get(step.assertionId);
      for (const ref of step.supportedBy) {
        if (!seen.has(ref)) {
          seen.add(ref);
          evidenceRefs.push(ref);
        }
        let entry = evidence.get(ref);
        if (entry === undefined) {
          entry = { assertionIds: new Set(), producers: new Map() };
          evidence.set(ref, entry);
        }
        entry.assertionIds.add(step.assertionId);
        if (assertion !== undefined) {
          const producer = producerOf(assertion);
          entry.producers.set(
            `${producer.principalId} ${producer.actorId} ${producer.clientId}`,
            producer,
          );
        }
      }
    }
    items.push({
      ref: expansion.ref,
      origin: expansion.distance === 0 ? 'seed' : 'connected',
      distance: expansion.distance,
      rank: expansion.rank,
      seedScore: expansion.seedScore,
      seedChannel: expansion.seedChannel,
      evidenceEligible: expansion.evidenceEligible,
      path: expansion.path,
      evidenceRefs,
    });
  }

  // A conflict is included when the pack touches ANY of its members — by a cited assertion, or by
  // an item standing on the subject the members disagree about. Showing one side of a disagreement
  // without saying a disagreement exists would be worse than showing neither side.
  const itemRefs = new Set(items.map((i) => i.ref));
  const canonicalOf = (ref: string): string => projection.aliases.canonical[ref] ?? ref;
  const conflicts = projection.conflicts.filter(
    (group) =>
      group.assertionIds.some((id) => citedAssertionIds.has(id)) ||
      itemRefs.has(canonicalOf(group.subject)) ||
      group.objects.some((object) => itemRefs.has(canonicalOf(object))),
  );

  const historical: GraphHistoricalItem[] =
    opts.includeHistorical === false
      ? []
      : projection.timeline
          .filter((a) => !byId.has(a.id))
          .filter(
            (a) => itemRefs.has(canonicalOf(a.subject)) || itemRefs.has(canonicalOf(a.object)),
          )
          .map((a) => ({
            assertionId: a.id,
            predicate: a.predicate,
            subject: a.subject,
            object: a.object,
            validAt: a.validAt,
            knownAt: a.knownAt,
            supportedBy: [...a.supportedBy],
            reason: 'not-in-current-view' as const,
          }));

  return {
    items,
    evidence: [...evidence.entries()].map(([ref, entry]) => ({
      ref,
      assertionIds: [...entry.assertionIds].sort(),
      producers: [...entry.producers.values()].sort((a, b) =>
        a.principalId !== b.principalId
          ? a.principalId < b.principalId
            ? -1
            : 1
          : a.actorId !== b.actorId
            ? a.actorId < b.actorId
              ? -1
              : 1
            : a.clientId < b.clientId
              ? -1
              : 1,
      ),
    })),
    conflicts,
    historical,
    traversal: expansion.report,
    degraded: [...(opts.degraded ?? [])],
    budgetTokens: opts.budgetTokens ?? GRAPH_DEFAULT_CONTEXT_TOKENS,
  };
}
