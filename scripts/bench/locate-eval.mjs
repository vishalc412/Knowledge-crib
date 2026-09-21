#!/usr/bin/env node
/**
 * Change localisation: crib against the baselines a developer already has.
 *
 * THE QUESTION THIS ANSWERS. Not "is the graph clever" but the only one an individual developer cares
 * about: given a description of a change, does crib point at the right files more often than ripgrep,
 * and what does each answer cost in tokens? Cheap and wrong is worthless, and correct-but-expensive
 * loses to grep in practice, so both axes are reported for every method or neither number means
 * anything.
 *
 * ── THE BASELINES, AND WHY THE UNFLATTERING ONES ARE HERE ──────────────────────────────────────────
 *
 *   grep-bm25   ripgrep over the base tree for the query's content words, files ranked by hit count.
 *               This is what an agent with a shell already does, and it is the honest incumbent.
 *   churn       the files changed most often in history BEFORE the base, ignoring the query entirely.
 *   recency      the files changed most recently before the base, also ignoring the query.
 *
 * The last two are query-BLIND, and they are the most important rows in the table. This repository has
 * an 8,000-line `cli.ts` that nearly every commit touches; if "always guess the busiest files" scores
 * comparably to a retrieval method, then that method has learned the repo's churn distribution rather
 * than the developer's question, and the whole measurement is measuring nothing. A benchmark without a
 * query-blind control cannot detect that, which is why most retrieval numbers should not be believed.
 *
 * ── THE VARIANTS, because the phrasing carries more than it looks like ─────────────────────────────
 *
 *   full        the whole commit message (subject + body)
 *   subject     the subject line only — much closer to what someone actually types
 *   no-scope    subject with the conventional-commit type and scope removed
 *
 * `fix(freshness):` names a component, and a component name is halfway to a path. Reporting `full`
 * alone would quietly credit retrieval for a hint that lives in the repo's commit convention rather
 * than in the index, so the scope's contribution is isolated and printed.
 *
 * ── HOW COST IS COUNTED, and the approximation admitted ───────────────────────────────────────────
 *
 * Tokens are estimated as bytes/4 over exactly what each method hands back to an agent: crib's JSON
 * result, or ripgrep's matching lines. That is an approximation of a real tokenizer and is used only to
 * compare orders of magnitude between methods on identical inputs, never quoted as an exact count.
 * The grep number is generous to grep: it counts the match lines, not the file reads an agent would
 * then do to understand them.
 *
 * Usage:
 *   node scripts/bench/locate-eval.mjs --base-tree <path-to-worktree-at-base> [--corpus <json>]
 *                                      [--k 10] [--json] [--limit N]
 *
 * `--base-tree` must be a checkout of the corpus's `base` commit with `crib index` already run in it.
 * The script verifies the commit matches and refuses otherwise, because scoring against an index built
 * from a later tree is the leak the corpus exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
const LIMIT = num('--limit', Number.POSITIVE_INFINITY);
const AS_JSON = args.includes('--json');
/**
 * How many NODES to ask crib for before collapsing to files. Not a tuning knob for accuracy: a
 * file-level ranking cannot exceed the quality of the candidate list it is computed from, and the grep
 * baseline is already given up to 5 matches for each of 12 query words. Overridable so the sensitivity
 * of the result to this choice can be checked rather than assumed.
 */
const NODE_BUDGET = num('--node-budget', 60);

if (!BASE_TREE) {
  process.stderr.write('--base-tree <path> is required (a checkout of the corpus base, indexed)\n');
  process.exit(2);
}
const TREE = resolve(BASE_TREE);
const corpus = JSON.parse(readFileSync(resolve(CORPUS), 'utf8'));

