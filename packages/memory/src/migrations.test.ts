import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * G1.2 — the memory-1 → memory-2 migration + the MANDATORY legacy-ID alias map. Covers the pure
 * rewrite (field mapping + provenance derivation), the id-preserving loader chain step, the
 * alias map's persistence + transparent resolution, store-level migration semantics per role
 * (local/global REPLACE, team retains + aliases only), idempotency (byte-stable re-runs), the
 * additive read-bridges (legacy-keyed decisions + feedback still attach), and the preserved
 * v1 content-addressed dedupe invariants (the v1 seed did not move).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AliasConflictError,
  DEFAULT_RETENTION_POLICY_ID,
  MEMORY_MIGRATORS,
  type MemoryAlias,
  type MemoryCandidate,
  type MemoryDecision,
  type MemoryEntry,
  type MemoryFeedback,
  type MemoryRecord,
  type MemoryRecordV2,
  type MemoryRecordV3,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  assertValidMemoryEntry,
  assertValidMemoryRecordV2,
  bridgedDecisions,
  buildAliasIndex,
  canonicalMemoryJson,
  conservativeVerdicts,
  decisionId,
  derivePropositionKey,
  feedbackId,
  gatherRecall,
  isMemoryRecordV2,
  isMemoryRecordV3,
  isRecallEligible,
  memoryAliasId,
  memoryCandidateId,
  memoryRecordId,
  memoryRecordV2Id,
  memoryRecordV3Id,
  migrateMemoryRecord,
  migrateRecordV1ToV2,
  migrateRecordV2ToV3,
  migrationProvenance,
  parseMemoryShard,
  recallProjection,
  serializeMemoryShard,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-mig';
const SUBJECT = 'sym:src/a.ts#A.b';

// ─── fixtures ────────────────────────────────────────────────────────────────

function evidence(over: Record<string, unknown> = {}): MemoryRecord['evidence'][number] {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: 'blake3:abc',
    ...over,
  };
}

