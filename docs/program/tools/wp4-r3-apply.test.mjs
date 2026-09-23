#!/usr/bin/env node
/**
 * `wp4-r3-apply.mjs` — the §10.5 application, driven in both directions.
 *
 * WHY THIS SUITE EXISTS. The tool computes two clauses of a rule frozen before its numbers arrived, and
 * the danger it exists to remove is a *quiet* misreading — a clause that reads as cleared because the
 * comparison was computed against the wrong quantity, or a pair that was not one experiment and was
 * scored anyway. So every rule is driven here as a subprocess against a synthetic pair and shown
 * FIRING ON A VIOLATION and QUIET ON ITS COMPLIANT TWIN. A guard that only ever refuses is
 * indistinguishable from one that refuses everything; a guard that only ever passes is not a guard.
 *
 * The fixtures are synthetic on purpose: the real C1 number does not exist yet, and a test that needed
 * it could not have been written before the freeze — which is the whole point of writing it now.
 *
 * Run: node docs/program/tools/wp4-r3-apply.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOL = resolve(import.meta.dirname, 'wp4-r3-apply.mjs');
const BASE = 'd872789840b47e2a2b2b9a5f0751288b6ad0a050';

/** A locate-eval-shaped report. Only the fields the tool reads are real; the rest are the shape. */
function report({ arm, base = BASE, tasks = 61, crib, churn, carriesVectors }) {
  return {
    corpus: { base, tasks },
    k: 10,
    arm,
    index: { db: `/tmp/${arm}/crib.sqlite`, carriesVectors, vectorNote: null, servedLexically: false },
    table: [
      { method: 'crib', variant: 'full', recall1: 0.1, recall5: 0.2, recall10: 0.3, mrr: crib, medianTokens: 1902 },
      { method: 'crib', variant: 'subject', recall1: 0.1, recall5: 0.2, recall10: 0.3, mrr: crib - 0.01, medianTokens: 1889 },
      { method: 'grep-bm25', variant: 'full', recall1: 0.2, recall5: 0.3, recall10: 0.4, mrr: 0.47, medianTokens: 24062 },
      { method: 'churn', variant: 'full', recall1: 0.27, recall5: 0.34, recall10: 0.42, mrr: churn, medianTokens: 0 },
      { method: 'churn', variant: 'subject', recall1: 0.27, recall5: 0.34, recall10: 0.42, mrr: churn, medianTokens: 0 },
      { method: 'churn', variant: 'no-scope', recall1: 0.27, recall5: 0.34, recall10: 0.42, mrr: churn, medianTokens: 0 },
    ],
  };
}

const dir = mkdtempSync(join(tmpdir(), 'wp4-r3-apply-'));
let n = 0;
/** Write a pair to disk and run the tool. Never throws: these are asserted on status and output. */
function run(c0, c1, extra = []) {
  const a = join(dir, `c0-${n}.json`);
  const b = join(dir, `c1-${n}.json`);
  n += 1;
  writeFileSync(a, JSON.stringify(c0));
  writeFileSync(b, JSON.stringify(c1));
  const r = spawnSync(process.execPath, [TOOL, '--c0', a, '--c1', b, '--json', ...extra], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', parse: () => JSON.parse(r.stdout) };
}

/** The churn the corpus was measured to produce; kept realistic so clause 2's domain is the real one. */
const CHURN = 0.5012;

// ── clause 1 — the discrimination guard, violation and twin ─────────────────────────────────────
{
  // A candidate that beats the incumbent but NOT the query-blind control: clause 1 fails, clause 2 passes.
  const bad = run(
    report({ arm: 'c0-lexical-only', crib: 0.32, churn: CHURN, carriesVectors: false }),
    report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.48, churn: CHURN, carriesVectors: true }),
  );
  assert.equal(bad.status, 1, 'clause 1: a candidate under the control must exit 1');
  const v = bad.parse();
  assert.equal(v.clauses[0].status, 'fail', 'clause 1 must be the failing clause');
  assert.equal(v.clauses[1].status, 'pass', 'clause 2 must NOT be reported as failed too');
  assert.equal(v.promotable, false, 'a clause-1 failure is never promotable');
  assert.match(v.verdict, /FAILS clause\(s\) 1\b/, 'the verdict must name the failed clause');

  const good = run(
    report({ arm: 'c0-lexical-only', crib: 0.32, churn: CHURN, carriesVectors: false }),
    report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.55, churn: CHURN, carriesVectors: true }),
  );
  assert.equal(good.status, 0, `clause 1 twin: beating the control must clear 1 and 2: ${good.stderr}`);
  const g = good.parse();
  assert.deepEqual(g.cleared, [1, 2], 'the twin clears exactly clauses 1 and 2');
  process.stdout.write('  ✓ clause 1: under the control FAILS; over it clears\n');
}

