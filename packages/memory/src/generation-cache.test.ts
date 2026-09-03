/**
 * G3.3 — the generation-keyed evaluation cache + the revalidation hoists.
 *
 * Red line #1: never revalidate every record to answer one query. One test per clause:
 *
 *   - `GenerationCache`: bind / memoized hit / wholesale invalidation on ANY slot change /
 *     UNVERSIONED refusal (an unversionable dependency never gets a cache) / bounded entries /
 *     display-only clock via an injected `nowMs`.
 *   - `attachVolatileFreshness`: the wall-clock freshness trio attaches NON-enumerably, so the
 *     ifHash canonical form (which walks `Object.keys`) never sees it — the wall-clock law is
 *     enforced by SHAPE, not by discipline.
 *   - evaluator wiring: a memoized evaluation is returned verbatim (frozen) with ZERO port calls;
 *     a changed code generation re-evaluates.
 *   - `SoulStoreSoulPort` hoist over a REAL SoulStore: the O(all-nodes) materialization + per-locator
 *     matches are generation-keyed, so a `putNodes` bump invalidates instead of desynchronising.
 *   - API wiring: a fresh search reports the dependency generation on provenance (enumerable,
 *     ifHash-safe) and the volatile trio on each hit's freshness — and two identical searches stay
 *     byte-equal (the `evaluatedAt: null` invariant scripts/ifhash-check.mjs pins).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import { type Node, contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryRecordId } from './ids.js';
import {
  GenerationCache,
  MemoryApi,
  MemoryEvaluator,
  MemoryStore,
  SoulStoreSoulPort,
  UNVERSIONED,
  __resetMemoryLockGuardForTest,
  attachVolatileFreshness,
  entrySetFingerprint,
  fingerprintGenerations,
  freshnessAgeMs,
} from './index.js';
import type {
  EvaluationCachePort,
  MemoryEvalContext,
  MemoryEvidence,
  MemoryRecord,
  MemorySoulPort,
  RecordEvaluation,
} from './index.js';
import { buildLocatorFromEvidence } from './locator.js';

const T0 = '2026-01-01T00:00:00.000Z';
const REPO = 'r-gen3';
const SUBJECT = 'sym:src/a.ts#A.b';

// ─── unit: fingerprints + pure helpers ───────────────────────────────────────

describe('generation fingerprints', () => {
  it('fingerprintGenerations joins every slot (any slot change re-fingerprints)', () => {
    const base = fingerprintGenerations({
      code: 'c1',
      policy: 'p1',
      receipts: 'r1',
      decisions: 'd1',
      feedback: 'f1',
      embedder: 'e1',
      index: 'i1',
    });
    expect(base).toBe('c1|p1|r1|d1|f1|e1|i1');
    expect(fingerprintGenerations({ ...base0(), code: 'c2' })).not.toBe(base);
  });

  it('entrySetFingerprint is count + max id (append-only sets)', () => {
    expect(entrySetFingerprint([])).toBe('0:');
    const ids = ['dec:b', 'dec:a', 'dec:c'];
    expect(entrySetFingerprint(ids.map((id) => ({ id })))).toBe('3:dec:c');
    // appending a lexicographically smaller id still changes the count
    expect(entrySetFingerprint([...ids.map((id) => ({ id })), { id: 'dec:aa' }])).toBe('4:dec:c');
  });

  it('freshnessAgeMs floors at 0 (a backwards clock never shows a negative age)', () => {
    expect(freshnessAgeMs(1000, 1500)).toBe(500);
    expect(freshnessAgeMs(2000, 1500)).toBe(0);
  });
});

function base0() {
  return {
    code: 'c1',
    policy: 'p1',
    receipts: 'r1',
    decisions: 'd1',
    feedback: 'f1',
    embedder: 'e1',
    index: 'i1',
  };
}

// ─── unit: GenerationCache ───────────────────────────────────────────────────

describe('GenerationCache', () => {
  // The cache stores opaque RecordEvaluation objects; identity is all these tests assert.
  const EVAL: RecordEvaluation = {
    evidence: 'valid',
    applicability: 'current',
    items: [],
    reattached: false,
    reasons: [],
  };

  it('binds a port, memoizes per key, and serves the SAME frozen entry', () => {
    const cache = new GenerationCache({ nowMs: () => 1000 });
    const port = cache.bind({ code: 'c1' });
    expect(port).toBeDefined();
    const p = port!;
    expect(p.generation()).toBe('c1|none|none|none|none|none|none');
    p.set('k1', EVAL);
    expect(p.get('k1')).toBe(EVAL);
    expect(cache.size).toBe(1);
  });

  it('returns undefined WITHOUT mutating when any slot is unversioned', () => {
    const cache = new GenerationCache();
    cache.bind({ code: 'c1' })!.set('kept', EVAL);
    expect(cache.bind({ code: UNVERSIONED })).toBeUndefined();
    expect(cache.bind({ code: 'c1', receipts: UNVERSIONED })).toBeUndefined();
    // the refusal left the previously-bound entries intact at their generation
    expect(cache.size).toBe(1);
    expect(cache.currentGeneration).toBe('c1|none|none|none|none|none|none');
  });

  it('ANY slot change invalidates wholesale (a stale verdict is never served)', () => {
    const cache = new GenerationCache({ nowMs: () => 1000 });
    const first = cache.bind({ code: 'c1', decisions: 'd1' })!;
    first.set('k', EVAL);
    expect(cache.bind({ code: 'c1', decisions: 'd2' })!.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.evaluatedAt).toBeNull(); // re-stamped at the new generation's first fill
  });

  it('an unchanged generation keeps entries across binds (the cross-call hit path)', () => {
    const cache = new GenerationCache();
    const first = cache.bind({ code: 'c1' })!;
    first.set('k', EVAL);
    expect(cache.bind({ code: 'c1' })!.get('k')).toBe(EVAL);
  });

  it('is bounded: hitting maxEntries clears instead of growing unbounded', () => {
    const cache = new GenerationCache({ maxEntries: 2 });
    const port = cache.bind({ code: 'c1' })!;
    port.set('a', EVAL);
    port.set('b', EVAL);
    port.set('c', EVAL);
    expect(cache.size).toBe(1); // cleared at the bound, then the new entry landed
  });

  it('ageMs uses the injected display clock only (never a key or id)', () => {
    let now = 1000;
    const cache = new GenerationCache({ nowMs: () => now });
    expect(cache.ageMs()).toBeNull();
    cache.bind({ code: 'c1' })!.set('k', EVAL);
    expect(cache.ageMs()).toBe(0);
    now = 6500;
    expect(cache.ageMs()).toBe(5500);
    cache.invalidate();
    expect(cache.ageMs()).toBeNull();
  });
});

// ─── unit: non-enumerable volatile freshness ─────────────────────────────────

describe('attachVolatileFreshness (the wall-clock law, enforced by shape)', () => {
  it('attaches generation + evaluatedAtMs + ageMs as non-enumerable properties', () => {
    const target: Record<string, unknown> = { state: 'fresh', evaluatedAt: null, codeHead: null };
    attachVolatileFreshness(target, { generation: 'g1', evaluatedAtMs: 1000 }, 1750);
    expect(target.generation).toBe('g1');
    expect(target.evaluatedAtMs).toBe(1000);
    expect(target.ageMs).toBe(750);
    // invisible to Object.keys / JSON.stringify — the ifHash canonical form
    expect(Object.keys(target)).toEqual(['state', 'evaluatedAt', 'codeHead']);
    expect(JSON.parse(JSON.stringify(target))).toEqual({
      state: 'fresh',
      evaluatedAt: null,
      codeHead: null,
    });
  });

  it('attaches generation alone when nothing was cached (no wall-clock fields at all)', () => {
    const target: Record<string, unknown> = {};
    attachVolatileFreshness(target, { generation: null }, 1000);
    expect(target.generation).toBeNull();
    expect(target.evaluatedAtMs).toBeUndefined();
    expect(target.ageMs).toBeUndefined();
    expect(Object.keys(target)).toEqual([]);
  });
});

// ─── evaluator wiring ────────────────────────────────────────────────────────

/** A soul port WITH a generation signal + call counters (unit fakes without one must never cache). */
function fakeSoulWithGeneration(
  opts: {
    generation?: string;
    nodes?: Node[];
    texts?: Map<string, string>;
  } = {},
): MemorySoulPort & { getNodeCalls: () => number; findByLocatorCalls: () => number } {
  const nodes = opts.nodes ?? [];
  const texts = opts.texts ?? new Map<string, string>();
  let getNodeCalls = 0;
  let findByLocatorCalls = 0;
  const port = {
    generation: () => opts.generation ?? 'gen-1',
    getNode: (id: string) => {
      getNodeCalls++;
      return nodes.find((n) => n.id === id);
    },
    rehydrate: (n: Node) => ({
      text: texts.get(n.id) ?? n.name ?? '',
      truncated: false,
      totalLines: 1,
      startLine: n.span?.start ?? 1,
    }),
    findByLocator: (locator: unknown) => {
      findByLocatorCalls++;
      void locator;
      return [];
    },
    getNodeCalls: () => getNodeCalls,
    findByLocatorCalls: () => findByLocatorCalls,
  };
  return port as MemorySoulPort & { getNodeCalls: () => number; findByLocatorCalls: () => number };
}

