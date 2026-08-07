import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { graphPaths, migrateLegacyGraph } from './graph-layout.js';
import { GraphStore, graphSourceFingerprint } from './graph-store.js';
import { newManifest } from './manifest.js';
import { materializeComposite } from './materialize.js';
import { SoulStore } from './soul-store.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fileNode(): Node {
  return {
    id: 'file:src/auth.ts',
    kind: 'file',
    hash: 'blake3:abcdef0123456789',
    file: 'src/auth.ts',
    name: 'auth.ts',
  };
}

describe('canonical graph store', () => {
  it('writes extracted graph under .crib/graph and reads fresh semantic artifacts as one view', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-graph-store-'));
    const crib = join(root, '.crib');
    const soul = new SoulStore(crib, { manifest: newManifest({ now: '2026-01-01T00:00:00Z' }) });
    soul.putNodes([fileNode()]);
    soul.commit('2026-01-01T00:00:00Z');

    const paths = graphPaths(crib);
    expect(existsSync(paths.manifest)).toBe(true);
    expect(existsSync(join(paths.nodes, '00')) || existsSync(paths.nodes)).toBe(true);
    expect(existsSync(join(crib, 'nodes'))).toBe(false);
    const bootstrap = JSON.parse(readFileSync(join(crib, 'crib.json'), 'utf8'));
    expect(bootstrap.stores.graph.path).toBe('.crib/graph');
    expect(bootstrap.stats).toBeUndefined();
    expect(soul.getManifest().generation).toEqual({ extracted: 1, semantic: 0 });

    const artifactDir = join(paths.artifacts, 'file', '00');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, 'auth.json'),
      JSON.stringify({
        version: 1,
        layer: 'file',
        targetId: fileNode().id,
        nodeHash: fileNode().hash,
        schemaVersion: soul.getManifest().schemaVersion,
        builtAt: '2026-01-01T00:00:00Z',
        model: 'test-model',
        grounded: true,
        analysis: { purpose: 'Authentication boundary', confidence: 0.9 },
        graph: {
          nodes: [
            {
              id: 'llm:file:src/auth.ts#cap:auth',
              localId: 'cap:auth',
              kind: 'capability',
              name: 'Authentication',
            },
          ],
          edges: [
            {
              from: fileNode().id,
              to: 'llm:file:src/auth.ts#cap:auth',
              rel: 'realizes',
              confidence: 0.9,
            },
          ],
        },
        evidence: [{ soulId: fileNode().id, why: 'file anchor' }],
      }),
    );

    const graph = new GraphStore(soul).compositeLive();
    expect(graph.nodes.map((node) => node.id)).toContain('llm:file:src/auth.ts#cap:auth');
    expect(graph.edges.some((edge) => edge.origin === 'semantic' && edge.rel === 'realizes')).toBe(
      true,
    );
    expect(graph.diagnostics.fresh).toBe(1);

    const result = materializeComposite(soul);
    expect(result.sourceFingerprint).toBe(graphSourceFingerprint(soul));
    expect(existsSync(join(result.root, 'graph.json'))).toBe(true);
    expect(existsSync(join(result.root, 'crib.sqlite'))).toBe(true);
    expect(new GraphStore(soul).composite().nodes).toHaveLength(graph.nodes.length);
    const materializedManifest = JSON.parse(
      readFileSync(join(result.root, 'manifest.json'), 'utf8'),
    );
    expect(materializedManifest).toMatchObject({
      graphGeneration: { extracted: 1, semantic: 0 },
      schemaVersion: soul.getManifest().schemaVersion,
      extractedHash: expect.stringMatching(/^blake3:/),
      semanticHash: expect.stringMatching(/^blake3:/),
    });

    soul.putNodes([
      {
        id: 'file:src/new.ts',
        kind: 'file',
        hash: 'blake3:1234abcd',
        file: 'src/new.ts',
        name: 'new.ts',
      },
    ]);
    soul.commit('2026-01-02T00:00:00Z');
    expect(
      new GraphStore(soul).composite().nodes.some((node) => node.id === 'file:src/new.ts'),
    ).toBe(true);
  });

  it('migrates legacy extracted + llm roots and activates canonical manifest last', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-graph-migrate-'));
    const crib = join(root, '.crib');
    mkdirSync(crib, { recursive: true });
    writeFileSync(join(crib, 'crib.json'), `${JSON.stringify(newManifest())}\n`);
    const legacy = new SoulStore(crib);
    legacy.putNodes([fileNode()]);
    legacy.commit('2026-01-01T00:00:00Z');
    const legacyArtifact = join(crib, 'llm', 'analysis', 'file', '00', 'auth.json');
    mkdirSync(join(crib, 'llm', 'analysis', 'file', '00'), { recursive: true });
    const artifactBytes = `${JSON.stringify({
      version: 1,
      layer: 'file',
      targetId: fileNode().id,
      nodeHash: fileNode().hash,
      schemaVersion: legacy.getManifest().schemaVersion,
      grounded: false,
      analysis: { purpose: 'legacy' },
      graph: { nodes: [], edges: [] },
      evidence: [],
    })}\n`;
    writeFileSync(legacyArtifact, artifactBytes);

    expect(migrateLegacyGraph(crib, true).needed).toBe(true);
    const report = migrateLegacyGraph(crib, false);
    expect(report.moved).toContain('nodes');
    expect(existsSync(graphPaths(crib).manifest)).toBe(true);
    expect(existsSync(join(crib, 'nodes'))).toBe(false);
    expect(readFileSync(join(graphPaths(crib).artifacts, 'file', '00', 'auth.json'), 'utf8')).toBe(
      artifactBytes,
    );

    const reopened = new SoulStore(crib);
    reopened.load();
    expect(reopened.getNode(fileNode().id)).toBeDefined();
  });

  it('leaves the legacy store authoritative when staged validation fails', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-graph-migrate-fail-'));
    const crib = join(root, '.crib');
    mkdirSync(crib, { recursive: true });
    writeFileSync(join(crib, 'crib.json'), `${JSON.stringify(newManifest())}\n`);
    const legacy = new SoulStore(crib);
    legacy.putNodes([fileNode()]);
    legacy.commit('2026-01-01T00:00:00Z');
    const manifest = JSON.parse(readFileSync(join(crib, 'crib.json'), 'utf8'));
    manifest.stats.nodes = 99;
    writeFileSync(join(crib, 'crib.json'), `${JSON.stringify(manifest)}\n`);

    expect(() => migrateLegacyGraph(crib, false)).toThrow(/node count mismatch/);
    expect(existsSync(graphPaths(crib).manifest)).toBe(false);
    expect(existsSync(join(crib, 'nodes'))).toBe(true);
    const reopened = new SoulStore(crib);
    reopened.load();
    expect(reopened.getNode(fileNode().id)).toBeDefined();
  });
});