function v1Input(over: { claim?: string; subject?: string; createdAt?: string } = {}) {
  const subject = over.subject ?? SUBJECT;
  const input = {
    kind: 'fact' as const,
    subject,
    claim: over.claim ?? 'A.b does the thing',
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [subject],
    evidence: [evidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return { input, createdAt: over.createdAt ?? NOW };
}

/** A fully-valid memory-1 record (id content-addressed from the v1 seed). */
function v1Record(
  over: { claim?: string; subject?: string; createdAt?: string } = {},
): MemoryRecord {
  const { input, createdAt } = v1Input(over);
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt,
  };
}

/** The v2 twin id the migration derives for a v1 record of this raw content. */
function twinId(record: MemoryRecord): string {
  return memoryRecordV2Id({
    kind: record.kind,
    subject: record.subject,
    propositionKey: derivePropositionKey({ subject: record.subject }),
    claim: record.claim,
    evidence: record.evidence,
  });
}

function candidateFor(record: MemoryRecord): MemoryCandidate {
  const { input } = v1Input({ claim: record.claim, subject: record.subject });
  return {
    id: memoryCandidateId(input),
    schemaVersion: '1',
    ...input,
    origin: 'observe',
    proposedAt: NOW,
  };
}

function decisionOn(subject: string, kind: MemoryDecision['kind']): MemoryDecision {
  return {
    id: decisionId({ kind, subject, actor: 'ci' }),
    schemaVersion: '1',
    kind,
    subject,
    actor: 'ci',
    ts: NOW,
  };
}

function feedbackOn(subject: string, signal: MemoryFeedback['signal']): MemoryFeedback {
  return {
    id: feedbackId({ signal, subject, actor: 'ci' }),
    schemaVersion: '1',
    signal,
    subject,
    actor: 'ci',
    ts: NOW,
  };
}

/**
 * A second v1 record of the SAME claim content that differs only where the v1 seed counts identity
 * (authorship actor) — so it re-seeds to the SAME v2 twin (the v2 seed excludes authorship + scope)
 * while keeping a distinct v1 id. This is the designed-for collapse: two v1 ids, one v2 record.
 */
function v1Sibling(
  base: MemoryRecord,
  over: { actor?: string; verdicts?: MemoryRecord['verdicts'] } = {},
): MemoryRecord {
  const authorship = over.actor ? { ...base.authorship, actor: over.actor } : base.authorship;
  const input = {
    kind: base.kind,
    subject: base.subject,
    claim: base.claim,
    scope: base.scope,
    appliesTo: base.appliesTo,
    evidence: base.evidence,
    authorship,
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: over.verdicts ?? base.verdicts,
    createdAt: base.createdAt,
  };
}

/** Snapshot every file under `dir` (path → bytes) for idempotency comparisons. */
function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else out.set(p, readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-mig-home-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

// ─── provenance derivation ────────────────────────────────────────────────────

describe('migrationProvenance', () => {
  const agentAuth = { actor: 'claude-code', kind: 'agent', tool: 'claude-code' };

  it('derives the documented defaults from authorship', () => {
    const p = migrationProvenance(agentAuth, {}, {});
    expect(p).toEqual({
      principalId: 'principal:local',
      deviceId: 'device:local',
      actorId: 'claude-code',
      agentId: 'claude-code',
      clientId: 'claude-code', // authorship.tool is the closest honest client proxy
      tool: 'claude-code',
    });
  });

  it('env config overrides the defaults; explicit overrides beat env', () => {
    const fromEnv = migrationProvenance(
      agentAuth,
      {},
      {
        KCRIB_PRINCIPAL_ID: 'principal:p1',
        KCRIB_DEVICE_ID: 'device:d1',
        KCRIB_CLIENT_ID: 'client:c1',
      },
    );
    expect(fromEnv.principalId).toBe('principal:p1');
    expect(fromEnv.deviceId).toBe('device:d1');
    expect(fromEnv.clientId).toBe('client:c1');

    const explicit = migrationProvenance(
      agentAuth,
      { clientId: 'cursor' },
      {
        KCRIB_CLIENT_ID: 'client:c1',
      },
    );
    expect(explicit.clientId).toBe('cursor');
  });

  it('a human attestation derives NO agentId; a tool-less authorship defaults the client', () => {
    const human = migrationProvenance({ actor: 'vishal', kind: 'human' }, {}, {});
    expect(human.agentId).toBeUndefined();
    expect(human.clientId).toBe('crib');
    expect(human.tool).toBeUndefined();
  });
});

// ─── the pure rewrite ─────────────────────────────────────────────────────────

describe('migrateRecordV1ToV2', () => {
  it('maps every field per the G1.2 contract and validates as a memory-2 record', () => {
    const v1 = v1Record({ createdAt: '2026-03-03T00:00:00.000Z' });
    const { record, alias } = migrateRecordV1ToV2(v1, migrationProvenance(v1.authorship, {}, {}));

    expect(record.id).toBe(twinId(v1));
    expect(record.id).not.toBe(v1.id); // re-seeded by design — the alias map reconciles
    expect(record.schemaVersion).toBe('2');
    expect(record.visibility).toBe('workspace');
    expect(record.propositionKey).toBe(derivePropositionKey({ subject: v1.subject }));
    expect(record.validTime).toEqual({ from: v1.createdAt });
    expect(record.transactionTime).toEqual({ observedAt: v1.createdAt, recordedAt: v1.createdAt });
    expect(record.evidence).toEqual(v1.evidence);
    expect(record.lineage).toEqual({});
    expect(record.sensitivity).toBe('internal');
    expect(record.retentionPolicyId).toBe(DEFAULT_RETENTION_POLICY_ID);
    expect(record.provenance.actorId).toBe(v1.authorship.actor);

    expect(alias).toEqual({
      id: memoryAliasId({ legacyId: v1.id, resolvedId: record.id }),
      schemaVersion: '1',
      legacyId: v1.id,
      resolvedId: record.id,
      verdicts: v1.verdicts, // the v1 axes travel in the alias snapshot
      scope: v1.scope, // ...and so does the v1 state the closed envelope drops
      appliesTo: v1.appliesTo,
    } satisfies MemoryAlias); // no meta on this fixture — the field is copied only when present

    expect(() => assertValidMemoryRecordV2(record)).not.toThrow();
    expect(() =>
      assertValidMemoryEntry(record as unknown as { id: string } & Record<string, unknown>),
    ).not.toThrow();
  });

  it('a non-empty meta.propositionKey override wins (trimmed, verbatim)', () => {
    const v1 = { ...v1Record(), meta: { propositionKey: '  topic:auth  ' } };
    const { record } = migrateRecordV1ToV2(v1, migrationProvenance(v1.authorship));
    expect(record.propositionKey).toBe('topic:auth');
  });

  it('is deterministic: the same record + provenance re-derives byte-identical output', () => {
    const v1 = v1Record();
    const a = migrateRecordV1ToV2(v1, migrationProvenance(v1.authorship));
    const b = migrateRecordV1ToV2(v1, migrationProvenance(v1.authorship));
    expect(canonicalMemoryJson(a.record)).toBe(canonicalMemoryJson(b.record));
    expect(canonicalMemoryJson(a.alias)).toBe(canonicalMemoryJson(b.alias));
    // provenance is excluded from the v2 seed: a different env re-derives the SAME id
    const otherEnv = migrateRecordV1ToV2(
      v1,
      migrationProvenance(
        v1.authorship,
        {},
        {
          KCRIB_PRINCIPAL_ID: 'principal:other',
        },
      ),
    );
    expect(otherEnv.record.id).toBe(a.record.id);
  });
});

describe('migrateRecordV2ToV3', () => {
  it('preserves v2 claim/evidence history while re-addressing it in the resolved namespace', () => {
    const v1 = v1Record();
    const v2 = migrateRecordV1ToV2(v1, migrationProvenance(v1.authorship, {}, {})).record;
    const namespace = {
      principalId: v2.provenance.principalId,
      workspaceId: 'workspace:crib',
      projectId: 'project:knowledge-crib',
      agentProfileId: 'agent-profile:codex',
    };
    const { record, alias } = migrateRecordV2ToV3(v2, namespace, v1.verdicts);

    expect(record.schemaVersion).toBe('3');
    expect(record.namespace).toEqual(namespace);
    expect(record.id).toBe(memoryRecordV3Id({ ...v2, namespace }));
    expect(record.id).not.toBe(v2.id);
    expect(record.claim).toBe(v2.claim);
    expect(record.evidence).toEqual(v2.evidence);
    expect(alias.legacyId).toBe(v2.id);
    expect(alias.resolvedId).toBe(record.id);
  });
});

// ─── the alias id + schema ─────────────────────────────────────────────────────

describe('memoryAliasId + alias validation', () => {
  it('seeds exactly {legacyId, resolvedId} — the verdicts snapshot is not identity', () => {
    const base = { legacyId: 'mem:aaa', resolvedId: 'mem:bbb' };
    expect(memoryAliasId(base)).toMatch(/^alias:[0-9a-f]+$/);
    expect(memoryAliasId(base)).toBe(memoryAliasId(base));
    expect(memoryAliasId({ legacyId: 'mem:aaa', resolvedId: 'mem:ccc' })).not.toBe(
      memoryAliasId(base),
    );
  });

  it('round-trips an alias byte-stably through the JSONL path', () => {
    const alias: MemoryAlias = {
      id: memoryAliasId({ legacyId: 'mem:aaa', resolvedId: 'mem:bbb' }),
      schemaVersion: '1',
      legacyId: 'mem:aaa',
      resolvedId: 'mem:bbb',
      verdicts: {
        trust: 'local',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'active',
      },
    };
    expect(() =>
      assertValidMemoryEntry(alias as unknown as { id: string } & Record<string, unknown>),
    ).not.toThrow();
    const once = serializeMemoryShard([alias]);
    const parsed = parseMemoryShard(once, 'aliases/00.jsonl');
    expect(parsed.errors).toHaveLength(0);
    expect(serializeMemoryShard(parsed.entries as unknown as [MemoryAlias])).toBe(once);
  });

  it('fails closed: an alias without the verdicts snapshot does not validate', () => {
    const bad = {
      id: memoryAliasId({ legacyId: 'mem:aaa', resolvedId: 'mem:bbb' }),
      schemaVersion: '1',
      legacyId: 'mem:aaa',
      resolvedId: 'mem:bbb',
    };
    expect(() =>
      assertValidMemoryEntry(bad as unknown as { id: string } & Record<string, unknown>),
    ).toThrow();
  });
});

// ─── the loader chain step ─────────────────────────────────────────────────────

describe('the 1→2 loader chain step', () => {
  it('produces the v2 envelope while PRESERVING the line id (in-place upgrade)', () => {
    const step = MEMORY_MIGRATORS.find((m) => m.from === '1' && m.to === '2');
    expect(step).toBeDefined();
    const raw = v1Record() as unknown as Record<string, unknown>;
    const out = step!.migrate(raw);
    expect(out.id).toBe(raw.id); // the loader's contract: id is stable across the walk
    expect(out.schemaVersion).toBe('2');
    expect(out.visibility).toBe('workspace');
    expect(out.propositionKey).toBe(derivePropositionKey({ subject: SUBJECT }));
  });

  it('migrateMemoryRecord is the identity for v1 while v1 is the live current version', () => {
    const raw = v1Record() as unknown as Record<string, unknown>;
    expect(migrateMemoryRecord(raw, '1')).toBe(raw);
  });
});

// ─── the pure alias helpers ────────────────────────────────────────────────────

describe('buildAliasIndex + bridgedDecisions', () => {
  const verdicts = {
    trust: 'local',
    evidence: 'valid',
    applicability: 'current',
    lifecycle: 'active',
  } as const;
  const alias = (legacyId: string, resolvedId: string): MemoryAlias => ({
    id: memoryAliasId({ legacyId, resolvedId }),
    schemaVersion: '1',
    legacyId,
    resolvedId,
    verdicts,
  });

  it('resolves legacy ids; two legacy ids onto one twin are legitimate', () => {
    const idx = buildAliasIndex([alias('mem:a', 'mem:x'), alias('mem:b', 'mem:x')]);
    expect(idx.resolve('mem:a')).toBe('mem:x');
    expect(idx.resolve('mem:b')).toBe('mem:x');
    expect(idx.resolve('mem:zzz')).toBeUndefined();
    expect(idx.aliasFor('mem:x')?.legacyId).toBe('mem:b'); // last writer for aliasFor, resolve is exact
  });

  it('aliasesFor exposes EVERY legacy id bound to a twin — never a last-wins silent pick', () => {
    const a = alias('mem:a', 'mem:x');
    const b = alias('mem:b', 'mem:x');
    const idx = buildAliasIndex([a, b]);
    expect(idx.aliasesFor('mem:x')).toEqual([a, b]);
    expect(idx.aliasesFor('mem:other')).toEqual([]);
  });

  it('resolves a v1 → v2 → v3 chain and retains the original legacy binding', () => {
    const v1ToV2 = alias('mem:v1', 'mem:v2');
    const v2ToV3 = alias('mem:v2', 'mem:v3');
    const idx = buildAliasIndex([v1ToV2, v2ToV3]);

    expect(idx.resolve('mem:v1')).toBe('mem:v3');
    expect(idx.resolve('mem:v2')).toBe('mem:v3');
    expect(idx.aliasesFor('mem:v3')).toEqual([v1ToV2, v2ToV3]);
  });

  it('FAILS CLOSED on one legacy id bound to two different resolved ids', () => {
    expect(() => buildAliasIndex([alias('mem:a', 'mem:x'), alias('mem:a', 'mem:y')])).toThrow(
      AliasConflictError,
    );
  });

  it('bridgedDecisions bridges decisions from EVERY legacy id bound to the record', () => {
    const decs = [decisionOn('mem:a', 'quarantine'), decisionOn('mem:b', 'supersede')];
    // no aliases bound to the record: exact no-op
    expect(bridgedDecisions([], 'mem:x', decs)).toBe(decs);
    expect(bridgedDecisions(undefined, 'mem:x', decs)).toBe(decs);

    // BOTH bound legacy ids bridge — matching the multi-alias feedback path (additive, on-disk
    // lines never rewritten)
    const bridged = bridgedDecisions(
      [alias('mem:a', 'mem:x'), alias('mem:b', 'mem:x')],
      'mem:x',
      decs,
    );
    expect(bridged).toHaveLength(4); // originals stay; one copy per bound legacy id is ADDED
    const copied = bridged.filter((d) => d.subject === 'mem:x');
    expect(copied).toHaveLength(2);
    expect(copied.map((d) => d.kind).sort()).toEqual(['quarantine', 'supersede']);
    // an alias bound to a DIFFERENT record bridges nothing
    const mixed = bridgedDecisions([alias('mem:a', 'mem:y')], 'mem:x', decs);
    expect(mixed).toBe(decs);
  });

  it('conservativeVerdicts merges collapsed-sibling snapshots worst-axis-first, order-independent', () => {
    const strong = {
      ...alias('mem:a', 'mem:x'),
      verdicts: {
        trust: 'team',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'active',
      },
    } as MemoryAlias;
    const weak = {
      ...alias('mem:b', 'mem:x'),
      verdicts: {
        trust: 'candidate',
        evidence: 'invalid',
        applicability: 'orphaned',
        lifecycle: 'retracted',
      },
    } as MemoryAlias;
    expect(conservativeVerdicts([strong, weak])).toEqual({
      trust: 'candidate', // worst trust
      evidence: 'invalid', // worst evidence
      applicability: 'orphaned', // worst applicability
      lifecycle: 'retracted', // worst lifecycle
    });
    // determinism: merge is a function of the SET, never of sibling order
    expect(conservativeVerdicts([weak, strong])).toEqual(conservativeVerdicts([strong, weak]));
    expect(conservativeVerdicts([])).toBeUndefined();
  });

  it('bridgedDecisions is an exact no-op without bound aliases, additive with one', () => {
    const decs = [decisionOn('mem:a', 'quarantine'), decisionOn('mem:other', 'quarantine')];
    expect(bridgedDecisions(undefined, 'mem:x', decs)).toBe(decs);

    const a = alias('mem:a', 'mem:x');
    const bridged = bridgedDecisions([a], 'mem:x', decs);
    expect(bridged).toHaveLength(3); // originals stay; the legacy-keyed copy is ADDED
    expect(bridged.filter((d) => d.subject === 'mem:x')).toHaveLength(1);
    expect(bridged[2]).toEqual({ ...decs[0], subject: 'mem:x' });
    expect(canonicalMemoryJson(decs[0]!)).toContain('"mem:a"'); // the on-disk line is never rewritten
  });
});

// ─── local mixed-store migration end-to-end ──────────────────────────────────

describe('MemoryStore.migrateToV2 (local, mixed store)', () => {
  it('rewrites the v1 record to its v2 twin, persists the alias, and touches nothing else', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    const cand = candidateFor(v1);
    const dec = decisionOn(v1.id, 'supersede');
    const fb = feedbackOn(v1.id, 'useful');
    s.upsertEntries('active', [v1]);
    s.upsertEntries('candidates', [cand]);
    s.upsertEntries('decisions', [dec]);
    s.upsertEntries('feedback', [fb]);
    const v2 = twinId(v1);

    const result = s.migrateToV2();
    expect(result.migrated).toEqual([v2]);
    expect(result.aliases).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.retained).toBe(0);

    // active holds ONLY the v2 twin (read v1, write v2)
    const active = s.readCollection('active');
    expect(active.errors).toHaveLength(0);
    expect(active.entries).toHaveLength(1);
    expect(active.entries[0]?.id).toBe(v2);
    expect(isMemoryRecordV2(active.entries[0] as MemoryRecord | MemoryRecordV2)).toBe(true);

    // the other collections are untouched
    expect(s.readCollection('candidates').entries).toEqual([cand]);
    expect(s.readCollection('decisions').entries).toEqual([dec]);
    expect(s.readCollection('feedback').entries).toEqual([fb]);

    // manifest counts survive the 1:1 replacement
    expect(s.readManifest()?.counts.records).toBe(1);
  });

  it('resolves the v1 id transparently: findEntry/resolveId/readAlias all return the twin', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    s.upsertEntries('active', [v1]);
    const v2 = twinId(v1);
    s.migrateToV2();

    expect(s.readAlias(v1.id)?.resolvedId).toBe(v2);
    expect(s.resolveId(v1.id)).toBe(v2);
    const viaLegacy = s.findEntry('active', v1.id) as MemoryRecordV2;
    expect(viaLegacy.id).toBe(v2);
    expect(viaLegacy.schemaVersion).toBe('2');
    expect(s.findEntry('active', v2)?.id).toBe(v2); // direct hit still works
    expect(s.findEntry('active', 'mem:never')).toBeUndefined();
  });

  it('is idempotent: a second run writes nothing and every byte is unchanged', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    s.upsertEntries('active', [v1Record(), v1Record({ claim: 'A.b does another thing' })]);
    s.upsertEntries('feedback', [feedbackOn(v1Record().id, 'useful')]);
    const first = s.migrateToV2();
    expect(first.migrated).toHaveLength(2);

    const root = dirname(s.aliasesDir());
    const before = snapshotDir(root);
    const second = s.migrateToV2();
    expect(second.migrated).toHaveLength(0);
    expect(second.aliases).toHaveLength(0);
    expect(second.skipped).toBe(0);
    expect(snapshotDir(root)).toEqual(before);
  });

  it('skips when the v2 twin is already present beside the v1 line — first writer wins, never forks', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    // an INDEPENDENT writer (different principal) already recorded the twin: provenance is excluded
    // from the v2 seed, so the migration's default-env twin derives the SAME id and must not fork
    const independent = migrateRecordV1ToV2(
      v1,
      migrationProvenance(v1.authorship, {}, { KCRIB_PRINCIPAL_ID: 'principal:other' }),
    );
    s.upsertEntries('active', [v1, independent.record]);

    const result = s.migrateToV2();
    expect(result.migrated).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.aliases).toHaveLength(1); // the binding is still recorded

    // the v1 line is retired, the twin is NOT overwritten (byte-identical to the independent write)
    const active = s.readCollection('active');
    expect(active.entries).toHaveLength(1);
    expect(active.entries[0]?.id).toBe(independent.record.id);
    expect(canonicalMemoryJson(active.entries[0] as MemoryEntry)).toBe(
      canonicalMemoryJson(independent.record),
    );
  });
});

