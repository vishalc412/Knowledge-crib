/**
 * W5 Slice 2 — the team-promotion tombstone: pure selectors + the store-coupled
 * `tombstoneLocalForTeamPromotion` + the no-poison invariant (a local tombstone must NOT drop the
 * same-id team record from recall).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MemoryDecision,
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordKind,
  MemoryStore,
  type TrustedTeamPresence,
  type Verdicts,
  __resetMemoryLockGuardForTest,
  decisionId,
  gatherRecall,
  isTeamTrustedRecord,
  localRecordsToTombstone,
  memoryRecordId,
  recallProjection,
  tombstoneLocalForTeamPromotion,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-tomb';
const BLAKE_A = `blake3:${'a'.repeat(64)}`;
let home = '';
let regDir = '';
let crib = '';
let env: NodeJS.ProcessEnv;
let local: MemoryStore;
let team: MemoryStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tomb-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'tomb-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();
  crib = mkdtempSync(join(tmpdir(), 'tomb-crib-'));
  writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: REPO, root: '.' } }));
  local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
  team = MemoryStore.team(crib, { env, now: () => NOW, repoRoot: '/r' });
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
  rmSync(crib, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

function evidence(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: BLAKE_A,
  };
}

/** A record whose id is content-addressed from the claim body (trust/verdicts excluded → same id across trust tiers). */
function record(opts: {
  trust?: Verdicts['trust'];
  subject?: string;
  claim?: string;
  kind?: MemoryRecordKind;
}): MemoryRecord {
  const kind = opts.kind ?? 'fact';
  const subject = opts.subject ?? 'sym:src/a.ts#A.b';
  const claim = opts.claim ?? 'A.b does the thing';
  const input = {
    kind,
    subject,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [subject],
    evidence: [evidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: opts.trust ?? 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: NOW,
  };
}

function presence(recordIds: string[], accepted: string[]): TrustedTeamPresence {
  return { recordIds: new Set(recordIds), acceptedRecordIds: new Set(accepted) };
}

// ─── pure selectors ──────────────────────────────────────────────────────────

describe('isTeamTrustedRecord', () => {
  it('is true only when the id is in the ref records AND accepted', () => {
    const p = presence(['mem:a', 'mem:b'], ['mem:a']);
    expect(isTeamTrustedRecord('mem:a', p)).toBe(true);
    expect(isTeamTrustedRecord('mem:b', p)).toBe(false); // present but not accepted
    expect(isTeamTrustedRecord('mem:c', p)).toBe(false); // absent
  });

  it('is false when no trusted ref is configured (undefined presence)', () => {
    expect(isTeamTrustedRecord('mem:a', undefined)).toBe(false);
  });
});

describe('localRecordsToTombstone', () => {
  it('selects only the local active records whose id is team-trusted', () => {
    const trusted = record({ claim: 'trusted claim' });
    const branchOnly = record({ claim: 'branch-only claim' });
    const p = presence([trusted.id], [trusted.id]);
    const picked = localRecordsToTombstone([trusted, branchOnly], p);
    expect(picked.map((r) => r.id)).toEqual([trusted.id]);
  });

  it('selects nothing when no trusted ref is configured', () => {
    const r = record({});
    expect(localRecordsToTombstone([r], undefined)).toEqual([]);
  });
});

// ─── store-coupled tombstone ─────────────────────────────────────────────────

describe('tombstoneLocalForTeamPromotion', () => {
  it('removes the local active record + writes a supersede decision (successor = same id)', () => {
    const r = record({ trust: 'local' });
    local.upsertEntry('active', r);
    const res = tombstoneLocalForTeamPromotion(local, r.id, 'ci', () => NOW);
    expect(res.removed).toBe(true);
    expect(local.readCollection('active').entries).toHaveLength(0);
    const decisions = local.readCollection('decisions').entries as MemoryDecision[];
    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    expect(d).toBeDefined();
    if (!d) return; // narrow for noUncheckedIndexedAccess
    expect(d.kind).toBe('supersede');
    expect(d.subject).toBe(r.id);
    expect(d.successor).toBe(r.id); // the team copy is content-identical (same id)
    expect(d.id).toBe(
      decisionId({
        kind: 'supersede',
        subject: r.id,
        successor: r.id,
        actor: 'ci',
        reason: d.reason,
      }),
    );
  });

  it('is idempotent (re-tombstone reproduces the same dec id + remove is a no-op)', () => {
    const r = record({ trust: 'local' });
    local.upsertEntry('active', r);
    const first = tombstoneLocalForTeamPromotion(local, r.id, 'ci', () => NOW);
    const second = tombstoneLocalForTeamPromotion(local, r.id, 'ci', () => NOW);
    expect(first.removed).toBe(true);
    expect(second.removed).toBe(false); // already removed
    expect(second.decisionId).toBe(first.decisionId); // same content-addressed dec id
    const decisions = local.readCollection('decisions').entries as MemoryDecision[];
    expect(decisions).toHaveLength(1); // upsert deduped the re-tombstone
  });

  it('never touches the team store (local-only)', () => {
    const r = record({ trust: 'local' });
    local.upsertEntry('active', r);
    tombstoneLocalForTeamPromotion(local, r.id, 'ci', () => NOW);
    // the team store is a separate object; assert it holds nothing for this id
    expect(
      (team.readCollection('records').entries as MemoryRecord[]).map((x) => x.id),
    ).not.toContain(r.id);
    expect(team.readCollection('decisions').entries).toHaveLength(0);
  });
});

// ─── the no-poison invariant (the W5 Slice 2 exit gate) ──────────────────────

describe('no-poison: a local tombstone does not drop the same-id team record from recall', () => {
  it('team record stays recall-eligible after the local copy is tombstoned', () => {
    // The team record + the local record share the SAME content-addressed id (trust is excluded).
    const id = memoryRecordId({
      kind: 'fact',
      subject: 'sym:src/a.ts#A.b',
      claim: 'A.b does the thing',
      scope: { boundary: 'repo', repoId: REPO },
      appliesTo: ['sym:src/a.ts#A.b'],
      evidence: [evidence()],
      authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
    });
    const teamRecord = record({ trust: 'team' });
    const localRecord = record({ trust: 'local' });
    expect(teamRecord.id).toBe(id);
    expect(localRecord.id).toBe(id); // same id — the duplicate the tombstone retires

    team.upsertEntry('records', teamRecord);
    // team-trust requires an accept decision in the team store
    team.upsertEntry('decisions', {
      id: decisionId({
        kind: 'accept',
        subject: id,
        actor: 'ci',
        reason: 'team proposal accepted',
      }),
      schemaVersion: '1',
      kind: 'accept',
      subject: id,
      actor: 'ci',
      reason: 'team proposal accepted',
      ts: NOW,
    });
    local.upsertEntry('active', localRecord);

    // tombstone the local copy (its content is now team-trusted)
    tombstoneLocalForTeamPromotion(local, id, 'ci', () => NOW);

    const gathered = gatherRecall({ team, local, global: undefined });
    const proj = recallProjection(gathered);
    // the local copy is gone; the team record is the ONLY eligible memory and is NOT poisoned
    expect(proj.memories.map((m) => m.record.id)).toEqual([id]);
    expect(proj.memories).toHaveLength(1);
    const m = proj.memories[0];
    expect(m).toBeDefined();
    if (!m) return; // narrow for noUncheckedIndexedAccess
    expect(m.source).toBe('team');
    expect(m.verdicts.lifecycle).toBe('active'); // NOT 'superseded'
  });
});
