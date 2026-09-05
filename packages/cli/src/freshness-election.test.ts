/**
 * R01 (docs/audits/2026-09-05/post-merge-reaudit.md) — the freshness lease must have ONE owner,
 * and no acknowledged refresh task may vanish when its owner is killed.
 *
 * The audit started 8 real worker processes twelve times and watched 5-8 of them per trial believe
 * they owned a single-owner service: `start()` read the lease, checked liveness, and wrote its own
 * state with no lock spanning the decision. A companion crash probe then acknowledged 8 tasks, let
 * 8 workers claim them, killed the workers, and recovered exactly ONE — the other seven were absent
 * from both the recovery state and the pending queue, because every claimant had overwritten the
 * same `activeTask` field.
 *
 * Both halves are asserted here against real processes, because neither defect reproduces in a
 * single-threaded in-process test: the election race needs genuine concurrent starts, and the lost
 * work needs a real SIGKILL. The third test covers the case a lock alone cannot fix — an owner that
 * stalls past its lease, is replaced, and then wakes up and tries to write.
 *
 * Children import the compiled `dist` build (`pretest` produces it).
 */
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FreshnessTask,
  FreshnessWorker,
  type FreshnessWorkerEvent,
  enqueueFreshness,
  freshnessTaskId,
  readFreshnessQueue,
  readWorkerState,
} from './freshness.js';

const CONTENDERS = 8;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(packageRoot, 'dist', 'freshness.js');

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-freshness-elect-'));
  env = { KCRIB_REGISTRY_DIR: dir };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One contender: start a worker whose revalidation never resolves, so a won lease keeps its task
 * leased in `activeTask` exactly as a mid-refresh kill would leave it. Reports the outcome, then
 * stays alive to be killed by the parent.
 */
function contenderSource(): string {
  return `
import { FreshnessWorker } from ${JSON.stringify(pathToFileURL(distEntry).href)};
const [registry] = process.argv.slice(2);
const worker = new FreshnessWorker({
  env: { KCRIB_REGISTRY_DIR: registry },
  revalidate: () => new Promise(() => {}),
  pollMs: 10,
  heartbeatMs: 50,
});
process.send('ready');
process.on('message', async () => {
  try {
    await worker.start();
    process.send({ outcome: 'won', pid: process.pid });
  } catch (error) {
    process.send({ outcome: String(error && error.name) === 'WorkerAlreadyRunningError'
      ? 'refused'
      : 'error:' + String(error && error.message) });
  }
});
setInterval(() => {}, 1 << 30);
`;
}

interface Outcome {
  outcome: string;
  pid?: number;
}

/** Fork `CONTENDERS` workers against one registry, release them together, collect their outcomes. */
async function raceContenders(registry: string): Promise<{
  outcomes: Outcome[];
  kill: () => Promise<void>;
}> {
  const file = join(dir, 'contender.mjs');
  writeFileSync(file, contenderSource());
  const children = Array.from({ length: CONTENDERS }, () =>
    fork(file, [registry], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  );
  // SIGKILL then AWAIT the exit: a killed child stays a zombie until its parent reaps it, and a
  // zombie still answers the `kill(pid, 0)` liveness probe. Reaping here makes the test assert
  // takeover-from-a-dead-pid rather than takeover-after-the-lease-TTL.
  const kill = async () => {
    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((resolve) => {
            if (c.exitCode !== null || c.signalCode !== null) return resolve();
            c.once('exit', () => resolve());
            c.kill('SIGKILL');
          }),
      ),
    );
  };
  try {
    await Promise.all(
      children.map((c) => new Promise<void>((resolve) => c.once('message', () => resolve()))),
    );
    const settled = children.map(
      (c) => new Promise<Outcome>((resolve) => c.once('message', (m) => resolve(m as Outcome))),
    );
    // Release every contender only once all are listening, so the elections genuinely overlap.
    for (const c of children) c.send('go');
    return { outcomes: await Promise.all(settled), kill };
  } catch (error) {
    await kill();
    throw error;
  }
}

