/**
 * WP-G5 — the serving laws of `memory_graph`, kept pure so they can be tested without a ledger.
 *
 * `Verbs.memoryConnectedGraph` gathers the authorized projection and recall seeds; everything
 * that decides WHAT a response may contain lives here:
 *
 *  - **Generation.** A response names the content generation of the exact view it was computed
 *    from: a digest over the viewer, the time window, the trusted current view, the alias state,
 *    and the conflict groups. Two requests over the same authorized view agree; any change a
 *    reader could observe moves it.
 *  - **Cursors are bound, not merely positioned.** A continuation carries the generation AND a
 *    digest of the principal plus every query parameter. Replaying it under another principal,
 *    with other filters, or after the graph moved is refused as `CURSOR_STALE` — a stale page is
 *    never silently re-based onto a different answer.
 *  - **Explicit seeds must be graph nodes of the authorized view.** A ref the viewer's projection
 *    does not contain is reported back as unresolved (it is the caller's own input) and never
 *    becomes a distance-0 result, so a foreign id cannot be laundered into an answer or a count.
 */
import { createHash } from 'node:crypto';
import type {
  GraphAssertion,
  GraphExpansion,
  GraphExpansionResult,
  GraphPathStep,
  GraphProjection,
  GraphSeed,
} from '@knowledge-crib/memory';
import {
  GRAPH_PATH_MAX_HOPS,
  MEMORY_GRAPH_PREDICATES,
  buildGraphContextPack,
  exportGraphProjection,
  graphPath,
  isMemoryGraphPredicate,
} from '@knowledge-crib/memory';
import { type GraphCompletionCandidate, GraphFitLedger } from './graph-fit-ledger.js';
import { fitTokenBudget } from './token-budget.js';

export const MEMORY_GRAPH_OPS = ['search', 'neighbors', 'path', 'history', 'context'] as const;
export type MemoryGraphOp = (typeof MEMORY_GRAPH_OPS)[number];

/** The query identity a cursor is bound to. The principal is server-derived, never caller-supplied. */
export interface MemoryGraphQueryIdentity {
  principalId: string;
  op: MemoryGraphOp;
  q?: string;
  refs?: readonly string[];
  scope?: string;
  at?: string;
  knownBy?: string;
  hops?: number;
  predicates?: readonly string[];
}

interface CursorBody {
  v: 1;
  g: string;
  q: string;
  o: number;
}

export type CursorDecode =
  | { ok: true; offset: number }
  | { ok: false; code: 'BAD_REQUEST' | 'CURSOR_STALE'; message: string };

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

// Both derivations below are pure functions of an immutable projection and cost O(assertions), so
// they are memoized per projection object: a cached view pays for them once, not per request.
const generationMemo = new WeakMap<GraphProjection, string>();
const nodesMemo = new WeakMap<GraphProjection, Set<string>>();

/** The content generation of one authorized view (see the module law). */
export function graphViewGeneration(projection: GraphProjection): string {
  const memo = generationMemo.get(projection);
  if (memo !== undefined) return memo;
  const generation = computeGraphViewGeneration(projection);
  generationMemo.set(projection, generation);
  return generation;
}

function computeGraphViewGeneration(projection: GraphProjection): string {
  return sha256(
    JSON.stringify({
      viewer: projection.viewer,
      at: projection.at ?? null,
      knownBy: projection.knownBy ?? null,
      aliases: projection.aliases,
      conflicts: projection.conflicts,
      current: exportGraphProjection(projection),
    }),
  );
}

/** Digest of the query identity. Arrays are order-normalized so equivalent queries agree. */
export function graphQueryDigest(identity: MemoryGraphQueryIdentity): string {
  return sha256(
    JSON.stringify({
      principalId: identity.principalId,
      op: identity.op,
      q: identity.q ?? '',
      refs: [...(identity.refs ?? [])],
      scope: identity.scope ?? 'global',
      at: identity.at ?? null,
      knownBy: identity.knownBy ?? null,
      hops: identity.hops ?? null,
      predicates: [...(identity.predicates ?? [])].sort(),
    }),
  );
}

