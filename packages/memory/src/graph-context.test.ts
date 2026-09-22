import { describe, expect, it } from 'vitest';
import {
  GRAPH_DEFAULT_CONTEXT_TOKENS,
  assembleGraphContext,
  buildGraphContextPack,
} from './graph-context.js';
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
const seed = (ref: string) => ({ ref, score: 1, channel: 'explicit' as const });

describe('assembleGraphContext', () => {
  it('lists each cited assertion and producer once however many paths cross them', () => {
    const a = edge('about', 'mem:d1', 'topic:retry', ['mem:shared']);
    const b = edge('applies-to', 'mem:d1', 'sym:ledger#settle', ['mem:shared'], T1, 'agent:other');
    const c = edge('affects', 'topic:retry', 'sym:ledger#settle', ['mem:shared']);
    const projection = projectGraph({ assertions: [a, b, c], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [seed('mem:d1')]);

    const pack = assembleGraphContext(projection, expansion);

    expect(pack.items.map((i) => i.ref)).toEqual(expansion.expansions.map((e) => e.ref));
    expect(pack.items[0]).toMatchObject({ ref: 'mem:d1', distance: 0, path: [] });
    expect(pack.assertions.map((x) => x.id)).toEqual([a.id, b.id, c.id].sort());
    expect(new Set(pack.assertions.map((x) => x.id)).size).toBe(pack.assertions.length);
    expect(pack.producers.map((p) => p.actorId)).toEqual(
      expect.arrayContaining(['agent:context-test', 'agent:other']),
    );
    expect(pack.producers).toHaveLength(2);
    expect(pack.traversal).toEqual(expansion.report);
    expect(pack.budgetTokens).toBe(GRAPH_DEFAULT_CONTEXT_TOKENS);
    expect(pack.degraded).toEqual([]);
  });

  it('cites the relation between two items that were both retrieved directly', () => {
    const link = edge('about', 'mem:d1', 'topic:retry', ['mem:d1']);
    const projection = projectGraph({ assertions: [link], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [seed('mem:d1'), seed('topic:retry')]);

    const pack = assembleGraphContext(projection, expansion);

    expect(pack.items.every((i) => i.path.length === 0)).toBe(true);
    expect(pack.relations).toEqual([link.id]);
    expect(pack.assertions.map((x) => x.id)).toEqual([link.id]);
  });

  it('carries every side of an explicit contradiction the pack touches', () => {
    const thirty = edge('contradicts', 'mem:d1', 'mem:d2', ['mem:d1']);
    const sixty = edge('contradicts', 'mem:d2', 'mem:d1', ['mem:d2']);
    const projection = projectGraph({ assertions: [thirty, sixty], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [seed('mem:d1')], { hops: 0 });

    const pack = assembleGraphContext(projection, expansion);

    expect(pack.conflicts).toEqual([
      {
        subject: 'mem:d1',
        predicate: 'contradicts',
        objects: ['mem:d1', 'mem:d2'],
        assertionIds: [thirty.id, sixty.id].sort(),
      },
    ]);
    expect(pack.assertions.map((x) => x.id)).toEqual([thirty.id, sixty.id].sort());
  });

  it('labels history as historical — valid-later assertions and superseded supporters alike', () => {
    const before = edge('about', 'mem:d1', 'topic:retry', ['mem:d1'], T1);
    const after = edge('supersedes', 'mem:d2', 'mem:d1', ['mem:d2'], T3);
    const projection = projectGraph({ assertions: [before, after], records: RECORDS }, VIEWER, {
      at: T2,
    });
    const pack = assembleGraphContext(projection, expandFromSeeds(projection, [seed('mem:d1')]));

    expect(pack.items.flatMap((i) => i.path)).not.toContain(after.id);
    expect(pack.assertions.find((x) => x.id === after.id)?.status).toBe('historical');
    expect(pack.assertions.find((x) => x.id === before.id)?.status).toBe('current');
    const without = assembleGraphContext(
      projection,
      expandFromSeeds(projection, [seed('mem:d1')]),
      {
        includeHistorical: false,
      },
    );
    expect(without.assertions.map((x) => x.id)).not.toContain(after.id);

    const superseded = projectGraph(
      {
        assertions: [before],
        records: RECORDS.filter((r) => r.id !== 'mem:d1'),
        historicalRecords: [{ id: 'mem:d1' }],
      },
      VIEWER,
    );
    const history = buildGraphContextPack(
      superseded,
      expandFromSeeds(superseded, [seed('mem:d1')]).expansions,
      expandFromSeeds(superseded, [seed('mem:d1')]).report,
    );
    expect(history.items[0]).toMatchObject({ ref: 'mem:d1', state: 'historical' });
    expect(history.assertions).toEqual([
      expect.objectContaining({ id: before.id, status: 'historical' }),
    ]);
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
    const pack = assembleGraphContext(projection, expandFromSeeds(projection, [seed('mem:d1')]), {
      budgetTokens: 500,
      degraded: ['semantic-channel-unavailable'],
    });

    expect(JSON.stringify(pack)).not.toContain('beta');
    expect(pack.budgetTokens).toBe(500);
    expect(pack.degraded).toEqual(['semantic-channel-unavailable']);
  });

  it('derives everything from the kept items, so a trimmed prefix stays coherent', () => {
    const a = edge('about', 'mem:d1', 'topic:retry', ['mem:shared']);
    const b = edge('about', 'mem:d2', 'topic:window', ['mem:d2']);
    const projection = projectGraph({ assertions: [a, b], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:d1', score: 0.9, channel: 'lexical' },
      { ref: 'mem:d2', score: 0.1, channel: 'lexical' },
    ]);
    const prefix = expansion.expansions.filter((e) => e.seedRef === 'mem:d1');

    const trimmed = buildGraphContextPack(projection, prefix, expansion.report);

    expect(trimmed.assertions.map((x) => x.id)).toEqual([a.id]);
    expect(JSON.stringify(trimmed)).not.toContain('topic:window');
  });

  it('S3 defense-in-depth: itemEligible drops an expansion before the pack is derived', () => {
    // The expansion layer already filters arrivals by the same set; this test pins the pack
    // builder's own guarantee — even handed UNFILTERED expansions, it never cites a relation,
    // history entry or conflict that touches an ineligible item.
    const a = edge('about', 'mem:d1', 'topic:retry', ['mem:shared']);
    const b = edge('about', 'mem:d2', 'topic:window', ['mem:d2']);
    const projection = projectGraph({ assertions: [a, b], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:d1', score: 0.9, channel: 'lexical' },
      { ref: 'mem:d2', score: 0.1, channel: 'lexical' },
    ]);
    expect(expansion.expansions).toHaveLength(4);

    const filtered = buildGraphContextPack(projection, expansion.expansions, expansion.report, {
      itemEligible: new Set(['mem:d1', 'topic:retry']),
    });
    const total = buildGraphContextPack(projection, expansion.expansions, expansion.report);

    expect(filtered.items.map((i) => i.ref)).toEqual(['mem:d1', 'topic:retry']);
    expect(filtered.assertions.map((x) => x.id)).toEqual([a.id]);
    expect(JSON.stringify(filtered)).not.toContain('topic:window');
    expect(total.items).toHaveLength(4);
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

describe('buildGraphContextPack citedAssertionIds (S5 completion citations)', () => {
  it("states a trimmed partner's connection with its supporters and producer, without adding the item", () => {
    const link = edge('about', 'mem:d1', 'topic:retry', ['mem:shared']);
    const applies = edge(
      'applies-to',
      'mem:d1',
      'sym:ledger#settle',
      ['mem:shared'],
      T1,
      'agent:other',
    );
    const projection = projectGraph({ assertions: [link, applies], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [seed('mem:d1')]);
    // The budget fit kept only the seeded record; both connection endpoints were trimmed.
    const prefix = expansion.expansions.filter((e) => e.ref === 'mem:d1');

    const pack = buildGraphContextPack(projection, prefix, expansion.report, {
      citedAssertionIds: [link.id, applies.id],
    });

    expect(pack.items.map((i) => i.ref)).toEqual(['mem:d1']);
    expect(pack.relations).toEqual([]);
    expect(pack.assertions.map((x) => x.id)).toEqual([link.id, applies.id].sort());
    for (const assertion of pack.assertions) {
      expect(assertion.status).toBe('current');
      expect(assertion.supportedBy).toEqual(['mem:shared']);
    }
    expect(pack.producers).toHaveLength(2);
    expect(new Set(pack.producers.map((p) => p.actorId))).toEqual(
      new Set(['agent:context-test', 'agent:other']),
    );
  });

  it('never duplicates an id another channel already cited, and ignores ids the view cannot resolve', () => {
    const link = edge('about', 'mem:d1', 'topic:retry', ['mem:d1']);
    const projection = projectGraph({ assertions: [link], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [seed('mem:d1'), seed('topic:retry')]);
    // Both endpoints are kept, so the relation channel already cites the link once.

    const pack = buildGraphContextPack(projection, expansion.expansions, expansion.report, {
      citedAssertionIds: [link.id, 'assertion:unknown-in-this-view'],
    });

    expect(pack.relations).toEqual([link.id]);
    expect(pack.assertions).toHaveLength(1);
    expect(pack.assertions[0]?.id).toBe(link.id);
    expect(pack.producers).toHaveLength(1);
    expect(JSON.stringify(pack)).not.toContain('unknown-in-this-view');
  });

  it('cites an assertion the view only holds as history, labelling it historical', () => {
    const before = edge('about', 'mem:d1', 'topic:retry', ['mem:d1'], T1);
    const superseded = projectGraph(
      {
        assertions: [before],
        records: RECORDS.filter((r) => r.id !== 'mem:d1'),
        historicalRecords: [{ id: 'mem:d1' }],
      },
      VIEWER,
    );
    const report = expandFromSeeds(superseded, [seed('mem:d1')]).report;

    const pack = buildGraphContextPack(superseded, [], report, {
      citedAssertionIds: [before.id],
    });

    expect(pack.items).toEqual([]);
    expect(pack.assertions).toEqual([
      expect.objectContaining({ id: before.id, status: 'historical', supportedBy: ['mem:d1'] }),
    ]);
    expect(pack.producers.map((p) => p.actorId)).toEqual(['agent:context-test']);
  });
});
