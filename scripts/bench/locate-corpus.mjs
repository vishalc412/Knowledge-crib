#!/usr/bin/env node
/**
 * Build a CHANGE-LOCALISATION corpus from git history — labels nobody had to write.
 *
 * WHY THIS EXISTS. Every accuracy number this project publishes rests on hand-written questions: 22
 * of them, on one repository, authored by someone who already knew the codebase
 * (`scripts/eval/code-vector-eval.mjs` says so in its own header), plus a 7-label resolution fixture.
 * That is a regression gate. It cannot answer the question a developer actually has — "will this make
 * my agent better on my repo, and what does it cost" — because the questions were written by someone
 * who could see the answer.
 *
 * Git history has no such problem. A commit is a labelled example that predates any benchmark: the
 * message is a developer describing a change in their own words, and the files it touched are the
 * ground truth for "where does this change belong". That is the classic bug/change-localisation task,
 * and it is free, plentiful, and language-agnostic.
 *
 * ── THE LEAKAGE CONTROL, which is the whole difference between a benchmark and a rigged one ─────────
 *
 * Three ways this measurement can flatter itself, each closed here:
 *
 *  1. THE INDEX MUST NOT CONTAIN THE ANSWER. If the graph is built at HEAD, it already contains every
 *     evaluated change — a `feat:` commit's new symbol is sitting in the index, named in the message.
 *     So the corpus is anchored at a BASE commit and only commits AFTER it are evaluated. The index is
 *     built from the tree at that base, which predates every task by construction.
 *  2. THE QUESTION MUST NOT CONTAIN THE ANSWER. A commit message that says
 *     `packages/core/src/scip/wire.ts` hands over the answer, and any tool that greps would "win".
 *     Path-like tokens and bare filenames matching the ground truth are stripped, and what was removed
 *     is recorded per task so the cleaning is auditable rather than trusted.
 *  3. THE GROUND TRUTH MUST BE REACHABLE. A commit that ADDS a file cannot be localised to it from an
 *     index that predates the file. Only files present at the base count as ground truth; a task with
 *     none left is dropped, not scored as a miss.
 *
 * ── WHAT THIS CORPUS IS NOT ────────────────────────────────────────────────────────────────────────
 *
 * One repository, and 89% of its commits are by one author, whose messages are unusually long and
 * explanatory. That inflates ABSOLUTE scores for every retrieval method equally and makes the corpus
 * unrepresentative of a terse-commit repository. It is a fair COMPARISON between methods on this repo
 * and not yet an external benchmark; `--repo` exists so the same harness runs on someone else's
 * history, which is the next step and the one that matters.
 *
 * Usage:
 *   node scripts/bench/locate-corpus.mjs [--base <rev>] [--max-files 5] [--limit 200]
 *                                        [--repo <path>] [--out docs/bench/locate-corpus.json]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const num = (name, fallback) => {
  const v = flag(name, undefined);
  return v === undefined ? fallback : Number(v);
};

const REPO = resolve(flag('--repo', process.cwd()));
/** How many commits back the base snapshot sits. Everything after it is evaluable. */
const DEPTH = num('--depth', 120);
/** A commit touching more than this many source files is a refactor, not a localisation task. */
const MAX_FILES = num('--max-files', 5);
const LIMIT = num('--limit', 500);
const OUT = flag('--out', 'docs/bench/locate-corpus.json');

const git = (...a) =>
  execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Extensions that carry code. A commit touching only docs or lockfiles is not a code-localisation task. */
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|go|py|rs|cs|php|rb|sql|swift|scala)$/;

/** Conventional-commit prefix, e.g. `feat(scip): ` — captured separately so its contribution is measurable. */
const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?!?:\s*/;

/**
 * Strip anything from the message that hands over the answer.
 *
 * Removes: path-like tokens (two or more segments joined by `/`), and any bare filename that matches a
 * ground-truth basename. Deliberately does NOT remove ordinary identifiers — a developer describing a
 * change names the things they changed, and removing that would leave a question with no content. The
 * point is to remove the LOCATION, not the subject.
 */
function stripAnswers(message, truthFiles) {
  const removed = [];
  const basenames = new Set(truthFiles.map((f) => f.split('/').pop()));
  let out = message
    // path-like: a/b or a/b/c.ts, with at least one slash and no spaces
    .replace(/\b[\w.@-]+(?:\/[\w.@-]+)+\b/g, (m) => {
      removed.push(m);
      return ' ';
    });
  // bare filenames that are ground truth (e.g. "wire.ts" with no directory)
  for (const base of basenames) {
    if (!base) continue;
    const re = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    out = out.replace(re, (m) => {
      removed.push(m);
      return ' ';
    });
  }
  return { text: out.replace(/\s+/g, ' ').trim(), removed };
}

// ── the base snapshot ────────────────────────────────────────────────────────
const head = git('rev-parse', 'HEAD').trim();
/**
 * The base is the DEPTH-th commit back along the FULL ancestor list, clamped to its length, rather
 * than `HEAD~DEPTH` or a first-parent walk.
 *
 * Two ways the obvious implementations fail, both hit while building this:
 *
 *  - `HEAD~150` throws on a history with merges whose FIRST-PARENT chain is shorter than 150, and the
 *    natural fallback (the root commit) is the worst possible base: its tree is nearly empty, so almost
 *    no ground-truth file is reachable and the corpus comes out empty while every drop counter still
 *    looks plausible.
 *  - Walking `--first-parent` has the same problem for a different reason. This repository has 330
 *    commits but a first-parent chain of 43, because the work arrived through merges; clamping to that
 *    chain lands back at the root.
 *
 * So the base is chosen from the FULL ancestor list (`rev-list HEAD`, newest first), every element of
 * which is an ancestor of HEAD by construction, and the actual depth used is reported.
 */
