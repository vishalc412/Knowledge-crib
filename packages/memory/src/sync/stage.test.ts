/**
 * The write-site staging port (ADR-003 D3/D4): every non-engine store write stages its own sync
 * event INSIDE the caller's lock hold — a tombstone written between two pushes must reach the
 * other devices instead of resurrecting on them. Honest gates, one test each: team skipped (D2 —
 * git IS its backend), un-initialized skipped (the push sweep heals), no derivable repo id
 * skipped, the stable `syncRepoId` override wins over the per-checkout manifest id, global NEVER
 * carries a repo id (D1), and a staged write re-pushes through the engine sweep without being
 * staged twice.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, __resetMemoryLockGuardForTest } from '../index.js';
import { FileSyncObjectStore } from './adapter.js';
import { seedSyncBaseline } from './bootstrap.js';
import { pushSync } from './engine.js';
import { SYNC_OUTBOX_FILE, loadSyncState, readStagedEvents } from './queue.js';
import { stageSyncableWrite } from './stage.js';
import { NOW, PRINCIPAL, REPO, decision, feedback, freshTestHome } from './sync-test-fixtures.js';

const SYNC_ID = 'sync-fixed-for-both-clones';
const KEY = Buffer.from('ab'.repeat(32), 'hex');
const CTX = {
  principalId: PRINCIPAL,
  now: () => NOW,
};

let home: ReturnType<typeof freshTestHome>;
let globalHome: ReturnType<typeof freshTestHome>;

beforeEach(() => {
  __resetMemoryLockGuardForTest();
  home = freshTestHome();
  globalHome = freshTestHome();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home.home, { recursive: true, force: true });
  rmSync(home.regDir, { recursive: true, force: true });
  rmSync(globalHome.home, { recursive: true, force: true });
  rmSync(globalHome.regDir, { recursive: true, force: true });
});

describe('stageSyncableWrite (the D3/D4 write-site port)', () => {
  it('skips the team store entirely (D2 — git IS the team backend)', () => {
    const crib = mkdtempSync(join(tmpdir(), 'stage-team-crib-'));
    try {
      const team = MemoryStore.team(crib, { env: home.env, now: () => NOW });
      expect(stageSyncableWrite(team, 'decision.append', decision('retract'), CTX)).toBeUndefined();
      expect(existsSync(join(team.rootDir, SYNC_OUTBOX_FILE))).toBe(false);
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });

  it('skips an un-initialized store (no sync-state — the push sweep owns the heal)', () => {
    const local = MemoryStore.local(REPO, { env: home.env, now: () => NOW });
    local.ensureManifest();
    expect(loadSyncState(local.rootDir)).toBeUndefined();
    expect(stageSyncableWrite(local, 'feedback.append', feedback('useful'), CTX)).toBeUndefined();
    expect(existsSync(join(local.rootDir, SYNC_OUTBOX_FILE))).toBe(false);
  });

  it('stages a decision.append whose envelope re-derives, and is idempotent on re-stage', () => {
    const local = MemoryStore.local(REPO, { env: home.env, now: () => NOW });
    local.ensureManifest();
    seedSyncBaseline(local, { deviceId: 'device-a' });
    const dec = decision('retract', 'mem:subject-a');
    const first = stageSyncableWrite(local, 'decision.append', dec, CTX);
    expect(first).toBeDefined();
    expect(first?.staged).toBe(true);
    // the staged row is the ENVELOPE (evt: id over the canonical payload), not the payload id
    const second = stageSyncableWrite(local, 'decision.append', dec, CTX);
    expect(second?.idempotent).toBe(true);
    expect(second?.id).toBe(first?.id);
    // exactly ONE canonical line, and it carries the decision payload
    const staged = readStagedEvents(local.rootDir).events;
    expect(staged).toHaveLength(1);
    expect(staged[0]?.id).toBe(first?.id);
    expect(staged[0]?.kind).toBe('decision.append');
    expect(staged[0]?.payloadId).toBe(dec.id);
    expect(staged[0]?.repoId).toBe(REPO);
  });

  it('a local store whose manifest carries no repo.id is honestly skipped', () => {
    const local = MemoryStore.local(REPO, { env: home.env, now: () => NOW });
    local.ensureManifest();
    seedSyncBaseline(local, { deviceId: 'device-a' });
    // simulate the un-derivable case: no override AND no manifest repo at all (`repo` is optional
    // in the manifest schema, so dropping it is a VALID manifest — the skip is the honest outcome)
    const manifestPath = join(local.rootDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      repo?: { id?: string };
    };
    manifest.repo = undefined;
    // JSON.stringify drops the undefined key, so the written manifest carries no repo at all
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    expect(stageSyncableWrite(local, 'decision.append', decision('retract'), CTX)).toBeUndefined();
  });

  it('the stable syncRepoId override wins over the per-checkout manifest repo.id', () => {
    const local = MemoryStore.local(REPO, { env: home.env, now: () => NOW });
    local.ensureManifest();
    seedSyncBaseline(local, { deviceId: 'device-a' });
    stageSyncableWrite(local, 'decision.append', decision('retract', 'mem:subject-b'), {
      ...CTX,
      syncRepoId: SYNC_ID,
    });
    const staged = readStagedEvents(local.rootDir).events;
    expect(staged[0]?.repoId).toBe(SYNC_ID);
  });

  it('a global-scope stage NEVER carries a repoId (D1: global events forbid it)', () => {
    const globalStore = MemoryStore.global({ env: globalHome.env, now: () => NOW });
    globalStore.ensureManifest();
    seedSyncBaseline(globalStore, { deviceId: 'device-a' });
    const first = stageSyncableWrite(
      globalStore,
      'feedback.append',
      feedback('unhelpful', 'mem:subject-c'),
      CTX,
    );
    expect(first?.staged).toBe(true);
    const staged = readStagedEvents(globalStore.rootDir).events;
    expect(staged[0]?.store).toBe('global');
    expect(staged[0]?.repoId).toBeUndefined();
  });

  it('a staged write rides the NEXT push and is acked without being re-staged', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'stage-remote-'));
    try {
      const local = MemoryStore.local(REPO, { env: home.env, now: () => NOW });
      local.ensureManifest();
      seedSyncBaseline(local, { deviceId: 'device-a' });
      const dec = decision('retract', 'mem:subject-d');
      const stageRes = stageSyncableWrite(local, 'decision.append', dec, CTX);
      expect(stageRes?.staged).toBe(true);
      const res = await pushSync(local, new FileSyncObjectStore(remote), {
        key: KEY,
        principalId: PRINCIPAL,
        now: () => NOW,
      });
      expect(res.ok).toBe(true);
      expect(res.pushed).toBe(1);
      expect(res.acked).toBe(1);
      // the ack names the ENVELOPE id that was staged — the payload never re-stages
      expect(loadSyncState(local.rootDir)?.ackedEvents).toContain(stageRes?.id);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
