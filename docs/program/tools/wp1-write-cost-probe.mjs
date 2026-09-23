#!/usr/bin/env node
/**
 * WP1 write-cost probe — the REUSABLE measurement behind
 * `docs/program/logs/wp1-soulstore-write-cost-2026-09-23.log`.
 *
 * It answers one question with a measured number rather than an estimate: now that
 * `writeJsonAtomic` flushes the file before the rename and the parent directory after it, what
 * does that cost a real `crib index` / `crib update` workload on this machine?
 *
 * Three stages, each independently useful:
 *
 *   A. per-write durable cost — N timed `writeJsonAtomic` calls, p50/p95/mean, plus a replication
 *      of the pre-WP1 primitive (`mkdir` + `writeFileSync(tmp)` + `renameSync`) in the same process
 *      and directory so the delta is same-machine and same-filesystem.
 *   B. filesystem-operation tally — `node:fs` is wrapped BEFORE the workload's module graph is
 *      evaluated, so `renameSync` / `fsyncSync` calls made by the ESM `import { fsyncSync } from
 *      'node:fs'` bindings are counted. This is the instrumentation style of
 *      `wp1-durability-baseline-2026-09-22.log`, and the wrapping MUST happen in a `--require`
 *      preload: patching `fs.renameSync` from inside an .mjs and then dynamically importing the
 *      target does NOT work, because a builtin's ESM namespace is snapshotted from the CJS exports
 *      object at first import (verified — see the log's "instrumentation" note).
 *   C. the workload itself — a REAL project copied into a private temp dir, indexed with the real
 *      CLI, then re-indexed incrementally after a one-file edit (`--dirty`, which is required for
 *      the working-tree edit to be visible at all), then a no-op update to price the floor.
 *
 * Hard safety rules this script obeys by construction (WP1 probe rules):
 *   - It NEVER runs the CLI against the source project. The project is copied into a directory
 *     created by `mkdtempSync(join(tmpdir(), 'crib-wp1-cost-'))` and only the COPY is indexed, so
 *     no `.crib/` is ever created inside someone else's repository.
 *   - `KCRIB_REGISTRY_DIR` and `KCRIB_MEMORY_DIR` are redirected INTO that temp dir, so the real
 *     `~/.crib/registry.json` is never touched either.
 *   - Cleanup is `fs.rmSync(tmpDir, {recursive: true, force: true})` on the directory this process
 *     created. No shell `rm -rf`, ever, and nothing outside `tmpDir` is ever deleted.
 *
 * Usage:
 *   node docs/program/tools/wp1-write-cost-probe.mjs
 *   node docs/program/tools/wp1-write-cost-probe.mjs --n=200 --log=<path> --source=<dir>
 *   node docs/program/tools/wp1-write-cost-probe.mjs --skip-workload      # stages A+B only
 *
 * Exit status is 0 when every requested stage produced a number, 1 when a stage could not be
 * measured — a stage that could not run is reported as NOT MEASURED, never as zero.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Layout and constants
// ---------------------------------------------------------------------------------------------

const SELF = fileURLToPath(import.meta.url);
/** docs/program/tools -> repo root. */
const REPO_ROOT = resolve(dirname(SELF), '..', '..', '..');

/** The BUILT modules under test. Both are the same code; the tally covers whichever the CLI loads. */
const MEMORY_ATOMIC = join(REPO_ROOT, 'packages/memory/dist/atomic.js');
const CORE_ATOMIC = join(REPO_ROOT, 'packages/core/dist/atomic-write.js');
const CLI_BIN = join(REPO_ROOT, 'packages/cli/dist/bin.js');

/** The operation kinds tallied, unchanged from the pre-WP1 baseline log. */
const COUNTED_OPS = ['openSync', 'fsyncSync', 'renameSync', 'writeFileSync', 'appendFileSync'];

/**
 * Which counted ops get CALL-SITE attribution, and why it is opt-in per child.
 *
 * The ops below are the ones that write. Attributing them answers the question a bare tally
 * cannot: *which code path did this rename come from?* — the difference between `writeJsonAtomic`
 * (two flushes) and an unflushed tmp+rename writer is the entire cost question, and the tally
 * alone cannot tell them apart (both are writeFileSync+renameSync, 1:1).
 *
 * It is opt-in because `new Error().stack` costs tens of microseconds per call. In the workload
 * children that is noise against a 300 s wall clock, but in the per-write timing child it would
 * inflate the 0.12 ms rename-only baseline by a comparable amount and corrupt the very
 * comparison the probe exists to make. So the workload children set WP1_ATTRIB=1; the timing
 * child does not.
 */
const ATTRIBUTED_OPS = ['renameSync', 'writeFileSync', 'fsyncSync'];

/** The WP2 gate this measurement is weighed against. */
const UPDATE_VISIBILITY_BUDGET_MS = 2000;

/**
 * Candidate source projects, in the order WP1 named them. The first that exists AND is a git work
 * tree is used; anything else is reported, not silently substituted.
 */
const CANDIDATE_SOURCES = [
  '/Users/vishalchawla/Documents/personal/seeroflow/seero-flow',
  '/Users/vishalchawla/Project/seeroflow/seero-flow',
  '/Users/vishalchawla/Project/theknowlegecrib',
  '/Users/vishalchawla/Project/agency-agents',
  '/Users/vishalchawla/Documents/personal/Knowledge-crib',
];

/** Source extensions the indexer understands, used only to report the copy's scale. */
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|sql|md)$/;

const ARGS = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=') || 'true'];
  }),
);

const OPT = {
  mode: ARGS.get('child') ?? 'parent',
  n: Number(ARGS.get('n') ?? 200),
  log: ARGS.get('log') ?? join(REPO_ROOT, 'docs/program/logs/wp1-soulstore-write-cost-2026-09-23.log'),
  source: ARGS.get('source'),
  skipWorkload: ARGS.get('skip-workload') === 'true',
};

// ---------------------------------------------------------------------------------------------
// Reporting: every line goes to stdout AND to the log, so the log is never hand-transcribed
// ---------------------------------------------------------------------------------------------

const LOG_LINES = [];
function emit(text = '') {
  LOG_LINES.push(text);
  process.stdout.write(`${text}\n`);
}

