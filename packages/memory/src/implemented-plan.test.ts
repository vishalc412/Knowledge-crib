import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ImplementationRecord, MemoryStore } from './index.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(): ImplementationRecord {
  return {
    id: `impl:${'a'.repeat(64)}`,
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
    archivePath: 'implementations/archive.md',
    archiveSha256: '1'.repeat(64),
    receiptIds: [],
    actor: 'human:principal-1',
    recordedAt: '2026-09-24T00:00:00.000Z',
  };
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
  });
});
