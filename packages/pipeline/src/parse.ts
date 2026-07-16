import type { SoulStore } from '@knowledge-crib/core';
/**
 * Phase 2 — parse. For each discovered file, resolve an extractor and run it, writing the resulting
 * symbol nodes + intra-file edges to the soul. A file with no extractor is left as just its Phase-1
 * file node. Extractors degrade to no symbols on parse failure (they never throw the pipeline).
 *
 * M3.4 — parallel path. When `parallel` is enabled (default, when the worker script is built and
 * `KCRIB_PARALLEL != '0'` and no custom extractors are in play), extraction runs across a
 * worker-thread pool (`runParseParallel`) and results are persisted in DISCOVERY ORDER so the soul's
 * in-memory Map insertion order — and therefore every order-sensitive downstream phase — is
 * byte-identical to the serial loop below. Otherwise the serial loop runs (custom extractors, tests
 * pinning the in-process path, or when the worker script isn't built).
 */
import { grammarsNeededFor, preloadGrammars } from '@knowledge-crib/parsers';
import type { ExtractorRegistry, FileMeta } from '@knowledge-crib/parsers';
import { makeExtractCtx } from './extract-ctx.js';
import { DEFAULT_CONCURRENCY, runParseConcurrent } from './parse-concurrent.js';
import { parallelAvailable, runParseParallel } from './parse-pool.js';

export interface ParseStats {
  filesParsed: number;
  nodes: number;
  edges: number;
}

/** Phase 2: run the registry over every file, persisting nodes + intra-file edges to the soul.
 *
 *  PARALLEL MODES (M3.4):
 *  - `concurrency` (default, when `parallel !== false`): bounded async pool — overlaps readFile I/O
 *    on the event loop, persists in discovery order. ~1.2-1.3× measured, deterministic, no workers.
 *  - `workers` (opt-in via `KCRIB_PARALLEL=workers`, default fleet only): worker-thread pool. Net-
 *    negative for crib's small-file workload (cold-JIT + clone cost — see ADR-001 + parse-pool.ts),
 *    retained for the future huge-file case. Ignored when `parallel === false`.
 *  - `serial` (`parallel === false`): the original in-order loop. Used by incremental `crib update`
 *    (1-3 changed files), determinism cross-checks, and custom-extractor runs (workers can't receive
 *    class instances).
 *
 *  `defaultRegistry` flags that the registry came from `defaultExtractors()` (no custom
 *  `opts.extractors`) — the worker pool only ships the default fleet. The concurrency + serial paths
 *  honor any registry. */
export async function runParse(
  soul: SoulStore,
  registry: ExtractorRegistry,
  root: string,
  files: FileMeta[],
  opts: { parallel?: boolean; defaultRegistry?: boolean; concurrency?: number } = {},
): Promise<ParseStats> {
  // Preload tree-sitter grammars on the main thread (shared by serial + concurrency; the worker
  // path preloads in each isolate instead). A no-op for runs with no tree-sitter files.
  await preloadGrammars(grammarsNeededFor(files));

  // Worker pool is opt-in (env) AND only for the default fleet AND only when the worker script is
  // built + enough files to attempt amortizing the cold start.
  const useWorkers =
    opts.parallel !== false &&
    process.env.KCRIB_PARALLEL === 'workers' &&
    opts.defaultRegistry !== false &&
    parallelAvailable(files.length);

  if (useWorkers) {
    return runParseParallel(soul, root, files);
  }

  // Concurrency is the shipped default parallel path. `parallel === false` forces the serial loop
  // (incremental update, determinism cross-check, custom extractors). One file → serial (no overlap
  // to gain).
  if (opts.parallel !== false && files.length > 1) {
    return runParseConcurrent(soul, registry, root, files, opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  let filesParsed = 0;
  let nodes = 0;
  let edges = 0;
  for (const file of files) {
    const extractor = registry.resolve(file);
    if (!extractor) continue;
    const ctx = makeExtractCtx(root, file.path);
    const result = await extractor.extract(file, ctx);
    if (result.nodes.length > 0) soul.putNodes(result.nodes);
    if (result.edges.length > 0) soul.putEdges(result.edges);
    filesParsed++;
    nodes += result.nodes.length;
    edges += result.edges.length;
  }
  return { filesParsed, nodes, edges };
}
