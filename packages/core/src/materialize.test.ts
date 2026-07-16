/**
 * WP3 — closes the materialize test gap. `materializeComposite` writes a unified composite graph
 * (extracted + semantic) to `.crib/index/composite`; `GraphStore.composite()` reads the materialized
 * cache when its fingerprint matches the live soul, else falls back to `compositeLive()`. These tests
 * pin the four properties the plan calls out: live-vs-materialized equivalence, invalidation on an
 * extracted OR semantic change, idempotence, and a clean fallback when no materialization exists.
 *
 * The non-atomic swap window (`materialize.ts:70-71` rmSync→renameSync) is intentionally NOT fixed:
 * writers are excluded by `runLocked`, and a reader hitting the window sees a missing dir and falls
 * back to live composite (`graph-store.ts:90`) — a perf blip, not corruption. The fallback test
 * covers the missing-materialization branch that the swap window also triggers.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { graphPaths } from './graph-layout.js';
import { GraphStore, graphSourceFingerprint } from './graph-store.js';
import { newManifest } from './manifest.js';
import { materializeComposite } from './materialize.js';
import { SoulStore } from './soul-store.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fileNode(id = 'file:src/auth.ts', hash = 'blake3:abcdef0123456789'): Node {
  return { id, kind: 'file', hash, file: 'src/auth.ts', name: 'auth.ts' };
}

/** Write a fresh (grounded) semantic artifact for `target` so compositeLive() surfaces a semantic node. */
function writeArtifact(
  crib: string,
  target: Node,
  schemaVersion: string,
  capName = 'Authentication',
): void {
  const dir = join(graphPaths(crib).artifacts, 'file', '00');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      version: 1,
      layer: 'file',
      targetId: target.id,
      nodeHash: target.hash,
      schemaVersion,
      builtAt: '2026-01-01T00:00:00Z',
      model: 'test-model',
      grounded: true,
      analysis: { purpose: 'Authentication boundary', confidence: 0.9 },
      graph: {
        nodes: [
          {
            id: `llm:${target.id}#cap:auth`,
            localId: 'cap:auth',
            kind: 'capability',
            name: capName,
          },
        ],
        edges: [
          { from: target.id, to: `llm:${target.id}#cap:auth`, rel: 'realizes', confidence: 0.9 },
        ],
      },
      evidence: [{ soulId: target.id, why: 'file anchor' }],
    }),
  );
}

function sortedIds<T extends { id: string }>(items: T[]): string[] {
  return items.map((item) => item.id).sort();
}

