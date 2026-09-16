import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryApi } from './api.js';
import { buildGraphExtractionJob } from './graph-extraction.js';
import { createGraphAssertion, createGraphEntity } from './graph.js';
import { memoryRecordId } from './ids.js';
import { MemoryStore, __resetMemoryLockGuardForTest } from './store.js';
import type { MemoryProvenance, MemoryRecord } from './types.js';

const ALPHA = 'principal:alpha';
const BETA = 'principal:beta';
const NOW = '2026-01-01T00:00:00.000Z';

let home: string;
let local: MemoryStore;

function provenance(principalId: string): MemoryProvenance {
  return {
    principalId,
    deviceId: 'device:graph-api-test',
    actorId: 'agent:graph-api-test',
    clientId: 'vitest',
  };
}

function entity(principalId: string) {
  return createGraphEntity({
    kind: 'concept',
    name: `support-${principalId.slice('principal:'.length)}`,
    namespace: { principalId },
    scope: { boundary: 'global' },
    provenance: provenance(principalId),
  });
}

function assertion(principalId: string, subject: string, object: string, supportedBy: string) {
  return createGraphAssertion({
    predicate: 'about',
    subject,
    object,
    namespace: { principalId },
    scope: { boundary: 'global' },
    validAt: NOW,
    knownAt: NOW,
    supportedBy: [supportedBy],
    provenance: provenance(principalId),
  });
}

function record(): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: 'topic:graph-lifecycle',
    claim: 'Graph lifecycle evidence must remain current.',
    scope: { boundary: 'global' as const },
    appliesTo: ['topic:graph-lifecycle'],
    evidence: [
      {
        kind: 'source-quote' as const,
        verdict: 'valid' as const,
        checkedAt: NOW,
        soulId: 'topic:graph-lifecycle',
        quote: 'Graph lifecycle evidence must remain current.',
        targetHash: 'blake3:0123456789abcdef',
      },
    ],
    authorship: { actor: 'vitest', kind: 'agent' as const, tool: 'vitest' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: NOW,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crib-graph-api-'));
  __resetMemoryLockGuardForTest();
  local = MemoryStore.local('repo-graph-api', {
    repoRoot: home,
    env: { ...process.env, KCRIB_MEMORY_DIR: home },
    now: () => NOW,
  });
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

describe('MemoryApi.graphProjection', () => {
  it('projects only the authenticated principal graph entries', () => {
    const alphaEntity = entity(ALPHA);
    const betaEntity = entity(BETA);
    const mine = assertion(ALPHA, 'mem:alpha', 'topic:alpha', alphaEntity.ref);
    const theirs = assertion(BETA, 'mem:beta', 'topic:beta', betaEntity.ref);
    local.submitGraphEntries([alphaEntity, betaEntity, mine, theirs]);

    const api = new MemoryApi({
      stores: { local },
      env: { ...process.env, KCRIB_PRINCIPAL_ID: ALPHA },
      now: () => NOW,
    });
    const graph = api.graphProjection();

    expect(graph.current.map((edge) => edge.id)).toEqual([mine.id]);
    expect(graph.diagnostics.excludedForeign).toBe(0);
    expect(JSON.stringify(graph)).not.toContain('topic:beta');
  });

  it('withdraws an assertion when its only supporting record is retracted', () => {
    const support = record();
    const edge = assertion(ALPHA, support.id, 'topic:retained-edge', support.id);
    const job = buildGraphExtractionJob(
      {
        sourceId: support.id,
        sourceHash: 'blake3:0123456789abcdef',
        ontologyVersion: 'graph-ontology-v1',
        principalId: ALPHA,
        producer: { id: 'agent:retention', version: '1.0.0' },
        idempotencyKey: 'retention:graph-api:1',
      },
      NOW,
    );
    local.upsertEntry('active', support);
    local.submitGraphEntries([edge]);
    local.upsertEntry('graph-jobs', job);
    const api = new MemoryApi({
      stores: { local },
      env: { ...process.env, KCRIB_PRINCIPAL_ID: ALPHA },
      now: () => NOW,
    });

    expect(api.graphProjection().current.map((item) => item.id)).toEqual([edge.id]);
    expect(api.delete(support.id, { actor: 'agent:retention' }).ok).toBe(true);

    const graph = api.graphProjection();
    expect(graph.current).toEqual([]);
    expect(graph.timeline).toEqual([]);
    expect(graph.diagnostics.unsupported).toEqual([
      { id: edge.id, missingSupporters: [support.id] },
    ]);
    expect(local.readCollection('graph-jobs').entries).toEqual([]);
  });
});
