import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
/**
 * G5.4 — the memory-ledger projection tests, two layers:
 *
 *   - the PURE anchor correlation (`correlateAnchor`/`correlateAnchors`/`ledgerGroupOf`): the
 *     "what went stale when the code moved" signal — current / moved (exactly-one reattachment) /
 *     gone (file gone vs symbol gone distinguished) / uncheckable, and the group folding;
 *   - `MemoryApi.ledger`: the full viz projection over a fixture store — effective verdicts via
 *     the SAME decision fold as get(), tombstones VISIBLE in the retracted group, the display
 *     `standing` rename, pagination caps, conflict groups, and NO banned vocabulary in the
 *     serialized response (the Gate-0 user-facing contract).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EffectiveVerdicts,
  LEDGER_GROUPS,
  type MemoryAnchorPort,
  MemoryApi,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordV2,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  correlateAnchor,
  correlateAnchors,
  decisionId,
  derivePropositionKey,
  feedbackId,
  ledgerGroupOf,
  memoryRecordId,
  memoryRecordV2Id,
  reviewReasonsOf,
  standingOf,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';
const REPO = 'r-ledger';
const LIVE_ID = 'sym:src/a.ts#A.b@L10';
const GONE_ID = 'sym:src/gone.ts#G.one@L5';
const MOVED_ID = 'sym:src/b.ts#A.b@L30';

function node(over: { id: string; file: string; qualifiedName?: string; kind?: string }): Node {
  return {
    id: over.id,
    kind: over.kind ?? 'symbol',
    name: (over.qualifiedName ?? 'x').split('.').pop() ?? 'x',
    qualifiedName: over.qualifiedName ?? 'x',
    file: over.file,
    span: { start: 1, end: 10 },
    lang: 'typescript',
    hash: `blake3:${over.id}`,
  } as unknown as Node;
}

// correlateAnchor wants an id→node index over the same node list; ids here ARE the fixture ids.
function index(nodes: Node[]): Map<string, Node> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function quoteEvidence(soulId: string): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: T0,
    soulId,
    quote: 'does the thing',
    targetHash: 'blake3:abcd1234',
  };
}

function v1Record(
  over: {
    subject?: string;
    appliesTo?: string[];
    evidence?: MemoryEvidence[];
    verdicts?: MemoryRecord['verdicts'];
    claim?: string;
  } = {},
): MemoryRecord {
  const subject = over.subject ?? LIVE_ID;
  const input = {
    kind: 'fact' as const,
    subject,
    claim: over.claim ?? 'does the thing',
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: over.appliesTo ?? [subject],
    evidence: over.evidence ?? [quoteEvidence(subject)],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: over.verdicts ?? {
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: T0,
  };
}

function v2Record(
  over: { subject?: string; evidence?: MemoryEvidence[]; claim?: string } = {},
): MemoryRecordV2 {
  const subject = over.subject ?? 'topic:session-lifecycle';
  const kind = 'fact' as const;
  const claim = over.claim ?? 'sessions are recorded';
  const ev = over.evidence ?? [
    { kind: 'human-attestation' as const, verdict: 'valid' as const, checkedAt: T0, actor: 'ci' },
  ];
  return {
    id: memoryRecordV2Id({
      kind,
      subject,
      propositionKey: derivePropositionKey({ subject }),
      claim,
      evidence: ev,
    }),
    schemaVersion: '2',
    visibility: 'workspace',
    kind,
    subject,
    propositionKey: derivePropositionKey({ subject }),
    claim,
    validTime: { from: T0 },
    transactionTime: { observedAt: T0, recordedAt: T0 },
    evidence: ev,
    provenance: {
      principalId: 'principal:local',
      deviceId: 'device:local',
      actorId: 'claude-code',
      agentId: 'claude-code',
      clientId: 'claude-code',
    },
    lineage: {},
    sensitivity: 'internal',
    retentionPolicyId: 'ret:default',
  };
}

function decisionOn(
  subject: string,
  kind: 'retract' | 'supersede' | 'quarantine',
  over: { ts?: string; successor?: string } = {},
) {
  return {
    id: decisionId({
      kind,
      subject,
      actor: 'ci',
      ...(over.successor ? { successor: over.successor } : {}),
    }),
    schemaVersion: '1' as const,
    kind,
    subject,
    ...(over.successor ? { successor: over.successor } : {}),
    actor: 'ci',
    ts: over.ts ?? T0,
  };
}

// ─── pure anchor correlation ──────────────────────────────────────────────────

describe('anchor correlation', () => {
  it('an exact id resolves current', () => {
    const live = node({ id: LIVE_ID, file: 'src/a.ts', qualifiedName: 'A.b' });
    const anchor = correlateAnchor(LIVE_ID, index([live]), [live]);
    expect(anchor.state).toBe('current');
    expect(anchor.kind).toBe('symbol');
  });

  it('a moved symbol reattaches to exactly one live node elsewhere', () => {
    const moved = node({ id: MOVED_ID, file: 'src/b.ts', qualifiedName: 'A.b' });
    const anchor = correlateAnchor(LIVE_ID, index([moved]), [moved]);
    expect(anchor.state).toBe('moved');
    expect(anchor.nowAt).toBe(MOVED_ID);
    expect(anchor.file).toBe('src/b.ts');
  });

  it('a gone symbol reports whether its FILE is gone too (moved file vs deleted symbol)', () => {
    const noFile = correlateAnchor(GONE_ID, index([]), []);
    expect(noFile.state).toBe('gone');
    expect(noFile.reason).toBe('file no longer in the graph');

    const fileAlive = node({
      id: 'sym:src/gone.ts#G.two@L1',
      file: 'src/gone.ts',
      qualifiedName: 'G.two',
    });
    const symbolGone = correlateAnchor(GONE_ID, index([fileAlive]), [fileAlive]);
    expect(symbolGone.state).toBe('gone');
    expect(symbolGone.reason).toBe('symbol not found');
  });

  it('a bare path ref anchors when a live node still sits in that file', () => {
    const live = node({ id: 'file:src/a.ts', kind: 'file', file: 'src/a.ts' });
    const anchor = correlateAnchor('src/a.ts', index([live]), [live]);
    expect(anchor.state).toBe('current');
    expect(anchor.kind).toBe('path');
  });

  it('a topic subject never anchors — v2 session-lifecycle captures stay unanchored, not stale', () => {
    const record = v2Record();
    const { anchors, status } = correlateAnchors(record, index([]), []);
    expect(anchors).toEqual([]);
    expect(status).toBe('unanchored');
  });

  it('a record with no anchors at all is unanchored', () => {
    const record = v1Record({ appliesTo: [], evidence: [] });
    expect(correlateAnchors(record, index([]), []).status).toBe('unanchored');
  });

  it('the record-level status is the worst anchor state, stale beats moved beats current', () => {
    const record = v1Record({
      appliesTo: [LIVE_ID, GONE_ID],
      evidence: [quoteEvidence(LIVE_ID), quoteEvidence(GONE_ID)],
    });
    expect(correlateAnchors(record, index([]), []).status).toBe('stale');
    const moved = node({ id: MOVED_ID, file: 'src/b.ts', qualifiedName: 'A.b' });
    const movedRecord = v1Record({
      appliesTo: [LIVE_ID, MOVED_ID],
      evidence: [quoteEvidence(MOVED_ID)],
    });
    expect(correlateAnchors(movedRecord, index([moved]), [moved]).status).toBe('moved');
  });
});

describe('group folding + standing', () => {
  const active: EffectiveVerdicts = {
    trust: 'local',
    evidence: 'valid',
    applicability: 'current',
    lifecycle: 'active',
    quarantined: false,
    reasons: [],
  };

  it('lifecycle decisions win first — a retracted record is visible, never hidden by staleness', () => {
    expect(ledgerGroupOf({ ...active, lifecycle: 'retracted' }, 'stale')).toBe('retracted');
    expect(ledgerGroupOf({ ...active, lifecycle: 'superseded' }, 'current')).toBe('retracted');
    expect(ledgerGroupOf({ ...active, quarantined: true }, 'current')).toBe('retracted');
  });

  it('the staleness signal ranks stale > moved > unanchored > current', () => {
    expect(ledgerGroupOf(active, 'stale')).toBe('stale');
    expect(ledgerGroupOf(active, 'moved')).toBe('moved');
    expect(ledgerGroupOf(active, 'unanchored')).toBe('unanchored');
    expect(ledgerGroupOf(active, 'unverified')).toBe('unanchored');
    expect(ledgerGroupOf(active, 'current')).toBe('current');
  });

  it('the admission axis maps onto the display standing', () => {
    expect(standingOf('team')).toBe('team');
    expect(standingOf('local')).toBe('local');
    expect(standingOf('candidate')).toBe('staged');
  });

  it('LEDGER_GROUPS renders stale first and stays the sort backbone', () => {
    expect(LEDGER_GROUPS[0]).toBe('stale');
    expect([...LEDGER_GROUPS]).toEqual(['stale', 'moved', 'current', 'unanchored', 'retracted']);
  });
});

// ─── MemoryApi.ledger over a fixture store ────────────────────────────────────

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mem-ledger-home-'));
  env = {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_SYNC_KEY: undefined,
  };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
});

describe('MemoryApi.ledger', () => {
  it('projects the whole ledger with tombstones visible, display verdicts, and no banned vocabulary', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const current = v1Record({ claim: 'A.b does the thing' });
    const stale = v1Record({
      subject: GONE_ID,
      claim: 'G.one did the thing',
      appliesTo: [GONE_ID],
    });
    const retracted = v1Record({ subject: 'sym:src/old.ts#O.ld@L3', claim: 'the old way' });
    const session = v2Record();
    local.upsertEntries('active', [current, stale, retracted, session]);
    local.upsertEntries('decisions', [decisionOn(retracted.id, 'retract')]);
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      soul: {
        getNode: (id: string) =>
          [node({ id: LIVE_ID, file: 'src/a.ts', qualifiedName: 'A.b' })].find((n) => n.id === id),
        allNodes: () => [node({ id: LIVE_ID, file: 'src/a.ts', qualifiedName: 'A.b' })],
        rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
      } as unknown as MemoryAnchorPort,
    });

    const result = api.ledger();
    expect(result.configured).toBe(true);
    expect(result.counts.current).toBe(1);
    expect(result.counts.stale).toBe(1);
    expect(result.counts.unanchored).toBe(1);
    expect(result.counts.retracted).toBe(1);
    expect(result.errors).toEqual([]);

    // The tombstone is part of the ledger: visible with its effective lifecycle, never hidden.
    const tombstone = result.rows.find((r) => r.id === retracted.id);
    expect(tombstone?.group).toBe('retracted');
    expect(tombstone?.lifecycle).toBe('retracted');
    expect(tombstone?.eligible).toBe(false);

    // Display rename: the response carries `standing`, and NO banned word anywhere in the JSON.
    const row = result.rows.find((r) => r.id === current.id)!;
    expect(row.standing).toBe('local');
    expect(row.eligible).toBe(true);
    const v2Row = result.rows.find((r) => r.id === session.id)!;
    expect(v2Row.standing).toBe('staged');
    expect(v2Row.schemaVersion).toBe('2');
    expect(v2Row.retentionPolicyId).toBe('ret:default');
    expect(v2Row.observedAt).toBe(T0);
    const staleRow = result.rows.find((r) => r.id === stale.id)!;
    expect(staleRow.group).toBe('stale');
    expect(staleRow.anchorStatus).toBe('stale');

    // Deterministic group-rank ordering (stale first, tombstones last).
    const ranks = result.rows.map((r) => LEDGER_GROUPS.indexOf(r.group));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);

    // The Gate-0 user-facing contract: no banned word survives into the serialized surface.
    expect(JSON.stringify(result)).not.toMatch(/candidate|trust/i);
  });

  it('paginates with a hard cap and filters by group without hiding whole-ledger counts', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const a = v1Record({ subject: LIVE_ID, claim: 'claim a' });
    const b = v1Record({ subject: GONE_ID, claim: 'claim b', appliesTo: [GONE_ID] });
    local.upsertEntries('active', [a, b]);
    const live = node({ id: LIVE_ID, file: 'src/a.ts', qualifiedName: 'A.b' });
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      soul: {
        getNode: (id: string) => [live].find((n) => n.id === id),
        allNodes: () => [live],
        rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
      } as unknown as MemoryAnchorPort,
    });

    const capped = api.ledger({ limit: 5000 });
    expect(capped.limit).toBe(200); // MAX_LEDGER_PAGE — the payload cannot be inflated
    expect(capped.total).toBe(2);

    const page = api.ledger({ offset: 1, limit: 1 });
    expect(page.rows).toHaveLength(1);
    expect(page.offset).toBe(1);

    const staleOnly = api.ledger({ group: 'stale' });
    expect(staleOnly.rows.every((r) => r.group === 'stale')).toBe(true);
    expect(staleOnly.total).toBe(1); // filtered
    expect(staleOnly.counts.current).toBe(1); // counts still cover the WHOLE ledger
  });

  it('surfaces conflicts through the evaluator group projection and tags the rows', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const a = v1Record({ subject: LIVE_ID, claim: 'claim a' });
    const b = v1Record({ subject: LIVE_ID, claim: 'claim b (contradicts a)' });
    local.upsertEntries('active', [a, b]);
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      soul: {
        getNode: () => undefined,
        allNodes: () => [],
        rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
      } as unknown as MemoryAnchorPort,
    });

    const result = api.ledger();
    expect(result.counts.conflicts).toBe(1);
    expect([...(result.conflicts[0]?.recordIds ?? [])].sort()).toEqual([a.id, b.id].sort());
    expect(result.rows.every((r) => r.conflicts.length === 1)).toBe(true);
  });

  it('honors the no-poison rule — a local quarantine never retires a team record', () => {
    const crib = mkdtempSync(join(tmpdir(), 'mem-ledger-team-'));
    const team = MemoryStore.team(crib, { env, now: () => T0 });
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const record = v1Record({ subject: LIVE_ID, claim: 'team claim' });
    team.upsertEntries('records', [record]);
    local.upsertEntries('decisions', [decisionOn(record.id, 'quarantine')]);
    const api = new MemoryApi({
      stores: { team, local },
      env,
      now: () => T0,
      soul: {
        getNode: () => undefined,
        allNodes: () => [],
        rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
      } as unknown as MemoryAnchorPort,
    });

    const result = api.ledger();
    const row = result.rows.find((r) => r.id === record.id)!;
    expect(row.source).toBe('team');
    expect(row.quarantined).toBe(false); // local decision did NOT poison the team record
    expect(row.group).toBe('stale'); // no live node for the anchor — staleness, not the quarantine
  });

  it('keeps folded verdicts identical to get() — the same decision truth, one projection', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const record = v1Record({ subject: LIVE_ID, claim: 'claim' });
    local.upsertEntries('active', [record]);
    local.upsertEntries('decisions', [decisionOn(record.id, 'quarantine')]);
    const api = new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      soul: {
        getNode: () => undefined,
        allNodes: () => [],
        rehydrate: () => ({ text: '', truncated: false, totalLines: 0, startLine: 1 }),
      } as unknown as MemoryAnchorPort,
    });

    const ledgerRow = api.ledger().rows.find((r) => r.id === record.id)!;
    const gotten = api.get(record.id);
    expect(gotten.found).toBe(true);
    // Every verdict axis the ledger row carries equals the get() fold — the projection reuses
    // the same effectiveVerdicts fold, never a parallel truth.
    expect(ledgerRow.standing).toBe('local');
    expect(ledgerRow.evidenceVerdict).toBe(gotten.verdicts?.evidence);
    expect(ledgerRow.applicability).toBe(gotten.verdicts?.applicability);
    expect(ledgerRow.lifecycle).toBe(gotten.verdicts?.lifecycle);
    expect(ledgerRow.quarantined).toBe(gotten.verdicts?.quarantined);
    expect(ledgerRow.quarantined).toBe(true);
  });
});

// ─── working views: Active / Needs review (UI remediation Phase 2) ───────────

describe('reviewReasonsOf', () => {
  const base = {
    standing: 'local' as const,
    evidenceVerdict: 'valid' as const,
    applicability: 'current' as const,
    lifecycle: 'active' as const,
    quarantined: false,
    eligible: true,
    conflicts: [],
    concern: false,
  };

  it('a healthy active record needs nothing', () => {
    expect(reviewReasonsOf(base)).toEqual([]);
  });

  it('degraded evidence asks for review without blocking recall', () => {
    expect(reviewReasonsOf({ ...base, evidenceVerdict: 'degraded' })).toEqual([
      { code: 'evidence-degraded', blocking: false },
    ]);
  });

  it('names every recall exclusion, blocking reasons before advisory ones', () => {
    const reasons = reviewReasonsOf({
      ...base,
      standing: 'staged',
      evidenceVerdict: 'invalid',
      applicability: 'orphaned',
      quarantined: true,
      eligible: false,
      conflicts: [{}],
      concern: true,
    });
    expect(reasons.map((r) => r.code)).toEqual([
      'not-admitted',
      'evidence-invalid',
      'applicability-orphaned',
      'quarantined',
      'conflict',
      'concern',
    ]);
    const firstAdvisory = reasons.findIndex((r) => !r.blocking);
    expect(reasons.slice(firstAdvisory).every((r) => !r.blocking)).toBe(true);
  });

  it('an ineligible row is never classified as needing nothing', () => {
    expect(reviewReasonsOf({ ...base, eligible: false })).toEqual([
      { code: 'not-recall-eligible', blocking: true },
    ]);
  });

  it('retired records carry no review reasons — their lifecycle settled them', () => {
    expect(
      reviewReasonsOf({ ...base, lifecycle: 'retracted', evidenceVerdict: 'invalid' }),
    ).toEqual([]);
    expect(reviewReasonsOf({ ...base, lifecycle: 'superseded', concern: true })).toEqual([]);
  });
});

describe('MemoryApi.ledger working views', () => {
  // One live symbol per fixture record: records sharing a subject with different claims form a
  // conflict group, which would blur every other state under test.
  const subjectFor = (name: string) => `sym:src/${name}.ts#S.${name}@L1`;
  const liveNodes = [
    'valid',
    'degraded',
    'invalid',
    'stale',
    'quarantined',
    'conflict',
    'concerned',
    'retired',
    'staged',
    'many',
  ].map((name) =>
    node({ id: subjectFor(name), file: `src/${name}.ts`, qualifiedName: `S.${name}` }),
  );
  const at = (name: string, claim: string, over: Partial<MemoryRecord['verdicts']> = {}) =>
    v1Record({ subject: subjectFor(name), claim, verdicts: verdicts(over) });
  function apiOver(local: MemoryStore) {
    return new MemoryApi({
      stores: { local },
      env,
      now: () => T0,
      soul: {
        getNode: (id: string) => liveNodes.find((n) => n.id === id),
        allNodes: () => liveNodes,
        rehydrate: () => ({ text: '', truncated: false, totalLines: 1, startLine: 1 }),
      } as unknown as MemoryAnchorPort,
    });
  }
  const verdicts = (over: Partial<MemoryRecord['verdicts']>): MemoryRecord['verdicts'] => ({
    trust: 'local',
    evidence: 'valid',
    applicability: 'current',
    lifecycle: 'active',
    ...over,
  });

  function seedEveryState() {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const valid = at('valid', 'valid claim');
    const degraded = at('degraded', 'degraded claim', { evidence: 'degraded' });
    const invalid = at('invalid', 'invalid claim', { evidence: 'invalid' });
    const stale = at('stale', 'stale claim', { applicability: 'needs-review' });
    const moved = v1Record({
      subject: MOVED_ID,
      appliesTo: [MOVED_ID],
      claim: 'moved claim',
      verdicts: verdicts({ applicability: 'orphaned' }),
    });
    const quarantined = at('quarantined', 'quarantined claim');
    const conflictA = at('conflict', 'S.conflict returns a');
    const conflictB = at('conflict', 'S.conflict returns b');
    const concerned = at('concerned', 'reported claim');
    const retired = at('retired', 'retired claim');
    const staged = at('staged', 'staged claim', { trust: 'candidate' });
    local.upsertEntries('active', [
      valid,
      degraded,
      invalid,
      stale,
      moved,
      quarantined,
      conflictA,
      conflictB,
      concerned,
      retired,
      staged,
    ]);
    local.upsertEntries('decisions', [
      decisionOn(quarantined.id, 'quarantine'),
      decisionOn(retired.id, 'retract'),
    ]);
    const signal = 'contradicted' as const;
    local.upsertEntries('feedback', [
      {
        id: feedbackId({ signal, subject: concerned.id, actor: 'human:reviewer' }),
        schemaVersion: '1' as const,
        signal,
        subject: concerned.id,
        actor: 'human:reviewer',
        ts: T0,
      },
    ]);
    return {
      api: apiOver(local),
      ids: {
        valid,
        degraded,
        invalid,
        stale,
        moved,
        quarantined,
        conflictA,
        conflictB,
        concerned,
        retired,
        staged,
      },
    };
  }

  it('Active is exactly the recall gate; Needs review names why; they overlap on degraded', () => {
    const { api, ids } = seedEveryState();
    const all = api.ledger({ limit: 200 });
    const active = api.ledger({ view: 'active', limit: 200 });
    const review = api.ledger({ view: 'needs-review', limit: 200 });

    expect(active.rows.every((r) => r.eligible)).toBe(true);
    expect(active.total).toBe(all.rows.filter((r) => r.eligible).length);
    const activeIds = new Set(active.rows.map((r) => r.id));
    expect(activeIds.has(ids.valid.id)).toBe(true);
    expect(activeIds.has(ids.degraded.id)).toBe(true);
    expect(activeIds.has(ids.concerned.id)).toBe(true);

    const reasonsOf = (id: string) =>
      review.rows.find((r) => r.id === id)?.reviewReasons.map((x) => x.code) ?? [];
    expect(reasonsOf(ids.valid.id)).toEqual([]);
    expect(reasonsOf(ids.degraded.id)).toEqual(['evidence-degraded']);
    expect(reasonsOf(ids.invalid.id)).toEqual(['evidence-invalid']);
    expect(reasonsOf(ids.stale.id)).toContain('applicability-needs-review');
    expect(reasonsOf(ids.moved.id)).toContain('applicability-orphaned');
    expect(reasonsOf(ids.quarantined.id)).toContain('quarantined');
    expect(reasonsOf(ids.conflictA.id)).toContain('conflict');
    expect(reasonsOf(ids.conflictB.id)).toContain('conflict');
    expect(reasonsOf(ids.concerned.id)).toEqual(['concern']);
    expect(reasonsOf(ids.staged.id)).toContain('not-admitted');
    // Retired records live in History, not in the working review queue.
    expect(review.rows.some((r) => r.id === ids.retired.id)).toBe(false);
    expect(all.rows.some((r) => r.id === ids.retired.id)).toBe(true);

    // The overlap is real and explained by the reasons: eligible rows in review are advisory-only.
    const overlap = review.rows.filter((r) => activeIds.has(r.id));
    expect(overlap.map((r) => r.id).sort()).toEqual(
      [ids.degraded.id, ids.conflictA.id, ids.conflictB.id, ids.concerned.id].sort(),
    );
    expect(overlap.every((r) => r.reviewReasons.every((x) => !x.blocking))).toBe(true);
  });

  it('whole-ledger view counts equal the totals of the views they open', () => {
    const { api } = seedEveryState();
    const counts = api.ledger({ limit: 1 }).views;
    expect(counts.active).toBe(api.ledger({ view: 'active', limit: 1 }).total);
    expect(counts.needsReview).toBe(api.ledger({ view: 'needs-review', limit: 1 }).total);
    // Views never change History: the unfiltered total and group counts are the whole ledger.
    const history = api.ledger({ limit: 1 });
    expect(history.total).toBe(11);
    expect(Object.values(history.views).every((n) => n <= history.total)).toBe(true);
  });

  it('Needs review sorts blocking reasons first, then newest, then id', () => {
    const { api } = seedEveryState();
    const rows = api.ledger({ view: 'needs-review', limit: 200 }).rows;
    const rank = rows.map((r) => (r.reviewReasons.some((x) => x.blocking) ? 0 : 1));
    expect([...rank].sort((a, b) => a - b)).toEqual(rank);
    const blockingIds = rows.filter((r) => rank[rows.indexOf(r)] === 0).map((r) => r.id);
    expect([...blockingIds].sort()).toEqual(blockingIds); // equal times → stable id order
  });

  it('pages every record beyond the first page and rejects group combined with view', () => {
    const local = MemoryStore.local(REPO, { env, now: () => T0 });
    const many = Array.from({ length: 230 }, (_, i) =>
      at('many', `claim ${String(i).padStart(3, '0')}`, { evidence: 'degraded' }),
    );
    local.upsertEntries('active', many);
    const api = apiOver(local);
    const seen = new Set<string>();
    const total = api.ledger({ limit: 1 }).views.needsReview;
    expect(total).toBe(230);
    for (let offset = 0; offset < total; offset += 50) {
      const page = api.ledger({ view: 'needs-review', offset, limit: 50 });
      expect(page.rows.length).toBeLessThanOrEqual(50);
      for (const row of page.rows) seen.add(row.id);
    }
    expect(seen.size).toBe(230);
    expect(() => api.ledger({ view: 'active', group: 'stale' })).toThrow(/cannot be combined/);
  });

  it('keeps the unfiltered History ordering and adds no banned vocabulary', () => {
    const { api } = seedEveryState();
    const history = api.ledger({ limit: 200 });
    const ranks = history.rows.map((r) => LEDGER_GROUPS.indexOf(r.group));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(JSON.stringify(api.ledger({ view: 'needs-review', limit: 200 }))).not.toMatch(
      /candidate|trust/i,
    );
  });
});
