/**
 * M3.5 parser fuzzing — the runFuzz HARNESS.
 *
 * Spawns a K-slot `worker_threads` pool (fuzz-worker.js, built alongside this file), generates
 * seeded fast-check inputs on the MAIN thread, and dispatches one input per worker message. Each
 * extract call runs under a per-call BUDGET timeout; if a worker doesn't respond in budget (a sync
 * parse hang — the PL/SQL `recover()` infinite-loop class), the main thread TERMINATES that worker,
 * records the exact triggering input as a reproducer, respawns a fresh worker for that slot, and
 * continues. This is the only way to catch a per-input sync hang: a Promise.race timeout can't fire
 * while the event loop is blocked, so the hang lives in a separate OS thread the main thread can kill.
 *
 * DETERMINISM — inputs are `fc.sample` from a SEEDED arbitrary (`opts.seed`, default 1), so a run is
 * reproducible input-for-input. Reproducers carry the exact `(extractorName, text)` so a real bug can
 * be re-fed to the extractor directly. The harness never touches the soul or the filesystem.
 *
 * OUTCOMES per input:
 *   ok      — extract returned + validateFuzzResult passed (well-formed node/edge set)
 *   throw   — extract threw (contract violation; must degrade to a file node, not throw)
 *   invalid — extract returned a malformed node/edge (failed structural validation)
 *   hang    — no worker response within budget (terminated + respawned)
 *
 * The gate (fuzz-check.mjs) asserts: production extractors produce 0 throw / 0 hang / 0 invalid
 * across N iterations; the 3 test-only fakes each produce their named failure class (self-test).
 */
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FuzzOutcomeKind } from './fuzz-validate.js';

/**
 * LAZY fast-check load — fast-check is a DEV/CI dependency (fuzz gate + tests), NOT a runtime
 * dependency of @knowledge-crib/parsers. This module is re-exported from the package entry, so a
 * top-level `import 'fast-check'` would force every consumer (incl. the `crib` CLI's `--help`) to
 * pull fast-check at load time — and the published package doesn't ship it (ERR_MODULE_NOT_FOUND in
 * installer:smoke). Dynamic-import it only when runFuzz actually runs (the fuzz gate / tests, where
 * fast-check's devDependency is present). The runtime path never touches it.
 */
type FastCheck = typeof import('fast-check');
async function loadFc(): Promise<FastCheck> {
  return (await import('fast-check')) as FastCheck;
}

/** Resolve the compiled worker script URL (dist/fuzz-worker.js alongside dist/extractor-fuzz.js). */
function workerUrl(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fuzz-worker.js');
}

export interface FuzzReproducer {
  extractor: string;
  outcome: Exclude<FuzzOutcomeKind, 'ok'>;
  idx: number;
  text: string;
  reason?: string;
}

export interface FuzzOutcome {
  extractor: string;
  iterations: number;
  ok: number;
  throw: number;
  invalid: number;
  hang: number;
  reproducers: FuzzReproducer[];
}

export interface RunFuzzOpts {
  /** fast-check run count (inputs per extractor). Default 1000. */
  iterations?: number;
  /** per-extract wall-clock budget before the worker is terminated as hung. Default 500ms. */
  budgetMs?: number;
  /** worker pool size. Default min(4, cpus-1). */
  concurrency?: number;
  /** fast-check seed (deterministic). Default 1. */
  seed?: number;
  /** max generated input length in characters. Default 4096. */
  maxLength?: number;
  /** progress callback (inputs resolved so far, total). */
  onProgress?: (done: number, total: number) => void;
}

type WorkerOutMsg =
  | { kind: 'ready' }
  | { kind: 'result'; idx: number; outcome: 'ok' | 'throw' | 'invalid'; reason?: string }
  | { kind: 'error'; message: string };

interface SlotResult {
  idx: number;
  outcome: FuzzOutcomeKind;
  reason?: string;
}

/** Spawn a worker + init it for `extractorName`. Resolves on `ready`. */
function spawnInit(url: string, extractorName: string): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const w = new Worker(url);
    const onReady = (msg: WorkerOutMsg) => {
      if (msg.kind === 'ready') {
        w.off('message', onReady);
        resolve(w);
      } else if (msg.kind === 'error') {
        w.off('message', onReady);
        reject(new Error(`worker init failed for ${extractorName}: ${msg.message}`));
      }
    };
    w.on('message', onReady);
    w.on('error', reject);
    w.postMessage({ kind: 'init', extractorName });
  });
}

