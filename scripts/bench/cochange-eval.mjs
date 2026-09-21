#!/usr/bin/env node
/**
 * "What else do I have to touch?" — the question the graph exists to answer, measured against the
 * baselines that need no graph at all.
 *
 * WHY A SECOND TASK TYPE. `locate-eval.mjs` asks which files a described change belongs in. That is a
 * fair question and it plays to TEXT matching, which is grep's home turf; a graph is not obviously
 * needed to answer it. This harness asks the question crib's `impact` verb actually claims: given one
 * file you are about to change, which OTHER files does that change reach? Ground truth is again free
 * and unarguable — the rest of the files in the same commit.
 *
 * ── THE BASELINE THAT MAKES THIS HONEST: CO-CHANGE MINING ───────────────────────────────────────────
 *
 * Files that changed together in the past tend to change together again. Mining that from history is a
 * thirty-year-old technique, it needs no parser, no index and no graph, and on many repositories it is
 * very strong. It is included here because it is the baseline a graph must beat to justify its
 * existence: if `impact` cannot outperform "look at what usually changes alongside this file", then the
 * 185K lines of extractors are buying ranking that git log already contained.
 *
 * The mining window is strictly BEFORE the base commit, so it cannot see any evaluated commit.
 *
 * ── WHAT THE GRAPH METHOD DOES, and why it is in-process ───────────────────────────────────────────
 *
 * It reproduces `impact`'s traversal directly against the committed graph: take the symbol nodes
 * declared in the seed file, walk outgoing AND incoming edges (rel-agnostic, exactly as
 * `traversalAdjacency` does), and collapse the reached nodes to files ranked by hop distance then by
 * how many distinct edges reach them. Walking in-process rather than shelling out to the verb 61 times
 * is a speed decision only; the traversal is the same one, and the token figure is computed from the
 * payload the verb WOULD return so the cost comparison stays honest.
 *
 * Usage:
 *   node scripts/bench/cochange-eval.mjs --base-tree <path> [--corpus <json>] [--k 10] [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SoulStore } from '../../packages/core/dist/index.js';
import { mean, mrr, recallAtK } from '../eval/metrics.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const num = (name, fallback) => {
  const v = flag(name, undefined);
  return v === undefined ? fallback : Number(v);
};

const CORPUS = flag('--corpus', 'docs/bench/locate-corpus.json');
const BASE_TREE = flag('--base-tree', undefined);
const K = num('--k', 10);
const AS_JSON = args.includes('--json');
if (!BASE_TREE) {
  process.stderr.write('--base-tree <path> is required\n');
  process.exit(2);
}
const TREE = resolve(BASE_TREE);
const corpus = JSON.parse(readFileSync(resolve(CORPUS), 'utf8'));
/** Absolute, because the harness sets `cwd` to the base tree, where no build exists. */
const CRIB = resolve('packages/cli/dist/bin.js');
const treeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TREE, encoding: 'utf8' }).trim();
if (treeHead !== corpus.base) {
  process.stderr.write(
    `refusing to score: base tree is ${treeHead.slice(0, 12)}, corpus base ${corpus.base.slice(0, 12)}\n`,
  );
  process.exit(2);
}

// ── tasks: only commits touching 2+ reachable files can pose this question ────
const tasks = [];
for (const t of corpus.tasks) {
  if (t.expectedFiles.length < 2) continue;
  // Each file in turn is the seed; the rest are the answer. One commit yields several tasks, which is
  // legitimate — a developer starting from a different file is a different question.
  for (const seed of t.expectedFiles) {
    const rest = t.expectedFiles.filter((f) => f !== seed);
    if (rest.length > 0) tasks.push({ commit: t.id, seed, expectedFiles: rest });
  }
}

// ── the graph ────────────────────────────────────────────────────────────────
const soul = new SoulStore(resolve(TREE, '.crib'));
soul.load();

