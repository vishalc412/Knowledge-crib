/**
 * P0 bench runner — composes the five scenario families into one JSON-able report. The runner owns
 * the ONLY filesystem concern (a throwaway `KCRIB_MEMORY_DIR` for the three stores, cleaned up in a
 * finally) so the scenarios themselves stay store-agnostic and testable at any scale.
 *
 * The report is the contract with every later phase: `crib memory bench --json` lands in
 * `docs/bench/memory-baseline.json` and each phase PR must show its metric diff (recall@5,
 * staleness-precision, dedupe, p95 latency) — the plan's "you cannot win a benchmark you don't run".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../store.js';
import {
  type CrossWriterResult,
  type LatencyResult,
  type RecallRelevanceResult,
  type RefactorSurvivalResult,
  type TrustGradientResult,
  runCrossWriter,
  runLatency,
  runRecallRelevance,
  runRefactorSurvival,
  runTrustGradient,
} from './scenarios.js';

// ─── scale knobs ─────────────────────────────────────────────────────────────

/** The scenario sizes. Tests use BENCH_FAST_SCALE; the CLI default publishes the 10k curve. */
export interface BenchScale {
  /** (a) records + query pairs at top of the relevance corpus. */
  topics: number;
  /** (b) records PER transition case (4 × perCase total). */
  survivalPerCase: number;
  /** (c) duplicate writers on the shared claim. */
  writers: number;
  /** (c) distinct single upserts for the write-throughput probe. */
  throughputWrites: number;
  /** (e) record count for the latency curve. */
  records: number;
  candidates: number;
  decisions: number;
  feedback: number;
  /** (e) timing trials per phase (p50/p95 over these). */
  trials: number;
}

/** Full-scale defaults for the published report (10k records × 1k candidates — the J1 curve). */
export const BENCH_SCALE_DEFAULT: BenchScale = {
  topics: 60,
  survivalPerCase: 3,
  writers: 5,
  throughputWrites: 200,
  records: 10_000,
  candidates: 1_000,
  decisions: 1_000,
  feedback: 500,
  trials: 5,
};

/** CI/test scale — every correctness invariant, none of the big-store wall time. */
export const BENCH_SCALE_FAST: BenchScale = {
  topics: 24,
  survivalPerCase: 2,
  writers: 4,
  throughputWrites: 50,
  records: 400,
  candidates: 80,
  decisions: 100,
  feedback: 40,
  trials: 3,
};

// ─── the report ──────────────────────────────────────────────────────────────

export interface MemoryBenchReport {
  version: 1;
  scale: BenchScale;
  /** stamped by the CLI (wall clock). The pure runner omits it so the report is ifHash-stable. */
  generatedAt?: string;
  scenarios: {
    recallRelevance: RecallRelevanceResult;
    refactorSurvival: RefactorSurvivalResult;
    crossWriter: CrossWriterResult;
    trustGradient: TrustGradientResult;
    latency: LatencyResult;
  };
}

/**
 * Run all five families. Each family gets a FRESH set of stores under its own temp dir so scenario
 * writes never bleed into one another's measurements (e.g. the throughput probe must not count the
 * trust-gradient's records).
 */
export function runMemoryBench(
  scale: BenchScale,
  opts: { now?: () => string } = {},
): MemoryBenchReport {
  return {
    version: 1,
    scale,
    ...(opts.now ? { generatedAt: opts.now() } : {}),
    scenarios: {
      recallRelevance: withStores((stores) => runRecallRelevance(stores, { topics: scale.topics })),
      refactorSurvival: runRefactorSurvival({ perCase: scale.survivalPerCase }),
      crossWriter: withStores((stores) =>
        runCrossWriter(stores, {
          writers: scale.writers,
          throughputWrites: scale.throughputWrites,
        }),
      ),
      trustGradient: withStores((stores) => runTrustGradient(stores)),
      latency: withStores((stores) =>
        runLatency(stores, {
          records: scale.records,
          candidates: scale.candidates,
          decisions: scale.decisions,
          feedback: scale.feedback,
          trials: scale.trials,
        }),
      ),
    },
  };
}

