/**
 * G2.2 — the durable capture outbox, exercised end-to-end through the MCP verb surface.
 *
 * The fixture mirrors verbs-memory-capture.test.ts exactly (same `src/auth.ts`, same seeding, same
 * env relocation) so the two files stay comparable clause-for-clause. What this file adds on top of
 * the capture pins:
 *   • the capture/observe acks carry a durable `outboxId` (`cap:` prefix) + `idempotent` flag —
 *     WITHOUT using the forbidden response vocabulary (no 'candidate'/'trust' words in responses);
 *   • a re-capture is a byte-stable no-op: the same `cand:` id AND the same `cap:` id, one outbox row;
 *   • a policy refusal (secret / PII / home-path / transcript) writes NEITHER the outbox row NOR the
 *     staging entry, and never echoes the refused content back;
 *   • the crash window between the durable outbox write and the staging write heals on re-capture;
 *   • the retry limit is a dead-letter TRANSITION (`dead` collection keeps the history) and the
 *     dead-lettered item leaves the drain queue and never surfaces through recall;
 *   • both verbs funnel through ONE staging path: identical content via memoryObserve and
 *     memoryCapture re-derives the same `cand:` id AND the same `cap:` id;
 *   • the durable write precedes the staging write, pinned by spying on the store's writes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import {
  type CaptureOutboxEntry,
  type MemoryCandidate,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  captureRetryCount,
  deadLetterCapture,
  pendingCaptures,
  readCaptureOutboxEntry,
  readDeadCapture,
  recordCaptureRetry,
  shouldDeadLetterCapture,
} from '@knowledge-crib/memory';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryDeps } from './verbs.js';
import { Verbs } from './verbs.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-verbs-outbox';

const loginId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.login',
  startLine: 10,
});
const loginHash = contentHash('AuthService.login');
/** The rehydrated login span, trimmed — exactly what the auto-anchor must lift as its quote. */
const LOGIN_SPAN = 'login(user, pass) {\n    return issue(user, pass);';

