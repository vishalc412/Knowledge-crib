import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitignoreMatcher, parseGitignore, readGitignore } from './gitignore.js';
import type { GitignoreRule } from './gitignore.js';
import { discoverFiles } from './structure.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-git-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('parseGitignore', () => {
  it('skips comments, blanks, and parses negation + dir-suffix + anchor', () => {
    const rules = parseGitignore(
      [
        '# a comment',
        '',
        '.gstack/',
        '*.log',
        '!keep.log',
        'python/models/',
        '.vscode/*',
        '!.vscode/extensions.json',
        '/rooted.txt',
        '*.py[cod]',
      ].join('\n'),
    );
    // 8 non-comment, non-blank lines → 8 rules.
    expect(rules).toHaveLength(8);
    const matches = (r: GitignoreRule | undefined, path: string, isDir = false): boolean =>
      !!r && (!r.dirOnly || isDir) && r.re.test(path);
    // .gstack/ → dir-only, unanchored (matches at any depth)
    expect(rules[0]!).toMatchObject({ negated: false, dirOnly: true, anchored: false });
    expect(matches(rules[0], '.gstack', true)).toBe(true);
    expect(matches(rules[0], 'src/.gstack', true)).toBe(true);
    expect(matches(rules[0], '.gstack/x', false)).toBe(false); // dirOnly → file not matched
    // *.log → unanchored glob
    expect(rules[1]!).toMatchObject({ negated: false, dirOnly: false, anchored: false });
    expect(matches(rules[1], 'app.log')).toBe(true);
    expect(matches(rules[1], 'a/b/c.log')).toBe(true);
    expect(matches(rules[1], 'app.ts')).toBe(false);
    // !keep.log → negated
    expect(rules[2]!).toMatchObject({ negated: true, dirOnly: false, anchored: false });
    // python/models/ → anchored dir-only
    expect(rules[3]!).toMatchObject({ negated: false, dirOnly: true, anchored: true });
    expect(matches(rules[3], 'python/models', true)).toBe(true);
    expect(matches(rules[3], 'x/python/models', true)).toBe(false); // anchored → root only
    // .vscode/* + its re-include → anchored
    expect(rules[4]!).toMatchObject({ negated: false, dirOnly: false, anchored: true });
    expect(matches(rules[4], '.vscode/settings.json')).toBe(true);
    expect(rules[5]!).toMatchObject({ negated: true, dirOnly: false, anchored: true });
    expect(matches(rules[5], '.vscode/extensions.json')).toBe(true);
    // /rooted.txt → leading slash stripped → unanchored single name
    expect(rules[6]!).toMatchObject({ negated: false, dirOnly: false, anchored: false });
    expect(matches(rules[6], 'rooted.txt')).toBe(true);
    // *.py[cod] → char class
    expect(matches(rules[7], 'app.pyc')).toBe(true);
    expect(matches(rules[7], 'app.pyo')).toBe(true);
    expect(matches(rules[7], 'app.pyd')).toBe(true);
    expect(matches(rules[7], 'app.py')).toBe(false);
  });

  it('treats a bare ! or / as a no-op rule (nothing to match)', () => {
    const rules = parseGitignore('!\n/\n');
    expect(rules).toHaveLength(0);
  });
});

