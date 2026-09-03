import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  type MemoryEvidence,
  type MemoryRecord,
  type MemoryRecordV2,
  MemoryStore,
  type StoreMigrationResult,
  derivePropositionKey,
  memoryRecordId,
  memoryRecordV2Id,
  migrateRecordV1ToV2,
  migrationProvenance,
} from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Gate 1.3 — the `crib memory search|get|supersede|delete|history` subcommands (the portable
 * MemoryApi wired into the CLI), driven end-to-end against the BUILT `dist/cli.js` over a temp
 * indexed repo — the same harness memory-recall.test.ts uses, so the real arg parsing, root
 * resolution, store locks, and fresh evaluator revalidation all run for real.
 *
 * The fixtures deliberately cover the MIXED v1+v2 ledger shapes the wave-2 review flagged:
 *   - a classic v1 record (the W3 response contract must not regress);
 *   - a REAL `MemoryStore.migrateToV2()` pass on the LOCAL store (v1 line replaced by its
 *     re-seeded twin + the alias binding — a legacy id must still resolve, and the alias
 *     snapshot must restore the twin's eligibility);
 *   - a fresh v2 record with NO alias (reads candidate-trust, never crashes the audit tally).
 *
 * It also pins the two v2-awareness fixes inside the pre-existing commands:
 *   - `crib memory audit` no longer crashes / demotes on a migrated ledger (the trust tally
 *     comes from EFFECTIVE verdicts, so it agrees with recall);
 *   - `crib memory recall --json` emits v2-appropriate fields for a migrated twin instead of
 *     undefined v1 ones (scope / appliesTo / createdAt).
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-portable';
const NODE_ID = 'sym:db/loan_pkg_spec.sql#loan_pkg@L1';

// A trivial PL/SQL fixture so `indexRepo` produces a real node the evidence can ground against.
const SPEC = `CREATE OR REPLACE PACKAGE loan_pkg IS
  C_THRESHOLD CONSTANT NUMBER := 30;
  PROCEDURE process_one(p_id NUMBER);
END loan_pkg;
/
`;

function evidence(): MemoryEvidence {
  return {
    kind: 'source-quote',
    verdict: 'valid',
    checkedAt: NOW,
    soulId: NODE_ID,
    quote: 'C_THRESHOLD CONSTANT NUMBER := 30',
  };
}

/** A recall-eligible memory-1 record (admissible fact → grounded source-quote, trust local). */
function v1Record(claim: string): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject: NODE_ID,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO_ID },
    appliesTo: [NODE_ID],
    evidence: [evidence()],
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

/** A fully-formed memory-2 record (passes the v2 write gate when persisted). */
function v2Record(claim: string): MemoryRecordV2 {
  return {
    id: memoryRecordV2Id({
      kind: 'fact',
      subject: NODE_ID,
      propositionKey: derivePropositionKey({ subject: NODE_ID }),
      claim,
      evidence: [evidence()],
    }),
    schemaVersion: '2',
    visibility: 'workspace',
    kind: 'fact',
    subject: NODE_ID,
    propositionKey: derivePropositionKey({ subject: NODE_ID }),
    claim,
    validTime: { from: NOW },
    transactionTime: { observedAt: NOW, recordedAt: NOW },
    evidence: [evidence()],
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

let repo: string;
let home: string;
let cribDir: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'crib-memory-portable-'));
  home = mkdtempSync(join(tmpdir(), 'crib-memory-portable-home-'));
  cribDir = join(repo, '.crib');
  mkdirSync(join(repo, 'db'), { recursive: true });
  writeFileSync(join(repo, 'db', 'loan_pkg_spec.sql'), SPEC);
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
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
  return MemoryStore.team(cribDir, { repoRoot: repo, env: env(), now: () => NOW });
}

function localStore(): MemoryStore {
  return MemoryStore.local(REPO_ID, { repoRoot: repo, env: env(), now: () => NOW });
}

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
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

