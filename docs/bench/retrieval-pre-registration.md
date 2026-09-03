# Retrieval scorer pre-registration — G3.2 (two embedder tiers + versioned scorer)

**Status: FROZEN BEFORE MEASUREMENT.** This document was written before any held-out evaluation
number was computed. Everything above the `FROZEN` divider below is the commitment; everything below
it is the outcome, appended after the run, unedited in its commitments. If the result is negative,
it ships as a negative result — the launch default stays lexical-only.

Author: G3.2 workstream (Gate 3 wave, 2026-09-03). Branch: `feature/superset-plan`.

## Why pre-register

The P0 memory bench (docs/bench/memory.md) shows exact recall@5 = 100% and word-disjoint paraphrase
recall@5 = 10% (BM25-only), sitting at or slightly below the 12.5% pure tie-order fallback floor —
i.e. the lexical-only scorer retrieves essentially no meaning on paraphrase queries. G3.2 adds an
embedding channel and fusion strategies. Without a rule fixed in advance, a fusion strategy could be
"selected" after peeking at results — which is how retrieval systems acquire tuned-on-the-test-set
defaults. This document commits to the decision rule first.

Scope note (red line #4): this eval decides **memory recall** scoring only. It does not cite the
code-graph alternation result — different corpus, different domain.

## 1. Held-out eval set construction

**Index (corpus).** The existing P0 relevance corpus, unchanged: `relevanceCorpus(40)` from
`packages/memory/src/bench/scenarios.ts` — 40 records, one per distinct hand-written topic, seeded
into REAL stores exactly like `runRecallRelevance` (team/local placement alternating by index, plus
the one global decoy record). Every candidate record the projection can rank is one of these 41.

**Queries — three splits, fixed at authoring time:**

| Split | Size | Source | Role |
|---|---|---|---|
| `exact` | 40 | existing `exact` queries of the corpus | regression guard only |
| `dev-paraphrase` | 40 | the 40 `paraphrase` queries already published in docs/bench/memory.md | development visibility only — MAY inform implementation debugging, MUST NOT decide the launch default |
| **`heldout-paraphrase`** | 40 | NEW: `HELDOUT_PARAPHRASES` in `packages/memory/src/bench/heldout.ts`, one per topic, index-aligned | **the decision metric** |

The held-out split is generated deterministically: a fixed, hand-written list committed to the
repository in the same commit as this document, BEFORE the eval runs. Construction invariants,
asserted by `retrieval-eval.test.ts`:

1. each held-out query shares **zero word tokens** with its own labeled record's claim (same
   tokenization as the corpus test: lowercase, split on non-alphanumeric, `_` retained);
2. each held-out query is word-disjoint from the corresponding PUBLISHED paraphrase for the same
   topic (the held-out set is not a re-write of the dev set — at most trivial function-word overlap
   is disallowed entirely by rule 1 against the claim, and rule 2 forbids reusing the dev wording);
3. each held-out query labels exactly one record (the same record id the corpus builder emits).

The eval never re-splits, re-weights, or extends the query sets after results are seen. Adding
topics later means a new pre-registration.

## 2. Metric

**Primary (decision) metric: recall@5 on `heldout-paraphrase`** — `recallAtK` from
`bench/metrics.ts`, mean over the 40 held-out queries. NOT exact match, which is already 100%.

Reported alongside (non-deciding): precision@5, MRR, and per-call rank latency (p50/p95 in ms).
Latency is measured around the full `recallProjection` call with a FRESH scorer per query (the
production shape: one projection per query, so vector precompute for the embedding channel is inside
the measured window). Timings are machine-dependent; they only ever act as the tie-break, never the
primary comparison.

**Regression guard:** exact-family recall@5 for every candidate strategy. A strategy whose exact
recall@5 drops below the lexical-only baseline's exact recall@5 is disqualified regardless of its
paraphrase number (criterion-1 exact dominance must not be traded away).

## 3. Candidate strategies

All behind the versioned scorer id `memory-rank-v2:<embedder-id>:<lexical>:<fusion>`:

1. `lexical-only` — `memory-rank-v2:none:bm25:lexical-only`. The current scorer, unchanged
   (exact-match bonus + FTS5 BM25). The incumbent.
2. `rrf` — reciprocal-rank fusion of the BM25 channel and the cosine channel, k = 60:
   `memory-rank-v2:<embedder-id>:bm25+cosine:rrf-k60`.
3. `weighted` — `0.5 × max-normalized BM25 + 0.5 × max(0, cosine)` (alpha frozen at 0.5; alpha is
   NOT tuned on this eval): `memory-rank-v2:<embedder-id>:bm25+cosine:weighted-a0.5`.

