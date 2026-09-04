import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * G1.1 — the memory-2 envelope: the v2 record schema, content-addressed v2 ids, propositionKey
 * derivation, mixed v1+v2 store acceptance, byte-stable round-trips, and the proposition-keyed
 * conflict semantics (complementary facts about one subject do NOT conflict; explicit
 * `lineage.contradicts` within one propositionKey DOES). Also pins that v1 conflict behaviour and
 * the v1 read projection are unchanged for v1 records.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryFtsIndex,
  type MemoryRecord,
  type MemoryRecordV2,
  MemoryStore,
  TeamPrivateVisibilityError,
  __resetMemoryLockGuardForTest,
  assertValidMemoryEntry,
  assertValidMemoryRecord,
  assertValidMemoryRecordV2,
  canonicalMemoryJson,
  conflictGroups,
  derivePropositionKey,
  effectiveVerdicts,
  gatherRecall,
  isMemoryRecordV2,
  isRecallEligible,
  memoryRecordId,
  memoryRecordV2Id,
  parseMemoryShard,
  recallProjection,
  recordSortTime,
  serializeMemoryShard,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-v2';
/** The principal every v2 fixture is stamped with. Recall must be called as this principal to see
 *  them (G7 boundary) — referenced by both `v2Input` and the recall tests so they cannot drift. */
const FIXTURE_PRINCIPAL = 'principal-1';

// ─── fixtures ────────────────────────────────────────────────────────────────