function runJson(args: string[]): {
  status: number;
  parsed: Record<string, unknown>;
  stderr: string;
} {
  const r = run([...args, '--json']);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    // leave parsed empty — the per-test assertions on parsed fields will fail with context
  }
  return { status: r.status, parsed, stderr: r.stderr };
}

describe('crib memory get — version-aware single-record read', () => {
  it('answers a memory-1 record with the W3 contract (no v2 keys)', () => {
    const rec = v1Record('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    teamStore().upsertEntries('records', [rec]);

    const r = runJson(['memory', 'get', rec.id]);
    expect(r.status).toBe(0);
    expect(r.parsed.id).toBe(rec.id);
    expect(r.parsed.claim).toBe(rec.claim);
    expect(r.parsed.source).toBe('team');
    expect((r.parsed.verdicts as Record<string, unknown>).trust).toBe('local');
    expect(r.parsed.scope).toEqual({ boundary: 'repo', repoId: REPO_ID });
    expect(r.parsed.appliesTo).toEqual([NODE_ID]);
    expect(r.parsed.createdAt).toBe(NOW);
    // v1 keeps the classic shape: no v2 envelope keys are fabricated.
    expect(r.parsed.schemaVersion).toBeUndefined();
    expect(r.parsed.visibility).toBeUndefined();
    expect(r.parsed.propositionKey).toBeUndefined();
    expect(r.parsed.supersededBy).toBeUndefined();
  });

  it('answers a memory-2 record with the v2 fields (not undefined v1 ones)', () => {
    const rec = v2Record('loan_pkg threshold constant is 30 (v2)');
    teamStore().upsertEntries('records', [rec]);

    const r = runJson(['memory', 'get', rec.id]);
    expect(r.status).toBe(0);
    expect(r.parsed.id).toBe(rec.id);
    expect(r.parsed.schemaVersion).toBe('2');
    expect(r.parsed.visibility).toBe('workspace');
    expect(r.parsed.propositionKey).toBe(rec.propositionKey);
    expect(r.parsed.sensitivity).toBe('internal');
    expect(r.parsed.validity).toEqual({
      validTime: { from: NOW },
      transactionTime: { observedAt: NOW, recordedAt: NOW },
    });
    expect((r.parsed.verdicts as Record<string, unknown>).trust).toBe('candidate');
    expect(r.parsed.placement).toEqual(['team']);
    // the v1-only fields the envelope no longer carries are absent, not undefined-valued keys
    expect(r.parsed.scope).toBeUndefined();
    expect(r.parsed.createdAt).toBeUndefined();
  });

  it('follows the alias map: a legacy id resolves to its migrated twin with trust restored', () => {
    const legacy = v1Record('loan_pkg threshold constant is 30');
    const local = localStore();
    local.upsertEntries('active', [legacy]);
    const migration = local.migrateToV2() as StoreMigrationResult;
    expect(migration.migrated).toHaveLength(1);
    const twinId = migration.migrated[0]!;

    const r = runJson(['memory', 'get', legacy.id]);
    expect(r.status).toBe(0);
    expect(r.parsed.id).toBe(twinId);
    expect(r.parsed.requestedId).toBe(legacy.id);
    expect(r.parsed.resolvedViaAlias).toBe(legacy.id);
    expect(r.parsed.schemaVersion).toBe('2');
    // the alias snapshot restores the migrated record's eligibility — never demoted to candidate
    expect((r.parsed.verdicts as Record<string, unknown>).trust).toBe('local');
    expect(r.parsed.source).toBe('local');
    expect(r.parsed.legacyIds).toEqual([legacy.id]);
  });

  it('exit 2 + usage when the id is missing; not-found is an error, not a crash', () => {
    const usage = run(['memory', 'get']);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage: crib memory get');

    const missing = runJson(['memory', 'get', 'mem:does-not-exist']);
    expect(missing.status).toBe(1);
    expect(missing.parsed).toEqual({ found: false, id: 'mem:does-not-exist' });
  });
});

describe('crib memory search — the portable API projection over a mixed ledger', () => {
  it('returns the migrated twin (v2 fields) and the classic v1 record (scope) in one ranked set', () => {
    // local: a v1 record that is then REALLY migrated (v1 line replaced by the re-seeded twin).
    const legacy = v1Record('loan_pkg threshold constant is 30');
    const local = localStore();
    local.upsertEntries('active', [legacy]);
    const migration = local.migrateToV2() as StoreMigrationResult;
    expect(migration.migrated).toHaveLength(1);
    // team: a classic v1 record (the W3 search shape must not regress).
    const teamRec = v1Record('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    teamStore().upsertEntries('records', [teamRec]);

    const r = runJson(['memory', 'search', 'threshold']);
    expect(r.status).toBe(0);
    expect(Object.keys(r.parsed).sort()).toEqual([
      'conflicts',
      'hits',
      'provenance',
      'query',
      'truncated',
    ]);
    const hits = r.parsed.hits as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(2);
    const byId = new Map(hits.map((h) => [String(h.id), h]));
    // the migrated twin: v2 fields, alias-restored trust — never demoted to candidate.
    const twin = byId.get(String(migration.migrated[0]))!;
    expect(twin.schemaVersion).toBe('2');
    expect(twin.visibility).toBe('workspace');
    expect(twin.propositionKey).toBe(derivePropositionKey({ subject: NODE_ID }));
    expect((twin.verdicts as Record<string, unknown>).trust).toBe('local');
    expect(twin.scope).toBeUndefined();
    expect(twin.freshness).toEqual({
      state: 'fresh',
      // deterministic by construction: no wall clock in the response (ifHash-stable)
      evaluatedAt: null,
      codeHead: null,
    });
    // the classic record: the v1 shape with its semantic scope.
    const classic = byId.get(teamRec.id)!;
    expect(classic.schemaVersion).toBe('1');
    expect(classic.scope).toEqual({ boundary: 'repo', repoId: REPO_ID });
    expect(classic.visibility).toBe('workspace');
  });

  it('caps with --limit and flags truncation; --sources rejects unknown names', () => {
    const a = v1Record('loan_pkg threshold constant is 30');
    const b = v1Record('loan_pkg auto-rejects loans above C_THRESHOLD (30)');
    teamStore().upsertEntries('records', [a, b]);

    const capped = runJson(['memory', 'search', 'threshold', '--limit', '1']);
    expect(capped.parsed.hits as unknown[]).toHaveLength(1);
    expect(capped.parsed.truncated).toBe(true);

    const bad = run(['memory', 'search', 'threshold', '--sources', 'bogus']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--sources accepts team, local, global');
  });

  it('human-readable default render is not the JSON shape', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    teamStore().upsertEntries('records', [rec]);

    const r = run(['memory', 'search', 'threshold']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('memory search "threshold"');
    expect(r.stdout).toContain(rec.id);
    expect(r.stdout).not.toContain('"query"');
  });
});

describe('crib memory audit + recall over a migrated ledger (the v2-awareness fixes)', () => {
  it('audit tallies a migrated team record at its alias-restored trust, not candidate, and exits 0', () => {
    // Team migration is alias-only (the append-only ledger retains the v1 line and never writes the
    // twin), so this test ALSO writes the deterministic v2 twin the alias points at — the shape a
    // real synced/migrated team ledger converges to. The store then holds BOTH the retained v1
    // record and its v2 twin, and the tally must count each once at the trust the alias snapshot
    // restores (the pre-G1.3 code crashed on the twin's missing `verdicts` field; a naive fix
    // would demote it to 'candidate').
    const legacy = v1Record('loan_pkg threshold constant is 30');
    const team = teamStore();
    team.upsertEntries('records', [legacy]);
    const migration = team.migrateToV2() as StoreMigrationResult;
    expect(migration.retained).toBe(1); // the v1 line stays; nothing was rewritten
    expect(migration.migrated).toEqual([]); // team migration writes the alias binding ONLY
    const [alias] = team.readAliases();
    expect(alias?.legacyId).toBe(legacy.id);
    // re-derive the deterministic twin (same pure function + env the store's pass used) and
    // confirm it is exactly the record the alias resolves to before persisting it.
    const twin = migrateRecordV1ToV2(legacy, migrationProvenance(legacy.authorship, {}, env()));
    expect(twin.record.id).toBe(alias?.resolvedId);
    team.upsertEntries('records', [twin.record]);

    const r = run(['memory', 'audit']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    const trust = parsed.trust as Record<string, number>;
    expect(trust.local).toBe(2); // retained v1 (stamped) + migrated twin (alias-restored)
    expect(trust.candidate).toBeUndefined();
  });

  it('audit does not crash on a fresh v2 record (no alias) — it tallies as candidate', () => {
    const legacy = v1Record('loan_pkg threshold constant is 30');
    const fresh = v2Record('loan_pkg threshold constant is 31 (v2)');
    const team = teamStore();
    team.upsertEntries('records', [legacy, fresh]);

    const r = run(['memory', 'audit']);
    expect(r.status).toBe(0);
    const trust = (JSON.parse(r.stdout) as Record<string, unknown>).trust as Record<string, number>;
    expect(trust).toEqual({ local: 1, candidate: 1 });
  });

  it('recall --json emits v2-appropriate fields for the migrated twin (no undefined v1 keys)', () => {
    const legacy = v1Record('loan_pkg threshold constant is 30');
    const local = localStore();
    local.upsertEntries('active', [legacy]);
    const migration = local.migrateToV2() as StoreMigrationResult;

    const r = runJson(['memory', 'recall', 'threshold']);
    expect(r.status).toBe(0);
    const memories = r.parsed.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    const twin = memories[0]!;
    expect(twin.id).toBe(migration.migrated[0]);
    expect(twin.schemaVersion).toBe('2');
    expect(twin.visibility).toBe('workspace');
    expect(twin.propositionKey).toBe(derivePropositionKey({ subject: NODE_ID }));
    expect(twin.validTime).toEqual({ from: NOW });
    // the v1-only fields are gone, not present-with-undefined
    expect(twin.scope).toBeUndefined();
    expect(twin.appliesTo).toBeUndefined();
    expect(twin.createdAt).toBeUndefined();
    expect(twin.trust).toBe('local');
  });
});

describe('crib memory supersede / delete / history — the mutation + timeline ops', () => {
  it('supersede --claim writes a memory-2 successor and retires the record from recall', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    teamStore().upsertEntries('records', [rec]);

    const s = runJson([
      'memory',
      'supersede',
      rec.id,
      '--actor',
      'claude-code',
      '--claim',
      'loan_pkg threshold constant is 31',
      '--reason',
      'constant raised',
    ]);
    expect(s.status).toBe(0);
    expect(s.parsed.ok).toBe(true);
    expect(s.parsed.supersededId).toBe(rec.id);
    expect(s.parsed.successorCreated).toBe(true);
    expect(s.parsed.decisionSource).toBe('team');
    const successorId = s.parsed.successorId as string;

    // the retired record now carries the supersession link…
    const after = runJson(['memory', 'get', rec.id]);
    expect(after.parsed.supersededBy as unknown[]).toHaveLength(1);
    // …and recall no longer surfaces it (lifecycle superseded → ineligible).
    const recall = runJson(['memory', 'recall', 'threshold']);
    const ids = (recall.parsed.memories as Array<Record<string, unknown>>).map((m) => m.id);
    expect(ids).not.toContain(rec.id);
    // the successor (fresh v2, no admissible-claim migration) is content-addressed: repeat = no-op.
    const again = runJson([
      'memory',
      'supersede',
      rec.id,
      '--actor',
      'claude-code',
      '--claim',
      'loan_pkg threshold constant is 31',
    ]);
    expect(again.status).toBe(0);
    expect(again.parsed.successorId).toBe(successorId);
    expect(again.parsed.successorCreated).toBe(false);
  });

  it('supersede --successor names an existing record; delete tombstones; history keeps the trail', () => {
    const old = v1Record('loan_pkg threshold constant is 30');
    const replacement = v1Record('loan_pkg threshold constant is 31');
    teamStore().upsertEntries('records', [old, replacement]);

    const s = runJson([
      'memory',
      'supersede',
      old.id,
      '--actor',
      'claude-code',
      '--successor',
      replacement.id,
    ]);
    expect(s.status).toBe(0);
    expect(s.parsed.successorId).toBe(replacement.id);
    expect(s.parsed.successorCreated).toBe(false);

    const d = runJson(['memory', 'delete', replacement.id, '--actor', 'claude-code']);
    expect(d.status).toBe(0);
    expect(d.parsed).toMatchObject({
      ok: true,
      id: replacement.id,
      mode: 'tombstone',
      decisionSource: 'team',
    });
    expect(typeof d.parsed.decisionId).toBe('string');

    // history: the full belief timeline — the tombstone is a retract event, the record line stays.
    const h = runJson(['memory', 'history', replacement.id]);
    expect(h.status).toBe(0);
    expect(h.parsed.key).toBe(replacement.id);
    const events = h.parsed.events as Array<Record<string, unknown>>;
    expect(events.map((e) => e.type)).toContain('retract');
    expect(events.map((e) => e.type)).toContain('recorded');
    const records = h.parsed.records as Array<Record<string, unknown>>;
    expect(records.map((r) => r.id)).toContain(replacement.id);

    // point-in-time: before the retract was recorded, the record was believed active.
    const before = runJson([
      'memory',
      'history',
      replacement.id,
      '--as-of',
      '2025-12-31T00:00:00.000Z',
    ]);
    expect(before.status).toBe(0);
    expect(before.parsed.records as unknown[]).toHaveLength(0); // not yet known then
  });

  it('delete resolves a legacy id through the alias map (the twin is tombstoned)', () => {
    const legacy = v1Record('loan_pkg threshold constant is 30');
    const local = localStore();
    local.upsertEntries('active', [legacy]);
    const migration = local.migrateToV2() as StoreMigrationResult;
    const twinId = migration.migrated[0]!;

    const d = runJson(['memory', 'delete', legacy.id, '--actor', 'claude-code']);
    expect(d.status).toBe(0);
    expect(d.parsed.id).toBe(twinId); // the RESOLVED id, not the legacy one

    // recall drops the tombstoned twin; history still sees the whole trail (append-only).
    const recall = runJson(['memory', 'recall', 'threshold']);
    expect(recall.parsed.memories as unknown[]).toHaveLength(0);
    const h = runJson(['memory', 'history', legacy.id]);
    const events = h.parsed.events as Array<Record<string, unknown>>;
    expect(events.map((e) => e.type)).toContain('retract');
  });

  it('require the actor and the successor-or-claim (exit 2), and report not-found as an error', () => {
    const noActor = run(['memory', 'supersede', 'mem:x', '--claim', 'c']);
    expect(noActor.status).toBe(2);
    expect(noActor.stderr).toContain('usage: crib memory supersede');

    const neither = run(['memory', 'supersede', 'mem:x', '--actor', 'a']);
    expect(neither.status).toBe(2);

    const delMissing = run(['memory', 'delete', 'mem:does-not-exist', '--actor', 'a']);
    expect(delMissing.status).toBe(1);
    expect(delMissing.stderr).toContain('not found');

    const histUsage = run(['memory', 'history']);
    expect(histUsage.status).toBe(2);
    expect(histUsage.stderr).toContain('usage: crib memory history');
  });

  it('rejects an unparseable --as-of with exit 2 — never a silently mis-filtered timeline', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    teamStore().upsertEntries('records', [rec]);
    const bad = run(['memory', 'history', rec.id, '--as-of', 'not-a-date']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('asOf');
  });
});
