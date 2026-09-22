/**
 * WP-G2 — the authorized temporal projection laws (the plan's WP-G2 items 1–4 and 6):
 *
 *   - authorization: a viewer NEVER sees a foreign principal's assertions (zero foreign
 *     disclosure), and a global-scoped viewer never sees a repo-scoped one; a repo-scoped
 *     viewer sees its own repo plus the global scope, never another repo's;
 *   - temporal: the current view honors BOTH time axes — `at` (valid time: when the
 *     relationship held) and `knownBy` (transaction time: what the store had learned) — so a
 *     historical query at T reconstructs exactly what an authorized viewer would have seen at
 *     T, including the alias state of that moment (decisions folded only up to `knownBy`);
 *   - contradiction preservation: two assertions that disagree (same canonical subject +
 *     predicate, different objects) BOTH stay in the current view and BOTH stay traversable —
 *     the projection never resolves a conflict by recency (never last-write-wins), it only
 *     GROUPS the disagreement (`conflicts`) so the owner can see it;
 *   - aliases: `establish`/`reverse` resolution decisions fold IN ORDER into undirected
 *     bindings; canonical resolution is deterministic (the lexicographically least ref in the
 *     connected component), a decision that would close an alias cycle is REJECTED (reported,
 *     never applied), and a `reverse` with no matching binding is a reported no-op;
 *   - unsupported exclusion: an assertion NONE of whose supporters resolve in the gathered
 *     universe (records by id, entities by ref/id, caller-known refs) is excluded from every
 *     trusted view — current, timeline, traversal, counts, export — and retained in
 *     `diagnostics` for the owner (diagnostic visibility without trust);
 *   - exit surface: neighbors (with alias expansion), bounded paths, per-predicate counts, and
 *     a deterministic JSONL export — all over the authorized, supported, temporally-windowed
 *     view, so repeated projections of the same inputs are byte-identical.
 */
import { describe, expect, it } from 'vitest';
import {
  exportGraphProjection,
  graphNeighbors,
  graphPath,
  projectGraph,
} from './graph-projection.js';
import { createGraphAssertion, createGraphEntity, createGraphResolutionDecision } from './graph.js';
import type { MemoryGraphPredicate } from './graph.js';
import type {
  GraphAssertion,
  GraphEntity,
  GraphResolutionDecision,
  MemoryNamespace,
  MemoryProvenance,
  MemoryScope,
} from './types.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';
const T3 = '2026-04-01T00:00:00.000Z';

const P1 = 'principal:p1';
const P2 = 'principal:p2';
const GLOBAL: MemoryScope = { boundary: 'global' };
const REPO_A: MemoryScope = { boundary: 'repo', repoId: 'repoa' };
const REPO_B: MemoryScope = { boundary: 'repo', repoId: 'repob' };

const SUPPORTER = 'mem:supporter';

function assertion(input: {
  predicate: MemoryGraphPredicate;
  subject: string;
  object: string;
  principalId?: string;
  scope?: MemoryScope;
  validAt?: string;
  knownAt?: string;
  supportedBy?: string[];
}): GraphAssertion {
  const principalId = input.principalId ?? P1;
  const namespace: MemoryNamespace = { principalId };
  const provenance: MemoryProvenance = {
    principalId,
    deviceId: 'device:projection-test',
    actorId: 'agent:projection-test',
    clientId: 'vitest',
  };
  return createGraphAssertion({
    predicate: input.predicate,
    subject: input.subject,
    object: input.object,
    namespace,
    scope: input.scope ?? GLOBAL,
    validAt: input.validAt ?? T0,
    knownAt: input.knownAt ?? T1,
    supportedBy: input.supportedBy ?? [SUPPORTER],
    provenance,
  });
}

