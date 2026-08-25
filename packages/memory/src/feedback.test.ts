/**
 * W5 Slice 3 — contradicted-feedback suppression: the pure admissibility predicates, the pure
 * {@link contradictedSuppression} verdict, the store-coupled {@link applyContradictedFeedback}, the
 * audit-surfacing helpers, and the no-poison invariant (a local quarantine suppresses the LOCAL copy
 * but NEVER retracts the same-id team record — PRD line 242: "one negative event cannot retract team
 * memory").
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MemoryDecision,
  type MemoryEvidence,
  type MemoryFeedback,
  type MemoryRecord,
  type MemoryRecordKind,
  MemoryStore,
  type Verdicts,
  __resetMemoryLockGuardForTest,
  applyContradictedFeedback,
  contradictedForReview,
  contradictedSuppression,
  decisionId,
  gatherRecall,
  hasAdmissibleCounterEvidence,
  isAdmissibleCounterEvidence,
  memoryRecordId,
  quarantinedRecordIds,
  recallProjection,
} from './index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-fb';
const BLAKE_A = `blake3:${'a'.repeat(64)}`;
let home = '';
let regDir = '';
let crib = '';
let env: NodeJS.ProcessEnv;
let local: MemoryStore;
let team: MemoryStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fb-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'fb-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();
  crib = mkdtempSync(join(tmpdir(), 'fb-crib-'));
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

function ev(opts: {
  kind?: MemoryEvidence['kind'];
  verdict?: MemoryEvidence['verdict'];
}): MemoryEvidence {
  return {
    kind: opts.kind ?? 'source-quote',
    verdict: opts.verdict ?? 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: BLAKE_A,
  };
}

/** A record whose id is content-addressed from the claim body (trust/verdicts excluded → same id across tiers). */
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
    evidence: [ev({})],
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

function contradictedFeedback(subject: string, actor = 'claude-code'): MemoryFeedback {
  return {
    id: `fb:${subject}`,
    schemaVersion: '1',
    signal: 'contradicted',
    subject,
    actor,
    ts: NOW,
  };
}

// ─── admissibility predicates (pure) ─────────────────────────────────────────

describe('isAdmissibleCounterEvidence', () => {
  it('is true for an admissible kind with a valid verdict', () => {
    expect(
      isAdmissibleCounterEvidence(ev({ kind: 'source-quote', verdict: 'valid' }), 'fact'),
    ).toBe(true);
    expect(
      isAdmissibleCounterEvidence(ev({ kind: 'execution-assertion', verdict: 'valid' }), 'fact'),
    ).toBe(true);
  });

  it('is false when the verdict is not valid (degraded/invalid do not support suppression)', () => {
    expect(
      isAdmissibleCounterEvidence(ev({ kind: 'source-quote', verdict: 'degraded' }), 'fact'),
    ).toBe(false);
    expect(
      isAdmissibleCounterEvidence(ev({ kind: 'source-quote', verdict: 'invalid' }), 'fact'),
    ).toBe(false);
  });

  it('is false when the kind is not admissible for the claim kind', () => {
    // human-attestation is not admissible for a `fact` (only source-quote / execution-assertion are).
    expect(
      isAdmissibleCounterEvidence(ev({ kind: 'human-attestation', verdict: 'valid' }), 'fact'),
    ).toBe(false);
    // ...but it IS admissible for a `decision`.
    expect(
      isAdmissibleCounterEvidence(ev({ kind: 'human-attestation', verdict: 'valid' }), 'decision'),
    ).toBe(true);
  });
});

describe('hasAdmissibleCounterEvidence', () => {
  it('is true iff at least one item is admissible+valid', () => {
    expect(
      hasAdmissibleCounterEvidence(
        [
          ev({ kind: 'human-attestation', verdict: 'valid' }),
          ev({ kind: 'source-quote', verdict: 'valid' }),
        ],
        'fact',
      ),
    ).toBe(true);
    expect(
      hasAdmissibleCounterEvidence(
        [
          ev({ kind: 'human-attestation', verdict: 'valid' }),
          ev({ kind: 'source-quote', verdict: 'degraded' }),
        ],
        'fact',
      ),
    ).toBe(false); // human-attestation inadmissible for fact + the source-quote is degraded
    expect(hasAdmissibleCounterEvidence([], 'fact')).toBe(false);
  });
});

// ─── contradictedSuppression (pure verdict) ──────────────────────────────────

