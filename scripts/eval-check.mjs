/**
 * eval-check — the M1.1 retrieval-quality regression gate.
 *
 * Runs the eval harness (scripts/eval/harness.mjs) and compares recall@10 / MRR / nDCG@10 — per
 * language AND overall — against the committed baseline in scripts/eval-baseline.json. A drop
 * greater than MAX_REGRESSION_PCT on ANY tracked metric fails the build. This is the plan's
 * ">20% regression fails build" contract made into a CI fact, mirroring budget-check.mjs's
 * shape (failures[] + check() + process.exit(1)).
 *
 * Bootstrap: if scripts/eval-baseline.json is absent, the current run is written as the baseline
 * and the gate passes. This lets the first commit land the harness + baseline together; every
 * subsequent run is measured against it. To refresh the baseline deliberately, delete the file
 * and re-run (then commit the new baseline) — do NOT silence a regression this way without a
 * deliberate review.
 *
 * Higher metric = better for all three (recall, MRR, nDCG). Regression pct = (baseline - current)
 * / baseline × 100. A baseline of 0 (no signal ever) is treated as "no floor to regress against"
 * for that metric so a 0→0 or 0→small step never false-fails; a baseline >0 collapsing to 0 is a
 * 100% regression and fails.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runEval } from './eval/harness.mjs';

/** A metric drop greater than this (vs baseline) fails the build. */
const MAX_REGRESSION_PCT = 20;
const BASELINE_PATH = resolve('scripts', 'eval-baseline.json');
const METRICS = ['recall10', 'mrr', 'ndcg10'];

const failures = [];
// Hoisted stash so the second check reads the first check's result without a TDZ ReferenceError
// (the first check's callback runs during the first await, before any later `let` is initialized).
let evalReport = null;

async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    process.stdout.write(`FAIL  ${name}: ${msg}\n`);
  }
}

function regressionPct(baseline, current) {
  if (baseline === 0) return 0; // no floor — nothing to regress against
  return ((baseline - current) / baseline) * 100;
}

await check('eval harness runs across all fixture languages', async () => {
  const report = await runEval();
  // Stash for the baseline-compare check (and for the bootstrap write path).
  evalReport = report;
  const langs = Object.keys(report.perLang);
  if (langs.length === 0) throw new Error('harness produced no per-language results');
  for (const lang of langs) {
    const r = report.perLang[lang];
    if (r.pairs === 0) throw new Error(`${lang} produced 0 golden pairs`);
    if (r.recall10 <= 0)
      throw new Error(`${lang} recall@10 is 0 — retrieval is broken, not regressed`);
  }
});

await check(`metrics regressed <= ${MAX_REGRESSION_PCT}% vs baseline`, async () => {
  if (!evalReport) throw new Error('harness did not produce a report');
  if (!existsSync(BASELINE_PATH)) {
    // Bootstrap: commit the first baseline.
    writeFileSync(BASELINE_PATH, `${JSON.stringify(evalReport, null, 2)}\n`);
    process.stdout.write(
      '  [bootstrap] no baseline found — wrote current run as scripts/eval-baseline.json\n' +
        '  re-run to measure against it.\n',
    );
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  for (const lang of Object.keys(evalReport.perLang)) {
    const cur = evalReport.perLang[lang];
    const base = baseline.perLang?.[lang];
    if (!base) {
      // New fixture language since baseline — not a regression, but record it.
      process.stdout.write(`  [${lang}] new since baseline (pairs=${cur.pairs})\n`);
      continue;
    }
    for (const m of METRICS) {
      const reg = regressionPct(base[m], cur[m]);
      if (reg > MAX_REGRESSION_PCT) {
        throw new Error(
          `${lang} ${m} regressed ${reg.toFixed(1)}% (baseline ${base[m].toFixed(3)} → ` +
            `current ${cur[m].toFixed(3)}) > cap ${MAX_REGRESSION_PCT}%`,
        );
      }
    }
  }
  // Overall macro-average too — a uniform small drop across all langs is itself a signal.
  for (const m of METRICS) {
    const reg = regressionPct(baseline.overall[m], evalReport.overall[m]);
    if (reg > MAX_REGRESSION_PCT) {
      throw new Error(
        `overall ${m} regressed ${reg.toFixed(1)}% (baseline ${baseline.overall[m].toFixed(3)} → ` +
          `current ${evalReport.overall[m].toFixed(3)}) > cap ${MAX_REGRESSION_PCT}%`,
      );
    }
  }
  // Report the current numbers so CI logs show the living metrics, not just pass/fail.
  for (const lang of Object.keys(evalReport.perLang)) {
    const r = evalReport.perLang[lang];
    process.stdout.write(
      `  [${lang}] pairs=${r.pairs}  R@10=${r.recall10.toFixed(3)}  MRR=${r.mrr.toFixed(3)}  ` +
        `nDCG@10=${r.ndcg10.toFixed(3)}\n`,
    );
  }
});

if (failures.length > 0) {
  process.stderr.write(
    `\neval-check failed (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('\neval-check ok - retrieval quality held within regression budget\n');
