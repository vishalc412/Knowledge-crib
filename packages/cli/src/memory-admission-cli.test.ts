import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  type GateReceipt,
  type MemoryCandidate,
  MemoryStore,
  memoryCandidateId,
} from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The admission verbs as SUBPROCESSES — the gap the requirements audit flagged: no test in this
 * suite ever invoked `crib memory evaluate` / `crib memory admit` / `crib memory remember` as a
 * child process, so the only cross-process admission-ack evidence lived in the Playwright browser
 * suite, which the release gate does not run. If the CLI ever printed its exit-0 ack before the
 * record + receipt were durably written (or skipped the candidate cleanup), nothing in `pnpm
 * verify` would notice.
 *
 * The contract under test: the JSON ack is the LAST write of `runLocalAdmission` — gate → evaluate
 * → activate (record + receipt) → candidate cleanup → ack. So after an exit-0 ack, an INDEPENDENT
 * `MemoryStore` in the TEST process (never the one the subprocess used) must find the record in
 * `active` with trust `local`, the gate receipt in `receipts` pinned to the repo's real HEAD, and
 * no candidate left behind. A second subprocess (`memory recall`) must also surface the record —
 * the cheap, CLI-shaped port of the browser suite's post-ack `/memory.json` ledger read (porting
 * the HTTP surface itself would mean booting the viz server, which no CLI-side harness does).
 *
 * Also pinned cross-process: the human-attestation law. `remember` and `admit` record that a
 * HUMAN accepted a claim, so from a non-terminal stdin (exactly what a subprocess has) both must
 * refuse — no spawned process can mint `tty: true`.
 *
 * The harness mirrors memory-capture-hook.test.ts (spawnSync of the BUILT dist/cli.js with a
 * relocated KCRIB_MEMORY_DIR home) and memory-check.test.ts (a real temp git repo — admission
 * snapshots HEAD, so the repo must have a commit).
 *
 * NOTE: requires the BUILT `@knowledge-crib/memory` + cli dists (the CLI imports the compiled
 * packages). Do not rebuild as part of running this file.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-admission';
const CLAIM = 'loan_pkg threshold constant is 30 (admission e2e)';

// A trivial PL/SQL fixture so `indexRepo` produces a real symbol node the evidence can ground
// against (the same fixture memory-portable.test.ts uses).
const SPEC = `CREATE OR REPLACE PACKAGE loan_pkg IS
  C_THRESHOLD CONSTANT NUMBER := 30;
  PROCEDURE process_one(p_id NUMBER);
END loan_pkg;
/
`;

