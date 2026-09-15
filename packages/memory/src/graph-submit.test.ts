/**
 * WP-G1 commit 2 — the graph submission storage laws:
 *
 *   - roundtrip: submitted entries read back byte-equal from the `graph` collection (local AND
 *     global — the two stores the launch plan gives the graph);
 *   - idempotent re-submit: identical entries write NOTHING (no shard rewrite, no generation
 *     bump) — the plan's exit criterion "repeated imports produce the same canonical assertions";
 *   - additive merge: supporter lists and membership union, `knownAt` never regresses, a
 *     resolution decision is first-writer-wins (never re-authored);
 *   - fail-closed gates: the TEAM store refuses `graph` outright, a non-graph entry is refused,
 *     a caller-supplied `admission` other than 'proposed' fails schema validation;
 *   - ack-after-persist: a faulted atomic write throws and acknowledges nothing, the prior
 *     snapshot is intact, and the retry re-derives the same content-addressed ids (the plan's
 *     "interrupted writes and projection restarts do not lose acknowledged work").
 *
 * The persist fault is injected exactly as in `ack-after-persist.test.ts`: `./atomic.js` is
 * mocked AROUND the real implementation, and writes whose target lives under the faulted path
 * prefix throw (the temp file is never renamed over the target — the mid-write crash window).
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemorySchemaError,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  clearMemoryCollectionCache,
  createGraphAssertion,
  createGraphEntity,
  createGraphResolutionDecision,
  memoryShard,
} from './index.js';
import type { GraphAssertion, GraphEntity, MemoryNamespace, MemoryProvenance } from './types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const REPO = 'graph-store-test';

const NAMESPACE: MemoryNamespace = {
  principalId: 'principal:graph-store',
  workspaceId: 'workspace:graph-store',
};
const PROVENANCE: MemoryProvenance = {
  principalId: 'principal:graph-store',
  deviceId: 'device:graph-store',
  actorId: 'agent:graph-store',
  clientId: 'vitest',
};
// A SECOND submitter for the same content id — the merge laws must not let the re-import erase
// the first submitter's state (meta) even though the incoming entry's own fields win by design.
const PROVENANCE_B: MemoryProvenance = {
  principalId: 'principal:graph-store',
  deviceId: 'device:graph-store',
  actorId: 'agent:graph-store-b',
  clientId: 'vitest',
};
const REPO_SCOPE = { boundary: 'repo', repoId: REPO } as const;

// The fault injection: a path prefix whose atomic writes throw. Hoisted for vi.mock.
const fault = vi.hoisted(() => ({ prefix: undefined as string | undefined }));

vi.mock('./atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic.js')>();
  return {
    ...actual,
    writeJsonAtomic: (path: string, content: string): void => {
      if (fault.prefix !== undefined && path.startsWith(fault.prefix)) {
        throw new Error(`simulated persist fault: ${path}`);
      }
      actual.writeJsonAtomic(path, content);
    },
  };
});

// ─── harness ─────────────────────────────────────────────────────────────────

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-graph-submit-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  fault.prefix = undefined;
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  fault.prefix = undefined; // never leak a fault into a later test
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

function localStore(): MemoryStore {
  return MemoryStore.local(REPO, { env, now: () => T0 });
}

function entity(members?: string[]): GraphEntity {
  return createGraphEntity({
    kind: 'service',
    name: 'OrderService',
    namespace: NAMESPACE,
    scope: REPO_SCOPE,
    provenance: PROVENANCE,
    ...(members !== undefined ? { members } : {}),
  });
}

function assertion(input: {
  supportedBy?: string[];
  knownAt?: string;
  subject?: string;
  provenance?: MemoryProvenance;
  meta?: Record<string, unknown>;
}): GraphAssertion {
  return createGraphAssertion({
    predicate: 'about',
    subject: input.subject ?? 'mem:0123456789abcdef',
    object: 'topic:ledger-retry-idempotency',
    namespace: NAMESPACE,
    scope: REPO_SCOPE,
    validAt: T0,
    knownAt: input.knownAt ?? T0,
    supportedBy: input.supportedBy ?? ['mem:0123456789abcdef'],
    provenance: input.provenance ?? PROVENANCE,
    ...(input.meta !== undefined ? { meta: input.meta } : {}),
  });
}

/** An assertion whose subject varies — the ONLY fixture axis that moves it across shards
 *  (memoryShard is a blake3 slice of the id, and the id seeds on the subject). */
