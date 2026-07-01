import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'ts-cross',
);

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-resolve-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('Phase 3 resolve — cross-file edges (M3 gate)', () => {
  it('resolves imports, cross-file calls, inherits and implements at precision 1.0', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, FIXTURE_ROOT, { now: '2026-01-01T00:00:00.000Z' });

    const nodes = [...soul.iterate('symbol')];
    const byQ = (q: string): Node | undefined => nodes.find((n) => n.qualifiedName === q);
    const app = byQ('App');
    const appRun = byQ('App.run');
    const base = byQ('Base');
    const greeter = byQ('Greeter');
    const helper = byQ('helper');
    expect(app && appRun && base && greeter && helper).toBeTruthy();

    const edgePairs = (rel: string): string[] =>
      [...soul.iterateEdges(rel as never)]
        .map((e) => {
          const s = nodes.find((n) => n.id === e.src)?.qualifiedName ?? e.src;
          const d = nodes.find((n) => n.id === e.dst)?.qualifiedName ?? e.dst;
          return `${s} -> ${d}`;
        })
        .sort();

    // inherits: App -> Base ; implements: App -> Greeter
    expect(edgePairs('inherits')).toEqual(['App -> Base']);
    expect(edgePairs('implements')).toEqual(['App -> Greeter']);
    // cross-file call: App.run -> helper
    expect(edgePairs('calls')).toContain('App.run -> helper');
    // imports: file app.ts -> {Base, Greeter, helper}
    const importTargets = [...soul.iterateEdges('imports')].map(
      (e) => nodes.find((n) => n.id === e.dst)?.qualifiedName,
    );
    expect(importTargets.sort()).toEqual(['Base', 'Greeter', 'helper']);

    // every resolved edge is EXTRACTED/static/confidence 1.0 (no guessing)
    for (const rel of ['inherits', 'implements', 'calls', 'imports'] as const) {
      for (const e of soul.iterateEdges(rel)) {
        expect(e.provenance).toBe('EXTRACTED');
        expect(e.method).toBe('static');
        expect(e.confidence).toBe(1);
      }
    }

    expect(report.resolve.dropped).toBe(0); // everything in the fixture resolves
  });

  it('drops unresolved references (external imports), never guesses', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE_ROOT, { now: '2026-01-01T00:00:00.000Z' });
    // No edge should point at a node id that does not exist (invariant #1 holds post-resolve).
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });
});