const chain = git('rev-list', 'HEAD').trim().split('\n').filter(Boolean);
const base = chain[Math.min(DEPTH, chain.length - 1)];
if (!base) {
  process.stderr.write('no commit history to build a corpus from\n');
  process.exit(1);
}

/** Every file present in the tree at the base — the reachable ground-truth set. */
const filesAtBase = new Set(
  git('ls-tree', '-r', '--name-only', base, '--').trim().split('\n').filter(Boolean),
);

// ── walk the commits after the base ──────────────────────────────────────────
// A commit BODY contains newlines, so the header cannot be delimited by one: %x02 terminates it and
// everything after that up to the next %x00 is the file list. Getting this wrong silently turns body
// text into "filenames", which is how the first run of this script reported zero usable tasks.
const log = git(
  'log',
  '--no-merges',
  '--reverse',
  '--format=%x00%H%x1f%an%x1f%aI%x1f%s%x1f%b%x02',
  '--name-only',
  `${base}..${head}`,
  '--',
);

const tasks = [];
const dropped = { tooManyFiles: 0, noSourceFiles: 0, noReachableTruth: 0, messageTooThin: 0 };

for (const block of log.split('\0').slice(1)) {
  const [header = '', fileBlock = ''] = block.split('\x02');
  const [sha, author, date, subject, body] = header.split('\x1f');
  if (!sha) continue;
  const touched = fileBlock
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const source = touched.filter((f) => SOURCE.test(f) && !/\.(test|spec)\./.test(f));

  if (source.length === 0) {
    dropped.noSourceFiles += 1;
    continue;
  }
  if (source.length > MAX_FILES) {
    dropped.tooManyFiles += 1;
    continue;
  }
  // Leakage control 3: only files the base index can possibly contain.
  const truth = source.filter((f) => filesAtBase.has(f));
  if (truth.length === 0) {
    dropped.noReachableTruth += 1;
    continue;
  }

  const rawMessage = `${subject}\n${body ?? ''}`.trim();
  const conventional = CONVENTIONAL.exec(subject);
  const { text, removed } = stripAnswers(rawMessage, truth);
  // A message with nothing left but its type prefix cannot be answered by anyone; scoring it would
  // measure noise. 30 characters is the floor at which a question still describes something.
  if (text.replace(CONVENTIONAL, '').length < 30) {
    dropped.messageTooThin += 1;
    continue;
  }

  tasks.push({
    id: sha.slice(0, 12),
    author,
    date,
    /** The question as a retrieval method sees it — answer-bearing locations removed. */
    question: text,
    /** The conventional-commit scope, kept separate so `--strip-scope` can measure its contribution. */
    type: conventional?.[1] ?? null,
    scope: conventional?.[2] ?? null,
    /** Ground truth: source files this commit changed that exist at the base snapshot. */
    expectedFiles: truth,
    /** Files changed but unreachable from the base index (added later), reported not scored. */
    unreachableFiles: source.filter((f) => !filesAtBase.has(f)),
    /** What the cleaner removed, so the stripping is auditable rather than trusted. */
    strippedTokens: [...new Set(removed)].slice(0, 20),
  });
  if (tasks.length >= LIMIT) break;
}

const corpus = {
  generatedAt: new Date().toISOString(),
  repo: REPO,
  /** The index under test MUST be built from this tree. Recorded so a run can verify it. */
  base,
  head,
  depth: DEPTH,
  maxFiles: MAX_FILES,
  counts: {
    filesAtBase: filesAtBase.size,
    tasks: tasks.length,
    dropped,
    truthFilesPerTask: (
      tasks.reduce((n, t) => n + t.expectedFiles.length, 0) / (tasks.length || 1)
    ).toFixed(2),
    distinctAuthors: new Set(tasks.map((t) => t.author)).size,
  },
  limits: [
    'One repository. Absolute scores are not comparable to any external benchmark; the method-to-method comparison is what this corpus supports.',
    'Author concentration: a corpus dominated by one author inherits that author’s commit-message style, which biases absolute recall for every method equally.',
    'A commit message is a POST-HOC description of a change, not a bug report written before the fix. It is a better proxy for "an agent is told what to change" than for "an agent is told what is broken".',
    'Ground truth is file-level. A method that finds the right file but the wrong symbol inside it scores as a hit.',
  ],
  tasks,
};

writeFileSync(resolve(REPO, OUT), `${JSON.stringify(corpus, null, 2)}\n`);
process.stdout.write(
  [
    `wrote ${OUT}`,
    `  base ${base.slice(0, 12)} → head ${head.slice(0, 12)} (depth ${chain.indexOf(base)} of ${chain.length} ancestors)`,
    `  ${filesAtBase.size} file(s) in the base tree (the reachable ground-truth universe)`,
    `  tasks ${tasks.length} · ${corpus.counts.truthFilesPerTask} truth file(s) each · ${corpus.counts.distinctAuthors} author(s)`,
    `  dropped: ${Object.entries(dropped)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
    '',
  ].join('\n'),
);
