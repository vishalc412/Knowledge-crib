/**
 * W6 — working overlay math (PRD exit gate line 375).
 *
 * Covers the overlay's pure bookkeeping: seed-from-canonical, markDirty deferral, ephemeral
 * commit() no-op, canonicalDrifted against the on-disk manifest, resync, restoreFrom, and the
 * GraphStore delegation that makes `extracted()`/`composite()` read from the overlay. The
 * re-parse + closure re-resolution behavior lives in the pipeline package test.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphStore } from './graph-store.js';
import { newManifest } from './manifest.js';
import { SoulStore } from './soul-store.js';
import { WorkingOverlay, canonicalFingerprint } from './working-overlay.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-overlay-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileNode(path: string): Node {
  return {
    id: idFor({ kind: 'file', path }),
    kind: 'file',
    file: path,
    hash: contentHash(path),
    lang: 'typescript',
  };
}
function symNode(path: string, name: string, line: number): Node {
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
function callEdge(src: Node, dst: Node): Edge {
  return {
    id: edgeId(src.id, dst.id, 'calls'),
    src: src.id,
    dst: dst.id,
    rel: 'calls',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by: 'test' },
  };
}

/** Build a committed canonical soul with a.ts (greet) ← calls — b.ts (main), then commit it to disk. */
function committedCanonical(): {
  soul: SoulStore;
  aSym: Node;
  bSym: Node;
  aFile: Node;
  bFile: Node;
  edge: Edge;
} {
  const crib = join(dir, '.crib');
  const soul = new SoulStore(crib, {
    manifest: newManifest({ now: '2026-01-01T00:00:00Z', root: '.' }),
  });
  soul.load();
  const aFile = fileNode('src/a.ts');
  const bFile = fileNode('src/b.ts');
  const aSym = symNode('src/a.ts', 'greet', 1);
  const bSym = symNode('src/b.ts', 'main', 2);
  const edge = callEdge(bSym, aSym);
  soul.putNodes([aFile, bFile, aSym, bSym]);
  soul.putEdges([edge]);
  soul.setVcsHead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  soul.commit('2026-01-01T00:00:00Z');
  return { soul, aSym, bSym, aFile, bFile, edge };
}

describe('working overlay — seed + ephemeral guard', () => {
  it('seeds a full in-memory copy from canonical on construction', () => {
    const { soul, aSym, bSym, edge } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    // The overlay store has every canonical node/edge in memory.
    expect(overlay.store.getNode(aSym.id)).toBeDefined();
    expect(overlay.store.getNode(bSym.id)).toBeDefined();
    expect(overlay.store.getEdge(edge.id)).toBeDefined();
    expect(overlay.dirty).toEqual([]);
    expect(overlay.isSealed).toBe(true);
  });

  it('commit() on the overlay store is a structural no-op (canonical .crib stays byte-identical)', () => {
    const { soul, aSym } = committedCanonical();
    const crib = soul.cribDir;
    const beforeManifest = readFileSync(join(crib, 'crib.json'), 'utf8');

    const overlay = new WorkingOverlay(soul);
    // Mutate the overlay in memory and try to commit — it must NOT touch disk.
    overlay.store.removeByFile('src/a.ts');
    overlay.store.commit('2026-02-02T00:00:00Z');
    overlay.store.putNodes([{ ...aSym, name: 'greetEdited' }]);
    overlay.store.commit('2026-03-03T00:00:00Z');

    const afterManifest = readFileSync(join(crib, 'crib.json'), 'utf8');
    expect(afterManifest).toBe(beforeManifest);
    // Canonical in-memory store is untouched by overlay mutations.
    expect(soul.getNode(aSym.id)?.name).toBe('greet');
  });
});

describe('working overlay — dirty bookkeeping', () => {
  it('markDirty records the path without dropping overlay records (deferred removal)', () => {
    const { soul, aSym, edge } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    overlay.markDirty('src/a.ts');
    expect(overlay.dirty).toEqual(['src/a.ts']);
    expect(overlay.isDirty('src/a.ts')).toBe(true);
    expect(overlay.isSealed).toBe(false);
    // Deferred: a's records are STILL present until the refresher runs (closure needs them intact
    // in canonical; the overlay keeps a queryable pre-edit state within the debounce window).
    expect(overlay.store.getNode(aSym.id)).toBeDefined();
    expect(overlay.store.getEdge(edge.id)).toBeDefined();
  });

  it('markDirty is idempotent', () => {
    const { soul } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    overlay.markDirty('src/a.ts');
    overlay.markDirty('src/a.ts');
    expect(overlay.dirty).toEqual(['src/a.ts']);
  });
});

