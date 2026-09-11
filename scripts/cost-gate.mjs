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
 * IDLE sampling (WP10.4): after the verb calls, the serve process sits QUIESCENT for 30s with no
 * tool calls, then RSS/CPU are sampled twice (10s apart) via ps. Reported in the cost table. The
 * assertion is deliberately report-mostly: it FAILS only on clear unbounded growth (RSS growing
 * more than MAX_IDLE_RSS_GROWTH_KB between the two quiescent samples — a leak, not noise); idle
 * CPU only WARNS. A long-lived idle `crib serve` must not grow or spin.
 *
 * Usage: node scripts/cost-gate.mjs [--update]
 *   --update rewrites the budgets from the current run. Use it deliberately, and read the diff:
 *   a budget raised without a reason is this gate being switched off one line at a time.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Quiescent window before the first idle sample (no tool calls in flight). */
const IDLE_SETTLE_MS = 30_000;
/** Gap between the two idle RSS samples. */
const IDLE_SAMPLE_GAP_MS = 10_000;
/**
 * Idle RSS may grow at most this much between the two quiescent samples before the gate fails.
 * 64 MB is far above allocator/GC wobble on an idle process and far below any real leak.
 */
const MAX_IDLE_RSS_GROWTH_KB = 64 * 1024;
/** Idle CPU above this percent warns (report-only — a busy loop is worth a human's attention). */
const IDLE_CPU_WARN_PCT = 25;

const ROOT = process.cwd();
const BUDGET_FILE = join(ROOT, 'scripts', 'cost-budgets.json');
const UPDATE = process.argv.includes('--update');

/**
 * Headroom over the measured cost.
 *
 * TOKENS FAIL THE BUILD; LATENCY ONLY WARNS. Token counts are deterministic — measured under heavy
 * machine load they came back byte-identical (3782 / 2588 / 1256 / 188) while the same run's
 * wall-clock inflated 6x and tripped every budget. A gate that fires on someone else's CPU
 * contention is a gate people learn to ignore, and then it protects nothing. Latency is still
 * reported, and still useful for spotting a real slowdown, but it does not decide the exit code.
 */
const TOKEN_SLACK = 1.25;
const MS_SLACK = 3.0;

/**
 * WP10.4 idle sample — RSS (KB) and CPU% of one process via `ps`, BSD/GNU-compatible flags
 * (`-o rss=,pcpu=` suppresses the header on both macOS and Linux). Returns null if the process
 * has already exited (ps exits non-zero for an unknown pid) rather than throwing mid-gate.
 */
function sampleProcess(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    const [rssKb, cpuPct] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(rssKb) || !Number.isFinite(cpuPct)) return null;
    return { rssKb, cpuPct };
  } catch {
    return null;
  }
}

function reportIdle(idle) {
  if (!idle) {
    console.log(
      '\nidle sample: unavailable (process exited or `ps` failed — not gated, reported only)',
    );
    return;
  }
  const sign = idle.growthKb >= 0 ? '+' : '';
  console.log(
    `\nidle sample (${IDLE_SETTLE_MS / 1000}s settle, ${IDLE_SAMPLE_GAP_MS / 1000}s gap): ` +
      `RSS ${(idle.rssStartKb / 1024).toFixed(1)}→${(idle.rssEndKb / 1024).toFixed(1)}MB ` +
      `(${sign}${(idle.growthKb / 1024).toFixed(1)}MB), CPU ${idle.cpuPct.toFixed(1)}%`,
  );
}

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

  // WP10.4 idle sampling — let the serve process sit QUIESCENT (no tool calls in flight) for
  // IDLE_SETTLE_MS so any post-call GC/allocator settling is over, then take two RSS/CPU samples
  // IDLE_SAMPLE_GAP_MS apart. Growth between the two quiescent samples is the leak signal; a
  // single high sample right after a burst of calls is not.
  await sleep(IDLE_SETTLE_MS);
  const idleSample1 = sampleProcess(proc.pid);
  await sleep(IDLE_SAMPLE_GAP_MS);
  const idleSample2 = sampleProcess(proc.pid);
  proc.kill();

  const idle =
    idleSample1 && idleSample2
      ? {
          rssStartKb: idleSample1.rssKb,
          rssEndKb: idleSample2.rssKb,
          growthKb: idleSample2.rssKb - idleSample1.rssKb,
          cpuPct: Math.max(idleSample1.cpuPct, idleSample2.cpuPct),
        }
      : null;

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
    reportIdle(idle);
    return;
  }

  const budgets = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
  const failures = [];
  const warnings = [];
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
    if (msBad) warnings.push(`${name}: ${v.ms}ms over the ${b.maxMs}ms guideline`);
    console.log(
      `  ${name.padEnd(20)} ${String(v.tokens).padStart(6)} / ${String(b.maxTokens).padEnd(7)}${tokBad ? ' OVER' : '    '}  ${String(v.ms).padStart(5)} / ${String(b.maxMs).padEnd(5)}${msBad ? ' slow' : ''}`,
    );
  }
  const total = Object.values(measured).reduce((a, v) => a + v.tokens, 0);
  console.log(`\nsession total: ${total} tokens`);
  reportIdle(idle);
  if (idle) {
    if (idle.growthKb > MAX_IDLE_RSS_GROWTH_KB) {
      failures.push(
        `idle RSS grew ${(idle.growthKb / 1024).toFixed(1)}MB over ${IDLE_SAMPLE_GAP_MS / 1000}s quiescent — exceeds the ${(MAX_IDLE_RSS_GROWTH_KB / 1024).toFixed(0)}MB leak threshold`,
      );
    }
    if (idle.cpuPct > IDLE_CPU_WARN_PCT) {
      warnings.push(
        `idle CPU ${idle.cpuPct.toFixed(1)}% exceeds the ${IDLE_CPU_WARN_PCT}% guideline — a quiescent serve process should not be busy`,
      );
    }
  }
  if (warnings.length) {
    console.log('\nslower than guideline (informational — a loaded machine inflates these):');
    for (const w of warnings) console.log(`  ${w}`);
  }
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