describe('MemoryStore.migrateToV3 (local)', () => {
  it('re-addresses a v2 record into its namespace and keeps the v2 address resolvable', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    s.upsertEntries('active', [v1]);
    s.migrateToV2();
    const v2 = s.readCollection('active').entries[0] as MemoryRecordV2;
    const namespace = { principalId: v2.provenance.principalId, workspaceId: 'workspace:crib' };

    const result = s.migrateToV3({ namespace });
    expect(result.migrated).toHaveLength(1);
    expect(result.aliases).toHaveLength(1);
    const active = s.readCollection('active').entries;
    expect(active).toHaveLength(1);
    const v3 = active.find((entry) => isMemoryRecordV3(entry)) as MemoryRecordV3 | undefined;
    expect(isMemoryRecordV3(v3)).toBe(true);
    expect(v3?.namespace).toEqual(namespace);
    expect(s.resolveId(v2.id)).toBe(v3?.id);
    expect(s.findEntry('active', v2.id)?.id).toBe(v3?.id);
  });
});

// ─── verdict restoration + additive read-bridges through recall ───────────────

describe('recall after migration (verdict restoration + legacy-keyed events)', () => {
  it('a migrated twin ranks with its v1 verdicts restored (no silent demotion)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    s.upsertEntries('active', [v1]);
    const before = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(before.memories.map((m) => m.record.id)).toEqual([v1.id]);

    const v2 = twinId(v1);
    s.migrateToV2();
    const after = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(after.memories).toHaveLength(1);
    expect(after.memories[0]?.record.id).toBe(v2);
    expect(after.memories[0]?.verdicts.trust).toBe('local'); // restored from the alias snapshot
    expect(after.memories[0]?.verdicts.evidence).toBe('valid');
    expect(isRecallEligible(after.memories[0]!.verdicts)).toBe(true);

    // control: a v2 record with NO alias (a fresh observation) stays rank-ineligible
    const fresh: MemoryRecordV2 = {
      id: memoryRecordV2Id({
        kind: 'fact',
        subject: 'sym:src/other.ts#X.y',
        propositionKey: derivePropositionKey({ subject: 'sym:src/other.ts#X.y' }),
        claim: 'X.y does something',
        evidence: [evidence()],
      }),
      schemaVersion: '2',
      visibility: 'private',
      kind: 'fact',
      subject: 'sym:src/other.ts#X.y',
      propositionKey: derivePropositionKey({ subject: 'sym:src/other.ts#X.y' }),
      claim: 'X.y does something',
      validTime: { from: NOW },
      transactionTime: { observedAt: NOW, recordedAt: NOW },
      evidence: [evidence()],
      provenance: migrationProvenance({ actor: 'claude-code', kind: 'agent' }),
      lineage: {},
      sensitivity: 'internal',
      retentionPolicyId: DEFAULT_RETENTION_POLICY_ID,
    };
    s.upsertEntries('active', [fresh]);
    const mixed = recallProjection(gatherRecall({ local: s }), { query: '' });
    expect(mixed.memories.map((m) => m.record.id)).not.toContain(fresh.id);
  });

  it('a feedback record keyed on the v1 id still adjusts the migrated twin', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    s.upsertEntries('active', [v1]);
    s.upsertEntries('feedback', [feedbackOn(v1.id, 'unhelpful')]);
    const v2 = twinId(v1);
    s.migrateToV2();

    const p = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(p.memories[0]?.record.id).toBe(v2);
    expect(p.memories[0]?.score.feedbackAdjust).toBe(-1); // bridged onto the resolved id
  });

  it('a quarantine decision keyed on the v1 id still excludes the migrated twin', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    s.upsertEntries('active', [v1]);
    s.upsertEntries('decisions', [decisionOn(v1.id, 'quarantine')]);
    const v2 = twinId(v1);
    s.migrateToV2();

    const p = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(p.memories).toHaveLength(0); // excluded from normal recall, NOT deleted
    const viaLegacy = s.findEntry('active', v1.id);
    expect(viaLegacy?.id).toBe(v2); // the record itself is still there
  });

  it('a v1 conflict pair migrates to two COEXISTING claims (migration never fabricates lineage)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const x = v1Record({ claim: 'A.b does X' });
    const y = v1Record({ claim: 'A.b does Y' });
    s.upsertEntries('active', [x, y]);
    const pre = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(pre.conflicts).toHaveLength(1); // the heuristic v1 group (subject + scope)

    s.migrateToV2();
    const post = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(post.memories).toHaveLength(2); // both twins rank
    expect(post.conflicts).toHaveLength(0); // ...and neither contradicts the other
  });
});

