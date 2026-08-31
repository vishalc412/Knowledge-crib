# Memory bench — knowledge-crib baseline (P0)

The ruler every memory phase measures itself against. Produced by:

```bash
node packages/cli/dist/cli.js memory bench --json --out docs/bench/memory-baseline.json
```

Scale: 60 labeled records (120 queries), 12 refactor cases, 5+2 writers, **10,000 records / 1,000 candidates / 1,000 decisions / 500 feedback** for latency, 5 trials. Raw numbers: [memory-baseline.json](./memory-baseline.json). Run `crib memory bench --fast` for a quick smoke; timings are machine-dependent — the ratios are what matter.

## Headline

| Scenario | Metric | Baseline (2026-08-31) |
|---|---|---|
| (a) recall relevance | exactly-worded recall@5 | **100%** (MRR 0.958) |
| (a) recall relevance | **word-disjoint paraphrase recall@5** | **1.7%** (MRR 0.032) |
| (b) refactor survival | staleness-precision | **100%** (12/12 PRD verdict transitions) |
| (c) cross-writer | duplicate-collapse (content-id dedupe) | **100%** |
| (c) cross-writer | conflict groups surfaced / expected | **1/1** |
| (d) trust gradient | invariant violations | **0** (6 checks) |
| (e) latency @10k | recall call p50 / p95 | **553 ms / 577 ms** |

## Reading the three lines that matter

**Paraphrase is the Phase-3 target.** Queries that share zero tokens with the claim ("dependency resolution breaks whenever the manifest gets regenerated" → "run pnpm dedupe after lockfile churn") are nearly invisible to the lexical-only scorer: recall@5 1.7%, MRR 0.032. Exact-worded memory works perfectly. This is the quantified "lexical-only recall misses meaning" line Phase 3 (hybrid retrieval) must demonstrably move — or not ship.

**Revalidation dominates latency (the J1 curve).** Per recall call at 10k records:

| Phase | p50 | p95 |
|---|---|---|
| gather (all three stores, every shard) | 42.8 ms | 45.4 ms |
| FTS rebuild (per call — the J1 defect) | 33.1 ms | 34.2 ms |
| rank (cold, no evaluator) | 53.3 ms | 58.0 ms |
| **fresh revalidation (evaluator vs soul)** | **421 ms** | **441 ms** |
| **total per `memory_recall`** | **553 ms** | **577 ms** |

`recallProjectionOf` re-runs all of this **per call, per agent**. A swarm does not parallelize away full-shard scans + an FTS rebuild + whole-ledger regrounding — it multiplies them. Phase 3's persistent read model must cut the non-fresh path (gather+rebuild ≈ 76 ms is cacheable) and the fresh path (revalidate changed-records-only).

**Trust invariants hold under pressure.** Candidates never recall; a contradicted signal without admissible counter-evidence never quarantines; with it, the local copy dies while the team twin of the same content id survives (no-poison). Write path: ~3.9k single-entry upserts/s including per-write lock acquire/release (the Phase 6 fan-in design constraint).

## What each phase is expected to move

- **P1 (fast local trust lane):** (d) gains an auto-verify lane; trust-discipline checks extend to it.
- **P2 (scoping):** (c)/(d) extended per-agent; isolation checks become per-scope.
- **P3 (persistent hybrid retrieval):** paraphrase recall@5 must move off 1.7%; latency p95 must drop ≥5× at 10k (persistent FTS + incremental rebuild + scorer reuse).
- **P4 (Tier-2 extraction):** (d) gains the false-claim-never-promotes proof test.
- **P5 (lifecycle):** (b) gains the reviewAfter/expiry decay expectations; consolidation merges synthetic duplicates without recall regression.