function assertionWithSubject(index: number): GraphAssertion {
  return assertion({
    subject: `mem:${index.toString(16).padStart(16, '0')}`,
    supportedBy: [`mem:${index.toString(16).padStart(16, '0')}`],
  });
}

/** An assertion whose id lands in a DIFFERENT shard from `exclude` (or the SAME shard when
 *  `sameShard` — the two tests that need shard control search until the hash obliges). */
function assertionInShard(exclude: string, sameShard: boolean): GraphAssertion {
  for (let i = 1; i < 10_000; i++) {
    const candidate = assertionWithSubject(i);
    const same = memoryShard(candidate.id) === memoryShard(exclude);
    if (same === sameShard) return candidate;
  }
  throw new Error(`no ${sameShard ? 'same' : 'different'}-shard fixture found`);
}

function resolution(actor: string): ReturnType<typeof createGraphResolutionDecision> {
  return createGraphResolutionDecision({
    kind: 'establish',
    entityA: 'entity:graph-store-test/OrderService',
    entityB: 'entity:ledger/OrderService',
    namespace: NAMESPACE,
    scope: REPO_SCOPE,
    provenance: PROVENANCE,
    actor,
    ts: T0,
  });
}

/** The raw bytes of the shard files holding `ids` (idempotence is asserted on disk, not on the
 *  returned summary — a no-op submit must not even rewrite a file it agrees with). */
function shardBytes(store: MemoryStore, ...ids: string[]): string[] {
  const shards = new Set(ids.map((id) => memoryShard(id)));
  return [...shards].map((s) => readFileSync(store.shardPath('graph', s), 'utf8'));
}

// ─── roundtrip + idempotence ─────────────────────────────────────────────────

describe('graph submission — roundtrip', () => {
  it('submits and reads back graph entries from the local store', () => {
    const store = localStore();
    const e = entity(['sym:packages/demo/ledger']);
    const a = assertion({});
    const res = store.submitGraphEntries([e, a]);
    expect(res.written.sort()).toEqual([a.id, e.id].sort());
    expect(res.skipped).toEqual([]);
    const entries = store.readCollection('graph').entries;
    expect(entries.map((x) => x.id).sort()).toEqual([a.id, e.id].sort());
    expect(entries).toEqual(expect.arrayContaining([e, a]));
  });

  it('accepts the global store too (the launch plan gives graph to local + global)', () => {
    const store = MemoryStore.global({ env, now: () => T0 });
    const e = entity();
    const res = store.submitGraphEntries([e]);
    expect(res.written).toEqual([e.id]);
    expect(store.readCollection('graph').entries.map((x) => x.id)).toEqual([e.id]);
  });
});

describe('graph submission — idempotent re-submit', () => {
  it('writes NOTHING for a byte-identical resubmission (not even a shard rewrite)', () => {
    const store = localStore();
    const a = assertion({});
    store.submitGraphEntries([a]);
    const before = shardBytes(store, a.id);

    const res = store.submitGraphEntries([a]);
    expect(res.written).toEqual([]);
    expect(res.skipped).toEqual([a.id]);
    expect(shardBytes(store, a.id)).toEqual(before); // the bytes never changed
    expect(store.readCollection('graph').entries.map((x) => x.id)).toEqual([a.id]);
  });
});

// ─── additive merge laws ──────────────────────────────────────────────────────

