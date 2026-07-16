/**
 * onboarding-check — the M4.2 "5-minute onboarding" gate.
 *
 * Pins the plan's M4.2 gate intent: "clean machine → first MCP query < 5 min." The deliverable is
 * two CLI commands — `crib init` (orchestrates index + install-hooks + mcp install + a next-steps
 * hero) and `crib doctor` (six health checks with ✓/✗ + fix hints). The human stopwatch is the real
 * gate, but THIS script pins the BEHAVIORAL properties the 5-minute promise depends on: that `init`
 * actually produces an indexed, hooked, MCP-wired repo in one command, and that `doctor` correctly
 * reports a clean setup as clean and a broken setup as broken (so a stuck user can self-diagnose).
 *
 * Method (shells out to the BUILT `crib` CLI exactly as a user would — `node packages/cli/dist/cli.js`
 * — so the test exercises the real arg parsing + orchestration, not a hand-wired in-process call):
 *   (1) temp repo, `git init`, deterministic author + commit dates, commit one TypeScript file;
 *   (2) `crib --help` lists BOTH `init` and `doctor` (discoverability — a user can't run what they
 *       can't see in --help);
 *   (3) `crib init . --ide claude` → exit 0; stdout contains "indexed" (step 1 ran), "hooks"
 *       (step 2 ran), ".mcp.json" (step 3 wrote the IDE config), and "Next steps" (the hero);
 *       `.mcp.json` exists on disk (the wiring is real, not just a printed line);
 *       `.gitattributes` contains the kcrib merge block (hooks are real);
 *   (4) `crib doctor .` on the just-init'd repo → exit 0, "6/6 checks passed", every line marked ✓
 *       (a clean setup is reported clean — the diagnostic does not cry wolf);
 *   (5) a SECOND temp repo, NOT indexed — `crib doctor .` → exit NON-zero, "repo indexed" line
 *       marked ✗ with a "fix:" hint (a broken setup is reported broken + actionable — the
 *       diagnostic does not mask a missing index). This is the load-bearing assertion: doctor's
 *       value is telling a stuck user what's wrong, so it MUST fail loud on a not-init'd repo.
 *
 * Hermeticity: `--ide claude` scopes MCP wiring to a project-local `.mcp.json` inside the temp repo
 * (never the user's global `~/.claude` or `~/.cursor`). The temp repos are rmSync'd in `finally`.
 *
 * release:verify builds every package before any gate runs, so `packages/cli/dist/cli.js` exists.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CLI = resolve(REPO, 'packages', 'cli', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const AUTHOR_NAME = 'Onboarding Check';
const AUTHOR_EMAIL = 'onboarding@crib.dev';

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  onboarding:check FAIL — ${msg}\n`);
  failed++;
};

const git = (repo, args, env) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

const runCrib = (repo, args) => {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

const SOURCE = [
  'export function assess(amount: number, score: number): string {',
  '  const risk = amount * 0.4 + score * 0.6;',
  '  return risk > 700 ? "decline" : "approve";',
  '}',
  '',
].join('\n');

let helpOut = '';
try {
  helpOut = runCrib(REPO, ['--help']).out;
} catch (err) {
  fail(`crib --help threw: ${err?.stack ?? err}`);
}

// (2) --help lists both commands.
if (!/crib init\b/.test(helpOut)) fail('crib --help does not list `crib init`');
else process.stdout.write('  onboarding:check — --help lists `crib init`\n');
if (!/crib doctor\b/.test(helpOut)) fail('crib --help does not list `crib doctor`');
else process.stdout.write('  onboarding:check — --help lists `crib doctor`\n');

// (3) + (4) init then doctor on a clean repo.
let repo1 = '';
try {
  repo1 = mkdtempSync(join(tmpdir(), 'crib-onboarding-clean-'));
  try {
    git(repo1, ['init', '-q']);
    git(repo1, ['config', 'user.name', AUTHOR_NAME]);
    git(repo1, ['config', 'user.email', AUTHOR_EMAIL]);
    writeFileSync(join(repo1, 'loan.ts'), SOURCE);
    const dateEnv = { GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
    git(repo1, ['add', 'loan.ts'], dateEnv);
    git(repo1, ['commit', '-q', '-m', 'init'], dateEnv);

    const init = runCrib(repo1, ['init', '.', '--ide', 'claude']);
    if (init.code !== 0) {
      fail(`crib init exited ${init.code}: ${init.out}`);
    } else {
      const o = init.out;
      if (!/indexed\s+\d+\s+files/.test(o))
        fail('crib init did not run the index step (no "indexed N files" line)');
      if (!/hooks/i.test(o)) fail('crib init did not run the install-hooks step (no "hooks" line)');
      if (!/\.mcp\.json/.test(o))
        fail('crib init did not write the MCP config (no ".mcp.json" in output)');
      if (!/Next steps/i.test(o)) fail('crib init did not print the next-steps hero');
      if (!existsSync(join(repo1, '.mcp.json'))) fail('crib init did not create .mcp.json on disk');
      const attrs = existsSync(join(repo1, '.gitattributes'))
        ? readFileSync(join(repo1, '.gitattributes'), 'utf8')
        : '';
      if (!/kcrib merge/.test(attrs)) fail('crib init did not wire the .gitattributes merge block');
      process.stdout.write(
        '  onboarding:check — crib init produced indexed + hooked + MCP-wired repo\n',
      );
    }

    // (4) doctor on the clean repo → all pass.
    const doc = runCrib(repo1, ['doctor', '.']);
    if (doc.code !== 0) {
      fail(`crib doctor on a clean repo exited ${doc.code} (expected 0): ${doc.out}`);
    } else if (!/6\/6 checks passed/.test(doc.out)) {
      fail(`crib doctor did not report 6/6 checks passed:\n${doc.out}`);
    } else if (/✗/.test(doc.out)) {
      fail(`crib doctor reported a ✗ on a clean repo (cry wolf):\n${doc.out}`);
    } else {
      process.stdout.write('  onboarding:check — crib doctor reports clean setup as 6/6 ✓\n');
    }
  } finally {
    rmSync(repo1, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(
    `  onboarding:check threw during clean-repo sequence: ${err?.stack ?? err}\n`,
  );
  failed++;
  if (repo1) {
    try {
      rmSync(repo1, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// (5) doctor on a NOT-indexed repo → exit non-zero, ✗ on the index check, with a fix hint.
let repo2 = '';
try {
  repo2 = mkdtempSync(join(tmpdir(), 'crib-onboarding-bare-'));
  try {
    git(repo2, ['init', '-q']);
    git(repo2, ['config', 'user.name', AUTHOR_NAME]);
    git(repo2, ['config', 'user.email', AUTHOR_EMAIL]);
    writeFileSync(join(repo2, 'a.ts'), 'let x = 1;\n');
    const dateEnv = { GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
    git(repo2, ['add', 'a.ts'], dateEnv);
    git(repo2, ['commit', '-q', '-m', 'init'], dateEnv);

    const doc = runCrib(repo2, ['doctor', '.']);
    if (doc.code === 0) {
      fail(
        `crib doctor on a NOT-indexed repo exited 0 (expected non-zero — must fail loud):\n${doc.out}`,
      );
    } else {
      const o = doc.out;
      const indexLine = o.split('\n').find((l) => /repo indexed/.test(l)) ?? '';
      if (!/✗/.test(indexLine))
        fail(`crib doctor did not mark the index check ✗ on a bare repo:\n${o}`);
      else if (!/fix:/i.test(o))
        fail('crib doctor reported a failure without any fix hint (not actionable)');
      else
        process.stdout.write(
          '  onboarding:check — crib doctor reports bare repo as broken + actionable\n',
        );
    }
  } finally {
    rmSync(repo2, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(
    `  onboarding:check threw during bare-repo sequence: ${err?.stack ?? err}\n`,
  );
  failed++;
  if (repo2) {
    try {
      rmSync(repo2, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

if (failed > 0) {
  process.stderr.write(`\nonboarding:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nonboarding:check — all assertions passed\n');
