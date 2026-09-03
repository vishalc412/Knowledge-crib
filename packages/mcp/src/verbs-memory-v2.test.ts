/**
 * Gate 1.3 — the portable MemoryApi op set wired into the MCP memory dispatcher, over MIXED
 * v1+v2 ledgers AND real post-migration stores (the wave-2 review gap: the verbs were only ever
 * exercised against memory-1 records, so `memory_get` returned undefined v1 fields for v2,
 * `memory_status`/`memory_audit` crashed or silently demoted migrated records to
 * trust 'candidate', and search/supersede/delete/history/sync did not exist as verbs).
 *
 * The fixtures therefore cover three shapes:
 *   - a fresh v2 record with NO alias (reads candidate-trust, conflict-visible, never crashed on);
 *   - a REAL `MemoryStore.migrateToV2()` pass (local: v1 line replaced by its re-seeded twin +
 *     the alias binding; the v1 state survives only in the alias);
 *   - the classic v1 records (the W3 response contract must not regress).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordV2,
  MemoryStore,
  type Verdicts,
  __resetMemoryLockGuardForTest,
  decisionId,
  derivePropositionKey,
  memoryRecordId,
  memoryRecordV2Id,
} from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryDeps } from './verbs.js';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-verbs-mem-v2';
const BLAKE_A = `blake3:${'a'.repeat(64)}`;

function evidence(partial: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: BLAKE_A,
    ...partial,
  };
}

function v1Record(
  over: {
    subject?: string;
    claim?: string;
    trust?: Verdicts['trust'];
    createdAt?: string;
  } = {},
): MemoryRecord {
  const subject = over.subject ?? 'sym:src/a.ts#A.b';
  const input = {
    kind: 'fact' as const,
    subject,
    claim: over.claim ?? 'A.b does the thing',
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [subject],
    evidence: [evidence({ soulId: subject, quote: 'does the thing' })],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: over.trust ?? 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: over.createdAt ?? NOW,
  };
}

/** A fully-formed memory-2 record (passes the v2 write gate when persisted). */
function v2Record(over: Partial<MemoryRecordV2> & { id?: string }): MemoryRecordV2 {
  const subject = over.subject ?? 'sym:src/a.ts#A.b';
  const kind = over.kind ?? 'fact';
  const claim = over.claim ?? 'A.b does the thing (v2)';
  const ev = over.evidence ?? [evidence({ soulId: subject, quote: 'does the thing' })];
  return {
    id:
      over.id ??
      memoryRecordV2Id({
        kind,
        subject,
        propositionKey: derivePropositionKey({ subject }),
        claim,
        evidence: ev,
      }),
    schemaVersion: '2',
    visibility: 'workspace',
    kind,
    subject,
    propositionKey: derivePropositionKey({
      subject,
      ...(over.propositionKey ? { propositionKey: over.propositionKey } : {}),
    }),
    claim,
    validTime: { from: NOW },
    transactionTime: { observedAt: NOW, recordedAt: NOW },
    evidence: ev,
    provenance: {
      principalId: 'principal:local',
      deviceId: 'device:local',
      actorId: 'claude-code',
      agentId: 'claude-code',
      clientId: 'claude-code',
    },
    lineage: {},
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
    ...over,
  };
}

let repo: string;
let home: string;
let regDir: string;
let env: NodeJS.ProcessEnv;
let soul: SoulStore;
let index: SqliteIndexStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-mem-v2-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), `${'\n'.repeat(8)}class A { b() { return 1; } }\n`);
  home = mkdtempSync(join(tmpdir(), 'mem-home-v2-'));
  regDir = mkdtempSync(join(tmpdir(), 'mem-reg-v2-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();

  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.commit(NOW);
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
});

function teamStoreWith(entries: Array<MemoryRecord | MemoryRecordV2>): MemoryStore {
  const crib = mkdtempSync(join(tmpdir(), 'mem-crib-v2-'));
  writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: REPO } }));
  const team = MemoryStore.team(crib, { env, now: () => NOW });
  team.upsertEntries('records', entries);
  return team;
}

function verbsWith(team: MemoryStore): Verbs {
  const mem: MemoryDeps = { team };
  return new Verbs({ soul, index, repoRoot: repo, memory: mem });
}

function verbsWithLocal(local: MemoryStore): Verbs {
  const mem: MemoryDeps = { local };
  return new Verbs({ soul, index, repoRoot: repo, memory: mem });
}

