# Memory bench — knowledge-crib baseline (P0)

The ruler every memory phase measures itself against. Produced by:

```bash
node packages/cli/dist/cli.js memory bench --json --out docs/bench/memory-baseline.json
```

Scale: 40 labeled records (80 queries — the `topics: 60` knob is capped to the 40-entry distinct topic bank; see the corpus fix below), 12 refactor cases, 5+2 writers, **10,000 records / 1,000 candidates / 1,000 decisions / 500 feedback** for latency, 5 trials. Raw numbers: [memory-baseline.json](./memory-baseline.json). Run `crib memory bench --fast` for a quick smoke; timings are machine-dependent — the ratios are what matter.

## Corpus fix (2026-09-02) — distinct topics, honest MRR ceiling

The 2026-08-31 baseline cycled a **12-topic bank 5×** (`TOPICS[i % 12]`): every paraphrase query was emitted 5 times, each labeling one of five near-identical records (same topic, different mod token). MRR was therefore capped at ≈ 1/2.2 ≈ **0.46** and paraphrase ranking could not be measured at all. The bank is now **40 hand-written topics drawn DISTINCTLY** (`n = min(n, TOPICS.length)` in `relevanceCorpus`): each query labels exactly one record, exact and paraphrase both get a clean 1.0 ceiling, and the zero-token-intersection invariant is preserved (asserted per-topic in `bench.test.ts`).

What changed:

| Metric | Before (2026-08-31, 12 topics × 5) | After (2026-09-02, 40 distinct) |
|---|---|---|
| exact recall@5 | 100% | 100% |
| exact MRR | 0.958 (ceiling-capped corpus) | **1.0** (clean ceiling) |
| paraphrase recall@5 | 1.7% | **10%** |
| paraphrase MRR | 0.032 | **0.049** |

The paraphrase move from 1.7% → 10% is **not** a scorer improvement — it is the fix making the number interpretable. With zero lexical signal the projection falls back to its deterministic tiebreak (source tier, then newest-first `createdAt`); measured with the lexical scorer disabled entirely, that pure tie-order floor is **recall@5 12.5% / MRR 0.057** on this corpus. The BM25 paraphrase numbers (10% / 0.049) sit slightly *below* that floor — weak stopword matches actually displace the labeled record. So the honest reading is unchanged: **a lexical-only scorer retrieves essentially no meaning** (paraphrase recall ≈ its tie-order noise floor), and the Phase-3 semantic scorer must demonstrably beat that floor, not merely the old 1.7%.

## Headline

| Scenario | Metric | Baseline (2026-09-02) |
|---|---|---|
| (a) recall relevance | exactly-worded recall@5 | **100%** (MRR 1.0) |
| (a) recall relevance | **word-disjoint paraphrase recall@5** | **10%** (MRR 0.049 — at the tie-order floor; see corpus fix) |
| (b) refactor survival | staleness-precision | **100%** (12/12 PRD verdict transitions) |
| (c) cross-writer | duplicate-collapse (content-id dedupe) | **100%** |
| (c) cross-writer | conflict groups surfaced / expected | **1/1** |
| (d) trust gradient | invariant violations | **0** (6 checks) |
| (e) latency @10k | recall call p50 / p95 | **570 ms / 609 ms** (553/577 on the 2026-08-31 run — machine noise; ratios are what matter) |

## Reading the three lines that matter

**Paraphrase is the Phase-3 target.** Queries that share zero tokens with the claim ("dependency resolution breaks whenever the manifest gets regenerated" → "run pnpm dedupe after lockfile churn") are invisible to the lexical-only scorer: recall@5 10%, MRR 0.049 — i.e. at (slightly below) the 12.5%/0.057 pure tie-order floor, meaning BM25 contributes nothing and the hits are fallback ordering, not recall. Exact-worded memory works perfectly (MRR at its clean 1.0 ceiling). This is the quantified "lexical-only recall misses meaning" line Phase 3 (hybrid retrieval) must demonstrably move — or not ship.

**Revalidation dominates latency (the J1 curve).** Per recall call at 10k records:

| Phase | p50 | p95 |
|---|---|---|
| gather (all three stores, every shard) | 44.9 ms | 46.6 ms |
| FTS rebuild (per call — the J1 defect) | 35.1 ms | 47.8 ms |
| rank (cold, no evaluator) | 55.9 ms | 63.7 ms |
| **fresh revalidation (evaluator vs soul)** | **429 ms** | **462 ms** |
| **total per `memory_recall`** | **570 ms** | **609 ms** |

`recallProjectionOf` re-runs all of this **per call, per agent**. A swarm does not parallelize away full-shard scans + an FTS rebuild + whole-ledger regrounding — it multiplies them. Phase 3's persistent read model must cut the non-fresh path (gather+rebuild ≈ 80 ms is cacheable) and the fresh path (revalidate changed-records-only).

**Trust invariants hold under pressure.** Candidates never recall; a contradicted signal without admissible counter-evidence never quarantines; with it, the local copy dies while the team twin of the same content id survives (no-poison). Write path: ~4.0k single-entry upserts/s including per-write lock acquire/release (the Phase 6 fan-in design constraint).

## What each phase is expected to move

- **P1 (fast local trust lane):** (d) gains an auto-verify lane; trust-discipline checks extend to it.
- **P2 (scoping):** (c)/(d) extended per-agent; isolation checks become per-scope.
- **P3 (persistent hybrid retrieval):** paraphrase recall@5 must move decisively off the tie-order floor (12.5% pure fallback / 10% measured BM25-only) — beating the floor means the scorer is actually matching meaning, not benefiting from fallback ordering; latency p95 must drop ≥5× at 10k (persistent FTS + incremental rebuild + scorer reuse).
- **P4 (Tier-2 extraction):** (d) gains the false-claim-never-promotes proof test.
- **P5 (lifecycle):** (b) gains the reviewAfter/expiry decay expectations; consolidation merges synthetic duplicates without recall regression.