import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupIntegrityError,
  createMemoryBackup,
  restoreMemoryBackup,
  verifyMemoryBackup,
} from './backup.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crib-memory-backup-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(name: string, contents: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'active'), { recursive: true });
  writeFileSync(join(dir, 'active', 'aa.jsonl'), contents);
  writeFileSync(join(dir, 'sync-state.json'), '{"schemaVersion":"1"}\n');
  writeFileSync(join(dir, '.lock'), 'ephemeral');
  writeFileSync(join(dir, 'orphan.tmp'), 'ephemeral');
  return dir;
}

describe('verified memory backup and restore (F12)', () => {
  it('creates a content-hashed local/global bundle and excludes locks/temp files', () => {
    const local = seed('local', 'local memory\n');
    const global = seed('global', 'global memory\n');
    const bundle = join(root, 'backup');
    const created = createMemoryBackup(
      [
        { role: 'local', root: local },
        { role: 'global', root: global },
      ],
      bundle,
      { now: '2026-09-05T00:00:00.000Z' },
    );
    expect(created.files).toHaveLength(4);
    expect(verifyMemoryBackup(bundle)).toEqual(created);
    expect(existsSync(join(bundle, 'local', '.lock'))).toBe(false);
    expect(existsSync(join(bundle, 'local', 'orphan.tmp'))).toBe(false);
  });

  it('refuses a tampered bundle before writing any restore target', () => {
    const local = seed('local', 'local memory\n');
    const bundle = join(root, 'backup');
    createMemoryBackup([{ role: 'local', root: local }], bundle, {
      now: '2026-09-05T00:00:00.000Z',
    });
    writeFileSync(join(bundle, 'local', 'active', 'aa.jsonl'), 'tampered\n');
    const target = join(root, 'restored');
    expect(() => restoreMemoryBackup(bundle, [{ role: 'local', root: target }])).toThrow(
      BackupIntegrityError,
    );
    expect(existsSync(target)).toBe(false);
  });

  it('restores both stores and rolls the first back when later activation is interrupted', () => {
    const sourceLocal = seed('source-local', 'new local\n');
    const sourceGlobal = seed('source-global', 'new global\n');
    const bundle = join(root, 'backup');
    createMemoryBackup(
      [
        { role: 'local', root: sourceLocal },
        { role: 'global', root: sourceGlobal },
      ],
      bundle,
      { now: '2026-09-05T00:00:00.000Z' },
    );
    const targetLocal = seed('target-local', 'old local\n');
    const targetGlobal = seed('target-global', 'old global\n');

    expect(() =>
      restoreMemoryBackup(
        bundle,
        [
          { role: 'local', root: targetLocal },
          { role: 'global', root: targetGlobal },
        ],
        {
          force: true,
          beforeActivate: (role) => {
            if (role === 'global') throw new Error('simulated interrupted activation');
          },
        },
      ),
    ).toThrow(/interrupted/);
    expect(readFileSync(join(targetLocal, 'active', 'aa.jsonl'), 'utf8')).toBe('old local\n');
    expect(readFileSync(join(targetGlobal, 'active', 'aa.jsonl'), 'utf8')).toBe('old global\n');

    const restored = restoreMemoryBackup(
      bundle,
      [
        { role: 'local', root: targetLocal },
        { role: 'global', root: targetGlobal },
      ],
      { force: true },
    );
    expect(restored.restored).toEqual(['local', 'global']);
    expect(readFileSync(join(targetLocal, 'active', 'aa.jsonl'), 'utf8')).toBe('new local\n');
    expect(readFileSync(join(targetGlobal, 'active', 'aa.jsonl'), 'utf8')).toBe('new global\n');
  });
});
