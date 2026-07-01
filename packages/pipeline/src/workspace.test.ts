import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectWorkspace, resolvePackageArg } from './workspace.js';
import { discoverFiles } from './structure.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-ws-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Create a dir + a placeholder source file so discovery has something to find. */
function pkg(name: string, rel: string): void {
  const dir = join(repo, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), `export const ${name.replace(/-/g, '_')} = 1;\n`);
}

describe('detectWorkspace', () => {
  it('returns null for a single-package repo (no workspace manifest)', () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'solo', version: '0.0.0' }));
    expect(detectWorkspace(repo)).toBeNull();
  });

  it('detects a pnpm workspace and enumerates packages by glob', () => {
    writeFileSync(
      join(repo, 'pnpm-workspace.yaml'),
      ['packages:', '  - "packages/*"', ''].join('\n'),
    );
    pkg('ftc-cloud', 'packages/FTCCloud');
    pkg('ftc-local', 'packages/FTCLocal');
    const layout = detectWorkspace(repo);
    expect(layout?.tool).toBe('pnpm');
    expect(layout?.packages.map((p) => p.name).sort()).toEqual(['ftc-cloud', 'ftc-local']);
    expect(layout?.packages.map((p) => p.rel).sort()).toEqual([
      'packages/FTCCloud',
      'packages/FTCLocal',
    ]);
  });

  it('detects npm/yarn workspaces from package.json#workspaces', () => {
    pkg('alpha', 'packages/alpha');
    pkg('beta', 'packages/beta');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
    const layout = detectWorkspace(repo);
    expect(layout?.tool).toBe('npm-workspaces');
    expect(layout?.packages.length).toBe(2);
  });

  it('detects a Lerna layout from lerna.json', () => {
    pkg('lerna-a', 'modules/a');
    pkg('lerna-b', 'modules/b');
    writeFileSync(
      join(repo, 'lerna.json'),
      JSON.stringify({ packages: ['modules/*'], version: '7.0.0' }),
    );
    const layout = detectWorkspace(repo);
    expect(layout?.tool).toBe('lerna');
    expect(layout?.packages.map((p) => p.rel).sort()).toEqual(['modules/a', 'modules/b']);
  });

  it('falls back to the dir basename when a member has no package.json#name', () => {
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
    mkdirSync(join(repo, 'apps', 'nameless', 'src'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'nameless', 'src', 'i.ts'), 'export const x = 1;\n');
    const layout = detectWorkspace(repo);
    expect(layout?.packages[0]!.name).toBe('nameless');
    expect(layout?.packages[0]!.rel).toBe('apps/nameless');
  });

  it('handles recursive `**` patterns', () => {
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "libs/**"\n');
    mkdirSync(join(repo, 'libs', 'deep', 'core', 'src'), { recursive: true });
    writeFileSync(join(repo, 'libs', 'deep', 'core', 'package.json'), '{"name":"core"}');
    writeFileSync(join(repo, 'libs', 'deep', 'core', 'src', 'i.ts'), 'export const c = 1;\n');
    const layout = detectWorkspace(repo);
    expect(layout?.packages.map((p) => p.rel)).toEqual(['libs/deep/core']);
  });
});

describe('resolvePackageArg', () => {
  const layout = {
    tool: 'pnpm' as const,
    packages: [
      { name: 'ftc-cloud', dir: '/r/packages/FTCCloud', rel: 'packages/FTCCloud' },
      { name: 'ftc-local', dir: '/r/packages/FTCLocal', rel: 'packages/FTCLocal' },
    ],
  };

  it('`all` and undefined resolve to a full walk (no packageRoots)', () => {
    expect(resolvePackageArg('/r', undefined, layout)).toEqual({
      packageRoots: undefined,
      all: true,
    });
    expect(resolvePackageArg('/r', 'all', layout)).toEqual({ packageRoots: undefined, all: true });
  });

  it('matches by name or rel path', () => {
    expect(resolvePackageArg('/r', 'ftc-cloud', layout)).toEqual({
      packageRoots: ['packages/FTCCloud'],
      all: false,
    });
    expect(resolvePackageArg('/r', 'packages/FTCLocal', layout)).toEqual({
      packageRoots: ['packages/FTCLocal'],
      all: false,
    });
  });

  it('flags an unknown package name (not a layout member)', () => {
    expect(resolvePackageArg('/r', 'ghost', layout)).toEqual({
      packageRoots: undefined,
      all: false,
      unknown: 'ghost',
    });
  });

  it('flags any arg when the repo is not a monorepo', () => {
    expect(resolvePackageArg('/r', 'anything', null)).toEqual({
      packageRoots: undefined,
      all: false,
      unknown: 'anything',
    });
  });
});

describe('discoverFiles package scoping', () => {
  beforeEach(() => {
    // two packages + a root file; only FTCCloud is selected.
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    pkg('ftc-cloud', 'packages/FTCCloud');
    pkg('ftc-local', 'packages/FTCLocal');
    writeFileSync(join(repo, 'README.md'), '# root\n');
  });

  it('full walk (no packageRoots) sees every package + root files', () => {
    const all = discoverFiles(repo).map((f) => f.path);
    expect(all).toContain('README.md');
    expect(all).toContain('packages/FTCCloud/src/index.ts');
    expect(all).toContain('packages/FTCLocal/src/index.ts');
  });

  it('packageRoots prunes sibling packages at the dir branch (only FTCCloud + root files)', () => {
    const scoped = discoverFiles(repo, { packageRoots: ['packages/FTCCloud'] }).map((f) => f.path);
    expect(scoped).toContain('packages/FTCCloud/src/index.ts');
    expect(scoped).toContain('README.md'); // root-level files stay
    expect(scoped.some((p) => p.startsWith('packages/FTCLocal'))).toBe(false);
  });

  it('multiple packageRoots keep both selected packages', () => {
    const scoped = discoverFiles(repo, {
      packageRoots: ['packages/FTCCloud', 'packages/FTCLocal'],
    }).map((f) => f.path);
    expect(scoped).toContain('packages/FTCCloud/src/index.ts');
    expect(scoped).toContain('packages/FTCLocal/src/index.ts');
  });
});