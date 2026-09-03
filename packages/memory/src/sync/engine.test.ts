/**
 * The Gate-4 engine tests: two devices over ONE shared file backend (real fs + crypto, no mocks).
 * Every ordering law is exercised where it bites — acks after the durable bytes, the cursor after
 * the applied rows, the abort before anything is written — and every crash window heals by
 * redelivery, not by a special case. Crafted-envelope tests install objects on the shared remote
 * directly, because the threats under test (forged ids, torn records, tampered blobs, a secret in
 * a pre-staged outbox line) are exactly the ones that cannot pass the healthy writer path.
 */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStore,
  __resetMemoryLockGuardForTest,
  canonicalMemoryJson,
  memoryShard,
} from '../index.js';
import { FileSyncObjectStore } from './adapter.js';
import { seedSyncBaseline } from './bootstrap.js';
import { encryptEvent, keyFingerprint, routeKeyFor } from './crypto.js';
import { batchIdFor, pullSync, pushSync, rotateSyncKey, syncEngineStatus } from './engine.js';
import { type SyncEvent, buildSyncEvent, serializeSyncEvent } from './event.js';
import {
  SYNC_OUTBOX_FILE,
  SYNC_STATE_FILE,
  loadSyncState,
  readStagedEvents,
  saveSyncState,
  stageOutboundEvent,
} from './queue.js';
import {
  DEVICE,
  KEY_HEX,
  LATER,
  NOW,
  PRINCIPAL,
  REPO,
  decision,
  eventFor,
  freshTestHome,
  v1Record,
  v2Record,
} from './sync-test-fixtures.js';

const KEY = Buffer.from(KEY_HEX, 'hex');
const KEY2 = Buffer.from('cd'.repeat(32), 'hex');

// ─── harness: two devices, one shared remote ─────────────────────────────────

let homeA: ReturnType<typeof freshTestHome>;
let homeB: ReturnType<typeof freshTestHome>;
let remoteDir: string;
let backend: FileSyncObjectStore;
let storeA: MemoryStore;
let storeB: MemoryStore;

beforeEach(() => {
  __resetMemoryLockGuardForTest();
  homeA = freshTestHome();
  homeB = freshTestHome();
  remoteDir = mkdtempSync(join(tmpdir(), 'sync-engine-remote-'));
  backend = new FileSyncObjectStore(remoteDir);
  storeA = MemoryStore.local(REPO, { env: homeA.env, now: () => NOW });
  storeB = MemoryStore.local(REPO, { env: homeB.env, now: () => NOW });
  storeA.ensureManifest();
  storeB.ensureManifest();
  seedSyncBaseline(storeA, { deviceId: 'device-a' });
  seedSyncBaseline(storeB, { deviceId: 'device-b' });
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(homeA.home, { recursive: true, force: true });
  rmSync(homeA.regDir, { recursive: true, force: true });
  rmSync(homeB.home, { recursive: true, force: true });
  rmSync(homeB.regDir, { recursive: true, force: true });
  rmSync(remoteDir, { recursive: true, force: true });
});

const runOpts = (key: Uint8Array = KEY) => ({
  key,
  principalId: PRINCIPAL,
  now: () => NOW,
});

/** The canonical batch-manifest bytes the engine writes (the engine's own shape, replicated). */
function batchManifestBytes(keys: string[]): Uint8Array {
  const sorted = [...keys].sort();
  return Buffer.from(JSON.stringify({ v: '1', count: sorted.length, keys: sorted }), 'utf8');
}

/** Install crafted envelopes on the shared remote under one content-addressed batch manifest. */
async function stageRemoteBatch(evts: SyncEvent[], key: Uint8Array = KEY): Promise<string> {
  const keys: string[] = [];
  for (const evt of evts) {
    const routeKey = routeKeyFor(evt.id, key);
    await backend.putObject(routeKey, encryptEvent(evt, key));
    keys.push(routeKey);
  }
  const batchId = batchIdFor(keys);
  await backend.putObject(`b/${batchId}.json`, batchManifestBytes(keys));
  return batchId;
}

