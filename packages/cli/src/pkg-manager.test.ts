import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyNpmFailure, resolveNpm, runNpm } from './pkg-manager.js';

const NEVER_EXISTS = () => false;

describe('pkg-manager — the shared package-manager launcher (WP1.1–WP1.2)', () => {
  it('prefers the npm that started this process when npm_execpath really names npm', () => {
    const res = resolveNpm({
      execPath: '/usr/local/bin/node',
      env: { npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js' },
      exists: (p) => p === '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.npm.source).toBe('npm-execpath');
      expect(res.npm.execPath).toBe('/usr/local/bin/node');
    }
  });

  it('rejects a pnpm npm_execpath — pnpm must never be run as npm', () => {
    const res = resolveNpm({
      execPath: '/usr/local/bin/node',
      env: { npm_execpath: '/path/to/lib/node_modules/.pnpm/pnpm@9.15.0/pnpm.cjs' },
      exists: NEVER_EXISTS,
      probe: () => false,
    });
    // Falls all the way through: pnpm is not npm, nothing bundled, no PATH npm.
    expect(res.ok).toBe(false);
  });

  it('finds bundled npm in the unix prefix layout (../lib/node_modules beside the bin dir)', () => {
    const script = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
    const res = resolveNpm({
      execPath: '/usr/local/bin/node',
      env: {},
      exists: (p) => p === script,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.npm.source).toBe('bundled-npm');
  });

  it('finds bundled npm in the Windows layout (node_modules beside node.exe)', () => {
    // Forward slashes are valid on Windows too and let path.join behave the same on every host
    // running this test; the platform injection only gates the PATH fallback.
    const res = resolveNpm({
      execPath: 'C:/Program Files/nodejs/node.exe',
      env: {},
      exists: (p) => p === 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js',
      platform: 'win32',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.npm.source).toBe('bundled-npm');
  });

  it('falls back to a PATH npm on non-Windows and labels it path-npm', () => {
    const res = resolveNpm({
      execPath: '/usr/local/bin/node',
      env: {},
      exists: NEVER_EXISTS,
      platform: 'linux',
      probe: () => true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.npm.source).toBe('path-npm');
  });

  it('on Windows with no bundled npm: a discovery failure with the repair action, never a .cmd shim', () => {
    const res = resolveNpm({
      execPath: 'C:\\some\\node.exe',
      env: {},
      exists: NEVER_EXISTS,
      platform: 'win32',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.phase).toBe('discovery');
      expect(res.repair).toMatch(/nodejs\.org/);
    }
  });

  it('resolves a real npm on this machine (integration: the launcher must work where it runs)', () => {
    const res = resolveNpm();
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Whatever the source, the resolved entry must be runnable — a script or the literal
      // PATH name, but never a `.cmd`/`.bat` shim.
      expect(res.npm.script).not.toMatch(/\.(cmd|bat)$/i);
      expect(res.npm.execPath).toBe(process.execPath);
    }
  });
});

describe('pkg-manager — failure taxonomy (WP1.3)', () => {
  const FALLBACK = 'Re-run with a working npm';

  it('classifies a missing executable as discovery', () => {
    const f = classifyNpmFailure(
      Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }),
      FALLBACK,
    );
    expect(f.phase).toBe('discovery');
  });

  it('classifies registry-reachability errors as network', () => {
    for (const sig of [
      'ENOTFOUND',
      'ETIMEDOUT',
      'getaddrinfo EAI_AGAIN',
      'network tunneling socket',
    ]) {
      const f = classifyNpmFailure(
        { stderr: `npm ERR! ${sig} request to https://registry.npmjs.org` },
        FALLBACK,
      );
      expect(f.phase).toBe('network');
      expect(f.repair).toMatch(/network/i);
    }
  });

  it('classifies a plain nonzero exit as install', () => {
    const f = classifyNpmFailure({ status: 1, stderr: 'npm ERR! code EUSAGE' }, FALLBACK);
    expect(f.phase).toBe('install');
    expect(f.repair).toBe(FALLBACK);
  });

  it('sanitizes: single line, bounded, newline-collapsed', () => {
    const long = `boom\n${'x'.repeat(5000)}`;
    const f = classifyNpmFailure({ status: 1, stderr: long }, FALLBACK);
    expect(f.message).not.toMatch(/\n/);
    expect(f.message.length).toBeLessThanOrEqual(810);
  });
});

describe('pkg-manager — runNpm', () => {
  it('returns the discovery failure instead of spawning when nothing resolves', () => {
    const res = runNpm('/tmp', ['--version'], {
      execPath: '/nonexistent/node',
      env: {},
      exists: NEVER_EXISTS,
      platform: 'win32',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.phase).toBe('discovery');
  });

  it('runs a real npm command to completion (integration: --version is side-effect free)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crib-pkgmgr-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"t","private":true}');
      const res = runNpm(dir, ['--version']);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
