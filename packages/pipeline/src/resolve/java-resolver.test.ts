import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const JAVA_CROSS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'java-cross',
);

const JAVA_SPRING = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'java-spring',
);

const JAVA_EXTS = ['.java'];
const NOW = '2026-01-01T00:00:00.000Z';

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-java-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('JavaResolver — cross-file edges (gate)', () => {
  it('resolves imports / inherits / implements / cross-file constructor calls', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, JAVA_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
    });

    // imports: Controller.java → Base, Service, Token (the three explicit same-package imports).
    // Greeter is NOT imported — Controller implements it via same-package FQN lookup, so no imports edge.
    const imports = [...soul.iterateEdges('imports')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(imports).toEqual([
      'file:Controller.java -> sym:Base',
      'file:Controller.java -> sym:Service',
      'file:Controller.java -> sym:Token',
    ]);

    // inherits: Controller extends Base.
    const inherits = [...soul.iterateEdges('inherits')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(inherits).toEqual(['sym:Controller -> sym:Base']);

    // implements: Controller implements Greeter; Service implements Greeter (same-package, no import).
    const implements_ = [...soul.iterateEdges('implements')]
      .map((e) => pair(soul, e.src, e.dst))
      .sort();
    expect(implements_).toEqual(['sym:Controller -> sym:Greeter', 'sym:Service -> sym:Greeter']);

    // cross-file calls: Controller.issue → Token (the `new Token(input)` constructor call to an
    // imported type). `service.greet(user)` is a field-receiver call — NOT resolved cross-file
    // (method resolution across files is inference's job, never guessed here).
    const calls = [...soul.iterateEdges('calls')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(calls).toContain('sym:Controller.issue -> sym:Token');

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
    await indexRepo(soul, JAVA_CROSS, {
      now: NOW,
      cluster: false,
      semantic: false,
      ownership: false,
    });

    const javaEdges = edgesInFiles(soul, JAVA_EXTS);
    const rels = new Set(javaEdges.map((e) => e.rel));
    // Java declares {imports, calls, inheritance, types:'none'} ⇒ these are the only rels that may
    // appear. `implements` is a structural (non-type) edge here, so it IS allowed (unlike Python).
    // `executes` is an intra-file control-flow edge the Track-3 extractor body-walk stamps
    // (proc → statement) — NOT a resolver type edge, so it IS allowed. ZERO genuine type/data edges.
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
    await indexRepo(soul, JAVA_CROSS, {
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
    await indexRepo(a, JAVA_CROSS, { now: NOW, cluster: false, semantic: false, ownership: false });
    const aNodes = JSON.stringify([...a.iterate()].sort(byId));
    const aEdges = JSON.stringify([...a.iterateEdges()].sort(byEdgeId));

    cribDir = mkdtempSync(join(tmpdir(), 'crib-java2-'));
    const b = soulFor();
    await indexRepo(b, JAVA_CROSS, { now: NOW, cluster: false, semantic: false, ownership: false });
    expect(JSON.stringify([...b.iterate()].sort(byId))).toBe(aNodes);
    expect(JSON.stringify([...b.iterateEdges()].sort(byEdgeId))).toBe(aEdges);
  });
});

describe('JavaResolver — Spring DI cross-file (schema 1.3 gate)', () => {
  it('resolves constructor + @Autowired field injection across files → injects edges', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, JAVA_SPRING, {
      now: NOW,
      cluster: false,
      semantic: false,
    });

    // The Spring pass (Phase 2) records `meta.injects` on each bean for types it could NOT resolve
    // intra-file; the resolver turns those into cross-file `injects` edges here:
    //   LoanController --injects--> LoanService    (constructor-injected, imported)
    //   LoanService    --injects--> LoanRepository (@Autowired field, imported)
    const injects = [...soul.iterateEdges('injects')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(injects).toEqual([
      'sym:LoanController -> sym:LoanService',
      'sym:LoanService -> sym:LoanRepository',
    ]);

    // every resolved injects edge is EXTRACTED/static/confidence 1 (no guessing).
    for (const e of soul.iterateEdges('injects')) expectEdge(e);

    // both bean dependencies resolved cross-file.
    expect(report.resolve.injects).toBeGreaterThanOrEqual(2);

    // stereotypes survived onto the class symbols (the Spring pass mutates the symbol node).
    const stereotype = (q: string) =>
      [...soul.iterate('symbol')].find((n) => n.qualifiedName === q)?.stereotype;
    expect(stereotype('LoanController')).toBe('controller');
    expect(stereotype('LoanService')).toBe('service');
    expect(stereotype('LoanRepository')).toBe('repository');

    // routes + exposes are intra-file artifacts from the Spring pass (Phase 2), present in the soul.
    const routes = [...soul.iterate('route')].map((n) => `${n.httpMethod} ${n.routePath}`).sort();
    expect(routes).toEqual(['GET /api/loans/{id}', 'POST /api/loans']);
    expect([...soul.iterateEdges('exposes')].length).toBeGreaterThanOrEqual(2);
  });

  it('resolves @Bean producer methods across files → produces edges (schema 1.3)', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, JAVA_SPRING, {
      now: NOW,
      cluster: false,
      semantic: false,
    });

    // The Spring pass (Phase 2) records `meta.produces` on each @Bean method for return types it
    // could NOT resolve intra-file; the resolver turns those into cross-file `produces` edges here:
    //   LoanConfig.auditClient     --produces--> AuditClient     (imported)
    //   LoanConfig.loanRepository  --produces--> LoanRepository  (imported)
    const produces = [...soul.iterateEdges('produces')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(produces).toEqual([
      'sym:LoanConfig.auditClient -> sym:AuditClient',
      'sym:LoanConfig.loanRepository -> sym:LoanRepository',
    ]);

    // every resolved produces edge is EXTRACTED/static/confidence 1 (no guessing).
    for (const e of soul.iterateEdges('produces')) expectEdge(e);
    expect(report.resolve.produces).toBeGreaterThanOrEqual(2);

    // the @Configuration class carries the config stereotype; the @Bean methods are its producers.
    const stereotype = (q: string) =>
      [...soul.iterate('symbol')].find((n) => n.qualifiedName === q)?.stereotype;
    expect(stereotype('LoanConfig')).toBe('config');
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
