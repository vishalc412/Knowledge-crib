import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const CSHARP_CROSS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'csharp-cross',
);

const CSHARP_EXTS = ['.cs'];
const NOW = '2026-01-01T00:00:00.000Z';

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-csharp-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('CsharpResolver — cross-file edges (gate)', () => {
  it('resolves imports / inherits / implements / cross-file constructor calls', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, CSHARP_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
    });

    // imports: Controller.cs → Base, Service, Token (the three explicit type usings).
    // IGreeter is NOT imported — Controller implements it via same-namespace FQN lookup, so no
    // imports edge.
    const imports = [...soul.iterateEdges('imports')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(imports).toEqual([
      'file:Controller.cs -> sym:Crib.Example.Base',
      'file:Controller.cs -> sym:Crib.Example.Service',
      'file:Controller.cs -> sym:Crib.Example.Token',
    ]);

    // inherits: Controller : Base (Base resolves to a class → inherits).
    const inherits = [...soul.iterateEdges('inherits')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(inherits).toEqual(['sym:Crib.Example.Controller -> sym:Crib.Example.Base']);

    // implements: Controller : IGreeter (IGreeter resolves to an interface → implements);
    // Service : IGreeter (same-namespace, no import).
    const implements_ = [...soul.iterateEdges('implements')]
      .map((e) => pair(soul, e.src, e.dst))
      .sort();
    expect(implements_).toEqual([
      'sym:Crib.Example.Controller -> sym:Crib.Example.IGreeter',
      'sym:Crib.Example.Service -> sym:Crib.Example.IGreeter',
    ]);

    // cross-file calls: Controller.Issue → Token (the `new Token(input)` constructor call to an
    // imported type). `service.Greet(user)` is a field-receiver call — NOT resolved cross-file
    // (method resolution across files is inference's job, never guessed here).
    const calls = [...soul.iterateEdges('calls')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(calls).toContain('sym:Crib.Example.Controller.Issue -> sym:Crib.Example.Token');

    // every resolved cross-file edge is EXTRACTED/static/confidence 1 (no guessing).
    for (const e of soul.iterateEdges('imports')) expectEdge(e);
    for (const e of soul.iterateEdges('inherits')) expectEdge(e);
    for (const e of soul.iterateEdges('implements')) expectEdge(e);
    for (const e of soul.iterateEdges('calls')) expectEdge(e);

    // resolver stats reflect at least one of each cross-file category.
    expect(report.resolve.imports).toBeGreaterThanOrEqual(3);
    expect(report.resolve.inherits).toBeGreaterThanOrEqual(1);
    expect(report.resolve.implements).toBeGreaterThanOrEqual(2);
    expect(report.resolve.calls).toBeGreaterThanOrEqual(1);
  });

  it('is capability-honest: only member-of/calls/imports/inherits/implements; ZERO type edges', async () => {
    const soul = soulFor();
    await indexRepo(soul, CSHARP_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
      ownership: false,
    });

    const csEdges = edgesInFiles(soul, CSHARP_EXTS);
    const rels = new Set(csEdges.map((e) => e.rel));
    // C# declares {imports, calls, inheritance, types:'none'} ⇒ these are the only rels that may
    // appear. `implements` is a structural (non-type) edge here, so it IS allowed. `executes` is an
    // intra-file control-flow edge the Track-3 extractor body-walk stamps (proc → statement) — NOT
    // a resolver type edge, so it IS allowed. ZERO genuine type/data edges.
    expect(rels).toEqual(
      new Set<Rel>(['member-of', 'calls', 'imports', 'inherits', 'implements', 'executes']),
    );
    for (const typeRel of ['references', 'derived-from', 'reads', 'writes'] as const) {
      expect(rels.has(typeRel)).toBe(false);
    }
    expect([...soul.iterateEdges('imports')].length).toBeGreaterThanOrEqual(1);
    expect([...soul.iterateEdges('calls')].length).toBeGreaterThanOrEqual(1);
    expect([...soul.iterateEdges('inherits')].length).toBeGreaterThanOrEqual(1);
    expect([...soul.iterateEdges('implements')].length).toBeGreaterThanOrEqual(1);
  });

  it('never emits an edge whose endpoint node does not exist (pruneDangling-safe)', async () => {
    const soul = soulFor();
    await indexRepo(soul, CSHARP_CROSS, {
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
    await indexRepo(a, CSHARP_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
      ownership: false,
    });
    const aNodes = JSON.stringify([...a.iterate()].sort(byId));
    const aEdges = JSON.stringify([...a.iterateEdges()].sort(byEdgeId));

    cribDir = mkdtempSync(join(tmpdir(), 'crib-csharp2-'));
    const b = soulFor();
    await indexRepo(b, CSHARP_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
      ownership: false,
    });
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
