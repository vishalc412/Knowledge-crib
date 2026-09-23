import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  type MemoryEvidence,
  type MemoryRecord,
  MemoryStore,
  memoryRecordId,
  verifyMemoryBackup,
} from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * WP1 item 12 — `crib memory migrate` as a REAL migration surface, driven end-to-end against the
 * BUILT `dist/cli.js` over a temp indexed repo (the harness memory-sync.test.ts uses).
 *
 * What this pins, and why each one is worth a test:
 *
 *   - **preview is the default and writes NOTHING.** A command whose name reads like a report must
 *     not rewrite a user's ledger, and "preview touched nothing" is only provable by measuring the
 *     store afterwards.
 *   - **apply stamps local, and the backup holds the PRE-migration bytes.** The backup is the whole
 *     reason `--apply` is safe; a backup taken after the write would be worthless, so the assertion
 *     is that the v1 line is still in the bundle.
 *   - **the TEAM store is retained, not stamped** (append-only invariant), and the command SAYS so.
 *     Measured, not assumed: `migrateToV2` on a team store returns `retained: N` and leaves the v1
 *     line on disk with no provenance. A report that implied otherwise would be the same class of
 *     defect — a claim the engine does not support — that item 12 exists to close.
 *   - **a second apply migrates nothing.** This is the resume story for an interrupted run: the
 *     pass is deterministic and keyed on content ids, so the store IS the progress ledger and no
 *     separate state file has to be kept in sync with it.
 *   - **the principal is explicit, never silently invented.**
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-migrate';
const NODE_ID = 'sym:db/loan_pkg_spec.sql#loan_pkg@L1';

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

/** A recall-eligible memory-1 record (unstamped — exactly what the migration exists to stamp). */
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

