import {
  buildGraphContextPack,
  createGraphAssertion,
  expandFromSeeds,
  projectGraph,
} from '@knowledge-crib/memory';
import type { GraphAssertion, MemoryGraphPredicate } from '@knowledge-crib/memory';
/**
 * The S5 fit ledger's exactness lock.
 *
 * GraphFitLedger exists so fitGraphContext can measure a candidate's token cost without
 * rebuilding the pack (the round-0 per-candidate rebuild measured as a ~3.5s p95 regression
 * against the 500ms gate). But a FAST mirror that drifts from the builder is worse than no
 * mirror: every budget decision the ledger makes is only as good as its serialization being
 * byte-identical to `buildGraphContextPack`. These tests lock the equality on fixtures that
 * exercise every citation channel — paths, relations, conflicts, history and the completion's
 * own citedAssertionIds — across prefix sweeps and add→remove cycles, and pin the ledger's own
 * read APIs (cite, newCitationCount, tokensWith*) so a future change cannot silently make the
 * ledger measure a pack the builder would not serve.
 */
import { describe, expect, it } from 'vitest';
import { GraphFitLedger } from './graph-fit-ledger.js';

const ALPHA = 'principal:ledger-test';
const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-05T00:00:00.000Z';
const T3 = '2026-09-10T00:00:00.000Z';
const VIEWER = { principalId: ALPHA, scope: { boundary: 'global' as const } };

function edge(
  predicate: MemoryGraphPredicate,
  subject: string,
  object: string,
  supportedBy: string[],
  at = T1,
  actorId = 'agent:ledger-test',
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
      deviceId: 'device:ledger-test',
      actorId,
      clientId: 'vitest',
    },
  });
}

const RECORDS = [
  { id: 'mem:a' },
  { id: 'mem:b' },
  { id: 'mem:c' },
  { id: 'mem:d2' },
  { id: 'mem:shared' },
];

/** The mixed fixture: relations, a path, a conflict pair, history and two producers. */
function mixedFixture() {
  const affects = edge('affects', 'mem:a', 'mem:b', ['mem:shared']);
  const partOf = edge('part-of', 'mem:b', 'mem:c', ['mem:shared']);
  const thirty = edge('contradicts', 'mem:a', 'mem:b', ['mem:a']);
  const sixty = edge('contradicts', 'mem:b', 'mem:a', ['mem:b']);
  const about = edge('about', 'mem:d2', 'topic:retry', ['mem:d2'], T1, 'agent:other');
  // Nothing seeds or traverses to topic:x1, so no kept item ever cites this one — the
  // only way the pack states it is an explicit completion cite.
  const orphan = edge('about', 'topic:x1', 'topic:x2', ['mem:shared'], T1, 'agent:other');
  const projection = projectGraph(
    {
      assertions: [affects, partOf, thirty, sixty, about, orphan],
      records: RECORDS,
      historicalRecords: [{ id: 'mem:d1' }],
    },
    VIEWER,
  );
  const expansion = expandFromSeeds(projection, [
    { ref: 'mem:a', score: 1, channel: 'explicit' as const },
    { ref: 'mem:c', score: 0.9, channel: 'explicit' as const },
    { ref: 'mem:d2', score: 0.8, channel: 'explicit' as const },
  ]);
  return { affects, partOf, thirty, sixty, about, orphan, projection, expansion };
}

/** The builder's own serialized form — the thing the ledger must reproduce byte for byte. */
function builderJson(
  projection: Parameters<typeof buildGraphContextPack>[0],
  prefix: Parameters<typeof buildGraphContextPack>[1],
  traversal: Parameters<typeof buildGraphContextPack>[2],
  opts: Parameters<typeof buildGraphContextPack>[3] = {},
): string {
  return JSON.stringify({
    context: buildGraphContextPack(projection, prefix, traversal, opts),
    budgetExhausted: true,
  });
}

