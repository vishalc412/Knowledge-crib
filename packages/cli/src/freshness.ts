/**
 * G3.4 — freshness modes + the durable background freshness worker.
 *
 * A project's freshness mode is stored ADDITIVELY in `~/.crib/registry.json`
 * (`freshnessMode` on {@link RegisteredProject}); the registry is user-owned and never committed.
 * The contract per mode:
 *   - `manual` (DEFAULT when unset): nothing post-commit, reads are as-of-last-update, zero cost.
 *   - `watch`: always-fresh in-memory overlay reads (`watch.ts`), 300ms debounce, serialized
 *     updates, atomic generation publication, target 5s queryable-update p95, zero commit tax.
 *     Watch is the default WHILE A SERVER RUNS — never a persisted default.
 *   - `auto` (opt-in): a DURABLE BACKGROUND WORKER revalidates memory vs the new HEAD after each
 *     commit. Agent reads are current-on-disk; ALL refresh work is background. Red line #5: the
 *     worker must be durable — persistent queue on disk, lease/heartbeat, coalescing, crash
 *     recovery, last-known-good generation retained. A detached shell process is NOT sufficient.
 *
 * RED LINES enforced here by SHAPE, not by convention:
 *   - Zero commit tax in EVERY mode: the post-commit path is {@link postCommitFreshness} — a
 *     synchronous, single small-file enqueue (or a no-op). It never awaits, never spawns, never
 *     revalidates. The actual revalidation runs only inside the worker loop.
 *   - Never a broken index: a failed refresh NEVER publishes. {@link publishGeneration} writes the
 *     new generation to a temp file and atomic-renames it; the worker records last-known-good ONLY
 *     after a successful revalidation, and only after the generation file is durably on disk (the
 *     same durable-result-first ordering as the G2.2 capture outbox). A crash at any point leaves
 *     the previous generation readable and at worst re-runs an idempotent task.
 *   - Wall-clock law: task ids are content-addressed over (projectRoot, head) — no timestamp, no
 *     randomness. Wall clock appears ONLY in bookkeeping fields (`enqueuedAt`, heartbeats, ages)
 *     that never feed an id or hash, and always through the injected `now` port.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CribLock, LockBusyError } from '@knowledge-crib/core';
import {
  type ChildTaskDescriptor,
  type TaskRunner,
  clearStagedResult,
  consumeCancellationRequest,
  inProcessTaskRunner,
  pruneCancellationRequests,
  pruneStagedResults,
  readCancellationRequests,
} from './freshness-child.js';
import {
  type RegisteredProject,
  lookupProject,
  readRegistry,
  registryDir,
  writeRegistry,
} from './registry.js';

// ─── modes ───────────────────────────────────────────────────────────────────

export type FreshnessMode = 'manual' | 'watch' | 'auto';

/** Every legal mode, in preference order (the integration layer offers them in this order). */
export const FRESHNESS_MODES: readonly FreshnessMode[] = ['manual', 'watch', 'auto'];

/**
 * The persisted default. `manual` costs nothing and breaks nothing; `watch` must never be a
 * persisted default (it is the de-facto mode only while a server is running), and `auto` is
 * opt-in because it starts a durable worker.
 */
export const DEFAULT_FRESHNESS_MODE: FreshnessMode = 'manual';

/**
 * Pure mode resolution: an unset/unknown value degrades to `manual` rather than throwing, so an
 * old registry JSON (or a hand-edited one) always resolves to the zero-cost mode. Callers that
 * need to DISTINGUISH "user asked for garbage" from "unset" use {@link parseFreshnessMode}.
 */
export function resolveFreshnessMode(raw: unknown): FreshnessMode {
  return parseFreshnessMode(raw) ?? DEFAULT_FRESHNESS_MODE;
}

/** Validate one raw value as a mode; `undefined` when unset, `null`-ish/invalid → undefined. */
export function parseFreshnessMode(raw: unknown): FreshnessMode | undefined {
  return typeof raw === 'string' && (FRESHNESS_MODES as readonly string[]).includes(raw)
    ? (raw as FreshnessMode)
    : undefined;
}

/**
 * Should a serving process watch the working tree?
 *
 * Extracted so the policy is testable and stated in ONE place. The audited gap (F06) was that this
 * decision lived only in the `--watch` argv check inside `cmdServe`, while every generated client
 * config spawns a bare `crib serve <root>` — so selecting `watch` or `auto` persisted a preference
 * that configured nothing, and the user got a stale-on-save server with no signal.
 *
 * `--watch` remains an explicit override so a one-off run (or an unregistered project, which has no
 * persisted mode) can still watch. `manual` is the only mode that serves committed source only.
 */
export function shouldServeWatch(args: readonly string[], mode: FreshnessMode): boolean {
  return args.includes('--watch') || mode !== 'manual';
}

/** The persisted mode for one registered project (defaults to `manual` when unset/unregistered). */
export function getFreshnessMode(
  absRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): FreshnessMode {
  return resolveFreshnessMode(lookupProject(absRoot, env)?.freshnessMode);
}

/** Error thrown by {@link setFreshnessMode} for a value outside {@link FRESHNESS_MODES}. */
export class InvalidFreshnessModeError extends Error {
  constructor(value: unknown) {
    super(
      `invalid freshness mode: ${JSON.stringify(value)} — expected one of ${FRESHNESS_MODES.join(' | ')}`,
    );
    this.name = 'InvalidFreshnessModeError';
  }
}

/**
 * Persist the mode for a project. The project must already be registered (`crib init` registers
 * before a mode can be set); an unknown root throws so a typo'd path can never silently create a
 * mode-only registry entry detached from a real project.
 */
