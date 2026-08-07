import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * W5 Slice 1 — the structured attempt-lifecycle recorder: pure compaction/GC selectors + the
 * store-coupled compactAttempt / gcUnpromotedAttempts wrappers (PRD lines 354–360).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AttemptEvent,
  type MemoryCandidate,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  appendAttemptEvent,
  attemptEventId,
  attemptEventsFor,
  attemptLastActivity,
  buildAttemptEvent,
  compactAttempt,
  compactAttemptEvents,
  gcUnpromotedAttempts,
  isAttemptPromoted,
  unpromotedAttemptIds,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-attempt';
const DAY = 24 * 60 * 60 * 1000;
let home = '';
let regDir = '';
let env: NodeJS.ProcessEnv;
let crib = '';
let local: MemoryStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'att-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'att-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();
  crib = mkdtempSync(join(tmpdir(), 'att-crib-'));
  // readRepoId reads <cribDir>/crib.json → stamp a stable repo.id so MemoryStore.local resolves.
  writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: REPO, root: '.' } }));
  local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
  rmSync(crib, { recursive: true, force: true });
});

/** A minimal structured summary (the ONLY prose an attempt carries — PRD line 355). */
function summary(text: string): AttemptEvent['observation'] {
  return { summary: text, fileRefs: ['src/a.ts'], receiptIds: ['rcpt:abc'] };
}

function event(
  attemptId: string,
  phase: AttemptEvent['phase'],
  ts: string,
  extra: Partial<AttemptEvent> = {},
): AttemptEvent {
  const base: AttemptEvent = {
    id: `att:${attemptId}:${phase}`,
    schemaVersion: '1',
    attemptId,
    phase,
    ts,
  };
  return { ...base, ...extra } as AttemptEvent;
}

/** Build an attempt event with a REAL content-addressed `att:<hex>` id (store-valid). */
function storeEvent(
  attemptId: string,
  phase: AttemptEvent['phase'],
  ts: string,
  extra: Partial<Omit<AttemptEvent, 'id' | 'schemaVersion' | 'attemptId' | 'phase' | 'ts'>> = {},
): AttemptEvent {
  const id = attemptEventId({
    attemptId,
    phase,
    ...(extra.subject !== undefined ? { subject: extra.subject } : {}),
    ...(extra.observation !== undefined ? { observation: extra.observation } : {}),
    ...(extra.action !== undefined ? { action: extra.action } : {}),
    ...(extra.outcome !== undefined ? { outcome: extra.outcome } : {}),
    ...(extra.candidateId !== undefined ? { candidateId: extra.candidateId } : {}),
    ...(extra.evaluationId !== undefined ? { evaluationId: extra.evaluationId } : {}),
  });
  return buildAttemptEvent({ id, attemptId, phase, ts, ...extra });
}

describe('attempt pure selectors', () => {
  it('attemptEventsFor filters by attemptId', () => {
    const es = [
      event('attgrp:1', 'start', NOW),
      event('attgrp:2', 'start', NOW),
      event('attgrp:1', 'outcome', NOW),
    ];
    expect(attemptEventsFor(es, 'attgrp:1').map((e) => e.phase)).toEqual(['start', 'outcome']);
  });

  it('isAttemptPromoted is true only when a promotion event exists', () => {
    const es = [event('a', 'start', NOW), event('a', 'evaluation', NOW)];
    expect(isAttemptPromoted(es, 'a')).toBe(false);
    es.push(event('a', 'promotion', NOW));
    expect(isAttemptPromoted(es, 'a')).toBe(true);
  });

  it('attemptLastActivity is the lexicographic max ts', () => {
    const es = [
      event('a', 'start', '2026-01-01T00:00:00.000Z'),
      event('a', 'outcome', '2026-02-01T00:00:00.000Z'),
      event('a', 'compaction', '2026-01-15T00:00:00.000Z'),
    ];
    expect(attemptLastActivity(es, 'a')).toBe('2026-02-01T00:00:00.000Z');
    expect(attemptLastActivity(es, 'missing')).toBeUndefined();
  });
});

describe('unpromotedAttemptIds', () => {
  it('reaps unpromoted attempts older than maxAge, keeps promoted + recent', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const recent = NOW;
    const es = [
      // unpromoted + old → reaped
      event('old-1', 'start', old),
      event('old-1', 'outcome', old),
      // promoted + old → kept (success is reusable)
      event('old-2', 'start', old),
      event('old-2', 'promotion', old),
      // unpromoted + recent → kept
      event('new-1', 'start', recent),
    ];
    const reaped = unpromotedAttemptIds(es, 30 * DAY, NOW);
    expect(reaped).toEqual(['old-1']);
  });

  it('returns [] when now is unparseable', () => {
    const es = [event('a', 'start', NOW)];
    expect(unpromotedAttemptIds(es, 30 * DAY, 'not-a-date')).toEqual([]);
  });

  it('ignores attempts with an unparseable ts', () => {
    const es = [event('a', 'start', 'not-a-date')];
    expect(unpromotedAttemptIds(es, 30 * DAY, NOW)).toEqual([]);
  });
});