let repo: string;
let home: string;
let regDir: string;
let env: NodeJS.ProcessEnv;
let soul: SoulStore;
let index: SqliteIndexStore;
let local: MemoryStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-outbox-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  // lines 1-8 blank, line 9 `class AuthService {`, lines 10-11 the login body, line 12 `  }`, line 13 `}`.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
  }
}
`,
  );
  home = mkdtempSync(join(tmpdir(), 'mem-outbox-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'mem-outbox-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();

  soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  soul.putNodes([
    {
      id: idFor({ kind: 'file', path: 'src/auth.ts' }),
      kind: 'file',
      file: 'src/auth.ts',
      hash: contentHash('src/auth.ts'),
    },
    {
      id: loginId,
      kind: 'symbol',
      type: 'method',
      name: 'login',
      qualifiedName: 'AuthService.login',
      file: 'src/auth.ts',
      span: { start: 10, end: 11 },
      lang: 'typescript',
      hash: loginHash,
    },
  ]);
  soul.commit(NOW);
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: repo });
});

afterEach(() => {
  index.close();
  __resetMemoryLockGuardForTest();
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
});

function verbs(): Verbs {
  const mem: MemoryDeps = { local };
  return new Verbs({ soul, index, repoRoot: repo, memory: mem });
}

function candidates(): MemoryCandidate[] {
  return local.readCollection('candidates').entries as MemoryCandidate[];
}

function outbox(): CaptureOutboxEntry[] {
  return local.readCollection('outbox').entries as CaptureOutboxEntry[];
}

function dead(): CaptureOutboxEntry[] {
  return local.readCollection('dead').entries as CaptureOutboxEntry[];
}

const CAPTURE = {
  subject: 'topic:login-retry',
  observation: 'the login retry backoff went fine',
  actor: 'claude-code',
} as const;

describe('memoryCapture durable outbox', () => {
  it('acks a durable cap: outbox id + idempotent=false, and stages the outbox row first', () => {
    const order: string[] = [];
    const orig = local.upsertEntry.bind(local);
    vi.spyOn(local, 'upsertEntry').mockImplementation((collection, entry) => {
      order.push(collection);
      return orig(collection, entry);
    });
    const res = verbs().memoryCapture({ ...CAPTURE }) as Record<string, unknown>;
    expect(res.status).toBe('pending');
    expect((res.outboxId as string).startsWith('cap:')).toBe(true);
    expect(res.idempotent).toBe(false);
    // ordering law: the durable queue write precedes the staging write
    expect(order[0]).toBe('outbox');
    expect(order[1]).toBe('candidates');
    const entry = readCaptureOutboxEntry(local, res.outboxId as string);
    expect(entry?.status).toBe('pending');
    expect(entry?.claim).toBe(CAPTURE.observation);
    expect(entry?.authorship.actor).toBe('claude-code');
    // the queue row mirrors the staging id it produced
    expect(entry?.id).toBe(res.outboxId);
  });

  it('an identical re-capture is a byte-stable no-op (same cand: id, same cap: id, one row)', () => {
    const v = verbs();
    const a = v.memoryCapture({ ...CAPTURE }) as Record<string, unknown>;
    const entryBefore = readCaptureOutboxEntry(local, a.outboxId as string);
    const b = v.memoryCapture({ ...CAPTURE }) as Record<string, unknown>;
    expect(b.id).toBe(a.id);
    expect(b.outboxId).toBe(a.outboxId);
    expect(b.idempotent).toBe(true);
    expect(outbox()).toHaveLength(1);
    expect(JSON.stringify(readCaptureOutboxEntry(local, a.outboxId as string))).toBe(
      JSON.stringify(entryBefore),
    );
  });

  it('a policy refusal (secret / PII / home path / transcript) writes NOTHING and echoes no content', () => {
    const v = verbs();
    const cases: Array<[string, string]> = [
      ['secret', `the api key is ghp_${'a'.repeat(36)} do not share`],
      ['pii', 'ask bob@example.com to re-run the login retry'],
      ['path', 'the fix is in /Users/bob/proj/src/auth.ts'],
      ['transcript', 'user: did the retry work?\nassistant: yes'],
    ];
    for (const [axis, observation] of cases) {
      const res = v.memoryCapture({ ...CAPTURE, observation }) as Record<string, unknown>;
      expect(res.ok).toBe(false);
      expect((res.violations as Array<{ axis: string }>).map((x) => x.axis)).toContain(axis);
      // no content echo in the refusal
      expect(res.error as string).not.toContain(observation);
      // the refusal is POLICY-BEFORE-ID: neither tier ever sees the refused capture
      expect(candidates()).toHaveLength(0);
      expect(outbox()).toHaveLength(0);
      expect(dead()).toHaveLength(0);
    }
  });

  it('the crash window between the outbox write and the staging write heals on re-capture', () => {
    const v = verbs();
    const a = v.memoryCapture({ ...CAPTURE }) as Record<string, unknown>;
    // simulate the crash: the durable row survives, the staging entry never landed
    expect(local.removeEntry('candidates', a.id as string)).toBe(true);
    expect(readCaptureOutboxEntry(local, a.outboxId as string)?.status).toBe('pending');
    expect(pendingCaptures(local).map((e) => e.id)).toEqual([a.outboxId]);
    // replay the capture: both ids re-derive, the staging entry is restored, nothing duplicates
    const b = v.memoryCapture({ ...CAPTURE }) as Record<string, unknown>;
    expect(b.id).toBe(a.id);
    expect(b.outboxId).toBe(a.outboxId);
    expect(b.idempotent).toBe(true);
    expect(candidates()).toHaveLength(1);
    expect(outbox()).toHaveLength(1);
  });

  it('a retry-limit exhaust is a dead-letter TRANSITION: dead keeps the history, the queue empties', () => {
    const v = verbs();
    const res = v.memoryCapture({ ...CAPTURE }) as Record<string, unknown>;
    const capId = res.outboxId as string;
    const entry = readCaptureOutboxEntry(local, capId) as CaptureOutboxEntry;
    for (let n = 1; n <= 3; n++) recordCaptureRetry(local, entry, n, 'distiller-timeout', NOW);
    expect(captureRetryCount(local, capId)).toBe(3);
    expect(shouldDeadLetterCapture(captureRetryCount(local, capId))).toBe(true);
    expect(deadLetterCapture(local, capId, 'attempts exhausted')).toEqual({ deadLettered: true });
    // the outbox row is gone; the dead collection carries the full history
    expect(readCaptureOutboxEntry(local, capId)).toBeUndefined();
    const deadEntry = readDeadCapture(local, capId);
    expect(deadEntry?.status).toBe('dead');
    expect(deadEntry?.meta?.deadLetterReason).toBe('attempts exhausted');
    expect(pendingCaptures(local)).toHaveLength(0);
  });

  it('a dead-lettered capture never surfaces through recall — the cap: row is queue state, not a claim', () => {
    const v = verbs();
    const res = v.memoryCapture({ ...CAPTURE }) as Record<string, unknown>;
    const capId = res.outboxId as string;
    const entry = readCaptureOutboxEntry(local, capId) as CaptureOutboxEntry;
    for (let n = 1; n <= 3; n++) recordCaptureRetry(local, entry, n, 'boom', NOW);
    deadLetterCapture(local, capId, 'attempts exhausted');
    // the drain queue no longer offers it; the dead history stays readable but out of the queue
    expect(pendingCaptures(local)).toHaveLength(0);
    expect(readCaptureOutboxEntry(local, capId)).toBeUndefined();
    expect(dead().map((e) => e.id)).toEqual([capId]);
    // recall's pending group is fed by the staging tier only — no outbox/dead row ever leaks there
    const normal = v.memoryRecall({ q: 'login retry backoff' }) as Record<string, unknown>;
    expect(normal.memories).toHaveLength(0);
    expect(normal.pending).toBeUndefined();
    const withPending = v.memoryRecall({
      q: 'login retry backoff',
      includePending: true,
    }) as Record<string, unknown>;
    const pending = (withPending.pending ?? []) as Array<Record<string, unknown>>;
    for (const p of pending) expect(String(p.id)).not.toMatch(/^cap:/);
  });
});

describe('memoryObserve funnels through the same outbox', () => {
  it('observe acks outboxId + idempotent and reuses the capture lane ids for identical content', () => {
    const v = verbs();
    const captured = v.memoryCapture({
      ...CAPTURE,
      idempotencyKey: 'shared-lane',
    }) as Record<string, unknown>;
    const observed = v.memoryObserve({
      kind: 'fact',
      subject: CAPTURE.subject,
      claim: CAPTURE.observation,
      actor: CAPTURE.actor,
      idempotencyKey: 'shared-lane',
    }) as Record<string, unknown>;
    expect(observed.ok).toBe(true);
    // one staging funnel ⟹ the two verbs converge on the same staging identity
    expect(observed.id).toBe(captured.id);
    expect(observed.outboxId).toBe(captured.outboxId);
    expect(observed.idempotent).toBe(true);
    expect(candidates()).toHaveLength(1);
    expect(outbox()).toHaveLength(1);
  });

  it('observe records attempt origin/authorKind on both the staging row and the durable row', () => {
    const res = verbs().memoryObserve({
      kind: 'procedure',
      subject: 'topic:deploy',
      claim: 'run the smoke suite before each deploy',
      actor: 'claude-code',
      authorKind: 'human',
      attemptId: 'att:abc',
    }) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.origin).toBe('attempt');
    expect((res.outboxId as string).startsWith('cap:')).toBe(true);
    const [cand] = candidates();
    expect(cand?.authorship.kind).toBe('human');
    expect(cand?.attemptId).toBe('att:abc');
    const entry = readCaptureOutboxEntry(local, res.outboxId as string);
    expect(entry?.origin).toBe('attempt');
    expect(entry?.attemptId).toBe('att:abc');
  });

  it('an anchored capture grounds the auto-lifted quote in BOTH tiers (staging + durable)', () => {
    const res = verbs().memoryCapture({
      subject: 'topic:login-retry',
      observation: 'changed the login signature handling',
      symbols: ['login'],
      files: ['src/auth.ts'],
      actor: 'claude-code',
    }) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.anchorStatus).toBe('anchored');
    const entry = readCaptureOutboxEntry(local, res.outboxId as string) as CaptureOutboxEntry;
    const ev = entry?.evidence[0] as Record<string, unknown>;
    expect(ev.kind).toBe('source-quote');
    expect(ev.quote).toBe(LOGIN_SPAN);
    expect(ev.targetHash).toBe(loginHash);
    expect(entry?.appliesTo).toContain(loginId);
  });
});
