/**
 * WP7 — the ack-after-persist law: an acknowledgement is earned by a COMPLETED atomic write.
 *
 * Every store mutation funnels through `writeJsonAtomic` (temp→rename, synchronous, under
 * CribLock). A fault at the rename means the target file was never replaced — the previous bytes
 * are still the only truth — so no write lane may surface a success across it. One test per lane:
 *
 *   - the staging funnel (`MemoryApi.capture` + `observe`): the durable outbox write faults →
 *     the call THROWS (never `ok:true`), the lock is released, and BOTH the outbox and the
 *     candidates collections still read the prior valid snapshot;
 *   - `checkpointIntake`: the intakes shard write faults → the call throws, no partial ack, the
 *     prior intake history is intact;
 *   - `activateLocal`: the `active` shard write faults → the call throws, no record landed, and
 *     the candidate is NEVER cleaned up (cleanup acks a record write that did not happen).
 *
 * The fault is injected by mocking `./atomic.js` AROUND the real implementation: writes whose
 * target lives under the faulted path prefix throw (the temp file is never renamed over the
 * target — the classic mid-write crash window), every other write behaves normally.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GateProfile,
  type GateReceipt,
  MemoryApi,
  type MemoryCandidate,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemoryPolicy,
  type MemorySoulPort,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  activateLocal,
  evaluateCandidate,
  memoryCandidateId,
  policyHash,
  profileHash,
  receiptId,
} from './index.js';
import type { StableLocator } from './locator.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const REPO = 'r-ack-persist';
const HEAD = '0'.repeat(40);
const DIGEST = `blake3:${'a'.repeat(64)}`;
const SOUL_ID = 'sym:src/a.ts#A.b';
const QUOTE = 'does the thing';
const TARGET = `blake3:${'a'.repeat(64)}`;

// The fault injection: a path prefix whose atomic writes throw. Hoisted so the vi.mock factory
// (which vitest hoists above every import) can read it.
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
  home = mkdtempSync(join(tmpdir(), 'mem-ack-persist-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  fault.prefix = undefined;
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  fault.prefix = undefined; // never leak a fault into a later test
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

/** A local store + API over it (the capture-outbox fixture shape). */
function setup() {
  const local = MemoryStore.local(REPO, { env, now: () => T0 });
  const api = new MemoryApi({ stores: { local }, env, now: () => T0 });
  return { local, api };
}

// ─── the staging funnel: no ack when the atomic persist fails ────────────────

