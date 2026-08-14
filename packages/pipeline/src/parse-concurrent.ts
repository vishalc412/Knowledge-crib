/**
 * M3.4 parallel parse — BOUNDED-CONCURRENCY async pool (the shipped default).
 *
 * Extractors are `async` (they `await ctx.readText()`), but the serial `for (const file of files) {
 * await extract(...) }` loop awaits each file to completion before starting the next, serializing the
 * readFile I/O. A bounded pool of K concurrent extractors overlaps that I/O on the event loop: while
 * one file's sync regex parse runs, another's readFile is in flight. Measured ~1.2-1.3× on a
 * 2300-file fixture — the ceiling is the I/O fraction (~25% of parse time); the rest is sync CPU
 * (regex/tree-sitter) which a single Node thread cannot parallelize.
 *
 * DETERMINISM — same trick as the worker pool: collect every result into `results[idx]` keyed by
 * DISCOVERY index, then persist (`putNodes`/`putEdges`) in `files` order once all extractors resolve.
 * The soul's in-memory Map insertion order is therefore byte-identical to the serial loop, so every
 * order-sensitive downstream phase (resolve/link/Louvain cluster) iterates the same sequence.
 *
 * WHY NOT WORKER THREADS — investigated + measured (see parse-pool.ts, ADR-001). Worker threads are
 * NET-NEGATIVE for crib's parse workload: (1) a fresh worker isolate has cold V8 JIT, so the regex
 * extractors run ~2-3× slower per file than on the warm main thread, eating the parallelism gain;
 * (2) `structuredClone` of the {nodes,edges} results across the isolate boundary adds transfer cost;
 * (3) the pool is torn down per `crib index` (CLI, not a server) so workers never amortize their
 * cold start. Bounded concurrency wins by staying in-process: no cold JIT, no clone, no spawn, no
 * new failure modes. The worker pool is retained behind `KCRIB_PARALLEL=workers` for the future
 * huge-file case where per-worker work is long enough to amortize the cold start.
 */
import type { SoulStore } from '@knowledge-crib/core';
import { grammarsNeededFor, preloadGrammars } from '@knowledge-crib/parsers';
import type { ExtractDiagnostic, ExtractorRegistry, FileMeta } from '@knowledge-crib/parsers';
import { makeExtractCtx } from './extract-ctx.js';
import { DEFAULT_DIAGNOSTIC_LIMIT, aggregateDiagnostics, emptyParseStats } from './parse.js';
import type { FileExtraction, ParseStats } from './parse.js';

/** Default concurrency. Tuned on the 2300-file bench: speedup plateaus at K≈8-32; 16 is a safe
 *  middle that avoids over-scheduling the event loop on smaller repos. */
export const DEFAULT_CONCURRENCY = 16;

/** Run Phase 2 extraction with a bounded-concurrency async pool, persisting in discovery order. */
export async function runParseConcurrent(
  soul: SoulStore,
  registry: ExtractorRegistry,
  root: string,
  files: FileMeta[],
  concurrency = DEFAULT_CONCURRENCY,
  diagnosticLimit = DEFAULT_DIAGNOSTIC_LIMIT,
): Promise<ParseStats> {
  if (files.length === 0) return emptyParseStats();
  // Preload tree-sitter grammars on the main thread (the pool shares this one loaded language across
  // all concurrent extractors — `createParserHandle` is cheap per call; the Language is shared).
  await preloadGrammars(grammarsNeededFor(files));

  type Slot = {
    nodes: import('@knowledge-crib/soul-schema').Node[];
    edges: import('@knowledge-crib/soul-schema').Edge[];
    parsed: boolean;
    extractorName: string;
    diagnostics: ExtractDiagnostic[];
  } | null;
  const results: Slot[] = new Array(files.length).fill(null);
  let cursor = 0;
  const nextIdx = (): number => (cursor < files.length ? cursor++ : -1);

  // K runners pull from the shared cursor; each awaits readText + sync parse for its file. The
  // `await` is the overlap seam — while one runner is inside sync regex parse, another's readFile
  // I/O is pending on the event loop.
  const runner = async (): Promise<void> => {
    for (let idx = nextIdx(); idx >= 0; idx = nextIdx()) {
      const file = files[idx]!;
      const extractor = registry.resolve(file);
      if (!extractor) {
        results[idx] = { nodes: [], edges: [], parsed: false, extractorName: '', diagnostics: [] };
        continue;
      }
      const ctx = makeExtractCtx(root, file.path);
      const result = await extractor.extract(file, ctx);
      results[idx] = {
        nodes: result.nodes,
        edges: result.edges,
        parsed: true,
        extractorName: extractor.name,
        diagnostics: result.diagnostics ?? [],
      };
    }
  };

  const K = Math.min(Math.max(1, concurrency), files.length);
  await Promise.all(Array.from({ length: K }, () => runner()));

  // SERIAL PERSIST in discovery order — determinism-critical (see header). The diagnostics are also
  // folded in this same discovery-order pass so the aggregated surface matches the serial loop.
  let filesParsed = 0;
  let nodes = 0;
  let edges = 0;
  const extractions: FileExtraction[] = [];
  for (let i = 0; i < files.length; i++) {
    const r = results[i];
    if (!r) continue; // defensive — every index should have been filled
    if (r.nodes.length > 0) soul.putNodes(r.nodes);
    if (r.edges.length > 0) soul.putEdges(r.edges);
    if (r.parsed) filesParsed++; // mirrors serial `filesParsed` semantics
    nodes += r.nodes.length;
    edges += r.edges.length;
    if (r.parsed) extractions.push({ extractorName: r.extractorName, diagnostics: r.diagnostics });
  }
  return { filesParsed, nodes, edges, ...aggregateDiagnostics(extractions, diagnosticLimit) };
}