function evidence(over: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId: SUBJECT,
    quote: 'does the thing',
    targetHash: 'blake3:abcd1234',
    ...over,
  };
}

function record(over: { evidence?: MemoryEvidence[]; claim?: string } = {}): MemoryRecord {
  const claim = over.claim ?? 'A.b does the thing';
  const ev = over.evidence ?? [evidence()];
  const input = {
    kind: 'fact' as const,
    subject: SUBJECT,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [SUBJECT],
    evidence: ev,
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: T0,
  };
}

describe('evaluator + generation-keyed cache', () => {
  it('a hash-matching evidence evaluates with ZERO port calls, and the SECOND evaluate is served verbatim', () => {
    const soul = fakeSoulWithGeneration({
      nodes: [
        {
          id: SUBJECT,
          kind: 'symbol',
          name: 'A.b',
          qualifiedName: 'A.b',
          file: 'src/a.ts',
          span: { start: 1, end: 100 },
          lang: 'typescript',
          hash: 'blake3:abcd1234',
        } as Node,
      ],
    });
    const evaluator = new MemoryEvaluator();
    const cache = new GenerationCache({ nowMs: () => 1000 });
    const port = cache.bind({ code: soul.generation?.() ?? UNVERSIONED })!;
    const ctx: MemoryEvalContext = { soul, cache: port };
    const r = record();

    const first = evaluator.evaluate(r, ctx);
    expect(first.evidence).toBe('valid'); // the G3.3 hash short-circuit: no re-grounding
    expect(soul.getNodeCalls()).toBe(1);

    const second = evaluator.evaluate(r, ctx);
    expect(second).toBe(first); // the SAME frozen object — no revalidation at all
    expect(soul.getNodeCalls()).toBe(1); // zero further port calls
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('a changed code generation re-evaluates from the ports', () => {
    let generation = 'gen-1';
    const mutable = fakeSoulWithGeneration();
    // re-point the port's generation at the mutable closure
    const soul: MemorySoulPort & { getNodeCalls: () => number } = Object.assign(
      { ...mutable, generation: () => generation },
      { getNodeCalls: mutable.getNodeCalls, findByLocatorCalls: mutable.findByLocatorCalls },
    );
    const evaluator = new MemoryEvaluator();
    const r = record({ evidence: [evidence({ targetHash: 'blake3:deadbeef' })] });

    const first = evaluator.evaluate(r, { soul, cache: cacheBind(generation) });
    expect(soul.getNodeCalls()).toBe(1);

    generation = 'gen-2';
    const second = evaluator.evaluate(r, { soul, cache: cacheBind(generation) });
    expect(soul.getNodeCalls()).toBe(2); // re-evaluated at the new generation
    expect(second).not.toBe(first);
  });
});

function cacheBind(code: string): EvaluationCachePort {
  return new GenerationCache({ nowMs: () => 1000 }).bind({ code })!;
}

// ─── SoulStoreSoulPort hoist over a REAL SoulStore ───────────────────────────

describe('SoulStoreSoulPort generation-keyed hoist', () => {
  let dir = '';
  let soul: SoulStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gen3-soul-'));
    soul = new SoulStore(join(dir, '.crib'), {
      ephemeral: true,
      manifest: newManifest({ now: T0 }),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sym(name: string, path: string, start: number): Node {
    return {
      id: idFor({ kind: 'symbol', path, qualifiedName: name, startLine: start }),
      kind: 'symbol',
      type: 'function',
      name,
      qualifiedName: name,
      file: path,
      span: { start, end: start + 5 },
      lang: 'typescript',
      hash: contentHash(`${path}#${name}`),
    } as Node;
  }

  it('memoizes per locator, and a putNodes bump invalidates instead of desynchronising', () => {
    const assess = sym('assess', 'src/loan.ts', 1);
    soul.putNodes([assess, sym('helper', 'src/loan.ts', 17)]);
    const port = new SoulStoreSoulPort(soul, dir);
    const locator = buildLocatorFromEvidence({
      soulId: assess.id,
      targetHash: assess.hash,
    });
    expect(locator).toBeDefined();

    const genBefore = port.generation();
    const first = port.findByLocator(locator!);
    expect(first.map((n) => n.id)).toEqual([assess.id]);
    expect(port.findByLocator(locator!)).toBe(first); // memoized — the SAME array

    // a node mutation bumps the generation; the stale memo must NOT survive it. The new node sits
    // in the SAME file with the SAME content hash as the locator's fingerprint, so it MATCHES —
    // proving the re-materialized scan (not the memo) answered.
    const moved = { ...sym('assess', 'src/loan.ts', 200), hash: assess.hash } as Node;
    soul.putNodes([moved]);
    expect(port.generation()).not.toBe(genBefore);
    const after = port.findByLocator(locator!);
    expect(after.map((n) => n.id)).toContain(moved.id);
    expect(port.findByLocator(locator!)).toBe(after);
  });

  it('invalidateLocatorCache drops the materialized array + memo', () => {
    const assess = sym('assess', 'src/loan.ts', 1);
    soul.putNodes([assess]);
    const port = new SoulStoreSoulPort(soul, dir);
    const locator = buildLocatorFromEvidence({ soulId: assess.id, targetHash: assess.hash })!;
    const first = port.findByLocator(locator);
    port.invalidateLocatorCache();
    expect(port.findByLocator(locator)).not.toBe(first);
    expect(port.findByLocator(locator)).toEqual(first);
  });
});

// ─── API wiring: provenance generation + per-hit volatile freshness ──────────

describe('MemoryApi.search freshness metadata', () => {
  let home = '';
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gen3-api-home-'));
    env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
    __resetMemoryLockGuardForTest();
  });

  afterEach(() => {
    __resetMemoryLockGuardForTest();
    rmSync(home, { recursive: true, force: true });
  });

  /** A hash-matching soul port with a generation signal → the fresh path short-circuits per item. */
  function freshSoul(): MemorySoulPort {
    return {
      generation: () => 'gen-1',
      getNode: (id: string) =>
        id === SUBJECT
          ? ({
              id: SUBJECT,
              kind: 'symbol',
              name: 'A.b',
              file: 'src/a.ts',
              span: { start: 1, end: 100 },
              lang: 'typescript',
              hash: 'blake3:abcd1234',
            } as Node)
          : undefined,
      rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
      findByLocator: () => [],
    };
  }

  it('reports the dependency generation on provenance and the volatile trio per hit', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const r = record();
    local.upsertEntry('active', r);
    const evaluator = new MemoryEvaluator();
    const evalCtx: MemoryEvalContext = { soul: freshSoul() };
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      nowMs: () => 5000,
      evaluator,
      evalCtx,
    });

    const res = api.search(SUBJECT);
    expect(res.provenance.fresh).toBe(true);
    expect(res.provenance.generation).toBe('gen-1|none|none|0:|0:|none|none');
    const hit = res.hits[0];
    if (!hit) throw new Error('no hit');
    // non-enumerable trio: readable explicitly, invisible to JSON (and thus to ifHash)
    expect(hit.freshness.generation).toBe('gen-1|none|none|0:|0:|none|none');
    expect(hit.freshness.evaluatedAtMs).toBe(5000);
    expect(hit.freshness.ageMs).toBe(0);
    const flat = JSON.parse(JSON.stringify(hit.freshness)) as Record<string, unknown>;
    expect(flat).toEqual({ state: 'fresh', evaluatedAt: null, codeHead: null });
    expect(JSON.stringify(res)).not.toContain('ageMs');
    expect(JSON.stringify(res)).not.toContain('evaluatedAtMs');
  });

  it('two identical searches stay byte-equal (the ifHash determinism invariant)', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    local.upsertEntry('active', record());
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      nowMs: () => 5000,
      evaluator: new MemoryEvaluator(),
      evalCtx: { soul: freshSoul() },
    });
    const a = api.search(SUBJECT);
    const b = api.search(SUBJECT);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('a generation-less soul port binds nothing (provenance.generation is null, fresh eval still runs)', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    local.upsertEntry('active', record());
    const preG33: MemorySoulPort = {
      // resolves the anchor + matches the hash (the G3.3 short-circuit answers per item), but
      // carries NO generation() — the pre-G3.3 port shape. The pass must still evaluate FRESH.
      getNode: (id: string) =>
        id === SUBJECT
          ? ({
              id: SUBJECT,
              kind: 'symbol',
              name: 'A.b',
              file: 'src/a.ts',
              span: { start: 1, end: 100 },
              lang: 'typescript',
              hash: 'blake3:abcd1234',
            } as Node)
          : undefined,
      rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
      findByLocator: () => [],
    };
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      evaluator: new MemoryEvaluator(),
      evalCtx: { soul: preG33 },
    });
    const res = api.search(SUBJECT);
    expect(res.provenance.fresh).toBe(true); // fresh evaluation still ran
    expect(res.provenance.generation).toBeNull(); // but nothing was cached — honest null
    const hit = res.hits[0];
    if (!hit) throw new Error('no hit');
    expect(hit.freshness.generation).toBeNull();
    expect(hit.freshness.ageMs).toBeUndefined();
  });
});