export function setFreshnessMode(
  absRoot: string,
  mode: FreshnessMode,
  env: NodeJS.ProcessEnv = process.env,
): RegisteredProject {
  if (parseFreshnessMode(mode) === undefined) throw new InvalidFreshnessModeError(mode);
  const reg = readRegistry(env);
  const entry = reg.projects[absRoot];
  if (!entry) throw new Error(`project not registered: ${absRoot}`);
  entry.freshnessMode = mode;
  reg.projects[absRoot] = entry;
  writeRegistry(reg, env);
  return entry;
}

// ─── the durable queue (on disk, under the crib dir) ─────────────────────────

/** Directory holding the freshness queue + worker state. Relocated by `KCRIB_REGISTRY_DIR`. */
export function freshnessDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(registryDir(env), 'freshness');
}

/** One unit of pending revalidation work. Ids are content-addressed; timestamps are bookkeeping. */
export interface FreshnessTask {
  /** `fq:` + sha256(projectRoot ␀ head) — coalescing-safe, crash-stable, wall-clock-free. */
  id: string;
  /** Absolute project root (the registry key). */
  projectRoot: string;
  /** The VCS head the revalidation targets. */
  head: string;
  /** Failed-attempt count (dead-letters at the worker's maxAttempts). */
  attempts: number;
  /** Earliest wall-clock ms the worker may pick this task up (retry backoff). Never an id input. */
  notBeforeMs?: number;
  /** ISO timestamp the task was FIRST enqueued (bookkeeping only — never rewritten on coalesce). */
  enqueuedAt: string;
}

/** The persistent queue file. `pending` is the work set; `dead` is a no-delete audit trail. */
export interface FreshnessQueue {
  version: 1;
  pending: FreshnessTask[];
  dead: FreshnessTask[];
}

const QUEUE_VERSION = 1;

function queuePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(freshnessDir(env), 'queue.json');
}

function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(freshnessDir(env), 'worker-state.json');
}

/** Atomic JSON write (temp→rename): a crash mid-write leaves the OLD file plus an orphan `.tmp`. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined; // torn/corrupt queue: the prior file (pre-rename) is gone, start empty —
    // enqueue re-creates it and the worker re-derives work from VCS, never from a broken file.
  }
}

/** Read the durable queue (empty when absent or unreadable). */
export function readFreshnessQueue(env: NodeJS.ProcessEnv = process.env): FreshnessQueue {
  return (
    readJson<FreshnessQueue>(queuePath(env)) ?? { version: QUEUE_VERSION, pending: [], dead: [] }
  );
}

function writeQueue(q: FreshnessQueue, env: NodeJS.ProcessEnv): void {
  writeJsonAtomic(queuePath(env), q);
}

const QUEUE_LOCK_RETRIES = 1_000;
const QUEUE_LOCK_WAIT_MS = 1;
const queueWaitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** The queue lock: serializes read-modify-write of `queue.json` across producers and the worker. */
const QUEUE_LOCK = '.queue.lock';
/**
 * The lease lock: serializes worker ELECTION and every owned state write.
 *
 * LOCK ORDER LAW — the queue lock is OUTER, the lease lock is INNER. `claim()` and the failure
 * path take the queue lock and then nest a lease check inside it; nothing may ever take the lease
 * lock first and then reach for the queue lock, or two workers deadlock against each other.
 */
const LEASE_LOCK = '.lease.lock';

/**
 * Run `fn` under one named freshness lock, spinning while another process holds it.
 *
 * Shared by the queue and the lease so both obey the same contention and stale-holder policy
 * (`CribLock` reclaims a lock whose holder pid is dead, so a killed worker never wedges the queue).
 */
function withFreshnessLock<T>(env: NodeJS.ProcessEnv, lockName: string, fn: () => T): T {
  let lastBusy: LockBusyError | undefined;
  for (let attempt = 0; attempt < QUEUE_LOCK_RETRIES; attempt += 1) {
    const lock = new CribLock({ cribDir: freshnessDir(env), lockName });
    try {
      lock.acquire();
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      lastBusy = error;
      Atomics.wait(queueWaitCell, 0, 0, QUEUE_LOCK_WAIT_MS);
      continue;
    }
    try {
      return fn();
    } finally {
      lock.release();
    }
  }
  throw lastBusy ?? new Error(`freshness lock ${lockName} could not be acquired`);
}

/** Serialize a complete queue read-modify-write across post-commit processes. */
function mutateFreshnessQueue<T>(env: NodeJS.ProcessEnv, mutate: (queue: FreshnessQueue) => T): T {
  return withFreshnessLock(env, QUEUE_LOCK, () => {
    const queue = readFreshnessQueue(env);
    const result = mutate(queue);
    writeQueue(queue, env);
    return result;
  });
}

/**
 * Content-addressed task id: `fq:` over (projectRoot ␀ head). Deterministic, so a re-enqueue of
 * the same (project, head) re-derives the same id and coalescing can compare ids instead of
 * trusting wall-clock ordering. No Date.now/new Date anywhere near this — wall-clock law.
 */
/**
 * WP5.5 — durable removal of a QUEUED task by id (the no-worker cancellation path). Returns the
 * removed task, or undefined when it is not pending (already claimed, done, or unknown — the
 * caller then leaves any cancel request in place for the live worker's sweep to honor).
 */
export function removePendingFreshnessTask(
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): FreshnessTask | undefined {
  return mutateFreshnessQueue(env, (q) => {
    const idx = q.pending.findIndex((t) => t.id === taskId);
    if (idx === -1) return undefined;
    const [task] = q.pending.splice(idx, 1);
    return task;
  });
}

export function freshnessTaskId(projectRoot: string, head: string): string {
  const digest = createHash('sha256').update(`${projectRoot} ${head}`).digest('hex');
  return `fq:${digest.slice(0, 24)}`;
}

export interface EnqueueResult {
  id: string;
  /** true when an older pending entry for the same project was superseded (coalesced away). */
  coalesced: boolean;
}

