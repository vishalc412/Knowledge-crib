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
 * ADR-002 records this method. `--repo <path>` indexes a real public repo at full size as a
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
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

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
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--slices' && argv[i + 1]) {
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
// bounded sub-linear per ADR-002, NOT a pipeline regression), so a 512 MB baseline flakes the gate
// on Node 24+. The per-kLOC SLOPE (marginal RSS per file — the pipeline-dependent part that a
// regression would inflate) is unchanged across Node versions; only the fixed V8/node:sqlite/parser
// BASELINE inflates. So raise the baseline on Node 24+ and keep the slope — the gate stays ACTIVE on
// every runtime (catches super-linear blow-ups + baseline explosions) without flaking on Node-version
// baseline inflation. Project requires Node >=22.5, so Node 24 is a supported runtime.
const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0], 10);
const RSS_BASELINE_MB = NODE_MAJOR >= 24 ? 768 : 512;

/** Run `crib index <root>` under /usr/bin/time; measure wall (s) in-process, parse peak RSS (bytes)
 *  + crib's summary. */
function benchIndex(root) {
  // /usr/bin/time writes usage to stderr (BSD -l or GNU -v); crib writes its summary to stdout.
  // On windows (HAS_TIME false) spawn crib index directly — node.exe accepts a native path arg, so
  // `process.execPath CLI index root` runs the built CLI with no external time wrapper. Peak RSS is
  // then unmeasurable (NaN); the gate skips the RSS budget when HAS_TIME is false.
  const t0 = performance.now();
  const res = HAS_TIME
    ? spawnSync('/usr/bin/time', [TIME_FMT, process.execPath, CLI, 'index', root], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      })
    : spawnSync(process.execPath, [CLI, 'index', root], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
  const t1 = performance.now();
  const stderr = res.stderr || '';
  const stdout = res.stdout || '';
  if (res.status !== 0) {
    throw new Error(`crib index exited ${res.status}\nstdout:${stdout}\nstderr:${stderr}`);
  }
  // Wall measured in-process (portable, sub-ms) — not parsed from /usr/bin/time's elapsed string.
  const wallS = (t1 - t0) / 1000;
  // Peak RSS from /usr/bin/time (a parent can't read a child's peak RSS via spawnSync): BSD -l
  // reports bytes; GNU -v reports kbytes (×1024 to normalize to bytes). Unavailable on windows
  // (HAS_TIME false → direct spawn, no time wrapper) → stays NaN; the gate skips the RSS budget.
  let peakRssBytes = Number.NaN;
  if (HAS_TIME) {
    if (IS_DARWIN) {
      const rssMatch = /(\d+)\s+maximum resident set size/.exec(stderr);
      peakRssBytes = rssMatch ? Number.parseInt(rssMatch[1], 10) : Number.NaN;
    } else {
      const gnuRss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
      peakRssBytes = gnuRss ? Number.parseInt(gnuRss[1], 10) * 1024 : Number.NaN;
    }
  }
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

// --- base fixture LOC (for batch math) ---------------------------------------------------------
const baseLoc = countLoc(FIX).loc;
if (baseLoc <= 0) throw new Error(`fixture LOC count was 0 at ${FIX}`);

// --- run the curve ------------------------------------------------------------------------------
const rows = [];
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
    rows.push({
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
    });
    process.stdout.write(
      `    ✓ ${loc.toLocaleString()} LOC | ${files.toLocaleString()} files | ${m.nodes.toLocaleString()} nodes | ${m.wallS.toFixed(2)}s | peak RSS ${Number.isFinite(peakRssMb) ? `${peakRssMb.toFixed(0)} MB` : 'N/A'} | ${Number.isFinite(rssPerKloc) ? `${rssPerKloc.toFixed(1)} MB/kLOC` : 'N/A'} | ${nodesPerS.toFixed(0)} nodes/s\n`,
    );
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

function fmt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—';
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
  '> Generated by `node scripts/scale-bench.mjs`. Method: the 23-file `packages/parsers/fixtures` tree (~858 LOC) replicated into N sibling batches → N×858 LOC of real extracted code, indexed by the built `crib` CLI under `/usr/bin/time` (wall measured in-process via `performance.now()`; peak RSS from BSD `-l` on darwin / GNU `-v` on linux, normalized to bytes). Setup is excluded; only the `crib index` run is timed. See ADR-002 for the storage decision this curve drives.',
);
lines.push('');
lines.push(`- **Fixture base:** ${baseLoc} LOC, ${countLoc(FIX).files} files`);
lines.push(`- **Slices:** ${slices.map((s) => s.toLocaleString()).join(', ')} LOC`);
lines.push(
  `- **Peak RSS across curve:** ${HAS_TIME ? `${maxRss.toFixed(0)} MB` : 'N/A (no /usr/bin/time on this platform)'}`,
);
lines.push(`- **RSS growth (last/first slice):** ${HAS_TIME ? `${rssGrowth.toFixed(2)}×` : 'N/A'}`);
lines.push(
  peak1m
    ? `- **1M-LOC point:** ${Number.isFinite(peak1m.peakRssMb) ? `${peak1m.peakRssMb.toFixed(0)} MB peak RSS, ` : ''}${peak1m.wallS.toFixed(1)}s wall, ${peak1m.nodes.toLocaleString()} nodes`
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
// the pipeline doesn't blow up, NOT that memory is tiny. The ADR interprets the actual numbers.
// RSS_BASELINE_MB is Node-major-aware (768 MB on Node 24+, 512 MB on Node ≤23) so Node 24's higher
// V8 baseline doesn't flake the gate; the 4 MB/kLOC slope (the pipeline-dependent marginal RSS a
// regression would inflate) is unchanged across Node versions.
let breach = 0;
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
if (breach > 0) {
  process.stderr.write(`\n[scale:bench] ${breach} bound breach(es) — see above\n`);
  process.exit(1);
}
process.stdout.write(
  HAS_TIME
    ? '[scale:bench] PASS — all slices within RSS budget, measurements well-formed\n'
    : '[scale:bench] PASS — all slices well-formed (RSS N/A: no /usr/bin/time on this platform)\n',
);