describe('ack-after-persist — the staging funnel (capture + observe)', () => {
  it('capture throws when the outbox shard persist faults — both collections keep the prior valid snapshot', () => {
    const { local, api } = setup();
    // Seed the prior valid snapshot through the normal funnel.
    const first = api.capture({
      subject: SOUL_ID,
      observation: 'A.b returns 42',
      actor: 'claude-code',
      repoId: REPO,
      idempotencyKey: 'k1',
    });
    if (!first.ok) throw new Error(first.error);
    const priorOutbox = local.readCollection('outbox').entries.map((e) => e.id);
    const priorCandidates = local.readCollection('candidates').entries.map((e) => e.id);

    // The FIRST durable write of the funnel faults: the outbox shard is never replaced.
    fault.prefix = join(local.rootDir, 'outbox');
    expect(() =>
      api.capture({
        subject: SOUL_ID,
        observation: 'A.b returns 43',
        actor: 'claude-code',
        repoId: REPO,
        idempotencyKey: 'k2',
      }),
    ).toThrow(/simulated persist fault/); // a fault mid-write NEVER returns ok:true

    // The faulted rename left the old files in place: both collections read the prior snapshot.
    expect(local.readCollection('outbox').entries.map((e) => e.id)).toEqual(priorOutbox);
    expect(local.readCollection('candidates').entries.map((e) => e.id)).toEqual(priorCandidates);

    // The lock was released and nothing half-landed: once the fault heals, a retry succeeds and
    // derives exactly the ids of the failed attempt (the designed at-least-once recovery).
    fault.prefix = undefined;
    const retry = api.capture({
      subject: SOUL_ID,
      observation: 'A.b returns 43',
      actor: 'claude-code',
      repoId: REPO,
      idempotencyKey: 'k2',
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const outboxIds = local.readCollection('outbox').entries.map((e) => e.id);
    expect(outboxIds).toHaveLength(2);
    expect(outboxIds).toContain(retry.outboxId);
    expect(local.readCollection('candidates').entries.map((e) => e.id)).toContain(retry.id);
  });

  it('observe funnels through the same persist gate — a faulted write throws, never ok:true', () => {
    const { local, api } = setup();
    fault.prefix = join(local.rootDir, 'outbox');
    expect(() =>
      api.observe({
        kind: 'fact',
        subject: SOUL_ID,
        claim: 'A.b returns 42',
        actor: 'claude-code',
        repoId: REPO,
      }),
    ).toThrow(/simulated persist fault/);
    // Neither write of the funnel landed — no queue row, no staging entry, no ack.
    expect(local.readCollection('outbox').entries).toHaveLength(0);
    expect(local.readCollection('candidates').entries).toHaveLength(0);
  });
});

// ─── checkpointIntake: no ack when the intakes shard persist fails ────────────

describe('ack-after-persist — checkpointIntake', () => {
  it('throws when the intakes shard persist faults — the prior history is intact, no partial ack', () => {
    const { local, api } = setup();
    const requirement = api.createIntake({
      namespace: { principalId: 'principal:local', projectId: REPO },
      original: 'Continue the hardening work',
      interpretation: {
        outcome: 'Finish the persistence tests',
        scope: ['packages/memory'],
        constraints: [],
        acceptanceCriteria: ['Faults never ack'],
      },
      sensitivity: 'internal',
      retentionPolicyId: 'default',
      provenance: {
        principalId: 'principal:local',
        deviceId: 'device-1',
        actorId: 'actor-1',
        clientId: 'codex',
      },
      createdAt: T0,
    });
    const prior = local.readCollection('intakes').entries.map((e) => e.id);

    fault.prefix = join(local.rootDir, 'intakes');
    expect(() =>
      api.checkpointIntake({
        intakeId: requirement.id,
        kind: 'progress',
        phase: 'executing',
        nextSafeAction: 'Run tests',
        summary: 'Started',
        repository: { dirty: false },
        actor: 'codex',
        recordedAt: T1,
      }),
    ).toThrow(/simulated persist fault/);

    // The checkpoint never replaced the shard: the intake history is exactly what it was.
    expect(local.readCollection('intakes').entries.map((e) => e.id)).toEqual(prior);
  });
});

// ─── activateLocal: no ack when the active shard persist fails ────────────────

describe('ack-after-persist — activateLocal', () => {
  it('throws when the active shard persist faults — no record lands and the candidate is never cleaned up', () => {
    const { local } = setup();
    const c = candidate();
    local.upsertEntry('candidates', c);
    const evaluation = evaluate(c);
    const receipt = gateReceipt();

    fault.prefix = join(local.rootDir, 'active');
    expect(() => activateLocal(local, c, evaluation, receipt)).toThrow(/simulated persist fault/);

    // The durable-result-first funnel stopped at its FIRST write: no record landed…
    expect(local.readCollection('active').entries).toHaveLength(0);
    expect(local.readCollection('receipts').entries.map((e) => e.id)).not.toContain(receipt.id);
    // …and cleanup never acked a write that did not happen — the candidate is still there.
    expect(local.readCollection('candidates').entries.map((e) => e.id)).toEqual([c.id]);
  });
});

// ─── fixtures (the promotion.test.ts shapes, trimmed to what activation needs) ─

function fakeSoul(): MemorySoulPort {
  const n: Node = {
    id: SOUL_ID,
    kind: 'symbol',
    name: 'b',
    file: 'src/a.ts',
    span: { start: 1, end: 100 },
    hash: TARGET,
  } as Node;
  return {
    getNode: (id) => (id === SOUL_ID ? n : undefined),
    rehydrate: (node) => ({
      text: node.id === SOUL_ID ? QUOTE : '',
      truncated: false,
      totalLines: 1,
      startLine: 1,
    }),
    findByLocator: (_locator: StableLocator) => [],
  };
}

function profile(partial: Partial<GateProfile> = {}): GateProfile {
  return {
    name: 'test',
    executable: 'node',
    args: ['--version'],
    timeoutMs: 5000,
    permittedEnv: ['PATH'],
    successExitCodes: [0],
    assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }],
    ...partial,
  };
}

function gateReceipt(): GateReceipt {
  const pol: MemoryPolicy = { version: 1, profiles: { test: profile() } };
  const prof = pol.profiles.test!;
  const r = {
    policyHash: policyHash(pol),
    profileHash: profileHash(prof),
    executable: '/usr/bin/node',
    args: prof.args,
    head: HEAD,
    worktreeDigest: DIGEST,
    exitCode: 0,
    outputDigest: `blake3:${'b'.repeat(64)}`,
    assertions: [{ name: 'exit-ok', passed: true }],
    runner: 'ci' as const,
  };
  return {
    id: receiptId(r),
    schemaVersion: '1',
    ...r,
    durationMs: 0,
    ts: T0,
  };
}

function sourceQuoteEvidence(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId: SOUL_ID,
    quote: QUOTE,
    targetHash: TARGET,
  };
}

function candidate(): MemoryCandidate {
  const input = {
    kind: 'fact' as const,
    subject: SOUL_ID,
    claim: 'A.b does the thing',
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [SOUL_ID],
    evidence: [sourceQuoteEvidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryCandidateId(input),
    schemaVersion: '1',
    ...input,
    origin: 'observe',
    proposedAt: T0,
  };
}

function evaluate(cand: MemoryCandidate) {
  const evaluator = new MemoryEvaluator();
  return evaluateCandidate(cand, {
    evaluator,
    soul: fakeSoul(),
    receipt: gateReceipt(),
    now: () => T0,
  });
}
