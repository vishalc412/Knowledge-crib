/**
 * `crib setup` and the mandatory-by-default onboarding.
 *
 * Two behaviours are pinned here because both are REVERSALS of a previous default, and a silent
 * revert of either would put the repository back in the state this change exists to fix:
 *
 *  1. `crib init` writes the protocol for EVERY client unless told otherwise. The protocol block now
 *     opens with "Knowledge-crib is MANDATORY in this repository"; a client that merely failed to be
 *     detected must not be silently exempt from it. `--ide detected` keeps the narrow behaviour.
 *  2. The semantic tier installs by DEFAULT. It used to prompt on a TTY and skip everywhere else, so
 *     every scripted onboarding finished on the 2.6%-paraphrase lexical fallback with no signal that
 *     anything was missing. `--no-embed` / `KCRIB_NO_EMBED=1` are the escape hatches, and this suite
 *     uses them throughout — a test must never pull ~2.1 GB of weights.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'dist', 'cli.js');

interface Run {
  status: number;
  out: string;
}

/**
 * `bare: true` builds the child environment from scratch instead of inheriting this one. Client
 * detection reads env vars, and the suite itself usually runs INSIDE a detected client (this repo's
 * own test run inherits `CLAUDE_CODE_ENTRYPOINT`), so an inherited environment makes "detect
 * nothing" untestable — and makes the result depend on whoever ran the suite.
 */
function runCli(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  opts: { bare?: boolean } = {},
): Run {
  const base: NodeJS.ProcessEnv = opts.bare
    ? {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      }
    : process.env;
  try {
    const out = execFileSync(process.execPath, [CLI, ...argv], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...base, NO_COLOR: '1', KCRIB_NO_EMBED: '1', ...env },
      maxBuffer: 1024 * 1024 * 64,
    });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let repo: string;
const git = (args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-setup-'));
  writeFileSync(
    join(repo, 'app.ts'),
    'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n',
  );
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'initial']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('crib setup — discoverability and argument validation', () => {
  it('is listed in --help alongside init', () => {
    const help = runCli(['--help'], repo);
    expect(help.status).toBe(0);
    expect(help.out).toMatch(/crib setup \[path\]/);
    expect(help.out).toMatch(/crib init \[path\]/);
  });

  it('--help names every step it runs, so the one command is auditable before running it', () => {
    const help = runCli(['setup', '--help'], repo);
    expect(help.status).toBe(0);
    for (const step of [
      'crib index',
      'crib install-hooks',
      'crib mcp install',
      'crib adapters install',
      'crib embed setup',
      'crib memory init',
      'crib doctor',
    ]) {
      expect(help.out).toContain(step);
    }
    // The escape hatches must be documented in the same place as the defaults they override.
    expect(help.out).toContain('--no-embed');
    expect(help.out).toContain('KCRIB_NO_EMBED=1');
    expect(help.out).toContain('--ide detected');
  });

  it('rejects an unknown --ide and names `detected` among the valid values', () => {
    const r = runCli(['init', '.', '--ide', 'emacs'], repo);
    expect(r.status).toBe(2);
    expect(r.out).toContain('unknown --ide: emacs');
    expect(r.out).toMatch(/valid: .*detected/);
  });

  it('rejects an unknown --embed-model instead of silently installing the default', () => {
    // Silently falling back would install a 2.1 GB model the operator did not ask for; the old
    // interactive picker did exactly that with a typo'd answer.
    const r = runCli(['init', '.', '--embed-model', 'huge'], repo, { KCRIB_NO_EMBED: '' });
    expect(r.status).toBe(2);
    expect(r.out).toContain('unknown --embed-model: huge');
  });

  it('resolves the repo root from --cwd, not from the value of --ide', () => {
    // `--ide` was not in VALUE_FLAGS, so `crib init --ide claude` (no path) resolved the project
    // root to `./claude`.
    const r = runCli(['init', '--ide', 'claude', '--no-embed'], repo);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, 'claude'))).toBe(false);
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(true);
  });
});

describe('crib init — the mandatory default writes every client', () => {
  it('writes the protocol into every client instruction file with no --ide', () => {
    const r = runCli(['init', '.', '--no-embed'], repo);
    expect(r.status).toBe(0);
    expect(r.out).toContain('crib is mandatory for this repository');
    for (const file of [
      'CLAUDE.md',
      'AGENTS.md',
      'GEMINI.md',
      '.windsurfrules',
      join('.github', 'copilot-instructions.md'),
      join('.cursor', 'rules', 'crib.mdc'),
    ]) {
      const path = join(repo, file);
      expect(existsSync(path), `${file} should exist`).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(
        'Knowledge-crib is MANDATORY in this repository',
      );
    }
  });

  it('--ide detected keeps the narrow behaviour: the neutral file only, no IDE config', () => {
    const r = runCli(['init', '.', '--ide', 'detected', '--no-embed'], repo, {}, { bare: true });
    expect(r.status).toBe(0);
    expect(r.out).toContain('none detected');
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    for (const file of ['GEMINI.md', '.windsurfrules', 'CLAUDE.md']) {
      expect(existsSync(join(repo, file)), `${file} should NOT be written`).toBe(false);
    }
    // A config file's location IS the client identity, so an unidentified client gets none.
    expect(existsSync(join(repo, '.mcp.json'))).toBe(false);
  });

  it('reports the skipped tier honestly rather than implying recall is semantic', () => {
    const r = runCli(['init', '.', '--no-embed'], repo);
    expect(r.out).toContain('--no-embed');
    expect(r.out).toMatch(/recall stays LEXICAL/);
    expect(r.out).toContain('crib embed setup --yes');
  });
});

describe('crib setup — the full install in one command', () => {
  it('runs onboarding, creates the memory stores, and finishes with the health check', () => {
    const r = runCli(['setup', '.', '--no-embed'], repo);
    expect(r.status).toBe(0);
    // onboarding
    expect(existsSync(join(repo, '.crib'))).toBe(true);
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(repo, '.mcp.json'))).toBe(true);
    // memory stores — the step `crib init` alone never ran
    expect(existsSync(join(repo, '.crib', 'memory', 'policy.json'))).toBe(true);
    expect(r.out).toContain('team store:');
    // and the last thing on screen is what is actually working
    expect(r.out).toMatch(/health check:/);
    expect(r.out).toContain('crib setup complete');
  });

  it('is idempotent — a second run re-wires without duplicating the managed block', () => {
    expect(runCli(['setup', '.', '--no-embed'], repo).status).toBe(0);
    expect(runCli(['setup', '.', '--no-embed'], repo).status).toBe(0);
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    expect(claude.split('<!-- crib:start -->').length - 1).toBe(1);
    expect(claude.split('<!-- crib:end -->').length - 1).toBe(1);
  });
});
