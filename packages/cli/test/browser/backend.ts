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

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../../dist/cli.js');

// A fixed clock keeps the seeded records deterministic and sortable.
const T0 = '2026-01-01T00:00:00.000Z';

const SOURCE = [
  '/** Normalizes input before hashing. */',
  'export function normalizeInput(value: string): string {',
  '  return value.trim().toLowerCase();',
  '}',
  'export const value = 1;',
  '',
].join('\n');

const READY_CLAIM = 'normalizeInput trims and lowercases before hashing';
const TERMINAL_CLAIM = 'the resume view closes the detail after a recorded resume';
const BLOCKED_CLAIM = 'normalizeInput is pure';
const CAPTURE_CLAIM = 'normalizeInput lowercased the token before the lookup';

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

export class MemoryBackend {
  readonly repo: string;
  readonly home: string;
  readonly principal = 'principal:e2e';
  url = '';
  repoId = '';
  sym: SeededSymbol = { id: '', hash: '' };
  staged: SeededCandidates = { ready: '', terminal: '', blocked: '' };
  intakeId = '';
  private server: ReturnType<typeof spawn> | null = null;
  private readonly env: NodeJS.ProcessEnv;

  constructor() {
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
    const created = this.cli([
      'intake',
      'create',
      '--from',
      'Ship the browser admission and resume flows',
      '--outcome',
      'The memory home works end to end from a real browser',
      '--accept',
      'A new session sees the same next action',
      '--json',
    ]);
    this.intakeId = (JSON.parse(created.stdout) as { id: string }).id;
    this.cli([
      'intake',
      'checkpoint',
      this.intakeId,
      '--phase',
      'executing',
      '--next',
      'Re-run the browser suite against the real backend',
      '--summary',
      'Started the work',
      '--json',
    ]);

    // 8. The real viz server, headless (`--no-open`), on an ephemeral port.
    await this.startServer();
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
}

export const SEEDED = {
  readyClaim: READY_CLAIM,
  terminalClaim: TERMINAL_CLAIM,
  blockedClaim: BLOCKED_CLAIM,
  captureClaim: CAPTURE_CLAIM,
  t0: T0,
} as const;
