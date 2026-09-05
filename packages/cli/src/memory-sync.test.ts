import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  type MemoryEvidence,
  type MemoryRecord,
  MemoryStore,
  decisionId,
  memoryRecordId,
} from '@knowledge-crib/memory';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Gate 4 — the sync surfaces (ADR-003 D12), driven end-to-end against the BUILT `dist/cli.js` over
 * a temp indexed repo (the harness memory-portable.test.ts uses). What this pins:
 *
 *   - `init-sync` seeds the D5 baseline and syncs NOTHING; the config file carries a key REFERENCE
 *     + fingerprint + epoch — never the key bytes (D7) — and `--gen-key` mints a 0600 keyfile;
 *   - `sync push` flows post-init changes to the file backend, `sync status` reports honestly;
 *   - a SECOND device (a relocated memory home) pulls the pushed event clean;
 *   - `purge` enforces the exact-confirm law (D11), the dry-run writes nothing, and a real purge
 *     tombstones + removes from the local store;
 *   - `conflicts` folds decision conflicts; `resolve` appends the human decision (append-only).
 *
 * Both memory homes AND the registry are relocated per device via KCRIB_MEMORY_DIR +
 * KCRIB_REGISTRY_DIR set BEFORE the subprocess runs (the store-relocation law).
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'r-sync';
const NODE_ID = 'sym:db/loan_pkg_spec.sql#loan_pkg@L1';
const KEY_HEX = 'a'.repeat(64); // 32 bytes — the D7 env source (value never enters a config file)

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

/** A recall-eligible memory-1 record (admissible fact → grounded source-quote). */
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
let remote: string;
let cribDir: string;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  repo = tempDir('crib-memory-sync-');
  home = tempDir('crib-memory-sync-home-');
  remote = tempDir('crib-memory-sync-remote-');
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
  // The sync surfaces key the local config + events on the store manifest's repo.id — make sure it
  // exists on disk before any CLI invocation (a store that has never been written has none).
  MemoryStore.local(REPO_ID, {
    repoRoot: repo,
    env: deviceEnv(home),
    now: () => NOW,
  }).ensureManifest();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A device env: the given memory home + registry relocated, the shared sync key in the env (D7). */
function deviceEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KCRIB_MEMORY_DIR: homeDir,
    KCRIB_REGISTRY_DIR: homeDir,
    KCRIB_SYNC_KEY: KEY_HEX,
  };
}

function localStore(homeDir: string = home): MemoryStore {
  return MemoryStore.local(REPO_ID, { repoRoot: repo, env: deviceEnv(homeDir), now: () => NOW });
}

/** Run the CLI as device `homeDir` from `cwdDir`; `envPatch` deletes keys (set a value to `null`
 *  to remove it). The cwd decides WHICH repo the invocation sees — two clones of one repo have
 *  different crib.json repo ids but share the sync id (see the --sync-id tests below). */
function run(
  args: string[],
  homeDir: string = home,
  envPatch?: Record<string, string | null>,
  cwdDir: string = repo,
): { status: number; stdout: string; stderr: string } {
  const base = deviceEnv(homeDir);
  const env = { ...base };
  if (envPatch) {
    for (const [k, v] of Object.entries(envPatch)) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
  }
  // spawnSync (not execFileSync) so stderr warnings on a SUCCESSFUL run are observable too.
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwdDir,
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

function runJson(
  args: string[],
  homeDir: string = home,
  envPatch?: Record<string, string | null>,
  cwdDir: string = repo,
): { status: number; parsed: Record<string, unknown>; stderr: string } {
  const r = run([...args, '--json'], homeDir, envPatch, cwdDir);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    // leave parsed empty — the per-test assertions on parsed fields will fail with context
  }
  return { status: r.status, parsed, stderr: r.stderr };
}

