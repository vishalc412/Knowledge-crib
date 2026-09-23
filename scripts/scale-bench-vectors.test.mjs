import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * WP4 §12 T9 / T10 — the vector arm of `scripts/scale-bench.mjs`.
 *
 * T9: a `--vectors` run records the cache directory AND its byte size, and a warm-cache run is
 *     reported as warm-cache (i.e. the cold column is not silently a second warm run).
 * T10: an incremental update writes vectors for exactly the changed nodes.
 *
 * Why this test drives the REAL harness at a real slice instead of asserting on a fixture of the
 * report: both properties are properties of the measurement, not of the formatting. A mock would
 * happily agree that a fresh cache directory was created while the harness passed an empty env, and
 * would happily agree that the counts were exact while the mirror in `DETAIL_KINDS` had drifted from
 * `soul-schema` — the two ways these columns can lie. A slice of the replicated fixture is cheap
 * (two batches, ~1.7k LOC) and exercises the whole path: cache dir creation, `KCRIB_EMBED_CACHE`
 * injection, the git-init'd staged tree, `update --dirty`, and the sqlite reads behind the counts.
 *
 * SKIPS RATHER THAN FAILS when no embedding tier is installed. That is not leniency: with no tier the
 * vector channel genuinely cannot be measured, and the harness's contract for that case is to say so
 * (§9.4's three-outcome model — "could not be measured" is a distinct outcome from "measured and
 * worse"). The test asserts THAT contract in the skip branch, so the skip is itself a check.
 *
 * Evidence for §12's method note ("a new test is credited only after it is shown to fail against the
 * pre-change code"): before this change `scripts/scale-bench.mjs` had no `--vectors` flag, so the
 * first assertion below — that the flag produces a vector section at all — fails against the
 * pre-change harness by construction. Recorded in the evidence register as T9/T10.
 *
 * Run: node scripts/scale-bench-vectors.test.mjs
 */
const REPO = resolve(import.meta.dirname, '..');
const BENCH = join(REPO, 'scripts', 'scale-bench.mjs');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'cli.js');
const MANIFEST = join(homedir(), '.crib', 'embed', 'manifest.json');

/** A slice of two fixture batches: small enough to run in a test, wide enough that the incremental
 *  step has more than one candidate file and the "exactly the changed nodes" claim has content. */
const SLICE = 900;

/** The embedding tier is resolved from the user's embed home; absent there is no vector channel. */
function embedderInstalled() {
  return existsSync(MANIFEST);
}

