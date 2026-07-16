/**
 * Cross-repo federation (M3.2) — a RUNTIME layer over independent souls.
 *
 * Each soul stays one-repo, independent, deterministic, committed-clean. This module loads N souls
 * and exposes a federated blast-radius traversal that hops a repo-A outbound HTTP client call
 * (`http-call` node, schema 1.5) to the repo-B `route` node it resolves to — matched by
 * `{httpMethod, routePath}` — WITHOUT committing a cross-repo edge. The bridge is a deterministic
 * computation over the two souls (same inputs → same hops), not persisted state, so the
 * `--extracted-only` byte-identical invariant holds per-repo.
 *
 * Why runtime, not committed: a committed A→B edge would (a) dangle when repo B is absent/renamed,
 * (b) make repo A's soul non-deterministic w.r.t. repo B's history, and (c) violate the one-soul-
 * per-repo storage contract. The P4 `packageRoots` precedent deliberately keeps a UNIFIED soul for
 * intra-repo multi-package; cross-repo is a strictly harder contract (different repos, different
 * histories) so it lives above storage, not in it.
 *
 * The traversal reuses the existing `calls` edge (enclosing function → http-call) + `exposes` edge
 * (handler → route) — no new Rel. The only new graph artifact is the `http-call` NodeKind (1.5).
 */
import { join } from 'node:path';
import type { Edge, Node, NodeKind } from '@knowledge-crib/soul-schema';
import type { Dir } from './index-store.js';
import { SoulStore } from './soul-store.js';

/** One loaded soul in a federation, keyed by its repo root (absolute). */
export interface FederatedSoul {
  root: string;
  soul: SoulStore;
}

/** A federated graph: N loaded souls + the route/call indexes that drive the cross-repo hop. */
export interface Federation {
  souls: FederatedSoul[];
  /** route index: `METHOD path` → the routes (across all souls) serving it. */
  routes: Map<string, Array<{ soulRoot: string; node: Node }>>;
  /** http-call index: every outbound call site, grouped by soul, for the reverse hop. */
  httpCalls: Array<{ soulRoot: string; node: Node }>;
  /** per-soul adjacency: down = src→edges, up = dst→edges. Built once per load. */
  adjacency: Map<string, { down: Map<string, Edge[]>; up: Map<string, Edge[]> }>;
}

/** Load N souls (read-only) from their repo roots and build the federation indexes. */
export function loadFederation(roots: string[]): Federation {
  const souls: FederatedSoul[] = [];
  for (const root of roots) {
    const cribDir = join(root, '.crib');
    const soul = new SoulStore(cribDir);
    soul.load();
    souls.push({ root, soul });
  }
  const routes = new Map<string, Array<{ soulRoot: string; node: Node }>>();
  const httpCalls: Array<{ soulRoot: string; node: Node }> = [];
  const adjacency = new Map<string, { down: Map<string, Edge[]>; up: Map<string, Edge[]> }>();
  for (const { root, soul } of souls) {
    const down = new Map<string, Edge[]>();
    const up = new Map<string, Edge[]>();
    for (const e of soul.iterateEdges()) {
      push(down, e.src, e);
      push(up, e.dst, e);
    }
    adjacency.set(root, { down, up });
    for (const n of soul.iterate('route' as NodeKind)) {
      const key = routeKey(n.httpMethod ?? '', n.routePath ?? '');
      if (!key) continue;
      let bucket = routes.get(key);
      if (!bucket) {
        bucket = [];
        routes.set(key, bucket);
      }
      bucket.push({ soulRoot: root, node: n });
    }
    for (const n of soul.iterate('http-call' as NodeKind)) {
      httpCalls.push({ soulRoot: root, node: n });
    }
  }
  return { souls, routes, httpCalls, adjacency };
}

/** A federated impact traversal result. */
export interface FederatedImpactResult {
  root: string;
  dir: Dir;
  affected: Array<{
    id: string;
    soul: string;
    rel: string;
    distance: number;
    risk: 'high' | 'medium' | 'low';
    crossRepo: boolean;
  }>;
  crossRepoHops: number;
  truncated: boolean;
}

const DEFAULT_FED_DEPTH = 3;
const MAX_FED_DEPTH = 6;
const DEFAULT_FED_LIMIT = 200;
const MAX_FED_LIMIT = 1000;

