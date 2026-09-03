/**
 * G3.1 — the persistent memory FTS snapshot: lazy open, incremental store-write upserts, and the
 * self-heal contract. The invariant every test here pins is that the snapshot is RANKING-IDENTICAL
 * to the ephemeral full rebuild over the same ledger (BM25 is corpus statistics — a snapshot that
 * misses or ghosts a single row shifts the IDF of every query), and that it never serves a stale,
 * corrupt, or foreign-format snapshot: the shards are truth, the snapshot rebuilds.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryFtsIndex } from './fts-index.js';
import {
  MEMORY_FTS_FORMAT_VERSION,
  type MemoryCandidate,
  type MemoryRecord,
  type MemoryRecordV2,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  derivePropositionKey,
  gatherRecall,
  memoryCandidateId,
  memoryRecordId,
  memoryRecordV2Id,
  openMemoryFts,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-test';
const BLAKE_A = `blake3:${'a'.repeat(64)}`;

function evidence(soulId = 'sym:src/a.ts#A.b') {
  return {
    kind: 'source-quote' as const,
    verdict: 'valid' as const,
    checkedAt: NOW,
    soulId,
    quote: 'does the thing',
    targetHash: BLAKE_A,
  };
}

/** A valid memory-1 record; distinct claims (and distinct subjects) give distinct content ids. */
function v1Record(claim: string, subject = 'sym:src/a.ts#A.b'): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [subject],
    evidence: [evidence(subject)],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: NOW,
  };
}

/** A valid memory-2 record (the mixed-version corpus the index must build over). */
function v2Record(claim: string, subject: string): MemoryRecordV2 {
  const input = {
    kind: 'fact' as const,
    subject,
    propositionKey: derivePropositionKey({ subject }),
    claim,
    evidence: [evidence(subject)],
  };
  return {
    id: memoryRecordV2Id(input),
    schemaVersion: '2',
    ...input,
    visibility: 'private',
    validTime: { from: NOW },
    transactionTime: { observedAt: NOW, recordedAt: NOW },
    provenance: {
      principalId: 'principal-1',
      deviceId: 'device-1',
      actorId: 'actor-1',
      clientId: 'claude-code',
    },
    lineage: {},
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
  };
}

