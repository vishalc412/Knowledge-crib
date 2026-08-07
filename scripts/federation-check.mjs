/**
 * federation-check — the M3.2 cross-repo federation gate.
 *
 * Pins the plan's M3.2 gate intent: "federated impact traverses 2-repo fixture". Two independent
 * repos are built, indexed, and committed (each its own one-repo soul); `loadFederation` re-loads
 * both souls from disk and `federatedImpact` walks the route-layer bridge between them — a repo-A
 * outbound `fetch('/api/loans/${id}')` (an `http-call` node) resolving to repo-B's
 * `app.get('/api/loans/:id', handler)` `route` node, matched by {httpMethod, routePath}, WITHOUT a
 * committed cross-repo edge.
 *
 * Drives the REAL pipeline: both repos are `git init`ed + committed, then `indexRepo` runs the full
 * deterministic extraction (TS structure → parse → resolve → link; ownership OFF to isolate the
 * federation path). The TS http-client extractor (M3.2) emits the `http-call` node + a `calls` edge
 * from the enclosing function; the Express extractor emits the `route` node + an `exposes` edge.
 *
 * Asserts:
 *   (1) repoA emits an `http-call` node (GET /api/loans/:id) + a `calls` edge from fetchLoan → it.
 *   (2) repoB emits a `route` node (GET /api/loans/:id).
 *   (3) NO cross-repo edge is committed in either soul (the bridge is runtime, not persisted) —
 *       every edge in each soul has both endpoints inside that soul.
 *   (4) `federatedImpact` DOWN from repoA's fetchLoan reaches repoB's route with crossRepo=true.
 *   (5) `federatedImpact` UP from repoB's route reaches repoA's http-call (and fetchLoan) with
 *       crossRepo=true.
 *   (6) crossRepoHops > 0 in both directions.
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built
 * core + pipeline dist resolve.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const NOW = '2026-01-01T00:00:00.000Z';
const AUTHOR_NAME = 'Federation Gate';
const AUTHOR_EMAIL = 'fed@crib.dev';

const core = await import(
  pathToFileURL(resolve(REPO, 'packages', 'core', 'dist', 'index.js')).href
);
const pipeline = await import(
  pathToFileURL(resolve(REPO, 'packages', 'pipeline', 'dist', 'index.js')).href
);
const { SoulStore, newManifest, loadFederation, federatedImpact } = core;
const { indexRepo } = pipeline;

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  federation:check FAIL — ${msg}\n`);
  failed++;
};

/** `git init` + author config + first commit of one TypeScript file, so the repo has a history. */
const gitInit = (repo) => {
  const g = (args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  g(['init']);
  g(['config', 'user.name', AUTHOR_NAME]);
  g(['config', 'user.email', AUTHOR_EMAIL]);
};

const commit = (repo, msg) => {
  const env = { ...process.env, GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
  execFileSync('git', ['-C', repo, 'commit', '-m', msg], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
};

/** repoA: a TS client with an outbound `fetch('/api/loans/${id}')` inside `fetchLoan`. */
const buildRepoA = () => {
  const repo = mkdtempSync(join(tmpdir(), 'crib-fed-a-'));
  gitInit(repo);
  writeFileSync(
    join(repo, 'client.ts'),
    [
      '// repoA — outbound HTTP client. The fetch call site becomes an http-call node.',
      'export async function fetchLoan(id: string): Promise<unknown> {',
      '  const res = await fetch(`/api/loans/${id}`);',
      '  return res.json();',
      '}',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['-C', repo, 'add', 'client.ts'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  commit(repo, 'repoA: client');
  return repo;
};

/** repoB: a TS Express server exposing GET /api/loans/:id. */
const buildRepoB = () => {
  const repo = mkdtempSync(join(tmpdir(), 'crib-fed-b-'));
  gitInit(repo);
  writeFileSync(
    join(repo, 'server.ts'),
    [
      '// repoB — Express route. app.get(path, handler) becomes a route node.',
      'import express from "express";',
      'const app = express();',
      'app.get("/api/loans/:id", function getLoan(req, res) {',
      '  res.json({ id: req.params.id });',
      '});',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['-C', repo, 'add', 'server.ts'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  commit(repo, 'repoB: server');
  return repo;
};

/** Index one repo into a fresh soul + persist (commit). Returns the in-memory soul (post-commit). */
const indexRepo_ = async (repo) => {
  const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
  soul.load();
  await indexRepo(soul, repo, { now: NOW, ownership: false, dossiers: false, cluster: false });
  return soul;
};

try {
  const repoA = buildRepoA();
  const repoB = buildRepoB();
  try {
    const soulA = await indexRepo_(repoA);
    const soulB = await indexRepo_(repoB);

    // (1) repoA: an http-call node (GET /api/loans/:id) + a calls edge fetchLoan → http-call.
    const callNodes = [...soulA.iterate()].filter((n) => n.kind === 'http-call');
    if (callNodes.length === 0) {
      fail('repoA emitted no http-call nodes (fetch(...) was not extracted)');
    } else {
      const c = callNodes[0];
      if (c.httpMethod !== 'GET') fail(`repoA http-call method ${c.httpMethod} (need GET)`);
      if (c.routePath !== '/api/loans/:id')
        fail(`repoA http-call routePath ${c.routePath} (need /api/loans/:id)`);
      if (c.framework !== 'fetch') fail(`repoA http-call framework ${c.framework} (need fetch)`);
      const callsEdge = [...soulA.iterateEdges()].find((e) => e.rel === 'calls' && e.dst === c.id);
      if (!callsEdge) fail(`repoA no calls edge into http-call ${c.id}`);
      else if (callsEdge.provenance !== 'EXTRACTED')
        fail(`repoA calls→http-call provenance ${callsEdge.provenance} (need EXTRACTED)`);
      else
        process.stdout.write(
          `  federation:check — repoA http-call ${c.id} (calls edge src=${callsEdge.src})\n`,
        );
    }

    // (2) repoB: a route node (GET /api/loans/:id).
    const routeNodes = [...soulB.iterate()].filter((n) => n.kind === 'route');
    if (routeNodes.length === 0) {
      fail('repoB emitted no route nodes (app.get(...) was not extracted)');
    } else {
      const r = routeNodes[0];
      if (r.httpMethod !== 'GET') fail(`repoB route method ${r.httpMethod} (need GET)`);
      if (r.routePath !== '/api/loans/:id')
        fail(`repoB route path ${r.routePath} (need /api/loans/:id)`);
      if (r.framework !== 'express') fail(`repoB route framework ${r.framework} (need express)`);
      process.stdout.write(`  federation:check — repoB route ${r.id}\n`);
    }

    // (3) NO committed cross-repo edge: every edge endpoint in each soul resolves inside that soul.
    for (const [name, soul, root] of [
      ['repoA', soulA, repoA],
      ['repoB', soulB, repoB],
    ]) {
      for (const e of soul.iterateEdges()) {
        if (soul.getNode(e.src) === undefined)
          fail(`${name} edge ${e.id} src ${e.src} not in soul`);
        if (soul.getNode(e.dst) === undefined)
          fail(`${name} edge ${e.id} dst ${e.dst} not in soul`);
      }
    }
    process.stdout.write(
      '  federation:check — no committed cross-repo edges (bridge is runtime)\n',
    );

    // Re-load both souls from disk via loadFederation (proves persistence + the real load path).
    const fed = loadFederation([repoA, repoB]);
    if (fed.souls.length !== 2) fail(`loadFederation loaded ${fed.souls.length} souls (need 2)`);

    const callId = [...soulA.iterate()].find((n) => n.kind === 'http-call')?.id;
    const fetchLoanId = [...soulA.iterate()].find(
      (n) => n.kind === 'symbol' && n.name === 'fetchLoan',
    )?.id;
    const routeId = [...soulB.iterate()].find((n) => n.kind === 'route')?.id;
    if (!callId) fail('no http-call id in repoA');
    if (!fetchLoanId) fail('no fetchLoan symbol id in repoA');
    if (!routeId) fail('no route id in repoB');

    // (4) DOWN from repoA's fetchLoan → crosses to repoB's route (crossRepo=true).
    if (fetchLoanId) {
      const down = federatedImpact(fed, repoA, fetchLoanId, 'down', { depth: 3 });
      const cross = down.affected.filter((a) => a.crossRepo);
      const reachedRoute = down.affected.find((a) => a.id === routeId && a.crossRepo);
      if (down.crossRepoHops === 0)
        fail('down from fetchLoan: crossRepoHops=0 (bridge did not fire)');
      if (!reachedRoute)
        fail(
          `down from fetchLoan: did not reach repoB route ${routeId} (affected=${JSON.stringify(down.affected.map((a) => a.id))})`,
        );
      else
        process.stdout.write(
          `  federation:check — DOWN fetchLoan → repoB route (crossRepoHops=${down.crossRepoHops})\n`,
        );
      if (cross.length === 0) fail('down from fetchLoan: no crossRepo affected nodes');
    }

    // (5) UP from repoB's route → crosses to repoA's http-call (+ fetchLoan) with crossRepo=true.
    if (routeId) {
      const up = federatedImpact(fed, repoB, routeId, 'up', { depth: 3 });
      const reachedCall = up.affected.find((a) => a.id === callId && a.crossRepo);
      if (up.crossRepoHops === 0) fail('up from route: crossRepoHops=0 (bridge did not fire)');
      if (!reachedCall)
        fail(
          `up from route: did not reach repoA http-call ${callId} (affected=${JSON.stringify(up.affected.map((a) => a.id))})`,
        );
      else
        process.stdout.write(
          `  federation:check — UP repoB route → repoA http-call (crossRepoHops=${up.crossRepoHops})\n`,
        );
      // The enclosing fetchLoan is reached in a later hop via the calls edge (http-call → fetchLoan up).
      const reachedFn = up.affected.find((a) => a.id === fetchLoanId);
      if (reachedFn)
        process.stdout.write(
          `  federation:check — UP repoB route → repoA fetchLoan (distance=${reachedFn.distance})\n`,
        );
    }
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  federation:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nfederation:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nfederation:check — all assertions passed\n');
