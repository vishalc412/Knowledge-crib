/**
 * Real task-level A/B (the closest honest thing to a live agent A/B without an API key). It answers
 * the SAME cross-package investigation two ways against THIS repo and measures the actual context
 * tokens each path pulls in — real bytes, not modeled counts:
 *
 *   Task: "understand the query pipeline — SoulStore, the index build, and the query verb, and how
 *          they relate."
 *
 *   Path B (no crib): what a crib-less agent actually does — grep the codebase for each symbol, then
 *     READ THE WHOLE FILE that defines it (agents can't read half a file). Relationships cost extra
 *     whole-file reads. Measured by walking each package src tree and reading real file contents.
 *
 *   Path A (crib): `crib query` pinpoints the symbol (one snippet, not the file) and `crib neighbors`
 *     returns the relationships as graph edges — no file bodies read at all. Measured from real CLI output.
 *
 * The token counts are MEASURED. The multi-turn dollar cost is then derived with the shared session
 * model (disclosed). What this CANNOT measure — live cache-read/write and output tokens — needs a real
 * model call; capture those with `crib-cost-report.mjs` from two real sessions' /usage panels.
 *
 * Run: node scripts/crib-ab-task.mjs   (from an indexed checkout).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { coldCost, sessionCost, usd } from './lib/pricing.mjs';

const CLI = resolve('packages/cli/dist/cli.js');
const TURNS = 6;

// The investigation. Real symbols spanning core/pipeline/mcp — a genuine "how does querying work" task.
const SYMBOLS = ['SoulStore', 'buildIndex', 'Verbs'];
const SRC_ROOTS = [
  'packages/core/src',
  'packages/pipeline/src',
  'packages/mcp/src',
  'packages/cli/src',
];

function estTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function crib(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkTs(full, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// ---- Path B: no crib. Grep for each symbol's DEFINITION, read the whole defining files. ----
const allTs = SRC_ROOTS.flatMap((d) => walkTs(d));
const noCribFiles = new Set();
for (const sym of SYMBOLS) {
  const def = new RegExp(`\\b(export\\s+)?(class|function|interface|const|type)\\s+${sym}\\b`);
  for (const file of allTs) {
    const text = readFileSync(file, 'utf8');
    if (def.test(text)) noCribFiles.add(file);
  }
}
let noCribTokens = 0;
for (const file of noCribFiles) noCribTokens += estTokens(readFileSync(file, 'utf8'));

// ---- Path A: crib. Pinpoint each symbol + pull its relationships as edges (no file bodies). ----
let cribTokens = 0;
const cribCalls = [];
for (const sym of SYMBOLS) {
  const q = crib(['query', sym, '--limit', '5']);
  cribTokens += estTokens(q);
  cribCalls.push(`query ${sym}`);
  // resolve the top hit id and pull its neighbors — the relationship answer crib gives for free.
  const top = (JSON.parse(q).hits ?? [])[0];
  if (top) {
    const n = crib(['neighbors', top.id, '--dir', 'both', '--limit', '10']);
    cribTokens += estTokens(n);
    cribCalls.push(`neighbors ${sym}`);
  }
}

const cribCost = sessionCost({ contextTokens: cribTokens, turns: TURNS });
const noCribCost = sessionCost({ contextTokens: noCribTokens, turns: TURNS, stable: false });
const noCribCostCached = sessionCost({ contextTokens: noCribTokens, turns: TURNS });
// Cold lens: cache cleared, one pass, everything fresh input. No cache-read discount either way, so
// the dollar difference is exactly the token difference — the "actual difference" the user asked for.
const cribCold = coldCost(cribTokens);
const noCribCold = coldCost(noCribTokens);

const report = {
  task: 'understand the query pipeline (SoulStore + index build + query verb + relationships)',
  turns: TURNS,
  noCrib: {
    strategy: 'grep + read whole defining files',
    filesRead: noCribFiles.size,
    files: [...noCribFiles],
    contextTokens: noCribTokens,
    coldCostUsd: usd(noCribCold),
    costUsd: usd(noCribCost),
    costCachedUsd: usd(noCribCostCached),
  },
  crib: {
    strategy: 'crib query + neighbors (pinpoint snippets + graph edges, no file bodies)',
    calls: cribCalls,
    contextTokens: cribTokens,
    coldCostUsd: usd(cribCold),
    costUsd: usd(cribCost),
  },
  verdict: {
    tokenReduction: cribTokens > 0 ? +(noCribTokens / cribTokens).toFixed(2) : null,
    // Cold: cache cleared, actual difference. Equals the token ratio by construction — that IS the point.
    coldCostSaving: cribCold > 0 ? +(noCribCold / cribCold).toFixed(2) : null,
    coldExtraDollarsNoCrib: usd(noCribCold - cribCold),
    costSavingVsChurn: cribCost > 0 ? +(noCribCost / cribCost).toFixed(2) : null,
    costSavingCached: cribCost > 0 ? +(noCribCostCached / cribCost).toFixed(2) : null,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `\nReal measured context for the SAME task: no-crib ${noCribTokens} tokens ` +
    `(${noCribFiles.size} whole files) vs crib ${cribTokens} tokens.\n` +
    `COLD (cache cleared, actual difference): no-crib $${usd(noCribCold)} vs crib $${usd(cribCold)} ` +
    `→ ${report.verdict.coldCostSaving}x cheaper, +$${report.verdict.coldExtraDollarsNoCrib} wasted per no-crib task.\n` +
    `WARM 6-turn session: ${report.verdict.costSavingVsChurn}x cheaper ` +
    `(${report.verdict.costSavingCached}x even if no-crib reads were perfectly cached).\n`,
);