function evidence(over: Record<string, unknown> = {}): MemoryRecordV2['evidence'][number] {
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

interface V2Input {
  subject?: string;
  claim?: string;
  propositionKey?: string;
  evidence?: MemoryRecordV2['evidence'];
  provenance?: Partial<MemoryRecordV2['provenance']>;
  lineage?: MemoryRecordV2['lineage'];
  visibility?: MemoryRecordV2['visibility'];
  sensitivity?: MemoryRecordV2['sensitivity'];
  retentionPolicyId?: string;
}

function v2Input(over: V2Input = {}): Parameters<typeof memoryRecordV2Id>[0] & {
  visibility: MemoryRecordV2['visibility'];
  validTime: MemoryRecordV2['validTime'];
  transactionTime: MemoryRecordV2['transactionTime'];
  provenance: MemoryRecordV2['provenance'];
  lineage: MemoryRecordV2['lineage'];
  sensitivity: MemoryRecordV2['sensitivity'];
  retentionPolicyId: string;
} {
  const subject = over.subject ?? 'sym:src/a.ts#A.b';
  return {
    kind: 'fact',
    subject,
    propositionKey: derivePropositionKey({ subject, propositionKey: over.propositionKey }),
    claim: over.claim ?? 'A.b does the thing',
    evidence: over.evidence ?? [evidence()],
    visibility: over.visibility ?? 'private',
    validTime: { from: '2026-01-01T00:00:00.000Z' },
    transactionTime: { observedAt: NOW, recordedAt: NOW },
    provenance: {
      principalId: FIXTURE_PRINCIPAL,
      deviceId: 'device-1',
      actorId: 'actor-1',
      clientId: 'claude-code',
      ...over.provenance,
    } as MemoryRecordV2['provenance'],
    lineage: over.lineage ?? {},
    sensitivity: over.sensitivity ?? 'internal',
    retentionPolicyId: over.retentionPolicyId ?? 'ret:default',
  };
}

/** Build a fully-valid memory-2 record (id content-addressed from the v2 seed). */
function v2Record(over: V2Input = {}): MemoryRecordV2 {
  const input = v2Input(over);
  return { id: memoryRecordV2Id(input), schemaVersion: '2', ...input };
}

function v1Record(claim = 'A.b does the thing', subject = 'sym:src/a.ts#A.b'): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [subject],
    evidence: [evidence()],
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

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-v2-home-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

// ─── schema validation ────────────────────────────────────────────────────────

describe('memory-2 schema validation', () => {
  it('a fully-valid v2 record passes both the v2 validator and prefix entry dispatch', () => {
    const r = v2Record();
    expect(() => assertValidMemoryRecordV2(r)).not.toThrow();
    expect(() =>
      assertValidMemoryEntry(r as unknown as { id: string } & Record<string, unknown>),
    ).not.toThrow();
  });

  it('dispatches on the DECLARED schemaVersion — a v2 record fails the v1 schema and vice versa', () => {
    const v2 = v2Record();
    expect(() => assertValidMemoryRecord(v2 as unknown as MemoryRecord)).toThrow();
    type Entry = { id: string } & Record<string, unknown>;
    expect(() => assertValidMemoryEntry({ ...v2, schemaVersion: '1' } as unknown as Entry)).toThrow(
      /record schema validation failed/,
    );

    const v1 = v1Record();
    expect(() => assertValidMemoryEntry({ ...v1, schemaVersion: '2' } as unknown as Entry)).toThrow(
      /record-v2 schema validation failed/,
    );
  });

  it('enforces the exact v2 field set (additionalProperties: false — tenancy stays absent)', () => {
    const withTenancy = {
      ...v2Record(),
      tenantId: 'org-1',
    } as unknown as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(withTenancy)).toThrow(/tenantId/);

    for (const drop of [
      'propositionKey',
      'visibility',
      'sensitivity',
      'retentionPolicyId',
      'provenance',
      'lineage',
      'validTime',
      'transactionTime',
    ] as const) {
      const partial = { ...v2Record() } as Record<string, unknown>;
      delete partial[drop];
      expect(() =>
        assertValidMemoryEntry(partial as unknown as { id: string } & Record<string, unknown>),
      ).toThrow();
    }
  });

  it('rejects out-of-enum visibility/sensitivity values', () => {
    const badVisibility = { ...v2Record(), visibility: 'org-wide' } as unknown as MemoryRecordV2;
    const badSensitivity = { ...v2Record(), sensitivity: 'secret' } as unknown as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(badVisibility)).toThrow();
    expect(() => assertValidMemoryRecordV2(badSensitivity)).toThrow();
  });

  it('rejects an inverted or empty validTime window (to must be STRICTLY after from)', () => {
    const base = v2Record(); // validTime is excluded from the id seed — tweak it freely

    // to === from: an empty half-open [from,to) window is not a valid validity interval
    const equal = { ...base, validTime: { from: NOW, to: NOW } } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(equal)).toThrow(/validTimeWindow/);
    // the entry dispatch (the store's write gate) enforces the same constraint
    expect(() =>
      assertValidMemoryEntry(equal as unknown as { id: string } & Record<string, unknown>),
    ).toThrow(/validTimeWindow/);

    // to < from: inverted window
    const inverted = {
      ...base,
      validTime: { from: '2026-06-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(inverted)).toThrow(/validTimeWindow/);

    // unparseable date-times fail closed — now at the SCHEMA pattern level first (the runtime
    // window check remains belt-and-braces for hand-built in-memory inputs).
    const garbage = { ...base, validTime: { from: 'not-a-date' } } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(garbage)).toThrow(/validTime/);
    const garbageTo = { ...base, validTime: { from: NOW, to: 'yesterday-ish' } } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(garbageTo)).toThrow(/validTime/);

    // a proper half-open window (and the open-ended from-only form) still validates
    const ok = {
      ...base,
      validTime: { from: NOW, to: '2026-12-01T00:00:00.000Z' },
    } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(ok)).not.toThrow();
    expect(() => assertValidMemoryRecordV2(base)).not.toThrow();
  });

  // ─── adversarial-verify finding 5: the SCHEMA itself pins the ISO instant form ───

  it('the v2 schema rejects non-instant validTime bounds at the pattern level', () => {
    const base = v2Record();
    // date-only parses under Date.parse, so the runtime window check alone admits it — the
    // SCHEMA must pin the canonical full-instant form every writer emits (toISOString).
    const dateOnly = { ...base, validTime: { from: '2026-03-01' } } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(dateOnly)).toThrow(/validTime/);

    const dateOnlyTo = {
      ...base,
      validTime: { from: NOW, to: '2026-03-01' },
    } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(dateOnlyTo)).toThrow(/validTime/);

    // canonical forms (ms precision, optional offset) still validate
    const canonical = {
      ...base,
      validTime: { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T05:30:00+05:30' },
    } as MemoryRecordV2;
    expect(() => assertValidMemoryRecordV2(canonical)).not.toThrow();
  });

  it('the strict loader rejects a persisted v2 line with an inverted validTime window', () => {
    const inverted = {
      ...v2Record(),
      validTime: { from: '2026-06-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    } as MemoryRecordV2;
    const parsed = parseMemoryShard(`${JSON.stringify(inverted)}\n`, 'x.jsonl');
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatch(/validTimeWindow/);
  });
});

