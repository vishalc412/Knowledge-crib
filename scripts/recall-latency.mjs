/**
 * Warm recall p95 gate (WP10.4) — the memory-latency budget as a BUILD-BREAKING gate, not just a
 * published measurement.
 *
 * History: `crib memory bench` (cmdMemoryBench) measured the J1 latency curve but always returned
 * EXIT.OK — nothing failed on a breach, and nothing in release:verify ran it. The launch-verification
 * run (docs/bench/perf-gates.md, 2026-09-04) re-measured the PRODUCTION recall path directly
 * (`MemoryApi.search`, not the J1 in-memory-FTS shape) and took 2074 ms → 8.3 ms p95 @ 10k through
 * seven loop-invariant fixes — but that improvement was still only ever OBSERVED. This script turns
 * it into a gate wired into budget:check (wherever budget:check runs).
 *
 * METHOD (frozen before this gate existed — docs/bench/perf-gates.md §"Method honesty"):
 *  - the corpus is the SAME 10k-record bench corpus the J1 family builds (`runLatency`'s seeding:
 *    10k records / 1k candidates / 1k decisions / 500 feedback across the three real stores);
 *  - the measured call is `MemoryApi.search` — the production path, with the PERSISTENT FTS
 *    snapshot (`openMemoryFts`) + the versioned scorer at the launch default `lexical-only`
 *    (no embedder: an installed model is machine state, and this gate must be deterministic);
 *  - `fresh=false` — no evaluator is bound, so the pass measures the served (stamped-verdict)
 *    recall, the shape `memory_recall` answers from when no evaluator is configured;
 *  - p95 over >= 50 warm iterations after >= 5 warmup iterations;
 *  - page shape = the MCP verb's (limit 20 + 1 for `truncated`).
 *
 * LOADED-MACHINE HONESTY: on a breach the gate settles 1s and retries once over the SAME corpus —
 * it fails only if BOTH passes breach. Other agents/tests running on this machine can inflate a
 * single pass; two independent breaches 1s apart are a real regression, not contention.
 *
 * The @100k / 300ms variant is a separate NON-CI check: opt in with KC_BENCH_100K=1 (seeding 100k
 * records is a minutes-scale cost, and 300 ms at 100k was validated once at launch — see
 * docs/bench/perf-gates.md "FINAL — both scale gates PASS").
 *
 * Usage:
 *   node scripts/recall-latency.mjs                 # the 10k / 100ms gate (budget:check also runs this)
 *   KC_BENCH_100K=1 node scripts/recall-latency.mjs # additionally the 100k / 300ms gate
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The enforced warm-recall p95 budgets (docs/bench/perf-gates.md gate table). */
export const RECALL_P95_10K_MS = 100;
export const RECALL_P95_100K_MS = 300;
/** The frozen method's iteration counts — p95 over >= 50 warm iterations after >= 5 warmup. */
export const RECALL_WARMUP = 5;
export const RECALL_ITERATIONS = 50;
/** Opt-in env flag for the non-CI 100k variant. */
export const KC_BENCH_100K_ENV = 'KC_BENCH_100K';

/** The bench's own query (scenarios.ts LATENCY_QUERY) — kept here so the gate is self-contained. */
const RECALL_QUERY = 'deploy retries exponential backoff lockfile';
/** The MCP verb's page shape: limit 20, +1 so `truncated` survives without enriching the ledger. */
const RECALL_LIMIT = 21;

/**
 * Nearest-rank p95 over a timing sample — the SAME definition as the memory bench's
 * `percentile(samples, 0.95)` (bench/metrics.ts), reimplemented locally so the pure classifier
 * half of this file has zero dist dependencies and tests can import it cold.
 */
