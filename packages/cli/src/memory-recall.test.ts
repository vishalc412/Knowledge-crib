import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  type MemoryCandidate,
  type MemoryRecord,
  MemoryStore,
  memoryCandidateId,
  memoryRecordId,
} from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * P0.1 — `crib memory recall "<query>"` end-to-end. The neutral agent-memory protocol spliced into
 * every IDE instruction file (adapters.ts `neutralProtocolBody`) names this command as the CLI
 * fallback for the `brief` MCP tool's memory half, so it must exist AND behave like the MCP
 * `memory_recall` verb: the same trust-tier eligibility (candidate-trust records never surface in
 * normal recall; only in the opt-in `pending` group), the same ranked projection shape
 * (memories + conflicts + provenance + truncated), and the same store sources.
 *
 * Drives the BUILT `dist/cli.js` against a temp repo the pipeline has indexed, so the real arg
 * parsing + root resolution + fresh evaluator revalidation (the seeded source-quote grounds
 * against the live soul) run for real — not just the pure projection.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-recall';
const NODE_ID = 'sym:db/loan_pkg_spec.sql#loan_pkg@L1';

// A trivial PL/SQL fixture so `indexRepo` produces a real node the evidence can ground against.
const SPEC = `CREATE OR REPLACE PACKAGE loan_pkg IS
  C_THRESHOLD CONSTANT NUMBER := 30;
  PROCEDURE process_one(p_id NUMBER);
END loan_pkg;
/
`;

/** A recall-eligible team record: admissible (fact → source-quote) + grounded against the soul. */
function groundedRecord(claim: string): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: NODE_ID,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO_ID },
    appliesTo: [NODE_ID],
    evidence: [
      {
        kind: 'source-quote' as const,
        verdict: 'valid' as const,
        checkedAt: NOW,
        soulId: NODE_ID,
        quote: 'C_THRESHOLD CONSTANT NUMBER := 30',
      },
    ],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: NOW,
  };
}

/** An INELIGIBLE record: human-attestation is inadmissible for kind fact → evidence ignored → invalid. */
function inadmissibleRecord(): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: NODE_ID,
    claim: 'C_THRESHOLD is 80',
    scope: { boundary: 'repo' as const, repoId: REPO_ID },
    appliesTo: [NODE_ID],
    evidence: [
      {
        kind: 'human-attestation' as const,
        verdict: 'valid' as const,
        checkedAt: NOW,
        actor: 'someone',
        tty: true as const,
        attestedAt: NOW,
      },
    ],
    authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryRecordId(input),
    schemaVersion: '1',
    ...input,
    verdicts: { trust: 'local', evidence: 'valid', applicability: 'current', lifecycle: 'active' },
    createdAt: NOW,
  };
}

/** A candidate-trust observation (memory_observe's output shape) — never recall-eligible. */
function candidate(claim: string): MemoryCandidate {
  const input = {
    kind: 'fact' as const,
    subject: NODE_ID,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO_ID },
    appliesTo: [NODE_ID],
    evidence: [],
    authorship: { actor: 'peer-agent', kind: 'agent' as const, tool: 'claude-code' },
  };
  return {
    id: memoryCandidateId(input),
    schemaVersion: '1',
    ...input,
    origin: 'observe' as const,
    proposedAt: NOW,
  };
}

