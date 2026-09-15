import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphAssertion, createGraphEntity } from './graph.js';
import { MemoryApi } from './api.js';
import { MemoryStore, __resetMemoryLockGuardForTest } from './store.js';
import type { MemoryProvenance } from './types.js';

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
});
