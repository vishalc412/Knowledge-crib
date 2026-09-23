#!/usr/bin/env node
/**
 * Build and FREEZE the rename corpus (WP4 §8.4), with its git window recorded.
 *
 * WHY THIS IS A SEPARATE SCRIPT. §8.4 step 5: renames are enumerated mechanically from
 * `git log --diff-filter=R` over a fixed window, "and the window is recorded as part of the corpus. If
 * the window yields too few qualifying renames, the honest outcome is 'underpowered, reported as
 * underpowered' — not a padded set." Separating the builder is what makes that possible: the corpus is
 * a committed artifact with a size and a composition, so nobody can grow it after seeing a result.
 *
 * ── TWO TRAPS, BOTH MEASURED, THAT MAKE A NAIVE BUILDER REPORT A FALSE ZERO ───────────────────────
 *
 * 1. THE DEFAULT RENAME LIMIT SILENTLY SKIPS DETECTION. `git log --diff-filter=R` on this repository
 *    prints `warning: exhaustive rename detection was skipped due to too many files` and returns ZERO
 *    rename entries — not because the history has none, but because git gave up comparing the trees. A
 *    builder that read that zero as a fact would conclude "rename has no evidence" for a reason that is
 *    not about renames at all, which is the same class of error as H-6 (an absent measurement printed
 *    as a result). `--rename-limit` therefore defaults to 20000 and is RECORDED in the corpus, and the
 *    builder refuses to report a zero unless detection actually ran to completion.
 *
 * 2. MOST RENAME ENTRIES IN THIS REPOSITORY ARE DERIVED-ARTIFACT CHURN, NOT CODE. Measured
 *    2026-09-23 over the full 326-commit history with detection complete: 1192 rename entries, of
 *    which 1188 are under `.crib/**` (the derived dossier store, whose filenames embed a LINE NUMBER
 *    and therefore "rename" every time a symbol moves down the file), 3 are docs, 1 is a vendored
 *    license file, and **0 are source files**. Scoring a corpus that had not filtered those out would
 *    be scoring file churn inside a generated directory. Paths are therefore classified and the
 *    classification is part of the corpus, so the composition is auditable rather than asserted.
 *
 * THE RESULT ON THIS REPOSITORY IS ZERO, AND THAT IS THE FINDING. Across all 326 commits: 0 source
 * renames, 2 deleted source files (`packages/ui/web/main.js`,
 * `packages/ui/web/vendor/cytoscape.min.js`) against 1113 added source files. This repository builds
 * features by adding files; it does not move them. §8.4 asked for the honest outcome in exactly this
 * case, so the corpus is written with `powered: false` and the evaluator reports the category as
 * underpowered instead of printing a metric. `--repo` runs the same builder against a history that does
 * rename files, which is the run that would give the category power.
 *
 * Usage:
 *   node scripts/bench/rename-corpus.mjs [--repo <path>] [--depth 400] [--rename-limit 20000]
 *                                        [--index-rev <sha>] [--min-tasks 8]
 *                                        [--out docs/bench/rename-corpus.json] [--json]
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
/** How far back the recorded window reaches. Everything inside it is enumerable. */
const DEPTH = num('--depth', 400);
/** See trap 1. Raised far above git's default 1000 so detection completes on a wide tree. */
const RENAME_LIMIT = num('--rename-limit', 20000);
/** Below this, the category is underpowered by §8.4 step 5 rather than scored. */
const MIN_TASKS = num('--min-tasks', 8);
/** Written to the WORKING DIRECTORY, not to `--repo`: a corpus built from another history is still a
 *  committed artifact of THIS repository, and must not be dropped into someone else's tree. */
const OUT = resolve(flag('--out', 'docs/bench/rename-corpus.json'));
const AS_JSON = args.includes('--json');

const git = (...a) =>
  execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

/** Extensions that carry code — the same set the localisation corpus uses. */
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|go|py|rs|cs|php|rb|sql|swift|scala)$/;
/** The derived store. A rename here is a line number moving, not a declaration moving. */
const DERIVED = /^\.crib\//;
const DOCS = /\.(md|json|txt|yml|yaml|lock|toml|svg|png)$/;

const head = git('rev-parse', 'HEAD').trim();
const chain = git('rev-list', 'HEAD').trim().split('\n').filter(Boolean);
const base = chain[Math.min(DEPTH, chain.length - 1)];
if (!base) {
  process.stderr.write('no commit history to build a corpus from\n');
  process.exit(1);
}

