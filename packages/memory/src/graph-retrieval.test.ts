/**
 * WP-G5 — connected retrieval laws (the plan's WP-G5 items 1–4 and the §2 traversal defaults):
 *
 *   - expansion runs over the AUTHORIZED projection only: a seed naming a foreign principal's ref
 *     reaches nothing, because nothing foreign is in `current` to traverse;
 *   - the traversal budget is fixed and honest: two hops by default and four maximum, at most 200
 *     nodes and 500 edges, and every bound that BITES is named in `truncationReasons` — a short
 *     list with `truncated:false` is the only statement that the neighbourhood was exhausted;
 *   - ranking is deterministic: seed relevance decayed per hop, multiplied by evidence
 *     eligibility, ordered (rank desc, distance asc, ref asc) — shuffling the inputs cannot
 *     change the output order, and a node reachable from two seeds takes its best claim;
 *   - the text-search score and the graph explanation stay DISTINCT (item 4): `seedScore` is the
 *     retriever's own number, carried through untouched, and `rank`/`path` are the graph's — the
 *     module never folds one into the other or presents either as calibrated confidence;
 *   - a conflict is not resolved here: two assertions that disagree both stay traversable, so both
 *     of their objects appear in the expansion.
 */
import { describe, expect, it } from 'vitest';
import { projectGraph } from './graph-projection.js';
import type { GraphProjection } from './graph-projection.js';
import {
  GRAPH_DEFAULT_HOPS,
  GRAPH_HOP_DECAY,
  GRAPH_INELIGIBLE_EVIDENCE_FACTOR,
  GRAPH_MAX_EXAMINED_EDGES,
  GRAPH_MAX_VISITED_NODES,
  expandFromSeeds,
} from './graph-retrieval.js';
import type { GraphSeed } from './graph-retrieval.js';
import { createGraphAssertion } from './graph.js';
import type { MemoryGraphPredicate } from './graph.js';
import type { GraphAssertion, MemoryProvenance, MemoryScope } from './types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const P1 = 'principal:p1';
const P2 = 'principal:p2';
const GLOBAL: MemoryScope = { boundary: 'global' };
const SUPPORTER = 'mem:supporter';

function provenance(principalId: string): MemoryProvenance {
  return {
    principalId,
    deviceId: 'device:retrieval-test',
    actorId: 'agent:retrieval-test',
    clientId: 'vitest',
  };
}

function assertion(input: {
  subject: string;
  object: string;
  predicate?: MemoryGraphPredicate;
  principalId?: string;
  supportedBy?: string[];
}): GraphAssertion {
  const principalId = input.principalId ?? P1;
  return createGraphAssertion({
    predicate: input.predicate ?? 'about',
    subject: input.subject,
    object: input.object,
    namespace: { principalId },
    scope: GLOBAL,
    validAt: T0,
    knownAt: T1,
    supportedBy: input.supportedBy ?? [SUPPORTER],
    provenance: provenance(principalId),
  });
}

function project(assertions: GraphAssertion[], principalId = P1): GraphProjection {
  const supporters = new Set<string>();
  for (const a of assertions) for (const ref of a.supportedBy) supporters.add(ref);
  return projectGraph(
    { assertions, records: [...supporters].map((id) => ({ id })) },
    { principalId, scope: GLOBAL },
  );
}

function seed(ref: string, score = 1, channel: GraphSeed['channel'] = 'lexical'): GraphSeed {
  return { ref, score, channel };
}

/** A chain topic:a — topic:b — topic:c — topic:d, one `about` edge per link. */
const CHAIN = [
  assertion({ subject: 'topic:a', object: 'topic:b' }),
  assertion({ subject: 'topic:b', object: 'topic:c' }),
  assertion({ subject: 'topic:c', object: 'topic:d' }),
];

// ─── traversal budget (item 2 + §2 defaults) ──────────────────────────────────

