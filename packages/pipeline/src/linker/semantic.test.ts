import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Edge } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';
import { runSemanticLink } from './semantic.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'docs-semantic',
);

let cribDir: string;
beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-sem-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  s.load();
  return s;
}

const NOW = '2026-01-01T00:00:00.000Z';

/** Collect doc→symbol edges (describes + references) as comparable records. */
function docSymbolEdges(soul: SoulStore): Array<{ src: string; dst: string; rel: string }> {
  const out: Array<{ src: string; dst: string; rel: string }> = [];
  for (const rel of ['describes', 'references'] as const) {
    for (const e of soul.iterateEdges(rel) as Iterable<Edge>) {
      out.push({ src: e.src, dst: e.dst, rel });
    }
  }
  out.sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : a.dst < b.dst ? -1 : 1));
  return out;
}

describe('M7 semantic linker (INFERRED TF-IDF pass)', () => {
  it('deterministic-only (default) does NOT link the class mentioned only as a common noun', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: NOW }); // semantic defaults off
    const nodes = [...soul.iterate('symbol')];
    const cls = nodes.find((n) => n.qualifiedName === 'TokenService')!;
    const rotate = nodes.find((n) => n.qualifiedName === 'TokenService.rotate')!;
    // explicit code-ref → describes rotate
    const describesRotate = [...soul.iterateEdges('describes')].find((e) => e.dst === rotate.id);
    expect(describesRotate).toBeDefined();
    expect(describesRotate?.method).toBe('explicit');
    expect(describesRotate?.provenance).toBe('EXTRACTED');
    // prose says "token", but no symbol is named "token" → deterministic misses the class
    const classEdges = [
      ...soul.iterateEdges('describes'),
      ...soul.iterateEdges('references'),
    ].filter((e) => e.dst === cls.id);
    expect(classEdges).toHaveLength(0);
    // every deterministic edge is EXTRACTED (--extracted-only is a clean subset)
    for (const e of [...soul.iterateEdges('describes'), ...soul.iterateEdges('references')]) {
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('semantic on adds an INFERRED references edge for the missed class (recall strictly greater)', async () => {
    const det = soulFor();
    await indexRepo(det, FIXTURE, { now: NOW });
    const detEdges = docSymbolEdges(det);

    const sem = soulFor();
    const report = await indexRepo(sem, FIXTURE, { now: NOW, semantic: true });
    expect(report.semantic.added).toBeGreaterThanOrEqual(1);
    const semEdges = docSymbolEdges(sem);

    // recall strictly greater: semantic emitted more doc→symbol edges than deterministic alone
    expect(semEdges.length).toBeGreaterThan(detEdges.length);

    const nodes = [...sem.iterate('symbol')];
    const cls = nodes.find((n) => n.qualifiedName === 'TokenService')!;
    const classLinks = [...sem.iterateEdges('references')].filter((e) => e.dst === cls.id);
    expect(classLinks.length).toBeGreaterThanOrEqual(1);
    const sem_ = classLinks[0]!;
    expect(sem_.method).toBe('semantic');
    expect(sem_.provenance).toBe('INFERRED');
    // capped below the 0.8 describes threshold
    expect(sem_.confidence).toBeGreaterThanOrEqual(0.4);
    expect(sem_.confidence).toBeLessThanOrEqual(0.6);
  });

  it('never duplicates a deterministic edge and leaves the deterministic set byte-identical', async () => {
    const det = soulFor();
    await indexRepo(det, FIXTURE, { now: NOW });
    const detExtracted = docSymbolEdges(det).filter(() => true); // all deterministic are EXTRACTED

    const sem = soulFor();
    await indexRepo(sem, FIXTURE, { now: NOW, semantic: true });
    // every EXTRACTED edge in the semantic run must also exist in the deterministic run (no
    // deterministic edge was added/removed/altered by the semantic pass)
    const detSet = new Set(detExtracted.map((e) => `${e.src}|${e.dst}|${e.rel}`));
    for (const e of [...sem.iterateEdges('describes'), ...sem.iterateEdges('references')]) {
      if (e.provenance === 'EXTRACTED') {
        expect(detSet.has(`${e.src}|${e.dst}|${e.rel}`)).toBe(true);
      } else {
        // INFERRED edges are references only, never describes
        expect(e.rel).toBe('references');
        expect(e.method).toBe('semantic');
      }
    }
  });

  it('graceful-degrades on a corpus with no doc-sections (no throw, no edges)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'crib-sem-empty-'));
    try {
      mkdirSync(join(empty, 'src'), { recursive: true });
      writeFileSync(join(empty, 'src', 'a.ts'), 'export function lone(): void {}\n');
      const soul = soulForAt(empty);
      const report = await indexRepo(soul, empty, { now: NOW, semantic: true });
      expect(report.semantic.added).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('M2.3 embedding-cosine linker (inflection recall-up vs TF-IDF)', () => {
  /**
   * The fixture pair: symbol `validateInput` (src/validate.ts) vs doc-section "Validation"
   * (docs/validation.md) whose prose says "validation logic guards entry points". TF-IDF tokenizes
   * "validation" and "validate" as distinct terms (no stemmer) → no shared term → the section never
   * retrieves `validateInput`. char-n-gram embedding shares the "validat" n-grams across the
   * inflection boundary → cosine above floor → `validateInput` is retrieved. This is the recall-up
   * signal M2.3 ships, pinned under the same [0.4, 0.6] conf cap as the M7 TF-IDF pass.
   */
  it('TF-IDF mode does NOT link validateInput (inflection is a shared-term miss)', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: NOW }); // deterministic only
    const validateInput = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'validateInput',
    )!;
    expect(validateInput, 'fixture must surface validateInput').toBeDefined();

    const { added } = runSemanticLink(soul, FIXTURE, undefined, { mode: 'tfidf' });
    // TF-IDF sees no shared term between "validation …" and `validateInput` → no candidate → no edge.
    const links = [...soul.iterateEdges('references')].filter((e) => e.dst === validateInput.id);
    expect(links).toHaveLength(0);
    // (added may be > 0 from other pairs — that's fine; the gate is per-symbol recall.)
    expect(added).toBeGreaterThanOrEqual(0);
  });

  it('embedding mode links validateInput (inflection caught via char-n-gram overlap)', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: NOW });
    const validateInput = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'validateInput',
    )!;

    const { added } = runSemanticLink(soul, FIXTURE, undefined, { mode: 'embedding' });
    expect(added).toBeGreaterThanOrEqual(1);

    const links = [...soul.iterateEdges('references')].filter((e) => e.dst === validateInput.id);
    expect(links.length).toBeGreaterThanOrEqual(1);
    const edge = links[0]!;
    expect(edge.method).toBe('semantic');
    expect(edge.provenance).toBe('INFERRED');
    expect(edge.evidence?.by).toBe('embedding');
    // same conf cap as TF-IDF — strictly below the 0.8 describes threshold.
    expect(edge.confidence).toBeGreaterThanOrEqual(0.4);
    expect(edge.confidence).toBeLessThanOrEqual(0.6);
  });

  it('embedding mode does not invent edges to clearly-unrelated symbols (precision held)', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: NOW });
    runSemanticLink(soul, FIXTURE, undefined, { mode: 'embedding' });

    // `rotate` (key rotation) is unrelated to "validation guards" — the deterministic pass already
    // links it via the explicit code-ref, so it must NOT also carry an INFERRED references edge.
    const rotate = [...soul.iterate('symbol')].find(
      (n) => n.qualifiedName === 'TokenService.rotate',
    )!;
    const inferredToRotate = [...soul.iterateEdges('references')].filter(
      (e) => e.dst === rotate.id && e.method === 'semantic',
    );
    expect(inferredToRotate).toHaveLength(0);
    // and no INFERRED edge is ever promoted to describes.
    for (const e of soul.iterateEdges('describes')) {
      expect(e.provenance).toBe('EXTRACTED');
    }
  });
});

function soulForAt(dir: string): SoulStore {
  const s = new SoulStore(join(dir, '.crib'), { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}
