/**
 * WP5.1–WP5.5 (docs/launch/requirements-register.md) — the supervisor/child split of the
 * freshness worker.
 *
 * WHY A CHILD AT ALL: production revalidation runs `crib update`, whose parsing is synchronous —
 * inside the worker it blocked the event loop for as long as the repo took, the heartbeat timer
 * could not fire, and the only thing keeping a takeover from duplicating the work was a ten-minute
 * busy grace bolted onto the lease. Moving revalidation into a forked child frees the supervisor's
 * loop: it heartbeats THROUGH the work, so the ordinary 15s lease is the one and only liveness
 * contract, and the busy grace is retired (WP5.1).
 *
 * DIVISION OF LABOR (the WP5 architecture law):
 *   - the SUPERVISOR owns lease renewal, queue ownership, cancellation and publication — every
 *     durable write of its own state stays fenced by the epoch token in freshness.ts;
 *   - the CHILD receives `{taskId, projectRoot, head, epoch, supervisorPid}`, runs the
 *     revalidation port, and its ONLY output is a STAGED RESULT — it never touches the worker
 *     state, the queue, or the generation files;
 *   - ACTIVATION (publishGeneration + lastKnownGood + dequeue) happens exclusively inside the
 *     supervisor's fenced commit, re-checking ownership at the moment of publication.
 *
 * ORPHAN SAFETY (WP5.3): the child detects a dead supervisor via fork's IPC channel
 * (`disconnect` fires when the parent exits) and, because a synchronous revalidation can delay
 * that event, re-checks `isPidAlive(supervisorPid)` BEFORE staging. A child that staged under a
 * dead supervisor is still inert: staged results are only ever read by a supervisor, and the
 * staging epoch tags which election commissioned them — a successor at a new epoch will not
 * activate them.
 */
import { fork } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type FreshnessTask, type RevalidateFn, freshnessDir } from './freshness.js';

// ─── the protocol ───────────────────────────────────────────────────────────

/** WP5.1 — the task as handed to a child: identity, target repository state, fencing epoch. */
export interface ChildTaskDescriptor {
  taskId: string;
  projectRoot: string;
  /** The head the task was enqueued at. The child must report what it ACTUALLY processed. */
  head: string;
  /** The supervisor's fencing epoch — stamped into the staged result for activation-time checks. */
  epoch: number;
  /** For the orphan check: a child whose supervisor died must not stage (WP5.3). */
  supervisorPid: number;
}

/**
 * WP5.2 — the child's only output. `actualHead` is the head the child ACTUALLY processed: the
 * supervisor publishes it as-is and never stamps a newer result with the original queued HEAD.
 */
export interface StagedResult {
  taskId: string;
  epoch: number;
  actualHead: string;
  /** Fingerprint of the artifacts the child produced (the revalidation port's return value). */
  generation: string;
}

/**
 * Runs one task's revalidation and returns its STAGED result. `signal` fires when the supervisor
 * cancels the task or loses its lease — the runner must terminate its child promptly.
 */
export type TaskRunner = (
  descriptor: ChildTaskDescriptor,
  signal: AbortSignal,
) => Promise<StagedResult>;

// ─── staged results (durable) ────────────────────────────────────────────────

function stagedDir(env: NodeJS.ProcessEnv): string {
  return join(freshnessDir(env), 'staged');
}

function stagedPath(env: NodeJS.ProcessEnv, taskId: string): string {
  return join(stagedDir(env), `${taskId}.json`);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/** The child's durable output: the staged result file a supervisor may activate under its fence. */
export function stageResult(env: NodeJS.ProcessEnv, result: StagedResult): void {
  mkdirSync(stagedDir(env), { recursive: true });
  writeJsonAtomic(stagedPath(env, result.taskId), result);
}

/** Read one staged result (undefined when absent/unparseable — a missing stage is never fatal). */
export function readStagedResult(env: NodeJS.ProcessEnv, taskId: string): StagedResult | undefined {
  try {
    const raw = readFileSync(stagedPath(env, taskId), 'utf8');
    return JSON.parse(raw) as StagedResult;
  } catch {
    return undefined;
  }
}

/** Consume a staged result after activation (or refusal) so it cannot be mistaken for live state. */
export function clearStagedResult(env: NodeJS.ProcessEnv, taskId: string): void {
  rmSync(stagedPath(env, taskId), { force: true });
}

/** Drop staged files older than `maxAgeMs` — orphaned output of crashed children is inert by
 *  epoch, and pruning keeps the directory bounded. */
export function pruneStagedResults(
  env: NodeJS.ProcessEnv,
  maxAgeMs: number,
  now: () => number,
): void {
  const dir = stagedDir(env);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // never staged anything — nothing to prune
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      if (now() - statSync(full).mtimeMs > maxAgeMs) rmSync(full, { force: true });
    } catch {
      /* raced away — nothing to prune */
    }
  }
}

