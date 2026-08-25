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

const MULE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'mule-cross',
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

/**
 * Task 8 — MuleSoft cross-file resolve (end-to-end via indexRepo). The default fleet now ships the
 * MuleExtractor + MuleResolver, so a Mule 4 fixture indexes into the same graph vocabulary the code
 * languages use: flows/subflows (symbols), processors (statements), routes, conditions, http-calls,
 * exception-handlers. The resolver turns the extractor-recorded `meta.references` into EXTRACTED
 * edges WITHOUT re-parsing XML, persists external-flow placeholder nodes for static missing targets,
 * and DROPS dynamic names. SECURITY: only keys/refs are resolved — property VALUES never enter.
 */
describe('Phase 3 resolve — MuleSoft cross-file (Task 8)', () => {
  const NOW = '2026-01-01T00:00:00.000Z';

  it('resolves a cross-file flow-ref to a calls edge flow→subflow at confidence 1.0', async () => {
    const soul = soulFor();
    await indexRepo(soul, MULE_ROOT, { now: NOW, ownership: false, dossiers: false });

    const flow = [...soul.iterate('symbol')].find(
      (n) => n.name === 'getOrders' && n.type === 'flow',
    );
    const sub = [...soul.iterate('symbol')].find((n) => n.name === 'enrichOrder');
    expect(flow && sub).toBeTruthy();

    const calls = [...soul.iterateEdges('calls')].find(
      (e) => e.src === flow?.id && e.dst === sub?.id,
    );
    expect(calls).toMatchObject({ provenance: 'EXTRACTED', method: 'static', confidence: 1 });
  });

  it('persists an external-flow placeholder node + calls edge for a static missing flow target', async () => {
    const soul = soulFor();
    await indexRepo(soul, MULE_ROOT, { now: NOW, ownership: false, dossiers: false });

    const flow = [...soul.iterate('symbol')].find(
      (n) => n.name === 'getOrders' && n.type === 'flow',
    );
    const placeholder = [...soul.iterate('symbol')].find(
      (n) => n.type === 'external-flow' && n.name === 'missingFlow',
    );
    expect(placeholder).toMatchObject({ kind: 'symbol', type: 'external-flow', lang: 'mule' });
    expect(placeholder?.meta).toMatchObject({ family: 'mule', external: true });

    // the placeholder node is actually in the soul (runResolve persisted resolver-returned nodes)
    expect([...soul.iterate()].some((n) => n.id === placeholder?.id)).toBe(true);

    const calls = [...soul.iterateEdges('calls')].find(
      (e) => e.src === flow?.id && e.dst === placeholder?.id,
    );
    expect(calls).toMatchObject({ provenance: 'EXTRACTED', confidence: 1 });
  });

  it('resolves a connector config-ref to a references edge (http-call → config)', async () => {
    const soul = soulFor();
    await indexRepo(soul, MULE_ROOT, { now: NOW, ownership: false, dossiers: false });

    const call = [...soul.iterate('http-call')].find((n) => n.routePath === '/downstream');
    const config = [...soul.iterate('symbol')].find(
      (n) => n.type === 'config' && n.name === 'httpConfig',
    );
    expect(call && config).toBeTruthy();

    const ref = [...soul.iterateEdges('references')].find(
      (e) => e.src === call?.id && e.dst === config?.id,
    );
    expect(ref).toMatchObject({ provenance: 'EXTRACTED', confidence: 1 });
    expect((ref?.evidence as { referenceKind?: string })?.referenceKind).toBe('config');
  });

  it('drops a dynamic flow-ref name without a placeholder or edge', async () => {
    const soul = soulFor();
    await indexRepo(soul, MULE_ROOT, { now: NOW, ownership: false, dossiers: false });
    expect([...soul.iterate()].some((n) => n.name === '#[payload.target]')).toBe(false);
  });

  it('emits no inherits / implements edges (capability honesty — no type system)', async () => {
    const soul = soulFor();
    await indexRepo(soul, MULE_ROOT, { now: NOW, ownership: false, dossiers: false });
    expect([...soul.iterateEdges('inherits')].length).toBe(0);
    expect([...soul.iterateEdges('implements')].length).toBe(0);
  });

  it('every resolved edge points at a node that exists (placeholders persisted)', async () => {
    const soul = soulFor();
    await indexRepo(soul, MULE_ROOT, { now: NOW, ownership: false, dossiers: false });
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });

  it('never persists a property VALUE — only keys', async () => {
    const soul = soulFor();
    await indexRepo(soul, MULE_ROOT, { now: NOW, ownership: false, dossiers: false });
    // the secret value must never reach the soul graph; the keys must.
    const dump = JSON.stringify([...soul.iterate()].map((n) => ({ n, e: n })));
    expect(dump).not.toContain('swordfish');
    expect(dump).toContain('db.password');
  });
});