describe('GraphFitLedger mirrors the serialized pack exactly', () => {
  it('is byte-identical to the builder over a prefix sweep of a mixed projection', () => {
    const { projection, expansion } = mixedFixture();
    const opts = { budgetTokens: 2000 };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    expect(expansion.expansions.length).toBeGreaterThanOrEqual(4);
    for (let n = 0; n <= expansion.expansions.length; n += 1) {
      const prefix = expansion.expansions.slice(0, n);
      ledger.rebuild(prefix);
      expect(ledger.serialize()).toBe(builderJson(projection, prefix, expansion.report, opts));
    }
  });

  it('is byte-identical when the S3 item filter removes an expansion from the pack', () => {
    const { projection, expansion } = mixedFixture();
    const eligible = new Set(['mem:a', 'mem:b', 'topic:retry']);
    const opts = { budgetTokens: 2000, itemEligible: eligible };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    for (let n = 0; n <= expansion.expansions.length; n += 1) {
      const prefix = expansion.expansions.slice(0, n);
      ledger.rebuild(prefix);
      expect(ledger.serialize()).toBe(builderJson(projection, prefix, expansion.report, opts));
    }
  });

  it('mirrors the completion citation channel: cite(id) equals citedAssertionIds on the builder', () => {
    const { affects, projection, expansion } = mixedFixture();
    // Keep mem:a only, so the affects relation's other endpoint (mem:b) is trimmed.
    const prefix = expansion.expansions.filter((e) => e.ref === 'mem:a');
    const opts = { budgetTokens: 2000 };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    ledger.rebuild(prefix);
    ledger.cite(affects.id);
    expect(ledger.serialize()).toBe(
      builderJson(projection, prefix, expansion.report, {
        ...opts,
        citedAssertionIds: [affects.id],
      }),
    );
    expect(ledger.completionCitations()).toEqual([affects.id]);
  });

  it('add → remove retracts relations, history and conflicts, and add appends without reordering', () => {
    const { projection, expansion } = mixedFixture();
    const opts = { budgetTokens: 2000 };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    const full = expansion.expansions;
    ledger.rebuild(full);
    expect(ledger.serialize()).toBe(builderJson(projection, full, expansion.report, opts));
    // Drop one item at a time: every intermediate state must equal the builder's, and the
    // retractions (dead relations, orphaned history, un-included conflicts) must be exact.
    for (const dropped of full) {
      ledger.remove(dropped.ref);
      const reduced = full.filter((e) => e.ref !== dropped.ref);
      expect(ledger.serialize()).toBe(builderJson(projection, reduced, expansion.report, opts));
      // Adding it back APPENDS — the fit order is never rewritten, so the state mirrors the
      // builder fed the same re-ordered list, not the original one.
      ledger.add(dropped);
      expect(ledger.serialize()).toBe(
        builderJson(projection, [...reduced, dropped], expansion.report, opts),
      );
      ledger.rebuild(full);
    }
  });
});

