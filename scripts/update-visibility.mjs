#!/usr/bin/env node
/**
 * Update-visibility instrument — answers ONE question: after a single file is saved, how long
 * until the change is QUERYABLE?
 *
 * WHY THIS EXISTS
 * `docs/bench/perf-gates.md:33` carries the row "One-file watch update → queryable | < 5 s p95 |
 * **not measured** | **BLOCKED** (no E2E watch fixture wired)", and `perf-gates.md:80` repeats it.
 * `docs/program/developer-trust-plan.md:127` states the same acceptance target as "**update
 * visibility ≤2 s** on the specified workload". So the tree carried a plan acceptance criterion
 * with no reproducible command behind it, and two thresholds — 2 s (plan) and 5 s (perf-gates.md
 * and `packages/cli/src/watch.ts:71-73`). This script supplies the missing instrument and reports
 * against BOTH thresholds WITHOUT choosing between them (see THRESHOLDS below).
 *
 * WHAT IT ACTUALLY MEASURES
 * The real production path, not a reimplementation of it:
 *   real fs event (node:fs recursive watch)
 *     -> WatchMode's 300 ms debounce + isWatchable filter
 *       -> RefreshCoordinator.requestRefresh (serialized, coalescing)
 *         -> working-overlay refresh + candidate build
 *           -> publication of a ReaderBundle
 *             -> a BM25 query against that bundle's index returns the new symbol
 *
 * WHAT IT DOES *NOT* MEASURE — read before quoting any number
 *  1. NO PROCESS ISOLATION. The coordinator and the probe share one process. A cross-process
 *     fs.watch -> separate MCP client round trip is not measured here.
 *  2. THE PROBE READS THE LIVE IN-MEMORY INDEX, NOT THE COMMITTED ONE. `RefreshCoordinator`
 *     builds its reader index as `new SqliteIndexStore()` (refresh-coordinator.ts:536), so the
 *     serving process's view lives in memory. Only the first half of what follows is verified
 *     here: a fresh `crib query` process does NOT observe an uncommitted edit at all (checked
 *     directly — `Alpha` queryable before the edit, `hits: []` for the appended symbol after it,
 *     the derived index being rebuilt only by `crib index`/`crib update`). That the committed
 *     index stays untouched *while watch mode is running* is INFERRED from the in-memory
 *     construction above, not proven end to end. Either way, "queryable" in this script means
 *     "queryable by the serving process" — the only reader that can see a watch-mode update.
 *  3. BM25 ONLY (`semantic: false`). The visibility question is "is the new symbol in the index",
 *     so the deterministic exact-match path is the right probe — a vector channel would add noise
 *     to a measurement that is about presence, not ranking quality.
 *  4. macOS, single machine, one run. `perf-gates.md:43` asks for "background load noted"; none
 *     was induced and none was controlled for.
 *
 * THRESHOLDS — why this exits 0 by default
 * The plan and perf-gates.md disagree (2 s vs 5 s). Resolving that disagreement is a decision this
 * instrument is not entitled to make, so it prints the verdict against both and asserts against
 * neither unless told to: `--assert=plan`, `--assert=perf-gates`, or `--assert=both`.
 *
 * A BROKEN PROBE MUST NOT READ AS A SLOW SYSTEM. If an iteration never observes its own symbol the
 * result is recorded as a timeout, never as a latency; if EVERY iteration times out the script exits
 * 2 and says the instrument failed to observe a change that definitely happened, rather than
 * reporting a very slow — but fabricated — p95.
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Pinned so the fixture tree is byte-identical run to run (matches scripts/budget-check.mjs).
const PINNED_DATE = '2026-01-01T00:00:00.000Z';

const FIXTURE_FILES = 300;
/** perf-gates.md:43 — "p95 over >= 50 warm iterations after >= 5 warmup iterations". */
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = Number.parseInt(process.env.UV_ITERATIONS ?? '50', 10);
const POLL_INTERVAL_MS = 10;
/**
 * Generous: a timeout means the probe failed to see its own change, not that the update was slow.
 * Overridable because at scale the update path is fixed-cost dominated (WP1-D13) and can legitimately
 * exceed this on a large repo — where an actual number is more useful than a timeout.
 */
