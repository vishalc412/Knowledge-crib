/**
 * Cross-repo federation (M3.2) — unit + 2-soul integration coverage.
 *
 * Two layers are pinned here:
 *   1. `routeMatches` — the path-template matcher that binds a repo-A `http-call` to a repo-B
 *      `route` by {httpMethod, routePath}. Exact equality, route-param (`:x`/`{x}`) wildcard, the
 *      `ANY` method wildcard, `?query` strip, trailing-slash normalize, and the asymmetry rule
 *      (a templated CALL is more general than a literal ROUTE → no match).
 *   2. `federatedImpact` — the BFS that hops repos via the route-layer bridge. Down from a repo-A
 *      `fetchLoan` reaches the repo-B `route` (crossRepo=true); up from the repo-B `route` reaches
 *      the repo-A `http-call` and its enclosing `fetchLoan` (crossRepo=true). A single-repo call
 *      does NOT cross (crossRepoHops=0). `extractedOnly` drops INFERRED in-soul neighbors.
 *
 * Souls are built in-memory (putNodes/putEdges/commit) — no git, no TS — so the federation logic
 * is tested deterministically, independent of the extractor that produces the nodes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { federatedImpact, loadFederation, routeMatches } from './federation.js';
import { newManifest } from './manifest.js';
import { SoulStore } from './soul-store.js';

const NOW = '2026-01-01T00:00:00.000Z';
let dirs: string[] = [];
beforeEach(() => {
  dirs = [mkdtempSync(join(tmpdir(), 'crib-fed-a-')), mkdtempSync(join(tmpdir(), 'crib-fed-b-'))];
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function open(repoRoot: string): SoulStore {
  // loadFederation reads `join(root, '.crib')`, so the soul must live under <root>/.crib — treat
  // each tmpdir as a repo root, not a .crib dir.
  const s = new SoulStore(join(repoRoot, '.crib'), { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}

function fnNode(path: string, name: string, line: number): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: name, startLine: line }),
    kind: 'symbol',
    type: 'function',
    name,
    qualifiedName: name,
    file: path,
    span: { start: line, end: line + 2 },
    lang: 'typescript',
    hash: contentHash(`${path}#${name}`),
  };
}

function httpCall(method: string, path: string, file: string, line: number): Node {
  return {
    id: idFor({ kind: 'http-call', httpMethod: method, routePath: path, file, line }),
    kind: 'http-call',
    name: `${method} ${path}`,
    httpMethod: method,
    routePath: path,
    framework: 'fetch',
    file,
    span: { start: line, end: line },
    lang: 'typescript',
    hash: contentHash(`http-call:${method}:${path}`),
  };
}

function route(method: string, path: string, file: string, line: number): Node {
  return {
    id: idFor({ kind: 'route', httpMethod: method, routePath: path, file, line }),
    kind: 'route',
    name: `${method} ${path}`,
    httpMethod: method,
    routePath: path,
    framework: 'express',
    file,
    span: { start: line, end: line },
    lang: 'typescript',
    hash: contentHash(`route:${method}:${path}`),
  };
}

function edge(
  src: Node,
  dst: Node,
  rel: Edge['rel'],
  provenance: Edge['provenance'] = 'EXTRACTED',
  conf = 1.0,
): Edge {
  return {
    id: edgeId(src.id, dst.id, rel),
    src: src.id,
    dst: dst.id,
    rel,
    method: 'static',
    provenance,
    confidence: conf,
  };
}

describe('routeMatches — the path-template bridge matcher', () => {
  it('exact method+path equality matches', () => {
    expect(routeMatches('GET', '/api/loans', 'GET', '/api/loans')).toBe(true);
  });
  it('method is case-insensitive', () => {
    expect(routeMatches('get', '/x', 'GET', '/x')).toBe(true);
    expect(routeMatches('POST', '/x', 'post', '/x')).toBe(true);
  });
  it('route ANY method matches any call method', () => {
    expect(routeMatches('GET', '/x', 'ANY', '/x')).toBe(true);
    expect(routeMatches('DELETE', '/x', 'ANY', '/x')).toBe(true);
  });
  it('mismatched method does not match', () => {
    expect(routeMatches('GET', '/x', 'POST', '/x')).toBe(false);
  });
  it('a route :param segment matches any call segment (literal or param)', () => {
    expect(routeMatches('GET', '/api/loans/123', 'GET', '/api/loans/:id')).toBe(true);
    expect(routeMatches('GET', '/api/loans/:id', 'GET', '/api/loans/:id')).toBe(true);
    expect(routeMatches('GET', '/api/loans/{id}', 'GET', '/api/loans/:id')).toBe(true);
  });
  it('a templated CALL does NOT match a literal ROUTE (call is more general)', () => {
    expect(routeMatches('GET', '/api/loans/:id', 'GET', '/api/loans/123')).toBe(false);
  });
  it('segment count mismatch does not match', () => {
    expect(routeMatches('GET', '/api/loans', 'GET', '/api/loans/:id')).toBe(false);
    expect(routeMatches('GET', '/api/loans/1/2', 'GET', '/api/loans/:id')).toBe(false);
  });
  it('a literal segment mismatch does not match', () => {
    expect(routeMatches('GET', '/api/users/1', 'GET', '/api/loans/:id')).toBe(false);
  });
  it('strips a ?query suffix on the call and normalizes a trailing slash', () => {
    expect(routeMatches('GET', '/api/loans/123?expand=1', 'GET', '/api/loans/:id')).toBe(true);
    expect(routeMatches('GET', '/api/loans/', 'GET', '/api/loans')).toBe(true);
  });
});

describe('federatedImpact — 2-soul route-layer bridge', () => {
  /** Build the canonical fixture: repoA fetchLoan→http-call; repoB handler→route. */
  function fixture(): {
    rootA: string;
    rootB: string;
    fetchLoan: Node;
    call: Node;
    handler: Node;
    rt: Node;
  } {
    const rootA = dirs[0]!;
    const rootB = dirs[1]!;
    const fetchLoan = fnNode('client.ts', 'fetchLoan', 2);
    const call = httpCall('GET', '/api/loans/:id', 'client.ts', 3);
    const handler = fnNode('server.ts', 'getLoan', 4);
    const rt = route('GET', '/api/loans/:id', 'server.ts', 4);

    const a = open(rootA);
    a.putNodes([fetchLoan, call]);
    a.putEdges([edge(fetchLoan, call, 'calls')]);
    a.commit(NOW);

    const b = open(rootB);
    b.putNodes([handler, rt]);
    b.putEdges([edge(handler, rt, 'exposes')]);
    b.commit(NOW);

    return { rootA, rootB, fetchLoan, call, handler, rt };
  }

  it('DOWN from repoA fetchLoan crosses to repoB route (crossRepo=true, crossRepoHops>0)', () => {
    const f = fixture();
    const fed = loadFederation([f.rootA, f.rootB]);
    const res = federatedImpact(fed, f.rootA, f.fetchLoan.id, 'down', { depth: 3 });
    expect(res.crossRepoHops).toBeGreaterThan(0);
    const crossed = res.affected.find((a) => a.id === f.rt.id && a.crossRepo);
    expect(crossed).toBeDefined();
    expect(crossed?.soul).toBe(f.rootB);
    expect(crossed?.rel).toBe('calls-route');
    // the in-soul http-call is reached first (distance 1, not cross-repo)
    const inSoul = res.affected.find((a) => a.id === f.call.id);
    expect(inSoul).toBeDefined();
    expect(inSoul?.crossRepo).toBe(false);
  });

  it('UP from repoB route crosses to repoA http-call and enclosing fetchLoan', () => {
    const f = fixture();
    const fed = loadFederation([f.rootA, f.rootB]);
    const res = federatedImpact(fed, f.rootB, f.rt.id, 'up', { depth: 3 });
    expect(res.crossRepoHops).toBeGreaterThan(0);
    const callHop = res.affected.find((a) => a.id === f.call.id && a.crossRepo);
    expect(callHop).toBeDefined();
    expect(callHop?.soul).toBe(f.rootA);
    // fetchLoan is reached via the calls edge (http-call up → fetchLoan), distance 2.
    const fnHop = res.affected.find((a) => a.id === f.fetchLoan.id);
    expect(fnHop).toBeDefined();
  });

  it('a single-repo http-call does NOT cross when no matching route exists in another soul', () => {
    const f = fixture();
    const fed = loadFederation([f.rootA]); // repoB absent
    const res = federatedImpact(fed, f.rootA, f.fetchLoan.id, 'down', { depth: 3 });
    expect(res.crossRepoHops).toBe(0);
    expect(res.affected.every((a) => !a.crossRepo)).toBe(true);
  });

  it('the bridge crosses REPOS only — a same-soul route is NOT connected via the runtime bridge', () => {
    // Put both the http-call AND a matching route in repoA (no edge binds them; the bridge skips
    // same-soul by design — within-repo call↔route relationships are an EXTRACTED-edge concern, not
    // a runtime federation concern). repoB has nothing to match.
    const rootA = dirs[0]!;
    const rootB = dirs[1]!;
    const fetchLoan = fnNode('client.ts', 'fetchLoan', 2);
    const call = httpCall('GET', '/api/loans/:id', 'client.ts', 3);
    const handler = fnNode('server.ts', 'getLoan', 4);
    const rt = route('GET', '/api/loans/:id', 'server.ts', 4);
    const a = open(rootA);
    a.putNodes([fetchLoan, call, handler, rt]);
    a.putEdges([edge(fetchLoan, call, 'calls'), edge(handler, rt, 'exposes')]);
    a.commit(NOW);
    const b = open(rootB);
    b.putNodes([]);
    b.commit(NOW);

    const fed = loadFederation([rootA, rootB]);
    const res = federatedImpact(fed, rootA, fetchLoan.id, 'down', { depth: 3 });
    expect(res.crossRepoHops).toBe(0);
    // the http-call is reached in-soul (distance 1), but the same-soul route is NOT (no edge, and
    // the bridge deliberately does not bind within a soul).
    expect(res.affected.find((x) => x.id === call.id && !x.crossRepo)).toBeDefined();
    expect(res.affected.find((x) => x.id === rt.id)).toBeUndefined();
  });

  it('extractedOnly drops INFERRED in-soul neighbors but still crosses the EXTRACTED bridge', () => {
    const rootA = dirs[0]!;
    const rootB = dirs[1]!;
    const fetchLoan = fnNode('client.ts', 'fetchLoan', 2);
    const call = httpCall('GET', '/api/loans/:id', 'client.ts', 3);
    const inferredCallee = fnNode('client.ts', 'helper', 10);
    const handler = fnNode('server.ts', 'getLoan', 4);
    const rt = route('GET', '/api/loans/:id', 'server.ts', 4);
    const a = open(rootA);
    a.putNodes([fetchLoan, call, inferredCallee]);
    // calls→http-call EXTRACTED; calls→inferredCallee INFERRED.
    a.putEdges([
      edge(fetchLoan, call, 'calls', 'EXTRACTED', 1),
      edge(fetchLoan, inferredCallee, 'calls', 'INFERRED', 0.5),
    ]);
    a.commit(NOW);
    const b = open(rootB);
    b.putNodes([handler, rt]);
    b.putEdges([edge(handler, rt, 'exposes')]);
    b.commit(NOW);

    const fed = loadFederation([rootA, rootB]);
    const res = federatedImpact(fed, rootA, fetchLoan.id, 'down', {
      depth: 3,
      extractedOnly: true,
    });
    expect(res.affected.find((x) => x.id === inferredCallee.id)).toBeUndefined();
    expect(res.affected.find((x) => x.id === call.id)).toBeDefined();
    expect(res.crossRepoHops).toBeGreaterThan(0);
    expect(res.affected.find((x) => x.id === rt.id && x.crossRepo)).toBeDefined();
  });

  it('returns an empty result for an unknown start id (no spurious hops)', () => {
    const f = fixture();
    const fed = loadFederation([f.rootA, f.rootB]);
    const res = federatedImpact(fed, f.rootA, 'sym:nope@L1', 'down', { depth: 3 });
    expect(res.affected).toEqual([]);
    expect(res.crossRepoHops).toBe(0);
  });

  it('clamps depth/limit to the max and respects a small depth bound', () => {
    const f = fixture();
    const fed = loadFederation([f.rootA, f.rootB]);
    // depth 1 reaches only the in-soul http-call (distance 1). The cross-repo hop fires from the
    // http-call frontier, which is distance 2 — so depth=1 does NOT cross.
    const shallow = federatedImpact(fed, f.rootA, f.fetchLoan.id, 'down', { depth: 1 });
    expect(shallow.affected.find((x) => x.id === f.call.id)).toBeDefined();
    expect(shallow.crossRepoHops).toBe(0);
    expect(shallow.affected.find((x) => x.id === f.rt.id)).toBeUndefined();
    // a huge depth/limit clamps without truncating this tiny graph.
    const huge = federatedImpact(fed, f.rootA, f.fetchLoan.id, 'down', { depth: 999, limit: 9999 });
    expect(huge.truncated).toBe(false);
    expect(huge.affected.find((x) => x.id === f.rt.id && x.crossRepo)).toBeDefined();
  });
});
