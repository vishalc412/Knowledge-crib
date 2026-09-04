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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  const tmp = `${path}.tmp`;
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

/**
 * Content-addressed task id: `fq:` over (projectRoot ␀ head). Deterministic, so a re-enqueue of
 * the same (project, head) re-derives the same id and coalescing can compare ids instead of
 * trusting wall-clock ordering. No Date.now/new Date anywhere near this — wall-clock law.
 */
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
  const q = readFreshnessQueue(env);
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
  writeQueue(q, env);
  return { id, coalesced };
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence probe
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM means it exists but is owned by someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ─── the worker ──────────────────────────────────────────────────────────────

/** The port integration injects: actually revalidate this project at `task.head`. */
export type RevalidateFn = (task: FreshnessTask) => Promise<{ generation: string }>;

export interface FreshnessWorkerOpts {
  env?: NodeJS.ProcessEnv;
  /** The revalidation implementation (memory evaluator + soul update). Required. */
  revalidate: RevalidateFn;
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
  | { kind: 'heartbeat' }
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
 *   - lease: `freshness/worker-state.json` carries pid + heartbeatAt. Start refuses while the
 *     holder is alive AND its heartbeat is fresh; takes over otherwise (crashed owner).
 *   - crash recovery: a takeover re-enqueues the crashed worker's `activeTask` (it was leased but
 *     never finished — at-least-once revalidation; re-running at the same HEAD re-derives the same
 *     generation, so redelivery is idempotent).
 *   - publication order: revalidate → publishGeneration (durable result) → lastKnownGood in state
 *     → dequeue. A crash between publish and dequeue re-runs the task and re-publishes the SAME
 *     generation. A failed revalidation publishes NOTHING: the prior generation file and the
 *     lastKnownGood entry stand — never a broken index.
 *   - coalescing: the enqueue path guarantees ≤1 pending entry per project, so a commit burst
 *     collapses to one revalidation at the newest HEAD.
 */
export class FreshnessWorker {
  private readonly env: NodeJS.ProcessEnv;
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
  /** Resolves when the in-flight task finishes — `stop()` awaits it (no task torn mid-flight). */
  private current?: Promise<void>;