describe('crib memory init — the memory-loop bootstrap', () => {
  it('creates the team store root so the doctor memory-loop check completes in one command', () => {
    // Regression: init used to write only policy.json; the doctor memory-loop check (policy +
    // team store + adapters) then reported `team store ✗` with a fix hint pointing back at
    // `crib memory init` — circular, and unfixable until the first team write.
    const r = run(['memory', 'init']);
    expect(r.status).toBe(0);
    expect(existsSync(join(cribDir, 'memory', 'policy.json'))).toBe(true);
    expect(existsSync(join(cribDir, 'memory', 'team'))).toBe(true);

    // Idempotent: a second init keeps the policy and does not error.
    const again = run(['memory', 'init']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('policy already present');
  });
});

describe('crib memory backup — verified recovery workflow (F12)', () => {
  it('creates, verifies, and restores the local/global stores', () => {
    const rec = v1Record('loan_pkg threshold survives a verified restore');
    localStore().upsertEntries('active', [rec]);
    const bundle = join(repo, 'memory-backup');

    const created = runJson(['memory', 'backup', 'create', '--out', bundle]);
    expect(created.status).toBe(0);
    expect(created.parsed.ok).toBe(true);
    expect(existsSync(join(bundle, 'backup-manifest.json'))).toBe(true);

    const verified = runJson(['memory', 'backup', 'verify', '--from', bundle]);
    expect(verified.status).toBe(0);
    expect(verified.parsed.ok).toBe(true);

    localStore().removeEntry('active', rec.id);
    expect(localStore().findEntry('active', rec.id)).toBeUndefined();
    const restored = runJson([
      'memory',
      'backup',
      'restore',
      '--from',
      bundle,
      '--stores',
      'local,global',
      '--force',
    ]);
    expect(restored.status).toBe(0);
    expect(restored.parsed.restored).toEqual(['local', 'global']);
    expect(localStore().findEntry('active', rec.id)?.id).toBe(rec.id);
  });
});

describe('crib memory init-sync — the D5/D7 configuration surface', () => {
  it('seeds the baseline, writes a references-only config, and syncs NOTHING', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]);

    const r = runJson([
      'memory',
      'init-sync',
      '--scope',
      'repo',
      '--backend',
      'file',
      '--url',
      remote,
      '--gen-key',
    ]);
    expect(r.status).toBe(0);
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.synced).toBe(false); // D5 honesty: init-sync is bookkeeping, never a transfer
    expect(String(r.parsed.message)).toContain('synced nothing');
    const configPath = r.parsed.configPath as string;
    expect(configPath).toContain(join('sync', `local-${REPO_ID}.json`));

    // The config is references only: keySource + fingerprint + epoch + the backend location.
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(config.keySource).toBe('keyfile');
    expect(typeof config.keyFingerprint).toBe('string');
    expect(config.keyEpoch).toBe(1);
    expect(config.backend).toEqual({ kind: 'file', url: remote });
    // D7 — the minted key's bytes appear NOWHERE in the config.
    const keyHex = readFileSync(join(home, 'sync-key'), 'utf8').trim();
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(configPath, 'utf8')).not.toContain(keyHex);
    // --gen-key mints the keyfile 0600 (owner-read/write only).
    expect(statSync(join(home, 'sync-key')).mode & 0o777).toBe(0o600);

    // The remote target is untouched: init-sync never pushes (the baseline acked the record).
    expect(existsSync(join(remote, 'manifest.json'))).toBe(false);
  });

  it('resolves the key from KCRIB_SYNC_KEY when no key flag is given', () => {
    const r = runJson([
      'memory',
      'init-sync',
      '--scope',
      'global',
      '--backend',
      'file',
      '--url',
      remote,
    ]);
    expect(r.status).toBe(0);
    const config = JSON.parse(readFileSync(r.parsed.configPath as string, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.keySource).toBe('env'); // the env NAME is the reference; the value is never stored
    expect(readFileSync(r.parsed.configPath as string, 'utf8')).not.toContain(KEY_HEX);
  });

  it('fails closed on an unresolvable key and refuses a second key source', () => {
    const noKey = run(
      ['memory', 'init-sync', '--scope', 'repo', '--backend', 'file', '--url', remote],
      home,
      { KCRIB_SYNC_KEY: null }, // no env key, no keyfile → D7 fails closed
    );
    expect(noKey.status).toBe(1);
    expect(noKey.stderr).toContain('error:');
    expect(noKey.stderr).toContain('no sync key resolved');

    const two = run([
      'memory',
      'init-sync',
      '--scope',
      'repo',
      '--backend',
      'file',
      '--url',
      remote,
      '--key-env',
      'OTHER',
      '--gen-key',
    ]);
    expect(two.status).toBe(2);
    expect(two.stderr).toContain('ONE of --key-env');
  });
});