function localStore(): MemoryStore {
  return MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: repo });
}

function localStoreWith(records: MemoryRecord[]): MemoryStore {
  const local = localStore();
  local.upsertEntries('active', records);
  return local;
}

// ─── degrade-to-not-configured (the new op set mirrors the W3 verbs) ─────────

describe('the Gate 1.3 memory ops without a configured ledger', () => {
  it('search / supersede / delete / history / sync report "not configured"', async () => {
    const v = new Verbs({ soul, index, repoRoot: repo });
    expect((v.memorySearch({}) as Record<string, unknown>).memory).toBe('not configured');
    expect(
      (v.memorySupersede({ id: 'mem:x', actor: 'a', claim: 'c' }) as Record<string, unknown>)
        .memory,
    ).toBe('not configured');
    expect((v.memoryDelete({ id: 'mem:x', actor: 'a' }) as Record<string, unknown>).memory).toBe(
      'not configured',
    );
    expect((v.memoryHistory({ key: 'mem:x' }) as Record<string, unknown>).memory).toBe(
      'not configured',
    );
    expect(((await v.memorySync({})) as Record<string, unknown>).memory).toBe('not configured');
  });
});

// ─── memory_get over a mixed v1+v2 ledger ────────────────────────────────────

describe('memoryGet over mixed v1+v2 records', () => {
  it('answers a v1 record with the exact W3 v1 contract (no v2 keys leaked)', () => {
    const r = v1Record({ claim: 'the v1 claim' });
    const res = verbsWith(teamStoreWith([r])).memoryGet({ id: r.id }) as Record<string, unknown>;
    expect(res.id).toBe(r.id);
    expect(res.claim).toBe('the v1 claim');
    expect(res.source).toBe('team');
    // found is absent on a hit (the W3 contract) and the v1 fields are all present…
    expect(res.found).toBeUndefined();
    expect(res.scope).toEqual({ boundary: 'repo', repoId: REPO });
    expect(res.authorship).toEqual({
      actor: 'claude-code',
      kind: 'agent',
      tool: 'claude-code',
    });
    expect(res.createdAt).toBe(NOW);
    expect(res.verdicts).toEqual(r.verdicts);
    // …while the v2 fields are NOT emitted for a v1 record.
    expect(res.schemaVersion).toBeUndefined();
    expect(res.visibility).toBeUndefined();
    expect(res.propositionKey).toBeUndefined();
  });

  it('answers a v2 record with v2 fields — never the undefined v1 ones', () => {
    const r = v2Record({ claim: 'the v2 claim' });
    const res = verbsWith(teamStoreWith([r])).memoryGet({ id: r.id }) as Record<string, unknown>;
    expect(res.id).toBe(r.id);
    expect(res.schemaVersion).toBe('2');
    expect(res.visibility).toBe('workspace');
    expect(res.propositionKey).toBe(r.propositionKey);
    expect(res.validity).toEqual({
      validTime: { from: NOW },
      transactionTime: { observedAt: NOW, recordedAt: NOW },
    });
    expect(res.sensitivity).toBe('internal');
    expect(res.retentionPolicyId).toBe('ret:default');
    expect(res.source).toBe('team');
    expect(res.placement).toEqual(['team']);
    // a fresh v2 record with no alias reads candidate-trust (honest, never fabricated)
    expect((res.verdicts as Verdicts).trust).toBe('candidate');
    // the v1 fields the v2 envelope no longer carries are absent, not undefined
    expect(res.scope).toBeUndefined();
    expect(res.authorship).toBeUndefined();
    expect(res.createdAt).toBeUndefined();
  });

  it('follows the alias map: a legacy id finds its migrated twin post-migration', () => {
    const legacy = v1Record({ claim: 'the migrated claim' });
    const local = localStoreWith([legacy]);
    const migrated = local.migrateToV2();
    expect(migrated.migrated.length).toBe(1);
    const twinId = migrated.migrated[0] as string;

    const res = verbsWithLocal(local).memoryGet({ id: legacy.id }) as Record<string, unknown>;
    expect(res.id).toBe(twinId);
    expect(res.requestedId).toBe(legacy.id);
    expect(res.resolvedViaAlias).toBe(legacy.id);
    expect(res.schemaVersion).toBe('2');
    expect((res.verdicts as Verdicts).trust).toBe('local'); // alias-restored, not 'candidate'
    expect(res.legacyIds).toEqual([legacy.id]);
    expect(res.source).toBe('local');
  });

  it('returns found:false for an unknown id (unchanged contract)', () => {
    const res = verbsWith(teamStoreWith([v1Record()])).memoryGet({ id: 'mem:unknown' }) as Record<
      string,
      unknown
    >;
    expect(res.found).toBe(false);
    expect(res.id).toBe('mem:unknown');
  });
});

