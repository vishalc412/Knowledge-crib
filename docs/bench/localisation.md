# Change localisation and co-change: crib against the baselines a developer already has

**Status: FIRST READING, AND IT IS NEGATIVE FOR RETRIEVAL QUALITY.** Measured 2026-09-21. Published
because it is the honest result, and because every accuracy claim this project made before today rested
on 22 hand-written questions authored by someone who could already see the answer.

Reproduce:

```bash
node scripts/bench/locate-corpus.mjs --depth 150
git worktree add --detach /tmp/bench-base <base-sha>
node packages/cli/dist/bin.js index /tmp/bench-base
node scripts/bench/locate-eval.mjs --base-tree /tmp/bench-base
node scripts/bench/cochange-eval.mjs --base-tree /tmp/bench-base
```

## Why this corpus exists

The prior evidence was a regression gate, not a benchmark — `scripts/eval/code-vector-eval.mjs` says so
in its own header: "22 questions, one repository, authored by someone who knows the codebase". A
question written by someone looking at the code cannot measure whether a developer's question gets
answered.

Git history has no such problem. A commit message is a developer describing a change in their own words,
and the files it touched are ground truth that predates any benchmark. 61 localisation tasks and 75
co-change tasks were derived from this repository's history with no hand-labelling.

**Three leakage controls, because without them this measures nothing.** The index is built from a BASE
commit that predates every evaluated commit; path-like tokens and ground-truth filenames are stripped
from every question (and what was stripped is recorded per task); and only files present at the base
count as ground truth, since an index cannot find a file that does not exist yet.

## Task 1 — localisation: "here is a change, which files does it belong in?"

61 tasks, index built at `d872789840b4`, 772 files in the base tree, k = 10.

| method | phrasing | recall@1 | recall@5 | recall@10 | MRR | lift | median tokens |
|---|---|---|---|---|---|---|---|
| crib | full message | 16.5% | 35.7% | 47.3% | 0.323 | 0.64 | **1,902** |
| crib | subject only | 13.5% | 38.3% | 49.1% | 0.299 | 0.60 | **1,889** |
| crib | no scope | 10.2% | 36.9% | 47.5% | 0.265 | 0.53 | **1,890** |
| grep-bm25 | full message | 24.8% | 36.9% | 51.1% | **0.478** | 0.95 | 24,062 |
| grep-bm25 | subject only | 20.7% | **45.7%** | **55.1%** | 0.464 | 0.93 | 68,963 |
| grep-bm25 | no scope | 20.7% | 43.6% | 51.9% | 0.459 | 0.92 | 62,663 |
| churn *(query-blind)* | — | **27.1%** | 34.7% | 42.5% | **0.501** | — | 0 |
| recency *(query-blind)* | — | 0.0% | 0.0% | 0.0% | 0.000 | — | 0 |

`lift` = MRR ÷ best query-blind MRR. **Nothing clears 1.00.**

## Task 2 — co-change: "I am changing this file, what else must I touch?"

75 tasks from 25 commits. This is the question `impact` claims to answer.

| method | recall@1 | recall@5 | recall@10 | MRR | lift | median tokens |
|---|---|---|---|---|---|---|
| crib-impact | 15.0% | 20.3% | 24.1% | 0.357 | 0.56 | 64,225 |
| cochange *(git log only)* | 11.2% | 33.1% | 34.3% | 0.441 | 0.69 | 0 |
| same-dir *(query-blind)* | 0.0% | 1.4% | 1.4% | 0.010 | — | 0 |
| churn *(query-blind)* | **25.3%** | **42.7%** | **45.3%** | **0.640** | — | 0 |

## What these numbers say, stated plainly

**1. The token-efficiency claim is real. The accuracy claim that travels with it is not.** `crib index`
prints "≈42.1× fewer tokens per discovery query than reading files directly", and this measurement
confirms the order of magnitude: 1,902 tokens against 24,062–68,963 for grep, a 13–36× reduction. But
the sentence a reader completes in their head — *the same answers, cheaper* — is false here. On
localisation, grep-bm25 beats crib on MRR by 48% (0.478 vs 0.323) and on recall@10 (51.1% vs 47.3%).
crib delivers **worse answers far more cheaply**, and that is a different product claim than the one
currently being made.

**2. Neither retrieval method beats guessing the busiest files.** A control that never reads the question
scores MRR 0.501 on localisation and 0.640 on co-change — above every method that does read it. On
co-change, the graph (0.357) also loses to 30-year-old co-change mining over `git log` (0.441), which
needs no parser, no index and no graph.

**3. The commit convention is doing work the index is being credited for.** Stripping the
`fix(freshness):` scope costs crib 18% of its MRR (0.323 → 0.265). A benchmark reporting only the full
message would attribute that to retrieval.

## What these numbers do NOT say

- **This is one repository, and 89% of its commits have one author** whose messages are unusually long.
  Absolute scores are not comparable to any external benchmark. The method-to-method comparison is what
  this supports, and only here.
- **The churn control's strength is partly this repo's shape.** Changes concentrate in a few hot files
  (an 8,000-line `cli.ts` that most commits touch), which raises the query-blind floor and makes this
  corpus a weak discriminator. That is a property of the corpus, not a defence of the graph — but it
  does mean a repository with flatter churn is needed before concluding how large the real gap is.
- **Ground truth is file-level.** A method that finds the right file but the wrong symbol scores a hit,
  which flatters every method equally.
- **A commit message is a post-hoc description, not a bug report.** It proxies "an agent is told what to
  change" better than "an agent is told what is broken".
- **`crib-impact` here reproduces `impact`'s traversal with a deliberately naive ranking** (hop distance,
  then edge count, rel-agnostic, undirected, depth 2). Hub suppression is an obvious improvement. It was
  not applied, because the idea arrived *after* seeing these numbers and fitting it to this corpus would
  produce a number that means nothing — see the pre-registration below.

## What happens next, committed before measuring

Following this repository's own pre-registration practice (`docs/bench/retrieval-pre-registration.md`),
the next round is committed here BEFORE it runs:

1. **Run on three external repositories** with different churn profiles and multiple authors, chosen
   before any result is seen. The SCIP importer makes non-TypeScript repos reachable.
2. **Hypothesis H1:** suppressing hub nodes in the graph walk (excluding nodes whose degree exceeds the
   95th percentile) raises `crib-impact` lift above 1.00 on a held-out repository. Tested on repos not
   used to form the hypothesis.
3. **Hypothesis H2:** crib's localisation MRR rises above grep-bm25's when the query is a symbol-bearing
   question rather than a change description — i.e. the gap above is a property of the task, not of the
   index. If H2 fails, the retrieval path needs work, not framing.
4. **The honest interim product claim** is the one the evidence supports today: *dramatically fewer
   tokens, measurably lower ranking accuracy than grep on change localisation.* That is what the README
   and capability matrix should say until a number says otherwise.