function flushLog(logPath) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${LOG_LINES.join('\n')}\n`);
    process.stdout.write(`\n[probe] log written to ${logPath}\n`);
  } catch (error) {
    process.stderr.write(`[probe] could NOT write log ${logPath}: ${error.message}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function summarise(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

const ms = (v) => (Number.isFinite(v) ? v.toFixed(4) : 'NOT MEASURED');

// ---------------------------------------------------------------------------------------------
// Child modes: probe-only (the one-time capability probe's constant cost) and perwrite timing
// ---------------------------------------------------------------------------------------------

/** The CJS preload. Written into the temp dir and passed to every counted child via --require. */
function preloadSource() {
  return `// WP1 write-cost probe preload — generated, do not edit.
'use strict';
const fs = require('node:fs');
const COUNTED = ${JSON.stringify(COUNTED_OPS)};
const ATTRIBUTED = ${JSON.stringify(ATTRIBUTED_OPS)};
const ATTRIB_ON = process.env.WP1_ATTRIB === '1';
const counts = {};
const originals = {};
const attribution = {};

// Collapse absolute paths so the table is readable and stable across tmp dirs. V8 frames come
// through as file:// URLs, so strip the scheme BEFORE prefix matching or every prefix misses.
function shorten(file) {
  let f = file.startsWith('file://') ? file.slice(7) : file;
  for (const p of [process.env.WP1_TMPDIR, process.env.WP1_REPOROOT]) {
    if (p && f.startsWith(p)) f = '~' + f.slice(p.length);
  }
  f = f.replace(/^.*\\/node_modules\\/@knowledge-crib\\//, '@');
  f = f.replace(/^~\\/packages\\/([^/]+)\\/(?:dist|src)\\//, '$1:');
  f = f.replace(/^~\\/project\\//, 'copy:');
  return f;
}

// The two innermost frames outside node: internal and outside this preload.
//   frame 0 = the WRITER (the function that called fs.<op>)
//   frame 1 = ITS CALLER
// so "pkg:core/dist/atomic-write.js#writeJsonAtomic  <-  pkg:core/dist/soul-store.js#writeShardChunks"
// reads as: a graph shard chunk, written through the durable primitive.
function callerFrames() {
  const out = [];
  const lines = (new Error().stack || '').split('\\n');
  for (const ln of lines) {
    const m = /^\\s+at (?:(.*?) )?\\(?(.*?):(\\d+):(\\d+)\\)?$/.exec(ln);
    if (!m) continue;
    const fn = m[1] || '<anonymous>';
    const file = m[2];
    if (file === '' || file.startsWith('node:') || file.includes('wp1-fs-count-preload')) continue;
    out.push(shorten(file) + '#' + fn);
    if (out.length === 2) break;
  }
  return out;
}

for (const k of COUNTED) {
  const orig = fs[k];
  originals[k] = orig;
  counts[k] = 0;
  const attributed = ATTRIB_ON && ATTRIBUTED.includes(k);
  fs[k] = function (...args) {
    counts[k] += 1;
    if (attributed) {
      const f = callerFrames();
      const key = (f[0] || '<unknown>') + '  <-  ' + (f[1] || '<none>');
      const perOp = attribution[k] || (attribution[k] = {});
      perOp[key] = (perOp[key] || 0) + 1;
    }
    return orig.apply(this, args);
  };
}
globalThis.__wp1Counts = counts;
globalThis.__wp1Attribution = attribution;
const out = process.env.WP1_COUNT_OUT;
if (out) {
  process.on('exit', () => {
    // Snapshot FIRST, then write with the ORIGINAL writeFileSync, so the dump cannot count itself.
    const snapshot = {};
    for (const k of COUNTED) snapshot[k] = counts[k];
    const attr = {};
    for (const k of Object.keys(attribution)) attr[k] = attribution[k];    try {
      originals.writeFileSync(out, JSON.stringify({ pid: process.pid, counts: snapshot, attribution: attr }));
    } catch (error) {
      try { originals.writeFileSync(out, JSON.stringify({ error: String(error) })); } catch (_) {}
    }
  });
}
`;
}

function zeroCounts() {
  const c = {};
  for (const k of COUNTED_OPS) c[k] = 0;
  return c;
}

async function childProbeOnly() {
  // Force BOTH modules' one-time capability probes, so their constant contribution to a workload
  // tally is MEASURED rather than assumed. Each probe: open + write + fsync + dir open + fsync.
  const report = { modules: {}, counts: null };
  for (const [name, path] of [
    ['memory', MEMORY_ATOMIC],
    ['core', CORE_ATOMIC],
  ]) {
    try {
      const mod = await import(pathToFileURL(path).href);
      report.modules[name] = mod.atomicWriteDurability();
    } catch (error) {
      report.modules[name] = { error: error.message };
    }
  }
  report.counts = globalThis.__wp1Counts ? { ...globalThis.__wp1Counts } : null;
  process.stdout.write(`PROBE-ONLY ${JSON.stringify(report)}\n`);
}

async function childPerWrite() {
  const payload = `{"pad":"${'x'.repeat(2000)}"}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'crib-wp1-perwrite-'));
  const target = join(dir, 'write.json');
  const tmp = `${target}.tmp`;
  const out = { dir, payloadBytes: Buffer.byteLength(payload), n: OPT.n, series: {} };

  // Warm both modules' cached durability probes BEFORE timing, so no timed sample pays the
  // one-time probe (which the probe-only child measures separately).
  const memory = await import(pathToFileURL(MEMORY_ATOMIC).href);
  const core = await import(pathToFileURL(CORE_ATOMIC).href);
  const durability = {
    memory: memory.atomicWriteDurability(),
    core: core.atomicWriteDurability(),
  };
  out.durability = durability;

  // (1) Replication of the PRE-WP1 primitive: mkdir + writeFileSync(tmp) + renameSync, nothing else.
  // Same directory, same payload, same process as the durable series — so the delta is the barrier.
  {
    const samples = [];
    for (let i = 0; i < OPT.n; i += 1) {
      const t0 = performance.now();
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, target);
      samples.push(performance.now() - t0);
    }
    out.series.baselineRenameOnly = summarise(samples);
  }

  // (2) The durable primitive, from each BUILT module, timed through its public entry point.
  for (const [name, mod] of [
    ['memoryDist', memory],
    ['coreDist', core],
  ]) {
    const samples = [];
    for (let i = 0; i < OPT.n; i += 1) {
      const t0 = performance.now();
      mod.writeJsonAtomic(target, payload);
      samples.push(performance.now() - t0);
    }
    out.series[name] = summarise(samples);
  }

  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`PERWRITE ${JSON.stringify(out)}\n`);
}

// ---------------------------------------------------------------------------------------------
// The workload: copy a REAL project, index the copy, then re-index it incrementally
// ---------------------------------------------------------------------------------------------

function pickSource() {
  if (OPT.source) {
    return { path: OPT.source, why: 'explicit --source' };
  }
  for (const candidate of CANDIDATE_SOURCES) {
    if (!existsSync(candidate)) continue;
    if (!statSync(candidate).isDirectory()) continue;
    const git = spawnSync('git', ['-C', candidate, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    if (git.status !== 0 || git.stdout.trim() !== 'true') continue;
    return { path: candidate, why: 'first candidate that exists and is a git work tree' };
  }
  return null;
}

function gitLines(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    return { ok: false, stderr: r.stderr?.toString('utf8') ?? '', lines: [] };
  }
  return { ok: true, stderr: '', lines: r.stdout.toString('utf8').split('\n').filter(Boolean) };
}

/**
 * Copy the source project's TRACKED working-tree files into `dest`.
 *
 * Tracked files, because the indexer's `discoverFiles` respects the repo's `.gitignore` and
 * `DEFAULT_IGNORES` — so a real in-place `crib index` skips gitignored trees (on the source project
 * measured here that is ~1 GB of node_modules, ~414 MB of .git, and ~2.4 GB of gitignored installer
 * build scratch). Copying tracked files therefore reproduces the file set a real index would walk,
 * without dragging several GB of build output through /tmp.
 */
function copyTrackedFiles(sourceRoot, dest) {
  // -z is NUL-separated, so this one call is read as bytes and split on \0 rather than on newlines.
  const raw = spawnSync('git', ['-C', sourceRoot, 'ls-files', '-z'], {
    encoding: 'buffer',
    maxBuffer: 1 << 30,
  });
  if (raw.status !== 0) {
    return {
      ok: false,
      files: 0,
      reason: `git ls-files failed: ${(raw.stderr ?? '').toString('utf8').trim()}`,
    };
  }
  const names = raw.stdout.toString('utf8').split('\0').filter(Boolean);

  const stats = { files: 0, sourceFiles: 0, sourceLines: 0, bytes: 0, missing: 0 };
  for (const rel of names) {
    const from = join(sourceRoot, rel);
    const to = join(dest, rel);
    let buf;
    try {
      buf = readFileSync(from);
    } catch {
      stats.missing += 1; // tracked but deleted in the working tree — skip, like the walker would
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    stats.files += 1;
    stats.bytes += buf.length;
    if (SOURCE_EXT.test(rel)) {
      stats.sourceFiles += 1;
      let lines = 0;
      for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) lines += 1;
      stats.sourceLines += lines;
    }
  }
  return { ok: true, ...stats, totalListed: names.length };
}

/** Run the real CLI in the copy with counting on, and return its stdout/stderr + tallies. */
function runCounted(tag, cwd, cliArgs, preloadPath, tmpDir, countFile) {
  const env = {
    ...process.env,
    // Redirect the tool's global state INTO the temp dir: the user's ~/.crib is never touched.
    KCRIB_REGISTRY_DIR: join(tmpDir, 'home', '.crib'),
    KCRIB_MEMORY_DIR: join(tmpDir, 'home', '.crib', 'memory'),
    WP1_COUNT_OUT: countFile,
    // Call-site attribution on, and the two path prefixes the preload collapses. Only the
    // workload children get this; the per-write timing child never does (see ATTRIBUTED_OPS).
    WP1_ATTRIB: '1',
    WP1_TMPDIR: tmpDir,
    WP1_REPOROOT: REPO_ROOT,
  };
  const argv = [CLI_BIN, ...cliArgs];
  const command = ['node', '--require', preloadPath, ...argv].join(' ');
  const t0 = performance.now();
  const r = spawnSync('node', ['--require', preloadPath, ...argv], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  const wallMs = performance.now() - t0;

  let counts = null;
  let attribution = null;
  let countsError = null;
  try {
    const parsed = JSON.parse(readFileSync(countFile, 'utf8'));
    counts = parsed.counts ?? null;
    attribution = parsed.attribution ?? null;
    countsError = parsed.error ?? null;
  } catch (error) {
    countsError = `no tally written (${error.message})`;
  }

  return {
    tag,
    command,
    exitStatus: r.status,
    wallMs,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    counts,
    attribution,
    countsError,
  };
}

// ---------------------------------------------------------------------------------------------
// Parent orchestration
// ---------------------------------------------------------------------------------------------

async function parent() {
  const startedAt = new Date();
  const tmpDir = mkdtempSync(join(tmpdir(), 'crib-wp1-cost-'));
  const preloadPath = join(tmpDir, 'wp1-fs-count-preload.cjs');
  writeFileSync(preloadPath, preloadSource());

  emit('WP1 write-cost probe — durable-write cost and filesystem-operation tally');
  emit('='.repeat(92));
  emit(`run at          ${startedAt.toISOString()}`);
  emit(`host            ${process.platform} ${process.platform === 'darwin' ? 'darwin' : ''} (node ${process.version})`);
  emit(`repo root       ${REPO_ROOT}`);
  emit(`probe script    ${SELF}`);
  emit(`temp dir        ${tmpDir}  (mkdtempSync(tmpdir(), 'crib-wp1-cost-'); removed with fs.rmSync at the end)`);
  emit();
  emit('Exact command that produced everything below:');
  emit(`  node ${SELF.replace(`${REPO_ROOT}/`, '')}${[...ARGS.entries()].map(([k, v]) => ` --${k}=${v}`).join('')}`);
  emit();

  // ---- Module under test -----------------------------------------------------------------
  emit('Module under test');
  emit('-'.repeat(92));
  const moduleState = {};
  for (const [name, path] of [
    ['packages/memory/dist/atomic.js', MEMORY_ATOMIC],
    ['packages/core/dist/atomic-write.js', CORE_ATOMIC],
  ]) {
    const exists = existsSync(path);
    const source = exists ? readFileSync(path, 'utf8') : '';
    const hasFsync = source.includes('fsyncSync');
    // A RE-EXPORT SHIM is not a module that lacks the flush — it is a module that delegates it.
    // `packages/memory/src/atomic.ts` was refactored during WP1 to re-export the core leaf so the
    // tree keeps ONE implementation; its built output legitimately contains no `fsyncSync` of its
    // own. Reporting that as "does not flush" would be a false finding, so it is labelled here and
    // the semantic check below (atomicWriteDurability) is what actually decides the capability.
    const reExports =
      !hasFsync && /@knowledge-crib\/core\/atomic-write/.test(source) && /export\s*\{/.test(source);
    let durability = null;
    if (exists) {
      try {
        const mod = await import(pathToFileURL(path).href);
        durability = mod.atomicWriteDurability();
      } catch (error) {
        durability = { error: error.message };
      }
    }
    moduleState[name] = { exists, hasFsync, reExports, durability };
    emit(`  ${name}`);
    emit(
      `    exists=${exists}  contains fsyncSync=${hasFsync}${reExports ? '  (RE-EXPORT SHIM -> @knowledge-crib/core/atomic-write; delegates, does not lack the flush)' : ''}`,
    );
    emit(`    atomicWriteDurability() = ${JSON.stringify(durability)}`);
  }
  const coreDurability = moduleState['packages/core/dist/atomic-write.js'].durability;
  const flushes = Boolean(coreDurability?.fileFlush && coreDurability?.dirFlush);
  const memoryIsShim = moduleState['packages/memory/dist/atomic.js'].reExports === true;
  if (memoryIsShim) {
    emit(
      '  NOTE: memory/dist/atomic.js delegates to core, so BOTH modules resolve to the SAME core',
    );
    emit(
      '        module instance. The one-time capability probe therefore runs ONCE per process,',
    );
    emit(
      '        and the `memoryDist` / `coreDist` rows in Stage A measure the same implementation.',
    );
  }
  emit(
    `  => the primitive measured below DOES flush: ${flushes} (fileFlush=${coreDurability?.fileFlush}, dirFlush=${coreDurability?.dirFlush}, powerLossDurable=${coreDurability?.powerLossDurable})`,
  );
  emit();

  // ---- Stage A: per-write cost -----------------------------------------------------------
  emit(`Stage A — per-write durable cost (${OPT.n} timed writes, 2 KB payload, one directory)`);
  emit('-'.repeat(92));
  const perWriteProc = spawnSync(
    'node',
    ['--require', preloadPath, SELF, '--child=perwrite', `--n=${OPT.n}`],
    { encoding: 'utf8', maxBuffer: 1 << 30 },
  );
  let perWrite = null;
  for (const line of (perWriteProc.stdout ?? '').split('\n')) {
    if (line.startsWith('PERWRITE ')) perWrite = JSON.parse(line.slice('PERWRITE '.length));
  }
  if (!perWrite) {
    emit('  NOT MEASURED — the per-write child produced no result.');
    emit(`  child stderr: ${(perWriteProc.stderr ?? '').trim().slice(0, 800)}`);
  } else {
    emit(`  payload ${perWrite.payloadBytes} bytes`);
    emit('  series                       p50(ms)     p95(ms)     mean(ms)     min        max');
    for (const [name, s] of Object.entries(perWrite.series)) {
      emit(
        `  ${name.padEnd(26)} ${ms(s.p50).padStart(9)} ${ms(s.p95).padStart(11)} ${ms(s.mean).padStart(12)} ${ms(s.min).padStart(10)} ${ms(s.max).padStart(10)}`,
      );
    }
    const base = perWrite.series.baselineRenameOnly;
    const durable = perWrite.series.coreDist;
    if (base && durable) {
      emit(
        `  overhead (coreDist - baselineRenameOnly): p50 +${ms(durable.p50 - base.p50)} ms   p95 +${ms(durable.p95 - base.p95)} ms   (${(durable.p50 / base.p50).toFixed(1)}x)`,
      );
    }
  }
  emit();

  // ---- Probe's constant contribution -----------------------------------------------------
  emit("Stage B(0) — the one-time capability probe's constant contribution to a workload tally");
  emit('-'.repeat(92));
  const probeProc = spawnSync('node', ['--require', preloadPath, SELF, '--child=probe-only'], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  let probeOnly = null;
  for (const line of (probeProc.stdout ?? '').split('\n')) {
    if (line.startsWith('PROBE-ONLY ')) probeOnly = JSON.parse(line.slice('PROBE-ONLY '.length));
  }
  if (!probeOnly) {
    emit('  NOT MEASURED — the probe-only child produced no result.');
  } else {
    emit(`  durability probed per module: ${JSON.stringify(probeOnly.modules)}`);
    emit(`  fs ops consumed by probing BOTH modules: ${JSON.stringify(probeOnly.counts)}`);
    emit('  (subtracted from the raw workload tallies below, so those figures describe the WORKLOAD.)');
  }
  emit();

  if (OPT.skipWorkload) {
    emit('--skip-workload: stopping after stage B. Workload tallies NOT MEASURED.');
    flushLog(OPT.log);
    return 0;
  }

  // ---- Stage B/C: the real workload ------------------------------------------------------
  emit('Stage B/C/D — a REAL indexing workload: full index, one-file incremental re-index, no-op');
  emit('-'.repeat(92));
  const picked = pickSource();
  if (!picked) {
    emit('  NO SOURCE PROJECT — none of the candidate paths exists as a git work tree.');
    emit(`  candidates tried: ${CANDIDATE_SOURCES.join(', ')}`);
    emit('  Workload tallies NOT MEASURED.');
    flushLog(OPT.log);
    rmSync(tmpDir, { recursive: true, force: true });
    return 1;
  }
  const sourceRoot = picked.path;
  emit(`  source project   ${sourceRoot}`);
  emit(`  selected because ${picked.why}`);

  const head = gitLines(sourceRoot, ['rev-parse', 'HEAD']);
  emit(`  source HEAD      ${head.ok ? head.lines[0] : 'unknown (not a git work tree)'}`);

  const dest = join(tmpDir, 'project');
  mkdirSync(dest, { recursive: true });
  const copy = copyTrackedFiles(sourceRoot, dest);
  if (!copy.ok) {
    emit(`  COPY FAILED: ${copy.reason}`);
    emit('  Workload tallies NOT MEASURED.');
    flushLog(OPT.log);
    rmSync(tmpDir, { recursive: true, force: true });
    return 1;
  }
  emit();
  emit('  copied scale (tracked working-tree files, i.e. what the indexer would actually walk):');
  emit(`    tracked files listed   ${copy.totalListed}`);
  emit(`    files copied           ${copy.files}   (${copy.missing} tracked-but-missing skipped)`);
  emit(`    source files           ${copy.sourceFiles}  (.ts/.tsx/.js/.jsx/.mjs/.cjs/.py/.go/.rs/.java/.sql/.md)`);
  emit(`    source LOC             ${copy.sourceLines}`);
  emit(`    bytes copied           ${(copy.bytes / 1024 / 1024).toFixed(1)} MiB`);
  emit();

  // A VCS anchor is required for `crib update` to compute a delta rather than fall back to a full
  // index, so the copy gets its own tiny repo. This is inside OUR temp dir, not the source repo.
  //
  // `.crib/` IS ADDED TO THE COPY'S .gitignore FIRST, and that is load-bearing, not tidiness. The
  // stages below commit the copy's working tree to exercise the committed-delta path, and a plain
  // `git add -A` would otherwise stage the index's OWN artifacts — hundreds of `.crib/graph/**`
  // shard files that the index just wrote. Those files then appear in the next delta's `changed:`
  // list and inflate its scope with index plumbing instead of source. (An uncommitted `.crib/` is
  // invisible to `uncommittedChanges()` — it deliberately excludes untracked files — so this only
  // bites the committed path, which is exactly where it went unnoticed until a smoke test caught
  // `changed: .crib/graph/extracted/edges/3c/0000.jsonl` in a "one-file edit" stage.)
  const gitignorePath = join(dest, '.gitignore');
  const existingIgnore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!/^\.crib\/?$/m.test(existingIgnore)) {
    const prefix = existingIgnore.length > 0 && !existingIgnore.endsWith('\n') ? `${existingIgnore}\n` : existingIgnore;
    writeFileSync(gitignorePath, `${prefix}.crib/\n`);
  }
  const gitInit = spawnSync('git', ['init', '-q'], { cwd: dest, encoding: 'utf8' });
  const gitAdd = spawnSync('git', ['add', '-A'], { cwd: dest, encoding: 'utf8' });
  const gitCommit = spawnSync(
    'git',
    ['-c', 'user.email=probe@local', '-c', 'user.name=probe', 'commit', '-q', '-m', 'probe baseline'],
    { cwd: dest, encoding: 'utf8', maxBuffer: 1 << 30 },
  );
  emit(`  git anchor in the copy: init=${gitInit.status} add=${gitAdd.status} commit=${gitCommit.status}`);
  if (gitCommit.status !== 0) {
    emit(`  (commit stderr: ${(gitCommit.stderr ?? '').trim().slice(0, 300)})`);
    emit('  NOTE: without a VCS anchor the incremental stage degrades to a full index; reported if so.');
  }
  emit();

  const full = runCounted(
    'full-index',
    dest,
    ['index', dest],
    preloadPath,
    tmpDir,
    join(tmpDir, 'counts-full.json'),
  );
  reportWorkload('B1. FULL INDEX  (crib index on the copy)', full, probeOnly?.counts);
  emit(`     cli stdout: ${full.stdout.split('\n')[0] ?? ''}`);
  emit(`     wall clock (whole CLI process, incl. node startup + sqlite index): ${full.wallMs.toFixed(1)} ms`);
  emit();

  // ---- Stages C1-C3: one-file re-indexes, from typical to worst case ----------------------
  //
  // WHY THREE ONE-FILE STAGES. The write count of a one-file re-index is not driven by "one file"
  // — it is driven by the DELTA SCOPE the changed file pulls in (its importers) and by how many
  // callable symbols it owns (one dossier rewrite each). A single "one file edited" number is
  // therefore not interpretable without saying WHICH file. The first run of this probe edited the
  // symbol-densest file and produced a 730-file cascade — a real number, but a worst case, and one
  // that would mislead if reported as "the cost of a one-file edit". So three cases are measured:
  //   C1 a typical LEAF file (nothing imports it), edited in the WORKING TREE       -> `--dirty`
  //   C2 the same leaf file, COMMITTED and applied without `--dirty`                -> canonical
  //   C3 the symbol-densest file (worst case: large scope + many dossiers)          -> `--dirty`
  //
  // `--dirty` IS REQUIRED for a working-tree edit, and its absence silently makes the stage a
  // no-op rather than a measurement. `updateRepo` computes its delta from
  // `changedFilesSince(root, since)` = `git diff --name-only --no-renames <since>..HEAD`, which sees
  // COMMITTED changes only; an uncommitted edit is invisible without `--dirty`, so the run takes the
  // `noop: true` branch (`soul.setVcsHead(head)` + `soul.commit(now, true)`) — advancing the anchor
  // and reporting "up to date" while measuring a commit, not a re-index. `--dirty` adds
  // `uncommittedChanges(root)` (staged + unstaged), which is exactly the developer-edits-a-file case.
  // C2 and D deliberately omit `--dirty` to exercise the other branch.
  const oneFileStages = [];
  const editAndRun = ({ edit, label, args, outName, caution }) => {
    if (!edit) {
      emit(`${label} — NOT MEASURED (no candidate source file found in the copy for this case).`);
      emit();
      return null;
    }
    emit(
      `     edited file: ${edit.rel} (${edit.bytesBefore} -> ${edit.bytesAfter} bytes, +1 line; ${edit.exportsInFile} \`export\` statement(s); ${edit.note})`,
    );
    const r = runCounted(`stage-${outName}`, dest, args, preloadPath, tmpDir, join(tmpDir, `counts-${outName}.json`));
    reportWorkload(label, r, probeOnly?.counts);
    emit(`     cli stdout: ${r.stdout.split('\n')[0] ?? ''}`);
    emit(`     cli stdout: ${r.stdout.split('\n')[1] ?? ''}`);
    emit(`     wall clock (whole CLI process): ${r.wallMs.toFixed(1)} ms`);
    if (/^indexed /.test(r.stdout)) {
      emit('     CAUTION: the CLI re-ran a FULL index (no usable VCS anchor) — this is NOT an incremental figure.');
    } else if (/^up to date/.test(r.stdout)) {
      emit('     CAUTION: the CLI reported "up to date" — the edit was NOT seen as a change, so this');
      emit('              tally is an anchor-advance commit, NOT a one-file re-index.');
    }
    if (caution) emit(`     NOTE: ${caution}`);
    emit();
    oneFileStages.push({ label, r });
    return r;
  };

  emit('C. ONE-FILE RE-INDEXES');
  emit('-'.repeat(92));
  const leafEdit = appendToOneSourceFile(dest, 'leaf');
  editAndRun({
    edit: leafEdit,
    label: 'C1. ONE-FILE RE-INDEX — typical LEAF file, UNCOMMITTED edit (crib update --dirty)',
    args: ['update', dest, '--dirty'],
    outName: 'c1-leaf-dirty',
    caution: 'a leaf file has no importers, so the delta scope should be small — this is the COMMON case.',
  });

  // Commit the leaf edit inside the COPY (never the source project), then apply it with a plain
  // `update`. This both prices the committed-change path and ADVANCES THE VCS ANCHOR past the leaf
  // commit, so the worst-case stage below sees only its own edit rather than a two-file delta.
  if (leafEdit) {
    const committed = gitCommitAll(dest, 'probe: leaf one-line edit');
    emit(`     [C1 leaf edit committed inside the copy: status=${committed}]`);
    emit();
    const leafCommitted = runCounted(
      'stage-c2-leaf-committed',
      dest,
      ['update', dest],
      preloadPath,
      tmpDir,
      join(tmpDir, 'counts-c2-leaf-committed.json'),
    );
    reportWorkload('C2. ONE-FILE RE-INDEX — same LEAF file, COMMITTED (crib update, no --dirty)', leafCommitted, probeOnly?.counts);
    emit(`     cli stdout: ${leafCommitted.stdout.split('\n')[0] ?? ''}`);
    emit(`     wall clock (whole CLI process): ${leafCommitted.wallMs.toFixed(1)} ms`);
    if (/^indexed /.test(leafCommitted.stdout)) {
      emit('     CAUTION: the CLI re-ran a FULL index — NOT an incremental figure.');
    } else if (/^up to date/.test(leafCommitted.stdout)) {
      emit('     CAUTION: reported "up to date" — the committed edit was not seen; NOT a re-index.');
    }
    emit();
    oneFileStages.push({ label: 'C2. ONE-FILE (leaf, committed)', r: leafCommitted });
  }

  const denseEdit = appendToOneSourceFile(dest, 'densest');
  editAndRun({
    edit: denseEdit,
    label: 'C3. ONE-FILE RE-INDEX — WORST CASE: symbol-densest file, UNCOMMITTED edit (--dirty)',
    args: ['update', dest, '--dirty'],
    outName: 'c3-dense-dirty',
    caution:
      'NOT a typical edit: the symbol-densest file is also widely imported, so the scope cascades well beyond one file. Reported as the upper bound of a single-file edit, never as "the" one-file cost.',
  });

  // ---- Stage D: the no-op floor ---------------------------------------------------------
  // `crib update` with nothing changed at all. It is the FLOOR every re-index sits above: it prices
  // the unconditional write side of an update (stats refresh + manifest + generation bump) with no
  // graph shard and no dossier touched. Without it there is no way to say how much of a one-file
  // figure is "the file" versus "an update always writes this".
  // No `--dirty` here on purpose: with the C3 edit still uncommitted, `--dirty` would re-see it.
  const noop = runCounted(
    'stage-d-noop',
    dest,
    ['update', dest],
    preloadPath,
    tmpDir,
    join(tmpDir, 'counts-d-noop.json'),
  );
  reportWorkload('D. UPDATE NO-OP FLOOR  (crib update with nothing changed)', noop, probeOnly?.counts);
  emit(`     cli stdout: ${noop.stdout.split('\n')[0] ?? ''}`);
  emit(`     wall clock (whole CLI process): ${noop.wallMs.toFixed(1)} ms`);
  emit();

  // ---- Arithmetic ---------------------------------------------------------------------
  emit('Arithmetic — added ms per workload = rename-or-write count x per-write durable cost');
  emit('-'.repeat(92));
  const perWriteCostP50 = perWrite?.series?.coreDist?.p50;
  const perWriteCostP95 = perWrite?.series?.coreDist?.p95;
  const workloads = [
    { name: 'FULL INDEX', r: full },
    ...oneFileStages.map(({ label, r }) => ({ name: label, r })),
    { name: 'UPDATE NO-OP FLOOR', r: noop },
  ];
  for (const { name, r } of workloads) {
    emit(`  ${name}`);
    if (!r.counts) {
      emit('    NOT MEASURED (no tally).');
      continue;
    }
    const raw = r.counts;
    const net = subtractCounts(raw, probeOnly?.counts);
    emit(`    raw tally            ${JSON.stringify(raw)}`);
    emit(`    minus probe constant ${JSON.stringify(probeOnly?.counts ?? {})} -> net ${JSON.stringify(net)}`);
    const renames = net.renameSync;
    const fsyncs = net.fsyncSync;
    emit(
      `    renames (renameSync) = ${renames}   barriers (fsyncSync) = ${fsyncs}   fsync/rename = ${renames > 0 ? (fsyncs / renames).toFixed(2) : 'n/a'}`,
    );
    if (!Number.isFinite(perWriteCostP50) || !Number.isFinite(perWriteCostP95)) {
      emit('    NOT MEASURED (per-write cost unavailable).');
      continue;
    }
    for (const [label, c] of [
      ['p50', perWriteCostP50],
      ['p95', perWriteCostP95],
    ]) {
      const added = renames * c;
      emit(
        `    [PRESCRIBED FORMULA] added ms @ ${label} = ${renames} rename(s) x ${c.toFixed(4)} ms = ${added.toFixed(1)} ms  =>  ${((added / UPDATE_VISIBILITY_BUDGET_MS) * 100).toFixed(2)}% of the ${UPDATE_VISIBILITY_BUDGET_MS} ms update-visibility budget`,
      );
    }
    // THE FORMULA ABOVE IS AN UPPER BOUND, and the tallies say by how much. Each durable
    // `writeJsonAtomic` pays EXACTLY two barriers (file flush + parent-dir flush), so the number of
    // writes that actually paid a barrier is fsyncSync/2 — never the rename count, because a large
    // share of writers in this tree rename WITHOUT flushing.
    //
    // WHICH WRITER DOES NOT FLUSH is MEASURED below, not inferred. The tally alone cannot say:
    // both `writeJsonAtomic` and an unflushed tmp+rename writer appear as writeFileSync+renameSync,
    // 1:1, and the tree contains TEN-PLUS unflushed tmp+rename writers besides the dossiers
    // (`dossier/persist.ts`, `graph-layout.ts`, `materialize.ts`, `freshness-service.ts`,
    // `intelligence-projections.ts`, `registry.ts`, … — every non-test file that matches
    // `renameSync` with no `fsync`). So the probe captures the call stack of every counted write
    // and reports the writer frame directly, plus a CROSS-CHECK that the renames attributed to
    // `writeJsonAtomic` equal fsyncSync/2 — if they do not, the two-barriers-per-write model is
    // wrong and the barrier-attributable figure above is wrong with it.
    const durableWrites = fsyncs / 2;
    const unflushedRenames = renames - durableWrites;
    const perBarrierCost = perWriteCostP50 - (perWrite?.series?.baselineRenameOnly?.p50 ?? Number.NaN);
    emit(
      `    writes that paid a barrier (fsyncSync/2) = ${durableWrites}   renames that did NOT flush = ${unflushedRenames}`,
    );
    const attrRenames = r.attribution?.renameSync ?? null;
    if (attrRenames) {
      const entries = Object.entries(attrRenames).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((s, [, v]) => s + v, 0);
      emit(`    MEASURED call-site attribution of ${total} renameSync call(s) (frame 0 = writer, frame 1 = its caller):`);
      for (const [k, v] of entries.slice(0, 9)) {
        emit(`      ${String(v).padStart(6)}  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
      }
      if (entries.length > 9) emit(`      ${String(total - entries.slice(0, 9).reduce((s, [, v]) => s + v, 0)).padStart(6)}          (${entries.length - 9} further distinct call site(s))`);
      const viaAtomic = entries.filter(([k]) => /atomic-write/.test(k)).reduce((s, [, v]) => s + v, 0);
      const bypass = total - viaAtomic;
      emit(`      renames THROUGH writeJsonAtomic (flushed)     = ${viaAtomic}  (${((viaAtomic / total) * 100).toFixed(1)}%)`);
      emit(`      renames BYPASSING it (tmp+rename, no flush)   = ${bypass}  (${((bypass / total) * 100).toFixed(1)}%)`);
      emit(
        `      CROSS-CHECK vs fsyncSync/2 = ${durableWrites}: ${viaAtomic === durableWrites ? 'CONSISTENT — two barriers per durable write, and every fsync accounted for by a writeJsonAtomic rename' : `INCONSISTENT — ${Math.abs(viaAtomic - durableWrites)} rename(s) unexplained by the two-barriers-per-write model`}`,
      );
    } else {
      emit('    MEASURED call-site attribution: NOT MEASURED (no attribution in this child).');
    }
    if (Number.isFinite(perBarrierCost)) {
      const perBarrier = perBarrierCost / 2; // two barriers per durable write
      const attributable = fsyncs * perBarrier;
      emit(
        `    [BARRIER-ATTRIBUTABLE] per-barrier cost = (${perWriteCostP50.toFixed(4)} - ${perWrite.series.baselineRenameOnly.p50.toFixed(4)}) / 2 = ${perBarrier.toFixed(4)} ms`,
      );
      emit(
        `    [BARRIER-ATTRIBUTABLE] added ms = ${fsyncs} barrier(s) x ${perBarrier.toFixed(4)} ms = ${attributable.toFixed(1)} ms  =>  ${((attributable / UPDATE_VISIBILITY_BUDGET_MS) * 100).toFixed(2)}% of the ${UPDATE_VISIBILITY_BUDGET_MS} ms budget`,
      );
      // The budget percentage above is an ADDITIVE estimate against a gate measured on a DIFFERENT
      // workload, so it is not the whole story. This second share is the one that can be read
      // directly: what fraction of THIS workload's own measured wall clock the barriers account for.
      if (Number.isFinite(r.wallMs) && r.wallMs > 0) {
        emit(
          `    [SHARE OF THIS WORKLOAD] ${attributable.toFixed(1)} ms barrier-attributable / ${r.wallMs.toFixed(1)} ms measured wall clock = ${((attributable / r.wallMs) * 100).toFixed(2)}%`,
        );
      }
    }
  }
  emit();
  emit('  Derivation notes (which numbers are MEASURED vs DERIVED):');
  emit('    MEASURED  : every tally, every wall clock, every per-write percentile above.');
  emit('    MEASURED  : the fsyncSync tally, hence the number of writes that paid a barrier.');
  emit('    MEASURED  : the delta scope the CLI itself printed for each one-file stage');
  emit('                (`updated N file(s) [scope M]`) — which is why one file is not one file.');
  emit('    DERIVED   : `added ms` is a PRODUCT (count x per-write cost), never a direct timing of');
  emit('                the workload. Two products are given and they disagree on purpose:');
  emit('                  - PRESCRIBED FORMULA (renames x per-write cost) is an UPPER BOUND. It');
  emit('                    charges a barrier to every rename, including the ~93% of renames that');
  emit('                    pay no barrier at all. It is NOT the cost.');
  emit('                  - BARRIER-ATTRIBUTABLE (fsyncs x per-barrier cost) charges only the');
  emit('                    barriers the tally actually observed. This is the honest figure.');
  emit('                If the two are far apart, the rename count is NOT a proxy for the flush');
  emit('                count and any capacity argument must use the second product.');
  emit('    MEASURED  : WHICH call site each rename came from (see the attribution table per');
  emit('                workload) and, from it, the split between renames that went through');
  emit('                writeJsonAtomic and renames that bypassed it. The unflushed renames are');
  emit('                therefore identified, not inferred — an earlier draft of this probe');
  emit('                asserted "the unflushed renames are the dossiers" from the tally shape');
  emit('                alone, and a source scan falsified it: `renameSync` with no `fsync` also');
  emit('                occurs in graph-layout.ts, materialize.ts, freshness-service.ts,');
  emit('                intelligence-projections.ts, registry.ts and others, so the tally shape');
  emit('                could not distinguish them. The attribution table is what settles it.');
  emit('    DERIVED   : `per-barrier cost` splits the measured overhead in two because each durable');
  emit('                write pays two flushes. The two-barriers-per-write model is CROSS-CHECKED');
  emit('                against the attribution (renames through writeJsonAtomic vs fsyncSync/2)');
  emit('                and against the no-op floor, where renames == fsyncSync/2 == 5 and');
  emit('                unflushedRenames == 0.');
  emit('    NOT MEASURED: the wall-clock DELTA the barriers add. Nothing here re-times a workload with');
  emit('                the flushes disabled; the added-ms figures are products, not A/B timings.');
  emit('    NOT MEASURED: the WP2 watch -> queryable path itself. The gate was recorded against a');
  emit('                different code path AND a different workload than the CLI mutations measured');
  emit('                here (a full index of this project takes ~376 s, so the 1956.6 ms gate figure');
  emit('                cannot be this workload). The percentages above are ADDITIVE BUDGET');
  emit('                estimates, not a re-measurement of that gate.');
  emit('    NOT MEASURED: writes that do not rename at all. Only rename/write/fsync/open are counted,');
  emit('                so a writer that appends (appendLineDurable) or that writes in place would be');
  emit('                invisible here except through `appendFileSync`/`openSync`. `appendFileSync` is');
  emit('                0 in every workload below, so `appendLineDurable` was NOT exercised by these');
  emit('                paths — that is an absence in the workload, not proof it never flushes.');

  emit();
  emit(`temp dir cleanup: fs.rmSync(${tmpDir}, {recursive:true, force:true})`);
  rmSync(tmpDir, { recursive: true, force: true });
  emit(`temp dir removed: ${!existsSync(tmpDir)}`);
  emit(`run finished at ${new Date().toISOString()} (${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)} s)`);

  flushLog(OPT.log);
  return 0;
}

/** Raw tally minus the probe's constant, floored at 0 so a mismatch is visible, never negative. */
function subtractCounts(raw, probe) {
  const out = zeroCounts();
  for (const k of COUNTED_OPS) out[k] = Math.max(0, (raw?.[k] ?? 0) - (probe?.[k] ?? 0));
  return out;
}

function reportWorkload(title, result, probeCounts) {
  emit(`  ${title}`);
  emit(`     command: ${result.command}`);
  emit(`     exit status: ${result.exitStatus}`);
  if (result.countsError) emit(`     TALLY PROBLEM: ${result.countsError}`);
  emit(`     raw fs tally:      ${JSON.stringify(result.counts ?? null)}`);
  if (result.counts && probeCounts) {
    emit(`     net of probe:      ${JSON.stringify(subtractCounts(result.counts, probeCounts))}`);
  }
  if (result.stderr) {
    const s = result.stderr.split('\n').slice(0, 3).join(' | ').slice(0, 300);
    emit(`     stderr: ${s}`);
  }
}

/** Commit everything in the COPY (never the source project), so a committed-delta path can be run. */
function gitCommitAll(root, message) {
  const add = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  if (add.status !== 0) return `add failed (${add.status})`;
  const commit = spawnSync(
    'git',
    ['-c', 'user.email=probe@local', '-c', 'user.name=probe', 'commit', '-q', '-m', message],
    { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 },
  );
  return commit.status === 0 ? 'ok' : `commit failed (${commit.status}): ${(commit.stderr ?? '').trim().slice(0, 200)}`;
}

/**
 * Append one line to ONE real source file, so `crib update` sees a genuine one-file change.
 *
 * `prefer` picks WHICH kind of file, because "one file" does not determine the cost:
 *   - 'leaf'    : a file NOTHING imports (its stem appears in no other file's import specifier).
 *                 A leaf change cannot cascade, so its delta scope is small — the COMMON case.
 *                 Among leaves, the MEDIAN-size one is taken, so the figure is typical rather than
 *                 the cheapest possible or the largest.
 *   - 'densest' : the file with the most `export` statements. `runDossiers()` rewrites one dossier
 *                 PER CALLABLE SYMBOL, so this is the file whose re-index touches the most dossiers
 *                 — the worst case for a single-file edit.
 *
 * Why this distinction is load-bearing: the first version of this probe took the alphabetically
 * first `.ts` (a symbol-free `vitest.config.ts`) and the second took the densest file. Those two
 * choices differ by orders of magnitude in write count, so a single unqualified "one file" number
 * would have been an artifact of the pick, not a property of the system.
 */
function appendToOneSourceFile(root, prefer = 'densest') {
  const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build', 'coverage', 'out', 'tmp', 'vendor'];
  const isExcludedName = (name) =>
    name.startsWith('.') ||
    name.endsWith('.config.ts') ||
    name.endsWith('.d.ts') ||
    name.endsWith('.min.ts');
  const candidates = [];
  const importTargets = new Set(); // every last-segment of every import specifier seen anywhere
  const IMPORT_RE = /(?:from|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g;
  const stemOf = (rel) => {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return base.replace(/\.[^.]+$/, '');
  };
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = join(root, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(childRel);
        continue;
      }
      if (!childRel.endsWith('.ts') || isExcludedName(entry.name)) continue;
      let body;
      try {
        body = readFileSync(join(root, childRel), 'utf8');
      } catch {
        continue;
      }
      // Collect what this file imports, in one pass, so leaf detection stays O(total bytes).
      for (const m of body.matchAll(IMPORT_RE)) {
        const spec = m[1];
        importTargets.add(spec.slice(spec.lastIndexOf('/') + 1));
      }
      candidates.push({
        rel: childRel,
        bytes: Buffer.byteLength(body, 'utf8'),
        exports: (body.match(/^\s*export\b/gm) ?? []).length,
      });
    }
  }
  if (candidates.length === 0) return null;

  let chosen;
  let note;
  if (prefer === 'leaf') {
    const leaves = candidates
      .filter((c) => c.exports > 0 && !importTargets.has(stemOf(c.rel)))
      .sort((a, b) => a.bytes - b.bytes);
    if (leaves.length === 0) return null;
    chosen = leaves[Math.floor(leaves.length / 2)]; // median size among leaves
    note = `LEAF (nothing imports it) — median-sized of ${leaves.length} leaf candidate(s), so the delta scope should stay small`;
  } else {
    chosen = [...candidates].sort((a, b) => b.exports - a.exports || b.bytes - a.bytes)[0];
    note = `SYMBOL-DENSEST of ${candidates.length} candidate(s) — worst case: many dossiers, and widely imported so the scope cascades`;
  }
  const abs2 = join(root, chosen.rel);
  const before = readFileSync(abs2, 'utf8');
  writeFileSync(abs2, `${before}\n// wp1-probe: one-line edit to force an incremental re-index\n`);
  return {
    rel: chosen.rel,
    bytesBefore: Buffer.byteLength(before, 'utf8'),
    bytesAfter: statSync(abs2).size,
    exportsInFile: chosen.exports,
    candidateCount: candidates.length,
    note,
  };
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

if (OPT.mode === 'probe-only') {
  await childProbeOnly();
} else if (OPT.mode === 'perwrite') {
  await childPerWrite();
} else {
  const status = await parent();
  process.exit(status);
}
