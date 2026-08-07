import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SoulStore, clusterContentHash, newManifest, readLlmOverlay } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, describe, expect, it } from 'vitest';

let dir: string | undefined;

function sym(path: string, qname: string, line: number): Node {
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
  };
}

function writeArtifact(cribDir: string, artifact: Record<string, unknown>): void {
  const path = join(
    cribDir,
    '.crib',
    'llm',
    'analysis',
    artifact.layer as string,
    '00',
    'art.json',
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
function writeLlmManifest(cribDir: string, builtAgainstHead: string | null): void {
  const path = join(cribDir, '.crib', 'llm', 'manifest.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ builtAgainstHead, version: 1 }, null, 2)}\n`, 'utf8');
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('readLlmOverlay', () => {
  it('surfaces a fresh cluster artifact with name/purpose/confidence and stale=false', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-overlay-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const a = sym('src/a.ts', 'A.run', 1);
    const cluster: Node = {
      id: 'c:mod',
      kind: 'cluster',
      label: 'mod',
      members: [a.id],
      hash: contentHash('mod'),
    };
    soul.putNodes([a, cluster]);
    soul.commit('2026-01-01T00:00:00.000Z');

    writeArtifact(dir, {
      version: 1,
      layer: 'cluster',
      targetId: cluster.id,
      nodeHash: clusterContentHash(soul, cluster),
      schemaVersion: soul.getManifest().schemaVersion,
      builtAt: '2026-01-01T00:00:00.000Z',
      analysis: { purpose: 'Auth module', name: 'auth', confidence: 0.8 },
      graph: { nodes: [], edges: [] },
      evidence: [],
    });

    const overlay = readLlmOverlay(soul);
    const entry = overlay.entries.get(cluster.id);
    expect(entry).toBeDefined();
    expect(entry?.layer).toBe('cluster');
    expect(entry?.stale).toBe(false);
    expect(entry?.purpose).toBe('Auth module');
    expect(entry?.name).toBe('auth');
    expect(entry?.confidence).toBe(0.8);
  });

  it('marks a cluster stale when its membership content drifts', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-overlay-stale-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const a = sym('src/a.ts', 'A.run', 1);
    const cluster: Node = {
      id: 'c:mod',
      kind: 'cluster',
      label: 'mod',
      members: [a.id],
      hash: contentHash('mod'),
    };
    soul.putNodes([a, cluster]);
    soul.commit('2026-01-01T00:00:00.000Z');

    writeArtifact(dir, {
      version: 1,
      layer: 'cluster',
      targetId: cluster.id,
      nodeHash: clusterContentHash(soul, cluster),
      schemaVersion: soul.getManifest().schemaVersion,
      builtAt: '2026-01-01T00:00:00.000Z',
      analysis: { purpose: 'Auth module', confidence: 0.8 },
      graph: { nodes: [], edges: [] },
      evidence: [],
    });

    // Drift: add a new member → clusterContentHash changes.
    const b = sym('src/b.ts', 'B.go', 1);
    cluster.members = [a.id, b.id];
    soul.putNodes([b, cluster]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const overlay = readLlmOverlay(soul);
    expect(overlay.entries.get(cluster.id)?.stale).toBe(true);
  });

  it('marks the system artifact fresh/stale against the LLM manifest builtAgainstHead', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-overlay-sys-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    soul.getManifest().repo.vcsHead = 'sha1';
    soul.commit('2026-01-01T00:00:00.000Z');

    writeLlmManifest(dir, 'sha1');
    writeArtifact(dir, {
      version: 1,
      layer: 'system',
      targetId: 'system:repo',
      nodeHash: 'deadbeef',
      schemaVersion: soul.getManifest().schemaVersion,
      builtAt: '2026-01-01T00:00:00.000Z',
      analysis: { purpose: 'whole repo', confidence: 0.7 },
      graph: { nodes: [], edges: [] },
      evidence: [],
      mode: 'skeleton',
    });

    let overlay = readLlmOverlay(soul);
    expect(overlay.system?.stale).toBe(false);
    expect(overlay.system?.mode).toBe('skeleton');
    expect(overlay.hasFreshSystem).toBe(true);

    // Drift the vcsHead → system becomes stale.
    soul.getManifest().repo.vcsHead = 'sha2';
    soul.commit('2026-01-01T00:00:00.000Z');
    overlay = readLlmOverlay(soul);
    expect(overlay.system?.stale).toBe(true);
    expect(overlay.hasFreshSystem).toBe(false);
  });

  it('returns an empty overlay when no LLM layer exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-overlay-empty-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const overlay = readLlmOverlay(soul);
    expect(overlay.entries.size).toBe(0);
    expect(overlay.hasFreshSystem).toBe(false);
  });
});
