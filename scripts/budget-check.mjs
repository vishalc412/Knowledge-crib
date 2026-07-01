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
 *
 * MAX_RUNTIME_DEPS is 6, not lower, because `web-tree-sitter` (the PHP extractor's WASM engine,
 * P3) is currently the 6th external runtime dependency — a deliberate, disclosed tradeoff (see
 * NOTICE), not headroom to spend carelessly. MAX_PARSERS_PACKAGE_BYTES exists for the same reason:
 * a future grammar addition that quietly balloons this package should fail the build, not slip in.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_RUNTIME_DEPS = 6;
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024; // 5 MB, mcp+cli combined
const MAX_PARSERS_PACKAGE_BYTES = 3 * 1024 * 1024; // 3 MB — today's actual is ~0.6 MB; headroom for a
// couple more small vendored grammars before this becomes a real conversation, not silent bloat.
const MAX_DEFAULT_HIT_BYTES = 1536; // 1.5 KB/hit default tier
const MAX_QUERY_P50_MS = 150;
const MAX_INDEX_MS = 20_000;
const FIXTURE_FILE_COUNT = 50;

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
await check('core path is network-free', () => {
  const offenders = [];
  for (const dir of CORE_PATH_DIRS) {
    for (const file of walk(dir)) {
      if (file.endsWith('.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        const code = line.split('//')[0];
        if (NETWORK_PATTERN.test(code)) offenders.push(file);
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
    const runtimeModule = resolve('packages/cli/dist/runtime.js');
    const mcpModule = resolve('packages/mcp/dist/index.js');
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
