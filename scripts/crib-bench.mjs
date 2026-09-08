/**
 * Public, reproducible token-savings benchmark (P0). Runs real `crib query` calls against this
 * repo's own committed soul and compares three token costs for the same discovery task:
 *
 *   1. raw-file-read  — what an agent without crib pays: read every whole file that contains a hit
 *   2. crib-default    — the tiered default response (one-line snippet + LLM pointer when present)
 *   3. crib-full       — the same query with --with-llm (full analysis+graph+evidence blob)
 *
 * Anyone can reproduce this: `node scripts/crib-bench.mjs` from a checked-out, indexed repo.
 * `--out <path>` also writes a markdown report.
 *
 * REPORT-ONLY BY DECISION (WP10.4): this benchmark's job is the PUBLISHED number, not the gate.
 * The enforced token budget is budget-check.mjs's MIN_COST_SAVING cost-saving floor, which fails
 * the build on a retrieval regression; duplicating that assertion here would give the same law
 * two owners. The optional `--ceil <tokens>` flag exists for callers who want the total
 * crib-default tokens over the query set to be a hard ceiling (e.g. an ad-hoc local check):
 * when given, the run exits 1 if the total exceeds the ceiling. It is deliberately NOT wired
 * into any CI gate — see docs/bench/perf-gates.md.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rates, sessionCost, usd } from './lib/pricing.mjs';

const CLI = resolve('packages/cli/dist/cli.js');
const REPO_ROOT = resolve('.');

// A discovery answer is not read once — it is referenced across the follow-up turns of an agent
// task. `--turns N` models that reuse; the cache economics (cheap re-reads of a stable context vs
// re-primed churn) are what turn a token win into a dollar win. Default 6 ≈ a small multi-turn task.
const turnsArg = process.argv.indexOf('--turns');
let TURNS = 6;
if (turnsArg >= 0) {
  // Number('abc') is NaN and Math.max(1, NaN) is NaN — silently poisoning every cost figure. Reject
  // non-positive-integer input loudly instead of computing a NaN benchmark.
  TURNS = Number(process.argv[turnsArg + 1]);
  if (!Number.isInteger(TURNS) || TURNS < 1) {
    throw new Error(
      `--turns must be a positive integer, got ${JSON.stringify(process.argv[turnsArg + 1])}`,
    );
  }
}

// Optional token ceiling (report-only by default — see the header). 0 = unset = no assertion.
const ceilArg = process.argv.indexOf('--ceil');
let TOKEN_CEIL = 0;
if (ceilArg >= 0) {
  TOKEN_CEIL = Number(process.argv[ceilArg + 1]);
  if (!Number.isInteger(TOKEN_CEIL) || TOKEN_CEIL < 1) {
    throw new Error(
      `--ceil must be a positive integer (max total crib-default tokens), got ${JSON.stringify(process.argv[ceilArg + 1])}`,
    );
  }
}
const PRICE = rates();

// Real symbols known to exist in this self-indexed repo — chosen to span packages so the
// benchmark reflects a typical multi-hit discovery query, not a cherry-picked single hit.
// `cmdIndex` has a saved LLM artifact, so it also exercises the default-vs-full tiered-savings path
// (the other queries hit symbols with no LLM analysis yet, where tieredSavings is honestly 1x).
const QUERIES = ['SoulStore', 'indexRepo', 'Verbs', 'buildIndex', 'estimateTokens', 'cmdIndex'];

function runCli(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

// `sym:<file>#<name>@L<line>` / `file:<path>` — pull the source file path out of a node id.
function fileOfId(id) {
  const m = /^(?:sym|file|cluster):([^#]+?)(?:#.*)?$/.exec(id);
  return m ? m[1] : undefined;
}

function rawFileReadTokens(hits) {
  const files = new Set();
  for (const hit of hits) {
    const file = fileOfId(hit.id);
    if (file) files.add(file);
  }
  let total = 0;
  for (const file of files) {
    try {
      total += estimateTokens(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
    } catch {
      // hit referenced a file outside the worktree (e.g. node_modules type) — skip, don't crash the bench
    }
  }
  return { tokens: total, fileCount: files.size };
}

const rows = [];
for (const q of QUERIES) {
  const defaultOut = runCli(['query', q, '--limit', '10']);
  const fullOut = runCli(['query', q, '--limit', '10', '--with-llm']);
  const defaultParsed = JSON.parse(defaultOut);
  const fullParsed = JSON.parse(fullOut);
  const hits = defaultParsed.hits ?? [];

  const defaultTokens = estimateTokens(defaultOut);
  const fullTokens = estimateTokens(fullOut);
  const raw = rawFileReadTokens(hits);

  // Session dollar cost of each retrieval path over TURNS turns.
  //  - crib: proven byte-deterministic output (see crib-cache-stability.test.mjs) => cache-stable,
  //    primed once then re-read at the 0.1x rate.
  //  - no-crib (raw-file-read): the agent's working set churns as it greps/reads across turns, so its
  //    context is re-primed at the 1.25x cache-write rate every turn (stable:false). We ALSO compute a
  //    conservative variant that gives no-crib the SAME cache discount crib gets, so the headline win
  //    is never an artifact of the churn assumption — crib still wins there, just by less.
  const cribCost = sessionCost({ contextTokens: defaultTokens, turns: TURNS }, PRICE);
  const noCribCost = sessionCost({ contextTokens: raw.tokens, turns: TURNS, stable: false }, PRICE);
  const noCribCostCached = sessionCost({ contextTokens: raw.tokens, turns: TURNS }, PRICE);

  rows.push({
    query: q,
    hits: hits.length,
    rawFileReadTokens: raw.tokens,
    rawFileCount: raw.fileCount,
    cribDefaultTokens: defaultTokens,
    cribFullTokens: fullTokens,
    vsRawFileRead: raw.tokens > 0 ? +(raw.tokens / defaultTokens).toFixed(2) : null,
    tieredSavings: +(fullTokens / defaultTokens).toFixed(2),
    cribCostUsd: usd(cribCost),
    noCribCostUsd: usd(noCribCost),
    noCribCostCachedUsd: usd(noCribCostCached),
    costSavingVsChurn: cribCost > 0 ? +(noCribCost / cribCost).toFixed(2) : null,
    costSavingCached: cribCost > 0 ? +(noCribCostCached / cribCost).toFixed(2) : null,
  });
}

const totals = rows.reduce(
  (acc, r) => ({
    raw: acc.raw + r.rawFileReadTokens,
    cribDefault: acc.cribDefault + r.cribDefaultTokens,
    cribFull: acc.cribFull + r.cribFullTokens,
    cribCost: acc.cribCost + r.cribCostUsd,
    noCribCost: acc.noCribCost + r.noCribCostUsd,
    noCribCostCached: acc.noCribCostCached + r.noCribCostCachedUsd,
  }),
  { raw: 0, cribDefault: 0, cribFull: 0, cribCost: 0, noCribCost: 0, noCribCostCached: 0 },
);

const report = {
  repo: REPO_ROOT,
  generatedAt: new Date().toISOString(),
  turns: TURNS,
  priceModel: PRICE,
  queries: rows,
  totals: {
    ...totals,
    cribCost: usd(totals.cribCost),
    noCribCost: usd(totals.noCribCost),
    noCribCostCached: usd(totals.noCribCostCached),
    vsRawFileReadOverall: totals.raw > 0 ? +(totals.raw / totals.cribDefault).toFixed(2) : null,
    tieredSavingsOverall: +(totals.cribFull / totals.cribDefault).toFixed(2),
    costSavingVsChurnOverall:
      totals.cribCost > 0 ? +(totals.noCribCost / totals.cribCost).toFixed(2) : null,
    costSavingCachedOverall:
      totals.cribCost > 0 ? +(totals.noCribCostCached / totals.cribCost).toFixed(2) : null,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

const md = [
  '# crib-bench report',
  '',
  `Generated ${report.generatedAt} against \`${REPO_ROOT}\`.`,
  '',
  '| query | hits | raw-file-read tokens | crib-default tokens | crib-full tokens | vs raw-file-read | tiered savings |',
  '|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.query} | ${r.hits} | ${r.rawFileReadTokens} | ${r.cribDefaultTokens} | ${r.cribFullTokens} | ${r.vsRawFileRead ?? 'n/a'}x | ${r.tieredSavings}x |`,
  ),
  '',
  `**Overall:** crib-default beats raw-file-read by **${report.totals.vsRawFileReadOverall ?? 'n/a'}x**; ` +
    `default tier beats full tier by **${report.totals.tieredSavingsOverall}x**.`,
  '',
  `## Cost per task (session model, ${TURNS} turns)`,
  '',
  `Dollars, not tokens — the number that answers "why more tokens yet less money". Prices (USD/1M): input $${PRICE.input}, output $${PRICE.output}, cache-write $${PRICE.cacheWrite}, cache-read $${PRICE.cacheRead}. crib context is cache-stable (primed once, re-read cheap); no-crib churns (re-primed each turn). The *cached* column gives no-crib the same discount crib gets.`,
  '',
  '| query | crib $/task | no-crib $/task (churn) | no-crib $/task (cached) | crib cheaper by (churn) | (cached) |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.query} | ${r.cribCostUsd} | ${r.noCribCostUsd} | ${r.noCribCostCachedUsd} | ${r.costSavingVsChurn ?? 'n/a'}x | ${r.costSavingCached ?? 'n/a'}x |`,
  ),
  '',
  `**Cost per task:** crib **$${report.totals.cribCost}** vs no-crib **$${report.totals.noCribCost}** ` +
    `(churn) / **$${report.totals.noCribCostCached}** (cached) → crib is ` +
    `**${report.totals.costSavingVsChurnOverall ?? 'n/a'}x** cheaper (churn), ` +
    `**${report.totals.costSavingCachedOverall ?? 'n/a'}x** cheaper even if no-crib were perfectly cached.`,
  '',
].join('\n');

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1], md);
  process.stdout.write(`\nwrote ${process.argv[outIdx + 1]}\n`);
}

// The optional --ceil assertion: fail when the total crib-default tokens over the query set
// exceeds the caller's ceiling. Unset (the default) keeps the run report-only.
if (TOKEN_CEIL > 0 && totals.cribDefault > TOKEN_CEIL) {
  process.stderr.write(
    `crib-bench FAIL — total crib-default tokens ${totals.cribDefault} > ceiling ${TOKEN_CEIL}\n`,
  );
  process.exit(1);
}
if (TOKEN_CEIL > 0) {
  process.stdout.write(`token ceiling held: ${totals.cribDefault} <= ${TOKEN_CEIL}\n`);
}
