/**
 * Cross-process mutual exclusion for {@link CribLock}.
 *
 * The audited defect (docs/audits/2026-09-05, F02) was not in the freshness queue that surfaced it
 * but in this lock: `acquire()` classified a VANISHED lock file as stale, and the reclaim path then
 * unlinked unconditionally before creating. Two contenders racing inside a holder's release window
 * each deleted the other's freshly created lock and both entered the critical section, so an
 * unlocked read-modify-write behind the lock silently lost updates. A single-process unit test
 * cannot observe that — only genuinely concurrent processes can — so this suite forks.
 *
 * The counter below is deliberately a NON-atomic read-modify-write: it is the exact shape the lock
 * exists to protect, and its final value is the assertion. Any lost update is a lock failure.
 *
 * The children import the COMPILED `dist` entrypoint (no TypeScript loader is installed); `pretest`
 * builds it, and the test asserts its presence rather than skipping, so a missing build is a
 * failure instead of silent non-coverage.
 */
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WRITERS = 8;
const INCREMENTS_PER_WRITER = 25;
const EXPECTED_TOTAL = WRITERS * INCREMENTS_PER_WRITER;

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(packageRoot, 'dist', 'index.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-lock-conc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One writer process: acquire → read → +1 → atomic write → release, in a bounded retry loop. */
function writerSource(): string {
  return `
import { CribLock, LockBusyError } from ${JSON.stringify(pathToFileURL(distEntry).href)};
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [dir, counter] = process.argv.slice(2);
// Atomics.wait is the only sub-millisecond blocking sleep available to a SYNCHRONOUS retry loop
// (setTimeout cannot pause synchronous code); it needs a shared buffer to wait on.
const cell = new Int32Array(new SharedArrayBuffer(4));
function withRetry(fn) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const lock = new CribLock({ cribDir: dir, lockName: '.counter.lock' });
    try {
      lock.acquire();
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      Atomics.wait(cell, 0, 0, 1);
      continue;
    }
    try {
      return fn();
    } finally {
      lock.release();
    }
  }
  throw new Error('writer never acquired the lock');
}
process.send('ready');
process.on('message', () => {
  try {
    for (let i = 0; i < ${INCREMENTS_PER_WRITER}; i += 1) {
      withRetry(() => {
        const value = JSON.parse(readFileSync(counter, 'utf8'));
        value.n += 1;
        const tmp = counter + '.' + process.pid + '.' + randomUUID() + '.tmp';
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, counter);
      });
    }
    process.send({ ok: true });
  } catch (error) {
    process.send({ ok: false, error: String(error && error.message) });
  }
  process.exit(0);
});
`;
}

interface WriterOutcome {
  ok: boolean;
  error?: string;
}

describe('CribLock under concurrent processes', () => {
  it('loses no acknowledged update across 8 processes racing a read-modify-write', async () => {
    expect(existsSync(distEntry), `build ${distEntry} before running this test`).toBe(true);

    const counter = join(dir, 'counter.json');
    writeFileSync(counter, JSON.stringify({ n: 0 }));
    const writerFile = join(dir, 'writer.mjs');
    writeFileSync(writerFile, writerSource());

    const children = Array.from({ length: WRITERS }, () =>
      fork(writerFile, [dir, counter], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
    );
    try {
      // Wait for every child to be listening BEFORE releasing any of them, so the writes actually
      // overlap; starting them as they spawn would serialize the race away.
      await Promise.all(
        children.map((c) => new Promise<void>((resolve) => c.once('message', () => resolve()))),
      );
      const outcomes = children.map(
        (c) =>
          new Promise<WriterOutcome>((resolve) =>
            c.once('message', (m) => resolve(m as WriterOutcome)),
          ),
      );
      for (const c of children) c.send('go');
      const settled = await Promise.all(outcomes);
      expect(settled.filter((o) => !o.ok).map((o) => o.error)).toEqual([]);
    } finally {
      for (const c of children) if (c.exitCode === null) c.kill();
    }

    // The assertion: every acknowledged increment survived. A shortfall means two processes were
    // inside the critical section at the same time.
    expect(JSON.parse(readFileSync(counter, 'utf8')).n).toBe(EXPECTED_TOTAL);
  }, 60_000);
});