describe('graph submission — additive merge', () => {
  it('unions supporter lists and never regresses knownAt on a re-derived assertion', () => {
    const store = localStore();
    const first = assertion({ supportedBy: ['mem:a'], knownAt: T0 });
    expect(store.submitGraphEntries([first]).written).toEqual([first.id]);

    // The same assertion re-imported with a GROWN supporter list and a later knownAt: same id
    // (both are outside the seed), merged additively.
    const second = assertion({ supportedBy: ['mem:b'], knownAt: T1 });
    const res = store.submitGraphEntries([second]);
    expect(res.written).toEqual([second.id]);
    const stored = store.readCollection('graph').entries[0] as GraphAssertion;
    expect(stored.supportedBy).toEqual(['mem:a', 'mem:b']); // union, sorted
    expect(stored.knownAt).toBe(T1); // transaction time moved forward

    // A replayed OLDER import cannot regress it — and now needs no write at all.
    const replay = assertion({ supportedBy: ['mem:a'], knownAt: T0 });
    const res2 = store.submitGraphEntries([replay]);
    expect(res2.written).toEqual([]);
    expect(res2.skipped).toEqual([replay.id]);
    const after = store.readCollection('graph').entries[0] as GraphAssertion;
    expect(after.supportedBy).toEqual(['mem:a', 'mem:b']);
    expect(after.knownAt).toBe(T1);
  });

  it('unions entity membership without re-addressing the entity', () => {
    const store = localStore();
    const first = entity(['sym:a']);
    store.submitGraphEntries([first]);
    const second = entity(['sym:b']);
    expect(second.id).toBe(first.id); // membership is outside the id seed
    const res = store.submitGraphEntries([second]);
    expect(res.written).toEqual([second.id]);
    const stored = store.readCollection('graph').entries[0] as GraphEntity;
    expect(stored.members).toEqual(['sym:a', 'sym:b']);
    // The grown set is now stable: re-submitting either input is a byte-identical no-op.
    expect(store.submitGraphEntries([first]).written).toEqual([]);
    expect(store.submitGraphEntries([second]).written).toEqual([]);
  });

  it('keeps the FIRST writer of a resolution decision (never re-authors it)', () => {
    const store = localStore();
    const first = resolution('operator:alpha');
    store.submitGraphEntries([first]);
    const second = resolution('operator:beta'); // same {kind, entityA, entityB} seed → same id
    expect(second.id).toBe(first.id);
    const res = store.submitGraphEntries([second]);
    expect(res.written).toEqual([]);
    expect(res.skipped).toEqual([second.id]);
    const stored = store.readCollection('graph').entries[0] as { actor: string };
    expect(stored.actor).toBe('operator:alpha');
  });
});

// ─── fail-closed gates ────────────────────────────────────────────────────────

describe('graph submission — fail-closed gates', () => {
  it('refuses the team store outright (graph proposals are machine-local until promoted)', () => {
    const cribDir = join(home, 'crib');
    const team = MemoryStore.team(cribDir, { env, now: () => T0 });
    expect(() => team.submitGraphEntries([assertion({})])).toThrow(
      /collection 'graph' is not held by the team store/,
    );
  });

  it('refuses a well-formed non-graph entry (nothing but gent/grel/gres may enter)', () => {
    const store = localStore();
    const alien = {
      id: 'mem:0123456789abcdef',
      schemaVersion: '1',
      kind: 'fact',
      claim: 'not a graph entry',
      subject: 'sym:x',
      scope: REPO_SCOPE,
      evidence: [],
      authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'vitest' },
      origin: 'observe',
      proposedAt: T0,
    };
    expect(() => store.submitGraphEntries([alien as never])).toThrow(
      /refusing to submit non-graph entry mem:0123456789abcdef/,
    );
    expect(store.readCollection('graph').entries).toHaveLength(0);
  });

  it('refuses a caller-supplied admission other than proposed (the schema const)', () => {
    const store = localStore();
    const smuggled = { ...assertion({}), admission: 'trusted' } as never;
    expect(() => store.submitGraphEntries([smuggled])).toThrow(MemorySchemaError);
    expect(store.readCollection('graph').entries).toHaveLength(0);
  });
});

// ─── ack-after-persist (the durability law) ───────────────────────────────────

