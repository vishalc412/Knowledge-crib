/**
 * WP-G1 commit 3 — the backfill derivation laws (the plan's WP-G1 items 6–7):
 *
 *   - corpus pin: deriving over the acceptance corpus reproduces EXACTLY the 35 pre-registered
 *     backfill-scope edges (docs/bench/graph-gates.md §2), never one of the 9 capture-scope
 *     edges, plus the two gd1 decoy edges the corpus's own structure legitimately yields —
 *     derived − expected = precisely those two, nothing invented;
 *   - determinism: two derivations are deep-equal (the store's byte-identity no-op path
 *     depends on it), and the derivation never mutates its inputs (the no-id-rewrite law);
 *   - fail-closed reporting: an unresolvable subject, a dangling lineage ref, a non-ref
 *     evidence anchor, and a malformed entity member are each REPORTED, never linked;
 *   - self-edges and non-valid evidence contribute no anchors;
 *   - store integration: submitting the derived assertions acknowledges every one, and a
 *     resubmit skips all 37 — backfill ties into commit 2's idempotence law.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGraphCorpus } from './graph-corpus/corpus.js';
import {
  GRAPH_BACKFILL_EPOCH,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  clearMemoryCollectionCache,
  createGraphEntity,
  deriveAssertionsFromRecords,
  graphAssertionTriple,
  memoryRecordV3Id,
} from './index.js';
import type {
  GraphAssertion,
  GraphEntity,
  MemoryEvidence,
  MemoryNamespace,
  MemoryProvenance,
  MemoryRecordV3,
} from './types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';

const PROVENANCE: MemoryProvenance = {
  principalId: 'principal:graph-backfill',
  deviceId: 'device:graph-backfill',
  actorId: 'agent:graph-backfill',
  clientId: 'vitest',
};

/** A minimal valid v3 record — the id is the content address, derived exactly as ids.ts does. */
function v3(input: {
  subject: string;
  claim: string;
  evidence?: MemoryEvidence[];
  namespace?: MemoryNamespace;
  lineage?: MemoryRecordV3['lineage'];
  validFrom?: string;
  recordedAt?: string;
}): MemoryRecordV3 {
  const namespace = input.namespace ?? { principalId: PROVENANCE.principalId };
  const seed = {
    kind: 'fact' as const,
    subject: input.subject,
    propositionKey: `prop:${input.claim}`,
    claim: input.claim,
    evidence: input.evidence ?? [],
    namespace,
  };
  return {
    id: memoryRecordV3Id(seed),
    schemaVersion: '3',
    visibility: 'workspace',
    ...seed,
    validTime: { from: input.validFrom ?? T0 },
    transactionTime: { observedAt: T0, recordedAt: input.recordedAt ?? T1 },
    evidence: input.evidence ?? [],
    provenance: PROVENANCE,
    lineage: input.lineage ?? {},
    sensitivity: 'internal',
    retentionPolicyId: 'retention:default',
    namespace,
  };
}

function sourceQuote(soulId: string): MemoryEvidence {
  return { kind: 'source-quote', verdict: 'valid', checkedAt: T1, soulId, quote: 'q' };
}

/** `(predicate, subject, object)` string key — the edge identity both worlds agree on. The two
 * shapes differ only in field names (corpus `from`/`to` vs assertion `subject`/`object`). */
function key(t: {
  predicate: string;
  subject?: string;
  object?: string;
  from?: string;
  to?: string;
}): string {
  return `${t.predicate}|${t.subject ?? t.from}|${t.object ?? t.to}`;
}

// ─── the corpus pin ──────────────────────────────────────────────────────────

/**
 * The corpus ships entity FIXTURES (no members — ownership is authored, not inferred), but the
 * pre-registered part-of edges state exactly which members each entity owns. Build the entity
 * table from the corpus itself: members come from the expected part-of edges, so the test can
 * never drift from the pre-registration.
 */
