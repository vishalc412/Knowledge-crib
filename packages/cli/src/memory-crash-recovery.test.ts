import { type ChildProcess, fork, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import {
  MemoryFtsIndex,
  type MemoryRecord,
  MemoryStore,
  __resetMemoryLockGuardForTest,
  gatherRecall,
  memoryRecordId,
  openMemoryFts,
} from '@knowledge-crib/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Crash recovery for the durable memory substrate — asserted across REAL PROCESS BOUNDARIES,
 * because none of the three failure modes reproduce in-process:
 *
 *   1. **Torn trailing line** — the intelligence journal is append-only JSONL; a process killed
 *      mid-append leaves half a line. The honest contract has two halves, both pinned here:
 *      a torn FINAL line without a newline is recovered (earlier history reads, the handoff keeps
 *      its prior-session coordinates, `degraded` stays empty), while a torn line that a LATER
 *      append completed (the real crash-then-successor sequence) is corruption — and then no
 *      process may exit as if there had been no prior work: `session bootstrap` reports the
 *      `lifecycle-journal-unreadable` degraded marker and `memory events` fails LOUDLY (exit 1).
 *   2. **Replay after a kill** — a forked appender commits a lifecycle event, acks over IPC, and
 *      is SIGKILLed while still alive (deterministic with respect to the append). The successor
 *      is the REAL CLI capture hook deriving the SAME idempotency key: the replay must dedupe to
 *      the dead process's event and write NOTHING — never double-persist.
 *   3. **Interrupted FTS rebuild** — the persistent snapshot is disposable and the shards are
 *      truth. A child SIGKILLed at any point of a rebuild must leave a state the successor opens
 *      greenly, and the successor's BM25 ranking must be identical to a clean rebuild (the
 *      oracle: an ephemeral `:memory:` index over the same gathered ledger).
 *
 * Children import the compiled `@knowledge-crib/memory` dist (the CLI subprocesses import the
 * compiled `dist/cli.js`); `pretest` produces both.
 *
 * Determinism law for the SIGKILL legs (the classic flake source): the kill in leg 2 lands only
 * AFTER the child's append is committed (the IPC ack proves it), and the leg-3 victim runs against
 * a garbage snapshot db with NO meta header — so every kill-landing point is contract-green: a kill
 * before `writeMeta` leaves no header (the successor rebuilds), a kill after it leaves a COMPLETE
 * snapshot (the successor serves). What can never happen is the racy middle: a partially-written db
 * under a still-valid header — see the notes on `rebuildFromStores` ordering in the sibling
 * persistent-fts suite; that window is deliberately NOT raced here.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_DIST = join(packageRoot, '..', 'memory', 'dist', 'index.js');

const NOW = '2026-01-01T00:00:00.000Z';
const PRINCIPAL = 'principal:crash-e2e';
const REPO_ID = 'r-crash-recovery';
const SESSION_ID = 'crash-e2e-session-0001';

/** The fixed FTS corpus + queries the ranking-identity oracle compares over. */
const FTS_CLAIMS: ReadonlyArray<readonly [claim: string, subject: string]> = [
  ['alpha retention gates the writer', 'sym:src/alpha.ts#a'],
  ['beta retention report', 'sym:src/beta.ts#b'],
  ['gamma deploy pipeline runs on friday', 'sym:src/gamma.ts#g'],
];
const FTS_QUERIES = ['retention', 'deploy', 'friday'] as const;

let scratch: string;
let /** children still alive at teardown */ live: ChildProcess[];
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  expect(existsSync(CLI), `build ${CLI} before running this test`).toBe(true);
  expect(existsSync(MEMORY_DIST), `build ${MEMORY_DIST} before running this test`).toBe(true);
  __resetMemoryLockGuardForTest();
  scratch = tempDir('crib-crash-recovery-');
  live = [];
});

