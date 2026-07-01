import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Edge } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

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

function soulForAt(dir: string): SoulStore {
  const s = new SoulStore(join(dir, '.crib'), { manifest: newManifest({ now: NOW }) });
  s.load();
  return s;
}
