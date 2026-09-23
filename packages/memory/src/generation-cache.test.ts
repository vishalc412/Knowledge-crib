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
  NO_DEPENDENCY,
  SoulStoreSoulPort,
  UNVERSIONED,
  __resetMemoryLockGuardForTest,
  attachVolatileFreshness,
  bindEvaluationPass,
  entrySetFingerprint,
  fingerprintGenerations,
  freshnessAgeMs,
} from './index.js';
import type {
  DependencyGenerations,
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
    const base = fingerprintGenerations(base0());
    expect(base).toBe('c1|g1|l1|p1|r1|d1|f1|e1|i1');
    expect(fingerprintGenerations({ ...base0(), code: 'c2' })).not.toBe(base);
    // The two WP1 slots are members of the fingerprint, not decoration — a `reader` or `ledger` move
    // alone must re-fingerprint, or §7.4's stale read stays reachable (D2-c).
    expect(fingerprintGenerations({ ...base0(), reader: 'g2' })).not.toBe(base);
    expect(fingerprintGenerations({ ...base0(), ledger: 'l2' })).not.toBe(base);
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

function base0(): DependencyGenerations {
  return {
    code: 'c1',
    reader: 'g1',
    ledger: 'l1',
    policy: 'p1',
    receipts: 'r1',
    decisions: 'd1',
    feedback: 'f1',
    embedder: 'e1',
    index: 'i1',
  };
}

/** The fingerprint a `bind` reaches from a bare `{ code }` — every other slot is at its default. */
const RAW_BIND = 'c1|none|none|none|none|none|none|none|none';

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
    expect(p.generation()).toBe(RAW_BIND);
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
    expect(cache.currentGeneration).toBe(RAW_BIND);
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

// ─── the caller's pin: the reader + ledger slots (WP1 items 7/8, D2-c) ───────

describe('bindEvaluationPass pins the reader + ledger slots (D2-c)', () => {
  const soul = (): MemorySoulPort => fakeSoulWithGeneration({ generation: 'gen-1' });
  const none = { decisions: [], localDecisions: [], feedback: [] };
  /** Opaque memoized verdict — identity is all these assertions need. */
  const EVAL_FOR_PIN: RecordEvaluation = {
    evidence: 'valid',
    applicability: 'current',
    items: [],
    reattached: false,
    reasons: [],
  };

  it('reports the pin on the pass generation, so the verdict names what it is current against', () => {
    const bound = bindEvaluationPass({ soul: soul() }, none, {
      reader: 'reader:A',
      ledger: 'ledger:9',
    });

    // `code` is still the soul port's own generation — the pin ADDS a dependency, never replaces one.
    expect(bound.generation).toBe('gen-1|reader:A|ledger:9|none|none|0:|0:|none|none');
  });

  it('a reader bump misses even though the soul generation is untouched — D2-c', () => {
    const cache = new GenerationCache({ nowMs: () => 1000 });
    const gathered = { decisions: [], localDecisions: [], feedback: [] };
    const first = bindEvaluationPass({ soul: soul() }, gathered, {
      cache,
      reader: 'reader:A',
      ledger: 'ledger:9',
    });
    first.evalCtx!.cache!.set('k', EVAL_FOR_PIN);

    // The §7.4 sequence, reduced to the slot that makes it reachable: a working-tree edit republishes
    // the code reader while the canonical soul has not moved. Before this item no slot could move, so
    // the memoized verdict was served for evidence whose anchored span had changed.
    const second = bindEvaluationPass({ soul: soul() }, gathered, {
      cache,
      reader: 'reader:B',
      ledger: 'ledger:9',
    });

    expect(second.evalCtx).toBeDefined();
    expect(second.evalCtx!.cache!.get('k')).toBeUndefined();
    expect(second.generation).not.toBe(first.generation);
    expect(cache.size).toBe(0);
  });

  it('a ledger-only change misses even though the soul generation is untouched — D2-c', () => {
    const cache = new GenerationCache({ nowMs: () => 1000 });
    const gathered = { decisions: [], localDecisions: [], feedback: [] };
    const first = bindEvaluationPass({ soul: soul() }, gathered, {
      cache,
      reader: 'reader:A',
      ledger: 'ledger:9',
    });
    first.evalCtx!.cache!.set('k', EVAL_FOR_PIN);

    // The other half of the collapse: the ledger moves (a durable graph entry lands) without the soul
    // moving and without touching the decision/feedback entry sets — invisible to every pre-WP1 slot.
    const second = bindEvaluationPass({ soul: soul() }, gathered, {
      cache,
      reader: 'reader:A',
      ledger: 'ledger:10',
    });

    expect(second.evalCtx!.cache!.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('an omitted pin binds `none`, not UNVERSIONED — a reader-less caller still caches', () => {
    const bound = bindEvaluationPass({ soul: soul() }, none);

    // The distinction the slots turn on: "no such dependency" is cacheable, "cannot name it" is not.
    // Refusing here would have made every existing CLI/MCP read evaluate fresh, which is why the
    // default is `none` and item 8's call sites opt IN to the pin.
    expect(bound.evalCtx).toBeDefined();
    expect(bound.generation).toBe('gen-1|none|none|none|none|0:|0:|none|none');
  });

  it('UNVERSIONED refuses the cache: a reader that exists but cannot be named is never trusted', () => {
    const bound = bindEvaluationPass({ soul: soul() }, none, {
      reader: UNVERSIONED,
      ledger: 'ledger:9',
    });

    // Adoption pending: an overlay is serving reads but its generation is not yet authoritative, so
    // there is nothing to prove a memoized verdict current against. Fresh evaluation is the only
    // honest answer — and it must not be silently reported as a cacheable generation.
    expect(bound.evalCtx).toBeUndefined();
    expect(bound.generation).toBeNull();
  });

  // ── the pin as the serve process carries it: on the long-lived eval context ──

  it('resolves the CONTEXT pin at bind time, so a reader that moves between reads busts — D2-c', () => {
    // The serve process's shape: one long-lived context, one pin whose accessor answers "what is this
    // process serving RIGHT NOW". A value captured once at construction would answer yesterday's
    // question — either never busting (§7.4) or busting on the wrong trigger.
    let served = 'reader:A';
    const ctx: MemoryEvalContext = {
      soul: soul(),
      pin: { reader: () => served, ledger: () => 'ledger:9' },
    };
    const cache = new GenerationCache({ nowMs: () => 1000 });

    const first = bindEvaluationPass(ctx, none, { cache });
    expect(first.generation).toBe('gen-1|reader:A|ledger:9|none|none|0:|0:|none|none');
    first.evalCtx!.cache!.set('k', EVAL_FOR_PIN);

    // One refresh cycle later: the bundle the process serves has moved. The memoized verdict was
    // evaluated against the OLD snapshot's spans, so serving it now is the stale read.
    served = 'reader:B';
    const second = bindEvaluationPass(ctx, none, { cache });

    expect(second.evalCtx!.cache!.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(second.generation).toContain('reader:B');
  });

  it('a context with no reader pins `none` and still caches (manual freshness mode)', () => {
    // The manual-mode server and every one-shot command resolve against the canonical soul: there is
    // no snapshot to be stale against, so the slot is `NO_DEPENDENCY` — not a refusal, and not a
    // claim of a dependency the process does not have.
    const bound = bindEvaluationPass({ soul: soul(), pin: { reader: () => NO_DEPENDENCY } }, none);

    expect(bound.evalCtx).toBeDefined();
    expect(bound.generation).toBe('gen-1|none|none|none|none|0:|0:|none|none');
  });

  it('an explicit per-pass pin overrides the context pin', () => {
    const ctx: MemoryEvalContext = { soul: soul(), pin: { reader: () => 'reader:A' } };

    // The context says what the process serves; an argument says what THIS pass reads. The argument
    // wins, so a caller can pin one read without disturbing the session's identity.
    expect(bindEvaluationPass(ctx, none, { reader: 'reader:EXPLICIT' }).generation).toContain(
      'reader:EXPLICIT',
    );
    expect(bindEvaluationPass(ctx, none).generation).toContain('reader:A');
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
    // KCRIB_PRINCIPAL_ID is pinned rather than inherited: the fixture store is migrated under
    // `principal:local` (see migratedLocal), and a developer shell that exported a different id would
    // otherwise stamp and gather under different owners, turning these tests environment-dependent.
    env = {
      ...process.env,
      KCRIB_MEMORY_DIR: home,
      KCRIB_REGISTRY_DIR: home,
      KCRIB_PRINCIPAL_ID: 'principal:local',
    };
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

  /**
   * A local store holding ONE recall-eligible record — the shape a private store has after
   * `crib memory migrate` (WP1 item 12), built through that supported path rather than by hand.
   *
   * The **alias snapshot** `migrateToV2` writes is the half these tests actually need: a bare
   * memory-2 record carries no `verdicts` field, so `effectiveVerdicts` projects it as `candidate`
   * trust and `isRecallEligible` drops it. Hand-building a v2 record would therefore empty these
   * tests for a silent reason.
   *
   * The **stamp** is not what admits it — the principal boundary is OFF unless `KCRIB_STRICT_PRINCIPAL`
   * is set (see `resolveStrictPrincipal`, and D-2 in the WP1 spec for why it cannot be on by default).
   * The stamp is kept so the fixture is the shape a real migrated store has rather than one that only
   * works while the boundary is off, and `env` pins the principal so a developer shell that exported
   * a different id cannot change which owner the fixture is built for.
   */
  function migratedLocal(): MemoryStore {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    local.upsertEntry('active', record());
    local.migrateToV2({ provenance: { principalId: 'principal:local' } });
    return local;
  }

  it('reports the dependency generation on provenance and the volatile trio per hit', () => {
    const local = migratedLocal();
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
    expect(res.provenance.generation).toBe('gen-1|none|none|none|none|0:|0:|none|none');
    const hit = res.hits[0];
    if (!hit) throw new Error('no hit');
    // non-enumerable trio: readable explicitly, invisible to JSON (and thus to ifHash)
    expect(hit.freshness.generation).toBe('gen-1|none|none|none|none|0:|0:|none|none');
    expect(hit.freshness.evaluatedAtMs).toBe(5000);
    expect(hit.freshness.ageMs).toBe(0);
    const flat = JSON.parse(JSON.stringify(hit.freshness)) as Record<string, unknown>;
    expect(flat).toEqual({ state: 'fresh', evaluatedAt: null, codeHead: null });
    expect(JSON.stringify(res)).not.toContain('ageMs');
    expect(JSON.stringify(res)).not.toContain('evaluatedAtMs');
  });

  it('two identical searches stay byte-equal (the ifHash determinism invariant)', () => {
    const local = migratedLocal();
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
    // non-vacuous: two EMPTY responses would also be byte-equal, so pin that there is something to
    // be equal ABOUT before comparing.
    expect(a.hits).toHaveLength(1);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('a generation-less soul port binds nothing (provenance.generation is null, fresh eval still runs)', () => {
    const local = migratedLocal();
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
