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
 *
 * Foundation Task 7 — diagnostics aggregation. Extractors may return per-file `diagnostics` (warnings/
 * errors/info). Every execution mode aggregates them into `ParseStats` deterministically: counts
 * (`byCode`/`bySeverity`/`byExtractor`) reflect EVERY diagnostic, while the `diagnostics` array
 * retains only the first `diagnosticLimit` in DISCOVERY order (the rest reported in
 * `diagnosticsTruncated`). Serial, concurrent, and worker modes all fold into the same aggregation,
 * so a full re-index yields identical diagnostics regardless of execution mode.
 */
import { grammarsNeededFor, preloadGrammars } from '@knowledge-crib/parsers';
import type { ExtractDiagnostic, ExtractorRegistry, FileMeta } from '@knowledge-crib/parsers';
import { makeExtractCtx } from './extract-ctx.js';
import { DEFAULT_CONCURRENCY, runParseConcurrent } from './parse-concurrent.js';
import { parallelAvailable, runParseParallel } from './parse-pool.js';

/** Default cap on retained diagnostic records. Counts (`byCode`/`bySeverity`/`byExtractor`) are
 *  always complete; only the per-record `diagnostics` array is bounded so a runaway extractor can't
 *  blow up the CLI report or the index manifest. */
export const DEFAULT_DIAGNOSTIC_LIMIT = 1_000;

export interface ParseStats {
  filesParsed: number;
  nodes: number;
  edges: number;
  /** Retained diagnostics in DISCOVERY order (bounded by `diagnosticLimit`). */
  diagnostics: ExtractDiagnostic[];
  /** Diagnostics produced but not retained (total produced − retained). Always counts all. */
  diagnosticsTruncated: number;
  /** Per-extractor file + diagnostic counts (every diagnostic counted). */
  byExtractor: Record<string, { files: number; diagnostics: number }>;
  /** Per-code diagnostic counts (every diagnostic counted). */
  byCode: Record<string, number>;
  /** Per-severity diagnostic counts (every diagnostic counted). */
  bySeverity: Record<ExtractDiagnostic['severity'], number>;
}

/** A per-file extraction outcome retained for diagnostic aggregation. The serial, concurrent, and
 *  worker paths each collect these in DISCOVERY order, then fold them through
 *  {@link aggregateDiagnostics} so the diagnostics surface is identical across modes. */
export interface FileExtraction {
  extractorName: string;
  diagnostics: ExtractDiagnostic[];
}

/** An empty ParseStats (zeroed counts, empty aggregations) for the noop / fallback paths. */
export function emptyParseStats(): ParseStats {
  return {
    filesParsed: 0,
    nodes: 0,
    edges: 0,
    diagnostics: [],
    diagnosticsTruncated: 0,
    byExtractor: {},
    byCode: {},
    bySeverity: { info: 0, warning: 0, error: 0 },
  };
}

/**
 * Aggregate per-file diagnostics (in DISCOVERY order) into the `ParseStats` diagnostics fields.
 * Counts EVERY diagnostic in `byCode`/`bySeverity`/`byExtractor` (never bounded — the summary is
 * always complete), while the `diagnostics` array retains only the first `limit` records in
 * discovery order; the remainder is reported in `diagnosticsTruncated`. Pure + deterministic: same
 * input ⇒ same output, so serial / concurrent / worker modes produce identical diagnostics.
 */
export function aggregateDiagnostics(
  extractions: readonly FileExtraction[],
  limit = DEFAULT_DIAGNOSTIC_LIMIT,
): Pick<
  ParseStats,
  'diagnostics' | 'diagnosticsTruncated' | 'byCode' | 'bySeverity' | 'byExtractor'
> {
  const byCode: Record<string, number> = {};
  const bySeverity: Record<ExtractDiagnostic['severity'], number> = {
    info: 0,
    warning: 0,
    error: 0,
  };
  const byExtractor: Record<string, { files: number; diagnostics: number }> = {};
  const retained: ExtractDiagnostic[] = [];
  let total = 0;
  for (const ext of extractions) {
    let bucket = byExtractor[ext.extractorName];
    if (!bucket) {
      bucket = { files: 0, diagnostics: 0 };
      byExtractor[ext.extractorName] = bucket;
    }
    bucket.files++;
    for (const d of ext.diagnostics) {
      total++;
      bucket.diagnostics++;
      byCode[d.code] = (byCode[d.code] ?? 0) + 1;
      bySeverity[d.severity]++;
      if (retained.length < limit) retained.push(d);
    }
  }
  return {
    diagnostics: retained,
    diagnosticsTruncated: Math.max(0, total - retained.length),
    byCode,
    bySeverity,
    byExtractor,
  };
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
 *  honor any registry. `diagnosticLimit` bounds the retained diagnostics array (counts stay full). */
export async function runParse(
  soul: SoulStore,
  registry: ExtractorRegistry,
  root: string,
  files: FileMeta[],
  opts: {
    parallel?: boolean;
    defaultRegistry?: boolean;
    concurrency?: number;
    diagnosticLimit?: number;
  } = {},
): Promise<ParseStats> {
  const limit = opts.diagnosticLimit ?? DEFAULT_DIAGNOSTIC_LIMIT;
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
    return runParseParallel(soul, root, files, undefined, limit);
  }

  // Concurrency is the shipped default parallel path. `parallel === false` forces the serial loop
  // (incremental update, determinism cross-check, custom extractors). One file → serial (no overlap
  // to gain).
  if (opts.parallel !== false && files.length > 1) {
    return runParseConcurrent(
      soul,
      registry,
      root,
      files,
      opts.concurrency ?? DEFAULT_CONCURRENCY,
      limit,
    );
  }

  let filesParsed = 0;
  let nodes = 0;
  let edges = 0;
  const extractions: FileExtraction[] = [];
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
    extractions.push({ extractorName: extractor.name, diagnostics: result.diagnostics ?? [] });
  }
  return { filesParsed, nodes, edges, ...aggregateDiagnostics(extractions, limit) };
}