describe('compactAttemptEvents', () => {
  it('removes every event for the attempt except the compaction event', () => {
    const es = [
      event('a', 'start', NOW),
      event('a', 'observation', NOW),
      event('a', 'action', NOW),
      event('a', 'outcome', NOW),
      event('b', 'start', NOW), // a different attempt is untouched
    ];
    const compaction = buildAttemptEvent({
      id: 'att:a:compaction',
      attemptId: 'a',
      phase: 'compaction',
      ts: NOW,
      observation: summary('A.b does the thing — promoted to local'),
    });
    const next = compactAttemptEvents(es, 'a', compaction);
    expect(next.filter((e) => e.attemptId === 'a')).toEqual([compaction]);
    expect(next.filter((e) => e.attemptId === 'b')).toHaveLength(1);
  });
});

describe('store-coupled compactAttempt', () => {
  it('deletes the intermediate trail and leaves only the compaction summary', () => {
    const attemptId = 'attgrp:ok';
    appendAttemptEvent(local, storeEvent(attemptId, 'start', NOW));
    appendAttemptEvent(
      local,
      storeEvent(attemptId, 'observation', NOW, { observation: summary('snapshot') }),
    );
    appendAttemptEvent(local, storeEvent(attemptId, 'action', NOW));
    appendAttemptEvent(local, storeEvent(attemptId, 'promotion', NOW));
    const compaction = storeEvent(attemptId, 'compaction', NOW, {
      observation: summary('A.b promoted to local — compacted'),
    });
    const { removed } = compactAttempt(local, attemptId, compaction);
    expect(removed).toBe(4);
    const remaining = (local.readCollection('attempts').entries as AttemptEvent[]).filter(
      (e) => e.attemptId === attemptId,
    );
    expect(remaining).toEqual([compaction]);
  });

  it('is idempotent (re-compacting only rewrites the compaction event)', () => {
    const attemptId = 'attgrp:idem';
    const compaction = storeEvent(attemptId, 'compaction', NOW, { observation: summary('done') });
    compactAttempt(local, attemptId, compaction);
    const { removed } = compactAttempt(local, attemptId, compaction);
    expect(removed).toBe(0);
    const remaining = (local.readCollection('attempts').entries as AttemptEvent[]).filter(
      (e) => e.attemptId === attemptId,
    );
    expect(remaining).toEqual([compaction]);
  });
});

describe('gcUnpromotedAttempts', () => {
  it('reaps old unpromoted attempt events + their candidate, keeps promoted', () => {
    const oldTs = '2025-01-01T00:00:00.000Z';
    const candidateId = 'cand:deadbeef';
    // unpromoted + old, with a candidate-phase event carrying candidateId
    appendAttemptEvent(local, storeEvent('old', 'start', oldTs));
    appendAttemptEvent(local, storeEvent('old', 'candidate', oldTs, { candidateId }));
    // promoted + old → kept
    appendAttemptEvent(local, storeEvent('prom', 'start', oldTs));
    appendAttemptEvent(local, storeEvent('prom', 'promotion', oldTs));
    // plant the candidate so GC can remove it
    const cand: MemoryCandidate = {
      id: candidateId,
      schemaVersion: '1',
      kind: 'fact',
      subject: 'sym:src/a.ts#A.b',
      claim: 'A.b does the thing',
      scope: { boundary: 'repo', repoId: REPO },
      appliesTo: ['sym:src/a.ts#A.b'],
      evidence: [
        {
          kind: 'source-quote',
          verdict: 'valid',
          checkedAt: oldTs,
          soulId: 'sym:src/a.ts#A.b',
          quote: 'x',
          targetHash: 'blake3:abc',
        },
      ],
      authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
      origin: 'attempt',
      attemptId: 'old',
      proposedAt: oldTs,
    };
    local.upsertEntry('candidates', cand);

    const res = gcUnpromotedAttempts(local, 30 * DAY, NOW);
    expect(res.reapedAttempts).toEqual(['old']);
    expect(res.removedCandidateIds).toEqual([candidateId]);
    const remaining = local.readCollection('attempts').entries as AttemptEvent[];
    // the promoted attempt's trail survives; only 'old' was reaped
    expect(remaining.every((e) => e.attemptId === 'prom')).toBe(true);
    expect(remaining).toHaveLength(2);
    expect(local.readCollection('candidates').entries).toHaveLength(0);
  });

  it('never touches the team store (local-only)', () => {
    // gcUnpromotedAttempts only reads/writes the supplied (local) store; team is never passed here.
    appendAttemptEvent(local, storeEvent('old', 'start', '2025-01-01T00:00:00.000Z'));
    const res = gcUnpromotedAttempts(local, 30 * DAY, NOW);
    expect(res.reapedAttempts).toEqual(['old']);
    // sanity: the local store still has its other collections intact (no team access attempted)
    expect(local.readCollection('active').entries).toEqual([]);
  });
});