describe('WP-G5 connected retrieval — the traversal budget is fixed and reported', () => {
  it('expands two hops by DEFAULT and names the hop bound that stopped it', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a')]);

    expect(result.report.budget.hops).toBe(GRAPH_DEFAULT_HOPS);
    expect(result.expansions.map((e) => e.ref)).toEqual(['topic:a', 'topic:b', 'topic:c']);
    // topic:d is one hop further than the default allows — the walk is a PAGE, and says so.
    expect(result.report.truncated).toBe(true);
    expect(result.report.truncationReasons).toEqual(['hops']);
  });

  it('exhausts the neighbourhood without truncation when the budget covers it', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a')], { hops: 4 });

    expect(result.expansions.map((e) => e.ref)).toEqual([
      'topic:a',
      'topic:b',
      'topic:c',
      'topic:d',
    ]);
    expect(result.report.truncated).toBe(false);
    expect(result.report.truncationReasons).toEqual([]);
  });

  it('caps hops at the projection maximum however many a caller asks for', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a')], { hops: 99 });
    expect(result.report.budget.hops).toBe(4);
    expect(result.report.budget.maxNodes).toBe(GRAPH_MAX_VISITED_NODES);
    expect(result.report.budget.maxEdges).toBe(GRAPH_MAX_EXAMINED_EDGES);
  });

  it('stops at the node bound and reports it rather than returning a silently short list', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a')], { hops: 4, maxNodes: 2 });

    expect(result.expansions).toHaveLength(2);
    expect(result.report.visitedNodes).toBe(2);
    expect(result.report.truncated).toBe(true);
    expect(result.report.truncationReasons).toContain('nodes');
  });

  it('stops at the edge bound and reports it', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a')], { hops: 4, maxEdges: 1 });

    expect(result.report.examinedEdges).toBe(1);
    expect(result.report.truncated).toBe(true);
    expect(result.report.truncationReasons).toContain('edges');
  });

  it('never examines more edges than the §2 ceiling, whatever a caller asks for', () => {
    const wide: GraphAssertion[] = [];
    for (let i = 0; i < 700; i += 1) {
      wide.push(assertion({ subject: 'topic:hub', object: `topic:leaf-${i}` }));
    }
    const result = expandFromSeeds(project(wide), [seed('topic:hub')], {
      hops: 4,
      maxEdges: 10_000,
      maxNodes: 10_000,
    });

    expect(result.report.examinedEdges).toBeLessThanOrEqual(GRAPH_MAX_EXAMINED_EDGES);
    expect(result.report.visitedNodes).toBeLessThanOrEqual(GRAPH_MAX_VISITED_NODES);
    expect(result.report.truncated).toBe(true);
  });
});

// ─── authorization is inherited, never re-derived (item 2) ────────────────────

describe('WP-G5 connected retrieval — expansion cannot widen the authorized set', () => {
  it('reaches nothing through a foreign principal edge, because it is not in the view', () => {
    const mine = assertion({ subject: 'topic:a', object: 'topic:b' });
    const theirs = assertion({ subject: 'topic:b', object: 'topic:secret', principalId: P2 });
    const result = expandFromSeeds(project([mine, theirs]), [seed('topic:a')], { hops: 4 });

    expect(result.expansions.map((e) => e.ref)).toEqual(['topic:a', 'topic:b']);
    expect(JSON.stringify(result)).not.toContain('topic:secret');
  });

  it('returns a seed that connects to nothing as a lone distance-0 expansion', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:orphan')], { hops: 4 });

    expect(result.expansions).toEqual([
      expect.objectContaining({ ref: 'topic:orphan', distance: 0, path: [] }),
    ]);
    expect(result.report.truncated).toBe(false);
  });
});

// ─── deterministic ranking (item 3) ──────────────────────────────────────────