describe('GitignoreMatcher', () => {
  it('matches unanchored names at any depth', () => {
    const m = new GitignoreMatcher();
    m.add('', parseGitignore('node_modules/'));
    expect(m.isIgnored('node_modules', true)).toBe(true);
    expect(m.isIgnored('src/node_modules', true)).toBe(true);
    expect(m.isIgnored('node_modules/x.ts', false)).toBe(false); // dirOnly → file not matched
    expect(m.isIgnored('src/auth.ts', false)).toBe(false);
  });

  it('matches globs and honors ! re-include (last match wins)', () => {
    const m = new GitignoreMatcher();
    m.add('', parseGitignore('*.log\n!keep.log'));
    expect(m.isIgnored('app.log', false)).toBe(true);
    expect(m.isIgnored('a/b/c.log', false)).toBe(true);
    expect(m.isIgnored('keep.log', false)).toBe(false); // re-included
  });

  it('anchors patterns with a slash to the gitignore dir', () => {
    const m = new GitignoreMatcher();
    m.add('', parseGitignore('python/models/\n.venv/'));
    expect(m.isIgnored('python/models', true)).toBe(true);
    expect(m.isIgnored('python/models/whisper.bin', false)).toBe(false); // dir skipped, file never seen
    expect(m.isIgnored('other/python/models', true)).toBe(false); // anchored → only at root
    expect(m.isIgnored('.venv', true)).toBe(true); // unanchored (no slash after strip)
  });

  it('scopes nested .gitignore rules to their subtree and lets them override the root', () => {
    const m = new GitignoreMatcher();
    m.add('', parseGitignore('*.log\n!keep.log')); // root: ignore *.log, but keep.log is re-included
    m.add('sub', parseGitignore('keep.log')); // nested: ignore keep.log under sub/
    expect(m.isIgnored('keep.log', false)).toBe(false); // root re-include wins at root
    expect(m.isIgnored('sub/keep.log', false)).toBe(true); // nested override → ignored
    expect(m.isIgnored('sub/other.log', false)).toBe(true); // root *.log still applies under sub
    expect(m.isIgnored('elsewhere/keep.log', false)).toBe(false); // nested layer doesn't apply
  });

  it('does not leak a nested layer into a sibling subtree', () => {
    const m = new GitignoreMatcher();
    m.add('a', parseGitignore('secret.env'));
    expect(m.isIgnored('a/secret.env', false)).toBe(true);
    expect(m.isIgnored('b/secret.env', false)).toBe(false); // sibling not affected
  });
});

describe('readGitignore', () => {
  it('returns [] when no .gitignore exists', () => {
    expect(readGitignore(repo, '')).toEqual([]);
  });
  it('reads + parses the repo .gitignore', () => {
    writeFileSync(join(repo, '.gitignore'), '*.log\n.env\n');
    const rules = readGitignore(repo, '');
    expect(rules).toHaveLength(2);
    expect(rules[1]!.re.test('.env')).toBe(true);
    expect(rules[1]!.re.test('config/.env')).toBe(true);
  });
});

describe('discoverFiles respects .gitignore (integration)', () => {
  it('excludes gitignored files + dirs and keeps source', () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.gstack'), { recursive: true });
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.gitignore'),
      ['.gstack/', '.claude/', '*.log', '.env', ''].join('\n'),
    );
    writeFileSync(join(repo, 'src', 'auth.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'src', 'debug.log'), 'noise\n');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    writeFileSync(join(repo, '.gstack', 'audit.jsonl'), '{}\n');
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}\n');
    const files = discoverFiles(repo)
      .map((f) => f.path)
      .sort();
    // .gitignore itself is tracked repo content → kept; src/auth.ts kept; everything else excluded.
    expect(files).toEqual(['.gitignore', 'src/auth.ts']);
  });

  it('DEFAULT_IGNORES still prunes node_modules even if a .gitignore tries to re-include it', () => {
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), '!node_modules/\n');
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'src', 'auth.ts'), 'export const x = 1;\n');
    const files = discoverFiles(repo)
      .map((f) => f.path)
      .sort();
    expect(files).toEqual(['.gitignore', 'src/auth.ts']); // node_modules stays pruned (baseline wins)
  });

  it('honors a nested .gitignore scoped to its subtree', () => {
    mkdirSync(join(repo, 'pkg', 'gen'), { recursive: true });
    mkdirSync(join(repo, 'pkg', 'src'), { recursive: true });
    mkdirSync(join(repo, 'other', 'gen'), { recursive: true });
    writeFileSync(join(repo, 'pkg', '.gitignore'), 'gen/\n');
    writeFileSync(join(repo, 'pkg', 'gen', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'pkg', 'src', 'b.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, 'other', 'gen', 'c.ts'), 'export const c = 1;\n');
    const files = discoverFiles(repo)
      .map((f) => f.path)
      .sort();
    // pkg/.gitignore is itself tracked content (not self-ignored) → kept; pkg/gen/ excluded by the
    // nested rule; other/gen/ has no .gitignore above it → kept.
    expect(files).toEqual(['other/gen/c.ts', 'pkg/.gitignore', 'pkg/src/b.ts'].sort());
  });
});