describe('crib memory sync — push, status, and the honest unconfigured shape', () => {
  it('pushes post-init changes to the file backend; status reports both stores', () => {
    const init = runJson([
      'memory',
      'init-sync',
      '--scope',
      'repo',
      '--backend',
      'file',
      '--url',
      remote,
    ]);
    expect(init.status).toBe(0);

    // status BEFORE any transfer: initialized, nothing staged, remote reachable and empty.
    const st = runJson(['memory', 'sync', 'status']);
    expect(st.status).toBe(0);
    const stores = st.parsed.stores as Array<Record<string, unknown>>;
    expect(stores.map((s) => s.store)).toEqual(['local', 'global']);
    const local = stores[0]!;
    expect(local.status).toBe('initialized');
    expect(local.staged).toBe(0);
    const remoteView = local.remote as Record<string, unknown>;
    expect(remoteView.reachable).toBe(true);
    expect(remoteView.batches).toBe(0);
    // no manifest remotely yet → the fingerprint comparison is honestly ABSENT, not false
    expect(remoteView.keyFingerprintMatch).toBeUndefined();
    const configs = st.parsed.configs as Array<Record<string, unknown>>;
    expect(configs[0]).toMatchObject({ scope: 'local', configured: true, keyEpoch: 1 });
    expect(configs[1]).toMatchObject({ scope: 'global', configured: false });

    // A post-init record flows on the next push (the baseline did NOT ack it — D5).
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]);
    const push = runJson(['memory', 'sync', 'push']);
    expect(push.status).toBe(0);
    const pushed = (push.parsed.stores as Array<Record<string, unknown>>)[0]!;
    expect(pushed.ok).toBe(true);
    const report = pushed.push as Record<string, unknown>;
    expect(report.status).toBe('pushed');
    expect(report.stagedNow).toBe(1);
    expect(report.pushed).toBe(1);

    // The D6 physical layout: a manifest + event blobs under ev/ — and the status report now
    // compares the manifest fingerprint against the resolved key (D7 verify-everything).
    expect(existsSync(join(remote, 'manifest.json'))).toBe(true);
    expect(readdirSync(join(remote, 'ev')).length).toBe(1);
    const stAfter = runJson(['memory', 'sync', 'status']);
    const localAfter = (stAfter.parsed.stores as Array<Record<string, unknown>>)[0]!;
    expect((localAfter.remote as Record<string, unknown>).keyFingerprintMatch).toBe(true);
    expect((localAfter.remote as Record<string, unknown>).batches).toBe(1);

    // A re-push is a no-op (the acks are LAST, D4): nothing staged, nothing pushed.
    const again = runJson(['memory', 'sync', 'push']);
    const againReport = ((again.parsed.stores as Array<Record<string, unknown>>)[0]!.push ??
      {}) as Record<string, unknown>;
    expect(againReport.stagedNow).toBe(0);
    expect(againReport.pushed).toBe(0);
  });

  it('push --backfill stages even what the baseline acked (the explicit D5 flag)', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]); // present BEFORE init → acked by the baseline
    const init = runJson([
      'memory',
      'init-sync',
      '--scope',
      'repo',
      '--backend',
      'file',
      '--url',
      remote,
    ]);
    expect(init.status).toBe(0);

    const plain = runJson(['memory', 'sync', 'push']);
    const plainReport = ((plain.parsed.stores as Array<Record<string, unknown>>)[0]!.push ??
      {}) as Record<string, unknown>;
    expect(plainReport.pushed).toBe(0); // acked at init — a plain push moves nothing

    const backfill = runJson(['memory', 'sync', 'push', '--backfill']);
    const backfillReport = ((backfill.parsed.stores as Array<Record<string, unknown>>)[0]!.push ??
      {}) as Record<string, unknown>;
    expect(backfillReport.pushed).toBe(1);
  });

  it('refuses push/pull on an unconfigured scope honestly (exit 1, never a silent skip)', () => {
    const r = runJson(['memory', 'sync', 'push']);
    expect(r.status).toBe(1);
    const stores = r.parsed.stores as Array<Record<string, unknown>>;
    expect(stores).toHaveLength(2);
    for (const s of stores) {
      expect(s.ok).toBe(false);
      expect(String(s.error)).toContain('init-sync');
    }
  });

  it('status degrades to a warning (not a crash) when the configured key cannot resolve', () => {
    const init = runJson(
      [
        'memory',
        'init-sync',
        '--scope',
        'repo',
        '--backend',
        'file',
        '--url',
        remote,
        '--key-env',
        'SYNC_KEY',
      ],
      home,
      { SYNC_KEY: KEY_HEX },
    );
    expect(init.status).toBe(0);
    // The config references env SYNC_KEY; without it the key resolution fails — the sidecar
    // counts are still reported and the failure is STATED, never swallowed.
    const st = run(['memory', 'sync', 'status'], home, { SYNC_KEY: null });
    expect(st.status).toBe(0);
    expect(st.stdout).toContain('sync status');
    expect(st.stderr).toContain('no sync key resolved');
  });
});

