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

## Install — use the command, not this directory

```bash
crib embed setup --yes
```

That is the whole install. It checks your Python, installs `sentence-transformers` if missing,
downloads the weights once, **generates and pins an adapter equivalent to this one**, and then
proves the tier ranks before reporting success.

Two reasons it exists rather than these files:

- **This directory does not ship.** The published package contains `dist`, `skills`, `LICENSE`,
  `NOTICE` — so `crib embed install examples/embedders/minilm-e5 …` is followable only from a git
  checkout. For an npm install the path is simply not there.
- **It is measured.** `crib embed setup --list` prints the size/quality ladder from
  `docs/bench/embed-model-ladder.md`, so you pick a download size against a real number rather than
  a parameter count. (`small` is 90 MB and scores 66.0%; only `large` passes the gate at 81.0%.)

The generated adapter scores **identically** to this hand-written one — G2 0.6601307189542484 for
`small`, matching to every digit. Convenience costs nothing here.

If your Python is not on `PATH` as `python3`:

```bash
crib embed setup --python /path/to/venv/bin/python3 --yes
```

### The manual path

Still supported, and what this directory is for — reading, forking, or installing a model the
ladder does not list:

```bash
pip install sentence-transformers
python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('intfloat/multilingual-e5-large')"
crib embed install examples/embedders/minilm-e5 \
  --model-id intfloat/multilingual-e5-large --model-version 1 --entry embedder.mjs
crib doctor .
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
