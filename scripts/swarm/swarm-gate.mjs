#!/usr/bin/env node
/**
 * Swarm gate — proves many agents can share ONE graph, correctly, under load and under abuse.
 *
 * Why a daemon at all: the stdio transport is one process per client, and each loads the whole
 * graph — measured on this repo at 213 MB and ~450ms EACH. Four hundred agents would need ~83 GB
 * of RAM to hold 400 identical copies of the same graph, which is more than the machine has.
 * Sharing one instance is what makes a swarm possible rather than merely slow.
 *
 * What this asserts, in order of what actually matters:
 *   1. CORRECTNESS under concurrency — each agent asks a question whose right answer is known, and
 *      the response is checked for THAT answer. A daemon serving 400 fast wrong answers is worse
 *      than one serving none, and a liveness-only check cannot tell the two apart.
 *   2. Resilience — malformed bodies, unknown tools, a 200KB query, and 50 clients hanging up
 *      mid-flight must not crash the daemon or corrupt a neighbour's answer.
 *   3. No leak — RSS must return near baseline after the load, or a long-running daemon dies.
 *
 * Usage: node scripts/swarm/swarm-gate.mjs [agents]   (default 400)
 */
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const AGENTS = Number(process.argv[2] ?? 400);
const PORT = 7000 + Math.floor(Math.random() * 900);

const rssMb = (pid) => {
  try {
    return Math.round(
      Number(
        execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
          .toString()
          .trim(),
      ) / 1024,
    );
  } catch {
    return -1;
  }
};
const run = (script, args) =>
  new Promise((resolve) => {
    const p = spawn('node', [join(HERE, script), String(PORT), ...args], { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
  });

const daemon = spawn(
  'node',
  [join(ROOT, 'packages/cli/dist/cli.js'), 'serve', ROOT, '--http', '--port', String(PORT)],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let ready = false;
daemon.stderr.on('data', (d) => {
  if (String(d).includes('daemon on http')) ready = true;
});
const deadline = Date.now() + 30000;
while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
if (!ready) {
  console.error('daemon did not start within 30s');
  daemon.kill();
  process.exit(2);
}

const baseline = rssMb(daemon.pid);
console.log(`daemon up on :${PORT} — baseline RSS ${baseline} MB\n`);

let failures = 0;
console.log('── correctness under concurrency ──');
failures += await run('swarm-correctness.mjs', [String(AGENTS)]);
console.log('\n── correctness with realistic staggered arrival ──');
failures += await run('swarm-correctness.mjs', [String(AGENTS), '--stagger']);
console.log('\n── resilience ──');
failures += await run('swarm-resilience.mjs', []);

console.log('\n── memory ──');
const peak = rssMb(daemon.pid);
await new Promise((r) => setTimeout(r, 10000)); // let GC settle
const idle = rssMb(daemon.pid);
console.log(`  baseline ${baseline} MB -> peak ${peak} MB -> idle ${idle} MB`);
// Generous: GC timing varies by machine. This catches an unbounded leak, not ordinary churn.
const leakCeiling = baseline * 3;
if (idle > leakCeiling) {
  console.log(`  FAIL: idle RSS ${idle} MB exceeds ${leakCeiling} MB — possible leak`);
  failures++;
} else console.log('  ok — memory returns near baseline');

daemon.kill();
console.log(
  failures
    ? `\nSWARM GATE FAILED (${failures})`
    : `\nSWARM GATE PASSED — ${AGENTS} agents, one shared graph`,
);
process.exit(failures ? 1 : 0);