  constructor(private readonly opts: FreshnessWorkerOpts) {
    if (typeof opts.revalidate !== 'function') {
      throw new Error('FreshnessWorker requires a revalidate(task) implementation');
    }
    this.env = opts.env ?? process.env;
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
    const existing = readWorkerState(this.env);
    if (existing && isPidAlive(existing.pid) && this.heartbeatFresh(existing)) {
      this.onEvent({ kind: 'refused', reason: `live worker pid ${existing.pid}` });
      throw new WorkerAlreadyRunningError(existing.pid);
    }

    // Takeover (fresh boot or crashed predecessor): recover the crashed worker's active task back
    // into the pending queue BEFORE claiming anything, so no leased work is ever orphaned.
    let recovered = 0;
    const q = readFreshnessQueue(this.env);
    if (existing?.activeTask) {
      if (!q.pending.some((t) => t.id === existing.activeTask!.id)) {
        q.pending.push({ ...existing.activeTask, notBeforeMs: undefined });
        recovered = 1;
      }
      writeQueue(q, this.env);
    }

    this.state = {
      pid: process.pid,
      startedAt: new Date(this.now()).toISOString(),
      heartbeatAt: new Date(this.now()).toISOString(),
      lastKnownGood: existing?.lastKnownGood ?? {},
    };
    writeJsonAtomic(statePath(this.env), this.state);
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
    rmSync(statePath(this.env), { force: true });
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

  /** The heartbeat: the lease liveness signal, written atomically. */
  private heartbeat(): void {
    if (!this.running || !this.state) return;
    this.state.heartbeatAt = new Date(this.now()).toISOString();
    writeJsonAtomic(statePath(this.env), this.state);
    this.onEvent({ kind: 'heartbeat' });
  }

  private heartbeatFresh(s: FreshnessWorkerState): boolean {
    return this.now() - Date.parse(s.heartbeatAt) < this.leaseTtlMs;
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
    if (!this.state) return undefined;
    const q = readFreshnessQueue(this.env);
    const nowMs = this.now();
    const idx = q.pending.findIndex((t) => (t.notBeforeMs ?? 0) <= nowMs);
    if (idx === -1) return undefined;
    const task = q.pending[idx]!;
    // Lease FIRST (durable in state), remove from pending SECOND: a crash in the window leaves the
    // task in BOTH, which heals idempotently — the next start sees the stale lease, re-enqueues (the
    // dup check no-ops because the task is still pending), and the task re-runs. The reverse order
    // could orphan a leased task that exists in NEITHER file, which is the one unrecoverable window.
    this.state.activeTask = task;
    writeJsonAtomic(statePath(this.env), this.state);
    q.pending = q.pending.filter((_, i) => i !== idx);
    writeQueue(q, this.env);
    this.onEvent({ kind: 'task-start', task });
    return task;
  }

  /** Run one revalidation with the publish ordering that guarantees last-known-good survival. */
  private async run(task: FreshnessTask): Promise<void> {
    if (!this.state) return;
    try {
      const { generation } = await this.opts.revalidate(task);
      // Durable result first: the generation file is on disk before ANY bookkeeping acknowledges it.
      const published: PublishedGeneration = {
        projectRoot: task.projectRoot,
        generation,
        head: task.head,
        publishedAt: new Date(this.now()).toISOString(),
      };
      publishGeneration(task.projectRoot, published, this.env);
      this.state.lastKnownGood[task.projectRoot] = published;
      this.state.activeTask = undefined;
      writeJsonAtomic(statePath(this.env), this.state);
      this.onEvent({ kind: 'task-done', task, generation });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const attempts = task.attempts + 1;
      const failed: FreshnessTask = { ...task, attempts };
      const q = readFreshnessQueue(this.env);
      if (attempts >= this.maxAttempts) {
        // Dead-letter = lifecycle transition, never a delete (the team-ledger rule, applied to the
        // queue): the failed entry stays auditable in `dead` with its last error.
        q.dead = [...q.dead, { ...failed, notBeforeMs: undefined }];
        writeQueue(q, this.env);
        this.onEvent({ kind: 'task-dead', task: failed, error: message });
      } else {
        q.pending = [
          ...q.pending,
          { ...failed, notBeforeMs: this.now() + this.retryBackoff(attempts) },
        ];
        writeQueue(q, this.env);
        this.onEvent({ kind: 'task-retry', task: failed, error: message });
      }
      // The red line lives here: NOTHING was published on this path. The prior generation file and
      // the prior lastKnownGood entry are untouched — the failed refresh cannot break the index.
      this.state.activeTask = undefined;
      writeJsonAtomic(statePath(this.env), this.state);
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
  /** true when a live worker (fresh heartbeat, alive pid) holds the freshness lease. */
  workerRunning: boolean;
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
  const entry = lookupProject(projectRoot, env);
  const mode = resolveFreshnessMode(entry?.freshnessMode);
  const state = readWorkerState(env);
  const workerRunning =
    state !== undefined &&
    isPidAlive(state.pid) &&
    Date.now() - Date.parse(state.heartbeatAt) < 15_000;
  const q = readFreshnessQueue(env);
  const last = readPublishedGeneration(projectRoot, env);
  const head = readHead(projectRoot);
  return {
    mode,
    modeExplicit: parseFreshnessMode(entry?.freshnessMode) !== undefined,
    workerRunning,
    ...(state && workerRunning ? { workerPid: state.pid } : {}),
    ...(state?.activeTask ? { inFlight: state.activeTask } : {}),
    pending: q.pending.filter((t) => t.projectRoot === projectRoot).length,
    dead: q.dead.filter((t) => t.projectRoot === projectRoot).length,
    ...(last ? { lastKnownGood: last } : {}),
    ...(head !== undefined ? { currentHead: head } : {}),
    behindHead: last !== undefined && head !== undefined && last.head !== head,
  };
}
