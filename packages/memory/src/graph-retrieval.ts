import type { GraphProjection } from './graph-projection.js';
import { GRAPH_PATH_MAX_HOPS } from './graph-projection.js';
/**
 * WP-G5 — connected retrieval: the PURE expansion + ranking layer that turns a set of seed refs
 * (found by the existing lexical/semantic recall, which this module never replaces) into a bounded,
 * deterministically ranked neighbourhood of the authorized projection.
 *
 * The laws, each a direct reading of the plan's WP-G5 items and §2 defaults:
 *
 *  - **Additive, never substitutive (item 1).** This module takes seeds; it does not find them.
 *    Plain recall keeps its own behaviour and its own frozen gates, and a caller that never asks
 *    for expansion gets exactly what it got before. A seed carries its ORIGINAL text-search score
 *    untouched through to the output (item 4) — the graph rank is reported beside it, never folded
 *    into it, because the two are not the same kind of number and neither is calibrated confidence.
 *
 *  - **Fixed traversal budget (item 2, §2 defaults).** Two hops by default, four maximum; at most
 *    {@link GRAPH_MAX_VISITED_NODES} nodes visited and {@link GRAPH_MAX_EXAMINED_EDGES} edges
 *    examined per request. Every bound that BITES is reported in `truncationReasons` — a truncated
 *    walk is a page of the neighbourhood, never the neighbourhood, and the WP-G2/G6 honesty law
 *    says a limit must be visible rather than inferred from a short list.
 *
 *  - **Deterministic ranking (item 3).** `rank = seedScore × DECAY^distance × evidenceFactor`,
 *    ordered by (rank desc, distance asc, ref asc). Every input is a stated number and the final
 *    tie-break is the stable ref, so the same projection and seeds produce the same order on every
 *    machine and every run. Distance is measured to the NEAREST seed; a node reachable from two
 *    seeds takes the better of the two, which is why expansion runs as one multi-source BFS rather
 *    than per-seed walks that would have to be merged afterwards.
 *
 *  - **Evidence eligibility is the caller's to state.** The projection has already excluded every
 *    unsupported assertion from `current`, so being traversable here means "supported". Whether a
 *    supporter is also RECALL-ELIGIBLE (admitted, valid, not retracted) is a trust question this
 *    pure layer cannot answer, so the caller passes `eligibleSupporters`. A path whose every edge
 *    is backed by an eligible supporter ranks above one that is merely supported, and the
 *    difference is reported per expansion as `evidenceEligible` rather than silently priced in.
 *    Passing no set at all means "the caller does not distinguish" — every supported edge counts
 *    as eligible, which keeps the pure layer usable without a trust oracle.
 *
 *  - **Authorization is not re-implemented here.** Every assertion this module can see already
 *    passed WP-G2's principal + scope + support gates on its way into `projection.current`. There
 *    is no path in this file that reads an assertion from anywhere else, which is what makes "a
 *    connected answer can never widen the authorized set" structural rather than a checklist item.
 */
import type { GraphAssertion } from './types.js';

/** §2 default traversal depth. Two hops answers "what touches this, and what touches that". */
export const GRAPH_DEFAULT_HOPS = 2;

/** §2 hard ceiling on nodes visited in one request. */
export const GRAPH_MAX_VISITED_NODES = 200;

/** §2 hard ceiling on edges examined in one request. */
export const GRAPH_MAX_EXAMINED_EDGES = 500;

/**
 * Per-hop rank decay. A directly connected claim outranks a two-hop one at equal seed relevance,
 * which is the whole point of bounding the walk; 0.5 makes each hop cost as much as halving the
 * seed's own relevance, so a weak seed's neighbour never outranks a strong seed's neighbour at the
 * same distance. Stated as a constant because the ranking must be reproducible by inspection.
 */
export const GRAPH_HOP_DECAY = 0.5;

/** The rank multiplier for a path NOT wholly backed by recall-eligible supporters. */
export const GRAPH_INELIGIBLE_EVIDENCE_FACTOR = 0.5;

