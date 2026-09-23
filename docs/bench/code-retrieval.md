# Code retrieval — §8's five categories, published with the losses

**What this document is.** The per-category evidence for the five evaluation categories of
`docs/program/wp4-implementation-spec.md` §8 (D-a's artifact), published in the bench family's
one-doc-per-run style. It reports **every** category, including the ones that lost, the one that could not
be scored, and the one whose arm **does not exist in the instrument** — because a category table that
reports only the categories that worked is not evidence.

**Generated from.** `docs/program/logs/wp4-r3-wp4-r3-quality-step3.json` (categories exact, nl, cross-file,
rename) and `...-step5.json` (dependency), both produced by the pre-registered R3 block
(`docs/program/tools/wp4-r3-run.sh`) at HEAD `b4615721e6a352aa9f89edc0f9f4094d28e113a6`, branch
`program/developer-trust`.

**The arms, as this harness could actually open them.** Reported before any number, because three of the
four arms being absent is the single most important fact about this table:

| arm | name | status | why |
|---|---|---|---|
| **C0** | lexical-only | **measured** | the incumbent; no embedder needed |
| **C1** | hybrid-rrf-rerank | **unavailable** | this reader constructs `SqliteIndexStore` with **no embedder** (`code-retrieval-eval.mjs:208`), so `query` never fuses — whatever the index holds |
| **C2** | hybrid-rrf | **unavailable** | same construction, same reason |
| **C3** | semantic-only | **not-measurable** | no public switch: `semantic:false` turns the vector channel *off*, and `vectorQuery` is private. Cosine-alone has no entry point |

The index under test **does** carry `multilingual-e5-large-1024-sym` vectors
(`index: {vector:false, vectorNote:"index carries … vectors; this reader loaded no embedder, so code
search is lexical here"}`). **This note does not mean the index lacks vectors, and it does not mean a
hybrid number was measured lexically.** It is written by this harness's no-embedder reader: `vectorNote` is
present precisely *because* the index carries the vector metadata. C1/C2 are `unavailable` here for the
structural reason above — this harness has no `upgradeIndexToVectors` step — **not** because the tree is
vectorless. The distinction matters: the **same message text** arises in `locate-eval.mjs` as a *probe*
artifact where C1 **is** measured. See spec §10.8(1)/(8) and §10 RESULTS R1.

## Per-category table

| category | arm | n | metric | value | note |
|---|---|---:|---|---:|---|
| **exact** (`qualifiedName`) | C0 | 400 | self `r@1` | **0.4375** | ceiling **0.8368** |
| | C0 | 400 | self `r@k` | 0.805 | |
| | C0 | 400 | file `r@1` | 0.7075 | |
| | C0 | 400 | MRR | 0.5660 | |
| **exact** (`name`) | C0 | 400 | self `r@1` | **0.3675** | ceiling **0.7442** |
| | C0 | 400 | self `r@k` | 0.735 | |
| | C0 | 400 | file `r@1` | 0.615 | |
| | C0 | 400 | MRR | 0.4980 | |
| **nl** | C0 | 20 | `r@1` | 0.1000 | corpus: `CASES` (20 labelled questions) |
| | C0 | 20 | `r@k` | 0.1917 | |
| | C0 | 20 | MRR | 0.1654 | |
| **cross-file** | C0 | 20 | `r@k` | 0.2625 | grain: **file** — hits deduped by file before scoring |
| | C0 | 20 | all-files-covered | **0.1000** | the metric that is *not* `r@k` (§8.3) |
| | C0 | 20 | MRR | 0.1861 | |
| **rename** | — | **0** | — | **underpowered** | fewer qualifying renames than the corpus minimum of 8 (§8.4 step 5) |
| **dependency** | `crib-impact` | 75 | MRR | 0.3573 | `queryBlind: false`, lift over blind **0.5583** |
| | `cochange` | 75 | MRR | 0.4411 | `queryBlind: false`, lift over blind 0.6892 |
| | `same-dir` | 75 | MRR | **0.0100** | **`queryBlind: true`** |
| | **`churn`** | 75 | MRR | **0.6400** | **`queryBlind: true`** — the control |

## The four things this table says

**(1) `exact` is the category with real signal, and it reports its own ceiling.** `qualifiedName` self `r@1`
0.4375 against a ceiling of 0.8368; `name` 0.3675 against 0.7442. The ceilings are published because
**628 query strings in the sampled universe are borne by multiple symbols** — an `r@1` of 0.3675 is not
self-evidently good or bad until the reader knows how much of the gap is *name ambiguity* rather than
retrieval failure. The universe is sampled at a fixed stride over the id-sorted symbol list, so the sample
is identical on every run and every arm.

**(2) The control wins the dependency category too.** `churn` — query-blind, same files in the same order
for every task — holds **MRR 0.6400**, above `cochange` (0.4411), above `crib-impact` (0.3573), and far
above the other blind method `same-dir` (0.0100). This is an **independent 75-task corpus** from the
61-task one behind spec §10 RESULTS, and it reproduces the same pattern: *guessing the recently-changed
files* outranks every retrieval method measured. That is a fact about this repository's churn
distribution, not about the vector channel.

**(3) `cross-file` shows why two metrics are needed.** `r@k` 0.2625 against all-files-covered **0.1000**. On
a multi-file case, "found the file" and "found **all** the files" are different questions, and the second
is much harder. Collapsing them into one number would hide exactly the failure this category exists to
expose.

**(4) `rename` is reported as underpowered, not scored.** The corpus is **empty**: 0 qualifying renames
against a minimum of 8. Composition over the recorded window `a8a5c121… → b4615721…` (353 commits, depth
400): **derived 1188, docs 3, other 1, source 0** — *this repository has no source-file renames in its
history*. Scoring an empty corpus as 0.0 would read as a catastrophic retrieval failure; scoring it as 1.0
would read as perfection. §8.4 step 5 says report it as **underpowered**, and that is what it is.

## What this document does NOT measure

Stated plainly, so no reader has to infer the gaps:

- **The primary natural-language arm is not here.** §8.2's primary corpus is the **61-task** one, scored by
  `locate-eval.mjs` — not this harness. This harness scores the 20-case `CASES` corpus so the *arms* can be
  compared on one corpus. The 61-task numbers are in spec **§10 RESULTS R3**.
- **No hybrid (C1/C2) number exists in this document, for any category.** See the arms table: this
  instrument cannot open a hybrid arm. **§10.5 clause 3 is therefore unproven** on the instrument the frozen
  rule names — not satisfied, not failed (spec §10.8(8), P-8).
- **C3 (semantic-only) has no entry point** and is not measured at all.
- **The `nl` and `cross-file` corpora are duplicated** from `scripts/eval/code-vector-eval.mjs`, which
  cannot be imported because it evaluates on import. `CASES.length` is asserted to be exactly 20 so the
  size cannot drift silently; the entries themselves are **not** mechanically compared between the two
  copies.
- **`rename` has a stated proxy limit**: a file-level rename is only a proxy for the declaration-level
  rename §8.4 describes — a declaration that moves between files without the file itself moving is
  invisible to `--diff-filter=R`. And the commit subject is a *post-hoc* description, so it is a better
  proxy for "an agent is told what moved" than for "an agent asks where something went".

## Reproduction

```bash
# categories exact, nl, cross-file, rename
node scripts/bench/code-retrieval-eval.mjs --category exact,nl,cross-file,rename --decide --json

# dependency — the same binary the `dependency` category delegates to, so the number stays comparable
node scripts/bench/cochange-eval.mjs --base-tree <checkout of the corpus base> --json
```
