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

/** The content generation of one authorized view (see the module law). */
export function graphViewGeneration(projection: GraphProjection): string {
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

/** Seeds from the plain recall projection — already authorized by recall itself. */
export function recallSeeds(recalled: Record<string, unknown> | undefined): GraphSeed[] {
  if (recalled === undefined || !Array.isArray(recalled.hits)) return [];
  return recalled.hits.flatMap((hit) => {
    const view = hit as { id?: unknown; score?: unknown };
    return typeof view.id === 'string' && typeof view.score === 'number'
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
 * `context`: the pack for the largest rank-ordered prefix of expansions that fits the budget. The
 * pack is REBUILT for each candidate prefix, so a trimmed pack never cites a relation, history
 * entry, conflict or supporter that only a dropped item touched.
 */
export function fitGraphContext(
  graph: GraphProjection,
  expanded: GraphExpansionResult,
  maxTokens: number,
): Record<string, unknown> {
  const build = (prefix: GraphExpansionResult['expansions']) =>
    buildGraphContextPack(graph, prefix, expanded.report, { budgetTokens: maxTokens });
  const fitted = fitTokenBudget(expanded.expansions, maxTokens, (prefix) =>
    JSON.stringify({ context: build(prefix), budgetExhausted: true }),
  );
  const context = build(fitted.items);
  return {
    context: fitted.budgetExhausted
      ? { ...context, traversal: { ...context.traversal, truncated: true } }
      : context,
    ...(fitted.budgetExhausted ? { budgetExhausted: true } : {}),
  };
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

/** Union seeds from several channels by ref, keeping each ref's best score (channel of the best). */
export function mergeGraphSeeds(...channels: GraphSeed[][]): GraphSeed[] {
  const best = new Map<string, GraphSeed>();
  for (const seed of channels.flat()) {
    const current = best.get(seed.ref);
    if (current === undefined || seed.score > current.score) best.set(seed.ref, seed);
  }
  return [...best.values()].sort((a, b) =>
    a.score !== b.score ? b.score - a.score : a.ref < b.ref ? -1 : 1,
  );
}
