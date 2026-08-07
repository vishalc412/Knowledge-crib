/**
 * Real-session cost attribution (closes item 5 — the output-token leg the modeled harness leaves at
 * zero). Where `crib-bench.mjs` *models* a task, this tool *measures* one: it ingests the actual four
 * token buckets Anthropic bills — input, output, cache-read, cache-write — for a with-crib run and a
 * without-crib run of the SAME task, and computes the true dollar cost of each from the shared rate
 * model. These are exactly the numbers the Claude Code `/usage` panel reports per session.
 *
 * This is what turns the "more tokens, yet less money" screenshot into a reproducible fact:
 *   - it prints total tokens and total dollars for each run, so the paradox is visible side by side;
 *   - if a run includes its `reportedCostUsd` (the figure the panel showed), it reconciles computed
 *     vs reported so the rate model is validated against real billing, not asserted;
 *   - it credits crib for reduced OUTPUT tokens too — the leg the static bench cannot see — because
 *     here the output count is a measured input, not an assumption.
 *
 * Usage:
 *   node scripts/crib-cost-report.mjs runs.json           # one file with { withCrib, withoutCrib }
 *   node scripts/crib-cost-report.mjs withCrib.json without.json
 *
 * Each run object: { input, output, cacheRead, cacheWrite, reportedCostUsd? }  (token counts; USD).
 */
import { readFileSync } from 'node:fs';
import { bucketCost, rates, usd } from './lib/pricing.mjs';

const PRICE = rates();
const BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const RATE_OF = {
  input: 'input',
  output: 'output',
  cacheRead: 'cacheRead',
  cacheWrite: 'cacheWrite',
};

function loadRuns(argv) {
  const files = argv.slice(2);
  if (files.length === 1) {
    const doc = JSON.parse(readFileSync(files[0], 'utf8'));
    if (!doc.withCrib || !doc.withoutCrib) {
      throw new Error('single-file input must have both "withCrib" and "withoutCrib" keys');
    }
    return { withCrib: doc.withCrib, withoutCrib: doc.withoutCrib };
  }
  if (files.length === 2) {
    return {
      withCrib: JSON.parse(readFileSync(files[0], 'utf8')),
      withoutCrib: JSON.parse(readFileSync(files[1], 'utf8')),
    };
  }
  throw new Error('provide one combined JSON file, or two files (with-crib then without-crib)');
}

function validateRun(run, label) {
  for (const b of BUCKETS) {
    const v = run[b];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`${label}.${b} must be a non-negative number, got ${JSON.stringify(v)}`);
    }
  }
  if (
    run.reportedCostUsd !== undefined &&
    (typeof run.reportedCostUsd !== 'number' || run.reportedCostUsd < 0)
  ) {
    throw new Error(`${label}.reportedCostUsd must be a non-negative number if present`);
  }
}

function costOf(run) {
  const perBucket = {};
  let total = 0;
  for (const b of BUCKETS) {
    const c = bucketCost(run[b], PRICE[RATE_OF[b]]);
    perBucket[b] = usd(c);
    total += c;
  }
  return { perBucket, totalUsd: usd(total), totalTokens: BUCKETS.reduce((s, b) => s + run[b], 0) };
}

const { withCrib, withoutCrib } = loadRuns(process.argv);
validateRun(withCrib, 'withCrib');
validateRun(withoutCrib, 'withoutCrib');

const a = costOf(withCrib); // with crib
const b = costOf(withoutCrib); // without crib

// Reconciliation: does the shared rate model reproduce the panel's reported cost? If it drifts hard,
// the rates are wrong (or a bucket is mis-mapped) and every downstream claim is suspect — surface it.
function reconcile(run, computed, label) {
  if (run.reportedCostUsd === undefined) return null;
  const diff = computed.totalUsd - run.reportedCostUsd;
  const pct = run.reportedCostUsd > 0 ? (diff / run.reportedCostUsd) * 100 : null;
  return {
    label,
    computedUsd: computed.totalUsd,
    reportedUsd: run.reportedCostUsd,
    diffUsd: usd(diff),
    pct: pct === null ? null : +pct.toFixed(1),
  };
}

// Two cost lenses, kept separate on purpose:
//  - list-rate  : what the run WOULD cost on API pay-as-you-go, from the shared rate model. Here
//                 cache-read is 0.1x input — cheap, but NOT free, so more cache-read tokens still add up.
//  - reported   : the figure the /usage panel actually showed (subscription/plan billing). On a Max/Pro
//                 plan, marginal cache-read is effectively subsidized, which is why the same run can be
//                 far cheaper than its list-rate equivalent.
// The "more tokens, less money" claim must name its lens — it can be TRUE on a plan yet FALSE at list
// rates. Judging it on the wrong basis is exactly the trap this tool exists to prevent.
function lens(costA, costB) {
  return {
    costRatio: costB > 0 ? +(costA / costB).toFixed(2) : null,
    cribCostsLess: costA < costB,
    paradoxConfirmed: a.totalTokens > b.totalTokens && costA < costB,
  };
}

const haveReported =
  withCrib.reportedCostUsd !== undefined && withoutCrib.reportedCostUsd !== undefined;

const report = {
  priceModel: PRICE,
  withCrib: { tokens: a.totalTokens, listRateCostUsd: a.totalUsd, perBucketUsd: a.perBucket },
  withoutCrib: { tokens: b.totalTokens, listRateCostUsd: b.totalUsd, perBucketUsd: b.perBucket },
  verdict: {
    tokenRatio: b.totalTokens > 0 ? +(a.totalTokens / b.totalTokens).toFixed(2) : null,
    cribUsesMoreTokens: a.totalTokens > b.totalTokens,
    byListRate: lens(a.totalUsd, b.totalUsd),
    byReportedCost: haveReported
      ? lens(withCrib.reportedCostUsd, withoutCrib.reportedCostUsd)
      : null,
  },
  reconciliation: [
    reconcile(withCrib, a, 'withCrib'),
    reconcile(withoutCrib, b, 'withoutCrib'),
  ].filter(Boolean),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const v = report.verdict;
const lines = [
  '',
  `Tokens: with-crib ${v.cribUsesMoreTokens ? 'used MORE' : 'used fewer'} (${v.tokenRatio}x the without-crib run).`,
];
if (v.byReportedCost) {
  const rc = v.byReportedCost;
  lines.push(
    `On your PLAN (reported /usage cost): ${rc.paradoxConfirmed ? 'PARADOX CONFIRMED — more tokens, less money' : 'no paradox'} ` +
      `(with-crib cost ${rc.costRatio}x the without-crib run).`,
  );
}
const lr = v.byListRate;
lines.push(
  `At API LIST rates: ${lr.paradoxConfirmed ? 'PARADOX CONFIRMED' : 'NO paradox — the extra (cache-read) tokens are discounted but not free'} ` +
    `(with-crib cost ${lr.costRatio}x the without-crib run).`,
);
if (report.reconciliation.some((r) => r.pct !== null && Math.abs(r.pct) > 25)) {
  lines.push(
    'Reconciliation: reported plan cost diverges >25% from list-rate — your plan subsidizes cache-read, ' +
      'so a "cheaper" result here is a plan effect, not a list-rate truth. Quote the lens explicitly.',
  );
}
process.stdout.write(`${lines.join('\n')}\n`);
