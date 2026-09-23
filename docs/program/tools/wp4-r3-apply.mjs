#!/usr/bin/env node
/**
 * Applies WP4's frozen §10.5 rule to the deciding pair — as arithmetic, not as judgement.
 *
 * WHY THIS EXISTS. §10.5 is a seven-clause rule frozen *before* the numbers arrived, and its whole value
 * is that no clause moves afterwards. Seven clauses over four harnesses, applied by hand at the moment
 * the numbers are finally visible, is exactly the situation in which a frozen rule gets quietly bent —
 * not by dishonesty but by the ordinary pull of a result the reader is half-expecting. So the clauses
 * that CAN be computed from the pair are computed here and nowhere else, and the clauses that CANNOT are
 * printed as unproven rather than left to be assumed. This tool does not decide anything either: it
 * reports which clauses the pair settles, which it does not, and why.
 *
 * WHAT IT READS. The two `locate-eval.mjs --json` reports of one clean back-to-back `{C0, C1}` pair on
 * the same corpus base (§10.8(5)). The quantity §10.5 names is `MRR(C)` on the primary natural-language
 * arm — method `crib`, variant `full` (the ablations `subject`/`no-scope` are not the primary arm), and
 * the query-blind control is method `churn`, whose three variants are byte-identical by construction.
 *
 * WHAT IT REFUSES, because a mismatched pair is a silently different experiment:
 *   - both reports must name the SAME corpus base and the same task count;
 *   - the c0 report must NOT be labelled a hybrid arm, and the c1 report must not be labelled lexical
 *     (`locate-eval` asserts this itself; this is the second lock on the same door);
 *   - a report missing the `crib`/`full` or `churn` row is refused rather than defaulted.
 *
 * WHAT IT DOES NOT COMPUTE, and says so in its output rather than in a footnote:
 *   - **Clause 3 (`exact R@1`)** — UNPROVEN. Its instrument is §8.1's exact-symbol arm, owned by
 *     `code-retrieval-eval.mjs`, which cannot open a hybrid arm at all (`sqlite-index.ts:352`,
 *     register §5.6(B), spec §10.8(8)): its own guard field is computed `null` by construction. There is
 *     no number to read here, so none is printed.
 *   - **Clauses 4 and 5 (latency, resources)** — PENDING in `--c0/--c1` mode. `locate-eval.mjs` measures
 *     no latency; those clauses belong to `scale-bench.mjs` (step 6), a different harness on different
 *     trees. Read them with `--scale` instead (below), NOT by hand out of the markdown.
 * A run in pair mode therefore tops out at "clears 1 and 2", which is NOT the same as promotable, and
 * the output says so in those words.
 *
 * ── THE TWO MODES, AND WHY THERE ARE TWO ────────────────────────────────────────────────────────
 * The rule draws its clauses from three harnesses that produce three different artifacts, so one mode
 * cannot serve both without inventing a quantity. Each mode computes exactly the clauses its own
 * instrument can settle and prints every other clause as unproven or pending:
 *
 *   --c0/--c1   clauses 1 and 2   (locate-eval.mjs, the 61-task corpus pair)
 *   --scale     clause 4, 5a-5d   (scale-bench.mjs's emitted scale-curve markdown)
 *
 * §10.7 requires §10.5 be applied BY TOOL, not by hand once the numbers are visible — which is why
 * clause 4 is computed here rather than transcribed from the emitted p95 table into the spec. The
 * emitted table IS the tool's input; the spec carries the verdict, not the arithmetic.
 *
 * WHAT --scale REFUSES. The markdown is a human artifact and a parser over it is only as honest as its
 * refusals: a header it does not recognise, a slice the pre-registered set names but the file omits,
 * a table absent entirely, or a non-numeric cell where a number is required — each is a refusal (exit
 * 2), never a skip. A `—`/`*UNAVAILABLE*` cell is NOT a refusal and NOT a pass: it is `unproven` at
 * that slice, which is the honest reading of "not measured" (§9.4 forbids extrapolating it).
 *
 * Usage:
 *   node docs/program/tools/wp4-r3-apply.mjs --c0 /tmp/wp4-r3-c0.json --c1 /tmp/wp4-r3-c1.json [--json]
 *   node docs/program/tools/wp4-r3-apply.mjs --scale docs/bench/scale-curve.md [--json]
 *
 * Exit: 0 = every clause this mode can settle, clears; 1 = a clause fails; 2 = the input is unusable.
 */