const TIMEOUT_MS = Number.parseInt(process.env.UV_TIMEOUT_MS ?? '60000', 10);

const PLAN_THRESHOLD_MS = 2000;
const PERF_GATES_THRESHOLD_MS = 5000;

const assertMode = (process.argv.find((a) => a.startsWith('--assert=')) ?? '--assert=none').slice(
  9,
);
/**
 * NEGATIVE CONTROL. A p95 that passes is only evidence if the probe could have failed. With
 * `--negative-control` the watcher is never started, so nothing schedules a refresh: if the symbol
 * STILL becomes queryable, the instrument is not measuring the watch path and every number it has
 * ever printed is worthless. Exits 0 when the control holds (the change is correctly NOT observed)
 * and 1 when it does not.
 */
const negativeControl = process.argv.includes('--negative-control');
/**
 * `--repo=<path>` runs against an EXISTING repo instead of the generated fixture — the only way to
 * measure the workload `perf-gates.md:33` actually names ("crib repo"), and the scale workloads
 * where the update path is already known to be fixed-cost dominated (WP1-D13: ~410-416 durable
 * writes per update whichever file changed). It APPENDS to a file in that tree, so it refuses to
 * run without `--yes-modify-copy`, and it never deletes the repo it was pointed at. Point it at a
 * throwaway COPY, never the tree you are working in.
 */
const repoArg = process.argv.find((a) => a.startsWith('--repo='))?.slice(7);
const modifyCopy = process.argv.includes('--yes-modify-copy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixtureSource(i) {
  const steps = Array.from(
    { length: 6 },
    (_, k) => `  step${k}(v: number): number { return v + ${k}; }`,
  ).join('\n');
  return [
    `// svc${i} — generated fixture`,
    `export class Svc${i} {`,
    steps,
    `  helper(): string { return 'svc${i}'; }`,
    '}',
    '',
    `export function runSvc${i}(v: number): number {`,
    `  return new Svc${i}().step0(v);`,
    '}',
    '',
  ].join('\n');
}

/** git in a fixture repo, every commit pinned for determinism. */
function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  }).trim();
}

function buildFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'knowledge-crib-update-visibility-'));
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'update-visibility-fixture', private: true }, null, 2)}\n`,
    'utf8',
  );
  for (let i = 0; i < FIXTURE_FILES; i++) {
    writeFileSync(join(repoRoot, 'src', `svc${i}.ts`), fixtureSource(i), 'utf8');
  }
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);
  return repoRoot;
}

/**
 * Pick a small, tracked source file to append probe functions to, for `--repo=`. Deterministic:
 * the first `.ts` file `git ls-files` reports, skipping generated/vendored trees.
 */
function pickEditTarget(root) {
  const files = git(root, ['ls-files'])
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !/(^|\/)(node_modules|dist|build)\//.test(f));
  const picked = files.find((f) => f.length < 120);
  if (!picked) {
    throw new Error(`--repo=${root}: no suitable tracked .ts file to append to`);
  }
  return join(root, picked);
}

/** Nearest-rank percentile on an ascending-sorted array. */ function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function fmt(ms) {
  return Number.isFinite(ms) ? ms.toFixed(1) : 'n/a';
}

async function main() {
  if (repoArg && !modifyCopy) {
    process.stderr.write(
      `update-visibility: --repo=${repoArg} APPENDS probe functions to a file in that tree.\nPoint it at a throwaway copy and pass --yes-modify-copy to confirm. Refusing.\n`,
    );
    return 2;
  }
  // Only a fixture we created ourselves is ever deleted (see the `finally` below).
  const owned = repoArg === undefined;
  const repoRoot = owned ? buildFixture() : resolve(repoArg);
  let watch;
  let coordinator;

  try {
    const importDist = (p) => import(pathToFileURL(resolve(p)).href);
    const core = await importDist('packages/core/dist/index.js');
    const pipeline = await importDist('packages/pipeline/dist/index.js');
    const { WatchMode } = await importDist('packages/cli/dist/watch.js');
    const { RefreshCoordinator } = await importDist('packages/cli/dist/refresh-coordinator.js');

    const { SoulStore, newManifest } = core;
    const { indexRepo } = pipeline;

    // Mirror scripts/budget-check.mjs gate 6b's construction exactly, so this instrument and the
    // existing update-RATIO gate build their world the same way.
    const soulFor = () => {
      const soul = new SoulStore(join(repoRoot, '.crib'), {
        manifest: newManifest({ now: PINNED_DATE }),
      });
      soul.load();
      return soul;
    };

    // Cold commit-side index first, exactly as `crib index` would, so the coordinator's overlay
    // work during the measured iterations is genuinely incremental (one dirty file, not 300).
    await indexRepo(soulFor(), repoRoot, { now: PINNED_DATE });

    const warnings = [];
    let liveBundle;
    coordinator = new RefreshCoordinator(soulFor(), repoRoot, {
      onPublish: (bundle) => {
        liveBundle = bundle;
      },
      onWarn: (m) => warnings.push(`coordinator: ${m}`),
    });

    // The first bundle is built BEFORE the watcher exists (WP4.1) — startup is itself a refresh
    // trigger, so any event landing mid-build coalesces rather than racing.
    await coordinator.initialize();

    watch = new WatchMode(coordinator, repoRoot, {
      debounceMs: 300,
      onWarn: (m) => warnings.push(`watch: ${m}`),
    });
    // The negative control deliberately does NOT start the watcher: nothing can then request a
    // refresh, so the change must stay unqueryable. Everything else is identical.
    if (!negativeControl) await watch.start();

    const target = owned ? join(repoRoot, 'src', 'svc0.ts') : pickEditTarget(repoRoot);

    /** Is `sym` queryable in the CURRENTLY PUBLISHED bundle? BM25, exact name match. */
    const visible = (sym) => {
      if (!liveBundle) return false;
      const hits = liveBundle.index.query({ text: sym, semantic: false, limit: 10 });
      return hits.some((h) => h.name === sym);
    };

    const iterate = async (i, timeoutMs = TIMEOUT_MS) => {
      const sym = `zzqvprobe${i}`;
      // t0 is the SAVE moment, so the write itself is inside the measured interval — that is what
      // "update -> queryable" means to the person who hit save.
      const t0 = performance.now();
      appendFileSync(target, `\nexport function ${sym}(): number { return ${i}; }\n`, 'utf8');

      let ms = null;
      while (performance.now() - t0 < timeoutMs) {
        if (visible(sym)) {
          ms = performance.now() - t0;
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      // Let the cycle settle so the next iteration starts from a quiet coordinator. Outside the
      // measured interval by construction.
      await coordinator.whenIdle();
      return { sym, ms };
    };

    if (negativeControl) {
      // CONTROL_WAIT_MS is ~14x the observed p95 from the measured run, so "not visible" is a real
      // absence rather than a probe that gave up too early.
      const CONTROL_WAIT_MS = 10_000;
      const r = await iterate(0, CONTROL_WAIT_MS);
      const held = r.ms === null;
      process.stdout.write(
        `${[
          'update-visibility — NEGATIVE CONTROL (watcher not started)',
          `waited           : ${CONTROL_WAIT_MS} ms (~14x the measured p95)`,
          `observed         : ${held ? 'NOT queryable — control HOLDS' : `queryable after ${fmt(r.ms)} ms — CONTROL BROKEN`}`,
          '',
          held
            ? 'The change stays invisible when nothing schedules a refresh, so the measured latencies\ncome from the watch path and not from some incidental background scan.'
            : 'The change became queryable with no watcher running. The instrument is NOT measuring the\nwatch path; discard every number it has printed.',
        ].join('\n')}\n`,
      );
      return held ? 0 : 1;
    }

    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      const w = await iterate(i);
      if (w.ms === null) warnings.push(`warmup ${i} never became visible (${w.sym})`);
    }

    const measured = [];
    let timeouts = 0;
    for (let i = 0; i < MEASURED_ITERATIONS; i++) {
      const r = await iterate(WARMUP_ITERATIONS + i);
      if (r.ms === null) {
        timeouts++;
        warnings.push(`measured iteration ${i} TIMED OUT — ${r.sym} never became queryable`);
      } else {
        measured.push(r.ms);
      }
    }

    const sorted = [...measured].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = sorted.length ? sorted[sorted.length - 1] : Number.NaN;

    const planVerdict =
      sorted.length === 0 ? 'NO DATA' : p95 <= PLAN_THRESHOLD_MS ? 'PASS' : 'FAIL';
    const pgVerdict =
      sorted.length === 0 ? 'NO DATA' : p95 <= PERF_GATES_THRESHOLD_MS ? 'PASS' : 'FAIL';

    const out = [
      'update-visibility — one-file watch update -> queryable',
      `workload source  : ${owned ? `generated fixture, ${FIXTURE_FILES} files` : `existing repo ${repoRoot}`}`,
      `edit target      : ${relative(repoRoot, target)}`,
      'workload         : node:fs recursive watch -> WatchMode debounce 300ms -> RefreshCoordinator -> publish',
      'probe            : published bundle .index.query({ text, semantic:false }) — BM25, exact name match',
      `iterations       : warmup ${WARMUP_ITERATIONS}, measured ${MEASURED_ITERATIONS}, poll ${POLL_INTERVAL_MS}ms`,
      `observed         : ${sorted.length} of ${MEASURED_ITERATIONS} (${timeouts} timed out)`,
      '',
      `p50              : ${fmt(p50)} ms`,
      `p95              : ${fmt(p95)} ms`,
      `max              : ${fmt(max)} ms`,
      '',
      `plan threshold   : ${PLAN_THRESHOLD_MS} ms  -> ${planVerdict}     (developer-trust-plan.md:127)`,
      `perf-gates bound : ${PERF_GATES_THRESHOLD_MS} ms  -> ${pgVerdict}     (perf-gates.md:33, watch.ts:71-73)`,
      '',
      'NOT MEASURED: process isolation (coordinator and probe share one process); cross-process',
      'fs.watch -> separate client round trip; background load. The probe reads the live in-memory',
      'reader index, not the committed .crib index — a separate `crib query` process cannot observe',
      'a watch-mode update at all (see the header of this file, point 2).',
    ];
    if (warnings.length) {
      out.push('', `warnings (${warnings.length}):`, ...warnings.map((w) => `  - ${w}`));
    }
    process.stdout.write(`${out.join('\n')}\n`);

    watch.stop();
    coordinator.close();

    // A probe that never saw ANY of its own changes is a broken instrument, not a slow system.
    if (sorted.length === 0) {
      process.stderr.write(
        '\nupdate-visibility: instrument failure — no iteration observed its own symbol.\n' +
          'This is NOT an update-visibility measurement. Exiting 2.\n',
      );
      return 2;
    }

    const gate =
      assertMode === 'plan'
        ? planVerdict
        : assertMode === 'perf-gates'
          ? pgVerdict
          : assertMode === 'both'
            ? planVerdict === 'PASS' && pgVerdict === 'PASS'
              ? 'PASS'
              : 'FAIL'
            : 'PASS';
    if (gate !== 'PASS') {
      process.stderr.write(`\nupdate-visibility: FAIL against ${assertMode}\n`);
      return 1;
    }
    return 0;
  } finally {
    try {
      watch?.stop();
    } catch {
      /* best effort */
    }
    try {
      coordinator?.close();
    } catch {
      /* best effort */
    }
    // Only ever removes a fixture we created, and only after re-checking it is under the system
    // temp root. A repo passed via `--repo=` is NEVER deleted — it may hold the only copy of it.
    // (Guarded rather than returned early: a `return` in `finally` would swallow main()'s exit code.)
    if (owned) {
      try {
        const tmpRoot = realpathSync(tmpdir());
        const real = realpathSync(repoRoot);
        if (real.startsWith(tmpRoot)) rmSync(real, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`update-visibility: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
