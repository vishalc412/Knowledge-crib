import { createWriteStream } from 'node:fs';
/**
 * Safe ZIP/JAR extraction (Foundation Task 3).
 *
 * Mule projects arrive as source folders, exported ZIPs, or deployable JARs — all of which are
 * ZIP containers. This module is the ONE place archive bytes touch disk. Every entry is validated
 * BEFORE its output stream opens, so a malformed archive can never write outside `destRoot`.
 *
 * Defense in depth (each layer independently prevents path traversal / bombs):
 *  - {@link safeArchiveRelativePath} rejects absolute, drive-relative, traversal, and empty names.
 *  - Per-entry mode bits reject Unix symlink/socket/fifo/device entries (only regular/dir allowed).
 *  - `isEncrypted()` + `compressionMethod` (stored/deflate only) reject entries we can't decode.
 *  - Size limits: per-entry, total-uncompressed, and a compression-ratio bomb guard.
 *  - Duplicate + case-insensitive collision guards (catches case-folding ambiguity on macOS/Windows).
 *  - Final `destination.startsWith(destRoot + sep)` containment check before writing.
 *  - Per-entry byte counter caps the stream even when the central-directory size field lies.
 *
 * yauzl's own `validateEntrySizes` catches a stream that under/over-runs `uncompressedSize`; our
 * per-entry counter is the belt to that suspenders. Entries are written incrementally as they pass
 * validation; the first rejectable entry aborts the run (no further entries are written). Cache-level
 * atomicity — a failed extraction never replacing a good cache — is the caller's job (staging+swap).
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import yauzl from 'yauzl';

/** Hard caps that bound a single extraction. Tuned for real Mule projects (thousands of files,
 *  tens of MB) while staying far below anything that could exhaust disk or memory. */
export const ARCHIVE_LIMITS = {
  /** Max number of entries (files + dirs) in one archive. */
  entries: 50_000,
  /** Max uncompressed bytes for a single entry. */
  entryBytes: 100 * 1024 * 1024,
  /** Max total uncompressed bytes across the whole archive. */
  totalBytes: 2 * 1024 * 1024 * 1024,
  /** Max compression ratio (uncompressed / compressed) — a zip-bomb guard. */
  compressionRatio: 100,
} as const;

export type ArchiveLimits = typeof ARCHIVE_LIMITS;

/** Thrown for every rejectable condition below. Carries the offending entry name when known. */
export class ArchiveExtractionError extends Error {
  constructor(
    message: string,
    /** The archive entry name that triggered the rejection, when applicable. */
    readonly entry?: string,
  ) {
    super(message);
    this.name = 'ArchiveExtractionError';
  }
}

/**
 * Normalize + validate a single archive entry name to a `destRoot`-relative POSIX path.
 * Rejects absolute (`/foo`), drive-relative (`C:\foo`), traversal (`../bar`), and empty names,
 * plus any NUL byte. Backslashes are normalized to forward slashes (some Windows zips use them).
 * Returns the cleaned relative path with no trailing slash and no `.`/empty segments.
 */
export function safeArchiveRelativePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ArchiveExtractionError('empty archive entry name', raw);
  }
  if (raw.includes('\0')) throw new ArchiveExtractionError('NUL byte in archive entry', raw);

  const normalized = raw.replaceAll('\\', '/');
  if (normalized.startsWith('/')) {
    throw new ArchiveExtractionError('absolute archive entry path', raw);
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new ArchiveExtractionError('drive-relative archive entry path', raw);
  }

  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') throw new ArchiveExtractionError('traversal (..) in archive entry', raw);
  }
  const cleaned = segments.filter((seg) => seg.length > 0 && seg !== '.').join('/');
  if (cleaned.length === 0) throw new ArchiveExtractionError('empty archive entry path', raw);
  return cleaned;
}

/** Resolve `rel` under `destRoot` and confirm the result stays inside `destRoot`. */
function resolveContained(destRoot: string, rel: string): string {
  const dest = join(destRoot, ...rel.split('/'));
  if (dest !== destRoot && !dest.startsWith(destRoot + sep)) {
    throw new ArchiveExtractionError(`entry escapes destination root: ${rel}`, rel);
  }
  return dest;
}

/** Reject Unix entry modes that aren't regular-file or directory (symlink/socket/fifo/device). */
function assertSafeMode(entry: yauzl.Entry): 'dir' | 'file' {
  // `externalFileAttributes` upper 16 bits hold the Unix mode on archives made on Unix; 0 on many
  // Windows archives (treat as regular). Directories always have a trailing '/' in yauzl regardless.
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (mode === 0) return entry.fileName.endsWith('/') ? 'dir' : 'file';
  const type = mode & 0o170000;
  if (type === 0o040000) return 'dir';
  if (type === 0o100000) return 'file';
  throw new ArchiveExtractionError(
    `unsupported entry mode ${type.toString(8)} (only file/dir)`,
    entry.fileName,
  );
}

/** Promise wrapper around yauzl's callback `open`. */
function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (err, zip) => {
        if (err) reject(new ArchiveExtractionError(`cannot open archive: ${err.message}`));
        else resolve(zip);
      },
    );
  });
}

/** Promise wrapper around yauzl's callback `openReadStream`. */
function openEntryStream(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<import('node:stream').Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err)
        reject(new ArchiveExtractionError(`cannot read entry: ${err.message}`, entry.fileName));
      else resolve(stream);
    });
  });
}

export interface ExtractionResult {
  /** number of entries written (files + dirs). */
  entries: number;
  /** total uncompressed bytes written. */
  totalBytes: number;
}