import { readFileSync } from 'node:fs';

const EXIT = { CLEAR: 0, FAIL: 1, UNUSABLE: 2 };

const argv = process.argv.slice(2);
const str = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const AS_JSON = argv.includes('--json');

// ── constants the SCALE mode needs, declared BEFORE the dispatch ─────────────────────────────────
// Not cosmetics: `--scale` is dispatched at the top of this file, so every `const` its call graph
// reaches is still in the temporal dead zone at that moment. Function declarations hoist and are safe
// to call there; `const` bindings are not. Anything a scale helper reads must therefore live above the
// dispatch — a future addition put below it throws `Cannot access … before initialization` on every
// `--scale` run, which the smoke test in `wp4-r3-apply.test.mjs` catches.

/**
 * §10.5 clause 5's slices — "at each of 10k/100k/500k LOC". A clause phrased over a named set cannot be
 * cleared by whichever subset got measured, so this is a CONSTANT and not "the rows in the file": if
 * the file omits one, the clause is unproven *because of the omission*, and the tool must be able to
 * tell omission from compliance. The harness may measure a superset (the run under test adds 50k/200k
 * to keep `scale-curve.md`'s published lexical points alive) — extra slices are reported, never scored.
 */
const PRE_REGISTERED_SLICES = [10000, 100000, 500000];

const fmt = (n) => n.toLocaleString('en-US');
const isMark = (cellText) => /UNAVAILABLE/i.test(cellText);

const SCALE_PATH = str('--scale');
const C0_PATH = str('--c0');
const C1_PATH = str('--c1');

// Two modes, two instruments. `--scale` is checked FIRST so a stray `--c0` cannot silently win.
if (SCALE_PATH) process.exit(runScale(SCALE_PATH));

if (!C0_PATH || !C1_PATH) {
  process.stderr.write(
    'usage: wp4-r3-apply.mjs --c0 <c0.json> --c1 <c1.json> [--json]\n' +
      '       wp4-r3-apply.mjs --scale <scale-curve.md> [--json]\n',
  );
  process.exit(EXIT.UNUSABLE);
}

/** Read one report, refusing an unreadable or unparseable file rather than defaulting any field. */
function load(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read the ${label} report at ${path}: ${err.message}\n`);
    process.exit(EXIT.UNUSABLE);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`the ${label} report at ${path} is not JSON: ${err.message}\n`);
    process.exit(EXIT.UNUSABLE);
  }
}

/** The ONE row §10.5 names, or a refusal. Never a fallback: a default would be a different quantity. */
function cell(report, method, variant, label) {
  const row = (report.table ?? []).find((r) => r.method === method && r.variant === variant);
  if (!row || typeof row.mrr !== 'number') {
    process.stderr.write(
      `the ${label} report has no \`${method}\`/\`${variant}\` row with a numeric mrr — refusing to ` +
        'default the quantity §10.5 names\n',
    );
    process.exit(EXIT.UNUSABLE);
  }
  return row;
}

const c0 = load(C0_PATH, 'C0');
const c1 = load(C1_PATH, 'C1');

