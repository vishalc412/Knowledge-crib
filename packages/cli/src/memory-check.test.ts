import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest, openIndex } from '@knowledge-crib/core';
import {
  type GateProfile,
  type GateReceipt,
  type MemoryEvidence,
  type MemoryPolicy,
  type MemoryRecord,
  MemoryStore,
  memoryRecordId,
  policyHash,
  policyPath,
  proposeExisting,
  receiptId,
} from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * W4 Slice 3 — the `crib memory check` CI gate end-to-end (PRD lines 275–280, 350).
 *
 * Drives the BUILT `dist/cli.js` against a real temp git repo with two commits (a trusted base + a PR
 * branch) so the gate's git plumbing — merge-base, `git show <ref>:<path>`, `ls-tree` — runs for real.
 * Covers the four W4 exit-gate invariants (PRD line 350):
 *   1. an untrusted PR cannot inject or alter a command CI executes → self-authoring guard;
 *   2. an agent cannot self-assert a pass → invalid-evidence team records are refused;
 *   3. branch-only memory is not team-trusted → records absent from the trusted ref are pending;
 *   4. exact merged records become team-trusted without a cloud → records present (id + accept
 *      decision) in the trusted ref are `already-trusted`.
 *
 * The gate loads policy from the MERGE BASE (the trusted base commit), never the PR's working-tree
 * policy.json — invariant #1's foundation.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const ACTOR = 'ci-test';

// A trivial PL/SQL fixture so `indexRepo` bootstraps `.crib/crib.json` with a stable repo.id (the
// memory gate needs readRepoId to resolve — indexRepo persists the manifest that carries repo.id).
const SPEC = `CREATE OR REPLACE PACKAGE loan_pkg IS
  C_THRESHOLD CONSTANT NUMBER := 30;
  PROCEDURE process_one(p_id NUMBER);
END loan_pkg;
/
`;

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

const BASE_POLICY: MemoryPolicy = {
  version: 1,
  trustedRef: 'refs/remotes/origin/HEAD',
  profiles: { 'self-test': profile('self-test') },
};
const PR_POLICY_CHANGED: MemoryPolicy = {
  version: 1,
  trustedRef: 'refs/remotes/origin/HEAD',
  profiles: { 'self-test': profile('self-test'), 'new-prof': profile('new-prof') },
};

function ev(verdict: MemoryEvidence['verdict'] = 'valid'): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict,
    checkedAt: NOW,
    soulId: 'sym:db/loan_pkg_spec.sql#loan_pkg',
    quote: 'does the thing',
    targetHash: `blake3:${'a'.repeat(64)}`,
  };
}

/** Build a team-claim record (NOT yet stamped trust:team — proposeExisting does that). */
function record(opts: {
  claim: string;
  evidenceVerdict?: MemoryEvidence['verdict'];
  receiptId?: string;
}): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: 'sym:db/loan_pkg_spec.sql#loan_pkg',
    claim: opts.claim,
    scope: { boundary: 'repo' as const, repoId: 'r-check' },
    appliesTo: ['sym:db/loan_pkg_spec.sql#loan_pkg'],
    evidence: [ev(opts.evidenceVerdict)],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: {
      trust: 'local',
      evidence: opts.evidenceVerdict ?? 'valid',
      applicability: 'current',
      lifecycle: 'active',
    },
    createdAt: NOW,
    ...(opts.receiptId ? { meta: { receiptId: opts.receiptId } } : {}),
  };
}

function receipt(policyHashValue: string): GateReceipt {
  const r = {
    policyHash: policyHashValue,
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

let repo: string;
let cribDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-check-'));
  cribDir = join(repo, '.crib');
  mkdirSync(join(repo, 'db'), { recursive: true });
  writeFileSync(join(repo, 'db', 'loan_pkg_spec.sql'), SPEC);
  // bootstrap .crib with a repo.id (indexRepo persists crib.json — readRepoId resolves at check time)
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  indexRepo(soul, repo);
  mkdirSync(join(cribDir, 'index'), { recursive: true });
  const index = openIndex(soul.getManifest().stores.index.backend, {
    path: join(cribDir, 'index', 'crib.sqlite'),
  });
  index.buildFromSoul(soul, repo);
  index.close();
  // persist the soul (graph/manifest.json) so the CLI's SoulStore.load() resolves the canonical layout,
  // then write the bootstrap locator crib.json with a stable repo.id — readRepoId reads `<crib>/.crib/crib.json`
  // (indexRepo builds the soul in memory but does NOT persist; verbs-memory.test.ts calls soul.commit too).
  soul.commit(NOW);
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: 'r-check', root: '.' } }, null, 2)}\n`,
  );
  // init a git repo (deterministic identity so commits are reproducible)
  git(['init', '-q']);
  git(['config', 'user.name', 'crib-test']);
  git(['config', 'user.email', 'crib-test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Write a policy.json to the crib dir (committed → readable via `git show <ref>:.crib/memory/policy.json`). */
function writePolicy(policy: MemoryPolicy): void {
  mkdirSync(join(cribDir, 'memory'), { recursive: true });
  writeFileSync(policyPath(cribDir), `${JSON.stringify(policy, null, 2)}\n`);
}

/** Commit ALL working-tree state (including .crib) on the current branch. */
function commitAll(message: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '--allow-empty', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

function runCheck(trustedRef: string): { status: number; stdout: string; stderr: string } {
  const r = runCheckRaw(trustedRef);
  if (r.status !== 0) {
    // eslint-disable-next-line no-console
    console.log(`[memory-check] exit=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
  }
  return r;
}

