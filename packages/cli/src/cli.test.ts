import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('crib ask — natural-language CLI dispatch', () => {
  it('markdown answer explains a symbol by qualified name', () => {
    const md = runCli(['ask', 'loan_pkg.process_one', '--format', 'markdown']);
    expect(md).toContain('# loan_pkg.process_one');
    expect(md).toContain('interpretation:');
    expect(md).toContain('loan_pkg');
  });

  it('discovery answer searches the index and returns graph hits', () => {
    const out = runCli(['ask', 'C_THRESHOLD', '--limit', '5']);
    const r = JSON.parse(out) as {
      interpretation: string;
      hits: Array<{ id: string; snippet?: string }>;
    };
    expect(r.interpretation).toBe('discovery');
    expect(r.hits.length).toBeGreaterThan(0);
    const text = r.hits.map((h) => `${h.id} ${h.snippet ?? ''}`).join('\n');
    expect(text).toMatch(/loan_pkg|C_THRESHOLD/i);
  });

  it('overview question falls back to cluster summary when no LLM bible exists', () => {
    const out = runCli(['ask', 'what is the architecture']);
    const r = JSON.parse(out) as {
      interpretation: string;
      fallback?: { clusters: unknown[] };
    };
    expect(r.interpretation).toBe('overview');
    expect(r.fallback?.clusters).toBeDefined();
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

describe('crib index --package (workspace-aware indexing) — CLI dispatch', () => {
  let wsRepo: string;
  const wsPkg = (name: string, rel: string): void => {
    const dir = join(wsRepo, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), `export const ${name.replace(/-/g, '_')} = 1;\n`);
  };
  const runWs = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: wsRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };

  beforeEach(() => {
    wsRepo = mkdtempSync(join(tmpdir(), 'crib-cli-ws-'));
    writeFileSync(join(wsRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(join(wsRepo, 'README.md'), '# root\n');
    wsPkg('ftc-cloud', 'packages/FTCCloud');
    wsPkg('ftc-local', 'packages/FTCLocal');
  });
  afterEach(() => rmSync(wsRepo, { recursive: true, force: true }));

  const fileCount = (stdout: string): number => {
    const m = stdout.match(/indexed (\d+) files/);
    return m ? Number(m[1]!) : -1;
  };

  it('indexes the full repo when no --package is given, but lists detected packages on stderr', () => {
    const r = runWs(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('monorepo detected (pnpm)');
    expect(r.stderr).toContain('ftc-cloud');
    expect(r.stderr).toContain('--package');
    expect(r.stdout).toMatch(/indexed \d+ files/);
    expect(r.stdout).not.toContain('[scoped:');
    // full walk sees both packages + root files
    expect(fileCount(r.stdout)).toBeGreaterThanOrEqual(6);
  });

  it('scopes discovery to one package with --package <name> (sibling pruned)', () => {
    const scoped = runWs(['index', '.', '--package', 'ftc-cloud']);
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('[scoped: packages/FTCCloud]');
    const scopedCount = fileCount(scoped.stdout);
    // scoped walk: FTCCloud package.json + index.ts + root README + workspace.yaml (4), NOT FTCLocal
    expect(scopedCount).toBeLessThanOrEqual(4);
    // the FTCLocal source file never enters the soul
    expect(scoped.stdout).not.toContain('FTCLocal');

    const full = runWs(['index', '.', '--package', 'all']);
    expect(full.status).toBe(0);
    expect(full.stdout).not.toContain('[scoped:');
    expect(fileCount(full.stdout)).toBeGreaterThan(scopedCount);
  });

  it('scopes by repo-relative path too', () => {
    const r = runWs(['index', '.', '--package', 'packages/FTCLocal']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[scoped: packages/FTCLocal]');
  });

  it('rejects an unknown package name as BAD_ARGS with the valid names listed', () => {
    const r = runWs(['index', '.', '--package', 'ghost']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown package: ghost');
    expect(r.stderr).toContain('ftc-cloud');
    expect(r.stderr).toContain('ftc-local');
  });

  it('records the workspace + indexedPackages in the soul manifest meta', () => {
    const r = runWs(['index', '.', '--package', 'ftc-cloud']);
    expect(r.status).toBe(0);
    const manifest = JSON.parse(
      execFileSync('cat', [join(wsRepo, '.crib', 'crib.json')], { encoding: 'utf8' }),
    ) as { meta?: { workspace?: { tool: string }; indexedPackages?: string[] } };
    expect(manifest.meta?.workspace?.tool).toBe('pnpm');
    expect(manifest.meta?.indexedPackages).toEqual(['packages/FTCCloud']);
  });
});

describe('crib index — token-savings hero output (P1 instant value)', () => {
  let heroRepo: string;
  const runHero = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: heroRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };

  afterEach(() => rmSync(heroRepo, { recursive: true, force: true }));

  it('prints a real measured token-savings ratio when a central, well-called symbol exists', () => {
    heroRepo = mkdtempSync(join(tmpdir(), 'crib-cli-hero-'));
    writeFileSync(join(heroRepo, 'package.json'), JSON.stringify({ name: 'hero', type: 'module' }));
    mkdirSync(join(heroRepo, 'src'), { recursive: true });
    // a deliberately central function (high in-degree) called from several other files padded with
    // unrelated content, so the raw-file-read cost meaningfully exceeds the one-line query response.
    const filler = Array.from({ length: 40 }, (_, i) => `export const filler${i} = ${i};`).join(
      '\n',
    );
    writeFileSync(
      join(heroRepo, 'src', 'core.ts'),
      `${filler}\nexport function widgetCore(id: string): string {\n  return id.toUpperCase();\n}\n`,
    );
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(heroRepo, 'src', `caller${i}.ts`),
        `${filler}\nimport { widgetCore } from './core.js';\nexport function use${i}(): string {\n  return widgetCore('x${i}');\n}\n`,
      );
    }
    const r = runHero(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /≈\d+(\.\d+)?x fewer tokens per discovery query than reading files directly/,
    );
    expect(r.stdout).toContain('via crib query');
  });

  it('omits the hero line on a tiny repo where the win is not real (no overclaiming)', () => {
    heroRepo = mkdtempSync(join(tmpdir(), 'crib-cli-hero-tiny-'));
    writeFileSync(join(heroRepo, 'package.json'), JSON.stringify({ name: 'tiny', type: 'module' }));
    mkdirSync(join(heroRepo, 'src'), { recursive: true });
    writeFileSync(
      join(heroRepo, 'src', 'a.ts'),
      'export function one(): number {\n  return 1;\n}\n',
    );
    const r = runHero(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/fewer tokens per discovery query/);
  });
});

describe('crib skill install --dest — cross-client skill installation', () => {
  it('does not mistake the destination value for a skill name', () => {
    const dest = join(repo, 'codex-skills');
    const first = runCliResult(['skill', 'install', '--dest', dest]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`crib-enrich: installed → ${join(dest, 'crib-enrich')}`);
    expect(readFileSync(join(dest, 'crib-enrich', 'SKILL.md'), 'utf8')).toContain('# crib-enrich');

    const second = runCliResult(['skill', 'install', '--dest', dest]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('crib-enrich: already up to date');
  });

  it('rejects a missing --dest value', () => {
    const result = runCliResult(['skill', 'install', '--dest']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: crib skill install [name] [--dest <dir>]');
  });
});

describe('crib update --package (P4 multi-package federation) — CLI dispatch', () => {
  let fedRepo: string;
  const runFed = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: fedRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (s: string): string =>
      s
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };
  const git = (args: string[]): string =>
    execFileSync('git', ['-C', fedRepo, ...args], { encoding: 'utf8' }).trim();

  beforeEach(() => {
    fedRepo = mkdtempSync(join(tmpdir(), 'crib-cli-fed-'));
    writeFileSync(join(fedRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    for (const [name, rel] of [
      ['pkg-a', 'packages/pkg-a'],
      ['pkg-b', 'packages/pkg-b'],
    ] as const) {
      mkdirSync(join(fedRepo, rel, 'src'), { recursive: true });
      writeFileSync(join(fedRepo, rel, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
      writeFileSync(
        join(fedRepo, rel, 'src', 'index.ts'),
        `export const ${name.replace('-', '_')} = 1;\n`,
      );
    }
    git(['init', '-q']);
    git(['add', '-A']);
    git(['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'initial']);
  });
  afterEach(() => rmSync(fedRepo, { recursive: true, force: true }));

  it('scopes an incremental update to one package, leaving the other package pending and the anchor un-advanced', () => {
    const indexed = runFed(['index', '.']);
    expect(indexed.status).toBe(0);
    const h1 = git(['rev-parse', 'HEAD']);

    writeFileSync(
      join(fedRepo, 'packages', 'pkg-a', 'src', 'index.ts'),
      'export const pkg_a = 2;\n',
    );
    writeFileSync(
      join(fedRepo, 'packages', 'pkg-b', 'src', 'index.ts'),
      'export const pkg_b = 2;\n',
    );
    git(['add', 'packages/pkg-a/src/index.ts', 'packages/pkg-b/src/index.ts']);
    git(['-c', 'user.email=t@t.test', '-c', 'user.name=T', 'commit', '-q', '-m', 'edit both']);

    const scoped = runFed(['update', '.', '--package', 'pkg-a']);
    expect(scoped.status).toBe(0);
    expect(scoped.stdout).toContain('outside scope');
    expect(scoped.stdout).toContain('anchor not advanced');

    const manifest = JSON.parse(readFileSync(join(fedRepo, '.crib', 'crib.json'), 'utf8')) as {
      repo: { vcsHead: string };
    };
    expect(manifest.repo.vcsHead).toBe(h1);
  });
});

describe('crib index — cross-process writer lock (M0.6)', () => {
  let lockRepo: string;
  const runLock = (args: string[]): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: lockRepo,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const stripNoise = (str: string): string =>
      str
        .split('\n')
        .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
        .join('\n')
        .trim();
    return {
      status: r.status ?? 1,
      stdout: stripNoise(r.stdout ?? ''),
      stderr: stripNoise(r.stderr ?? ''),
    };
  };
  beforeEach(() => {
    lockRepo = mkdtempSync(join(tmpdir(), 'crib-cli-lock-'));
    writeFileSync(join(lockRepo, 'README.md'), '# locked\n');
    mkdirSync(join(lockRepo, 'src'), { recursive: true });
    writeFileSync(join(lockRepo, 'src', 'a.ts'), 'export const a = 1;\n');
  });
  afterEach(() => rmSync(lockRepo, { recursive: true, force: true }));

  it('leaves no .lock behind after a clean index', () => {
    const r = runLock(['index', '.']);
    expect(r.status).toBe(0);
    expect(existsSync(join(lockRepo, '.crib', '.lock'))).toBe(false);
  });

  it('refuses to index when a live-pid lock already holds (exit 4 LOCKED)', () => {
    mkdirSync(join(lockRepo, '.crib'), { recursive: true });
    // the test process is alive and is NOT the child crib will spawn → foreign live holder
    writeFileSync(join(lockRepo, '.crib', '.lock'), `${process.pid}\n`);
    const r = runLock(['index', '.']);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('crib is busy');
  });

  it('self-heals a stale (dead-pid) lock and indexes successfully', () => {
    mkdirSync(join(lockRepo, '.crib'), { recursive: true });
    // a pid nothing owns → dead → stale → stolen on acquire
    writeFileSync(join(lockRepo, '.crib', '.lock'), '4194304\n');
    const r = runLock(['index', '.']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/indexed \d+ files/);
    expect(existsSync(join(lockRepo, '.crib', '.lock'))).toBe(false);
  });
});

describe('crib federated-impact (M3.2) — CLI dispatch + id-parse regression', () => {
  it('parses the id as the positional AFTER flag values, not the --dir value', () => {
    // Regression: `args.find(!startsWith('-'))` resolved id to 'down' (the --dir VALUE) when --dir
    // preceded the id. positionalsOf strips VALUE_FLAGS values so the id is the real positional.
    // With the bug, the verb got id='down' → NOT_FOUND; with the fix, id='loan_pkg.process_one'
    // resolves and the result has a `root` (no error). The PL/SQL fixture has no http-call, so the
    // down traversal is empty — this still proves dispatch + id resolution + the verb shape.
    const out = runCli(['federated-impact', '--dir', 'down', 'loan_pkg.process_one']);
    const r = JSON.parse(out) as {
      root?: string;
      dir?: string;
      federatedRoots?: string[];
      affected?: unknown[];
      crossRepoHops?: number;
      error?: { code: string };
    };
    expect(r.error).toBeUndefined();
    expect(r.dir).toBe('down');
    expect(typeof r.root).toBe('string');
    expect(Array.isArray(r.affected)).toBe(true);
    expect(r.crossRepoHops).toBe(0);
  });

  it('accepts the `federated` alias', () => {
    const out = runCli(['federated', '--dir', 'down', 'loan_pkg.process_one']);
    const r = JSON.parse(out) as { dir?: string; error?: { code: string } };
    expect(r.error).toBeUndefined();
    expect(r.dir).toBe('down');
  });

  it('exits BAD_ARGS when --dir is missing', () => {
    const r = runCliResult(['federated-impact', 'loan_pkg.process_one']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits BAD_ARGS when --dir is not up|down', () => {
    const r = runCliResult(['federated-impact', '--dir', 'sideways', 'loan_pkg.process_one']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });

  it('exits BAD_ARGS when the id is missing', () => {
    const r = runCliResult(['federated-impact', '--dir', 'down']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage:/);
  });
});
