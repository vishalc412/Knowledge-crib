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
 * ── WHICH RETRIEVAL ARM THIS RUN MEASURES, and why it is no longer implicit ────────────────────────
 *
 * `crib` here is the shipped path, and the CLI has NO query-side arm switch: `--semantic` exists only
 * on `index`/`reindex` (`cli.ts:1187`, `:2579`). So the arm is decided by ONE ambient property of the
 * tree — whether its index carries vectors — because `crib query` fuses only then: `cmdQuery` opens
 * the index lexically and hands it to `upgradeIndexToVectors` (`cli.ts:1366`), which reads
 * `vectorNote`, loads the on-device tier ONLY when the index actually carries vectors, and otherwise
 * returns the lexical store unchanged.
 *
 *   c0-lexical-only        the index holds no vectors. This is the incumbent.
 *   c1-hybrid-rrf-rerank   the index carries vectors and its tier loaded, so BM25 fuses with cosine
 *                          before the rerank.
 *
 * That property used to be invisible in the output, which made two runs against two index states
 * produce two MRR columns a reader could not attribute — a number whose meaning depends on an
 * unstated condition, which is the defect class this work package exists to remove.
 *
 * The arm is now established in two steps, and NEITHER step is `capabilities().vector` — that field
 * means "may THIS reader fuse", not "does the index carry vectors", because a store opened without an
 * embedder never fuses (`restoreVectorMeta` sets `builtEmbedderId` only for a matching tier). Read
 * that way a vectorised index reports `vector: false`, which is the mislabelling this check exists to
 * prevent. The discriminator is the three states of the pair, and it is the one the CLI itself uses:
 *
 *   vector === true                               channel live for this reader
 *   vector === false && vectorNote !== undefined  the index CARRIES vectors; this reader did not fuse
 *   vector === false && vectorNote === undefined  the index carries no vectors at all
 *
 * State two is why a probe alone is not enough: the index has vectors, but the run that follows is
 * hybrid only if the tier loads, and that is a fact about the RUN. So it is verified, not inferred —
 * `crib query`'s stderr is captured and the CLI's own degradation warnings
 * (`upgradeIndexToVectors`, `cli.ts:1455`, `:1465`) are matched. An index whose vectors cannot be
 * queried yields a lexical number and is reported as c0, because that is what it is.
 *
 * `--arm c0|c1` is an ASSERTION, not a switch. There is no way to select an arm here; there is only
 * the tree's state. A requested arm that does not match is refused rather than relabelled, because
 * scoring a lexical index and filing the number under a hybrid heading is exactly the mislabelling
 * this check prevents. Comparing the two arms therefore means two runs against two index states built
 * from the same tree — R3's §10.5 clause 2 does precisely that on the 61-task corpus.
 *
 * Usage:
 *   node scripts/bench/locate-eval.mjs --base-tree <path-to-worktree-at-base> [--corpus <json>]
 *                                      [--k 10] [--json] [--limit N] [--arm c0|c1] [--db <path>]
 *
 * `--base-tree` must be a checkout of the corpus's `base` commit with `crib index` already run in it.
 * The script verifies the commit matches and refuses otherwise, because scoring against an index built
 * from a later tree is the leak the corpus exists to prevent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SqliteIndexStore } from '../../packages/core/dist/index.js';
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

// ── the arm: read from the index, then VERIFIED against the run ──────────────
const ARM_C0 = 'c0-lexical-only';
const ARM_C1 = 'c1-hybrid-rrf-rerank';
const ARM_WANT = flag('--arm', undefined);
const DB = resolve(TREE, flag('--db', '.crib/index/crib.sqlite'));

/**
 * Three states, not a boolean. `capabilities().vector` is "may THIS reader fuse", and a store opened
 * without an embedder never may — so it reads false on a vectorised index too. `vectorNote` is the
 * field that answers "does the index carry vectors at all", which is why the CLI reads it first.
 */
const armProbe = (() => {
  if (!existsSync(DB)) return { carries: null, note: null, why: `no index at ${DB}` };
  try {
    const caps = new SqliteIndexStore(DB).capabilities();
    // Live channel: no note, and this reader may fuse. Only reachable if an embedder was passed in,
    // which this harness never does — handled anyway so the three states stay exhaustive.
    if (caps.vector === true) return { carries: true, note: null, why: null };
    return { carries: caps.vectorNote !== undefined, note: caps.vectorNote ?? null, why: null };
  } catch (e) {
    return { carries: null, note: null, why: `index unreadable: ${e.message}` };
  }
})();

/**
 * The CLI's own degradation warnings, matched verbatim from `upgradeIndexToVectors`
 * (`cli.ts:1455`, `:1465`). Matched, never inferred: whether the on-device tier loaded is a fact
 * about the run, and an index that carries vectors can still serve a lexical answer.
 */
const DEGRADED_MARKERS = [
  'this index carries code vectors but they cannot be queried',
  'code vectors unavailable',
  'index vectors were built',
  'this reader loaded no embedder',
];
const runArm = { degraded: null, warning: null, verified: null };

/** Called with each `crib query`'s stderr. Idempotent; first warning wins for the message. */
function noteStderr(stderr) {
  // A stderr was inspected, so "no degradation seen" becomes a fact rather than an absence of data.
  runArm.verified = true;
  for (const line of String(stderr ?? '').split('\n')) {
    if (!line.startsWith('warning:')) continue;
    if (!DEGRADED_MARKERS.some((m) => line.includes(m))) continue;
    runArm.degraded = true;
    runArm.warning ??= line.trim();
  }
}