function runCheckRaw(trustedRef: string): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, 'memory', 'check', '--trusted-ref', trustedRef],
      {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, KCRIB_MEMORY_DIR: join(repo, 'mem-home') },
      },
    );
    return { status: 0, stdout: out.trim(), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
    };
  }
}

/**
 * Author a trusted-base commit: writes the base policy + any already-trusted team records (with their
 * accept decisions + receipts) via the real {@link proposeExisting} path, commits, and branches `pr`.
 * Returns the base SHA (used as --trusted-ref) + the live team store.
 */
function setupBase(opts: {
  policy?: MemoryPolicy;
  trusted?: Array<{ rec: MemoryRecord; rcpt: GateReceipt }>;
}): { baseSha: string; team: MemoryStore } {
  const policy = opts.policy ?? BASE_POLICY;
  writePolicy(policy);
  const team = MemoryStore.team(cribDir, {
    repoRoot: repo,
    env: { ...process.env, KCRIB_MEMORY_DIR: join(repo, 'mem-home') },
  });
  for (const { rec, rcpt } of opts.trusted ?? []) {
    // stamp meta.receiptId on the activated record before proposing (the real `crib memory propose` path)
    const stamped: MemoryRecord = { ...rec, meta: { ...(rec.meta ?? {}), receiptId: rcpt.id } };
    proposeExisting(team, stamped, rcpt, ACTOR, () => NOW);
  }
  const baseSha = commitAll('base: trusted policy + already-trusted records');
  git(['checkout', '-b', 'pr', '-q']);
  return { baseSha, team };
}

// ─── invariant #4: exact merged records become team-trusted without a cloud ──────────────────

describe('crib memory check — invariant #4: already-trusted records pass', () => {
  it('a record present (id + accept decision) in the trusted ref is already-trusted and the gate passes', () => {
    const rcpt = receipt(policyHash(BASE_POLICY));
    const rec = record({ claim: 'loan_pkg.process_one is the entry point', receiptId: rcpt.id });
    const { baseSha, team } = setupBase({
      trusted: [{ rec, rcpt }],
    });
    // PR re-proposes the SAME record (idempotent by content id) — already in the trusted ref
    proposeExisting(
      team,
      { ...rec, meta: { ...(rec.meta ?? {}), receiptId: rcpt.id } },
      rcpt,
      ACTOR,
      () => NOW,
    );
    commitAll('pr: re-propose already-trusted record');

    const res = runCheck(baseSha);
    const report = JSON.parse(res.stdout) as {
      alreadyTrusted: number;
      newlyProposed: number;
      ok: boolean;
    };
    expect(res.status).toBe(0);
    expect(report.alreadyTrusted).toBe(1);
    expect(report.newlyProposed).toBe(0);
    expect(report.ok).toBe(true);
  });
});

// ─── invariant #3: branch-only memory is not team-trusted ────────────────────────────────────

describe('crib memory check — invariant #3: branch-only memory is pending', () => {
  it('a newly-proposed record absent from the trusted ref is pending (newly-proposed) but the gate still passes', () => {
    const { baseSha, team } = setupBase({});
    // PR adds a NEW record (not in the trusted ref) with admissible evidence + a merge-base-policy receipt
    const rcpt = receipt(policyHash(BASE_POLICY));
    const rec = record({ claim: 'loan_pkg.C_THRESHOLD is 30', receiptId: rcpt.id });
    proposeExisting(
      team,
      { ...rec, meta: { ...(rec.meta ?? {}), receiptId: rcpt.id } },
      rcpt,
      ACTOR,
      () => NOW,
    );
    commitAll('pr: new team proposal');

    const res = runCheck(baseSha);
    const report = JSON.parse(res.stdout) as {
      alreadyTrusted: number;
      newlyProposed: number;
      ok: boolean;
    };
    expect(res.status).toBe(0);
    expect(report.alreadyTrusted).toBe(0);
    expect(report.newlyProposed).toBe(1);
    expect(report.ok).toBe(true);
  });
});

// ─── invariant #2: an agent cannot self-assert a pass ────────────────────────────────────────

describe('crib memory check — invariant #2: invalid-evidence records are refused', () => {
  it('a team record with invalid evidence is refused and fails the gate', () => {
    const { baseSha, team } = setupBase({});
    // PR commits a team record with invalid evidence — written DIRECTLY (proposeExisting would refuse it
    // at author time; the check must also refuse it at CI time, the authoritative gate).
    const invalidRec: MemoryRecord = {
      ...record({ claim: 'loan_pkg.process_one is broken', evidenceVerdict: 'invalid' }),
      verdicts: {
        trust: 'team',
        evidence: 'invalid',
        applicability: 'current',
        lifecycle: 'active',
      },
    };
    team.upsertEntry('records', invalidRec);
    commitAll('pr: invalid-evidence team record');

    const res = runCheck(baseSha);
    const report = JSON.parse(res.stdout) as { refused: number; ok: boolean };
    expect(res.status).toBe(1);
    expect(report.refused).toBe(1);
    expect(report.ok).toBe(false);
  });
});

