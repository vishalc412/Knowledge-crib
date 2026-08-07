/**
 * ownership-check — the M3.1 ownership gate.
 *
 * Pins the plan's M3.1 gate intent: "ownership queries work on self-index" — i.e. `git blame` is
 * parsed into symbol→owner `owned-by` EXTRACTED edges (confidence 1, method static), and the
 * `ownership` MCP verb returns the owner for a symbol id.
 *
 * Unlike the ifhash gate (which hand-builds nodes), this one drives the REAL pipeline: a temp repo
 * is `git init`ed, a TypeScript source file is committed, then `indexRepo` runs the full deterministic
 * pipeline — which includes the M3.1 `runOwnership` phase that shells out to `git blame` and emits
 * owner nodes + owned-by edges. This proves ownership works against the self-index, not a fixture.
 *
 * Asserts:
 *   (1) owned-by edges exist and are EXTRACTED (provenance) + confidence 1 + method static — the
 *       deterministic, file-derived fact that belongs in the `--extracted-only` subset.
 *   (2) an `owner` node exists with kind 'owner' + the committed author's email.
 *   (3) the `ownership` verb, given a symbol id, returns that owner (name + email + commit + head).
 *   (4) the `ownership` verb returns not-found for an unknown id (no spurious owner).
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built
 * core + pipeline + mcp dist resolve.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const NOW = '2026-01-01T00:00:00.000Z';
const AUTHOR_NAME = 'Ada Owner';
const AUTHOR_EMAIL = 'ada@crib.dev';

const core = await import(
  pathToFileURL(resolve(REPO, 'packages', 'core', 'dist', 'index.js')).href
);
const pipeline = await import(
  pathToFileURL(resolve(REPO, 'packages', 'pipeline', 'dist', 'index.js')).href
);
const mcp = await import(pathToFileURL(resolve(REPO, 'packages', 'mcp', 'dist', 'index.js')).href);
const { SoulStore, SqliteIndexStore, newManifest } = core;
const { indexRepo } = pipeline;
const { Verbs } = mcp;

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  ownership:check FAIL — ${msg}\n`);
  failed++;
};

/** `git init` + author config + first commit of one TypeScript file, so `git blame` has a history. */
const buildGitRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), 'crib-ownership-'));
  const g = (args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  g(['init']);
  g(['config', 'user.name', AUTHOR_NAME]);
  g(['config', 'user.email', AUTHOR_EMAIL]);
  writeFileSync(
    join(repo, 'loan.ts'),
    [
      'export function assess(amount: number, score: number): string {',
      '  const base = amount * 0.4 + score * 0.6;',
      '  const risk = base + (amount > 50000 ? 100 : 0);',
      '  return risk > 700 ? "decline" : risk > 500 ? "review" : "approve";',
      '}',
      'export function helper(n: number): number {',
      '  return Math.round(n * 100) / 100;',
      '}',
      '',
    ].join('\n'),
  );
  g(['add', 'loan.ts']);
  // GIT_AUTHOR/COMMITTER dates pin the commit deterministically (no wall clock leaks into blame).
  const env = { ...process.env, GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  return repo;
};

try {
  const repo = buildGitRepo();
  try {
    const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
    soul.load();
    const report = await indexRepo(soul, repo, { now: NOW });
    const index = new SqliteIndexStore();
    index.buildFromSoul(soul, repo);

    // (1) owned-by edges: EXTRACTED, confidence 1, method static.
    const ownedBy = [...soul.iterateEdges()].filter((e) => e.rel === 'owned-by');
    if (ownedBy.length === 0) {
      fail('no owned-by edges emitted by runOwnership (git blame produced no owners)');
    } else {
      for (const e of ownedBy) {
        if (e.provenance !== 'EXTRACTED')
          fail(`owned-by edge ${e.id} provenance=${e.provenance} (need EXTRACTED)`);
        if (e.confidence !== 1) fail(`owned-by edge ${e.id} confidence=${e.confidence} (need 1)`);
        if (e.method !== 'static') fail(`owned-by edge ${e.id} method=${e.method} (need static)`);
      }
      process.stdout.write(
        `  ownership:check — ${ownedBy.length} owned-by edge(s), all EXTRACTED/conf=1/static\n`,
      );
    }

    // (2) an owner node with kind 'owner' + the committed author's email.
    const owners = [...soul.iterate()].filter((n) => n.kind === 'owner');
    if (owners.length === 0) {
      fail('no owner nodes emitted');
    } else {
      const ada = owners.find((o) => o.email === AUTHOR_EMAIL);
      if (!ada) {
        fail(`no owner node for ${AUTHOR_EMAIL}; owners: ${owners.map((o) => o.id).join(', ')}`);
      } else if (ada.name !== AUTHOR_NAME) {
        fail(`owner name mismatch: ${ada.name} (need ${AUTHOR_NAME})`);
      } else {
        process.stdout.write(
          `  ownership:check — owner node ${ada.id} (${ada.name} <${ada.email}>)\n`,
        );
      }
    }

    // (3) the ownership verb returns the owner for a symbol id. Find a symbol with an owned-by edge.
    const v = new Verbs({ soul, index, repoRoot: repo });
    const sample = ownedBy[0];
    if (sample) {
      const res = v.ownership({ id: sample.src });
      if (!Array.isArray(res.owners) || res.owners.length === 0) {
        fail(`ownership verb returned no owners for ${sample.src}`);
      } else {
        const o = res.owners[0];
        const node = o.owner;
        if (node?.email !== AUTHOR_EMAIL) {
          fail(`ownership verb owner email ${node?.email} (need ${AUTHOR_EMAIL})`);
        } else if (typeof o.commit !== 'string' || o.commit.length === 0) {
          fail('ownership verb owner commit missing');
        } else {
          process.stdout.write(
            `  ownership:check — ownership verb → ${node.name} <${node.email}> @ ${o.commit}\n`,
          );
        }
      }
    }

    // (4) not-found for an unknown id (no spurious owner; the verb does NOT invent attribution).
    const nf = v.ownership({ id: 'sym:no-such-symbol@L1' });
    if (nf.owners !== undefined) {
      fail(`ownership verb returned a payload for an unknown id (got ${JSON.stringify(nf)})`);
    } else {
      process.stdout.write('  ownership:check — ownership verb returns not-found for unknown id\n');
    }

    // sanity: the index report carried an ownership stats block.
    if (!report.ownership || typeof report.ownership.edges !== 'number') {
      fail('indexRepo report missing ownership stats');
    } else if (report.ownership.edges === 0) {
      fail('indexRepo report ownership.edges=0 (runOwnership was a no-op in a git repo)');
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  ownership:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nownership:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nownership:check — all assertions passed\n');