// ─── memory_status + memory_audit over migrated records (the demotion bug) ────

describe('memoryStatus / memoryAudit after a real migrateToV2 pass', () => {
  it('memoryStatus counts the migrated twin at its alias-restored trust, agreeing with recall', () => {
    const legacy = v1Record({ claim: 'status claim' });
    const local = localStoreWith([legacy]);
    local.migrateToV2();

    const res = verbsWithLocal(local).memoryStatus({}) as Record<string, unknown>;
    const counts = res.counts as Record<string, Record<string, number>>;
    expect(counts.total).toBe(1);
    expect(counts.trust).toEqual({ local: 1 }); // NOT { candidate: 1 } — the demotion bug
    expect(counts.eligible).toBe(1);
  });

  it('memoryAudit does not throw on v2 records and tallies alias-restored trust', () => {
    const legacy = v1Record({ claim: 'audit claim' });
    const local = localStoreWith([legacy]);
    local.migrateToV2();
    const freshV2 = v2Record({ claim: 'a fresh v2 observation', subject: 'topic:other' });
    const team = teamStoreWith([freshV2, v1Record({ claim: 'a plain v1 record' })]);

    const v = new Verbs({
      soul,
      index,
      repoRoot: repo,
      memory: { team, local },
    });
    const res = v.memoryAudit({}) as Record<string, unknown>;
    const validation = res.validation as Record<string, unknown>;
    expect(validation.records).toBe(3); // local twin + fresh v2 + plain v1 — no TypeError
    expect(validation.drifted).toBe(0); // alias snapshot == effective axes; nothing drifted
    const trust = res.trust as Record<string, number>;
    expect(trust.local).toBe(2); // the migrated twin (alias-restored) + the plain v1 record
    expect(trust.candidate).toBe(1); // the fresh v2 record, honestly unevaluated
  });

  it('memoryAudit counts a quarantined v1 record without regressing the v1 path', () => {
    const quarantined = v1Record({
      claim: 'quarantined claim',
      trust: 'local',
    });
    const team = teamStoreWith([quarantined]);
    // quarantine is an exclusion flag, not an axis change: drift stays 0, the record is counted.
    team.upsertEntries('decisions', [
      {
        id: decisionId({
          kind: 'quarantine',
          subject: quarantined.id,
          actor: 'tester',
          reason: 'test quarantine',
        }),
        schemaVersion: '1',
        kind: 'quarantine',
        subject: quarantined.id,
        actor: 'tester',
        ts: NOW,
        reason: 'test quarantine',
      },
    ]);
    const res = verbsWith(team).memoryAudit({}) as Record<string, unknown>;
    const validation = res.validation as Record<string, unknown>;
    expect(validation.records).toBe(1);
    expect(validation.drifted).toBe(0);
    const feedback = res.feedback as Record<string, unknown>;
    expect(feedback.quarantined).toBe(1);
  });
});

// ─── memory_search over a mixed ledger (same projection as memory_recall) ────