// ─── invariant #1: an untrusted PR cannot inject or alter a command CI executes ──────────────

describe('crib memory check — invariant #1: the self-authoring guard', () => {
  it('a policy-changing PR authorizing a memory with a receipt pinning the PR policy is a violation', () => {
    const { baseSha, team } = setupBase({});
    // PR changes the policy (adds a profile) — the merge-base policy is still BASE_POLICY
    writePolicy(PR_POLICY_CHANGED);
    // PR proposes a record whose receipt pins the PR-introduced (changed) policy → self-authoring
    const rcpt = receipt(policyHash(PR_POLICY_CHANGED));
    const rec = record({ claim: 'loan_pkg.process_one passes the new gate', receiptId: rcpt.id });
    proposeExisting(
      team,
      { ...rec, meta: { ...(rec.meta ?? {}), receiptId: rcpt.id } },
      rcpt,
      ACTOR,
      () => NOW,
    );
    commitAll('pr: policy change + self-authorizing memory');

    const res = runCheck(baseSha);
    const report = JSON.parse(res.stdout) as {
      policyChanged: boolean;
      selfAuthoringViolations: string[];
      ok: boolean;
    };
    expect(res.status).toBe(1);
    expect(report.policyChanged).toBe(true);
    expect(report.selfAuthoringViolations).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it('a policy-changing PR with a receipt pinning the MERGE-BASE policy passes (the trusted policy ran the gate)', () => {
    const { baseSha, team } = setupBase({});
    writePolicy(PR_POLICY_CHANGED);
    // the receipt pins the merge-base (trusted) policy → the gate ran under the trusted policy → admissible
    const rcpt = receipt(policyHash(BASE_POLICY));
    const rec = record({ claim: 'loan_pkg.process_one passes the base gate', receiptId: rcpt.id });
    proposeExisting(
      team,
      { ...rec, meta: { ...(rec.meta ?? {}), receiptId: rcpt.id } },
      rcpt,
      ACTOR,
      () => NOW,
    );
    commitAll('pr: policy change + merge-base-pinned receipt');

    const res = runCheck(baseSha);
    const report = JSON.parse(res.stdout) as {
      policyChanged: boolean;
      selfAuthoringViolations: string[];
      newlyProposed: number;
      ok: boolean;
    };
    expect(res.status).toBe(0);
    expect(report.policyChanged).toBe(true);
    expect(report.selfAuthoringViolations).toHaveLength(0);
    expect(report.newlyProposed).toBe(1);
    expect(report.ok).toBe(true);
  });
});

// ─── missing receipts (PRD line 346) ─────────────────────────────────────────────────────────

describe('crib memory check — missing gating receipts fail the gate', () => {
  it('a team record with no meta.receiptId is a missing-receipt violation', () => {
    const { baseSha, team } = setupBase({});
    // a team record with no receipt pinning its gate run — the agent cannot show the trusted policy ran
    const noReceipt: MemoryRecord = {
      ...record({ claim: 'loan_pkg.process_one is admissible' }),
      verdicts: { trust: 'team', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    };
    team.upsertEntry('records', noReceipt);
    commitAll('pr: team record without a receipt');

    const res = runCheck(baseSha);
    const report = JSON.parse(res.stdout) as { missingReceipts: string[]; ok: boolean };
    expect(res.status).toBe(1);
    expect(report.missingReceipts).toHaveLength(1);
    expect(report.ok).toBe(false);
  });
});

// ─── the merge-base policy is loaded, never the PR policy (invariant #1 foundation) ──────────

describe('crib memory check — policy is loaded from the merge base, not the PR', () => {
  it('the merge-base policy hash is the base policy hash, not the PR policy hash', () => {
    const { baseSha, team } = setupBase({});
    writePolicy(PR_POLICY_CHANGED);
    const rcpt = receipt(policyHash(BASE_POLICY));
    const rec = record({ claim: 'loan_pkg.process_one passes the base gate', receiptId: rcpt.id });
    proposeExisting(
      team,
      { ...rec, meta: { ...(rec.meta ?? {}), receiptId: rcpt.id } },
      rcpt,
      ACTOR,
      () => NOW,
    );
    commitAll('pr: policy change');

    const res = runCheck(baseSha);
    const report = JSON.parse(res.stdout) as {
      mergeBasePolicyHash: string;
      prPolicyHash: string;
      policyChanged: boolean;
    };
    expect(res.status).toBe(0);
    expect(report.mergeBasePolicyHash).toBe(policyHash(BASE_POLICY));
    expect(report.prPolicyHash).toBe(policyHash(PR_POLICY_CHANGED));
    expect(report.policyChanged).toBe(true);
  });
});
