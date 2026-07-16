import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const GO_CROSS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'go-cross');

const GO_EXTS = ['.go'];
const NOW = '2026-01-01T00:00:00.000Z';

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-go-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('GoResolver — cross-file edges (gate)', () => {
  it('resolves imports / cross-file calls / embedding inherits', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, GO_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
    });

    // imports: controller.go imports "auth/util" → the util package's first top-level symbol
    // (UtilFn). Go imports bring a whole package; the edge points at a representative symbol.
    const imports = [...soul.iterateEdges('imports')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(imports).toEqual(['file:controller.go -> sym:UtilFn']);

    // inherits: Controller embeds Base (cross-file, same package) → inherits Controller → Base.
    const inherits = [...soul.iterateEdges('inherits')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(inherits).toEqual(['sym:Controller -> sym:Base']);

    // cross-file calls: Controller.Run calls util.UtilFn() → calls Controller.Run → UtilFn.
    const calls = [...soul.iterateEdges('calls')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(calls).toContain('sym:Controller.Run -> sym:UtilFn');

    // every resolved cross-file edge is EXTRACTED/static/confidence 1 (no guessing).
    for (const e of soul.iterateEdges('imports')) expectEdge(e);
    for (const e of soul.iterateEdges('inherits')) expectEdge(e);
    for (const e of soul.iterateEdges('calls')) expectEdge(e);

    // resolver stats reflect at least one of each cross-file category.
    expect(report.resolve.imports).toBeGreaterThanOrEqual(1);
    expect(report.resolve.inherits).toBeGreaterThanOrEqual(1);
    expect(report.resolve.calls).toBeGreaterThanOrEqual(1);
  });

  it('is capability-honest: member-of/calls/imports/inherits; ZERO implements + ZERO type edges', async () => {
    const soul = soulFor();
    await indexRepo(soul, GO_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
      ownership: false,
    });

    const goEdges = edgesInFiles(soul, GO_EXTS);
    const rels = new Set(goEdges.map((e) => e.rel));
    // Go declares {imports, calls, inheritance, types:'none'}. Implicit interface satisfaction is NOT
    // detected → `implements` never appears. `inherits` covers explicit embedding only. `executes` is
    // an intra-file control-flow edge the Track-3 extractor body-walk stamps (proc → statement) — NOT
    // a resolver type edge, so it IS allowed. `describes` is an intra-file doc edge the schema-1.2
    // comment-attachment pass stamps (explanation → symbol) — also NOT a resolver type edge, so it IS
    // allowed. ZERO genuine type/data edges + ZERO implements.
    expect(rels).toEqual(
      new Set<Rel>(['member-of', 'calls', 'imports', 'inherits', 'executes', 'describes']),
    );
    for (const typeRel of [
      'references',
      'derived-from',
      'reads',
      'writes',
      'implements',
    ] as const) {
      expect(rels.has(typeRel as Rel)).toBe(false);
    }
    expect([...soul.iterateEdges('imports')].length).toBeGreaterThanOrEqual(1);
    expect([...soul.iterateEdges('calls')].length).toBeGreaterThanOrEqual(1);
    expect([...soul.iterateEdges('inherits')].length).toBeGreaterThanOrEqual(1);
  });

  it('never emits an edge whose endpoint node does not exist (pruneDangling-safe)', async () => {
    const soul = soulFor();
    await indexRepo(soul, GO_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
      ownership: false,
    });
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });

  it('is id-stable: re-indexing yields byte-identical nodes + edges', async () => {
    const a = soulFor();
    await indexRepo(a, GO_CROSS, { now: NOW, cluster: false, semantic: false, ownership: false });
    const aNodes = JSON.stringify([...a.iterate()].sort(byId));
    const aEdges = JSON.stringify([...a.iterateEdges()].sort(byEdgeId));

    cribDir = mkdtempSync(join(tmpdir(), 'crib-go2-'));
    const b = soulFor();
    await indexRepo(b, GO_CROSS, { now: NOW, cluster: false, semantic: false, ownership: false });
    expect(JSON.stringify([...b.iterate()].sort(byId))).toBe(aNodes);
    expect(JSON.stringify([...b.iterateEdges()].sort(byEdgeId))).toBe(aEdges);
  });
});

// --- helpers ---

function edgesInFiles(soul: SoulStore, exts: string[]): Edge[] {
  const files = new Set(
    [...soul.iterate()]
      .filter((n) => n.file && exts.some((e) => n.file!.endsWith(e)))
      .map((n) => n.id),
  );
  return [...soul.iterateEdges()].filter((e) => files.has(e.src) || files.has(e.dst));
}

function pair(soul: SoulStore, srcId: string, dstId: string): string {
  return `${label(soul, srcId)} -> ${label(soul, dstId)}`;
}

function label(soul: SoulStore, id: string): string {
  const n: Node | undefined = [...soul.iterate()].find((x) => x.id === id);
  if (!n) return id;
  switch (n.kind) {
    case 'symbol':
      return `sym:${n.qualifiedName ?? n.name}`;
    case 'file':
      return `file:${shortFile(n.file)}`;
    default:
      return n.kind;
  }
}

function shortFile(p: string | undefined): string {
  return p ? (p.split('/').pop() ?? p) : '?';
}

function expectEdge(e: { provenance: string; method: string; confidence: number }): void {
  expect(e.provenance).toBe('EXTRACTED');
  expect(e.method).toBe('static');
  expect(e.confidence).toBe(1);
}

function byId(a: Node, b: Node): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function byEdgeId(a: Edge, b: Edge): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
