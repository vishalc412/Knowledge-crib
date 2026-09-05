import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MemoryRecordV3,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  assertValidMemoryEntry,
  assertValidMemoryRecordV3,
  derivePropositionKey,
  gatherRecall,
  memoryRecordV3Id,
  recallProjection,
} from './index.js';

const NOW = '2026-09-04T00:00:00.000Z';
const REPO = 'r-v3';

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-v3-home-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

function record(principalId = 'principal:one'): MemoryRecordV3 {
  const subject = 'sym:src/memory.ts#remember';
  const namespace = {
    principalId,
    workspaceId: 'workspace:knowledge-crib',
    projectId: 'project:knowledge-crib',
    agentProfileId: 'agent-profile:one',
  };
  const input = {
    kind: 'fact' as const,
    subject,
    propositionKey: derivePropositionKey({ subject }),
    claim: 'The journal retains sanitized intelligence events for 30 days.',
    evidence: [
      {
        kind: 'source-quote' as const,
        verdict: 'valid' as const,
        checkedAt: NOW,
        soulId: 'sym:packages/memory/src/intelligence-events.ts#IntelligenceEventJournal',
        quote: 'default 30-day retention',
        targetHash: 'blake3:abc',
      },
    ],
    namespace,
  };
  return {
    id: memoryRecordV3Id(input),
    schemaVersion: '3',
    visibility: 'workspace',
    ...input,
    validTime: { from: NOW },
    transactionTime: { observedAt: NOW, recordedAt: NOW },
    provenance: {
      principalId,
      deviceId: 'device:test',
      actorId: 'agent:test',
      clientId: 'vitest',
    },
    lineage: {},
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
  };
}

describe('memory-3 namespace envelope', () => {
  it('content-addresses the namespace and rejects unmodeled caller fields', () => {
    const one = record('principal:one');
    const two = record('principal:two');
    expect(one.id).not.toBe(two.id);
    expect(() => assertValidMemoryRecordV3(one)).not.toThrow();
    expect(() =>
      assertValidMemoryEntry(one as unknown as { id: string } & Record<string, unknown>),
    ).not.toThrow();
    expect(() =>
      assertValidMemoryRecordV3({ ...one, tenantId: 'forged' } as MemoryRecordV3),
    ).toThrow(/tenantId/);
  });

  it('projects for its owner without throwing and excludes a foreign principal before projection', () => {
    const store = MemoryStore.local(REPO, { env, now: () => NOW });
    const ownerRecord = record('principal:owner');
    const foreignRecord = record('principal:foreign');
    store.upsertEntries('active', [ownerRecord, foreignRecord]);

    const gathered = gatherRecall({ local: store }, { principal: 'principal:owner' });
    expect(gathered.records.map(({ record }) => record.id)).toEqual([ownerRecord.id]);
    expect(gathered.principalExcluded).toBe(1);
    expect(() => recallProjection(gathered)).not.toThrow();
  });
});