/**
 * Federated blast-radius BFS. Starts at `id` in the start soul, walks `dir` up to `depth`, and
 * crosses to other souls when it reaches an `http-call` (dir down → serving route in repo B) or a
 * `route` (dir up → calling http-call in repo A). Each hop carries `crossRepo: true` so a consumer
 * can see exactly where the traversal left the start repo.
 */
export function federatedImpact(
  fed: Federation,
  startRoot: string,
  id: string,
  dir: Dir,
  opts: { depth?: number; limit?: number; extractedOnly?: boolean } = {},
): FederatedImpactResult {
  const startSoul = fed.souls.find((s) => s.root === startRoot);
  const startNode = startSoul?.soul.getNode(id);
  if (!startSoul || !startNode) {
    return { root: startRoot, dir, affected: [], crossRepoHops: 0, truncated: false };
  }
  const depth = clamp(opts.depth, DEFAULT_FED_DEPTH, MAX_FED_DEPTH);
  const limit = clamp(opts.limit, DEFAULT_FED_LIMIT, MAX_FED_LIMIT);
  const extractedOnly = opts.extractedOnly ?? false;

  type Front = { soulRoot: string; id: string };
  const visited = new Set<string>();
  const key = (f: Front) => `${f.soulRoot}::${f.id}`;
  const start: Front = { soulRoot: startRoot, id };
  visited.add(key(start));
  const affected: FederatedImpactResult['affected'] = [];
  let crossRepoHops = 0;
  let frontier: Front[] = [start];

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: Front[] = [];
    for (const cur of frontier) {
      const adj = fed.adjacency.get(cur.soulRoot);
      if (!adj) continue;
      const edges = dir === 'down' ? (adj.down.get(cur.id) ?? []) : (adj.up.get(cur.id) ?? []);
      const node = fed.souls.find((s) => s.root === cur.soulRoot)?.soul.getNode(cur.id);
      // In-soul neighbors (the normal BFS step).
      for (const e of edges) {
        if (extractedOnly && e.provenance !== 'EXTRACTED') continue;
        const nbId = dir === 'down' ? e.dst : e.src;
        const nb: Front = { soulRoot: cur.soulRoot, id: nbId };
        if (visited.has(key(nb))) continue;
        visited.add(key(nb));
        next.push(nb);
        affected.push({
          id: nbId,
          soul: cur.soulRoot,
          rel: e.rel,
          distance: d,
          risk: d === 1 ? 'high' : d === 2 ? 'medium' : 'low',
          crossRepo: false,
        });
      }
      // Cross-repo hop: http-call (dir down) → serving routes in OTHER souls; route (dir up) →
      // calling http-calls in OTHER souls. Deterministic match by method+path-template.
      for (const hop of crossRepoNeighbors(fed, cur, node, dir)) {
        if (visited.has(key(hop))) continue;
        visited.add(key(hop));
        next.push(hop);
        crossRepoHops++;
        affected.push({
          id: hop.id,
          soul: hop.soulRoot,
          rel: 'calls-route',
          distance: d,
          risk: d === 1 ? 'high' : d === 2 ? 'medium' : 'low',
          crossRepo: true,
        });
      }
    }
    frontier = next;
  }
  const truncated = affected.length > limit;
  return {
    root: startRoot,
    dir,
    affected: truncated ? affected.slice(0, limit) : affected,
    crossRepoHops,
    truncated,
  };
}

/**
 * The cross-repo neighbors of `cur` (a node in one soul) reached via the route-layer bridge.
 *   - dir down + http-call → routes in OTHER souls matching {method, path}.
 *   - dir up + route → http-calls in OTHER souls matching {method, path}.
 * Other node kinds / directions yield nothing (the bridge only binds calls↔routes).
 */