function runBench(args) {
  const out = join(mkdtempSync(join(tmpdir(), 'scale-vectors-test-')), 'curve.md');
  const res = spawnSync(process.execPath, [BENCH, ...args, '--out', out], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { res, out, report: existsSync(out) ? readFileSync(out, 'utf8') : '' };
}

/** The markdown section between a `## ` heading and the next one. */
function section(report, heading) {
  const start = report.indexOf(heading);
  if (start < 0) return '';
  const rest = report.slice(start + heading.length);
  const end = rest.indexOf('\n## ');
  return end < 0 ? rest : rest.slice(0, end);
}

/** Header cells of the one table in a section that carries a column called `name`.
 *
 *  Identified BY NAME rather than by position, for two separate reasons that both bit:
 *   - the slice table gained the embedder decomposition columns, and a positional destructure would
 *     have gone on parsing happily while reading the wrong cell;
 *   - `## Vector arm` holds FOUR tables (slice, incremental, query, cache dirs), so "every `|` line
 *     in the section" is not a table and never was — reading it that way counted the other tables'
 *     data rows *and* left their header rows in as data. That is a wrong count, not a wrong cell,
 *     which is how it surfaced: `expected one slice row, got 6`. */
function tableHeader(sectionText, name) {
  const header = sectionText
    .split('\n')
    .find((l) => l.startsWith('|') && l.split('|').includes(` ${name} `));
  assert.ok(
    header,
    `no table in this section carries a column named "${name}": ${sectionText.slice(0, 400)}`,
  );
  return header
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** Column index of a named column in the table carrying `name`. */
function columnIndex(sectionText, name) {
  const at = tableHeader(sectionText, name).indexOf(name);
  assert.ok(at >= 0, `column "${name}" is missing from the table that carries it`);
  return at;
}

/** Body rows of the ONE table in a section that carries a column called `name`, as cell arrays.
 *  Stops at the first line that is not part of that table, so a section's other tables cannot leak
 *  into the row count. */
function tableWith(sectionText, name) {
  const lines = sectionText.split('\n');
  const start = lines.findIndex((l) => l.startsWith('|') && l.split('|').includes(` ${name} `));
  assert.ok(start >= 0, `no table in this section carries a column named "${name}"`);
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    if (/^\|[\s|:-]+\|$/.test(line)) continue; // |---|---| separator
    rows.push(
      line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

if (!existsSync(CLI)) {
  process.stdout.write(
    '  scale-bench-vectors: SKIP — cli dist missing (corepack pnpm -F @knowledge-crib/cli build)\n',
  );
  process.exit(0);
}

// ── The incumbent path is unchanged by the flag's existence ──────────────────────────────────────
// §10.5 clause 5's last bullet is "existing perf gates unchanged", and `scale:check` runs this same
// harness without `--vectors`. So the lexical-only run must be exactly the report it always was.
{
  const { res, report } = runBench(['--slice', String(SLICE)]);
  assert.equal(res.status, 0, `lexical run must pass: ${res.stderr}`);
  assert.ok(
    report.includes('| Target LOC | Actual LOC | Files | Batches | Nodes | Edges | Wall (s)'),
    'lexical report must keep its original columns',
  );
  assert.ok(
    !report.includes('## Vector arm'),
    'a run without --vectors must not emit a vector section (the incumbent path is untouched)',
  );
  process.stdout.write('  ✓ lexical-only run is unchanged by the flag\n');
}

// ── The vector arm ───────────────────────────────────────────────────────────────────────────────
{
  const { res, out, report } = runBench([
    '--slice',
    String(SLICE),
    '--vectors',
    '--query-iters',
    '5',
    '--warmups',
    '2',
  ]);
  const combined = `${res.stdout}\n${res.stderr}`;
  // §9.4's three-outcome model applies to the harness's OWN exit code: the harness exits 1 when a
  // §10.5 budget is breached and 0 when it is met, so exit 1 is a MEASURED breach that must still
  // carry a report — and asserting `=== 0` here would have turned this test into "the vectors must
  // be fast enough", which is the gate's job, not the test's. Anything else is a crash.
  assert.ok(
    res.status === 0 || res.status === 1,
    `vector run must not crash (exit ${res.status}): ${combined.slice(0, 2000)}`,
  );
  const breached = res.status === 1;
  const breaches = [...combined.matchAll(/§10\.5 BREACH — (.+)/g)].map((m) => m[1].trim());
  assert.equal(
    breached,
    breaches.length > 0,
    'exit 1 must mean a reported §10.5 breach, and a reported breach must mean exit 1',
  );
  if (breached) {
    // Loudly, not silently: a breach measured at the test's slice is real information, and the test
    // reports which budget it was rather than hiding the exit code behind a loosened assertion.
    process.stdout.write(
      `  ! §10.5 breach measured at this slice (harness exit 1 — not a crash):\n${breaches
        .map((b) => `      ${b}`)
        .join('\n')}\n`,
    );
  }
  try {
    rmSync(out, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  assert.ok(report.length > 0, 'a breached run must still write its report');
  const sectionText = section(report, '## Vector arm');
  assert.ok(sectionText.length > 0, '--vectors must emit a vector-arm section (T9)');

  if (!embedderInstalled()) {
    // No tier → the channel could not be measured. The contract is UNAVAILABLE-with-a-reason, and
    // never a number. This is the branch that keeps the harness honest on a machine without the
    // model, which is every CI machine.
    process.stdout.write(
      '  scale-bench-vectors: no embedding tier installed (~/.crib/embed/manifest.json absent)\n',
    );
    const unavailableRow = tableWith(sectionText, 'Vectors')[0];
    assert.ok(
      unavailableRow,
      'an unmeasured slice must still appear in the table, with its reason',
    );
    assert.equal(unavailableRow[1], '—', 'an unmeasurable channel must not publish a vector count');
    assert.ok(
      /UNAVAILABLE|Not measured, and why/.test(report),
      'an unmeasurable channel must record that it was not measured, and why',
    );
    assert.ok(
      /vector arm failed:|not measured/.test(combined),
      'the reason must also reach the operator on stdout/stderr',
    );
    process.stdout.write(
      '  ✓ absent tier is reported as UNAVAILABLE with a reason, not as a number\n',
    );
    process.exit(0);
  }

  const rows = tableWith(sectionText, 'Vectors');
  assert.equal(rows.length, 1, `expected one slice row in the vector table, got ${rows.length}`);
  const vrow = rows[0];
  const target = vrow[columnIndex(sectionText, 'Target LOC')];
  const vectors = vrow[columnIndex(sectionText, 'Vectors')];
  const cold = vrow[columnIndex(sectionText, 'Cold (s)')];
  const warm = vrow[columnIndex(sectionText, 'Warm-cache (s)')];
  const kbPerNode = vrow[columnIndex(sectionText, 'Index Δ (KB/node)')];
  const cacheMb = vrow[columnIndex(sectionText, 'Cache (MB)')];
  const peakRssMb = vrow[columnIndex(sectionText, 'Peak RSS (MB)')];
  const embedderMb = vrow[columnIndex(sectionText, 'Embedder (MB)')];
  const indexSideMb = vrow[columnIndex(sectionText, 'Index-side (MB)')];
  assert.equal(target.replace(/,/g, ''), String(SLICE), 'the vector row is for the slice measured');
  assert.notEqual(vectors, '—', 'with a tier installed the vector count must be a number');
  assert.ok(
    Number.parseInt(vectors.replace(/,/g, ''), 10) > 0,
    'a vector run must produce vectors',
  );

  // §9.1 requires the embedder's own footprint to be reported SEPARATELY (§9.4 forbids folding it into
  // the index's). Both columns must be present; either may read `n/a` when the split is unavailable,
  // and `n/a` is the honest value then — never a fabricated number. What is asserted here is that the
  // harness attempts and reports the split, not that a particular machine can produce it.
  //
  // The renderer EMPHASISES the unavailable marker (`*n/a*`, scale-bench.mjs:915) — markdown is the
  // harness's presentation of the value, not the value, so the comparison normalises it away. Reading
  // the raw cell without doing so is what made the first run of this test fail on its own assertion
  // (`got "*n/a*"`), which is a defect in the assertion and not in the harness.
  const plain = (cell) => String(cell).replace(/\*/g, '').trim();
  const UNAVAILABLE = 'n/a';
  assert.ok(
    plain(embedderMb) === UNAVAILABLE || Number.isFinite(Number.parseFloat(embedderMb)),
    `the embedder footprint column must be a number or n/a, got "${embedderMb}"`,
  );
  assert.ok(
    plain(indexSideMb) === UNAVAILABLE || Number.isFinite(Number.parseFloat(indexSideMb)),
    `the index-side RSS column must be a number or n/a, got "${indexSideMb}"`,
  );
  // When the split cannot be produced, the harness's contract is to say so — clause 5b is UNPROVEN,
  // never breached. Asserting merely that the word "UNPROVEN" appears somewhere in the section would
  // be VACUOUS: the section's own method note always contains it, so the assertion could not fail.
  // What is asserted instead is the operator-visible gate line, which is emitted only on this path and
  // must carry a real reason (not the `reason not recorded` placeholder).
  if (plain(embedderMb) === UNAVAILABLE) {
    const UNPROVEN_5B =
      /§10\.5 UNPROVEN — .*clause 5b \(peak RSS\) — embedder split unavailable \((.+)\)/;
    const unprovenLine = UNPROVEN_5B.exec(combined);
    assert.ok(
      unprovenLine,
      'an unavailable embedder split must emit the clause-5b UNPROVEN gate line, or the degradation is silent',
    );
    assert.notEqual(
      unprovenLine[1].trim(),
      'reason not recorded',
      'the clause-5b UNPROVEN line must carry the real reason the split was unavailable',
    );
    assert.ok(
      !/§10\.5 BREACH .*vector index-side RSS/.test(combined),
      'an unavailable split must never produce an index-side RSS breach — an unsplit figure cannot decide the clause',
    );
  }
  // The decomposition is arithmetic, so it can be checked even on a machine that cannot produce the
  // split: WHEN both operands are present the residual must be their difference. This is the one
  // assertion here that pins the split's MEANING rather than its presence — without it, a column that
  // printed the whole-process figure twice would pass every other check in this file.
  const num = (cell) => Number.parseFloat(plain(cell).replace(/,/g, ''));
  if (Number.isFinite(num(peakRssMb)) && Number.isFinite(num(embedderMb))) {
    assert.ok(
      Math.abs(num(peakRssMb) - num(embedderMb) - num(indexSideMb)) <= 1,
      `Index-side (MB) must be the whole-process peak less the embedder: ${peakRssMb} − ${embedderMb} ≠ ${indexSideMb}`,
    );
  }

  // T9 — the cold claim is auditable: the cache directory is recorded, it is a real (temp) directory
  // outside the repository, and it is non-empty (which is what makes the warm column a WARM run).
  //
  // The byte figure is read as GROUPED digits, which is the second time this file has been bitten by
  // reading a rendered cell as if it were the raw value: the harness formats for a human, so a
  // pattern requiring bare digits silently matched nothing. That is a defect in the assertion, and it
  // is why `parseInt` below strips separators rather than parsing `"15,89,248"` as `15`.
  const cacheLine = /- ([\d,]+) LOC → `([^`]+)` \(([\d,]+) bytes\)/.exec(sectionText);
  assert.ok(
    cacheLine,
    `T9: the cold cache directory and its byte size must be recorded:\n${sectionText.slice(0, 600)}`,
  );
  const cacheDir = cacheLine[2];
  assert.ok(existsSync(cacheDir), `T9: recorded cache directory must exist: ${cacheDir}`);
  assert.ok(
    !resolve(cacheDir).startsWith(REPO),
    'T9: the cold cache must be outside the repository (a repo-local cache is not cold)',
  );
  assert.ok(
    Number.parseInt(cacheLine[3].replace(/,/g, ''), 10) > 0,
    'T9: the recorded cache must be non-empty — an empty cache makes the warm run a second cold run',
  );
  assert.ok(
    sectionText.includes('Warm-cache (s)'),
    'T9: the warm-cache run must be reported as warm-cache, not merged into the cold column',
  );
  assert.ok(Number.isFinite(Number.parseFloat(cold)), 'the cold wall must be a number');
  assert.ok(Number.isFinite(Number.parseFloat(warm)), 'the warm wall must be a number');
  assert.ok(
    Number.parseFloat(cacheMb) > 0,
    'the reported cache size must be a positive MB figure, consistent with the recorded bytes',
  );
  assert.ok(
    Number.isFinite(Number.parseFloat(kbPerNode)),
    'disk per vectorized node must be a number',
  );

  // The per-slice budgets §10.5 clause 5 names, at the only slice this test measures. A breach here
  // would already have exited non-zero above, so this asserts the harness computed them.
  assert.ok(
    /## Vector arm/.test(report) && /Index Δ \(KB\/node\)/.test(report),
    '§10.5 disk budget must be reported as KB per vectorized node',
  );

  // T10 — incremental updates wrote vectors for exactly the changed non-detail nodes. The harness
  // cross-checks its own DETAIL_KINDS mirror against the index, so "exact" here is a real equality
  // (non-detail count == vectorized count), not a copied constant agreeing with itself.
  const incSection = section(report, '### Incremental update');
  const incRows = tableWith(incSection, 'Vectorized (actual)');
  assert.ok(incRows.length >= 1, 'T10: the incremental update must be measured');
  const incAt = {
    loc: columnIndex(incSection, 'Vectorized (actual)'),
    files: columnIndex(incSection, 'Files changed'),
    totalNodes: columnIndex(incSection, 'Nodes in files'),
    nonDetail: columnIndex(incSection, 'Non-detail (expected)'),
    vectorized: columnIndex(incSection, 'Vectorized (actual)'),
    verdict: columnIndex(incSection, 'Verdict'),
  };
  for (const r of incRows) {
    const loc = r[incAt.loc];
    const files = r[incAt.files];
    const totalNodes = r[incAt.totalNodes];
    const nonDetail = r[incAt.nonDetail];
    const vectorized = r[incAt.vectorized];
    const verdict = r[incAt.verdict];
    assert.ok(
      Number.parseInt(files, 10) >= 1,
      'T10: an incremental row names how many files changed',
    );
    assert.ok(Number.parseInt(totalNodes, 10) > 0, 'T10: the changed files must contain nodes');
    assert.equal(
      verdict,
      'exact',
      `T10: incremental over ${files} file(s) at ${loc} LOC vectorized ${vectorized} of ${nonDetail} non-detail nodes — not an exact count`,
    );
  }

  process.stdout.write(
    `  ✓ T9: cold cache recorded at ${cacheDir} (${cacheLine[3]} bytes), warm-cache reported separately\n`,
  );
  process.stdout.write(
    `  ✓ T10: ${incRows.length} incremental update(s) vectorized exactly the changed non-detail nodes\n`,
  );
}
process.stdout.write('scale-bench-vectors: PASS\n');
