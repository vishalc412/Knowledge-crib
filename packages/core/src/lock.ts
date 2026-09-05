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

/**
 * How many times `acquire()` may re-race the atomic create before declaring sustained contention.
 * Each pass costs one `openSync` + one `statSync`; the loop only spins while OTHER processes are
 * winning the create, so a bound this size is a liveness backstop, not a latency budget.
 */
const ACQUIRE_RACE_ATTEMPTS = 100;

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
    // Bounded re-race loop. Each pass either wins the atomic create, proves the lock is live
    // (throws), or reclaims a genuinely stale one. The loop exists for the VANISHED case: a holder
    // releasing between our failed create and our stat leaves no file, and the only sound response
    // is to re-race the atomic create. Unlinking there is what broke mutual exclusion — two
    // contenders in the same release window would each unlink the other's freshly created lock and
    // both proceed into the critical section.
    for (let attempt = 0; attempt < ACQUIRE_RACE_ATTEMPTS; attempt += 1) {
      if (this.tryCreate(this.path)) {
        this.held = true;
        return;
      }
      const verdict = this.staleness();
      if (verdict.kind === 'vanished') continue; // re-race the create; never unlink
      if (verdict.kind === 'live') {
        throw new LockBusyError(
          verdict.holderPid,
          `crib is busy: another process (pid ${verdict.holderPid}) holds ${this.path}. If that process has exited, the lock will self-heal within 10 minutes, or run \`crib reindex\`.`,
        );
      }
      // Stale: reclaim it, but only while the file still carries the exact holder+mtime we judged.
      // A false return means another contender reclaimed it first — re-evaluate rather than assume.
      if (this.steal(verdict.holderPid, verdict.mtimeMs)) {
        this.held = true;
        return;
      }
    }
    throw new LockBusyError(
      this.readHolder(),
      `crib is busy: ${this.path} is under sustained contention (${ACQUIRE_RACE_ATTEMPTS} attempts).`,
    );
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

  /**
   * Classify the lock file we failed to create.
   *
   * `vanished` is deliberately NOT `stale`: the holder released between our failed create and this
   * stat, so there is nothing to reclaim and the caller must simply re-race `tryCreate`. The
   * returned holder pid and mtime pin the exact file a reclaim is allowed to remove.
   */
  private staleness():
    | { kind: 'vanished' }
    | { kind: 'live'; holderPid: number }
    | { kind: 'stale'; holderPid: number; mtimeMs: number } {
    let st: Stats;
    try {
      st = statSync(this.path);
    } catch {
      return { kind: 'vanished' };
    }
    const holder = this.readHolder();
    // A contender can observe the O_EXCL-created lock between `openSync` and the holder pid write.
    // Treat that short-lived empty/unreadable state as held until the normal stale timeout;
    // reclaiming it immediately lets two writers enter the critical section.
    const stale = Date.now() - st.mtimeMs > this.staleMs || (holder !== 0 && !pidAlive(holder));
    return stale
      ? { kind: 'stale', holderPid: holder, mtimeMs: st.mtimeMs }
      : { kind: 'live', holderPid: holder };
  }

  /**
   * Reclaim a lock previously classified stale. Returns false — rather than throwing — when the
   * file changed under us (another contender reclaimed it first, or the holder rewrote it), so the
   * caller re-evaluates instead of deleting a lock that is now legitimately held.
   */
  private steal(expectedPid: number, expectedMtimeMs: number): boolean {
    try {
      const st = statSync(this.path);
      if (st.mtimeMs !== expectedMtimeMs || this.readHolder() !== expectedPid) return false;
      unlinkSync(this.path);
    } catch {
      // vanished under us — the atomic create below re-races for it, which is the correct outcome
    }
    return this.tryCreate(this.path);
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