describe('freshness lease election (R01)', () => {
  it('admits EXACTLY ONE owner when 8 workers start concurrently', async () => {
    expect(existsSync(distEntry), `build ${distEntry} before running this test`).toBe(true);
    const { outcomes, kill } = await raceContenders(dir);
    try {
      const won = outcomes.filter((o) => o.outcome === 'won');
      const refused = outcomes.filter((o) => o.outcome === 'refused');
      // The pre-repair behaviour was 5-8 winners here. Anything but exactly one is the defect.
      expect(won).toHaveLength(1);
      expect(refused).toHaveLength(CONTENDERS - 1);
      // The lease on disk names the single winner.
      expect(readWorkerState(env)?.pid).toBe(won[0]!.pid);
    } finally {
      await kill();
    }
  }, 60_000);

  it('loses NO acknowledged task when every worker process is killed mid-refresh', async () => {
    expect(existsSync(distEntry), `build ${distEntry} before running this test`).toBe(true);
    const roots = Array.from({ length: CONTENDERS }, (_, i) => `/synthetic/project-${i}`);
    const acknowledged = roots.map((root) => {
      enqueueFreshness(root, `head-${root}`, env);
      return freshnessTaskId(root, `head-${root}`);
    });
    expect(readFreshnessQueue(env).pending).toHaveLength(CONTENDERS);

    const { outcomes, kill } = await raceContenders(dir);
    expect(outcomes.filter((o) => o.outcome === 'won')).toHaveLength(1);
    // Let the winner lease a task, then SIGKILL every contender: no clean shutdown, no lease
    // release — precisely the state the audit's crash probe produced.
    await vi.waitFor(() => expect(readWorkerState(env)?.activeTask).toBeDefined(), {
      timeout: 5_000,
    });
    await kill();

    // Every acknowledged task must still be REACHABLE: pending, dead-lettered, or leased in the
    // dead owner's state (which the next election recovers). The audit found 7 of 8 in none of them.
    const reachable = () => {
      const q = readFreshnessQueue(env);
      const active = readWorkerState(env)?.activeTask;
      return new Set<string>([
        ...q.pending.map((t) => t.id),
        ...q.dead.map((t) => t.id),
        ...(active ? [active.id] : []),
      ]);
    };
    const missing = acknowledged.filter((id) => !reachable().has(id));
    expect(missing).toEqual([]);

    // And recovery actually drains them: a fresh worker takes over the dead pid's lease, recovers
    // the orphan, and completes all eight.
    const done: string[] = [];
    const recovery = new FreshnessWorker({
      env,
      revalidate: async (task: FreshnessTask) => {
        done.push(task.projectRoot);
        return { generation: `gen-${task.head}` };
      },
      pollMs: 10,
      heartbeatMs: 50,
    });
    await recovery.start();
    try {
      await vi.waitFor(() => expect(new Set(done).size).toBe(CONTENDERS), { timeout: 20_000 });
      expect(readFreshnessQueue(env).pending).toHaveLength(0);
      expect(readFreshnessQueue(env).dead).toHaveLength(0);
    } finally {
      await recovery.stop();
    }
  }, 90_000);

  it('FENCES a stalled owner: after replacement it refuses to write and stands down', async () => {
    const root = '/synthetic/fenced';
    enqueueFreshness(root, 'head-a', env);
    const events: FreshnessWorkerEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const stalled = new FreshnessWorker({
      env,
      // Hangs mid-revalidation: the worker is elected and leased, then effectively frozen — the
      // stall a lock cannot prevent, because the lock was already released.
      revalidate: async () => {
        await gate;
        return { generation: 'from-the-stalled-owner' };
      },
      pollMs: 10,
      heartbeatMs: 10_000, // no heartbeat during the window under test
      onEvent: (e) => events.push(e),
    });
    await stalled.start();
    await vi.waitFor(() => expect(stalled.inFlight?.projectRoot).toBe(root), { timeout: 5_000 });

    // A successor election happens while it is frozen: same shape the real takeover writes, with
    // the next fencing token.
    const beforeTakeover = readWorkerState(env)!;
    const successor = {
      ...beforeTakeover,
      epoch: (beforeTakeover.epoch ?? 0) + 1,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      activeTask: undefined,
      lastKnownGood: {},
    };
    writeFileSync(
      join(dir, 'freshness', 'worker-state.json'),
      `${JSON.stringify(successor, null, 2)}\n`,
    );

    // The stalled owner wakes up and tries to publish its result.
    release();
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'superseded')).toBe(true), {
      timeout: 5_000,
    });

    // It published nothing, wrote nothing, and deleted nothing: the successor's lease is intact.
    const after = readWorkerState(env)!;
    expect(after.epoch).toBe(successor.epoch);
    expect(after.lastKnownGood).toEqual({});
    expect(events.some((e) => e.kind === 'task-done')).toBe(false);
    expect(stalled.isRunning).toBe(false);

    // A superseded worker's stop() must not remove its successor's lease file either.
    await stalled.stop();
    expect(readWorkerState(env)?.epoch).toBe(successor.epoch);
  }, 30_000);
});