function decision(input: {
  kind: 'establish' | 'reverse';
  entityA: string;
  entityB: string;
  ts?: string;
  principalId?: string;
  scope?: MemoryScope;
}): GraphResolutionDecision {
  const principalId = input.principalId ?? P1;
  return createGraphResolutionDecision({
    kind: input.kind,
    entityA: input.entityA,
    entityB: input.entityB,
    namespace: { principalId },
    scope: input.scope ?? GLOBAL,
    provenance: {
      principalId,
      deviceId: 'device:projection-test',
      actorId: 'agent:projection-test',
      clientId: 'vitest',
    },
    actor: 'agent:projection-test',
    ts: input.ts ?? T1,
  });
}

const RECORDS = [{ id: SUPPORTER }];

function entity(ref: string, opts?: { scope?: MemoryScope }): GraphEntity {
  // ref like `entity:OrderService` (global) or `entity:repoa/OrderService` (repo).
  const local = ref.slice('entity:'.length);
  const scope = opts?.scope ?? GLOBAL;
  const name = local.includes('/') ? local.slice(local.indexOf('/') + 1) : local;
  const principalId = P1;
  return createGraphEntity({
    kind: 'concept',
    name,
    namespace: { principalId },
    scope,
    provenance: {
      principalId,
      deviceId: 'device:projection-test',
      actorId: 'agent:projection-test',
      clientId: 'vitest',
    },
  });
}

// ─── authorization (item 2) ────────────────────────────────────────────────────

describe('WP-G2 projection — authorization', () => {
  it("never discloses a foreign principal's assertions", () => {
    const mine = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1' });
    const theirs = assertion({
      predicate: 'about',
      subject: 'mem:b',
      object: 'topic:t1',
      principalId: P2,
    });
    const p = projectGraph(
      { assertions: [mine, theirs], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.current.map((a) => a.id)).toEqual([mine.id]);
    expect(p.diagnostics.excludedForeign).toBe(0);
  });

  it('a global viewer never sees repo-scoped assertions (isolation)', () => {
    const globalEdge = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1' });
    const repoEdge = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:t2',
      scope: REPO_A,
    });
    const p = projectGraph(
      { assertions: [globalEdge, repoEdge], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.current.map((a) => a.id)).toEqual([globalEdge.id]);
  });

  it('a repo viewer sees its own repo plus global, never another repo', () => {
    const globalEdge = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1' });
    const ownRepo = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:t2',
      scope: REPO_A,
    });
    const otherRepo = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:t3',
      scope: REPO_B,
    });
    const p = projectGraph(
      { assertions: [globalEdge, ownRepo, otherRepo], records: RECORDS },
      { principalId: P1, scope: REPO_A },
    );
    expect(new Set(p.current.map((a) => a.id))).toEqual(new Set([globalEdge.id, ownRepo.id]));
  });

  it('does not fold a foreign principal alias decision into the caller graph', () => {
    const edgeOfB = assertion({
      predicate: 'part-of',
      subject: 'sym:svc/b.ts#beta',
      object: 'entity:svc-b',
    });
    const foreign = decision({
      kind: 'establish',
      entityA: 'entity:svc-a',
      entityB: 'entity:svc-b',
      principalId: P2,
    });
    const p = projectGraph(
      { assertions: [edgeOfB], decisions: [foreign], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );

    expect(p.aliases.bindings).toEqual([]);
    expect(graphNeighbors(p, 'entity:svc-a')).toEqual([]);
  });
});

// ─── temporal correctness (item 1) ────────────────────────────────────────────

