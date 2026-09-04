/**
 * P2.1 — dossier update-latency gates.
 *
 * `runDossiers` builds every callable's dossier through ONE hoisted set of adjacency/name-index
 * opts (`hoistedDossierOpts`) instead of letting each `buildDossier` rebuild them from full
 * iterateEdges()/iterate('symbol') scans. The whole change rests on an equivalence that nothing
 * previously pinned: a dossier built from the hoisted opts must be DEEP-EQUAL to one built with no
 * opts at all. This test pins that equivalence on a fixture that exercises every hoisted field —
 * Spring framework semantics (routes via exposes, produces supply-chain, injects DI), the
 * decision-table path that receives the hoisted adjacency as `out`, and the coverage pass that
 * consumes the hoisted name index for call-site resolution.
 *
 * It also pins the `pruneDossiers` contract (path-derived ids, contents never parsed) so the
 * O(all-dossiers) JSON.parse cost stays out of every `crib update`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALLABLE_SYMBOL_TYPES,
  SoulStore,
  buildDossier,
  dossierPath,
  newManifest,
  pruneDossiers,
} from '@knowledge-crib/core';
import type { Dossier } from '@knowledge-crib/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hoistedDossierOpts } from './dossiers.js';
import { indexRepo } from './pipeline.js';

// The Spring fixture exercises the full hoisted surface: @Bean producers (produces edges),
// constructor DI (injects), @RequestMapping handlers (exposes routes), and method bodies
// (executes statements + recorded call sites for coverage resolution).
const JAVA_SPRING = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'java-spring');
const NOW = '2026-01-01T00:00:00.000Z';

describe('hoistedDossierOpts — buildDossier equivalence (P2.1)', () => {
  let crib: string;
  beforeEach(() => {
    crib = mkdtempSync(join(tmpdir(), 'crib-hoist-'));
  });
  afterEach(() => rmSync(crib, { recursive: true, force: true }));

  it('dossiers built with and without the hoisted opts are deep-equal for every callable', async () => {
    const soul = new SoulStore(crib, { manifest: newManifest({ now: NOW }) });
    soul.load();
    await indexRepo(soul, JAVA_SPRING, { now: NOW, cluster: false, semantic: false });

    const callables = [...soul.iterate('symbol')].filter(
      (n) => n.type !== undefined && CALLABLE_SYMBOL_TYPES.has(n.type),
    );
    expect(callables.length).toBeGreaterThanOrEqual(4); // every handler + @Bean producer

    const opts = hoistedDossierOpts(soul);
    const withHoist: Array<[string, Dossier | undefined]> = [];
    const withoutHoist: Array<[string, Dossier | undefined]> = [];
    for (const node of callables) {
      withHoist.push([node.id, buildDossier(soul, JAVA_SPRING, node.id, NOW, opts)]);
      withoutHoist.push([node.id, buildDossier(soul, JAVA_SPRING, node.id, NOW)]);
    }

    // THE equivalence: identical `now`, identical soul, so every field — including builtAt —
    // must match. The hoist is a pure speedup, never a behavior change.
    expect(withHoist).toEqual(withoutHoist);

    // The fixture must actually exercise what the hoist carries, or the equivalence above is
    // vacuous: framework semantics (routes + produces), decision tables, and coverage on every
    // callable — the three consumers of outgoing/incoming/producerOf/nameIndex.
    const built = withHoist.map(([, d]) => d).filter((d) => d !== undefined);
    expect(built.length).toBe(callables.length);
    for (const d of built) {
      expect(d!.rules).toBeDefined();
      expect(d!.coverage).toBeDefined();
    }
    expect(built.some((d) => (d!.framework?.routes?.length ?? 0) > 0)).toBe(true);
    expect(built.some((d) => (d!.framework?.produces?.length ?? 0) > 0)).toBe(true);
    // at least one callable with a real body — coverage's bodyPresent/unimplemented fork is live
    expect(built.some((d) => d!.coverage!.bodyPresent)).toBe(true);
  });
});

describe('pruneDossiers — path-derived ids (P2.1)', () => {
  let crib: string;
  beforeEach(() => {
    crib = mkdtempSync(join(tmpdir(), 'crib-prune-'));
  });
  afterEach(() => rmSync(crib, { recursive: true, force: true }));

  /** Drop a dossier file at the path the id hashes to (the writeDossier layout). */
  function writeAt(id: string, contents: string): string {
    const path = dossierPath(crib, id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  it('keeps a live node dossier, prunes orphans, never parses file contents', () => {
    const live = 'sym:LiveCallable';
    const livePath = writeAt(live, JSON.stringify({ id: live }));
    const orphanPath = writeAt('sym:GoneCallable', JSON.stringify({ id: 'sym:GoneCallable' }));
    // a corrupt orphan — no readable id at all; the path alone must mark it dead
    const corruptPath = writeAt('sym:CorruptCallable', '{not json');

    const pruned = pruneDossiers(crib, new Set([live]));
    expect(pruned).toBe(2);
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(corruptPath)).toBe(false);
  });

  it('keeps a corrupt-but-live file (pruning is path-keyed, contents are irrelevant)', () => {
    // The path is the identity: a file AT a live node's path survives pruning without being read.
    // (The old parse-the-file implementation deleted it here; runDossiers rewrites it anyway
    // because readDossier reports a corrupt file as missing — so this is not a stale-serving path.)
    const live = 'sym:LiveCallable';
    const livePath = writeAt(live, '{corrupt');
    const pruned = pruneDossiers(crib, new Set([live]));
    expect(pruned).toBe(0);
    expect(existsSync(livePath)).toBe(true);
  });

  it('returns 0 when no dossier store exists yet (first index)', () => {
    expect(pruneDossiers(crib, new Set(['sym:anything']))).toBe(0);
  });
});