afterEach(async () => {
  for (const child of live) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }
  __resetMemoryLockGuardForTest();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─── the repo fixture + CLI subprocess surface (the memory-sync harness shape) ──────────

/** A light indexed repo: committed soul + crib.json repo.id — enough for the memory/session
 *  verbs (the capture-hook e2e suite uses this shape; no full indexRepo pass is needed). */
function makeRepo(): string {
  const repo = tempDir('crib-crash-repo-');
  const cribDir = join(repo, '.crib');
  const soul = new SoulStore(cribDir, { manifest: newManifest({ root: '.' }) });
  soul.load();
  soul.commit(NOW);
  writeFileSync(
    join(cribDir, 'crib.json'),
    `${JSON.stringify({ repo: { id: REPO_ID, root: '.' } }, null, 2)}\n`,
  );
  return repo;
}

/** A device env: the memory home + registry relocated into a temp dir, and the caller principal
 *  pinned so the seeded journal events and the handoff's principal filter agree. */
function deviceEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KCRIB_MEMORY_DIR: home,
    KCRIB_REGISTRY_DIR: home,
    KCRIB_PRINCIPAL_ID: PRINCIPAL,
  };
}

/** Run the BUILT CLI as a subprocess from `cwdDir` with `homeDir`'s memory env. `input` drives
 *  the real hook stdin wire (the capture hook reads JSON from fd 0). */
function run(
  args: string[],
  home: string,
  cwdDir: string,
  input?: string,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwdDir,
    encoding: 'utf8',
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : undefined,
    input,
    maxBuffer: 32 * 1024 * 1024,
    env: deviceEnv(home),
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

function runJson(
  args: string[],
  home: string,
  cwdDir: string,
): { status: number; parsed: Record<string, unknown>; stdout: string; stderr: string } {
  const r = run([...args, '--json'], home, cwdDir);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    // leave parsed empty — the per-test assertions on parsed fields will fail with context
  }
  return { status: r.status, parsed, stdout: r.stdout, stderr: r.stderr };
}

// ─── the intelligence journal fixture (pre-torn files, no timing) ───────────────────────

function journalPath(repo: string): string {
  return join(repo, '.crib', 'intelligence', 'intelligence-events.jsonl');
}

/** One complete, valid `agent.lifecycle` line carrying the resume record (a repository anchor) —
 *  the shape the capture hook appends, hand-written so the file can be pre-torn deterministically.
 *  `pinned: true` keeps the seeded events readable against the real clock. */
function seedEvent(opts: { id: string; key: string; sessionId: string; occurredAt: string }): {
  id: string;
  schemaVersion: '1';
  kind: 'agent.lifecycle';
  idempotencyKey: string;
  source: { clientId: string; sessionId: string };
  identity: { principalId: string };
  payload: Record<string, unknown>;
  evidenceRefs: string[];
  retention: { expiresAfterDays: number; pinned: boolean };
  occurredAt: string;
  recordedAt: string;
} {
  return {
    id: opts.id,
    schemaVersion: '1',
    kind: 'agent.lifecycle',
    idempotencyKey: opts.key,
    source: { clientId: 'claude-code-hook', sessionId: opts.sessionId },
    identity: { principalId: PRINCIPAL },
    payload: {
      event: 'turn-end',
      repository: { branch: 'debug/crash', head: 'cafebabe', changedPaths: ['src/index.ts'] },
    },
    evidenceRefs: [],
    retention: { expiresAfterDays: 30, pinned: true },
    occurredAt: opts.occurredAt,
    recordedAt: opts.occurredAt,
  };
}

function journalEvents() {
  return [
    seedEvent({
      id: 'iev:crash-a',
      key: 'hook:turn-end:crash-sess-a:nooffset',
      sessionId: 'crash-sess-a',
      occurredAt: '2026-01-01T00:00:01.000Z',
    }),
    seedEvent({
      id: 'iev:crash-b',
      key: 'hook:turn-end:crash-sess-b:nooffset',
      sessionId: 'crash-sess-b',
      occurredAt: '2026-01-01T00:00:02.000Z',
    }),
  ];
}

/** Seed the journal: complete lines, optionally followed by a torn half line with NO trailing
 *  newline — the exact on-disk shape a process killed mid-append leaves behind. */
