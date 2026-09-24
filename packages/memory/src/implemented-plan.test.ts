import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ImplementationRecord,
  MemoryApi,
  MemoryStore,
  createIntakeCheckpoint,
  createIntakeRequirement,
  implementationArchivePath,
  implementationRecordId,
} from './index.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(): ImplementationRecord {
  const record: ImplementationRecord = {
    id: '',
    schemaVersion: '1',
    namespace: { principalId: 'principal-1', projectId: 'repo-1' },
    intakeId: `intake:${'b'.repeat(64)}`,
    audience: 'private',
    category: 'enhancement',
    summary: 'Add durable plan archive',
    planPath: 'docs/plan.md',
    planSha256: 'c'.repeat(64),
    baseCommit: 'd'.repeat(40),
    headCommit: 'e'.repeat(40),
    commits: ['e'.repeat(40)],
    changedPaths: ['src/feature.ts'],
    patchSha256: 'f'.repeat(64),
    archivePath: '',
    archiveSha256: '1'.repeat(64),
    receiptIds: [],
    actor: 'human:principal-1',
    recordedAt: '2026-09-24T00:00:00.000Z',
  };
  record.id = implementationRecordId(record);
  record.archivePath = implementationArchivePath(record);
  return record;
}

describe('implemented plan collection', () => {
  it('persists an implementation separately from claim records', () => {
    const home = mkdtempSync(join(tmpdir(), 'implementation-memory-'));
    homes.push(home);
    const env = { ...process.env, KCRIB_MEMORY_DIR: home };
    const store = MemoryStore.local('repo-1', { env });
    const record = fixture();
    store.upsertEntry('implementations', record);

    const reopened = MemoryStore.local('repo-1', { env });
    expect(reopened.readCollection('implementations').entries).toEqual([record]);
    expect(reopened.readCollection('active').entries).toEqual([]);
    expect(() => store.upsertEntry('active', record)).toThrow();
    expect(() =>
      store.upsertEntry('implementations', { ...record, archivePath: '../../probe.md' }),
    ).toThrow();
    expect(() =>
      store.upsertEntry('implementations', { ...record, id: `impl:${'2'.repeat(64)}` }),
    ).toThrow();
    expect(() =>
      store.upsertEntry('implementations', { ...record, summary: 'tampered' }),
    ).toThrow();
  });

  it('retrieves only implementations attached to completed intakes and reports archive damage', () => {
    const home = mkdtempSync(join(tmpdir(), 'implementation-memory-'));
    homes.push(home);
    const env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_PRINCIPAL_ID: 'principal-1' };
    const local = MemoryStore.local('repo-1', { env });
    const api = new MemoryApi({ stores: { local }, env });
    const intake = createIntakeRequirement({
      namespace: { principalId: 'principal-1', projectId: 'repo-1' },
      original: 'Implement the plan',
      interpretation: {
        outcome: 'Feature shipped',
        scope: [],
        constraints: [],
        acceptanceCriteria: [],
      },
      sensitivity: 'internal',
      retentionPolicyId: 'default',
      provenance: {
        principalId: 'principal-1',
        deviceId: 'test',
        actorId: 'test',
        clientId: 'test',
      },
      createdAt: '2026-09-24T00:00:00.000Z',
    });
    local.upsertEntry('intakes', intake);
    const record = { ...fixture(), intakeId: intake.id };
    record.id = implementationRecordId(record);
    record.archivePath = implementationArchivePath(record);
    const wrongProject = {
      ...record,
      namespace: { principalId: 'principal-1', projectId: 'repo-2' },
    };
    wrongProject.id = implementationRecordId(wrongProject);
    wrongProject.archivePath = implementationArchivePath(wrongProject);
    expect(() => api.recordImplementation(wrongProject)).toThrow(/project does not match/i);
    api.recordImplementation(record);
    expect(api.listImplementations()).toEqual([]);
    local.upsertEntry(
      'intakes',
      createIntakeCheckpoint({
        intakeId: intake.id,
        kind: 'completed',
        phase: 'complete',
        summary: 'Done',
        repository: { head: record.headCommit, dirty: false },
        artifactPaths: [record.archivePath],
        actor: 'test',
        recordedAt: '2026-09-24T00:01:00.000Z',
      }),
    );
    expect(api.listImplementations()).toMatchObject([
      { record: { id: record.id }, integrity: 'missing' },
    ]);
    mkdirSync(join(local.rootDir, 'implementations'), { recursive: true });
    writeFileSync(join(local.rootDir, record.archivePath), 'modified archive');
    expect(api.searchImplementations('durable plan')).toMatchObject([
      { record: { id: record.id }, integrity: 'mismatch' },
    ]);
    const second = { ...record, category: 'addon' as const };
    second.id = implementationRecordId(second);
    second.archivePath = implementationArchivePath(second);
    expect(() => api.recordImplementation(second)).toThrow(/completed intake/i);
    const foreign = new MemoryApi({
      stores: { local },
      env: { ...env, KCRIB_PRINCIPAL_ID: 'principal-2' },
    });
    expect(foreign.listImplementations()).toEqual([]);
  });
});