describe('working overlay — canonical drift detection', () => {
  it('canonicalDrifted is false right after seed', () => {
    const { soul } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    expect(overlay.canonicalDrifted()).toBe(false);
  });

  it('canonicalDrifted is true after an external crib update advances the on-disk manifest', () => {
    const { soul, bSym } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    expect(overlay.canonicalDrifted()).toBe(false);

    // Simulate another process running `crib update`: advance canonical + commit to disk.
    soul.putNodes([{ ...bSym, name: 'mainEdited' }]);
    soul.setVcsHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    soul.commit('2026-04-04T00:00:00Z');

    expect(overlay.canonicalDrifted()).toBe(true);
  });

  it('canonicalFingerprint returns null when the manifest is absent', () => {
    expect(canonicalFingerprint(join(dir, 'nope'))).toBeNull();
  });
});

describe('working overlay — resync', () => {
  it('resync re-seeds from the advanced canonical on-disk soul and clears the dirty set', () => {
    const { soul, bSym } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    overlay.markDirty('src/a.ts');
    expect(overlay.isSealed).toBe(false);

    // External crib update: canonical advances on disk.
    soul.putNodes([{ ...bSym, name: 'mainEdited' }]);
    soul.setVcsHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    soul.commit('2026-04-04T00:00:00Z');
    expect(overlay.canonicalDrifted()).toBe(true);

    overlay.resync();
    expect(overlay.canonicalDrifted()).toBe(false);
    expect(overlay.isSealed).toBe(true);
    // The overlay now reflects the edited canonical record.
    expect(overlay.store.getNode(bSym.id)?.name).toBe('mainEdited');
  });
});

describe('working overlay — restoreFrom', () => {
  it('restores a single committed file, skipping edges whose other endpoint is still dirty', () => {
    const { soul, aSym, bSym, edge } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    // Both files dirty: drop their overlay records to simulate a mid-refresh state.
    overlay.markDirty('src/a.ts');
    overlay.markDirty('src/b.ts');
    overlay.store.removeByFile('src/a.ts');
    overlay.store.removeByFile('src/b.ts');
    expect(overlay.store.getNode(aSym.id)).toBeUndefined();
    expect(overlay.store.getEdge(edge.id)).toBeUndefined();

    // b leaves the dirty set first → restore a's records from canonical.
    overlay.restoreFrom(soul, 'src/a.ts');
    expect(overlay.isDirty('src/a.ts')).toBe(false);
    expect(overlay.store.getNode(aSym.id)).toBeDefined();
    // The b→a edge is NOT restored because b is still dirty (b's re-parse will re-emit it).
    expect(overlay.store.getEdge(edge.id)).toBeUndefined();

    // Now b leaves the dirty set → edge comes back.
    overlay.restoreFrom(soul, 'src/b.ts');
    expect(overlay.store.getEdge(edge.id)).toBeDefined();
  });

  it('restoreFrom is a no-op for a path that was not dirty', () => {
    const { soul, aSym } = committedCanonical();
    const overlay = new WorkingOverlay(soul);
    overlay.restoreFrom(soul, 'src/a.ts'); // never marked dirty
    expect(overlay.store.getNode(aSym.id)).toBeDefined();
    expect(overlay.isSealed).toBe(true);
  });
});

describe('working overlay — GraphStore delegation', () => {
  it('setWorkingOverlay routes extracted() through the overlay, not canonical', () => {
    const { soul, aSym } = committedCanonical();
    const graph = new GraphStore(soul);
    const overlay = new WorkingOverlay(soul);
    // Canonical state before overlay activation.
    expect(graph.extracted().nodes.some((n) => n.id === aSym.id)).toBe(true);

    graph.setWorkingOverlay(overlay.store);
    // Remove a from the overlay only — the extracted read model reflects the overlay, while
    // canonical's own store is untouched (the committed graph is not dirtied).
    overlay.store.removeByFile('src/a.ts');
    expect(graph.extracted().nodes.some((n) => n.id === aSym.id)).toBe(false);
    expect(soul.getNode(aSym.id)).toBeDefined(); // canonical intact
  });

  it('semantic() always reads canonical, not the overlay (semantic is a separate fresh layer)', () => {
    const { soul, aSym } = committedCanonical();
    const graph = new GraphStore(soul);
    const overlay = new WorkingOverlay(soul);
    // Baseline: semantic() with no overlay active (no semantic artifacts → empty node set, but the
    // snapshot is well-formed and reads from the committed soul).
    const before = graph.semantic();
    graph.setWorkingOverlay(overlay.store);
    overlay.store.removeByFile('src/a.ts');
    // The overlay IS active for the extracted layer (aSym is gone from extracted()).
    expect(graph.extracted().nodes.some((n) => n.id === aSym.id)).toBe(false);
    // semantic() is unchanged by the overlay mutation — it reads the canonical soul, not the overlay.
    const after = graph.semantic();
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
  });
});
