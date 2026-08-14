/**
 * Prepared source input (Foundation Task 3).
 *
 * The CLI accepts three input shapes — a source folder, an exported ZIP, or a deployable Mule JAR —
 * and they all need to land at a single `sourceRoot` that the rest of the pipeline can `discover()`
 * against. This module normalizes all three into one {@link PreparedSourceInput} and caches extracted
 * archives so a repeated `crib update` on the same archive skips re-extraction.
 *
 * Cache layout (archives only):
 *   `<importsDir>/<sha256(realpath)>/source`        ← extracted tree (the `sourceRoot`)
 *   `<importsDir>/<sha256(realpath)>/crib`          ← per-archive `.crib` (soul lives here)
 *   `<importsDir>/<sha256(realpath)>/input.json`    ← fingerprint manifest (cache-hit check)
 *
 * A cache hit requires a matching fingerprint (SHA-256 of the archive BYTES), so editing the archive
 * in place triggers a fresh extraction. Refreshed content extracts into `source.staging-<uuid>` and
 * is swapped over `source` only after validation succeeds — a half-extracted archive never replaces
 * a good cache. Directories are never extracted: their `sourceRoot` is the directory itself and
 * `cribDir` is `<dir>/.crib` (the existing convention).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { extractArchive, swapExtraction } from './archive.js';

/** ZIP magic header (PK\x03\x04). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** What kind of input the user pointed us at. */
export type PreparedSourceKind = 'directory' | 'zip' | 'jar';

/** The normalized, pipeline-ready source input. Stable across calls for the same input. */
export interface PreparedSourceInput {
  /** Absolute canonical path of the original input (directory or archive). Used as the registry key. */
  projectKey: string;
  /** Absolute path of the tree the pipeline will `discover()` against. */
  sourceRoot: string;
  /** Absolute path of the `.crib` directory the soul will be written into. */
  cribDir: string;
  kind: PreparedSourceKind;
  /** SHA-256 of archive bytes (hex) for archives; empty string for directories (no archive to fingerprint). */
  fingerprint: string;
  /** The original archive path, when `kind` is `zip`/`jar`. */
  archivePath?: string;
}

/** Caller options. `importsDir` defaults to `~/.crib/imports`; `cribDir` overrides the per-archive crib. */
export interface PrepareSourceOptions {
  /** Base directory for the archive cache. Default `~/.crib/imports`. */
  importsDir?: string;
  /** Explicit `.crib` location (overrides `<baseDir>/crib` for archives and `<dir>/.crib` for directories). */
  cribDir?: string;
}

/** On-disk manifest written next to each extracted archive so a repeat call detects a cache hit. */
interface PreparedInputManifest {
  kind: PreparedSourceKind;
  projectKey: string;
  sourceRoot: string;
  cribDir: string;
  fingerprint: string;
  archivePath?: string;
}

const SHA256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Read the first 4 bytes of a file to detect a ZIP container. */
async function isZipFile(path: string): Promise<boolean> {
  let handle: { close(): void } | undefined;
  try {
    const { open } = await import('node:fs/promises');
    const fh = await open(path, 'r');
    handle = fh;
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.equals(ZIP_MAGIC);
  } catch {
    return false;
  } finally {
    if (handle) await (handle as { close(): Promise<void> }).close().catch(() => {});
  }
}

/** `kind` from extension, confirmed by the ZIP magic header (a `.jar` is structurally a `.zip`). */
async function detectKind(
  path: string,
  st: { isDirectory(): boolean },
): Promise<PreparedSourceKind> {
  if (st.isDirectory()) return 'directory';
  const ext = extname(path).toLowerCase();
  const zip = await isZipFile(path);
  if (!zip) throw new Error(`unsupported input (not a directory or ZIP/JAR archive): ${path}`);
  return ext === '.jar' ? 'jar' : 'zip';
}

/**
 * Normalize an input path into a {@link PreparedSourceInput}. Directories resolve instantly;
 * archives are extracted once and cached by content fingerprint. Repeated calls on an unchanged
 * archive are cache hits (no re-extraction); an archive whose bytes changed re-extracts and swaps.
 */
export async function prepareSourceInput(
  input: string,
  opts: PrepareSourceOptions = {},
): Promise<PreparedSourceInput> {
  const projectKey = resolve(input);
  let st: Stats;
  try {
    st = await stat(projectKey);
  } catch (err) {
    throw new Error(`input not found: ${projectKey} (${(err as Error).message})`);
  }
  const kind = await detectKind(projectKey, st);

  if (kind === 'directory') {
    const cribDir = opts.cribDir ?? join(projectKey, '.crib');
    return { projectKey, sourceRoot: projectKey, cribDir, kind, fingerprint: '' };
  }

  // Archive: fingerprint bytes, then cache by canonical-path hash.
  const bytes = await readFile(projectKey);
  const fingerprint = SHA256(bytes);
  const importsDir = opts.importsDir ?? join(homedir(), '.crib', 'imports');
  const baseDir = join(importsDir, SHA256(Buffer.from(projectKey)));
  const sourceRoot = join(baseDir, 'source');
  const cribDir = opts.cribDir ?? join(baseDir, 'crib');
  const manifestPath = join(baseDir, 'input.json');

  await mkdir(baseDir, { recursive: true });

  // Cache hit? An existing manifest whose fingerprint matches means the extracted tree is current.
  const cached = await readManifest(manifestPath);
  if (cached && cached.fingerprint === fingerprint && (await pathExists(sourceRoot))) {
    return {
      projectKey,
      sourceRoot: cached.sourceRoot,
      cribDir: cached.cribDir,
      kind: cached.kind,
      fingerprint: cached.fingerprint,
      ...(cached.archivePath !== undefined ? { archivePath: cached.archivePath } : {}),
    };
  }

  // Cache miss / stale: extract into staging, then swap over `source` so a failed extraction never
  // replaces a good cache.
  const staging = join(baseDir, `source.staging-${randomUUID()}`);
  await rm(staging, { recursive: true, force: true });
  try {
    await extractArchive(projectKey, staging);
    await swapExtraction(staging, sourceRoot);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  const manifest: PreparedInputManifest = {
    kind,
    projectKey,
    sourceRoot,
    cribDir,
    fingerprint,
    archivePath: projectKey,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { projectKey, sourceRoot, cribDir, kind, fingerprint, archivePath: projectKey };
}

async function readManifest(path: string): Promise<PreparedInputManifest | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PreparedInputManifest;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

void basename; // (kept available for future per-entry provenance)
