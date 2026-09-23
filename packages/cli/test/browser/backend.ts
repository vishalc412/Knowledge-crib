// WP6 slice D — the real isolated backend the browser suite drives.
//
// Every prior layer was tested in-process; this fixture boots the REAL stack instead:
// a temp git repo, `crib index` building a real graph, a real memory policy, stores
// seeded through the real memory package, an intake recorded by the REAL CLI, and the
// REAL `crib viz` server spawned as a child process. The only test doubles are the
// temp directories themselves — nothing else is faked.
//
// Vocabulary law: nothing this fixture writes may match /\bcandidate\b/i or /\btrust\b/i
// in user-visible strings (server payloads are pinned banned-word-free by
// viz-server.test.ts); the in-repo identifier `candidates` is a store-collection name,
// not a shipped string, and never reaches the page.
//
// WP5 additions (T16–T20): `new MemoryBackend({ seed: false })` boots the same real stack with
// no memory records written at all, so the empty state is reachable without faking a payload;
// `seedExclusions()` writes a claim whose evidence has stopped grounding; `observe()` saves a
// claim through the REAL CLI so a change to the code on disk can be watched from the browser.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../../dist/cli.js');

// A fixed clock keeps the seeded records deterministic and sortable.
const T0 = '2026-01-01T00:00:00.000Z';

// The body line inside `normalizeInput` — the LIVE text a saved claim's quote has to ground
// against. Declared once and interpolated into SOURCE, so the file the fixture writes and the
// line a claim quotes cannot drift apart: `editSourceBodyLine` changes the file, and the quote
// recorded beforehand is what stops grounding.
const SOURCE_BODY_LINE = '  return value.trim().toLowerCase();';

const SOURCE = [
  '/** Normalizes input before hashing. */',
  'export function normalizeInput(value: string): string {',
  SOURCE_BODY_LINE,
  '}',
  'export const value = 1;',
  '',
].join('\n');

const READY_CLAIM = 'normalizeInput trims and lowercases before hashing';
const TERMINAL_CLAIM = 'the resume view closes the detail after a recorded resume';
const BLOCKED_CLAIM = 'normalizeInput is pure';
const CAPTURE_CLAIM = 'normalizeInput lowercased the token before the lookup';
const GRAPH_CURRENT_CLAIM = 'normalizeInput hashes the trimmed lowercase token';
const GRAPH_RETIRED_CLAIM = 'normalizeInput hashed the raw token';

// WP5 T18 — a claim whose quote no longer grounds AND whose recorded hash no longer matches the
// node it names. BOTH halves are load-bearing: a hash that only drifted evaluates `degraded`, and
// `degraded` evidence is still recall-ELIGIBLE, so the row would carry no exclusion to inspect at
// all. Drift + an ungroundable quote is what yields `invalid` / `needs-review` / `hash-drift`.
const DRIFTED_CLAIM = 'normalizeInput upper-cases the token before hashing';
const DRIFTED_QUOTE = '  return value.trim().toUpperCase();';
/** A well-formed blake3 digest (the pin is /^blake3:[0-9a-f]{64}$/), deliberately not this node's. */
const DRIFTED_TARGET_HASH = `blake3:${'0'.repeat(64)}`;

// WP5 T19 — the claim saved through the real CLI, quoting the fixture's live body line, and the
// rewrite that makes that quote stop grounding.
const OBSERVED_CLAIM = 'the lookup token is lower-cased before the hash is computed';
const EDITED_BODY_LINE = '  return value.trim();';

// The same gate policy shape memory-check.test.ts uses: a profile that runs
// `node --version` (deterministic, offline, exit 0) with an exit-code assertion.
const POLICY = {
  version: 1,
  trustedRef: 'refs/remotes/origin/HEAD',
  profiles: {
    'self-test': {
      name: 'self-test',
      executable: 'node',
      args: ['--version'],
      timeoutMs: 5000,
      permittedEnv: ['PATH'],
      successExitCodes: [0],
      assertions: [{ name: 'exit-ok', kind: 'exit-code', codes: [0] }],
    },
  },
};

export interface SeededSymbol {
  id: string;
  hash: string;
}

export interface SeededCandidates {
  ready: string;
  terminal: string;
  blocked: string;
}