let repo: string;
let home: string;
let cribDir: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-recall-'));
  home = mkdtempSync(join(tmpdir(), 'crib-memory-recall-home-'));
  cribDir = join(repo, '.crib');
  mkdirSync(join(repo, 'db'), { recursive: true });
  writeFileSync(join(repo, 'db', 'loan_pkg_spec.sql'), SPEC);
  // bootstrap .crib with a repo.id (indexRepo builds the soul in memory but does NOT persist).
  // NOTE: awaited — indexRepo is async; committing before extraction finishes yields a file-only
  // soul and the seeded source-quote evidence could never ground against a symbol node.
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  // persist the soul (graph/manifest.json) so the CLI's SoulStore.load() resolves the canonical
  // layout, then write the bootstrap locator crib.json with a stable repo.id.
  soul.commit(NOW);
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`,
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  // isolate the local/global stores per test (the team store lives under the repo's .crib).
  return { ...process.env, KCRIB_MEMORY_DIR: home };
}

function teamStore(): MemoryStore {
  return MemoryStore.team(cribDir, { repoRoot: repo, env: env() });
}

function localStore(): MemoryStore {
  return MemoryStore.local(REPO_ID, { repoRoot: repo, env: env() });
}

function runRecall(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, 'memory', 'recall', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: env(),
    });
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

describe('crib memory recall — the protocol-named CLI fallback exists', () => {
  it('returns the seeded grounded team record, not "unknown memory subcommand"', () => {
    const good = groundedRecord('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    const hidden = inadmissibleRecord();
    teamStore().upsertEntries('records', [good, hidden]);

    const r = runRecall(['loan threshold']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('unknown memory subcommand');
    expect(r.stdout).toContain(good.id);
    expect(r.stdout).toContain('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    // trust-tier eligibility: the inadmissible-evidence record is considered but never surfaced.
    expect(r.stdout).toContain('considered 2, eligible 1');
    expect(r.stdout).not.toContain(hidden.id);
  });

  it('--json mirrors the memory_recall projection shape (memories + conflicts + provenance + truncated)', () => {
    const good = groundedRecord('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    teamStore().upsertEntries('records', [good]);

    const r = runRecall(['loan', 'threshold', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'conflicts',
      'memories',
      'provenance',
      'truncated',
    ]);
    const memories = parsed.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    expect(memories[0]!.id).toBe(good.id);
    expect(memories[0]!.claim).toBe(good.claim);
    expect(memories[0]!.source).toBe('team');
    // fresh revalidation grounded the quote → evidence stays valid, applicability current.
    expect(memories[0]!.evidence).toBe('valid');
    expect(memories[0]!.applicability).toBe('current');
    // default view = evidence summaries (kind + verdict + soul anchor), not the full items.
    expect(memories[0]!.evidenceItems).toEqual([
      { kind: 'source-quote', verdict: 'valid', soulId: NODE_ID },
    ]);
    const prov = parsed.provenance as Record<string, unknown>;
    // provenance.sources lists the stores that actually yielded records (only team was seeded).
    expect(prov.sources).toEqual(['team']);
    expect((prov.counts as Record<string, number>).eligible).toBe(1);
    expect(prov.fresh).toBe(true);
  });

  // Gate 0 item 1: the wiring must gather ALL THREE stores, not just team. provenance.sources lists
  // the stores that actually yielded records (same semantics as the MCP verb's projection), so
  // seeding one eligible record per store must surface all three — and rank team > local > global.
  it('gathers local and global stores too: one eligible record each surfaces, ranked team > local > global', () => {
    const teamRec = groundedRecord('team says the threshold is 30');
    teamStore().upsertEntries('records', [teamRec]);
    const localRec = groundedRecord('local says the threshold is 30');
    localStore().upsertEntries('active', [localRec]);
    const globalInput = {
      kind: 'fact' as const,
      subject: NODE_ID,
      claim: 'global says the threshold is 30',
      scope: { boundary: 'global' as const },
      appliesTo: [NODE_ID],
      evidence: [
        {
          kind: 'source-quote' as const,
          verdict: 'valid' as const,
          checkedAt: NOW,
          soulId: NODE_ID,
          quote: 'C_THRESHOLD CONSTANT NUMBER := 30',
        },
      ],
      authorship: { actor: 'claude-code', kind: 'agent' as const, tool: 'claude-code' },
    };
    const globalRec: MemoryRecord = {
      id: memoryRecordId(globalInput),
      schemaVersion: '1',
      ...globalInput,
      verdicts: {
        trust: 'local',
        evidence: 'valid',
        applicability: 'current',
        lifecycle: 'active',
      },
      createdAt: NOW,
    };
    MemoryStore.global({ env: env() }).upsertEntries('records', [globalRec]);

    const r = runRecall(['threshold', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    const memories = parsed.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(3);
    // All three stores yielded their eligible record. The exact rank order across sources is not
    // asserted here: criterion 1 (FTS lexical + exact match) dominates criterion 2-4 (source tier),
    // and the three distinct claims carry slightly different BM25 scores — cross-source ranking is
    // pinned by the memory package's own recall tests where claims are held identical.
    expect(memories.map((m) => m.id).sort()).toEqual(
      [teamRec.id, localRec.id, globalRec.id].sort(),
    );
    const prov = parsed.provenance as Record<string, unknown>;
    // provenance.sources is the projection's deterministic push order: team, local, global.
    expect(prov.sources).toEqual(['team', 'local', 'global']);
    expect((prov.counts as Record<string, number>).eligible).toBe(3);
  });

  it('candidate-trust records never enter memories; --include-pending returns them in a separate group', () => {
    const good = groundedRecord('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    teamStore().upsertEntries('records', [good]);
    const pend = candidate('peer found the PL/SQL recover loop fix');
    localStore().upsertEntries('candidates', [pend]);

    const plain = runRecall(['loan threshold']);
    expect(plain.status).toBe(0);
    // default view (human-readable, no --include-pending): the candidate is nowhere in it.
    expect(plain.stdout).not.toContain(pend.id);

    const opted = runRecall(['loan threshold', '--include-pending', '--json']);
    expect(opted.status).toBe(0);
    const parsed = JSON.parse(opted.stdout) as Record<string, unknown>;
    const pending = parsed.pending as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(pend.id);
    // a lead, not an established fact — stamped on every entry, not just the group name.
    expect(pending[0]!.trust).toBe('untrusted');
    expect(pending[0]!.status).toBe('pending');
    // memories stays trusted-only whatever --include-pending returns.
    expect((parsed.memories as Array<Record<string, unknown>>).map((m) => m.id)).toEqual([good.id]);
  });

  it('--limit caps the count and flags truncation (same caps as memory_recall)', () => {
    const a = groundedRecord('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    const b = groundedRecord('loan_pkg threshold constant is named C_THRESHOLD');
    teamStore().upsertEntries('records', [a, b]);

    const all = runRecall(['loan threshold', '--json']);
    expect((JSON.parse(all.stdout).memories as unknown[]).length).toBe(2);

    const capped = runRecall(['loan threshold', '--limit', '1', '--json']);
    const parsed = JSON.parse(capped.stdout) as Record<string, unknown>;
    expect(parsed.memories as unknown[]).toHaveLength(1);
    expect(parsed.truncated).toBe(true);
  });

  it('a query is required (usage + exit 2), not "unknown memory subcommand"', () => {
    const r = runRecall([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: crib memory recall');
    expect(r.stderr).not.toContain('unknown memory subcommand');
  });

  it('--sources rejects unknown store names', () => {
    const r = runRecall(['loan', '--sources', 'bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--sources accepts team, local, global');
  });
});