describe('graph submission — ack-after-persist', () => {
  it('throws and acknowledges NOTHING when the shard persist faults; the retry re-derives the same ids', () => {
    const store = localStore();
    const seeded = assertion({ supportedBy: ['mem:seed'] });
    store.submitGraphEntries([seeded]); // the prior valid snapshot
    const priorBytes = shardBytes(store, seeded.id);
    const priorIds = store.readCollection('graph').entries.map((e) => e.id);

    const fresh = entity(['sym:x']);
    fault.prefix = join(store.rootDir, 'graph');
    expect(() => store.submitGraphEntries([fresh])).toThrow(/simulated persist fault/);

    // The faulted rename left the old shard in place: the acknowledged prior snapshot survives.
    expect(shardBytes(store, seeded.id)).toEqual(priorBytes);
    expect(store.readCollection('graph').entries.map((e) => e.id)).toEqual(priorIds);

    // The fault heals: a retry re-derives the SAME content-addressed id and completes the write.
    fault.prefix = undefined;
    const res = store.submitGraphEntries([fresh]);
    expect(res.written).toEqual([fresh.id]);
    expect(
      store
        .readCollection('graph')
        .entries.map((e) => e.id)
        .sort(),
    ).toEqual([fresh.id, seeded.id].sort());
  });

  it('survives a projection restart: a cleared read cache re-reads the durable state', () => {
    const store = localStore();
    const a = assertion({});
    const e = entity(['sym:a']);
    store.submitGraphEntries([a, e]);

    // A restarted projection has no memoized reads: the durable store is the only truth.
    clearMemoryCollectionCache();
    const entries = store.readCollection('graph').entries;
    expect(entries.map((x) => x.id).sort()).toEqual([a.id, e.id].sort());
    expect(entries).toEqual(expect.arrayContaining([a, e]));
  });
});

// ─── regression pins for the adversarial-review fixes ─────────────────────────
//
// Each block below pins one defect the 5-lens review confirmed in the first cut of
// submitGraphEntries (the raw findings were adjudicated against the code inline because the
// verify agents died on provider 429s; these tests ARE the adjudication, made durable).

describe('graph submission — knownAt is chronological, not lexicographic', () => {
  it('keeps the later INSTANT when an offset-form replay would win a string compare', () => {
    const store = localStore();
    // 23:00Z on the 14th — a plain UTC stamp.
    const first = assertion({ knownAt: '2026-09-14T23:00:00Z' });
    expect(store.submitGraphEntries([first]).written).toEqual([first.id]);

    // The replay is stamped +05:00 local: 01:00 on the 15th LOOKS later as a string but is
    // 20:00Z — three hours EARLIER. A string compare would regress the transaction time; the
    // law must compare instants and keep the prior spelling.
    const replay = assertion({ knownAt: '2026-09-15T01:00:00+05:00' });
    expect(replay.id).toBe(first.id); // knownAt is outside the id seed
    const res = store.submitGraphEntries([replay]);
    expect(res.written).toEqual([]);
    expect(res.skipped).toEqual([replay.id]);
    const stored = store.readCollection('graph').entries[0] as GraphAssertion;
    expect(stored.knownAt).toBe('2026-09-14T23:00:00Z');
  });

  it('takes a later fractional-second instant over an earlier whole-second spelling', () => {
    const store = localStore();
    const first = assertion({ knownAt: '2026-09-15T00:00:00Z' }); // whole seconds
    expect(store.submitGraphEntries([first]).written).toEqual([first.id]);
    const later = assertion({ knownAt: '2026-09-15T00:00:00.500Z' }); // 500ms later
    const res = store.submitGraphEntries([later]);
    expect(res.written).toEqual([later.id]); // a REAL advance — written, not skipped
    const stored = store.readCollection('graph').entries[0] as GraphAssertion;
    expect(stored.knownAt).toBe('2026-09-15T00:00:00.500Z');
  });
});

