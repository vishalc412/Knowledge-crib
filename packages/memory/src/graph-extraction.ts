import { blake3Hex } from '@knowledge-crib/soul-schema';

/** The bounded retry budget for optional graph enrichment. */
export const GRAPH_EXTRACTION_MAX_ATTEMPTS = 3;

export interface GraphExtractionJobInput {
  sourceId: string;
  sourceHash: string;
  ontologyVersion: string;
  principalId: string;
  producer: { id: string; version: string };
  idempotencyKey: string;
}

export interface GraphExtractionJob extends GraphExtractionJobInput {
  id: string;
  schemaVersion: '1';
  createdAt: string;
  status: 'pending' | 'leased' | 'retry' | 'completed';
  retryCount: number;
  lease?: { owner: string; expiresAt: string };
  outcome?: { status: 'failed' | 'completed'; reason?: string };
}

function identity(input: GraphExtractionJobInput): string {
  return JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    ontologyVersion: input.ontologyVersion,
    principalId: input.principalId,
    producer: input.producer,
    sourceHash: input.sourceHash,
    sourceId: input.sourceId,
  });
}

/** Build a pending job. Operational state is deliberately excluded from the content address. */
export function buildGraphExtractionJob(
  input: GraphExtractionJobInput,
  createdAt: string,
): GraphExtractionJob {
  return {
    ...input,
    id: `gjob:${blake3Hex(identity(input))}`,
    schemaVersion: '1',
    createdAt,
    status: 'pending',
    retryCount: 0,
  };
}

/** A changed source invalidates any extraction output derived from the old content. */
export function isGraphExtractionStale(job: GraphExtractionJob, sourceHash: string): boolean {
  return job.sourceHash !== sourceHash;
}

/** Pending jobs and expired leases are eligible for a new worker; visible retry-queue jobs require
 * an explicit operator requeue so three automatic failures cannot churn indefinitely. */
export function canLeaseGraphExtractionJob(job: GraphExtractionJob, now: string): boolean {
  if (job.status === 'pending') return true;
  if (job.status !== 'leased' || job.lease === undefined) return false;
  return Date.parse(job.lease.expiresAt) <= Date.parse(now);
}

/** Record one failed attempt; failure three is surfaced as a retry-queue item. */
export function failGraphExtractionJob(
  job: GraphExtractionJob,
  reason: string,
): GraphExtractionJob {
  const retryCount = job.retryCount + 1;
  return {
    ...job,
    retryCount,
    status: retryCount >= GRAPH_EXTRACTION_MAX_ATTEMPTS ? 'retry' : 'pending',
    lease: undefined,
    outcome: { status: 'failed', reason },
  };
}
