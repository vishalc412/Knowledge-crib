/**
 * Correctness under concurrency. Each agent asks a question whose right answer is known, and the
 * response is checked for THAT answer — not merely for the absence of an error. A daemon that
 * serves 400 fast wrong answers is worse than one that serves none.
 */
const PORT = Number(process.argv[2]);
const N = Number(process.argv[3] ?? 400);
const STAGGER = process.argv.includes('--stagger');
const URL = `http://127.0.0.1:${PORT}/`;
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const rpc = async (b) =>
  (await fetch(URL, { method: 'POST', headers: H, body: JSON.stringify(b) })).text();

const CASES = [
  [
    'how do I debug a parser that hangs',
    ['fuzz/extractor-fuzz.ts', 'fuzz/fuzz-worker.ts', 'fuzz-check.mjs'],
  ],
  ['what stops two indexing runs corrupting each other', ['core/src/lock.ts']],
  ['how does a memory survive a refactor', ['memory/src/locator.ts']],
  ['why is there no native hashing dependency', ['soul-schema/src/hash.ts']],
  [
    'what keeps uncommitted edits queryable',
    ['working-overlay.ts', 'cli/src/watch.ts', 'working-overlay-refresh.ts'],
  ],
];

async function agent(i) {
  if (STAGGER) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5000)));
  const [q, want] = CASES[i % CASES.length];
  const t = process.hrtime.bigint();
  try {
    await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: `a${i}`, version: '1' },
      },
    });
    const text = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'brief', arguments: { q } },
    });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const correct = want.some((w) => text.includes(w));
    return { live: text.includes('codeHits') && !text.includes('"error"'), correct, ms };
  } catch (e) {
    return { live: false, correct: false, ms: 0, why: String(e).slice(0, 50) };
  }
}
const t0 = process.hrtime.bigint();
const res = await Promise.all(Array.from({ length: N }, (_, i) => agent(i)));
const wall = Number(process.hrtime.bigint() - t0) / 1e6;
const live = res.filter((r) => r.live).length;
const correct = res.filter((r) => r.correct).length;
const times = res
  .filter((r) => r.live)
  .map((r) => r.ms)
  .sort((a, b) => a - b);
const p = (x) =>
  times.length
    ? times[Math.min(times.length - 1, Math.floor((times.length * x) / 100))].toFixed(0)
    : 'n/a';
console.log(`${STAGGER ? 'STAGGERED (realistic)' : 'THUNDERING HERD (all at once)'} — ${N} agents`);
console.log(`  responded        : ${live}/${N}`);
console.log(`  CORRECT answer   : ${correct}/${N}  (${Math.round((100 * correct) / N)}%)`);
console.log(`  wall             : ${wall.toFixed(0)}ms`);
console.log(`  latency p50/p95  : ${p(50)}ms / ${p(95)}ms`);
process.exit(live === N && correct === N ? 0 : 1);