describe('WP-G5 connected retrieval — ranking is deterministic and explainable', () => {
  it('decays rank per hop from the seed score, exactly as the constants state', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a', 0.8)], { hops: 2 });
    const byRef = new Map(result.expansions.map((e) => [e.ref, e]));

    expect(byRef.get('topic:a')?.rank).toBeCloseTo(0.8, 10);
    expect(byRef.get('topic:b')?.rank).toBeCloseTo(0.8 * GRAPH_HOP_DECAY, 10);
    expect(byRef.get('topic:c')?.rank).toBeCloseTo(0.8 * GRAPH_HOP_DECAY ** 2, 10);
  });

  it('does not depend on the order the caller listed its seeds in', () => {
    const projection = project([...CHAIN, assertion({ subject: 'topic:x', object: 'topic:c' })]);
    const seeds = [seed('topic:a', 0.9), seed('topic:x', 0.4)];
    const forwards = expandFromSeeds(projection, seeds, { hops: 2 });
    const backwards = expandFromSeeds(projection, [...seeds].reverse(), { hops: 2 });

    expect(forwards.expansions).toEqual(backwards.expansions);
  });

  it('takes the BETTER seed when a node is equidistant from two, whatever the seed order', () => {
    // Both seeds are exactly one hop from topic:shared, so distance cannot decide — the seed score
    // must, and then the stable seed ref. This is the rule that makes the walk order-independent
    // rather than "whichever seed the caller happened to list first".
    const projection = project([
      assertion({ subject: 'topic:strong', object: 'topic:shared' }),
      assertion({ subject: 'topic:weak', object: 'topic:shared' }),
    ]);
    const seeds = [seed('topic:strong', 0.9), seed('topic:weak', 0.2)];
    const forwards = expandFromSeeds(projection, seeds, { hops: 1 });
    const backwards = expandFromSeeds(projection, [...seeds].reverse(), { hops: 1 });

    expect(forwards.expansions).toEqual(backwards.expansions);
    const shared = forwards.expansions.find((e) => e.ref === 'topic:shared');
    expect(shared?.seedRef).toBe('topic:strong');
    expect(shared?.seedScore).toBe(0.9);
  });

  it('breaks an equal-score equidistant claim on the stable seed ref, not on input order', () => {
    const projection = project([
      assertion({ subject: 'topic:zeta-seed', object: 'topic:shared' }),
      assertion({ subject: 'topic:alpha-seed', object: 'topic:shared' }),
    ]);
    const seeds = [seed('topic:zeta-seed', 0.5), seed('topic:alpha-seed', 0.5)];
    const forwards = expandFromSeeds(projection, seeds, { hops: 1 });
    const backwards = expandFromSeeds(projection, [...seeds].reverse(), { hops: 1 });

    expect(forwards.expansions).toEqual(backwards.expansions);
    expect(forwards.expansions.find((e) => e.ref === 'topic:shared')?.seedRef).toBe(
      'topic:alpha-seed',
    );
  });

  it('collapses duplicate seeds onto one expansion, keeping the better-scoring claim', () => {
    // A caller whose lexical and semantic channels both surfaced the same ref must not get the ref
    // twice, and must not get the WEAKER of the two claims just because it was listed last.
    const result = expandFromSeeds(
      project(CHAIN),
      [seed('topic:a', 0.3, 'lexical'), seed('topic:a', 0.9, 'semantic')],
      { hops: 1 },
    );

    const a = result.expansions.filter((e) => e.ref === 'topic:a');
    expect(a).toHaveLength(1);
    expect(a[0]?.seedScore).toBe(0.9);
    expect(a[0]?.seedChannel).toBe('semantic');
    // And the duplicate did not double-expand the neighbourhood behind it.
    expect(result.expansions.filter((e) => e.ref === 'topic:b')).toHaveLength(1);
    expect(result.report.visitedNodes).toBe(2);
  });

  it('takes the SHORTEST distance when a node is reachable from two seeds', () => {
    const projection = project([...CHAIN, assertion({ subject: 'topic:near', object: 'topic:d' })]);
    const result = expandFromSeeds(projection, [seed('topic:a', 0.9), seed('topic:near', 0.2)], {
      hops: 4,
    });
    const d = result.expansions.find((e) => e.ref === 'topic:d');

    expect(d?.distance).toBe(1);
    expect(d?.seedRef).toBe('topic:near');
    expect(d?.path.map((s) => s.subject)).toEqual(['topic:near']);
  });

  it('breaks an exact rank tie on distance then on the stable ref', () => {
    const projection = project([
      assertion({ subject: 'topic:hub', object: 'topic:zeta' }),
      assertion({ subject: 'topic:hub', object: 'topic:alpha' }),
    ]);
    const result = expandFromSeeds(projection, [seed('topic:hub', 1)], { hops: 1 });

    expect(result.expansions.map((e) => e.ref)).toEqual(['topic:hub', 'topic:alpha', 'topic:zeta']);
  });
});

// ─── the two scores stay distinct (item 4) ───────────────────────────────────