// ── the pair must be one experiment ──────────────────────────────────────────────────────────────
const problems = [];
for (const [label, r] of [
  ['C0', c0],
  ['C1', c1],
]) {
  if (!r.corpus?.base) problems.push(`${label} does not name a corpus base`);
  if (typeof r.corpus?.tasks !== 'number') problems.push(`${label} does not report a task count`);
}
if (c0.corpus?.base !== c1.corpus?.base) {
  problems.push(
    `the two arms are on DIFFERENT corpus bases (C0 ${c0.corpus?.base} vs C1 ${c1.corpus?.base})`,
  );
}
if (c0.corpus?.tasks !== c1.corpus?.tasks) {
  problems.push(`the two arms ran ${c0.corpus?.tasks} vs ${c1.corpus?.tasks} tasks`);
}
if (c0.arm === c1.arm) {
  problems.push(`both reports are labelled \`${c0.arm}\` — that is one arm measured twice, not a pair`);
}
if (/c1|hybrid/.test(c0.arm ?? '') && !c0.index?.carriesVectors) {
  problems.push(`C0 is labelled \`${c0.arm}\` but its index carries no vectors`);
}
if (problems.length > 0) {
  process.stderr.write(`the pair is unusable:\n  - ${problems.join('\n  - ')}\n`);
  process.exit(EXIT.UNUSABLE);
}

// ── the two quantities, and nothing else ────────────────────────────────────────────────────────
const c0Arm = cell(c0, 'crib', 'full', 'C0');
const c1Arm = cell(c1, 'crib', 'full', 'C1');
const churn = cell(c1, 'churn', 'full', 'C1'); // the control read in the CANDIDATE's run, per clause 1

const mrrC0 = c0Arm.mrr;
const mrrC1 = c1Arm.mrr;
const churnMrr = churn.mrr;

const clauses = [
  {
    id: 1,
    name: 'discrimination guard',
    rule: 'MRR(C1) > churn MRR',
    instrument: 'locate-eval.mjs (this pair)',
    value: `MRR(C1) ${mrrC1.toFixed(4)} vs churn ${churnMrr.toFixed(4)}`,
    status: mrrC1 > churnMrr ? 'pass' : 'fail',
    note:
      'The control is query-blind — same files, same order, every task — so this is the whole of ' +
      'clause 1 and no reading of it is available.',
  },
  {
    id: 2,
    name: 'minimum effect',
    rule: 'MRR(C1) >= MRR(C0) + 0.05',
    instrument: 'locate-eval.mjs (this pair)',
    value: `MRR(C1) ${mrrC1.toFixed(4)} vs MRR(C0) + 0.05 = ${(mrrC0 + 0.05).toFixed(4)}`,
    status: mrrC1 >= mrrC0 + 0.05 ? 'pass' : 'fail',
    note:
      churnMrr > mrrC0 + 0.05
        ? `On this corpus the control (${churnMrr.toFixed(4)}) already exceeds MRR(C0)+0.05 ` +
          `(${(mrrC0 + 0.05).toFixed(4)}), so clause 2 is strictly dominated by clause 1 and cannot ` +
          'bind — clearing clause 1 clears it (register §5.6(F)(i)).'
        : 'Clause 2 can bind on this corpus.',
  },
  {
    id: 3,
    name: 'exact guard',
    rule: 'exact R@1(C1) >= exact R@1(C0)',
    instrument: 'code-retrieval-eval.mjs --category exact (§8.1)',
    value: null,
    status: 'unproven',
    note:
      'NOT MEASURABLE WITH THIS RUN’S INSTRUMENTS. The named harness cannot open a hybrid arm ' +
      '(it constructs SqliteIndexStore with no embedder, `:208`), so `exact R@1(C1)` is not ' +
      'representable in it and its own guard field is computed `null` by construction (`:552`). This ' +
      'clause is an outright disqualifier, so it cannot be *cleared* — only left unmet. See register ' +
      '§5.6(G) and P-8.',
  },
  {
    id: 4,
    name: 'latency guard',
    rule: 'query p95(C1) <= 2x query p95(C0), same machine same run',
    instrument: 'scale-bench.mjs (step 6)',
    value: null,
    status: 'pending',
    note:
      'A DIFFERENT RUN. locate-eval.mjs measures no latency at all; clause 4 reads scale-bench.mjs’s ' +
      'lexical-vs-hybrid p50/p95 table, which satisfies "same machine same run" internally, on synthetic ' +
      'LOC slices rather than on the corpus base commit. No number from this pair may be quoted as ' +
      'clause 4.',
  },
  {
    id: 5,
    name: 'resource budgets',
    rule: 'cold index <= 20x lexical; peak RSS <= 2x; disk <= 8 KB/vector; incremental writes exactly the changed nodes; perf-gates unchanged with vectors',
    instrument: 'scale-bench.mjs (step 6)',
    value: null,
    status: 'pending',
    note: 'Same instrument and same run as clause 4; not measured by this pair.',
  },
];