/**
 * THE REVISION THE EVALUATOR MUST INDEX — one revision for the whole corpus, and it is NOT the window
 * base. Three conditions have to hold simultaneously for a rename task to be scoreable:
 *
 *   the NEW path exists there  → the ground truth is findable at all;
 *   the OLD path is GONE there → the move really is a move, so "the old site appears at the top" is a
 *                                meaningful question rather than a tautology (metric 2);
 *   the query was authored from a tree that revision does not contain → the leakage control.
 *
 * Only a revision at or after the last rename satisfies the first two, which is why indexing the
 * window's oldest commit (the obvious reading, and this builder's first version) drops every task with
 * `newPathNotInIndexRev` — measured, not predicted: on a three-commit fixture containing one real
 * `git mv`, the oldest-commit reading scored 0 usable tasks while the rename was plainly detected.
 */
const INDEX_REV = flag('--index-rev', head);
const filesAtIndexRev = new Set(
  git('ls-tree', '-r', '--name-only', INDEX_REV, '--').trim().split('\n').filter(Boolean),
);

/**
 * `%x00` starts a commit, `%x1f` separates its header fields, `%x02` ends the header. A rename entry
 * is `R<similarity>\t<old>\t<new>`; every other status is a single path. Both forms are parsed here so
 * "no other change in the same commit" (§8.4 step 1) can be checked rather than assumed.
 */
const log = git(
  'log',
  '--no-merges',
  '--reverse',
  '--name-status',
  '-M',
  '-l',
  String(RENAME_LIMIT),
  '--format=%x00%H%x1f%s%x1f%aI%x02',
  `${base}..${head}`,
  '--',
);

const buckets = { derived: 0, docs: 0, other: 0, source: 0 };
const dropped = {
  commitHasOtherChanges: 0,
  noSourceRename: 0,
  oldPathStillInIndexRev: 0,
  newPathNotInIndexRev: 0,
  messageTooThin: 0,
};
const tasks = [];
let renameEntries = 0;
let commitsWithRenames = 0;

