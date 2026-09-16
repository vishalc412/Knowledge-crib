/**
 * Durable machine-local queue for optional graph enrichment.
 *
 * This module owns operational state only. A completed job is never itself an admitted graph
 * assertion: callers must separately validate scope, evidence, authorization, and source hash
 * before submitting any proposed graph entries.
 */
import {
  type GraphExtractionJobInput,
  buildGraphExtractionJob,
  canLeaseGraphExtractionJob,
  failGraphExtractionJob,
} from './graph-extraction.js';
import { memoryShard } from './ids.js';
import type { MemoryStore } from './store.js';
import type { GraphExtractionJob } from './types.js';

/** Read one durable job by content-addressed id. */
export function readGraphExtractionJob(
  store: MemoryStore,
  id: string,
): GraphExtractionJob | undefined {
  return store.readShard('graph-jobs', memoryShard(id)).entries.find((entry) => entry.id === id) as
    | GraphExtractionJob
    | undefined;
}

/** Read the visible terminal retry queue in deterministic order. */
export function retryGraphExtractionJobs(store: MemoryStore): GraphExtractionJob[] {
  return (store.readCollection('graph-jobs').entries as GraphExtractionJob[])
    .filter((job) => job.status === 'retry')
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Enqueue once. The immutable semantic identity includes the source hash, ontology, principal and
 * producer, so duplicate delivery collapses while a changed source becomes a distinct work item.
 */
export function enqueueGraphExtractionJob(
  store: MemoryStore,
  input: GraphExtractionJobInput,
  createdAt: string,
): { job: GraphExtractionJob; idempotent: boolean } {
  const job = buildGraphExtractionJob(input, createdAt);
  return store.withLock(() => {
    const existing = readGraphExtractionJob(store, job.id);
    if (existing !== undefined) return { job: existing, idempotent: true };
    store.upsertEntry('graph-jobs', job);
    return { job, idempotent: false };
  });
}

/** Atomically lease an eligible pending or expired job to one worker. */
export function claimGraphExtractionJob(
  store: MemoryStore,
  id: string,
  opts: { owner: string; now: string; expiresAt: string },
): GraphExtractionJob | undefined {
  return store.updateGraphExtractionJob(id, (current) => {
    if (!canLeaseGraphExtractionJob(current, opts.now)) return undefined;
    return {
      ...current,
      status: 'leased',
      lease: { owner: opts.owner, expiresAt: opts.expiresAt },
      outcome: undefined,
    };
  });
}

/** Complete only the lease held by `owner`; an expired or stolen lease cannot acknowledge work. */
export function completeGraphExtractionJob(
  store: MemoryStore,
  id: string,
  owner: string,
): GraphExtractionJob | undefined {
  return store.updateGraphExtractionJob(id, (current) => {
    if (current.status !== 'leased' || current.lease?.owner !== owner) return undefined;
    return {
      ...current,
      status: 'completed',
      lease: undefined,
      outcome: { status: 'completed' },
    };
  });
}

/** Record a failed lease attempt, surfacing the job after the bounded retry budget is exhausted. */
export function failLeasedGraphExtractionJob(
  store: MemoryStore,
  id: string,
  owner: string,
  reason: string,
): GraphExtractionJob | undefined {
  return store.updateGraphExtractionJob(id, (current) => {
    if (current.status !== 'leased' || current.lease?.owner !== owner) return undefined;
    return failGraphExtractionJob(current, reason);
  });
}

/** An operator explicitly returns a visible terminal retry item to the pending queue. */
export function requeueGraphExtractionJob(
  store: MemoryStore,
  id: string,
): GraphExtractionJob | undefined {
  return store.updateGraphExtractionJob(id, (current) => {
    if (current.status !== 'retry') return undefined;
    return { ...current, status: 'pending', outcome: undefined };
  });
}
