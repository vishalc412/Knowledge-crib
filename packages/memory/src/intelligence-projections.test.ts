import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectionCheckpointStore } from './intelligence-projections.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:05.000Z';
const roots: string[] = [];

function store() {
  const rootDir = mkdtempSync(join(tmpdir(), 'knowledge-crib-projections-'));
  roots.push(rootDir);
  return new ProjectionCheckpointStore({ rootDir, now: () => T0 });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProjectionCheckpointStore', () => {
  it('publishes a current last-known-good generation after a successful projection', () => {
    const checkpoints = store();

    const checkpoint = checkpoints.recordSuccess({
      projector: 'memory-recall',
      sourceWatermark: 'iev:0002',
      pendingCount: 0,
      deadLetterCount: 0,
      replayVersion: '1',
      completedAt: T1,
    });

    expect(checkpoint).toMatchObject({
      projector: 'memory-recall',
      generation: 1,
      sourceWatermark: 'iev:0002',
      lag: 0,
      lastSuccess: T1,
      pendingCount: 0,
      deadLetterCount: 0,
      replayVersion: '1',
      status: 'current',
    });
    expect(checkpoints.read('memory-recall')).toEqual(checkpoint);
  });

  it('retains the prior readable generation when a later projection fails', () => {
    const checkpoints = store();
    checkpoints.recordSuccess({
      projector: 'memory-recall',
      sourceWatermark: 'iev:0002',
      pendingCount: 0,
      deadLetterCount: 0,
      replayVersion: '1',
      completedAt: T1,
    });

    const failed = checkpoints.recordFailure({
      projector: 'memory-recall',
      sourceWatermark: 'iev:0004',
      pendingCount: 2,
      deadLetterCount: 1,
      replayVersion: '1',
      error: 'embedding model unavailable',
      failedAt: '2026-01-01T00:00:10.000Z',
    });

    expect(failed).toMatchObject({
      generation: 1,
      sourceWatermark: 'iev:0002',
      lag: 2,
      lastSuccess: T1,
      lastError: 'embedding model unavailable',
      pendingCount: 2,
      deadLetterCount: 1,
      status: 'failed',
    });
  });
});
