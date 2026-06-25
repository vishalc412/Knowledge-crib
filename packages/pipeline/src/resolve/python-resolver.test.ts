import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const PY_CROSS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'python-cross',
);
const PY_TS_MIXED = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'py-ts-mixed',
);
const PY_MODULE_IMPORTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'python-module-imports',
);

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
const PY_EXTS = ['.py', '.pyi'];
const NOW = '2026-01-01T00:00:00.000Z';

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-py-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('PythonResolver — cross-file edges (M8 gate)', () => {
  it('resolves imports / cross-file calls / inherits across sibling modules', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, PY_CROSS, { now: NOW, cluster: false, semantic: false });

    // imports: auth.py → Base (base.py) and → format_token (util.py)
    const imports = [...soul.iterateEdges('imports')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(imports).toEqual(['file:auth.py -> sym:Base', 'file:auth.py -> sym:format_token']);

    // inherits: Auth → Base (Base is from-imported)
    const inherits = [...soul.iterateEdges('inherits')].map((e) => pair(soul, e.src, e.dst));
    expect(inherits).toEqual(['sym:Auth -> sym:Base']);

    // cross-file calls: Auth.issue → format_token (imported bare name).
    // `Auth()` in make_auth is a LOCAL class → intra-file, handled by the extractor, not the resolver.
    const calls = [...soul.iterateEdges('calls')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(calls).toContain('sym:Auth.issue -> sym:format_token');

    // every resolved edge is EXTRACTED/static/confidence 1 (no guessing)
    for (const e of soul.iterateEdges('imports')) expectEdge(e);
    for (const e of soul.iterateEdges('inherits')) expectEdge(e);
    for (const e of soul.iterateEdges('calls')) expectEdge(e);

    // resolver stats reflect at least one of each cross-file category
    expect(report.resolve.imports).toBeGreaterThanOrEqual(2);
    expect(report.resolve.inherits).toBeGreaterThanOrEqual(1);
    expect(report.resolve.calls).toBeGreaterThanOrEqual(1);
  });

  it('is capability-honest: ≥1 imports/calls/inherits, ZERO type edges', async () => {
    const soul = soulFor();
    await indexRepo(soul, PY_CROSS, { now: NOW, cluster: false, semantic: false });

    const pyEdges = edgesInFiles(soul, PY_EXTS);
    const rels = new Set(pyEdges.map((e) => e.rel));
    // Python declares {imports, calls, inheritance, types:'none'} ⇒ only these rels may appear.
    expect(rels).toEqual(new Set<Rel>(['member-of', 'calls', 'imports', 'inherits']));
    // ZERO type edges: no references / derived-from / implements / reads / writes / executes.
    for (const typeRel of [
      'references',
      'derived-from',
      'implements',
      'reads',
      'writes',
      'executes',
    ] as const) {
      expect(rels.has(typeRel)).toBe(false);
    }
    expect([...soul.iterateEdges('imports')].length).toBeGreaterThanOrEqual(1);
    expect([...soul.iterateEdges('calls')].length).toBeGreaterThanOrEqual(1);
    expect([...soul.iterateEdges('inherits')].length).toBeGreaterThanOrEqual(1);
  });

  it('never emits an edge whose endpoint node does not exist (pruneDangling-safe)', async () => {
    const soul = soulFor();
    await indexRepo(soul, PY_CROSS, { now: NOW, cluster: false, semantic: false });
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });

  it('is id-stable: re-indexing yields byte-identical nodes + edges', async () => {
    const a = soulFor();
    await indexRepo(a, PY_CROSS, { now: NOW, cluster: false, semantic: false });
    const aNodes = JSON.stringify([...a.iterate()].sort(byId));
    const aEdges = JSON.stringify([...a.iterateEdges()].sort(byEdgeId));

    cribDir = mkdtempSync(join(tmpdir(), 'crib-py2-'));
    const b = soulFor();
    await indexRepo(b, PY_CROSS, { now: NOW, cluster: false, semantic: false });
    expect(JSON.stringify([...b.iterate()].sort(byId))).toBe(aNodes);
    expect(JSON.stringify([...b.iterateEdges()].sort(byEdgeId))).toBe(aEdges);
  });
});

describe('Mixed TS + Python indexRepo — no cross-talk (M8 gate)', () => {
  it('indexes both languages in one repo without cross-language edges', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, PY_TS_MIXED, {
      now: NOW,
      cluster: false,
      semantic: false,
    });

    const tsSyms = [...soul.iterate('symbol')].filter((n) => n.lang === 'typescript');
    const pySyms = [...soul.iterate('symbol')].filter((n) => n.lang === 'python');
    expect(tsSyms.some((n) => n.qualifiedName === 'greet')).toBe(true);
    expect(pySyms.some((n) => n.qualifiedName === 'thing')).toBe(true);

    // no edge connects a TS-family node to a Python-family node (or vice-versa).
    const allNodes = [...soul.iterate()];
    const famOf = (id: string): 'ts' | 'py' | undefined => {
      const n = allNodes.find((x) => x.id === id);
      const f = n?.file;
      if (!f) return undefined;
      if (TS_EXTS.some((e) => f.endsWith(e))) return 'ts';
      if (PY_EXTS.some((e) => f.endsWith(e))) return 'py';
      return undefined;
    };
    let crossTalk = 0;
    for (const e of soul.iterateEdges()) {
      const sf = famOf(e.src);
      const df = famOf(e.dst);
      if (sf && df && sf !== df) crossTalk++;
    }
    expect(crossTalk).toBe(0);

    // every edge endpoint exists
    const ids = new Set(allNodes.map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
    expect(report.resolve).toBeDefined();
  });
});

describe('PythonResolver — module bindings (M8 NICE-5)', () => {
  it('resolves `import M` / `M.f()` and comma `import a, b` with ZERO imports edges', async () => {
    const soul = soulFor();
    await indexRepo(soul, PY_MODULE_IMPORTS, { now: NOW, cluster: false, semantic: false });

    // `import base, util` binds BOTH modules (comma multi-module) → both calls resolve cross-file.
    const calls = [...soul.iterateEdges('calls')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(calls).toContain('sym:use_base -> sym:base_fn');
    expect(calls).toContain('sym:use_util -> sym:util_fn');

    // `from . import helper` resolves the SIBLING SUBMODULE helper.py → helper.do() cross-file call.
    expect(calls).toContain('sym:use_helper -> sym:do');

    // Multi-part `import sub.inner` + `sub.inner.deep()` — the local `sub` binds to the TOP package,
    // the chain `sub.inner` lands on the imported fullModule → deep() in pkg/sub/inner.py resolves.
    expect(calls).toContain('sym:use_deep -> sym:deep');

    // Mismatched chain: `sub.deep()` after `import sub.inner` must NOT resolve to inner.deep (wrong
    // file). It is dropped — no contradictory/wrong cross-file edge. (sub has no top-level `deep`.)
    expect(calls).not.toContain('sym:use_mismatched -> sym:deep');

    // Capability-honest: module bindings emit NO `imports` edge (no module node to point at).
    // The only from-import here is `from . import helper`, which is a submodule (module binding),
    // so there are zero imports edges in this fixture.
    expect([...soul.iterateEdges('imports')].length).toBe(0);

    // every resolved edge is EXTRACTED/static/confidence 1; every endpoint exists.
    for (const e of soul.iterateEdges('calls')) expectEdge(e);
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
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