export function p95Of(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(0.95 * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

/** p50, same nearest-rank definition (reported alongside p95, never gating). */
export function p50Of(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(0.5 * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

/**
 * Gate verdict over one or more p95 runs. Retry-once semantics: PASS if ANY run held the threshold
 * (a loaded machine can inflate one pass; two breaches 1s apart are real). Pure — unit-tested over
 * synthetic runs.
 */
export function recallGateVerdict(p95Runs, thresholdMs) {
  const runs = (Array.isArray(p95Runs) ? p95Runs : []).filter((v) => Number.isFinite(v));
  if (runs.length === 0) {
    return { ok: false, worst: Number.NaN, best: Number.NaN, reason: 'no measurements' };
  }
  const worst = Math.max(...runs);
  const best = Math.min(...runs);
  return { ok: runs.some((v) => v <= thresholdMs), worst, best };
}

/**
 * Measure warm recall p95 over the J1 bench corpus at `records` scale, through the production
 * `MemoryApi.search` path (persistent FTS + versioned scorer, fresh=false, in-process — never a
 * CLI subprocess per call, which would measure Node startup instead of recall).
 *
 * When `thresholdMs` is given and the FIRST pass breaches it, sleeps `settleMs` and measures a
 * second pass over the same corpus; the caller fails only if both passes breach
 * (see {@link recallGateVerdict}).
 */
export async function measureRecallP95(opts = {}) {
  const {
    records = 10_000,
    warmup = RECALL_WARMUP,
    iterations = RECALL_ITERATIONS,
    thresholdMs,
    settleMs = 1000,
  } = opts;
  if (!Number.isInteger(records) || records <= 0) {
    throw new Error(`records must be a positive integer, got ${JSON.stringify(records)}`);
  }
  // dynamic import() needs a file:// URL on win32 (same reason as every budget-check dist import).
  const memoryModule = pathToFileURL(resolve('packages/memory/dist/index.js')).href;
  const { makeStores, runLatency, openMemoryFts, VersionedLexicalScorer, MemoryApi, gatherRecall } =
    await import(memoryModule);

  const dir = mkdtempSync(join(tmpdir(), 'crib-recall-gate-'));
  let fts;
  try {
    const stores = makeStores(dir);
    // Seed the SAME corpus the J1 family builds. trials: 0 skips the J1 phase timings entirely —
    // only the seeding runs (and its result is discarded: this gate measures MemoryApi.search).
    const scale = { records };
    runLatency(stores, {
      records: scale.records,
      candidates: Math.round(scale.records / 10),
      decisions: Math.round(scale.records / 10),
      feedback: Math.round(scale.records / 20),
      trials: 0,
    });

    // The production lexical channel (mcp/src/verbs.ts lexicalChannel, all-sources default): the
    // PERSISTENT FTS snapshot + the versioned scorer at the launch default, no embedder.
    const gathered = gatherRecall(stores);
    fts = openMemoryFts(stores);
    const scorer = new VersionedLexicalScorer({
      fts,
      records: gathered.records.map((g) => g.record),
      strategy: 'lexical-only',
    });
    const api = new MemoryApi({ stores, env: { KCRIB_MEMORY_DIR: dir } });
    const searchOnce = () =>
      api.search(RECALL_QUERY, { lexicalScorer: scorer, limit: RECALL_LIMIT });

    // Warmup (>= 5 per the frozen method). The first open of the persistent FTS rebuilds its
    // snapshot, and the first searches JIT — neither belongs in the measured window. The warmup
    // result also sanity-checks the corpus: a search returning zero hits measures nothing.
    let warm;
    for (let i = 0; i < warmup; i++) warm = searchOnce();
    if (!warm || (warm.hits ?? []).length === 0) {
      throw new Error('warm recall search returned no hits — the measurement would be invalid');
    }

    const runPass = () => {
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        searchOnce();
        samples.push(performance.now() - t0);
      }
      return { p50: p50Of(samples), p95: p95Of(samples), samples };
    };

    const passes = [runPass()];
    if (thresholdMs !== undefined && passes[0].p95 > thresholdMs) {
      // Loaded-machine retry: settle, then measure again over the SAME corpus. Failing only when
      // both passes breach keeps other agents' CPU contention from flaking the gate.
      await new Promise((r) => setTimeout(r, settleMs));
      passes.push(runPass());
    }
    return {
      records,
      warmup,
      iterations,
      query: RECALL_QUERY,
      passes,
      bestP95: Math.min(...passes.map((p) => p.p95)),
      worstP95: Math.max(...passes.map((p) => p.p95)),
    };
  } finally {
    try {
      fts?.close();
    } catch {
      /* the temp dir is removed regardless */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- standalone ---------------------------------------------------------------------------------

async function main() {
  const targets = [{ name: '10k', records: 10_000, thresholdMs: RECALL_P95_10K_MS }];
  if (process.env[KC_BENCH_100K_ENV] === '1') {
    targets.push({ name: '100k', records: 100_000, thresholdMs: RECALL_P95_100K_MS });
  }
  let failed = false;
  for (const t of targets) {
    const m = await measureRecallP95({ records: t.records, thresholdMs: t.thresholdMs });
    const v = recallGateVerdict(
      m.passes.map((p) => p.p95),
      t.thresholdMs,
    );
    const runs = m.passes.map((p) => `${p.p95.toFixed(1)}ms`).join(' / ');
    process.stdout.write(
      `recall p95 @${t.name} (${m.records} records, ${m.iterations} warm iterations after ${m.warmup} warmup): ` +
        `${runs} vs < ${t.thresholdMs}ms → ${v.ok ? 'PASS' : 'FAIL'}\n`,
    );
    if (!v.ok) failed = true;
  }
  if (failed) {
    process.stderr.write('recall-latency gate FAILED\n');
    process.exit(1);
  }
  process.stdout.write('recall-latency gate ok\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