function corpusEntities(provenance: MemoryProvenance): GraphEntity[] {
  const corpus = buildGraphCorpus();
  const membersByRef = new Map<string, string[]>();
  for (const edge of corpus.expectedRelationships) {
    if (edge.predicate !== 'part-of') continue;
    const members = membersByRef.get(edge.to);
    if (members) members.push(edge.from);
    else membersByRef.set(edge.to, [edge.from]);
  }
  // The graph-entity law pins namespace.principalId to the PROVENANCE's principal — the table
  // is authored as alpha, so the entity provenance must be alpha's too (it is distinct from the
  // `provenance` the derivation stamps onto the ASSERTIONS, which is caller-supplied).
  const entityProvenance: MemoryProvenance = {
    ...provenance,
    principalId: corpus.principals.alpha,
  };
  return corpus.entities.map((fixture) => {
    const entity = createGraphEntity({
      kind: fixture.type,
      name: fixture.name,
      namespace: { principalId: corpus.principals.alpha, projectId: fixture.repoId },
      scope: { boundary: 'repo', repoId: fixture.repoId },
      provenance: entityProvenance,
      members: membersByRef.get(fixture.id) ?? [],
    });
    expect(entity.ref).toBe(fixture.id); // the fixture ids ARE the canonical traversal refs
    return entity;
  });
}

/** The 35 backfill-scope expected edges (WP-G1 territory), per the graph-gates.md §2 split. */
function backfillScopeEdges(): { predicate: string; from: string; to: string }[] {
  const corpus = buildGraphCorpus();
  const intakeIds = new Set(Object.values(corpus.intakeIds));
  return corpus.expectedRelationships
    .filter(
      (e) =>
        e.predicate !== 'affects' &&
        e.predicate !== 'applies-to' &&
        !(e.predicate === 'about' && intakeIds.has(e.from)),
    )
    .map((e) => ({ predicate: e.predicate, from: e.from, to: e.to }));
}

/** The 9 capture-scope expected edges — WP-G4 territory; backfill must never mint one. */
function captureScopeEdges(): { predicate: string; from: string; to: string }[] {
  const corpus = buildGraphCorpus();
  const intakeIds = new Set(Object.values(corpus.intakeIds));
  return corpus.expectedRelationships
    .filter(
      (e) =>
        e.predicate === 'affects' ||
        e.predicate === 'applies-to' ||
        (e.predicate === 'about' && intakeIds.has(e.from)),
    )
    .map((e) => ({ predicate: e.predicate, from: e.from, to: e.to }));
}