function candidateFixture(claim = 'A.b might do the thing'): MemoryCandidate {
  const input = {
    kind: 'fact' as const,
    subject: 'sym:src/a.ts#A.b',
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: ['sym:src/a.ts#A.b'],
    evidence: [evidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryCandidateId(input),
    schemaVersion: '1',
    kind: input.kind,
    subject: input.subject,
    claim: input.claim,
    scope: input.scope,
    appliesTo: input.appliesTo,
    evidence: input.evidence,
    authorship: input.authorship,
    origin: 'observe',
    proposedAt: NOW,
  };
}

let home = '';
let crib = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-fts-home-'));
  crib = mkdtempSync(join(tmpdir(), 'mem-fts-crib-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
  rmSync(crib, { recursive: true, force: true });
});

function localStore(): MemoryStore {
  return MemoryStore.local(REPO, { env });
}
function teamStore(): MemoryStore {
  return MemoryStore.team(crib, { env });
}
function globalStore(): MemoryStore {
  return MemoryStore.global({ env });
}

/** Deterministic byte-comparable score projection: sorted [id, score] pairs, exact float text. */
function scores(index: MemoryFtsIndex, query: string): string {
  const pairs = [...index.search(query).entries()].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(pairs);
}

/**
 * Force the lazy open (the snapshot is loaded on FIRST USE, not at factory time — that is the
 * design), so the tests can assert on open-time decisions like the rebuild counter. The probe term
 * matches no fixture claim, so priming is side-effect-free beyond the open itself.
 */
function prime(index: MemoryFtsIndex): void {
  index.search('zzprobezz');
}

/** The equivalence oracle: an ephemeral full rebuild over the gathered ledger. */
function ephemeralScores(stores: Parameters<typeof gatherRecall>[0], query: string): string {
  const ephemeral = new MemoryFtsIndex(':memory:');
  try {
    ephemeral.rebuild(gatherRecall(stores).records.map((r) => r.record));
    return scores(ephemeral, query);
  } finally {
    ephemeral.close();
  }
}

// ─── persistence ─────────────────────────────────────────────────────────────

describe('persistent memory FTS', () => {
  it('persists across open/close — reopening serves the same BM25 map with NO rebuild', () => {
    const store = localStore();
    store.upsertEntry('active', v1Record('retention policy gates the deploy'));
    store.upsertEntry(
      'active',
      v1Record('the deploy pipeline runs on friday', 'sym:src/deploy.ts#run'),
    );
    const first = openMemoryFts({ local: store });
    const before = scores(first, 'deploy');
    expect(first.rebuildCountForTest).toBe(1); // first open built the snapshot
    expect(first.metaFilePath).toBeDefined();
    first.close();

    const second = openMemoryFts({ local: store });
    prime(second);
    expect(second.rebuildCountForTest).toBe(0); // the snapshot header matched — zero-rebuild fast path
    expect(scores(second, 'deploy')).toBe(before);
    second.close();
  });

  it('a record-collection write through an OPEN index is visible immediately (incremental, no rebuild)', () => {
    const store = localStore();
    store.upsertEntry('active', v1Record('alpha retention gates the writer'));
    const fts = openMemoryFts({ local: store });
    const fresh = v1Record('beta retention report', 'sym:src/beta.ts#x');
    store.upsertEntry('active', fresh);
    expect(fts.search('beta').size).toBe(1); // the write listener upserted the row
    expect(fts.rebuildCountForTest).toBe(1); // ...without a rebuild
    fts.close();
  });

  // ─── incremental == full rebuild (the byte-comparability invariant) ────────

  it('incremental upsert + remove equals a full rebuild — byte-identical BM25 on a fixed fixture', () => {
    const store = localStore();
    const r1 = v1Record('alpha retention gates the writer');
    const r2 = v1Record('beta retention report', 'sym:src/beta.ts#x');
    store.upsertEntry('active', r1);
    const fts = openMemoryFts({ local: store });
    store.upsertEntry('active', r2); // listener upsert
    const r3 = v1Record('gamma unrelated claim', 'sym:src/gamma.ts#g');
    store.upsertEntry('active', r3); // listener upsert
    store.removeEntry('active', r2.id); // listener remove
    const persistent = scores(fts, 'retention');
    fts.close();

    // The oracle is the pre-G3.1 behaviour: one ephemeral FTS index rebuilt over the same ledger.
    expect(persistent).toBe(ephemeralScores({ local: store }, 'retention'));
  });

  it('a merged team+local+global snapshot ranks identically to the ephemeral rebuild (mixed v1+v2 corpus)', () => {
    const team = teamStore();
    const local = localStore();
    const global = globalStore();
    team.upsertEntry('records', v1Record('team retention ledger', 'sym:src/team.ts#t'));
    local.upsertEntry('active', v1Record('local retention note', 'sym:src/local.ts#l'));
    global.upsertEntry('records', v2Record('global retention note', 'sym:src/global.ts#g'));

    const stores = { team, local, global };
    const fts = openMemoryFts(stores);
    const persistent = scores(fts, 'retention');
    fts.close();
    expect(persistent).toBe(ephemeralScores(stores, 'retention'));
  });

  // ─── staleness detection + self-heal ───────────────────────────────────────

  it('a write made while the index was CLOSED (another "process") rebuilds on the next open', () => {
    const store = localStore();
    store.upsertEntry('active', v1Record('alpha retention gates the writer'));
    const fts = openMemoryFts({ local: store });
    fts.close();

    // A fresh store instance = no write listener attached — the cross-process shape.
    MemoryStore.local(REPO, { env }).upsertEntry(
      'active',
      v1Record('beta retention report', 'sym:src/beta.ts#x'),
    );

    const reopened = openMemoryFts({ local: store });
    prime(reopened);
    expect(reopened.rebuildCountForTest).toBe(1); // the generation check caught the drift
    expect(reopened.search('beta').size).toBe(1);
    expect(scores(reopened, 'retention')).toBe(ephemeralScores({ local: store }, 'retention'));
    reopened.close();
  });

  it('a corrupt snapshot file self-heals: deleted, rebuilt, and ranking-identical', () => {
    const store = localStore();
    store.upsertEntry('active', v1Record('alpha retention gates the writer'));
    const fts = openMemoryFts({ local: store });
    prime(fts); // materialize the snapshot (the open is lazy)
    const dbPath = fts.indexFilePath;
    fts.close();
    expect(existsSync(dbPath)).toBe(true);
    writeFileSync(dbPath, 'this is not a sqlite database', 'utf8');

    const healed = openMemoryFts({ local: store });
    prime(healed);
    expect(healed.rebuildCountForTest).toBe(1); // corrupt file deleted + rebuilt, never served
    expect(scores(healed, 'retention')).toBe(ephemeralScores({ local: store }, 'retention'));
    healed.close();
  });

  it('an index-format version mismatch rebuilds and rewrites the current version', () => {
    const store = localStore();
    store.upsertEntry('active', v1Record('alpha retention gates the writer'));
    const fts = openMemoryFts({ local: store });
    prime(fts); // materialize the meta header
    const metaPath = fts.metaFilePath as string;
    fts.close();

    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      formatVersion: number;
      stores: Record<string, unknown>;
    };
    expect(meta.formatVersion).toBe(MEMORY_FTS_FORMAT_VERSION);
    writeFileSync(
      metaPath,
      JSON.stringify({ ...meta, formatVersion: MEMORY_FTS_FORMAT_VERSION - 1 }, null, 2),
      'utf8',
    );

    const rebuilt = openMemoryFts({ local: store });
    prime(rebuilt);
    expect(rebuilt.rebuildCountForTest).toBe(1);
    const after = JSON.parse(readFileSync(metaPath, 'utf8')) as { formatVersion: number };
    expect(after.formatVersion).toBe(MEMORY_FTS_FORMAT_VERSION);
    rebuilt.close();
  });

  it('a cleared store rebuilds from scratch — the nonce binding defeats a coincidental generation', () => {
    const global = globalStore();
    global.upsertEntry('records', v1Record('global retention ledger', 'sym:src/g.ts#g'));
    const fts = openMemoryFts({ local: localStore(), global });
    prime(fts);
    expect(fts.search('retention').size).toBe(1);
    fts.close();
    const genBefore = JSON.parse(readFileSync(join(global.rootDir, 'fts.gen'), 'utf8')) as {
      nonce: string;
    };

    global.clearStore(); // the gen file dies with the root → a fresh nonce on the next bump

    const reopened = openMemoryFts({ local: localStore(), global });
    prime(reopened);
    expect(reopened.rebuildCountForTest).toBe(1);
    expect(reopened.search('retention').size).toBe(0);
    reopened.close();
    // A later write mints a DIFFERENT nonce for the same (reset) generation counter.
    global.upsertEntry('records', v1Record('reborn after reset', 'sym:src/g2.ts#g'));
    const genAfter = JSON.parse(readFileSync(join(global.rootDir, 'fts.gen'), 'utf8')) as {
      nonce: string;
    };
    expect(genAfter.nonce).not.toBe(genBefore.nonce);
  });

  it('an open index survives a clear of its own store: lazily rebuilds from the now-empty store', () => {
    const store = localStore();
    store.upsertEntry('active', v1Record('alpha retention gates the writer'));
    const fts = openMemoryFts({ local: store });
    prime(fts); // open + build before the clear
    store.clearStore();
    expect(fts.search('retention').size).toBe(0); // reset notice dropped the snapshot
    fts.close();
  });

  it('a store that appears after the snapshot was built forces a rebuild (store-set reconciliation)', () => {
    const local = localStore();
    local.upsertEntry('active', v1Record('alpha retention gates the writer'));
    const fts = openMemoryFts({ local });
    prime(fts);
    fts.close();

    const global = globalStore();
    global.upsertEntry('records', v1Record('global retention ledger', 'sym:src/g.ts#g'));

    const reopened = openMemoryFts({ local, global });
    prime(reopened);
    expect(reopened.rebuildCountForTest).toBe(1);
    expect(reopened.search('global').size).toBe(1);
    reopened.close();
  });

  // ─── the store write hooks ─────────────────────────────────────────────────

  it('the migration rewrite keeps the snapshot in sync (v1 row dropped, v2 twin indexed)', () => {
    const store = localStore();
    store.upsertEntry('active', v1Record('a claim that will migrate'));
    const fts = openMemoryFts({ local: store });
    const result = store.migrateToV2();
    expect(result.migrated.length).toBe(1);
    const persistent = scores(fts, 'migrate');
    fts.close();
    // The oracle over the post-migration ledger: the v1 row is gone, the v2 twin is in.
    expect(persistent).toBe(ephemeralScores({ local: store }, 'migrate'));
  });

  it('record-collection writes bump the generation; the capture lane (candidates) bumps NOTHING', () => {
    const store = localStore();
    expect(store.readFtsGeneration()).toEqual({ gen: 0, nonce: '' });
    store.upsertEntry('active', v1Record('alpha retention gates the writer'));
    expect(store.readFtsGeneration().gen).toBe(1);
    const stored = store.readCollection('active').entries[0] as { id: string };
    store.removeEntry('active', stored.id);
    expect(store.readFtsGeneration().gen).toBe(2);

    // The G2 capture lane stages candidates + drains the outbox — none of it is an FTS row, so the
    // derived-index cost of capturing must stay zero.
    store.upsertEntry('candidates', candidateFixture());
    expect(store.readFtsGeneration().gen).toBe(2);
  });

  it('falls back to the ephemeral mode when there is no local store (no repo-scoped home)', () => {
    const global = globalStore();
    global.upsertEntry('records', v1Record('global retention ledger', 'sym:src/g.ts#g'));
    const fts = openMemoryFts({ global });
    expect(fts.indexFilePath).toBe(':memory:');
    expect(fts.metaFilePath).toBeUndefined();
    expect(fts.search('retention').size).toBe(1);
    fts.close();
    expect(existsSync(join(home, 'repos', REPO, 'fts'))).toBe(false); // nothing was persisted
  });

  it('a listener failure never breaks the store write (fail-open, self-heals on the next open)', () => {
    const store = localStore();
    const fts = openMemoryFts({ local: store });
    fts.close(); // closes its listener; install a throwing one to simulate a wedged snapshot
    store.setFtsWriteListener(() => {
      throw new Error('wedged snapshot');
    });
    expect(() =>
      store.upsertEntry('active', v1Record('alpha retention gates the writer')),
    ).not.toThrow();
    expect(store.readCollection('active').entries.length).toBe(1); // the write committed
    store.setFtsWriteListener(undefined);
  });
});
