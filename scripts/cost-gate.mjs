#!/usr/bin/env node
/**
 * Cost gate — fails the build when a verb costs more tokens or milliseconds than its budget.
 *
 * This exists because a 43,328-token `overview` shipped unnoticed. Every cost in this system GROWS
 * with enrichment: `overview` carried one entry per authored artifact, `status` re-read every
 * artifact and materialized the whole composite graph. Work that improved ANSWERS silently
 * degraded cost, and the test suite could not see it because tests assert behaviour, not price.
 *
 * Measured the way a user actually pays: a cold `crib serve` process, spoken to over MCP stdio.
 * In-process benchmarks against a warm store reported 3ms and 487 tokens for calls that really
 * cost 150ms and 43k tokens.
 *
 * Usage: node scripts/cost-gate.mjs [--update]
 *   --update rewrites the budgets from the current run. Use it deliberately, and read the diff:
 *   a budget raised without a reason is this gate being switched off one line at a time.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BUDGET_FILE = join(ROOT, 'scripts', 'cost-budgets.json');
const UPDATE = process.argv.includes('--update');

/** Headroom over the measured cost. Tight enough to catch a real regression, loose enough that
 *  ordinary growth in a repo's own content does not fail an unrelated pull request. */
const TOKEN_SLACK = 1.25;
const MS_SLACK = 3.0; // wall-clock is noisy on shared CI; tokens are the precise signal

function rpc(proc, pending, method, params, id) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    pending.set(id, (line) =>
      resolve({
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        tokens: Math.round(line.length / 4),
      }),
    );
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function main() {
  const proc = spawn('node', [join(ROOT, 'packages/cli/dist/cli.js'), 'serve', ROOT], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          const cb = pending.get(msg.id);
          if (cb) {
            pending.delete(msg.id);
            cb(line);
          }
        } catch {
          /* not a response line */
        }
      }
      i = buf.indexOf('\n');
    }
  });

  let id = 0;
  const boot = process.hrtime.bigint();
  await rpc(
    proc,
    pending,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cost-gate', version: '1' },
    },
    ++id,
  );
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await rpc(proc, pending, 'tools/list', {}, ++id);
  const startupMs = Number(process.hrtime.bigint() - boot) / 1e6;

  // A representative symbol, resolved from the graph so the gate never measures a NOT_FOUND reply
  // (which is cheap, and would silently hide the real cost of every deep verb).
  const core = await import(`file://${join(ROOT, 'packages/core/dist/index.js')}`);
  const soul = new core.SoulStore(join(ROOT, '.crib'));
  soul.load();
  let sampleId;
  for (const node of soul.iterate('symbol')) {
    if (node.file && !node.file.includes('fixtures')) {
      sampleId = node.id;
      break;
    }
  }
  if (!sampleId) {
    console.error('no symbol in the graph — run `crib index .` first');
    process.exit(2);
  }

  const CALLS = [
    ['brief', { q: 'how do I debug a parser that hangs' }],
    ['query', { q: 'enrichment batching' }],
    ['context', { id: sampleId }],
    ['dossier', { id: sampleId }],
    ['impact', { id: sampleId }],
    ['overview', {}],
    ['status', {}],
  ];
  const measured = { 'startup+tools/list': { tokens: tools.tokens, ms: Math.round(startupMs) } };
  for (const [name, args] of CALLS) {
    const r = await rpc(proc, pending, 'tools/call', { name, arguments: args }, ++id);
    measured[name] = { tokens: r.tokens, ms: Math.round(r.ms) };
  }
  proc.kill();

  if (UPDATE || !existsSync(BUDGET_FILE)) {
    const budgets = {};
    for (const [k, v] of Object.entries(measured)) {
      budgets[k] = {
        maxTokens: Math.ceil((v.tokens * TOKEN_SLACK) / 50) * 50,
        maxMs: Math.max(Math.ceil(v.ms * MS_SLACK), 50),
      };
    }
    writeFileSync(BUDGET_FILE, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`budgets written to ${BUDGET_FILE}`);
    for (const [k, v] of Object.entries(measured))
      console.log(
        `  ${k.padEnd(20)} ${String(v.tokens).padStart(6)} tok  ${String(v.ms).padStart(5)}ms`,
      );
    return;
  }

  const budgets = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
  const failures = [];
  console.log('call                    tokens / budget      ms / budget');
  for (const [name, v] of Object.entries(measured)) {
    const b = budgets[name];
    if (!b) {
      console.log(`  ${name.padEnd(20)} (no budget — run --update)`);
      continue;
    }
    const tokBad = v.tokens > b.maxTokens;
    const msBad = v.ms > b.maxMs;
    if (tokBad) failures.push(`${name}: ${v.tokens} tokens exceeds budget ${b.maxTokens}`);
    if (msBad) failures.push(`${name}: ${v.ms}ms exceeds budget ${b.maxMs}ms`);
    console.log(
      `  ${name.padEnd(20)} ${String(v.tokens).padStart(6)} / ${String(b.maxTokens).padEnd(7)}${tokBad ? ' OVER' : '    '}  ${String(v.ms).padStart(5)} / ${String(b.maxMs).padEnd(5)}${msBad ? ' OVER' : ''}`,
    );
  }
  const total = Object.values(measured).reduce((a, v) => a + v.tokens, 0);
  console.log(`\nsession total: ${total} tokens`);
  if (failures.length) {
    console.error('\nFAIL — cost regression:');
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      '\nIf the new cost is genuinely justified, re-run with --update and explain the diff.',
    );
    process.exit(1);
  }
  console.log('OK — every verb within budget');
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