describe('crib memory sync — cross-device pull over the file backend', () => {
  it("a second device (relocated home) pulls device A's pushed event clean", () => {
    // Device A: init, write, push.
    const homeA = tempDir('crib-memory-sync-device-a-');
    const initA = runJson(
      ['memory', 'init-sync', '--scope', 'repo', '--backend', 'file', '--url', remote],
      homeA,
    );
    expect(initA.status).toBe(0);
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore(homeA).upsertEntries('active', [rec]);
    const pushA = runJson(['memory', 'sync', 'push'], homeA);
    expect(pushA.status).toBe(0);

    // Device B: a DIFFERENT memory home, same backend + same key (D7 shared key material).
    const homeB = tempDir('crib-memory-sync-device-b-');
    MemoryStore.local(REPO_ID, {
      repoRoot: repo,
      env: deviceEnv(homeB),
      now: () => NOW,
    }).ensureManifest();
    const initB = runJson(
      ['memory', 'init-sync', '--scope', 'repo', '--backend', 'file', '--url', remote],
      homeB,
    );
    expect(initB.status).toBe(0);
    const pull = runJson(['memory', 'sync', 'pull'], homeB);
    expect(pull.status).toBe(0);
    const pullReport = ((pull.parsed.stores as Array<Record<string, unknown>>)[0]!.pull ??
      {}) as Record<string, unknown>;
    expect(pullReport.status).toBe('pulled');
    expect(pullReport.batchesSeen).toBe(1);
    expect(pullReport.batchesApplied).toBe(1);
    const applied = pullReport.applied as Array<Record<string, unknown>>;
    expect(applied.map((a) => a.payloadId)).toContain(rec.id);

    // The pulled record is readable on device B through the ordinary surface.
    const got = runJson(['memory', 'get', rec.id], homeB);
    expect(got.status).toBe(0);
    expect(got.parsed.id).toBe(rec.id);
    expect(got.parsed.source).toBe('local');

    // A re-pull is a no-op (the cursor advanced LAST, D4).
    const again = runJson(['memory', 'sync', 'pull'], homeB);
    const againReport = ((again.parsed.stores as Array<Record<string, unknown>>)[0]!.pull ??
      {}) as Record<string, unknown>;
    expect(againReport.batchesApplied).toBe(0);
  });
});

/**
 * A second independently indexed repo: its crib.json carries a DIFFERENT repo.id (a fresh
 * manifest would mint a randomUUID), so nothing about the two checkouts matches except what the
 * operator makes match — the `--sync-id` (F6/F8/F12/F18's stable cross-clone id).
 */
