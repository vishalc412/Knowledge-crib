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
 * MEASUREMENT — each slice is indexed by the BUILT `crib` CLI under `/usr/bin/time`, which prints
 * wall seconds + peak RSS for the child node process. The flag + output format differ by platform
 * (BSD `-l` on darwin vs GNU `-v` on linux; GNU reports RSS in kbytes, BSD in bytes — normalized to
 * bytes in benchIndex), so the harness is cross-platform. The crib CLI also prints
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
//   - darwin (BSD time): `-l` prints "X.XX real" (wall s) + "N maximum resident set size" (N = BYTES)
//   - linux  (GNU time): `-v` prints "Elapsed (wall clock) time (in seconds): M:SS.xx" +
//                          "Maximum resident set size (kbytes): N" (N = KBYTES — ×1024 to bytes)
// GNU time has NO `-l` (`/usr/bin/time: invalid option -- 'l'` → exit 125), which crashed the ubuntu
// release gate at scale:check. Detect once; parse per-platform; normalize RSS to bytes so the
// downstream RSS budget + MB/kLOC math is unit-invariant.
const IS_DARWIN = process.platform === 'darwin';
const TIME_FMT = IS_DARWIN ? '-l' : '-v';

/** Run `crib index <root>` under /usr/bin/time; parse wall (s), peak RSS (bytes), crib's summary. */
function benchIndex(root) {
  // /usr/bin/time writes usage to stderr (BSD -l or GNU -v); crib writes its summary to stdout.
  const res = spawnSync('/usr/bin/time', [TIME_FMT, process.execPath, CLI, 'index', root], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const stderr = res.stderr || '';
  const stdout = res.stdout || '';
  if (res.status !== 0) {
    throw new Error(`crib index exited ${res.status}\nstdout:${stdout}\nstderr:${stderr}`);
  }
  let wallS = Number.NaN;
  let peakRssBytes = Number.NaN;
  if (IS_DARWIN) {
    const realMatch = /([\d.]+)\s+real/.exec(stderr);
    const rssMatch = /(\d+)\s+maximum resident set size/.exec(stderr);
    wallS = realMatch ? Number.parseFloat(realMatch[1]) : Number.NaN;
    peakRssBytes = rssMatch ? Number.parseInt(rssMatch[1], 10) : Number.NaN;
  } else {
    // GNU time -v: "Elapsed (wall clock) time (in seconds): M:SS.xx" (M = minutes; H:MM:SS.xx is
    // not expected for these slices — scale:check runs a ~20k-LOC slice that indexes in well under a
    // minute). Parse minutes + seconds.MM → seconds.
    const elap = /Elapsed \(wall clock\) time \(in seconds\):\s*(\d+):(\d+\.\d+)/.exec(stderr);
    wallS = elap ? Number.parseInt(elap[1], 10) * 60 + Number.parseFloat(elap[2]) : Number.NaN;
    // GNU time -v reports RSS in KILOBYTES (BSD -l reports bytes); ×1024 to normalize to bytes.
    const gnuRss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
    peakRssBytes = gnuRss ? Number.parseInt(gnuRss[1], 10) * 1024 : Number.NaN;
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
      `    ✓ ${loc.toLocaleString()} LOC | ${files.toLocaleString()} files | ${m.nodes.toLocaleString()} nodes | ${m.wallS.toFixed(2)}s | peak RSS ${peakRssMb.toFixed(0)} MB | ${rssPerKloc.toFixed(1)} MB/kLOC | ${nodesPerS.toFixed(0)} nodes/s\n`,
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
        `  ✓ ${loc.toLocaleString()} LOC | ${files.toLocaleString()} files | ${m.nodes.toLocaleString()} nodes | ${m.wallS.toFixed(2)}s | peak RSS ${repoRow.peakRssMb.toFixed(0)} MB\n`,
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
const maxRss = rows.reduce((mx, r) => Math.max(mx, r.peakRssMb), 0);
const rssGrowth = rows.length > 1 ? rows[rows.length - 1].peakRssMb / rows[0].peakRssMb : 1;

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
  '> Generated by `node scripts/scale-bench.mjs`. Method: the 23-file `packages/parsers/fixtures` tree (~858 LOC) replicated into N sibling batches → N×858 LOC of real extracted code, indexed by the built `crib` CLI under `/usr/bin/time` (BSD `-l` on darwin, GNU `-v` on linux; RSS normalized to bytes). Setup is excluded; only the `crib index` run is timed. See ADR-002 for the storage decision this curve drives.',
);
lines.push('');
lines.push(`- **Fixture base:** ${baseLoc} LOC, ${countLoc(FIX).files} files`);
lines.push(`- **Slices:** ${slices.map((s) => s.toLocaleString()).join(', ')} LOC`);
lines.push(`- **Peak RSS across curve:** ${maxRss.toFixed(0)} MB`);
lines.push(`- **RSS growth (last/first slice):** ${rssGrowth.toFixed(2)}×`);
lines.push(
  peak1m
    ? `- **1M-LOC point:** ${peak1m.peakRssMb.toFixed(0)} MB peak RSS, ${peak1m.wallS.toFixed(1)}s wall, ${peak1m.nodes.toLocaleString()} nodes`
    : '- **1M-LOC point:** not in this run',
);
lines.push('');
lines.push(
  '| Target LOC | Actual LOC | Files | Batches | Nodes | Edges | Wall (s) | crib ms | Peak RSS (MB) | MB / kLOC | Nodes / s |',
);
lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  lines.push(
    `| ${fmt(r.targetLoc)} | ${fmt(r.loc)} | ${fmt(r.files)} | ${fmt(r.batches)} | ${fmt(r.nodes)} | ${fmt(r.edges)} | ${fmt2(r.wallS)} | ${fmt(r.cribMs)} | ${r.peakRssMb.toFixed(0)} | ${fmt1(r.rssPerKloc)} | ${fmt(Math.round(r.nodesPerS))} |`,
  );
}
if (repoRow) {
  lines.push('');
  lines.push('## Real-repo cross-check');
  lines.push('');
  lines.push('| Repo | LOC | Files | Nodes | Wall (s) | Peak RSS (MB) | Nodes / s |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  lines.push(
    `| ${repoRow.path} | ${fmt(repoRow.loc)} | ${fmt(repoRow.files)} | ${fmt(repoRow.nodes)} | ${fmt2(repoRow.wallS)} | ${repoRow.peakRssMb.toFixed(0)} | ${fmt(Math.round(repoRow.nodesPerS))} |`,
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
// The budget is generous (4 MB/kLOC + 512 MB baseline) — the gate proves the harness runs + the
// pipeline doesn't blow up, NOT that memory is tiny. The ADR interprets the actual numbers.
let breach = 0;
for (const r of rows) {
  const budgetMb = 512 + 4 * (r.loc / 1000);
  if (r.peakRssMb > budgetMb) {
    process.stderr.write(
      `  scale:bench BOUND BREACH — ${r.loc.toLocaleString()} LOC: peak RSS ${r.peakRssMb.toFixed(0)} MB > budget ${budgetMb.toFixed(0)} MB (4 MB/kLOC + 512 MB baseline)\n`,
    );
    breach++;
  }
  if (!Number.isFinite(r.wallS) || !Number.isFinite(r.peakRssMb) || !Number.isFinite(r.nodes)) {
    process.stderr.write(
      `  scale:bench PARSE FAIL — ${r.loc.toLocaleString()} LOC: missing wall/RSS/nodes\n`,
    );
    breach++;
  }
}
if (breach > 0) {
  process.stderr.write(`\n[scale:bench] ${breach} bound breach(es) — see above\n`);
  process.exit(1);
}
process.stdout.write(
  '[scale:bench] PASS — all slices within RSS budget, measurements well-formed\n',
);
