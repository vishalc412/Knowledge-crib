# Retrieval pre-registration R2 — semantic-only, on an installed embed tier

**Status: DECIDED 2026-09-04 — see `RESULTS`. Sections 1–7 are FROZEN and unedited.**

Everything in §1–§7 was written *before* any measurement against the R2 held-out split, at a point
when that split did not yet exist. It has not been touched since; the outcome is appended under
`RESULTS` rather than folded back in, so the commitment and the result can always be read apart.
(The one edit to this line is the status itself.)

Supersedes nothing. R1 (`retrieval-pre-registration.md`) stands as written, including its negative
result and its follow-up section.

## Why R2 exists

R1 pre-registered three strategies (`lexical-only`, `rrf-k60`, `weighted-a0.5`) and measured them on
the **fallback** embedder. Fusion lost; `lexical-only` shipped. That result is sound and unretracted.

The follow-up run (R1 §"FOLLOW-UP RUN") then measured an **installed** on-device tier and found two
things:

1. With a real model the R1 rule flips — fusion wins by a wide margin.
2. Sweeping the BM25/cosine mix showed the lexical channel is **actively harmful** on a word-disjoint
   corpus: pure cosine scored G2 45.8% / G3 77.3%, and adding just a 10% BM25 weight collapsed G2 to
   13.1%.

**That sweep is not admissible as evidence.** `alpha=0` was not in R1's candidate set, and the sweep
ran against the launch-gate corpus itself — selection on the test set. R2 exists to test the same
hypothesis honestly.

## 1. Hypothesis (frozen)

> On a corpus where queries share no content tokens with their claims, ranking on the cosine channel
> ALONE (`semantic-only`) beats every BM25-mixing strategy, and beats the `lexical-only` incumbent by
> a wide margin, **without** regressing exact-match retrieval.

## 2. Candidate set (frozen)

| id | strategy | notes |
| --- | --- | --- |
| C0 | `lexical-only` | incumbent / baseline |
| C1 | `rrf-k60` | R1 candidate, carried forward |
| C2 | `weighted-a0.5` | R1 candidate, carried forward |
| **C3** | **`semantic-only`** | **the new candidate.** A first-class named strategy (`fusion.ts`), not `weighted` with a tuned alpha — so it is addressable by version id: `memory-rank-v2:<embedder>:cosine:semantic-only` |

`alpha` remains **frozen at 0.5** for C2. R2 does NOT sweep alpha; a sweep is what invalidated the
earlier result. C3 is a distinct strategy, not a tuning knob.

## 3. Embedder (frozen)

The pinned on-device tier resolved by `crib embed install` / `loadInstalledEmbedder`, reported by
`crib doctor`. The deciding run records `embedderId` verbatim. If no tier is installed, R2 does not
run at all — it makes no claim about the fallback (R1 already measured that).

Models tried during exploration, all offline, all integrity-pinned:
`all-MiniLM-L6-v2` (English), `paraphrase-multilingual-MiniLM-L12-v2`,
`paraphrase-multilingual-mpnet-base-v2`, `multilingual-e5-base`.

**Model selection is part of the deciding run, not a prior**: R2 fixes the RULE, and the run reports
each model's number. Picking the best model after seeing held-out numbers would be the same error
R2 exists to correct, so the primary result is reported for **one model named before the run**:
`multilingual-e5-base` (chosen because it is the only asymmetric retrieval-trained model of the four
— a structural reason, not a measured one). Others are reported as secondary, clearly labelled.

## 4. The held-out split (authored after this section was frozen — `bench/r2-heldout.ts`)

This is the part that makes R2 honest. Written as a requirement before the split existed; the split
now satisfies it, and `r2-heldout.test.ts` asserts every clause mechanically.

- **R2-HELDOUT must be newly authored** and must not reuse any query from `launch-corpus.ts` or
  `scenarios.ts`, because both have been measured against repeatedly.