// ── clause 2 — the minimum effect, violation and twin ───────────────────────────────────────────
{
  // Above the control but only +0.02 over the incumbent: clause 1 passes, clause 2 fails.
  const bad = run(
    report({ arm: 'c0-lexical-only', crib: 0.50, churn: CHURN, carriesVectors: false }),
    report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.52, churn: CHURN, carriesVectors: true }),
  );
  assert.equal(bad.status, 1, 'clause 2: an effect under +0.05 must exit 1');
  assert.equal(bad.parse().clauses[1].status, 'fail', 'clause 2 must be the failing clause');

  // Exactly +0.05 must CLEAR — the rule reads `>=`, and a strict reading here would be a bent rule.
  const edge = run(
    report({ arm: 'c0-lexical-only', crib: 0.50, churn: CHURN - 0.2, carriesVectors: false }),
    report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.55, churn: CHURN - 0.2, carriesVectors: true }),
  );
  assert.equal(edge.status, 0, 'clause 2 is `>=`: exactly +0.05 must clear, not fail');
  assert.equal(edge.parse().clauses[1].status, 'pass', 'the boundary belongs to the candidate');
  process.stdout.write('  ✓ clause 2: +0.02 FAILS; exactly +0.05 clears (the rule reads `>=`)\n');
}

// ── clause 3 and 4/5 — the tool may not invent what it cannot measure ───────────────────────────
{
  const v = run(
    report({ arm: 'c0-lexical-only', crib: 0.32, churn: CHURN, carriesVectors: false }),
    report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.55, churn: CHURN, carriesVectors: true }),
  ).parse();
  assert.equal(v.clauses[2].status, 'unproven', 'clause 3 must be UNPROVEN, never pass');
  assert.equal(v.clauses[2].value, null, 'clause 3 must carry NO number');
  assert.equal(v.clauses[3].status, 'pending', 'clause 4 is another run, and is pending');
  assert.equal(v.clauses[4].status, 'pending', 'clause 5 is another run, and is pending');
  assert.equal(v.tieBreak.startsWith('NOT APPLICABLE'), true, 'clause 6 cannot fire while 3-5 are open');
  assert.equal(v.promotable, false, 'clearing 1 and 2 alone is NOT a promotion');
  assert.match(
    v.verdict,
    /NOT promotable on this run/,
    'the verdict must refuse to read a 1-and-2 pass as a promotion',
  );
  // The failure mode this guards: a 1-and-2 pass reported as promotable. Asserted in the negative.
  assert.doesNotMatch(v.verdict, /^CLEARS.*promotable\./s, 'never read as promotable');
  process.stdout.write('  ✓ clauses 3-5: unproven/pending, and a 1-and-2 pass is never a promotion\n');
}

// ── refusals — a pair that is not one experiment is not scored ──────────────────────────────────
{
  const differentBase = run(
    report({ arm: 'c0-lexical-only', crib: 0.32, churn: CHURN, carriesVectors: false }),
    report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.55, churn: CHURN, carriesVectors: true, base: 'f'.repeat(40) }),
  );
  assert.equal(differentBase.status, 2, 'two corpus bases must be refused');
  assert.match(differentBase.stderr, /DIFFERENT corpus bases/, 'the refusal must name the mismatch');

  const sameArm = run(
    report({ arm: 'c0-lexical-only', crib: 0.32, churn: CHURN, carriesVectors: false }),
    report({ arm: 'c0-lexical-only', crib: 0.55, churn: CHURN, carriesVectors: false }),
  );
  assert.equal(sameArm.status, 2, 'one arm measured twice must be refused as a non-pair');
  assert.match(sameArm.stderr, /one arm measured twice/, 'the refusal must say what it saw');

  const differentTasks = run(
    report({ arm: 'c0-lexical-only', crib: 0.32, churn: CHURN, carriesVectors: false, tasks: 61 }),
    report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.55, churn: CHURN, carriesVectors: true, tasks: 20 }),
  );
  assert.equal(differentTasks.status, 2, 'a task-count mismatch must be refused');
  assert.match(differentTasks.stderr, /61 vs 20 tasks/, 'the refusal must quote both counts');

  // A missing row must refuse rather than default the quantity §10.5 names.
  const noChurn = report({ arm: 'c1-hybrid-rrf-rerank', crib: 0.55, churn: CHURN, carriesVectors: true });
  noChurn.table = noChurn.table.filter((r) => r.method !== 'churn');
  const missing = run(
    report({ arm: 'c0-lexical-only', crib: 0.32, churn: CHURN, carriesVectors: false }),
    noChurn,
  );
  assert.equal(missing.status, 2, 'a missing control row must be refused, not defaulted');
  assert.match(missing.stderr, /no `churn`\/`full` row/, 'the refusal must name the missing quantity');
  process.stdout.write('  ✓ refusals: different base, one arm twice, task mismatch, missing control row\n');
}

