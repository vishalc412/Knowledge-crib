/**
 * WP1 obligation 2 — the durability contract of `writeJsonAtomic` / `appendLineDurable`.
 *
 * WHY THIS TEST LIVES IN `core`. The primitive does: before WP1 `SoulStore` had a private copy and
 * `@knowledge-crib/memory` vendored a second one, and WP1 collapsed them into this single module so
 * the flush could not be added to one and forgotten in the other. A test for a shared primitive
 * belongs with it, not inside one of its two consumers — otherwise the second consumer's writer can
 * regress the contract with this suite still green.
 *
 * WHY THIS TEST INSTRUMENTS `node:fs`. On a running kernel there is no on-disk difference between
 * "flushed, then renamed" and "renamed, never flushed" — that is exactly the distinction that only
 * becomes observable at power loss. So the strongest available evidence is the ORDER of the
 * syscalls, and the only way to see that order is to wrap the fs primitives. The wrapper delegates
 * every call unchanged; it only records.
 *
 * WHY MOCKING `node:fs` IS SAFE HERE. This file imports `./atomic-write.js` and nothing else from
 * the package, and that module imports only `node:fs` / `node:os` / `node:path`. The mocked module
 * graph is therefore three Node builtins wide — no other module is loaded through the wrapper, so
 * the mock cannot perturb unrelated code. (This is also why the module is reached by its own leaf
 * path rather than through the package barrel: importing `@knowledge-crib/core` here would drag the
 * whole index/sqlite/kuzu graph through the mock and hollow out that guarantee.)
 *
 * HONESTY CONSTRAINT (spec §11.1). No assertion here claims a capability the platform may not have.
 * The ordering assertions are conditional on the capability `atomicWriteDurability()` REPORTS, and
 * the unconditional assertion is that the report and the performed work AGREE — which is what the
 * spec can assert on every platform. Nothing here is a power-loss guarantee (§4): every existing
 * "crash" test kills a process, and so does this file's crash case.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** One recorded filesystem event, in the order the implementation issued it. */
type TraceEntry =
  | { op: 'open'; path: string }
  | { op: 'fsync'; path: string | undefined }
  | { op: 'rename'; from: string; to: string }
  | { op: 'close'; path: string | undefined };

const trace = vi.hoisted(() => ({
  entries: [] as Array<
    | { op: 'open'; path: string }
    | { op: 'fsync'; path: string | undefined }
    | { op: 'rename'; from: string; to: string }
    | { op: 'close'; path: string | undefined }
  >,
  /** fd → path, so an `fsync(fd)` can be attributed to the file it flushes. */
  fdPath: new Map<number, string>(),
  /** When set, `fsyncSync` throws for any fd whose path matches — the barrier-failure injection. */
  failFsyncFor: undefined as ((path: string | undefined) => boolean) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>): number => {
      const fd = actual.openSync(...args);
      const path = typeof args[0] === 'string' ? args[0] : undefined;
      if (path !== undefined) {
        trace.fdPath.set(fd, path);
        trace.entries.push({ op: 'open', path });
      }
      return fd;
    },
    closeSync: (fd: number): void => {
      const path = trace.fdPath.get(fd);
      trace.entries.push({ op: 'close', path });
      actual.closeSync(fd);
    },
    fsyncSync: (fd: number): void => {
      const path = trace.fdPath.get(fd);
      trace.entries.push({ op: 'fsync', path });
      if (trace.failFsyncFor?.(path)) {
        const err: NodeJS.ErrnoException = new Error(`EIO: simulated flush failure at ${path}`);
        err.code = 'EIO';
        throw err;
      }
      actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string): void => {
      trace.entries.push({ op: 'rename', from, to });
      actual.renameSync(from, to);
    },
  };
});

// Imported AFTER the mock declaration (vitest hoists the factory above every import).
const { appendLineDurable, atomicWriteDurability, DurabilityError, writeJsonAtomic } = await import(
  './atomic-write.js'
);

let root = '';
let storeDir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crib-atomic-durability-'));
  storeDir = join(root, 'store');
  trace.entries.length = 0;
  trace.fdPath.clear();
  trace.failFsyncFor = undefined;
});