let repo: string;
let home: string;
let cribDir: string;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  repo = tempDir('crib-memory-migrate-');
  home = tempDir('crib-memory-migrate-home-');
  const cribDirPath = join(repo, '.crib');
  cribDir = cribDirPath;
  mkdirSync(join(repo, 'db'), { recursive: true });
  writeFileSync(join(repo, 'db', 'loan_pkg_spec.sql'), SPEC);
  const soul = new SoulStore(cribDirPath, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  soul.commit(NOW);
  writeFileSync(
    join(cribDirPath, 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`,
  );
  // `crib memory init` is not decoration: the doctor's `principal boundary enforceable` check is
  // gated on `<repo>/.crib/memory/policy.json` existing (memory is opt-in), so without this the
  // check the migration exists to clear never runs and the last suite asserts against nothing.
  expect(run(['memory', 'init']).status).toBe(0);
  const store = localStore();
  store.ensureManifest();
  store.upsertEntries('active', [v1Record('the loan threshold is 30')]);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deviceEnv(): NodeJS.ProcessEnv {
  return { ...process.env, KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home };
}

function localStore(): MemoryStore {
  return MemoryStore.local(REPO_ID, { repoRoot: repo, env: deviceEnv(), now: () => NOW });
}

function teamStore(): MemoryStore {
  return MemoryStore.team(cribDir, { repoRoot: repo, env: deviceEnv(), now: () => NOW });
}

function run(
  args: string[],
  envPatch?: Record<string, string | null>,
): { status: number; stdout: string; stderr: string } {
  const env = deviceEnv();
  if (envPatch) {
    for (const [k, v] of Object.entries(envPatch)) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
  }
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function runJson(args: string[], envPatch?: Record<string, string | null>) {
  const r = run([...args, '--json'], envPatch);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    /* leave empty — field assertions fail with context */
  }
  return { status: r.status, parsed, stdout: r.stdout, stderr: r.stderr };
}

/** The active-collection records as `{id, schemaVersion, principal}` — the migration's observable. */
function activeShape(): Array<{ id: string; v: unknown; p: string | null }> {
  return (
    localStore().readCollection('active').entries as unknown as Array<{
      id: string;
      schemaVersion?: unknown;
      provenance?: { principalId?: string };
    }>
  ).map((e) => ({ id: e.id, v: e.schemaVersion, p: e.provenance?.principalId ?? null }));
}

describe('crib memory migrate — preview by default, apply on request', () => {
  it('reports what it WOULD stamp and writes nothing when invoked bare', () => {
    const before = activeShape();
    const r = runJson(['memory', 'migrate']);
    expect(r.status).toBe(0);
    expect(r.parsed.mode).toBe('preview');
    expect(r.parsed.totalMigrated).toBe(0);
    const local = (r.parsed.perStore as Array<Record<string, unknown>>).find(
      (s) => s.store === 'local',
    );
    expect(local?.wouldStamp).toBe(1);
    expect(local?.migrated).toBe(0);
    // the load-bearing assertion: nothing on disk moved
    expect(activeShape()).toEqual(before);
    // The split is part of the contract, not decoration (WP1 item 14): the SAME total can mean
    // "run migrate" or "migrate cannot reach this", so a report that only carried `unstamped` let
    // the remediation promise a repair that half existed. This fixture is a LOCAL record, so the
    // whole remainder is private — the actionable half.
    expect(r.parsed.unstampedBefore).toEqual({
      total: 1,
      unstamped: 1,
      unstampedTeam: 0,
      unstampedPrivate: 1,
    });
  });

  it('stamps local records under --apply, leaving one memory-2 record with the principal', () => {
    const r = runJson(['memory', 'migrate', '--apply', '--principal', 'principal:probe']);
    expect(r.status).toBe(0);
    expect(r.parsed.mode).toBe('applied');
    expect(r.parsed.principalId).toBe('principal:probe');
    expect(r.parsed.principalSource).toBe('flag');
    expect(r.parsed.totalMigrated).toBe(1);
    const shape = activeShape();
    expect(shape).toHaveLength(1);
    expect(shape[0]!.v).toBe('2');
    expect(shape[0]!.p).toBe('principal:probe');
    expect(r.parsed.unstampedAfter).toEqual({
      total: 1,
      unstamped: 0,
      unstampedTeam: 0,
      unstampedPrivate: 0,
    });
  });

  it('reports the default principal and its SOURCE honestly when no flag or env is set', () => {
    const r = runJson(['memory', 'migrate', '--apply'], { KCRIB_PRINCIPAL_ID: null });
    expect(r.status).toBe(0);
    expect(r.parsed.principalId).toBe('principal:local');
    expect(r.parsed.principalSource).toBe('default');
  });

  it('takes the principal from KCRIB_PRINCIPAL_ID when no flag is passed', () => {
    const r = runJson(['memory', 'migrate', '--apply'], { KCRIB_PRINCIPAL_ID: 'principal:env' });
    expect(r.status).toBe(0);
    expect(r.parsed.principalId).toBe('principal:env');
    expect(r.parsed.principalSource).toBe('KCRIB_PRINCIPAL_ID');
    expect(activeShape()[0]!.p).toBe('principal:env');
  });

  it('rejects --preview and --apply together rather than picking one', () => {
    const r = run(['memory', 'migrate', '--preview', '--apply']);
    expect(r.status).toBe(2); // EXIT.BAD_ARGS — an ambiguous intent is never resolved by guessing
    expect(r.stderr).toContain('mutually exclusive');
    expect(activeShape()[0]!.v).toBe('1');
  });

  it('rejects an empty --principal (a stamp of "" would be an unowned record)', () => {
    const r = run(['memory', 'migrate', '--apply', '--principal', '']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('non-empty');
    expect(activeShape()[0]!.p).toBe(null);
  });

  it('does not mistake the --principal value for the repo path', () => {
    // --principal is a value flag: if it leaked into positionals, resolveRoot would read
    // 'principal:probe' as the repo and fail NOT_INDEXED (3) instead of succeeding.
    const r = run(['memory', 'migrate', '--apply', '--principal', 'principal:probe']);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('could not resolve repoId');
  });
});

describe('crib memory migrate — the backup is the safety net, and it is pre-migration', () => {
  it('writes a verifiable bundle containing the PRE-migration bytes', () => {
    const r = runJson(['memory', 'migrate', '--apply']);
    expect(r.status).toBe(0);
    const backup = r.parsed.backup as { path: string; files: number };
    expect(backup.files).toBeGreaterThan(0);
    expect(existsSync(backup.path)).toBe(true);
    // verifies as a well-formed bundle (hash-checked against its own manifest)
    expect(verifyMemoryBackup(backup.path).files.length).toBe(backup.files);
    // and it holds the UN-migrated state: the v1 line, not the stamped twin. The shard name is
    // derived from the record id, so scan the collection rather than assume a filename.
    const backed = readdirSync(join(backup.path, 'local', 'active'))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(backup.path, 'local', 'active', f), 'utf8'))
      .join('');
    expect(backed).toContain('"schemaVersion":"1"');
    expect(backed).not.toContain('principal:local');
    // …while the live store is now stamped
    expect(activeShape()[0]!.v).toBe('2');
  });

  it('honours --out instead of the default ~/.crib/memory/backups/<repoId>/ location', () => {
    const out = join(tempDir('crib-migrate-out-'), 'bundle');
    const r = runJson(['memory', 'migrate', '--apply', '--out', out]);
    expect(r.status).toBe(0);
    expect((r.parsed.backup as { path: string }).path).toBe(out);
    expect(existsSync(join(out, 'backup-manifest.json'))).toBe(true);
  });

  it('refuses to apply over an existing bundle at --out, and does NOT migrate', () => {
    const out = join(tempDir('crib-migrate-clash-'), 'bundle');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'occupied\n');
    const r = runJson(['memory', 'migrate', '--apply', '--out', out]);
    expect(r.status).toBe(1);
    expect(r.parsed.mode).toBe('applied'); // the report still describes the attempt…
    expect(r.parsed.backupError).toBeTruthy(); // …and names why it stopped
    // a backup that did not happen is not a backup: the ledger is untouched
    expect(r.parsed.totalMigrated).toBe(0);
    expect(activeShape()[0]!.v).toBe('1');
  });
});

describe('crib memory migrate — resumable without a progress file', () => {
  it('migrates nothing on a second apply (the store IS the ledger)', () => {
    expect(runJson(['memory', 'migrate', '--apply']).parsed.totalMigrated).toBe(1);
    const second = runJson(['memory', 'migrate', '--apply']);
    expect(second.status).toBe(0);
    expect(second.parsed.totalMigrated).toBe(0);
    expect(second.parsed.unstampedAfter).toEqual({
      total: 1,
      unstamped: 0,
      unstampedTeam: 0,
      unstampedPrivate: 0,
    });
    // still exactly one record — a re-run never duplicates a twin
    expect(activeShape()).toHaveLength(1);
    expect(activeShape()[0]!.v).toBe('2');
  });

  it('resumes a partially migrated store, migrating only what is left', () => {
    // simulate an interrupted run: one record already stamped, one still memory-1
    const store = localStore();
    store.upsertEntries('active', [v1Record('a second, unmigrated claim')]);
    store.migrateToV2({ provenance: { principalId: 'principal:probe' } }); // "the part that finished"
    store.upsertEntries('active', [v1Record('a third claim added after the interruption')]);
    expect(activeShape().filter((e) => e.v === '1')).toHaveLength(1);
    const r = runJson(['memory', 'migrate', '--apply', '--principal', 'principal:probe']);
    expect(r.status).toBe(0);
    expect(r.parsed.totalMigrated).toBe(1); // only the leftover
    expect(activeShape().every((e) => e.v === '2')).toBe(true);
    expect(r.parsed.unstampedAfter).toEqual({
      total: 3,
      unstamped: 0,
      unstampedTeam: 0,
      unstampedPrivate: 0,
    });
  });
});

describe('crib memory migrate — the team ledger is retained, and the command says so', () => {
  beforeEach(() => {
    teamStore().upsertEntries('records', [v1Record('a team-shared claim')]);
  });

  it('aliases but cannot stamp a team record, and reports the limit instead of implying success', () => {
    const r = runJson(['memory', 'migrate', '--apply']);
    expect(r.status).toBe(0);
    const team = (r.parsed.perStore as Array<Record<string, unknown>>).find(
      (s) => s.store === 'team',
    );
    expect(team?.retained).toBe(1); // append-only: the committed line is never rewritten
    expect(team?.migrated).toBe(0);
    // the team v1 line is STILL on disk, still unstamped — the boundary genuinely cannot exclude it
    const teamRecords = teamStore().readCollection('records').entries as unknown as Array<{
      schemaVersion?: unknown;
      provenance?: { principalId?: string };
    }>;
    expect(teamRecords).toHaveLength(1);
    expect(teamRecords[0]!.schemaVersion).toBe('1');
    expect(teamRecords[0]!.provenance).toBeUndefined();
    // The split is the whole point of this fixture (WP1 item 14): migrate stamped the LOCAL record
    // and cannot touch the TEAM one, so the residual 1 is entirely un-stampable. Reporting a bare
    // `unstamped: 1` invited the doctor to name `crib memory migrate` as its remedy, which the
    // operator would run, see no change, and be told to run again.
    expect(r.parsed.unstampedAfter).toEqual({
      total: 2,
      unstamped: 1,
      unstampedTeam: 1,
      unstampedPrivate: 0,
    });
  });

  it('tells the operator a retained team record was NOT stamped', () => {
    const r = run(['memory', 'migrate', '--apply']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('aliased but NOT stamped');
    expect(r.stdout).toContain('append-only');
  });

  it('never claims the boundary is enforceable while an unstamped team line remains', () => {
    const r = run(['memory', 'migrate', '--apply']);
    expect(r.stdout).toContain('unstamped records: 2/2 → 1/2');
    expect(r.stdout).not.toContain('the principal boundary is now enforceable');
  });
});

describe('crib memory migrate — the doctor check it exists to clear', () => {
  it('is ✗ before the migration and ✓ after it, on a local-store-only ledger', () => {
    const before = run(['doctor']);
    expect(before.stdout).toMatch(/✗ principal boundary enforceable/);
    expect(before.stdout).toContain('memory-1 (no principal stamp)');

    expect(run(['memory', 'migrate', '--apply']).status).toBe(0);

    const after = run(['doctor']);
    expect(after.stdout).toMatch(/✓ principal boundary enforceable/);
    expect(after.stdout).toContain('all 1 record(s) carry a principal stamp');
  });

  /**
   * WP1 item 14 — the REMEDY, not the verdict.
   *
   * The two tests above pin the ✗/✓ transition and its `detail`; neither reads the `fix` line, so
   * the check's advice was unasserted: the pre-fix text ("run `crib memory migrate` … or pass
   * strictPrincipal on any gather") could be restored and the whole suite would still pass. That
   * text was wrong twice over — `strictPrincipal` is an internal option of `gatherRecall` that no
   * operator passes, and the migrate half promised a repair the team ledger cannot receive.
   *
   * What makes the advice correct is not that it names two commands but the ORDER, which the
   * comment in cli.ts calls load-bearing: the boundary refuses a record it cannot attribute, so
   * engaging the switch before stamping hides the operator's OWN records from them. An assertion
   * that both names appear would pass on advice that gets this backwards.
   */
  it('names the remedy in the order that works — migrate first, THEN engage (WP1 item 14)', () => {
    const r = run(['doctor']);
    expect(r.stdout).toMatch(/✗ principal boundary enforceable/);

    // the fix line belonging to THIS check — not any earlier failing check's
    const after = r.stdout.slice(r.stdout.indexOf('principal boundary enforceable'));
    const fixLine = after.split('\n').find((l) => l.trimStart().startsWith('fix:'));
    expect(fixLine).toBeDefined();
    expect(fixLine).toContain('crib memory migrate');
    expect(fixLine).toContain('KCRIB_STRICT_PRINCIPAL');
    // the claim itself: stamp first, engage second
    expect(fixLine!.indexOf('crib memory migrate')).toBeLessThan(
      fixLine!.indexOf('KCRIB_STRICT_PRINCIPAL'),
    );
    // and the option no operator can pass is not offered as one
    expect(r.stdout).not.toContain('strictPrincipal on any gather');
  });

  it('says plainly that a team-only remainder cannot be cleared by the named repair (WP1 item 14)', () => {
    expect(run(['memory', 'migrate', '--apply']).status).toBe(0); // clear the private remainder
    teamStore().upsertEntries('records', [v1Record('a team-shared claim')]);

    const r = run(['doctor']);
    expect(r.stdout).toMatch(/✗ principal boundary enforceable/);
    const after = r.stdout.slice(r.stdout.indexOf('principal boundary enforceable'));
    const fixLine = after.split('\n').find((l) => l.trimStart().startsWith('fix:'));
    expect(fixLine).toBeDefined();
    expect(fixLine).toContain('TEAM ledger');
    // append-only: migrate ALIASES a committed line, it never stamps it — saying otherwise is the
    // lie that sent an operator round the same loop twice
    expect(fixLine).toContain('cannot stamp');
    expect(fixLine).not.toContain('to stamp your local/global records');
  });
});
