import { existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CribLock,
  DEFAULT_LOCK_STALE_MS,
  LockBusyError,
  withCribLock,
  withCribLockAsync,
} from './lock.js';

let crib: string;

beforeEach(() => {
  crib = mkdtempSync(join(tmpdir(), 'crib-lock-'));
});
afterEach(() => {
  rmSync(crib, { recursive: true, force: true });
});

/** A pid that is guaranteed not to be a live process: far above the OS pid max on every
 *  supported platform (darwin/linux/windows maxpid ≤ ~4.19M; 5_000_000 is unreachable). */
const DEAD_PID = 5_000_000;

describe('CribLock', () => {
  it('creates a .lock file holding the current pid on acquire', () => {
    const lock = new CribLock({ cribDir: crib });
    expect(existsSync(lock.lockPath)).toBe(false);
    lock.acquire();
    expect(lock.isHeld).toBe(true);
    expect(existsSync(lock.lockPath)).toBe(true);
    expect(lock.lockPath).toBe(join(crib, '.lock'));
  });

  it('blocks a second acquire on the same crib while the holder pid is alive', () => {
    const a = new CribLock({ cribDir: crib });
    a.acquire();
    const b = new CribLock({ cribDir: crib });
    expect(() => b.acquire()).toThrow(LockBusyError);
    expect(() => b.acquire()).toThrow(/crib is busy/);
    expect(b.isHeld).toBe(false);
    a.release();
  });

  it('release unlinks the file and lets the next lock acquire cleanly', () => {
    const a = new CribLock({ cribDir: crib });
    a.acquire();
    expect(existsSync(a.lockPath)).toBe(true);
    a.release();
    expect(a.isHeld).toBe(false);
    expect(existsSync(a.lockPath)).toBe(false);

    const b = new CribLock({ cribDir: crib });
    b.acquire();
    expect(b.isHeld).toBe(true);
    b.release();
  });

  it('release is idempotent and safe when not held', () => {
    const lock = new CribLock({ cribDir: crib });
    expect(() => lock.release()).not.toThrow();
    expect(lock.isHeld).toBe(false);
  });

  it('steals a stale lock whose holder pid is dead (self-heal after a crash)', () => {
    writeFileSync(join(crib, '.lock'), `${DEAD_PID}\n`);
    const lock = new CribLock({ cribDir: crib });
    expect(() => lock.acquire()).not.toThrow();
    expect(lock.isHeld).toBe(true);
    // the file now carries OUR pid, not the dead one
    expect(lock.lockPath).toBe(join(crib, '.lock'));
    lock.release();
  });

  it('steals a live-pid lock that is older than the stale threshold', () => {
    // a lock held by our OWN (alive) pid but aged past staleMs must still be reclaimable
    const lockPath = join(crib, '.lock');
    writeFileSync(lockPath, `${process.pid}\n`);
    const ancient = new Date(Date.now() - (DEFAULT_LOCK_STALE_MS + 60_000));
    utimesSync(lockPath, ancient, ancient);

    const lock = new CribLock({ cribDir: crib });
    expect(() => lock.acquire()).not.toThrow();
    expect(lock.isHeld).toBe(true);
    lock.release();
  });

  it('respects a custom staleMs', () => {
    const lockPath = join(crib, '.lock');
    writeFileSync(lockPath, `${process.pid}\n`);
    // 100ms old — fresh under default 10 min, but stale under a 50ms custom threshold
    const recent = new Date(Date.now() - 200);
    utimesSync(lockPath, recent, recent);

    const fresh = new CribLock({ cribDir: crib, staleMs: 50 });
    expect(() => fresh.acquire()).not.toThrow();
    fresh.release();

    // and a same-age file is NOT stale under a generous threshold
    writeFileSync(lockPath, `${process.pid}\n`);
    utimesSync(lockPath, recent, recent);
    const generous = new CribLock({ cribDir: crib, staleMs: 60_000 });
    expect(() => generous.acquire()).toThrow(LockBusyError);
  });

  it('honors a custom lockName', () => {
    const lock = new CribLock({ cribDir: crib, lockName: '.writer.lock' });
    lock.acquire();
    expect(lock.lockPath).toBe(join(crib, '.writer.lock'));
    expect(existsSync(join(crib, '.writer.lock'))).toBe(true);
    lock.release();
  });

  it('release does not clobber a lock a fresh holder has since acquired', () => {
    // simulate: a wrote a lock, then we (same pid) steal via staleness and release — but in
    // between another process recreated the file with a different pid. Our release must NOT unlink.
    const a = new CribLock({ cribDir: crib });
    a.acquire();
    // overwrite the lock file with a different holder pid right before a releases
    writeFileSync(join(crib, '.lock'), `${DEAD_PID - 1}\n`);
    a.release();
    // the foreign holder's file survives our release
    expect(existsSync(join(crib, '.lock'))).toBe(true);
  });
});

describe('withCribLock', () => {
  it('holds the lock through fn and releases on success', () => {
    let observed: boolean;
    const result = withCribLock({ cribDir: crib }, () => {
      observed = existsSync(join(crib, '.lock'));
      return 42;
    });
    expect(result).toBe(42);
    expect(observed!).toBe(true);
    expect(existsSync(join(crib, '.lock'))).toBe(false);
  });

  it('releases on throw and re-throws the original error', () => {
    expect(() =>
      withCribLock({ cribDir: crib }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(join(crib, '.lock'))).toBe(false);
  });

  it('serializes: a nested acquire on the same crib is blocked (no re-entrancy)', () => {
    expect(() =>
      withCribLock({ cribDir: crib }, () => {
        const inner = new CribLock({ cribDir: crib });
        inner.acquire(); // same process, live pid → busy
      }),
    ).toThrow(LockBusyError);
    // outer lock was released despite the inner throw
    expect(existsSync(join(crib, '.lock'))).toBe(false);
  });
});

describe('withCribLockAsync', () => {
  it('holds across an awaited promise and releases on resolve', async () => {
    const result = await withCribLockAsync({ cribDir: crib }, async () => {
      await Promise.resolve();
      expect(existsSync(join(crib, '.lock'))).toBe(true);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(existsSync(join(crib, '.lock'))).toBe(false);
  });

  it('releases on reject and re-throws', async () => {
    await expect(
      withCribLockAsync({ cribDir: crib }, async () => {
        await Promise.resolve();
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');
    expect(existsSync(join(crib, '.lock'))).toBe(false);
  });
});