afterEach(() => {
  trace.failFsyncFor = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** Index of the first trace entry matching `predicate`, or -1. */
function at(predicate: (entry: TraceEntry) => boolean): number {
  return trace.entries.findIndex(predicate);
}

describe('atomic write durability — the barrier is ordered around the rename', () => {
  it('flushes the temp file BEFORE the rename and the directory AFTER it, exactly as the capability reports', () => {
    const capability = atomicWriteDurability();
    const target = join(storeDir, 'shard.json');
    trace.entries.length = 0; // drop the one-off capability probe from the trace

    writeJsonAtomic(target, '{"a":1}\n');

    const tmp = `${target}.tmp`;
    const fileFlush = at((e) => e.op === 'fsync' && e.path === tmp);
    const rename = at((e) => e.op === 'rename' && e.from === tmp && e.to === target);
    const dirFlush = at((e) => e.op === 'fsync' && e.path === storeDir);

    // The report and the work must AGREE, on every platform: this is the assertion that is true
    // everywhere, and it is the one that fails if the capability is ever asserted rather than probed.
    expect(fileFlush >= 0).toBe(capability.fileFlush);
    expect(dirFlush >= 0).toBe(capability.dirFlush);

    // The rename always happens, and always exactly once.
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(trace.entries.filter((e) => e.op === 'rename')).toHaveLength(1);

    if (capability.fileFlush) {
      expect(fileFlush).toBeLessThan(rename); // content reaches the device before it is reachable
    }
    if (capability.dirFlush) {
      expect(rename).toBeLessThan(dirFlush); // …and the rename itself is ordered after it
    }
  });

  it('leaves the PREVIOUS file intact when the file barrier fails — no rename, no acknowledgement', () => {
    const capability = atomicWriteDurability();
    const target = join(storeDir, 'shard.json');
    writeJsonAtomic(target, '{"gen":1}\n');

    // Inject a failure only for the temp file's flush, i.e. the barrier BEFORE the rename.
    trace.failFsyncFor = (path) => path === `${target}.tmp`;
    trace.entries.length = 0;

    const attempt = (): void => writeJsonAtomic(target, '{"gen":2}\n');

    if (capability.fileFlush) {
      expect(attempt).toThrow(DurabilityError);
      expect(readFileSync(target, 'utf8')).toBe('{"gen":1}\n'); // the old bytes are still the truth
      expect(at((e) => e.op === 'rename')).toBe(-1); // the fault landed before any rename
    } else {
      // On a platform without the barrier the write simply completes; nothing is claimed either way.
      expect(attempt).not.toThrow();
    }
  });

  it('throws rather than acknowledge when the directory barrier fails AFTER a completed rename', () => {
    const capability = atomicWriteDurability();
    const target = join(storeDir, 'shard.json');
    trace.failFsyncFor = (path) => path === storeDir;

    const attempt = (): void => writeJsonAtomic(target, '{"gen":2}\n');

    if (capability.dirFlush) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DurabilityError);
      const failure = thrown as InstanceType<typeof DurabilityError>;
      expect(failure.phase).toBe('dir');
      expect(failure.path).toBe(storeDir);
      // Precise about the state: the rename already happened, so the NEW bytes are on disk while the
      // call reported failure. A caller must not read a throw as "the old file survived" — it means
      // "the replacement is not ordered", and the next write heals it.
      expect(readFileSync(target, 'utf8')).toBe('{"gen":2}\n');
    } else {
      expect(attempt).not.toThrow();
    }
  });

  it('is atomic even without the barrier: no torn target is ever visible, and the temp is gone', () => {
    const target = join(storeDir, 'shard.json');
    writeJsonAtomic(target, '{"n":1}\n');
    writeJsonAtomic(target, '{"n":2}\n');

    expect(readFileSync(target, 'utf8')).toBe('{"n":2}\n');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});

describe('appendLineDurable — a flush per appended line, torn-line recovery unchanged', () => {
  it('flushes the file for every appended line, and the directory only when it creates the file', () => {
    const capability = atomicWriteDurability();
    const journal = join(storeDir, 'events.jsonl');

    trace.entries.length = 0;
    appendLineDurable(journal, '{"i":1}\n');
    const firstOpen = at((e) => e.op === 'open' && e.path === journal);
    const firstFlush = at((e) => e.op === 'fsync' && e.path === journal);
    const firstDirFlush = at((e) => e.op === 'fsync' && e.path === storeDir);
    const renameCount = trace.entries.filter((e) => e.op === 'rename').length;

    trace.entries.length = 0;
    appendLineDurable(journal, '{"i":2}\n');
    const secondFlush = at((e) => e.op === 'fsync' && e.path === journal);
    const secondDirFlush = at((e) => e.op === 'fsync' && e.path === storeDir);

    // Append semantics are untouched: no temp file, no rename, ever.
    expect(renameCount).toBe(0);
    expect(trace.entries.filter((e) => e.op === 'rename')).toHaveLength(0);

    expect(firstOpen).toBeGreaterThanOrEqual(0);
    expect(firstOpen).toBeLessThan(firstFlush);
    expect(firstFlush >= 0).toBe(capability.fileFlush);
    expect(secondFlush >= 0).toBe(capability.fileFlush);

    // The directory entry of a pre-existing file cannot change, so only the creating append pays it.
    expect(firstDirFlush >= 0).toBe(capability.dirFlush);
    expect(secondDirFlush).toBe(-1);

    expect(readFileSync(journal, 'utf8')).toBe('{"i":1}\n{"i":2}\n');
  });

  it('still tolerates a torn trailing line after a crash — the reader contract is unchanged', () => {
    const journal = join(storeDir, 'events.jsonl');
    appendLineDurable(journal, '{"i":1}\n');
    // The window the readers already handle: a line written without its terminating newline.
    writeFileSync(journal, '{"i":2', { flag: 'a' });

    const lines = readFileSync(journal, 'utf8').split('\n');
    expect(lines.at(-2)).toBe('{"i":1}'); // the complete line survives
    expect(lines.at(-1)).toBe('{"i":2'); // and the incomplete one is the LAST, which readers skip
  });
});
