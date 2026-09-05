/**
 * R03 (docs/audits/2026-09-05/post-merge-reaudit.md) — durable intakes are subject to the SAME
 * principal boundary as memory records.
 *
 * An earlier repair gave versioned records a principal guard at the gather point
 * (`acceptsRecord`). Intakes were left out, and `intakeEntries()` merged every entry from every
 * store with no principal or audience policy. Because `getIntake`, `listIntakes`, `handoff` and
 * `checkpointIntake` all funnel through that one merge, the audit found principal A could read
 * principal B's `private` intake, see it in a listing, receive it in handoff, and APPEND a
 * checkpoint to it.
 *
 * Isolation tests are only half the contract: a guard that denies everything would pass them and
 * destroy the product. Every denial below is paired with the access that must still work — the
 * owner reading their own intake, and a deliberately team-shared intake reaching a colleague.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryApi } from './api.js';
import { MemoryStore } from './store.js';

const OWNER = 'principal:B';
const STRANGER = 'principal:A';
const AT = '2026-09-05T00:00:00.000Z';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-r03-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envFor(principal: string): NodeJS.ProcessEnv {
  return { ...process.env, KCRIB_MEMORY_DIR: dir, KCRIB_PRINCIPAL_ID: principal };
}

/** Create one private intake owned by `OWNER`, with a private progress checkpoint on it. */
function seedPrivateIntake(store: MemoryStore, repoId: string) {
  const owner = new MemoryApi({ stores: { local: store }, env: envFor(OWNER) });
  const requirement = owner.createIntake({
    namespace: { principalId: OWNER, projectId: repoId },
    original: 'Private task belonging to principal B',
    interpretation: {
      outcome: 'Complete the private task',
      scope: [],
      constraints: [],
      acceptanceCriteria: [],
    },
    sensitivity: 'internal',
    retentionPolicyId: 'default',
    provenance: {
      principalId: OWNER,
      deviceId: 'fixture',
      actorId: 'fixture',
      clientId: 'fixture',
    },
    createdAt: AT,
  });
  owner.checkpointIntake({
    intakeId: requirement.id,
    kind: 'progress',
    phase: 'executing',
    nextSafeAction: 'Resume the private task',
    summary: 'Private checkpoint',
    audience: 'private',
    repository: { dirty: false },
    actor: OWNER,
    recordedAt: '2026-09-05T00:01:00.000Z',
  });
  return { owner, requirement };
}