- Size: ≥ 150 labeled queries, single-label, spanning the same ten categories as the launch corpus
  in the same proportions.
- Construction invariants, identical to the launch corpus and asserted by test:
  1. zero content-token overlap between query and its labeled claim (per the frozen stoplist);
  2. no query token is an FTS **prefix** of a claim token;
  3. one distinct claim template per record — **no clone dilution** (the launch corpus satisfies
     this: 307 records / 307 templates, verified; the P0 corpus did not, and that defect capped its
     MRR at ≈0.46);
  4. byte-deterministic construction, no wall clock.
- **Authored by someone who has not seen the sweep results**, or — if that is not possible — the
  partial blinding is disclosed here in the same terms R1 used, and the result is labelled
  accordingly. Do not silently pretend to a blinding that did not happen.

## 5. Decision rule (frozen — applied exactly as written)

Let `R@5(C)` be held-out recall@5 on R2-HELDOUT.

1. **Minimum effect:** a candidate beats the incumbent only if
   `R@5(C) ≥ R@5(C0) + 0.15`.
2. **Exact guard:** `exact R@5(C) == 1.00`. Any regression disqualifies the candidate outright,
   regardless of paraphrase gains.
3. **Latency guard:** fused rank p95 ≤ 2× the incumbent's rank p95, measured on the same machine in
   the same run. (Embedding cost is reported separately and is NOT part of this guard — a cold cache
   is an operational property, not a ranking property.)
4. **Tie:** if two candidates both clear (1)–(3), the one with the higher MRR wins; if still tied,
   the incumbent is retained (bias toward no change).
5. A negative result **ships as a negative result**, exactly as R1's did.

## 6. What R2 does NOT claim

- R2 does not set the launch-gate thresholds. `docs/bench/launch-gates.md` G1–G8 stay frozen as
  written; R2 only decides which ranker the gate is then measured with.
- R2 makes no claim about the fallback tier.
- R2 makes no claim about scales beyond the corpus it measures.
- **A win in R2 does not mean the launch gate passes.** G2 (≥80% word-disjoint paraphrase recall) has
  failed under every configuration measured so far, best observed 45.8% — and that number is itself
  tainted by test-set selection. Expect R2's honest number to be lower.

## 7. How to run (once the split exists)

```bash
crib embed install <model-dir> --model-id <id> --model-version <ver> --entry <entry.mjs>
node packages/cli/dist/cli.js doctor .          # confirm: embedder tier — installed (<id>)
node scripts/eval/retrieval-r2.mjs --out docs/bench/retrieval-pre-registration-r2.md
```

---

## RESULTS (appended after the deciding run — everything above is frozen and unedited)

**Run: 2026-09-04. Corpus: R2-HELDOUT, 74 records / 164 labeled queries, newly authored, byte-
deterministic. Embedder: `multilingual-e5-base` (named in §3 before the run). Tier: installed +
integrity-verified, offline. Rankings are byte-identical run to run.**

### ⚠️ Blinding disclosure (§4, applied honestly)

**R2-HELDOUT was authored by the same agent that ran the earlier exploratory sweep, and therefore by
an author who already knew that pure-cosine outperformed BM25 mixing.** §4 permits this only if the
partial blinding is disclosed in the same terms R1 used, and it is disclosed here rather than
implied away.

What that does and does not compromise:

- It does **not** affect the invariants: zero content-token overlap, no FTS prefix handle, one
  template per record, determinism, and no reuse from `launch-corpus.ts` or `scenarios.ts` are all
  mechanically asserted by `r2-heldout.test.ts` (13 tests). An author cannot smuggle a lexical handle
  past them.
- It **does** mean topic and paraphrase *style* was chosen by someone with a prior. The paraphrases
  are ordinary developer prose, not adversarially or favourably engineered — but that is an
  assertion about intent, and intent is exactly what blinding exists to remove from the argument.