// ─── collapsed twins: two legacy ids, one v2 record (adversarial-review fix) ───
//
// The v2 content seed excludes v1 authorship/scope BY DESIGN, so two v1 records of one claim
// (observed by two actors, or at two scope boundaries) collapse onto ONE twin. The decision bridge
// and the verdict snapshot must therefore be MULTI-alias (like the feedback bridge) and the
// snapshot CONSERVATIVE (worst axis) — never a last-wins silent pick.

describe('recall after migration (collapsed twins)', () => {
  it('a quarantine decision on ANY collapsed sibling keeps the twin out of recall (no resurface)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const claude = v1Record(); // actor claude-code
    const codex = v1Sibling(claude, { actor: 'codex' }); // same claim, different actor -> same twin
    const twin = twinId(claude);
    expect(claude.id).not.toBe(codex.id); // distinct v1 ids...
    expect(twinId(codex)).toBe(twin); // ...one v2 twin
    s.upsertEntries('active', [claude, codex]);
    s.upsertEntries('decisions', [decisionOn(claude.id, 'quarantine')]);

    // pre-migration: the quarantined sibling is excluded, the active sibling ranks
    const before = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(before.memories.map((m) => m.record.id)).toEqual([codex.id]);

    s.migrateToV2();
    // post-migration: the twin IS the quarantined sibling's claim too — the quarantine bridges
    // from the legacy id and the claim must NOT resurface in `memories`
    const after = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(after.memories).toHaveLength(0);
    // quarantined, not deleted: the twin is still in the store, reachable by either legacy id
    expect(s.findEntry('active', codex.id)?.id).toBe(twin);
    expect(s.findEntry('active', claude.id)?.id).toBe(twin);
  });

  it('a quarantine on one twin does not leak to another record of a different claim', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const claude = v1Record();
    const codex = v1Sibling(claude, { actor: 'codex' });
    const other = v1Record({ claim: 'A.b does a different thing' }); // a different claim/twin
    s.upsertEntries('active', [claude, codex, other]);
    s.upsertEntries('decisions', [decisionOn(claude.id, 'quarantine')]);

    s.migrateToV2();
    const p = recallProjection(gatherRecall({ local: s }), { query: '' });
    expect(p.memories.map((m) => m.record.id)).toEqual([twinId(other)]); // only the clean twin
  });

  it('the twin of two ACTIVE collapsed siblings stays recall-eligible (no over-exclusion)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const claude = v1Record();
    const codex = v1Sibling(claude, { actor: 'codex' });
    s.upsertEntries('active', [claude, codex]);

    s.migrateToV2();
    const p = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(p.memories.map((m) => m.record.id)).toEqual([twinId(claude)]);
    expect(p.memories[0]?.verdicts.trust).toBe('local'); // both siblings stamped local/valid
    expect(p.memories[0]?.verdicts.evidence).toBe('valid');
  });

  it('the verdict snapshot across collapsed siblings is CONSERVATIVE (worst axis), never last-wins', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const base = v1Record();
    // sibling verdicts differ on two axes in OPPOSITE directions, so no single-alias pick can
    // produce the conservative merge — last-wins (any order) yields one whole sibling's axes
    const x = v1Sibling(base, {
      actor: 'codex',
      verdicts: {
        trust: 'team',
        evidence: 'degraded',
        applicability: 'current',
        lifecycle: 'active',
      },
    });
    const y = v1Sibling(base, {
      actor: 'cursor',
      verdicts: {
        trust: 'local',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'active',
      },
    });
    s.upsertEntries('active', [x, y]);

    s.migrateToV2();
    const p = recallProjection(gatherRecall({ local: s }), { query: SUBJECT });
    expect(p.memories).toHaveLength(1);
    expect(p.memories[0]?.record.id).toBe(twinId(base));
    expect(p.memories[0]?.verdicts.trust).toBe('local'); // worst of {team, local}
    expect(p.memories[0]?.verdicts.evidence).toBe('degraded'); // worst of {degraded, valid}
  });
});

