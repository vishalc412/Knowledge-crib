/**
 * Atomic *and durable* JSON write (PRD W2 Slice 2: "atomic temp→rename writes"; WP1 obligation 2:
 * "flush file contents before replacement … surface unsupported guarantees explicitly").
 *
 * WHY THIS LIVES IN `core`. Both packages write through this primitive: `SoulStore` commits graph
 * shards, chunk files, vendored schemas and the manifest here, and `@knowledge-crib/memory` writes
 * its store, journals and sync sidecars here. Before WP1 each had its OWN copy of the temp→rename
 * pattern — `SoulStore.atomicWrite` was a private method and the memory package vendored a second
 * one — so any durability fix would have had to be made twice and could silently drift apart. One
 * implementation, exposed at the dependency-free `@knowledge-crib/core/atomic-write` leaf subpath
 * (the memory package re-exports it from its own `./atomic.js`), keeps the fix in one place while
 * keeping the module's import graph three Node builtins wide.
 *
 * A crash mid-write leaves the OLD file intact plus an orphan `<path>.tmp`; the stores' read paths
 * never read `.tmp`, so a reader always sees either the previous or the next valid snapshot — never
 * a half-written file. `renameSync` is atomic on the target filesystems knowledge-crib runs on
 * (POSIX local dirs; the committed team store is local-disk too). The store's per-role lock
 * guarantees a single writer per path, so the shared `<path>.tmp` name never collides.
 *
 * ATOMICITY AND DURABILITY ARE DIFFERENT PROMISES, and this module used to make only the first.
 * temp→rename guarantees that a reader never sees a torn file; it says nothing about whether the
 * bytes behind the renamed name have reached stable storage. The write used to be
 * `writeFileSync(tmp)` + `renameSync` and nothing else, so a completed, acknowledged mutation lived
 * only in the page cache: measured on this tree, one admitted `crib memory observe` performed 12 renames and ZERO fsyncs. A power loss or kernel
 * panic after the acknowledgement could therefore lose work the store had already reported as
 * written.
 *
 * What this module now guarantees, and what it does NOT:
 *
 *   - the file's bytes are flushed before the rename, and the parent directory is flushed after it,
 *     so a completed write is ordered on the device;
 *   - a completed write survives a PROCESS CRASH outright;
 *   - a completed write survives POWER LOSS **only where the platform's fsync reaches the media**.
 *     On darwin `man 2 fsync` is explicit that it flushes "from the host to the drive" and that
 *     "the drive itself may not physically write the data to the platters for quite some time";
 *     `F_FULLFSYNC` is the real barrier and Node core exposes no way to reach it without a native
 *     dependency. So {@link atomicWriteDurability} reports `powerLossDurable` separately, and
 *     reports `false` here. The honest product statement is "survives a process crash and is
 *     ordered on the device" — strictly stronger than the page-cache acknowledgement it replaces,
 *     strictly weaker than power-loss durability, and never silently either one.
 *
 * Flushes are attempted only when the platform supports them ({@link atomicWriteDurability} probes
 * once per process), so an unsupported platform degrades to the old rename-only behaviour rather
 * than failing. Where the platform DOES support the barrier and it nonetheless fails — a full disk,
 * an I/O error, a filesystem that lies — the failure is NOT swallowed: it surfaces as a
 * {@link DurabilityError}. That asymmetry is deliberate and is the whole point of WP1 obligation 2's
 * exit criterion, "persistence failures do not produce successful acknowledgements": a barrier that
 * quietly did not happen is precisely the false acknowledgement this module exists to prevent.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * What THIS platform can actually guarantee about a completed write. Three values, not two: a single
 * `durable: true` would have to be either a lie on darwin or a needless pessimism on linux.
 */
export interface AtomicWriteDurability {
  /** The file's own bytes are flushed to the device before the rename. Measured by probe. */
  fileFlush: boolean;
  /**
   * The parent directory is flushed after the rename, so the rename itself is ordered. Measured by
   * probe; `false` where the platform refuses to open a directory as a file descriptor (Windows).
   */
  dirFlush: boolean;
  /**
   * A completed write survives POWER LOSS — not merely a process crash. Derived from the platform's
   * documented `fsync` semantics, never measured here: `false` on darwin (fsync stops at the drive's
   * cache and `F_FULLFSYNC` is unreachable from Node core), `true` on linux, where `fsync` transfers
   * to the device and issues a cache flush — modulo hardware that lies about flushing.
   */
  powerLossDurable: boolean;
}

