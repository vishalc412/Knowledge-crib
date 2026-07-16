import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * M3.4 parallel-parse POOL. Spawns a fixed fleet of `worker_threads` isolates (parse-worker.ts),
 * dispatches file extraction across them, and persists the results to the soul in DISCOVERY ORDER.
 *
 * THE DETERMINISM TRICK — parallel extract, serial persist. Worker completion order is
 * non-deterministic (OS scheduling), but the soul's `nodes`/`edges` Maps preserve INSERTION order,
 * and the downstream phases (resolve/link/Louvain cluster) iterate those Maps. Louvain is
 * visitation-order-sensitive, so if workers wrote the soul directly the cluster ids could flip
 * between runs. Instead: each worker returns a plain `{nodes, edges}` payload; the main thread
 * collects them into a `results[idx]` array keyed by the file's DISCOVERY index, then — once every
 * worker is done — iterates `files` in order and calls `putNodes`/`putEdges`. The soul therefore
 * sees the exact same insertion sequence as the serial `for (const file of files)` loop. Every
 * committed chunk (id-sorted on disk) and every downstream phase is byte-identical to serial.
 *
 * Pool sizing: default `min(cpus - 1, 8)`, clamped to `[1, files.length]`. Workers are PERSISTENT
 * across the batch (boot once, handle many files) to amortize the per-isolate cost (Node worker
 * spawn +, for PHP files, `web-tree-sitter` `Parser.init` + `Language.load`). The pool is spun up
 * for one `runParse` call and torn down after — crib is a CLI, not a long-running server, so a
 * long-lived cross-index pool would hold memory for no benefit.
 *
 * Fallback: `KCRIB_PARALLEL=0` or a missing built `parse-worker.js` → the caller (`runParse`)
 * downgrades to the serial loop. Custom extractors (`opts.extractors`) also force serial — worker
 * isolates cannot receive class instances with closures, so the pool only ships the DEFAULT fleet.
 */
import { Worker } from 'node:worker_threads';
import type { SoulStore } from '@knowledge-crib/core';
import { grammarsNeededFor } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import type { ParseStats } from './parse.js';

/** A single file's extraction result, stashed by discovery index until serial persist. */
interface FileResult {
  nodes: import('@knowledge-crib/soul-schema').Node[];
  edges: import('@knowledge-crib/soul-schema').Edge[];
  /** true iff an extractor resolved for this file (mirrors serial `filesParsed` semantics). */
  parsed: boolean;
}

type WorkerOutMsg =
  | { kind: 'ready' }
  | {
      kind: 'result';
      idx: number;
      nodes: FileResult['nodes'];
      edges: FileResult['edges'];
      parsed: boolean;
    }
  | { kind: 'error'; idx: number; message: string };

/** Resolve the compiled worker script URL (dist/parse-worker.js alongside dist/parse-pool.js). */
function workerUrl(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'parse-worker.js');
}

/** Default pool size: leave one core for the main thread (persist + downstream), cap at 8. */
export function defaultPoolSize(fileCount: number): number {
  if (fileCount <= 1) return 1;
  const cpus = availableParallelism();
  return Math.min(8, Math.max(1, cpus - 1), fileCount);
}

/**
 * Run Phase 2 extraction across a worker pool, persisting to the soul in discovery order.
 * Throws if any worker extraction throws (preserving the serial failure surface). The caller is
 * responsible for the serial fallback when `parallelAvailable()` is false.
 */