// ── --scale mode — clauses 4 and 5, from scale-bench's emitted markdown ─────────────────────────
//
// The markdown is a HUMAN artifact, so this parser is only as honest as its refusals and its handling of
// "not measured". The two failure modes worth a test each: reading the WRONG COLUMN (clause 5b is about
// the index-side RSS, not the whole-process peak — a tool that reads the wrong one fails a compliant
// candidate), and reading an UNAVAILABLE slice as a PASS (which would clear a clause §10.5 states "at
// each of" 10k/100k/500k from the two slices that happened to be affordable).

/** Scalar or `(slice) => value`; `null` renders as `UNAVAILABLE`. Defaults are compliant everywhere. */
const pick = (v, s) => (typeof v === 'function' ? v(s) : v);

/** A scale-curve-shaped document. Compliant by default so each test moves exactly one cell. */
function scaleReport({
  slices = [10000, 100000, 500000],
  coldRatio = 3.0,
  indexSide = 100,
  lexPeak = 200,
  kbPerNode = 4.0,
  p95Ratio = 1.3,
  incremental = 'exact',
} = {}) {
  const loc = (nn) => nn.toLocaleString('en-US');
  const cells = (v, s, f) => (pick(v, s) === null ? '—' : f(pick(v, s)));
  const L = [];
  L.push('# Scale curve — `crib index` time + peak RSS vs corpus LOC');
  L.push('');
  L.push('| Target LOC | Actual LOC | Files | Batches | Nodes | Edges | Wall (s) | crib ms | Peak RSS (MB) | MB / kLOC | Nodes / s |');
  L.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of slices) {
    L.push(`| ${loc(s)} | ${loc(s)} | 252 | 12 | 5,854 | 7,378 | 8.26 | 7,800 | ${Number(pick(lexPeak, s)).toFixed(3)} | 23.1 | 709 |`);
  }
  L.push('');
  L.push('| Target LOC | Vectors | Cold (s) | Cold ÷ lexical | Warm-cache (s) | Peak RSS (MB) | Embedder (MB) | Index-side (MB) | Index Δ (KB/node) | Cache (MB) |');
  L.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of slices) {
    const vec = pick(coldRatio, s);
    if (vec === null || pick(indexSide, s) === null) {
      L.push(`| ${loc(s)} | — | *UNAVAILABLE* | — | — | — | — | — | — | — |`);
      continue;
    }
    L.push(
      `| ${loc(s)} | 2,934 | 24.78 | ${vec.toFixed(1)}× | 20.00 | 5,432 | 3,412 | ${Number(pick(indexSide, s)).toFixed(0)} | ${Number(pick(kbPerNode, s)).toFixed(2)} | 231 |`,
    );
  }
  L.push('');
  L.push('| Target LOC | Files changed | Wall (s) | Nodes in files | Non-detail (expected) | Vectorized (actual) | Verdict |');
  L.push('|---:|---:|---:|---:|---:|---:|:--|');
  for (const s of slices) {
    const v = pick(incremental, s);
    L.push(`| ${loc(s)} | 1 | 0.42 | 30 | 24 | ${v === 'exact' ? 24 : 30} | ${v === 'exact' ? 'exact' : '**MISMATCH**'} |`);
  }
  L.push('');
  L.push('| Target LOC | Lexical p50 | Lexical p95 | Hybrid p50 | Hybrid p95 | p95 ratio |');
  L.push('|---:|---:|---:|---:|---:|:--|');
  for (const s of slices) {
    const r = pick(p95Ratio, s);
    if (r === null) {
      L.push(`| ${loc(s)} | — | — | — | — | *UNAVAILABLE* |`);
      continue;
    }
    L.push(`| ${loc(s)} | 12.34 | 45.67 | 15.00 | ${(45.67 * r).toFixed(2)} | ${r.toFixed(2)}× |`);
  }
  L.push('');
  return L.join('\n');
}