// ─── the alias binding carries the v1 state the v2 envelope drops ────────────

describe('alias-carried v1 state (as-believed recoverability)', () => {
  it('scope/appliesTo/meta travel in the alias binding — recoverable after the v1 line is replaced', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = {
      ...v1Record(),
      meta: { receiptId: 'rcpt:abc', note: 'promotion linkage' },
    };
    s.upsertEntries('active', [v1]);

    const result = s.migrateToV2();
    expect(result.migrated).toHaveLength(1);
    // the twin drops the v1 placement/targets/meta (the closed envelope has no counterpart)...
    const twin = s.findEntry('active', v1.id) as MemoryRecordV2;
    expect(isMemoryRecordV2(twin)).toBe(true);
    expect((twin as unknown as MemoryRecord).scope).toBeUndefined();
    expect((twin as unknown as MemoryRecord).appliesTo).toBeUndefined();
    // ...so the alias binding carries them: the as-believed v1 state stays recoverable
    const alias = s.readAlias(v1.id);
    expect(alias).toBeDefined();
    expect(alias?.scope).toEqual(v1.scope);
    expect(alias?.appliesTo).toEqual(v1.appliesTo);
    expect(alias?.meta).toEqual(v1.meta);
    expect(alias?.verdicts).toEqual(v1.verdicts);
    // and the enriched binding still passes the write gate
    expect(() =>
      assertValidMemoryEntry(alias as unknown as { id: string } & Record<string, unknown>),
    ).not.toThrow();
  });

  it('re-migrating a pre-enrichment store upserts the enriched alias in place (idempotent, same id)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    s.upsertEntries('active', [v1]);
    s.migrateToV2();
    // simulate a pre-enrichment binding: same ids, no carried v1 state
    const bare: MemoryAlias = {
      id: memoryAliasId({ legacyId: v1.id, resolvedId: twinId(v1) }),
      schemaVersion: '1',
      legacyId: v1.id,
      resolvedId: twinId(v1),
      verdicts: v1.verdicts,
    };
    s.upsertAliases([bare]);
    expect(s.readAlias(v1.id)?.scope).toBeUndefined(); // the bare binding replaced it

    // a fresh migration of the (already v2) store re-upserts nothing — but upserting the enriched
    // alias again converges the map to the carried-state form (replace by id, id unchanged)
    const { alias } = migrateRecordV1ToV2(v1, migrationProvenance(v1.authorship));
    expect(alias.id).toBe(bare.id); // the seed is {legacyId, resolvedId} only — id never moved
    s.upsertAliases([alias]);
    const read = s.readAlias(v1.id);
    expect(read?.scope).toEqual(v1.scope);
    expect(read?.appliesTo).toEqual(v1.appliesTo);
  });
});