/**
 * Create a full three-store fixture rooted at a fresh temp dir (`KCRIB_MEMORY_DIR` relocates the
 * local + global trees; the team store lives under the same root as `<dir>/team-crib/memory/team`),
 * run `fn`, then always remove the dir. `withMemoryStores` in the verb/CLI layer composes the same
 * shape, so the bench exercises the REAL store locking + sharding, not in-memory fakes.
 */
export function makeStores(dir: string): {
  team: MemoryStore;
  local: MemoryStore;
  global: MemoryStore;
} {
  const env: NodeJS.ProcessEnv = { KCRIB_MEMORY_DIR: dir };
  return {
    team: MemoryStore.team(join(dir, 'team-crib'), { env, repoRoot: dir }),
    local: MemoryStore.local('bench-repo', { env, repoRoot: dir }),
    global: MemoryStore.global({ env }),
  };
}

// ─── the with-stores fixture (the only filesystem concern in the bench) ──────

/**
 * Create a full three-store fixture rooted at a fresh temp dir (`KCRIB_MEMORY_DIR` relocates the
 * local + global trees; the team store lives under the same root as `<dir>/team-crib/memory/team`),
 * run `fn`, then always remove the dir. The bench exercises the REAL store locking + sharding +
 * schema validation, not in-memory fakes.
 */
function withStores<T>(
  fn: (stores: { team: MemoryStore; local: MemoryStore; global: MemoryStore }) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), 'crib-mem-bench-'));
  try {
    return fn(makeStores(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── text rendering (CLI) ────────────────────────────────────────────────────

const ms = (n: number): string => `${n.toFixed(1)}ms`;

/** Human-readable report (what `crib memory bench` prints without --json). */
export function formatBenchReport(r: MemoryBenchReport): string {
  const lines: string[] = [];
  const a = r.scenarios.recallRelevance;
  const b = r.scenarios.refactorSurvival;
  const c = r.scenarios.crossWriter;
  const d = r.scenarios.trustGradient;
  const e = r.scenarios.latency;
  lines.push('memory bench — knowledge-crib vs mem0 baseline (P0)');
  lines.push('');
  lines.push('(a) recall relevance (recall@5 / precision@5 / MRR)');
  lines.push(
    `    exact      ${pct(a.exact.recallAt5)} / ${pct(a.exact.precisionAt5)} / mrr ${a.exact.mrr.toFixed(3)}`,
  );
  lines.push(
    `    paraphrase ${pct(a.paraphrase.recallAt5)} / ${pct(a.paraphrase.precisionAt5)} / mrr ${a.paraphrase.mrr.toFixed(3)}`,
  );
  lines.push('');
  lines.push(`(b) refactor survival — staleness-precision ${pct(b.stalenessPrecision)}`);
  for (const cs of b.cases) {
    lines.push(
      `    ${cs.name.padEnd(12)} ${cs.actualMatched}/${cs.records} matched (expected ${cs.expected.evidence}/${cs.expected.applicability}/${cs.expected.eligible ? 'eligible' : 'dropped'})`,
    );
  }
  lines.push('');
  lines.push(
    `(c) cross-writer — dedupe ${pct(c.dedupeRate)}, conflicts ${c.conflictsSurfaced}/${c.conflictsExpected}, ${c.writesPerSecond.toFixed(0)} writes/s`,
  );
  lines.push('');
  const violations = d.violations.length > 0 ? `: ${d.violations.join('; ')}` : '';
  lines.push(
    `(d) trust gradient — ${d.checks} checks, ${d.violations.length} violations${violations}`,
  );
  lines.push('');
  lines.push(
    `(e) latency @ ${e.records} records / ${e.candidates} candidates (${e.trials} trials)`,
  );
  lines.push(`    gather        p50 ${ms(e.gatherMs.p50)}  p95 ${ms(e.gatherMs.p95)}`);
  lines.push(`    fts rebuild   p50 ${ms(e.ftsRebuildMs.p50)}  p95 ${ms(e.ftsRebuildMs.p95)}`);
  lines.push(`    rank (cold)   p50 ${ms(e.rankColdMs.p50)}  p95 ${ms(e.rankColdMs.p95)}`);
  lines.push(`    fresh eval    p50 ${ms(e.freshEvalMs.p50)}  p95 ${ms(e.freshEvalMs.p95)}`);
  lines.push(`    TOTAL recall  p50 ${ms(e.totalMs.p50)}  p95 ${ms(e.totalMs.p95)}`);
  return lines.join('\n');
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
