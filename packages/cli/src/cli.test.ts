import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, newManifest, openIndex } from '@knowledge-crib/core';
import { indexRepo } from '@knowledge-crib/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * End-to-end CLI dispatch tests for the P2 surface: `context --package <pkg>` (WS-4 bulk dossierByScope)
 * and `reconstruct <pkg>` (WS-6). Drives the BUILT `dist/cli.js` as a subprocess against a temp repo the
 * pipeline has indexed, so these exercise the real arg parsing + scope routing + the maxSymbols guard
 * (Blocker 2 regression) — not just the verbs (which are covered in @knowledge-crib/core / @knowledge-crib/mcp).
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');

let repo: string;
let pkgQname: string;

// A PL/SQL package SPEC with the two migration-critical CONSTANT thresholds (30/80) + three member
// procedures (so maxSymbols cap/truncation is testable). Mirrors the parser's captured shape
// (CONSTANT keyword precedes the type).
const SPEC = `CREATE OR REPLACE PACKAGE loan_pkg IS
  C_THRESHOLD_AUTO_REJECT   CONSTANT NUMBER := 30;
  C_THRESHOLD_AUTO_APPROVE  CONSTANT NUMBER := 80;
  PROCEDURE process_one(p_id NUMBER);
  PROCEDURE process_two(p_id NUMBER);
  PROCEDURE process_three(p_id NUMBER);
END loan_pkg;
/
`;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'crib-cli-e2e-'));
  mkdirSync(join(repo, 'db'), { recursive: true });
  writeFileSync(join(repo, 'db', 'loan_pkg_spec.sql'), SPEC);
  pkgQname = 'loan_pkg';
  // index the temp repo so .crib exists at the repo root (the CLI resolves .crib from cwd)
  const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ root: '.' }) });
  soul.load();
  await indexRepo(soul, repo);
  mkdirSync(join(repo, '.crib', 'index'), { recursive: true });
  const index = openIndex(soul.getManifest().stores.index.backend, {
    path: join(repo, '.crib', 'index', 'crib.sqlite'),
  });
  index.buildFromSoul(soul, repo);
  index.close();
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** Run the CLI from the temp repo root, returning parsed JSON (or raw stdout for markdown). */
function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Run the CLI capturing a non-zero exit (e.g. BAD_ARGS) instead of throwing. */
function runCliResult(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout: out.trim(), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
    };
  }
}

describe('crib context --package (WS-4 bulk dossierByScope) — CLI dispatch', () => {
  it('returns all package members in one call (scope=package, per-symbol dossiers)', () => {
    const out = runCli(['context', '--package', pkgQname]);
    const r = JSON.parse(out) as {
      scope: string;
      label: string;
      symbolCount: number;
      symbols: Array<{ node: { qualifiedName?: string } }>;
      truncated: boolean;
      skipped: string[];
    };
    expect(r.scope).toBe('package');
    expect(r.label).toBe(pkgQname);
    // the package itself is NOT a member (members are the 3 procedures); spec-only → all unimplemented
    expect(r.symbolCount).toBe(3);
    expect(r.symbols).toHaveLength(3);
    expect(r.truncated).toBe(false);
    expect(r.skipped).toEqual([]);
    const qnames = r.symbols.map((s) => s.node.qualifiedName).sort();
    expect(qnames).toEqual(
      ['loan_pkg.process_one', 'loan_pkg.process_three', 'loan_pkg.process_two'].sort(),
    );
  });

  it('resolves by qualified name and supports --format markdown + --max-symbols cap', () => {
    // markdown format dispatches through dossiersByScopeToMarkdown
    const md = runCli(['context', '--package', pkgQname, '--format', 'markdown']);
    expect(md).toContain('# Dossier-by-scope: loan_pkg');
    expect(md).toContain('- symbols: 3');
    // the cap: --max-symbols 1 → truncated, symbolCount still 3
    const capped = JSON.parse(runCli(['context', '--package', pkgQname, '--max-symbols', '1'])) as {
      symbolCount: number;
      symbols: unknown[];
      truncated: boolean;
    };
    expect(capped.symbols).toHaveLength(1);
    expect(capped.symbolCount).toBe(3);
    expect(capped.truncated).toBe(true);
  });
});