// ─── team + global migration semantics ───────────────────────────────────────

describe('MemoryStore.migrateToV2 (team + global)', () => {
  it('team records the binding ONLY: every pre-existing byte is unchanged, the v1 line stays live', () => {
    const team = MemoryStore.team(join(home, 'crib'), { env, now: () => NOW });
    const v1 = v1Record();
    team.upsertEntries('records', [v1]);
    const before = snapshotDir(dirname(team.aliasesDir()));

    const result = team.migrateToV2();
    expect(result.migrated).toHaveLength(0); // no twin written beside the retained v1 line
    expect(result.retained).toBe(1);
    expect(result.aliases).toHaveLength(1);

    const after = snapshotDir(dirname(team.aliasesDir()));
    for (const [path, bytes] of before) expect(after.get(path)).toBe(bytes);

    // the alias resolves, and the direct hit still wins (the v1 line is live, not a stale address)
    expect(team.resolveId(v1.id)).toBe(twinId(v1));
    expect(team.findEntry('records', v1.id)?.id).toBe(v1.id);

    // recall over the retained line does NOT double-list the claim
    const p = recallProjection(gatherRecall({ team }), { query: SUBJECT });
    expect(p.memories.map((m) => m.record.id)).toEqual([v1.id]);
  });

  it('global replaces the v1 line with its twin and persists the alias', () => {
    const g = MemoryStore.global({ env, now: () => NOW });
    const v1 = v1Record();
    g.upsertEntries('records', [v1]);
    const v2 = twinId(v1);

    const result = g.migrateToV2();
    expect(result.migrated).toEqual([v2]);
    const records = g.readCollection('records');
    expect(records.entries).toHaveLength(1);
    expect(records.entries[0]?.id).toBe(v2);
    expect(g.resolveId(v1.id)).toBe(v2);
    expect((g.findEntry('records', v1.id) as MemoryRecordV2).schemaVersion).toBe('2');
  });

  it('readAliases fails closed on a corrupt alias shard', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    s.upsertEntries('active', [v1]);
    s.migrateToV2();
    // corrupt the persisted map: a line that is not an alias
    const shard = s.aliasShardPath(v1.id);
    const lines = readFileSync(shard, 'utf8').trim().split('\n');
    writeFileSync(
      shard,
      `${lines[0]}\n${JSON.stringify({ id: 'mem:not-an-alias', schemaVersion: '1' })}\n`,
    );
    expect(() => s.readAliases()).toThrow(/corrupt alias map/);
  });
});

// ─── the v1 dedupe invariants are preserved (the seed did not move) ───────────

describe('v1 content-addressed invariants survive G1.2', () => {
  it('re-observing the same v1 input yields the same v1 id; tool changes dedupe; kind does not', () => {
    const { input } = v1Input();
    expect(memoryRecordId(input)).toBe(memoryRecordId(v1Input().input));
    const otherTool = {
      ...input,
      authorship: { ...input.authorship, tool: 'cursor' },
    };
    expect(memoryRecordId(otherTool)).toBe(memoryRecordId(input)); // tool is not identity
    const human = {
      ...input,
      authorship: { actor: 'vishal', kind: 'human' as const },
    };
    expect(memoryRecordId(human)).not.toBe(memoryRecordId(input)); // actor/kind are
  });

  it('the cand:↔mem: shared-id promotion contract is intact', () => {
    const { input } = v1Input();
    const cand: string = memoryCandidateId(input);
    const mem: string = memoryRecordId(input);
    expect(cand.replace('cand:', 'mem:')).toBe(mem); // promotion of an identical claim collapses
    const promoted: MemoryRecord = v1Record();
    const staged = candidateFor(promoted);
    expect(staged.id).toBe(`cand:${promoted.id.slice('mem:'.length)}`);
  });
});