async function makeDeviceRepo(repoId: string): Promise<string> {
  const dir = tempDir('crib-memory-sync-clone-');
  mkdirSync(join(dir, 'db'), { recursive: true });
  writeFileSync(join(dir, 'db', 'loan_pkg_spec.sql'), SPEC);
  const cribPath = join(dir, '.crib');
  const soul = new SoulStore(cribPath, { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, dir);
  soul.commit(NOW);
  writeFileSync(
    join(cribPath, 'crib.json'),
    `${JSON.stringify({ repo: { id: repoId, root: '.' } }, null, 2)}\n`,
  );
  return dir;
}

describe('crib memory sync — cross-clone reconciliation via --sync-id', () => {
  it('two clones with DIFFERENT crib.json repo ids reconcile under one --sync-id', async () => {
    const repoB = await makeDeviceRepo('r-sync-clone-b');
    const homeA = tempDir('crib-memory-sync-clone-a-');
    const homeB = tempDir('crib-memory-sync-clone-b-');
    const SYNC_ID = 'sync-both-clones-share-this';

    // Device A (the fixture repo, repo id r-sync): init WITH the shared id, write, push.
    const initA = runJson(
      [
        'memory',
        'init-sync',
        '--scope',
        'repo',
        '--backend',
        'file',
        '--url',
        remote,
        '--sync-id',
        SYNC_ID,
      ],
      homeA,
    );
    expect(initA.status).toBe(0);
    expect(initA.parsed.syncRepoId).toBe(SYNC_ID);
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore(homeA).upsertEntries('active', [rec]);
    const pushA = runJson(['memory', 'sync', 'push'], homeA);
    expect(pushA.status).toBe(0);
    const pushReportA = (pushA.parsed.stores as Array<Record<string, unknown>>)[0]!.push as Record<
      string,
      unknown
    >;
    expect(pushReportA.pushed).toBe(1);

    // Device B (a DIFFERENT clone: different repo id AND different memory home), same --sync-id.
    const initB = runJson(
      [
        'memory',
        'init-sync',
        '--scope',
        'repo',
        '--backend',
        'file',
        '--url',
        remote,
        '--sync-id',
        SYNC_ID,
      ],
      homeB,
      undefined,
      repoB,
    );
    expect(initB.status).toBe(0);
    expect(initB.parsed.syncRepoId).toBe(SYNC_ID);
    const pull = runJson(['memory', 'sync', 'pull'], homeB, undefined, repoB);
    expect(pull.status).toBe(0);
    const pullReport = (pull.parsed.stores as Array<Record<string, unknown>>)[0]!.pull as Record<
      string,
      unknown
    >;
    expect(
      (pullReport.applied as Array<Record<string, unknown>>).map((a) => a.payloadId),
    ).toContain(rec.id);
    // readable through the ordinary surface on the other clone
    const got = runJson(['memory', 'get', rec.id], homeB, undefined, repoB);
    expect(got.status).toBe(0);
    expect(got.parsed.id).toBe(rec.id);
  });

  it('without a shared --sync-id the different repo id surfaces honestly and applies nothing', async () => {
    const repoB = await makeDeviceRepo('r-sync-clone-c');
    const homeA = tempDir('crib-memory-sync-clone-c-a-');
    const homeB = tempDir('crib-memory-sync-clone-c-b-');
    // NO --sync-id on either device: each derives its own repo id, so the ids cannot match
    const initA = runJson(
      ['memory', 'init-sync', '--scope', 'repo', '--backend', 'file', '--url', remote],
      homeA,
    );
    expect(initA.status).toBe(0);
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore(homeA).upsertEntries('active', [rec]);
    expect(runJson(['memory', 'sync', 'push'], homeA).status).toBe(0);

    const initB = runJson(
      ['memory', 'init-sync', '--scope', 'repo', '--backend', 'file', '--url', remote],
      homeB,
      undefined,
      repoB,
    );
    expect(initB.status).toBe(0);
    const pull = runJson(['memory', 'sync', 'pull'], homeB, undefined, repoB);
    expect(pull.status).toBe(0); // surfaced, never a crash — and never silently dropped either
    const pullReport = (pull.parsed.stores as Array<Record<string, unknown>>)[0]!.pull as Record<
      string,
      unknown
    >;
    expect(pullReport.applied).toHaveLength(0);
    expect((pullReport.surfaced as Array<Record<string, unknown>>).map((x) => x.reason)).toContain(
      'different-repo',
    );
  });

  it('init-sync --key-env CUSTOM threads the env-var NAME into the config; push resolves from it', () => {
    const homeA = tempDir('crib-memory-sync-keyenv-');
    // init WITHOUT the ambient KCRIB_SYNC_KEY — the key comes ONLY from $CUSTOM (D7 reference)
    const init = runJson(
      [
        'memory',
        'init-sync',
        '--scope',
        'repo',
        '--backend',
        'file',
        '--url',
        remote,
        '--key-env',
        'CUSTOM',
      ],
      homeA,
      { KCRIB_SYNC_KEY: null, CUSTOM: KEY_HEX },
    );
    expect(init.status).toBe(0);
    // the record is written AFTER the baseline (D5: the baseline acks what exists at init time)
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore(homeA).upsertEntries('active', [rec]);
    // push succeeds reading $CUSTOM (the ambient var is absent in this run's env)
    const push = runJson(['memory', 'sync', 'push'], homeA, {
      KCRIB_SYNC_KEY: null,
      CUSTOM: KEY_HEX,
    });
    expect(push.status).toBe(0);
    const pushReport = (push.parsed.stores as Array<Record<string, unknown>>)[0]!.push as Record<
      string,
      unknown
    >;
    expect(pushReport.pushed).toBe(1);

    // a WRONG value under $CUSTOM resolves but fails the fingerprint verification — fail closed
    const wrong = runJson(['memory', 'sync', 'push'], homeA, {
      KCRIB_SYNC_KEY: null,
      CUSTOM: 'b'.repeat(64),
    });
    expect(wrong.status).toBe(1);
    // the refusal is the run report's error (named SOURCE, never bytes) — env CUSTOM, fail closed
    const wrongStore = (wrong.parsed.stores as Array<Record<string, unknown>>)[0]!;
    expect(wrongStore.ok).toBe(false);
    expect(String(wrongStore.error)).toContain('fingerprint');

    // an ABSENT $CUSTOM is a refusal too — the config's referenced name is the only source
    // (the ambient KCRIB_SYNC_KEY present in this run is NOT consulted: the reference threads)
    const missing = runJson(['memory', 'sync', 'push'], homeA, {
      KCRIB_SYNC_KEY: KEY_HEX,
      CUSTOM: null,
    });
    expect(missing.status).toBe(1);
    const missingStore = (missing.parsed.stores as Array<Record<string, unknown>>)[0]!;
    expect(missingStore.ok).toBe(false);
    expect(String(missingStore.error)).toContain('CUSTOM');
  });
});

describe('crib memory purge — the D11 exact-confirm law', () => {
  it('refuses when --confirm does not repeat the exact id list (exit 1, nothing written)', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]);

    const mismatch = runJson([
      'memory',
      'purge',
      rec.id,
      '--confirm',
      'mem:other',
      '--stores',
      'local',
    ]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('confirmIds must repeat the exact purge list');
    // the refusal wrote nothing — the record is still readable
    expect(runJson(['memory', 'get', rec.id]).parsed).toMatchObject({ id: rec.id });
  });

  it('usage exit 2 without ids or --confirm', () => {
    const noConfirm = run(['memory', 'purge', 'mem:x']);
    expect(noConfirm.status).toBe(2);
    expect(noConfirm.stderr).toContain('usage: crib memory purge');
  });

  it('dry-run computes the full report and writes nothing', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]);

    const dry = runJson([
      'memory',
      'purge',
      rec.id,
      '--confirm',
      rec.id,
      '--stores',
      'local',
      '--dry-run',
    ]);
    expect(dry.status).toBe(0);
    expect(dry.parsed.dryRun).toBe(true);
    const report = (dry.parsed.purged as Array<Record<string, unknown>>)[0]!;
    expect(report.found).toBe(true);
    // the dry-run still shows the tombstone + removal it WOULD perform…
    const storeReport = (report.stores as Array<Record<string, unknown>>)[0]!;
    expect(storeReport.removed).toBe(false); // …but nothing was removed
    // …and nothing WAS written: the record is still readable.
    expect(runJson(['memory', 'get', rec.id]).parsed).toMatchObject({ id: rec.id });
  });

  it('a real purge tombstones, removes from the local shard, and reports honestly', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]);

    const purge = runJson([
      'memory',
      'purge',
      rec.id,
      '--confirm',
      rec.id,
      '--stores',
      'local',
      '--history-scan',
    ]);
    expect(purge.status).toBe(0);
    expect(purge.parsed.ok).toBe(true);
    const report = (purge.parsed.purged as Array<Record<string, unknown>>)[0]!;
    expect(report.found).toBe(true);
    const storeReport = (report.stores as Array<Record<string, unknown>>)[0]!;
    expect(storeReport.removed).toBe(true);
    expect(typeof storeReport.decisionId).toBe('string'); // the synced, replayable tombstone (D9)

    // the record is gone from reads; the git history honesty note is stated, never glossed.
    expect(runJson(['memory', 'get', rec.id]).parsed.found).toBe(false);
    expect(purge.parsed.ok).toBe(true);
  });
});