describe('deriveAssertionsFromRecords — the corpus pin', () => {
  const corpus = buildGraphCorpus();
  const entities = corpusEntities(PROVENANCE);
  const report = deriveAssertionsFromRecords(corpus.records, entities, PROVENANCE);

  it('derives exactly the corpus arithmetic: 37 edges = 35 pre-registered + 2 gd1 decoys', () => {
    expect(report.stats).toEqual({
      recordsConsidered: 15,
      entitiesConsidered: 5,
      derived: 37,
      about: 15,
      supportedBy: 12,
      derivedFrom: 1,
      supersedes: 1,
      contradicts: 2,
      partOf: 6,
      // a3, a4, a9, a10, a11, b2 each quote their own subject — no traversal information.
      skippedSelfAnchors: 6,
      skippedInvalidEvidence: 0,
      unresolvedSubjects: 0,
      missingAnchors: 0,
      unplacedScopes: 0,
    });
    const ids = report.assertions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length); // unique by id — the report contract
  });

  it('reproduces every 35 backfill-scope edge the corpus pre-registered', () => {
    const derived = new Set(report.assertions.map((a) => key(graphAssertionTriple(a))));
    const expected = backfillScopeEdges();
    expect(expected).toHaveLength(35);
    const missing = expected.filter((e) => !derived.has(key(e)));
    expect(missing).toEqual([]);
  });

  it('never derives a capture-scope edge (affects / applies-to / intake about)', () => {
    const derived = new Set(report.assertions.map((a) => key(graphAssertionTriple(a))));
    const capture = captureScopeEdges();
    expect(capture).toHaveLength(9);
    const leaked = capture.filter((e) => derived.has(key(e)));
    expect(leaked).toEqual([]);
  });

  it('derives NOTHING beyond the pre-registration except the two gd1 decoy edges', () => {
    const gd1 = corpus.globalDecoys[0]!;
    const expected = new Set(backfillScopeEdges().map(key));
    const extra = [...new Set(report.assertions.map((a) => key(graphAssertionTriple(a))))].filter(
      (k) => !expected.has(k),
    );
    // The decoy record's own structure legitimately yields its subject + its evidence anchor —
    // the corpus excludes it from the expected set because the ANSWER probes must not surface it,
    // not because the derivation may not see it.
    expect(extra.sort()).toEqual(
      [
        `about|${gd1.id}|${gd1.subject}`,
        `supported-by|${gd1.id}|${gd1.evidence[0]!.soulId}`,
      ].sort(),
    );
  });

  it('stamps record edges from the record times and part-of edges at the fixed epoch', () => {
    const byPredicate = new Map<string, GraphAssertion>();
    for (const a of report.assertions)
      byPredicate.set(`${a.predicate}|${a.subject}|${a.object}`, a);
    // d1: validAt = validTime.from, knownAt = transactionTime.recordedAt (NOT the clock).
    const d1 = corpus.recordsByRole.alphaLedger[0]!;
    const aboutD1 = byPredicate.get(`about|${d1.id}|${d1.subject}`);
    expect(aboutD1?.validAt).toBe(d1.validTime.from);
    expect(aboutD1?.knownAt).toBe(d1.transactionTime.recordedAt);
    // part-of: no record stamps it — the fixed epoch, so the id is run-invariant.
    const partOf = report.assertions.filter((a) => a.predicate === 'part-of');
    expect(partOf).toHaveLength(6);
    for (const a of partOf) {
      expect(a.validAt).toBe(GRAPH_BACKFILL_EPOCH);
      expect(a.knownAt).toBe(GRAPH_BACKFILL_EPOCH);
    }
  });

  it('maps scope from the namespace: projectId → repo scope, absent → global', () => {
    const scopes = new Set(
      report.assertions.map((a) => `${a.scope.boundary}:${a.scope.repoId ?? 'global'}`),
    );
    expect(scopes).toEqual(
      new Set(['repo:graph-corpus-ledger', 'repo:graph-corpus-checkout', 'global:global']),
    );
    // g1 is the global record: its namespace carries no projectId.
    const g1 = corpus.recordsByRole.alphaGlobal[0]!;
    const aboutG1 = report.assertions.find((a) => a.predicate === 'about' && a.subject === g1.id);
    expect(aboutG1?.scope).toEqual({ boundary: 'global' });
  });

  it('carries backfill provenance: meta origin, the deriving record/entity as source, the record as its own supporter', () => {
    const entityIds = new Set(entities.map((e) => e.id));
    for (const a of report.assertions) {
      expect(a.admission).toBe('proposed');
      expect(a.meta).toMatchObject({ origin: 'backfill' });
      if (a.predicate === 'part-of') {
        // the source is the owning entity's own gent id (mirroring records, where it is the
        // record id); the ref vouches in supportedBy.
        expect(entityIds.has(a.meta?.source as string)).toBe(true);
        expect(a.supportedBy).toEqual([a.object]);
      } else {
        expect(a.meta).toMatchObject({ source: a.subject });
        expect(a.supportedBy).toEqual([a.subject]);
      }
    }
  });

  it('is deterministic: two derivations are deep-equal, and neither mutates its inputs', () => {
    const corpusAgain = buildGraphCorpus();
    const entitiesAgain = corpusEntities(PROVENANCE);
    const recordsBefore = JSON.stringify(corpus.records);
    const entitiesBefore = JSON.stringify(entities);
    const second = deriveAssertionsFromRecords(corpus.records, entitiesAgain, PROVENANCE);
    expect(second).toEqual(report);
    expect(JSON.stringify(second.assertions)).toBe(JSON.stringify(report.assertions));
    expect(JSON.stringify(corpus.records)).toBe(recordsBefore); // no-id-rewrite, no mutation
    expect(JSON.stringify(entities)).toBe(entitiesBefore);
    expect(corpusAgain.records).toEqual(corpus.records);
  });
});