describe('durable intake principal isolation (R03)', () => {
  it('denies a foreign principal read, list, handoff AND append on a private intake', ({
    task,
  }) => {
    const repoId = `r03-${task.id}`;
    const store = MemoryStore.local(repoId, { env: envFor(OWNER) });
    const { requirement } = seedPrivateIntake(store, repoId);

    // The same store, a different caller identity — the audited configuration exactly.
    const stranger = new MemoryApi({ stores: { local: store }, env: envFor(STRANGER) });

    expect(stranger.getIntake(requirement.id)).toBeUndefined();
    expect(stranger.listIntakes().choices.some((c) => c.intakeId === requirement.id)).toBe(false);
    expect(stranger.handoff().intakes.choices.some((c) => c.intakeId === requirement.id)).toBe(
      false,
    );
    // The mutation path is the one that mattered most: the audit's foreign caller successfully
    // appended a checkpoint to another principal's private continuation.
    expect(() =>
      stranger.checkpointIntake({
        intakeId: requirement.id,
        kind: 'progress',
        phase: 'executing',
        nextSafeAction: 'Foreign-authored action',
        summary: 'Foreign caller modified a private continuation',
        audience: 'private',
        repository: { dirty: false },
        actor: STRANGER,
        recordedAt: '2026-09-05T00:02:00.000Z',
      }),
    ).toThrow(/unknown intake/);
  });

  it('leaks no checkpoint detail even though checkpoints carry no principal of their own', ({
    task,
  }) => {
    const repoId = `r03-cp-${task.id}`;
    const store = MemoryStore.local(repoId, { env: envFor(OWNER) });
    const { requirement } = seedPrivateIntake(store, repoId);
    const stranger = new MemoryApi({ stores: { local: store }, env: envFor(STRANGER) });

    // A checkpoint's summary/nextSafeAction describe the private work as directly as the
    // requirement does, so hiding the requirement while surfacing its events would be no fix.
    const handoff = stranger.handoff();
    const serialized = JSON.stringify(handoff);
    expect(serialized).not.toContain('Resume the private task');
    expect(serialized).not.toContain('Private checkpoint');
    expect(serialized).not.toContain(requirement.id);
  });

  it('still lets the OWNER read, list, resume and append', ({ task }) => {
    const repoId = `r03-owner-${task.id}`;
    const store = MemoryStore.local(repoId, { env: envFor(OWNER) });
    const { owner, requirement } = seedPrivateIntake(store, repoId);

    const history = owner.getIntake(requirement.id);
    expect(history?.requirement.id).toBe(requirement.id);
    expect(history?.checkpoints).toHaveLength(1);
    expect(owner.listIntakes().choices.some((c) => c.intakeId === requirement.id)).toBe(true);
    expect(owner.handoff().intakes.choices.some((c) => c.intakeId === requirement.id)).toBe(true);
    expect(() =>
      owner.checkpointIntake({
        intakeId: requirement.id,
        kind: 'progress',
        phase: 'executing',
        nextSafeAction: 'Keep going',
        summary: 'Owner checkpoint',
        audience: 'private',
        repository: { dirty: false },
        actor: OWNER,
        recordedAt: '2026-09-05T00:03:00.000Z',
      }),
    ).not.toThrow();
  });

  it('DOES share with a colleague once the owner deliberately shares to the team', ({ task }) => {
    const repoId = `r03-team-${task.id}`;
    const local = MemoryStore.local(repoId, { env: envFor(OWNER) });
    const team = MemoryStore.team(join(dir, 'teamrepo'), { env: envFor(OWNER) });
    const ownerApi = new MemoryApi({ stores: { local, team }, env: envFor(OWNER) });
    const requirement = ownerApi.createIntake({
      namespace: { principalId: OWNER, projectId: repoId },
      original: 'Task that will be shared with the team',
      interpretation: {
        outcome: 'Ship the shared task',
        scope: [],
        constraints: [],
        acceptanceCriteria: [],
      },
      sensitivity: 'internal',
      retentionPolicyId: 'default',
      provenance: {
        principalId: OWNER,
        deviceId: 'fixture',
        actorId: 'fixture',
        clientId: 'fixture',
      },
      createdAt: AT,
    });
    ownerApi.checkpointIntake({
      intakeId: requirement.id,
      kind: 'progress',
      phase: 'executing',
      nextSafeAction: 'Continue the shared task',
      summary: 'Shared-track checkpoint',
      repository: { dirty: false },
      actor: OWNER,
      recordedAt: '2026-09-05T00:01:00.000Z',
    });

    // Before the share, a colleague sees nothing.
    const colleagueBefore = new MemoryApi({ stores: { local, team }, env: envFor(STRANGER) });
    expect(colleagueBefore.getIntake(requirement.id)).toBeUndefined();

    const shared = ownerApi.shareIntake(requirement.id, {
      audience: 'team',
      actor: OWNER,
      repository: { dirty: false },
    });
    expect(shared.ok).toBe(true);
    expect(shared.teamWritten).toBe(true);

    // After it, the SAME colleague can read and resume — authorization is the deliberate promotion
    // into Git-backed team memory, not the caller's identity string.
    const colleague = new MemoryApi({ stores: { local, team }, env: envFor(STRANGER) });
    const visible = colleague.getIntake(requirement.id);
    expect(visible?.requirement.id).toBe(requirement.id);
    expect(colleague.listIntakes().choices.some((c) => c.intakeId === requirement.id)).toBe(true);
  });
});
