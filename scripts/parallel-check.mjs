/**
 * parallel-check — the M3.4 parallel-parse gate.
 *
 * Pins the plan's M3.4 intent — "deterministic output identical" + a real speedup — against the
 * SHIPPED bounded-concurrency pool, and smoke-tests the retained worker-thread opt-in. Drives the
 * REAL pipeline (indexRepo over a SCALED parsers-pkg fixture, ~2300 files) so the speedup is
 * measurable (the 23-file fixture is too small for any parallelism to amortize dispatch overhead).
 *
 * Asserts:
 *   (1) DETERMINISM: a full indexRepo via the concurrent path commits a byte-identical soul to the
 *       serial path (same repoId, dossiers/ownership off to isolate parse + resolve/link/cluster).
 *   (2) SPEEDUP: concurrent parse is ≥ 1.10× the serial parse on the scaled fixture (measured
 *       1.15-1.31× across runs; the ceiling is the readFile-I/O fraction since the rest is sync CPU a
 *       single Node thread cannot parallelize). Floor sits BELOW the observed min so CI runners
 *       slower than the dev box don't flake the gate; it still fails on a serial-parity regression.
 *   (3) WORKER OPT-IN: `KCRIB_PARALLEL=workers` runs + commits a byte-identical soul (the retained
 *       worker-thread pool still works, even though it is net-negative for small files and therefore
 *       not the default — see ADR-001).
 *   (4) WIRING: parse-concurrent.ts exists + runParse routes to it by default + the worker pool is
 *       env-gated (anchored to executable source syntax, not bare words).
 *
 * The "≥ 2×" in the original plan row is unsatisfiable for crib's parse workload via any in-process
 * mechanism: worker threads lose to cold-V8-JIT + structuredClone transfer cost; bounded concurrency
 * is capped by the I/O fraction (~25%). See ADR-001 for the full empirical finding. This gate pins
 * the honest, measured contract.
 *
 * release:verify builds every package before any gate runs, so the dynamic imports of the built
 * pipeline dist resolve.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const NOW = '2026-01-01T00:00:00.000Z';
const REPO_ID = 'parallel-check-fixed-repo-id';
const FIX = resolve(REPO, 'packages', 'parsers', 'fixtures');
const SCALE = 100; // ~2300 files (23-file fixture × 100 batches)
// Floor BELOW the observed MIN (1.15× across dev + bench runs), not at it. CI runners vary more than
// the dev box; a floor at the min flakes the moment a runner is ~5% slower. 1.10× still fails if
// concurrency regresses to serial-parity (proving the path engages + helps) while absorbing variance.
const SPEEDUP_FLOOR = 1.1;

const core = await import(resolve(REPO, 'packages', 'core', 'dist', 'index.js'));
const pipeline = await import(resolve(REPO, 'packages', 'pipeline', 'dist', 'index.js'));
const parsers = await import(resolve(REPO, 'packages', 'parsers', 'dist', 'index.js'));
const { SoulStore, newManifest } = core;
const { indexRepo, discoverFiles, defaultExtractors } = pipeline;
const { ExtractorRegistry } = parsers;
const { runParse } = await import(resolve(REPO, 'packages', 'pipeline', 'dist', 'parse.js'));

let failed = 0;
const fail = (msg) => {
  process.stderr.write(`  parallel:check FAIL — ${msg}\n`);
  failed++;
};

// Build a scaled fixture: copy the 23-file fixture tree SCALE times into sibling batch dirs.
function buildScaled(n) {
  const root = mkdtempSync(join(tmpdir(), 'crib-par-gate-'));
  for (let i = 0; i < n; i++) cpSync(FIX, join(root, `batch${i}`), { recursive: true });
  return root;
}
function newSoul(repo) {
  const s = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: NOW, repoId: REPO_ID }),
  });
  s.load();
  return s;
}
function newReg() {
  const r = new ExtractorRegistry();
  for (const e of defaultExtractors()) r.register(e);
  return r;
}
function snap(repo) {
  const crib = join(repo, '.crib');
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel === '.crib' ? `.crib/${name}` : `${rel}/${name}`;
      if (r === '.crib/index' || r === '.crib/embeddings') continue; // gitignored derived state
      if (statSync(abs).isDirectory()) {
        walk(abs, r);
        continue;
      }
      out.push(r);
      out.push(readFileSync(abs, 'utf8'));
    }
  };
  walk(crib, '.crib');
  return out.join('\n');
}

try {
  // (4) wiring assertions — anchored to executable source syntax.
  const parseSrc = readFileSync(resolve(REPO, 'packages', 'pipeline', 'src', 'parse.ts'), 'utf8');
  if (!/from '\.\/parse-concurrent\.js'/.test(parseSrc))
    fail('parse.ts does not import parse-concurrent');
  if (!/runParseConcurrent/.test(parseSrc)) fail('parse.ts does not call runParseConcurrent');
  if (!/KCRIB_PARALLEL === 'workers'/.test(parseSrc))
    fail('parse.ts does not env-gate the worker pool on KCRIB_PARALLEL=workers');
  const ccSrc = readFileSync(
    resolve(REPO, 'packages', 'pipeline', 'src', 'parse-concurrent.ts'),
    'utf8',
  );
  if (!/discovery order/.test(ccSrc))
    fail('parse-concurrent.ts does not document discovery-order persist');
  else
    process.stdout.write(
      '  parallel:check — wiring present (concurrency default, workers env-gated)\n',
    );

  const root = buildScaled(SCALE);
  try {
    const files = discoverFiles(root, {});
    process.stdout.write(`  parallel:check — scaled fixture: ${files.length} files (N=${SCALE})\n`);

    // (1) DETERMINISM: serial vs concurrent full indexRepo, byte-identical souls.
    // Snapshot the serial soul to a STRING before rmSync so the worker-opt-in step (3) can compare
    // against the same canonical serial output without keeping the temp dir alive.
    const detOpts = { now: NOW, dossiers: false, ownership: false };
    const ser = mkdtempSync(join(tmpdir(), 'crib-par-g-ser-'));
    const con = mkdtempSync(join(tmpdir(), 'crib-par-g-con-'));
    cpSync(root, join(ser, 'src'), { recursive: true });
    cpSync(root, join(con, 'src'), { recursive: true });
    await indexRepo(newSoul(ser), ser, { ...detOpts, parallel: false });
    await indexRepo(newSoul(con), con, detOpts);
    const serialSnap = snap(ser);
    if (snap(con) !== serialSnap) fail('concurrent indexRepo soul !== serial indexRepo soul');
    else
      process.stdout.write(
        '  parallel:check — determinism: concurrent soul byte-identical to serial\n',
      );
    rmSync(ser, { recursive: true, force: true });
    rmSync(con, { recursive: true, force: true });

    // (2) SPEEDUP: time the parse phase serial vs concurrent. Warmup once, then measure.
    await runParse(newSoul(root), newReg(), root, files, { parallel: false });
    const t0 = performance.now();
    const ss = await runParse(newSoul(root), newReg(), root, files, { parallel: false });
    const t1 = performance.now();
    const cc = await runParse(newSoul(root), newReg(), root, files, {});
    const t2 = performance.now();
    const serialMs = t1 - t0;
    const concMs = t2 - t1;
    const speedup = serialMs / concMs;
    if (ss.nodes !== cc.nodes || ss.edges !== cc.edges || ss.filesParsed !== cc.filesParsed)
      fail(
        `parse counts diverge: serial n=${ss.nodes}/e=${ss.edges}/p=${ss.filesParsed} vs concurrent n=${cc.nodes}/e=${cc.edges}/p=${cc.filesParsed}`,
      );
    if (speedup < SPEEDUP_FLOOR)
      fail(
        `speedup ${speedup.toFixed(2)}× < ${SPEEDUP_FLOOR}× floor (serial ${serialMs.toFixed(0)}ms, concurrent ${concMs.toFixed(0)}ms)`,
      );
    else
      process.stdout.write(
        `  parallel:check — speedup ${speedup.toFixed(2)}× (serial ${serialMs.toFixed(0)}ms → concurrent ${concMs.toFixed(0)}ms; counts n=${cc.nodes}/e=${cc.edges})\n`,
      );

    // (3) WORKER OPT-IN smoke: KCRIB_PARALLEL=workers runs + soul byte-identical to serial.
    // Compares against `serialSnap` captured in step (1) — the canonical serial output.
    process.env.KCRIB_PARALLEL = 'workers';
    try {
      const wkr = mkdtempSync(join(tmpdir(), 'crib-par-g-wkr-'));
      cpSync(root, join(wkr, 'src'), { recursive: true });
      await indexRepo(newSoul(wkr), wkr, detOpts);
      if (snap(wkr) !== serialSnap) fail('KCRIB_PARALLEL=workers soul !== serial soul');
      else
        process.stdout.write('  parallel:check — worker opt-in: soul byte-identical to serial\n');
      rmSync(wkr, { recursive: true, force: true });
    } finally {
      process.env.KCRIB_PARALLEL = undefined;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} catch (err) {
  process.stderr.write(`  parallel:check threw: ${err?.stack ?? err}\n`);
  failed++;
}

if (failed > 0) {
  process.stderr.write(`\nparallel:check — ${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\nparallel:check — all assertions passed\n');