// ── the leak check, before any measurement ───────────────────────────────────
const treeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TREE, encoding: 'utf8' }).trim();
if (treeHead !== corpus.base) {
  process.stderr.write(
    [
      `refusing to score: ${TREE} is at ${treeHead.slice(0, 12)} but the corpus base is ${corpus.base.slice(0, 12)}.`,
      'Scoring against an index built from a LATER tree would let the index contain the very changes',
      'the tasks describe, which is the leak this corpus is designed to prevent.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}
if (!existsSync(join(TREE, '.crib', 'crib.json'))) {
  process.stderr.write(`no index in ${TREE} — run \`crib index\` there first\n`);
  process.exit(2);
}

const CRIB = resolve('packages/cli/dist/bin.js');
const bytesToTokens = (n) => Math.round(n / 4);

/** English stopwords plus the vocabulary of commit messages themselves, which carries no location. */
const STOP = new Set(
  `a an the and or but if then than that this these those is are was were be been being it its of to in on at by for with from as not no so such only also into over under about
   fix fixes fixed feat feature add adds added remove removes removed update updates updated change changes changed make makes made use uses used now new when where what which why how
   because rather instead every each any all both one two three first second last same other another
   commit refactor chore test tests docs doc style perf build ci revert wip todo note notes
   we i you it they them their there here does do did done can could should would must may might will`
    .split(/\s+/)
    .filter(Boolean),
);

/** Content words from a query: lowercased, de-stopworded, de-duplicated, longest first. */
function contentWords(text, cap = 12) {
  const seen = new Set();
  const words = [];
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []) {
    if (STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    words.push(raw);
  }
  return words.sort((a, b) => b.length - a.length).slice(0, cap);
}

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?!?:\s*/;

/** The three phrasings of one task. */
function variantsOf(task) {
  const full = task.question;
  const subject = full.split('\n')[0].slice(0, 300);
  return {
    full,
    subject,
    'no-scope': subject.replace(CONVENTIONAL, ''),
  };
}

// ── methods ──────────────────────────────────────────────────────────────────

/**
 * `crib query` — the shipped discovery path, collapsed to ranked FILES.
 *
 * TWO CORRECTIONS TO AN EARLIER, UNFAIR VERSION OF THIS FUNCTION. The first run of this harness ranked
 * files by the position of the FIRST node seen for each, and asked for only `limit * 3` nodes. Both
 * choices penalised crib against a grep baseline that was given proper per-file score aggregation over
 * a much wider candidate net — so the comparison was measuring the harness, not the retriever.
 *
 *  - Files are now ranked by their BEST node score, ties broken by how many of the file's nodes matched.
 *    Max-score rather than sum is deliberate and was chosen on principle rather than by trying both:
 *    summing rewards a file for merely having many nodes, which in this repository means the
 *    8,000-line `cli.ts` would climb on size alone — the exact churn-mimicking behaviour the
 *    query-blind control exists to detect.
 *  - The node budget is raised well above `limit`, because the question is which FILES rank highest,
 *    and a file-level ranking cannot be better than the candidate list it is computed from.
 *
 * Both changes favour crib, which is why the run that applies them reports the previous numbers beside
 * the new ones rather than quietly replacing them.
 */
function cribQuery(query, limit, kinds) {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      [CRIB, 'query', query, '--limit', String(NODE_BUDGET), ...(kinds ? ['--kinds', kinds] : [])],
      {
        cwd: TREE,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return { files: [], bytes: 0 };
  }
  let hits = [];
  try {
    hits = JSON.parse(out).hits ?? [];
  } catch {
    return { files: [], bytes: out.length };
  }
  // A hit is a node; the task is file-level, so aggregate per file.
  //
  // `score` is FTS5 bm25, where MORE NEGATIVE is a better match, so relevance is its negation. A hit
  // carries no `file` field, only `id`, so the path comes from the id grammar.
  const best = new Map(); // file -> { relevance, nodes }
  for (const h of hits) {
    const file = h.file ?? fileFromId(h.id);
    if (!file) continue;
    const relevance = typeof h.score === 'number' ? -h.score : 0;
    const cur = best.get(file);
    if (cur) {
      cur.relevance = Math.max(cur.relevance, relevance);
      cur.nodes += 1;
    } else best.set(file, { relevance, nodes: 1 });
  }
  const files = [...best.entries()]
    .sort((a, b) => b[1].relevance - a[1].relevance || b[1].nodes - a[1].nodes)
    .map(([f]) => f);
  return { files: files.slice(0, limit), bytes: out.length };
}

/** Recover a path from an id when the hit omits `file` (`sym:<path>#…`, `doc:<path>#…`). */
function fileFromId(id) {
  if (typeof id !== 'string') return undefined;
  const afterPrefix = id.slice(id.indexOf(':') + 1);
  const cut = afterPrefix.search(/[#@]/);
  return cut === -1 ? afterPrefix : afterPrefix.slice(0, cut);
}

/** ripgrep for the query's content words; files ranked by how many distinct words hit. */
function grepBm25(query, limit) {
  const words = contentWords(query);
  if (words.length === 0) return { files: [], bytes: 0 };
  const score = new Map();
  let bytes = 0;
  for (const word of words) {
    let out = '';
    try {
      out = execFileSync(
        'rg',
        [
          '--no-heading',
          '--line-number',
          '--max-count',
          '5',
          '-i',
          '-F',
          word,
          '--glob',
          '!.crib/**',
          '--glob',
          '!node_modules/**',
          '--glob',
          '!dist/**',
        ],
        {
          cwd: TREE,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch {
      continue; // rg exits 1 on no matches
    }
    bytes += out.length;
    const filesForWord = new Set();
    for (const line of out.split('\n')) {
      const path = line.split(':')[0];
      if (path) filesForWord.add(path);
    }
    // Rarer words are worth more — a word matching 400 files says nothing about any of them. This is
    // the IDF idea, which is what makes this a fair grep baseline rather than a strawman.
    const idf = 1 / Math.log2(2 + filesForWord.size);
    for (const f of filesForWord) score.set(f, (score.get(f) ?? 0) + idf);
  }
  const files = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  return { files: files.slice(0, limit), bytes };
}

/** Query-BLIND control: the files changed most often before the base. */
const churnRanking = (() => {
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

/** Query-BLIND control: the files touched by the most recent commits before the base. */
const recencyRanking = (() => {
  const out = execFileSync('git', ['log', '--format=', '--name-only', '-n', '80', 'HEAD', '--'], {
    cwd: TREE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const seen = [];
  for (const line of out.split('\n')) {
    const f = line.trim();
    if (f && !seen.includes(f)) seen.push(f);
  }
  return seen;
})();

const METHODS = {
  crib: (q) => cribQuery(q, K),
  // The same verb restricted to code kinds. Separated rather than substituted because the difference
  // between these two rows IS the finding: the default blend ranks this project's prose about a change
  // above the code implementing it, for exactly the queries where code was wanted.
  'crib --kinds symbol': (q) => cribQuery(q, K, 'symbol'),
  'grep-bm25': (q) => grepBm25(q, K),
  // Cost 0: these read nothing at query time. That is exactly what makes them a fair control — if they
  // score well, the retrieval methods are being paid for information the ranking already had.
  churn: () => ({ files: churnRanking.slice(0, K), bytes: 0 }),
  recency: () => ({ files: recencyRanking.slice(0, K), bytes: 0 }),
};

// ── run ──────────────────────────────────────────────────────────────────────
const tasks = corpus.tasks.slice(0, LIMIT);
const VARIANTS = ['full', 'subject', 'no-scope'];
const results = {};
for (const method of Object.keys(METHODS)) {
  results[method] = {};
  for (const variant of VARIANTS) {
    results[method][variant] = { r1: [], r5: [], rk: [], mrr: [], tokens: [] };
  }
}

let done = 0;
for (const task of tasks) {
  const variants = variantsOf(task);
  for (const [variant, query] of Object.entries(variants)) {
    for (const [method, run] of Object.entries(METHODS)) {
      // The query-blind controls ignore the variant entirely, so run them once and reuse.
      const { files, bytes } = run(query);
      const cell = results[method][variant];
      cell.r1.push(recallAtK(files, task.expectedFiles, 1));
      cell.r5.push(recallAtK(files, task.expectedFiles, 5));
      cell.rk.push(recallAtK(files, task.expectedFiles, K));
      cell.mrr.push(mrr(files, task.expectedFiles));
      cell.tokens.push(bytesToTokens(bytes));
    }
  }
  done += 1;
  if (!AS_JSON && done % 10 === 0) process.stderr.write(`  …${done}/${tasks.length}\n`);
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const table = [];
for (const method of Object.keys(METHODS)) {
  for (const variant of VARIANTS) {
    const c = results[method][variant];
    table.push({
      method,
      variant,
      recall1: mean(c.r1),
      recall5: mean(c.r5),
      [`recall${K}`]: mean(c.rk),
      mrr: mean(c.mrr),
      medianTokens: c.tokens.slice().sort((a, b) => a - b)[Math.floor(c.tokens.length / 2)] ?? 0,
    });
  }
}

if (AS_JSON) {
  process.stdout.write(
    `${JSON.stringify({ corpus: { base: corpus.base, tasks: tasks.length }, k: K, table }, null, 2)}\n`,
  );
} else {
  process.stdout.write(
    [
      '',
      `change localisation — ${tasks.length} task(s) from git history, index built at ${corpus.base.slice(0, 12)}`,
      '',
      `| method      | phrasing | recall@1 | recall@5 | recall@${K} | MRR   | median tokens |`,
      '|-------------|----------|----------|----------|-----------|-------|---------------|',
      ...table.map(
        (r) =>
          `| ${r.method.padEnd(11)} | ${r.variant.padEnd(8)} | ${pct(r.recall1).padStart(8)} | ${pct(r.recall5).padStart(8)} | ${pct(r[`recall${K}`]).padStart(9)} | ${r.mrr.toFixed(3)} | ${String(r.medianTokens).padStart(13)} |`,
      ),
      '',
      'churn and recency are QUERY-BLIND controls: they never read the question. Any method that does not',
      'clearly beat them has learned this repository’s churn distribution rather than the developer’s intent.',
      '',
    ].join('\n'),
  );
}