/** `c1` → ARM_C1, `c0` → ARM_C0; anything else is a typo, not an arm. */
function normaliseArm(v) {
  const s = String(v).toLowerCase();
  if (s === 'c0' || s === ARM_C0) return ARM_C0;
  if (s === 'c1' || s === ARM_C1) return ARM_C1;
  return null;
}

const WANT = ARM_WANT === undefined ? null : normaliseArm(ARM_WANT);
if (ARM_WANT !== undefined && WANT === null) {
  process.stderr.write(`--arm must be c0 or c1 (got "${ARM_WANT}")\n`);
  process.exit(2);
}

const ARM_HELP = [
  '',
  'The arm is a property of the index, not a switch on this script — `crib query` has no arm flag.',
  'A lexical arm needs a tree whose index holds no vectors; a hybrid arm needs one that does, and',
  'whose on-device tier loads. Both arms are built from the SAME tree and differ only in that.',
  '',
].join('\n');

// Pre-flight: `--arm c1` against an index that carries no vectors is impossible whatever the tier
// does, so refuse before paying for a run whose number could only be misfiled.
if (WANT === ARM_C1 && armProbe.carries === false) {
  process.stderr.write(
    [
      `refusing to score: --arm ${ARM_C1} was requested but ${TREE} holds no vectors.`,
      `  index: ${DB}`,
      '',
      'Build the hybrid arm first: KCRIB_EMBED_CACHE=$(mktemp -d) crib index . --vectors',
      ARM_HELP,
    ].join('\n'),
  );
  process.exit(2);
}

if (armProbe.carries === null) {
  process.stderr.write(
    [
      `refusing to score: cannot determine the retrieval arm for ${TREE}.`,
      `  reason: ${armProbe.why}`,
      '',
      'A localisation number whose arm is unknown cannot be compared to any other arm, and §10.5',
      'clause 2 compares exactly two. Make the index readable, or point --db at one.',
      '',
    ].join('\n'),
  );
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

/** `crib query` — the shipped discovery path. Returns ranked FILES with the bytes it cost. */
function cribQuery(query, limit) {
  // spawnSync, not execFileSync: the arm this run actually measured is stated on the CLI's stderr and
  // nowhere else, and execFileSync does not hand stderr back. See `noteStderr`.
  const r = spawnSync(process.execPath, [CRIB, 'query', query, '--limit', String(limit * 3)], {
    cwd: TREE,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  noteStderr(r.stderr);
  const out = r.stdout ?? '';
  if (r.status !== 0) return { files: [], bytes: 0 };
  let hits = [];
  try {
    hits = JSON.parse(out).hits ?? [];
  } catch {
    return { files: [], bytes: out.length };
  }
  // A hit is a node; the task is file-level, so collapse to first-seen file order (rank preserved).
  const files = [];
  for (const h of hits) {
    const file = h.file ?? fileFromId(h.id);
    if (file && !files.includes(file)) files.push(file);
  }
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

// ── the arm this run MEASURED, established after the fact ────────────────────
// Both halves are required for c1: the index carries vectors, AND the queries above came back without
// the CLI reporting that it fell back. Either half missing means these numbers are lexical, and
// saying so is the point — a hybrid heading over a lexical run is the mislabelling this guard exists
// to prevent, and it is the failure mode a single index probe cannot catch.
const arm = armProbe.carries === false ? ARM_C0 : runArm.degraded === true ? ARM_C0 : ARM_C1;

if (armProbe.carries === true && runArm.verified !== true) {
  process.stderr.write(
    [
      `refusing to report: ${TREE} carries vectors but no \`crib query\` ran, so the arm is unverified.`,
      '',
      'The arm a run measured is only knowable from that run. Score at least one task.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

if (WANT !== null && WANT !== arm) {
  const because =
    WANT === ARM_C1
      ? [
          `the index carries vectors (${armProbe.note ?? 'tier mismatch'}) but this run served lexical`,
          'search instead, so the numbers just scored are lexical:',
          runArm.warning ? `  ${runArm.warning}` : '',
        ]
      : ['the index carries vectors and its tier loaded, so this run is hybrid:'];
  process.stderr.write(
    [
      `refusing to report: --arm ${WANT} was requested but the run measured ${arm}.`,
      `  index: ${DB}`,
      '',
      ...because,
      ARM_HELP,
      'Re-run against a tree whose index is in the state you mean to measure.',
      '',
    ]
      .filter((l) => l !== '')
      .join('\n'),
  );
  process.exit(2);
}

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
    `${JSON.stringify(
      {
        corpus: { base: corpus.base, tasks: tasks.length },
        k: K,
        arm,
        index: {
          db: DB,
          carriesVectors: armProbe.carries,
          vectorNote: armProbe.note,
          servedLexically: runArm.degraded === true,
        },
        table,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(
    [
      '',
      `change localisation — ${tasks.length} task(s) from git history, index built at ${corpus.base.slice(0, 12)}`,
      `retrieval arm: ${arm}  (index carries vectors: ${armProbe.carries})`,
      ...(runArm.degraded === true
        ? [
            `⚠ the CLI reported it could not serve the vectors, so these numbers are lexical: ${runArm.warning}`,
          ]
        : []),
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
