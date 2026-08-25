/**
 * W4 Slice 3 — trusted-ref derivation + the `crib memory check` CI gate (PRD lines 250–280, 340–350).
 *
 * Covers the four W4 exit-gate invariants (PRD line 350) as PURE logic (no git):
 *   - an untrusted PR cannot inject or alter a command CI executes → self-authoring guard;
 *   - an agent cannot self-assert a pass → invalid-evidence team records are refused;
 *   - branch-only memory is not team-trusted → records absent from the trusted ref are pending;
 *   - exact merged records become team-trusted without a cloud → records present (id + accept
 *     decision) in the trusted ref are `already-trusted`.
 */
import { describe, expect, it } from 'vitest';
import { memoryRecordId, receiptId } from './ids.js';
import { type GateProfile, type MemoryPolicy, policyHash } from './policy.js';
import {
  type MemoryCheckContext,
  type TrustedTeamPresence,
  deriveTeamTrust,
  runMemoryCheck,
} from './trusted-ref.js';
import type { GateReceipt, MemoryEvidence, MemoryRecord } from './types.js';

const NOW = '2026-01-01T00:00:00.000Z';
const REPO = 'r-check';

function profile(name: string): GateProfile {
  return {
    name,
    executable: 'node',
    args: ['--version'],
    timeoutMs: 5000,
    permittedEnv: ['PATH'],
    successExitCodes: [0],
    assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }],
  };
}

const MERGE_BASE_POLICY: MemoryPolicy = {
  version: 1,
  trustedRef: 'refs/remotes/origin/HEAD',
  profiles: { 'self-test': profile('self-test') },
};
const PR_POLICY_CHANGED: MemoryPolicy = {
  version: 1,
  trustedRef: 'refs/remotes/origin/HEAD',
  profiles: { 'self-test': profile('self-test'), 'new-prof': profile('new-prof') },
};
const MERGE_BASE_POLICY_HASH = policyHash(MERGE_BASE_POLICY);
const PR_POLICY_HASH = policyHash(PR_POLICY_CHANGED);
const OTHER_POLICY_HASH = `blake3:${'c'.repeat(64)}`;

function ev(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: 'sym:src/a.ts#A.b',
    quote: 'does the thing',
    targetHash: `blake3:${'a'.repeat(64)}`,
  };
}

function teamRecord(opts: {
  claim?: string;
  trust?: MemoryRecord['verdicts']['trust'];
  evidence?: MemoryRecord['verdicts']['evidence'];
  receiptId?: string;
}): MemoryRecord {
  const claim = opts.claim ?? 'A.b does the thing';
  const input = {
    kind: 'fact' as const,
    subject: 'sym:src/a.ts#A.b',
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO },
    appliesTo: ['sym:src/a.ts#A.b'],
    evidence: [ev()],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: opts.trust ?? 'team',
      evidence: opts.evidence ?? 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: NOW,
    ...(opts.receiptId ? { meta: { receiptId: opts.receiptId } } : {}),
  };
}

function receipt(policyHash: string): GateReceipt {
  const r = {
    policyHash,
    profileHash: `blake3:${'d'.repeat(64)}`,
    executable: '/usr/bin/node',
    args: ['--version'],
    head: '0'.repeat(40),
    worktreeDigest: `blake3:${'a'.repeat(64)}`,
    exitCode: 0,
    outputDigest: `blake3:${'b'.repeat(64)}`,
    assertions: [{ name: 'exit-ok', passed: true }],
    runner: 'ci' as const,
  };
  return { id: receiptId(r), schemaVersion: '1', ...r, durationMs: 0, ts: NOW };
}

function presence(recordIds: string[], acceptedRecordIds: string[]): TrustedTeamPresence {
  return {
    recordIds: new Set(recordIds),
    acceptedRecordIds: new Set(acceptedRecordIds),
  };
}

// ─── deriveTeamTrust ─────────────────────────────────────────────────────────

describe('deriveTeamTrust', () => {
  it('marks a record trusted iff present + has an accept decision in the trusted ref', () => {
    const r = teamRecord({});
    const present = presence([r.id], [r.id]);
    const v = deriveTeamTrust([r], present);
    expect(v[0]?.trusted).toBe(true);
    expect(v[0]?.reason).toBe('present');
  });

  it('marks a record record-absent when its id is not in the trusted ref (branch-only → pending)', () => {
    const r = teamRecord({});
    const v = deriveTeamTrust([r], presence([], []));
    expect(v[0]?.trusted).toBe(false);
    expect(v[0]?.reason).toBe('record-absent');
  });

  it('marks a record decision-absent when the accept decision is missing from the trusted ref', () => {
    const r = teamRecord({});
    const v = deriveTeamTrust([r], presence([r.id], [])); // record present, no accept decision
    expect(v[0]?.trusted).toBe(false);
    expect(v[0]?.reason).toBe('decision-absent');
  });

  it('marks every record no-trusted-ref (pending) when no trusted ref is configured', () => {
    const r = teamRecord({});
    const v = deriveTeamTrust([r], undefined);
    expect(v[0]?.trusted).toBe(false);
    expect(v[0]?.reason).toBe('no-trusted-ref');
  });
});

// ─── runMemoryCheck — the W4 exit-gate invariants ────────────────────────────

function ctx(over: Partial<MemoryCheckContext> = {}): MemoryCheckContext {
  return {
    mergeBasePolicy: MERGE_BASE_POLICY,
    prPolicy: MERGE_BASE_POLICY,
    presence: presence([], []),
    records: [],
    receipts: new Map(),
    ...over,
  };
}

