/**
 * WP5.1–WP5.4 — the supervisor/child split, asserted against REAL PROCESSES.
 *
 * None of these properties reproduce in a single-threaded in-process test: a supervisor whose
 * forked child outlives the lease TTL, a grandchild that must die with its supervisor (SIGKILL
 * races no timer), a takeover that replays a killed owner's task, and a frozen owner whose fenced
 * activation must fail after replacement (SIGSTOP, not a mock).
 *
 * What is pinned here (red lines):
 *   - WP5.1: the supervisor's loop is FREE while its child works — heartbeats continue through
 *     the run, the ordinary lease TTL is the only liveness contract, and a second worker is
 *     refused for the whole window. The end-to-end fork path (runner → child entry → IPC'd
 *     staged result → fenced activation) publishes the child's generation.
 *   - WP5.3: a child whose supervisor is SIGKILLed mid-run completes its work but STAGES
 *     NOTHING — it exits at the orphan check instead.
 *   - WP5.4: after a mid-run SIGKILL the successor takes over, recovers the leased task, and
 *     publishes — at-least-once revalidation, and the dead owner's result never lands.
 *   - WP5.2: a FROZEN owner (SIGSTOP) loses its lease to a successor while its child stages
 *     honestly; on resume the old epoch's fenced activation publishes NOTHING and the owner
 *     stands down.
 *
 * Children import the compiled `dist` build (`pretest` produces it); the revalidation port is a
 * fixture module so the child's real fork+orphan machinery runs against a deterministic port.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStagedResult } from './freshness-child.js';
import {
  FreshnessWorker,
  enqueueFreshness,
  freshnessTaskId,
  readFreshnessQueue,
  readPublishedGeneration,
  readWorkerState,
} from './freshness.js';
import { registerProject } from './registry.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_FRESHNESS = join(packageRoot, 'dist', 'freshness.js');
const DIST_CHILD = join(packageRoot, 'dist', 'freshness-child.js');

let dir: string;
let env: NodeJS.ProcessEnv;
let /** supervisors still alive at teardown */ live: ChildProcess[];

beforeEach(() => {
  expect(existsSync(DIST_FRESHNESS), `build ${DIST_FRESHNESS} before running this test`).toBe(true);
  dir = mkdtempSync(join(tmpdir(), 'crib-fresh-subproc-'));
  env = { KCRIB_REGISTRY_DIR: dir };
  live = [];
});
afterEach(async () => {
  for (const child of live) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function registeredRoot(name = '/synthetic/proj'): string {
  registerProject(name, { repoId: 'r1', cribDir: `${name}/.crib`, env });
  return name;
}

/** A deterministic revalidation port for the forked child: sleep, mark, return. */
function writeRevalidateFixture(spec: {
  sleepMs: number;
  generation: string;
  startMarker?: string;
  doneMarker?: string;
}): string {
  const file = join(dir, 'fixture-revalidate.mjs');
  writeFileSync(
    file,
    `
import { writeFileSync } from 'node:fs';
${spec.startMarker ? `const START = ${JSON.stringify(spec.startMarker)};` : ''}
${spec.doneMarker ? `const DONE = ${JSON.stringify(spec.doneMarker)};` : ''}
export async function freshnessRevalidate(task) {
  ${spec.startMarker ? "writeFileSync(START, 'started');" : ''}
  await new Promise((resolve) => setTimeout(resolve, ${spec.sleepMs}));
  ${spec.doneMarker ? "writeFileSync(DONE, 'done');" : ''}
  return { generation: ${JSON.stringify(spec.generation)}, actualHead: task.head };
}
`,
  );
  return file;
}

/**
 * Fork a REAL supervisor: a worker wired to the production forkTaskRunner, so revalidation runs
 * in a grandchild (the compiled child entry) and the supervisor's loop stays free. Events are
 * IPC'd home as they fire.
 */
function forkSupervisor(
  registry: string,
  fixtureUrl: string,
  opts: {
    heartbeatMs: number;
    leaseTtlMs: number;
  },
): { child: ChildProcess; ready: boolean; events: Array<{ kind: string; [k: string]: unknown }> } {
  const file = join(dir, 'supervisor.mjs');
  writeFileSync(
    file,
    `
import { FreshnessWorker } from ${JSON.stringify(pathToFileURL(DIST_FRESHNESS).href)};
import { forkTaskRunner } from ${JSON.stringify(pathToFileURL(DIST_CHILD).href)};
const [registry] = process.argv.slice(2);
const events = [];
const worker = new FreshnessWorker({
  env: { KCRIB_REGISTRY_DIR: registry },
  runTask: forkTaskRunner(),
  pollMs: 10,
  heartbeatMs: ${opts.heartbeatMs},
  leaseTtlMs: ${opts.leaseTtlMs},
  onEvent: (e) => { try { process.send({ event: e }); } catch {} },
});
process.send('ready');
process.on('message', async (m) => {
  if (m !== 'start') return;
  try {
    await worker.start();
    process.send({ started: true });
  } catch (error) {
    process.send({ outcome: 'refused:' + String(error && (error.name ?? error.message)) });
  }
});
setInterval(() => {}, 1 << 30);
`,
  );
  const child = fork(file, [registry], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      KCRIB_REGISTRY_DIR: registry,
      KCRIB_FRESHNESS_REVALIDATE_MODULE: fixtureUrl,
    },
  });
  live.push(child);
  const handle: {
    child: ChildProcess;
    ready: boolean;
    events: Array<{ kind: string; [k: string]: unknown }>;
  } = {
    child,
    ready: false,
    events: [],
  };
  child.on('message', (m: string | { event?: { kind: string } }) => {
    if (m === 'ready') handle.ready = true;
    else if (typeof m === 'object' && m?.event) {
      handle.events.push(m.event as { kind: string });
    }
  });
  return handle;
}