// ─── cancellation requests (WP5.5, durable, writable by ANYONE) ─────────────

/**
 * The durable cancellation surface: any process may write a request file; the lease-holding
 * worker's sweep honors it (kill the in-flight child / drop the pending entry) and consumes it.
 * A request for a task that is neither active nor pending is LEFT in place — it may target a task
 * that has not been claimed yet — and is pruned by age.
 */
export interface CancelRequest {
  taskId: string;
  requestedAt: string;
}

function cancelRequestDir(env: NodeJS.ProcessEnv): string {
  return join(freshnessDir(env), 'cancel-requests');
}

function cancelRequestPath(env: NodeJS.ProcessEnv, taskId: string): string {
  return join(cancelRequestDir(env), `${taskId}.json`);
}

/** `crib freshness cancel` writes this; no lease is needed or taken. */
export function requestCancellation(
  env: NodeJS.ProcessEnv,
  taskId: string,
  now: () => number = Date.now,
): void {
  mkdirSync(cancelRequestDir(env), { recursive: true });
  writeJsonAtomic(cancelRequestPath(env, taskId), {
    taskId,
    requestedAt: new Date(now()).toISOString(),
  } satisfies CancelRequest);
}

/** Whether an unconsumed cancellation request exists for a task. */
export function hasCancellationRequest(env: NodeJS.ProcessEnv, taskId: string): boolean {
  return existsSync(cancelRequestPath(env, taskId));
}

/** Consume (delete) the request once honored — one-shot semantics, so a later re-enqueue of the
 *  same content-addressed task id is a fresh run, not a cancelled one. */
export function consumeCancellationRequest(env: NodeJS.ProcessEnv, taskId: string): void {
  rmSync(cancelRequestPath(env, taskId), { force: true });
}

/** All outstanding cancellation requests (the supervisor's sweep input). */
export function readCancellationRequests(env: NodeJS.ProcessEnv): CancelRequest[] {
  const out: CancelRequest[] = [];
  try {
    for (const name of readdirSync(cancelRequestDir(env))) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(cancelRequestDir(env), name), 'utf8')));
      } catch {
        /* a torn request file — the sweep's age pruning removes it */
      }
    }
  } catch {
    /* no requests yet */
  }
  return out;
}

/** Prune requests older than `maxAgeMs` (never honored — their task never appeared). */
export function pruneCancellationRequests(
  env: NodeJS.ProcessEnv,
  maxAgeMs: number,
  now: () => number,
): void {
  for (const req of readCancellationRequests(env)) {
    try {
      if (now() - statSync(cancelRequestPath(env, req.taskId)).mtimeMs > maxAgeMs) {
        consumeCancellationRequest(env, req.taskId);
      }
    } catch {
      /* raced away */
    }
  }
}

// ─── runners ─────────────────────────────────────────────────────────────────

/**
 * The default runner: run `revalidate` IN-PROCESS and stage its result. This is the seam the
 * worker falls back to when no forked runner is injected — unit tests exercise the entire
 * supervisor protocol (staging, epoch checks, cancellation refusal, fenced activation) through
 * it, and `crib` wiring passes the real {@link forkTaskRunner} instead.
 */
