/**
 * G2.3 — the distillation engine. One test per contract clause:
 *
 *   - the PINNED red line: complementary same-subject claims classify as ADD, never CONFLICT — a
 *     CONFLICT decision over non-negating claims is REJECTED as a per-item failure (nothing written,
 *     the entry stays pending), while the same claim as ADD verifies and applies;
 *   - `negatesClaim`: the deterministic contradiction boundary (identical after stripping negation
 *     tokens from both sides, raw claims differ) — pure, no model, no wall clock;
 *   - `distillBatchId`: the drain batch's wall-clock-free identity (sorted ids, stable across
 *     reorders and processes) that the CLI's zero-progress marker matches against;
 *   - per-decision verification fails CLOSED: an uncited SUPERSEDE/CONFLICT/NOOP, a citation that
 *     does not resolve in the LOCAL store, a CONFLICT across propositionKeys, and a NOOP whose
 *     cited duplicate carries a different claim are all per-item failures — never applied;
 *   - SUPERSEDE applies through the portable API's payload path (a v2 successor + decision event),
 *     CONFLICT stages an ADD candidate carrying `meta.contradicts` (the cited record is never
 *     rewritten), NOOP writes nothing;
 *   - ADD reclassification to NOOP: the `cand:` candidate OR its promoted `mem:` twin proves the
 *     content already landed (at-least-once redelivery), and the re-apply is a byte-stable no-op;
 *   - `failDistillItem` honors B's retry/dead-letter lifecycle verbatim: attempt-style appends,
 *     a terminal dead-letter TRANSITION at the third attempt (never a delete);
 *   - store hygiene: every store relocates via KCRIB_MEMORY_DIR into a temp home — nothing here
 *     ever writes the real `~/.crib`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CaptureOutboxEntry,
  type CapturePolicySection,
  type DistillDecision,
  type DistillDecisionKind,
  type DistillVerifyContext,
  type MemoryCandidate,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordKind,
  type MemoryScope,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  applyVerifiedDecision,
  buildCaptureOutboxEntry,
  buildDistillWorkItem,
  captureRetryCount,
  derivePropositionKey,
  distillBatchId,
  failDistillItem,
  markCaptureDone,
  memoryCandidateId,
  memoryRecordId,
  negatesClaim,
  normalizeClaim,
  pendingCaptures,
  readCaptureOutboxEntry,
  readDeadCapture,
  sameSubjectRecords,
  stageCaptureOutboxEntry,
  verifyDistillDecision,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const REPO = 'r-distill';
const SUBJECT = 'sym:src/a.ts#A.b';
const SCOPE: MemoryScope = { boundary: 'repo', repoId: REPO };
const BLAKE_A = `blake3:${'a'.repeat(64)}`;

let home = '';
let env: NodeJS.ProcessEnv;
let local: MemoryStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-distill-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
  local = MemoryStore.local(REPO, { env, now: () => T0 });
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

function ev(
  opts: { kind?: MemoryEvidence['kind']; verdict?: MemoryEvidence['verdict'] } = {},
): MemoryEvidence {
  return {
    kind: opts.kind ?? 'source-quote',
    verdict: opts.verdict ?? 'valid',
    checkedAt: T0,
    soulId: SUBJECT,
    quote: 'does the thing',
    targetHash: BLAKE_A,
  };
}

/** A v1 local record (trust/verdicts excluded from the id seed — same body as its candidate twin). */
function record(opts: { subject?: string; claim?: string; kind?: MemoryRecordKind }): MemoryRecord {
  const input = {
    kind: opts.kind ?? ('fact' as const),
    subject: opts.subject ?? SUBJECT,
    claim: opts.claim ?? 'A.b does the thing',
    scope: SCOPE,
    appliesTo: [SUBJECT],
    evidence: [ev({})],
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

/** A pending capture-outbox entry, staged durably (the distiller's queue row). */
function capture(
  opts: { claim?: string; subject?: string; kind?: MemoryRecordKind } = {},
): CaptureOutboxEntry {
  const entry = buildCaptureOutboxEntry(
    {
      kind: opts.kind ?? ('fact' as const),
      subject: opts.subject ?? SUBJECT,
      claim: opts.claim ?? 'A.b returns 42',
      scope: SCOPE,
      appliesTo: [SUBJECT],
      evidence: [ev({})],
      authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
      origin: 'observe',
      idempotencyKey: `k-${opts.claim ?? 'default'}`,
    },
    T0,
  );
  stageCaptureOutboxEntry(local, entry);
  return entry;
}

/** The `cand:` content id an ADD of this capture's effective content would stage under. */
function contentIdOf(
  entry: CaptureOutboxEntry,
  overrides: { kind?: string; subject?: string; claim?: string } = {},
): string {
  return memoryCandidateId({
    kind: (overrides.kind ?? entry.kind) as MemoryCandidate['kind'],
    subject: overrides.subject ?? entry.subject,
    claim: overrides.claim ?? entry.claim,
    scope: entry.scope,
    appliesTo: entry.appliesTo,
    evidence: entry.evidence,
    authorship: entry.authorship,
  });
}

function ctx(entry: CaptureOutboxEntry, policy?: CapturePolicySection): DistillVerifyContext {
  return { local, entry, ...(policy !== undefined ? { policy } : {}) };
}

/** A decision with the minimum required fields filled (rationale by default). */
function dec(
  fields: { decision: DistillDecisionKind } & Partial<DistillDecision>,
): DistillDecision {
  return { rationale: 'provider judged it so', ...fields };
}

/** Verify a decision against its own capture (the well-addressed case). */
function verify(
  entry: CaptureOutboxEntry,
  decision: DistillDecision,
  policy?: CapturePolicySection,
): ReturnType<typeof verifyDistillDecision> {
  return verifyDistillDecision({ targetId: entry.id, decision }, entry.id, ctx(entry, policy));
}

// ─── the pinned red line: complementary ≠ conflict ───────────────────────────

describe('the pinned false-conflict regression', () => {
  it('a CONFLICT over complementary same-subject claims is REJECTED as a per-item failure, writing nothing', () => {
    const rec = record({ claim: 'the service uses pnpm for installs' });
    local.upsertEntry('active', rec);
    const entry = capture({ claim: 'the service uses npm for installs' });

    const res = verify(entry, dec({ decision: 'CONFLICT', contradictsRecordId: rec.id }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe(
      'unsupported CONFLICT: the claims are not deterministic negations (complementary same-subject claims classify as ADD)',
    );

    // Nothing was written: the refused decision never touches the store.
    expect(local.readCollection('candidates').entries).toHaveLength(0);
    expect(readCaptureOutboxEntry(local, entry.id)?.status).toBe('pending');
    // The cited record is untouched, and no retry was recorded either.
    expect(captureRetryCount(local, entry.id)).toBe(0);
  });

  it('the same complementary claim as ADD verifies and stages the candidate', () => {
    const rec = record({ claim: 'the service uses pnpm for installs' });
    local.upsertEntry('active', rec);
    const entry = capture({ claim: 'the service uses npm for installs' });

    const res = verify(entry, dec({ decision: 'ADD' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified.reclassifiedToNoop).toBe(false);

    const applied = applyVerifiedDecision(ctx(entry), res.verified, { env, now: () => T0 });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.candidateId === undefined) return;
    const candidateId: string = applied.candidateId;
    expect(applied.decision).toBe('ADD');
    expect(candidateId).toBe(contentIdOf(entry));
    const candidates = local.readCollection('candidates').entries as MemoryCandidate[];
    expect(candidates.map((c) => c.id)).toContain(candidateId);
    // The candidate tier's trust law is untouched: an untrusted staging entry, never a record.
    expect(local.findEntry('active', candidateId)).toBeUndefined();
  });
});

// ─── negatesClaim (the honesty boundary) ─────────────────────────────────────

describe('negatesClaim', () => {
  it('accepts a deterministic negation pair (whitespace/case-normalized, tokens stripped from both sides)', () => {
    expect(negatesClaim('the deploy cache is enabled', 'the deploy cache is not enabled')).toBe(
      true,
    );
    expect(negatesClaim('the deploy cache  is enabled', 'the deploy cache is not enabled ')).toBe(
      true,
    );
    expect(negatesClaim('caching cannot be disabled', 'caching can be disabled')).toBe(true);
    expect(negatesClaim('the build never caches', 'the build caches')).toBe(true);
  });

  it('rejects complementary claims, identical claims, and claims that strip to nothing', () => {
    expect(negatesClaim('the service uses pnpm', 'the service uses npm')).toBe(false);
    expect(negatesClaim('caching is enabled', 'caching is enabled')).toBe(false);
    expect(negatesClaim('caching is enabled', 'caching is fast')).toBe(false);
    // Both sides reduce to the empty string → nothing left to have negated.
    expect(negatesClaim('no', 'not')).toBe(false);
  });
});

// ─── the batch identity + the work item ──────────────────────────────────────

describe('distillBatchId and buildDistillWorkItem', () => {
  it('derives a wall-clock-free batch id: order-independent, content-sensitive, stable', () => {
    const a = distillBatchId(['cap:bbb', 'cap:aaa']);
    expect(a.startsWith('distill:')).toBe(true);
    expect(distillBatchId(['cap:aaa', 'cap:bbb'])).toBe(a);
    expect(distillBatchId(['cap:aaa', 'cap:bbb', 'cap:ccc'])).not.toBe(a);
    expect(distillBatchId([])).toBe(distillBatchId([]));
  });

  it('wraps a capture as an enrich-envelope-shaped work item with the same-subject context', () => {
    const rec = record({ claim: 'A.b caches its result' });
    local.upsertEntry('active', rec);
    const entry = capture({});
    const existing = sameSubjectRecords(local, entry.subject);
    const item = buildDistillWorkItem(entry, existing);

    expect(item.targetId).toBe(entry.id);
    expect(item.seed.capture).toEqual({
      id: entry.id,
      kind: entry.kind,
      subject: entry.subject,
      claim: entry.claim,
      evidenceKinds: ['source-quote'],
    });
    expect(item.seed.existing).toEqual(existing);
    expect(item.instructions.length).toBeGreaterThan(0);
    expect(item.outputSchema).toBeTruthy();
  });

  it('sameSubjectRecords matches v1 records by their derived propositionKey, sorted, capped', () => {
    const a = record({ claim: 'A.b returns 42' });
    const b = record({ claim: 'A.b is pure' });
    const other = record({ subject: 'sym:src/b.ts#B.c', claim: 'B.c returns 1' });
    local.upsertEntries('active', [b, a, other]);

    const hits = sameSubjectRecords(local, SUBJECT);
    expect(hits.map((h) => h.id)).toEqual([a.id, b.id].sort((x, y) => x.localeCompare(y)));
    for (const h of hits) {
      expect(h.propositionKey).toBe(derivePropositionKey({ subject: SUBJECT }));
    }
    expect(hits).toHaveLength(2);

    // The cap bounds the prompt, and an explicit propositionKey override wins over the derived key.
    expect(sameSubjectRecords(local, SUBJECT, 1)).toHaveLength(1);
  });
});

// ─── CONFLICT verification + application ─────────────────────────────────────

describe('CONFLICT — verified only as a deterministic negation under one propositionKey', () => {
  it('applies a true negation as an ADD candidate carrying meta.contradicts, leaving the cited record untouched', () => {
    const rec = record({ claim: 'the deploy cache is enabled' });
    local.upsertEntry('active', rec);
    const entry = capture({ claim: 'the deploy cache is not enabled' });

    const res = verify(entry, dec({ decision: 'CONFLICT', contradictsRecordId: rec.id }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const applied = applyVerifiedDecision(ctx(entry), res.verified, { env, now: () => T0 });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.candidateId === undefined) return;
    expect(applied.candidateId).toBe(contentIdOf(entry));

    // The conflict rides the candidate tier with provenance — append-only, promotion stays the gate.
    const cand = local.findEntry('candidates', applied.candidateId) as MemoryCandidate | undefined;
    expect(cand?.meta?.contradicts).toBe(rec.id);
    expect(cand?.meta?.distilledFrom).toBe(entry.id);
    // The cited record was never rewritten (no successor, no decision event).
    expect((local.findEntry('active', rec.id) as MemoryRecord).claim).toBe(rec.claim);
    expect(local.readCollection('active').entries).toHaveLength(1);
    expect(local.readCollection('decisions').entries).toHaveLength(0);

    // The outbox entry carries the auditable decision surface (the MCP outbox projection reads it).
    const done = readCaptureOutboxEntry(local, entry.id);
    expect(done?.status).toBe('done');
    expect(done?.meta?.distillDecision).toBe('CONFLICT');
    expect(done?.meta?.distillVerified).toBe(true);
    expect(done?.meta?.contradictsRecordId).toBe(rec.id);
    expect(done?.meta?.candidateId).toBe(applied.candidateId);
    expect(pendingCaptures(local)).toHaveLength(0);
  });

  it('rejects a CONFLICT whose cited record carries a different propositionKey (two facts, not a conflict)', () => {
    const rec = record({
      subject: 'sym:src/other.ts#Other.x',
      claim: 'the deploy cache is enabled',
    });
    local.upsertEntry('active', rec);
    const entry = capture({ claim: 'the deploy cache is not enabled' });

    const res = verify(entry, dec({ decision: 'CONFLICT', contradictsRecordId: rec.id }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe(
      'unsupported CONFLICT: the cited record carries a different propositionKey',
    );
  });

  it('rejects a CONFLICT whose provider-pinned propositionKey overrides the derived key away from the record', () => {
    const rec = record({ claim: 'the deploy cache is enabled' });
    local.upsertEntry('active', rec);
    const entry = capture({ claim: 'the deploy cache is not enabled' });

    const res = verify(
      entry,
      dec({
        decision: 'CONFLICT',
        contradictsRecordId: rec.id,
        propositionKey: 'topic:somewhere-else',
      }),
    );
    expect(res.ok).toBe(false);
  });

  it('rejects an uncited or unresolvable CONFLICT', () => {
    const entry = capture({ claim: 'the deploy cache is not enabled' });
    expect(verify(entry, dec({ decision: 'CONFLICT' })).ok).toBe(false);
    const res = verify(entry, dec({ decision: 'CONFLICT', contradictsRecordId: 'mem:deadbeef' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unsupported CONFLICT: no local record 'mem:deadbeef'");
  });
});

// ─── SUPERSEDE verification + application ────────────────────────────────────

describe('SUPERSEDE — applied through the portable API only with a resolvable local citation', () => {
  it('rejects an uncited SUPERSEDE and one citing a nonexistent record', () => {
    const entry = capture({ claim: 'A.b returns 43' });
    expect(verify(entry, dec({ decision: 'SUPERSEDE' })).ok).toBe(false);
    const res = verify(entry, dec({ decision: 'SUPERSEDE', supersedesRecordId: 'mem:0000' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unsupported SUPERSEDE: no local record 'mem:0000'");
  });

  it('applies a cited SUPERSEDE as a v2 successor + decision event, done LAST', () => {
    const rec = record({ claim: 'A.b returns 42' });
    local.upsertEntry('active', rec);
    const entry = capture({ claim: 'A.b returns 43' });

    const res = verify(entry, dec({ decision: 'SUPERSEDE', supersedesRecordId: rec.id }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const applied = applyVerifiedDecision(ctx(entry), res.verified, { env, now: () => T0 });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.successorId).toBeDefined();

    // The successor is a v2 record in the local active collection with forward lineage…
    const successor = local.findEntry('active', applied.successorId as string) as
      | Record<string, unknown>
      | undefined;
    expect(successor?.schemaVersion).toBe('2');
    expect(successor?.claim).toBe('A.b returns 43');
    expect((successor?.lineage as { supersedes: string[] }).supersedes).toEqual([rec.id]);
    // …plus a supersede decision event, and the original record line untouched (append-only).
    expect(local.readCollection('decisions').entries.length).toBeGreaterThan(0);
    expect((local.findEntry('active', rec.id) as MemoryRecord).claim).toBe(rec.claim);

    const done = readCaptureOutboxEntry(local, entry.id);
    expect(done?.status).toBe('done');
    expect(done?.meta?.distillDecision).toBe('SUPERSEDE');
    expect(done?.meta?.supersedesRecordId).toBe(rec.id);
  });
});

// ─── NOOP verification + application ─────────────────────────────────────────

describe('NOOP — a dedupe that must cite its duplicate AND match its claim', () => {
  it('applies a cited duplicate by writing NOTHING and marking the entry done', () => {
    const entry = capture({ claim: 'A.b returns 42' });
    const dup = {
      ...record({ claim: 'A.b returns 42' }),
    };
    local.upsertEntry('active', dup);

    const res = verify(entry, dec({ decision: 'NOOP', duplicateOfId: dup.id }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const before = JSON.stringify(local.readCollection('active').entries);
    const applied = applyVerifiedDecision(ctx(entry), res.verified, { env, now: () => T0 });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.decision).toBe('NOOP');
    expect(applied.candidateId).toBeUndefined();
    // NOOP writes nothing durable: the active collection is byte-identical.
    expect(JSON.stringify(local.readCollection('active').entries)).toBe(before);
    expect(local.readCollection('candidates').entries).toHaveLength(0);

    const done = readCaptureOutboxEntry(local, entry.id);
    expect(done?.status).toBe('done');
    expect(done?.meta?.duplicateOfId).toBe(dup.id);
    expect(pendingCaptures(local)).toHaveLength(0);
  });

  it('accepts a staged candidate as the cited duplicate too', () => {
    const entry = capture({ claim: 'A.b returns 42' });
    const input = {
      kind: 'fact' as const,
      subject: SUBJECT,
      claim: 'A.b returns 42',
      scope: SCOPE,
      appliesTo: [SUBJECT],
      evidence: [ev({})],
      authorship: { actor: 'someone-else', kind: 'agent' as const },
    };
    const dup: MemoryCandidate = {
      id: memoryCandidateId(input),
      schemaVersion: '1',
      ...input,
      origin: 'observe',
      proposedAt: T0,
    };
    local.upsertEntry('candidates', dup);

    const res = verify(entry, dec({ decision: 'NOOP', duplicateOfId: dup.id }));
    expect(res.ok).toBe(true);
  });

  it('rejects an uncited NOOP and a NOOP whose cited duplicate carries a different claim', () => {
    const entry = capture({ claim: 'A.b returns 42' });
    expect(verify(entry, dec({ decision: 'NOOP' })).ok).toBe(false);

    const other = record({ claim: 'a totally different claim' });
    local.upsertEntry('active', other);
    const res = verify(entry, dec({ decision: 'NOOP', duplicateOfId: other.id }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('unsupported NOOP: the cited entry carries a different claim');

    // …and one citing an id that resolves nowhere at all.
    const missing = verify(entry, dec({ decision: 'NOOP', duplicateOfId: 'cand:0000' }));
    expect(missing.ok).toBe(false);
  });
});

// ─── ADD reclassification (at-least-once healing) ────────────────────────────

describe('ADD reclassification and idempotent re-distill', () => {
  it('reclassifies ADD to NOOP when the staged candidate already exists', () => {
    const entry = capture({ claim: 'A.b returns 42' });
    const input = {
      kind: 'fact' as const,
      subject: SUBJECT,
      claim: 'A.b returns 42',
      scope: SCOPE,
      appliesTo: [SUBJECT],
      evidence: [ev({})],
      authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
    };
    const twin: MemoryCandidate = {
      id: memoryCandidateId(input),
      schemaVersion: '1',
      ...input,
      origin: 'observe',
      proposedAt: T0,
    };
    // The candidate's id IS the content id an ADD of this capture re-derives.
    expect(twin.id).toBe(contentIdOf(entry));
    local.upsertEntry('candidates', twin);

    const res = verify(entry, dec({ decision: 'ADD' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified.reclassifiedToNoop).toBe(true);

    const applied = applyVerifiedDecision(ctx(entry), res.verified, { env, now: () => T0 });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.decision).toBe('NOOP');
    expect(applied.reclassifiedToNoop).toBe(true);
    expect(applied.candidateId).toBeUndefined();
    expect(local.readCollection('candidates').entries).toHaveLength(1);
  });

  it('reclassifies ADD to NOOP when the promoted mem: twin exists (one seed body, two prefixes)', () => {
    const entry = capture({ claim: 'A.b returns 42' });
    const contentId = contentIdOf(entry);
    const memId = `mem:${contentId.slice(5)}`;
    // The cand↔mem shared-id contract: the v1 record of the same body IS the promoted twin.
    expect(
      memoryRecordId({
        kind: entry.kind as MemoryRecord['kind'],
        subject: entry.subject,
        claim: entry.claim,
        scope: entry.scope,
        appliesTo: entry.appliesTo,
        evidence: entry.evidence,
        authorship: entry.authorship,
      }),
    ).toBe(memId);
    local.upsertEntry('active', { ...record({ claim: entry.claim }), id: memId });

    const res = verify(entry, dec({ decision: 'ADD' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified.reclassifiedToNoop).toBe(true);
  });

  it('a re-distill of the same entry is a byte-stable no-op (same ids, same bytes)', () => {
    const entry = capture({ claim: 'A.b returns 42' });
    const first = verify(entry, dec({ decision: 'ADD' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstApply = applyVerifiedDecision(ctx(entry), first.verified, { env, now: () => T0 });
    expect(firstApply.ok).toBe(true);
    if (!firstApply.ok || firstApply.candidateId === undefined) return;
    const candidateId: string = firstApply.candidateId;
    const before = JSON.stringify(local.findEntry('candidates', candidateId));

    // Redelivery: the same pending capture re-verifies (reclassified) and re-applies.
    const second = verify(entry, dec({ decision: 'ADD' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.verified.reclassifiedToNoop).toBe(true);
    const secondApply = applyVerifiedDecision(ctx(entry), second.verified, { env, now: () => T0 });
    expect(secondApply.ok).toBe(true);
    if (!secondApply.ok) return;

    // The candidate is byte-identical (the upsert was skipped), the outbox entry still done,
    // and the cap: id never moved. The reclassified apply reports NO new candidateId — the
    // content was already there.
    expect(secondApply.candidateId).toBeUndefined();
    expect(JSON.stringify(local.findEntry('candidates', candidateId))).toBe(before);
    expect(readCaptureOutboxEntry(local, entry.id)?.status).toBe('done');
    expect(
      (local.readCollection('candidates').entries as MemoryCandidate[]).filter(
        (c) => c.id === candidateId,
      ),
    ).toHaveLength(1);
  });

  it('re-marking done is idempotent (markCaptureDone twice, one candidateId in meta)', () => {
    const entry = capture({});
    const twin = {
      id: contentIdOf(entry),
      schemaVersion: '1' as const,
      kind: entry.kind as MemoryCandidate['kind'],
      subject: entry.subject,
      claim: entry.claim,
      scope: entry.scope,
      appliesTo: entry.appliesTo,
      evidence: entry.evidence,
      authorship: entry.authorship,
      origin: 'observe' as const,
      proposedAt: T0,
    };
    local.upsertEntry('candidates', twin);
    const done = markCaptureDone(local, entry.id, { candidateId: twin.id });
    const again = markCaptureDone(local, entry.id, { candidateId: twin.id });
    expect(again?.id).toBe(done?.id);
    expect(readCaptureOutboxEntry(local, entry.id)?.meta?.candidateId).toBe(twin.id);
    expect(local.readCollection('outbox').entries).toHaveLength(1);
  });
});

// ─── per-item failures honor B's lifecycle ───────────────────────────────────

describe('failDistillItem — retries then the dead-letter transition', () => {
  it('records attempt-style appends and dead-letters at the third attempt without deleting anything', () => {
    const entry = capture({ claim: 'unverifiable capture' });

    const first = failDistillItem(local, entry, 'unsupported decision', () => T0);
    expect(first).toEqual({ attempt: 1, deadLettered: false });
    expect(captureRetryCount(local, entry.id)).toBe(1);
    expect(pendingCaptures(local).map((e) => e.id)).toContain(entry.id);

    const second = failDistillItem(local, entry, 'unsupported decision', () => T0);
    expect(second).toEqual({ attempt: 2, deadLettered: false });

    const third = failDistillItem(local, entry, 'unsupported decision', () => T0);
    expect(third).toEqual({ attempt: 3, deadLettered: true });

    // Terminal: dead WINS over outbox — the entry is readable in `dead` with its reason and gone
    // from the drain view (a transition, never a delete).
    expect(captureRetryCount(local, entry.id)).toBe(3);
    expect(pendingCaptures(local)).toHaveLength(0);
    expect(local.readCollection('outbox').entries).toHaveLength(0);
    const dead = readDeadCapture(local, entry.id);
    expect(dead?.status).toBe('dead');
    expect(dead?.meta?.deadLetterReason).toBe('unsupported decision');
    expect(dead?.id).toBe(entry.id);
  });
});

// ─── verification fails closed on malformed / policy-refused input ───────────

describe('verifyDistillDecision — shape and policy gates', () => {
  it('rejects non-objects, misaddressed targets, unknown decisions, and missing rationales', () => {
    const entry = capture({});
    const ctxp = ctx(entry);
    expect(verifyDistillDecision('nope', entry.id, ctxp).ok).toBe(false);
    expect(
      verifyDistillDecision(
        { targetId: 'cap:other', decision: dec({ decision: 'ADD' }) },
        entry.id,
        ctxp,
      ).ok,
    ).toBe(false);
    expect(verifyDistillDecision({ targetId: entry.id }, entry.id, ctxp).ok).toBe(false);
    expect(
      verifyDistillDecision(
        { targetId: entry.id, decision: { decision: 'MAYBE', rationale: 'x' } },
        entry.id,
        ctxp,
      ).ok,
    ).toBe(false);
    expect(
      verifyDistillDecision({ targetId: entry.id, decision: { decision: 'ADD' } }, entry.id, ctxp)
        .ok,
    ).toBe(false);
    expect(
      verifyDistillDecision(
        { targetId: entry.id, decision: { decision: 'ADD', rationale: '   ' } },
        entry.id,
        ctxp,
      ).ok,
    ).toBe(false);
  });

  it('never lets a secret ride the rationale into persisted meta', () => {
    const entry = capture({});
    const res = verify(entry, {
      decision: 'ADD',
      rationale: `deploy token=sk-${'a'.repeat(30)} rotated`,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('distill rationale refused: secret-credential pattern');
    // And the reason never echoes the refused content.
    expect(res.reason).not.toContain('sk-');
  });

  it('rejects non-string optional fields and unknown record kinds', () => {
    const entry = capture({});
    expect(
      verifyDistillDecision(
        { targetId: entry.id, decision: { decision: 'ADD', rationale: 'r', claim: 42 } },
        entry.id,
        ctx(entry),
      ).ok,
    ).toBe(false);
    expect(verify(entry, dec({ decision: 'ADD', kind: 'rumor' })).ok).toBe(false);
  });

  it('tightening capture policy refuses the distilled claim (kind + length axes)', () => {
    const long = capture({ claim: 'a claim far longer than ten characters for sure' });
    const lengthPolicy: CapturePolicySection = { maxClaimChars: 10 };
    expect(verify(long, dec({ decision: 'ADD' }), lengthPolicy).ok).toBe(false);

    const entry = capture({ kind: 'pitfall', claim: 'short claim' });
    const kindPolicy: CapturePolicySection = { forbiddenKinds: ['pitfall'] };
    const res = verify(entry, dec({ decision: 'ADD' }), kindPolicy);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('distilled claim refused by the capture policy');
  });

  it('a refined claim re-ids the candidate (the seed covers the claim text)', () => {
    const entry = capture({ claim: 'A.b returns 42' });
    const res = verify(entry, dec({ decision: 'ADD', claim: 'A.b returns 42 for sure' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const applied = applyVerifiedDecision(ctx(entry), res.verified, { env, now: () => T0 });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.candidateId).toBe(contentIdOf(entry, { claim: 'A.b returns 42 for sure' }));
    expect(applied.candidateId).not.toBe(contentIdOf(entry));
  });
});

// ─── hygiene ─────────────────────────────────────────────────────────────────

describe('hygiene', () => {
  it('normalizeClaim is the equality the NOOP check relies on (whitespace-collapsed, case kept)', () => {
    expect(normalizeClaim('A.b   returns  42')).toBe('A.b returns 42');
    expect(normalizeClaim('A.b returns 42')).toBe(normalizeClaim(' A.b\treturns 42 '));
  });

  it('every store stayed inside the relocated KCRIB_MEMORY_DIR — nothing touched the real ~/.crib', () => {
    expect(local.rootDir.startsWith(home)).toBe(true);
    const entry = capture({});
    const res = verify(entry, dec({ decision: 'ADD' }));
    if (res.ok) applyVerifiedDecision(ctx(entry), res.verified, { env, now: () => T0 });
    failDistillItem(local, capture({ claim: 'second' }), 'unsupported', () => T0);
    // The whole cycle wrote only under the temp home.
    expect(local.rootDir.startsWith(home)).toBe(true);
    expect(local.readCollection('candidates').entries.length).toBeGreaterThan(0);
  });
});
