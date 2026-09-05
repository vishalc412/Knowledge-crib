# The cost of reviewing a change

**Measured:** 2026-09-06, on this repository, Apple M4 Max / Node v22.23.1. Token figures are
`characters / 4` over the exact bytes each approach puts in front of a model — a stable proxy, not a
tokenizer count, and quoted to two significant figures for that reason.

## Why this was measured

Reported from real use: *"I gave something to review, and my model read ten lines and predicted what
was happening."*

That is usually read as the model being lazy. It is better read as arithmetic. A reviewer needs more
than the diff — it has to know who calls the changed code and what was already decided about it —
and the obvious way to get that is to read the files. So the question was what that actually costs.

## The measurement

Two real changes on this repository. **A** is what an agent does when the diff is not enough: read
every file the change touched. **B** is the diff alone. **C** is the `review` verb.

| | commit `403b17e4` (8 files) | working tree (4 files) |
|---|---:|---:|
| **A.** read every touched file | **212,000** | **166,000** |
| **B.** raw diff | 6,400 | 2,900 |
| **C.** `crib review` | 2,000 | 4,400 |
| **C.** `crib review --limit 6` | — | 2,300 |

## What the numbers say, and what they do not

**A is the finding.** 166k–212k tokens does not fit a working context alongside the conversation
that asked for the review. A model handed that task either truncates or skims, and skimming is what
gets reported as "it read ten lines and guessed". The behaviour is rational; the budget was
impossible.

**C is not cheaper than B, and this file will not claim it is.** A raw diff costs about the same or
less. `review` earns its place by answering questions the diff structurally cannot:

- *who calls this* — a diff shows the changed lines, never their callers;
- *what did we already decide about this* — trusted memory for the changed surface, so a review does
  not re-open a settled argument.

The useful combination is B **and** C — roughly 7k tokens together, against 212k for A.

**These are payload sizes, not review quality.** Nothing here measures whether the resulting review
finds more defects. That would need a labelled defect corpus and a blind comparison, and neither
exists in this repository; do not cite this file as evidence of review quality.

## Honest limits of the verb itself

- **Declarations only.** `changedSymbols` counts every node in a touched file, and behaviour nodes
  (assignments, statements) are the large majority of the graph — the first draft reported 5,156
  "changed symbols" for a six-file change and spent its whole budget on `assign:…@L1009` entries.
  `review` reports both counts: `changedNodeCount` (graph touched) and `changedSymbolCount`
  (declarations a human must read).
- **Callers are code, not prose.** Documentation sections that mention a name are incoming edges
  too. Ranking by raw incoming edges put a trivial local helper called `flag` at the top of the
  list, because that word appears in a dozen markdown headings. Doc edges are excluded from
  `callers`.
- **An empty caller list is labelled, never presented as "unused".** Dynamic dispatch, property
  access and cross-language calls all produce the same emptiness. The response says so on every
  such symbol rather than leaving it to be inferred.
- **A `note` qualifies everything below it.** When `detect_changes` degrades — no vcs adapter, not a
  work tree, no incremental anchor — the counts are a floor, not a total.
- **A stale graph answers confidently.** `review` reads the committed graph; if it is behind HEAD,
  `crib status` says so (`aheadOfVcsHead`) and the review describes the older commit.

## Reproducing

```bash
crib review --limit 6            # the packet
git diff | wc -c                 # the diff, for comparison
```