/**
 * Durable enqueue — THE post-commit path. Synchronous, O(queue size ≤ pending), one small atomic
 * file write: the entire commit-side cost of `auto` mode. Coalescing law: a project has AT MOST
 * ONE pending entry — a new commit supersedes the older one, because revalidating at the newest
 * HEAD subsumes any refresh at an older one. The superseded entry's `enqueuedAt` is inherited so
 * the queue's origin time reflects when work was FIRST requested, not when it was last restated.
 */
export function enqueueFreshness(
  projectRoot: string,
  head: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): EnqueueResult {
  return mutateFreshnessQueue(env, (q) => {
    const id = freshnessTaskId(projectRoot, head);
    const priorIdx = q.pending.findIndex((t) => t.projectRoot === projectRoot);
    const coalesced = priorIdx !== -1;
    const task: FreshnessTask = {
      id,
      projectRoot,
      head,
      attempts: coalesced ? q.pending[priorIdx]!.attempts : 0,
      ...(coalesced && q.pending[priorIdx]!.notBeforeMs !== undefined
        ? { notBeforeMs: q.pending[priorIdx]!.notBeforeMs }
        : {}),
      enqueuedAt: coalesced ? q.pending[priorIdx]!.enqueuedAt : now().toISOString(),
    };
    q.pending = coalesced
      ? q.pending.map((t, i) => (i === priorIdx ? task : t))
      : [...q.pending, task];
    return { id, coalesced };
  });
}

/**
 * The post-commit hook body (integration wires this into the converted hook). ZERO commit tax by
 * construction: mode lookup is one small JSON read; `manual` and `watch` are pure no-ops; `auto`
 * is the synchronous enqueue above. Never throws into the hook — a freshness problem must NEVER
 * fail a commit (the same fail-open law as the capture hook), so every failure is swallowed and
 * reported as `ok: false` for stderr only.
 */
export function postCommitFreshness(
  projectRoot: string,
  head: string,
  env: NodeJS.ProcessEnv = process.env,
): { mode: FreshnessMode; enqueued: boolean; id?: string; ok: boolean } {
  try {
    const mode = getFreshnessMode(projectRoot, env);
    if (mode !== 'auto') return { mode, enqueued: false, ok: true };
    const { id } = enqueueFreshness(projectRoot, head, env);
    return { mode, enqueued: true, id, ok: true };
  } catch {
    return { mode: 'manual', enqueued: false, ok: false };
  }
}

// ─── generation publication (atomic; last-known-good preserved on failure) ───

/** The published, readable freshness generation for one project. */
export interface PublishedGeneration {
  projectRoot: string;
  /** Opaque dependency-generation fingerprint handed back by the revalidation port (G3.3's cache key). */
  generation: string;
  /** The VCS head this generation was revalidated against. */
  head: string;
  /** ISO timestamp of publication (display only). */
  publishedAt: string;
}

function generationsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(freshnessDir(env), 'generations');
}

/**
 * Publish a generation ATOMICALLY: write to `<projectId>.json.tmp`, rename over the target. A
 * crash or failure at any point leaves the PREVIOUS generation file intact — readers never see a
 * half-written generation, which is the red-line "failed refresh preserves the prior readable
 * generation" guarantee at the storage layer. The project filename is the sha256 of the root
 * (files cannot carry path separators).
 */
export function publishGeneration(
  projectRoot: string,
  gen: PublishedGeneration,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(generationsDir(env), { recursive: true });
  const name = `${createHash('sha256').update(projectRoot).digest('hex').slice(0, 24)}.json`;
  writeJsonAtomic(join(generationsDir(env), name), gen);
}

/** The last published generation for a project, or undefined when none was ever published. */
export function readPublishedGeneration(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): PublishedGeneration | undefined {
  const name = `${createHash('sha256').update(projectRoot).digest('hex').slice(0, 24)}.json`;
  return readJson<PublishedGeneration>(join(generationsDir(env), name));
}

// ─── worker state (lease + heartbeat + last-known-good registry) ─────────────

/**
 * The worker's durable self-description. Doubles as the lease: a second worker refuses to start
 * while `pid` is alive AND `heartbeatAt` is inside the lease TTL; a state with a dead pid or a
 * stale heartbeat is a CRASHED worker, and startup takes over (recovery).
 */
export interface FreshnessWorkerState {
  pid: number;
  /**
   * FENCING TOKEN — monotonic, incremented once per successful election.
   *
   * Atomic election alone stops two workers from starting together; it does not stop a worker that
   * was elected, then stalled past its lease TTL (a paused process, a swapped-out VM, a 20s GC
   * pause), from waking up and writing over its successor's state. Every owned write re-reads this
   * field under the lease lock and proceeds only when it still matches the writer's own epoch, so a
   * superseded owner's write is refused rather than applied. Absent on pre-fencing state files,
   * which read as epoch 0 — the next election writes 1 and takes ownership.
   */
  epoch?: number;
  startedAt: string;
  heartbeatAt: string;
  /** The task currently leased by this worker (crash recovery re-enqueues it on takeover). */
  activeTask?: FreshnessTask;
  /** Last-known-good generation per project root — written ONLY on successful revalidation. */
  lastKnownGood: Record<string, PublishedGeneration>;
}

