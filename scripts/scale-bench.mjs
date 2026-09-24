import { execFileSync, spawnSync } from 'node:child_process';
/**
 * scale-bench — the M3.6 scale measurement.
 *
 * Pins the plan's M3.6 intent — "bench on a ≥1M-LOC public repo; decide per-module souls / lazy
 * shard loading from data, not guesswork" — with a reproducible index-time + peak-RSS curve across
 * LOC slices. The load-bearing question: does crib's peak memory grow with corpus size (→ need
 * per-module souls / lazy shard loading) or stay bounded (extractors are pure per-file, the pipeline
 * streams, the sqlite index is disk-backed)? The curve answers that from data, not guesswork.
 *
 * METHOD — replicated fixture (the M3.4 precedent). `packages/parsers/fixtures` is 23 real source
 * files (~858 LOC) spanning every supported extractor's surface. Replicating it into N sibling
 * `batchN/` dirs yields N×858 LOC of REAL extracted code (not synthetic) with a deterministic
 * file count + size distribution anyone with the repo can reproduce — no multi-GB clone, no network.
 * `--repo <path>` indexes a real public repo at full size as a
 * cross-check data point alongside the curve (one measurement, no slicing).
 *
 * MEASUREMENT — each slice is indexed by the BUILT `crib` CLI under `/usr/bin/time`. Wall time is
 * measured in-process via `performance.now()` around the synchronous spawnSync (portable, sub-ms —
 * not parsed from /usr/bin/time's platform-specific elapsed string). Peak RSS comes from
 * `/usr/bin/time` (a parent can't read a child's peak RSS via spawnSync): BSD `-l` on darwin vs
 * GNU `-v` on linux; GNU reports RSS in kbytes, BSD in bytes — normalized to bytes in benchIndex,
 * so the harness is cross-platform. The crib CLI also prints
 * `indexed N files → X nodes, Y edges in Zms`, parsed for the throughput + graph-size columns.
 * Setup (copying batches) is excluded from the timing — only the `crib index` run is measured, so
 * the curve reflects pure index cost.
 *
 * OUTPUT — a markdown table (LOC, files, nodes, edges, wall s, peak RSS MB, RSS-per-kLOC, nodes/s)
 * written to docs/bench/scale-curve.md (+ stdout). The committed artifact is the published curve;
 * `scale:check` (release:verify) runs a SMALL slice to prove the harness works + RSS bounded, and
 * asserts the committed curve file exists. The full 1M-LOC run is `scale:nightly`-class (slow),
 * re-run on demand when the corpus or pipeline changes.
 *
 * Usage:
 *   node scripts/scale-bench.mjs                       # default slices 10k/100k/500k/1M LOC
 *   node scripts/scale-bench.mjs --slices 10000,100000 # custom slices
 *   node scripts/scale-bench.mjs --repo ../TypeScript  # add a real-repo full-index data point
 *   node scripts/scale-bench.mjs --out docs/bench/scale-curve.md
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const FIX = resolve(REPO, 'packages', 'parsers', 'fixtures');
const CLI = resolve(REPO, 'packages', 'cli', 'dist', 'cli.js');

// Source extensions crib extracts (matches the fuzz fleet + md + pkb). Used to count LOC of a
// staged slice so the curve's x-axis is real source lines, not file count.
const SRC_EXTS = new Set([
  '.ts',
  '.tsx',
  '.py',
  '.go',
  '.java',
  '.cs',
  '.rs',
  '.php',
  '.md',
  '.pkb',
  '.js',
]);

// --- args ---------------------------------------------------------------------------------------
let slices = [10_000, 100_000, 500_000, 1_000_000];
let repoPoint = '';
let outPath = resolve(REPO, 'docs', 'bench', 'scale-curve.md');
// --- vector arm (WP4 §9) ------------------------------------------------------------------------
// Off by default: the lexical path above is the incumbent, and `scale:check` (a release gate) must
// keep running it exactly as before. §10.5's budgets are measured by opting in.
let wantVectors = false;
/** p95 iterations, per perf-gates.md's stated method: ≥5 warmups then ≥50 measured, `fresh=false`. */
let queryWarmups = 5;
let queryIters = 50;
let doIncremental = true;
/**
 * A slice whose VECTOR arm is projected to exceed this many minutes is NOT run, and is recorded as
 * UNAVAILABLE with the measured per-node rate as the reason — never as a fast number and never as a
 * projected one (§9.4 forbids publishing a fit). Embedding is ~36 ms/node on the installed tier, so a
 * 500k-LOC slice is hours of model time; the honest output for it is "not measured, here is why".
 */
let vectorMaxMinutes = 45;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--vectors') {
    wantVectors = true;
  } else if (a === '--query-iters' && argv[i + 1]) {
    queryIters = Number.parseInt(argv[i + 1], 10);
    i++;
  } else if (a === '--warmups' && argv[i + 1]) {
    queryWarmups = Number.parseInt(argv[i + 1], 10);
    i++;
  } else if (a === '--no-incremental') {
    doIncremental = false;
  } else if (a === '--vector-max-minutes' && argv[i + 1]) {
    vectorMaxMinutes = Number.parseFloat(argv[i + 1]);
    i++;
  } else if (a === '--slices' && argv[i + 1]) {
    slices = argv[i + 1]
      .split(',')
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
    i++;
  } else if (a === '--repo' && argv[i + 1]) {
    repoPoint = resolve(REPO, argv[i + 1]);
    i++;
  } else if (a === '--out' && argv[i + 1]) {
    outPath = resolve(REPO, argv[i + 1]);
    i++;
  } else if (a === '--slice' && argv[i + 1]) {
    // single small slice for the fast `scale:check` gate (e.g. --slice 20000)
    slices = [Number.parseInt(argv[i + 1], 10)];
    i++;
  }
}