/** Plant a raw line in the sidecar outbox — the D3 direct path that bypasses the store write gate. */
function stageOutboxLine(evt: SyncEvent, root: string): void {
  appendFileSync(join(root, SYNC_OUTBOX_FILE), `${serializeSyncEvent(evt)}\n`, 'utf8');
}

function digestOf(entry: unknown): string {
  return blake3Hex(canonicalMemoryJson(entry as never));
}

// ─── push (D4/D5) ─────────────────────────────────────────────────────────────

describe('pushSync (two devices, shared remote)', () => {
  it('pushes the sweep as encrypted blobs + a batch manifest and acks last', async () => {
    const rec = v1Record();
    storeA.upsertEntry('active', rec);
    const res = await pushSync(storeA, backend, runOpts());
    expect(res.ok).toBe(true);
    expect(res.status).toBe('pushed');
    expect(res.pushed).toBe(1);
    expect(res.acked).toBe(1);
    expect(res.batches).toHaveLength(1);
    // the remote carries the encrypted event and the self-bootstrapping manifest
    expect((await backend.listObjects('ev/')).keys).toHaveLength(1);
    const manifest = await backend.getObject('manifest.json');
    expect(manifest).toBeDefined();
    expect(Buffer.from(manifest ?? new Uint8Array()).toString('utf8')).toContain(
      keyFingerprint(KEY),
    );
    // the durable result lands before the bookkeeping: the ack is LAST, and it is there now
    const state = loadSyncState(storeA.rootDir);
    expect(state?.ackedEvents).toHaveLength(1);
  });

  it('is a byte-stable no-op on re-push (derive-and-diff finds nothing new)', async () => {
    storeA.upsertEntry('active', v1Record());
    await pushSync(storeA, backend, runOpts());
    const evBefore = (await backend.listObjects('ev/')).keys;
    const res = await pushSync(storeA, backend, runOpts());
    expect(res.ok).toBe(true);
    expect(res.stagedNow).toBe(0);
    expect(res.planned).toBe(0);
    expect(res.pushed).toBe(0);
    expect(res.batches).toEqual([]);
    expect((await backend.listObjects('ev/')).keys).toEqual(evBefore);
  });

  it('computes everything on --dry-run and writes nothing anywhere', async () => {
    storeA.upsertEntry('active', v1Record());
    const res = await pushSync(storeA, backend, { ...runOpts(), dryRun: true });
    expect(res.status).toBe('dry-run');
    expect(res.planned).toBe(1);
    expect(res.pushed).toBe(0);
    expect(res.acked).toBe(0);
    // nothing reached the remote, nothing was staged, nothing was acked
    expect((await backend.listObjects('')).keys).toEqual([]);
    expect(loadSyncState(storeA.rootDir)?.ackedEvents).toHaveLength(0);
    expect(readStagedEvents(storeA.rootDir).events).toHaveLength(0);
  });

  it('refuses a restricted-sensitivity record and pushes the rest (skip-and-report)', async () => {
    const refused = v2Record({ sensitivity: 'restricted' });
    storeA.upsertEntry('active', refused);
    storeA.upsertEntry('active', v1Record());
    const res = await pushSync(storeA, backend, runOpts());
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(1);
    expect(res.refusals).toHaveLength(1);
    expect(res.refusals[0]?.reason).toBe('sensitivity');
    expect(res.refusals[0]?.payloadId).toBe(refused.id);
  });

  it('aborts the ENTIRE run on a secret-scan hit in a pre-staged outbox line, recorded by id only', async () => {
    // The store's write gate refuses a secret-bearing record, so this arrives the way it can in
    // the wild: a line already in the sidecar outbox (D3's direct sidecar path, no store gate).
    const secret = v1Record(`the key is sk-${'a'.repeat(30)}`);
    const evt = eventFor(secret, { store: 'local', repoId: REPO });
    stageOutboxLine(evt, storeA.rootDir);
    const res = await pushSync(storeA, backend, runOpts());
    expect(res.ok).toBe(false);
    expect(res.status).toBe('aborted');
    expect(res.aborted?.kind).toBe('secret-scan');
    expect(res.aborted?.payloadId).toBe(secret.id);
    // NOTHING was written to the remote — not even the bootstrapping manifest
    expect((await backend.listObjects('')).keys).toEqual([]);
    // and nothing was acked
    expect(loadSyncState(storeA.rootDir)?.ackedEvents).toHaveLength(0);
  });

  it('a crash before the acks re-delivers the same event without duplicating anything', async () => {
    storeA.upsertEntry('active', v1Record());
    const first = await pushSync(storeA, backend, runOpts());
    const state = loadSyncState(storeA.rootDir)!;
    // Simulate the crash window: the durable bytes are on the remote, the ack never landed.
    saveSyncState(storeA.rootDir, { ...state, ackedEvents: [] });
    const evBefore = (await backend.listObjects('ev/')).keys;
    const second = await pushSync(storeA, backend, runOpts());
    expect(second.ok).toBe(true);
    expect(second.pushed).toBe(1); // redelivered (at-least-once)
    expect(second.batches).toEqual(first.batches); // the same key set re-derives the same batch id
    expect((await backend.listObjects('ev/')).keys).toEqual(evBefore); // same route key, no duplicate
    // and the pull side sees exactly ONE event, deduped by the evt: id
    const pull = await pullSync(storeB, backend, runOpts());
    expect(pull.applied).toHaveLength(1);
  });
});

