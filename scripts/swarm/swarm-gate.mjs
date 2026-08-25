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
 *   0. IDENTITY — the daemon is serving THIS repo's soul. Root resolution walks up to any ancestor
 *      with .crib/crib.json, so a corrupt or missing local crib silently serves a wrong soul and
 *      every correctness case then reports 0/N CORRECT — indistinguishable from a retrieval defect.
 *      Measured 2026-08-25: this gate served a 366-node ancestor soul (~/Documents/.crib) and
 *      reported SWARM GATE FAILED (2) with no hint of the cause.
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
import { existsSync } from 'node:fs';
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

// ── identity check ──────────────────────────────────────────────────────────────────────────────
// Everything below this line is only meaningful if the daemon is answering from THIS repo's soul.
// `crib serve` walks up from ROOT to the nearest ancestor holding .crib/crib.json (walkUpForCrib in
// packages/cli/src/runtime.ts), so a corrupt local crib silently swaps in an ancestor project and
// the gate then reports 0/400 CORRECT as if retrieval were broken. Check identity and stop BEFORE
// spending the 400-agent suites on a corpus that cannot pass.
const RPC_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const DAEMON_URL = `http://127.0.0.1:${PORT}/`;
const callTool = async (name, args) => {
  const post = (body) =>
    fetch(DAEMON_URL, { method: 'POST', headers: RPC_HEADERS, body: JSON.stringify(body) }).then(
      (r) => r.text(),
    );
  await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'identity', version: '1' },
    },
  });
  return post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
};

// Scale oracle: the derived index counts the nodes of the soul it was built from, and it can
// survive a corrupt .crib/graph (it did here). Reading it read-only never mutates the repo.
// node:sqlite prints a one-line experimental warning to stderr — noise, not a failure.
const expectedRepoNodes = async () => {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(ROOT, '.crib', 'index', 'crib.sqlite'), { readOnly: true });
    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n);
    db.close();
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // fall through to the floor
  }
  // Floor when the index is unreadable too. knowledge-crib's self-soul has been ~15k–30k nodes
  // across schema 1.3+; this is an order-of-magnitude safety net, not a precise expectation.
  return 10000;
};

// Names the soul the daemon actually resolved to, for the failure message only — the pass/fail
// decision below comes from the node band and the content probe, never from this path. Mirrors
// hasCrib + walkUpForCrib in packages/cli/src/runtime.ts (a dir has a crib iff .crib/crib.json
// exists); keep in sync if that file's root-resolution rule changes.
const resolvedSoulRoot = () => {
  if (existsSync(join(ROOT, '.crib', 'crib.json'))) return ROOT;
  let dir = ROOT;
  for (let i = 0; i < 128; i++) {
    const parent = dirname(dir);
    if (parent === dir) return dir; // filesystem root: no ancestor crib found
    dir = parent;
    if (existsSync(join(dir, '.crib', 'crib.json'))) return dir;
  }
  return dir;
};

const expected = await expectedRepoNodes();
// Wide on purpose: [expected/4, expected*4]. The index counts extracted + semantic nodes while the
// served count is the extracted soul's manifest stat, so the two legitimately differ by 2x-ish;
// a wrong project differs by an order of magnitude or more (366 vs ~30k measured). Tightening this
// band would trade a loud identity alarm for flaky gates on ordinary graph drift — don't.
const BAND_LO = Math.floor(expected / 4);
const BAND_HI = expected * 4;

const statusText = await callTool('status', {});
// status is JSON-stringified inside the MCP content envelope (possibly SSE-framed with escaped
// quotes), so match `"nodes":N` with optional escapes. First occurrence is stats.nodes — the served
// extracted-soul count, the same number the daemon banner prints.
const served = Number(/\\?"nodes\\?":(\d+)/.exec(statusText)?.[1] ?? -1);

// Content probe: even if the count somehow landed in-band, a brief for this repo's distinctive
// index module must return a hit in that file. sqlite-index.ts is stable across this branch.
const PROBE_QUERY = 'sqlite-index';
const PROBE_FILE = 'packages/core/src/index/sqlite-index.ts';
const probeText = await callTool('brief', { q: PROBE_QUERY });
const probeHit = probeText.includes(PROBE_FILE);

const identityOk = served >= BAND_LO && served <= BAND_HI && probeHit;
if (!identityOk) {
  const why =
    served < 0
      ? `status returned no node count (raw reply: ${statusText.slice(0, 200)})`
      : served < BAND_LO || served > BAND_HI
        ? `daemon is serving ${served} nodes; expected this repo (~${expected}, sane band ${BAND_LO}–${BAND_HI})`
        : `node count ${served} is in band but the probe brief for '${PROBE_QUERY}' returned no hit in ${PROBE_FILE} — answers are coming from a different corpus`;
  console.error('');
  console.error(`IDENTITY MISMATCH — ${why}.`);
  console.error(
    `The soul at ${resolvedSoulRoot()} is stale or walk-up resolved to an ancestor project.`,
  );
  console.error('Run: crib index .');
  daemon.kill();
  process.exit(3);
}
console.log(
  `identity ok — daemon serves ${served} nodes (expected ~${expected}, band ${BAND_LO}–${BAND_HI}), probe hit ${PROBE_FILE}`,
);

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