export function inProcessTaskRunner(revalidate: RevalidateFn, env: NodeJS.ProcessEnv): TaskRunner {
  return async (descriptor) => {
    const task: FreshnessTask = {
      id: descriptor.taskId,
      projectRoot: descriptor.projectRoot,
      head: descriptor.head,
      attempts: 0,
      enqueuedAt: new Date(0).toISOString(),
    };
    const { generation, actualHead } = await revalidate(task);
    const staged: StagedResult = {
      taskId: descriptor.taskId,
      epoch: descriptor.epoch,
      actualHead: actualHead ?? descriptor.head,
      generation,
    };
    stageResult(env, staged);
    return staged;
  };
}

/**
 * The production runner: fork the compiled child entry, send the descriptor, resolve on the
 * child's IPC'd staged result. Abort terminates the child — SIGTERM, then SIGKILL after a short
 * grace — and rejects the pending run so the supervisor never activates a killed task's output.
 */
export function forkTaskRunner(opts: { env?: NodeJS.ProcessEnv } = {}): TaskRunner {
  const env = opts.env ?? process.env;
  // The child entry is this module's compiled sibling (dist/freshness-child-entry.js in the
  // built package). Resolving from import.meta.url keeps production wiring configuration-free.
  const childEntryUrl = new URL('./freshness-child-entry.js', import.meta.url);
  return (descriptor, signal) =>
    new Promise<StagedResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('freshness child aborted before fork'));
        return;
      }
      const child = fork(childEntryUrl, {
        env: { ...env, KCRIB_FRESHNESS_TASK: JSON.stringify(descriptor) },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        clearTimeout(killTimer);
        fn();
      };
      const onAbort = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          // A child blocked in synchronous parsing will not service signals until it yields —
          // escalate so an aborted run cannot linger holding a repo open.
          killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
        }
      };
      let killTimer = setTimeout(() => undefined, 0); // assigned for real on abort; cleared otherwise
      killTimer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('message', (msg: unknown) => {
        const staged = msg as StagedResult;
        if (staged && typeof staged === 'object' && staged.taskId === descriptor.taskId) {
          finish(() => resolve(staged));
        }
      });
      child.on('error', (err) => finish(() => reject(err)));
      child.on('exit', (code, signalCode) => {
        finish(() =>
          reject(new Error(`freshness child exited (code ${code ?? signalCode}) before staging`)),
        );
      });
    });
}

/**
 * The child body. Runs the revalidation port against the descriptor from
 * `KCRIB_FRESHNESS_TASK` (the fork pre-loads it so no IPC round-trip can race the supervisor's
 * death), stages the result, reports it, and exits. Refuses to stage for a dead supervisor.
 */
export async function runFreshnessChildBody(deps: {
  env: NodeJS.ProcessEnv;
  loadRevalidate: () => Promise<RevalidateFn>;
  isPidAlive: (pid: number) => boolean;
}): Promise<void> {
  const raw = deps.env.KCRIB_FRESHNESS_TASK;
  if (!raw) throw new Error('freshness child: no KCRIB_FRESHNESS_TASK in environment');
  const descriptor = JSON.parse(raw) as ChildTaskDescriptor;
  const revalidate = await deps.loadRevalidate();

  // A disconnect (supervisor exited or closed the channel) must not be followed by staging: the
  // staged file would be the orphan's only trace, and while inert by epoch it is also useless.
  let disconnected = false;
  process.on('disconnect', () => {
    disconnected = true;
  });

  const task: FreshnessTask = {
    id: descriptor.taskId,
    projectRoot: descriptor.projectRoot,
    head: descriptor.head,
    attempts: 0,
    enqueuedAt: new Date(0).toISOString(),
  };
  const { generation, actualHead } = await revalidate(task);

  // The belt-and-braces orphan check: `disconnect` may be delayed behind a synchronous
  // revalidation, so liveness is probed directly before anything durable is written (WP5.3).
  if (disconnected || !deps.isPidAlive(descriptor.supervisorPid)) {
    process.exit(0);
  }
  const staged: StagedResult = {
    taskId: descriptor.taskId,
    epoch: descriptor.epoch,
    actualHead: actualHead ?? descriptor.head,
    generation,
  };
  stageResult(deps.env, staged);
  process.send?.(staged);
}