describe('memorySearch', () => {
  it('ranks v1 and migrated-v2 records together with version-aware hit views', () => {
    const legacy = v1Record({ claim: 'the loan threshold is 30' });
    const local = localStoreWith([legacy]);
    local.migrateToV2();
    const team = teamStoreWith([v1Record({ claim: 'unrelated claim about parsing' })]);

    const v = new Verbs({ soul, index, repoRoot: repo, memory: { team, local } });
    const res = v.memorySearch({ q: 'loan threshold' }) as Record<string, unknown>;
    expect(Array.isArray(res.hits)).toBe(true);
    const hits = res.hits as Array<Record<string, unknown>>;
    // the projection returns every recall-eligible record (the lexical score ORDERS, it does not
    // filter) — both the matched migrated twin and the unrelated-but-eligible v1 record.
    expect(hits.length).toBe(2);
    const hit = hits[0] as Record<string, unknown>; // lexical match ranks first
    expect(hit.schemaVersion).toBe('2');
    expect(hit.visibility).toBe('workspace');
    expect(hit.propositionKey).toBeDefined();
    expect((hit.verdicts as Verdicts).trust).toBe('local'); // alias-restored via the projection
    expect(hit.trust).toBe('local');
    expect(hit.placement).toEqual(['local']);
    expect(hit.freshness).toEqual({
      state: 'unevaluated',
      evaluatedAt: null,
      codeHead: null,
    });
    expect(hit.rankingVersion).toBe('recall-v1:priority-order');
    // the v1-only keys are not fabricated for the v2 twin
    expect(hit.scope).toBeUndefined();
    expect(hit.createdAt).toBeUndefined();
    // the unmatched v1 record keeps its classic view shape
    const other = hits[1] as Record<string, unknown>;
    expect(other.schemaVersion).toBe('1');
    expect(other.scope).toEqual({ boundary: 'repo', repoId: REPO });
    const provenance = res.provenance as Record<string, unknown>;
    expect(provenance.rankingVersion).toBe('recall-v1:priority-order');
  });

  it('keeps a v1 hit in the classic v1 view shape', () => {
    const team = teamStoreWith([v1Record({ claim: 'the loan threshold is 30' })]);
    const res = verbsWith(team).memorySearch({ q: 'loan' }) as Record<string, unknown>;
    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits.length).toBe(1);
    const hit = hits[0] as Record<string, unknown>;
    expect(hit.schemaVersion).toBe('1');
    expect(hit.scope).toEqual({ boundary: 'repo', repoId: REPO });
    expect(hit.createdAt).toBe(NOW);
  });

  it('agrees with memory_recall over the same migrated ledger', () => {
    const legacy = v1Record({ claim: 'the loan threshold is 30' });
    const local = localStoreWith([legacy]);
    local.migrateToV2();
    const v = verbsWithLocal(local);
    const search = v.memorySearch({ q: 'loan' }) as Record<string, unknown>;
    const recall = v.memoryRecall({ q: 'loan' }) as Record<string, unknown>;
    const searchIds = (search.hits as Array<Record<string, unknown>>).map((h) => h.id);
    const recallIds = (recall.memories as Array<Record<string, unknown>>).map((m) => m.id);
    expect(searchIds).toEqual(recallIds);
  });

  it('respects limit and marks truncation', () => {
    const recs = Array.from({ length: 7 }, (_, i) =>
      v1Record({ claim: `shared claim ${i}`, subject: `topic:s${i}` }),
    );
    const res = verbsWith(teamStoreWith(recs)).memorySearch({
      q: 'shared claim',
      limit: 3,
    }) as Record<string, unknown>;
    expect((res.hits as unknown[]).length).toBe(3);
    expect(res.truncated).toBe(true);
  });

  // ─── adversarial-verify finding 4: the hit's source is the EFFECTIVE store, not placement[0] ───

  it('labels each hit with the effective store the projection resolved it from (team + local)', () => {
    // A record placed in BOTH stores yields one hit PER SOURCE (the projection is non-deducing by
    // id, mirroring memory_recall). placement is local-first, so `placement[0]` mislabels the
    // team-sourced hit as 'local' — the source must be the store the verdicts came from.
    const rec = v1Record({ claim: 'the loan threshold is 30' });
    const team = teamStoreWith([rec]);
    const local = localStoreWith([rec]);
    const v = new Verbs({ soul, index, repoRoot: repo, memory: { team, local } });
    const res = v.memorySearch({ q: 'loan', limit: 20 }) as Record<string, unknown>;
    const hits = res.hits as Array<Record<string, unknown>>;
    expect(hits.length).toBe(2); // one per source, exactly like memory_recall
    expect(hits.map((h) => h.source).sort()).toEqual(['local', 'team']);
    for (const h of hits) {
      expect(h.placement).toEqual(['local', 'team']);
    }
    // memory_recall reports the same per-source resolution — search's source must agree with it
    const recall = v.memoryRecall({ q: 'loan', limit: 20 }) as Record<string, unknown>;
    const recallSources = (recall.memories as Array<Record<string, unknown>>)
      .map((m) => m.source)
      .sort();
    expect(recallSources).toEqual(['local', 'team']);
    expect(hits.map((h) => h.source).sort()).toEqual(recallSources);
  });
});

// ─── supersede / delete / history / sync ─────────────────────────────────────

