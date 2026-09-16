import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimGraphExtractionJob,
  completeGraphExtractionJob,
  enqueueGraphExtractionJob,
  failLeasedGraphExtractionJob,
  requeueGraphExtractionJob,
  retryGraphExtractionJobs,
} from './graph-extraction-queue.js';
import {
  buildGraphExtractionJob,
  canLeaseGraphExtractionJob,
  failGraphExtractionJob,
  isGraphExtractionStale,
} from './graph-extraction.js';
import { MemoryStore, __resetMemoryLockGuardForTest } from './store.js';
import { assertValidMemoryEntry } from './validate.js';

const INPUT = {
  sourceId: 'cap:0123456789abcdef',
  sourceHash: 'blake3:source-a',
  ontologyVersion: 'graph-ontology-v1',
  principalId: 'principal:alpha',
  producer: { id: 'agent:codex', version: '1.0.0' },
  idempotencyKey: 'capture:alpha:1',
} as const;

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'graph-extraction-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

function store(): MemoryStore {
  return MemoryStore.local('graph-extraction-test', { env });
}

describe('graph extraction jobs', () => {
  it('deduplicates identical semantic input while keeping operational state out of the job id', () => {
    const a = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    const b = buildGraphExtractionJob(INPUT, '2026-02-01T00:00:00.000Z');
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('pending');
  });

  it('uses a schema-validated durable job envelope', () => {
    const job = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    expect(() => assertValidMemoryEntry({ ...job })).not.toThrow();
  });

  it('rejects a leased job without a durable lease owner and expiry', () => {
    const job = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    expect(() => assertValidMemoryEntry({ ...job, status: 'leased' })).toThrow(
      /graph-extraction-job schema validation failed/,
    );
  });

  it('rejects an invalid job timestamp before it reaches the queue', () => {
    const job = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    expect(() => assertValidMemoryEntry({ ...job, createdAt: 'later' })).toThrow(
      /graph-extraction-job schema validation failed/,
    );
  });

  it('marks output stale when the capture source hash changes', () => {
    const job = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    expect(isGraphExtractionStale(job, 'blake3:source-a')).toBe(false);
    expect(isGraphExtractionStale(job, 'blake3:source-b')).toBe(true);
  });

  it('reclaims an expired lease but refuses a still-live lease', () => {
    const job = {
      ...buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z'),
      status: 'leased' as const,
      lease: { owner: 'worker:a', expiresAt: '2026-01-01T00:01:00.000Z' },
    };
    expect(canLeaseGraphExtractionJob(job, '2026-01-01T00:00:30.000Z')).toBe(false);
    expect(canLeaseGraphExtractionJob(job, '2026-01-01T00:01:01.000Z')).toBe(true);
  });

  it('surfaces the third failed extraction in the retry queue', () => {
    const job = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    const once = failGraphExtractionJob(job, 'timeout');
    const twice = failGraphExtractionJob(once, 'timeout');
    const terminal = failGraphExtractionJob(twice, 'timeout');
    expect(terminal.retryCount).toBe(3);
    expect(terminal.status).toBe('retry');
    expect(canLeaseGraphExtractionJob(terminal, '2026-01-01T00:10:00.000Z')).toBe(false);
  });

  it('leases each job once, recovers an expired lease, and rejects stale-owner completion', () => {
    const queued = enqueueGraphExtractionJob(store(), INPUT, '2026-01-01T00:00:00.000Z');
    expect(enqueueGraphExtractionJob(store(), INPUT, '2026-01-01T01:00:00.000Z')).toMatchObject({
      idempotent: true,
      job: { id: queued.job.id, createdAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(
      claimGraphExtractionJob(store(), queued.job.id, {
        owner: 'worker-a',
        now: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:01:00.000Z',
      }),
    ).toMatchObject({ status: 'leased', lease: { owner: 'worker-a' } });
    expect(
      claimGraphExtractionJob(store(), queued.job.id, {
        owner: 'worker-b',
        now: '2026-01-01T00:00:30.000Z',
        expiresAt: '2026-01-01T00:02:00.000Z',
      }),
    ).toBeUndefined();
    expect(
      claimGraphExtractionJob(store(), queued.job.id, {
        owner: 'worker-b',
        now: '2026-01-01T00:01:00.000Z',
        expiresAt: '2026-01-01T00:02:00.000Z',
      }),
    ).toMatchObject({ status: 'leased', lease: { owner: 'worker-b' } });
    expect(completeGraphExtractionJob(store(), queued.job.id, 'worker-a')).toBeUndefined();
    expect(completeGraphExtractionJob(store(), queued.job.id, 'worker-b')).toMatchObject({
      status: 'completed',
    });
  });

  it('requires explicit requeue after the bounded failure budget', () => {
    const queued = enqueueGraphExtractionJob(store(), INPUT, '2026-01-01T00:00:00.000Z').job;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const leased = claimGraphExtractionJob(store(), queued.id, {
        owner: 'worker',
        now: `2026-01-01T00:0${attempt}:00.000Z`,
        expiresAt: `2026-01-01T00:0${attempt}:30.000Z`,
      });
      expect(leased).toMatchObject({ status: 'leased' });
      expect(
        failLeasedGraphExtractionJob(store(), queued.id, 'worker', `failure-${attempt}`),
      ).toBeDefined();
    }
    expect(retryGraphExtractionJobs(store())).toMatchObject([{ id: queued.id, retryCount: 3 }]);
    expect(
      claimGraphExtractionJob(store(), queued.id, {
        owner: 'worker',
        now: '2026-01-01T00:05:00.000Z',
        expiresAt: '2026-01-01T00:06:00.000Z',
      }),
    ).toBeUndefined();
    expect(requeueGraphExtractionJob(store(), queued.id)).toMatchObject({ status: 'pending' });
  });
});
