import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { indexRepo } from '@knowledge-crib/pipeline';
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