// --- build guard (standalone `pnpm scale:check`) ------------------------------------------------
if (!existsSync(CLI)) {
  process.stdout.write('$ corepack pnpm@9.15.0 -F @knowledge-crib/cli build (cli dist missing)\n');
  execFileSync('corepack', ['pnpm@9.15.0', '-F', '@knowledge-crib/cli', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

// --- helpers ------------------------------------------------------------------------------------
function countLoc(root) {
  let loc = 0;
  let files = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (SRC_EXTS.has(name.slice(name.lastIndexOf('.')))) {
        files++;
        // wc -l equivalent: count newline-terminated lines. Read + count \n.
        const text = readTextLines(p);
        loc += text;
      }
    }
  };
  walk(root);
  return { loc, files };
}

function readTextLines(p) {
  try {
    const buf = readFileSync(p);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    return buf.length > 0 && buf[buf.length - 1] !== 0x0a ? n + 1 : n; // trailing line w/o newline
  } catch {
    return 0;
  }
}

// /usr/bin/time flags + output format differ by platform, and a single hardcoded `-l` breaks
// scale:check on linux:
//   - darwin (BSD time): `-l` prints "N maximum resident set size" (N = BYTES)
//   - linux  (GNU time): `-v` prints "Maximum resident set size (kbytes): N" (N = KBYTES — ×1024 to bytes)
// GNU time has NO `-l` (`/usr/bin/time: invalid option -- 'l'` → exit 125), which crashed the ubuntu
// release gate at scale:check. Detect once; parse RSS per-platform; normalize to bytes so the
// downstream RSS budget + MB/kLOC math is unit-invariant.
//
// Wall time is NOT parsed from /usr/bin/time — it is measured in-process via performance.now() around
// the spawnSync call. spawnSync blocks until the child exits, so t1-t0 is the child's wall time +
// negligible spawn overhead (sub-ms, vs /usr/bin/time's ~10ms granularity). This sidesteps the
// platform-specific elapsed string entirely (BSD "X.XX real" vs GNU "Elapsed (wall clock) time
// (in seconds): M:SS.xx", whose exact sub-format varies by GNU time version — an earlier regex for
// the GNU form returned NaN on the ubuntu runner, failing the gate on wall alone). /usr/bin/time is
// kept ONLY for the child's peak RSS, which a parent cannot read from spawnSync.
const IS_DARWIN = process.platform === 'darwin';
const TIME_FMT = IS_DARWIN ? '-l' : '-v';

// /usr/bin/time exists on posix (BSD `-l` on darwin, GNU `-v` on linux) but NOT on windows — the
// windows-latest runner has no /usr/bin/time on PATH, so `spawnSync('/usr/bin/time', ...)` fails
// with `res.status === null` + empty streams (the spawn itself errors), throwing "crib index exited
// null" before `crib index` ever runs. Probe with existsSync (a real check, not a platform guess) so
// any posix box missing /usr/bin/time falls back to the direct spawn too. When HAS_TIME is false,
// benchIndex spawns `process.execPath CLI index root` directly (node.exe accepts a native path arg —
// same pattern crib-bench/crib-ab-task use safely) and peak RSS is unmeasurable (a sync parent can't
// read a dead child's RSS, and windows has no /usr/bin/time equivalent) → RSS reports N/A and the
// gate skips the RSS budget on windows (see the breach loop). The RSS budget is a linux-production
// characterization; windows CI still proves the pipeline runs at scale + wall/nodes are well-formed.
const HAS_TIME = existsSync('/usr/bin/time');

// The RSS budget baseline is Node-major-aware. The 512 MB baseline was calibrated on Node 22
// (local darwin 471 MB / ubuntu CI under budget for the 20k-LOC slice). Node 24's V8 carries a
// ~1.5× higher baseline (macos-latest Node 24 CI measured 708 MB for the same 483-file slice —
// bounded sub-linear, NOT a pipeline regression), so a 512 MB baseline flakes the gate
// on Node 24+. The per-kLOC SLOPE (marginal RSS per file — the pipeline-dependent part that a
// regression would inflate) is unchanged across Node versions; only the fixed V8/node:sqlite/parser
// BASELINE inflates. So raise the baseline on Node 24+ and keep the slope — the gate stays ACTIVE on
// every runtime (catches super-linear blow-ups + baseline explosions) without flaking on Node-version
// baseline inflation. Project requires Node >=22.5, so Node 24 is a supported runtime.
const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0], 10);
const RSS_BASELINE_MB = NODE_MAJOR >= 24 ? 768 : 512;

/** Peak RSS in bytes from `/usr/bin/time`'s usage block — BSD `-l` reports bytes, GNU `-v` reports
 *  kbytes (×1024 to normalize). A parent cannot read a child's peak RSS through `spawnSync`, so this
 *  parsed stderr is the only channel; it stays NaN when the wrapper is absent (windows), which is why
 *  every RSS consumer guards on `HAS_TIME`. */
function parsePeakRss(stderr) {
  if (!HAS_TIME) return Number.NaN;
  if (IS_DARWIN) {
    const m = /(\d+)\s+maximum resident set size/.exec(stderr);
    return m ? Number.parseInt(m[1], 10) : Number.NaN;
  }
  const m = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  return m ? Number.parseInt(m[1], 10) * 1024 : Number.NaN;
}

/**
 * The embedder's OWN peak RSS, from a child that loads it and embeds one text — nothing else.
 *
 * §9.1 requires the embedder's footprint to be reported **separately**, and §9.4 forbids folding it
 * into the index's. They are different resources: the model is ~2 GB a user cannot avoid if they want
 * semantic search, while the index is bytes this harness budgets at 8 KB per vectorized node. One
 * whole-process `/usr/bin/time` figure cannot separate them, because the embedder runs INSIDE the
 * indexing child — so without this measurement §10.5's 2× peak-RSS budget would be decided by ONNX
 * runtime memory and would fail for a reason that has nothing to do with the index. Measured rather
 * than read from the manifest: the manifest records what was installed, not what it costs resident.
 */
function measureEmbedderFootprint() {
  if (!HAS_TIME) return { rssBytes: Number.NaN, reason: 'no /usr/bin/time on this platform' };
  const child = `
    const { loadInstalledEmbedder } = await import(process.env.KCRIB_CORE_URL);
    const e = await loadInstalledEmbedder();
    if (!e) { process.stdout.write(JSON.stringify({ ok: false })); process.exit(0); }
    e.embed('measure resident footprint');
    process.stdout.write(JSON.stringify({ ok: true, id: e.id }));
  `;
  const res = spawnSync(
    '/usr/bin/time',
    [TIME_FMT, process.execPath, '--input-type=module', '-e', child],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, KCRIB_CORE_URL: coreEntryUrl() },
    },
  );
  if (res.status !== 0) {
    return { rssBytes: Number.NaN, reason: `embedder probe exited ${res.status}` };
  }
  let ok = false;
  try {
    ok = JSON.parse(res.stdout).ok === true;
  } catch {
    /* unparseable → treated as absent below */
  }
  if (!ok) return { rssBytes: Number.NaN, reason: 'no embedder installed' };
  const rssBytes = parsePeakRss(res.stderr || '');
  return Number.isFinite(rssBytes)
    ? { rssBytes }
    : { rssBytes: Number.NaN, reason: 'peak RSS unreadable for the embedder probe' };
}

/** Run a crib CLI command under /usr/bin/time; measure wall (s) in-process, parse peak RSS (bytes)
 *  + crib's summary.
 *
 *  `opts.vectors` appends `--vectors`; `opts.embedCacheDir` sets KCRIB_EMBED_CACHE for the child. The
 *  cache directory is passed in rather than read from the ambient environment so that a COLD run is
 *  provably cold: the caller mints a fresh dir per cold measurement and the same dir for a warm one
 *  (§9.2 — the adapter's cache is keyed by sha256(text), so a second run of the same slice is a warm
 *  run and will be dramatically faster for reasons that have nothing to do with scale). */