/** A starting point for expansion, carrying the retrieval score that found it. */
export interface GraphSeed {
  /** The traversal ref (`mem:`/`topic:`/`sym:`/…) the seed names. */
  ref: string;
  /** The ORIGINAL retrieval score, preserved verbatim into the output (item 4). */
  score: number;
  /** Which retrieval channel produced the seed — reported, never used to re-score. */
  channel: 'exact' | 'lexical' | 'semantic' | 'explicit';
}

export interface GraphTraversalBudget {
  /** Hops from a seed; defaults to {@link GRAPH_DEFAULT_HOPS}, capped at {@link GRAPH_PATH_MAX_HOPS}. */
  hops?: number;
  maxNodes?: number;
  maxEdges?: number;
}

/** Which bound stopped the walk. An empty list means the neighbourhood was exhausted. */
export type GraphTruncationReason = 'hops' | 'nodes' | 'edges';

export interface GraphTraversalReport {
  visitedNodes: number;
  examinedEdges: number;
  /** True when ANY bound bit — the result is a page of the neighbourhood, not the neighbourhood. */
  truncated: boolean;
  truncationReasons: GraphTruncationReason[];
  /** The bounds actually applied, after defaulting and capping — so a caller can see what it got. */
  budget: Required<GraphTraversalBudget>;
}

/** One step of the explanation: which assertion was traversed, and what it says. */
export interface GraphPathStep {
  assertionId: string;
  predicate: string;
  subject: string;
  object: string;
  /** The assertion's supporters, verbatim — the evidence path the plan requires in context packs. */
  supportedBy: string[];
}

export interface GraphExpansion {
  /** The canonical ref reached (alias-folded by the projection). */
  ref: string;
  /** Hops from the NEAREST seed; 0 for a seed itself. */
  distance: number;
  /** The seed this expansion's shortest path started from. */
  seedRef: string;
  /** The seed's own retrieval score, unchanged (item 4 — the two scores stay distinct). */
  seedScore: number;
  seedChannel: GraphSeed['channel'];
  /** The graph explanation: the assertions traversed, in order. Empty for a seed. */
  path: GraphPathStep[];
  /** True when every edge on the path is backed by a recall-eligible supporter. */
  evidenceEligible: boolean;
  /** Deterministic ordering score. NOT a calibrated confidence (item 4). */
  rank: number;
}

export interface GraphExpansionResult {
  expansions: GraphExpansion[];
  report: GraphTraversalReport;
}

function clampHops(hops: number | undefined): number {
  const value = hops ?? GRAPH_DEFAULT_HOPS;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), GRAPH_PATH_MAX_HOPS);
}

function clampCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  return Math.min(Math.floor(value), fallback);
}

function canonical(projection: GraphProjection, ref: string): string {
  return projection.aliases.canonical[ref] ?? ref;
}

function step(assertion: GraphAssertion): GraphPathStep {
  return {
    assertionId: assertion.id,
    predicate: assertion.predicate,
    subject: assertion.subject,
    object: assertion.object,
    supportedBy: [...assertion.supportedBy],
  };
}

/**
 * Build the canonical adjacency of the trusted current view, once per request. Edges are sorted by
 * id inside each bucket so the BFS expands in a stable order regardless of the projection's array
 * order — the determinism the ranking's tie-break depends on.
 */
function adjacency(
  projection: GraphProjection,
  predicates: ReadonlySet<string> | undefined,
): Map<string, GraphAssertion[]> {
  const byNode = new Map<string, GraphAssertion[]>();
  for (const assertion of projection.current) {
    if (predicates !== undefined && !predicates.has(assertion.predicate)) continue;
    const subject = canonical(projection, assertion.subject);
    const object = canonical(projection, assertion.object);
    for (const node of subject === object ? [subject] : [subject, object]) {
      let edges = byNode.get(node);
      if (edges === undefined) {
        edges = [];
        byNode.set(node, edges);
      }
      edges.push(assertion);
    }
  }
  for (const edges of byNode.values()) edges.sort((a, b) => (a.id < b.id ? -1 : 1));
  return byNode;
}

function pathEligible(path: GraphPathStep[], eligible: ReadonlySet<string> | undefined): boolean {
  if (eligible === undefined) return true;
  return path.every((s) => s.supportedBy.some((ref) => eligible.has(ref)));
}