// ─── the reporting laws — report, never invent ─────────────────────────────────

describe('deriveAssertionsFromRecords — fail-closed reporting', () => {
  it('reports an unresolvable subject instead of linking it', () => {
    const bad = v3({ subject: 'ledger-retries', claim: 'subject is not a graph ref' });
    const good = v3({ subject: 'topic:ledger', claim: 'a well-formed subject' });
    const report = deriveAssertionsFromRecords([bad, good], [], PROVENANCE);
    expect(report.unresolvedSubjects).toEqual([{ recordId: bad.id, subject: 'ledger-retries' }]);
    expect(report.stats.unresolvedSubjects).toBe(1);
    expect(report.assertions.some((a) => a.subject === bad.id)).toBe(false); // no about edge
    expect(report.assertions.some((a) => a.subject === good.id)).toBe(true);
  });

  it('reports a dangling lineage ref instead of guessing a link', () => {
    const missingRef = `mem:${'ab'.repeat(32)}`; // well-formed ref, absent from the input set
    const r = v3({
      subject: 'topic:lineage',
      claim: 'lineage points at a record that is not in the input set',
      lineage: { derivedFrom: [missingRef] },
    });
    const report = deriveAssertionsFromRecords([r], [], PROVENANCE);
    expect(report.missingAnchors).toEqual([
      { ownerId: r.id, relation: 'derived-from', ref: missingRef },
    ]);
    expect(report.assertions.filter((a) => a.predicate === 'derived-from')).toEqual([]);
  });

  it('reports a non-ref evidence anchor instead of linking it', () => {
    const r = v3({
      subject: 'topic:anchors',
      claim: 'evidence anchor is not a graph ref',
      evidence: [sourceQuote('src/some/file.ts#L10')],
    });
    const report = deriveAssertionsFromRecords([r], [], PROVENANCE);
    expect(report.missingAnchors).toEqual([
      { ownerId: r.id, relation: 'supported-by', ref: 'src/some/file.ts#L10' },
    ]);
    expect(report.assertions.filter((a) => a.predicate === 'supported-by')).toEqual([]);
  });

  it('reports a malformed entity member instead of linking it', () => {
    const entity = createGraphEntity({
      kind: 'service',
      name: 'OrderService',
      namespace: { principalId: PROVENANCE.principalId, projectId: 'backfill-repo' },
      scope: { boundary: 'repo', repoId: 'backfill-repo' },
      provenance: PROVENANCE,
      members: ['sym:good-member', 'member-without-prefix'],
    });
    const report = deriveAssertionsFromRecords([], [entity], PROVENANCE);
    expect(report.missingAnchors).toEqual([
      { ownerId: entity.id, relation: 'part-of', ref: 'member-without-prefix' },
    ]);
    const partOf = report.assertions.filter((a) => a.predicate === 'part-of');
    expect(partOf.map((a) => a.subject)).toEqual(['sym:good-member']);
  });

  it('omits the subject self-anchor and skips non-valid evidence entirely', () => {
    const self = v3({
      subject: 'sym:quoted-self',
      claim: 'its own source quote names its own subject',
      evidence: [sourceQuote('sym:quoted-self')],
    });
    const invalid = v3({
      subject: 'topic:invalid-evidence',
      claim: 'an invalid-verdict item may not assert support',
      evidence: [
        { kind: 'source-quote', verdict: 'invalid', checkedAt: T1, soulId: 'sym:elsewhere' },
        { kind: 'source-quote', verdict: 'degraded', checkedAt: T1, soulId: 'sym:fallback' },
      ],
    });
    const report = deriveAssertionsFromRecords([self, invalid], [], PROVENANCE);
    expect(report.assertions.filter((a) => a.predicate === 'supported-by')).toEqual([]);
    expect(report.stats.skippedSelfAnchors).toBe(1);
    expect(report.stats.skippedInvalidEvidence).toBe(2);
    expect(report.unresolvedSubjects).toEqual([]);
    expect(report.missingAnchors).toEqual([]); // skipped, not missing — the fields parse fine
  });

  it('derives one part-of edge per member even when members repeat', () => {
    const entity = createGraphEntity({
      kind: 'concept',
      name: 'RetrySemantics',
      namespace: { principalId: PROVENANCE.principalId },
      scope: { boundary: 'global' },
      provenance: PROVENANCE,
      members: ['topic:retry', 'topic:retry', 'topic:retry'],
    });
    const report = deriveAssertionsFromRecords([], [entity], PROVENANCE);
    const partOf = report.assertions.filter((a) => a.predicate === 'part-of');
    expect(partOf).toHaveLength(1);
    expect(partOf[0]!.object).toBe('entity:RetrySemantics');
  });

  // ─── the review findings — 5 defects the adversarial review confirmed, each pinned here ──

  it('reports a valid evidence item that names no anchor (never silently drops it)', () => {
    const r = v3({
      subject: 'topic:anchorless',
      claim: 'its only evidence passed a check but carries no anchor id',
      evidence: [{ kind: 'source-quote', verdict: 'valid', checkedAt: T1, quote: 'q' }],
    });
    const report = deriveAssertionsFromRecords([r], [], PROVENANCE);
    expect(report.missingAnchors).toEqual([
      { ownerId: r.id, relation: 'supported-by', ref: '<absent-anchor:source-quote>' },
    ]);
    expect(report.stats.missingAnchors).toBe(1);
    expect(report.assertions.filter((a) => a.predicate === 'supported-by')).toEqual([]);
  });

  it('collapses duplicate anchors and duplicate lineage refs into one edge each', () => {
    const target = v3({ subject: 'topic:target', claim: 'the lineage target' });
    const r = v3({
      subject: 'topic:dupes',
      claim: 'two evidence items share an anchor and lineage repeats a ref',
      evidence: [sourceQuote('sym:shared'), sourceQuote('sym:shared')],
      lineage: { derivedFrom: [target.id, target.id] },
    });
    const report = deriveAssertionsFromRecords([r, target], [], PROVENANCE);
    const ids = report.assertions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length); // no byte-identical duplicates, ever
    expect(report.stats.supportedBy).toBe(1);
    expect(report.stats.derivedFrom).toBe(1);
    expect(report.stats.derived).toBe(4); // about ×2 + supported-by 1 + derived-from 1
  });

  it('omits a lineage ref naming the record itself — no self-edge, reported nowhere as missing', () => {
    // lineage is excluded from the v3 content seed, so the id computed without it is the id
    // the record carries — the self-reference is schema-representable corrupt data.
    const base = v3({ subject: 'topic:self-lineage', claim: 'supersedes itself — corrupt' });
    const r = v3({
      subject: 'topic:self-lineage',
      claim: 'supersedes itself — corrupt',
      lineage: { supersedes: [base.id] },
    });
    expect(r.id).toBe(base.id);
    const report = deriveAssertionsFromRecords([r], [], PROVENANCE);
    expect(report.assertions.filter((a) => a.predicate === 'supersedes')).toEqual([]);
    expect(report.stats.skippedSelfAnchors).toBe(1);
    expect(report.missingAnchors).toEqual([]);
  });

  it('omits an entity member equal to the entity’s own ref — the part-of self-loop', () => {
    const entity = createGraphEntity({
      kind: 'concept',
      name: 'SelfRef',
      namespace: { principalId: PROVENANCE.principalId },
      scope: { boundary: 'global' },
      provenance: PROVENANCE,
      members: ['entity:SelfRef', 'topic:real-member'],
    });
    const report = deriveAssertionsFromRecords([], [entity], PROVENANCE);
    expect(report.assertions.some((a) => a.subject === a.object)).toBe(false);
    expect(report.stats.skippedSelfAnchors).toBe(1);
    expect(report.assertions.filter((a) => a.predicate === 'part-of')).toHaveLength(1);
  });

  it('reports an unplaceable repo scope instead of aborting the whole run', () => {
    // record-v3 allows any non-empty projectId; the graph SEGMENT grammar does not — one
    // unplaceable record must not lose every other record's edges.
    const bad = v3({
      subject: 'topic:unplaceable',
      claim: 'projectId is not a legal graph repoId segment',
      namespace: { principalId: PROVENANCE.principalId, projectId: 'org/repo' },
    });
    const good = v3({ subject: 'topic:placeable', claim: 'a fine record' });
    const report = deriveAssertionsFromRecords([bad, good], [], PROVENANCE);
    expect(report.unplacedScopes).toEqual([{ recordId: bad.id, projectId: 'org/repo' }]);
    expect(report.stats.unplacedScopes).toBe(1);
    expect(report.assertions.some((a) => a.subject === bad.id)).toBe(false);
    expect(report.assertions.some((a) => a.subject === good.id)).toBe(true);
  });
});

