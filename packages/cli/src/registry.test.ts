import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listProjects,
  lookupProject,
  readRegistry,
  registerProject,
  registryPath,
  unregisterProject,
  writeRegistry,
} from './registry.js';

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crib-reg-'));
  env = { KCRIB_REGISTRY_DIR: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('registry', () => {
  it('readRegistry returns an empty registry when the file is absent', () => {
    expect(readRegistry(env)).toEqual({ version: 1, projects: {} });
  });

  it('registerProject writes a keyed entry and preserves addedAt across re-registrations', () => {
    const root = '/abs/proj';
    const a = registerProject(root, {
      repoId: 'id-1',
      cribDir: '/abs/proj/.crib',
      addedAt: '2026-01-01T00:00:00Z',
      env,
    });
    expect(a.repoId).toBe('id-1');
    expect(lookupProject(root, env)?.repoId).toBe('id-1');

    // re-register: refreshes repoId/vcsHead but keeps the original addedAt.
    registerProject(root, { repoId: 'id-2', cribDir: '/abs/proj/.crib', vcsHead: 'deadbeef', env });
    const after = lookupProject(root, env)!;
    expect(after.repoId).toBe('id-2');
    expect(after.vcsHead).toBe('deadbeef');
    expect(after.addedAt).toBe('2026-01-01T00:00:00Z'); // preserved
  });

  it('listProjects returns all [root, entry] pairs', () => {
    registerProject('/a', { repoId: '1', cribDir: '/a/.crib', env });
    registerProject('/b', { repoId: '2', cribDir: '/b/.crib', env });
    expect(
      listProjects(env)
        .map(([r]) => r)
        .sort(),
    ).toEqual(['/a', '/b']);
  });

  it('unregisterProject removes an entry and returns false when absent', () => {
    registerProject('/a', { repoId: '1', cribDir: '/a/.crib', env });
    expect(unregisterProject('/a', env)).toBe(true);
    expect(lookupProject('/a', env)).toBeUndefined();
    expect(unregisterProject('/a', env)).toBe(false);
  });

  it('writeRegistry is atomic and produces parseable JSON at registryPath', () => {
    writeRegistry(
      { version: 1, projects: { '/x': { repoId: '9', cribDir: '/x/.crib', addedAt: 't' } } },
      env,
    );
    const path = registryPath(env);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).projects['/x'].repoId).toBe('9');
  });
});