describe('crib memory conflicts + resolve — the D8 read-only fold and the append-only resolution', () => {
  it('reports no conflicts on a clean ledger (read-only, exit 0)', () => {
    const r = runJson(['memory', 'conflicts']);
    expect(r.status).toBe(0);
    expect(r.parsed.decisionConflicts).toEqual([]);
    expect(r.parsed.syncConflicts).toEqual([]);
  });

  it('folds a retract + supersede on the same subject into a decision conflict group', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    const local = localStore();
    local.upsertEntries('active', [rec]);
    // Two retiring decisions on the same subject, written directly (a synced divergence):
    const retract = {
      id: decisionId({ kind: 'retract', subject: rec.id, actor: 'device-a' }),
      schemaVersion: '1' as const,
      kind: 'retract' as const,
      subject: rec.id,
      actor: 'device-a',
      ts: NOW,
    };
    const supersede = {
      id: decisionId({
        kind: 'supersede',
        subject: rec.id,
        successor: 'mem:elsewhere',
        actor: 'device-b',
      }),
      schemaVersion: '1' as const,
      kind: 'supersede' as const,
      subject: rec.id,
      successor: 'mem:elsewhere',
      actor: 'device-b',
      ts: NOW,
    };
    local.upsertEntries('decisions', [retract, supersede]);

    const r = runJson(['memory', 'conflicts']);
    expect(r.status).toBe(0);
    const groups = r.parsed.decisionConflicts as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ subject: rec.id, kind: 'retract-supersede' });
    expect(groups[0]!.decisionIds).toEqual([retract.id, supersede.id].sort());
  });

  it('resolve --successor appends the human decision (append-only; exit 2 on bad usage)', () => {
    const old = v1Record('loan_pkg threshold constant is 30');
    const replacement = v1Record('loan_pkg threshold constant is 31');
    localStore().upsertEntries('active', [old, replacement]);

    const r = runJson([
      'memory',
      'resolve',
      old.id,
      '--successor',
      replacement.id,
      '--actor',
      'vishal',
      '--reason',
      'constant raised',
    ]);
    expect(r.status).toBe(0);
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.id).toBe(old.id);
    expect(r.parsed.decisionSource).toBe('local');
    expect(String(r.parsed.decisionId)).toMatch(/^dec:/);

    // the resolution is an appended decision, readable through the ordinary surface.
    const after = runJson(['memory', 'get', old.id]);
    expect(after.parsed.supersededBy as unknown[]).toHaveLength(1);

    const bad = run([
      'memory',
      'resolve',
      old.id,
      '--successor',
      replacement.id,
      '--retract',
      '--actor',
      'vishal',
    ]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('usage: crib memory resolve');

    const noActor = run(['memory', 'resolve', old.id, '--successor', replacement.id]);
    expect(noActor.status).toBe(2);
  });

  it('resolve --retract appends a retract decision for a record', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]);

    const r = runJson(['memory', 'resolve', rec.id, '--retract', '--actor', 'vishal']);
    expect(r.status).toBe(0);
    expect(r.parsed.ok).toBe(true);
    expect(String(r.parsed.decisionId)).toMatch(/^dec:/);
    // a retract retires the record from recall (the lifecycle overlay, D9).
    const recall = runJson(['memory', 'recall', 'threshold']);
    expect(recall.parsed.memories as unknown[]).toHaveLength(0);
  });
});

