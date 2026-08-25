import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'docs-linked',
);

interface Label {
  anchor: string;
  symbol: string;
  rel: string;
}

let cribDir: string;
beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-link-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  s.load();
  return s;
}

describe('deterministic linker — precision gate (M4 headline)', () => {
  it('precision ≥ 0.9 against hand-labeled links', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const nodes = [...soul.iterate()];
    const qOf = (id: string): string | undefined => nodes.find((n) => n.id === id)?.qualifiedName;
    const anchorOf = (id: string): string | undefined => nodes.find((n) => n.id === id)?.anchor;

    const emitted: Label[] = [];
    for (const rel of ['describes', 'references'] as const) {
      for (const e of soul.iterateEdges(rel) as Iterable<Edge>) {
        const anchor = anchorOf(e.src);
        const symbol = qOf(e.dst);
        if (anchor && symbol) emitted.push({ anchor, symbol, rel });
      }
    }

    const { links } = JSON.parse(readFileSync(join(FIXTURE, 'labels.json'), 'utf8')) as {
      links: Label[];
    };
    const key = (l: Label) => `${l.anchor}|${l.symbol}|${l.rel}`;
    const trueSet = new Set(links.map(key));

    const correct = emitted.filter((e) => trueSet.has(key(e))).length;
    const precision = emitted.length === 0 ? 0 : correct / emitted.length;
    const recall = correct / links.length;

    expect(emitted.length).toBeGreaterThan(0);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  it('explicit code-ref yields a high-confidence describes edge', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    const nodes = [...soul.iterate()];
    const login = nodes.find((n) => n.qualifiedName === 'AuthService.login');
    const describes = [...soul.iterateEdges('describes')].find((e) => e.dst === login?.id);
    expect(describes).toBeDefined();
    expect(describes?.method).toBe('explicit');
    expect(describes?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('all linker edges are EXTRACTED (deterministic, --extracted-only safe)', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    for (const rel of ['describes', 'references'] as const) {
      for (const e of soul.iterateEdges(rel)) expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('emits doc-section nodes with heading hierarchy member-of', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    const sections = [...soul.iterate('doc-section')] as Node[];
    expect(sections.map((s) => s.anchor).sort()).toEqual(['authentication', 'sessions']);
    // "Sessions" (h2) is member-of "Authentication" (h1)
    const sessions = sections.find((s) => s.anchor === 'sessions');
    const auth = sections.find((s) => s.anchor === 'authentication');
    const memberEdge = [...soul.iterateEdges('member-of')].find((e) => e.src === sessions?.id);
    expect(memberEdge?.dst).toBe(auth?.id);
  });
});

describe('deterministic linker — W1 markdown fidelity', () => {
  it('a source-file link points at the FILE node, not every symbol (no path fan-out)', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    const auth = [...soul.iterate('doc-section')].find((s) => s.anchor === 'authentication');
    const tokenFileId = idFor({ kind: 'file', path: 'src/token.ts' });
    // ONE references edge to the file node
    const fileEdge = [...soul.iterateEdges('references')].find(
      (e) => e.src === auth?.id && e.dst === tokenFileId,
    );
    expect(fileEdge).toBeDefined();
    expect(fileEdge?.method).toBe('path');
    // NO fan-out to the symbols inside the file
    const tokenSyms = [...soul.iterate('symbol')].filter((s) => s.file === 'src/token.ts');
    for (const sym of tokenSyms) {
      expect(
        [...soul.iterateEdges('references')].some((e) => e.src === auth?.id && e.dst === sym.id),
      ).toBe(false);
    }
  });

  it('an unresolved internal link becomes a diagnostic, not a guessed edge', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    const missing = report.link.diagnostics.find((d) => d.target === '../src/missing.ts');
    expect(missing).toBeDefined();
    expect(missing?.kind).toBe('unresolved');
    // no edge was guessed to the missing file
    const missingFileId = idFor({ kind: 'file', path: 'src/missing.ts' });
    expect([...soul.iterateEdges()].some((e) => e.dst === missingFileId)).toBe(false);
  });

  it('an in-page #anchor link resolves to the doc-section node', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    const auth = [...soul.iterate('doc-section')].find((s) => s.anchor === 'authentication');
    const sessionsId = idFor({ kind: 'doc-section', path: 'docs/auth.md', anchor: 'sessions' });
    const anchorEdge = [...soul.iterateEdges('references')].find(
      (e) => e.src === auth?.id && e.dst === sessionsId,
    );
    expect(anchorEdge).toBeDefined();
    expect(anchorEdge?.method).toBe('path');
  });

  it('every persisted describe/reference edge carries a targetHash for drift audit', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    for (const rel of ['describes', 'references'] as const) {
      for (const e of soul.iterateEdges(rel) as Iterable<Edge>) {
        expect(e.evidence?.targetHash).toBeDefined();
        expect(typeof e.evidence?.targetHash).toBe('string');
        expect((e.evidence?.targetHash as string).startsWith('blake3:')).toBe(true);
      }
    }
  });

  it('generic prose identifier matches produce references, never describes', async () => {
    const soul = soulFor();
    await indexRepo(soul, FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    // every describes edge must be method 'explicit' (prose identifier hits are references only now)
    for (const e of soul.iterateEdges('describes')) {
      expect(e.method).toBe('explicit');
    }
  });
});
