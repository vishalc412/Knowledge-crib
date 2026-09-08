/**
 * Leak check (WP10.4) — repeated incremental-update cycles with heap/RSS sampling between cycles.
 *
 * History: launch-eval.ts's G5/G6 "leak" gates are DATA-leak gates (claims crossing trust/store
 * boundaries), not memory leaks. NOTHING asserted `process.memoryUsage()` anywhere in the repo, so a
 * per-cycle heap leak in `updateRepo` (the loop `crib freshness auto` runs on every merge, forever)
 * would ship unnoticed. This check closes that gap.
 *
 * METHOD — the same git-pinned update fixture budget-check's dossier-latency gate uses (300 files,
 * one class + one fn per file, every commit pinned to a fixed date), driven in-process:
 *
 *   indexRepo → WARMUP_CYCLES warmup updates → LEAK_CYCLES measured updates,
 *     each cycle: body-edit one file → `git commit` (pinned) → updateRepo → sample
 *     process.memoryUsage().heapUsed + .rss.
 *
 * The warmup cycles absorb one-time allocation (first parse, resolver tables, dossier caches) so
 * the measured window sees steady-state. The classifier is the load-bearing, unit-tested part
 * (see {@link classifyLeakSeries}): fail only on UNBOUNDED growth — last−first must exceed
 * K × the first-cycle delta before the gate fires, and never on a series whose total growth is
 * negative. The goal is catching real per-cycle leaks, not GC noise, so K is generous (10) and a
 * noise floor keeps a near-zero first delta from turning every wobble into a breach.
 *
 * wired into budget:check (wherever budget:check runs); also runnable standalone:
 *   node scripts/leak-check.mjs            # 300-file fixture, 2 warmup + 10 measured cycles
 *   node scripts/leak-check.mjs --cycles 3 # a faster smoke
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Warmup cycles before sampling begins (absorbs one-time allocation; not measured). */
export const LEAK_WARMUP_CYCLES = 2;
/** Measured cycles. >= 10 per the WP10.4 register row ("leak checks after repeated refresh"). */
export const LEAK_CYCLES = 10;
/**
 * The growth multiplier: total growth must exceed this × the first-cycle delta before the gate
 * fires. Generous on purpose — a true leak grows ~const per cycle (so the first-cycle delta is
 * already its rate) and 10× headroom swallows scheduler/GC wobble.
 */
export const LEAK_MULTIPLE = 10;
/**
 * A first-cycle delta at or below this is treated as "no measurable per-cycle cost", and the
 * fail threshold becomes LEAK_MULTIPLE × this floor — catching sustained drift without firing on
 * sub-MB GC noise. 4 MB is well above per-cycle wobble and well below any real leak.
 */
export const LEAK_NOISE_FLOOR_BYTES = 4 * 1024 * 1024;

/**
 * Classify a growth series (one sample per cycle, after warmup). Pure — unit-tested over
 * synthetic series in leak-check.test.mjs. Returns a verdict, never throws:
 *
 *  - 'insufficient' — fewer than 3 samples (first delta + trend need 3 points minimum);
 *  - 'fail'         — last−first > LEAK_MULTIPLE × max(first-cycle delta, noise floor);
 *  - 'pass'         — anything else, including any series whose total growth is <= 0.
 */
export function classifyLeakSeries(samples, opts = {}) {
  const { leakMultiple = LEAK_MULTIPLE, noiseFloorBytes = LEAK_NOISE_FLOOR_BYTES } = opts;
  if (!Array.isArray(samples) || samples.length < 3) {
    return { verdict: 'insufficient', growthBytes: 0, firstDeltaBytes: 0, thresholdBytes: 0 };
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const firstDelta = samples[1] - samples[0];
  const growth = last - first;
  if (growth <= 0) {
    return { verdict: 'pass', growthBytes: growth, firstDeltaBytes: firstDelta, thresholdBytes: 0 };
  }
  const threshold = leakMultiple * Math.max(firstDelta, noiseFloorBytes);
  return {
    verdict: growth > threshold ? 'fail' : 'pass',
    growthBytes: growth,
    firstDeltaBytes: firstDelta,
    thresholdBytes: threshold,
  };
}

/** The update-fixture source (identical shape to budget-check's `fixtureSource`). */
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

const PINNED_DATE = '2026-01-01T00:00:00.000Z';
const FIXTURE_FILES = 300;

/** git in a fixture repo, every commit pinned to PINNED_DATE (deterministic anchors). */
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  }).trim();
}

/** The update fixture: a git repo of FIXTURE_FILES deterministic service files. */
function buildUpdateFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'crib-leak-check-'));
  writeFileSync(
    join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'crib-leak-fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  for (let i = 0; i < FIXTURE_FILES; i++) {
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
  return repoRoot;
}

/**
 * Run the leak check in-process: build the fixture, index it, then warmup + measured cycles of
 * (edit → commit → updateRepo) with heap/RSS sampled after each measured cycle. Returns the
 * classifier verdicts for BOTH series; the caller decides exit (heap AND rss classify the same
 * way under the generous bound — a breach in either is a real leak, not noise).
 */