// ─── pull + the apply law (D8) ────────────────────────────────────────────────

describe('pullSync and the apply law', () => {
  it('applies an unseen batch through the store write gate and is a no-op on re-pull', async () => {
    const rec = v1Record();
    storeA.upsertEntry('active', rec);
    await pushSync(storeA, backend, runOpts());
    const pull = await pullSync(storeB, backend, runOpts());
    expect(pull.ok).toBe(true);
    expect(pull.status).toBe('pulled');
    expect(pull.applied).toEqual([
      { eventId: expect.any(String), payloadId: rec.id, action: 'upserted' },
    ]);
    // the pulled record keeps the pushing device's stamped verdicts, byte for byte
    const landed = storeB.readShard('active', memoryShard(rec.id)).entries[0];
    expect(landed && canonicalMemoryJson(landed) === canonicalMemoryJson(rec)).toBe(true);
    // the cursor advanced LAST: the batch is recorded in sync-state
    expect(loadSyncState(storeB.rootDir)?.cursors.pulledBatches).toHaveLength(1);
    // redelivery: the same batch again is a byte-identical no-op, never a second write
    const again = await pullSync(storeB, backend, runOpts());
    expect(again.batchesSeen).toBe(1);
    expect(again.applied).toHaveLength(0);
  });

  it('a forged payload id (bytes do not re-derive the id) is a hard conflict, never applied', async () => {
    const legit = v1Record();
    const forged = { ...legit, claim: 'a forged claim nobody wrote' };
    await stageRemoteBatch([eventFor(forged, { store: 'local', repoId: REPO })]);
    const pull = await pullSync(storeB, backend, runOpts());
    expect(pull.status).toBe('pulled');
    expect(pull.conflictsAdded).toHaveLength(1);
    expect(pull.conflictsAdded[0]?.localDigest).toBe('absent'); // the store never held this id
    expect(pull.conflictsAdded[0]?.remoteDigest).toBe(digestOf(forged));
    expect(pull.surfaced.map((s) => s.reason)).toContain('payload-id-mismatch');
    // the forged line was NOT applied
    expect(storeB.readShard('active', memoryShard(forged.id)).entries).toHaveLength(0);
    // and the conflict ledger persisted
    expect(loadSyncState(storeB.rootDir)?.conflicts).toHaveLength(1);
  });

  it('same id, different bytes: the local copy is retained and a conflict is recorded (never LWW)', async () => {
    const recA = v1Record();
    // verdicts/createdAt are NOT in the v1 id seed — same id, honest different bytes
    const recB = {
      ...recA,
      verdicts: { ...recA.verdicts, trust: 'team' as const },
      createdAt: LATER,
    };
    storeB.upsertEntry('active', recB);
    await stageRemoteBatch([eventFor(recA, { store: 'local', repoId: REPO })]);
    const pull = await pullSync(storeB, backend, runOpts());
    expect(pull.applied).toHaveLength(0); // nothing overwritten
    expect(pull.conflictsAdded).toHaveLength(1);
    expect(pull.conflictsAdded[0]?.localDigest).toBe(digestOf(recB));
    expect(pull.conflictsAdded[0]?.remoteDigest).toBe(digestOf(recA));
    // the local bytes survive untouched
    const held = storeB.readShard('active', memoryShard(recA.id)).entries[0];
    expect(held && canonicalMemoryJson(held) === canonicalMemoryJson(recB)).toBe(true);
  });

  it('a corrupt blob fails closed with the cursor unmoved — and --skip cannot fix decryption', async () => {
    const evt = eventFor(v1Record(), { store: 'local', repoId: REPO });
    const routeKey = routeKeyFor(evt.id, KEY);
    await backend.putObject(routeKey, Buffer.from('tampered-bytes', 'utf8'));
    const batchId = batchIdFor([routeKey]);
    await backend.putObject(`b/${batchId}.json`, batchManifestBytes([routeKey]));
    const halted = await pullSync(storeB, backend, runOpts());
    expect(halted.status).toBe('halted');
    expect(halted.halted?.reason).toContain('decryption failed');
    expect(loadSyncState(storeB.rootDir)?.cursors.pulledBatches).toHaveLength(0);
    // --skip quarantines what CAN be decrypted; it must never fake-decrypt
    const skipped = await pullSync(storeB, backend, { ...runOpts(), skip: true });
    expect(skipped.status).toBe('halted');
    expect(loadSyncState(storeB.rootDir)?.cursors.pulledBatches).toHaveLength(0);
  });

  it('--skip quarantines an invalid-schema payload instead of halting; without skip it halts', async () => {
    // A torn record: every field except `verdicts` — it still carries its (re-derivable) id.
    const full = v1Record() as unknown as Record<string, unknown>;
    const bad = Object.fromEntries(Object.entries(full).filter(([k]) => k !== 'verdicts'));
    const evt = buildSyncEvent({
      kind: 'record.upsert',
      store: 'local',
      repoId: REPO,
      deviceId: 'device-a',
      principalId: PRINCIPAL,
      payload: bad as never,
      ts: NOW,
    });
    await stageRemoteBatch([evt]);
    const halted = await pullSync(storeB, backend, runOpts());
    expect(halted.status).toBe('halted');
    expect(halted.halted?.reason).toContain('schema');
    expect(halted.halted?.eventId).toBe(evt.id);
    expect(loadSyncState(storeB.rootDir)?.cursors.pulledBatches).toHaveLength(0);
    // the skip law: quarantine BY ID — the finding text never enters the ledger, the blob is kept
    const skipped = await pullSync(storeB, backend, { ...runOpts(), skip: true });
    expect(skipped.status).toBe('pulled');
    expect(skipped.quarantined).toHaveLength(1);
    expect(skipped.quarantined[0]?.reason).toBe('invalid-schema');
    expect(skipped.quarantined[0]?.payloadId).toBe(v1Record().id);
    expect(loadSyncState(storeB.rootDir)?.quarantine).toHaveLength(1);
    // the batch is now in the cursor — the quarantined event is not redelivered
    const again = await pullSync(storeB, backend, runOpts());
    expect(again.batchesApplied).toBe(0);
  });

  it('applies a pulled tombstone and surfaces the ahead-of-record case (D9)', async () => {
    const dec = decision('retract', 'mem:does-not-exist-yet');
    const evt = eventFor(dec, { kind: 'decision.append', store: 'local', repoId: REPO });
    stageOutboundEvent(evt, storeA.rootDir);
    await pushSync(storeA, backend, runOpts());
    const pull = await pullSync(storeB, backend, runOpts());
    expect(pull.applied).toEqual([
      { eventId: evt.id, payloadId: dec.id, action: 'decision-applied' },
    ]);
    expect(pull.surfaced.map((s) => s.reason)).toContain('applied tombstone for unknown subject');
    // the decision landed through the write gate
    expect(storeB.readShard('decisions', memoryShard(dec.id)).entries).toHaveLength(1);
  });

  it('surfaces an event for a store role this machine has not configured, never applies it', async () => {
    // a global-scope envelope arrives at a local-scope receiver: placement is by role, not by whim
    const evt = eventFor(v2Record(), { store: 'global' });
    await stageRemoteBatch([evt]);
    const pull = await pullSync(storeB, backend, runOpts());
    expect(pull.surfaced).toEqual([
      { eventId: evt.id, payloadId: evt.payloadId, reason: 'unconfigured-store' },
    ]);
    expect(pull.applied).toHaveLength(0);
    // nothing was written into the receiver's collections
    expect(storeB.readCollection('active').entries).toHaveLength(0);
  });

  it('pull --dry-run computes the apply plan and writes nothing anywhere', async () => {
    const rec = v1Record();
    storeA.upsertEntry('active', rec);
    await pushSync(storeA, backend, runOpts());
    const stateBefore = canonicalMemoryJson(loadSyncState(storeB.rootDir) as never);
    const res = await pullSync(storeB, backend, { ...runOpts(), dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('dry-run');
    expect(res.applied).toEqual([
      { eventId: expect.any(String), payloadId: rec.id, action: 'upserted' },
    ]);
    // NOTHING mutated: the state (cursors) byte-identical, the store untouched, the remote intact
    expect(canonicalMemoryJson(loadSyncState(storeB.rootDir) as never)).toBe(stateBefore);
    expect(storeB.readCollection('active').entries).toHaveLength(0);
    // the real pull afterwards applies exactly what the dry-run planned (the plan is the truth)
    const real = await pullSync(storeB, backend, runOpts());
    expect(real.applied).toEqual(res.applied);
  });
});

// ─── the stable cross-clone sync id (syncRepoId) ──────────────────────────────

describe('the syncRepoId override (two clones of one repo reconcile)', () => {
  it('two stores with DIFFERENT manifest repo ids reconcile under one override id', async () => {
    // the manifest repo.id is a per-checkout identity — two real clones could never reconcile on
    // it. The override threads through the sweep, the walk/seed, and the pull placement, so both
    // devices derive the SAME evt: ids under one stable sync id.
    const remoteDir2 = mkdtempSync(join(tmpdir(), 'sync-clone-remote-'));
    try {
      const cloneA = MemoryStore.local('r-clone-a', { env: homeA.env, now: () => NOW });
      const cloneB = MemoryStore.local('r-clone-b', { env: homeB.env, now: () => NOW });
      const cloneC = MemoryStore.local('r-clone-c', { env: homeB.env, now: () => NOW });
      cloneA.ensureManifest();
      cloneB.ensureManifest();
      cloneC.ensureManifest();
      expect(cloneA.readManifest()?.repo?.id).toBe('r-clone-a');
      expect(cloneB.readManifest()?.repo?.id).toBe('r-clone-b');
      const id = { syncRepoId: 'sync-both-clones-share-this' };
      seedSyncBaseline(cloneA, { deviceId: 'device-a', ...id });
      seedSyncBaseline(cloneB, { deviceId: 'device-b', ...id });
      seedSyncBaseline(cloneC, { deviceId: 'device-c', ...id });
      const rec = v1Record();
      cloneA.upsertEntry('active', rec);
      const push = await pushSync(cloneA, backend, { ...runOpts(), ...id });
      expect(push.ok).toBe(true);
      expect(push.pushed).toBe(1);
      // WITHOUT the override the pull places nothing (the manifest id is not the sync id) — the
      // event is surfaced, never silently dropped. The surfaced pull still advances its cursor
      // (the placement refusal IS the durable outcome), so a separate clone proves the apply.
      const bare = await pullSync(cloneB, backend, runOpts());
      expect(bare.applied).toHaveLength(0);
      expect(bare.surfaced.map((s) => s.reason)).toContain('different-repo');
      expect(cloneB.readShard('active', memoryShard(rec.id)).entries).toHaveLength(0);
      // WITH the override the pulled event lands through the receiver's write gate
      const pull = await pullSync(cloneC, backend, { ...runOpts(), ...id });
      expect(pull.applied).toEqual([
        { eventId: expect.any(String), payloadId: rec.id, action: 'upserted' },
      ]);
      expect(cloneC.readShard('active', memoryShard(rec.id)).entries).toHaveLength(1);
    } finally {
      rmSync(remoteDir2, { recursive: true, force: true });
    }
  });
});

// ─── status + rotation (D7/D12) ───────────────────────────────────────────────

describe('syncEngineStatus and rotateSyncKey', () => {
  it('reports the honest empty shape before init and the counts + remote match after a push', async () => {
    rmSync(join(storeA.rootDir, SYNC_STATE_FILE), { force: true }); // un-seed for the empty check
    const empty = await syncEngineStatus(storeA);
    expect(empty.available).toBe(false);
    expect(empty.status).toBe('not-initialized');
    expect(empty.staged).toBe(0);
    seedSyncBaseline(storeA, { deviceId: DEVICE }); // re-seed for the initialized half

    storeA.upsertEntry('active', v1Record());
    await pushSync(storeA, backend, runOpts());
    const res = await syncEngineStatus(storeA, { backend, key: KEY });
    expect(res.available).toBe(true);
    expect(res.status).toBe('initialized');
    expect(res.deviceId).toBe(DEVICE);
    expect(res.pending).toBe(0);
    expect(res.acked).toBe(1);
    expect(res.conflicts).toHaveLength(0);
    expect(res.quarantine).toHaveLength(0);
    expect(res.remote?.reachable).toBe(true);
    expect(res.remote?.batches).toBe(1);
    expect(res.remote?.events).toBe(1);
    expect(res.remote?.keyFingerprintMatch).toBe(true);
    // the wrong key reports the mismatch instead of pretending
    const wrong = await syncEngineStatus(storeA, { backend, key: KEY2 });
    expect(wrong.remote?.keyFingerprintMatch).toBe(false);
  });

  it('refuses to rotate while the outbox holds staged-but-unacked events (the wedge guard)', async () => {
    // The staged-but-unacked event never re-pushes silently mid-rotation: the refusal is typed,
    // carries the pending count, and names the remediation (push first, rotate second).
    const secret = v1Record(`the key is sk-${'a'.repeat(30)}`);
    stageOutboxLine(eventFor(secret, { store: 'local', repoId: REPO }), storeA.rootDir);
    const res = await rotateSyncKey(storeA, backend, { ...runOpts(), newKey: KEY2 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.pending).toBe(1);
    expect(res.warning).toContain('staged-but-unacked');
    expect(res.warning).toContain('re-seeded');
    // nothing was re-pushed or re-encrypted by the refused rotation
    expect(res.reEncrypted).toBe(0);
    expect(res.batches).toEqual([]);
  });

  it('rotates: re-encrypts the acked roster under the new key and bumps the epoch LAST', async () => {
    storeA.upsertEntry('active', v1Record());
    await pushSync(storeA, backend, runOpts());
    const res = await rotateSyncKey(storeA, backend, { ...runOpts(), newKey: KEY2 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('rotated');
    expect(res.reEncrypted).toBe(1);
    const state = loadSyncState(storeA.rootDir);
    expect(state?.keyEpoch).toBe(2);
    const manifest = Buffer.from(
      (await backend.getObject('manifest.json')) ?? new Uint8Array(),
    ).toString('utf8');
    expect(manifest).toContain(keyFingerprint(KEY2));
    // device B (which never held the old key) pulls with the NEW key
    const pull = await pullSync(storeB, backend, runOpts(KEY2));
    expect(pull.applied.map((a) => a.action)).toContain('upserted');
  });
});
