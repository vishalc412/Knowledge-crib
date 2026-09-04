/**
 * Lightweight-budget gate (P0). Enforces the hard caps from the product roadmap so "lightweight"
 * is a CI fact, not an opinion. Every check is build-breaking — exit non-zero on any breach.
 *
 * Budgets:
 *  - cold runtime deps (external, deduped across workspace packages)  <= MAX_RUNTIME_DEPS
 *  - zero network calls in the deterministic core path (core/pipeline/parsers/mcp, non-test)
 *  - packed mcp+cli tarball size                                      < MAX_PACKAGE_BYTES
 *  - packed parsers tarball size (vendored tree-sitter grammars live here) < MAX_PARSERS_PACKAGE_BYTES
 *  - default (non --with-llm) query hit size                          <= MAX_DEFAULT_HIT_BYTES
 *  - warm query p50 latency                                           < MAX_QUERY_P50_MS
 *  - cold index time on a 50-file fixture                             < MAX_INDEX_MS
 *  - incremental `crib update` time (one-file edit)                   < MAX_UPDATE_RATIO
 *    of a full index on the same fixture (the P2.1 dossier-hoist gate)
 *
 * MAX_RUNTIME_DEPS is 10, and every one of the ten is a deliberate, disclosed tradeoff (see
 * NOTICE) rather than headroom to spend carelessly. It was 6 when `web-tree-sitter` (the PHP
 * extractor's WASM engine, P3) was the sixth. MuleSoft support then added three more — `saxes`
 * (streaming SAX XML for Mule 3/4 configs), `yaml` (RAML and descriptor parsing) and `yauzl` (ZIP
 * reader for project archives) — and the cap was never moved with them, so this gate has failed on
 * every branch since. All three are pure-JS with no native build, which is the property this budget
 * exists to protect; raising the cap records a decision already shipped rather than permitting a
 * new one. The next addition should still have to argue for itself here.
 *
 * `unpdf` (G5.3 multimodal PDF) is the tenth, and it argued for itself on exactly that property:
 * MIT, pure-JS (it bundles Mozilla pdf.js), no native build, no postinstall and no network. It is
 * also reached ONLY through a lazy `await import('unpdf')` inside the opt-in `--multimodal` phase,
 * so the default index path never loads it. It was NOT moved to `optionalDependencies` to slip
 * under the cap — optional deps still install by default, so that would have gamed this gate
 * without saving a caller a single byte. The eleventh addition still has to argue for itself.
 *
 * MAX_PARSERS_PACKAGE_BYTES exists for the same reason: a future grammar addition that quietly
 * balloons this package should fail the build, not slip in.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionCost } from './lib/pricing.mjs';

const MAX_RUNTIME_DEPS = 10;
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024; // 5 MB, mcp+cli combined
const MAX_PARSERS_PACKAGE_BYTES = 3 * 1024 * 1024; // 3 MB — today's actual is ~0.6 MB; headroom for a
// couple more small vendored grammars before this becomes a real conversation, not silent bloat.
const MAX_DEFAULT_HIT_BYTES = 1536; // 1.5 KB/hit default tier
const MAX_QUERY_P50_MS = 150;
const MAX_INDEX_MS = 20_000;
// P2.1 dossier-latency gate, two assertions on one fixture:
//  (i)  rebuilding every callable's dossier with the hoisted adjacency opts
//      (packages/pipeline/src/dossiers.ts hoistedDossierOpts — one edge scan + one symbol scan
//      shared by all rebuilds) must be at least MIN_DOSSIER_SPEEDUP x faster than rebuilding
//      them unhoisted. Unhoisted, every buildDossier re-scans every edge from scratch (D×E
//      visits per run; ~2400 callables × ~11k edges on this fixture), so the floor of 5x sits
//      far below the measured ~70x and catches any regression that drops the hoist or
//      re-introduces per-dossier scanning. Both loops run in the same process back-to-back,
//      so machine speed moves numerator and denominator together.
//  (ii) a one-file edit + commit + updateRepo must cost less than a full indexRepo on the same
//      fixture (ratio < MAX_UPDATE_RATIO). The aspirational end-to-end target is 25%, but that
//      is currently unattainable for a reason OUTSIDE this gate: decision-table row order
//      depends on soul edge iteration order, which differs between the index-time in-memory
//      soul and the update-time disk-reloaded soul, so ~45% of UNTOUCHED dossiers churn on
//      every update (written=1028/2400 here) until core/src/rules emits a stable row order.
//      The ceiling of 1.0 pins the honest promise that holds today: an incremental update
//      must never cost as much as re-indexing from scratch.
const MIN_DOSSIER_SPEEDUP = 5;
const MAX_UPDATE_RATIO = 1.0;
// Large enough that index time is parse-dominated (the update's closure re-parse is 1 file vs
// all of them), small enough that the gate stays a ~seconds-scale line item in release:verify.
const UPDATE_FIXTURE_FILES = 300;
const FIXTURE_FILE_COUNT = 50;
// Pin every fixture commit to a fixed date (mirrors soul-refresh-check) so the git anchor the
// update diffs against is deterministic.
const PINNED_DATE = '2026-01-01T00:00:00.000Z';
const ON_CI = process.env.GITHUB_ACTIONS === 'true';
// The product's core promise is a dollar promise, not just a token promise. This gate turns "crib is
// cheaper" into a build-breaking CI fact: over a modeled multi-turn task, the crib-default retrieval
// must cost at most 1/MIN_COST_SAVING of what reading the whole hit files (the no-crib path) costs.
// Deliberately conservative — the harness typically shows 40x+; a regression that drops us below 3x
// means the tiered default has bloated or the cache-stable advantage has been lost, and should fail.
const MIN_COST_SAVING = 3;
const COST_MODEL_TURNS = 6;

const CORE_PATH_DIRS = [
  'packages/core/src',
  'packages/pipeline/src',
  'packages/parsers/src',
  'packages/mcp/src',
];
const NETWORK_PATTERN = /\b(fetch|axios|node-fetch)\s*\(|https?\.request\s*\(/;
const WORKSPACE_PACKAGES = ['soul-schema', 'core', 'parsers', 'pipeline', 'mcp', 'cli', 'ui'];

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    process.stdout.write(`FAIL  ${name}: ${msg}\n`);
  }
}

// 1. Cold runtime deps — external (non-@knowledge-crib) deps, deduped by name, across all packages.
await check('runtime deps', () => {
  const seen = new Set();
  for (const pkg of WORKSPACE_PACKAGES) {
    const manifest = JSON.parse(readFileSync(`packages/${pkg}/package.json`, 'utf8'));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!dep.startsWith('@knowledge-crib/')) seen.add(dep);
    }
  }
  if (seen.size > MAX_RUNTIME_DEPS) {
    throw new Error(
      `${seen.size} external runtime deps [${[...seen].join(', ')}] > cap ${MAX_RUNTIME_DEPS}`,
    );
  }
});

// 2. Zero network calls in the deterministic core path (excludes test files — fixtures may mention
// network terms in comments/strings; this only flags real call sites in shipped source).
//
// ALLOWLIST: parsers that DETECT outbound HTTP call sites (schema 1.5 `http-call` extraction)
// legitimately mention `fetch(`/`axios(` in their doc block comments + match against the bare
// identifier strings `'fetch'`/`'axios'` — they never ISSUE a network call. The block-comment lines
// are not stripped by the `//` split below, so the parser would false-positive without this carve-out.
// The same carve-out applies to the PDG taint TABLE: `sink.url-fetch` declares the literal strings
// `'fetch('` / `'http.request('` as patterns the analyzer MATCHES AGAINST in other people's code.
// The file's only import is `import type` — it cannot issue a request. Both entries are pattern
// TABLES, not call sites; every other file in the core path stays gated.
const NETWORK_ALLOWLIST = new Set([
  'packages/parsers/src/ts/http-client.ts',
  'packages/pipeline/src/pdg/taint.ts',
]);
await check('core path is network-free', () => {
  const offenders = [];
  for (const dir of CORE_PATH_DIRS) {
    for (const file of walk(dir)) {
      if (file.endsWith('.test.ts')) continue;
      // walk() returns platform-native paths (backslashes on win32). NETWORK_ALLOWLIST is authored
      // in posix form, so a win32 `packages\parsers\src\ts\http-client.ts` would NOT match the posix
      // `packages/parsers/src/ts/http-client.ts` entry → the allowlisted http-call detector would be
      // false-flagged as a network offender on windows. Normalize to posix before the allowlist check
      // + offender reporting (no-op on posix — no backslashes present).
      const posixFile = file.replace(/\\/g, '/');
      if (NETWORK_ALLOWLIST.has(posixFile)) continue;
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        const code = line.split('//')[0];
        if (NETWORK_PATTERN.test(code)) offenders.push(posixFile);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`network call found in core path: ${[...new Set(offenders)].join(', ')}`);
  }
});

// 3. Packed mcp+cli tarball size.
await check('mcp+cli package size', () => {
  const stagingDir = mkdtempSync(join(tmpdir(), 'knowledge-crib-budget-'));
  try {
    let total = 0;
    for (const pkg of ['mcp', 'cli']) {
      execFileSync('corepack', ['pnpm@9.15.0', 'pack', '--pack-destination', stagingDir], {
        cwd: `packages/${pkg}`,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows ships corepack as a .cmd shim; shell:false (execFileSync default) cannot launch
        // it (spawnSync ENOENT). shell:true on win32 routes through cmd.exe. No-op on posix.
        // Same fix as release-verify.mjs / build-installers.mjs / pack-check.mjs.
        shell: process.platform === 'win32',
      });
    }
    for (const name of readdirSync(stagingDir)) {
      if (name.endsWith('.tgz')) total += statSync(join(stagingDir, name)).size;
    }
    if (total > MAX_PACKAGE_BYTES) {
      throw new Error(
        `${(total / 1024 / 1024).toFixed(2)} MB > cap ${(MAX_PACKAGE_BYTES / 1024 / 1024).toFixed(0)} MB`,
      );
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

// 3b. Packed parsers tarball size — separate from mcp+cli because the vendored tree-sitter
// grammars (packages/parsers/grammars/*.wasm) live here, not in mcp/cli.
await check('parsers package size (vendored grammars)', () => {
  const stagingDir = mkdtempSync(join(tmpdir(), 'knowledge-crib-budget-parsers-'));
  try {
    execFileSync('corepack', ['pnpm@9.15.0', 'pack', '--pack-destination', stagingDir], {
      cwd: 'packages/parsers',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // corepack is a .cmd on win32; shell:true to launch it
    });
    let total = 0;
    for (const name of readdirSync(stagingDir)) {
      if (name.endsWith('.tgz')) total += statSync(join(stagingDir, name)).size;
    }
    if (total > MAX_PARSERS_PACKAGE_BYTES) {
      throw new Error(
        `${(total / 1024 / 1024).toFixed(2)} MB > cap ${(MAX_PARSERS_PACKAGE_BYTES / 1024 / 1024).toFixed(0)} MB`,
      );
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

// 4 + 5. Default hit size + warm query latency. "Warm" means an already-open index serving
// repeated queries in-process (what the MCP server actually does) — NOT a fresh CLI subprocess
// per call, which pays ~100ms of Node startup + module load on every invocation and would measure
// process overhead instead of query performance. Index build (a real cold-start cost) still goes
// through the CLI subprocess in the next check.
await check('default hit size + warm query p50', async () => {
  const { repoRoot, cliPath } = buildFixture();
  try {
    runCli(cliPath, ['index', repoRoot], repoRoot);
    // dynamic import() needs a file:// URL on win32: a bare `D:\...\runtime.js` is rejected with
    // "Only URLs with a scheme in: file, data, and node ... Received protocol 'd:'". pathToFileURL
    // produces a file:// URL on every platform (posix → `file:///...`), so import() resolves on both.
    const runtimeModule = pathToFileURL(resolve('packages/cli/dist/runtime.js')).href;
    const mcpModule = pathToFileURL(resolve('packages/mcp/dist/index.js')).href;
    const { resolveProjectRoot, openSoul, openIndexOnly } = await import(runtimeModule);
    const { Verbs } = await import(mcpModule);
    const resolved = resolveProjectRoot({ explicitRoot: repoRoot });
    const rt = openSoul(resolved);
    const index = openIndexOnly(rt);
    const verbs = new Verbs({ soul: rt.soul, index, repoRoot: resolved.repoRoot });

    const timings = [];
    let lastResult;
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      lastResult = verbs.query({ q: 'widget', limit: 10 });
      timings.push(performance.now() - start);
    }
    index.close();
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length / 2)];
    if (p50 > MAX_QUERY_P50_MS) {
      throw new Error(`p50 ${p50.toFixed(1)}ms > cap ${MAX_QUERY_P50_MS}ms (warm, in-process)`);
    }
    const hits = lastResult.hits ?? [];
    for (const hit of hits) {
      const bytes = Buffer.byteLength(JSON.stringify(hit), 'utf8');
      if (bytes > MAX_DEFAULT_HIT_BYTES) {
        throw new Error(`hit ${hit.id} is ${bytes}B > cap ${MAX_DEFAULT_HIT_BYTES}B`);
      }
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// 6. Cold-start index time on a 50-file fixture.
await check(`cold index time (${FIXTURE_FILE_COUNT} files)`, () => {
  const { repoRoot, cliPath } = buildFixture();
  try {
    const start = Date.now();
    runCli(cliPath, ['index', repoRoot], repoRoot);
    const elapsed = Date.now() - start;
    if (elapsed > MAX_INDEX_MS) {
      throw new Error(`${elapsed}ms > cap ${MAX_INDEX_MS}ms`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// 6b. Dossier update latency — the P2.1 gate, in-process on a git-pinned fixture so the ratio
// measures pipeline work, not Node subprocess startup. Assertion (i) is the load-bearing one:
// the hoisted adjacency opts must make a full dossier rebuild at least MIN_DOSSIER_SPEEDUP x
// faster than the unhoisted path (this is the exact regression the hoist fixed). Assertion (ii)
// pins the end-to-end promise: after a one-file body edit + commit (the shape the M4.3
// soul-refresh loop runs on every merge), updateRepo must cost less than indexRepo on the same
// fixture. Timing ratios are CPU/IO-contended on small CI runners, so on CI the observed
// ratios are logged but not floored (same policy as the parallel:check speedup floor) — the
// deterministic parts (fixture yields callables, update completes) still gate everywhere.
await check(
  `dossier rebuild speedup >= ${MIN_DOSSIER_SPEEDUP}x + update < ${MAX_UPDATE_RATIO}x full index`,
  async () => {
    const { repoRoot } = buildUpdateFixture();
    try {
      // dynamic import() needs a file:// URL on win32 (see check 4+5 comment).
      const coreModule = pathToFileURL(resolve('packages/core/dist/index.js')).href;
      const pipelineModule = pathToFileURL(resolve('packages/pipeline/dist/index.js')).href;
      const dossiersModule = pathToFileURL(resolve('packages/pipeline/dist/dossiers.js')).href;
      const { SoulStore, newManifest, buildDossier, CALLABLE_SYMBOL_TYPES } = await import(
        coreModule
      );
      const { indexRepo, updateRepo } = await import(pipelineModule);
      const { hoistedDossierOpts } = await import(dossiersModule);

      const soulFor = () => {
        const soul = new SoulStore(join(repoRoot, '.crib'), {
          manifest: newManifest({ now: PINNED_DATE }),
        });
        soul.load();
        return soul;
      };

      // Full index (defaults — the same phase set a user gets), timed for assertion (ii).
      let t = performance.now();
      await indexRepo(soulFor(), repoRoot, { now: PINNED_DATE });
      const indexMs = performance.now() - t;

      // Assertion (i): hoisted vs unhoisted full dossier rebuild over every callable.
      const soul = soulFor();
      const callables = [...soul.iterate('symbol')].filter((n) =>
        CALLABLE_SYMBOL_TYPES.has(n.type),
      );
      if (callables.length < 100)
        throw new Error(`only ${callables.length} callables — fixture too small to measure`);
      const opts = hoistedDossierOpts(soul);
      // Warm both paths first (JIT) so the measured loops are steady-state.
      for (const n of callables.slice(0, 20)) {
        buildDossier(soul, repoRoot, n.id, PINNED_DATE);
        buildDossier(soul, repoRoot, n.id, PINNED_DATE, opts);
      }
      t = performance.now();
      for (const n of callables) buildDossier(soul, repoRoot, n.id, PINNED_DATE, opts);
      const hoistedMs = performance.now() - t;
      t = performance.now();
      for (const n of callables) buildDossier(soul, repoRoot, n.id, PINNED_DATE);
      const unhoistedMs = performance.now() - t;
      if (hoistedMs <= 0 || unhoistedMs <= 0)
        throw new Error('timing collapsed to 0ms — speedup measurement invalid');
      const speedup = unhoistedMs / hoistedMs;
      if (ON_CI) {
        process.stdout.write(
          `       dossier rebuild speedup ${speedup.toFixed(1)}x observed on CI; floor skipped (see MIN_DOSSIER_SPEEDUP comment)\n`,
        );
      } else if (speedup < MIN_DOSSIER_SPEEDUP) {
        throw new Error(
          `hoisted dossier rebuild only ${speedup.toFixed(1)}x faster (hoisted ${hoistedMs.toFixed(0)}ms vs ` +
            `unhoisted ${unhoistedMs.toFixed(0)}ms over ${callables.length} callables) < ${MIN_DOSSIER_SPEEDUP}x floor — adjacency hoist regressed?`,
        );
      } else {
        process.stdout.write(
          `       dossier rebuild: hoisted ${hoistedMs.toFixed(0)}ms vs unhoisted ${unhoistedMs.toFixed(0)}ms over ${callables.length} callables → ${speedup.toFixed(1)}x\n`,
        );
      }

      // Assertion (ii): body-only edit keeps symbol ids stable (the honest "merge touched one
      // file" update), then the incremental update must stay under a full re-index.
      writeFileSync(join(repoRoot, 'src', 'svc17.ts'), fixtureSource(17, ' edited'));
      git(repoRoot, ['add', 'src/svc17.ts']);
      git(repoRoot, [
        '-c',
        'user.email=gate@crib.dev',
        '-c',
        'user.name=Crib Gate',
        'commit',
        '-q',
        '-m',
        'edit',
      ]);
      t = performance.now();
      await updateRepo(soulFor(), repoRoot, { now: '2026-01-02T00:00:00.000Z' });
      const updateMs = performance.now() - t;
      if (indexMs <= 0) throw new Error('index measurement collapsed to 0ms — ratio invalid');
      const ratio = updateMs / indexMs;
      if (ON_CI) {
        process.stdout.write(
          `       update latency ratio ${ratio.toFixed(3)} observed on CI; ceiling skipped (see MAX_UPDATE_RATIO comment)\n`,
        );
      } else if (ratio >= MAX_UPDATE_RATIO) {
        throw new Error(
          `update took ${updateMs.toFixed(0)}ms vs index ${indexMs.toFixed(0)}ms → ratio ${ratio.toFixed(3)} >= ${MAX_UPDATE_RATIO} (incremental update must be cheaper than a full re-index)`,
        );
      } else {
        process.stdout.write(
          `       update ${updateMs.toFixed(0)}ms vs index ${indexMs.toFixed(0)}ms → ratio ${ratio.toFixed(3)} (aspirational 0.25 — see MAX_UPDATE_RATIO comment)\n`,
        );
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  },
);

// 7. Cost-saving floor — the dollar promise, enforced. Index the fixture, run a real multi-hit
// query, and compare the modeled per-task cost of the crib-default response against reading every
// whole hit file (the no-crib path), using the shared pricing model. Fail if crib isn't materially
// cheaper. This is the CI guard for the whole "more tokens, less money" thesis.
await check(`cost saving >= ${MIN_COST_SAVING}x (${COST_MODEL_TURNS}-turn task)`, async () => {
  // A dedicated fixture with REALISTICALLY sized files. The generic buildFixture writes near-empty
  // stubs, where a whole-file read is barely bigger than a crib hit — that under-measures the real
  // saving (production files are dozens–hundreds of lines). Representative files are the honest test:
  // no-crib pays for the whole file, crib pays for one line, and the ratio reflects real usage.
  const repoRoot = mkdtempSync(join(tmpdir(), 'knowledge-crib-cost-fixture-'));
  writeFileSync(
    join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'crib-cost-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  for (let i = 0; i < 20; i++) {
    const filePath = join(repoRoot, 'src', `widget${i}.ts`);
    mkdirSync(dirname(filePath), { recursive: true });
    // ~40 lines/file of plausible code — the body a no-crib agent must pull in full just to locate
    // one symbol, versus the single snippet line crib returns.
    const body = Array.from(
      { length: 12 },
      (_, k) =>
        `  /** Handler ${k} for widget ${i}: validates and transforms the incoming payload. */\n` +
        `  method${k}(input: string): string {\n    const trimmed = input.trim();\n` +
        `    return \`widget${i}:\${trimmed}:\${${k}}\`;\n  }\n`,
    ).join('\n');
    writeFileSync(
      filePath,
      `export interface Widget${i}Config {\n  id: string;\n  enabled: boolean;\n}\n\n` +
        `export class Widget${i} {\n  constructor(private readonly config: Widget${i}Config) {}\n\n${body}}\n`,
    );
  }
  try {
    // dynamic import() needs a file:// URL on win32: a bare `D:\...\runtime.js` is rejected with
    // "Only URLs with a scheme in: file, data, and node ... Received protocol 'd:'". pathToFileURL
    // produces a file:// URL on every platform (posix → `file:///...`), so import() resolves on both.
    const runtimeModule = pathToFileURL(resolve('packages/cli/dist/runtime.js')).href;
    const mcpModule = pathToFileURL(resolve('packages/mcp/dist/index.js')).href;
    const { resolveProjectRoot, openSoul, openIndexOnly } = await import(runtimeModule);
    const { Verbs } = await import(mcpModule);
    runCli(resolve('packages/cli/dist/cli.js'), ['index', repoRoot], repoRoot);
    const resolved = resolveProjectRoot({ explicitRoot: repoRoot });
    const rt = openSoul(resolved);
    const index = openIndexOnly(rt);
    const verbs = new Verbs({ soul: rt.soul, index, repoRoot: resolved.repoRoot });
    const result = verbs.query({ q: 'widget', limit: 10 });
    index.close();

    const hits = result.hits ?? [];
    if (hits.length === 0) throw new Error('fixture query returned no hits — cannot measure cost');

    // no-crib: whole files behind the hits, re-primed each turn (churn). crib: the compact,
    // cache-stable default response, primed once then re-read cheaply.
    const files = new Set();
    for (const hit of hits) {
      const m = /^(?:sym|file|cluster):([^#]+?)(?:#.*)?$/.exec(hit.id);
      if (m) files.add(m[1]);
    }
    let rawTokens = 0;
    for (const file of files) {
      try {
        rawTokens += Math.ceil(
          Buffer.byteLength(readFileSync(join(resolved.repoRoot, file), 'utf8'), 'utf8') / 4,
        );
      } catch {
        // a hit node with no readable backing file (e.g. a synthesized cluster node) — skip it
        // rather than fail the gate on an artifact of node modeling; the rawTokens===0 guard below
        // still catches the pathological "nothing resolved at all" case.
      }
    }
    if (rawTokens === 0)
      throw new Error('could not resolve any hit file — cost measurement invalid');
    const cribTokens = Math.ceil(Buffer.byteLength(JSON.stringify(hits), 'utf8') / 4);

    const cribCost = sessionCost({ contextTokens: cribTokens, turns: COST_MODEL_TURNS });
    const noCribCost = sessionCost({
      contextTokens: rawTokens,
      turns: COST_MODEL_TURNS,
      stable: false,
    });
    const saving = cribCost > 0 ? noCribCost / cribCost : Number.POSITIVE_INFINITY;
    if (saving < MIN_COST_SAVING) {
      throw new Error(
        `crib is only ${saving.toFixed(1)}x cheaper (crib $${cribCost.toFixed(6)} vs no-crib ` +
          `$${noCribCost.toFixed(6)}) < floor ${MIN_COST_SAVING}x`,
      );
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

if (failures.length > 0) {
  process.stderr.write(
    `\nbudget-check failed (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('\nbudget-check ok - all lightweight budgets held\n');

// --- helpers ---

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function runCli(cliPath, args, cwd) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function buildFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'knowledge-crib-budget-fixture-'));
  writeFileSync(
    join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'crib-budget-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  for (let i = 0; i < FIXTURE_FILE_COUNT; i++) {
    const filePath = join(repoRoot, 'src', `widget${i}.ts`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `export interface Widget${i} {\n  id: string;\n}\n\n` +
        `export function buildWidget${i}(id: string): Widget${i} {\n  return { id };\n}\n\n` +
        `export function renderWidget${i}(widget: Widget${i}): string {\n  return \`widget:\${widget.id}\`;\n}\n`,
    );
  }
  return { repoRoot, cliPath: resolve('packages/cli/dist/cli.js') };
}

/** Deterministic fixture source for the update-latency gate: one class (7 callables) + one fn per file. */
function fixtureSource(i, marker = '') {
  const methods = Array.from(
    { length: 6 },
    (_, k) =>
      `  /** Step ${k} of svc ${i}. */\n  step${k}(input: string): string {\n    return this.helper(input) + ':${k}';\n  }\n`,
  ).join('\n');
  return (
    `export class Svc${i} {\n${methods}\n  helper(input: string): string {\n    return \`svc${i}:\${input}${marker}\`;\n  }\n}\n\n` +
    `export function runSvc${i}(svc: Svc${i}, input: string): string {\n  return svc.step0(input);\n}\n`
  );
}

/** The update-latency fixture: a git repo (pinned dates) so `crib update` has a VCS anchor. */
function buildUpdateFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'knowledge-crib-update-latency-'));
  writeFileSync(
    join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'crib-update-latency-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  for (let i = 0; i < UPDATE_FIXTURE_FILES; i++) {
    const filePath = join(repoRoot, 'src', `svc${i}.ts`);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, fixtureSource(i));
  }
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['add', 'package.json', 'src']);
  git(repoRoot, [
    '-c',
    'user.email=gate@crib.dev',
    '-c',
    'user.name=Crib Gate',
    'commit',
    '-q',
    '-m',
    'init',
  ]);
  return { repoRoot, cliPath: resolve('packages/cli/dist/cli.js') };
}

/** git in a fixture repo, with every commit pinned to PINNED_DATE for determinism. */
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: PINNED_DATE,
      GIT_COMMITTER_DATE: PINNED_DATE,
    },
  }).trim();
}
