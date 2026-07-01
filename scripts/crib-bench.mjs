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
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI = resolve('packages/cli/dist/cli.js');
const REPO_ROOT = resolve('.');

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

  rows.push({
    query: q,
    hits: hits.length,
    rawFileReadTokens: raw.tokens,
    rawFileCount: raw.fileCount,
    cribDefaultTokens: defaultTokens,
    cribFullTokens: fullTokens,
    vsRawFileRead: raw.tokens > 0 ? +(raw.tokens / defaultTokens).toFixed(2) : null,
    tieredSavings: +(fullTokens / defaultTokens).toFixed(2),
  });
}

const totals = rows.reduce(
  (acc, r) => ({
    raw: acc.raw + r.rawFileReadTokens,
    cribDefault: acc.cribDefault + r.cribDefaultTokens,
    cribFull: acc.cribFull + r.cribFullTokens,
  }),
  { raw: 0, cribDefault: 0, cribFull: 0 },
);

const report = {
  repo: REPO_ROOT,
  generatedAt: new Date().toISOString(),
  queries: rows,
  totals: {
    ...totals,
    vsRawFileReadOverall: totals.raw > 0 ? +(totals.raw / totals.cribDefault).toFixed(2) : null,
    tieredSavingsOverall: +(totals.cribFull / totals.cribDefault).toFixed(2),
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
].join('\n');

const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1], md);
  process.stdout.write(`\nwrote ${process.argv[outIdx + 1]}\n`);
}