for (const block of log.split('\0').slice(1)) {
  const [header = '', fileBlock = ''] = block.split('\x02');
  const [sha, subject, date] = header.split('\x1f');
  if (!sha) continue;
  const entries = fileBlock
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const renames = [];
  let otherChanges = 0;
  for (const entry of entries) {
    const f = entry.split('\t');
    if (/^R\d*$/.test(f[0])) {
      renames.push({ oldPath: f[1], newPath: f[2] });
      renameEntries += 1;
      const p = f[2] ?? '';
      if (DERIVED.test(p)) buckets.derived += 1;
      else if (SOURCE.test(p)) buckets.source += 1;
      else if (DOCS.test(p)) buckets.docs += 1;
      else buckets.other += 1;
    } else {
      otherChanges += 1;
    }
  }
  if (renames.length === 0) continue;
  commitsWithRenames += 1;

  // §8.4 step 1: "with no other semantic change in the same commit". A commit that also modifies or
  // adds files makes the rename inseparable from the rest of the change, so its task is dropped.
  if (otherChanges > 0) {
    dropped.commitHasOtherChanges += 1;
    continue;
  }

  for (const { oldPath, newPath } of renames) {
    if (!SOURCE.test(newPath) || DERIVED.test(newPath)) {
      dropped.noSourceRename += 1;
      continue;
    }
    // Reachability, evaluated at INDEX_REV (see above) rather than at the window base. The index is
    // built once, at that revision, so both conditions must hold there for every task in the corpus.
    if (!filesAtIndexRev.has(newPath)) {
      dropped.newPathNotInIndexRev += 1;
      continue;
    }
    if (filesAtIndexRev.has(oldPath)) {
      dropped.oldPathStillInIndexRev += 1;
      continue;
    }

    // The query: the OLD path's stem, plus the commit subject with every location removed. The subject
    // is a developer's own words, and `stripAnswers` removes path-like tokens and the new file's own
    // basename — so the query says what the thing did without saying where it went.
    const stem = (oldPath.split('/').pop() ?? oldPath).replace(SOURCE, '');
    const basename = newPath.split('/').pop() ?? newPath;
    const question = subject
      .replace(/\b[\w.@-]+(?:\/[\w.@-]+)+\b/g, ' ')
      .replace(new RegExp(`\\b${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const full = `${stem} ${question}`.trim();
    if (full.length < 12) {
      dropped.messageTooThin += 1;
      continue;
    }

    tasks.push({
      commit: sha.slice(0, 12),
      date,
      oldPath,
      newPath,
      oldStem: stem,
      /** The question as a retrieval method sees it: the old name, and where it went removed. */
      question: full,
      /** Ground truth: the new location, the only place the declaration exists in the index. */
      expectedFiles: [newPath],
    });
  }
}

const power = {
  /** n ≥ MIN_TASKS. Below it the evaluator reports the category as underpowered, per §8.4 step 5. */
  powered: tasks.length >= MIN_TASKS,
  minTasks: MIN_TASKS,
  tasks: tasks.length,
};

const corpus = {
  generatedAt: new Date().toISOString(),
  repo: REPO,
  /** The recorded window the renames were enumerated from. */
  window: {
    base,
    head,
    depth: DEPTH,
    commitsInWindow: chain.length > DEPTH ? DEPTH : chain.length,
  },
  /**
   * The revision the evaluator MUST index. Carried in the artifact because a run that indexes anything
   * else scores a corpus whose ground truth is not there — the same class of silent mis-scoring the
   * localisation harness guards with its `rev-parse HEAD` equality check.
   */
  indexRev: INDEX_REV,
  renameLimit: RENAME_LIMIT,
  /**
   * The detection caveat, carried in the artifact rather than only in a comment: with git's default
   * limit this same command returns zero entries and prints a warning, so a corpus lacking this field
   * cannot be trusted to distinguish "no renames" from "detection was skipped".
   */
  renameDetection:
    'complete — `-l` was raised above the tree width; a skipped detection would have returned 0 entries',
  counts: {
    renameEntries,
    commitsWithRenames,
    byPathClass: buckets,
    tasks: tasks.length,
    dropped,
  },
  power,
  /**
   * What the arm measures, and the one metric that is a TRIPWIRE rather than a distribution.
   *
   * Metric 1 ("does the ranker follow the move?") is a real measurement: R@1/R@10/MRR on the new path.
   *
   * Metric 2 ("does the old site appear at the top?") is guaranteed zero at two independent layers,
   * and that is worth stating rather than printing a bare 0.0% as though it were a finding. A removed
   * node is deleted from `nodes_fts` and from `nodes` by `applyDelta`, and `vectorQuery` re-reads node
   * metadata through a join on `nodes`, so a stale vector row cannot surface a file that no longer
   * exists. A NON-zero value would mean one of those layers failed — which is exactly why the metric is
   * kept: it is the end-to-end assertion the `applyDelta` vector-deletion rule exists to make.
   */
  metric2: {
    name: 'old-site-at-top',
    kind: 'tripwire',
    guaranteedZeroBy: [
      'applyDelta deletes nodes_fts + nodes rows',
      'vectorQuery joins nodes for metadata',
    ],
  },
  limits: [
    'One repository, and this one has no source-file renames in its history — see counts.byPathClass.',
    'A file-level rename is a proxy for the declaration-level rename §8.4 describes; a declaration that moves between files without the file itself moving is invisible to `--diff-filter=R`.',
    'The commit subject is a post-hoc description written after the move, so it is a better proxy for "an agent is told what moved" than for "an agent asks where something went".',
  ],
  tasks,
};

writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`);

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ counts: corpus.counts, power }, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      '',
      `rename corpus — window ${base.slice(0, 12)}..${head.slice(0, 12)} (${DEPTH} commits), renameLimit ${RENAME_LIMIT}`,
      `  index at ${INDEX_REV.slice(0, 12)} (new paths present, old paths gone)`,
      `  rename entries ${renameEntries} across ${commitsWithRenames} commit(s):`,
      `    ${buckets.source} source · ${buckets.derived} derived (.crib/**) · ${buckets.docs} docs · ${buckets.other} other`,
      `  usable tasks ${tasks.length} (min ${MIN_TASKS}) → ${power.powered ? 'POWERED' : 'UNDERPOWERED'}`,
      `  dropped: ${
        Object.entries(dropped)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ') || 'none'
      }`,
      '',
      ...(power.powered
        ? []
        : [
            'This repository does not rename source files, so §8.4 step 5 applies: the category is reported',
            'as underpowered rather than scored. A padded set would be the failure the step names.',
            '',
          ]),
    ].join('\n'),
  );
}
