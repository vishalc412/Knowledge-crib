import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  FileSyncObjectStore,
  MemoryStore,
  decisionId,
  memoryRecordId,
  pullSync,
  pushSync,
  seedSyncBaseline,
} from '../packages/memory/dist/index.js';

const numberArg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const durationMs = numberArg('--duration-ms', 15 * 60 * 1000);
const intervalMs = numberArg('--interval-ms', 1000);
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : undefined;
const root = mkdtempSync(resolve(tmpdir(), 'crib-sync-soak-'));
const repoId = 'sync-soak-repo';
const principalId = 'sync-soak-principal';
const key = new Uint8Array(32).fill(19);
const remote = new FileSyncObjectStore(resolve(root, 'remote'));
const envFor = (name) => ({
  ...process.env,
  KCRIB_MEMORY_DIR: resolve(root, name),
  KCRIB_REGISTRY_DIR: resolve(root, `${name}-registry`),
});
const repoFor = (name) => {
  const path = resolve(root, `${name}-repo`);
  mkdirSync(path, { recursive: true });
  return path;
};
const storeFor = (name) =>
  MemoryStore.local(repoId, {
    repoRoot: repoFor(name),
    env: envFor(name),
    now: () => new Date().toISOString(),
  });

function record(cycle, device) {
  const subject = `sym:src/soak.ts#cycle${cycle}`;
  const claim = `sync soak cycle ${cycle} written by ${device}`;
  const input = {
    kind: 'fact',
    subject,
    claim,
    scope: { boundary: 'repo', repoId },
    appliesTo: [subject],
    evidence: [
      {
        kind: 'source-quote',
        verdict: 'valid',
        checkedAt: '2026-09-05T00:00:00.000Z',
        soulId: subject,
        quote: claim,
      },
    ],
    authorship: { actor: device, kind: 'agent', tool: 'sync-soak' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: new Date().toISOString(),
  };
}

const opts = () => ({
  key,
  principalId,
  syncRepoId: repoId,
  now: () => new Date().toISOString(),
});
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const expectedRecords = [];
const expectedDecisions = [];
const errors = [];
let cycles = 0;
let pushes = 0;
let pulls = 0;
let duplicatePulls = 0;
const startedAt = new Date().toISOString();
const started = Date.now();

try {
  for (const name of ['a', 'b']) {
    const store = storeFor(name);
    store.ensureManifest();
    seedSyncBaseline(store, { deviceId: `device-${name}`, backfill: true, repoId });
  }
  while (Date.now() - started < durationMs || cycles === 0) {
    cycles++;
    const writerName = cycles % 2 === 0 ? 'b' : 'a';
    const writer = storeFor(writerName); // reconstruct each cycle: process-restart equivalent state
    const next = record(cycles, `device-${writerName}`);
    writer.upsertEntries('active', [next]);
    expectedRecords.push(next.id);
    const pushed = await pushSync(writer, remote, opts());
    pushes++;
    if (!pushed.ok) errors.push(`cycle ${cycles} push ${writerName}: ${pushed.status}`);

    if (cycles % 7 === 0) {
      const subject = expectedRecords[Math.max(0, expectedRecords.length - 4)];
      const decision = {
        id: decisionId({ kind: 'retract', subject, actor: `device-${writerName}`, reason: 'soak' }),
        schemaVersion: '1',
        kind: 'retract',
        subject,
        actor: `device-${writerName}`,
        reason: 'soak',
        ts: new Date().toISOString(),
      };
      writer.upsertEntries('decisions', [decision]);
      expectedDecisions.push(decision.id);
      const tombstonePush = await pushSync(writer, remote, opts());
      pushes++;
      if (!tombstonePush.ok) errors.push(`cycle ${cycles} tombstone push: ${tombstonePush.status}`);
    }

    // Ten-cycle offline windows create backlog; duplicate pulls exercise idempotent replay.
    if (cycles % 10 === 0) {
      for (const name of ['a', 'b']) {
        const pulled = await pullSync(storeFor(name), remote, opts());
        pulls++;
        if (!pulled.ok) errors.push(`cycle ${cycles} pull ${name}: ${pulled.status}`);
        const duplicate = await pullSync(storeFor(name), remote, opts());
        duplicatePulls++;
        if (!duplicate.ok)
          errors.push(`cycle ${cycles} duplicate pull ${name}: ${duplicate.status}`);
      }
    }
    const remaining = durationMs - (Date.now() - started);
    if (remaining > 0) await wait(Math.min(intervalMs, remaining));
  }

  for (const name of ['a', 'b']) {
    const pulled = await pullSync(storeFor(name), remote, opts());
    pulls++;
    if (!pulled.ok) errors.push(`final pull ${name}: ${pulled.status}`);
  }
  const devices = ['a', 'b'].map((name) => {
    const store = storeFor(name);
    const records = new Set(store.readCollection('active').entries.map((entry) => entry.id));
    const decisions = new Set(store.readCollection('decisions').entries.map((entry) => entry.id));
    return {
      device: name,
      records: records.size,
      decisions: decisions.size,
      missingRecords: expectedRecords.filter((id) => !records.has(id)),
      missingDecisions: expectedDecisions.filter((id) => !decisions.has(id)),
    };
  });
  const elapsedMs = Date.now() - started;
  const pass =
    errors.length === 0 &&
    devices.every(
      (device) => device.missingRecords.length === 0 && device.missingDecisions.length === 0,
    );
  const report = {
    format: 'knowledge-crib-sync-soak',
    formatVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    configuredDurationMs: durationMs,
    elapsedMs,
    intervalMs,
    cycles,
    pushes,
    pulls,
    duplicatePulls,
    offlineWindowCycles: 10,
    recordsWritten: expectedRecords.length,
    tombstonesWritten: expectedDecisions.length,
    devices,
    errors,
    pass,
    durabilityClaim:
      'process restart, replay, atomic-file and interrupted-operation coverage; no power-loss/fsync claim',
  };
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
