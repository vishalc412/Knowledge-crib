/**
 * Cross-process advisory lock for the `.crib` derived-state directory.
 *
 * Two `crib index` / `crib update` processes (or an MCP `enrich_save` running alongside a
 * reindex) must not mutate the sqlite index concurrently — the soul is the committed source of
 * truth and tolerates concurrent reads, but the derived `.crib/index` store does not. This lock
 * serializes the writers.
 *
 * Mechanism: an exclusive-create (O_EXCL) file at `<cribDir>/.lock` holding the holder's pid.
 * `acquire()`:
 *   - tries `openSync(path, 'wx')` — atomically wins or learns someone else holds it;
 *   - if it loses, it checks staleness: a lock is stale when its holder pid is dead
 *     (process.kill(pid, 0) → ESRCH) OR the lock file is older than `staleMs` (default 10 min);
 *   - a stale lock is unlinked and recreated (stolen); a live, fresh lock throws LockBusyError.
 * `release()` unlinks the file only when it still carries our own pid (so a stolen-then-released
 * lock never clobbers a new holder). Stale detection makes a crashed `crib` self-healing on the
 * next run — no manual `rm .crib/.lock`.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';

/** Default age at which a lock is reclaimable even if its pid probe is inconclusive. */
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** Thrown when the crib is locked by a live process and cannot be acquired. */
export class LockBusyError extends Error {
  constructor(
    readonly holderPid: number,
    message: string,
  ) {
    super(message);
    this.name = 'LockBusyError';
  }
}

export interface CribLockOptions {
  /** The `.crib` directory the lock file lives in. Created if missing. */
  cribDir: string;
  /** Lock file name inside `cribDir`. Defaults to `.lock`. */
  lockName?: string;
  /** Age in ms after which a held lock is considered stale and reclaimable. */
  staleMs?: number;
}

/**
 * Is a process with `pid` currently running?
 *
 * `process.kill(pid, 0)` sends no signal — it only probes liveness. It throws:
 *   - ESRCH: no such process → dead.
 *   - EPERM: process exists but we lack permission → alive, held by another user.
 *   - EINVAL/anything else: treat as stale (bad pid) — the next acquire will recreate a clean lock.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') return true; // exists, owned by another user
    return false; // ESRCH / EINVAL / other → treat as dead or invalid
  }
}

/** Cross-process advisory lock on a `.crib` directory. */
export class CribLock {
  private readonly path: string;
  private readonly staleMs: number;
  private held = false;

  constructor(opts: CribLockOptions) {
    this.path = join(opts.cribDir, opts.lockName ?? '.lock');
    this.staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  }

  /** Absolute path of the lock file. */
  get lockPath(): string {
    return this.path;
  }

  /** True once `acquire()` has succeeded and `release()` has not yet run. */
  get isHeld(): boolean {
    return this.held;
  }

  /**
   * Acquire the lock or throw `LockBusyError`. Idempotent for an already-held lock on this
   * instance. Recovers automatically from a stale lock left by a crashed process.
   */
  acquire(): void {
    if (this.held) return;
    mkdirSync(dirname(this.path), { recursive: true });
    if (this.tryCreate(this.path)) {
      this.held = true;
      return;
    }
    // Someone else holds the file. Steal it iff it is stale; otherwise fail loudly.
    if (!this.isStale()) {
      throw new LockBusyError(
        this.readHolder(),
        `crib is busy: another process (pid ${this.readHolder()}) holds ${this.path}. If that process has exited, the lock will self-heal within 10 minutes, or run \`crib reindex\`.`,
      );
    }
    this.steal();
    this.held = true;
  }

  /**
   * Release the lock. Safe to call when not held or after a process exit. Only unlinks the file
   * when it still carries our own pid, so releasing after a steal never clobbers a fresh holder.
   */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      if (this.readHolder() === process.pid && existsSync(this.path)) {
        unlinkSync(this.path);
      }
    } catch {
      // best-effort: a failed unlink leaves a stale lock the next acquire recovers from
    }
  }

  private tryCreate(p: string): boolean {
    try {
      const fd = openSync(p, 'wx'); // O_WRONLY | O_CREAT | O_EXCL — atomic on most filesystems
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') return false;
      throw error;
    }
  }

  private readHolder(): number {
    try {
      const text = readFileSync(this.path, 'utf8').trim();
      const pid = Number.parseInt(text, 10);
      return Number.isInteger(pid) ? pid : 0;
    } catch {
      return 0;
    }
  }

  private isStale(): boolean {
    let st: Stats;
    try {
      st = statSync(this.path);
    } catch {
      return true; // vanished between the failed create and now — caller recreates
    }
    const age = Date.now() - st.mtimeMs;
    return !pidAlive(this.readHolder()) || age > this.staleMs;
  }

  private steal(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // ignore — the tryCreate below will fail loudly if it still exists
    }
    if (!this.tryCreate(this.path)) {
      // raced: someone else recreated it between our unlink and create
      throw new LockBusyError(
        this.readHolder(),
        `crib is busy: lock ${this.path} is held by another process`,
      );
    }
  }
}

/** Run `fn` while holding the crib lock; release on return or throw (sync). */
export function withCribLock<T>(opts: CribLockOptions, fn: () => T): T {
  const lock = new CribLock(opts);
  lock.acquire();
  try {
    return fn();
  } finally {
    lock.release();
  }
}

/** Run `fn` while holding the crib lock; release on resolve or reject (async). */
export async function withCribLockAsync<T>(
  opts: CribLockOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  const lock = new CribLock(opts);
  lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