/** Thrown when a durability barrier was attempted, is supported here, and failed. Nothing is claimed. */
export class DurabilityError extends Error {
  constructor(
    readonly phase: 'file' | 'dir',
    readonly path: string,
    override readonly cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`durability barrier failed (${phase} flush) at ${path}: ${message}`);
    this.name = 'DurabilityError';
  }
}

/**
 * Whether the platform's `fsync` is documented to reach the media rather than stopping at the
 * drive's write cache. Documentation-derived, not measured — see {@link AtomicWriteDurability}.
 */
function platformFlushesToMedia(): boolean {
  return process.platform === 'linux';
}

/**
 * Probe the capability once, on a throwaway directory, so the answer is observed rather than
 * asserted. Any failure of the probe itself is a `false`, never a throw: an inability to measure the
 * guarantee is an absence of the guarantee, and it must not be able to break a caller's write.
 */
function probeDurability(): AtomicWriteDurability {
  const probeDir = mkdtempForProbe();
  if (!probeDir) return { fileFlush: false, dirFlush: false, powerLossDurable: false };

  let fileFlush = false;
  let dirFlush = false;
  try {
    try {
      const fd = openSync(join(probeDir, 'probe.json'), 'w');
      try {
        writeFileSync(fd, '{}\n', 'utf8');
        fsyncSync(fd);
        fileFlush = true;
      } finally {
        closeSync(fd);
      }
    } catch {
      // fileFlush stays false: this platform cannot flush a file here.
    }
    if (fileFlush) {
      try {
        const dirFd = openSync(probeDir, 'r');
        try {
          fsyncSync(dirFd);
          dirFlush = true;
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // dirFlush stays false: this platform refuses to flush a directory (e.g. Windows).
      }
    }
  } finally {
    try {
      rmSync(probeDir, { recursive: true, force: true });
    } catch {
      // A leftover probe directory in the OS temp dir is not a failure worth propagating.
    }
  }
  return {
    fileFlush,
    dirFlush,
    // A write whose rename is not ordered is not power-loss durable even where the file flush works.
    powerLossDurable: fileFlush && dirFlush && platformFlushesToMedia(),
  };
}

function mkdtempForProbe(): string | undefined {
  try {
    return mkdtempSync(join(tmpdir(), 'crib-durability-'));
  } catch {
    return undefined;
  }
}

let cachedDurability: AtomicWriteDurability | undefined;

/**
 * What this process can guarantee about a completed {@link writeJsonAtomic}. Probed once, on first
 * ask, and cached — the probe costs two flushes, so it must not sit in a write path.
 */
export function atomicWriteDurability(): AtomicWriteDurability {
  cachedDurability ??= probeDurability();
  return cachedDurability;
}

/** Flush one open file descriptor, or surface the failure as a typed {@link DurabilityError}. */
function flushFd(fd: number, phase: 'file' | 'dir', path: string): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    throw new DurabilityError(phase, path, error);
  }
}

/** Open the directory read-only and flush it; see {@link writeJsonAtomic} for why this is a throw. */
function flushDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    flushFd(fd, 'dir', dir);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write `content` to `path` atomically AND durably: mkdir -p the parent, write `<path>.tmp` through
 * a file descriptor, flush it, close it, rename over `path`, then flush the parent directory.
 *
 * The two flushes flank the rename on purpose. Flushing the temp file BEFORE the rename means the
 * new content is on the device before it becomes reachable under the target name; flushing the
 * directory AFTER the rename means the rename itself is ordered. A failure of the first flush leaves
 * the old file untouched; a failure of the second leaves the new file in place but throws rather
 * than acknowledge, so no caller can mistake the outcome.
 */
export function writeJsonAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const capability = atomicWriteDurability();
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, content, 'utf8');
    if (capability.fileFlush) flushFd(fd, 'file', tmp);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (capability.dirFlush) flushDir(dir);
}

/**
 * Append one line durably, for the journal-shaped lanes (`intelligence-events`, the sync outbox)
 * whose readers already tolerate a torn trailing line. Deliberately NOT a change to append
 * semantics: no temp file and no rename, because the value of these lanes is the order of what was
 * already written, which a rewrite would have to reconstruct.
 *
 * The directory is flushed only when this append CREATED the file — the directory entry is the only
 * thing a later append can newly need ordered, and flushing it per line would pay a barrier for a
 * rename that did not happen.
 */
export function appendLineDurable(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const capability = atomicWriteDurability();
  const isNewFile = capability.dirFlush && !existsSync(path);
  const fd = openSync(path, 'a');
  try {
    writeFileSync(fd, line, 'utf8');
    if (capability.fileFlush) flushFd(fd, 'file', path);
  } finally {
    closeSync(fd);
  }
  if (isNewFile) flushDir(dirname(path));
}
