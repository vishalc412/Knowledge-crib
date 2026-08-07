/**
 * W3 Slice 1 — the recall core: the hard eligibility filter (exit-gate invariant #1), the 6-criterion
 * priority-ordered rank, conflict grouping (invariant #2), bounded feedback, provenance, and the
 * `gatherRecall` store-read + id-prefix narrowing. `recallProjection` is exercised PURE over
 * hand-built {@link GatheredRecall} (no IO); `gatherRecall` is exercised once against a real temp-dir
 * team store for the read + narrowing + decision-overlay path.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEvaluator } from './evaluator.js';
import { MemoryStore, __resetMemoryLockGuardForTest, decisionId, memoryRecordId } from './index.js';
import type {
  MemoryDecision,
  MemoryEvidence,
  MemoryFeedback,
  MemoryRecord,
  MemoryRecordKind,
  Verdicts,
} from './index.js';
import {
  type ConflictGroup,
  DEFAULT_FEEDBACK_BOUND,
  EXACT_MATCH_BONUS,
  type GatheredRecall,
  type LexicalScorer,
  type MemorySource,
  type RecallProjection,
  exactLexicalScorer,
  gatherRecall,
  recallProjection,
} from './recall.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-test';
const BLAKE_A = `blake3:${'a'.repeat(64)}`;
const BLAKE_B = `blake3:${'b'.repeat(64)}`;

// ─── record / entry builders ─────────────────────────────────────────────────

function evidence(
  partial: Partial<MemoryEvidence> & { kind?: MemoryEvidence['kind'] } = {},
): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: BLAKE_A,
    ...partial,
  };
}

function record(opts: {
  subject?: string;
  claim?: string;
  boundary?: 'repo' | 'global';
  repoId?: string;
  appliesTo?: string[];
  trust?: Verdicts['trust'];
  verdicts?: Partial<Verdicts>;
  createdAt?: string;
  kind?: MemoryRecordKind;
  evidenceItems?: MemoryEvidence[];
}): MemoryRecord {
  const kind = opts.kind ?? 'fact';
  const subject = opts.subject ?? 'sym:src/a.ts#A.b';
  const claim = opts.claim ?? 'A.b does the thing';
  const boundary = opts.boundary ?? 'repo';
  const scope =
    boundary === 'global'
      ? { boundary: 'global' as const }
      : { boundary: 'repo' as const, repoId: opts.repoId ?? REPO };
  const appliesTo = opts.appliesTo ?? [subject];
  const ev = opts.evidenceItems ?? [evidence({ soulId: subject, quote: 'does the thing' })];
  const input = {
    kind,
    subject,
    claim,
    scope,
    appliesTo,
    evidence: ev,
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
      ...opts.verdicts,
    },
    createdAt: opts.createdAt ?? NOW,
  };
}

function decision(opts: {
  kind: MemoryDecision['kind'];
  subject: string;
  successor?: string;
}): MemoryDecision {
  return {
    id: decisionId({
      kind: opts.kind,
      subject: opts.subject,
      successor: opts.successor,
      actor: 'ci',
      reason: 'test',
    }),
    schemaVersion: '1',
    kind: opts.kind,
    subject: opts.subject,
    ...(opts.successor ? { successor: opts.successor } : {}),
    actor: 'ci',
    reason: 'test',
    ts: NOW,
  };
}

function feedback(signal: MemoryFeedback['signal'], subject: string): MemoryFeedback {
  return {
    id: `fb:${signal}-${subject}-${Math.floor(Math.random() * 1e9)}`.replace(/[^a-z0-9:|-]/gi, 'x'),
    schemaVersion: '1',
    signal,
    subject,
    actor: 'claude-code',
    ts: NOW,
  };
}

/** Tag records with sources and build a GatheredRecall (pure input for recallProjection). */
function gathered(
  tagged: { record: MemoryRecord; source: MemorySource }[],
  decisions: MemoryDecision[] = [],
  fb: MemoryFeedback[] = [],
  localDecisions: MemoryDecision[] = [],
): GatheredRecall {
  return { records: tagged, decisions, localDecisions, feedback: fb, errors: [] };
}

function idsOf(p: RecallProjection): string[] {
  return p.memories.map((m) => m.record.id);
}