function crossRepoNeighbors(
  fed: Federation,
  cur: { soulRoot: string; id: string },
  node: Node | undefined,
  dir: Dir,
): Array<{ soulRoot: string; id: string }> {
  if (!node) return [];
  const out: Array<{ soulRoot: string; id: string }> = [];
  if (dir === 'down' && node.kind === 'http-call') {
    const callMethod = node.httpMethod ?? '';
    const callPath = node.routePath ?? '';
    for (const { soulRoot, node: route } of iterateRouteMatches(fed, callMethod, callPath)) {
      if (soulRoot === cur.soulRoot) continue; // bridge crosses repos, not within.
      out.push({ soulRoot, id: route.id });
    }
  } else if (dir === 'up' && node.kind === 'route') {
    const routeMethod = node.httpMethod ?? '';
    const routePath = node.routePath ?? '';
    for (const call of fed.httpCalls) {
      if (call.soulRoot === cur.soulRoot) continue;
      if (
        routeMatches(call.node.httpMethod ?? '', call.node.routePath ?? '', routeMethod, routePath)
      ) {
        out.push({ soulRoot: call.soulRoot, id: call.node.id });
      }
    }
  }
  return out;
}

/** Yield every route (in any soul) whose method+path-template matches the given call. */
function* iterateRouteMatches(
  fed: Federation,
  callMethod: string,
  callPath: string,
): Generator<{ soulRoot: string; node: Node }> {
  // Fast path: exact method+path key (a templated call `` `/api/loans/${id}` `` → `/api/loans/:id`
  // matches a route emitted as `/api/loans/:id` by string equality).
  const exactKey = routeKey(callMethod, callPath);
  const exact = exactKey ? fed.routes.get(exactKey) : undefined;
  if (exact) {
    for (const r of exact) yield r;
  }
  // Slow path: template match across ALL routes (handles a concrete call `/api/loans/123` against
  // a `/api/loans/:id` route). Bounded by the route count; the fast path already covered the
  // common templated-call case.
  for (const [, bucket] of fed.routes) {
    for (const r of bucket) {
      if (routeMatches(callMethod, callPath, r.node.httpMethod ?? '', r.node.routePath ?? '')) {
        // The exact-key bucket already yielded these; avoid double-yield on the fast-path overlap
        // by skipping entries whose key equals the exact key.
        if (exact && routeKey(r.node.httpMethod ?? '', r.node.routePath ?? '') === exactKey) {
          continue;
        }
        yield r;
      }
    }
  }
}

/**
 * Does a call `{callMethod, callPath}` resolve to a route `{routeMethod, routePath}`?
 *   - method: route `ANY` matches any call; else exact (case-insensitive).
 *   - path: segment-by-segment, equal length. A route param segment (`:x` / `{x}`) matches any
 *     call segment (literal OR param). A route literal segment matches a call literal iff equal,
 *     and does NOT match a call param (a templated call is more general than a literal route).
 * Trailing slashes are normalized; a `?query` suffix on the call is stripped.
 */
export function routeMatches(
  callMethod: string,
  callPath: string,
  routeMethod: string,
  routePath: string,
): boolean {
  if (routeMethod !== 'ANY' && routeMethod.toUpperCase() !== callMethod.toUpperCase()) return false;
  const cp = normalizePath(callPath);
  const rp = normalizePath(routePath);
  if (cp === rp) return true;
  const cs = cp.split('/').filter((s) => s.length > 0);
  const rs = rp.split('/').filter((s) => s.length > 0);
  if (cs.length !== rs.length) return false;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const r = rs[i]!;
    const rParam = isParamSegment(r);
    const cParam = isParamSegment(c);
    if (rParam) continue; // route param matches any call segment.
    if (cParam) return false; // call param is more general than a literal route segment.
    if (c !== r) return false;
  }
  return true;
}

/** `METHOD path` lookup key for the route index, or undefined if either part is empty. */
function routeKey(method: string, path: string): string | undefined {
  if (!method || !path) return undefined;
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function isParamSegment(seg: string): boolean {
  return seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}'));
}

function normalizePath(p: string): string {
  // Strip a `?query` suffix (a call may carry query params the route template omits) + collapse
  // a trailing slash so `/x/` and `/x` are equivalent. Local var — never reassign the parameter.
  let out = p;
  const q = out.indexOf('?');
  if (q >= 0) out = out.slice(0, q);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function push(map: Map<string, Edge[]>, id: string, e: Edge): void {
  let list = map.get(id);
  if (!list) {
    list = [];
    map.set(id, list);
  }
  list.push(e);
}

function clamp(v: number | undefined, def: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  if (v < 1) return 1;
  if (v > max) return max;
  return Math.floor(v);
}
