/**
 * soul-refresh-check — the M4.3 "never stale" gate.
 *
 * Pins the plan's M4.3 gate intent: "`crib update` on merge keeps the committed soul fresh." The
 * deliverable is the GitHub Action `.github/workflows/crib-soul-refresh.yml`, which on every merge
 * runs `crib update .` and commits the refreshed soul back. The workflow-file SHAPE is pinned in
 * `scripts/ci-workflow.test.mjs` (the canonical home for workflow-shape assertions). THIS gate pins
 * the BEHAVIORAL property the auto-commit-on-merge loop depends on: **idempotence** — re-running
 * the extract on an unchanged tree produces a byte-identical soul and therefore no commit.
 *
 * Without idempotence, an auto-commit-on-merge action would loop: refresh → commit → push → refresh
 * → ... With it, a no-op refresh yields an empty `git diff --staged` and the action exits without
 * pushing. Three loop-control layers are in the workflow ([skip ci], actor guard, empty-diff check);
 * this gate proves the third one is sound by exercising the real CLI the action calls.
 *
 * Method (mirrors ownership-check's real-pipeline temp-repo pattern, but shells out to the BUILT
 * `crib` CLI exactly as the action does — `node packages/cli/dist/cli.js` — so the test exercises the
 * same code path the action runs, not a hand-wired in-process call):
 *   (1) temp repo, `git init`, deterministic author + commit dates, commit one TypeScript file;
 *   (2) `crib index .` → exit 0, ≥1 node — the committed soul exists;
 *   (3) snapshot a content hash over the real committed-soul file set (`.crib/nodes/**`,
 *       `.crib/edges/**`, `.crib/dossiers/**`, `.crib/schema/**`, `.crib/clusters/**`,
 *       `.crib/crib.json`) — NOT the gitignored derived `.crib/index` or `.crib/embeddings`
 *       (rebuildable, not committed);
 *   (4) THE load-bearing assertion — `crib update .` on the unchanged tree → exit 0; re-snapshot
 *       → hashes equal (no-op update is byte-idempotent; the preserveTimestamp fix keeps
 *       crib.json:meta.lastUpdated stable so the action's empty-diff check works);
 *   (5) a second `crib update .` at the same head → still byte-identical (anchor already current);
 *   (6) mutate the source (add a function), commit, `crib update .` → exit 0; re-snapshot → hash
 *       CHANGES (update reflects source changes — it is not a silent no-op that would mask drift).
 *
 * release:verify builds every package before any gate runs, so `packages/cli/dist/cli.js` exists.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const CLI = resolve(REPO, 'packages', 'cli', 'dist', 'cli.js');
const NOW = '2026-01-01T00:00:00.000Z';
const AUTHOR_NAME = 'Soul Refresher';
const AUTHOR_EMAIL = 'refresh@crib.dev';

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  soul-refresh:check FAIL — ${msg}\n`);
  failed++;
};

/** Hash the committed-soul file set (the set the action commits). The real `.crib` layout is
 *  `nodes/` + `edges/` + `dossiers/` + `schema/` + `clusters/` + `crib.json` — the SECURITY.md names
 *  `.crib/soul/` and `.crib/llm/` are conceptual (soul = nodes+edges; llm = dossiers). Excludes the
 *  gitignored derived `index/` and `embeddings/` (rebuildable, not committed). */
const hashCommittedSoul = (repo) => {
  const cribDir = join(repo, '.crib');
  const h = createHash('sha256');
  const dirs = ['nodes', 'edges', 'dossiers', 'schema', 'clusters'];
  const files = ['crib.json'];
  const visit = (abs) => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) visit(join(abs, entry));
    } else {
      h.update(abs.slice(repo.length));
      h.update('\0');
      h.update(readFileSync(abs));
      h.update('\0');
    }
  };
  for (const d of dirs) {
    const p = join(cribDir, d);
    try {
      statSync(p);
      visit(p);
    } catch {
      /* dir absent — fine */
    }
  }
  for (const f of files) {
    const p = join(cribDir, f);
    try {
      statSync(p);
      visit(p);
    } catch {
      /* file absent — fine */
    }
  }
  return h.digest('hex');
};