export function encodeGraphCursor(generation: string, queryDigest: string, offset: number): string {
  const body: CursorBody = { v: 1, g: generation, q: queryDigest, o: offset };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function decodeGraphCursor(
  cursor: string | undefined,
  generation: string,
  queryDigest: string,
): CursorDecode {
  if (cursor === undefined) return { ok: true, offset: 0 };
  let body: Partial<CursorBody>;
  try {
    body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorBody>;
  } catch {
    return { ok: false, code: 'BAD_REQUEST', message: 'cursor is not a memory_graph cursor' };
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    body.v !== 1 ||
    typeof body.g !== 'string' ||
    typeof body.q !== 'string' ||
    typeof body.o !== 'number' ||
    !Number.isInteger(body.o) ||
    body.o < 0
  ) {
    return { ok: false, code: 'BAD_REQUEST', message: 'cursor is not a memory_graph cursor' };
  }
  if (body.q !== queryDigest) {
    return {
      ok: false,
      code: 'CURSOR_STALE',
      message: 'cursor belongs to a different query or principal; start a fresh query',
    };
  }
  if (body.g !== generation) {
    return {
      ok: false,
      code: 'CURSOR_STALE',
      message: 'the graph generation changed since this cursor was issued; start a fresh query',
    };
  }
  return { ok: true, offset: body.o };
}

/** Every canonical node of the authorized current view (alias members included). */
export function authorizedGraphNodes(projection: GraphProjection): Set<string> {
  const memo = nodesMemo.get(projection);
  if (memo !== undefined) return memo;
  const nodes = new Set<string>();
  const canonical = (ref: string): string => projection.aliases.canonical[ref] ?? ref;
  for (const assertion of projection.current) {
    nodes.add(assertion.subject);
    nodes.add(assertion.object);
    nodes.add(canonical(assertion.subject));
    nodes.add(canonical(assertion.object));
  }
  for (const [member, representative] of Object.entries(projection.aliases.canonical)) {
    if (nodes.has(representative)) nodes.add(member);
  }
  nodesMemo.set(projection, nodes);
  return nodes;
}

/** Split explicit refs into authorized seeds and the caller's unresolved input. */
export function authorizeExplicitSeeds(
  projection: GraphProjection,
  refs: readonly string[],
): { seeds: GraphSeed[]; unresolvedRefs: string[] } {
  const nodes = authorizedGraphNodes(projection);
  const seeds: GraphSeed[] = [];
  const unresolvedRefs: string[] = [];
  for (const ref of [...new Set(refs)]) {
    if (nodes.has(ref)) seeds.push({ ref, score: 1, channel: 'explicit' });
    else unresolvedRefs.push(ref);
  }
  return { seeds, unresolvedRefs };
}

// ─── op helpers ──────────────────────────────────────────────────────────────

/** The page a paged op serves: bound to one generation and one query digest. */
export interface MemoryGraphPage {
  generation: string;
  digest: string;
  offset: number;
  maxTokens: number;
}

interface MemoryGraphArgs {
  q?: string;
  refs?: string[];
  hops?: number;
  predicates?: string[];
  cursor?: string;
}

/** A request an op cannot answer honestly is refused before any graph is read. */
export function memoryGraphRequestError(op: string, args: MemoryGraphArgs): string | undefined {
  if (!(MEMORY_GRAPH_OPS as readonly string[]).includes(op)) {
    return `unknown memory_graph op '${op}'; expected one of ${MEMORY_GRAPH_OPS.join(', ')}`;
  }
  const refs = args.refs ?? [];
  if ((op === 'neighbors' || op === 'history') && refs.length === 0) {
    return `memory_graph op '${op}' requires refs`;
  }
  if (op === 'path' && refs.length !== 2) {
    return "memory_graph op 'path' requires exactly two refs: [from, to]";
  }
  if (op === 'context' && args.cursor !== undefined) {
    return "memory_graph op 'context' is a single token-bounded pack; it does not accept a cursor";
  }
  const unknown = (args.predicates ?? []).filter((p) => !isMemoryGraphPredicate(p));
  if (unknown.length > 0) {
    return `unknown graph predicate(s): ${unknown.join(', ')}; expected ${MEMORY_GRAPH_PREDICATES.join(', ')}`;
  }
  return undefined;
}

/**
 * Seeds from the plain recall projection — already authorized by recall itself. WP2 natural-zero
 * floor: a hit with `score <= 0` is dropped — zero is the FTS scorer's identity element, and a
 * zero-score "hit" never carries the ranking information a seed needs.
 */
export function recallSeeds(recalled: Record<string, unknown> | undefined): GraphSeed[] {
  if (recalled === undefined || !Array.isArray(recalled.hits)) return [];
  return recalled.hits.flatMap((hit) => {
    const view = hit as { id?: unknown; score?: unknown };
    return typeof view.id === 'string' && typeof view.score === 'number' && view.score > 0
      ? [{ ref: view.id, score: view.score, channel: 'semantic' as const }]
      : [];
  });
}

function pathStep(a: GraphAssertion): GraphPathStep {
  return {
    assertionId: a.id,
    predicate: a.predicate,
    subject: a.subject,
    object: a.object,
    supportedBy: [...a.supportedBy],
  };
}

/** `path`: the shortest authorized path between two authorized refs, or `null`. */
export function memoryGraphPathResult(
  graph: GraphProjection,
  args: MemoryGraphArgs,
): Record<string, unknown> {
  const [from, to] = args.refs as [string, string];
  const { unresolvedRefs } = authorizeExplicitSeeds(graph, [from, to]);
  const maxHops = Math.min(
    Math.max(Math.floor(args.hops ?? GRAPH_PATH_MAX_HOPS), 0),
    GRAPH_PATH_MAX_HOPS,
  );
  const found = unresolvedRefs.length > 0 ? null : graphPath(graph, from, to, { maxHops });
  return {
    from,
    to,
    path: found === null ? null : found.map(pathStep),
    report: { maxHops, found: found !== null },
    ...(unresolvedRefs.length > 0 ? { unresolvedRefs } : {}),
  };
}

/** `history`: the supported timeline touching the refs, with the disagreements and aliases on them. */
export function memoryGraphHistoryResult(
  graph: GraphProjection,
  args: MemoryGraphArgs,
  page: MemoryGraphPage,
): Record<string, unknown> {
  const { seeds, unresolvedRefs } = authorizeExplicitSeeds(graph, args.refs ?? []);
  const canonical = (ref: string): string => graph.aliases.canonical[ref] ?? ref;
  const wanted = new Set(seeds.map((s) => canonical(s.ref)));
  const current = new Set(graph.current.map((a) => a.id));
  const touching = graph.timeline.filter(
    (a) => wanted.has(canonical(a.subject)) || wanted.has(canonical(a.object)),
  );
  const entries = touching.map((a) => ({
    ...pathStep(a),
    validAt: a.validAt,
    knownAt: a.knownAt,
    state: current.has(a.id) ? ('current' as const) : ('historical' as const),
  }));
  const remaining = entries.slice(page.offset);
  const fitted = fitTokenBudget(remaining, page.maxTokens, (prefix) =>
    JSON.stringify({ timeline: prefix, truncated: true, budgetExhausted: true }),
  );
  const next = page.offset + Math.max(fitted.items.length, remaining.length > 0 ? 1 : 0);
  return {
    timeline: fitted.items,
    conflicts: graph.conflicts.filter(
      (g) => wanted.has(canonical(g.subject)) || g.objects.some((o) => wanted.has(canonical(o))),
    ),
    aliases: graph.aliases.bindings.filter(
      (b) => wanted.has(canonical(b.entityA)) || wanted.has(canonical(b.entityB)),
    ),
    report: { total: entries.length, truncated: next < entries.length },
    ...(next < entries.length
      ? { nextCursor: encodeGraphCursor(page.generation, page.digest, next) }
      : {}),
    ...(fitted.budgetExhausted ? { budgetExhausted: true } : {}),
    ...(unresolvedRefs.length > 0 ? { unresolvedRefs } : {}),
  };
}

/**
 * `context`: the pack for the largest rank-ordered prefix of expansions that fits the budget,
 * completed (S5) so the connections the answer depends on are still stated after the trim. The
 * pack is REBUILT from the final kept list, so a trimmed pack never cites a relation, history
 * entry, conflict or supporter that only a dropped item touched — except the completion's own
 * citations, which are exactly the connections the trim orphaned.
 *
 * S5 — pack completion: ONE deterministic queue of append and citation candidates, placed
 * greedily while they fit, re-run to a global fixed point:
 *
 *  1. **Appends first, then citations.** An append states a whole multi-hop chain at once —
 *     its path is the multi-hop story — so it outranks isolated connections when both compete
 *     for the same slack (round 2: the reverse order let cheap noise citations consume the
 *     slack a chain-carrying append needed, starving it). Within appends, candidates are
 *     ordered by the newest assertion on the append's own path, then the trim's nearest misses
 *     (partner rank, descending), then ref.
 *  2. **Citations, one connection at a time.** A CURRENT relation whose kept endpoint made the
 *     pack but whose partner was reached and then trimmed is still stated — cited into the pack
 *     with its supporters and producer. Each citation is placed on its OWN marginal cost
 *     (round 2: partner-group gating starved the cheapest connection behind group-mates that
 *     did not fit), ordered by marginal cost ascending — the budget buys the most connections —
 *     then by the partner group's total cost ascending (a group that fits alone is tried before
 *     a group whose members compete), then the current view's own recency (later-known first),
 *     then partner rank, predicate order, assertion id, partner ref.
 *  3. **Kept-anchored citations.** A kept item's CURRENT assertion whose OTHER endpoint was
 *     never reached at all — not even trimmed — may still be cited when that endpoint is itself
 *     item-eligible under S3: the assertion is lawful content of this view, and the kept anchor
 *     is the only route it has into the pack. These place LAST (they are bonus connections, not
 *     trim orphans) and never add an item.
 *  4. **Appends state only new information.** A still-dropped expansion — never reordering the
 *     prefix — is appended only when it would state something new: a relation to a kept
 *     endpoint, a history entry it touches, a path step the pack does not already cite, a
 *     disagreement it newly includes. Zero-information appends are skipped.
 *
 * The queue re-runs to a GLOBAL fixed point: an append can newly orphan a relation worth citing,
 * and a citation can make a later append zero-information.
 *
 * **Tail displacement (round 2).** When the queue exhausts with candidates still blocked by the
 * budget, the completion trials removing the pack's tail — the lowest-value KEPT item, in fit
 * order — and re-runs the queue with the freed slack: the removed item's orphaned relations and
 * path steps become citation candidates themselves (cite-backs), so nothing is lost silently.
 * TWO displacement trials run per pack (the spender and banker lineages — see
 * `runDisplacementTrial`), each removing up to five tail items, and a trial is committed ONLY
 * when the final pack states STRICTLY more distinct assertions than the pack it started from —
 * a displacement that merely trades an item's citations for equal ones is reverted (the
 * primary ledger is never mutated; each trial runs on a fork). Measured round-0, unbounded tail
 * trades were a net-zero lottery; bounded, cite-backed, and value-tested, they recover answers
 * that were one tail away.
 *
 * Every measure goes through an exact ledger of the serialized pack (graph-fit-ledger.ts) —
 * O(kept + cited) per candidate, never a full pack rebuild, which is what the round-0
 * implementation did per candidate per fixed-point pass and measured as a ~3.5s p95
 * context-assembly regression against the 500ms gate. `completion` (default on) is the test
 * switch; `itemEligible` is the S3 item set — appended items pass the same filter the expansion
 * layer already applied.
 */
export function fitGraphContext(
  graph: GraphProjection,
  expanded: GraphExpansionResult,
  maxTokens: number,
  opts: { completion?: boolean; itemEligible?: ReadonlySet<string> } = {},
): Record<string, unknown> {
  const ledger = new GraphFitLedger(graph, expanded.report, {
    budgetTokens: maxTokens,
    ...(opts.itemEligible !== undefined ? { itemEligible: opts.itemEligible } : {}),
  });
  const fitted = fitTokenBudget(expanded.expansions, maxTokens, (prefix) => {
    ledger.rebuild(prefix);
    return ledger.serialize();
  });
  const kept = [...fitted.items];
  let finalKept = kept;
  let citations: string[] = [];
  // Round 2: the completion runs even when the prefix kept everything — the kept-anchored
  // citation channel needs no trim to have happened, and a pack that kept all its expansions
  // can still have unreached, item-eligible connections worth stating into leftover slack.
  if (opts.completion !== false) {
    ledger.rebuild(kept);
    // S5 completion: one deterministic queue of appends and citations, placed greedily while
    // they fit, re-run to a global fixed point — an append can newly orphan a relation worth
    // citing, and a citation can make a later append zero-information.
    let pass = placeCompletionCandidates(ledger, expanded.expansions, maxTokens);
    while (pass.placed) {
      pass = placeCompletionCandidates(ledger, expanded.expansions, maxTokens);
    }
    let winner = ledger;
    if (pass.blocked) {
      const trial = displaceTailCandidates(ledger, expanded.expansions, maxTokens);
      if (trial !== null) winner = trial;
    }
    citations = winner.completionCitations();
    finalKept = winner.keptList();
  }
  const exhausted = finalKept.length < expanded.expansions.length;
  const context = buildGraphContextPack(graph, finalKept, expanded.report, {
    budgetTokens: maxTokens,
    ...(opts.itemEligible !== undefined ? { itemEligible: opts.itemEligible } : {}),
    ...(citations.length > 0 ? { citedAssertionIds: citations } : {}),
  });
  return {
    context: exhausted
      ? { ...context, traversal: { ...context.traversal, truncated: true } }
      : context,
    ...(exhausted ? { budgetExhausted: true } : {}),
  };
}

/**
 * One pass of S5 completion: the append channel, then the citation channel (per-connection,
 * with kept-anchored connections last), each placed greedily while it fits, in the one
 * deterministic order fitGraphContext documents. The spender's salvage pass swaps the first
 * two channels — citations before appends — per the salvage note below; the banker's final
 * pass (`bank: true`) keeps appends first and re-keys their order to the append's NEW-CITATION
 * count, because the bank exists to afford a whole item the per-iteration slack never could.
 *
 * The append channel appends a still-dropped expansion when it would state something new
 * (`newCitationCount > 0`, measured against the LIVE pack). The citation channel states one
 * connection at a time, in S5's rank order — the strongest-reached partner's connection first,
 * the cheapest among equals — so a partner group with one affordable member no longer drags it
 * behind group-mates that do not fit. Kept-anchored connections — a kept item's assertion to an
 * endpoint that was never reached, when that endpoint is item-eligible — place after both.
 *
 * The tail-displacement trial runs this same pass as a SALVAGE pass (`salvage: true`): its
 * budget is slack the primary could not spend, and it is the primary's mirror. The citation
 * channel places before the append channel — connections the pack already anchors state before
 * any new whole item buys a place — and the cite order's lead key inverts to partner rank
 * ASCENDING: the partners the primary's own rank ordering reached LAST are exactly the ones the
 * freed slack should reach FIRST, with marginal cost only breaking ties. The primary completes
 * the pack top-down (strongest partners first); the salvage fills the freed slack bottom-up, so
 * every partner group gets a turn before any gets a second connection. The salvage may still
 * only ADOPT states that are strict citation supersets of everything before them, so this
 * order extends what the pack says but never trades one assertion for another.
 *
 * Preconditions are re-checked live at placement: a partner kept within the pass cancels its own
 * append and its citations, a citation placed within the pass can empty a later append of its
 * information, and every placement is budget-checked through the exact ledger. Candidates that
 * do not fit are reported as `blocked` so fitGraphContext can try the tail-displacement trial
 * against them. Returns whether anything was placed, so the caller can re-run the channels to a
 * global fixed point.
 */
function placeCompletionCandidates(
  ledger: GraphFitLedger,
  expansions: readonly GraphExpansion[],
  maxTokens: number,
  opts?: { salvage?: boolean; bank?: boolean },
): { placed: boolean; blocked: boolean } {
  const expansionRefs = new Set(expansions.map((e) => e.ref));
  let placed = false;
  let blocked = false;
  const newestFirst = (a: string | undefined, b: string | undefined): number =>
    (a ?? '') < (b ?? '') ? 1 : (a ?? '') > (b ?? '') ? -1 : 0;

  // ── appends: the multi-hop chain's own channel ──
  const runAppends = (): void => {
    const appends: Extract<GraphCompletionCandidate, { kind: 'append' }>[] = [];
    for (const partner of expansions) {
      if (ledger.isKept(partner.ref)) continue;
      if (!ledger.eligibleItem(partner.ref)) continue;
      // An append that would state nothing the pack does not already cite never places, so it is
      // not even queued — its new-information count is measured against the CURRENT pack state.
      if (ledger.newCitationCount(partner) > 0) {
        let pathRecency = '';
        for (const step of partner.path) {
          const knownAt = ledger.knownAtOf(step.assertionId) ?? '';
          if (knownAt > pathRecency) pathRecency = knownAt;
        }
        appends.push({
          kind: 'append',
          partner,
          recency: pathRecency,
          partnerRank: partner.rank,
          predicate: '',
        });
      }
    }
    // The primary and the spender order appends by the chain's own recency and partner strength.
    // The banker's final pass inverts the lead key to partner rank ASCENDING — the same mirror
    // as its citations: the bank exists to afford whole items the per-iteration slack never
    // could, and the partners the primary's rank ordering starved longest are the first that
    // should claim it.
    appends.sort(
      (a, b) =>
        (opts?.bank === true
          ? a.partnerRank - b.partnerRank
          : newestFirst(a.recency, b.recency) || b.partnerRank - a.partnerRank) ||
        (a.partner.ref < b.partner.ref ? -1 : a.partner.ref > b.partner.ref ? 1 : 0),
    );
    for (const candidate of appends) {
      if (ledger.isKept(candidate.partner.ref)) continue;
      if (ledger.newCitationCount(candidate.partner) === 0) continue;
      if (ledger.tokensWith(candidate.partner) <= maxTokens) {
        ledger.add(candidate.partner);
        placed = true;
      } else {
        blocked = true;
      }
    }
  };

  // ── citations: one connection at a time ──
  const runCites = (): void => {
    type CiteCandidate = {
      id: string;
      assertion: GraphAssertion;
      recency: string;
      partnerRank: number;
      predicate: string;
      partnerRef: string;
      groupKey: string;
      /** This citation's own cost above the CURRENT pack — the salvage order's tiebreak key. */
      marginal: number;
    };
    const cites: CiteCandidate[] = [];
    const groupCostOf = new Map<string, number>();
    const addCite = (candidate: CiteCandidate): void => {
      cites.push(candidate);
      groupCostOf.set(
        candidate.groupKey,
        (groupCostOf.get(candidate.groupKey) ?? 0) + candidate.marginal,
      );
    };
    // — trim-orphan citations: a reached-and-trimmed partner's current relations to kept items —
    for (const partner of expansions) {
      if (ledger.isKept(partner.ref)) continue;
      if (!ledger.eligibleItem(partner.ref)) continue;
      for (const assertion of ledger.currentEdgesOf(partner.ref)) {
        const other = ledger.otherEndpointOf(assertion, partner.ref);
        if (other === null || !ledger.isKept(other)) continue;
        if (ledger.isCited(assertion.id)) continue;
        const marginal = ledger.tokensWithCitation(assertion.id) - ledger.tokens();
        addCite({
          id: assertion.id,
          assertion,
          recency: assertion.knownAt,
          partnerRank: partner.rank,
          predicate: assertion.predicate,
          partnerRef: partner.ref,
          groupKey: partner.ref,
          marginal,
        });
      }
    }
    // S5's own ordering principle — "in rank order" — leads for the primary's completion: the
    // connection to the strongest-reached partner completes first, and the cheapest connection
    // wins among equals. A cheaper connection to a weakly-reached partner can no longer crowd
    // out a dearer one to the partner the channels themselves ranked highest. The salvage pass
    // inverts the lead key — partner rank ASCENDING — because its budget is freed slack the
    // primary could not spend: the partners the primary's rank order reached LAST are exactly
    // the ones the freed slack should reach FIRST, and marginal cost only breaks ties. The
    // primary spends top-down; the salvage spends the freed slack bottom-up.
    cites.sort(
      (a, b) =>
        (opts?.salvage === true ? a.partnerRank - b.partnerRank : b.partnerRank - a.partnerRank) ||
        a.marginal - b.marginal ||
        (groupCostOf.get(a.groupKey) ?? 0) - (groupCostOf.get(b.groupKey) ?? 0) ||
        newestFirst(a.recency, b.recency) ||
        (a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
        (a.partnerRef < b.partnerRef ? -1 : 1),
    );
    for (const candidate of cites) {
      if (ledger.isCited(candidate.id)) continue;
      if (ledger.tokensWithCitation(candidate.id) <= maxTokens) {
        ledger.cite(candidate.id);
        placed = true;
      } else {
        blocked = true;
      }
    }
  };

  // ── kept-anchored connections: a kept item's assertion to an endpoint never reached ──
  const runAnchored = (): void => {
    const anchored: {
      id: string;
      assertion: GraphAssertion;
      keptRef: string;
      marginal: number;
    }[] = [];
    for (const item of ledger.keptList()) {
      if (!ledger.eligibleItem(item.ref)) continue;
      for (const assertion of ledger.currentEdgesOf(item.ref)) {
        const other = ledger.otherEndpointOf(assertion, item.ref);
        // Only the never-reached qualify here: a reached partner is the citation channel's own
        // case, and a kept one is already a relation. The S3 item-eligibility of the far endpoint
        // is the defense — an assertion whose far end could not legally be an item is not stated.
        if (other === null || expansionRefs.has(other)) continue;
        if (!ledger.eligibleItem(other)) continue;
        if (ledger.isCited(assertion.id)) continue;
        anchored.push({
          id: assertion.id,
          assertion,
          keptRef: item.ref,
          marginal: ledger.tokensWithCitation(assertion.id) - ledger.tokens(),
        });
      }
    }
    anchored.sort(
      (a, b) =>
        a.marginal - b.marginal ||
        newestFirst(a.assertion.knownAt, b.assertion.knownAt) ||
        (a.assertion.predicate < b.assertion.predicate
          ? -1
          : a.assertion.predicate > b.assertion.predicate
            ? 1
            : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
        (a.keptRef < b.keptRef ? -1 : 1),
    );
    for (const candidate of anchored) {
      if (ledger.isCited(candidate.id)) continue;
      if (ledger.tokensWithCitation(candidate.id) <= maxTokens) {
        ledger.cite(candidate.id);
        placed = true;
      } else {
        blocked = true;
      }
    }
  };

  // The primary completes top-down: whole items first, then the strongest partner's connections.
  // The salvage pass is the primary's mirror in ORDER, not in channel sequence — its cite order's
  // lead key inverts to partner rank ASCENDING (below), and in the BANKER's final pass (below)
  // the appends claim the bank first, ordered by the assertions they would newly state. The
  // spender's per-iteration pass still runs citations before appends: connections the pack
  // already anchors state before any new whole item buys a place with the per-iteration slack.
  if (opts?.salvage === true && opts?.bank !== true) {
    runCites();
    runAppends();
  } else {
    runAppends();
    runCites();
  }
  runAnchored();

  return { placed, blocked };
}

/**
 * The round-2 tail displacement trial: TWO forks of the fitted ledger, each removing up to five
 * tail items, arbitration picking the winner — because a single greedy lineage cannot both spend
 * each removal's slack immediately and preserve the CONTIGUOUS mass a whole-item append needs.
 *
 * The SPENDER spends as it strips: after each removal it restores, then runs the salvage
 * completion pass (citations before appends, cite order partner-rank ASCENDING) to fixed point,
 * and each fixed point is a candidate. The BANKER does not spend: it strips and restores only,
 * banking every removal's freed mass until the cap or an unproductive tail, then spends the
 * whole bank in ONE final pass whose appends claim the mass first, ordered by the number of
 * assertions they would newly state. The spender's per-removal slack is small and fragmented —
 * cheap connections crowd out exactly the whole items the primary could never afford; the
 * banker's accumulated bank is the only place those items fit, so both lineages run and the
 * arbitration below picks the state that says more.
 *
 * Each removal takes the LAST item-eligible kept expansion in fit order — the pack's own
 * lowest-value tail, which strips completion appends in reverse order before it ever touches a
 * prefix item — but a removal is a trade, not a gift: whatever it retracts (path steps,
 * relations, historical entries, conflict bodies) goes to `placeRestorationCites` FIRST, so the
 * trial puts the reader's assertions back before it spends the freed slack on anything new. The
 * restored cites also empty the tail's own `newCitationCount`, which breaks the re-append cycle
 * where a removed tail — still able to state its dead relations — simply bought its own place
 * back and the trial ended where it started. The spender undoes a removal that enables no
 * placement at all and moves on to the next tail — a removal that bought nothing alone is
 * remembered, not retried; the banker undoes a removal that bills more than it
 * freed — a tail whose restoration cites outweigh its mass cannot grow the bank, so stripping
 * stops. Five removals, not two: the first strips a completion append and the second often the
 * next one, both of which the restoration channel can re-cite nearly whole, and the third and
 * fourth — prefix items, with real item mass no citation channel had been able to compress —
 * free the slack the blocked candidates need. The fifth is for the pack that adopts at its
 * fourth removal still one connection short: one more tail item's mass — sometimes an item
 * whose assertions the trial's own earlier cites already cover, so the restoration channel bills
 * nothing — is what closes the gap.
 *
 * After each of the spender's removals' fixed points — and after the banker's final pass — the
 * state is a CANDIDATE, and a candidate is adopted within its own trial only when it is a
 * strict citation superset of everything before it: nothing the primary stated may be dropped,
 * nothing the best-so-far stated may be dropped, and the candidate must state strictly more
 * than the best. An adopted state therefore only ever GROWS in stated assertions — a
 * displacement may extend what the pack says, never trade one assertion for another, and a
 * lossy late removal (a restoration cite that no longer fits) can only leave an earlier,
 * smaller candidate standing, never regress it. A trial with no adopting candidate is dropped
 * wholesale — `cite()` is not reversible, so the primary ledger is never touched by a failed
 * trial.
 *
 * Arbitration between the two trials' candidates applies the same law one level up: a candidate
 * that would drop any of the primary's citations is disqualified outright; otherwise the one
 * that states more assertions wins, then the one that kept more of the items the PRIMARY
 * already fit (less collateral damage to a pack the primary lawfully packed beats chasing
 * upside), then the one that keeps more CONTENT items the primary could not fit — a record or
 * intake (`mem:`/`intake:`), whose body exists nowhere else in the pack, unlike an entity,
 * topic or symbol whose information rides relations its members state — then the one that
 * spends fewer tokens; a full tie keeps the spender, whose every adoption was already
 * greedy-verified removal by removal.
 */
function displaceTailCandidates(
  primary: GraphFitLedger,
  expansions: readonly GraphExpansion[],
  maxTokens: number,
): GraphFitLedger | null {
  const spender = runDisplacementTrial(primary, expansions, maxTokens, { bank: false });
  const banker = runDisplacementTrial(primary, expansions, maxTokens, { bank: true });
  if (spender === null) return banker;
  if (banker === null) return spender;
  if (banker.droppedCitationsFrom(primary).length > 0) return spender;
  if (spender.droppedCitationsFrom(primary).length > 0) return banker;
  const bankCited = banker.citedCount();
  const spendCited = spender.citedCount();
  if (bankCited !== spendCited) return bankCited > spendCited ? banker : spender;
  const primaryKept = new Set(primary.keptList().map((item) => item.ref));
  const preservedKeptOf = (trial: GraphFitLedger): number =>
    trial.keptList().reduce((n, item) => (primaryKept.has(item.ref) ? n + 1 : n), 0);
  const bankPreserved = preservedKeptOf(banker);
  const spendPreserved = preservedKeptOf(spender);
  if (bankPreserved !== spendPreserved) return bankPreserved > spendPreserved ? banker : spender;
  const isContentItem = (ref: string): boolean =>
    ref.startsWith('mem:') || ref.startsWith('intake:');
  const newlyKeptContentOf = (trial: GraphFitLedger): number =>
    trial
      .keptList()
      .reduce((n, item) => (!primaryKept.has(item.ref) && isContentItem(item.ref) ? n + 1 : n), 0);
  const bankContent = newlyKeptContentOf(banker);
  const spendContent = newlyKeptContentOf(spender);
  if (bankContent !== spendContent) return bankContent > spendContent ? banker : spender;
  return banker.tokens() < spender.tokens() ? banker : spender;
}

/**
 * One lineage of the tail displacement trial — see `displaceTailCandidates` for the portfolio.
 * The spender (`bank: false`) is the strip-spend loop; the banker (`bank: true`) strips and
 * restores only, then spends the accumulated bank in one final rank-mirrored completion pass.
 */
function runDisplacementTrial(
  primary: GraphFitLedger,
  expansions: readonly GraphExpansion[],
  maxTokens: number,
  opts: { bank: boolean },
): GraphFitLedger | null {
  const trial = primary.fork();
  let best: GraphFitLedger | null = null;
  let bestCited = primary.citedCount();
  const consider = (): void => {
    if (trial.droppedCitationsFrom(primary).length > 0) return;
    if (best !== null && trial.droppedCitationsFrom(best).length > 0) return;
    // The trial presents its best candidate under the same value order the arbitration applies:
    // most stated assertions first, and among states stating the same set, the one that spends
    // fewer tokens. A later iteration that holds every citation the snapshot holds while
    // freeing mass is strictly the better presentation of the same purchase.
    const cited = trial.citedCount();
    if (
      cited > bestCited ||
      (best !== null && cited === bestCited && trial.tokens() < best.tokens())
    ) {
      best = trial.fork();
      bestCited = cited;
    }
  };
  // A tail whose removal bought nothing is REMEMBERED, not retried: the loop undoes the removal
  // and moves on to the next tail instead of stopping the search — an unproductive removal only
  // proves THAT item's mass could not be spent alone, not that the tail holds no further trade
  // (a later item's mass, added to what this one could not use, is often exactly the gap the
  // blocked candidates need). The cap still bounds the search.
  const unproductive = new Set<string>();
  for (let removals = 0; removals < 5; removals += 1) {
    const eligibleKept = trial
      .keptList()
      .filter((e) => trial.eligibleItem(e.ref) && !unproductive.has(e.ref));
    if (eligibleKept.length <= 1) break;
    const tail = eligibleKept[eligibleKept.length - 1];
    if (tail === undefined) break;
    if (opts.bank) {
      // Bank the mass, do not spend it: restore what the removal retracted and continue
      // stripping. A removal that billed more than it freed cannot grow the bank — undo it.
      const before = trial.tokens();
      const retracted = trial.removeCollecting(tail.ref);
      placeRestorationCites(trial, retracted, maxTokens);
      if (trial.tokens() > before) {
        trial.add(tail);
        break;
      }
      continue;
    }
    const retracted = trial.removeCollecting(tail.ref);
    const restored = placeRestorationCites(trial, retracted, maxTokens);
    const first = placeCompletionCandidates(trial, expansions, maxTokens, { salvage: true });
    if (!restored.placed && !first.placed) {
      // This removal freed slack nothing could use — undo it and try the next tail. The stripped
      // state is still considered as a candidate: a removal that retracts nothing states the
      // same assertions as before while spending fewer tokens, which is the better presentation
      // of the same purchase.
      consider();
      trial.add(tail);
      unproductive.add(tail.ref);
      continue;
    }
    let pass = first;
    while (pass.placed) {
      pass = placeCompletionCandidates(trial, expansions, maxTokens, { salvage: true });
    }
    consider();
  }
  if (opts.bank) {
    // The bank is whole: appends claim it first in the rank-mirrored order (the partners the
    // primary's ordering starved longest claim the bank first), then the connection channels
    // spend what remains.
    let pass = placeCompletionCandidates(trial, expansions, maxTokens, {
      salvage: true,
      bank: true,
    });
    while (pass.placed) {
      pass = placeCompletionCandidates(trial, expansions, maxTokens, { salvage: true, bank: true });
    }
    consider();
  }
  return best;
}

/**
 * The displacement trial's first channel: put back what the removal took. Every retracted id —
 * a path step, a relation, a historical entry, a conflict body — goes back as a citation,
 * cheapest first, while the budget allows. A cited id resolves freely in the pack builder, so a
 * retracted relation or conflict body states again even with its item gone; the ids another
 * channel still serves never reach this list. What does not fit stays lost, and the trial's
 * value test accounts for it.
 */
function placeRestorationCites(
  ledger: GraphFitLedger,
  retracted: readonly string[],
  maxTokens: number,
): { placed: boolean } {
  const restorations: { id: string; marginal: number }[] = [];
  for (const id of retracted) {
    if (ledger.assertionOf(id) === undefined || ledger.isCited(id)) continue;
    restorations.push({ id, marginal: ledger.tokensWithCitation(id) - ledger.tokens() });
  }
  restorations.sort((a, b) => a.marginal - b.marginal || (a.id < b.id ? -1 : 1));
  let placed = false;
  for (const candidate of restorations) {
    if (ledger.isCited(candidate.id)) continue;
    if (ledger.tokensWithCitation(candidate.id) <= maxTokens) {
      ledger.cite(candidate.id);
      placed = true;
    }
  }
  return { placed };
}

/**
 * Plain recall does not know the read point. When the projection is historical (`at`/`knownBy`),
 * a recall seed survives only if it is a node of that windowed, authorized view — so a claim
 * recorded after `knownBy` cannot re-enter a historical answer through the recall channel.
 */
export function timeBoundRecallSeeds(graph: GraphProjection, seeds: GraphSeed[]): GraphSeed[] {
  if (graph.at === undefined && graph.knownBy === undefined) return seeds;
  const nodes = authorizedGraphNodes(graph);
  return seeds.filter((seed) => nodes.has(seed.ref));
}