function seedJournal(repo: string, events: ReturnType<typeof journalEvents>, tornTail?: string) {
  mkdirSync(dirname(journalPath(repo)), { recursive: true });
  writeFileSync(
    journalPath(repo),
    `${events.map((e) => `${JSON.stringify(e)}\n`).join('')}${tornTail ?? ''}`,
  );
}

/** Half of a valid event line, cut mid-JSON with no trailing newline. */
function tornTail(): string {
  const whole = JSON.stringify(
    seedEvent({
      id: 'iev:crash-torn',
      key: 'hook:turn-end:crash-sess-torn:nooffset',
      sessionId: 'crash-sess-torn',
      occurredAt: '2026-01-01T00:00:03.000Z',
    }),
  );
  return whole.slice(0, Math.max(1, Math.floor(whole.length / 2)));
}

// ─── the forked-children surface (the freshness-subprocess harness shape) ─────────────────

interface ChildHandle {
  child: ChildProcess;
  messages: unknown[];
}

/** Fork a `.mjs` fixture that imports the compiled memory dist; IPC messages are collected. */
function forkFixture(file: string, args: string[], env: NodeJS.ProcessEnv): ChildHandle {
  const child = fork(file, args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env });
  live.push(child);
  const handle: ChildHandle = { child, messages: [] };
  child.on('message', (m: unknown) => handle.messages.push(m));
  return handle;
}

/** Wait for the first IPC message matching `match` (fails with the child's exit if it dies first). */
async function waitMsg(handle: ChildHandle, match: (m: unknown) => boolean): Promise<unknown> {
  await vi.waitFor(
    () => {
      const dead = handle.child.exitCode !== null || handle.child.signalCode !== null;
      expect(
        dead ? 'the child exited before the expected message' : handle.messages.find(match),
      ).toBeTruthy();
    },
    { timeout: 15_000 },
  );
  return handle.messages.find(match);
}

/** SIGKILL a child and reap it, so no teardown or successor races a live pid. */
async function killAndReap(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }
}

// ─── the FTS corpus + the ranking-identity oracle (the persistent-fts harness shape) ──────