// ─── exactLexicalScorer ──────────────────────────────────────────────────────

describe('exactLexicalScorer', () => {
  it('scores 0 when nothing matches', () => {
    const r = record({ subject: 'sym:src/a.ts#A.b', claim: 'nope' });
    expect(exactLexicalScorer(r, 'query', ['sym:other.ts#X'])).toBe(0);
  });

  it('scores the exact-match bonus when subject equals the query', () => {
    const r = record({ subject: 'sym:src/a.ts#A.b', claim: 'c1' });
    expect(exactLexicalScorer(r, 'sym:src/a.ts#A.b', [])).toBe(EXACT_MATCH_BONUS);
  });

  it('scores the exact-match bonus when subject is a requested target', () => {
    // Non-matching appliesTo isolates the subject-target match (no appliesTo bonus added).
    const r = record({
      subject: 'sym:src/a.ts#A.b',
      claim: 'c1',
      appliesTo: ['sym:unrelated.ts#Z'],
    });
    expect(exactLexicalScorer(r, '', ['sym:src/a.ts#A.b'])).toBe(EXACT_MATCH_BONUS);
  });

  it('scores bonus + matched-target count when an appliesTo target is requested', () => {
    const r = record({
      subject: 'topic:auth',
      claim: 'c1',
      appliesTo: ['sym:src/a.ts#A.b', 'sym:src/b.ts#C.d', 'sym:src/other.ts#Z'],
    });
    expect(exactLexicalScorer(r, 'q', ['sym:src/a.ts#A.b', 'sym:src/b.ts#C.d'])).toBe(
      EXACT_MATCH_BONUS + 2,
    );
  });

  it('a custom FTS-style scorer plugs in (criterion 1 lexical relevance)', () => {
    const fts: LexicalScorer = {
      score: (r) => (r.claim.includes('auth') ? 8 : 1),
    };
    const auth = record({ subject: 'topic:auth', claim: 'auth handles login' });
    const other = record({ subject: 'topic:ui', claim: 'renders the button' });
    expect(fts.score(auth, 'auth', [])).toBe(8);
    expect(fts.score(other, 'auth', [])).toBe(1);
  });
});

// ─── eligibility filter (exit-gate invariant #1) ─────────────────────────────

describe('recallProjection eligibility (exit-gate invariant #1)', () => {
  it('excludes candidate-trust, invalid, orphaned, needs-review, superseded, retracted, quarantined', () => {
    const candidate = record({ claim: 'c-cand', trust: 'candidate' });
    const invalid = record({ claim: 'c-invalid', verdicts: { evidence: 'invalid' } });
    const orphaned = record({ claim: 'c-orphan', verdicts: { applicability: 'orphaned' } });
    const needsReview = record({ claim: 'c-review', verdicts: { applicability: 'needs-review' } });
    const superseded = record({ claim: 'c-super', verdicts: { lifecycle: 'superseded' } });
    const retracted = record({ claim: 'c-retract', verdicts: { lifecycle: 'retracted' } });
    const quarantined = record({ claim: 'c-quar' });
    const ok = record({ claim: 'c-ok' });
    const decs = [decision({ kind: 'quarantine', subject: quarantined.id })];
    const p = recallProjection(
      gathered(
        [
          { record: candidate, source: 'local' },
          { record: invalid, source: 'local' },
          { record: orphaned, source: 'local' },
          { record: needsReview, source: 'local' },
          { record: superseded, source: 'local' },
          { record: retracted, source: 'local' },
          { record: quarantined, source: 'local' },
          { record: ok, source: 'local' },
        ],
        decs,
      ),
    );
    expect(idsOf(p)).toEqual([ok.id]);
    expect(p.provenance.counts.eligible).toBe(1);
    expect(p.provenance.counts.considered).toBe(8);
  });

  it('keeps degraded-evidence records (eligible, but ranked below valid)', () => {
    const degraded = record({ claim: 'c-deg', verdicts: { evidence: 'degraded' } });
    const valid = record({ claim: 'c-ok' });
    const p = recallProjection(
      gathered([
        { record: degraded, source: 'local' },
        { record: valid, source: 'local' },
      ]),
    );
    expect(idsOf(p)).toEqual([valid.id, degraded.id]);
  });
});