function rankOf(seedScore: number, distance: number, evidenceEligible: boolean): number {
  const decay = GRAPH_HOP_DECAY ** distance;
  return seedScore * decay * (evidenceEligible ? 1 : GRAPH_INELIGIBLE_EVIDENCE_FACTOR);
}

export interface GraphExpansionOpts extends GraphTraversalBudget {
  /** Restrict traversal to these predicates (the plan's relation filter). Absent = every predicate. */
  predicates?: readonly string[];
  /** Supporter refs the CALLER considers recall-eligible. Absent = the caller does not distinguish. */
  eligibleSupporters?: ReadonlySet<string>;
}

/**
 * Expand a bounded neighbourhood from `seeds` over the authorized current view.
 *
 * One multi-source BFS, not one walk per seed: a node reachable from two seeds is recorded at its
 * SHORTEST distance, and among equal distances the seed with the higher score wins (ties broken by
 * seed ref) — so the result does not depend on the order the caller listed its seeds in. Seeds
 * themselves are returned as distance-0 expansions with an empty path, which is what lets a caller
 * render seeds and their connections through one ordered list.
 */
export function expandFromSeeds(
  projection: GraphProjection,
  seeds: readonly GraphSeed[],
  opts: GraphExpansionOpts = {},
): GraphExpansionResult {
  const budget: Required<GraphTraversalBudget> = {
    hops: clampHops(opts.hops),
    maxNodes: clampCount(opts.maxNodes, GRAPH_MAX_VISITED_NODES),
    maxEdges: clampCount(opts.maxEdges, GRAPH_MAX_EXAMINED_EDGES),
  };
  const predicates = opts.predicates === undefined ? undefined : new Set(opts.predicates);
  const byNode = adjacency(projection, predicates);
  const reasons = new Set<GraphTruncationReason>();

  // One claim per canonical ref: the FIRST one wins, and the first one is already the best.
  //
  // Two properties make that true, and neither is a tie-break rule:
  //   - the walk is a level-by-level BFS, so a ref is first reached at its SHORTEST distance from
  //     any seed — a later, longer claim can never be an improvement;
  //   - seeds enter the frontier in (score desc, ref asc) order and every later frontier is built
  //     by expanding the previous one in place, so among equal distances the claim that lands
  //     first is the one from the best-scoring seed.
  // A comparison here would therefore be unreachable code reading as the law while the sort and
  // the BFS silently did the work. The sort is also what makes an over-budget seed set drop its
  // LEAST relevant members rather than whichever the caller happened to list last.
  const best = new Map<string, GraphExpansion>();

  const ordered = [...seeds].sort((a, b) =>
    a.score !== b.score ? b.score - a.score : a.ref < b.ref ? -1 : 1,
  );

  let examinedEdges = 0;
  let frontier: GraphExpansion[] = [];
  for (const seed of ordered) {
    const ref = canonical(projection, seed.ref);
    const expansion: GraphExpansion = {
      ref,
      distance: 0,
      seedRef: seed.ref,
      seedScore: seed.score,
      seedChannel: seed.channel,
      path: [],
      evidenceEligible: true,
      rank: rankOf(seed.score, 0, true),
    };
    // A duplicate seed — or two seeds the alias fold maps onto one canonical ref — is already
    // recorded under its better-scoring form.
    if (best.has(ref)) continue;
    if (best.size >= budget.maxNodes) {
      reasons.add('nodes');
      continue;
    }
    best.set(ref, expansion);
    frontier.push(expansion);
  }

  for (let hop = 1; hop <= budget.hops && frontier.length > 0; hop += 1) {
    const next: GraphExpansion[] = [];
    for (const from of frontier) {
      for (const edge of byNode.get(from.ref) ?? []) {
        if (examinedEdges >= budget.maxEdges) {
          reasons.add('edges');
          break;
        }
        examinedEdges += 1;
        const subject = canonical(projection, edge.subject);
        const other = subject === from.ref ? canonical(projection, edge.object) : subject;
        if (other === from.ref) continue; // a self-edge reaches nothing new
        const path = [...from.path, step(edge)];
        const evidenceEligible = pathEligible(path, opts.eligibleSupporters);
        const candidate: GraphExpansion = {
          ref: other,
          distance: hop,
          seedRef: from.seedRef,
          seedScore: from.seedScore,
          seedChannel: from.seedChannel,
          path,
          evidenceEligible,
          rank: rankOf(from.seedScore, hop, evidenceEligible),
        };
        if (best.has(other)) continue;
        if (best.size >= budget.maxNodes) {
          reasons.add('nodes');
          continue;
        }
        best.set(other, candidate);
        next.push(candidate);
      }
      if (examinedEdges >= budget.maxEdges) break;
    }
    frontier = next;
  }

  // The hop bound bit only if something was still reachable when it ran out.
  if (budget.hops > 0 && frontier.length > 0 && byNode.size > 0) {
    for (const from of frontier) {
      if ((byNode.get(from.ref) ?? []).length > 0) {
        reasons.add('hops');
        break;
      }
    }
  } else if (budget.hops === 0 && best.size > 0) {
    for (const expansion of best.values()) {
      if ((byNode.get(expansion.ref) ?? []).length > 0) {
        reasons.add('hops');
        break;
      }
    }
  }

  const expansions = [...best.values()].sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.ref < b.ref ? -1 : 1;
  });

  return {
    expansions,
    report: {
      visitedNodes: best.size,
      examinedEdges,
      truncated: reasons.size > 0,
      truncationReasons: [...reasons].sort(),
      budget,
    },
  };
}

