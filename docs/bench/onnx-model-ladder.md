# ONNX model ladder — measured launch-gate results

**Run date:** 2026-09-05. **Host:** Apple M4 Max, arm64, 48 GiB, Node v22.23.1, darwin.
**Harness:** `runLaunchGate(LAUNCH_SCALE_FULL, { strategy: 'semantic-only', embedder })` — the same
function, corpus (500 labelled queries over 307 records) and frozen thresholds that
[`launch-gates.md`](launch-gates.md) pre-registers and that `crib release:evidence` reports.
**Runtime:** `@huggingface/transformers@3.7.6` (ONNX), `dtype: 'fp32'`, mean pooling, L2-normalised.
**No Python.**

## Why this file exists

The semantic tier previously required `pip install sentence-transformers` (and PyTorch) from a Node
CLI, which is where installs died in practice. This ladder measures the replacement. The question it
had to answer was not "does ONNX work" but "does it produce the SAME retrieval quality" — a faster
install that quietly ranks worse would be a regression sold as a fix.

## Results

Every row is one full gate run. `G2` is word-disjoint paraphrase recall@5 (threshold ≥ 80%); `G3` is
MRR over all 500 labelled queries (threshold ≥ 0.75). "Gates" counts all eight.

| Alias | Model | Dim | Prefix | Disk | G2 | G3 | Gates |
|---|---|---|---|---|---|---|---|
| — | *char-ngram fallback (no model)* | 384 | — | 0 | 2.6% | 0.520 | 6/8 |
| `small` | `Xenova/multilingual-e5-small` | 384 | `query: ` | 481 MB | 42.5% | 0.758 | 7/8 |
| `base` | `Xenova/multilingual-e5-base` | 768 | `query: ` | 1.1 GB | 69.9% | 0.841 | 7/8 |
| **`large`** | **`Xenova/multilingual-e5-large`** | **1024** | **`query: `** | **2.1 GB** | **81.1%** | **0.881** | **8/8** |

Measured but not shipped in the ladder, recorded so the choice is checkable:

| Model | Dim | Disk | G2 | G3 | Gates |
|---|---|---|---|---|---|
| `Xenova/bge-small-en-v1.5` | 384 | 129 MB | 61.4% | 0.677 | 6/8 |
| `Xenova/bge-base-en-v1.5` | 768 | 417 MB | 70.6% | 0.726 | 6/8 |

The `bge` models score higher on G2 at a given size but are English-only, and the corpus contains a
multilingual query family they cannot serve. The shipped ladder is one family at three sizes so that
`--model` is a clean size/quality dial rather than a change of behaviour; the numbers above are here
so that decision can be argued with rather than taken on trust.

## The result that matters

`multilingual-e5-large` measured **G2 81.05% / G3 0.8814** through the ONNX path. The figures already
committed for the Python configuration are **81.0% / 88.1%**. Reproducing them to within rounding is
the evidence that the toolchain swap changed the install and not the vector space — the same model,
the same weights, the same ranking.

`large` is therefore the default: it is the only row that clears every frozen gate, and shipping a
row that does not would mean advertising a semantic tier that cannot pass the project's own release
evidence.

## Honest limits

- One host, one run per model. These are not confidence intervals, and no variance is reported.
- Disk figures are `du` over the real cache after a download, not estimates. They are fp32 ONNX
  weights and exclude the 376 MB npm runtime (`onnxruntime-node` and its per-platform binaries),
  which is installed once into the embed home and shared by every model.
- The multilingual rows are much larger than their English equivalents at the same parameter count
  because a 250k-token vocabulary carries a correspondingly large embedding matrix — `small` is
  481 MB, not the ~120 MB an English model of that name would suggest. An earlier draft of this
  file estimated from the English figures and understated every multilingual row; the numbers above
  replace those estimates with measurements.
- Quantised (`q8`) variants would cut these substantially, but every gate above was measured at
  fp32. Switching dtype changes the vectors, so it would require re-running the table, not just
  changing a flag.
- The gates measure RETRIEVAL over the launch corpus. They say nothing about latency, memory, or
  behaviour on a corpus with different characteristics.
- Cold model load was ~0.5 s (`small`) to ~40 s (`large`) on this host; per-embed cost after load was
  single-digit milliseconds. Load happens once per process, not per call.

## Reproducing

The gate harness accepts any `Embedder`. Point it at an installed tier and run the same call the
table above used:

```js
import { runLaunchGate } from '@knowledge-crib/memory/dist/bench/launch-eval.js';
const report = runLaunchGate(undefined, { strategy: 'semantic-only', embedder });
```

`strategy` must be one of `lexical-only | rrf | weighted | semantic-only`. An unrecognised value
currently degrades to lexical rather than throwing — during this work that silently produced
fallback-level numbers for three different models and read as "all these models are bad". Check the
strategy is honoured before trusting a low result.
