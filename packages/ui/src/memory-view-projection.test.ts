import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { vizAssetsDir } from './viz.js';

type HealthSignal = {
  label: string;
  status: string;
  showSnapshot?: boolean;
  revision?: string;
  lastSuccess?: string;
  explanation: string;
};
type MemoryView = {
  healthSignals: (health: Record<string, unknown>) => HealthSignal[];
  ledgerRow: (row: Record<string, unknown>) => {
    subject: string;
    preview: string;
    status: string;
    timeLabel: string;
    time: string;
    nextAction: string;
  };
};

function projection(): MemoryView {
  const context: Record<string, unknown> = {};
  context.globalThis = context;
  runInNewContext(readFileSync(`${vizAssetsDir()}/memory-view-projection.js`, 'utf8'), context);
  return context.KCMemoryViewProjection as MemoryView;
}

describe('memory display projection', () => {
  it('keeps published index and reader snapshot states distinct', () => {
    const signals = projection().healthSignals({
      codeIndex: {
        checkedRevision: 'a'.repeat(40),
        lastSuccessfulAt: '2026-09-22T10:00:00.000Z',
        behindHead: false,
      },
      readerFreshness: {
        indexedHead: 'b'.repeat(40),
        currentHead: 'a'.repeat(40),
        stale: true,
        staleReasons: ['committed-behind'],
        lastSuccessfulRefreshAt: '2026-09-21T09:00:00.000Z',
      },
    });
    expect(signals.find((signal) => signal.label === 'Published index')).toMatchObject({
      status: 'Current',
      revision: 'a'.repeat(40),
      lastSuccess: '2026-09-22T10:00:00.000Z',
    });
    expect(signals.find((signal) => signal.label === 'Reader snapshot')).toMatchObject({
      status: 'Stale',
      revision: 'b'.repeat(40),
      lastSuccess: '2026-09-21T09:00:00.000Z',
    });
  });

  it('explains lexical retrieval and local-only sync without implying failure', () => {
    const signals = projection().healthSignals({
      retrieval: { mode: 'lexical-fallback', reason: 'No model installed' },
      sync: { configured: false },
    });
    expect(signals.find((signal) => signal.label === 'Retrieval')?.explanation).toContain(
      'keyword',
    );
    expect(signals.find((signal) => signal.label === 'Sync')?.explanation).toContain('local');
  });

  it('makes missing health checks explicit instead of silently omitting them', () => {
    const signals = projection().healthSignals({});
    for (const label of ['Published index', 'Reader snapshot']) {
      const signal = signals.find((item) => item.label === label);
      expect(signal).toMatchObject({
        status: 'Unknown',
        showSnapshot: true,
        revisionLabel: 'unavailable',
        lastSuccessLabel: 'not recorded',
      });
      expect(signal?.explanation).toContain('unavailable');
    }
  });

  it('makes a short one-line preview without losing the original claim on detail', () => {
    const fullClaim = 'Normalize input '.repeat(30);
    const row = projection().ledgerRow({
      id: 'mem:technical-id',
      subject: 'normalizeInput',
      claim: fullClaim,
      group: 'active',
      recordedAt: '2026-09-23T11:00:00.000Z',
    });
    expect(row.subject).toBe('normalizeInput');
    expect(row.preview.length).toBeLessThan(fullClaim.length);
    expect(row.preview.endsWith('…')).toBe(true);
    expect(row.status).toBe('Active');
    expect(row.timeLabel).toBe('Recorded');
    expect(row.time).toContain('2026-09-23');
    expect(row.nextAction).toBe('Inspect claim');
    expect(JSON.stringify(row)).not.toContain('mem:technical-id');
  });
});