describe('memorySupersede', () => {
  it('writes a v2 successor claim plus a supersede decision, and get reports the link', () => {
    const r = v1Record({ claim: 'the old truth' });
    const team = teamStoreWith([r]);
    const v = verbsWith(team);
    // D10 — the defaulted successor projects 'private' and the team write gate refuses it before
    // anything lands; the caller must name a git-admissible visibility for a team supersede.
    const refused = v.memorySupersede({
      id: r.id,
      claim: 'the corrected truth',
      actor: 'claude',
      reason: 'claim was wrong',
    }) as Record<string, unknown>;
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('private');
    // nothing was written by the refusal (no partial supersede)
    expect(team.readCollection('decisions').entries).toHaveLength(0);
    const res = v.memorySupersede({
      id: r.id,
      claim: 'the corrected truth',
      visibility: 'workspace',
      actor: 'claude',
      reason: 'claim was wrong',
    }) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    const successorId = res.successorId as string;
    expect(String(res.decisionId).startsWith('dec:')).toBe(true);
    expect(res.successorCreated).toBe(true);
    expect(res.supersededId).toBe(r.id);

    const got = verbsWith(team).memoryGet({ id: r.id }) as Record<string, unknown>;
    const supersededBy = got.supersededBy as Array<Record<string, unknown>>;
    expect(supersededBy.length).toBe(1);
    expect(supersededBy[0]?.id).toBe(successorId);

    // the retired record leaves recall; the successor (fresh v2, candidate-trust) does not enter
    const recall = verbsWith(team).memoryRecall({ q: 'truth' }) as Record<string, unknown>;
    expect((recall.memories as unknown[]).length).toBe(0);
  });

  it('supersedes by an existing successor record id (idempotent on repeat)', () => {
    const oldRec = v1Record({ claim: 'the old truth', subject: 'topic:old' });
    const newRec = v1Record({ claim: 'the new truth', subject: 'topic:old' });
    const team = teamStoreWith([oldRec, newRec]);
    const v = verbsWith(team);
    const first = v.memorySupersede({
      id: oldRec.id,
      successor: newRec.id,
      actor: 'claude',
    }) as Record<string, unknown>;
    expect(first.ok).toBe(true);
    expect(first.successorId).toBe(newRec.id);
    expect(first.successorCreated).toBe(false);
    // the retired record is excluded from recall
    const recall = v.memoryRecall({ q: 'truth' }) as Record<string, unknown>;
    const ids = (recall.memories as Array<Record<string, unknown>>).map((m) => m.id);
    expect(ids).toEqual([newRec.id]);
  });

  it('reports not-found honestly for an unknown id', () => {
    const res = verbsWith(teamStoreWith([v1Record()])).memorySupersede({
      id: 'mem:missing',
      claim: 'x',
      actor: 'claude',
    }) as Record<string, unknown>;
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('not found');
  });
});

describe('memoryDelete', () => {
  it('tombstones via a retract decision — the line stays, recall drops it', () => {
    const r = v1Record({ claim: 'the doomed claim' });
    const team = teamStoreWith([r]);
    const v = verbsWith(team);
    const res = v.memoryDelete({ id: r.id, actor: 'claude', reason: 'wrong' }) as Record<
      string,
      unknown
    >;
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('tombstone');
    expect(res.id).toBe(r.id);
    expect(String(res.decisionId).startsWith('dec:')).toBe(true);
    // the record line was never removed
    expect(team.readCollection('records').entries.length).toBe(1);
    const recall = v.memoryRecall({ q: 'doomed' }) as Record<string, unknown>;
    expect((recall.memories as unknown[]).length).toBe(0);
    // history still sees it
    const history = v.memoryHistory({ key: r.id }) as Record<string, unknown>;
    const events = history.events as Array<Record<string, unknown>>;
    expect(events.some((e) => e.type === 'retract')).toBe(true);
  });

  it('resolves a legacy id through the alias map (a pre-migration id retires its twin)', () => {
    const legacy = v1Record({ claim: 'the migrated doomed claim' });
    const local = localStoreWith([legacy]);
    const migrated = local.migrateToV2();
    const twinId = migrated.migrated[0] as string;
    const res = verbsWithLocal(local).memoryDelete({
      id: legacy.id,
      actor: 'claude',
    }) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.id).toBe(twinId);
  });
});