describe('GraphFitLedger reads the pack state honestly', () => {
  it('cite resolves current first and falls back to historical, ignoring unresolvable ids', () => {
    const { about, affects, projection, expansion } = mixedFixture();
    const opts = { budgetTokens: 2000 };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    ledger.rebuild([]);
    const before = ledger.tokens();
    // A current assertion cites as current.
    ledger.cite(affects.id);
    expect(JSON.parse(ledger.serialize()).context.assertions).toEqual([
      expect.objectContaining({ id: affects.id, status: 'current' }),
    ]);
    // about is also in the current view: it cites as current, and assertions stay sorted by id.
    ledger.cite(about.id);
    let pack = JSON.parse(ledger.serialize()).context;
    expect(pack.assertions.map((a: { id: string }) => a.id)).toEqual([about.id, affects.id].sort());
    for (const assertion of pack.assertions) {
      expect(assertion.status).toBe('current');
    }
    // An unknown id resolves to nothing: no assertion, no producer, no token change — but the
    // ledger still records it as a completion citation, exactly as it did before the drop.
    const withAbout = ledger.serialize();
    ledger.cite('assertion:not-in-this-view');
    pack = JSON.parse(ledger.serialize()).context;
    expect(pack.assertions.map((a: { id: string }) => a.id)).toEqual([about.id, affects.id].sort());
    expect(ledger.serialize()).toBe(withAbout);
    expect(ledger.completionCitations()).toEqual(
      ['assertion:not-in-this-view', about.id, affects.id].sort(),
    );
    expect(ledger.tokens()).toBeGreaterThan(before);
  });

  it('cites a historical assertion with status historical', () => {
    const before = edge('about', 'mem:d1', 'topic:retry', ['mem:d1'], T1);
    const after = edge('supersedes', 'mem:d2', 'mem:d1', ['mem:d2'], T3);
    const projection = projectGraph({ assertions: [before, after], records: RECORDS }, VIEWER, {
      at: T2,
    });
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:d1', score: 1, channel: 'explicit' as const },
    ]);
    const opts = { budgetTokens: 2000 };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    ledger.rebuild([]);
    ledger.cite(after.id);
    const pack = JSON.parse(ledger.serialize()).context;
    expect(pack.assertions).toEqual([
      expect.objectContaining({ id: after.id, status: 'historical' }),
    ]);
    expect(ledger.serialize()).toBe(
      builderJson(projection, [], expansion.report, { ...opts, citedAssertionIds: [after.id] }),
    );
  });

  it('tokensWith and tokensWithCitation measure without mutating the ledger', () => {
    const { affects, projection, expansion } = mixedFixture();
    const opts = { budgetTokens: 2000 };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    ledger.rebuild(expansion.expansions.filter((e) => e.ref === 'mem:a'));
    const state = ledger.serialize();
    const withPartner = ledger.tokensWith(expansion.expansions.find((e) => e.ref === 'mem:b')!);
    const withCitation = ledger.tokensWithCitation(affects.id);
    expect(withPartner).toBeGreaterThan(ledger.tokens());
    expect(withCitation).toBeGreaterThan(ledger.tokens());
    expect(ledger.serialize()).toBe(state);
    expect(ledger.completionCitations()).toEqual([]);
  });

  it('newCitationCount counts exactly what an append would newly state, and zero-info means zero', () => {
    const affects = edge('affects', 'mem:a', 'mem:b', ['mem:shared']);
    const projection = projectGraph({ assertions: [affects], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:a', score: 1, channel: 'explicit' as const },
      { ref: 'mem:b', score: 0.6, channel: 'explicit' as const },
    ]);
    const ledger = new GraphFitLedger(projection, expansion.report, { budgetTokens: 2000 });
    // Only mem:a kept: appending mem:b would newly state the affects relation — count 1.
    ledger.rebuild(expansion.expansions.filter((e) => e.ref === 'mem:a'));
    const partner = expansion.expansions.find((e) => e.ref === 'mem:b')!;
    expect(ledger.newCitationCount(partner)).toBe(1);
    // Once the relation is cited, the append is pure cost: a zero-information append.
    ledger.cite(affects.id);
    expect(ledger.newCitationCount(partner)).toBe(0);
    // Once mem:b is kept anyway, it is no longer an append candidate at all.
    ledger.add(partner);
    expect(ledger.isKept('mem:b')).toBe(true);
    expect(ledger.keptList().map((e) => e.ref)).toEqual(['mem:a', 'mem:b']);
  });

  it('an ineligible expansion is kept for the caller but contributes nothing to the pack', () => {
    const affects = edge('affects', 'mem:a', 'mem:b', ['mem:shared']);
    const projection = projectGraph({ assertions: [affects], records: RECORDS }, VIEWER);
    const expansion = expandFromSeeds(projection, [
      { ref: 'mem:a', score: 1, channel: 'explicit' as const },
      { ref: 'mem:b', score: 0.6, channel: 'explicit' as const },
    ]);
    const eligible = new Set(['mem:a']);
    const opts = { budgetTokens: 2000, itemEligible: eligible };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    ledger.rebuild(expansion.expansions);
    const pack = JSON.parse(ledger.serialize()).context;
    expect(pack.items.map((i: { ref: string }) => i.ref)).toEqual(['mem:a']);
    expect(ledger.keptList()).toHaveLength(2);
    expect(ledger.newCitationCount(expansion.expansions.find((e) => e.ref === 'mem:b')!)).toBe(0);
    expect(ledger.serialize()).toBe(
      builderJson(projection, expansion.expansions, expansion.report, opts),
    );
  });

  it('isCited sees every citation channel the pack serves', () => {
    const { affects, thirty, sixty, orphan, projection, expansion } = mixedFixture();
    const opts = { budgetTokens: 2000 };
    const ledger = new GraphFitLedger(projection, expansion.report, opts);
    // A path step, a relation among kept items, a conflict member and a completion cite.
    const keeper = expansion.expansions.filter((e) => e.ref !== 'mem:d2');
    ledger.rebuild(keeper);
    const pathStep = keeper.flatMap((e) => e.path).map((s) => s.assertionId);
    expect(pathStep.length).toBeGreaterThan(0);
    for (const id of pathStep) expect(ledger.isCited(id)).toBe(true);
    expect(ledger.isCited(affects.id)).toBe(true);
    for (const id of [thirty.id, sixty.id]) expect(ledger.isCited(id)).toBe(true);
    // The orphan is reachable by no kept item: only an explicit cite states it.
    expect(ledger.isCited(orphan.id)).toBe(false);
    ledger.cite(orphan.id);
    expect(ledger.isCited(orphan.id)).toBe(true);
    expect(ledger.serialize()).toBe(
      builderJson(projection, keeper, expansion.report, {
        ...opts,
        citedAssertionIds: [orphan.id],
      }),
    );
  });
});
