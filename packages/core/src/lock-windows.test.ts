import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Windows release window, reproduced on any host: the first exclusive create fails the way
// Windows fails it while another process still has the lock file open or pending deletion.
const failures = vi.hoisted(() => ({ remaining: 0, code: 'EPERM' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      if (failures.remaining > 0 && args[1] === 'wx') {
        failures.remaining -= 1;
        throw Object.assign(new Error(`${failures.code}: operation not permitted, open`), {
          code: failures.code,
        });
      }
      return actual.openSync(...args);
    }) as typeof actual.openSync,
  };
});

const { CribLock, isTransientLockCreateError } = await import('./lock.js');

describe('isTransientLockCreateError', () => {
  it('treats the Windows open-or-delete-pending codes as contention', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(isTransientLockCreateError(code, 'win32')).toBe(true);
    }
  });

  it('keeps them hard errors on POSIX, where they mean a real permission problem', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        expect(isTransientLockCreateError(code, platform)).toBe(false);
      }
    }
  });

  it('never classifies EEXIST or an unknown code as transient', () => {
    expect(isTransientLockCreateError('EEXIST', 'win32')).toBe(false);
    expect(isTransientLockCreateError('ENOSPC', 'win32')).toBe(false);
    expect(isTransientLockCreateError(undefined, 'win32')).toBe(false);
  });
});

describe('CribLock across the Windows release window', () => {
  let dir: string;
  const platform = process.platform;
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crib-lock-win-'));
  });
  afterEach(() => {
    setPlatform(platform);
    failures.remaining = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-races the create on win32 instead of failing the writer', () => {
    setPlatform('win32');
    failures.remaining = 2;
    const lock = new CribLock({ cribDir: dir });
    lock.acquire();
    expect(lock.isHeld).toBe(true);
    expect(failures.remaining).toBe(0);
    lock.release();
  });

  it('still throws the permission error on POSIX', () => {
    setPlatform('linux');
    failures.remaining = 1;
    const lock = new CribLock({ cribDir: dir });
    expect(() => lock.acquire()).toThrow(/EPERM/);
  });
});