/** Run one extract on `w` under a wall-clock budget. Rejects with `'hang'` on timeout. */
function raceBudget(w: Worker, idx: number, text: string, budgetMs: number): Promise<SlotResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      w.off('message', onMsg);
      reject(new Error('hang'));
    }, budgetMs);
    const onMsg = (msg: WorkerOutMsg) => {
      if (msg.kind === 'result' && msg.idx === idx) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.off('message', onMsg);
        resolve({ idx, outcome: msg.outcome, reason: msg.reason });
      }
    };
    w.on('message', onMsg);
    w.postMessage({ kind: 'extract', idx, text });
  });
}

/** Default pool size: small — fuzz workers are CPU-heavy (sync parse). Leave headroom for main. */
export function defaultFuzzConcurrency(): number {
  return Math.min(4, Math.max(1, availableParallelism() - 1));
}

/**
 * Fuzz one extractor: generate `iterations` seeded inputs, dispatch across a K-slot worker pool with
 * a per-call budget, terminate-on-hang + respawn, and tally outcomes. Reproducers record every
 * non-ok input with its exact text. Throws if the worker script isn't built (call after build).
 */
export async function runFuzz(extractorName: string, opts: RunFuzzOpts = {}): Promise<FuzzOutcome> {
  const iterations = opts.iterations ?? 1000;
  const budgetMs = opts.budgetMs ?? 500;
  const concurrency = opts.concurrency ?? defaultFuzzConcurrency();
  const seed = opts.seed ?? 1;
  const maxLength = opts.maxLength ?? 4096;
  const onProgress = opts.onProgress;

  const url = workerUrl();
  if (!existsSync(url)) {
    throw new Error(`fuzz worker not built: ${url} (run the build before fuzz)`);
  }

  // Seeded, deterministic inputs. Arbitrary unicode strings up to maxLength — exercises truncation,
  // odd tokens, control chars, partial/invalid syntax across every extractor's surface. fast-check
  // is dynamically imported here (dev/CI only) so the published runtime never loads it.
  const fc = await loadFc();
  const inputs: string[] = fc.sample(fc.string({ maxLength }), { numRuns: iterations, seed });

  const outcome: FuzzOutcome = {
    extractor: extractorName,
    iterations,
    ok: 0,
    throw: 0,
    invalid: 0,
    hang: 0,
    reproducers: [],
  };

  let cursor = 0;
  let done = 0;
  const nextIdx = (): number => (cursor < iterations ? cursor++ : -1);

  const slotLoop = async (): Promise<void> => {
    let w = await spawnInit(url, extractorName);
    for (let idx = nextIdx(); idx >= 0; idx = nextIdx()) {
      const text = inputs[idx]!;
      let res: SlotResult;
      try {
        res = await raceBudget(w, idx, text, budgetMs);
      } catch {
        // Hang — terminate the stuck worker, record the reproducer, respawn a fresh one for the slot.
        await w.terminate().catch(() => {});
        outcome.hang++;
        outcome.reproducers.push({ extractor: extractorName, outcome: 'hang', idx, text });
        done++;
        onProgress?.(done, iterations);
        w = await spawnInit(url, extractorName);
        continue;
      }
      if (res.outcome === 'ok') outcome.ok++;
      else if (res.outcome === 'throw') {
        outcome.throw++;
        outcome.reproducers.push({
          extractor: extractorName,
          outcome: 'throw',
          idx,
          text,
          reason: res.reason,
        });
      } else if (res.outcome === 'invalid') {
        outcome.invalid++;
        outcome.reproducers.push({
          extractor: extractorName,
          outcome: 'invalid',
          idx,
          text,
          reason: res.reason,
        });
      }
      done++;
      onProgress?.(done, iterations);
    }
    w.postMessage({ kind: 'shutdown' });
    await w.terminate().catch(() => {});
  };

  const slots = Array.from({ length: Math.min(concurrency, iterations) }, () => slotLoop());
  await Promise.all(slots);
  return outcome;
}

/**
 * Run the 3 test-only fakes (hang / throw / invalid) with a tiny budget + iteration count. Used by
 * the gate's self-test preamble to PROVE the detector catches each failure class before the real
 * fuzz runs. Returns the three outcomes keyed by fake name.
 */
export async function runFakeselfTest(
  budgetMs = 200,
  iterations = 4,
): Promise<{
  hang: FuzzOutcome;
  throw: FuzzOutcome;
  invalid: FuzzOutcome;
}> {
  const [hang, thr, inv] = await Promise.all([
    runFuzz('__fuzz_fake_hang', { iterations, budgetMs, concurrency: 1, maxLength: 16 }),
    runFuzz('__fuzz_fake_throw', { iterations, budgetMs, concurrency: 1, maxLength: 16 }),
    runFuzz('__fuzz_fake_invalid', { iterations, budgetMs, concurrency: 1, maxLength: 16 }),
  ]);
  return { hang, throw: thr, invalid: inv };
}