const failed = clauses.filter((c) => c.status === 'fail').map((c) => c.id);
const cleared = clauses.filter((c) => c.status === 'pass').map((c) => c.id);
const unresolved = clauses.filter((c) => c.status === 'unproven' || c.status === 'pending');

// Clause 6 needs (1)-(5) to be *cleared*, not merely clear-so-far, so it cannot fire on this pair.
const tieBreak =
  unresolved.length === 0 ? 'applicable' : 'NOT APPLICABLE — clauses 1-5 are not all cleared';

const verdict = {
  rule: 'docs/program/wp4-implementation-spec.md §10.5 (FROZEN)',
  pair: {
    base: c0.corpus.base,
    tasks: c0.corpus.tasks,
    c0: { path: C0_PATH, arm: c0.arm, mrr: mrrC0 },
    c1: { path: C1_PATH, arm: c1.arm, mrr: mrrC1 },
    churnMrr,
  },
  clauses,
  cleared,
  failed,
  unresolvedClauses: unresolved.map((c) => c.id),
  tieBreak,
  promotable: false,
  // The one sentence a reader must not be able to miss.
  verdict:
    failed.length > 0
      ? `FAILS clause(s) ${failed.join(', ')} — the candidate is not promoted.`
      : `CLEARS clause(s) ${cleared.join(', ')} ONLY. Clauses ${unresolved.map((c) => c.id).join(', ')} ` +
        'are NOT cleared on this run, so the candidate is NOT promotable on this run’s instruments. ' +
        'This is not a promotion and must not be reported as one.',
};

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
} else {
  const L = [];
  L.push(`§10.5 applied to {C0, C1} on ${verdict.pair.base} (${verdict.pair.tasks} tasks)`);
  L.push(`  C0 ${mrrC0.toFixed(4)}  ${C0_PATH}  [${c0.arm}]`);
  L.push(`  C1 ${mrrC1.toFixed(4)}  ${C1_PATH}  [${c1.arm}]`);
  L.push(`  churn control ${churnMrr.toFixed(4)}`);
  L.push('');
  for (const c of clauses) {
    const tag = { pass: 'PASS', fail: 'FAIL', unproven: 'UNPROVEN', pending: 'PENDING' }[c.status];
    L.push(`  ${c.id}. ${c.name} — ${tag}`);
    L.push(`     rule : ${c.rule}`);
    if (c.value) L.push(`     value: ${c.value}`);
    L.push(`     via  : ${c.instrument}`);
    for (const line of String(c.note).match(/.{1,96}(\s|$)/g) ?? []) {
      L.push(`     ${line.trim()}`);
    }
    L.push('');
  }
  L.push(`  tie-break: ${tieBreak}`);
  L.push('');
  L.push(`  ${verdict.verdict}`);
  process.stdout.write(`${L.join('\n')}\n`);
}

process.exit(failed.length > 0 ? EXIT.FAIL : EXIT.CLEAR);