describe('crib memory get — effective verdicts, not stamped ones (pulled-tombstone visibility)', () => {
  it('folds a local retract decision into the v1 get verdicts (lifecycle retracted)', () => {
    // Regression: the v1 branch surfaced the record's STAMPED verdicts, so a tombstone decision
    // synced from another device was invisible on `memory get` — the record read as active forever.
    const rec = v1Record('loan_pkg threshold constant is 30');
    const local = localStore();
    local.upsertEntries('active', [rec]);
    local.upsertEntries('decisions', [
      {
        id: decisionId({ kind: 'retract', subject: rec.id, actor: 'device-a' }),
        schemaVersion: '1' as const,
        kind: 'retract' as const,
        subject: rec.id,
        actor: 'device-a',
        ts: NOW,
      },
    ]);
    const r = runJson(['memory', 'get', rec.id, '--json']);
    expect(r.status).toBe(0);
    expect(r.parsed.verdicts).toEqual({
      trust: 'local',
      evidence: 'valid',
      applicability: 'current',
      lifecycle: 'retracted',
    });
  });

  it('keeps the classic no-decision read identical to the stamped verdicts', () => {
    const rec = v1Record('loan_pkg threshold constant is 30');
    localStore().upsertEntries('active', [rec]);
    const r = runJson(['memory', 'get', rec.id, '--json']);
    expect(r.status).toBe(0);
    expect(r.parsed.verdicts).toEqual(rec.verdicts);
  });
});