describe('WP-G5 connected retrieval — the retrieval score and the graph explanation stay distinct', () => {
  it('carries the seed score and channel through untouched beside the graph rank', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a', 0.37, 'semantic')], {
      hops: 1,
    });
    const b = result.expansions.find((e) => e.ref === 'topic:b');

    expect(b?.seedScore).toBe(0.37); // the retriever's own number, not re-scaled
    expect(b?.seedChannel).toBe('semantic');
    expect(b?.rank).not.toBe(b?.seedScore);
  });

  it('explains every hop with the assertion traversed and its evidence', () => {
    const result = expandFromSeeds(project(CHAIN), [seed('topic:a')], { hops: 2 });
    const c = result.expansions.find((e) => e.ref === 'topic:c');

    expect(c?.path).toHaveLength(2);
    expect(c?.path.map((s) => [s.subject, s.object])).toEqual([
      ['topic:a', 'topic:b'],
      ['topic:b', 'topic:c'],
    ]);
    expect(c?.path.every((s) => s.supportedBy.includes(SUPPORTER))).toBe(true);
    expect(c?.path.every((s) => s.assertionId.startsWith('grel:'))).toBe(true);
  });
});

// ─── evidence eligibility is the caller's to state ───────────────────────────

describe('WP-G5 connected retrieval — evidence eligibility is stated, never assumed', () => {
  it('ranks a path backed only by ineligible supporters below an eligible one, and says which', () => {
    const projection = project([
      assertion({ subject: 'topic:seed', object: 'topic:trusted', supportedBy: ['mem:good'] }),
      assertion({ subject: 'topic:seed', object: 'topic:weak', supportedBy: ['mem:quarantined'] }),
    ]);
    const result = expandFromSeeds(projection, [seed('topic:seed', 1)], {
      hops: 1,
      eligibleSupporters: new Set(['mem:good']),
    });
    const trusted = result.expansions.find((e) => e.ref === 'topic:trusted');
    const weak = result.expansions.find((e) => e.ref === 'topic:weak');

    expect(trusted?.evidenceEligible).toBe(true);
    expect(weak?.evidenceEligible).toBe(false);
    expect(weak?.rank).toBeCloseTo((trusted?.rank ?? 0) * GRAPH_INELIGIBLE_EVIDENCE_FACTOR, 10);
    // Demoted, NOT hidden: the owner still sees the connection and why it ranks lower.
    expect(result.expansions.map((e) => e.ref)).toContain('topic:weak');
  });

  it('treats every supported edge as eligible when the caller states no set', () => {
    const projection = project([
      assertion({ subject: 'topic:seed', object: 'topic:weak', supportedBy: ['mem:whatever'] }),
    ]);
    const result = expandFromSeeds(projection, [seed('topic:seed', 1)], { hops: 1 });

    expect(result.expansions.every((e) => e.evidenceEligible)).toBe(true);
  });
});

// ─── contradictions survive expansion (item 6 of the plan's retrieval list) ──

describe('WP-G5 connected retrieval — a disagreement is expanded, not resolved', () => {
  it('reaches BOTH objects of a contradiction from the shared subject', () => {
    const projection = project([
      assertion({ subject: 'topic:api', object: 'topic:rest', predicate: 'applies-to' }),
      assertion({ subject: 'topic:api', object: 'topic:grpc', predicate: 'applies-to' }),
    ]);
    expect(projection.conflicts).toHaveLength(1);

    const result = expandFromSeeds(projection, [seed('topic:api')], { hops: 1 });
    expect(result.expansions.map((e) => e.ref).sort()).toEqual([
      'topic:api',
      'topic:grpc',
      'topic:rest',
    ]);
  });
});

// ─── relation filters ────────────────────────────────────────────────────────

describe('WP-G5 connected retrieval — relation filters narrow the walk', () => {
  it('traverses only the requested predicates', () => {
    const projection = project([
      assertion({ subject: 'topic:a', object: 'topic:b', predicate: 'about' }),
      assertion({ subject: 'topic:a', object: 'topic:c', predicate: 'supersedes' }),
    ]);
    const result = expandFromSeeds(projection, [seed('topic:a')], {
      hops: 2,
      predicates: ['about'],
    });

    expect(result.expansions.map((e) => e.ref)).toEqual(['topic:a', 'topic:b']);
  });
});