/** Read the worker state file (undefined when absent/unparseable). */
export function readWorkerState(
  env: NodeJS.ProcessEnv = process.env,
): FreshnessWorkerState | undefined {
  return readJson<FreshnessWorkerState>(statePath(env));
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence probe
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM means it exists but is owned by someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ─── the worker ──────────────────────────────────────────────────────────────

/**
 * The port integration injects: actually revalidate this project at `task.head`.
 * `actualHead` is what the port ACTUALLY processed — a child whose repo moved mid-run reports the
 * real head, and the supervisor publishes THAT (WP5.2: never stamp a newer result with the queued HEAD).
 */
export type RevalidateFn = (task: FreshnessTask) => Promise<{
  generation: string;
  actualHead?: string;
}>;

export interface FreshnessWorkerOpts {
  env?: NodeJS.ProcessEnv;
  /**
   * The revalidation implementation (memory evaluator + soul update). Required unless `runTask`
   * is provided: the default runner executes this IN-PROCESS (the unit-test seam).
   */
  revalidate?: RevalidateFn;
  /**
   * WP5.1: how one task's revalidation actually runs. The production wiring passes the real
   * forked runner ({@link forkTaskRunner}) so synchronous parsing cannot block this supervisor's
   * loop; the default wraps `revalidate` in-process. Either way the runner's ONLY output is a
   * staged result — activation stays here, fenced.
   */
  runTask?: TaskRunner;
  /** Poll interval for the work loop; default 500ms. */
  pollMs?: number;
  /** Heartbeat write interval (the lease liveness signal); default 2000ms. */
  heartbeatMs?: number;
  /** A worker whose heartbeat is older than this is presumed crashed; default 15000ms. */
  leaseTtlMs?: number;
  /** Failed attempts before a task dead-letters; default 3 (mirrors the capture outbox). */
  maxAttempts?: number;
  /** Retry backoff base after a failure; default 1000ms (doubles per attempt). */
  retryBackoffMs?: number;
  /** Injected clock for lease/heartbeat/backoff decisions and bookkeeping stamps. Never an id input. */
  now?: () => number;
  /** Observability hook for lifecycle + task events (integration surfaces these in status). */
  onEvent?: (event: FreshnessWorkerEvent) => void;
}

export type FreshnessWorkerEvent =
  | { kind: 'started'; pid: number; recovered: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'task-start'; task: FreshnessTask }
  | { kind: 'task-done'; task: FreshnessTask; generation: string }
  | { kind: 'task-retry'; task: FreshnessTask; error: string }
  | { kind: 'task-dead'; task: FreshnessTask; error: string }
  /** WP5.5: a stuck task was cancelled — its child was killed, its late publication refused. */
  | { kind: 'task-cancelled'; task: FreshnessTask; reason: string }
  /** A staged result was discarded without activation (aborted child / stale epoch). */
  | { kind: 'task-discarded'; task: FreshnessTask; reason: string }
  | { kind: 'heartbeat' }
  /** This worker's lease was taken by another owner; it halted rather than write over that owner. */
  | { kind: 'superseded'; epoch: number; byPid?: number }
  | { kind: 'stopped' };

/** Error thrown by {@link FreshnessWorker.start} when a live worker already holds the lease. */
export class WorkerAlreadyRunningError extends Error {
  constructor(pid: number) {
    super(`freshness worker already running (pid ${pid})`);
    this.name = 'WorkerAlreadyRunningError';
  }
}

/**
 * The durable background freshness worker (red line #5).
 *
 * DURABILITY MECHANICS (mirroring the G2.2 outbox's ordering law — durable result first,
 * bookkeeping last, every crash window heals as an idempotent no-op):
 *   - queue: `freshness/queue.json`, atomic temp→rename, survives process death by construction.
 *   - lease: `freshness/worker-state.json` carries pid + heartbeatAt + epoch. Start refuses while
 *     the holder is alive AND its heartbeat is fresh; takes over otherwise (crashed owner). Since
 *     WP5 the revalidation runs in a CHILD, a healthy supervisor heartbeats straight through the
 *     work — a live owner with a stale heartbeat is a genuinely stalled process, and takeover at
 *     TTL is safe: every owned write is fenced by the epoch token, and its surrender path kills
 *     its obsolete child. The former ten-minute busy grace is retired (WP5.1).
 *   - crash recovery: a takeover re-enqueues the crashed worker's `activeTask` (it was leased but
 *     never finished — at-least-once revalidation; re-running at the same HEAD re-derives the same
 *     generation, so redelivery is idempotent). A crashed supervisor's orphaned child exits on
 *     `disconnect` and refuses to stage for a dead supervisor pid (WP5.3).
 *   - publication order: revalidate (in the child) → staged result → ACTIVATION, which is the
 *     supervisor's fenced commit: publishGeneration (durable result) → lastKnownGood in state →
 *     dequeue. A crash between staging and activation re-runs the task and publishes the SAME
 *     generation. A failed revalidation publishes NOTHING: the prior generation file and the
 *     lastKnownGood entry stand — never a broken index.
 *   - coalescing: the enqueue path guarantees ≤1 pending entry per project, so a commit burst
 *     collapses to one revalidation at the newest HEAD.
 *   - cancellation (WP5.5): any process writes a durable cancel request; the supervisor's sweep
 *     (on the heartbeat, which fires THROUGH child work) kills the in-flight child or drops the
 *     pending entry, and activation refuses a racing late result from the cancelled run.
 */
export class FreshnessWorker {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runTask: TaskRunner;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly now: () => number;
  private readonly onEvent: (event: FreshnessWorkerEvent) => void;

  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private running = false;
  private busy = false;
  private state?: FreshnessWorkerState;
  /** This worker's fencing token, assigned by the election. 0 until `start()` wins the lease. */
  private epoch = 0;
  /** Set once the lease was observed to belong to someone else — latches, never un-set. */
  private superseded = false;
  /** Resolves when the in-flight task finishes — `stop()` awaits it (no task torn mid-flight). */
  private current?: Promise<void>;
  /** WP5.5 — abort channel for the in-flight run: cancellation and surrender fire it. */
  private activeAbort?: AbortController;
  /**
   * WP5.5 — runs whose late publication must be refused (`taskId@enqueuedAt`, one-shot: consumed
   * at the refusal so a later re-enqueue of the same content-addressed id is a fresh run).
   */
  private readonly cancelledRuns = new Set<string>();

  constructor(private readonly opts: FreshnessWorkerOpts) {
    this.env = opts.env ?? process.env;
    const runner =
      opts.runTask ??
      (opts.revalidate ? inProcessTaskRunner(opts.revalidate, this.env) : undefined);
    if (!runner) {
      throw new Error(
        'FreshnessWorker requires a revalidate(task) or runTask(descriptor, signal) implementation',
      );
    }
    this.runTask = runner;
    this.pollMs = opts.pollMs ?? 500;
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
    this.leaseTtlMs = opts.leaseTtlMs ?? 15_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryBackoffMs = opts.retryBackoffMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * Claim the lease (or throw {@link WorkerAlreadyRunningError}), recover any crashed predecessor's
   * in-flight task, and start the poll + heartbeat loops. Idempotent-safe: calling start twice on
   * the same instance is a no-op on the second call.
   */
  async start(): Promise<void> {
    if (this.running) return;
    mkdirSync(freshnessDir(this.env), { recursive: true });

    // ELECTION — the read-check-write is ONE critical section under the lease lock.
    //
    // The audited defect (R01) was that this sequence ran unlocked: N processes starting together
    // each read "no live holder", each wrote its own state, and each believed it owned the lease.
    // Twelve trials of eight contenders admitted 5-8 owners. Serializing the whole decision means
    // the second contender necessarily reads the first's freshly written, fresh-heartbeat state.
    const outcome = withFreshnessLock(
      this.env,
      LEASE_LOCK,
      ():
        | { won: true; state: FreshnessWorkerState; orphan?: FreshnessTask }
        | { won: false; holderPid: number } => {
        const existing = readWorkerState(this.env);
        // WP5.1: the revalidation runs in a CHILD, so a healthy holder's heartbeat never ages
        // during work — a live holder with a stale heartbeat is a genuinely stalled process, and
        // taking it over at TTL is safe: its owned writes are all fenced (they will be refused,
        // not applied), and its surrender path kills its obsolete child. The retired ten-minute
        // busy grace used to shield the stalled owner here; it also shielded real stalls.
        if (existing && isPidAlive(existing.pid) && this.heartbeatFresh(existing)) {
          return { won: false, holderPid: existing.pid };
        }
        const stamp = new Date(this.now()).toISOString();
        const state: FreshnessWorkerState = {
          pid: process.pid,
          epoch: (existing?.epoch ?? 0) + 1,
          startedAt: stamp,
          heartbeatAt: stamp,
          // CARRY the predecessor's leased task into our own state before we own it. If we die
          // between winning the lease and re-enqueueing below, the task is still reachable as an
          // `activeTask` for the NEXT takeover — dropping it here would lose it in that window.
          ...(existing?.activeTask ? { activeTask: existing.activeTask } : {}),
          lastKnownGood: existing?.lastKnownGood ?? {},
        };
        writeJsonAtomic(statePath(this.env), state);
        return {
          won: true,
          state,
          ...(existing?.activeTask ? { orphan: existing.activeTask } : {}),
        };
      },
    );

    if (!outcome.won) {
      this.onEvent({ kind: 'refused', reason: `live worker pid ${outcome.holderPid}` });
      throw new WorkerAlreadyRunningError(outcome.holderPid);
    }

    this.state = outcome.state;
    this.epoch = outcome.state.epoch ?? 0;
    this.superseded = false;

    // Recover the crashed predecessor's in-flight task back into the pending queue. Under the
    // queue lock so a concurrent producer's enqueue is not clobbered; the id dup-check makes a
    // repeated takeover idempotent.
    let recovered = 0;
    const orphan = outcome.orphan;
    if (orphan) {
      recovered = mutateFreshnessQueue(this.env, (q) => {
        if (q.pending.some((t) => t.id === orphan.id)) return 0;
        q.pending.push({ ...orphan, notBeforeMs: undefined });
        return 1;
      });
      // Bookkeeping last: the task is durably pending before we stop calling it ours. A crash
      // here re-runs the same idempotent recovery.
      this.state.activeTask = undefined;
      this.writeOwnedState();
    }

    this.running = true;
    this.onEvent({ kind: 'started', pid: process.pid, recovered });

    this.pollTimer = setInterval(() => void this.tick(), this.pollMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    // First tick immediately, but NOT awaited: start() must resolve even when the first task hangs
    // (a slow revalidation is background work — the caller is never blocked on it, mirroring how
    // `crib serve --watch` starts).
    void this.tick();
  }

  /**
   * Stop cleanly: halt the loops, let any in-flight task FINISH (never torn mid-revalidation),
   * release the lease (the state file is removed so the next start needs no takeover), and leave
   * pending queue entries for the next worker. Resolves only after the task boundary.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    await this.current;
    // Fenced release: only the CURRENT owner may remove the lease file. A worker that was already
    // superseded must not delete its successor's state on the way out — that would hand the lease
    // to the next arbitrary starter while the real owner is still working.
    withFreshnessLock(this.env, LEASE_LOCK, () => {
      const onDisk = readWorkerState(this.env);
      if (onDisk && this.ownsLease(onDisk)) rmSync(statePath(this.env), { force: true });
    });
    this.state = undefined;
    this.onEvent({ kind: 'stopped' });
  }

  /**
   * Simulate a hard crash for tests: stop the loops WITHOUT releasing the lease or clearing the
   * active task — exactly the on-disk state a killed process leaves behind. The next
   * {@link start} must refuse while the heartbeat is fresh and take over once it goes stale.
   */
  abandonForTest(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    this.running = false;
  }

  /** Whether this instance currently holds the lease. */
  get isRunning(): boolean {
    return this.running;
  }

  /** The task currently leased (in flight) by this worker, if any. */
  get inFlight(): FreshnessTask | undefined {
    return this.state?.activeTask;
  }

  /** Last-known-good generations recorded by this worker instance (durable view via {@link readWorkerState}). */
  get lastKnownGood(): Record<string, PublishedGeneration> {
    return this.state?.lastKnownGood ?? {};
  }

  /** Does the on-disk lease still name THIS process and THIS election? */
  private ownsLease(onDisk: FreshnessWorkerState): boolean {
    return onDisk.pid === process.pid && (onDisk.epoch ?? 0) === this.epoch;
  }

  /**
   * The one way this worker is allowed to write its state: under the lease lock, and only while
   * the on-disk lease still matches this election's fencing token.
   *
   * `apply` mutates `this.state` in place and may perform the durable publication that must land
   * with the same ownership decision. Returns false when the lease moved on — the caller must then
   * abandon the write entirely rather than fall back to an unfenced one.
   */
  private writeOwnedState(apply?: () => void): boolean {
    if (!this.state) return false;
    const ok = withFreshnessLock(this.env, LEASE_LOCK, () => {
      const onDisk = readWorkerState(this.env);
      if (!onDisk || !this.ownsLease(onDisk)) return false;
      apply?.();
      writeJsonAtomic(statePath(this.env), this.state);
      return true;
    });
    if (!ok) this.surrender();
    return ok;
  }

  /**
   * Stand down: another owner holds the lease. Halt the loops without touching the state file —
   * the successor's lease and its recovery of our leased task are both already correct, and any
   * write from here would be exactly the clobber the fencing token exists to prevent.
   */
  private surrender(): void {
    if (this.superseded) return;
    this.superseded = true;
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.pollTimer = undefined;
    this.heartbeatTimer = undefined;
    // WP5.2 — terminate the obsolete child: its result could never be activated under this
    // (now lost) lease, so letting it run would only hold the repo open for nothing.
    this.activeAbort?.abort();
    const holder = readWorkerState(this.env);
    this.onEvent({
      kind: 'superseded',
      epoch: this.epoch,
      ...(holder ? { byPid: holder.pid } : {}),
    });
  }

  /** The heartbeat: the lease liveness signal, written atomically and under the fence. */
  private heartbeat(): void {
    if (!this.running || !this.state) return;
    try {
      const stamp = new Date(this.now()).toISOString();
      // Renewing through the fence is also how a stalled worker DISCOVERS it was replaced: the
      // first heartbeat after the takeover fails the epoch check and stands the worker down.
      if (
        !this.writeOwnedState(() => {
          this.state!.heartbeatAt = stamp;
        })
      ) {
        return;
      }
      this.onEvent({ kind: 'heartbeat' });
    } catch {
      // A heartbeat runs on a timer with no caller to catch for it. Lock contention or a transient
      // FS error must not become an unhandled rejection that kills the host process; the lease
      // simply ages, and a genuinely dead worker is taken over on TTL as designed.
    }
    // The sweep rides the heartbeat because the heartbeat fires THROUGH a child's work — that is
    // the whole point of the WP5 split: cancellation takes effect while the child is still running.
    try {
      this.sweepCancellationRequests();
    } catch {
      // A sweep failure must never take the heartbeat loop down with it.
    }
  }

  private heartbeatFresh(s: FreshnessWorkerState): boolean {
    return this.now() - Date.parse(s.heartbeatAt) < this.leaseTtlMs;
  }

  /** WP5.5 — the one-shot refusal key: the task id plus the run's enqueue stamp, so a later
   *  re-enqueue of the same content-addressed id is a fresh run, never a refused one. */
  private cancelRunKey(task: FreshnessTask): string {
    return `${task.id}@${task.enqueuedAt}`;
  }

  /**
   * WP5.5 — consume durable cancellation requests. For an IN-FLIGHT task: mark the run for
   * late-publication refusal, kill the child, and let the run's own abort path release the lease.
   * For a QUEUED task: remove it under the queue lock — it never runs and is never requeued.
   * A request matching neither is LEFT for a later claim window and pruned by age.
   */
  private sweepCancellationRequests(): void {
    if (!this.running || this.superseded || !this.state) return;
    const requests = readCancellationRequests(this.env);
    for (const req of requests) {
      const active = this.state.activeTask;
      if (active && active.id === req.taskId) {
        this.cancelledRuns.add(this.cancelRunKey(active));
        consumeCancellationRequest(this.env, req.taskId);
        this.activeAbort?.abort();
        continue;
      }
      let cancelled: FreshnessTask | undefined;
      const removed = mutateFreshnessQueue(this.env, (q) => {
        const idx = q.pending.findIndex((t) => t.id === req.taskId);
        if (idx === -1) return false;
        cancelled = q.pending[idx]!;
        q.pending.splice(idx, 1);
        return true;
      });
      if (removed && cancelled) {
        consumeCancellationRequest(this.env, req.taskId);
        this.onEvent({ kind: 'task-cancelled', task: cancelled, reason: 'cancelled while queued' });
      }
    }
    // Bounded residue: stale requests (their task never appeared) and staged files from crashed
    // children (inert by epoch) both age out.
    const DAY_MS = 24 * 60 * 60_000;
    pruneCancellationRequests(this.env, DAY_MS, this.now);
    pruneStagedResults(this.env, DAY_MS, this.now);
  }

  /** One serialized work step: claim → lease → revalidate → publish → dequeue. Never re-entrant. */
  private async tick(): Promise<void> {
    if (!this.running || this.busy) return;
    const task = this.claim();
    if (!task) return;
    this.busy = true;
    this.current = this.run(task).finally(() => {
      this.busy = false;
      this.current = undefined;
    });
    await this.current;
  }

  /** Lease the next eligible pending task (FIFO by enqueue order, skipping backoff windows). */
  private claim(): FreshnessTask | undefined {
    if (!this.state || this.superseded) return undefined;
    const nowMs = this.now();
    const task = mutateFreshnessQueue(this.env, (q) => {
      const idx = q.pending.findIndex((candidate) => (candidate.notBeforeMs ?? 0) <= nowMs);
      if (idx === -1) return undefined;
      const next = q.pending[idx]!;
      const priorActive = this.state!.activeTask;
      // Lease FIRST (durable in state), remove from pending SECOND: a crash in the window leaves
      // the task in BOTH, which heals idempotently on takeover. The reverse order could orphan it.
      // The lease write is FENCED, and the dequeue happens only if it lands — so a superseded
      // worker cannot quietly consume a task that its successor is also entitled to run.
      if (
        !this.writeOwnedState(() => {
          this.state!.activeTask = next;
        })
      ) {
        this.state!.activeTask = priorActive;
        return undefined;
      }
      q.pending = q.pending.filter((_, i) => i !== idx);
      return next;
    });
    if (!task) return undefined;
    this.onEvent({ kind: 'task-start', task });
    return task;
  }

  /**
   * Run one task through the WP5 protocol: hand the child the descriptor, await its STAGED result,
   * and activate it here — inside the fenced commit, after re-checking epoch and cancellation.
   */
  private async run(task: FreshnessTask): Promise<void> {
    if (!this.state) return;
    // The abort channel is the cancellation/lease-loss path (WP5.2/WP5.5): the sweep fires it for
    // a cancelled run, surrender fires it when the lease is lost, and the runner terminates its
    // child. A staged result that still races through is refused at activation.
    const controller = new AbortController();
    this.activeAbort = controller;
    const descriptor: ChildTaskDescriptor = {
      taskId: task.id,
      projectRoot: task.projectRoot,
      head: task.head,
      epoch: this.epoch,
      supervisorPid: process.pid,
    };
    try {
      const staged = await this.runTask(descriptor, controller.signal);
      if (controller.signal.aborted || staged.epoch !== this.epoch) {
        // A result from a killed child, or one commissioned by an obsolete election: discard it
        // without activation. The task itself is owned by whoever holds the lease now (the
        // successor recovered it, or the cancellation already ended the run).
        this.onEvent({
          kind: 'task-discarded',
          task,
          reason: controller.signal.aborted ? 'run aborted' : 'stale epoch',
        });
        // ...but the CLAIM must not leak: the task was taken off the queue when it was leased,
        // so leaving activeTask set would drop it between the two — lost AND reported busy.
        // Fenced: a superseded worker's clear fails harmlessly (its successor recovered the task).
        this.writeOwnedState(() => {
          this.state!.activeTask = undefined;
        });
        return;
      }
      const published: PublishedGeneration = {
        projectRoot: task.projectRoot,
        generation: staged.generation,
        // WP5.2 honesty: publish the head the child ACTUALLY processed — never stamp a newer
        // result with the original queued HEAD.
        head: staged.actualHead,
        publishedAt: new Date(this.now()).toISOString(),
      };
      // ACTIVATION — the supervisor's job and ONLY here: publication, bookkeeping and the
      // acknowledgement land together inside one lease-locked, epoch-checked commit. An owner
      // that lost the lease mid-flight cannot publish (its successor recovered the task), and a
      // CANCELLED task refuses its racing late publication inside the same critical section.
      let refused = false;
      if (
        !this.writeOwnedState(() => {
          const key = this.cancelRunKey(task);
          if (this.cancelledRuns.has(key)) {
            this.cancelledRuns.delete(key); // one-shot: consume at the refusal
            this.state!.activeTask = undefined;
            refused = true;
            return;
          }
          publishGeneration(task.projectRoot, published, this.env);
          this.state!.lastKnownGood[task.projectRoot] = published;
          this.state!.activeTask = undefined;
        })
      ) {
        return; // superseded — nothing published, successor owns the task
      }
      clearStagedResult(this.env, task.id);
      if (refused) {
        this.onEvent({ kind: 'task-cancelled', task, reason: 'late result refused' });
        return;
      }
      this.onEvent({ kind: 'task-done', task, generation: staged.generation });
    } catch (err) {
      if (controller.signal.aborted) {
        // The run was killed by cancellation or by lease loss. Cancellation is terminal for this
        // run: release the lease, publish nothing, requeue nothing. A superseded worker stays
        // silent — its successor recovered this exact task on takeover.
        const key = this.cancelRunKey(task);
        if (this.cancelledRuns.has(key)) {
          this.cancelledRuns.delete(key);
          this.writeOwnedState(() => {
            this.state!.activeTask = undefined;
          });
          this.onEvent({ kind: 'task-cancelled', task, reason: 'child terminated' });
        }
        return;
      }
      const message = (err as Error).message ?? String(err);
      const attempts = task.attempts + 1;
      const failed: FreshnessTask = { ...task, attempts };
      // Requeue-or-dead-letter and the lease release are ONE fenced decision. A superseded worker
      // must not re-enqueue here: its successor already recovered this exact task on takeover, so
      // an unfenced retry push would duplicate it and break the ≤1-pending-per-project law.
      const committed = mutateFreshnessQueue(this.env, (q) =>
        this.writeOwnedState(() => {
          if (attempts >= this.maxAttempts) {
            // Dead-letter = lifecycle transition, never a delete (the team-ledger rule, applied to
            // the queue): the failed entry stays auditable in `dead` with its last error.
            q.dead = [...q.dead, { ...failed, notBeforeMs: undefined }];
          } else {
            q.pending = [
              ...q.pending,
              { ...failed, notBeforeMs: this.now() + this.retryBackoff(attempts) },
            ];
          }
          this.state!.activeTask = undefined;
        }),
      );
      if (!committed) return;
      if (attempts >= this.maxAttempts)
        this.onEvent({ kind: 'task-dead', task: failed, error: message });
      else this.onEvent({ kind: 'task-retry', task: failed, error: message });
      // The red line lives here: NOTHING was published on this path. The prior generation file and
      // the prior lastKnownGood entry are untouched — the failed refresh cannot break the index.
      //
      // The state file was ALREADY persisted fenced: `writeOwnedState` inside `mutateFreshnessQueue`
      // cleared `activeTask` and wrote it under the lease lock (line above). The old code repeated
      // that write here UNFENCED — a worker whose lease expired in the microseconds between the two
      // writes would clobber its successor's freshly-won state with a stale in-memory copy, the
      // exact clobber the fencing token exists to prevent. The redundancy is deleted, not re-fenced.
    } finally {
      if (this.activeAbort === controller) this.activeAbort = undefined;
    }
  }

  private retryBackoff(attempts: number): number {
    return this.retryBackoffMs * 2 ** (attempts - 1);
  }
}

/** Convenience constructor + start for the integration layer's CLI wiring. */
export async function runFreshnessWorker(opts: FreshnessWorkerOpts): Promise<FreshnessWorker> {
  const worker = new FreshnessWorker(opts);
  await worker.start();
  return worker;
}

// ─── status / doctor surface (structured data for integration) ───────────────

/** Structured freshness state for `crib status` / `crib doctor` to surface. */
export interface FreshnessStatus {
  mode: FreshnessMode;
  /** Was a mode explicitly persisted, or is this the default? (doctor distinguishes the two). */
  modeExplicit: boolean;
  /** true when a live worker holds the freshness lease — heartbeating, OR busy (see below). */
  workerRunning: boolean;
  /**
   * true when the lease holder is ALIVE and owns a leased task, independent of heartbeat
   * freshness. Before WP5 this meant "a synchronous revalidation is blocking its own timer";
   * revalidation now runs in a child, so a busy worker normally heartbeats too — and one whose
   * heartbeat goes stale while holding a task is a stalled supervisor worth surfacing, not a
   * dead process. Either way, holding a live task means it is NOT dead: takeover waits for the
   * lease TTL, and the fence guarantees a stalled owner cannot clobber its successor.
   */
  workerBusy: boolean;
  /** pid of the lease holder when readable. */
  workerPid?: number;
  /** The task currently in flight on the lease holder, if any. */
  inFlight?: FreshnessTask;
  /** Queue depth for this project. */
  pending: number;
  /** Dead-lettered (exhausted) tasks for this project — doctor should surface these. */
  dead: number;
  /** The last successfully published generation, if any. */
  lastKnownGood?: PublishedGeneration;
  /** Current VCS head (best-effort; undefined outside a git repo or when headReader is absent). */
  currentHead?: string;
  /** true when the published generation's head is BEHIND the current VCS head. */
  behindHead: boolean;
}

export interface FreshnessStatusOpts {
  env?: NodeJS.ProcessEnv;
  /** Injected head reader (tests); default shells `git rev-parse HEAD` best-effort. */
  headReader?: (projectRoot: string) => string | undefined;
  /**
   * The lease TTL the heartbeat is judged against — the same value the WORKER was constructed with.
   * Default 15s (the worker's default leaseTtlMs). The old code hardcoded 15_000 here while the
   * worker read its own `opts.leaseTtlMs`: a deployment that tuned the lease left the status view
   * judging heartbeats against a window the worker was never held to, reporting a healthy worker
   * as dead or a dead one as alive.
   */
  leaseTtlMs?: number;
}

function gitHead(projectRoot: string): string | undefined {
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined; // not a git repo / no commits yet — behindHead stays false (nothing to be behind)
  }
}

/**
 * The status/doctor view: mode + in-flight + behind-HEAD, all structured, no I/O beyond the
 * registry/queue/state reads and one head lookup. Best-effort everywhere — a doctor check must
 * never throw on a half-initialized project.
 */
export function freshnessStatus(
  projectRoot: string,
  opts: FreshnessStatusOpts = {},
): FreshnessStatus {
  const env = opts.env ?? process.env;
  const readHead = opts.headReader ?? gitHead;
  const leaseTtlMs = opts.leaseTtlMs ?? 15_000;
  const entry = lookupProject(projectRoot, env);
  const mode = resolveFreshnessMode(entry?.freshnessMode);
  const state = readWorkerState(env);
  const alive = state !== undefined && isPidAlive(state.pid);
  const beating = state !== undefined && Date.now() - Date.parse(state.heartbeatAt) < leaseTtlMs;
  /**
   * BUSY IS NOT DEAD — and since WP5, busy no longer implies stalled either.
   *
   * Revalidation runs in a forked child, so a worker holding a task normally keeps heartbeating;
   * `workerBusy` reports task ownership independent of heartbeat freshness (WP5.1 keeps it as an
   * operational status). A live pid still holding a leased task is BUSY even when its heartbeat
   * has aged — that combination used to mean "healthy but blocked" and now means "stalled
   * supervisor"; either way it is not a dead process, and the epoch fence means the takeover
   * after the lease TTL is safe.
   */
  const workerBusy = alive && state?.activeTask !== undefined;
  const workerRunning = alive && (beating || workerBusy);
  const q = readFreshnessQueue(env);
  const last = readPublishedGeneration(projectRoot, env);
  const head = readHead(projectRoot);
  return {
    mode,
    modeExplicit: parseFreshnessMode(entry?.freshnessMode) !== undefined,
    workerRunning,
    workerBusy,
    ...(state && workerRunning ? { workerPid: state.pid } : {}),
    ...(state?.activeTask ? { inFlight: state.activeTask } : {}),
    pending: q.pending.filter((t) => t.projectRoot === projectRoot).length,
    dead: q.dead.filter((t) => t.projectRoot === projectRoot).length,
    ...(last ? { lastKnownGood: last } : {}),
    ...(head !== undefined ? { currentHead: head } : {}),
    behindHead: last !== undefined && head !== undefined && last.head !== head,
  };
}
