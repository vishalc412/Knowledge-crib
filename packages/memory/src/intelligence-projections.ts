/**
 * Checkpoints for replayable intelligence-event projectors.
 *
 * A checkpoint is derived state, never a replacement for the append-only event journal. The
 * current checkpoint is atomically published only after a successful projector run; a failure
 * reports its error and backlog while retaining the preceding readable generation.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FreshnessStatus = 'not-started' | 'current' | 'lagging' | 'failed';

export interface ProjectionCheckpoint {
  schemaVersion: '1';
  projector: string;
  /** Last successfully published materialization generation. */
  generation: number;
  /** Event ID/watermark incorporated by that last successful generation. */
  sourceWatermark?: string;
  /** Events not yet represented by the last-known-good generation. */
  lag: number;
  lastSuccess?: string;
  lastFailure?: string;
  lastError?: string;
  pendingCount: number;
  deadLetterCount: number;
  replayVersion: string;
  status: FreshnessStatus;
}

export interface ProjectionCheckpointStoreOptions {
  rootDir: string;
  now?: () => string;
}

export interface ProjectionSuccessInput {
  projector: string;
  sourceWatermark?: string;
  pendingCount: number;
  deadLetterCount: number;
  replayVersion: string;
  completedAt?: string;
}

export interface ProjectionFailureInput {
  projector: string;
  /** The newest source observed by the failed attempt; it is not published as success watermark. */
  sourceWatermark?: string;
  pendingCount: number;
  deadLetterCount: number;
  replayVersion: string;
  error: string;
  failedAt?: string;
}

const CHECKPOINT_FILE = 'projection-checkpoints.json';

export class ProjectionCheckpointStore {
  private readonly rootDir: string;
  private readonly nowFn: () => string;

  constructor(options: ProjectionCheckpointStoreOptions) {
    this.rootDir = options.rootDir;
    this.nowFn = options.now ?? (() => new Date().toISOString());
  }

  read(): ProjectionCheckpoint[];
  read(projector: string): ProjectionCheckpoint | undefined;
  read(projector?: string): ProjectionCheckpoint | ProjectionCheckpoint[] | undefined {
    const all = this.readAll();
    if (projector === undefined)
      return Object.values(all).sort((a, b) => a.projector.localeCompare(b.projector));
    return all[projector];
  }

  recordSuccess(input: ProjectionSuccessInput): ProjectionCheckpoint {
    validateInput(input.projector, input.pendingCount, input.deadLetterCount, input.replayVersion);
    const all = this.readAll();
    const prior = all[input.projector];
    const checkpoint: ProjectionCheckpoint = {
      schemaVersion: '1',
      projector: input.projector,
      generation: (prior?.generation ?? 0) + 1,
      ...(input.sourceWatermark !== undefined ? { sourceWatermark: input.sourceWatermark } : {}),
      lag: input.pendingCount,
      lastSuccess: input.completedAt ?? this.nowFn(),
      pendingCount: input.pendingCount,
      deadLetterCount: input.deadLetterCount,
      replayVersion: input.replayVersion,
      status: input.pendingCount === 0 && input.deadLetterCount === 0 ? 'current' : 'lagging',
    };
    this.publish({ ...all, [checkpoint.projector]: checkpoint });
    return checkpoint;
  }

  recordFailure(input: ProjectionFailureInput): ProjectionCheckpoint {
    validateInput(input.projector, input.pendingCount, input.deadLetterCount, input.replayVersion);
    if (input.error.trim().length === 0) throw new Error('projection failure error is required');
    const all = this.readAll();
    const prior = all[input.projector];
    // Do not advance the published generation or source watermark here: callers can continue using
    // the previous materialization and replay this attempt deterministically from its checkpoint.
    const checkpoint: ProjectionCheckpoint = {
      schemaVersion: '1',
      projector: input.projector,
      generation: prior?.generation ?? 0,
      ...(prior?.sourceWatermark !== undefined ? { sourceWatermark: prior.sourceWatermark } : {}),
      lag: input.pendingCount,
      ...(prior?.lastSuccess !== undefined ? { lastSuccess: prior.lastSuccess } : {}),
      lastFailure: input.failedAt ?? this.nowFn(),
      lastError: input.error,
      pendingCount: input.pendingCount,
      deadLetterCount: input.deadLetterCount,
      replayVersion: input.replayVersion,
      status: 'failed',
    };
    this.publish({ ...all, [checkpoint.projector]: checkpoint });
    return checkpoint;
  }

  private path(): string {
    return join(this.rootDir, CHECKPOINT_FILE);
  }

  private readAll(): Record<string, ProjectionCheckpoint> {
    if (!existsSync(this.path())) return {};
    const parsed: unknown = JSON.parse(readFileSync(this.path(), 'utf8'));
    if (!isCheckpointMap(parsed)) throw new Error('invalid projection checkpoint store');
    return parsed;
  }

  private publish(checkpoints: Record<string, ProjectionCheckpoint>): void {
    mkdirSync(this.rootDir, { recursive: true });
    const target = this.path();
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(checkpoints, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
  }
}

function validateInput(
  projector: string,
  pendingCount: number,
  deadLetterCount: number,
  replayVersion: string,
): void {
  if (!/^[a-z][a-z0-9._-]*$/i.test(projector)) throw new Error('invalid projector name');
  if (!Number.isInteger(pendingCount) || pendingCount < 0)
    throw new Error('pendingCount must be a non-negative integer');
  if (!Number.isInteger(deadLetterCount) || deadLetterCount < 0) {
    throw new Error('deadLetterCount must be a non-negative integer');
  }
  if (replayVersion.trim().length === 0) throw new Error('replayVersion is required');
}

function isCheckpointMap(value: unknown): value is Record<string, ProjectionCheckpoint> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isCheckpoint);
}

function isCheckpoint(value: unknown): value is ProjectionCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectionCheckpoint>;
  return (
    candidate.schemaVersion === '1' &&
    typeof candidate.projector === 'string' &&
    Number.isInteger(candidate.generation) &&
    typeof candidate.lag === 'number' &&
    typeof candidate.pendingCount === 'number' &&
    typeof candidate.deadLetterCount === 'number' &&
    typeof candidate.replayVersion === 'string' &&
    ['not-started', 'current', 'lagging', 'failed'].includes(candidate.status ?? '')
  );
}