describe('graph submission — merge parity (nothing the first writer set is erased)', () => {
  it('preserves prior grel meta when a re-import omits it; overlapping keys go to the newcomer', () => {
    const store = localStore();
    const withMeta = assertion({
      meta: { source: 'import-1', confidence: 0.9 },
      provenance: PROVENANCE,
    });
    expect(store.submitGraphEntries([withMeta]).written).toEqual([withMeta.id]);

    // A second submitter re-imports the same content id with NO meta. Pre-fix this ERASED the
    // first submitter's meta entirely; the merge must carry it forward (and only let the
    // incoming entry's own fields — provenance included — win, by design).
    const withoutMeta = assertion({ provenance: PROVENANCE_B });
    expect(withoutMeta.id).toBe(withMeta.id);
    const res = store.submitGraphEntries([withoutMeta]);
    expect(res.written).toEqual([withoutMeta.id]); // provenance changed → bytes changed
    const stored = store.readCollection('graph').entries[0] as GraphAssertion;
    expect(stored.meta).toEqual({ source: 'import-1', confidence: 0.9 }); // NOT erased
    expect(stored.provenance.actorId).toBe('agent:graph-store-b'); // incoming, by design
  });

  it('unions gent labels and merges meta without erasing omitted keys', () => {
    const store = localStore();
    const base = {
      kind: 'service' as const,
      name: 'OrderService',
      namespace: NAMESPACE,
      scope: REPO_SCOPE,
    };
    const e1 = createGraphEntity({
      ...base,
      provenance: PROVENANCE,
      labels: ['l2', 'l1'],
      meta: { a: 1, keep: 'first-writer' },
    });
    expect(store.submitGraphEntries([e1]).written).toEqual([e1.id]);
    const e2 = createGraphEntity({
      ...base,
      provenance: PROVENANCE_B,
      labels: ['l3', 'l1'], // l1 overlaps — the union dedupes
      meta: { a: 2 }, // 'keep' omitted — must survive
    });
    expect(e2.id).toBe(e1.id); // labels/meta are outside the id seed
    expect(store.submitGraphEntries([e2]).written).toEqual([e2.id]);
    const stored = store.readCollection('graph').entries[0] as GraphEntity;
    expect(stored.labels).toEqual(['l1', 'l2', 'l3']); // sorted union
    expect(stored.meta).toEqual({ a: 2, keep: 'first-writer' }); // merged, not replaced
  });
});

describe('graph submission — in-batch duplicates partition the ack', () => {
  it('acks an identical [x, x] batch once: written, never also skipped', () => {
    const store = localStore();
    const x = assertion({});
    const res = store.submitGraphEntries([x, x]);
    expect(res.written).toEqual([x.id]);
    expect(res.skipped).toEqual([]); // the partition law — no id in both lists
  });

  it('merges a same-id pair within one batch and acks the id exactly once', () => {
    const store = localStore();
    const a1 = assertion({ supportedBy: ['mem:a'], knownAt: T0 });
    const a2 = assertion({ supportedBy: ['mem:b'], knownAt: T1 });
    expect(a2.id).toBe(a1.id); // supporters/knownAt are outside the id seed
    const res = store.submitGraphEntries([a1, a2]);
    expect(res.written).toEqual([a1.id]); // ONE ack, with the merged content
    expect(res.skipped).toEqual([]);
    const stored = store.readCollection('graph').entries[0] as GraphAssertion;
    expect(stored.supportedBy).toEqual(['mem:a', 'mem:b']);
    expect(stored.knownAt).toBe(T1);
  });
});

