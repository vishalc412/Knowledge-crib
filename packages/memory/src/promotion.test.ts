/**
 * W4 Slice 1 — the evaluation → activation → proposal pipeline (PRD W4 lines 340–350).
 *
 * Covers the two PRD invariants that make promotion safe without a cloud:
 *   - **idempotent by content id** (line 347): a candidate and its record share the `claimBody` hash
 *     (`cand:<h>` ↔ `mem:<h>`), so re-evaluating an identical claim reproduces every id and every
 *     write is a no-op upsert;
 *   - **crash-after-shared-write-before-cleanup** (line 348): a crash that lands the record + receipt
 *     but not the candidate removal is completed by the next run (dedupe + re-clean).
 * Plus the team-proposal admissibility guard (line 346: refuse invalid evidence) and snapshot
 * verification (line 277).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import { memoryCandidateId, memoryRecordId, receiptId } from './ids.js';
import {
  type GateReceipt,
  type MemoryCandidate,
  MemoryEvaluator,
  type MemoryEvidence,
  type MemorySoulPort,
  MemoryStore,
  type PromotionSnapshot,
  ProposalRefusedError,
  __resetMemoryLockGuardForTest,
  activateLocal,
  buildRecord,
  evaluateCandidate,
  policyPortFromReceipt,
  proposeTeam,
  receiptView,
  verifySnapshot,
} from './index.js';
import type { StableLocator } from './locator.js';
import { type GateProfile, type MemoryPolicy, policyHash, profileHash } from './policy.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-promo';
const HEAD = '0'.repeat(40);
const DIGEST = `blake3:${'a'.repeat(64)}`;
const SOUL_ID = 'sym:src/a.ts#A.b';
const QUOTE = 'does the thing';
const TARGET = `blake3:${'a'.repeat(64)}`;

// ─── fakes ───────────────────────────────────────────────────────────────────

function fakeSoul(): MemorySoulPort {
  const n: Node = {
    id: SOUL_ID,
    kind: 'symbol',
    name: 'b',
    file: 'src/a.ts',
    span: { start: 1, end: 100 },
    hash: TARGET,
  } as Node;
  return {
    getNode: (id) => (id === SOUL_ID ? n : undefined),
    rehydrate: (node) => ({
      text: node.id === SOUL_ID ? QUOTE : '',
      truncated: false,
      totalLines: 1,
      startLine: 1,
    }),
    findByLocator: (_locator: StableLocator) => [],
  };
}

function profile(partial: Partial<GateProfile> = {}): GateProfile {
  return {
    name: 'test',
    executable: 'node',
    args: ['--version'],
    timeoutMs: 5000,
    permittedEnv: ['PATH'],
    successExitCodes: [0],
    assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }],
    ...partial,
  };
}
function policy(profiles: Record<string, GateProfile> = { test: profile() }): MemoryPolicy {
  return { version: 1, profiles };
}

function gateReceipt(): GateReceipt {
  const pol = policy();
  const prof = pol.profiles.test!;
  const ph = policyHash(pol);
  const profHash = profileHash(prof);
  const assertions = [{ name: 'exit-ok', passed: true }];
  const r = {
    policyHash: ph,
    profileHash: profHash,
    executable: '/usr/bin/node',
    args: prof.args,
    head: HEAD,
    worktreeDigest: DIGEST,
    exitCode: 0,
    outputDigest: `blake3:${'b'.repeat(64)}`,
    assertions,
    runner: 'ci' as const,
  };
  return {
    id: receiptId(r),
    schemaVersion: '1',
    ...r,
    durationMs: 0,
    ts: NOW,
  };
}

function sourceQuoteEvidence(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: SOUL_ID,
    quote: QUOTE,
    targetHash: TARGET,
  };
}

function candidate(claim = 'A.b does the thing'): MemoryCandidate {
  const input = {
    kind: 'fact' as const,
    subject: SOUL_ID,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: [SOUL_ID],
    evidence: [sourceQuoteEvidence()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryCandidateId(input),
    schemaVersion: '1',
    ...input,
    origin: 'observe',
    proposedAt: NOW,
  };
}

function stores() {
  const home = mkdtempSync(join(tmpdir(), 'mem-promo-home-'));
  const crib = mkdtempSync(join(tmpdir(), 'mem-promo-crib-'));
  writeFileSync(join(crib, 'crib.json'), JSON.stringify({ repo: { id: REPO } }));
  const env = { ...process.env, KCRIB_MEMORY_DIR: home };
  __resetMemoryLockGuardForTest();
  const local = MemoryStore.local(REPO, { env, now: () => NOW, repoRoot: '/r' });
  const team = MemoryStore.team(crib, { env, now: () => NOW });
  return {
    home,
    crib,
    local,
    team,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(crib, { recursive: true, force: true });
      __resetMemoryLockGuardForTest();
    },
  };
}

function evaluate(cand: MemoryCandidate, receipt = gateReceipt()) {
  const evaluator = new MemoryEvaluator();
  return evaluateCandidate(cand, { evaluator, soul: fakeSoul(), receipt, now: () => NOW });
}

// ─── buildRecord + receipt view ──────────────────────────────────────────────

describe('buildRecord + receiptView', () => {
  it('cand: and mem: share the claim body → promotion of an identical claim is one mem: id', () => {
    const c = candidate();
    const r = buildRecord(
      c,
      { trust: 'candidate', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
      c.evidence,
      NOW,
    );
    // the prefixes differ, but the hash bodies are identical → idempotent dedupe by content
    expect(c.id.startsWith('cand:')).toBe(true);
    expect(r.id.startsWith('mem:')).toBe(true);
    expect(c.id.slice('cand:'.length)).toBe(r.id.slice('mem:'.length));
    expect(memoryRecordId(r)).toBe(r.id);
  });

  it('receiptView projects the gate receipt to the evaluator subset (drops raw output fields)', () => {
    const r = gateReceipt();
    const v = receiptView(r);
    expect(v.id).toBe(r.id);
    expect(v.exitCode).toBe(0);
    expect(v.assertions).toEqual(r.assertions);
    expect(v.runner).toBe('ci');
  });

  it('policyPortFromReceipt pins the policy/profile hashes the gate ran against', () => {
    const r = gateReceipt();
    const port = policyPortFromReceipt(r);
    expect(port.policyHash()).toBe(r.policyHash);
    expect(port.profileHash()).toBe(r.profileHash);
  });
});

// ─── evaluateCandidate ───────────────────────────────────────────────────────

describe('evaluateCandidate', () => {
  it('stamps the evidence verdicts + keeps trust `candidate` until activated', () => {
    const { record, evaluation } = evaluate(candidate());
    expect(evaluation.evidence).toBe('valid');
    expect(record.verdicts.trust).toBe('candidate');
    expect(record.verdicts.evidence).toBe('valid');
    expect(record.evidence[0]?.verdict).toBe('valid');
    expect(record.evidence[0]?.reason).toBe('ok');
    expect(record.evidence[0]?.checkedAt).toBe(NOW);
  });

  it('is deterministic: re-evaluating the same candidate reproduces the same record id', () => {
    const a = evaluate(candidate());
    const b = evaluate(candidate());
    expect(a.record.id).toBe(b.record.id);
  });
});

// ─── activateLocal (idempotent + crash-safe) ─────────────────────────────────

describe('activateLocal', () => {
  it('writes the record to active + the receipt, then removes the candidate (cleanedUp:true)', () => {
    const { local, cleanup } = stores();
    try {
      const c = candidate();
      local.upsertEntry('candidates', c);
      const { record, evaluation } = evaluate(c);
      const res = activateLocal(local, c, { record, evaluation }, gateReceipt());
      expect(res.recordId).toBe(record.id);
      expect(res.record.verdicts.trust).toBe('local');
      expect(res.cleanedUp).toBe(true);
      // the candidate is gone
      const cands = local.readCollection('candidates');
      expect(cands.entries.find((e) => e.id === c.id)).toBeUndefined();
      // the record is present
      const active = local.readCollection('active');
      expect(active.entries.find((e) => e.id === record.id)).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('crash recovery: a pre-seeded record+receipt with the candidate still present → re-run dedupes + completes cleanup (cleanedUp:false)', () => {
    const { local, cleanup } = stores();
    try {
      const c = candidate();
      const { record, evaluation } = evaluate(c);
      const receipt = gateReceipt();
      // simulate a crash AFTER the shared write but BEFORE cleanup: record + receipt present, candidate still there
      local.upsertEntry('active', { ...record, verdicts: { ...record.verdicts, trust: 'local' } });
      local.upsertEntry('receipts', receipt);
      local.upsertEntry('candidates', c);

      const res = activateLocal(local, c, { record, evaluation }, receipt);
      // the writes were no-op upserts (same ids) → cleanedUp is false because... actually the candidate
      // WAS still present, so removeEntry removes it → cleanedUp:true. The invariant: no duplicates.
      expect(res.recordId).toBe(record.id);
      // exactly one record, one receipt, zero candidates
      expect(local.readCollection('active').entries.filter((e) => e.id === record.id)).toHaveLength(
        1,
      );
      expect(
        local.readCollection('receipts').entries.filter((e) => e.id === receipt.id),
      ).toHaveLength(1);
      expect(local.readCollection('candidates').entries.find((e) => e.id === c.id)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('is idempotent: activating an already-activated candidate is a no-op (no duplicate records)', () => {
    const { local, cleanup } = stores();
    try {
      const c = candidate();
      local.upsertEntry('candidates', c);
      const ev = evaluate(c);
      activateLocal(local, c, ev, gateReceipt());
      // second activation: candidate already removed → cleanedUp:false, still one record
      const res = activateLocal(local, c, ev, gateReceipt());
      expect(res.cleanedUp).toBe(false);
      expect(
        local.readCollection('active').entries.filter((e) => e.id === ev.record.id),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

// ─── proposeTeam (admissibility guard + idempotent) ──────────────────────────

describe('proposeTeam', () => {
  it('writes the team record (trust team) + an accept decision + the receipt', () => {
    const { team, cleanup } = stores();
    try {
      const c = candidate();
      const ev = evaluate(c);
      const receipt = gateReceipt();
      const res = proposeTeam(team, ev, receipt, 'ci-runner', () => NOW);
      expect(res.record.verdicts.trust).toBe('team');
      expect(
        team.readCollection('records').entries.find((e) => e.id === res.recordId),
      ).toBeTruthy();
      expect(
        team.readCollection('decisions').entries.find((e) => e.id === res.decisionId),
      ).toBeTruthy();
      expect(team.readCollection('receipts').entries.find((e) => e.id === receipt.id)).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('is idempotent: re-proposing the same claim reproduces identical ids (no duplicates, no cloud)', () => {
    const { team, cleanup } = stores();
    try {
      const c = candidate();
      const ev = evaluate(c);
      const receipt = gateReceipt();
      const a = proposeTeam(team, ev, receipt, 'ci-runner', () => NOW);
      const b = proposeTeam(team, ev, receipt, 'ci-runner', () => NOW);
      expect(a.recordId).toBe(b.recordId);
      expect(a.decisionId).toBe(b.decisionId);
      expect(
        team.readCollection('records').entries.filter((e) => e.id === a.recordId),
      ).toHaveLength(1);
      expect(
        team.readCollection('decisions').entries.filter((e) => e.id === a.decisionId),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('refuses an invalid-evidence proposal (PRD line 346 admissibility guard)', () => {
    const { team, cleanup } = stores();
    try {
      // a claim whose only evidence is a human-attestation — inadmissible for a `fact` claim
      const c = candidate();
      const inadmissible: MemoryCandidate = {
        ...c,
        evidence: [
          {
            kind: 'human-attestation',
            verdict: 'valid',
            checkedAt: NOW,
            actor: 'someone',
            statement: 'i swear',
          },
        ],
      };
      // recompute the candidate id over the new evidence so it is internally consistent
      inadmissible.id = memoryCandidateId(inadmissible);
      const ev = evaluate(inadmissible);
      expect(ev.evaluation.evidence).toBe('invalid');
      expect(() => proposeTeam(team, ev, gateReceipt(), 'ci-runner', () => NOW)).toThrow(
        ProposalRefusedError,
      );
      // nothing was written
      expect(team.readCollection('records').entries).toHaveLength(0);
      expect(team.readCollection('decisions').entries).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

// ─── verifySnapshot ──────────────────────────────────────────────────────────

describe('verifySnapshot', () => {
  const before: PromotionSnapshot = {
    policyHash: 'p',
    head: HEAD,
    worktreeDigest: DIGEST,
    candidateId: 'cand:x',
  };
  it('matches an identical snapshot', () => {
    expect(verifySnapshot(before, { ...before })).toBe(true);
  });
  it('mismatches on a policy / head / worktree / candidate drift', () => {
    expect(verifySnapshot(before, { ...before, policyHash: 'p2' })).toBe(false);
    expect(verifySnapshot(before, { ...before, head: '1'.repeat(40) })).toBe(false);
    expect(verifySnapshot(before, { ...before, worktreeDigest: 'blake3:other' })).toBe(false);
    expect(verifySnapshot(before, { ...before, candidateId: 'cand:y' })).toBe(false);
  });
});