/** Write a scale document and run the tool in scale mode. Never throws; asserted on status and output. */
function runScale(md, extra = []) {
  const p = join(dir, `scale-${n}.md`);
  n += 1;
  writeFileSync(p, md);
  const r = spawnSync(process.execPath, [TOOL, '--scale', p, '--json', ...extra], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', parse: () => JSON.parse(r.stdout) };
}
const clauseOf = (v, id) => v.clauses.find((c) => c.id === id);
const bulletOf = (v, key) => v.clause5Bullets.find((b) => b.label.startsWith(key));

// ── the compliant twin: both clauses clear, and the verdict still refuses promotion ──────────────
{
  const ok = runScale(scaleReport());
  assert.equal(ok.status, 0, 'a compliant document must exit 0');
  const v = ok.parse();
  assert.equal(clauseOf(v, 4).status, 'pass', 'clause 4 passes at all three pre-registered slices');
  assert.equal(clauseOf(v, 5).status, 'pass', 'clause 5 passes when all five bullets do');
  assert.deepEqual(v.cleared, [4, 5], 'exactly clauses 4 and 5 are cleared by this instrument');
  assert.deepEqual(v.failed, [], 'nothing fails');
  // The same discipline as pair mode: clearing what this instrument can settle is NOT a promotion,
  // because clauses 1-3 belong to a different run and are unreported here.
  assert.match(v.verdict, /clause\(s\) 4, 5 ONLY/, 'the verdict must name only what was cleared');
  assert.match(v.verdict, /not a promotion/, 'and must refuse the promotion reading in words');
  process.stdout.write('  ✓ scale: compliant twin clears 4 and 5, and is never read as promotable\n');
}

// ── clause 4 — the latency guard, violation and twin ────────────────────────────────────────────
{
  // The violation is planted at ONE slice only. Clause 4 is "at each of", so one breach must fail it —
  // a mean or a best-case reading would have cleared it.
  const bad = runScale(scaleReport({ p95Ratio: (s) => (s === 100000 ? 3.5 : 1.3) }));
  assert.equal(bad.status, 1, 'a p95 ratio over 2x at any pre-registered slice must exit 1');
  const v = bad.parse();
  assert.equal(clauseOf(v, 4).status, 'fail', 'clause 4 fails');
  assert.match(clauseOf(v, 4).value, /100,000: p95 ratio 3\.50× exceeds 2×/, 'and names the slice and the ratio');
  assert.deepEqual(v.failed, [4], 'only clause 4 fails');
  process.stdout.write('  ✓ scale: clause 4 fails on a single-slice breach, naming the slice\n');
}

// ── an UNAVAILABLE slice is UNPROVEN, and must never be folded into a PASS ──────────────────────
{
  const un = runScale(scaleReport({ p95Ratio: (s) => (s === 100000 ? null : 1.3) }));
  assert.equal(un.status, 0, 'an unmeasured slice is not a failure — but see the status below');
  const v = un.parse();
  assert.equal(clauseOf(v, 4).status, 'unproven', 'clause 4 is UNPROVEN, never pass, when a slice is unmeasured');
  assert.match(clauseOf(v, 4).value, /UNAVAILABLE at 100,000/, 'and says which slice went unmeasured');
  assert.match(clauseOf(v, 5).note, /at each of/, 'clause 5 carries the same "at each of" obligation');
  assert.ok(!v.cleared.includes(4), 'an unproven clause is NOT in the cleared list');
  process.stdout.write('  ✓ scale: an UNAVAILABLE slice reads UNPROVEN, never as a pass\n');
}

// ── a pre-registered slice OMITTED from the file is the omission, not compliance ─────────────────
{
  const cut = runScale(scaleReport({ slices: [10000, 500000] }));
  const v = cut.parse();
  assert.equal(clauseOf(v, 4).status, 'unproven', 'omitting 100k cannot clear clause 4');
  assert.match(clauseOf(v, 4).value, /not present in this file: 100,000/, 'the omission is named');
  assert.ok(!v.cleared.includes(4) && !v.cleared.includes(5), 'neither clause clears on a 2-of-3 file');
  assert.deepEqual(v.slices, [10000, 500000], 'the file is still reported as it is, not as it should be');
  process.stdout.write('  ✓ scale: a slice missing from the file is UNPROVEN, not compliant\n');
}

// ── clause 5b reads the INDEX-SIDE column — the column that is not the whole-process peak ────────
{
  // Whole-process peak is 5,432 MB against a 200 MB lexical run (27×, far over 2×). The index-side
  // figure is 300 MB (1.5×, within budget). A tool that compared the WRONG column would fail this
  // compliant candidate — which is the bug this test exists to catch, in the direction that matters.
  const ok = runScale(scaleReport({ lexPeak: 200, indexSide: 300 }));
  assert.equal(bulletOf(ok.parse(), '5b').status, 'pass', '5b must compare index-side RSS, not the peak');
  const bad = runScale(scaleReport({ lexPeak: 200, indexSide: 500 }));
  assert.equal(bulletOf(bad.parse(), '5b').status, 'fail', '5b fails when index-side RSS exceeds 2x');
  assert.equal(bad.status, 1, 'a 5b breach is a clause-5 failure');
  process.stdout.write('  ✓ scale: clause 5b compares the index-side column, not the whole-process peak\n');
}

// ── the other measured bullets, each fired ──────────────────────────────────────────────────────
{
  const a = runScale(scaleReport({ coldRatio: 25 }));
  assert.equal(bulletOf(a.parse(), '5a').status, 'fail', '5a fails above 20x');
  const c = runScale(scaleReport({ kbPerNode: 12 }));
  assert.equal(bulletOf(c.parse(), '5c').status, 'fail', '5c fails above 8 KB/node');
  const d = runScale(scaleReport({ incremental: (s) => (s === 100000 ? 'mismatch' : 'exact') }));
  assert.equal(bulletOf(d.parse(), '5d').status, 'fail', '5d fails on one MISMATCH row');
  assert.match(bulletOf(d.parse(), '5d').why, /MISMATCH/, 'and names what it saw');
  assert.equal(d.status, 1, 'each of these is a clause-5 failure');
  process.stdout.write('  ✓ scale: 5a/5c/5d each fire on their own violation\n');
}

// ── the five bullets are reported APART, and 5e declares itself structural ───────────────────────
{
  const v = runScale(scaleReport()).parse();
  assert.equal(v.clause5Bullets.length, 5, 'clause 5 is five bullets and must not be collapsed to one');
  const labels = v.clause5Bullets.map((b) => b.label.slice(0, 2));
  assert.deepEqual(labels, ['5a', '5b', '5c', '5d', '5e'], 'all five are labelled and in order');
  // 5e is the one bullet this harness does not measure. It must SAY so, or a reader will read it as
  // a measurement like its four siblings.
  assert.equal(bulletOf(v, '5e').status, 'pass', '5e clears');
  assert.match(bulletOf(v, '5e').why, /BY CONSTRUCTION, not by measurement/, 'and declares how');
  assert.match(clauseOf(v, 5).note, /perf-gates\.md/, 'the note points at the gates it does NOT re-measure');
  process.stdout.write('  ✓ scale: five bullets reported apart; 5e declares itself structural\n');
}

// ── refusals — an unparseable document is not a scored one ──────────────────────────────────────
{
  const noLatency = scaleReport().split('\n').filter((l) => !l.includes('p95 ratio') && !l.includes('12.34')).join('\n');
  const r1 = runScale(noLatency);
  assert.equal(r1.status, 2, 'a document with no latency table must be refused');
  assert.match(r1.stderr, /no query latency table/, 'the refusal must name the missing table');

  const badLoc = scaleReport().replace('| 10,000 | 10,000 |', '| ten-thousand | 10,000 |');
  const r2 = runScale(badLoc);
  assert.equal(r2.status, 2, 'a non-numeric Target LOC must be refused rather than keyed');
  assert.match(r2.stderr, /Target LOC cell is not numeric/, 'the refusal must quote the cell');

  const missing = spawnSync(process.execPath, [TOOL, '--scale', join(dir, 'nope.md')], { encoding: 'utf8' });
  assert.equal(missing.status, 2, 'an unreadable file must be refused');
  assert.match(missing.stderr, /cannot read the scale report/, 'the refusal must say so');
  process.stdout.write('  ✓ scale refusals: no latency table, non-numeric LOC, unreadable file\n');
}

process.stdout.write('wp4-r3-apply: PASS\n');
