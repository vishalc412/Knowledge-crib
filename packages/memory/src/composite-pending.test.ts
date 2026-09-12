/**
 * The memory graph shows a write the moment it happens.
 *
 * `memoryComposite` used to project only recall-eligible records, so a freshly observed claim —
 * staged, not yet admitted — had no link to the code it is about. These tests pin the additive
 * options: pending candidates become `status: 'pending'` nodes labelled untrusted, and loose
 * `appliesTo` targets (file paths) resolve to the soul ids the graph merger can keep.
 */
import { describe, expect, it } from 'vitest';
import { memoryComposite } from './composite.js';
import type { RecallProjection } from './recall.js';
import type { MemoryCandidate } from './types.js';

const EMPTY = { memories: [], conflicts: [] } as unknown as RecallProjection;

function candidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 'cand:aa',
    schemaVersion: '1',
    kind: 'fact',
    subject: 'sym:src/team.ts#Team.displayNumber@L10',
    claim: 'Team.displayNumber returns the cached value',
    scope: { boundary: 'repo', repoId: 'r' },
    appliesTo: ['src/team.ts'],
    evidence: [
      {
        kind: 'source-quote',
        verdict: 'valid',
        checkedAt: '2026-09-11T00:00:00.000Z',
        soulId: 'stmt:src/team.ts@L12',
        quote: 'return this.cached;',
      },
    ],
    authorship: { actor: 'claude-code', kind: 'agent' },
    origin: 'observe',
    proposedAt: '2026-09-11T00:00:00.000Z',
    ...over,
  } as MemoryCandidate;
}

describe('memoryComposite — pending candidates', () => {
  it('projects a staged candidate as an untrusted pending node', () => {
    const { nodes } = memoryComposite(EMPTY, { pending: [candidate()] });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: 'cand:aa',
      kind: 'memory',
      origin: 'memory',
      status: 'pending',
      trust: 'untrusted',
    });
  });

  it('links the candidate to its cited evidence and its (resolved) targets', () => {
    const { edges } = memoryComposite(EMPTY, {
      pending: [candidate()],
      resolveTarget: (t) => (t === 'src/team.ts' ? 'file:src/team.ts' : undefined),
    });
    expect(edges.map((e) => [e.rel, e.dst]).sort()).toEqual([
      ['applies-to', 'file:src/team.ts'],
      ['supported-by', 'stmt:src/team.ts@L12'],
    ]);
  });

  it('keeps an unresolvable target as written (the merger decides whether it survives)', () => {
    const { edges } = memoryComposite(EMPTY, {
      pending: [candidate({ appliesTo: ['src/gone.ts'] })],
      resolveTarget: () => undefined,
    });
    expect(edges.find((e) => e.rel === 'applies-to')?.dst).toBe('src/gone.ts');
  });

  it('collapses a path target and its id to one edge', () => {
    const { edges } = memoryComposite(EMPTY, {
      pending: [candidate({ appliesTo: ['src/team.ts', 'file:src/team.ts'] })],
      resolveTarget: (t) => (t === 'src/team.ts' ? 'file:src/team.ts' : t),
    });
    expect(edges.filter((e) => e.rel === 'applies-to')).toHaveLength(1);
  });

  it('is deterministic regardless of candidate order', () => {
    const a = candidate({ id: 'cand:aa' });
    const b = candidate({ id: 'cand:bb', claim: 'other' });
    expect(memoryComposite(EMPTY, { pending: [a, b] })).toEqual(
      memoryComposite(EMPTY, { pending: [b, a] }),
    );
  });
});
