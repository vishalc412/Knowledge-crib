#!/usr/bin/env node
/**
 * What one `loadInstalledEmbedder()` actually costs — measured, not assumed.
 *
 * WHY THIS EXISTS. Every process that touches the vector channel pays this before it does any work:
 * `loadInstalledEmbedder` calls `verifyInstalledEmbed`, which streams a sha256 over **every pinned
 * model file and every pinned weight-cache file** (`checkPinnedFiles` → `sha256File`, 1 MiB chunks,
 * main thread, synchronous). On this machine that is ~3.2 GiB of weights. The cost is therefore
 * per-CLI-invocation, not per-index, and it is invisible in any single number the scale harness
 * reports — the cold-index wall contains it, the lexical wall does not, and nothing in the report
 * says so.
 *
 * So it is measured here, twice back to back:
 *   - the FIRST also pays whatever disk read the cache has not already absorbed;
 *   - the SECOND is the hash's cost with the pages resident.
 * The gap is the disk component — **only if the first run actually met a cold cache**. This tool
 * cannot force that, and on a machine where the weights were already resident the gap comes out at
 * approximately zero or negative (measured: -38 ms). A negative gap is reported as "not observable"
 * rather than printed as a negative number of milliseconds, because "the disk cost was not measured"
 * and "the disk cost is zero" are different statements and only the first one is supported.
 *
 * What this tool does NOT do is explain a slow child. Measured 2026-09-23: the whole load is ~1.3 s on
 * a warm cache — real, per-invocation, and far too small to account for the ~27-37 s that §5.3 of the
 * evidence register measured for a vector-aware `crib update`, or for a multi-minute stall. Those are
 * different costs and must not be attributed to this one.
 *
 * This tool also WARMS THE PAGE CACHE, which is its other job when the R3 run calls it first: the
 * cold-index column of `scale-bench.mjs` must vary with the channel, not with whether the model
 * weights happened to be in cache. That is disclosed in the run log rather than left implicit — a
 * warmed cache is a measurement control, and an unstated control is a rumour.
 *
 * Report §9.4's three-outcome discipline applies: with no tier installed, this prints
 * `unavailable` and a reason and exits 0. "Could not be measured" is not "is zero".
 *
 * Usage: node docs/program/tools/embed-load-cost.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const CORE_URL = pathToFileURL(join(REPO, 'packages', 'core', 'dist', 'index.js')).href;
const MANIFEST = join(homedir(), '.crib', 'embed', 'manifest.json');
const AS_JSON = process.argv.includes('--json');

/** Bytes the loader is contractually obliged to hash, read from the manifest it will verify against. */
function pinnedBytes(manifest) {
  const sum = (files) => (files ?? []).reduce((n, f) => n + (f.bytes || 0), 0);
  return sum(manifest.files) + sum(manifest.provisioning?.weights?.files);
}

async function timedLoad() {
  const { loadInstalledEmbedder } = await import(CORE_URL);
  const t0 = performance.now();
  const embedder = await loadInstalledEmbedder();
  const loadMs = performance.now() - t0;
  if (!embedder) return { loadMs, embedderId: null, dim: null };
  // One embed, so the ONNX session is actually initialised and its arena allocated: a footprint or
  // cost measured on a session that has never run a tensor is not the cost this machine pays.
  const t1 = performance.now();
  embedder.embed('warm the session');
  const firstEmbedMs = performance.now() - t1;
  return { loadMs, firstEmbedMs, embedderId: embedder.id, dim: embedder.dim() };
}

let report;
try {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const bytes = pinnedBytes(manifest);
  const cold = await timedLoad();
  const warm = await timedLoad();
  report = {
    status: 'measured',
    embedderId: manifest.embedderId,
    dim: manifest.dim,
    pinnedBytesHashed: bytes,
    pinnedMiBHashed: Math.round(bytes / 1048576),
    coldLoadMs: Math.round(cold.loadMs),
    warmLoadMs: Math.round(warm.loadMs),
    firstEmbedMs: warm.firstEmbedMs === undefined ? null : Math.round(warm.firstEmbedMs),
    // The disk component is the only part a warm page cache removes. It is reported as a difference
    // rather than as a claim about the disk, because a cold first run also pays module import and
    // ONNX session construction, which the warm run pays again — so the difference is an upper bound
    // on the read cost, not a measurement of it.
    coldMinusWarmMs: Math.round(cold.loadMs - warm.loadMs),
    throughputMiBPerS: warm.loadMs > 0 ? Number((bytes / 1048576 / (warm.loadMs / 1000)).toFixed(0)) : null,
  };
} catch (err) {
  report = {
    status: 'unavailable',
    reason:
      err && err.code === 'ENOENT'
        ? `no installed embed tier (${MANIFEST} absent)`
        : `embedder load failed: ${err instanceof Error ? err.message : String(err)}`,
  };
}

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (report.status === 'unavailable') {
  process.stdout.write(`embed-load-cost: UNAVAILABLE — ${report.reason}\n`);
} else {
  process.stdout.write(
    [
      `embed-load-cost: ${report.embedderId} (dim ${report.dim})`,
      `  pinned and hashed per load : ${report.pinnedBytesHashed.toLocaleString('en-US')} bytes (${report.pinnedMiBHashed} MiB)`,
      `  first load (cache unknown)  : ${report.coldLoadMs} ms`,
      `  second load (cache warm)   : ${report.warmLoadMs} ms  ← the fixed per-invocation overhead`,
      `  derived hash throughput    : ${report.throughputMiBPerS} MiB/s (warm)`,
      report.coldMinusWarmMs > 0
        ? `  upper bound on the disk read: ${report.coldMinusWarmMs} ms`
        : '  disk component             : not observable (the first run did not meet a cold cache; this tool cannot force one)',
      '',
    ].join('\n'),
  );
}
process.exit(0);