const git = (repo, args, env) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

// real crib runner — shells out to the built CLI exactly as the action does
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
  '  const base = amount * 0.4 + score * 0.6;',
  '  const risk = base + (amount > 50000 ? 100 : 0);',
  '  return risk > 700 ? "decline" : risk > 500 ? "review" : "approve";',
  '}',
  '',
].join('\n');

const SOURCE_V2 = `${SOURCE}export function helper(n: number): number {
  return Math.round(n);
}
`;

try {
  const repo = mkdtempSync(join(tmpdir(), 'crib-soul-refresh-'));
  try {
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.name', AUTHOR_NAME]);
    git(repo, ['config', 'user.email', AUTHOR_EMAIL]);
    writeFileSync(join(repo, 'loan.ts'), SOURCE);
    const dateEnv = { GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
    git(repo, ['add', 'loan.ts'], dateEnv);
    git(repo, ['commit', '-q', '-m', 'init'], dateEnv);

    // (2) crib index → soul exists
    let r = runCrib(repo, ['index', '.']);
    if (r.code !== 0) fail(`crib index exited ${r.code}: ${r.out}`);
    else if (!/indexed\s+\d+\s+files.*?→\s+\d+\s+nodes/.test(r.out)) {
      fail(`crib index produced no nodes: ${r.out.trim()}`);
    } else {
      process.stdout.write(
        `  soul-refresh:check — crib index ok (${r.out.trim().split('\n')[0]})\n`,
      );
    }

    // (3) snapshot committed soul
    const h1 = hashCommittedSoul(repo);

    // (4) THE load-bearing assertion: `crib update` on an unchanged tree is byte-idempotent.
    // This is the exact command the M4.3 action runs, and the property its empty-diff loop control
    // depends on. Before the preserveTimestamp fix, the no-op path bumped crib.json:meta.lastUpdated
    // (wall-clock) on every run → the action would have emitted a spurious "refresh soul" commit on
    // every merge. After the fix, the no-op preserves lastUpdated → byte-identical committed soul.
    r = runCrib(repo, ['update', '.']);
    if (r.code !== 0) fail(`crib update (no-op #1) exited ${r.code}: ${r.out}`);
    const h2 = hashCommittedSoul(repo);
    if (h1 !== h2) {
      fail(
        `crib update no-op NOT byte-idempotent — committed soul changed on an unchanged tree\n  ${h1}\n  ${h2}\n  (meta.lastUpdated preserveTimestamp fix regressed?)`,
      );
    } else {
      process.stdout.write(
        '  soul-refresh:check — crib update no-op byte-idempotent (committed soul stable)\n',
      );
    }

    // (5) a second no-op update at the same head must ALSO be identical (anchor already current)
    r = runCrib(repo, ['update', '.']);
    if (r.code !== 0) fail(`crib update (no-op #2) exited ${r.code}: ${r.out}`);
    const h3 = hashCommittedSoul(repo);
    if (h2 !== h3) {
      fail(`second crib update no-op altered the soul\n  ${h2}\n  ${h3}`);
    } else {
      process.stdout.write(
        '  soul-refresh:check — repeated crib update no-op stable across two runs\n',
      );
    }

    // (6) mutate source + commit + update → soul changes (update reflects drift, not a silent no-op)
    writeFileSync(join(repo, 'loan.ts'), SOURCE_V2);
    git(repo, ['add', 'loan.ts'], dateEnv);
    git(repo, ['commit', '-q', '-m', 'add helper'], dateEnv);
    r = runCrib(repo, ['update', '.']);
    if (r.code !== 0) fail(`crib update (post-change) exited ${r.code}: ${r.out}`);
    const h4 = hashCommittedSoul(repo);
    if (h4 === h3) {
      fail('crib update did NOT reflect a source change — silent no-op would mask drift');
    } else {
      process.stdout.write(
        '  soul-refresh:check — crib update reflected source change (soul hash changed)\n',
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  soul-refresh:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nsoul-refresh:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nsoul-refresh:check — all assertions passed\n');