describe('memoryHistory', () => {
  it('projects the full timeline for a record: recorded + decision events', () => {
    const r = v1Record({ claim: 'the historical claim' });
    const team = teamStoreWith([r]);
    const res = verbsWith(team).memoryHistory({ key: r.id }) as Record<string, unknown>;
    expect(res.key).toBe(r.id);
    const records = res.records as Array<Record<string, unknown>>;
    expect(records.length).toBe(1);
    expect(records[0]?.id).toBe(r.id);
    expect(records[0]?.schemaVersion).toBe('1');
    expect(records[0]?.recordedAt).toBe(NOW);
    expect(records[0]?.lifecycle).toBe('active');
    const events = res.events as Array<Record<string, unknown>>;
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe('recorded');
  });

  it('projects asOf: only what was believed then, including the v1 alias state', () => {
    const legacy = v1Record({ claim: 'the historical claim' });
    const local = localStoreWith([legacy]);
    local.migrateToV2();
    const twinId = local.readCollection('active').entries[0] as { id: string };
    // a point-in-time read AFTER the migration still sees the full belief state
    const res = verbsWithLocal(local).memoryHistory({
      key: legacy.id,
      asOf: '2026-06-01T00:00:00.000Z',
    }) as Record<string, unknown>;
    const records = res.records as Array<Record<string, unknown>>;
    expect(records.length).toBe(1);
    expect(records[0]?.id).toBe(twinId.id);
    const legacyBindings = records[0]?.legacy as Array<Record<string, unknown>>;
    expect(legacyBindings.length).toBe(1);
    expect(legacyBindings[0]?.legacyId).toBe(legacy.id);
    expect(records[0]?.validTimeHolds).toBe(true);
    // asOf BEFORE the record was recorded → nothing was believed then
    const before = verbsWithLocal(local).memoryHistory({
      key: legacy.id,
      asOf: '2025-01-01T00:00:00.000Z',
    }) as Record<string, unknown>;
    expect((before.records as unknown[]).length).toBe(0);
  });

  // ─── adversarial-verify finding 3: an unparseable asOf is a REJECTED arg, not a silent mis-filter ───

  it('reports ok:false with a clear error for an unparseable asOf (no silent mis-filter)', () => {
    const r = v1Record({ claim: 'the historical claim' });
    const team = teamStoreWith([r]);
    const res = verbsWith(team).memoryHistory({
      key: r.id,
      asOf: 'not-a-date',
    }) as Record<string, unknown>;
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('asOf');
  });
});

describe('memorySync', () => {
  it('reports the honest not-configured shape (MCP never pushes or pulls, D12)', async () => {
    const res = (await verbsWith(teamStoreWith([v1Record()])).memorySync({})) as Record<
      string,
      unknown
    >;
    expect(res.ok).toBe(false);
    expect(res.available).toBe(false);
    expect(res.capability).toBe('sync');
    expect(res.status).toBe('not-configured');
    expect(String(res.message)).toContain('init-sync');
  });

  it('rejects an explicit push with the CLI-only reason (no network side effects behind an agent session)', async () => {
    const verbs = verbsWith(teamStoreWith([v1Record()]));
    for (const request of ['push', 'pull'] as const) {
      const res = (await verbs.memorySync({ request })) as Record<string, unknown>;
      expect(res.ok).toBe(false);
      expect(res.request).toBe(request);
      expect(res.status).toBe('rejected');
      expect(String(res.message)).toContain('crib memory sync');
      expect(String(res.message)).toContain('D12');
    }
  });
});

// ─── memory_recall view over a migrated twin (v2-aware, no v1 regression) ────

describe('memoryRecall over a migrated ledger', () => {
  it('returns the migrated twin with v2 view fields at its alias-restored trust', () => {
    const legacy = v1Record({ claim: 'the loan threshold is 30' });
    const local = localStoreWith([legacy]);
    local.migrateToV2();
    const res = verbsWithLocal(local).memoryRecall({ q: 'loan' }) as Record<string, unknown>;
    const memories = res.memories as Array<Record<string, unknown>>;
    expect(memories.length).toBe(1);
    const m = memories[0] as Record<string, unknown>;
    expect(m.trust).toBe('local');
    expect(m.schemaVersion).toBe('2');
    expect(m.visibility).toBe('workspace');
    expect(m.propositionKey).toBeDefined();
    expect(m.validTime).toEqual({ from: NOW });
    expect(m.scope).toBeUndefined(); // v1 keys never fabricated for the twin
    expect(m.createdAt).toBeUndefined();
  });
});
