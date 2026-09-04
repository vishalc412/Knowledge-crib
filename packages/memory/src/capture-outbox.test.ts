/**
 * G2.2 — the durable capture outbox. One test per contract clause:
 *
 *   - `captureEntryId`: content-addressed over the FROZEN semantic seed only (idempotency key +
 *     session/event offsets + kind + subject + normalized claim + actor); timestamps, status, and
 *     meta are excluded, so a re-capture re-derives the same `cap:` id and a status transition
 *     happens in place without the id moving;
 *   - `checkCapturePolicy`: PURE — the always-on hygiene axes (secrets / PII / paths / transcripts)
 *     bind with NO policy at all, the tightening axes only bind when the policy sets them, and no
 *     violation reason ever echoes the refused content;
 *   - the additive policy `capture` section: validated when present, absent without one;
 *   - the unified staging funnel (MemoryApi): policy BEFORE id, outbox BEFORE staging entry;
 *   - crash windows: a lost staging write heals via re-capture; `dead` wins over `outbox`;
 *   - retries: attempt-style appends with the attempt count inside the id seed; the limit is a
 *     dead-letter TRANSITION to the `dead` collection — never a delete;
 *   - manifest counts: the machine-local queue collections are claim-count-invisible (the manifest
 *     schema's `counts` object is closed).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAPTURE_MAX_CLAIM_CHARS,
  MemoryApi,
  type MemoryCandidate,
  type MemoryScope,
  MemoryStore,
  PolicyError,
  __resetMemoryLockGuardForTest,
  assertValidPolicy,
  buildCaptureOutboxEntry,
  captureEntryId,
  captureRetries,
  captureRetryCount,
  checkCapturePolicy,
  deadLetterCapture,
  loadPolicy,
  markCaptureDone,
  memoryCandidateId,
  pendingCaptures,
  readCaptureOutboxEntry,
  readDeadCapture,
  recordCaptureRetry,
  shouldDeadLetterCapture,
  stageCaptureOutboxEntry,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const REPO = 'r-cap-outbox';
const SUBJECT = 'sym:src/a.ts#A.b';
const SCOPE: MemoryScope = { boundary: 'repo', repoId: REPO };

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-cap-outbox-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

// ─── the cap: id (the FROZEN seed) ────────────────────────────────────────────

describe('captureEntryId', () => {
  it('is derived from the semantic seed only — same content, different claim whitespace, same id', () => {
    const a = captureEntryId({
      idempotencyKey: 'k1',
      kind: 'fact',
      subject: SUBJECT,
      claim: '  A.b   returns 42  ',
      actor: 'claude-code',
    });
    const b = captureEntryId({
      idempotencyKey: 'k1',
      kind: 'fact',
      subject: SUBJECT,
      claim: 'A.b returns 42',
      actor: 'claude-code',
    });
    expect(a).toBe(b);
    expect(a.startsWith('cap:')).toBe(true);
  });

  it('different keys, offsets, claim content, or actor re-id the entry (the seed covers them)', () => {
    const base = {
      idempotencyKey: 'k1',
      sessionId: 's1',
      sessionOffset: 1,
      eventOffset: 2,
      kind: 'fact',
      subject: SUBJECT,
      claim: 'A.b returns 42',
      actor: 'claude-code',
    };
    const id = captureEntryId(base);
    expect(captureEntryId({ ...base, idempotencyKey: 'k2' })).not.toBe(id);
    expect(captureEntryId({ ...base, sessionOffset: 2 })).not.toBe(id);
    expect(captureEntryId({ ...base, eventOffset: 3 })).not.toBe(id);
    expect(captureEntryId({ ...base, sessionId: 's2' })).not.toBe(id);
    expect(captureEntryId({ ...base, claim: 'A.b returns 43' })).not.toBe(id);
    expect(captureEntryId({ ...base, actor: 'codex' })).not.toBe(id);
  });

  it('a status transition does not move the id (status is not in the seed)', () => {
    const entry = buildCaptureOutboxEntry(
      {
        kind: 'fact',
        subject: SUBJECT,
        claim: 'A.b returns 42',
        scope: SCOPE,
        appliesTo: [],
        evidence: [],
        authorship: { actor: 'claude-code', kind: 'agent' },
        origin: 'observe',
        idempotencyKey: 'k1',
      },
      T0,
    );
    expect(entry.status).toBe('pending');
    expect(entry.id.startsWith('cap:')).toBe(true);
    expect({ ...entry, status: 'done' as const }.id).toBe(entry.id);
  });
});

// ─── the capture-policy gate (PURE) ──────────────────────────────────────────

describe('checkCapturePolicy', () => {
  const base = {
    kind: 'fact',
    subject: 'topic:x',
    claim: 'the thing works',
    boundary: 'repo' as const,
  };

  it('passes a clean capture with no policy at all', () => {
    expect(checkCapturePolicy(base)).toEqual({ ok: true });
  });

  it('refuses secrets, PII, home-tree paths, and transcripts WITHOUT any policy (always on)', () => {
    const cases: Array<[string, string]> = [
      ['secret', `token=sk-${'a'.repeat(30)}`],
      ['secret', `ghp_${'a'.repeat(36)}`],
      ['pii', 'contact bob@example.com about the fix'],
      ['path', 'the file lives at /Users/bob/secrets/app.ts'],
      ['path', 'check ~/.ssh/config for the host'],
      ['transcript', 'user: what happened?\nassistant: the build broke'],
    ];
    for (const [axis, claim] of cases) {
      const res = checkCapturePolicy({ ...base, claim });
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.violations.map((v) => v.axis)).toContain(axis);
    }
  });

  it('keeps repo-relative paths clean (the structural-skip posture for provenance refs)', () => {
    expect(checkCapturePolicy({ ...base, claim: 'the fix landed in src/auth.ts' })).toEqual({
      ok: true,
    });
  });

  it('never echoes the refused content back in a violation reason', () => {
    const res = checkCapturePolicy({ ...base, claim: `token=sk-${'a'.repeat(30)}` });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    for (const v of res.violations) expect(v.reason).not.toContain('sk-');
  });

  it('the tightening axes bind ONLY when the policy sets them (defaulted-open)', () => {
    const long = checkCapturePolicy({
      ...base,
      claim: 'x'.repeat(DEFAULT_CAPTURE_MAX_CLAIM_CHARS + 1),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.violations.map((v) => v.axis)).toEqual(['length']);
    // no policy: every record kind and both scope boundaries stay legal (the W4 posture)
    expect(checkCapturePolicy({ ...base, kind: 'decision' })).toEqual({ ok: true });
    expect(checkCapturePolicy({ ...base, boundary: 'global' })).toEqual({ ok: true });
  });

  it('the policy can tighten: maxClaimChars, forbiddenKinds, allowedScopeBoundaries', () => {
    const policy = {
      maxClaimChars: 10,
      forbiddenKinds: ['decision'],
      allowedScopeBoundaries: ['repo'],
    };
    const long = checkCapturePolicy({ ...base, claim: 'x'.repeat(11) }, policy);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.violations.map((v) => v.axis)).toEqual(['length']);
    const short = { ...base, claim: 'a b c' }; // within maxClaimChars: only the target axis fires
    expect(checkCapturePolicy({ ...short, kind: 'decision' }, policy)).toEqual({
      ok: false,
      violations: [
        { axis: 'kind', reason: "refused: kind 'decision' is forbidden by the capture policy" },
      ],
    });
    expect(checkCapturePolicy({ ...short, boundary: 'global' }, policy)).toEqual({
      ok: false,
      violations: [
        {
          axis: 'scope',
          reason: "refused: scope boundary 'global' is not allowed by the capture policy",
        },
      ],
    });
  });
});

describe('capture policy section validation', () => {
  it('assertValidPolicy accepts the additive capture section (no version bump)', () => {
    assertValidPolicy({
      version: 1,
      profiles: {},
      capture: {
        maxClaimChars: 100,
        forbiddenKinds: ['decision'],
        allowedScopeBoundaries: ['repo'],
      },
    });
  });

  it('assertValidPolicy rejects malformed capture sections', () => {
    expect(() =>
      assertValidPolicy({ version: 1, profiles: {}, capture: { maxClaimChars: -1 } }),
    ).toThrow(PolicyError);
    expect(() =>
      assertValidPolicy({ version: 1, profiles: {}, capture: { forbiddenKinds: [1] } }),
    ).toThrow(PolicyError);
    expect(() =>
      assertValidPolicy({
        version: 1,
        profiles: {},
        capture: { allowedScopeBoundaries: ['galaxy'] },
      }),
    ).toThrow(PolicyError);
    expect(() => assertValidPolicy({ version: 1, profiles: {}, capture: 'nope' })).toThrow(
      PolicyError,
    );
  });

  it('loadPolicy returns undefined without a policy file; a corrupt file throws (fail closed upstream)', () => {
    const crib = mkdtempSync(join(tmpdir(), 'mem-cap-policy-'));
    try {
      expect(loadPolicy(crib)).toBeUndefined(); // absent → the documented defaulted-open posture
      mkdirSync(join(crib, 'memory'), { recursive: true });
      writeFileSync(join(crib, 'memory', 'policy.json'), '{ not json');
      expect(() => loadPolicy(crib)).toThrow(PolicyError);
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });
});

// ─── the outbox mechanics ────────────────────────────────────────────────────

function entryFor(
  claim: string,
  idempotencyKey = 'k1',
): ReturnType<typeof buildCaptureOutboxEntry> {
  return buildCaptureOutboxEntry(
    {
      kind: 'fact',
      subject: SUBJECT,
      claim,
      scope: SCOPE,
      appliesTo: [],
      evidence: [],
      authorship: { actor: 'claude-code', kind: 'agent' },
      origin: 'observe',
      idempotencyKey,
    },
    T0,
  );
}

describe('outbox mechanics', () => {
  it('stageCaptureOutboxEntry: a re-derive of pending is idempotent; a TERMINAL entry is never clobbered', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const entry = entryFor('A.b returns 42');
    expect(stageCaptureOutboxEntry(local, entry)).toEqual({
      id: entry.id,
      idempotent: false,
      status: 'pending',
    });
    expect(stageCaptureOutboxEntry(local, entry)).toEqual({
      id: entry.id,
      idempotent: true,
      status: 'pending',
    });
    // finish it, then try to re-derive: the terminal state holds (a drain racing a re-capture
    // cannot rewind a completed capture back into the queue)
    markCaptureDone(local, entry.id);
    expect(stageCaptureOutboxEntry(local, entry).status).toBe('done');
    expect(pendingCaptures(local)).toHaveLength(0);
  });

  it('markCaptureDone is idempotent and stamps the drain result; a done entry is no longer work', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const entry = entryFor('A.b returns 42');
    stageCaptureOutboxEntry(local, entry);
    const done = markCaptureDone(local, entry.id, { candidateId: 'cand:abc' });
    expect(done?.status).toBe('done');
    expect(done?.meta?.candidateId).toBe('cand:abc');
    expect(markCaptureDone(local, entry.id)?.status).toBe('done'); // idempotent
    expect(pendingCaptures(local)).toHaveLength(0);
  });

  it('retries are attempt-style appends with the count in the seed — distinct attempts never collide', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const entry = entryFor('A.b returns 42');
    stageCaptureOutboxEntry(local, entry);
    recordCaptureRetry(local, entry, 1, 'distiller-timeout', T0);
    recordCaptureRetry(local, entry, 2, 'distiller-timeout', T0);
    recordCaptureRetry(local, entry, 3, 'distiller-timeout', T0);
    expect(captureRetryCount(local, entry.id)).toBe(3);
    expect(captureRetries(local, entry.id).map((e) => e.outcome?.attempt)).toEqual([1, 2, 3]);
    // the entry itself is untouched by a retry (a retry is not a terminal transition)
    expect(readCaptureOutboxEntry(local, entry.id)?.status).toBe('pending');
    expect(pendingCaptures(local)).toHaveLength(1); // still work
  });

  it('retry limit is a dead-letter LIFECYCLE TRANSITION: dead entry first, outbox removal second', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const entry = entryFor('A.b returns 42');
    stageCaptureOutboxEntry(local, entry);
    for (let n = 1; n <= 3; n++) recordCaptureRetry(local, entry, n, 'boom', T0);
    expect(shouldDeadLetterCapture(captureRetryCount(local, entry.id))).toBe(true);
    expect(deadLetterCapture(local, entry.id, 'attempts exhausted')).toEqual({
      deadLettered: true,
    });
    expect(readCaptureOutboxEntry(local, entry.id)).toBeUndefined();
    const dead = readDeadCapture(local, entry.id);
    expect(dead?.status).toBe('dead');
    expect(dead?.meta?.deadLetterReason).toBe('attempts exhausted');
    expect(pendingCaptures(local)).toHaveLength(0);
    // idempotent: a crash between the two writes heals on the next call
    expect(deadLetterCapture(local, entry.id, 'attempts exhausted').deadLettered).toBe(true);
  });

  it('pendingCaptures lets DEAD win over OUTBOX (the crash window between the two writes)', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const a = entryFor('A.b returns 42', 'k-a');
    const b = entryFor('A.b returns 43', 'k-b');
    stageCaptureOutboxEntry(local, a);
    stageCaptureOutboxEntry(local, b);
    // dead-letter a but simulate the crash AFTER the dead write and BEFORE the outbox removal
    local.upsertEntry('dead', { ...a, status: 'dead', meta: { deadLetterReason: 'boom' } });
    expect(pendingCaptures(local).map((e) => e.id)).toEqual([b.id]);
    // deterministic drain order (sorted by id), not insertion order
    expect(pendingCaptures(local)[0]?.id).toBe(b.id);
  });

  it('outbox + dead entries never inflate the manifest claim counts (closed counts object)', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    stageCaptureOutboxEntry(local, entryFor('A.b returns 42'));
    local.upsertEntry('dead', { ...entryFor('A.b returns 43'), status: 'dead' as const });
    const cand: MemoryCandidate = {
      id: memoryCandidateId({
        kind: 'fact',
        subject: SUBJECT,
        claim: 'A.b returns 42',
        scope: SCOPE,
        appliesTo: [],
        evidence: [],
        authorship: { actor: 'claude-code', kind: 'agent' },
      }),
      schemaVersion: '1',
      kind: 'fact',
      subject: SUBJECT,
      claim: 'A.b returns 42',
      scope: SCOPE,
      appliesTo: [],
      evidence: [],
      authorship: { actor: 'claude-code', kind: 'agent' },
      origin: 'observe',
      proposedAt: T0,
    };
    local.upsertEntry('candidates', cand);
    const counts = local.recomputeCounts();
    expect(counts.candidates).toBe(1); // the claim count — NOT inflated by the queue rows
    expect(Object.keys(counts).sort()).toEqual([
      'attempts',
      'candidates',
      'decisions',
      'feedback',
      'receipts',
      'records',
    ]);
    local.persistManifest();
    expect(local.readManifest()?.counts.candidates).toBe(1);
  });
});

// ─── the unified staging funnel (api-level) ──────────────────────────────────

describe('capture funnel (MemoryApi)', () => {
  it('writes the durable outbox entry BEFORE the staging entry, under one lock hold', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const api = new MemoryApi({ stores: { local }, env, now: () => T0 });
    const order: string[] = [];
    const orig = local.upsertEntry.bind(local);
    vi.spyOn(local, 'upsertEntry').mockImplementation((collection, entry) => {
      order.push(collection);
      return orig(collection, entry);
    });
    const res = api.capture({
      subject: SUBJECT,
      observation: 'A.b returns 42',
      actor: 'claude-code',
      repoId: REPO,
      idempotencyKey: 'k1',
      sessionId: 's1',
      sessionOffset: 1,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(order[0]).toBe('outbox');
    expect(order[1]).toBe('candidates');
    expect(res.outboxId.startsWith('cap:')).toBe(true);
    expect(res.idempotent).toBe(false);
    const entry = readCaptureOutboxEntry(local, res.outboxId);
    expect(entry?.status).toBe('pending');
    expect(entry?.claim).toBe('A.b returns 42');
    expect(entry?.idempotencyKey).toBe('k1');
    expect(entry?.sessionOffset).toBe(1);
    expect(entry?.sessionId).toBe('s1');
  });

  it('a policy refusal writes NOTHING (neither outbox nor staging entry) and reports typed violations', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const api = new MemoryApi({ stores: { local }, env, now: () => T0 });
    const res = api.capture({
      subject: SUBJECT,
      observation: `the token is token=sk-${'a'.repeat(30)}`,
      actor: 'claude-code',
      repoId: REPO,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.violations?.map((v) => v.axis)).toContain('secret');
    expect(res.error).not.toContain('sk-');
    expect(local.readCollection('candidates').entries).toHaveLength(0);
    expect(local.readCollection('outbox').entries).toHaveLength(0);
    expect(local.readCollection('dead').entries).toHaveLength(0);
  });

  it('the observe lane funnels through the SAME staging path (same cap: + cand: ids as capture)', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const api = new MemoryApi({ stores: { local }, env, now: () => T0 });
    const captured = api.capture({
      subject: SUBJECT,
      observation: 'A.b returns 42',
      actor: 'claude-code',
      repoId: REPO,
      idempotencyKey: 'shared',
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const observed = api.observe({
      kind: 'fact',
      subject: SUBJECT,
      claim: 'A.b returns 42',
      actor: 'claude-code',
      repoId: REPO,
      idempotencyKey: 'shared',
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    // one funnel ⟹ identical staging identity across lanes
    expect(observed.id).toBe(captured.id);
    expect(observed.outboxId).toBe(captured.outboxId);
    expect(local.readCollection('outbox').entries).toHaveLength(1);
    expect(local.readCollection('candidates').entries).toHaveLength(1);
    expect(observed.idempotent).toBe(true);
  });

  it('observe keeps the W4 contract (origin attempt, authorKind, evidence) plus the outbox ack', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const api = new MemoryApi({ stores: { local }, env, now: () => T0 });
    const res = api.observe({
      kind: 'procedure',
      subject: 'topic:x',
      claim: 'run the tests before shipping',
      actor: 'claude-code',
      authorKind: 'human',
      tool: 'reviewer',
      repoId: REPO,
      attemptId: 'att:abc',
      evidence: [
        {
          kind: 'source-quote',
          verdict: 'valid',
          checkedAt: T0,
          soulId: 'sym:x',
          quote: 'run the tests',
          targetHash: 'h1',
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.origin).toBe('attempt');
    expect(res.outboxId.startsWith('cap:')).toBe(true);
    const cand = local.readCollection('candidates').entries[0] as MemoryCandidate;
    expect(cand.authorship.kind).toBe('human');
    expect(cand.authorship.tool).toBe('reviewer');
    expect(cand.attemptId).toBe('att:abc');
    const entry = readCaptureOutboxEntry(local, res.outboxId);
    expect(entry?.origin).toBe('attempt');
    expect(entry?.attemptId).toBe('att:abc');
  });

  it('an injected policy tightens capture (forbiddenKinds / boundaries) without touching policy.json', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      capturePolicy: { forbiddenKinds: ['decision'], allowedScopeBoundaries: ['repo'] },
    });
    const badKind = api.capture({
      subject: SUBJECT,
      observation: 'decided the thing',
      kind: 'decision',
      actor: 'claude-code',
      repoId: REPO,
    });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.violations?.map((v) => v.axis)).toEqual(['kind']);
    const badScope = api.observe({
      kind: 'fact',
      subject: 'topic:x',
      claim: 'a global convention',
      actor: 'claude-code',
      scopeBoundary: 'global',
    });
    expect(badScope.ok).toBe(false);
    if (!badScope.ok) expect(badScope.violations?.map((v) => v.axis)).toEqual(['scope']);
    expect(local.readCollection('outbox').entries).toHaveLength(0);
    expect(local.readCollection('candidates').entries).toHaveLength(0);
  });

  it('a corrupt committed policy fails the capture CLOSED (typed refusal, nothing written)', () => {
    const crib = mkdtempSync(join(tmpdir(), 'mem-cap-corrupt-'));
    try {
      mkdirSync(join(crib, 'memory'), { recursive: true });
      writeFileSync(join(crib, 'memory', 'policy.json'), 'not json at all');
      const local = MemoryStore.local(REPO, { env, now: () => T0 });
      const api = new MemoryApi({ stores: { local }, env, now: () => T0, cribDir: crib });
      const res = api.capture({
        subject: SUBJECT,
        observation: 'A.b returns 42',
        actor: 'claude-code',
        repoId: REPO,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('fail closed');
      expect(local.readCollection('candidates').entries).toHaveLength(0);
      expect(local.readCollection('outbox').entries).toHaveLength(0);
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });

  it('the crash window between the outbox write and the staging write heals on re-capture (same ids)', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const api = new MemoryApi({ stores: { local }, env, now: () => T0 });
    const first = api.capture({
      subject: SUBJECT,
      observation: 'A.b returns 42',
      actor: 'claude-code',
      repoId: REPO,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // simulate the crash: the durable outbox entry survives, the staging entry never landed
    expect(local.removeEntry('candidates', first.id)).toBe(true);
    expect(readCaptureOutboxEntry(local, first.outboxId)?.status).toBe('pending');
    expect(pendingCaptures(local).map((e) => e.id)).toEqual([first.outboxId]);
    // replay: the re-capture re-derives BOTH ids and restores the staging entry
    const second = api.capture({
      subject: SUBJECT,
      observation: 'A.b returns 42',
      actor: 'claude-code',
      repoId: REPO,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.id).toBe(first.id);
    expect(second.outboxId).toBe(first.outboxId);
    expect(second.idempotent).toBe(true);
    expect(local.readCollection('candidates').entries).toHaveLength(1);
  });

  it('a dialogue-shaped claim is refused BEFORE anything is written (StructuredSummary-only law)', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const api = new MemoryApi({ stores: { local }, env, now: () => T0 });
    const res = api.observe({
      kind: 'fact',
      subject: 'topic:x',
      claim: 'user: fix it\nassistant: ok I ran the tests',
      actor: 'claude-code',
      repoId: REPO,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations?.map((v) => v.axis)).toContain('transcript');
    expect(local.readCollection('outbox').entries).toHaveLength(0);
  });
});
