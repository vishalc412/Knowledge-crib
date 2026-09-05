# Embed model ladder — measured, not estimated

<!-- CURRENT STATE — maintained. Every number here came from a run of the FROZEN launch gate
     (docs/bench/launch-gates.md). Nothing in this file is an estimate, an extrapolation from
     parameter count, or a vendor claim. -->

> ## What to install
>
> ```bash
> crib embed setup --yes
> ```
>
> One command. It generates the adapter, pins it, and proves it ranks before reporting success.
> `crib embed setup --list` prints the table below from the same data the command uses to choose.

## The measurement

Each model was run through `runLaunchGate()` at full scale with the pre-registered winning
strategy (`semantic-only`, `docs/bench/retrieval-pre-registration.md` §4) — the same frozen corpus,
thresholds, and code path as the launch gate. Only the embedder changed.

| alias | model | disk | dim | G1 exact | **G2 paraphrase** | G3 MRR | gates |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `large` | `intfloat/multilingual-e5-large` | 2.1 GB | 1024 | 100.0% | **81.0%** | 88.1% | **8/8 PASS** |
| `base` | `intfloat/multilingual-e5-base` | 1.1 GB | 768 | 100.0% | 69.9% | 84.1% | 7/8 |
| `small` | `sentence-transformers/all-MiniLM-L6-v2` | 87 MB | 384 | 100.0% | 66.0% | 67.2% | 6/8 |
| — | `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` | 1.0 GB | 768 | 100.0% | 59.5% | 80.3% | 7/8 |
| — | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | 458 MB | 384 | 100.0% | 47.1% | 73.6% | 6/8 |
| — | *(no tier)* char-ngram lexical fallback | 0 B | — | 100.0% | 2.6% | 52.0% | 6/8 |

G2 threshold is ≥ 80%. G1 is 100% for every configuration, including the fallback — exact-term
lookup was never the problem.

## Three findings

**1. Only `large` passes.** No smaller model clears the 80% paraphrase threshold, and the nearest
miss is 10 points short. There is no "ship a small model as the semantic tier" option that is also
honest, so `large` is the default and the smaller entries are labelled as not passing.

**2. Size does not predict quality.** The 87 MB English-only MiniLM (66.0%) beats a 458 MB
multilingual MiniLM (47.1%) and a 1.0 GB multilingual mpnet (59.5%). Reasoning from parameter count
would have shipped a **worse** default at 5–11× the download. This is the single most useful thing
in the table, and it is only visible because every row was actually run.

**3. `small` still earns its place.** 66.0% is **25× the 2.6% lexical fallback** for **4% of
`large`'s download**. It does not pass the gate and is not advertised as passing, but it is the
honest answer to "I am not pulling 2 GB to try this" — and it is a 90 MB download, not a service.

## Why these numbers can be trusted

- **The harness reproduces the published figure exactly.** `large` measured 81.0% (G2
  0.8104575163398693) here, matching the independently-measured launch-gate result to every digit.
- **The generated adapter reproduces the hand-written one exactly.** The adapter that
  `crib embed setup` writes scored G2 0.6601307189542484 for `small` — bit-identical to the
  hand-written measurement adapter. The convenience command costs nothing in quality.
- **No threshold, corpus, or query was touched.** Only the embedder varied.

## Reproducing

```bash
crib embed setup --model small --yes      # or base / large
crib doctor .                             # confirms the tier is active
```

Then run the gate (`packages/memory/src/bench/launch-eval.ts`, `runLaunchGate`) with
`{ strategy: 'semantic-only', embedder }` where `embedder` comes from `loadInstalledEmbedder()`.

Prewarm the vector cache with one batched `embedBatch()` over every corpus text first — otherwise
the gate spawns one Python process per query and the run takes hours instead of ~40 seconds.

## The limit this table does not remove

A fresh install with no tier is **6/8 and 2.6% paraphrase recall**. `crib embed setup` shortens the
path from three commands (one of which named a directory that does not exist in the published
package) to one, but it is still a command the operator has to run, and `large` is still a 2.2 GB
download. crib ships no model and makes no network call on its own: `MAX_RUNTIME_DEPS = 9` and
`MAX_PACKAGE_BYTES = 5 MB` are enforced by `pnpm budget:check`, and a bundled transformer breaches
both by orders of magnitude.
