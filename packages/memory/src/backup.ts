import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type MemoryBackupRole = 'local' | 'global';

export interface MemoryBackupLocation {
  role: MemoryBackupRole;
  root: string;
}

export interface MemoryBackupFile {
  role: MemoryBackupRole;
  path: string;
  bytes: number;
  sha256: string;
}

export interface MemoryBackupManifest {
  format: 'knowledge-crib-memory-backup';
  formatVersion: 1;
  createdAt: string;
  files: MemoryBackupFile[];
  excludes: string[];
}

export class BackupIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupIntegrityError';
  }
}

const MANIFEST_FILE = 'backup-manifest.json';
const EXCLUDES = ['.lock', '*.tmp', '*.tmp-*'];

function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function excluded(name: string): boolean {
  return name === '.lock' || name.endsWith('.tmp') || name.includes('.tmp-');
}

function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !path.split(/[\\/]/).includes('..')
  );
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excluded(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new BackupIntegrityError(`refusing symbolic link in memory store: ${path}`);
      }
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  };
  walk(root);
  return files.sort();
}

/** Create an immutable, content-hashed plaintext backup of local/global stores. */
export function createMemoryBackup(
  sources: readonly MemoryBackupLocation[],
  destination: string,
  options: { now?: string } = {},
): MemoryBackupManifest {
  const target = resolve(destination);
  if (existsSync(target))
    throw new BackupIntegrityError(`backup destination already exists: ${target}`);
  const stage = `${target}.tmp-${process.pid}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const files: MemoryBackupFile[] = [];
  try {
    for (const source of sources) {
      for (const relativePath of filesBelow(source.root)) {
        const from = join(source.root, relativePath);
        const bytes = readFileSync(from);
        const to = join(stage, source.role, relativePath);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        writeFileSync(to, bytes, { mode: 0o600 });
        files.push({
          role: source.role,
          path: relativePath,
          bytes: bytes.byteLength,
          sha256: digest(bytes),
        });
      }
    }
    files.sort((a, b) => `${a.role}/${a.path}`.localeCompare(`${b.role}/${b.path}`));
    const manifest: MemoryBackupManifest = {
      format: 'knowledge-crib-memory-backup',
      formatVersion: 1,
      createdAt: options.now ?? new Date().toISOString(),
      files,
      excludes: EXCLUDES,
    };
    writeFileSync(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    renameSync(stage, target);
    return manifest;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Validate every listed file before restore; malformed paths and changed bytes fail closed. */
export function verifyMemoryBackup(bundle: string): MemoryBackupManifest {
  const root = resolve(bundle);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
  } catch (error) {
    throw new BackupIntegrityError(`unreadable backup manifest: ${(error as Error).message}`);
  }
  const manifest = parsed as Partial<MemoryBackupManifest>;
  if (
    manifest.format !== 'knowledge-crib-memory-backup' ||
    manifest.formatVersion !== 1 ||
    typeof manifest.createdAt !== 'string' ||
    !Array.isArray(manifest.files)
  ) {
    throw new BackupIntegrityError('unsupported or malformed memory backup manifest');
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (
      (file.role !== 'local' && file.role !== 'global') ||
      !safeRelative(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      typeof file.sha256 !== 'string'
    ) {
      throw new BackupIntegrityError('malformed backup file entry');
    }
    const key = `${file.role}/${file.path}`;
    if (seen.has(key)) throw new BackupIntegrityError(`duplicate backup path: ${key}`);
    seen.add(key);
    const path = join(root, file.role, file.path);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new BackupIntegrityError(`backup file missing or not regular: ${key}`);
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256) {
      throw new BackupIntegrityError(`backup checksum mismatch: ${key}`);
    }
  }
  return manifest as MemoryBackupManifest;
}

export interface RestoreMemoryBackupOptions {
  force?: boolean;
  /** Test seam used to simulate an interruption between multi-store activations. */
  beforeActivate?: (role: MemoryBackupRole) => void;
}

/** Restore selected roles with pre-verification, sibling staging, and multi-target rollback. */
export function restoreMemoryBackup(
  bundle: string,
  targets: readonly MemoryBackupLocation[],
  options: RestoreMemoryBackupOptions = {},
): { restored: MemoryBackupRole[]; files: number } {
  const manifest = verifyMemoryBackup(bundle);
  const bundleRoot = resolve(bundle);
  const roles = new Set(manifest.files.map((file) => file.role));
  for (const target of targets) {
    if (!roles.has(target.role))
      throw new BackupIntegrityError(`backup has no ${target.role} store`);
    if (existsSync(target.root) && readdirSync(target.root).length > 0 && !options.force) {
      throw new BackupIntegrityError(`restore target is not empty: ${target.root} (pass force)`);
    }
  }

  const work = targets.map((target) => ({
    ...target,
    stage: `${resolve(target.root)}.restore-${process.pid}-${target.role}`,
    previous: `${resolve(target.root)}.pre-restore-${process.pid}-${target.role}`,
    movedPrevious: false,
    activated: false,
  }));
  try {
    for (const target of work) {
      rmSync(target.stage, { recursive: true, force: true });
      rmSync(target.previous, { recursive: true, force: true });
      mkdirSync(target.stage, { recursive: true, mode: 0o700 });
      for (const file of manifest.files.filter((entry) => entry.role === target.role)) {
        const to = join(target.stage, file.path);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        copyFileSync(join(bundleRoot, file.role, file.path), to);
      }
    }
    for (const target of work) {
      options.beforeActivate?.(target.role);
      if (existsSync(target.root)) {
        renameSync(target.root, target.previous);
        target.movedPrevious = true;
      }
      renameSync(target.stage, target.root);
      target.activated = true;
    }
  } catch (error) {
    for (const target of [...work].reverse()) {
      if (target.activated) rmSync(target.root, { recursive: true, force: true });
      if (target.movedPrevious && existsSync(target.previous)) {
        renameSync(target.previous, target.root);
      }
      rmSync(target.stage, { recursive: true, force: true });
    }
    throw error;
  }
  for (const target of work) rmSync(target.previous, { recursive: true, force: true });
  return {
    restored: work.map((target) => target.role),
    files: manifest.files.filter((file) => work.some((target) => target.role === file.role)).length,
  };
}
