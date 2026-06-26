import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { indexRepo } from '@knowledge-crib/pipeline';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { buildVizGraph, vizAssetsDir } from '@knowledge-crib/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-viz-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  // two symbols joined by a calls edge → one structural cluster.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    'export class AuthService {\n  login(): void { this.issue(); }\n  issue(): void {}\n}\n',
  );
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const NOW = '2026-01-01T00:00:00.000Z';
function soulFor(): SoulStore {
  const s = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}

describe('crib viz — buildVizGraph (DC runtime contract)', () => {
  it('emits clusters separately and marks member symbols with clusterId', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo, { now: NOW });
    const g = buildVizGraph(soul);

    expect(g.clusters.length).toBeGreaterThanOrEqual(1);

    // every cluster has ≥2 members whose node data carries clusterId == cluster id
    for (const c of g.clusters) {
      const cid = c.id;
      const members = g.nodes.filter((n) => n.data.clusterId === cid);
      expect(members.length).toBeGreaterThanOrEqual(2);
      // the cluster's members match the soul's member-of edges into this cluster
      const soulMembers = [...soul.iterateEdges('member-of')]
        .filter((e) => e.dst === cid)
        .map((e) => e.src)
        .sort();
      expect(members.map((m) => m.data.id).sort()).toEqual(soulMembers);
    }
    expect(g.stats.clusters).toBe(g.clusters.length);
    expect(g.stats.nodes).toBe(g.nodes.length);
    expect(g.stats.edges).toBe(g.edges.length);
  });

  it('is deterministic — byte-identical snapshot across runs', async () => {
    const a = soulFor();
    await indexRepo(a, repo, { now: NOW });
    const ga = buildVizGraph(a);

    const b = soulFor();
    await indexRepo(b, repo, { now: '2026-02-02T00:00:00.000Z' });
    const gb = buildVizGraph(b);

    expect(JSON.stringify(gb)).toBe(JSON.stringify(ga));
  });

  it('serializes as plain JSON (no soul types leak) and edges reference real node/cluster ids', async () => {
    const soul = soulFor();
    await indexRepo(soul, repo, { now: NOW });
    const g = buildVizGraph(soul);
    const ids = new Set(g.nodes.map((n) => n.data.id));
    const clusterIds = new Set(g.clusters.map((c) => c.id));
    for (const e of g.edges) {
      expect(ids.has(e.data.source) || clusterIds.has(e.data.source)).toBe(true);
      expect(ids.has(e.data.target) || clusterIds.has(e.data.target)).toBe(true);
    }
    // round-trips through JSON cleanly
    expect(() => JSON.parse(JSON.stringify(g))).not.toThrow();
  });

  it('vizAssetsDir points at the DC runtime assets', () => {
    const dir = vizAssetsDir();
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
    expect(existsSync(join(dir, 'support.js'))).toBe(true);
  });
});

describe('crib viz — framework-semantics 1.3 surfacing', () => {
  const F = 'src/com/acme/Loan.java';

  function node(partial: Partial<Node> & { id: string; kind: Node['kind'] }): Node {
    return {
      name: partial.id,
      file: F,
      span: { start: 1, end: 1 },
      lang: 'java',
      hash: contentHash(partial.id),
      ...partial,
    } as Node;
  }
  function edge(src: string, dst: string, rel: Rel): Edge {
    return {
      id: edgeId(src, dst, rel),
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
    };
  }

  it('surfaces route verb/path + field column + component framework + symbol stereotype on node data', () => {
    const soul = soulFor();
    const controller = node({
      id: idFor({
        kind: 'symbol',
        path: F,
        qualifiedName: 'com.acme.LoanController',
        startLine: 1,
      }),
      kind: 'symbol',
      type: 'class',
      name: 'LoanController',
      qualifiedName: 'com.acme.LoanController',
      stereotype: 'controller',
      framework: 'spring',
    });
    const route = node({
      id: idFor({ kind: 'route', httpMethod: 'POST', routePath: '/api/loans', file: F, line: 5 }),
      kind: 'route',
      name: 'POST /api/loans',
      httpMethod: 'POST',
      routePath: '/api/loans',
      framework: 'spring',
    });
    const field = node({
      id: idFor({ kind: 'field', path: F, qualifiedName: 'com.acme.Loan.applicant', startLine: 8 }),
      kind: 'field',
      name: 'applicant',
      qualifiedName: 'com.acme.Loan.applicant',
      meta: { column: { name: 'applicant_id' } },
    });
    const comp = node({
      id: idFor({ kind: 'component', path: F, qualifiedName: 'LoanForm', startLine: 20 }),
      kind: 'component',
      name: 'LoanForm',
      qualifiedName: 'LoanForm',
      framework: 'react',
    });
    soul.putNodes([controller, route, field, comp]);
    soul.putEdges([
      edge(controller.id, route.id, 'exposes'),
      edge(field.id, controller.id, 'member-of'),
    ]);
    soul.commit(NOW);

    const g = buildVizGraph(soul);
    const byId = new Map(g.nodes.map((n) => [n.data.id, n.data] as const));

    const r = byId.get(route.id)!;
    expect(r.kind).toBe('route');
    expect(r.httpMethod).toBe('POST');
    expect(r.routePath).toBe('/api/loans');
    expect(r.framework).toBe('spring');
    expect(r.summary).toBe('POST /api/loans'); // verb + path, not "route: ..."

    const f = byId.get(field.id)!;
    expect(f.kind).toBe('field');
    expect(f.summary).toBe('Field applicant → column applicant_id');

    const c = byId.get(comp.id)!;
    expect(c.kind).toBe('component');
    expect(c.framework).toBe('react');
    expect(c.summary).toBe('react component LoanForm');

    const ctl = byId.get(controller.id)!;
    expect(ctl.kind).toBe('class'); // derived from type 'class'
    expect(ctl.stereotype).toBe('controller');
    expect(ctl.framework).toBe('spring');
    expect(ctl.summary).toBe('controller: LoanController'); // stereotype-prefixed

    // all framework edges are present in the snapshot (exposes + member-of)
    const rels = new Set(g.edges.map((e) => e.data.rel));
    expect(rels.has('exposes')).toBe(true);
    expect(rels.has('member-of')).toBe(true);
  });
});
