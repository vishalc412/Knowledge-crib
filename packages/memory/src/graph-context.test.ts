import { describe, expect, it } from 'vitest';
import { GRAPH_DEFAULT_CONTEXT_TOKENS, assembleGraphContext } from './graph-context.js';
import { projectGraph } from './graph-projection.js';
import { expandFromSeeds } from './graph-retrieval.js';
import { createGraphAssertion } from './graph.js';
import type { MemoryGraphPredicate } from './graph.js';
import type { GraphAssertion } from './types.js';

const ALPHA = 'principal:alpha';
const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-05T00:00:00.000Z';
const T3 = '2026-09-10T00:00:00.000Z';

function edge(
  predicate: MemoryGraphPredicate,
  subject: string,
  object: string,
  supportedBy: string[],
  at = T1,
  actorId = 'agent:context-test',
): GraphAssertion {
  return createGraphAssertion({
    predicate,
    subject,
    object,
    namespace: { principalId: ALPHA },
    scope: { boundary: 'global' },
    validAt: at,
    knownAt: at,
    supportedBy,
    provenance: {
      principalId: ALPHA,
      deviceId: 'device:context-test',
      actorId,
      clientId: 'vitest',
    },
  });
}

const RECORDS = ['mem:d1', 'mem:d2', 'mem:shared', 'mem:late'].map((id) => ({ id }));
const VIEWER = { principalId: ALPHA, scope: { boundary: 'global' as const } };

describe('assembleGraphContext', () => {
  it('lists a supporting record once however many paths rest on it', () => {
    const a = edge('about', 'mem:d1', 'topic:retry', ['mem:shared']);
    const b = edge('applies-to', 'mem:d1', 'sym:ledger#settle', ['mem:shared'], T1, 'agent:other');
    const projection = projectGraph({ assertions: [a, b], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:d1', score: 1, channel: 'explicit' },
    ]);

    const pack = assembleGraphContext(projection, expansion);

    expect(pack.items.map((i) => i.ref)).toEqual(expansion.expansions.map((e) => e.ref));
    expect(pack.items[0]).toMatchObject({ ref: 'mem:d1', origin: 'seed', path: [] });
    expect(pack.items.slice(1).every((i) => i.origin === 'connected')).toBe(true);
    expect(pack.evidence).toHaveLength(1);
    expect(pack.evidence[0]?.ref).toBe('mem:shared');
    expect(pack.evidence[0]?.assertionIds).toEqual([a.id, b.id].sort());
    expect(pack.evidence[0]?.producers.map((p) => p.actorId)).toEqual([
      'agent:context-test',
      'agent:other',
    ]);
    expect(pack.traversal).toEqual(expansion.report);
    expect(pack.budgetTokens).toBe(GRAPH_DEFAULT_CONTEXT_TOKENS);
    expect(pack.degraded).toEqual([]);
  });

  it('carries every side of a disagreement the pack touches, and none it does not', () => {
    const thirty = edge('about', 'mem:d1', 'topic:window-30s', ['mem:d1']);
    const sixty = edge('about', 'mem:d1', 'topic:window-60s', ['mem:d2']);
    const unrelatedA = edge('about', 'mem:late', 'topic:x', ['mem:late']);
    const unrelatedB = edge('about', 'mem:late', 'topic:y', ['mem:late']);
    const projection = projectGraph(
      { assertions: [thirty, sixty, unrelatedA, unrelatedB], records: RECORDS },
      VIEWER,
    );
    // Seed ONE side at zero hops: the pack still says a disagreement exists.
    const expansion = expandFromSeeds(
      projection,
      [{ ref: 'topic:window-30s', score: 1, channel: 'explicit' }],
      { hops: 0 },
    );

    const pack = assembleGraphContext(projection, expansion);

    expect(pack.conflicts).toHaveLength(1);
    expect(pack.conflicts[0]?.assertionIds).toEqual([thirty.id, sixty.id].sort());
    expect(pack.conflicts[0]?.objects).toEqual(['topic:window-30s', 'topic:window-60s']);
  });

  it('labels assertions outside the current window as historical, never as current items', () => {
    const before = edge('about', 'mem:d1', 'topic:retry', ['mem:d1'], T1);
    const after = edge('supersedes', 'mem:d2', 'mem:d1', ['mem:d2'], T3);
    const projection = projectGraph({ assertions: [before, after], records: RECORDS }, VIEWER, {
      at: T2,
    });
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:d1', score: 1, channel: 'explicit' },
    ]);

    const pack = assembleGraphContext(projection, expansion);

    expect(pack.items.flatMap((i) => i.path.map((s) => s.assertionId))).not.toContain(after.id);
    expect(pack.historical).toEqual([
      {
        assertionId: after.id,
        predicate: 'supersedes',
        subject: 'mem:d2',
        object: 'mem:d1',
        validAt: T3,
        knownAt: T3,
        supportedBy: ['mem:d2'],
        reason: 'not-in-current-view',
      },
    ]);
    expect(
      assembleGraphContext(projection, expansion, { includeHistorical: false }).historical,
    ).toEqual([]);
  });

  it('never cites an assertion the viewer cannot see', () => {
    const mine = edge('about', 'mem:d1', 'topic:retry', ['mem:d1']);
    const foreign = createGraphAssertion({
      predicate: 'about',
      subject: 'mem:d1',
      object: 'topic:beta-secret',
      namespace: { principalId: 'principal:beta' },
      scope: { boundary: 'global' },
      validAt: T1,
      knownAt: T1,
      supportedBy: ['mem:d1'],
      provenance: {
        principalId: 'principal:beta',
        deviceId: 'device:beta',
        actorId: 'agent:beta',
        clientId: 'vitest',
      },
    });
    const projection = projectGraph({ assertions: [mine, foreign], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:d1', score: 1, channel: 'explicit' },
    ]);

    const pack = assembleGraphContext(projection, expansion, {
      budgetTokens: 500,
      degraded: ['semantic-channel-unavailable'],
    });

    expect(JSON.stringify(pack)).not.toContain('beta');
    expect(pack.budgetTokens).toBe(500);
    expect(pack.degraded).toEqual(['semantic-channel-unavailable']);
  });

  it('is deterministic for the same projection and expansion', () => {
    const a = edge('about', 'mem:d1', 'topic:retry', ['mem:shared']);
    const b = edge('about', 'mem:d2', 'topic:retry', ['mem:d2']);
    const projection = projectGraph({ assertions: [b, a], records: RECORDS }, VIEWER);
    const seeds = [
      { ref: 'mem:d2', score: 0.4, channel: 'semantic' as const },
      { ref: 'mem:d1', score: 0.9, channel: 'lexical' as const },
    ];
    const first = assembleGraphContext(projection, expandFromSeeds(projection, seeds));
    const second = assembleGraphContext(
      projectGraph({ assertions: [a, b], records: RECORDS }, VIEWER),
      expandFromSeeds(projection, [...seeds].reverse()),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