export async function runParseParallel(
  soul: SoulStore,
  root: string,
  files: FileMeta[],
  size = defaultPoolSize(files.length),
): Promise<ParseStats> {
  if (files.length === 0) return { filesParsed: 0, nodes: 0, edges: 0 };
  const url = workerUrl();
  if (!existsSync(url)) {
    throw new Error(
      `parallel parse worker not built: ${url} (run the build before parallel index)`,
    );
  }

  const grammarNames = grammarsNeededFor(files);
  const workers: Worker[] = [];
  const results: FileResult[] = new Array(files.length);
  let filesParsed = 0;
  let nodes = 0;
  let edges = 0;

  // Spawn + init each worker (preload grammars). An init failure aborts the whole run — partial
  // parallel parse would silently drop files, which is worse than a clear throw.
  const readyPromises: Promise<void>[] = [];
  for (let i = 0; i < size; i++) {
    const w = new Worker(url);
    workers.push(w);
    readyPromises.push(
      new Promise<void>((resolve, reject) => {
        const onReady = (msg: WorkerOutMsg) => {
          if (msg.kind === 'ready') {
            w.off('message', onReady);
            resolve();
          } else if (msg.kind === 'error') {
            reject(new Error(`worker init failed: ${msg.message}`));
          }
        };
        w.on('message', onReady);
        w.on('error', reject);
      }),
    );
    w.postMessage({ kind: 'init', grammarNames });
  }
  await Promise.all(readyPromises);

  // Shared cursor queue: each worker pulls the next discovery index until exhausted. This balances
  // skew (a big PHP file doesn't stall the worker behind a batch of tiny .md files the way a static
  // round-robin split would). Results land at results[idx] regardless of completion order.
  let cursor = 0;
  const nextIdx = (): number => (cursor < files.length ? cursor++ : -1);

  const workerLoop = async (w: Worker): Promise<void> => {
    for (let idx = nextIdx(); idx >= 0; idx = nextIdx()) {
      const file = files[idx]!;
      const result = await new Promise<FileResult>((resolve, reject) => {
        const onMsg = (msg: WorkerOutMsg) => {
          if (msg.kind === 'result' && msg.idx === idx) {
            w.off('message', onMsg);
            resolve({ nodes: msg.nodes, edges: msg.edges, parsed: msg.parsed });
          } else if (msg.kind === 'error' && msg.idx === idx) {
            w.off('message', onMsg);
            reject(new Error(`extract failed for ${file.path}: ${msg.message}`));
          }
        };
        w.on('message', onMsg);
        w.postMessage({ kind: 'extract', idx, file, root });
      });
      results[idx] = result;
    }
  };

  try {
    await Promise.all(workers.map(workerLoop));
  } finally {
    // Tear down the pool regardless of success/failure. `shutdown` lets the worker exit cleanly;
    // `terminate` is the backstop if the message handler is mid-flight.
    for (const w of workers) {
      try {
        w.postMessage({ kind: 'shutdown' });
      } catch {
        /* worker may already be gone */
      }
    }
    await Promise.allSettled(workers.map((w) => w.terminate()));
  }

  // SERIAL PERSIST in discovery order — the determinism-critical step. The soul's Map insertion
  // order now exactly matches the serial `for (const file of files)` loop, so every downstream
  // phase (resolve/cfg/link/cluster) iterates the same sequence.
  for (let i = 0; i < files.length; i++) {
    const r = results[i];
    if (!r) continue; // worker dropped this index without a result (shouldn't happen — guard)
    if (r.nodes.length > 0) soul.putNodes(r.nodes);
    if (r.edges.length > 0) soul.putEdges(r.edges);
    if (r.parsed) filesParsed++; // mirrors serial: count files an extractor resolved for
    nodes += r.nodes.length;
    edges += r.edges.length;
  }

  return { filesParsed, nodes, edges };
}

/** Minimum file count before the parallel path is worth spawning workers. Below this, worker
 *  boot + per-isolate grammar preload (~tens of ms) dominates the parse work, so the serial loop is
 *  both faster AND simpler. Tuned so the tiny gate fixtures (1-5 files) stay serial. */
export const PARALLEL_MIN_FILES = 8;

/** Whether the parallel path is available: env not disabled, enough files to amortize boot, AND the
 *  built worker script exists. */
export function parallelAvailable(fileCount: number): boolean {
  if (process.env.KCRIB_PARALLEL === '0') return false;
  if (fileCount < PARALLEL_MIN_FILES) return false;
  return existsSync(workerUrl());
}