describe('contradictedSuppression', () => {
  const r = record({});

  it('suppresses (quarantine decision) when admissible+valid counter-evidence exists', () => {
    const v = contradictedSuppression({
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => NOW,
    });
    expect(v.suppress).toBe(true);
    if (!v.suppress) return;
    expect(v.decision.kind).toBe('quarantine');
    expect(v.decision.subject).toBe(r.id);
    expect(v.decision.id).toBe(
      decisionId({
        kind: 'quarantine',
        subject: r.id,
        actor: 'claude-code',
        reason: v.decision.reason,
      }),
    );
  });

  it('the quarantine decision id is idempotent (excludes ts) — same content → same id', () => {
    const a = contradictedSuppression({
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => '2026-02-02T00:00:00.000Z',
    });
    const b = contradictedSuppression({
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => '2026-03-03T00:00:00.000Z',
    });
    expect(a.suppress).toBe(true);
    expect(b.suppress).toBe(true);
    if (!a.suppress || !b.suppress) return;
    expect(a.decision.id).toBe(b.decision.id); // ts differs but the id excludes ts
  });

  it('surfaces for review (no suppress) when no admissible counter-evidence exists', () => {
    const v = contradictedSuppression({
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'degraded' })], // not valid
      now: () => NOW,
    });
    expect(v.suppress).toBe(false);
    if (v.suppress) return;
    expect(v.surfacedForReview).toBe(true);
    expect(v.reason).toMatch(/admissible/);
  });

  it('surfaces for review when the signal is not contradicted (no suppression, bounded feedback only)', () => {
    const v = contradictedSuppression({
      record: { id: r.id, kind: r.kind },
      feedback: { ...contradictedFeedback(r.id), signal: 'unhelpful' },
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => NOW,
    });
    expect(v.suppress).toBe(false);
    if (v.suppress) return;
    expect(v.surfacedForReview).toBe(true);
  });
});

// ─── applyContradictedFeedback (store-coupled) ───────────────────────────────

describe('applyContradictedFeedback', () => {
  it('always writes the feedback event, and writes a LOCAL quarantine decision when suppressing', () => {
    const r = record({});
    local.upsertEntry('active', r);
    const res = applyContradictedFeedback(local, {
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => NOW,
    });
    expect(res.suppression.suppress).toBe(true);
    // feedback event recorded
    const fbs = local.readCollection('feedback').entries as MemoryFeedback[];
    expect(fbs.map((f) => f.subject)).toContain(r.id);
    // local quarantine decision recorded
    const decs = local.readCollection('decisions').entries as MemoryDecision[];
    const q = decs.find((d) => d.kind === 'quarantine' && d.subject === r.id);
    expect(q).toBeDefined();
    // the active record is NOT deleted (quarantine = exclusion-from-recall, not removal)
    expect((local.readCollection('active').entries as MemoryRecord[]).map((x) => x.id)).toContain(
      r.id,
    );
  });

  it('writes feedback but NO quarantine decision when surfacing for review', () => {
    const r = record({});
    local.upsertEntry('active', r);
    const res = applyContradictedFeedback(local, {
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'degraded' })], // no admissible+valid
      now: () => NOW,
    });
    expect(res.suppression.suppress).toBe(false);
    const fbs = local.readCollection('feedback').entries as MemoryFeedback[];
    expect(fbs.map((f) => f.subject)).toContain(r.id);
    const decs = local.readCollection('decisions').entries as MemoryDecision[];
    expect(decs.filter((d) => d.kind === 'quarantine')).toHaveLength(0);
  });

  it('is idempotent (re-applying reproduces the same feedback id + quarantine dec id)', () => {
    const r = record({});
    local.upsertEntry('active', r);
    const input = {
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => NOW,
    } as const;
    const a = applyContradictedFeedback(local, input);
    const b = applyContradictedFeedback(local, input);
    expect(a.feedbackId).toBe(b.feedbackId);
    const aS = a.suppression;
    const bS = b.suppression;
    expect(aS.suppress).toBe(true);
    expect(bS.suppress).toBe(true);
    if (!aS.suppress || !bS.suppress) return; // narrow for noUncheckedIndexedAccess / discriminated union
    expect(aS.decision.id).toBe(bS.decision.id);
    // one feedback + one quarantine decision after two applies (upsert dedupes by id)
    expect(local.readCollection('feedback').entries).toHaveLength(1);
    expect(
      (local.readCollection('decisions').entries as MemoryDecision[]).filter(
        (d) => d.kind === 'quarantine',
      ),
    ).toHaveLength(1);
  });

  it('never touches the team store (local-only — one negative event cannot retract team memory)', () => {
    const r = record({});
    local.upsertEntry('active', r);
    applyContradictedFeedback(local, {
      record: { id: r.id, kind: r.kind },
      feedback: contradictedFeedback(r.id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => NOW,
    });
    expect(team.readCollection('decisions').entries).toHaveLength(0);
    expect(
      (team.readCollection('records').entries as MemoryRecord[]).map((x) => x.id),
    ).not.toContain(r.id);
  });
});

// ─── audit surfacing (pure) ──────────────────────────────────────────────────