/**
 * Extract `archivePath` into `destRoot` with every entry validated BEFORE its output stream opens.
 * Entries are written incrementally as they pass validation; the first rejectable entry ABORTS the
 * run (no further entries are written, but already-written entries remain in `destRoot`). Cache-level
 * atomicity — a failed extraction never replacing a good cache — is the caller's responsibility and
 * is provided by {@link prepareSourceInput} via staging + {@link swapExtraction} + discard-on-failure.
 * `destRoot` is created if missing.
 */
export async function extractArchive(
  archivePath: string,
  destRoot: string,
  limits: ArchiveLimits = ARCHIVE_LIMITS,
): Promise<ExtractionResult> {
  const zip = await openZip(archivePath);
  try {
    await mkdir(destRoot, { recursive: true });
  } catch (err) {
    throw new ArchiveExtractionError(`cannot create destination: ${(err as Error).message}`);
  }

  const seen = new Set<string>();
  const seenLower = new Set<string>();
  let entries = 0;
  let totalBytes = 0;

  return new Promise<ExtractionResult>((resolve, reject) => {
    const fail = (err: unknown): void => {
      zip.close();
      reject(err instanceof ArchiveExtractionError ? err : new ArchiveExtractionError(String(err)));
    };

    const validate = (entry: yauzl.Entry): { rel: string; dest: string; kind: 'dir' | 'file' } => {
      if (++entries > limits.entries) {
        throw new ArchiveExtractionError(`too many entries (>${limits.entries})`, entry.fileName);
      }
      const kind = assertSafeMode(entry);
      if (entry.isEncrypted()) {
        throw new ArchiveExtractionError('encrypted entries are not supported', entry.fileName);
      }
      // compressionMethod: 0 = stored, 8 = deflate. Reject anything we can't decompress.
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw new ArchiveExtractionError(
          `unsupported compression method ${entry.compressionMethod}`,
          entry.fileName,
        );
      }
      if (entry.uncompressedSize > limits.entryBytes) {
        throw new ArchiveExtractionError(
          `entry exceeds per-entry limit (>${limits.entryBytes} bytes)`,
          entry.fileName,
        );
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > limits.totalBytes) {
        throw new ArchiveExtractionError(
          `archive exceeds total limit (>${limits.totalBytes} bytes)`,
          entry.fileName,
        );
      }
      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize > entry.compressedSize * limits.compressionRatio
      ) {
        throw new ArchiveExtractionError(
          `compression ratio exceeds ${limits.compressionRatio}x (possible zip bomb)`,
          entry.fileName,
        );
      }
      const rel = safeArchiveRelativePath(entry.fileName);
      if (seen.has(rel)) throw new ArchiveExtractionError('duplicate entry', rel);
      seen.add(rel);
      const lower = rel.toLowerCase();
      if (seenLower.has(lower)) throw new ArchiveExtractionError('case-colliding entry', rel);
      seenLower.add(lower);
      const dest = resolveContained(destRoot, rel);
      return { rel, dest, kind };
    };

    const onEntry = (entry: yauzl.Entry): void => {
      let info: { rel: string; dest: string; kind: 'dir' | 'file' };
      try {
        info = validate(entry);
      } catch (err) {
        fail(err);
        return;
      }
      if (info.kind === 'dir') {
        mkdir(info.dest, { recursive: true })
          .then(() => zip.readEntry())
          .catch(fail);
        return;
      }
      mkdir(dirname(info.dest), { recursive: true })
        .then(() => openEntryStream(zip, entry))
        .then((stream) => writeEntry(stream, info.dest, entry.uncompressedSize, limits))
        .then(() => zip.readEntry())
        .catch(fail);
    };

    const writeEntry = (
      stream: import('node:stream').Readable,
      dest: string,
      declaredSize: number,
      lim: ArchiveLimits,
    ): Promise<void> => {
      return new Promise<void>((res, rej) => {
        const out = createWriteStream(dest);
        let written = 0;
        const abort = (err: Error): void => {
          stream.destroy();
          out.destroy();
          rej(new ArchiveExtractionError(err.message, dest));
        };
        stream.on('data', (chunk: Buffer) => {
          written += chunk.length;
          // Cap the stream even if the central-directory size field lied about a small entry.
          if (written > Math.max(declaredSize, lim.entryBytes)) {
            abort(new Error('entry stream exceeded declared size'));
            return;
          }
          if (!out.write(chunk)) stream.pause();
        });
        out.on('drain', () => stream.resume());
        stream.on('error', abort);
        out.on('error', abort);
        out.on('finish', res);
        stream.on('end', () => out.end());
      });
    };

    zip.on('entry', onEntry);
    zip.on('error', (err) => fail(new ArchiveExtractionError(err.message)));
    zip.on('end', () => resolve({ entries, totalBytes }));
    zip.readEntry();
  });
}

/** Swap a freshly-extracted `staging` dir over `target` atomically-ish: rename target→target.old,
 *  staging→target, then remove the old dir. If the staging rename fails, target.old is restored so
 *  a failed swap never loses the previously-good cache. */
export async function swapExtraction(staging: string, target: string): Promise<void> {
  let backup: string | null = null;
  try {
    await rename(target, `${target}.old`)
      .then(() => {
        backup = `${target}.old`;
      })
      .catch(() => {
        /* target did not exist */
      });
    await rename(staging, target);
    if (backup) await rm(backup, { recursive: true, force: true });
  } catch (err) {
    if (backup) {
      await rename(backup, target).catch(() => {
        /* best-effort restore; leave .old in place */
      });
    }
    throw err;
  }
}