**Embedder tier for the decision:** the eval runs on the **fallback char-ngram embedder**
(`char-ngram-3-6-512`) — the only tier guaranteed present at launch. If an installed on-device model
manifest exists under `~/.crib/embed/` at eval time, the fused strategies are additionally measured
with it and reported, but the launch-default decision uses the fallback-tier numbers, because the
rule must select a default that holds for every user, not only operators who installed a model.

Exact-match handling is identical in every strategy: a record whose subject/appliesTo exactly matches
the query/targets scores the `EXACT_MATCH_BONUS` band and fusion applies only below that band. This
is why the exact guard is expected to hold by construction — it is still measured, not assumed.

## 4. Launch-default selection rule (the commitment)

**Ship as the launch default the strategy with the highest `heldout-paraphrase` recall@5. Ties are
broken by lower rank p95 latency. Subject to the minimum-effect threshold below.**

**Minimum-effect threshold:** a fusion strategy replaces `lexical-only` as the default ONLY if, on
the held-out split:

- its recall@5 is **≥ lexical-only's recall@5 + 0.15 absolute** (e.g. 0.10 → ≥ 0.25 — a jump big
  enough to be unambiguous rather than run-to-run noise on 40 queries), AND
- its exact recall@5 does not regress (guard above), AND
- its rank p95 ≤ 2× lexical-only's rank p95 on the same machine run.

If no fusion strategy clears all three, **`lexical-only` ships as the default** and the fusion code
remains available behind its version id for opt-in use — reported honestly as "no launch-worthy
effect measured", never spun as a win. The threshold is frozen here, before measurement; it is not
negotiated after seeing numbers.

## 5. Honesty commitments

- No metric definition, split, or threshold changes after results exist. A defect found in the eval
  itself voids the run: fix the eval, write a NEW pre-registration, re-run, and report both runs.
- The published result states which strategy the rule selected, including "none / lexical-only".
- Quality claims are never fabricated for the installed or remote embedder tiers: a tier with no
  measured numbers is documented as unmeasured. `char-ngram` is a degraded offline fallback and is
  never advertised as the semantic implementation.

---

## RESULTS (appended after measurement — the pre-registration above is frozen)

<!-- G3.2-RESULTS -->

**Run: 2026-09-03, full pre-registered scale (40 topics → 41 records; 40 held-out / 40 dev / 40
exact queries), fallback tier `char-ngram-3-6-512` (the only tier guaranteed present at launch).
Runner: `runRetrievalEval()` at `packages/memory/src/bench/retrieval-eval.ts`, executed from the
built dist. Rankings are byte-identical run to run; latency samples are inherent-jitter only.**

| strategy (version id) | held-out R@5 (DECIDING) | exact R@5 (guard) | dev R@5 | rank p50/p95 |
| --- | --- | --- | --- | --- |
| `memory-rank-v2:none:bm25:lexical-only` | **7.5%** | 100.0% | 10.0% | 0.1 / 0.1 ms |
| `memory-rank-v2:char-ngram-3-6-512:bm25+cosine:rrf-k60` | 5.0% | 100.0% | 7.5% | 1.1 / 1.2 ms |
| `memory-rank-v2:char-ngram-3-6-512:bm25+cosine:weighted-a0.5` | 5.0% | 100.0% | 12.5% | 1.3 / 1.4 ms |

**Verdict (rule §4, applied as written): no fusion strategy cleared the minimum-effect threshold —
`lexical-only` ships as the launch default.** Best fusion (rrf-k60) reached held-out recall@5
0.050 vs baseline 0.075 — delta **−0.025**, far below the required +0.15, and below the baseline
outright. Exact guard held at 100% for every strategy and fused latency was well under the 2× cap,
so the thresholds that failed were quality, not guards. This is a **negative result, reported as
such** per §4 and §5: the char-ngram fallback channel adds no held-out paraphrase recall on this
corpus, so the fusion code stays available behind its version ids for opt-in use and the
production default ranking is unchanged (`provenance.scorerVersion =
memory-rank-v2:none:bm25:lexical-only`).

Interpretation, honestly bounded: this measures the FALLBACK tier on a 41-record corpus. It does
not measure an installed on-device model (the advertised tier, unmeasured per §5 — no quality
claims are made for it), and 40 queries bound the delta the rule can detect. The measured P0 gap
(paraphrase recall ≪ exact recall) stands: the candidate lever for closing it is a real semantic
embedder, not the fallback channel. Provenance note on the split itself: the first run of the
construction-invariant gate found 32/40 `HELDOUT_PARAPHRASES` entries violating their own stated
word-disjointness invariants; all 32 were rewritten to the frozen invariants **before** this
deciding measurement ran (note in `packages/memory/src/bench/heldout.ts`), so no held-out number
informed the rewrite.