// ─── 6-criterion ranking ─────────────────────────────────────────────────────

describe('recallProjection ranking (6 criteria, priority-ordered)', () => {
  it('criterion 1: exact subject match outranks a non-exact match regardless of source', () => {
    // global + exact would beat local + non-exact (lexical is criterion 1, before source tier 2-4).
    const exactGlobal = record({ subject: 'sym:src/auth.ts#login', claim: 'c-exact' });
    const fuzzyLocal = record({ subject: 'sym:src/ui.ts#render', claim: 'c-fuzzy' });
    const p = recallProjection(
      gathered([
        { record: fuzzyLocal, source: 'local' },
        { record: exactGlobal, source: 'global' },
      ]),
      { query: 'sym:src/auth.ts#login' },
    );
    expect(idsOf(p)).toEqual([exactGlobal.id, fuzzyLocal.id]);
    expect(p.memories[0]?.score.lexical).toBe(EXACT_MATCH_BONUS);
    expect(p.memories[1]?.score.lexical).toBe(0);
  });

  it('criteria 2-4: team > local > global among equal-lexical records', () => {
    const a = record({ subject: 'topic:x', claim: 'team-claim' });
    const b = record({ subject: 'topic:x', claim: 'local-claim' });
    const c = record({ subject: 'topic:x', claim: 'global-claim' });
    const p = recallProjection(
      gathered([
        { record: c, source: 'global' },
        { record: b, source: 'local' },
        { record: a, source: 'team' },
      ]),
    );
    expect(idsOf(p)).toEqual([a.id, b.id, c.id]);
    expect(p.memories[0]?.score.sourceTier).toBe(3);
    expect(p.memories[2]?.score.sourceTier).toBe(1);
  });

  it('criterion 5: valid outranks degraded within the same source', () => {
    const v = record({ subject: 'topic:x', claim: 'valid-claim' });
    const d = record({
      subject: 'topic:x',
      claim: 'deg-claim',
      verdicts: { evidence: 'degraded' },
    });
    const p = recallProjection(
      gathered([
        { record: d, source: 'team' },
        { record: v, source: 'team' },
      ]),
    );
    expect(idsOf(p)).toEqual([v.id, d.id]);
  });

  it('criterion 6: bounded feedback breaks ties (and is bounded to ±DEFAULT_FEEDBACK_BOUND)', () => {
    const loved = record({ subject: 'topic:x', claim: 'loved-claim' });
    const meh = record({ subject: 'topic:x', claim: 'meh-claim' });
    // 10 useful → capped at +bound; 10 unhelpful → capped at -bound. Same source + evidence + lexical
    // so feedback is the only differentiator (criterion 6, before the createdAt tiebreak).
    const fb: MemoryFeedback[] = [];
    for (let i = 0; i < 10; i++) {
      fb.push(feedback('useful', loved.id));
      fb.push(feedback('unhelpful', meh.id));
    }
    const p = recallProjection(
      gathered(
        [
          { record: meh, source: 'team' },
          { record: loved, source: 'team' },
        ],
        [],
        fb,
      ),
    );
    expect(idsOf(p)).toEqual([loved.id, meh.id]);
    expect(p.memories[0]?.score.feedbackAdjust).toBe(DEFAULT_FEEDBACK_BOUND);
    expect(p.memories[1]?.score.feedbackAdjust).toBe(-DEFAULT_FEEDBACK_BOUND);
    expect(p.provenance.counts.eligible).toBe(2);
  });

  it('final tiebreak: newest createdAt first when all criteria tie', () => {
    const older = record({
      subject: 'topic:x',
      claim: 'older-claim',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = record({
      subject: 'topic:x',
      claim: 'newer-claim',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const p = recallProjection(
      gathered([
        { record: older, source: 'team' },
        { record: newer, source: 'team' },
      ]),
    );
    expect(idsOf(p)).toEqual([newer.id, older.id]);
  });
});

// ─── conflict groups (exit-gate invariant #2) ────────────────────────────────

describe('recallProjection conflicts (exit-gate invariant #2)', () => {
  it('two active records sharing subject+scope surface as one conflict group, both ranked', () => {
    // Distinct claims ⇒ distinct mem: ids ⇒ two records sharing subject+scope.
    const r1 = record({ subject: 'topic:auth-strategy', claim: 'use oauth' });
    const r2 = record({ subject: 'topic:auth-strategy', claim: 'use saml' });
    const p = recallProjection(
      gathered([
        { record: r1, source: 'team' },
        { record: r2, source: 'team' },
      ]),
    );
    expect(p.conflicts).toHaveLength(1);
    const group: ConflictGroup | undefined = p.conflicts[0];
    expect(group?.records.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(group?.subject).toBe('topic:auth-strategy');
    // both conflicting records are present in memories (no silent pick)
    expect(idsOf(p).sort()).toEqual([r1.id, r2.id].sort());
  });

  it('records in different scopes do not conflict', () => {
    const repo = record({
      subject: 'topic:x',
      claim: 'repo-claim',
      boundary: 'repo',
      repoId: REPO,
    });
    const glob = record({ subject: 'topic:x', claim: 'global-claim', boundary: 'global' });
    const p = recallProjection(
      gathered([
        { record: repo, source: 'team' },
        { record: glob, source: 'global' },
      ]),
    );
    expect(p.conflicts).toHaveLength(0);
  });

  it('a superseded record does not join a conflict group', () => {
    const live = record({ subject: 'topic:x', claim: 'live-claim' });
    const dead = record({
      subject: 'topic:x',
      claim: 'dead-claim',
      verdicts: { lifecycle: 'superseded' },
    });
    const p = recallProjection(
      gathered([
        { record: live, source: 'team' },
        { record: dead, source: 'team' },
      ]),
    );
    expect(p.conflicts).toHaveLength(0);
    expect(idsOf(p)).toEqual([live.id]);
  });
});

// ─── provenance + freshness ──────────────────────────────────────────────────

describe('recallProjection provenance + freshness', () => {
  it('counts sources + considered + eligible + conflicts; fresh=false without an evaluator', () => {
    const t = record({ subject: 'topic:x', claim: 'team-claim' });
    const l = record({ subject: 'topic:x', claim: 'local-claim' });
    const p = recallProjection(
      gathered([
        { record: t, source: 'team' },
        { record: l, source: 'local' },
      ]),
    );
    expect(p.provenance.sources).toEqual(['team', 'local']);
    expect(p.provenance.counts).toEqual({
      team: 1,
      local: 1,
      global: 0,
      considered: 2,
      eligible: 2,
      conflicts: 1,
    });
    expect(p.provenance.fresh).toBe(false);
  });

  it('fresh=true and verdicts are recomputed when an evaluator + evalCtx are supplied', () => {
    // A record stamped 'valid' whose anchor drifted but still grounds the quote → fresh revalidation
    // lands on evidence='degraded' (reason='hash-drift'): the node is present, its hash differs from the
    // evidence's targetHash (drift), but the rehydrated text still contains the quote (grounded). Per the
    // evaluator's source-quote revalidation table (hash-drift + grounded → degraded/current/hash-drift),
    // the record stays eligible (degraded) — proving the stamped 'valid' was overridden fresh.
    const r = record({
      subject: 'sym:src/a.ts#A.b@L1',
      claim: 'c-grounding',
      evidenceItems: [
        evidence({
          kind: 'source-quote',
          soulId: 'sym:src/a.ts#A.b@L1',
          quote: 'does the thing',
          targetHash: BLAKE_A,
        }),
      ],
      verdicts: { evidence: 'valid' },
    });
    const soul = {
      getNode: (id: string) =>
        id === 'sym:src/a.ts#A.b@L1'
          ? ({
              id,
              kind: 'symbol',
              hash: BLAKE_B,
              file: 'src/a.ts',
              span: { start: 1, end: 100 },
              name: 'x',
            } as Node)
          : undefined,
      rehydrate: (n: Node) => ({
        text: 'the function does the thing well',
        truncated: false,
        totalLines: 1,
        startLine: n.span?.start ?? 1,
      }),
      findByLocator: () => [],
    };
    const evaluator = new MemoryEvaluator();
    const p = recallProjection(gathered([{ record: r, source: 'local' }]), {
      evaluator,
      evalCtx: { soul },
    });
    expect(p.provenance.fresh).toBe(true);
    expect(p.memories[0]?.verdicts.evidence).toBe('degraded');
    expect(p.memories[0]?.verdicts.reasons).toContain('hash-drift');
  });
});

// ─── gatherRecall (integration: real temp-dir team store) ────────────────────

let home = '';
let regDir = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recall-home-'));
  regDir = mkdtempSync(join(tmpdir(), 'recall-reg-'));
  env = { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: regDir };
  __resetMemoryLockGuardForTest();
});

afterEach(() => {
  __resetMemoryLockGuardForTest();
  rmSync(home, { recursive: true, force: true });
  rmSync(regDir, { recursive: true, force: true });
});

describe('gatherRecall (integration)', () => {
  it('reads team records + decisions, narrows by id prefix, and overlays decisions in the projection', () => {
    const crib = mkdtempSync(join(tmpdir(), 'recall-crib-'));
    try {
      // a real repoId so the team store is consistent (not strictly required for team, but harmless)
      writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: REPO } }));
      const team = MemoryStore.team(crib, { env, now: () => NOW });
      const live = record({ subject: 'topic:live', claim: 'live-claim' });
      const dead = record({ subject: 'topic:dead', claim: 'dead-claim' });
      team.upsertEntries('records', [live, dead]);
      team.upsertEntries('decisions', [
        decision({ kind: 'supersede', subject: dead.id, successor: 'mem:other' }),
      ]);

      const g = gatherRecall({ team }, { sources: ['team'] });
      expect(g.records.map((r) => r.record.id).sort()).toEqual([live.id, dead.id].sort());
      expect(g.records.every((r) => r.source === 'team')).toBe(true);
      expect(g.decisions).toHaveLength(1);
      expect(g.decisions[0]?.subject).toBe(dead.id);

      const p = recallProjection(g);
      expect(idsOf(p)).toEqual([live.id]); // dead is superseded → excluded
      expect(p.provenance.counts.eligible).toBe(1);
      expect(p.provenance.counts.considered).toBe(2);
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });

  it('sources filter restricts which stores are read', () => {
    const crib = mkdtempSync(join(tmpdir(), 'recall-crib-'));
    try {
      const team = MemoryStore.team(crib, { env, now: () => NOW });
      const t = record({ subject: 'topic:t', claim: 'team-only-claim' });
      team.upsertEntries('records', [t]);
      const local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
      const l = record({ subject: 'topic:l', claim: 'local-only-claim' });
      local.upsertEntries('active', [l]);

      const gTeamOnly = gatherRecall({ team, local }, { sources: ['team'] });
      expect(gTeamOnly.records.map((r) => r.record.id)).toEqual([t.id]);

      const gLocalOnly = gatherRecall({ team, local }, { sources: ['local'] });
      expect(gLocalOnly.records.map((r) => r.record.id)).toEqual([l.id]);

      const gAll = gatherRecall({ team, local });
      expect(gAll.records.map((r) => r.record.id).sort()).toEqual([t.id, l.id].sort());
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });

  it('records per-source counts in provenance across team + local + global', () => {
    const crib = mkdtempSync(join(tmpdir(), 'recall-crib-'));
    try {
      const team = MemoryStore.team(crib, { env, now: () => NOW });
      const local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
      const global = MemoryStore.global({ env, now: () => NOW });
      team.upsertEntries('records', [record({ subject: 'topic:t1', claim: 't1' })]);
      local.upsertEntries('active', [record({ subject: 'topic:l1', claim: 'l1' })]);
      global.upsertEntries('records', [record({ subject: 'topic:g1', claim: 'g1' })]);

      const p = recallProjection(gatherRecall({ team, local, global }));
      expect(p.provenance.counts.team).toBe(1);
      expect(p.provenance.counts.local).toBe(1);
      expect(p.provenance.counts.global).toBe(1);
      expect(p.provenance.counts.considered).toBe(3);
      expect(p.provenance.sources).toEqual(['team', 'local', 'global']);
    } finally {
      rmSync(crib, { recursive: true, force: true });
    }
  });
});