describe('graph submission — canonical bytes regardless of producer order', () => {
  it('sorts set-valued lists on first write, so reversed imports converge on identical bytes', () => {
    // Two stores, identical corpus, opposite enumeration order: the stored shard bytes must be
    // byte-identical (the plan's "repeated imports produce the same canonical assertions").
    const home2 = mkdtempSync(join(tmpdir(), 'mem-graph-submit-2-'));
    try {
      const env2 = { ...env, KCRIB_MEMORY_DIR: home2, KCRIB_REGISTRY_DIR: home2 };
      const forward = assertion({ supportedBy: ['mem:a', 'mem:m', 'mem:z'] });
      const reversed = assertion({ supportedBy: ['mem:z', 'mem:m', 'mem:a'] });
      expect(reversed.id).toBe(forward.id); // same content identity either way

      const store1 = MemoryStore.local(REPO, { env, now: () => T0 });
      store1.submitGraphEntries([forward]);
      const store2 = MemoryStore.local(REPO, { env: env2, now: () => T0 });
      store2.submitGraphEntries([reversed]);

      expect(shardBytes(store1, forward.id)).toEqual(shardBytes(store2, forward.id));
      // And within one store the reversed re-import is a byte-identical no-op:
      const res = store1.submitGraphEntries([reversed]);
      expect(res.written).toEqual([]);
      expect(res.skipped).toEqual([reversed.id]);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});

describe('graph submission — fail-closed against corrupted and forged input', () => {
  it('refuses to submit to a shard holding an unreadable line (the rewrite must not launder it)', () => {
    const store = localStore();
    const seeded = assertion({});
    store.submitGraphEntries([seeded]);
    const path = store.shardPath('graph', memoryShard(seeded.id));
    const priorBytes = readFileSync(path, 'utf8');

    // Corrupt the shard the way a real crash would: a torn trailing line.
    appendFileSync(path, '{"id": "grel:torn'); // no closing brace, no newline
    const incoming = assertionInShard(seeded.id, true); // same shard, different content
    expect(() => store.submitGraphEntries([incoming])).toThrow(
      /refusing to submit to graph shard .* unreadable line/,
    );
    // The refusal left the shard (corruption included) untouched — nothing was erased.
    expect(readFileSync(path, 'utf8')).toEqual(`${priorBytes}{"id": "grel:torn`);
  });

  it('refuses a forged id: a schema-valid entry laundered under another id', () => {
    const store = localStore();
    const real = assertion({});
    const forged = { ...real, id: `grel:${'f'.repeat(64)}` }; // right shape, wrong content
    expect(forged.id).not.toBe(real.id);
    expect(() => store.submitGraphEntries([forged as never])).toThrow(MemorySchemaError);
    expect(() => store.submitGraphEntries([forged as never])).toThrow(/graph id/);
    expect(store.readCollection('graph').entries).toHaveLength(0);
  });

  it('blocks every generic writer from the graph collection (the merge laws ARE the write path)', () => {
    const store = localStore();
    const a = assertion({});
    expect(() => store.writeShard('graph', '00', [])).toThrow(
      /refusing to writeShard the graph collection/,
    );
    expect(() => store.upsertEntries('graph', [a as never])).toThrow(
      /refusing to upsertEntries into the graph collection/,
    );
    expect(() => store.removeEntry('graph', a.id)).toThrow(
      /refusing to removeEntry from the graph collection/,
    );
    expect(store.readCollection('graph').entries).toHaveLength(0);
  });

  it('acks an empty batch as empty and touches neither the disk nor the generation', () => {
    const store = localStore();
    const genBefore = store.readStoreGeneration().gen;
    expect(store.submitGraphEntries([])).toEqual({ written: [], skipped: [] });
    expect(store.readStoreGeneration().gen).toBe(genBefore);
  });
});

describe('graph submission — a multi-shard fault keeps earlier shard writes visible', () => {
  it('bumps the generation per shard write, so the unfaulted shard is durable and readable', () => {
    const store = localStore();
    const survivor = assertionWithSubject(1); // written FIRST (pending[] preserves input order)
    const casualty = assertionInShard(survivor.id, false); // a DIFFERENT shard
    const genBefore = store.readStoreGeneration().gen;

    // Fault only the casualty's shard file: the survivor's shard write completes first.
    fault.prefix = store.shardPath('graph', memoryShard(casualty.id));
    expect(() => store.submitGraphEntries([survivor, casualty])).toThrow(/simulated persist fault/);

    // The survivor's write is durable AND visible: the generation was bumped with it, so even a
    // memoized reader (one that never re-reads the sidecar) cannot serve the pre-write shard.
    expect(store.readStoreGeneration().gen).toBeGreaterThan(genBefore);
    clearMemoryCollectionCache();
    const ids = store.readCollection('graph').entries.map((e) => e.id);
    expect(ids).toContain(survivor.id);
    expect(ids).not.toContain(casualty.id);

    // The fault heals: a full retry is a no-op for the survivor and completes the casualty.
    fault.prefix = undefined;
    const res = store.submitGraphEntries([survivor, casualty]);
    expect(res.skipped).toEqual([survivor.id]);
    expect(res.written).toEqual([casualty.id]);
    const idsAfter = store.readCollection('graph').entries.map((e) => e.id);
    expect(idsAfter.sort()).toEqual([casualty.id, survivor.id].sort());
  });
});
