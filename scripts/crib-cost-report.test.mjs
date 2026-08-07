/**
 * Tests for the real-session cost attribution tool. Runs it as a subprocess (it executes on load)
 * against crafted bucket data and asserts the dual-lens verdict is judged on the correct cost basis —
 * the exact bug the tool exists to prevent (calling a plan-only paradox a list-rate truth).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TOOL = resolve('scripts/crib-cost-report.mjs');
const dir = mkdtempSync(join(tmpdir(), 'crib-cost-report-test-'));

function run(doc) {
  const file = join(dir, `runs-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(doc));
  // Capture stderr (not inherit) so an expected-throw child does not spray its stack on the console;
  // the message is still available on err.stderr for assertions.
  return execFileSync(process.execPath, [TOOL, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// The tool prints pretty JSON then a plain-text summary that contains no '}' — so the JSON payload
// always ends at the final closing brace. Robust for every case.
function parseReport(out) {
  return JSON.parse(out.slice(0, out.lastIndexOf('}') + 1));
}

// 1. Plan-only paradox: with-crib uses more tokens (cache-read heavy) yet the reported plan cost is
// lower, while list rates say otherwise. The verdict must confirm on reported, deny on list-rate.
{
  const out = run({
    withCrib: {
      input: 179600,
      output: 4500,
      cacheRead: 3500000,
      cacheWrite: 274600,
      reportedCostUsd: 0.56,
    },
    withoutCrib: {
      input: 128300,
      output: 180,
      cacheRead: 1600000,
      cacheWrite: 219300,
      reportedCostUsd: 1.12,
    },
  });
  const parsed = JSON.parse(
    out.slice(0, out.indexOf('\n\n')) || out.slice(0, out.lastIndexOf('}') + 1),
  );
  assert.equal(parsed.verdict.cribUsesMoreTokens, true, 'with-crib should show more tokens');
  assert.equal(
    parsed.verdict.byReportedCost.paradoxConfirmed,
    true,
    'reported-cost lens must confirm the paradox',
  );
  assert.equal(
    parsed.verdict.byListRate.paradoxConfirmed,
    false,
    'list-rate lens must NOT confirm it',
  );
  assert.match(
    out,
    /your plan subsidizes cache-read/,
    'must warn when reported diverges from list-rate',
  );
}

// 2. Genuine list-rate win: with-crib uses FEWER tokens (compact retrieval) and is cheaper both ways.
{
  const out = run({
    withCrib: { input: 2000, output: 500, cacheRead: 1000, cacheWrite: 2000 },
    withoutCrib: { input: 50000, output: 500, cacheRead: 0, cacheWrite: 0 },
  });
  const parsed = parseReport(out);
  assert.equal(parsed.verdict.cribUsesMoreTokens, false, 'compact retrieval uses fewer tokens');
  assert.equal(
    parsed.verdict.byListRate.cribCostsLess,
    true,
    'fewer tokens must be cheaper at list rates',
  );
  assert.equal(parsed.verdict.byReportedCost, null, 'no reported cost => that lens is null');
}

// 3. Input validation: a negative bucket must be rejected loudly.
{
  let threw;
  try {
    run({
      withCrib: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
      withoutCrib: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'negative token count must exit non-zero');
  // execFileSync surfaces the child's stderr on err.stderr, not err.message.
  assert.match(String(threw.stderr), /non-negative number/, 'must reject a negative bucket loudly');
}

console.log('crib cost-report tests ok');