describe('materializeComposite (WP3)', () => {
  it('live and materialized composite are equivalent (same node + edge id sets)', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-mat-equiv-'));
    const crib = join(root, '.crib');
    const soul = new SoulStore(crib, { manifest: newManifest({ now: '2026-01-01T00:00:00Z' }) });
    const node = fileNode();
    soul.putNodes([node]);
    soul.commit('2026-01-01T00:00:00Z');
    writeArtifact(crib, node, soul.getManifest().schemaVersion);

    const live = new GraphStore(soul).compositeLive();
    const result = materializeComposite(soul);
    expect(result.sourceFingerprint).toBe(graphSourceFingerprint(soul));

    const materialized = new GraphStore(soul).composite();
    // The materialized cache is served (fingerprint matches), and it carries the same nodes + edges
    // as the live composite — including the semantic capability node + the realizes edge.
    expect(sortedIds(materialized.nodes)).toEqual(sortedIds(live.nodes));
    expect(sortedIds(materialized.edges)).toEqual(sortedIds(live.edges));
    expect(materialized.nodes.map((n) => n.id)).toContain('llm:file:src/auth.ts#cap:auth');
    expect(materialized.edges.some((e) => e.origin === 'semantic' && e.rel === 'realizes')).toBe(
      true,
    );
  });

  it('invalidates on an extracted change: fingerprint mismatches and composite() falls back to live', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-mat-extracted-'));
    const crib = join(root, '.crib');
    const soul = new SoulStore(crib, { manifest: newManifest({ now: '2026-01-01T00:00:00Z' }) });
    const node = fileNode();
    soul.putNodes([node]);
    soul.commit('2026-01-01T00:00:00Z');
    writeArtifact(crib, node, soul.getManifest().schemaVersion);

    const beforeFp = graphSourceFingerprint(soul);
    materializeComposite(soul);
    expect(existsSync(join(crib, 'index', 'composite', 'graph.json'))).toBe(true);

    // An extracted change: add a new file node + commit. This bumps generation.extracted AND the
    // extracted file hash, so the fingerprint changes and the materialized cache must NOT be served.
    const newNode: Node = {
      id: 'file:src/new.ts',
      kind: 'file',
      hash: 'blake3:1234abcd',
      file: 'src/new.ts',
      name: 'new.ts',
    };
    soul.putNodes([newNode]);
    soul.commit('2026-01-02T00:00:00Z');

    expect(graphSourceFingerprint(soul)).not.toBe(beforeFp);
    const after = new GraphStore(soul).composite();
    // Falls back to live composite → the new node is visible (stale materialized cache was NOT served).
    expect(after.nodes.map((n) => n.id)).toContain('file:src/new.ts');
  });

  it('invalidates on a semantic change: a new artifact changes the semantic hash → fallback to live', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-mat-semantic-'));
    const crib = join(root, '.crib');
    const soul = new SoulStore(crib, { manifest: newManifest({ now: '2026-01-01T00:00:00Z' }) });
    const node = fileNode();
    soul.putNodes([node]);
    soul.commit('2026-01-01T00:00:00Z');
    writeArtifact(crib, node, soul.getManifest().schemaVersion, 'Auth-v1');

    const beforeFp = graphSourceFingerprint(soul);
    materializeComposite(soul);
    // Sanity: the v1 capability name is in the materialized cache.
    expect(new GraphStore(soul).composite().nodes.some((n) => n.kind === 'capability')).toBe(true);

    // A semantic change: rewrite the artifact with a different capability name. The semantic file hash
    // changes (generation.semantic is NOT bumped by a raw file write, but semanticHash covers the file
    // contents), so the fingerprint mismatches and composite() falls back to live.
    writeArtifact(crib, node, soul.getManifest().schemaVersion, 'Auth-v2');
    expect(graphSourceFingerprint(soul)).not.toBe(beforeFp);
    const after = new GraphStore(soul).composite();
    expect(
      after.nodes.some(
        (n) => n.kind === 'capability' && (n as { name?: string }).name === 'Auth-v2',
      ),
    ).toBe(true);
  });

  it('is idempotent: two materializeComposite runs produce byte-identical graph.json + manifest.json', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-mat-idem-'));
    const crib = join(root, '.crib');
    const soul = new SoulStore(crib, { manifest: newManifest({ now: '2026-01-01T00:00:00Z' }) });
    const node = fileNode();
    soul.putNodes([node]);
    soul.commit('2026-01-01T00:00:00Z');
    writeArtifact(crib, node, soul.getManifest().schemaVersion);

    materializeComposite(soul);
    const target = join(crib, 'index', 'composite');
    const graph1 = readFileSync(join(target, 'graph.json'), 'utf8');
    const manifest1 = readFileSync(join(target, 'manifest.json'), 'utf8');

    // Second run overwrites via a fresh staging dir (randomUUID); the OUTPUT must be identical because
    // compositeLive() is deterministic over a stable soul and the staging path never leaks into content.
    materializeComposite(soul);
    const graph2 = readFileSync(join(target, 'graph.json'), 'utf8');
    const manifest2 = readFileSync(join(target, 'manifest.json'), 'utf8');

    expect(graph2).toBe(graph1);
    expect(manifest2).toBe(manifest1);
  });

  it('falls back cleanly to live composite when no materialization exists', () => {
    root = mkdtempSync(join(tmpdir(), 'crib-mat-missing-'));
    const crib = join(root, '.crib');
    const soul = new SoulStore(crib, { manifest: newManifest({ now: '2026-01-01T00:00:00Z' }) });
    const node = fileNode();
    soul.putNodes([node]);
    soul.commit('2026-01-01T00:00:00Z');
    writeArtifact(crib, node, soul.getManifest().schemaVersion);

    // No materializeComposite call → no composite dir. composite() must fall back to live, not throw.
    expect(existsSync(join(crib, 'index', 'composite'))).toBe(false);
    const live = new GraphStore(soul).compositeLive();
    const composite = new GraphStore(soul).composite();
    expect(sortedIds(composite.nodes)).toEqual(sortedIds(live.nodes));
    expect(sortedIds(composite.edges)).toEqual(sortedIds(live.edges));
  });
});