// ─── content-addressed v2 ids ─────────────────────────────────────────────────

describe('memoryRecordV2Id', () => {
  it('repeated observations of the same claim dedupe to one id', () => {
    expect(memoryRecordV2Id(v2Input())).toBe(memoryRecordV2Id(v2Input()));
    expect(memoryRecordV2Id(v2Input())).toMatch(/^mem:[0-9a-f]+$/);
  });

  it('a different claim about the same proposition produces a different id', () => {
    const a = memoryRecordV2Id(v2Input({ claim: 'A.b does X' }));
    const b = memoryRecordV2Id(v2Input({ claim: 'A.b does Y' }));
    expect(a).not.toBe(b);
  });

  it('excludes placement, governance, time, provenance, and lineage from the seed', () => {
    const base = memoryRecordV2Id(v2Input());
    // A FULL record with every envelope field varied must hash identically: the seed reads only
    // kind/subject/propositionKey/claim/evidence, so placement, governance, both time axes,
    // provenance, and lineage never fork the id (repeated observations dedupe).
    const varied = {
      ...v2Input(),
      visibility: 'workspace',
      sensitivity: 'restricted',
      retentionPolicyId: 'ret:strict',
      validTime: { from: '2020-01-01T00:00:00.000Z', to: '2021-01-01T00:00:00.000Z' },
      transactionTime: {
        observedAt: '2026-05-05T00:00:00.000Z',
        recordedAt: '2026-06-06T00:00:00.000Z',
      },
      provenance: {
        principalId: 'principal-2',
        deviceId: 'device-2',
        actorId: 'actor-2',
        agentId: 'codex',
        clientId: 'codex',
        sessionId: 'session-9',
        tool: 'memory_observe',
      },
      lineage: { supersedes: ['mem:old'], contradicts: ['mem:other'] },
    } as unknown as Parameters<typeof memoryRecordV2Id>[0];
    expect(memoryRecordV2Id(varied)).toBe(base);
  });

  it('excludes mutable evidence check results and is evidence-order independent', () => {
    const base = memoryRecordV2Id(v2Input());
    const flipped = memoryRecordV2Id(
      v2Input({
        evidence: [
          evidence({ verdict: 'degraded', checkedAt: '2026-02-02T00:00:00.000Z', reason: 'drift' }),
        ],
      }),
    );
    expect(flipped).toBe(base);

    const a = memoryRecordV2Id(
      v2Input({ evidence: [evidence(), evidence({ kind: 'human-attestation' })] }),
    );
    const b = memoryRecordV2Id(
      v2Input({ evidence: [evidence({ kind: 'human-attestation' }), evidence()] }),
    );
    expect(a).toBe(b);
  });

  it('is distinct from the v1 id of the same raw content (different seeds by design)', () => {
    // The G1.2 alias map reconciles the two; the id functions must not silently converge.
    const subject = 'sym:src/a.ts#A.b';
    const v1 = memoryRecordId({
      kind: 'fact',
      subject,
      claim: 'A.b does the thing',
      scope: { boundary: 'repo', repoId: REPO },
      appliesTo: [subject],
      evidence: [evidence()],
      authorship: { actor: 'claude-code', kind: 'agent' },
    });
    const v2 = memoryRecordV2Id({
      kind: 'fact',
      subject,
      propositionKey: derivePropositionKey({ subject }),
      claim: 'A.b does the thing',
      evidence: [evidence()],
    });
    expect(v1).not.toBe(v2);
    expect(v1).toMatch(/^mem:/);
    expect(v2).toMatch(/^mem:/);
  });
});