describe('WP-G2 projection — temporal views', () => {
  it('excludes not-yet-valid assertions from an as-of current view', () => {
    const early = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1' });
    const late = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:t2',
      validAt: T3,
    });
    const atT1 = projectGraph(
      { assertions: [early, late], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
      { at: T1 },
    );
    expect(atT1.current.map((a) => a.id)).toEqual([early.id]);
    // history still knows the later assertion exists as a timeline entry
    expect(atT1.timeline.map((a) => a.id)).toContain(late.id);
  });

  it('honors transaction time: an assertion learned later is absent from the view as known then', () => {
    const heldLongAgo = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:t1',
      validAt: T0,
      knownAt: T3,
    });
    const asKnownAtT1 = projectGraph(
      { assertions: [heldLongAgo], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
      { knownBy: T1 },
    );
    expect(asKnownAtT1.current).toEqual([]);
    const asKnownNow = projectGraph(
      { assertions: [heldLongAgo], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(asKnownNow.current.map((a) => a.id)).toEqual([heldLongAgo.id]);
  });

  it('timeline keeps every version ordered by (validAt, id) — versions are never folded', () => {
    const v1 = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1', validAt: T0 });
    const v2 = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1', validAt: T2 });
    const p = projectGraph(
      { assertions: [v2, v1], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.timeline.map((a) => a.id)).toEqual([v1.id, v2.id]);
  });

  it('alias decisions fold only up to the transaction-time bound (temporal aliases)', () => {
    const edgeOfB = assertion({
      predicate: 'part-of',
      subject: 'sym:svc/b.ts#beta',
      object: 'entity:svc-b',
    });
    const establishAtT1 = decision({
      kind: 'establish',
      entityA: 'entity:svc-a',
      entityB: 'entity:svc-b',
      ts: T1,
    });
    const before = projectGraph(
      { assertions: [edgeOfB], decisions: [establishAtT1], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
      { knownBy: T0 },
    );
    // before the decision was recorded, entity:svc-a is NOT an alias of entity:svc-b
    expect(before.aliases.bindings).toEqual([]);
    expect(graphNeighbors(before, 'entity:svc-a')).toEqual([]);

    const after = projectGraph(
      { assertions: [edgeOfB], decisions: [establishAtT1], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
      { knownBy: T2 },
    );
    expect(after.aliases.bindings).toEqual([{ entityA: 'entity:svc-a', entityB: 'entity:svc-b' }]);
    // traversal through the alias: svc-a's neighborhood includes beta's part-of edge
    const n = graphNeighbors(after, 'entity:svc-a');
    expect(n.map((a) => a.id)).toEqual([edgeOfB.id]);
  });
});

// ─── contradiction preservation (item 3) ──────────────────────────────────────

describe('WP-G2 projection — contradiction preservation', () => {
  it('keeps BOTH contradictory assertions traversable and groups the disagreement', () => {
    const saysX = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:claim-x',
      validAt: T0,
    });
    const saysY = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:claim-y',
      validAt: T2,
    });
    const p = projectGraph(
      { assertions: [saysX, saysY], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    // never last-write-wins: both survive in the current view
    expect(new Set(p.current.map((a) => a.id))).toEqual(new Set([saysX.id, saysY.id]));
    // both stay traversable from the disputed subject
    expect(new Set(graphNeighbors(p, 'mem:a').map((a) => a.id))).toEqual(
      new Set([saysX.id, saysY.id]),
    );
    // the disagreement is surfaced, not resolved
    expect(p.conflicts).toEqual([
      {
        subject: 'mem:a',
        predicate: 'about',
        objects: ['topic:claim-x', 'topic:claim-y'],
        assertionIds: [saysX.id, saysY.id].sort(),
      },
    ]);
  });

  it('does not group a single-object predicate as a conflict', () => {
    const only = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1' });
    const p = projectGraph(
      { assertions: [only], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.conflicts).toEqual([]);
  });
});

// ─── reversible aliases, deterministic resolution, cycle rejection (item 4) ─────

describe('WP-G2 projection — aliases', () => {
  it('resolves canonically to the least ref and expands traversal across the binding', () => {
    const edgeOfB = assertion({
      predicate: 'part-of',
      subject: 'sym:svc/b.ts#beta',
      object: 'entity:svc-b',
    });
    const p = projectGraph(
      {
        assertions: [edgeOfB],
        decisions: [
          decision({ kind: 'establish', entityA: 'entity:svc-b', entityB: 'entity:svc-a' }),
        ],
        records: RECORDS,
      },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.aliases.canonical).toEqual({
      'entity:svc-a': 'entity:svc-a',
      'entity:svc-b': 'entity:svc-a',
    });
    expect(graphNeighbors(p, 'entity:svc-b').map((a) => a.id)).toEqual([edgeOfB.id]);
  });

  it('is reversible: a reverse decision removes the binding and un-merges traversal', () => {
    const edgeOfB = assertion({
      predicate: 'part-of',
      subject: 'sym:svc/b.ts#beta',
      object: 'entity:svc-b',
    });
    const p = projectGraph(
      {
        assertions: [edgeOfB],
        decisions: [
          decision({ kind: 'establish', entityA: 'entity:svc-a', entityB: 'entity:svc-b', ts: T1 }),
          decision({ kind: 'reverse', entityA: 'entity:svc-a', entityB: 'entity:svc-b', ts: T2 }),
        ],
        records: RECORDS,
      },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.aliases.bindings).toEqual([]);
    expect(p.aliases.canonical).toEqual({});
    expect(graphNeighbors(p, 'entity:svc-a')).toEqual([]);
  });

  it('rejects an establish that would close an alias cycle, and reports it', () => {
    const p = projectGraph(
      {
        assertions: [],
        decisions: [
          decision({ kind: 'establish', entityA: 'entity:a', entityB: 'entity:b', ts: T0 }),
          decision({ kind: 'establish', entityA: 'entity:b', entityB: 'entity:c', ts: T1 }),
          decision({ kind: 'establish', entityA: 'entity:a', entityB: 'entity:c', ts: T2 }),
        ],
        records: RECORDS,
      },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.aliases.bindings).toEqual([
      { entityA: 'entity:a', entityB: 'entity:b' },
      { entityA: 'entity:b', entityB: 'entity:c' },
    ]);
    expect(p.diagnostics.rejectedDecisions).toHaveLength(1);
    expect(p.diagnostics.rejectedDecisions[0]?.reason).toBe('alias-cycle');
    // resolution stays deterministic: the component {a,b,c} canonical is the least ref
    expect(p.aliases.canonical['entity:c']).toBe('entity:a');
  });

  it('reports a reverse with no matching binding as a no-op, never an error', () => {
    const p = projectGraph(
      {
        assertions: [],
        decisions: [decision({ kind: 'reverse', entityA: 'entity:a', entityB: 'entity:b' })],
        records: RECORDS,
      },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.aliases.bindings).toEqual([]);
    expect(p.diagnostics.rejectedDecisions).toEqual([
      { id: p.diagnostics.rejectedDecisions[0]?.id, reason: 'reverse-without-establish' },
    ]);
  });

  it('folds decisions deterministically regardless of their array order', () => {
    const d0 = decision({ kind: 'establish', entityA: 'entity:a', entityB: 'entity:b', ts: T0 });
    const d1 = decision({ kind: 'reverse', entityA: 'entity:a', entityB: 'entity:b', ts: T1 });
    const d2 = decision({ kind: 'establish', entityA: 'entity:a', entityB: 'entity:b', ts: T2 });
    const forward = projectGraph(
      { assertions: [], decisions: [d0, d1, d2], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    const shuffled = projectGraph(
      { assertions: [], decisions: [d2, d0, d1], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(shuffled).toEqual(forward);
    // establish → reverse → re-establish leaves exactly one effective binding
    expect(forward.aliases.bindings).toEqual([{ entityA: 'entity:a', entityB: 'entity:b' }]);
  });
});

// ─── unsupported exclusion with owner diagnostics (item 6) ────────────────────

describe('WP-G2 projection — unsupported exclusion', () => {
  it('excludes an assertion with no resolvable supporter from every trusted surface', () => {
    const supported = assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1' });
    const orphan = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:t2',
      supportedBy: ['mem:nowhere'],
    });
    const p = projectGraph(
      { assertions: [supported, orphan], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.current.map((a) => a.id)).toEqual([supported.id]);
    expect(p.timeline.map((a) => a.id)).toEqual([supported.id]);
    expect(graphNeighbors(p, 'mem:a').map((a) => a.id)).toEqual([supported.id]);
    expect(p.counts.total).toBe(1);
    // diagnostic visibility for the owner: WHICH assertion, WHICH supporters missed
    expect(p.diagnostics.unsupported).toEqual([
      { id: orphan.id, missingSupporters: ['mem:nowhere'] },
    ]);
  });

  it('counts an entity ref (and entity id) as a resolvable supporter', () => {
    const svc = entity('entity:svc-a');
    const byRef = assertion({
      predicate: 'part-of',
      subject: 'sym:svc/a.ts#alpha',
      object: 'entity:svc-a',
      supportedBy: ['entity:svc-a'],
    });
    const byId = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'entity:svc-a',
      supportedBy: [svc.id],
    });
    const p = projectGraph(
      { assertions: [byRef, byId], records: RECORDS, entities: [svc] },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.diagnostics.unsupported).toEqual([]);
    expect(p.counts.total).toBe(2);
  });

  it('honors caller-known refs (receipts and other anchors outside the memory store)', () => {
    const anchored = assertion({
      predicate: 'supported-by',
      subject: 'mem:a',
      object: 'rcpt:gate-1',
      supportedBy: ['rcpt:gate-1'],
    });
    const p = projectGraph(
      { assertions: [anchored], records: RECORDS, knownRefs: ['rcpt:gate-1'] },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.diagnostics.unsupported).toEqual([]);
    expect(p.counts.total).toBe(1);
  });
});

// ─── exit surface: paths, counts, exports (exit criterion) ─────────────────────

describe('WP-G2 projection — traversal, counts, and export', () => {
  const chain = [
    assertion({ predicate: 'about', subject: 'mem:a', object: 'topic:t1' }),
    assertion({ predicate: 'about', subject: 'topic:t1', object: 'sym:svc/x.ts#alpha' }),
    assertion({ predicate: 'part-of', subject: 'sym:svc/x.ts#alpha', object: 'entity:svc-x' }),
  ];

  it('finds a multi-hop path through the current view', () => {
    const p = projectGraph(
      { assertions: chain, records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    const path = graphPath(p, 'mem:a', 'entity:svc-x', { maxHops: 4 });
    expect(path?.map((a) => a.id)).toEqual([chain[0]?.id, chain[1]?.id, chain[2]?.id]);
  });

  it('respects the hop bound', () => {
    const p = projectGraph(
      { assertions: chain, records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(graphPath(p, 'mem:a', 'entity:svc-x', { maxHops: 2 })).toBeNull();
    expect(graphPath(p, 'mem:a', 'entity:svc-x', { maxHops: 3 })).not.toBeNull();
  });

  it('counts per predicate over the trusted current view only', () => {
    const orphan = assertion({
      predicate: 'about',
      subject: 'mem:z',
      object: 'topic:t9',
      supportedBy: ['mem:nowhere'],
    });
    const p = projectGraph(
      { assertions: [...chain, orphan], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.counts).toEqual({
      about: 2,
      'applies-to': 0,
      'supported-by': 0,
      'derived-from': 0,
      supersedes: 0,
      contradicts: 0,
      'part-of': 1,
      affects: 0,
      total: 3,
    });
  });

  it('exports a deterministic, sorted, one-assertion-per-line JSONL view', () => {
    const p1 = projectGraph(
      { assertions: chain, records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    const p2 = projectGraph(
      { assertions: [...chain].reverse(), records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    const e1 = exportGraphProjection(p1);
    const e2 = exportGraphProjection(p2);
    expect(e1).toBe(e2);
    const lines = e1.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([...chain].map((a) => a.id).sort());
  });

  it('the whole projection is deterministic and never mutates its inputs', () => {
    const decisions = [
      decision({ kind: 'establish', entityA: 'entity:a', entityB: 'entity:b', ts: T0 }),
      decision({ kind: 'reverse', entityA: 'entity:a', entityB: 'entity:b', ts: T1 }),
    ];
    const input = { assertions: [...chain], decisions, records: RECORDS };
    const snapshot = JSON.parse(JSON.stringify(input));
    const p1 = projectGraph(input, { principalId: P1, scope: GLOBAL });
    const p2 = projectGraph(input, { principalId: P1, scope: GLOBAL });
    expect(p2).toEqual(p1);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});

describe('WP-G5 projection — supersession is history, and conflicts are real disagreements', () => {
  it('keeps an assertion supported only by a superseded record in history, never current', () => {
    const edge = assertion({ predicate: 'about', subject: 'mem:old', object: 'topic:t' });
    const p = projectGraph(
      { assertions: [edge], records: [], historicalRecords: [{ id: SUPPORTER }] },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.current).toEqual([]);
    expect(p.timeline.map((a) => a.id)).toEqual([edge.id]);
    expect(p.historical.map((a) => a.id)).toEqual([edge.id]);
    expect(p.historicalRefs).toEqual([SUPPORTER]);
    expect(p.diagnostics.unsupported).toEqual([]);
  });

  it('an active supporter keeps the assertion current even when another supporter is superseded', () => {
    const edge = assertion({
      predicate: 'about',
      subject: 'mem:a',
      object: 'topic:t',
      supportedBy: [SUPPORTER, 'mem:retired'],
    });
    const p = projectGraph(
      { assertions: [edge], records: RECORDS, historicalRecords: [{ id: 'mem:retired' }] },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.current.map((a) => a.id)).toEqual([edge.id]);
    expect(p.historical).toEqual([]);
  });

  it('never knows an edge before both of its record endpoints were recorded', () => {
    const early = assertion({
      predicate: 'contradicts',
      subject: 'mem:a',
      object: 'mem:b',
      knownAt: T0,
      validAt: T0,
    });
    const input = {
      assertions: [early],
      records: [{ id: SUPPORTER }, { id: 'mem:a', knownAt: T0 }, { id: 'mem:b', knownAt: T2 }],
    };
    const viewer = { principalId: P1, scope: GLOBAL };
    expect(projectGraph(input, viewer, { knownBy: T1 }).current).toEqual([]);
    expect(projectGraph(input, viewer, { knownBy: T1 }).historical).toEqual([]);
    expect(projectGraph(input, viewer, { knownBy: T3 }).current.map((a) => a.id)).toEqual([
      early.id,
    ]);
  });

  it('does not call several objects of a multi-valued predicate a conflict', () => {
    const p = projectGraph(
      {
        assertions: [
          assertion({ predicate: 'supported-by', subject: 'mem:a', object: 'artifact:x' }),
          assertion({ predicate: 'supported-by', subject: 'mem:a', object: 'artifact:y' }),
          assertion({ predicate: 'affects', subject: 'topic:t', object: 'sym:f' }),
          assertion({ predicate: 'affects', subject: 'topic:t', object: 'sym:g' }),
        ],
        records: RECORDS,
      },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.conflicts).toEqual([]);
  });

  it('groups an explicit contradiction in both directions as one disagreement', () => {
    const ab = assertion({ predicate: 'contradicts', subject: 'mem:b', object: 'mem:a' });
    const ba = assertion({ predicate: 'contradicts', subject: 'mem:a', object: 'mem:b' });
    const p = projectGraph(
      { assertions: [ab, ba], records: RECORDS },
      { principalId: P1, scope: GLOBAL },
    );
    expect(p.conflicts).toEqual([
      {
        subject: 'mem:a',
        predicate: 'contradicts',
        objects: ['mem:a', 'mem:b'],
        assertionIds: [ab.id, ba.id].sort(),
      },
    ]);
  });
});