let repo: string;
let home: string;
let cribDir: string;
let nodeId: string;
let nodeHash: string;
let profileName: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-admission-'));
  home = mkdtempSync(join(tmpdir(), 'crib-memory-admission-home-'));
  cribDir = join(repo, '.crib');
  mkdirSync(join(repo, 'db'), { recursive: true });
  writeFileSync(join(repo, 'db', 'loan_pkg_spec.sql'), SPEC);
  // bootstrap .crib: a real soul over the fixture + the locator crib.json with a stable repo.id
  // (the same fixture shape memory-portable.test.ts / memory-check.test.ts use).
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  soul.commit(NOW);
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`,
  );
  git(['init', '-q']);
  git(['config', 'user.name', 'crib-test']);
  git(['config', 'user.email', 'crib-test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  // the REAL policy bootstrap — the same command the onboarding flow runs, so the profile the
  // tests admit against is whatever `crib memory init` actually writes (never a hand-rolled copy
  // that could drift from the shipped default).
  const init = run(['memory', 'init']);
  expect(init.status).toBe(0);
  profileName = gateProfileName();
  // admission snapshots HEAD + the worktree digest, so the repo needs a commit and a clean tree
  // (everything the CLI wrote so far — .crib, the policy, the team store root — is committed).
  git(['add', '-A']);
  git(['commit', '-q', '--allow-empty', '-m', 'seed the admission fixture repo']);
  // the real symbol node the seeded evidence grounds against. The evaluator short-circuits on
  // targetHash === node.hash, so this must be the graph's own hash — never a fabricated one.
  ({ id: nodeId, hash: nodeHash } = findLoanPkgNode());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  // relocate the local/global stores into the temp home (the real `~/.crib` is never touched) and
  // pin the embed home so the subprocess cannot pick up whatever tier the developer installed.
  return {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_EMBED_HOME: join(home, 'embed'),
  };
}

function localStore(): MemoryStore {
  return MemoryStore.local(REPO_ID, { repoRoot: repo, env: env(), now: () => NOW });
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: env(),
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '')
      .split('\n')
      .filter((l) => !l.includes('ExperimentalWarning') && !l.includes('trace-warnings'))
      .join('\n')
      .trim(),
  };
}

function git(args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** The first profile name of the policy `crib memory init` just wrote (the gate the tests run). */
function gateProfileName(): string {
  const policy = JSON.parse(readFileSync(join(cribDir, 'memory', 'policy.json'), 'utf8')) as {
    profiles?: Record<string, unknown>;
  };
  const name = Object.keys(policy.profiles ?? {})[0];
  if (!name) throw new Error('crib memory init wrote a policy with no gate profiles');
  return name;
}

/** The `loan_pkg` symbol node from the persisted extracted graph (id + content hash). */
function findLoanPkgNode(): { id: string; hash: string } {
  const nodesDir = join(cribDir, 'graph', 'extracted', 'nodes');
  for (const shard of readdirSync(nodesDir)) {
    const shardDir = join(nodesDir, shard);
    for (const file of readdirSync(shardDir)) {
      for (const line of readFileSync(join(shardDir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const node = JSON.parse(line) as { id?: string; hash?: string; kind?: string };
        if (node.kind === 'symbol' && node.id?.includes('loan_pkg')) {
          if (!node.hash) throw new Error(`symbol ${node.id} has no hash`);
          return { id: node.id, hash: node.hash };
        }
      }
    }
  }
  throw new Error('loan_pkg symbol not found in the extracted graph');
}

/** A promotable candidate: a fact whose source-quote evidence grounds against the real symbol. */
function seedClaim(claim: string): MemoryCandidate {
  const seed = {
    kind: 'fact' as const,
    subject: nodeId,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO_ID },
    appliesTo: [nodeId],
    evidence: [
      {
        kind: 'source-quote' as const,
        verdict: 'valid' as const,
        checkedAt: NOW,
        soulId: nodeId,
        quote: 'C_THRESHOLD CONSTANT NUMBER := 30',
        targetHash: nodeHash,
      },
    ],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
    origin: 'observe' as const,
  };
  const candidate: MemoryCandidate = {
    ...seed,
    id: memoryCandidateId(seed),
    schemaVersion: '1',
    proposedAt: NOW,
  };
  localStore().upsertEntries('candidates', [candidate]);
  return candidate;
}

describe('crib memory evaluate — the ack is backed by durable state, verified from outside the process', () => {
  it('acks exit 0 only after the record is active, the receipt persisted, and the candidate cleaned up', () => {
    const candidate = seedClaim(CLAIM);
    const r = run(['memory', 'evaluate', candidate.id, '--profile', profileName]);
    expect(r.status).toBe(0);
    // the ack is the only thing on stdout, pretty-printed — parse the whole output
    const ack = JSON.parse(r.stdout) as {
      recordId: string;
      receiptId: string;
      evidence: string;
      applicability: string;
      trust: string;
      cleanedUp: boolean;
    };
    expect(ack).toMatchObject({
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      cleanedUp: true,
    });
    // cand: and mem: share the claim body hash — the activated record's id is the candidate's twin.
    expect(ack.recordId).toBe(`mem:${candidate.id.slice('cand:'.length)}`);

    // The ack is worthless if this state is not on disk — so an INDEPENDENT MemoryStore in the
    // TEST process (never a handle the subprocess held) reads the store it claims to have written.
    const local = MemoryStore.local(REPO_ID, { repoRoot: repo, env: env() });
    const record = local.readCollection('active').entries.find((e) => e.id === ack.recordId) as
      | { verdicts?: { trust?: string; lifecycle?: string }; meta?: { receiptId?: string } }
      | undefined;
    expect(record?.verdicts).toMatchObject({ trust: 'local', lifecycle: 'active' });
    expect(record?.meta?.receiptId).toBe(ack.receiptId);
    const receipt = local.readCollection('receipts').entries.find((e) => e.id === ack.receiptId) as
      | GateReceipt
      | undefined;
    expect(receipt).toBeTruthy();
    // the receipt pins the exact repo state the gate ran against — the real HEAD of this repo
    expect(receipt?.head).toBe(git(['rev-parse', 'HEAD']));
    expect(receipt?.runner).toBe('cli');
    // cleanup: no double-admission path left behind
    expect(
      local.readCollection('candidates').entries.find((e) => e.id === candidate.id),
    ).toBeUndefined();

    // …and the NEXT process sees it too (the CLI-shaped port of the browser suite's post-ack
    // ledger read): recall surfaces the freshly admitted record as recallable local trust.
    const recall = run(['memory', 'recall', 'threshold', '--json']);
    expect(recall.status).toBe(0);
    const memories = JSON.parse(recall.stdout) as {
      memories?: Array<{ id?: string; trust?: string }>;
    };
    const hit = memories.memories?.find((m) => m.id === ack.recordId);
    expect(hit?.trust).toBe('local');
  });

  it('reports unknown-profile as a usage error and unknown-candidate as an error, running no gate', () => {
    const candidate = seedClaim(CLAIM);
    const profile = run(['memory', 'evaluate', candidate.id, '--profile', 'no-such-profile']);
    expect(profile.status).toBe(2);
    expect(profile.stderr).toContain('not in trusted-base policy');

    const missing = run(['memory', 'evaluate', 'cand:deadbeef', '--profile', profileName]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no local candidate');

    // neither refusal ran a gate or mutated the store: the claim is still staged, nothing active.
    const local = MemoryStore.local(REPO_ID, { repoRoot: repo, env: env() });
    expect(local.readCollection('candidates').entries).toHaveLength(1);
    expect(local.readCollection('active').entries).toHaveLength(0);
    expect(local.readCollection('receipts').entries).toHaveLength(0);
  });
});

describe('crib memory remember / admit — a subprocess cannot mint a human attestation', () => {
  it('refuses both verbs without a terminal, and the staged claim survives the refusal', () => {
    const refused = run(['memory', 'remember', 'always run the release gates from a terminal']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('refusing to attest');
    // nothing was staged by the refused remember
    expect(localStore().readCollection('candidates').entries).toHaveLength(0);

    // a staged human-attested claim (the shape the browser suite's terminal-only row uses): the
    // human must confirm it from a terminal — `admit` from a pipe refuses, and the refusal must
    // not consume or mutate the staged claim.
    const seed = {
      kind: 'decision' as const,
      subject: nodeId,
      claim: 'the resume view closes the detail after a recorded resume',
      scope: { boundary: 'repo' as const, repoId: REPO_ID },
      appliesTo: [nodeId],
      evidence: [
        {
          kind: 'human-attestation' as const,
          verdict: 'valid' as const,
          checkedAt: NOW,
          actor: 'human:operator',
        },
      ],
      authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
      origin: 'observe' as const,
    };
    const candidate: MemoryCandidate = {
      ...seed,
      id: memoryCandidateId(seed),
      schemaVersion: '1',
      proposedAt: NOW,
    };
    localStore().upsertEntries('candidates', [candidate]);

    const admit = run(['memory', 'admit', candidate.id]);
    expect(admit.status).toBe(1);
    expect(admit.stderr).toContain('refusing to admit');

    const local = MemoryStore.local(REPO_ID, { repoRoot: repo, env: env() });
    expect(
      local.readCollection('candidates').entries.find((e) => e.id === candidate.id),
    ).toBeTruthy();
    expect(local.readCollection('active').entries).toHaveLength(0);
  });
});