// ─── propositionKey derivation ────────────────────────────────────────────────

describe('derivePropositionKey', () => {
  it('derives purely from the whitespace-normalized subject', () => {
    expect(derivePropositionKey({ subject: 'sym:src/a.ts#A.b' })).toBe(
      derivePropositionKey({ subject: 'sym:src/a.ts#A.b' }),
    );
    expect(derivePropositionKey({ subject: 'sym:src/a.ts#A.b' })).toBe(
      derivePropositionKey({ subject: '  sym:src/a.ts#A.b  ' }),
    );
    expect(derivePropositionKey({ subject: 'sym:src/a.ts#A.b' })).toMatch(/^prop:[0-9a-f]+$/);
  });

  it('different subjects derive different proposition keys', () => {
    expect(derivePropositionKey({ subject: 'sym:a' })).not.toBe(
      derivePropositionKey({ subject: 'sym:b' }),
    );
  });

  it('an explicit non-empty override wins verbatim (trimmed)', () => {
    expect(derivePropositionKey({ subject: 'sym:a', propositionKey: 'topic:auth-jwt' })).toBe(
      'topic:auth-jwt',
    );
    expect(derivePropositionKey({ subject: 'sym:a', propositionKey: '  topic:auth-jwt  ' })).toBe(
      'topic:auth-jwt',
    );
    // an empty/whitespace override falls back to derivation
    expect(derivePropositionKey({ subject: 'sym:a', propositionKey: '   ' })).toBe(
      derivePropositionKey({ subject: 'sym:a' }),
    );
  });

  it('is claim-independent: two claims about one subject share the proposition', () => {
    const pk = derivePropositionKey({ subject: 'sym:src/a.ts#A.b' });
    const r1 = v2Record({ claim: 'A.b does X' });
    const r2 = v2Record({ claim: 'A.b does Y' });
    expect(r1.propositionKey).toBe(pk);
    expect(r2.propositionKey).toBe(pk);
  });
});

// ─── conflict detection ───────────────────────────────────────────────────────

