import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SoulStore,
  clusterContentHash,
  clusterMembers,
  newManifest,
  validateClusterIntegrity,
} from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, describe, expect, it } from 'vitest';

let dir: string | undefined;

function sym(path: string, qname: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: qname, startLine: line }),
    kind: 'symbol',
    type: 'function',
    name: qname.split('.').pop() ?? qname,
    qualifiedName: qname,
    file: path,
    span: { start: line, end: line },
    lang: 'typescript',
    hash: contentHash(`${path}:${qname}`),
    ...extra,
  };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('cluster-hash (core ↔ mcp parity)', () => {
  it('clusterContentHash is byte-identical to contentHash(cluster.hash | sorted member hashes)', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-cluster-hash-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const a = sym('src/a.ts', 'A.run', 1);
    const b = sym('src/b.ts', 'B.go', 1);
    const cluster: Node = {
      id: 'c:mod',
      kind: 'cluster',
      label: 'mod',
      members: [a.id, b.id],
      hash: contentHash('mod'),
    };
    soul.putNodes([a, b, cluster]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const expected = contentHash([cluster.hash, ...[a.hash, b.hash].sort()].join('|'));
    expect(clusterContentHash(soul, cluster)).toBe(expected);
  });

  it('clusterMembers resolves from the members array AND a stale clusterId back-compat path', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-cluster-members-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const inMembers = sym('src/a.ts', 'A.run', 1);
    const viaClusterId = sym('src/b.ts', 'B.go', 1, { clusterId: 'c:mod' });
    const lonely = sym('src/c.ts', 'C.go', 1);
    const cluster: Node = {
      id: 'c:mod',
      kind: 'cluster',
      label: 'mod',
      members: [inMembers.id],
      hash: contentHash('mod'),
    };
    soul.putNodes([inMembers, viaClusterId, lonely, cluster]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const members = clusterMembers(soul, cluster)
      .map((n) => n.id)
      .sort();
    expect(members).toEqual([inMembers.id, viaClusterId.id].sort());
  });

  it('is deterministic: two runs over the same soul produce identical hashes', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-cluster-hash-det-'));
    const mk = () => {
      const soul = new SoulStore(join(dir!, '.crib'), {
        manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
      });
      soul.load();
      const a = sym('src/a.ts', 'A.run', 1);
      const b = sym('src/b.ts', 'B.go', 1);
      const cluster: Node = {
        id: 'c:mod',
        kind: 'cluster',
        label: 'mod',
        members: [a.id, b.id],
        hash: contentHash('mod'),
      };
      soul.putNodes([a, b, cluster]);
      const e: Edge = {
        id: edgeId(a.id, b.id, 'calls'),
        src: a.id,
        dst: b.id,
        rel: 'calls',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
      };
      soul.putEdges([e]);
      soul.commit('2026-01-01T00:00:00.000Z');
      return clusterContentHash(soul, cluster);
    };
    expect(mk()).toBe(mk());
  });

  it('reports duplicate ownership and members/edge drift', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-cluster-integrity-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const a = sym('src/a.ts', 'A.run', 1);
    const one: Node = {
      id: 'c:one',
      kind: 'cluster',
      members: [a.id],
      hash: contentHash('one'),
    };
    const two: Node = {
      id: 'c:two',
      kind: 'cluster',
      members: [a.id],
      hash: contentHash('two'),
    };
    soul.putNodes([a, one, two]);
    soul.putEdges([
      {
        id: edgeId(a.id, one.id, 'member-of'),
        src: a.id,
        dst: one.id,
        rel: 'member-of',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
      },
    ]);

    const report = validateClusterIntegrity(soul);
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.includes('multiple clusters'))).toBe(true);
    expect(report.issues.some((issue) => issue.includes('missing member-of edge'))).toBe(true);
  });
});
