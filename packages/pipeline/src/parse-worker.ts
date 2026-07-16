/**
 * M3.4 parallel-parse WORKER entry. Runs in a `worker_threads` isolate spawned by `ParallelParser`
 * (parse-pool.ts). One worker handles many files over its lifetime (persistent pool): the main thread
 * dispatches file batches, the worker extracts each and returns the plain `{nodes, edges}` JSON.
 *
 * Why a worker (not Promise.all): per-file extraction is CPU-bound (regex + tree-sitter WASM parse),
 * so the event loop cannot interleave it — only OS threads parallelize it. `Promise.all` would still
 * run every extractor on the main thread, serially.
 *
 * DETERMINISM — read before editing. The worker does ONLY pure reads + extraction. It NEVER touches
 * the soul, NEVER writes the filesystem (except `readFile` of the source it is told to parse), NEVER
 * calls Date.now/Math.random. The main thread persists results in DISCOVERY ORDER (see parse-pool.ts),
 * so the soul's in-memory Map insertion order — which the order-sensitive downstream phases
 * (resolve/link/Louvain cluster) iterate — is byte-identical to the serial path. Tree-sitter parse is
 * deterministic given the same grammar + source; node ids are content-hash-based. So parallel output
 * equals serial output for every committed chunk + every downstream phase.
 *
 * The worker imports JUST the extractor fleet (extractors.ts) + the parsers package — NOT all of
 * pipeline.ts — so the worker isolate boots cheaply (no resolve/cfg/link/cluster modules loaded).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ExtractorRegistry, preloadGrammars } from '@knowledge-crib/parsers';
import type { FileMeta } from '@knowledge-crib/parsers';
import { makeExtractCtx } from './extract-ctx.js';
import { defaultExtractors } from './extractors.js';

// The registry is built ONCE per worker (extractor constructors are cheap but the fleet is the
// single source of truth — see extractors.ts). `resolve()` is disjoint by extension so the fleet
// order only matters for `.md`, which the registry honors identically here.
const registry = new ExtractorRegistry();
for (const e of defaultExtractors()) registry.register(e);

let ready = false;

type InMsg =
  | { kind: 'init'; grammarNames: string[] }
  | { kind: 'extract'; idx: number; file: FileMeta; root: string }
  | { kind: 'batch'; root: string; items: { idx: number; file: FileMeta }[] }
  | { kind: 'shutdown' };

if (parentPort) {
  parentPort.on('message', async (msg: InMsg) => {
    if (msg.kind === 'init') {
      // Preload exactly the grammars this run needs (php only today). Idempotent + cached in the
      // worker isolate's own `loadedLanguages` map. A run with no tree-sitter files → no-op (the
      // hot path — regex-only files skip the WASM boot entirely, which is what makes the batched
      // pool pay off: workers handling non-PHP slices boot cheap).
      await preloadGrammars(msg.grammarNames);
      ready = true;
      parentPort!.postMessage({ kind: 'ready' });
      return;
    }
    if (msg.kind === 'extract') {
      // Defensive: if an extract arrives before init resolved, the grammar may be missing. The main
      // thread serializes init→extract per worker, but guard anyway — degrade to no symbols, never
      // throw the pipeline (mirrors the serial extractor contract).
      try {
        const extractor = registry.resolve(msg.file);
        if (!extractor) {
          // No extractor for this file → not "parsed". Mirrors the serial `if (!extractor) continue`
          // (serial increments filesParsed ONLY for files an extractor resolved for).
          parentPort!.postMessage({
            kind: 'result',
            idx: msg.idx,
            nodes: [],
            edges: [],
            parsed: false,
          });
          return;
        }
        const ctx = makeExtractCtx(msg.root, msg.file.path);
        const result = ready ? await extractor.extract(msg.file, ctx) : { nodes: [], edges: [] };
        parentPort!.postMessage({
          kind: 'result',
          idx: msg.idx,
          nodes: result.nodes,
          edges: result.edges,
          parsed: true,
        });
      } catch (err) {
        // Extractors are contracted to degrade to a file node on parse failure (never throw the
        // pipeline). If one DOES throw, surface it as an error result so the main thread can decide
        // (the pool re-throws to preserve the serial failure surface, not silently drop the file).
        const message = err instanceof Error ? err.message : String(err);
        parentPort!.postMessage({ kind: 'error', idx: msg.idx, message });
      }
      return;
    }
    if (msg.kind === 'batch') {
      // BATCHED path: one message carries a slice of files; one message returns all their results.
      // Cuts the per-message round-trip overhead (listener add/remove + postMessage syscall) from
      // ~2×files to ~2×workers — the dominant cost for crib's many-small-file workload. Results are
      // returned in slice order; the main thread persists in DISCOVERY order (it knows the idx map).
      try {
        const results: { nodes: unknown[]; edges: unknown[]; parsed: boolean }[] = [];
        for (const item of msg.items) {
          const extractor = registry.resolve(item.file);
          if (!extractor) {
            results.push({ nodes: [], edges: [], parsed: false });
            continue;
          }
          const ctx = makeExtractCtx(msg.root, item.file.path);
          const result = ready ? await extractor.extract(item.file, ctx) : { nodes: [], edges: [] };
          results.push({ nodes: result.nodes, edges: result.edges, parsed: true });
        }
        parentPort!.postMessage({ kind: 'batch', results });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        parentPort!.postMessage({ kind: 'error', idx: -1, message });
      }
      return;
    }
    if (msg.kind === 'shutdown') {
      parentPort!.close();
      process.exit(0);
    }
  });
}

// `workerData` is unused but referenced so tsc/esbuild keeps the worker_threads import stable across
// build configs that tree-shake unused imports. No runtime effect.
void workerData;