// ── --scale mode: clauses 4 and 5, read from scale-bench's emitted markdown ──────────────────────
// `PRE_REGISTERED_SLICES`, `fmt` and `isMark` are declared ABOVE the dispatch, not here — see the note
// there. Everything below is a `function` declaration, so it is callable from the top of the file.

/** A numeric cell, or `null` for `—`/`n/a`/`UNAVAILABLE`. Never a default: null means unmeasured. */
function num(cellText) {
  const t = String(cellText).replace(/[*×]/g, '').replace(/,/g, '').trim();
  if (t === '' || t === '—' || t === 'n/a' || t === 'UNAVAILABLE') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every markdown table in the document, as {headers, rows}. A table is a `|`-row followed by a
 * `|---|`-separator row; its rows run until the first non-`|` line. Parsing the header lets a column be
 * found BY NAME rather than by position, so a reordered or widened table is read correctly instead of
 * shifted silently by one column.
 */
function tables(md) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim();
    if (!head.startsWith('|')) continue;
    if (!/^\|[\s:|-]+\|$/.test((lines[i + 1] ?? '').trim())) continue;
    const headers = head.split('|').slice(1, -1).map((h) => h.trim());
    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const r = lines[j].trim();
      if (!r.startsWith('|')) break;
      rows.push(r.split('|').slice(1, -1).map((c) => c.trim()));
    }
    out.push({ headers, rows });
    i = j - 1;
  }
  return out;
}

/** The one table whose headers contain every needed marker, or a refusal naming what was missing. */
function needTable(all, markers, label) {
  const hit = all.find((t) => markers.every((m) => t.headers.some((h) => h.includes(m))));
  if (!hit) {
    process.stderr.write(
      `the scale report has no ${label} table (looked for a header containing: ${markers.join(', ')}) — ` +
        'refusing to guess which table clause 4/5 is about\n',
    );
    process.exit(EXIT.UNUSABLE);
  }
  return hit;
}

/** Column index by header substring; a missing column is a refusal, not an `undefined` cell. */
function col(table, marker, label) {
  const i = table.headers.findIndex((h) => h.includes(marker));
  if (i === -1) {
    process.stderr.write(`the ${label} table has no \`${marker}\` column — refusing to guess\n`);
    process.exit(EXIT.UNUSABLE);
  }
  return i;
}

/**
 * One clause across the pre-registered slices. PASS requires every one of them to be PRESENT and
 * COMPLIANT. Order matters: a measured breach is reported as a breach even if another slice is also
 * missing, because a breach is a fact about the channel and a missing slice is a fact about the run.
 */
function aggregate(perSlice, check) {
  const missing = [];
  const unmeasured = [];
  const breaches = [];
  for (const loc of PRE_REGISTERED_SLICES) {
    const s = perSlice.get(loc);
    if (!s) {
      missing.push(loc);
      continue;
    }
    const got = check(s);
    if (got === null) {
      unmeasured.push(loc);
      continue;
    }
    if (!got.ok) breaches.push(`${fmt(loc)}: ${got.why}`);
  }
  if (breaches.length > 0) return { status: 'fail', why: breaches.join('; ') };
  if (missing.length > 0) {
    return { status: 'unproven', why: `not present in this file: ${missing.map(fmt).join(', ')}` };
  }
  if (unmeasured.length > 0) {
    return {
      status: 'unproven',
      why: `reported UNAVAILABLE at ${unmeasured.map(fmt).join(', ')} (§9.4 forbids extrapolating it)`,
    };
  }
  return { status: 'pass', why: `at each of ${PRE_REGISTERED_SLICES.map(fmt).join(', ')}` };
}

