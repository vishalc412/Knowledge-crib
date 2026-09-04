# On-device embedder — reference adapter

Knowledge-crib ranks memory recall in one of two modes, and `crib doctor` always tells you which:

| tier | scorer | word-disjoint paraphrase recall |
| --- | --- | --- |
| **fallback** (default, no setup) | `memory-rank-v2:none:bm25:lexical-only` | **2.6%** |
| **installed** (this adapter) | `memory-rank-v2:<id>:cosine:semantic-only` | **81.0%** |

Both numbers are measured on the pre-registered 500-query launch corpus
(`docs/bench/launch-gates.md`). With the fallback the memory-quality gate scores **6/8**; with an
installed model it scores **8/8**.

**crib ships no model and makes no network call** — at install time or at query time. That is a
product constraint, not an oversight: the runtime-dependency and package-size budgets
(`MAX_RUNTIME_DEPS = 9`, `MAX_PACKAGE_BYTES = 5 MB`) are enforced by `pnpm budget:check`, and a
bundled transformer would breach both by orders of magnitude. So the model is an operator-supplied
artifact, and this directory is a working bridge to it.

## Install

**1. A Python with `sentence-transformers`** (any interpreter; a venv is fine):

```bash
pip install sentence-transformers
```

**2. Fetch the weights once.** This is the only step that touches the network:

```bash
python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('intfloat/multilingual-e5-large')"
```

~2.2 GB into the local HuggingFace cache. Every later call runs offline against that cache.

**3. Register the adapter with crib:**

```bash
crib embed install examples/embedders/minilm-e5 --model-id intfloat/multilingual-e5-large --model-version 1 --entry embedder.mjs
```

**4. Confirm:**

```bash
crib doctor .
#   ✓ embedder tier — installed (multilingual-e5-large-1024-sym); remote disabled
```

If your Python is not on `PATH` as `python3`:

```bash
export KCRIB_EMBED_PYTHON=/path/to/venv/bin/python3
```

## Verify it is actually being used

The scorer names itself on every response, so you never have to guess:

```bash
crib memory search "how do we handle retries" --json | jq -r .provenance.scorerVersion
# memory-rank-v2:multilingual-e5-large-1024-sym:cosine:semantic-only
```

Seeing `...:none:bm25:lexical-only` means the tier is not active — run `crib doctor` for the reason.

## If it breaks, recall keeps working

A missing model, an unreadable manifest, a failed integrity check or a Python that cannot import
`sentence_transformers` all degrade to the lexical fallback. `crib doctor` reports the cause; recall
keeps answering with lower paraphrase quality. **It never crashes and never silently claims to be
semantic** — the scorer id changes, so a degraded deployment is visible in its own responses.

## Choosing a different model

Two rules, both learned the hard way:

1. **`embedBatch(texts)[i]` must equal `embed(texts[i]).`** Batching is a performance variant, never
   a semantic one. An earlier version of this adapter applied E5's `query:` prefix in `embed` and
   `passage:` in `embedBatch`; the ranking then depended on which method the caller used, and a
   one-line change inside crib silently cost 8 points of paraphrase recall.

2. **Change `ID` whenever the behaviour changes** — prefix, model, normalisation, anything. `ID` keys
   crib's persistent vector cache, so a behaviour change under a stable id serves vectors from the
   old embedding space.

Set `dim` to the model's real dimensionality: crib re-checks it against the pinned manifest on every
load and refuses a mismatch rather than mis-scoring.

### Why `query:` on both sides

E5 is trained asymmetrically (`query:` for questions, `passage:` for documents), which is right for
question→document retrieval. Memory recall is a **similarity** task — a paraphrase and the claim it
restates are two ways of saying one thing — and E5's own guidance is `query:` on both sides for that.
It also measures better here: **81.0% symmetric vs 73.2% asymmetric** on the launch corpus.

## What this costs at query time

Nothing per query, after the first pass. crib keeps a persistent vector store keyed by
`(record_id, embedder_id, text_version)`; because memory ids are content-addressed
(`mem:<blake3-of-content>`), a vector is immutable and never needs invalidating. Measured on a
307-record ledger: **308 texts embedded on the first call, 1 (just the query) on every call after**.