// ─── store integration — the idempotence tie-in ───────────────────────────────

describe('deriveAssertionsFromRecords — store integration', () => {
  let home = '';
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mem-graph-backfill-'));
    env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
    __resetMemoryLockGuardForTest();
  });

  afterEach(() => {
    __resetMemoryLockGuardForTest();
    clearMemoryCollectionCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('submits every derived assertion once; a resubmit skips all of them', () => {
    const corpus = buildGraphCorpus();
    const entities = corpusEntities(PROVENANCE);
    const report = deriveAssertionsFromRecords(corpus.records, entities, PROVENANCE);
    expect(report.assertions).toHaveLength(37);

    // Partition by the scope each assertion carries — the caller routes, the store holds.
    const ledger = report.assertions.filter(
      (a) => a.scope.boundary === 'repo' && a.scope.repoId === corpus.repoIds.ledger,
    );
    const checkout = report.assertions.filter(
      (a) => a.scope.boundary === 'repo' && a.scope.repoId === corpus.repoIds.checkout,
    );
    const globalOnes = report.assertions.filter((a) => a.scope.boundary === 'global');
    expect(ledger.length + checkout.length + globalOnes.length).toBe(37);

    const ledgerStore = MemoryStore.local(corpus.repoIds.ledger, { env, now: () => T0 });
    const checkoutStore = MemoryStore.local(corpus.repoIds.checkout, { env, now: () => T0 });
    const globalStore = MemoryStore.global({ env, now: () => T0 });

    const first = [
      ledgerStore.submitGraphEntries(ledger),
      checkoutStore.submitGraphEntries(checkout),
      globalStore.submitGraphEntries(globalOnes),
    ];
    expect(first.flatMap((r) => r.written)).toHaveLength(37);
    expect(first.flatMap((r) => r.skipped)).toEqual([]);

    // The WP-G1 exit criterion: repeated imports produce the same canonical assertions —
    // the second pass is a byte-identical no-op, acknowledged as skipped.
    const second = [
      ledgerStore.submitGraphEntries(ledger),
      checkoutStore.submitGraphEntries(checkout),
      globalStore.submitGraphEntries(globalOnes),
    ];
    expect(second.flatMap((r) => r.written)).toEqual([]);
    expect(second.flatMap((r) => r.skipped)).toHaveLength(37);
  });
});