function benchIndex(root, opts = {}) {
  const cliArgs = opts.cliArgs ?? ['index', root];
  if (opts.vectors) cliArgs.push('--vectors');
  const env = opts.embedCacheDir
    ? { ...process.env, KCRIB_EMBED_CACHE: opts.embedCacheDir }
    : process.env;
  // /usr/bin/time writes usage to stderr (BSD -l or GNU -v); crib writes its summary to stdout.
  // On windows (HAS_TIME false) spawn crib index directly — node.exe accepts a native path arg, so
  // `process.execPath CLI index root` runs the built CLI with no external time wrapper. Peak RSS is
  // then unmeasurable (NaN); the gate skips the RSS budget when HAS_TIME is false.
  const t0 = performance.now();
  const res = HAS_TIME
    ? spawnSync('/usr/bin/time', [TIME_FMT, process.execPath, CLI, ...cliArgs], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        env,
      })
    : spawnSync(process.execPath, [CLI, ...cliArgs], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        env,
      });
  const t1 = performance.now();
  const stderr = res.stderr || '';
  const stdout = res.stdout || '';
  if (res.status !== 0) {
    throw new Error(`crib ${cliArgs[0]} exited ${res.status}\nstdout:${stdout}\nstderr:${stderr}`);
  }
  // Wall measured in-process (portable, sub-ms) — not parsed from /usr/bin/time's elapsed string.
  const wallS = (t1 - t0) / 1000;
  const peakRssBytes = parsePeakRss(stderr);
  // crib prints: "indexed N files → X nodes, Y edges (...) in Zms"
  const sumMatch =
    /indexed\s+(\d+)\s+files.*?→\s+(\d+)\s+nodes,\s+(\d+)\s+edges.*?in\s+(\d+)\s*ms/.exec(stdout);
  return {
    wallS,
    peakRssBytes,
    files: sumMatch ? Number.parseInt(sumMatch[1], 10) : Number.NaN,
    nodes: sumMatch ? Number.parseInt(sumMatch[2], 10) : Number.NaN,
    edges: sumMatch ? Number.parseInt(sumMatch[3], 10) : Number.NaN,
    cribMs: sumMatch ? Number.parseInt(sumMatch[4], 10) : Number.NaN,
    stdout,
    stderr,
  };
}

/** Build a staged dir replicating FIX × nBatches, return its path. Caller rmSync's it. */
function stageBatches(nBatches) {
  const root = mkdtempSync(join(tmpdir(), 'crib-scale-'));
  for (let i = 0; i < nBatches; i++) cpSync(FIX, join(root, `batch${i}`), { recursive: true });
  return root;
}

// --- vector-arm helpers (WP4 §9.2, §9.3) --------------------------------------------------------

/**
 * The kinds the vector builder SKIPS. Mirrors `DETAIL_NODE_KINDS` in `@knowledge-crib/soul-schema`
 * (sqlite-index.ts:546 `if (isDetailNodeKind(node.kind)) continue`).
 *
 * A mirror can drift from its source, so it is never trusted on its own: the incremental check
 * asserts that, for a real file, `vectors ∩ nodes(file)` is EXACTLY the non-detail nodes of that
 * file. If this list were wrong — too broad or too narrow — that assertion fails on the first slice
 * instead of quietly publishing a wrong "exact" count, which is the failure mode §12 T10 exists for.
 */
const DETAIL_KINDS = new Set([
  'statement',
  'condition',
  'assignment',
  'case-branch',
  'raise',
  'cursor',
  'exception-handler',
  'explanation',
]);

/** Every file under `dir`, recursively. */
function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/** Recursive byte size of a directory (0 when absent). Used for the embed cache (§9.3). */
function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of walkFiles(dir)) {
    try {
      total += statSync(f).size;
    } catch {
      /* a file the adapter pruned mid-walk contributes 0 */
    }
  }
  return total;
}

/** Remove a staged root's `.crib` so the NEXT index run is a true cold build, not a delta (§9.1). */
function clearCrib(root) {
  rmSync(join(root, '.crib'), { recursive: true, force: true });
}

/** The sqlite index inside a staged root, or '' when the run produced none. */
function indexDbPath(root) {
  const crib = join(root, '.crib');
  if (!existsSync(crib)) return '';
  return walkFiles(crib).find((f) => f.endsWith('.sqlite')) ?? '';
}

/** Read-only handle on a staged index. Caller closes. */
function openIndex(root) {
  const p = indexDbPath(root);
  return p ? new DatabaseSync(p, { readOnly: true }) : null;
}

/** Vector rows + the recipe identity the index recorded, for the disk and budget columns (§9.3). */
function vectorStats(root) {
  const db = openIndex(root);
  if (!db) return { vectors: 0, meta: {} };
  try {
    const vectors = db.prepare('SELECT count(*) c FROM vectors').get().c;
    const meta = {};
    for (const r of db.prepare('SELECT k, v FROM vector_meta').all()) meta[r.k] = r.v;
    return { vectors, meta };
  } catch {
    // A lexical index has no `vectors` table at all — that is the incumbent's shape, not an error.
    return { vectors: 0, meta: {} };
  } finally {
    db.close();
  }
}

/** Absolute file URL of the core build, so an out-of-process child imports the REAL store. */
function coreEntryUrl() {
  return pathToFileURL(resolve(REPO, 'packages', 'core', 'dist', 'index.js')).href;
}

/**
 * Representative natural-language code questions for the latency arm (§9.1). Deliberately short
 * symbol-bearing questions rather than the fixture's file contents: the arm measures the CHANNEL's
 * cost (BM25 vs BM25 ∪ cosine + rerank), and a question that is a verbatim file line would favour
 * lexical for reasons that are not about latency.
 */
const QUERY_TEXTS = [
  'where is the request body parsed into a struct',
  'how does the retry backoff get computed',
  'which function opens the database connection',
  'what happens when the config file is missing',
  'how are permissions checked before writing',
  'where is the timestamp formatted for output',
  'how does the cache decide what to evict',
  'which handler validates the incoming payload',
  'how is the error mapped to a status code',
  'where are the default values applied',
];

/**
 * Query p50/p95 on a built index, measured IN-PROCESS.
 *
 * The CLI is deliberately NOT spawned per query: `node <cli> query` costs ~300 ms of startup, which
 * would swamp a p95 measured in tens of milliseconds and would report the runtime instead of the
 * channel. So one child opens the store once and loops — ≥5 warmups then ≥50 measured, the method
 * `perf-gates.md` states. `lexical` passes `semantic:false` (the incumbent C0); `hybrid` injects the
 * installed embedder and passes nothing, so the store fuses BM25 with cosine exactly as a real query
 * against a vectorized index does.
 */