// ─── graph-side seed selection ───────────────────────────────────────────────

/**
 * The seed scorer's identity, reported on every response that used it. Stated as a version so a
 * change to tokenization or scoring is a visible change, never a silent re-tuning.
 */
export const GRAPH_SEED_SCORER_VERSION = 'graph-seed-v1:term-overlap';

/** Seeds taken per query — the same page size plain recall defaults to. */
export const GRAPH_DEFAULT_SEED_LIMIT = 5;

/** Function words that carry no retrieval signal. A generic English list, not a corpus list. */
const GRAPH_STOPWORDS = new Set([
  'about',
  'across',
  'after',
  'and',
  'any',
  'are',
  'before',
  'both',
  'but',
  'by',
  'can',
  'did',
  'does',
  'each',
  'for',
  'from',
  'has',
  'have',
  'how',
  'into',
  'its',
  'now',
  'of',
  'other',
  'show',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'this',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

/**
 * Normalized retrieval terms: camelCase and every non-alphanumeric run split, lower-cased, tokens
 * shorter than three characters and stopwords dropped, and a trailing plural `s` folded — so
 * `settleOrder`, `settle-order` and "settle orders" meet on the same terms.
 */
export function graphTerms(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const out = new Set<string>();
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || GRAPH_STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return [...out];
}

/**
 * Lexical seeds over the AUTHORIZED graph: every candidate is a node of an assertion in the
 * projection's current or historical view — both already bounded by the read point — so a seed can never name something
 * the viewer cannot see or something not yet known at `knownBy`. `texts` supplies the searchable
 * text for a node (a record's claim, an entity's name); a node without text is matched on its ref.
 *
 * Score = distinct query terms present in the node's terms ÷ distinct query terms — a proportion,
 * not a calibrated confidence. Ties break by ref, so the selection is deterministic.
 */
export function selectGraphSeeds(
  projection: GraphProjection,
  query: string,
  texts: ReadonlyMap<string, string>,
  opts: { limit?: number } = {},
): GraphSeed[] {
  const queryTerms = graphTerms(query);
  if (queryTerms.length === 0) return [];
  const nodes = new Set<string>();
  for (const assertion of [...projection.current, ...projection.historical]) {
    nodes.add(assertion.subject);
    nodes.add(assertion.object);
  }
  const scored: GraphSeed[] = [];
  for (const ref of nodes) {
    const terms = new Set([...graphTerms(ref), ...graphTerms(texts.get(ref) ?? '')]);
    const matched = queryTerms.filter((term) => terms.has(term)).length;
    if (matched === 0) continue;
    scored.push({ ref, score: matched / queryTerms.length, channel: 'lexical' });
  }
  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.ref < b.ref ? -1 : 1));
  return scored.slice(0, Math.max(0, opts.limit ?? GRAPH_DEFAULT_SEED_LIMIT));
}
