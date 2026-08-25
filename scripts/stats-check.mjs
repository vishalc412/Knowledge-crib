/**
 * stats-check — the M3.3 server-observability gate.
 *
 * Pins the plan's M3.3 gate intent: "stats verb returns live numbers". Drives the REAL pipeline
 * (indexRepo over a one-file TS repo) + the real Verbs surface, then asserts:
 *   (1) `verbs.getStats().snapshot()` has the live-numbers shape (verbs/cache/uptimeMs/totalCalls).
 *   (2) per-verb count + latency are recorded for real verb calls (context + impact).
 *   (3) the ifHash change-aware cache hit rate is wired (a matching hash → hit, a mismatch → miss).
 *   (4) the `stats` MCP tool is registered in buildServer (the observability surface ships, not
 *       just the in-process counters) — anchored to executable call-site syntax, not a bare word.
 *   (5) private helpers are NOT counted (the Proxy whitelist excludes applyIfHash/attachLlm).
 *
 * Determinism note: the counters are runtime-only wall-clock measurements. This gate asserts their
 * SHAPE + that they increment — it does NOT pin latency magnitudes (those are inherently
 * non-deterministic; the `stats` verb's contract is explicitly "live numbers", quarantined away from
 * the deterministic soul + deterministic verb outputs).
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built
 * core + pipeline + mcp dist resolve.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const NOW = '2026-01-01T00:00:00.000Z';
const AUTHOR_NAME = 'Stats Gate';
const AUTHOR_EMAIL = 'stats@crib.dev';

const core = await import(
  pathToFileURL(resolve(REPO, 'packages', 'core', 'dist', 'index.js')).href
);
const pipeline = await import(
  pathToFileURL(resolve(REPO, 'packages', 'pipeline', 'dist', 'index.js')).href
);
const mcp = await import(pathToFileURL(resolve(REPO, 'packages', 'mcp', 'dist', 'index.js')).href);
const { SoulStore, newManifest, SqliteIndexStore } = core;
const { indexRepo } = pipeline;
const { Verbs } = mcp;

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  stats:check FAIL — ${msg}\n`);
  failed++;
};

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

// A one-function TS repo: indexRepo extracts `greet` as a callable symbol + a `calls` edge into it.
const buildRepo = () => {
  const repo = mkdtempSync(join(tmpdir(), 'crib-stats-'));
  gitInit(repo);
  writeFileSync(
    join(repo, 'greeter.ts'),
    [
      '// stats-check fixture — one callable for context/impact verbs.',
      'export function greet(name: string): string {',
      '  return `hello ${name}`;',
      '}',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['-C', repo, 'add', 'greeter.ts'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  commit(repo, 'greeter');
  return repo;
};

try {
  // (4) The observability surface is REACHABLE over MCP — anchored to executable syntax.
  //
  // Checks the capability, not a tool name. `stats` used to be its own tool; it is now an operation
  // on `status` (`status({op:'stats'})`), because every registered tool costs name + description +
  // schema in the tool list of every session whether or not it is used. Pinning the old literal
  // would have failed a rename that changed nothing about whether the numbers ship — which is what
  // this gate is actually for.
  const serverSrc = readFileSync(resolve(REPO, 'packages', 'mcp', 'src', 'server.ts'), 'utf8');
  const statsReachable =
    /server\.registerTool\(\s*'stats'/.test(serverSrc) ||
    (/server\.registerTool\(\s*'status'/.test(serverSrc) && /'stats'/.test(serverSrc));
  if (!statsReachable)
    fail("server.ts exposes no stats surface (neither a 'stats' tool nor a status op)");
  if (!/verbs\.getStats\(\)\.snapshot\(\)/.test(serverSrc))
    fail('server.ts stats surface does not call verbs.getStats().snapshot()');
  else process.stdout.write('  stats:check — stats surface wired in buildServer\n');

  // (4b) The Stats interceptor is wired in verbs.ts (the Proxy + PUBLIC_VERBS whitelist).
  const verbsSrc = readFileSync(resolve(REPO, 'packages', 'mcp', 'src', 'verbs.ts'), 'utf8');
  if (!/new Proxy\(this/.test(verbsSrc)) fail('verbs.ts has no Proxy interceptor');
  if (!/PUBLIC_VERBS/.test(verbsSrc)) fail('verbs.ts has no PUBLIC_VERBS whitelist');
  else process.stdout.write('  stats:check — Proxy interceptor + PUBLIC_VERBS whitelist present\n');

  const repo = buildRepo();
  try {
    const soul = new SoulStore(join(repo, '.crib'), { manifest: newManifest({ now: NOW }) });
    soul.load();
    await indexRepo(soul, repo, { now: NOW, ownership: false, dossiers: false, cluster: false });
    const index = new SqliteIndexStore();
    index.buildFromSoul(soul, repo);
    const verbs = new Verbs({ soul, index, repoRoot: repo });

    const greetId = [...soul.iterate()].find((n) => n.kind === 'symbol' && n.name === 'greet')?.id;
    if (!greetId) {
      fail('no greet symbol id in fixture');
      throw new Error('no greet symbol id'); // skip the verb-driven assertions below
    }

    // (1) shape.
    const empty = verbs.getStats().snapshot();
    if (typeof empty.totalCalls !== 'number') fail('snapshot.totalCalls missing');
    if (!empty.cache || typeof empty.cache.hitRate !== 'number')
      fail('snapshot.cache.hitRate missing');
    if (!empty.verbs) fail('snapshot.verbs missing');
    else process.stdout.write('  stats:check — snapshot has live-numbers shape\n');

    // (2) per-verb count + latency for real verb calls.
    verbs.context({ id: greetId });
    verbs.context({ id: greetId });
    verbs.impact({ id: greetId, dir: 'down' });
    const snap = verbs.getStats().snapshot();
    const ctx = snap.verbs.context;
    const imp = snap.verbs.impact;
    if (!ctx || ctx.count !== 2) fail(`context count=${ctx?.count} (need 2)`);
    if (!imp || imp.count !== 1) fail(`impact count=${imp?.count} (need 1)`);
    if (ctx && typeof ctx.totalMs !== 'number') fail('context.totalMs not a number');
    if (ctx && !(ctx.minMs <= ctx.maxMs)) fail('context minMs > maxMs (latency bounds broken)');
    if (snap.totalCalls !== 3) fail(`totalCalls=${snap.totalCalls} (need 3)`);
    else
      process.stdout.write(
        `  stats:check — counts live (context=${ctx?.count}, impact=${imp?.count}, total=${snap.totalCalls})\n`,
      );

    // (3) ifHash cache hit rate: matching hash → hit, mismatch → miss.
    const first = verbs.context({ id: greetId });
    const hash = first?.hash;
    if (typeof hash !== 'string') fail('context result has no hash field (ifHash cache unwired)');
    if (hash) {
      const hit = verbs.context({ id: greetId, ifHash: hash });
      if (!hit?.unchanged) fail('ifHash match did not collapse to {unchanged:true}');
      const miss = verbs.context({ id: greetId, ifHash: 'deadbeef' });
      if (miss?.unchanged) fail('ifHash mismatch collapsed (should return full body)');
      const c = verbs.getStats().snapshot().cache;
      if (c.hits < 1) fail(`cache.hits=${c.hits} (need >=1)`);
      if (c.misses < 1) fail(`cache.misses=${c.misses} (need >=1)`);
      if (c.hitRate <= 0 || c.hitRate > 1) fail(`cache.hitRate=${c.hitRate} out of (0,1]`);
      else
        process.stdout.write(
          `  stats:check — ifHash cache hit rate wired (hits=${c.hits}, misses=${c.misses}, rate=${c.hitRate.toFixed(3)})\n`,
        );
    }

    // (5) private helpers NOT counted (the Proxy whitelist excludes them).
    const final = verbs.getStats().snapshot();
    if (final.verbs.applyIfHash !== undefined) fail('private applyIfHash was counted as a verb');
    if (final.verbs.attachLlm !== undefined) fail('private attachLlm was counted as a verb');
    else process.stdout.write('  stats:check — private helpers excluded from per-verb counts\n');

    index.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  stats:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nstats:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nstats:check — all assertions passed\n');