function measureQueryLatency(root, { warmups, iters, mode }) {
  const db = indexDbPath(root);
  if (!db) return null;
  const child = `
    const { SqliteIndexStore, loadInstalledEmbedder } = await import(process.env.KCRIB_CORE_URL);
    const { performance } = await import('node:perf_hooks');
    const embedder = process.env.KCRIB_MODE === 'hybrid' ? await loadInstalledEmbedder() : null;
    const store = new SqliteIndexStore(process.env.KCRIB_Q_DB, { embedder });
    const queries = JSON.parse(process.env.KCRIB_Q_TEXTS);
    const warmups = Number(process.env.KCRIB_Q_WARMUPS);
    const iters = Number(process.env.KCRIB_Q_ITERS);
    const extra = process.env.KCRIB_MODE === 'hybrid' ? {} : { semantic: false };
    const run = (t) => store.query({ text: t, limit: 20, ...extra });
    for (let i = 0; i < warmups; i++) await run(queries[i % queries.length]);
    const times = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await run(queries[i % queries.length]);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
    process.stdout.write(JSON.stringify({ p50: q(0.5), p95: q(0.95), n: times.length }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      KCRIB_CORE_URL: coreEntryUrl(),
      KCRIB_Q_DB: db,
      KCRIB_Q_TEXTS: JSON.stringify(QUERY_TEXTS),
      KCRIB_Q_WARMUPS: String(warmups),
      KCRIB_Q_ITERS: String(iters),
      KCRIB_MODE: mode,
    },
  });
  if (res.status !== 0) {
    return { error: (res.stderr || 'child failed').trim().split('\n').slice(-2).join(' | ') };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: 'unparseable child output' };
  }
}

/** Make a staged root a git work tree with one commit, so `update --dirty` can see an exact delta.
 *  Without this the incremental arm is a fiction: `--dirty` on a non-work-tree degrades to a full
 *  re-index, which would report "the whole corpus" as the cost of a one-file change. */
function gitInitStaged(root) {
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 'scale-bench@local');
  g('config', 'user.name', 'scale-bench');
  g('add', '-A');
  g('commit', '-q', '-m', 'staged fixture');
}

/** Rewrite `n` source files (starting at `from`) with a real content change — a new declaration, so
 *  the delta is semantic rather than a timestamp that content-hashing would ignore. */
function touchSourceFiles(root, n, from = 0) {
  const files = walkFiles(root)
    .filter(
      (f) => SRC_EXTS.has(f.slice(f.lastIndexOf('.'))) && !f.includes(`${sep}node_modules${sep}`),
    )
    .sort();
  const touched = files.slice(from, from + n);
  for (const [i, f] of touched.entries()) {
    appendFileSync(f, `\nexport const scaleBenchTouch${from + i} = ${from + i};\n`);
  }
  return touched.map((f) => f.slice(root.length + 1));
}

/** For the touched files: how many nodes exist, how many are non-detail (the ones the vector builder
 *  embeds), and how many actually carry a vector — plus the index-wide vector total, so "exactly the
 *  changed nodes" can be told apart from "the whole corpus was re-embedded" (§10.5 clause 5). */
function incrementalVectorCounts(root, relPaths) {
  const db = openIndex(root);
  if (!db || relPaths.length === 0) return null;
  try {
    const marks = relPaths.map(() => '?').join(',');
    const total = db.prepare('SELECT count(*) c FROM vectors').get().c;
    const nodeRows = db
      .prepare(`SELECT id, kind FROM nodes WHERE file IN (${marks})`)
      .all(...relPaths);
    const nonDetail = nodeRows.filter((r) => !DETAIL_KINDS.has(r.kind)).length;
    const withVectors = db
      .prepare(
        `SELECT count(*) c FROM vectors WHERE id IN (SELECT id FROM nodes WHERE file IN (${marks}))`,
      )
      .get(...relPaths).c;
    return { total, files: relPaths.length, totalNodes: nodeRows.length, nonDetail, withVectors };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    db.close();
  }
}

/** Fraction of a lexical index's nodes the vector builder will embed, read from the index itself
 *  rather than assumed — the fixture's kind mix is not the repository's. */
function embeddableFraction(root) {
  const db = openIndex(root);
  if (!db) return Number.NaN;
  try {
    const rows = db.prepare('SELECT kind, count(*) c FROM nodes GROUP BY kind').all();
    const total = rows.reduce((s, r) => s + r.c, 0);
    const embeddable = rows.filter((r) => !DETAIL_KINDS.has(r.kind)).reduce((s, r) => s + r.c, 0);
    return total > 0 ? embeddable / total : Number.NaN;
  } catch {
    return Number.NaN;
  } finally {
    db.close();
  }
}

/**
 * The vector arm for one slice (§9.1). Runs only under `--vectors`, so the lexical path above is
 * exactly what it was before this flag existed — which is what §10.5 clause 5's "existing perf gates
 * unchanged" needs to be true of.
 *
 * Order matters and is not arbitrary: cold (fresh cache, fresh table) → warm-cache (same cache, table
 * still rebuilt) → incremental (real content change, git-visible) → query latency on the final index.
 */
function measureVectorArm(staged, targetLoc, lexRow, loc, state) {
  const frac = embeddableFraction(staged);
  const estEmbeddable = Math.round(frac * (lexRow.nodes || 0));
  const projectedMin = Number.isFinite(state.rateS)
    ? (estEmbeddable * state.rateS) / 60
    : Number.NaN;
  const rec = {
    targetLoc,
    loc,
    estEmbeddable,
    projectedMin,
    cacheDir: '',
    cacheBytes: 0,
    vectors: 0,
    meta: {},
    vectorDiskBytes: Number.NaN,
    kbPerNode: Number.NaN,
    coldWallS: Number.NaN,
    coldRssMb: Number.NaN,
    warmWallS: Number.NaN,
    warmRssMb: Number.NaN,
    // The embedder's own footprint, measured in its own child — reported separately (§9.1) and never
    // folded into the index's (§9.4). NaN with a `reason` means the split is unavailable, which makes
    // clause 5b UNPROVEN rather than breached: an unsplit whole-process number cannot decide it.
    embedderRssMb: Number.NaN,
    embedderRssReason: '',
    incremental: [],
    query: null,
    unavailable: '',
  };

  // §9.4 forbids publishing a fit; §8.4's precedent (an underpowered arm is reported as underpowered)
  // is the model here. A slice we cannot afford to measure is recorded as UNAVAILABLE with the
  // measured rate as the reason — never as a projected number dressed up as a result.
  if (Number.isFinite(projectedMin) && projectedMin > vectorMaxMinutes) {
    rec.unavailable = `projected ${projectedMin.toFixed(0)} min for ~${estEmbeddable.toLocaleString()} embeddable nodes at the measured ${(state.rateS * 1000).toFixed(0)} ms/node, over the ${vectorMaxMinutes} min ceiling`;
    return rec;
  }

  // A vector arm that FAILS must not take the lexical curve down with it. The three-outcome model
  // (perf-gates.md: PASS / FAIL / UNAVAILABLE) exists precisely so that "this channel could not be
  // measured" — no embedder installed, cache dir unwritable, the CLI refusing the flag — is recorded
  // as its own outcome rather than thrown away as a crash. Everything measured before the failure is
  // kept; the reason is carried in `unavailable`.
  try {
    runVectorArm(staged, rec, lexRow, state);
  } catch (err) {
    rec.unavailable = `vector arm failed: ${err instanceof Error ? err.message : String(err)}`
      .split('\n')[0]
      .slice(0, 300);
  }
  return rec;
}

/** The measurable part of a vector arm. Split from `measureVectorArm` so the failure above can be
 *  attributed to a channel rather than to the harness. */
function runVectorArm(staged, rec, lexRow, state) {
  // `update --dirty` needs a work tree; on a bare staged dir it degrades to a full re-index, which
  // would report the whole corpus as the cost of a one-file change.
  gitInitStaged(staged);

  // 0. EMBEDDER FOOTPRINT — measured once for the whole run, in its own child, because the model's
  // resident cost does not depend on the slice. `state` carries it across slices so a 3-slice run pays
  // for it once. This is what lets clause 5b compare like with like: the cold figure is a whole-process
  // `/usr/bin/time` peak taken in a child that hosts ONNX, so subtracting this is the only way to read
  // the *index's* RSS out of it.
  if (state.embedderFootprint === undefined) {
    state.embedderFootprint = measureEmbedderFootprint();
  }
  rec.embedderRssMb = state.embedderFootprint.rssBytes / (1024 * 1024);
  rec.embedderRssReason = state.embedderFootprint.reason ?? '';

  // 1. COLD — fresh cache dir, fresh table. The cache dir is recorded so the cold claim is auditable.
  const cacheDir = mkdtempSync(join(tmpdir(), 'crib-embed-cache-'));
  rec.cacheDir = cacheDir;
  clearCrib(staged);
  const cold = benchIndex(staged, { vectors: true, embedCacheDir: cacheDir });
  const vs = vectorStats(staged);
  const coldDb = indexDbPath(staged);
  const coldDbBytes = coldDb ? statSync(coldDb).size : 0;
  rec.vectors = vs.vectors;
  rec.meta = vs.meta;
  rec.coldWallS = cold.wallS;
  rec.coldRssMb = cold.peakRssBytes / (1024 * 1024);
  rec.cacheBytes = dirBytes(cacheDir);
  // Vector disk as the MARGINAL cost over the lexical index at the same slice. The whole db is mostly
  // lexical + FTS; charging all of it to the vector count would understate KB/vectorized-node by an
  // order of magnitude, and that ratio is exactly what §10.5's 8 KB budget is about.
  rec.vectorDiskBytes = coldDbBytes - (lexRow.dbBytes ?? 0);
  rec.kbPerNode = vs.vectors > 0 ? rec.vectorDiskBytes / 1024 / vs.vectors : Number.NaN;
  if (!Number.isFinite(state.rateS) && vs.vectors > 0) state.rateS = cold.wallS / vs.vectors;

  // 2. WARM-CACHE cold — same cache, table still rebuilt (§9.1). Isolates the table rewrite from the
  // model work; a cache that had NOT been populated would make this identical to the cold run.
  clearCrib(staged);
  const warm = benchIndex(staged, { vectors: true, embedCacheDir: cacheDir });
  rec.warmWallS = warm.wallS;
  rec.warmRssMb = warm.peakRssBytes / (1024 * 1024);

  // 3. INCREMENTAL — an exact count, not a ratio (§9.1). One file, then nine more.
  if (doIncremental) {
    for (const [n, from] of [
      [1, 0],
      [9, 1],
    ]) {
      const touched = touchSourceFiles(staged, n, from);
      const before = incrementalVectorCounts(staged, touched);
      const upd = benchIndex(staged, { cliArgs: ['update', '--cwd', staged, '--dirty'] });
      const after = incrementalVectorCounts(staged, touched);
      rec.incremental.push({
        files: n,
        wallS: upd.wallS,
        totalBefore: before?.total ?? Number.NaN,
        totalAfter: after?.total ?? Number.NaN,
        totalNodes: after?.totalNodes ?? Number.NaN,
        nonDetail: after?.nonDetail ?? Number.NaN,
        withVectors: after?.withVectors ?? Number.NaN,
      });
    }
  }

  // 4. QUERY LATENCY — both arms on the SAME index, so the comparison is the channel and not the
  // corpus. `semantic:false` is the incumbent; the default is the fused hybrid.
  rec.query = {
    lexical: measureQueryLatency(staged, {
      warmups: queryWarmups,
      iters: queryIters,
      mode: 'lexical',
    }),
    hybrid: measureQueryLatency(staged, {
      warmups: queryWarmups,
      iters: queryIters,
      mode: 'hybrid',
    }),
  };
}

// --- base fixture LOC (for batch math) ---------------------------------------------------------
const baseLoc = countLoc(FIX).loc;
if (baseLoc <= 0) throw new Error(`fixture LOC count was 0 at ${FIX}`);

// --- run the curve ------------------------------------------------------------------------------
const rows = [];
/** Learned from the first completed vector arm and reused to refuse an unaffordable slice. Absent
 *  until one arm completes, so a slice too big to measure is projected from MEASURED cost or not at
 *  all — never from an assumed constant. */
const vectorState = { rateS: Number.NaN };
process.stdout.write(
  `\n[scale:bench] fixture base = ${baseLoc} LOC across ${countLoc(FIX).files} files; slices = [${slices.join(', ')}] LOC\n`,
);
for (const targetLoc of slices) {
  const nBatches = Math.max(1, Math.ceil(targetLoc / baseLoc));
  process.stdout.write(
    `  slice target=${targetLoc.toLocaleString()} LOC → ${nBatches} batches … staging…\n`,
  );
  const staged = stageBatches(nBatches);
  try {
    const { loc, files } = countLoc(staged);
    process.stdout.write(
      `    staged ${files.toLocaleString()} files, ${loc.toLocaleString()} LOC → indexing…\n`,
    );
    const m = benchIndex(staged);
    const peakRssMb = m.peakRssBytes / (1024 * 1024);
    const rssPerKloc = peakRssMb / (loc / 1000);
    const nodesPerS = m.nodes / m.wallS;
    // Read before the vector arm runs: that arm clears .crib for its own cold measurement, so the
    // lexical db size it is charged against must be captured while this index still exists.
    const lexDb = indexDbPath(staged);
    const row = {
      targetLoc,
      loc,
      files,
      batches: nBatches,
      nodes: m.nodes,
      edges: m.edges,
      wallS: m.wallS,
      cribMs: m.cribMs,
      peakRssMb,
      rssPerKloc,
      nodesPerS,
      dbBytes: lexDb ? statSync(lexDb).size : 0,
      vector: null,
    };
    rows.push(row);
    process.stdout.write(
      `    ✓ ${loc.toLocaleString()} LOC | ${files.toLocaleString()} files | ${m.nodes.toLocaleString()} nodes | ${m.wallS.toFixed(2)}s | peak RSS ${Number.isFinite(peakRssMb) ? `${peakRssMb.toFixed(0)} MB` : 'N/A'} | ${Number.isFinite(rssPerKloc) ? `${rssPerKloc.toFixed(1)} MB/kLOC` : 'N/A'} | ${nodesPerS.toFixed(0)} nodes/s\n`,
    );
    if (wantVectors) {
      process.stdout.write(
        '    vector arm: cold (fresh cache) → warm-cache → incremental → query…\n',
      );
      row.vector = measureVectorArm(staged, targetLoc, row, loc, vectorState);
      const v = row.vector;
      if (v.unavailable) {
        process.stdout.write(`    ⊘ vector arm UNAVAILABLE — ${v.unavailable}\n`);
      } else {
        const ratio =
          Number.isFinite(v.coldWallS) && m.wallS > 0 ? v.coldWallS / m.wallS : Number.NaN;
        process.stdout.write(
          `    ✓ vector | ${v.vectors.toLocaleString()} vectors | cold ${v.coldWallS.toFixed(1)}s (${Number.isFinite(ratio) ? `${ratio.toFixed(1)}× lexical` : 'n/a'}) | warm ${v.warmWallS.toFixed(1)}s | cache ${(v.cacheBytes / 1024 / 1024).toFixed(1)} MB | disk +${Number.isFinite(v.kbPerNode) ? `${v.kbPerNode.toFixed(2)} KB/node` : 'n/a'}\n`,
        );
        for (const inc of v.incremental) {
          const exact = inc.nonDetail === inc.withVectors;
          process.stdout.write(
            `      incremental ${inc.files} file(s): ${inc.wallS.toFixed(2)}s | nodes ${inc.totalNodes} → non-detail ${inc.nonDetail}, vectorized ${inc.withVectors} ${exact ? '(exact)' : '(MISMATCH)'}\n`,
          );
        }
      }
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

// --- optional real-repo data point -------------------------------------------------------------
let repoRow = null;
if (repoPoint) {
  if (!existsSync(repoPoint)) {
    process.stdout.write(
      `\n[scale:bench] --repo ${repoPoint} not found — skipping real-repo point\n`,
    );
  } else {
    process.stdout.write(`\n[scale:bench] real-repo point: ${repoPoint} → indexing full tree…\n`);
    try {
      const { loc, files } = countLoc(repoPoint);
      const m = benchIndex(repoPoint);
      repoRow = {
        path: repoPoint,
        loc,
        files,
        nodes: m.nodes,
        edges: m.edges,
        wallS: m.wallS,
        peakRssMb: m.peakRssBytes / (1024 * 1024),
        nodesPerS: m.nodes / m.wallS,
      };
      process.stdout.write(
        `  ✓ ${loc.toLocaleString()} LOC | ${files.toLocaleString()} files | ${m.nodes.toLocaleString()} nodes | ${m.wallS.toFixed(2)}s | peak RSS ${Number.isFinite(repoRow.peakRssMb) ? `${repoRow.peakRssMb.toFixed(0)} MB` : 'N/A'}\n`,
      );
    } catch (err) {
      process.stdout.write(
        `  real-repo index failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

// --- emit markdown ------------------------------------------------------------------------------
const peak1m = rows.find((r) => r.loc >= 1_000_000);
// Guard NaN (windows: no /usr/bin/time → peakRssMb NaN). Math.max(NaN, x) === NaN would otherwise
// poison maxRss; rssGrowth's divide-by-NaN likewise. Fall back to 0 / 1 so the markdown reads "N/A"
// via the Number.isFinite guards below rather than printing "NaN".
const maxRss = rows.reduce(
  (mx, r) => Math.max(mx, Number.isFinite(r.peakRssMb) ? r.peakRssMb : 0),
  0,
);
const rssGrowth =
  rows.length > 1 && Number.isFinite(rows[0].peakRssMb)
    ? rows[rows.length - 1].peakRssMb / rows[0].peakRssMb
    : 1;

/**
 * Number formatting for the published report.
 *
 * The locale is PINNED, and that is a correctness requirement rather than style. `toLocaleString()`
 * with no argument reads the OPERATOR's locale, and the default for a bare call is not just about
 * separators — on an `en-IN` machine 1,589,248 renders as `15,89,248`, which is not a digit grouping
 * any other reader will recognise as a byte count. `docs/bench/scale-curve.md` is committed
 * evidence, so two operators measuring the same tree must produce the same bytes; a report whose
 * numbers change shape with the machine they were taken on is not reproducible evidence.
 */
function fmt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}
function fmt1(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '—';
}
function fmt2(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—';
}