export async function runLeakCheck(opts = {}) {
  const {
    warmupCycles = LEAK_WARMUP_CYCLES,
    cycles = LEAK_CYCLES,
    fixtureFiles = FIXTURE_FILES,
  } = opts;
  if (cycles < 3) throw new Error(`cycles must be >= 3 to classify, got ${cycles}`);
  // dynamic import() needs a file:// URL on win32 (same reason as every budget-check dist import).
  const coreModule = pathToFileURL(resolve('packages/core/dist/index.js')).href;
  const pipelineModule = pathToFileURL(resolve('packages/pipeline/dist/index.js')).href;
  const { SoulStore, newManifest } = await import(coreModule);
  const { indexRepo, updateRepo } = await import(pipelineModule);

  const repoRoot = buildUpdateFixture();
  try {
    const soulFor = () => {
      const soul = new SoulStore(join(repoRoot, '.crib'), {
        manifest: newManifest({ now: PINNED_DATE }),
      });
      soul.load();
      return soul;
    };
    await indexRepo(soulFor(), repoRoot, { now: PINNED_DATE });

    // One cycle = a body-only edit of one file (content changes every cycle so no update can
    // no-op), a pinned commit (the VCS anchor updateRepo diffs against), an incremental update,
    // then (for measured cycles) a heap/RSS sample.
    let cycle = 0;
    const runCycle = () => {
      const file = `svc${cycle % fixtureFiles}.ts`;
      writeFileSync(
        join(repoRoot, 'src', file),
        fixtureSource(cycle % fixtureFiles, ` cycle${cycle}`),
      );
      git(repoRoot, ['add', `src/${file}`]);
      git(repoRoot, [
        '-c',
        'user.email=gate@crib.dev',
        '-c',
        'user.name=Crib Gate',
        'commit',
        '-q',
        '-m',
        `cycle ${cycle}`,
      ]);
      const t0 = Date.now();
      const soul = soulFor();
      return updateRepo(soul, repoRoot, {
        now: new Date(Date.parse(PINNED_DATE) + (cycle + 1) * 60_000).toISOString(),
      }).then((r) => {
        cycle++;
        return { updateMs: Date.now() - t0, updated: r };
      });
    };

    for (let i = 0; i < warmupCycles; i++) await runCycle();

    const heapSamples = [];
    const rssSamples = [];
    const updateMs = [];
    for (let i = 0; i < cycles; i++) {
      const r = await runCycle();
      updateMs.push(r.updateMs);
      // Expose GC when the runner has it (--expose-gc) so retained-heap noise is minimized;
      // unavailable GC is fine — the classifier's bound is generous enough to absorb it.
      global.gc?.();
      const mu = process.memoryUsage();
      heapSamples.push(mu.heapUsed);
      rssSamples.push(mu.rss);
    }
    const heap = classifyLeakSeries(heapSamples);
    const rss = classifyLeakSeries(rssSamples);
    return {
      warmupCycles,
      cycles,
      heapSamples,
      rssSamples,
      updateMs,
      heap,
      rss,
      failed: heap.verdict === 'fail' || rss.verdict === 'fail',
    };
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** MB, for reporting. */
function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function formatClassification(name, c) {
  if (c.verdict === 'insufficient') return `${name}: insufficient samples`;
  const growth = `growth ${(c.growthBytes / 1024 / 1024).toFixed(1)} MB`;
  if (c.verdict === 'pass' && c.growthBytes <= 0) return `${name}: PASS (${growth} — no growth)`;
  return (
    `${name}: ${c.verdict === 'fail' ? 'FAIL' : 'PASS'} (${growth}, first-cycle delta ` +
    `${(c.firstDeltaBytes / 1024 / 1024).toFixed(1)} MB, fail threshold ${(c.thresholdBytes / 1024 / 1024).toFixed(0)} MB)`
  );
}

// --- standalone ---------------------------------------------------------------------------------

async function main() {
  const cyclesIdx = process.argv.indexOf('--cycles');
  const cycles =
    cyclesIdx >= 0 && Number.isInteger(Number(process.argv[cyclesIdx + 1]))
      ? Number(process.argv[cyclesIdx + 1])
      : LEAK_CYCLES;
  const r = await runLeakCheck({ cycles });
  process.stdout.write(
    `leak check — ${r.cycles} update cycles after ${r.warmupCycles} warmup ` +
      `(heap ${mb(r.heapSamples[0])}→${mb(r.heapSamples[r.heapSamples.length - 1])} MB, ` +
      `rss ${mb(r.rssSamples[0])}→${mb(r.rssSamples[r.rssSamples.length - 1])} MB)\n`,
  );
  process.stdout.write(`${formatClassification('heap', r.heap)}\n`);
  process.stdout.write(`${formatClassification('rss ', r.rss)}\n`);
  if (r.failed) {
    process.stderr.write('leak check FAILED — unbounded growth over repeated updates\n');
    process.exit(1);
  }
  process.stdout.write('leak check ok\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
