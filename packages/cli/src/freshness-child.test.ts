/**
 * WP5.1–WP5.5 — the supervisor/child split of FreshnessWorker (docs/launch/requirements-register.md).
 *
 * What is pinned here (red lines):
 *   - the child's ONLY output is a STAGED RESULT, and the supervisor ACTIVATES it under its
 *     epoch fence: nothing is published by a child, a stale-epoch stage is discarded (WP5.1);
 *   - `actualHead` honesty: the supervisor publishes the head the port ACTUALLY processed,
 *     never stamps a newer result with the queued HEAD (WP5.2);
 *   - durable cancellation requests are writable by ANY process and honored by the sweep on the
 *     heartbeat — queued tasks never run, in-flight children are killed, and a request that
 *     matches neither stays for a later claim window (WP5.5);
 *   - one-shot markers: a cancelled run consumes its marker, so re-enqueueing the same
 *     content-addressed task id is a FRESH run that completes — never wrongly refused;
 *   - `workerBusy` reports task ownership independent of heartbeat freshness (WP5.1 status law).
 *
 * The in-process runner (`inProcessTaskRunner`, wired via `revalidate`) is the seam these tests
 * drive; the FORKED production runner's process-level properties (orphan exit, takeover replay,
 * lease loss) are pinned in freshness-subprocess.test.ts.
 */
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChildTaskDescriptor,
  type StagedResult,
  type TaskRunner,
  clearStagedResult,
  consumeCancellationRequest,
  hasCancellationRequest,
  inProcessTaskRunner,
  pruneCancellationRequests,
  pruneStagedResults,
  readCancellationRequests,
  readStagedResult,
  requestCancellation,
  stageResult,
} from './freshness-child.js';
import {
  FreshnessWorker,
  enqueueFreshness,
  freshnessStatus,
  readFreshnessQueue,
  readPublishedGeneration,
  readWorkerState,
  removePendingFreshnessTask,
} from './freshness.js';
import { registerProject } from './registry.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-fresh-child-'));
  env = { KCRIB_REGISTRY_DIR: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Poll until `cond` is true, else fail with the caller's message (real timers, 10ms cadence). */
async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function registeredRoot(name = '/abs/proj'): string {
  registerProject(name, { repoId: 'r1', cribDir: `${name}/.crib`, env });
  return name;
}

interface Harness {
  worker: FreshnessWorker;
  events: Array<{ kind: string; [k: string]: unknown }>;
  /** The descriptors the runner was invoked with (for epoch/stage assertions). */
  descriptors: ChildTaskDescriptor[];
  /** Resolve to let a gated runner finish with a "successful" stage. */
  release: () => void;
}

/** A worker whose runner GATES until released, honoring (or ignoring) the abort signal per test. */
function makeWorker(
  overrides: {
    onAbort?: (descriptor: ChildTaskDescriptor) => StagedResult | undefined;
    ignoreAbort?: boolean;
    generation?: string;
  } = {},
): Harness {
  const events: Harness['events'] = [];
  const descriptors: ChildTaskDescriptor[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runner: TaskRunner = (descriptor, signal) =>
    new Promise<StagedResult>((resolve, reject) => {
      descriptors.push(descriptor);
      if (overrides.ignoreAbort) {
        void gate.then(() =>
          resolve({
            taskId: descriptor.taskId,
            epoch: descriptor.epoch,
            actualHead: descriptor.head,
            generation: overrides.generation ?? `gen-for-${descriptor.head}`,
          }),
        );
        return;
      }
      const onAbort = (): void => {
        const staged = overrides.onAbort?.(descriptor);
        if (staged) {
          resolve(staged); // a child that raced: it staged BEFORE the kill landed
        } else {
          reject(new Error('freshness child killed'));
        }
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      void gate.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve({
          taskId: descriptor.taskId,
          epoch: descriptor.epoch,
          actualHead: descriptor.head,
          generation: overrides.generation ?? `gen-for-${descriptor.head}`,
        });
      });
    });
  const worker = new FreshnessWorker({
    env,
    runTask: runner,
    pollMs: 10,
    heartbeatMs: 40,
    leaseTtlMs: 200,
    retryBackoffMs: 10,
    maxAttempts: 3,
    onEvent: (e) => events.push(e as { kind: string }),
  });
  return { worker, events, descriptors, release };
}

// ─── staged results + cancellation requests (the durable child surfaces) ─────

describe('staged results — the child’s only durable output', () => {
  it('round-trips a stage, and clearStagedResult consumes it', () => {
    const staged: StagedResult = {
      taskId: 'fq:t1',
      epoch: 7,
      actualHead: 'head-real',
      generation: 'gen1',
    };
    stageResult(env, staged);
    expect(readStagedResult(env, 'fq:t1')).toEqual(staged);
    clearStagedResult(env, 'fq:t1');
    expect(readStagedResult(env, 'fq:t1')).toBeUndefined();
    // clear is idempotent — clearing an absent stage is not an error
    expect(() => clearStagedResult(env, 'fq:t1')).not.toThrow();
  });

  it('an unparseable stage reads as absent (a torn write is never fatal) and ages out on prune', () => {
    mkdirSync(join(dir, 'freshness', 'staged'), { recursive: true });
    writeFileSync(join(dir, 'freshness', 'staged', 'fq:torn.json'), '{not json');
    expect(readStagedResult(env, 'fq:torn')).toBeUndefined();
    pruneStagedResults(env, 0, () => Date.now() + 1);
    expect(readStagedResultsRaw()).toEqual([]);
  });

  it('prunes only stages older than maxAgeMs', () => {
    stageResult(env, { taskId: 'fq:old', epoch: 1, actualHead: 'h', generation: 'g' });
    pruneStagedResults(env, 24 * 60 * 60_000, () => Date.now());
    expect(readStagedResultsRaw()).toHaveLength(1); // fresh — kept
    pruneStagedResults(env, 0, () => Date.now() + 1); // everything is "old" against this clock
    expect(readStagedResultsRaw()).toHaveLength(0);
  });
});

describe('cancellation requests — writable by ANY process, no lease', () => {
  it('writes, reads, and one-shot consumes a request', () => {
    requestCancellation(env, 'fq:t1');
    expect(hasCancellationRequest(env, 'fq:t1')).toBe(true);
    expect(readCancellationRequests(env).map((r) => r.taskId)).toEqual(['fq:t1']);
    consumeCancellationRequest(env, 'fq:t1');
    expect(hasCancellationRequest(env, 'fq:t1')).toBe(false);
    expect(readCancellationRequests(env)).toEqual([]);
  });

  it('prunes only requests older than maxAgeMs', () => {
    requestCancellation(env, 'fq:stale');
    pruneCancellationRequests(env, 24 * 60 * 60_000, () => Date.now());
    expect(readCancellationRequests(env)).toHaveLength(1);
    pruneCancellationRequests(env, 0, () => Date.now() + 1);
    expect(readCancellationRequests(env)).toEqual([]);
  });
});

// ─── the supervisor protocol (in-process runner seam) ─────────────────────────

describe('FreshnessWorker supervisor — activation is fenced, results are honest', () => {
  it('the in-process runner STAGES its result durably before returning it', async () => {
    const runner = inProcessTaskRunner(
      async () => ({ generation: 'gen-x', actualHead: 'real-h' }),
      env,
    );
    const signal = new AbortController().signal;
    const staged = await runner(
      { taskId: 'fq:d', projectRoot: '/p', head: 'queued-h', epoch: 3, supervisorPid: process.pid },
      signal,
    );
    expect(staged).toEqual({
      taskId: 'fq:d',
      epoch: 3,
      actualHead: 'real-h', // the port's truth wins over the queued head
      generation: 'gen-x',
    });
    // the stage is the child's durable output — it exists on disk, not just in memory
    expect(readStagedResult(env, 'fq:d')).toEqual(staged);
  });

  it('publishes the actualHead the port processed, not the queued head (WP5.2)', async () => {
    const root = registeredRoot();
    enqueueFreshness(root, 'queued-head', env);
    const worker = new FreshnessWorker({
      env,
      // the default in-process runner: the port reports what it ACTUALLY processed
      revalidate: async () => ({ generation: 'gen-moved', actualHead: 'actual-head' }),
      pollMs: 10,
      heartbeatMs: 40,
      leaseTtlMs: 200,
      retryBackoffMs: 10,
      maxAttempts: 3,
    });
    await worker.start();
    try {
      await until(() => worker.lastKnownGood[root] !== undefined, 'task published');
      expect(readPublishedGeneration(root, env)).toMatchObject({
        projectRoot: root,
        head: 'actual-head', // the child's truth — never the stale queued stamp
        generation: 'gen-moved',
      });
    } finally {
      await worker.stop();
    }
  });

  it('actualHead defaults to the queued head when the port does not report one', async () => {
    const root = registeredRoot();
    enqueueFreshness(root, 'headA', env);
    const worker = new FreshnessWorker({
      env,
      revalidate: async () => ({ generation: 'gen-a' }),
      pollMs: 10,
      heartbeatMs: 40,
      leaseTtlMs: 200,
      retryBackoffMs: 10,
      maxAttempts: 3,
    });
    await worker.start();
    try {
      await until(() => readPublishedGeneration(root, env) !== undefined, 'task published');
      expect(readPublishedGeneration(root, env)).toMatchObject({ head: 'headA' });
    } finally {
      await worker.stop();
    }
  });

  it('discards a staged result from a stale epoch and publishes NOTHING (WP5.1 fence)', async () => {
    const root = registeredRoot();
    const task = enqueueFreshness(root, 'stale', env);
    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    const runner: TaskRunner = async (descriptor) => ({
      taskId: descriptor.taskId,
      epoch: descriptor.epoch + 999, // a stage commissioned by a PREVIOUS election
      actualHead: descriptor.head,
      generation: 'stale-generation',
    });
    const worker = new FreshnessWorker({
      env,
      runTask: runner,
      pollMs: 10,
      heartbeatMs: 40,
      leaseTtlMs: 200,
      retryBackoffMs: 10,
      maxAttempts: 1, // the discarded run must not loop as a retry storm
      onEvent: (e) => events.push(e as { kind: string }),
    });
    await worker.start();
    try {
      await until(
        () => events.some((e) => e.kind === 'task-discarded'),
        'stale-epoch stage discarded',
      );
      expect(readPublishedGeneration(root, env)).toBeUndefined(); // nothing activated
      expect(readStagedResult(env, task.id)).toBeUndefined(); // never staged by the runner
      expect(readWorkerState(env)?.activeTask).toBeUndefined(); // the lease was released
    } finally {
      await worker.stop();
    }
  });
});

describe('FreshnessWorker supervisor — durable cancellation (WP5.5)', () => {
  it('a QUEUED task is cancelled by a request file and never runs', async () => {
    const root = registeredRoot();
    const task = enqueueFreshness(root, 'never-runs', env);
    // push the claim window into the future (the retry-backoff field), so the CLAIM cannot race
    // the sweep — the heartbeat is then the only thing that can act on the entry
    const q = readFreshnessQueue(env);
    q.pending[0] = { ...q.pending[0]!, notBeforeMs: Date.now() + 60_000 };
    writeJsonAtomicForTest(join(dir, 'freshness', 'queue.json'), q);
    requestCancellation(env, task.id); // written by "another process" — no lease anywhere
    let ran = 0;
    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    const worker = new FreshnessWorker({
      env,
      runTask: async (descriptor) => {
        ran++;
        return {
          taskId: descriptor.taskId,
          epoch: descriptor.epoch,
          actualHead: descriptor.head,
          generation: 'should-never-happen',
        };
      },
      pollMs: 10,
      heartbeatMs: 40,
      leaseTtlMs: 200,
      retryBackoffMs: 10,
      maxAttempts: 3,
      onEvent: (e) => events.push(e as { kind: string }),
    });
    await worker.start();
    try {
      await until(
        () => events.some((e) => e.kind === 'task-cancelled'),
        'queued task cancelled by the sweep',
      );
      const cancel = events.find((e) => e.kind === 'task-cancelled')!;
      expect(cancel.reason).toBe('cancelled while queued');
      expect(readFreshnessQueue(env).pending).toHaveLength(0);
      // the sweep consumed the request — one-shot — and the claim loop never saw the task
      expect(hasCancellationRequest(env, task.id)).toBe(false);
      await new Promise((r) => setTimeout(r, 120)); // past several poll windows: never claimed
      expect(ran).toBe(0);
      expect(readPublishedGeneration(root, env)).toBeUndefined();
    } finally {
      await worker.stop();
    }
  });

  it('an IN-FLIGHT task is killed when its child honors the abort signal', async () => {
    const root = registeredRoot();
    const task = enqueueFreshness(root, 'stuck', env);
    const h = makeWorker();
    await h.worker.start();
    try {
      await until(() => h.descriptors.length === 1, 'child started the stuck task');
      requestCancellation(env, task.id);
      await until(() => h.events.some((e) => e.kind === 'task-cancelled'), 'cancellation honored');
      const cancel = h.events.find((e) => e.kind === 'task-cancelled')!;
      expect(cancel.reason).toBe('child terminated');
      expect(readWorkerState(env)?.activeTask).toBeUndefined(); // lease released
      expect(readPublishedGeneration(root, env)).toBeUndefined(); // nothing published
      expect(hasCancellationRequest(env, task.id)).toBe(false); // consumed
    } finally {
      await h.worker.stop();
    }
  });

  it('a racing child that staged before the kill lands has its result DISCARDED, never published', async () => {
    const root = registeredRoot();
    const task = enqueueFreshness(root, 'racing', env);
    // the runner races the kill: it returns a "successful" stage in its abort listener, so the
    // run's continuation sees a result arrive — after the abort fired. The fence discards it.
    const h = makeWorker({
      onAbort: (descriptor) => ({
        taskId: descriptor.taskId,
        epoch: descriptor.epoch,
        actualHead: descriptor.head,
        generation: 'raced-generation',
      }),
    });
    await h.worker.start();
    try {
      await until(() => h.descriptors.length === 1, 'child started the racing task');
      requestCancellation(env, task.id);
      await until(
        () => h.events.some((e) => e.kind === 'task-discarded'),
        'racing result discarded',
      );
      const discarded = h.events.find((e) => e.kind === 'task-discarded')!;
      expect(discarded.reason).toBe('run aborted');
      expect(readPublishedGeneration(root, env)).toBeUndefined(); // nothing activated
      // the claim was released — the worker is not left reporting busy on a dead run
      expect(readWorkerState(env)?.activeTask).toBeUndefined();
    } finally {
      await h.worker.stop();
    }
  });

  it('a request matching neither an active nor a queued task is LEFT for a later claim window', async () => {
    const root = registeredRoot();
    requestCancellation(env, 'fq:not-yet-enqueued');
    const h = makeWorker();
    await h.worker.start();
    try {
      // wait through a few heartbeats — the sweep must not consume the request
      await new Promise((r) => setTimeout(r, 120));
      expect(hasCancellationRequest(env, 'fq:not-yet-enqueued')).toBe(true);
      h.release();
      await h.worker.stop();
    } catch (err) {
      h.release();
      throw err;
    }
  });

  it('one-shot markers: after cancellation, re-enqueueing the same task id runs to completion', async () => {
    const root = registeredRoot();
    const first = enqueueFreshness(root, 'requeue-me', env);
    const h = makeWorker();
    await h.worker.start();
    try {
      await until(() => h.descriptors.length === 1, 'child started the first run');
      requestCancellation(env, first.id);
      await until(() => h.events.some((e) => e.kind === 'task-cancelled'), 'first run cancelled');
      // the content-addressed id is the SAME — a marker keyed on the id alone would refuse this
      // run forever; the marker is keyed on id@enqueuedAt and was consumed by the first run
      const second = enqueueFreshness(root, 'requeue-me', env);
      expect(second.id).toBe(first.id);
      expect(second.coalesced ?? false).toBe(false); // a fresh entry, not a restatement
      h.release();
      await until(() => h.events.some((e) => e.kind === 'task-done'), 're-enqueued task completed');
      expect(readPublishedGeneration(root, env)).toMatchObject({
        head: 'requeue-me',
        generation: 'gen-for-requeue-me',
      });
      expect(readFreshnessQueue(env).pending).toHaveLength(0);
    } finally {
      h.release();
      await h.worker.stop();
    }
  });
});

describe('FreshnessWorker status — busy is task ownership, independent of heartbeat (WP5.1)', () => {
  it('reports workerBusy while a task is in flight, with a fresh heartbeat', async () => {
    const root = registeredRoot();
    enqueueFreshness(root, 'busy-work', env);
    const h = makeWorker();
    await h.worker.start();
    try {
      await until(() => h.descriptors.length === 1, 'child started the busy task');
      const status = freshnessStatus(root, { env, leaseTtlMs: 200 });
      expect(status.workerRunning).toBe(true);
      expect(status.workerBusy).toBe(true);
      expect(status.inFlight?.head).toBe('busy-work');
      // and the lease is genuinely fresh THROUGH the work — the WP5.1 property
      const s = readWorkerState(env);
      expect(Date.now() - Date.parse(s?.heartbeatAt ?? '')).toBeLessThan(200);
      h.release();
      await until(() => h.events.some((e) => e.kind === 'task-done'), 'task done');
      const after = freshnessStatus(root, { env, leaseTtlMs: 200 });
      expect(after.workerBusy).toBe(false);
    } finally {
      h.release();
      await h.worker.stop();
    }
  });
});

// ─── the no-worker cancellation path ─────────────────────────────────────────

describe('removePendingFreshnessTask — crib freshness cancel with no live worker', () => {
  it('removes a queued task durably and reports nothing removed for unknown/claimed ids', () => {
    const root = registeredRoot();
    const task = enqueueFreshness(root, 'orphan-queued', env);
    expect(removePendingFreshnessTask(task.id, env)).toMatchObject({ head: 'orphan-queued' });
    expect(readFreshnessQueue(env).pending).toHaveLength(0);
    expect(removePendingFreshnessTask(task.id, env)).toBeUndefined(); // already gone
    expect(removePendingFreshnessTask('fq:never-existed', env)).toBeUndefined();
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Hand-write on-disk state for a test: mkdir the parent, then the same temp→rename shape. */
function writeJsonAtomicForTest(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** The raw file listing of the staged directory (prune assertions need the files, not parses). */
function readStagedResultsRaw(): string[] {
  try {
    return readdirSync(join(dir, 'freshness', 'staged'));
  } catch {
    return []; // never staged anything — nothing to list
  }
}