describe('quarantinedRecordIds + contradictedForReview', () => {
  it('quarantinedRecordIds collects the subjects of quarantine decisions', () => {
    const decs: MemoryDecision[] = [
      {
        id: 'dec:1',
        schemaVersion: '1',
        kind: 'quarantine',
        subject: 'mem:a',
        actor: 'ci',
        ts: NOW,
      },
      {
        id: 'dec:2',
        schemaVersion: '1',
        kind: 'activate',
        subject: 'mem:b',
        actor: 'ci',
        ts: NOW,
      },
      {
        id: 'dec:3',
        schemaVersion: '1',
        kind: 'quarantine',
        subject: 'mem:c',
        actor: 'ci',
        ts: NOW,
      },
    ];
    expect(quarantinedRecordIds(decs)).toEqual(new Set(['mem:a', 'mem:c']));
  });

  it('contradictedForReview surfaces only un-quarantined contradicted feedback, deduped by subject', () => {
    const fbs: MemoryFeedback[] = [
      {
        id: 'fb:1',
        schemaVersion: '1',
        signal: 'contradicted',
        subject: 'mem:a',
        actor: 'ci',
        ts: NOW,
      },
      {
        id: 'fb:2',
        schemaVersion: '1',
        signal: 'contradicted',
        subject: 'mem:a',
        actor: 'ci',
        ts: NOW,
      }, // dup subject
      {
        id: 'fb:3',
        schemaVersion: '1',
        signal: 'contradicted',
        subject: 'mem:b',
        actor: 'ci',
        ts: NOW,
      }, // quarantined
      { id: 'fb:4', schemaVersion: '1', signal: 'useful', subject: 'mem:d', actor: 'ci', ts: NOW }, // not contradicted
    ];
    const out = contradictedForReview(fbs, new Set(['mem:b']));
    expect(out.map((f) => f.subject)).toEqual(['mem:a']); // mem:b suppressed, mem:d not contradicted, mem:a deduped
  });
});

// ─── the no-poison invariant (the W5 Slice 3 exit gate) ──────────────────────

describe('no-poison: a local quarantine suppresses the local copy but never the same-id team record', () => {
  it('team record stays recall-eligible while the local copy is suppressed', () => {
    // The team record + the local record share the SAME content-addressed id (trust is excluded).
    const id = memoryRecordId({
      kind: 'fact',
      subject: 'sym:src/a.ts#A.b',
      claim: 'A.b does the thing',
      scope: { boundary: 'repo', repoId: REPO },
      appliesTo: ['sym:src/a.ts#A.b'],
      evidence: [ev({})],
      authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
    });
    const teamRecord = record({ trust: 'team' });
    const localRecord = record({ trust: 'local' });
    expect(teamRecord.id).toBe(id);
    expect(localRecord.id).toBe(id);

    team.upsertEntry('records', teamRecord);
    local.upsertEntry('active', localRecord);

    // a single contradicted feedback WITH admissible counter-evidence quarantines the LOCAL copy only
    applyContradictedFeedback(local, {
      record: { id, kind: 'fact' },
      feedback: contradictedFeedback(id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'valid' })],
      now: () => NOW,
    });

    const gathered = gatherRecall({ team, local, global: undefined });
    const proj = recallProjection(gathered);
    // the team record is the ONLY eligible memory — the local copy is suppressed (quarantined)
    expect(proj.memories.map((m) => m.record.id)).toEqual([id]);
    expect(proj.memories).toHaveLength(1);
    const m = proj.memories[0];
    expect(m).toBeDefined();
    if (!m) return; // narrow for noUncheckedIndexedAccess
    expect(m.source).toBe('team');
    expect(m.verdicts.quarantined).toBe(false); // team memory NOT retracted by the local quarantine
    expect(m.verdicts.lifecycle).toBe('active');
  });

  it('a contradicted feedback WITHOUT admissible counter-evidence does not suppress either copy (bounded penalty only)', () => {
    const id = memoryRecordId({
      kind: 'fact',
      subject: 'sym:src/a.ts#A.b',
      claim: 'A.b does the thing',
      scope: { boundary: 'repo', repoId: REPO },
      appliesTo: ['sym:src/a.ts#A.b'],
      evidence: [ev({})],
      authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
    });
    const teamRecord = record({ trust: 'team' });
    const localRecord = record({ trust: 'local' });
    team.upsertEntry('records', teamRecord);
    local.upsertEntry('active', localRecord);

    applyContradictedFeedback(local, {
      record: { id, kind: 'fact' },
      feedback: contradictedFeedback(id),
      counterEvidence: [ev({ kind: 'source-quote', verdict: 'degraded' })], // not admissible+valid
      now: () => NOW,
    });

    const proj = recallProjection(gatherRecall({ team, local, global: undefined }));
    // both copies stay eligible (the local one takes a bounded −1 penalty but is NOT suppressed);
    // recall surfaces one entry per (record, source) so the same id appears twice, team first.
    expect(proj.memories.map((m) => m.record.id)).toEqual([id, id]);
    expect(proj.memories.map((m) => m.source)).toEqual(['team', 'local']); // team tier > local tier
    const m = proj.memories[0];
    expect(m).toBeDefined();
    if (!m) return;
    expect(m.source).toBe('team'); // team tier > local tier → team copy ranks first
    expect(m.verdicts.quarantined).toBe(false);
    const localMem = proj.memories[1];
    expect(localMem).toBeDefined();
    if (localMem) expect(localMem.verdicts.quarantined).toBe(false); // bounded penalty only, not suppressed
  });
});
