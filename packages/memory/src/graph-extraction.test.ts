import { describe, expect, it } from 'vitest';
import {
  buildGraphExtractionJob,
  canLeaseGraphExtractionJob,
  failGraphExtractionJob,
  isGraphExtractionStale,
} from './graph-extraction.js';

const INPUT = {
  sourceId: 'cap:0123456789abcdef',
  sourceHash: 'blake3:source-a',
  ontologyVersion: 'graph-ontology-v1',
  principalId: 'principal:alpha',
  producer: { id: 'agent:codex', version: '1.0.0' },
  idempotencyKey: 'capture:alpha:1',
} as const;

describe('graph extraction jobs', () => {
  it('deduplicates identical semantic input while keeping operational state out of the job id', () => {
    const a = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    const b = buildGraphExtractionJob(INPUT, '2026-02-01T00:00:00.000Z');
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('pending');
  });

  it('marks output stale when the capture source hash changes', () => {
    const job = buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z');
    expect(isGraphExtractionStale(job, 'blake3:source-a')).toBe(false);
    expect(isGraphExtractionStale(job, 'blake3:source-b')).toBe(true);
  });

  it('reclaims an expired lease but refuses a still-live lease', () => {
    const job = { ...buildGraphExtractionJob(INPUT, '2026-01-01T00:00:00.000Z'), status: 'leased' as const,
      lease: { owner: 'worker:a', expiresAt: '2026-01-01T00:01:00.000Z' } };
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
  });
});