/** Wait until the supervisor reports 'started' (or fail on its refusal message). */
async function startSupervisor(s: {
  child: ChildProcess;
  ready: boolean;
  events: Array<{ kind: string }>;
}): Promise<void> {
  // 'ready' proves the child's message handler is live — a 'start' sent earlier could be missed
  await vi.waitFor(() => expect(s.ready).toBe(true));
  const outcome = new Promise<string>((resolve) => {
    const onMessage = (m: { started?: boolean; outcome?: string }) => {
      if (typeof m !== 'object' || (!m.started && !m.outcome)) return;
      s.child.off('message', onMessage);
      resolve(m.started ? 'started' : (m.outcome ?? 'unknown'));
    };
    s.child.on('message', onMessage);
  });
  s.child.send('start');
  expect(await outcome).toBe('started');
}

describe('freshness supervisor/child split — real processes', () => {
  it('WP5.1: heartbeats THROUGH child work — the lease outlives the run, a second worker is refused, and the forked result publishes', async () => {
    const root = registeredRoot();
    enqueueFreshness(root, 'long-run', env);
    const taskId = freshnessTaskId(root, 'long-run');
    // the child's run (800ms) far exceeds the lease TTL (300ms): before WP5, this supervisor was
    // invisible from TTL-onward (blocked loop, no heartbeat) and needed a 10-minute busy grace.
    const fixtureUrl = pathToFileURL(
      writeRevalidateFixture({ sleepMs: 800, generation: 'gen-from-forked-child' }),
    ).href;
    const s = forkSupervisor(dir, fixtureUrl, { heartbeatMs: 50, leaseTtlMs: 300 });
    await startSupervisor(s);

    // past the TTL, mid-run: the heartbeat is FRESH (the loop is free — the WP5.1 property)
    await vi.waitFor(() => expect(readWorkerState(env)?.activeTask?.id).toBe(taskId), {
      timeout: 5_000,
    });
    await new Promise((r) => setTimeout(r, 450));
    const state = readWorkerState(env)!;
    expect(Date.now() - Date.parse(state.heartbeatAt)).toBeLessThan(300);
    // ...so a second worker is refused for the whole window — no takeover, no duplicate run
    const second = new FreshnessWorker({
      env,
      revalidate: async () => ({ generation: 'gen-duplicate' }),
      pollMs: 10,
      heartbeatMs: 50,
    });
    await expect(second.start()).rejects.toThrow(/already running/i);

    // and the run completes end-to-end through the REAL fork path: child → IPC → activation
    await vi.waitFor(() => expect(s.events.some((e) => e.kind === 'task-done')).toBe(true), {
      timeout: 10_000,
    });
    expect(readPublishedGeneration(root, env)).toMatchObject({
      head: 'long-run',
      generation: 'gen-from-forked-child',
    });
    expect(readFreshnessQueue(env).pending).toHaveLength(0);
  }, 60_000);

  it('WP5.3: a SIGKILLed supervisor leaves its child orphaned — the child finishes its work but stages NOTHING', async () => {
    const root = registeredRoot();
    enqueueFreshness(root, 'orphan-run', env);
    const taskId = freshnessTaskId(root, 'orphan-run');
    const doneMarker = join(dir, 'child-work-done.marker');
    const fixtureUrl = pathToFileURL(
      writeRevalidateFixture({
        sleepMs: 700,
        generation: 'gen-from-orphan',
        doneMarker,
      }),
    ).href;
    const s = forkSupervisor(dir, fixtureUrl, { heartbeatMs: 50, leaseTtlMs: 300 });
    await startSupervisor(s);

    // kill the supervisor mid-run; reap it so the pid liveness probe sees it as dead
    await vi.waitFor(() => expect(readWorkerState(env)?.activeTask?.id).toBe(taskId), {
      timeout: 5_000,
    });
    await new Promise<void>((resolve) => {
      s.child.once('exit', () => resolve());
      s.child.kill('SIGKILL');
    });

    // the grandchild finishes its sleep (proving it reached the orphan check) and exits WITHOUT
    // staging: no staged file, no publication — a dead supervisor commissions nothing.
    await vi.waitFor(() => expect(existsSync(doneMarker)).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 400)); // let the child's exit land on disk state
    expect(readStagedResult(env, taskId)).toBeUndefined();
    expect(readPublishedGeneration(root, env)).toBeUndefined();
  }, 60_000);

  it('WP5.4: after a mid-run SIGKILL the successor replays the task and publishes — at-least-once, never lost', async () => {
    const root = registeredRoot();
    enqueueFreshness(root, 'replay-me', env);
    const doneMarker = join(dir, 'first-run-finished.marker');
    const fixtureUrl = pathToFileURL(
      writeRevalidateFixture({
        sleepMs: 700,
        generation: 'gen-from-dead-owner',
        doneMarker,
      }),
    ).href;
    const s = forkSupervisor(dir, fixtureUrl, { heartbeatMs: 50, leaseTtlMs: 300 });
    await startSupervisor(s);
    await vi.waitFor(
      () => expect(readWorkerState(env)?.activeTask?.id).toBe(freshnessTaskId(root, 'replay-me')),
      { timeout: 5_000 },
    );
    await new Promise<void>((resolve) => {
      s.child.once('exit', () => resolve());
      s.child.kill('SIGKILL');
    });

    // the dead pid's lease is taken over immediately (no TTL wait for a dead process): the
    // successor recovers the leased task and completes it. The first run's work is observable
    // (the marker) — at-least-once, not at-most-once — but its result never lands.
    const done: string[] = [];
    const successor = new FreshnessWorker({
      env,
      revalidate: async (task) => {
        done.push(task.projectRoot);
        return { generation: 'gen-recovered' };
      },
      pollMs: 10,
      heartbeatMs: 50,
    });
    await successor.start();
    try {
      await vi.waitFor(() => expect(done).toEqual([root]), { timeout: 10_000 });
      expect(readPublishedGeneration(root, env)).toMatchObject({
        generation: 'gen-recovered',
        head: 'replay-me',
      });
      expect(readFreshnessQueue(env).pending).toHaveLength(0);
      expect(readFreshnessQueue(env).dead).toHaveLength(0);
      // the killed owner's run DID its work — it just never got to stage or publish
      await vi.waitFor(() => expect(existsSync(doneMarker)).toBe(true), { timeout: 10_000 });
    } finally {
      await successor.stop();
    }
  }, 60_000);

  it('WP5.2: a FROZEN owner loses its lease — its late fenced activation publishes nothing and it stands down', async () => {
    const root = registeredRoot();
    enqueueFreshness(root, 'frozen-run', env);
    const fixtureUrl = pathToFileURL(
      writeRevalidateFixture({ sleepMs: 600, generation: 'gen-from-frozen-owner' }),
    ).href;
    const s = forkSupervisor(dir, fixtureUrl, { heartbeatMs: 50, leaseTtlMs: 300 });
    await startSupervisor(s);
    await vi.waitFor(
      () => expect(readWorkerState(env)?.activeTask?.id).toBe(freshnessTaskId(root, 'frozen-run')),
      { timeout: 5_000 },
    );

    // freeze the supervisor mid-run: timers stop, the heartbeat ages out, the CHILD keeps working
    process.kill(s.child.pid!, 'SIGSTOP');
    try {
      // the child runs to completion and stages honestly (its supervisor is ALIVE, just frozen)
      await vi.waitFor(
        () =>
          expect(readStagedResult(env, freshnessTaskId(root, 'frozen-run'))?.generation).toBe(
            'gen-from-frozen-owner',
          ),
        { timeout: 10_000 },
      );

      // the heartbeat ages past the TTL; a successor takes over the stalled owner and completes
      await new Promise((r) => setTimeout(r, 450));
      const done: string[] = [];
      const successor = new FreshnessWorker({
        env,
        revalidate: async (task) => {
          done.push(task.projectRoot);
          return { generation: 'gen-recovered' };
        },
        pollMs: 10,
        heartbeatMs: 50,
        leaseTtlMs: 300,
      });
      await successor.start();
      try {
        await vi.waitFor(() => expect(done).toEqual([root]), { timeout: 10_000 });
      } finally {
        await successor.stop();
      }

      // NOW the frozen owner resumes: its staged result arrives, but the epoch fence refuses the
      // activation — the successor's publication is what stands, and the old owner stands down.
      process.kill(s.child.pid!, 'SIGCONT');
      await vi.waitFor(() => expect(s.events.some((e) => e.kind === 'superseded')).toBe(true), {
        timeout: 10_000,
      });
      expect(s.events.some((e) => e.kind === 'task-done')).toBe(false);
      expect(readPublishedGeneration(root, env)).toMatchObject({ generation: 'gen-recovered' });
    } finally {
      // never leave a SIGSTOPped child alive for the teardown to SIGKILL in a stopped state
      if (s.child.exitCode === null && s.child.signalCode === null) {
        process.kill(s.child.pid!, 'SIGCONT');
      }
    }
  }, 60_000);
});