describe('read commands use an existing derived index instead of rebuilding it', () => {
  it('reports a clear reindex instruction when the derived sqlite index is missing', async () => {
    const missingRepo = mkdtempSync(join(tmpdir(), 'crib-cli-missing-index-'));
    try {
      mkdirSync(join(missingRepo, 'db'), { recursive: true });
      writeFileSync(join(missingRepo, 'db', 'loan_pkg_spec.sql'), SPEC);
      const missingSoul = new SoulStore(join(missingRepo, '.crib'), {
        manifest: newManifest({ root: '.' }),
      });
      missingSoul.load();
      await indexRepo(missingSoul, missingRepo);

      const result = (() => {
        try {
          execFileSync(process.execPath, [CLI, 'status', '.'], {
            cwd: missingRepo,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { status: 0, stderr: '' };
        } catch (e) {
          const err = e as { status?: number; stderr?: string };
          return { status: err.status ?? 1, stderr: (err.stderr ?? '').trim() };
        }
      })();

      expect(result.status).toBe(3);
      expect(result.stderr).toContain('derived index missing or stale');
      expect(result.stderr).toContain('run `crib index .`');
    } finally {
      rmSync(missingRepo, { recursive: true, force: true });
    }
  });
});

describe('crib reconstruct (WS-6) — CLI dispatch + maxSymbols guard (Blocker 2 regression)', () => {
  it('markdown emits the 30/80 thresholds + expectedBodyFile + members', () => {
    const out = runCli(['reconstruct', pkgQname, '--format', 'markdown']);
    // the markdown is wrapped in a JSON { id, markdown } envelope (verbs.reconstruct format:path)
    const parsed = JSON.parse(out) as { markdown: string };
    const md = parsed.markdown;
    expect(md).toContain('# Reconstruct: loan_pkg');
    expect(md).toContain('C_THRESHOLD_AUTO_REJECT');
    expect(md).toContain('`30`');
    expect(md).toContain('C_THRESHOLD_AUTO_APPROVE');
    expect(md).toContain('`80`');
    // spec file is db/loan_pkg_spec.sql → expected body db/loan_pkg_body.sql
    expect(md).toContain('expectedBodyFile: `db/loan_pkg_body.sql`');
    expect(md).toContain('- members: 3');
  });

  it('a valid --max-symbols cap truncates (1 of 3), JSON shape', () => {
    const out = runCli(['reconstruct', pkgQname, '--max-symbols', '1']);
    const r = JSON.parse(out) as { memberCount: number; members: unknown[]; truncated: boolean };
    expect(r.members).toHaveLength(1);
    expect(r.memberCount).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('Blocker 2 regression: --max-symbols -5 is REJECTED (no silent slice(0,-5) corruption)', () => {
    // Before the fix, `--max-symbols -5` forwarded -5 → slice(0,-5) silently dropped all members
    // (or returned a corrupted tail). The guard now rejects non-positive values, so the FULL set is
    // returned: members.length === memberCount === 3, truncated false.
    const out = runCli(['reconstruct', pkgQname, '--max-symbols', '-5']);
    const r = JSON.parse(out) as { memberCount: number; members: unknown[]; truncated: boolean };
    expect(r.members).toHaveLength(3);
    expect(r.memberCount).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it('Blocker 2 regression: --max-symbols 0 is also rejected (no empty slice)', () => {
    const out = runCli(['reconstruct', pkgQname, '--max-symbols', '0']);
    const r = JSON.parse(out) as { memberCount: number; members: unknown[]; truncated: boolean };
    expect(r.members).toHaveLength(3);
    expect(r.memberCount).toBe(3);
    expect(r.truncated).toBe(false);
  });
});

describe('crib enrich --scope / --scope-cluster / --save flag guards (scope-picker hardening)', () => {
  it('--scope with no value is REJECTED as BAD_ARGS (no silent full-repo default)', () => {
    // The silent default to full-repo on a malformed --scope is the exact failure mode the scope
    // picker exists to prevent; it MUST surface as BAD_ARGS, not a quiet unscoped run.
    const r = runCliResult(['enrich', '--scope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--scope requires a path prefix');
  });

  it('--scope --next (flag-like value) is REJECTED as BAD_ARGS', () => {
    const r = runCliResult(['enrich', '--scope', '--next']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--scope requires a path prefix');
  });

  it('--scope-cluster with no value is REJECTED as BAD_ARGS', () => {
    const r = runCliResult(['enrich', '--scope', 'db', '--scope-cluster']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--scope-cluster requires a cluster id');
  });

  it('--save with no value is REJECTED as BAD_ARGS (no ENOENT crash on a missing file path)', () => {
    const r = runCliResult(['enrich', '--save']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: crib enrich --save');
  });

  it('--save --scope foo (flag-like value) is REJECTED as BAD_ARGS, not treated as a file', () => {
    const r = runCliResult(['enrich', '--save', '--scope', 'foo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: crib enrich --save');
  });

  it('a valid --scope runs scoped (exit 0): scopeEcho present, system reported separately, scoped pending hint not inflated by system', () => {
    const r = runCliResult(['enrich', '--scope', 'db']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"scopeEcho"');
    expect(r.stdout).toContain('"pathPrefix": "db"');
    expect(r.stdout).toContain('"wholeRepoPending"');
    // The scoped pending sum excludes the whole-repo system target, which is reported on its own line.
    expect(r.stdout).toMatch(/\d+ target\(s\) pending/);
    expect(r.stdout).toContain('whole-repo system target(s) still pending');
  });
});