describe('conflictGroups (v2 proposition-keyed)', () => {
  it('complementary facts sharing a subject do NOT conflict (the G1.1(a) fix)', () => {
    const a = v2Record({ claim: 'A.b issues a JWT' });
    const b = v2Record({ claim: 'A.b is rate-limited to 5 rps' });
    // same subject ⇒ same derived propositionKey ⇒ same bucket, but no contradicts link
    expect(a.propositionKey).toBe(b.propositionKey);
    const groups = conflictGroups([
      { record: a, verdicts: effectiveVerdicts(a, []) },
      { record: b, verdicts: effectiveVerdicts(b, []) },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('mutually exclusive claims (explicit contradicts lineage) about one proposition conflict', () => {
    const a = v2Record({ claim: 'A.b issues a JWT' });
    const contradictsA = v2Record({
      claim: 'A.b issues a session cookie',
      lineage: { contradicts: [a.id] },
    });
    const groups = conflictGroups([
      { record: a, verdicts: effectiveVerdicts(a, []) },
      { record: contradictsA, verdicts: effectiveVerdicts(contradictsA, []) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.records).toHaveLength(2);
    expect(groups[0]?.propositionKey).toBe(a.propositionKey);
    expect(groups[0]?.key).toBe(a.propositionKey);
    expect(groups[0]?.scope).toBeUndefined(); // v2 groups carry no v1 scope
    expect(groups[0]?.records.map((r) => r.id).sort()).toEqual([a.id, contradictsA.id].sort());
  });

  it('contradicts across DIFFERENT proposition keys does not conflict', () => {
    const a = v2Record({ subject: 'sym:src/a.ts#A.b', claim: 'A.b does X' });
    const b = v2Record({
      subject: 'sym:src/c.ts#C.d',
      claim: 'C.d does Y',
      lineage: { contradicts: [a.id] }, // declared, but about a different proposition
    });
    expect(
      conflictGroups([
        { record: a, verdicts: effectiveVerdicts(a, []) },
        { record: b, verdicts: effectiveVerdicts(b, []) },
      ]),
    ).toHaveLength(0);
  });

  it('an explicit propositionKey override participates in conflict grouping', () => {
    const a = v2Record({ subject: 'sym:x', propositionKey: 'topic:auth', claim: 'auth uses JWT' });
    const b = v2Record({
      subject: 'sym:y', // different subject, pinned to the SAME proposition
      propositionKey: 'topic:auth',
      claim: 'auth uses sessions',
      lineage: { contradicts: [a.id] },
    });
    const groups = conflictGroups([
      { record: a, verdicts: effectiveVerdicts(a, []) },
      { record: b, verdicts: effectiveVerdicts(b, []) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.propositionKey).toBe('topic:auth');
  });

  it('a quarantined v2 record cannot conflict', () => {
    const a = v2Record({ claim: 'A.b does X' });
    const b = v2Record({ claim: 'A.b does Y', lineage: { contradicts: [a.id] } });
    const quarantine = {
      id: 'dec:q',
      schemaVersion: '1' as const,
      kind: 'quarantine' as const,
      subject: b.id,
      actor: 'ci',
      ts: NOW,
    };
    const groups = conflictGroups([
      { record: a, verdicts: effectiveVerdicts(a, []) },
      { record: b, verdicts: effectiveVerdicts(b, [quarantine]) },
    ]);
    expect(groups).toHaveLength(0);
  });

  it('a SUPERSEDED or RETRACTED v2 record does not surface as an active conflict', () => {
    // the resolution is already recorded — re-reporting it invites a second, contradictory supersede
    const a = v2Record({ claim: 'A.b does X' });
    const b = v2Record({ claim: 'A.b does Y', lineage: { contradicts: [a.id] } });
    const supersedeB = {
      id: 'dec:s',
      schemaVersion: '1' as const,
      kind: 'supersede' as const,
      subject: b.id,
      actor: 'ci',
      ts: NOW,
    };
    expect(
      conflictGroups([
        { record: a, verdicts: effectiveVerdicts(a, []) },
        { record: b, verdicts: effectiveVerdicts(b, [supersedeB]) },
      ]),
    ).toHaveLength(0); // the v1 eligibility axes (minus trust) exclude the retired record

    const retractB = {
      id: 'dec:r',
      schemaVersion: '1' as const,
      kind: 'retract' as const,
      subject: b.id,
      actor: 'ci',
      ts: NOW,
    };
    expect(
      conflictGroups([
        { record: a, verdicts: effectiveVerdicts(a, []) },
        { record: b, verdicts: effectiveVerdicts(b, [retractB]) },
      ]),
    ).toHaveLength(0);
  });

  it('v1 conflict behaviour is unchanged (subject+scope, scope present in the group)', () => {
    const a = v1Record('A.b does X');
    const b = v1Record('A.b does Y');
    const groups = conflictGroups([
      { record: a, verdicts: effectiveVerdicts(a, []) },
      { record: b, verdicts: effectiveVerdicts(b, []) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.scope).toEqual({ boundary: 'repo', repoId: REPO });
    expect(groups[0]?.propositionKey).toBeUndefined();
  });

  it('v1 and v2 records about the same subject never merge into one group', () => {
    const a = v1Record('A.b does X');
    const b = v2Record({ claim: 'A.b does Y', lineage: { contradicts: [a.id] } });
    expect(
      conflictGroups([
        { record: a, verdicts: effectiveVerdicts(a, []) },
        { record: b, verdicts: effectiveVerdicts(b, []) },
      ]),
    ).toHaveLength(0);
  });
});

// ─── read projection on v2 (no-crash, rank-ineligible, conflict-visible) ──────

describe('effectiveVerdicts + recordSortTime on v2', () => {
  it('projects a v2 record as rank-ineligible without reading missing v1 axes', () => {
    const r = v2Record();
    const v = effectiveVerdicts(r, []);
    expect(isRecallEligible(v)).toBe(false);
    expect(v.trust).toBe('candidate');
    expect(v.evidence).toBe('valid'); // aggregated honestly from the stamped item verdicts
    expect(v.quarantined).toBe(false);
  });

  it('aggregates the v2 evidence axis with the memory-1 rule and honors quarantine decisions', () => {
    const degraded = effectiveVerdicts(
      v2Record({ evidence: [evidence({ verdict: 'degraded' })] }),
      [],
    );
    expect(degraded.evidence).toBe('degraded');
    const invalid = effectiveVerdicts(
      v2Record({ evidence: [evidence({ verdict: 'invalid' })] }),
      [],
    );
    expect(invalid.evidence).toBe('invalid');

    const r = v2Record();
    const quarantine = {
      id: 'dec:q',
      schemaVersion: '1' as const,
      kind: 'quarantine' as const,
      subject: r.id,
      actor: 'ci',
      ts: NOW,
    };
    expect(effectiveVerdicts(r, [quarantine]).quarantined).toBe(true);
  });

  it('recordSortTime uses transactionTime.recordedAt for v2 and createdAt for v1', () => {
    const v2 = v2Record();
    v2.transactionTime.recordedAt = '2026-08-12T00:00:00.000Z';
    expect(recordSortTime(v2)).toBe('2026-08-12T00:00:00.000Z');
    expect(recordSortTime(v1Record())).toBe(NOW);
  });
});

// ─── loader + store + round-trip (mixed v1/v2 shards) ─────────────────────────

describe('loader + store acceptance of mixed v1/v2 records', () => {
  it('parseMemoryShard accepts a v2 line alongside v1 lines with no errors', () => {
    const v1 = v1Record();
    const v2 = v2Record();
    const text = serializeMemoryShard([v1, v2]);
    const parsed = parseMemoryShard(text, 'local/active/00.jsonl');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((e) => e.id).sort()).toEqual([v1.id, v2.id].sort());
  });

  it('round-trips a v2 record byte-stably through the canonical JSONL path', () => {
    const v2 = v2Record();
    const once = serializeMemoryShard([v2]);
    const parsed = parseMemoryShard(once, 'x.jsonl');
    expect(parsed.errors).toHaveLength(0);
    const again = serializeMemoryShard([parsed.entries[0] as unknown as MemoryRecordV2]);
    expect(again).toBe(once);
    // key-sorted canonical form: schemaVersion sorts after provenance etc. — stability, not layout
    expect(once).toBe(`${canonicalMemoryJson(v2)}\n`);
  });

  it('stores accept and re-read a mixed v1+v2 collection (byte-stable rewrite)', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    const v2 = v2Record();
    s.upsertEntries('active', [v1, v2]);
    const read = s.readCollection('active');
    expect(read.errors).toHaveLength(0);
    expect(read.entries.map((e) => e.id).sort()).toEqual([v1.id, v2.id].sort());
    expect(read.entries.filter(isMemoryRecordV2)).toHaveLength(1);

    // upsert again: content-addressed replace is byte-identical (no churn in the shard)
    const before = s.readCollection('active');
    s.upsertEntries('active', [v1, v2]);
    expect(s.readCollection('active').entries).toEqual(before.entries);
  });

  it('the team records collection accepts non-private v2 records too (the merge driver unions by id)', () => {
    const team = MemoryStore.team(join(home, 'crib'), { env, now: () => NOW });
    const v2 = v2Record({ visibility: 'workspace' });
    team.upsertEntry('records', v2);
    const read = team.readCollection('records');
    expect(read.errors).toHaveLength(0);
    expect(read.entries[0]?.id).toBe(v2.id);
    // D10 (ADR-003): the SAME collection refuses a private-projecting v2 record — private never
    // enters git, at the write gate, for every writer.
    expect(() =>
      team.upsertEntry('records', v2Record({ visibility: 'private', claim: 'a private claim' })),
    ).toThrow(TeamPrivateVisibilityError);
  });

  it('a structurally-invalid v2 line is a per-line error, never a silent skip', () => {
    const bad = { ...v2Record() } as Record<string, unknown>;
    bad.propositionKey = undefined; // JSON.stringify drops the key: the line arrives without it
    const parsed = parseMemoryShard(`${JSON.stringify(bad)}\n`, 'x.jsonl');
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain('x.jsonl:1');
  });
});

// ─── recall projection + FTS over a mixed store (no crash, v2 conflict-visible) ─

describe('recallProjection + FTS over a mixed v1/v2 store', () => {
  it('ranks only v1 records but surfaces v2 conflicts', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record('A.b does the thing');
    const a = v2Record({ claim: 'A.b issues a JWT' });
    const b = v2Record({ claim: 'A.b issues a session cookie', lineage: { contradicts: [a.id] } });
    s.upsertEntries('active', [v1, a, b]);

    // G7 boundary: v2 records carry `provenance.principalId`, and gatherRecall admits a record only
    // when it is unstamped (v1 — treated as the caller's own) or stamped with EXACTLY the caller's
    // principal. The fixtures stamp `principal-1`, so recall must be called as that principal or the
    // two v2 rows are correctly excluded as foreign.
    const gathered = gatherRecall({ local: s }, { principal: FIXTURE_PRINCIPAL });
    expect(gathered.records).toHaveLength(3);

    // the same gather as a DIFFERENT principal sees only the unstamped v1 row (no cross-principal leak)
    expect(gatherRecall({ local: s }, { principal: 'principal-2' }).records).toHaveLength(1);

    const projection = recallProjection(gathered, { query: 'sym:src/a.ts#A.b' });
    expect(projection.memories.map((m) => m.record.id)).toEqual([v1.id]);
    expect(projection.conflicts).toHaveLength(1);
    expect(projection.conflicts[0]?.propositionKey).toBe(a.propositionKey);
    expect(projection.provenance.counts.conflicts).toBe(1);
  });

  it('the disposable FTS index rebuilds over mixed-version records without crashing', () => {
    const s = MemoryStore.local(REPO, { env, now: () => NOW });
    const v1 = v1Record();
    const v2 = v2Record({ claim: 'A.b issues a JWT' });
    s.upsertEntries('active', [v1, v2]);
    const gathered = gatherRecall({ local: s }, { principal: FIXTURE_PRINCIPAL });

    const fts = new MemoryFtsIndex(':memory:');
    try {
      fts.rebuild(gathered.records.map((r) => r.record));
      const hits = fts.search('JWT');
      expect(hits.get(v2.id)).toBeGreaterThan(0);
      // v2 placement text is its visibility (never a v1 scope read off `undefined`)
      expect(fts.search('private').get(v2.id)).toBeGreaterThan(0);
    } finally {
      fts.close();
    }
  });
});