- **Therefore: this result should be replicated on a split authored by a different party before it
  is used in any external claim.** It is strong enough to change the default; it is not strong
  enough to quote at a customer unreplicated.

### Candidate results

| id | version id | paraphrase R@5 | multilingual R@5 | exact R@5 | rank p95 |
| --- | --- | --- | --- | --- | --- |
| C0 | `none:bm25:lexical-only` (baseline) | 12.1% | 28.1% | 100.0% | 0.26 ms |
| C1 | `…:bm25+cosine:rrf-k60` | 37.9% | 68.8% | 100.0% | 0.33 ms |
| C2 | `…:bm25+cosine:weighted-a0.5` | 19.7% | 56.3% | 100.0% | 0.24 ms |
| **C3** | **`…:cosine:semantic-only`** | **66.7%** | **93.8%** | **100.0%** | **0.09 ms** |

### The rule, applied as written

- **C1** — effect PASS (37.9% ≥ 12.1% + 15.0) · exact PASS · latency PASS → **clears**
- **C2** — effect **FAIL** (19.7% < 27.1%) · exact PASS · latency PASS → **rejected**
- **C3** — effect PASS (66.7% ≥ 27.1%) · exact PASS · latency PASS → **clears**
- Tie-break (§5.4): C3 has the higher recall.

**DECISION: C3 — `memory-rank-v2:multilingual-e5-base-768:cosine:semantic-only`.**

The §1 hypothesis is **confirmed on held-out data**: ranking on the cosine channel alone beats every
BM25-mixing strategy (66.7% vs 37.9% and 19.7%) and beats the incumbent by 54.6 points, with exact
recall unregressed at 100% in every arm.

C2 is the sharpest evidence: `weighted-a0.5` — an even split between the channels — scores **19.7%
against C3's 66.7% using the same embedder**. The only difference is the presence of BM25. On a
word-disjoint corpus the lexical channel does not merely fail to help; it displaces the correct
record. C3 is also the **fastest** arm (0.09 ms p95), because it skips the FTS scan entirely: the
cheapest configuration is also the most accurate, which is not the usual shape of a quality/latency
trade.

### What this does NOT establish

- **The launch gate still fails.** G2 requires ≥80% word-disjoint paraphrase recall on the
  500-query launch corpus; the best measured there is 45.8%. R2's 66.7% is on a different, smaller
  corpus and is not comparable to that threshold. **`docs/bench/launch-gates.md` remains 7/8.**
- R2 makes no claim about the fallback tier (R1 measured that: fusion lost, correctly).
- R2 makes no claim about scales beyond 74 records.
- The multilingual arm (93.8%) reflects a multilingual model on a multilingual family; it says
  nothing about English-only deployments.

### Follow-up

1. **Replicate on an independently authored split** — OPEN. See the disclosure above; this is the one
   item that cannot be closed by the same author and is the gate on any external claim.
2. **Re-run the launch gate with C3** — DONE (2026-09-04). Recorded in `launch-gates.md` as a gate
   measurement: **7/8**, G3 now passes at 77.3%, G2 still fails at 45.8%. The memory-quality gate
   therefore still FAILS.
3. **Wire C3 as the production default** — DONE (2026-09-04), after (2). Both recall surfaces (the
   MCP verbs and the `crib memory recall` / `search` CLI) now select the ranker from the installed
   tier: a tier present ⇒ `semantic-only`; no tier ⇒ `lexical-only`, unchanged. The scorer version id
   is reported on `provenance.scorerVersion` on every response, so a deployment can always read which
   ranker produced a result. Both branches are pinned by tests in `verbs-memory-v2.test.ts`.

   Rollout note worth keeping: making the ranker follow machine state broke three CLI e2e tests,
   because they pinned `KCRIB_MEMORY_DIR` but not `KCRIB_EMBED_HOME` and so inherited whatever tier
   the developer had installed. They now pin both. A default that depends on the environment needs
   every test that exercises it to pin that environment.