/** What `start()` must do beyond booting the stack. */
export interface MemoryBackendOptions {
  /**
   * Write the memory records (policy, staged queue, intake, connected graph). `false` leaves the
   * repo indexed and the viz server running with NOTHING recorded — the only reachable shape of
   * "a repository with no memory in it" (see the T16 note in memory-home.browser.ts: the
   * `configured: false` branch is unreachable through `crib viz`, because the server refuses to
   * start on a repo without `.crib/crib.json`, which is the same file the memory API keys on).
   */
  seed?: boolean;
}

export class MemoryBackend {
  readonly repo: string;
  readonly home: string;
  readonly principal = 'principal:e2e';
  url = '';
  repoId = '';
  sym: SeededSymbol = { id: '', hash: '' };
  staged: SeededCandidates = { ready: '', terminal: '', blocked: '' };
  intakeId = '';
  graph = { current: '', retired: '' };
  /** WP5 T18 — the claim whose evidence stopped grounding (written by `seedExclusions`). */
  driftedId = '';
  /** WP5 T19 — the record id `observe()` had admitted for the claim it saved. */
  observedId = '';
  private readonly seed: boolean;
  private server: ReturnType<typeof spawn> | null = null;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: MemoryBackendOptions = {}) {
    this.seed = opts.seed !== false;
    this.repo = mkdtempSync(join(tmpdir(), 'crib-browser-repo-'));
    this.home = mkdtempSync(join(tmpdir(), 'crib-browser-home-'));
    this.env = {
      ...process.env,
      KCRIB_MEMORY_DIR: this.home,
      KCRIB_REGISTRY_DIR: this.home,
      KCRIB_PRINCIPAL_ID: this.principal,
    };
  }

  /** Runs the real CLI in the repo. Anything but exit 0 throws with the captured output. */
  private cli(
    args: string[],
    expectOk = true,
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: this.repo,
      env: this.env,
      encoding: 'utf8',
    });
    if (expectOk && result.status !== 0) {
      throw new Error(
        `crib ${args.join(' ')} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  private git(args: string[]): void {
    const result = spawnSync('git', args, { cwd: this.repo, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
    }
  }

  /** Reads the persisted graph JSONL and returns the normalizeInput symbol node. */
  private findSymbol(): SeededSymbol {
    const nodesDir = join(this.repo, '.crib', 'graph', 'extracted', 'nodes');
    for (const shard of readdirSync(nodesDir)) {
      const shardDir = join(nodesDir, shard);
      for (const file of readdirSync(shardDir)) {
        for (const line of readFileSync(join(shardDir, file), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const node = JSON.parse(line) as { id?: string; hash?: string; kind?: string };
          if (node.kind === 'symbol' && node.id && node.id.includes('normalizeInput')) {
            if (!node.hash) throw new Error(`symbol ${node.id} has no hash`);
            return { id: node.id, hash: node.hash };
          }
        }
      }
    }
    throw new Error('normalizeInput symbol not found in the extracted graph');
  }

  /**
   * Boots the whole stack. Order matters: the git repo must exist and be committed
   * (admission snapshots the repo head), the graph must exist (source-quote evidence
   * grounds against a real symbol), and the policy must exist before the stores are
   * seeded so the very first pending read classifies every row.
   *
   * Steps 1–4 and 8 always run. Steps 5–7b are the SEED — with `{ seed: false }` they are
   * skipped, leaving a real indexed repo with a real viz server and no memory records, which
   * is the only way the empty state can be reached through this stack (T16).
   */
  async start(): Promise<void> {
    // 1. A real git repo with one real source file.
    mkdirSync(join(this.repo, 'src'), { recursive: true });
    writeFileSync(join(this.repo, 'src', 'index.ts'), SOURCE);
    this.git(['init']);
    this.git(['config', 'user.email', 'e2e@example.invalid']);
    this.git(['config', 'user.name', 'crib e2e']);
    this.git(['add', '.']);
    this.git(['commit', '-m', 'seed the fixture repo']);

    // 2. The real index — writes .crib/crib.json (repo.id) and the extracted graph.
    this.cli(['index', this.repo]);

    // 3. The repo identity the memory stores key on.
    const cribJson = JSON.parse(readFileSync(join(this.repo, '.crib', 'crib.json'), 'utf8')) as {
      repo: { id: string };
    };
    this.repoId = cribJson.repo.id;

    // 4. The real symbol node the ready claim's source-quote evidence points at. The
    //    evaluator short-circuits on targetHash === node.hash, so this must be the
    //    graph's own hash — never a fabricated one.
    this.sym = this.findSymbol();

    if (this.seed) {
      // 5. A real gate policy so admission can actually run its profile.
      mkdirSync(join(this.repo, '.crib', 'memory'), { recursive: true });
      writeFileSync(
        join(this.repo, '.crib', 'memory', 'policy.json'),
        `${JSON.stringify(POLICY, null, 2)}\n`,
      );

      // 6. Seed the local memory store through the real memory package — the same
      //    stores the viz server opens, in the same home, keyed by the same repoId.
      await this.seedStores();

      // 7. A resumable intake recorded by the REAL CLI, checkpointed once.
      this.intakeId = this.newIntake({
        from: 'Ship the browser admission and resume flows',
        outcome: 'The memory home works end to end from a real browser',
        accept: 'A new session sees the same next action',
        next: 'Re-run the browser suite against the real backend',
      });

      // 7b. WP-G7 — a small connected graph over two admitted claims: the current claim replaces
      //     a retired one, touches code, and is linked from the saved work above.
      await this.seedGraph();

      // 7c. WP5 T18 — one admitted claim whose evidence has stopped grounding.
      await this.seedExclusions();
    }

    // 8. The real viz server, headless (`--no-open`), on an ephemeral port.
    await this.startServer();
  }

  /**
   * WP5 T19 — records a fresh intake through the REAL CLI and checkpoints it once, returning its
   * id. Extracted from `start()` (which used to inline both commands) so a test can start work of
   * its own to continue, without a second copy of the flag list drifting from this one.
   */
  newIntake(input: { from: string; outcome: string; accept: string; next: string }): string {
    const created = this.cli([
      'intake',
      'create',
      '--from',
      input.from,
      '--outcome',
      input.outcome,
      '--accept',
      input.accept,
      '--json',
    ]);
    const id = (JSON.parse(created.stdout) as { id: string }).id;
    this.cli([
      'intake',
      'checkpoint',
      id,
      '--phase',
      'executing',
      '--next',
      input.next,
      '--summary',
      'Started the work',
      '--json',
    ]);
    return id;
  }

  /**
   * WP5 T18 — an ADMITTED (active) claim whose evidence stops grounding from two directions at
   * once: a quote that is not in the file, and a recorded hash that is not the node's.
   *
   * Recorded as `active` rather than staged on purpose: the ledger gathers the `active`
   * collection, so a staged observation is not a ledger row at all and would test nothing.
   *
   * The STAMPED verdicts deliberately claim the opposite of what the evaluator now finds
   * (`evidence: 'valid'`). That is the state the surface exists to expose: the stamp is what a
   * cheap read reports, the fresh evaluation disagrees, and the ledger's group — which is
   * anchor-derived — does not move either way (§7.1's 2026-09-23 correction).
   */
  private async seedExclusions(): Promise<void> {
    const mem = (await import('@knowledge-crib/memory')) as {
      MemoryStore: { local: (repoId: string, opts: unknown) => MemoryStorePort };
      memoryRecordId: (input: unknown) => string;
    };
    const store = mem.MemoryStore.local(this.repoId, { env: this.env, now: () => T0 });
    if (this.sym.hash === DRIFTED_TARGET_HASH) {
      throw new Error('the drifted seed needs a hash that differs from the node it names');
    }
    const driftedSeed = {
      kind: 'fact',
      subject: this.sym.id,
      claim: DRIFTED_CLAIM,
      scope: { boundary: 'repo', repoId: this.repoId },
      appliesTo: [this.sym.id],
      evidence: [
        {
          kind: 'source-quote',
          verdict: 'valid',
          checkedAt: T0,
          soulId: this.sym.id,
          quote: DRIFTED_QUOTE,
          targetHash: DRIFTED_TARGET_HASH,
        },
      ],
      authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
    };
    this.driftedId = mem.memoryRecordId(driftedSeed);
    store.upsertEntries('active', [
      {
        id: this.driftedId,
        schemaVersion: '1',
        ...driftedSeed,
        verdicts: {
          trust: 'local',
          evidence: 'valid',
          applicability: 'current',
          lifecycle: 'active',
        },
        createdAt: T0,
      },
    ]);
  }

  /**
   * WP5 T19 — saves a claim the way an agent does: through the REAL CLI, with a source-quote the
   * admission gate itself verifies. Returns the id of the record it wrote.
   *
   * THROWS unless the CLI reports the record `active`. A staged observation never reaches the
   * ledger, so a test that accepted one would pass while asserting nothing at all — the failure
   * would look like a UI regression rather than a fixture mistake.
   */
  observe(claim: string, quote: string): string {
    // Written under .crib/, which is already untracked and never re-read after boot: the evidence
    // must not be a file that appears mid-test inside the working tree the page is describing.
    const evidencePath = join(this.repo, '.crib', 'e2e-evidence.json');
    writeFileSync(
      evidencePath,
      JSON.stringify([{ kind: 'source-quote', soulId: this.sym.id, quote }]),
    );
    const result = this.cli([
      'memory',
      'observe',
      '--kind',
      'fact',
      '--subject',
      this.sym.id,
      '--applies-to',
      this.sym.id,
      '--claim',
      claim,
      '--evidence',
      evidencePath,
      '--json',
    ]);
    const ack = parseAck(result.stdout);
    if (ack.ok !== true || ack.status !== 'active') {
      throw new Error(
        `crib memory observe did not admit the claim (status: ${String(ack.status)})\n${result.stdout}`,
      );
    }
    const id = ack.recordId ?? ack.id;
    if (!id) throw new Error(`crib memory observe returned no record id\n${result.stdout}`);
    this.observedId = id;
    return id;
  }

  /**
   * WP5 T19 — rewrites the body line on disk, so the quote a saved claim recorded stops grounding.
   *
   * No re-index is needed and none is done: the evaluator rehydrates the span from the FILE on
   * every read (`rehydrateBody` reads `join(repoRoot, node.file)` at request time), while anchor
   * correlation resolves against the persisted node list. The evidence therefore moves and the
   * ledger group does not — which is exactly the distinction §7.1's correction turns on.
   */
  editSourceBodyLine(to: string): void {
    const file = join(this.repo, 'src', 'index.ts');
    const text = readFileSync(file, 'utf8');
    if (!text.includes(SOURCE_BODY_LINE)) {
      throw new Error(`the fixture source no longer contains ${JSON.stringify(SOURCE_BODY_LINE)}`);
    }
    writeFileSync(file, text.replace(SOURCE_BODY_LINE, to));
  }

  private async seedStores(): Promise<void> {
    const mem = (await import('@knowledge-crib/memory')) as {
      MemoryStore: { local: (repoId: string, opts: unknown) => MemoryStorePort };
      memoryCandidateId: (seed: unknown) => string;
      buildCaptureOutboxEntry: (input: unknown, at: string) => unknown;
    };
    const store = mem.MemoryStore.local(this.repoId, { env: this.env, now: () => T0 });

    const scope = { boundary: 'repo', repoId: this.repoId };
    const authorship = { actor: 'claude-code', kind: 'agent', tool: 'claude-code' };

    // ready — a fact with browser-supported source-quote evidence that the evaluator
    // re-grounds valid via the hash short-circuit.
    const readySeed = {
      kind: 'fact',
      subject: this.sym.id,
      claim: READY_CLAIM,
      scope,
      appliesTo: [this.sym.id],
      evidence: [
        {
          kind: 'source-quote',
          verdict: 'valid',
          checkedAt: T0,
          soulId: this.sym.id,
          quote: 'Normalizes input before hashing.',
          targetHash: this.sym.hash,
        },
      ],
      authorship,
      origin: 'observe',
    };
    // terminal — a decision with an admissible but unstamped human attestation
    // (no tty:true): the row names `crib memory admit <id>`; the browser offers no button.
    const terminalSeed = {
      kind: 'decision',
      subject: this.sym.id,
      claim: TERMINAL_CLAIM,
      scope,
      appliesTo: [this.sym.id],
      evidence: [
        { kind: 'human-attestation', verdict: 'valid', checkedAt: T0, actor: 'human:operator' },
      ],
      authorship,
      origin: 'observe',
    };
    // blocked — no evidence at all: the row names `crib memory evaluate <id> --profile <name>`.
    const blockedSeed = {
      kind: 'fact',
      subject: this.sym.id,
      claim: BLOCKED_CLAIM,
      scope,
      appliesTo: [this.sym.id],
      evidence: [],
      authorship,
      origin: 'observe',
    };

    store.upsertEntries('candidates', [
      { ...readySeed, id: mem.memoryCandidateId(readySeed), schemaVersion: '1', proposedAt: T0 },
      {
        ...terminalSeed,
        id: mem.memoryCandidateId(terminalSeed),
        schemaVersion: '1',
        proposedAt: T0,
      },
      {
        ...blockedSeed,
        id: mem.memoryCandidateId(blockedSeed),
        schemaVersion: '1',
        proposedAt: T0,
      },
    ]);
    store.upsertEntry(
      'outbox',
      mem.buildCaptureOutboxEntry(
        {
          kind: 'fact',
          subject: this.sym.id,
          claim: CAPTURE_CLAIM,
          scope,
          appliesTo: [this.sym.id],
          evidence: [],
          authorship,
          origin: 'observe',
        },
        T0,
      ),
    );

    this.staged = {
      ready: mem.memoryCandidateId(readySeed),
      terminal: mem.memoryCandidateId(terminalSeed),
      blocked: mem.memoryCandidateId(blockedSeed),
    };
  }

  private async seedGraph(): Promise<void> {
    const mem = (await import('@knowledge-crib/memory')) as {
      MemoryStore: { local: (repoId: string, opts: unknown) => MemoryStorePort };
      memoryRecordId: (input: unknown) => string;
      decisionId: (input: unknown) => string;
      createGraphAssertion: (input: unknown) => { id: string };
    };
    const store = mem.MemoryStore.local(this.repoId, { env: this.env, now: () => T0 });
    const record = (claim: string) => {
      const input = {
        kind: 'fact',
        subject: this.sym.id,
        claim,
        scope: { boundary: 'repo', repoId: this.repoId },
        appliesTo: [this.sym.id],
        evidence: [
          {
            kind: 'source-quote',
            verdict: 'valid',
            checkedAt: T0,
            soulId: this.sym.id,
            quote: 'Normalizes input before hashing.',
            targetHash: this.sym.hash,
          },
        ],
        authorship: { actor: 'claude-code', kind: 'agent', tool: 'claude-code' },
      };
      return {
        id: mem.memoryRecordId(input),
        schemaVersion: '1',
        ...input,
        verdicts: {
          trust: 'local',
          evidence: 'valid',
          applicability: 'current',
          lifecycle: 'active',
        },
        createdAt: T0,
      };
    };
    const current = record(GRAPH_CURRENT_CLAIM);
    const retired = record(GRAPH_RETIRED_CLAIM);
    store.upsertEntries('active', [current, retired]);
    const supersede = {
      kind: 'supersede',
      subject: retired.id,
      successor: current.id,
      actor: 'human:operator',
    };
    store.upsertEntry('decisions', {
      id: mem.decisionId(supersede),
      schemaVersion: '1',
      ...supersede,
      ts: T0,
    });
    const edge = (predicate: string, subject: string, object: string, supporter: string) =>
      mem.createGraphAssertion({
        predicate,
        subject,
        object,
        namespace: { principalId: this.principal },
        scope: { boundary: 'repo', repoId: this.repoId },
        validAt: T0,
        knownAt: T0,
        supportedBy: [supporter],
        provenance: {
          principalId: this.principal,
          deviceId: 'device:e2e',
          actorId: 'agent:e2e',
          clientId: 'playwright',
        },
      });
    store.submitGraphEntries([
      edge('about', current.id, this.sym.id, current.id),
      edge('supersedes', current.id, retired.id, current.id),
      edge('about', this.intakeId, current.id, current.id),
      edge('applies-to', retired.id, 'sym:src/index.ts#legacyHash', retired.id),
    ]);
    this.graph = { current: current.id, retired: retired.id };
  }

  private startServer(): Promise<void> {
    return new Promise((resolveStart, rejectStart) => {
      const child = spawn(process.execPath, [CLI, 'viz', '--port', '0', '--no-open'], {
        cwd: this.repo,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.server = child;
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          rejectStart(new Error(`viz server did not announce its port in 30s\n${stderr}`));
        }
      }, 30_000);
      const onChunk = (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const match = stderr.match(/viz → http:\/\/127\.0\.0\.1:(\d+)\//);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          this.url = `http://127.0.0.1:${match[1]}`;
          // The banner means listen() succeeded; still wait for the first successful GET
          // so the very first page navigation cannot race the socket.
          void this.waitUntilServing().then(resolveStart, (err: Error) => {
            child.kill('SIGTERM');
            rejectStart(err);
          });
        }
      };
      child.stderr.on('data', onChunk);
      child.stdout.on('data', onChunk);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          rejectStart(new Error(`viz server exited early (code ${code})\n${stderr}`));
        }
      });
    });
  }

  private async waitUntilServing(): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(this.url);
        if (res.ok) return;
        lastError = new Error(`GET / answered ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((sleep) => setTimeout(sleep, 200));
    }
    throw new Error(`viz server never served a 200 on /: ${String(lastError)}`);
  }

  /**
   * Records a fresh checkpoint from OUTSIDE the browser — the "another session moved
   * the work" leg of the stale-resume test. Using the real CLI keeps the backend
   * honest: the browser's 409 is produced by the same store the CLI writes.
   */
  async concurrentCheckpoint(next: string): Promise<void> {
    this.cli([
      'intake',
      'checkpoint',
      this.intakeId,
      '--phase',
      'executing',
      '--next',
      next,
      '--summary',
      'Recorded by another session while the browser held an open form',
      '--json',
    ]);
  }

  /** GETs a server endpoint from node (GETs carry no Origin/CSRF requirements). */
  async getJson(path: string): Promise<unknown> {
    const res = await fetch(`${this.url}${path}`);
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return res.json();
  }

  async dispose(): Promise<void> {
    if (this.server) {
      const child = this.server;
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000).unref();
      });
    }
    rmSync(this.repo, { recursive: true, force: true });
    rmSync(this.home, { recursive: true, force: true });
  }
}

/** The slice of the memory package's store API the fixture relies on. */
interface MemoryStorePort {
  upsertEntry(collection: string, entry: unknown): void;
  upsertEntries(collection: string, entries: unknown[]): void;
  submitGraphEntries(entries: unknown[]): unknown;
}

/** The acknowledgement shape `crib … --json` writes to stdout. */
interface CliAck {
  ok?: boolean;
  id?: string;
  recordId?: string;
  status?: string;
}

/**
 * Read a `--json` acknowledgement out of a CLI run. Tolerant of any banner the CLI prints first
 * (the whole stdout is tried as JSON, then the outermost `{…}`), and loud when neither parses —
 * a fixture that silently read `undefined` out of a changed ack would mis-attribute a failure to
 * the UI.
 */
function parseAck(stdout: string): CliAck {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as CliAck;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as CliAck;
      } catch {
        /* fall through to the throw below */
      }
    }
    throw new Error(`could not parse a JSON acknowledgement from:\n${stdout}`);
  }
}

export const SEEDED_GRAPH = {
  currentClaim: GRAPH_CURRENT_CLAIM,
  retiredClaim: GRAPH_RETIRED_CLAIM,
} as const;

export const SEEDED = {
  readyClaim: READY_CLAIM,
  terminalClaim: TERMINAL_CLAIM,
  blockedClaim: BLOCKED_CLAIM,
  captureClaim: CAPTURE_CLAIM,
  /** WP5 T18 — the claim whose evidence has stopped grounding. */
  driftedClaim: DRIFTED_CLAIM,
  /** WP5 T18 — the evaluator reason (and its rendered sentence) that row must show. */
  driftedReason: 'hash-drift',
  driftedReasonText: 'the anchored code changed under the quote',
  /** WP5 T19 — the claim saved through the CLI, the line it quotes, and the rewrite to apply. */
  observedClaim: OBSERVED_CLAIM,
  sourceBodyLine: SOURCE_BODY_LINE,
  editedBodyLine: EDITED_BODY_LINE,
  observedReason: 'quote-not-found',
  observedReasonText: 'the quoted text was not found at the anchor',
  t0: T0,
} as const;