const nodesByFile = new Map();
const fileOfNode = new Map();
for (const node of soul.iterate()) {
  if (!node.file) continue;
  fileOfNode.set(node.id, node.file);
  const list = nodesByFile.get(node.file);
  if (list) list.push(node.id);
  else nodesByFile.set(node.file, [node.id]);
}
/** Undirected adjacency: `impact` walks one direction at a time, but "what else must I touch" is both. */
const adjacency = new Map();
let edgeCount = 0;
for (const edge of soul.iterateEdges()) {
  edgeCount += 1;
  for (const [from, to] of [
    [edge.src, edge.dst],
    [edge.dst, edge.src],
  ]) {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  }
}

/** Graph neighbours of a file, as files, ranked by hop distance then by how many edges reach them. */
function cribImpact(seedFile, k, depth = 2) {
  const seeds = nodesByFile.get(seedFile) ?? [];
  if (seeds.length === 0) return { files: [], bytes: 0, seeded: false };
  const seen = new Set(seeds);
  const score = new Map(); // file -> { hop, hits }
  let frontier = seeds;
  let payload = 0;
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of adjacency.get(id) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
        // The payload an `impact` response would carry for this node: id, rel, distance, risk.
        payload += nb.length + 40;
        const file = fileOfNode.get(nb);
        if (!file || file === seedFile) continue;
        const cur = score.get(file);
        if (cur) cur.hits += 1;
        else score.set(file, { hop, hits: 1 });
      }
    }
    frontier = next;
  }
  const files = [...score.entries()]
    .sort((a, b) => a[1].hop - b[1].hop || b[1].hits - a[1].hits)
    .map(([f]) => f);
  return { files: files.slice(0, k), bytes: payload, seeded: true };
}

