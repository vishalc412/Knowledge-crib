import { describe, expect, it } from 'vitest';
import {
  type MemoryRecordV3,
  assertValidMemoryEntry,
  assertValidMemoryRecordV3,
  derivePropositionKey,
  memoryRecordV3Id,
} from './index.js';

const NOW = '2026-09-04T00:00:00.000Z';

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
});
