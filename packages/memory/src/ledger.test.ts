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
  ledgerGroupOf,
  memoryRecordId,
  memoryRecordV2Id,
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