/** A recall-eligible memory-1 record (admissible fact → grounded source-quote). */
function v1Record(claim: string, subject: string): MemoryRecord {
  const input = {
    kind: 'fact' as const,
    subject,
    claim,
    scope: { boundary: 'repo' as const, repoId: REPO_ID },
    appliesTo: [subject],
    evidence: [
      {
        kind: 'source-quote' as const,
        verdict: 'valid' as const,
        checkedAt: NOW,
        soulId: subject,
        quote: 'does the thing',
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

/** The local store with the fixed corpus committed — the shards the FTS snapshot serves. */
function seedFtsCorpus(home: string): MemoryStore {
  const store = MemoryStore.local(REPO_ID, { env: deviceEnv(home), now: () => NOW });
  for (const [claim, subject] of FTS_CLAIMS) store.upsertEntry('active', v1Record(claim, subject));
  return store;
}

/** Deterministic byte-comparable score projection: sorted [id, score] pairs, exact float text. */
function scoresOf(index: MemoryFtsIndex, query: string): string {
  return JSON.stringify([...index.search(query).entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** The equivalence oracle: an ephemeral full rebuild over the same gathered ledger. */
function oracleScores(store: MemoryStore, query: string): string {
  const ephemeral = new MemoryFtsIndex(':memory:');
  try {
    ephemeral.rebuild(gatherRecall({ local: store }).records.map((r) => r.record));
    return scoresOf(ephemeral, query);
  } finally {
    ephemeral.close();
  }
}

/** The FTS child fixture. `rebuild` signals 'starting' right before priming a snapshot that does
 *  not exist yet; `block` waits for a 'go' it never receives (a kill guaranteed to land before
 *  the child touches the snapshot); `serve` is the successor: open, report scores + rebuild
 *  count, then reopen and report the convergence rebuild count. */
function writeFtsFixture(): string {
  const file = join(scratch, 'fts-child.mjs');
  writeFileSync(
    file,
    `
import { MemoryStore, openMemoryFts } from ${JSON.stringify(pathToFileURL(MEMORY_DIST).href)};
const repoId = process.argv[2];
const home = process.argv[3];
const mode = process.argv[4];
const QUERIES = ${JSON.stringify([...FTS_QUERIES])};
const store = MemoryStore.local(repoId, { env: { KCRIB_MEMORY_DIR: home, KCRIB_REGISTRY_DIR: home } });
const scoresOf = (fts) => {
  const out = {};
  for (const q of QUERIES) {
    out[q] = JSON.stringify(Array.from(fts.search(q).entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }
  return out;
};
process.send('ready');
process.on('message', (m) => {
  if (m !== 'start' || mode === 'block') return;
  const fts = openMemoryFts({ local: store });
  if (mode === 'rebuild') process.send('starting');
  fts.search('zzprobezz');
  const first = { rebuildCount: fts.rebuildCountForTest, scores: scoresOf(fts) };
  fts.close();
  const second = openMemoryFts({ local: store });
  second.search('zzprobezz');
  const converge = { rebuildCount: second.rebuildCountForTest };
  second.close();
  process.send({ done: true, first, converge });
});
setInterval(() => {}, 1 << 30);
`,
  );
  return file;
}

interface FtsReport {
  first: { rebuildCount: number; scores: Record<string, string> };
  converge: { rebuildCount: number };
}

function isFtsReport(m: unknown): m is FtsReport {
  return typeof m === 'object' && m !== null && 'first' in m && 'converge' in m;
}

// ─── leg 1: the torn trailing line ────────────────────────────────────────────────────────

describe('crib crash recovery — the torn intelligence journal, across real processes', () => {
  it('a torn final line recovers: earlier history reads and the handoff keeps its coordinates — undegraded', () => {
    const repo = makeRepo();
    const home = tempDir('crib-crash-home-');
    seedJournal(repo, journalEvents(), tornTail());

    // The events lane reads the two committed events and silently drops the torn tail — an
    // interrupted append loses only the event that never committed.
    const events = runJson(['memory', 'events', '--include-expired'], home, repo);
    expect(events.status).toBe(0);
    expect(events.parsed.total).toBe(2);
    expect((events.parsed.events as Array<{ id: string }>).map((e) => e.id)).toEqual([
      'iev:crash-b',
      'iev:crash-a',
    ]);

    // The handoff sees the newest anchor: the recoverable tear is NOT a degraded state, and the
    // prior session's coordinates survive the crash that cut the last line.
    const bootstrap = runJson(['session', 'bootstrap'], home, repo);
    expect(bootstrap.status).toBe(0);
    expect(bootstrap.parsed.degraded).toEqual([]);
    expect(bootstrap.parsed.lastSession).toMatchObject({
      sessionId: 'crash-sess-b',
      branch: 'debug/crash',
      head: 'cafebabe',
      changedPaths: ['src/index.ts'],
    });
  }, 60_000);

  it('a torn line completed by the successor append is corruption — degraded honestly, never "no prior work"', () => {
    const repo = makeRepo();
    const home = tempDir('crib-crash-home-');
    seedJournal(repo, journalEvents(), tornTail());

    // The real crash-then-successor sequence: the capture hook's append lands DIRECTLY after the
    // torn half (appendFileSync concatenates), so the torn line acquires its newline mid-JSON —
    // the recoverable tear becomes real, unrecoverable corruption.
    const hook = run(
      ['memory', 'capture-hook', '--event', 'turn-end'],
      home,
      repo,
      JSON.stringify({ session_id: 'crash-sess-c' }),
    );
    expect(hook.status).toBe(0);
    const ack = JSON.parse(hook.stdout.split('\n').at(-1) ?? '') as Record<string, unknown>;
    expect(ack).toMatchObject({ ok: true, status: 'checkpoint-requested', captured: false });

    // The handoff surfaces the unreadable journal through `degraded` (WP3.8) — and the empty-state
    // line is suppressed, so an operator is never told there was no prior work.
    const text = run(['session', 'bootstrap'], home, repo);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(
      '! DEGRADED — the lifecycle journal exists but could not be read',
    );
    expect(text.stdout).toContain('coordinates may be missing for that reason');
    expect(text.stdout).not.toContain('nothing in flight, nothing stale');

    const bootstrap = runJson(['session', 'bootstrap'], home, repo);
    expect(bootstrap.status).toBe(0);
    expect(bootstrap.parsed.degraded).toEqual(['lifecycle-journal-unreadable']);

    // The events lane fails LOUDLY — exit 1 naming the corrupted line, never a silent empty read.
    const events = runJson(['memory', 'events', '--include-expired'], home, repo);
    expect(events.status).toBe(1);
    expect(events.stderr).toContain('invalid intelligence event');
  }, 60_000);
});

// ─── leg 2: replay after a SIGKILL ────────────────────────────────────────────────────────

describe('crib crash recovery — idempotent replay across a killed appender', () => {
  it("a killed appender's event is never double-persisted — the successor replays the SAME key as a no-op", async () => {
    const repo = makeRepo();
    const home = tempDir('crib-crash-home-');
    const file = join(scratch, 'journal-appender.mjs');
    writeFileSync(
      file,
      `
import { IntelligenceEventJournal } from ${JSON.stringify(pathToFileURL(MEMORY_DIST).href)};
const journalRoot = process.argv[2];
const key = process.argv[3];
const principal = process.argv[4];
const sessionId = process.argv[5];
const journal = new IntelligenceEventJournal({ rootDir: journalRoot });
const appended = journal.append({
  kind: 'agent.lifecycle',
  idempotencyKey: key,
  source: { clientId: 'claude-code-hook', sessionId: sessionId },
  identity: { principalId: principal },
  payload: { event: 'session-start', repository: { branch: 'debug/crash', head: 'cafebabe' } },
  occurredAt: ${JSON.stringify(NOW)},
});
process.send({ appended: true, id: appended.event.id, duplicate: appended.duplicate });
setInterval(() => {}, 1 << 30);
`,
    );

    // Child 1: a REAL process appends the event and acks over IPC — the ack proves the line
    // committed before the SIGKILL can land (the kill is deterministic with respect to the append).
    const appender = forkFixture(
      file,
      [
        join(repo, '.crib', 'intelligence'),
        `hook:session-start:${SESSION_ID}:nooffset`,
        PRINCIPAL,
        SESSION_ID,
      ],
      deviceEnv(home),
    );
    const acked = (await waitMsg(
      appender,
      (m): m is { appended: boolean; id: string; duplicate: boolean } =>
        typeof m === 'object' && m !== null && 'appended' in m,
    )) as { appended: boolean; id: string; duplicate: boolean };
    expect(acked.appended).toBe(true);
    expect(acked.duplicate).toBe(false);
    const before = readFileSync(journalPath(repo), 'utf8');
    await killAndReap(appender.child);

    // The successor: the REAL CLI hook derives the SAME idempotency key
    // (`hook:session-start:<sid>:nooffset`) and replays it — the dedupe must return the dead
    // process's event, not a second line.
    const hook = run(
      ['memory', 'capture-hook', '--event', 'session-start'],
      home,
      repo,
      JSON.stringify({ session_id: SESSION_ID }),
    );
    expect(hook.status).toBe(0);
    const ack = JSON.parse(hook.stdout.split('\n').at(-1) ?? '') as Record<string, unknown>;
    expect(ack).toMatchObject({ ok: true, status: 'checkpoint-requested', captured: false });
    expect(ack.eventId).toBe(acked.id);

    // Never double-persisted: the journal file is byte-identical, and the events lane counts ONE.
    expect(readFileSync(journalPath(repo), 'utf8')).toBe(before);
    const events = runJson(['memory', 'events', '--include-expired'], home, repo);
    expect(events.status).toBe(0);
    expect(events.parsed.total).toBe(1);
  }, 60_000);
});

// ─── leg 3: the interrupted FTS snapshot rebuild ──────────────────────────────────────────

describe('crib crash recovery — a SIGKILLed FTS rebuild converges to the clean-rebuild ranking', () => {
  it('a child killed mid-rebuild leaves a state the successor opens greenly, with BM25 identical to a clean rebuild', async () => {
    const home = tempDir('crib-crash-fts-home-');
    const store = seedFtsCorpus(home);
    // A garbage snapshot db with NO meta header: whichever side of the rebuild the SIGKILL lands
    // on, the successor either rebuilds (no header) or serves a COMPLETE snapshot (header written
    // only after the rows) — every landing point is contract-green.
    const ftsDir = join(home, 'repos', REPO_ID, 'fts');
    mkdirSync(ftsDir, { recursive: true });
    writeFileSync(join(ftsDir, 'memory-fts.sqlite'), 'this is not a sqlite database');

    const fixture = writeFtsFixture();
    const victim = forkFixture(fixture, [REPO_ID, home, 'rebuild'], {
      ...process.env,
      KCRIB_MEMORY_DIR: home,
      KCRIB_REGISTRY_DIR: home,
    });
    await waitMsg(victim, (m) => m === 'ready');
    victim.child.send('start');
    await waitMsg(victim, (m) => m === 'starting'); // the rebuild is in flight — kill here
    await killAndReap(victim.child);

    // The successor: whatever the kill left, its first open is green and its ranking matches the
    // clean-rebuild oracle for every query, and it CONVERGED (a second open rebuilds nothing).
    const successor = forkFixture(fixture, [REPO_ID, home, 'serve'], {
      ...process.env,
      KCRIB_MEMORY_DIR: home,
      KCRIB_REGISTRY_DIR: home,
    });
    await waitMsg(successor, (m) => m === 'ready');
    successor.child.send('start');
    const done = (await waitMsg(successor, isFtsReport)) as FtsReport;
    for (const query of FTS_QUERIES) {
      expect(done.first.scores[query]).toBe(oracleScores(store, query));
    }
    expect(done.first.rebuildCount).toBeLessThanOrEqual(1); // served or rebuilt — never a loop
    expect(done.converge.rebuildCount).toBe(0);
  }, 60_000);

  it('a corrupt snapshot db under a still-valid meta header heals deterministically after a killed first opener', async () => {
    const home = tempDir('crib-crash-fts-home-');
    const store = seedFtsCorpus(home);
    // A COMPLETE snapshot (rows + header), then only the db file corrupted — the state a torn db
    // write leaves under a header that already matches.
    const fts = openMemoryFts({ local: store });
    fts.search('zzprobezz');
    expect(fts.rebuildCountForTest).toBe(1);
    const dbPath = fts.indexFilePath;
    fts.close();
    writeFileSync(dbPath, 'this is not a sqlite database');

    // The victim is SIGKILLed while blocked BEFORE it touches the snapshot — deterministic: the
    // successor is handed exactly the corrupt-db-valid-header state.
    const fixture = writeFtsFixture();
    const victim = forkFixture(fixture, [REPO_ID, home, 'block'], {
      ...process.env,
      KCRIB_MEMORY_DIR: home,
      KCRIB_REGISTRY_DIR: home,
    });
    await waitMsg(victim, (m) => m === 'ready');
    await killAndReap(victim.child);

    // The successor heals: the open fails on the corrupt file, deletes it, rebuilds from the
    // shards — ONE rebuild, ranking-identical to a clean rebuild, and converged on reopen.
    const successor = forkFixture(fixture, [REPO_ID, home, 'serve'], {
      ...process.env,
      KCRIB_MEMORY_DIR: home,
      KCRIB_REGISTRY_DIR: home,
    });
    await waitMsg(successor, (m) => m === 'ready');
    successor.child.send('start');
    const done = (await waitMsg(successor, isFtsReport)) as FtsReport;
    expect(done.first.rebuildCount).toBe(1);
    for (const query of FTS_QUERIES) {
      expect(done.first.scores[query]).toBe(oracleScores(store, query));
    }
    expect(done.converge.rebuildCount).toBe(0);
  }, 60_000);
});