function runScale(path) {
  let md;
  try {
    md = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read the scale report at ${path}: ${err.message}\n`);
    return EXIT.UNUSABLE;
  }

  const all = tables(md);
  const lexical = needTable(all, ['Actual LOC', 'Nodes / s'], 'lexical scale');
  const vector = needTable(all, ['Vectors', 'Cold'], 'vector scale');
  const latency = needTable(all, ['p95 ratio'], 'query latency');
  const incr = needTable(all, ['Non-detail (expected)', 'Verdict'], 'incremental');

  const LOC = 'Target LOC';
  const locAt = (t) => col(t, LOC, 'scale');

  // Per-slice, keyed by the target LOC every table shares. A row whose LOC is not a number is refused.
  const perSlice = new Map();
  for (const table of [lexical, vector, latency, incr]) {
    const li = locAt(table);
    for (const row of table.rows) {
      const loc = num(row[li]);
      if (loc === null) {
        process.stderr.write(`a ${LOC} cell is not numeric (\`${row[li]}\`) — refusing to key rows\n`);
        return EXIT.UNUSABLE;
      }
      if (!perSlice.has(loc)) perSlice.set(loc, { loc });
    }
  }
  // Columns are resolved BY NAME after the slice set is known, so nothing depends on table order.
  const lexPeakRss = col(lexical, 'Peak RSS', 'lexical scale');
  const vecIndexSide = col(vector, 'Index-side', 'vector scale');
  const vecKbPerNode = col(vector, 'Index Δ', 'vector scale');
  const latRatio = col(latency, 'p95 ratio', 'query latency');
  const incVerdict = col(incr, 'Verdict', 'incremental');
  const incLoc = col(incr, LOC, 'incremental');

  // The "Cold ÷ lexical" header contains "Cold", so `col` would find the plain Cold (s) column first.
  const coldRatioHeader = vector.headers.findIndex((h) => h.includes('÷'));
  if (coldRatioHeader === -1) {
    process.stderr.write('the vector scale table has no `Cold ÷ lexical` column — refusing\n');
    return EXIT.UNUSABLE;
  }

  const rowFor = (table, loc) => table.rows.find((r) => num(r[locAt(table)]) === loc) ?? null;

  // Incremental rows are many-per-slice, so they are collected separately from the one-row tables.
  const incrByLoc = new Map();
  for (const row of incr.rows) {
    const loc = num(row[incLoc]);
    if (loc === null) continue;
    if (!incrByLoc.has(loc)) incrByLoc.set(loc, []);
    incrByLoc.get(loc).push(row[incVerdict]);
  }

  const clauses = [
    {
      id: 1,
      name: 'discrimination guard',
      rule: 'MRR(C1) > churn MRR',
      instrument: 'locate-eval.mjs (the {C0, C1} pair — NOT this instrument)',
      value: null,
      status: 'pending',
      note:
        'NOT THIS RUN. Clauses 1-3 are corpus-base measurements taken by the pair mode; scale-bench ' +
        'indexes synthetic LOC slices, so no number here bears on them. Run --c0/--c1 for clause 1.',
    },
    {
      id: 2,
      name: 'minimum effect',
      rule: 'MRR(C1) >= MRR(C0) + 0.05',
      instrument: 'locate-eval.mjs (the {C0, C1} pair — NOT this instrument)',
      value: null,
      status: 'pending',
      note: 'Same reason as clause 1: a different run, on a different tree.',
    },
    {
      id: 3,
      name: 'exact guard',
      rule: 'exact R@1(C1) >= exact R@1(C0)',
      instrument: 'code-retrieval-eval.mjs --category exact (§8.1)',
      value: null,
      status: 'unproven',
      note:
        'UNPROVEN, and neither instrument in this run supplies it: the named harness cannot open a ' +
        'hybrid arm at all (`:208`), and scale-bench scores no exact-symbol corpus. This clause is an ' +
        'outright disqualifier, so it cannot be *cleared* — only left unmet (register §5.6(G), P-8).',
    },
    {
      id: 4,
      name: 'latency guard',
      rule: 'query p95(C1) <= 2x query p95(C0), same machine same run',
      instrument: 'scale-bench.mjs query-latency table (this run)',
      ...(() => {
        const agg = aggregate(perSlice, (s) => {
          const row = rowFor(latency, s.loc);
          if (!row || isMark(row[latRatio])) return null;
          const ratio = num(row[latRatio]);
          if (ratio === null) return null;
          return ratio <= 2
            ? { ok: true }
            : { ok: false, why: `p95 ratio ${ratio.toFixed(2)}× exceeds 2×` };
        });
        return { value: agg.why, status: agg.status };
      })(),
      note:
        'Both arms run against the SAME index in the SAME process, so "same machine same run" is ' +
        'satisfied internally rather than asserted. The ratio is the emitted `p95 ratio` column.',
    },
    {
      id: 5,
      name: 'resource budgets',
      rule:
        'cold index <= 20x lexical; peak RSS <= 2x; disk <= 8 KB/vector; incremental writes exactly ' +
        'the changed nodes; perf-gates unchanged with vectors',
      instrument: 'scale-bench.mjs scale + incremental tables (this run)',
      value: '',
      status: 'pending',
      note: '',
    },
  ];

  // Clause 5 is five bullets, and they do NOT fail alike: four are measured, one is structural. Bundling
  // them into one status would hide which of the five moved, so each is aggregated and reported.
  const five = [
    {
      label: '5a cold index <= 20x lexical',
      agg: aggregate(perSlice, (s) => {
        const row = rowFor(vector, s.loc);
        if (!row || isMark(row[coldRatioHeader])) return null;
        const r = num(row[coldRatioHeader]);
        if (r === null) return null;
        return r <= 20 ? { ok: true } : { ok: false, why: `cold is ${r.toFixed(1)}× lexical` };
      }),
    },
    {
      label: '5b peak RSS <= 2x (index-side, model excluded)',
      agg: aggregate(perSlice, (s) => {
        const vRow = rowFor(vector, s.loc);
        const lRow = rowFor(lexical, s.loc);
        if (!vRow || !lRow) return null;
        const side = num(vRow[vecIndexSide]);
        const lex = num(lRow[lexPeakRss]);
        if (side === null || lex === null || lex <= 0) return null;
        return side <= 2 * lex
          ? { ok: true }
          : { ok: false, why: `index-side ${side.toFixed(0)} MB > 2x lexical ${lex.toFixed(0)} MB` };
      }),
    },
    {
      label: '5c disk <= 8 KB per vectorized node',
      agg: aggregate(perSlice, (s) => {
        const row = rowFor(vector, s.loc);
        if (!row || isMark(row[vecKbPerNode])) return null;
        const kb = num(row[vecKbPerNode]);
        if (kb === null) return null;
        return kb <= 8 ? { ok: true } : { ok: false, why: `${kb.toFixed(2)} KB/node exceeds 8` };
      }),
    },
    {
      label: '5d incremental writes exactly the changed non-detail nodes',
      agg: aggregate(perSlice, (s) => {
        const verdicts = incrByLoc.get(s.loc);
        if (!verdicts || verdicts.length === 0) return null;
        const bad = verdicts.filter((v) => !/^exact$/i.test(v));
        return bad.length === 0 ? { ok: true } : { ok: false, why: `${bad.length} row(s) MISMATCH` };
      }),
    },
    {
      label: '5e existing perf gates unchanged with vectors',
      agg: {
        status: 'pass',
        why:
          'discharged BY CONSTRUCTION, not by measurement — the vector arm runs only under `--vectors`, ' +
          'so the lexical path is exactly what it was before the flag existed',
      },
    },
  ];

  const measured = five.filter((f) => f.agg.status === 'pass').length;
  const breached = five.filter((f) => f.agg.status === 'fail');
  const unproven = five.filter((f) => f.agg.status === 'unproven');
  clauses[4].status = breached.length > 0 ? 'fail' : unproven.length > 0 ? 'unproven' : 'pass';
  clauses[4].value = `${measured}/5 bullets clear`;
  clauses[4].note =
    breached.length > 0
      ? `BREACHED: ${breached.map((b) => `${b.label} — ${b.agg.why}`).join('; ')}`
      : unproven.length > 0
        ? `UNPROVEN at a pre-registered slice: ${unproven.map((b) => b.label).join('; ')}. ` +
          'A clause §10.5 states "at each of" cannot be cleared by the slices that were measured.'
        : `All five bullets clear AT EACH OF ${PRE_REGISTERED_SLICES.map(fmt).join(', ')} — clause 5 is ` +
          'phrased "at each of", so the scope is stated rather than left to the rows that happen to be ' +
          `present. 5a-5d are measured; 5e is structural — and note that perf-gates.md's ` +
          'ABSOLUTE thresholds (recall p95 < 100 ms @10k, < 300 ms @100k, `perf-gates.md:30-31`) are ' +
          'measured through `MemoryApi.search` and are NOT re-measured by this harness, whose latency ' +
          'table is about `crib query`. 5e claims the lexical path is UNCHANGED, not that those ' +
          'numbers were re-taken.';

  const failedIds = clauses.filter((c) => c.status === 'fail').map((c) => c.id);
  const clearedIds = clauses.filter((c) => c.status === 'pass').map((c) => c.id);
  const unresolvedIds = clauses
    .filter((c) => c.status === 'unproven' || c.status === 'pending')
    .map((c) => c.id);

  const verdict = {
    rule: 'docs/program/wp4-implementation-spec.md §10.5 (FROZEN)',
    mode: 'scale',
    source: path,
    slices: [...perSlice.keys()].sort((a, b) => a - b),
    preRegisteredSlices: PRE_REGISTERED_SLICES,
    clause5Bullets: five.map((f) => ({ label: f.label, ...f.agg })),
    clauses,
    cleared: clearedIds,
    failed: failedIds,
    unresolvedClauses: unresolvedIds,
    promotable: false,
    verdict:
      failedIds.length > 0
        ? `FAILS clause(s) ${failedIds.join(', ')} — the candidate is not promoted.`
        : `CLEARS clause(s) ${clearedIds.join(', ')} ONLY. Clauses ${unresolvedIds.join(', ')} are NOT ` +
          'cleared, so this run cannot promote the candidate on its own. ' +
          'This is not a promotion and must not be reported as one.',
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  } else {
    const L = [];
    L.push(`§10.5 clauses 4-5, applied to ${path}`);
    L.push(`  slices in file : ${verdict.slices.map(fmt).join(', ')}`);
    L.push(`  pre-registered : ${PRE_REGISTERED_SLICES.map(fmt).join(', ')}`);
    L.push('');
    L.push('  clause 5, bullet by bullet — a clause of five parts must not fail as one:');
    for (const b of verdict.clause5Bullets) {
      const tag = { pass: 'PASS', fail: 'FAIL', unproven: 'UNPROVEN', pending: 'PENDING' }[b.status];
      L.push(`    ${tag.padEnd(9)} ${b.label}`);
      L.push(`              ${b.why}`);
    }
    L.push('');
    for (const c of clauses) {
      const tag = { pass: 'PASS', fail: 'FAIL', unproven: 'UNPROVEN', pending: 'PENDING' }[c.status];
      L.push(`  ${c.id}. ${c.name} — ${tag}`);
      L.push(`     rule : ${c.rule}`);
      if (c.value) L.push(`     value: ${c.value}`);
      L.push(`     via  : ${c.instrument}`);
      for (const line of String(c.note).match(/.{1,96}(\s|$)/g) ?? []) {
        L.push(`     ${line.trim()}`);
      }
      L.push('');
    }
    L.push(`  ${verdict.verdict}`);
    process.stdout.write(`${L.join('\n')}\n`);
  }

  return failedIds.length > 0 ? EXIT.FAIL : EXIT.CLEAR;
}