// ── co-change mining, strictly before the base ───────────────────────────────
const cochange = new Map(); // file -> Map(other -> support)
{
  const log = execFileSync(
    'git',
    ['log', '--no-merges', '--format=%x00', '--name-only', 'HEAD', '--'],
    {
      cwd: TREE,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  for (const block of log.split('\0')) {
    const files = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // A 200-file commit is a bulk rename; it would make everything co-change with everything.
    if (files.length < 2 || files.length > 20) continue;
    for (const a of files) {
      let row = cochange.get(a);
      if (!row) {
        row = new Map();
        cochange.set(a, row);
      }
      for (const b of files) if (b !== a) row.set(b, (row.get(b) ?? 0) + 1);
    }
  }
}
function cochangePredict(seedFile, k) {
  const row = cochange.get(seedFile);
  if (!row) return { files: [], bytes: 0 };
  const files = [...row.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  return { files: files.slice(0, k), bytes: 0 };
}

/** Query-blind: the busiest files before the base, ignoring the seed entirely. */
const churn = (() => {
  const out = execFileSync('git', ['log', '--format=', '--name-only', 'HEAD', '--'], {
    cwd: TREE,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const count = new Map();
  for (const line of out.split('\n')) {
    const f = line.trim();
    if (f) count.set(f, (count.get(f) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
})();

/** Same directory as the seed — the cheapest structural guess there is. */
function sameDirectory(seedFile, k) {
  const dir = seedFile.slice(0, seedFile.lastIndexOf('/') + 1);
  const files = [...nodesByFile.keys()].filter((f) => f !== seedFile && f.startsWith(dir));
  return { files: files.slice(0, k), bytes: 0 };
}

/**
 * The SHIPPED verb, through the CLI — `impact` reading its own `coChanged` group.
 *
 * Separate from the `cochange` row below, which is this harness's own mining. Measuring both proves the
 * feature actually delivers the signal the harness measured, rather than the harness proving something
 * the product does not do. A gap between these two rows is a bug in the shipped path.
 */
function cribImpactVerb(seedFile, k) {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      [CRIB, 'impact', `file:${seedFile}`, '--dir', 'up', '--co-change-limit', String(k)],
      { cwd: TREE, encoding: 'utf8', maxBuffer: 3.2e7, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return { files: [], bytes: 0 };
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { files: [], bytes: out.length };
  }
  const files = [];
  for (const c of parsed.coChanged ?? []) if (c.file && !files.includes(c.file)) files.push(c.file);
  return { files: files.slice(0, k), bytes: out.length };
}

const METHODS = {
  'crib-impact': (seed) => cribImpact(seed, K),
  'impact.coChanged': (seed) => cribImpactVerb(seed, K),
  cochange: (seed) => cochangePredict(seed, K),
  'same-dir': (seed) => sameDirectory(seed, K),
  churn: () => ({ files: churn.slice(0, K), bytes: 0 }),
};

const results = {};
for (const m of Object.keys(METHODS)) results[m] = { r1: [], r5: [], rk: [], mrr: [], tokens: [] };
let unseeded = 0;
for (const task of tasks) {
  for (const [method, run] of Object.entries(METHODS)) {
    const { files, bytes, seeded } = run(task.seed);
    if (method === 'crib-impact' && seeded === false) unseeded += 1;
    const c = results[method];
    c.r1.push(recallAtK(files, task.expectedFiles, 1));
    c.r5.push(recallAtK(files, task.expectedFiles, 5));
    c.rk.push(recallAtK(files, task.expectedFiles, K));
    c.mrr.push(mrr(files, task.expectedFiles));
    c.tokens.push(Math.round(bytes / 4));
  }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * LIFT OVER THE QUERY-BLIND CONTROL — the number that decides whether a method used the question.
 *
 * Raw recall on this task is dominated by how concentrated a repository's changes are. On a repo with
 * one hot file that most commits touch, "always name the busiest files" scores well without reading the
 * seed at all, and every method inherits that floor. Reporting raw recall alone would therefore credit
 * a graph for a churn distribution git log already contained.
 *
 * Lift divides by the best query-blind baseline. A method at lift <= 1.0 has not demonstrated it uses
 * its input, whatever its raw score looks like.
 */
const blindMrr = Math.max(mean(results.churn.mrr), mean(results['same-dir'].mrr));
const table = Object.entries(results).map(([method, c]) => ({
  method,
  queryBlind: method === 'churn' || method === 'same-dir',
  recall1: mean(c.r1),
  recall5: mean(c.r5),
  [`recall${K}`]: mean(c.rk),
  mrr: mean(c.mrr),
  liftOverBlind: blindMrr > 0 ? mean(c.mrr) / blindMrr : null,
  medianTokens: c.tokens.slice().sort((a, b) => a - b)[Math.floor(c.tokens.length / 2)] ?? 0,
}));

if (AS_JSON) {
  process.stdout.write(
    `${JSON.stringify({ tasks: tasks.length, unseeded, k: K, table }, null, 2)}\n`,
  );
} else {
  process.stdout.write(
    [
      '',
      `co-change prediction — ${tasks.length} task(s) from ${new Set(tasks.map((t) => t.commit)).size} commit(s)`,
      `graph at ${corpus.base.slice(0, 12)}: ${fileOfNode.size} located node(s), ${edgeCount} edge(s)`,
      unseeded > 0
        ? `${unseeded} task(s) had NO graph node for the seed file, so crib-impact returned nothing for them (counted as misses, not skipped)`
        : 'every seed file had at least one graph node',
      '',
      `| method       | recall@1 | recall@5 | recall@${K} | MRR   | lift | median tokens |`,
      '|--------------|----------|----------|-----------|-------|------|---------------|',
      ...table.map(
        (r) =>
          `| ${r.method.padEnd(12)} | ${pct(r.recall1).padStart(8)} | ${pct(r.recall5).padStart(8)} | ${pct(r[`recall${K}`]).padStart(9)} | ${r.mrr.toFixed(3)} | ${(r.queryBlind ? '—' : r.liftOverBlind.toFixed(2)).padStart(4)} | ${String(r.medianTokens).padStart(13)} |`,
      ),
      '',
      `lift = MRR / best query-blind MRR (${blindMrr.toFixed(3)}). A method at lift <= 1.00 has not shown it uses`,
      'the seed file at all: the same score was available from git log with no index, no parser and no graph.',
      'cochange needs only git log; same-dir and churn never read the seed.',
      '',
    ].join('\n'),
  );
}