const lines = [];
lines.push('# Scale curve — `crib index` time + peak RSS vs corpus LOC');
lines.push('');
lines.push(
  '> Generated by `node scripts/scale-bench.mjs`. Method: the 23-file `packages/parsers/fixtures` tree (~858 LOC) replicated into N sibling batches → N×858 LOC of real extracted code, indexed by the built `crib` CLI under `/usr/bin/time` (wall measured in-process via `performance.now()`; peak RSS from BSD `-l` on darwin / GNU `-v` on linux, normalized to bytes). Setup is excluded; only the `crib index` run is timed.',
);
lines.push('');
lines.push(`- **Fixture base:** ${baseLoc} LOC, ${countLoc(FIX).files} files`);
lines.push(`- **Slices:** ${slices.map((s) => s.toLocaleString('en-US')).join(', ')} LOC`);
lines.push(
  `- **Peak RSS across curve:** ${HAS_TIME ? `${maxRss.toFixed(0)} MB` : 'N/A (no /usr/bin/time on this platform)'}`,
);
lines.push(`- **RSS growth (last/first slice):** ${HAS_TIME ? `${rssGrowth.toFixed(2)}×` : 'N/A'}`);
lines.push(
  peak1m
    ? `- **1M-LOC point:** ${Number.isFinite(peak1m.peakRssMb) ? `${peak1m.peakRssMb.toFixed(0)} MB peak RSS, ` : ''}${peak1m.wallS.toFixed(1)}s wall, ${peak1m.nodes.toLocaleString('en-US')} nodes`
    : '- **1M-LOC point:** not in this run',
);
lines.push('');
lines.push(
  '| Target LOC | Actual LOC | Files | Batches | Nodes | Edges | Wall (s) | crib ms | Peak RSS (MB) | MB / kLOC | Nodes / s |',
);
lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  lines.push(
    `| ${fmt(r.targetLoc)} | ${fmt(r.loc)} | ${fmt(r.files)} | ${fmt(r.batches)} | ${fmt(r.nodes)} | ${fmt(r.edges)} | ${fmt2(r.wallS)} | ${fmt(r.cribMs)} | ${fmt(r.peakRssMb)} | ${fmt1(r.rssPerKloc)} | ${fmt(Math.round(r.nodesPerS))} |`,
  );
}
if (repoRow) {
  lines.push('');
  lines.push('## Real-repo cross-check');
  lines.push('');
  lines.push('| Repo | LOC | Files | Nodes | Wall (s) | Peak RSS (MB) | Nodes / s |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  lines.push(
    `| ${repoRow.path} | ${fmt(repoRow.loc)} | ${fmt(repoRow.files)} | ${fmt(repoRow.nodes)} | ${fmt2(repoRow.wallS)} | ${fmt(repoRow.peakRssMb)} | ${fmt(Math.round(repoRow.nodesPerS))} |`,
  );
}
const vectorRows = rows.filter((r) => r.vector);
if (wantVectors) {
  lines.push('');
  lines.push('## Vector arm (WP4 §9.1)');
  lines.push('');
  lines.push(
    '> Method: every **cold** measurement runs with `KCRIB_EMBED_CACHE` pointed at a freshly created directory, and the directory is recorded below. This is not decoration — the adapter cache is keyed by `sha256(text)` (§9.2), so a second run over the same slice is a **warm** run, and reporting it as cold would understate the cold cost by the entire embedding pass. The warm-cache column is the same measurement with the cache deliberately reused and the table still rebuilt.',
  );
  lines.push('');
  lines.push(
    '> Peak RSS is reported **whole-process** (`/usr/bin/time` in the indexing child) **and decomposed**: the embedder column is the same model loaded and exercised in a child of its own, so `Index-side (MB)` is the whole-process peak minus the model — the number §10.5 clause 5 is actually about. The decomposition is labelled an estimate because a resident model and a live indexing pass do not simply add, and §9.4 forbids folding the embedder into the index: they are different resources with different lifecycles, and a user who wants semantic search cannot avoid the model. When the split is unavailable the clause is reported **UNPROVEN**, never breached — an unsplit figure cannot decide it. Disk is reported as the **marginal** index bytes over the lexical index at the same slice, plus the embed-cache bytes as a distinct artifact with a distinct lifecycle (§9.3).',
  );
  lines.push('');
  lines.push(
    '| Target LOC | Vectors | Cold (s) | Cold ÷ lexical | Warm-cache (s) | Peak RSS (MB) | Embedder (MB) | Index-side (MB) | Index Δ (KB/node) | Cache (MB) |',
  );
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of vectorRows) {
    const v = r.vector;
    if (v.unavailable) {
      lines.push(`| ${fmt(r.targetLoc)} | — | *UNAVAILABLE* | — | — | — | — | — | — | — |`);
      continue;
    }
    const ratio = r.wallS > 0 ? v.coldWallS / r.wallS : Number.NaN;
    const indexSideMb =
      Number.isFinite(v.embedderRssMb) && Number.isFinite(v.coldRssMb)
        ? v.coldRssMb - v.embedderRssMb
        : Number.NaN;
    lines.push(
      `| ${fmt(r.targetLoc)} | ${fmt(v.vectors)} | ${fmt2(v.coldWallS)} | ${fmt1(ratio)}× | ${fmt2(v.warmWallS)} | ${fmt(v.coldRssMb)} | ${Number.isFinite(v.embedderRssMb) ? fmt(v.embedderRssMb) : '*n/a*'} | ${Number.isFinite(indexSideMb) ? fmt(indexSideMb) : '*n/a*'} | ${fmt2(v.kbPerNode)} | ${fmt(v.cacheBytes / 1024 / 1024)} |`,
    );
  }
  lines.push('');
  const unavailable = vectorRows.filter((r) => r.vector.unavailable);
  if (unavailable.length > 0) {
    lines.push('**Not measured, and why** (§9.4 forbids extrapolating a curve):');
    lines.push('');
    for (const r of unavailable) {
      lines.push(`- ${fmt(r.targetLoc)} LOC — ${r.vector.unavailable}`);
    }
    lines.push('');
  }
  lines.push('### Incremental update (exact node count, not a ratio)');
  lines.push('');
  lines.push(
    "§10.5 clause 5 requires that an incremental update writes vectors for **exactly** the changed non-detail nodes. The check is self-verifying rather than trusting a copied constant: if the harness's `DETAIL_KINDS` mirror drifted from `soul-schema`, `non-detail` and `vectorized` would disagree on the first slice.",
  );
  lines.push('');
  lines.push(
    '| Target LOC | Files changed | Wall (s) | Nodes in files | Non-detail (expected) | Vectorized (actual) | Verdict |',
  );
  lines.push('|---:|---:|---:|---:|---:|---:|:--|');
  for (const r of vectorRows) {
    for (const inc of r.vector.incremental ?? []) {
      const exact = inc.nonDetail === inc.withVectors;
      lines.push(
        `| ${fmt(r.targetLoc)} | ${fmt(inc.files)} | ${fmt2(inc.wallS)} | ${fmt(inc.totalNodes)} | ${fmt(inc.nonDetail)} | ${fmt(inc.withVectors)} | ${exact ? 'exact' : '**MISMATCH**'} |`,
      );
    }
  }
  lines.push('');
  lines.push('### Query latency (p50 / p95 ms, warm, same index, same run)');
  lines.push('');
  lines.push(
    `> Method: \`${queryWarmups}\` warmup iterations discarded, then \`${queryIters}\` measured, \`fresh=false\`, driven in-process against the built store so node startup is not counted as query time. Both arms run against the **same** index, so the difference is the channel and not the corpus.`,
  );
  lines.push('');
  lines.push('| Target LOC | Lexical p50 | Lexical p95 | Hybrid p50 | Hybrid p95 | p95 ratio |');
  lines.push('|---:|---:|---:|---:|---:|:--|');
  for (const r of vectorRows) {
    const q = r.vector.query;
    if (!q?.lexical || q.lexical.error) {
      lines.push(`| ${fmt(r.targetLoc)} | — | — | — | — | *UNAVAILABLE* |`);
      continue;
    }
    const ratio =
      q.hybrid && !q.hybrid.error && q.lexical.p95 > 0 ? q.hybrid.p95 / q.lexical.p95 : Number.NaN;
    lines.push(
      `| ${fmt(r.targetLoc)} | ${fmt2(q.lexical.p50)} | ${fmt2(q.lexical.p95)} | ${Number.isFinite(q.hybrid?.p50) ? fmt2(q.hybrid.p50) : '—'} | ${Number.isFinite(q.hybrid?.p95) ? fmt2(q.hybrid.p95) : '—'} | ${Number.isFinite(ratio) ? `${ratio.toFixed(2)}×` : '—'} |`,
    );
  }
  lines.push('');
  lines.push('### Cache directories measured (cold runs)');
  lines.push('');
  for (const r of vectorRows) {
    if (r.vector.cacheDir) {
      lines.push(
        `- ${fmt(r.targetLoc)} LOC → \`${r.vector.cacheDir}\` (${fmt(r.vector.cacheBytes)} bytes)`,
      );
    }
  }
}
lines.push('');
lines.push('## Reading the curve');
lines.push('');
lines.push(
  '- **Peak RSS vs LOC** is the load-bearing column. If RSS-per-kLOC stays roughly flat (RSS grows ~linearly with LOC but the *rate* is constant and modest), the pipeline streams + the sqlite index is disk-backed → a single soul is fine at this scale. If RSS-per-kLOC *climbs* with LOC (super-linear), per-file state is accumulating in memory → per-module souls / lazy shard loading are warranted.',
);
lines.push(
  '- **Nodes/s** is throughput; it should stay roughly constant (per-file parse is O(file size), pipeline is a stream). A throughput *drop* at large N signals GC pressure or an O(N²) link/cluster phase.',
);
lines.push('');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${lines.join('\n')}\n`);
process.stdout.write(
  `\n[scale:bench] wrote ${outPath} (${rows.length} slice(s)${repoRow ? ' + 1 real-repo point' : ''})\n`,
);

// --- gate assertions (exit non-zero on a bound breach) -----------------------------------------
// A bounded-RSS gate: peak RSS must stay under a per-slice budget that scales gently with LOC.
// The budget is generous (4 MB/kLOC slope + RSS_BASELINE_MB) — the gate proves the harness runs +
// the pipeline doesn't blow up, NOT that memory is tiny.
// RSS_BASELINE_MB is Node-major-aware (768 MB on Node 24+, 512 MB on Node ≤23) so Node 24's higher
// V8 baseline doesn't flake the gate; the 4 MB/kLOC slope (the pipeline-dependent marginal RSS a
// regression would inflate) is unchanged across Node versions.
let breach = 0;
// UNPROVEN is tracked separately from BREACH, and deliberately does NOT set the exit code — the
// three-outcome model (perf-gates.md) keeps "the channel could not be measured" distinct from "the
// channel was measured and is worse". But it must still be visible in the verdict line: a run that
// breaches nothing because it could not measure is not a passing run.
let unproven = 0;
for (const r of rows) {
  if (HAS_TIME) {
    const budgetMb = RSS_BASELINE_MB + 4 * (r.loc / 1000);
    if (r.peakRssMb > budgetMb) {
      process.stderr.write(
        `  scale:bench BOUND BREACH — ${r.loc.toLocaleString()} LOC: peak RSS ${r.peakRssMb.toFixed(0)} MB > budget ${budgetMb.toFixed(0)} MB (4 MB/kLOC + ${RSS_BASELINE_MB} MB baseline; Node ${NODE_MAJOR})\n`,
      );
      breach++;
    }
    if (!Number.isFinite(r.wallS) || !Number.isFinite(r.peakRssMb) || !Number.isFinite(r.nodes)) {
      process.stderr.write(
        `  scale:bench PARSE FAIL — ${r.loc.toLocaleString()} LOC: missing wall/RSS/nodes\n`,
      );
      breach++;
    }
  } else {
    // No /usr/bin/time (windows) → peak RSS unmeasurable. Still assert the pipeline ran + produced a
    // node count + a finite wall. The RSS budget is a posix-production characterization; windows CI
    // proves the harness runs at scale without the memory cap. Precedent: parallel:check bars its
    // platform-irrelevant timing floor on CI (GITHUB_ACTIONS).
    if (!Number.isFinite(r.wallS) || !Number.isFinite(r.nodes)) {
      process.stderr.write(
        `  scale:bench PARSE FAIL — ${r.loc.toLocaleString()} LOC: missing wall/nodes\n`,
      );
      breach++;
    }
  }
}
// --- §10.5 resource budgets for the vector arm --------------------------------------------------
// Only the clauses this harness can actually observe. The discrimination, minimum-effect, exact-R@1
// and latency clauses live in the retrieval harnesses (that is where a quality claim can be made);
// asserting them here would be asserting them twice, in the weaker place.
if (wantVectors) {
  for (const r of rows) {
    const v = r.vector;
    if (!v) continue;
    if (v.unavailable) {
      process.stderr.write(
        `  scale:bench §10.5 UNPROVEN — ${r.loc.toLocaleString()} LOC vector arm not measured: ${v.unavailable}\n`,
      );
      unproven++;
      continue;
    }
    // Clause 5a: cold index (vector) ≤ 20× the lexical wall at the SAME slice. Same slice, same
    // machine, same run — comparing across slices would compare two different corpora.
    if (r.wallS > 0 && v.coldWallS / r.wallS > 20) {
      process.stderr.write(
        `  scale:bench §10.5 BREACH — ${r.loc.toLocaleString()} LOC: cold vector ${v.coldWallS.toFixed(1)}s is ${(v.coldWallS / r.wallS).toFixed(1)}× the lexical ${r.wallS.toFixed(1)}s, over the 20× budget\n`,
      );
      breach++;
    }
    // Clause 5b: peak RSS (vector) ≤ 2× the lexical peak. Evaluated on the INDEX-side figure, not the
    // whole-process one: the embedded model is resident in the same child, and §9.1/§9.4 require its
    // footprint to be reported separately rather than charged to the index. Comparing the raw
    // whole-process peak against the lexical peak would fail this clause on ONNX runtime memory alone,
    // for a reason that has nothing to do with the index — the failure §9.4 names.
    const indexSideMb =
      Number.isFinite(v.embedderRssMb) && Number.isFinite(v.coldRssMb)
        ? v.coldRssMb - v.embedderRssMb
        : Number.NaN;
    if (!HAS_TIME) {
      // No /usr/bin/time → no RSS at all. Three-outcome model: not measurable is not breached.
      process.stderr.write(
        `  scale:bench §10.5 UNPROVEN — ${r.loc.toLocaleString()} LOC: clause 5b (peak RSS) — no /usr/bin/time on this platform\n`,
      );
      unproven++;
    } else if (!Number.isFinite(indexSideMb)) {
      process.stderr.write(
        `  scale:bench §10.5 UNPROVEN — ${r.loc.toLocaleString()} LOC: clause 5b (peak RSS) — embedder split unavailable (${v.embedderRssReason || 'reason not recorded'}), so the whole-process ${v.coldRssMb.toFixed(0)} MB cannot be attributed to the index\n`,
      );
      unproven++;
    } else if (Number.isFinite(r.peakRssMb) && r.peakRssMb > 0 && indexSideMb / r.peakRssMb > 2) {
      process.stderr.write(
        `  scale:bench §10.5 BREACH — ${r.loc.toLocaleString()} LOC: vector index-side RSS ${indexSideMb.toFixed(0)} MB is ${(indexSideMb / r.peakRssMb).toFixed(2)}× the lexical ${r.peakRssMb.toFixed(0)} MB, over the 2× budget (whole-process ${v.coldRssMb.toFixed(0)} MB less embedder ${v.embedderRssMb.toFixed(0)} MB)\n`,
      );
      breach++;
    }
    // Clause 5c: disk ≤ 8 KB per vectorized node at dim 1024 — index and cache SEPARATELY (§9.3),
    // because a cache is disposable and an index is not.
    if (v.vectors > 0 && Number.isFinite(v.kbPerNode) && v.kbPerNode > 8) {
      process.stderr.write(
        `  scale:bench §10.5 BREACH — ${r.loc.toLocaleString()} LOC: index Δ ${v.kbPerNode.toFixed(2)} KB/vectorized node, over the 8 KB budget\n`,
      );
      breach++;
    }
    const kbPerVectorCache = v.vectors > 0 ? v.cacheBytes / 1024 / v.vectors : Number.NaN;
    if (Number.isFinite(kbPerVectorCache) && kbPerVectorCache > 8) {
      process.stderr.write(
        `  scale:bench §10.5 BREACH — ${r.loc.toLocaleString()} LOC: embed cache ${kbPerVectorCache.toFixed(2)} KB/vectorized node, over the 8 KB budget\n`,
      );
      breach++;
    }
    // Clause 5d: the incremental update wrote vectors for exactly the changed non-detail nodes.
    for (const inc of v.incremental) {
      if (inc.nonDetail !== inc.withVectors) {
        process.stderr.write(
          `  scale:bench §10.5 BREACH — ${r.loc.toLocaleString()} LOC: incremental over ${inc.files} file(s) vectorized ${inc.withVectors} of ${inc.nonDetail} non-detail nodes — not an exact count\n`,
        );
        breach++;
      }
    }
  }
}

if (breach > 0) {
  process.stderr.write(`\n[scale:bench] ${breach} bound breach(es) — see above\n`);
  if (unproven > 0) {
    process.stderr.write(
      `[scale:bench] plus ${unproven} clause(s) UNPROVEN (not measurable here)\n`,
    );
  }
  process.exit(1);
}
if (unproven > 0) {
  // Not a pass, and not a failure: some clause could not be measured. Exit 0 keeps the existing
  // contract (an unmeasurable channel must not fail the lexical curve), and the line refuses to claim
  // more than was established.
  process.stdout.write(
    `[scale:bench] PASS-with-caveats — all measured slices within budget; ${unproven} §10.5 clause(s) UNPROVEN here (see stderr)\n`,
  );
  process.exit(0);
}
process.stdout.write(
  HAS_TIME
    ? '[scale:bench] PASS — all slices within RSS budget, measurements well-formed\n'
    : '[scale:bench] PASS — all slices well-formed (RSS N/A: no /usr/bin/time on this platform)\n',
);