describe('runMemoryCheck — exact merged records become team-trusted (invariant #4)', () => {
  it('an already-trusted record (in the trusted ref) is reported already-trusted and passes', () => {
    const r = teamRecord({ receiptId: 'rcpt:1' });
    const report = runMemoryCheck(
      ctx({
        presence: presence([r.id], [r.id]),
        records: [r],
        receipts: new Map([['rcpt:1', receipt(MERGE_BASE_POLICY_HASH)]]),
      }),
    );
    expect(report.alreadyTrusted).toBe(1);
    expect(report.newlyProposed).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.perRecord[0]?.status).toBe('already-trusted');
  });
});

describe('runMemoryCheck — branch-only memory is not team-trusted (invariant #3)', () => {
  it('a newly-proposed record absent from the trusted ref is pending, not already-trusted', () => {
    const r = teamRecord({ receiptId: 'rcpt:1' });
    const report = runMemoryCheck(
      ctx({
        presence: presence([], []),
        records: [r],
        receipts: new Map([['rcpt:1', receipt(MERGE_BASE_POLICY_HASH)]]),
      }),
    );
    expect(report.alreadyTrusted).toBe(0);
    expect(report.newlyProposed).toBe(1);
    expect(report.perRecord[0]?.status).toBe('newly-proposed');
    // admissible + receipt pins merge-base policy → gate passes (it will become trusted on merge)
    expect(report.ok).toBe(true);
  });

  it('without a trusted ref, newly-proposed records remain pending and the gate surfaces a warning', () => {
    const r = teamRecord({ receiptId: 'rcpt:1' });
    const report = runMemoryCheck(
      ctx({
        presence: undefined,
        records: [r],
        receipts: new Map([['rcpt:1', receipt(MERGE_BASE_POLICY_HASH)]]),
      }),
    );
    expect(report.withoutTrustedRef).toBe(true);
    expect(report.newlyProposed).toBe(1);
    expect(report.violations.some((v) => v.includes('no trusted ref'))).toBe(true);
  });
});

describe('runMemoryCheck — an agent cannot self-assert a pass (invariant #2)', () => {
  it('a team record with invalid evidence is refused and fails the gate', () => {
    const r = teamRecord({ evidence: 'invalid', receiptId: 'rcpt:1' });
    const report = runMemoryCheck(
      ctx({
        records: [r],
        receipts: new Map([['rcpt:1', receipt(MERGE_BASE_POLICY_HASH)]]),
      }),
    );
    expect(report.refused).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.perRecord[0]?.status).toBe('refused');
  });
});

describe('runMemoryCheck — an untrusted PR cannot inject a command (invariant #1, self-authoring guard)', () => {
  it('a policy-changing PR authorizing a memory with a receipt pinning the PR policy is a violation', () => {
    const r = teamRecord({ receiptId: 'rcpt:1' });
    const report = runMemoryCheck({
      // merge-base and PR policies DIFFER → policyChanged
      mergeBasePolicy: MERGE_BASE_POLICY,
      prPolicy: PR_POLICY_CHANGED,
      presence: presence([], []),
      records: [r],
      // the receipt pins the PR-introduced policy → self-authoring violation (PRD line 276)
      receipts: new Map([['rcpt:1', receipt(PR_POLICY_HASH)]]),
    });
    expect(report.policyChanged).toBe(true);
    expect(report.selfAuthoringViolations).toEqual([r.id]);
    expect(report.ok).toBe(false);
    expect(report.violations[0]).toContain('self-authoring violation');
  });

  it('a policy-changing PR with a receipt pinning the MERGE-BASE policy passes (the trusted policy ran the gate)', () => {
    const r = teamRecord({ receiptId: 'rcpt:1' });
    const report = runMemoryCheck({
      mergeBasePolicy: MERGE_BASE_POLICY,
      prPolicy: PR_POLICY_CHANGED,
      presence: presence([], []),
      records: [r],
      receipts: new Map([['rcpt:1', receipt(MERGE_BASE_POLICY_HASH)]]),
    });
    expect(report.policyChanged).toBe(true);
    expect(report.selfAuthoringViolations).toHaveLength(0);
    expect(report.newlyProposed).toBe(1);
    expect(report.ok).toBe(true);
  });

  it('a receipt pinning an unknown policy (neither merge-base nor PR) is a violation', () => {
    const r = teamRecord({ receiptId: 'rcpt:1' });
    const report = runMemoryCheck(
      ctx({
        records: [r],
        receipts: new Map([['rcpt:1', receipt(OTHER_POLICY_HASH)]]),
      }),
    );
    expect(report.selfAuthoringViolations).toEqual([r.id]);
    expect(report.ok).toBe(false);
  });
});

describe('runMemoryCheck — missing receipts (PRD line 346)', () => {
  it('a team record with no meta.receiptId is a missing-receipt violation', () => {
    const r = teamRecord({}); // no receiptId
    const report = runMemoryCheck(ctx({ records: [r] }));
    expect(report.missingReceipts).toEqual([r.id]);
    expect(report.ok).toBe(false);
  });

  it('a team record whose receiptId is not in the receipts map is a missing-receipt violation', () => {
    const r = teamRecord({ receiptId: 'rcpt:missing' });
    const report = runMemoryCheck(ctx({ records: [r], receipts: new Map() }));
    expect(report.missingReceipts).toEqual([r.id]);
    expect(report.ok).toBe(false);
  });
});

describe('runMemoryCheck — only team-trust records are checked', () => {
  it('ignores local/candidate-trust records (the gate scopes to team proposals)', () => {
    const local = teamRecord({ trust: 'local', receiptId: 'rcpt:1' });
    const report = runMemoryCheck(ctx({ records: [local] }));
    expect(report.checked).toBe(0);
    expect(report.ok).toBe(true);
  });
});
