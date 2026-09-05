# Launch gate — performance and reliability

<!-- CURRENT STATE — maintained. Sections below are an append-only history; earlier rows that
     say "BLOCKED" or "not yet passing" for 100k were superseded by the final run. -->

> ## Current state — 5 Sep 2026
>
> | gate | threshold | measured | verdict |
> | --- | --- | --- | --- |
> | Warm local recall p95 @ 10k | < 100 ms | **8.3 ms** | **PASS** |
> | Warm local recall p95 @ 100k | < 300 ms | **132.8 ms** | **PASS** |
> | `git commit` blocking added | 0 ms | 0 ms | **PASS** |
> | Failed refresh readability | prior generation preserved | covered by Gate 3.3 tests | **PASS** |
> | One-file watch update → queryable | < 5 s p95 | — | **NOT MEASURED** (no E2E fixture) |
> | Sync convergence soak | no data loss | — | **NOT RUN** (unit-tested only) |
>
> Recall latency went 2074 ms → 8.3 ms at 10k and 3775 ms → 132.8 ms at 100k across seven
> loop-invariant defects. The two open rows are open: they have never been measured, and no claim
> should be made about either.


Status: DESIGN (frozen before the launch-verification run). Existing measurements from
`docs/bench/scale-curve.md` and Gate 3's E2E are the baselines; the launch run re-measures against
the gates below on the current build and appends results here.

## Gates

| Gate | Threshold | Where measured |
|------|-----------|----------------|
| Warm local recall p95 @ 10k records | < 100 ms | `scripts/scale-bench.mjs` (J1 latency family; rank with fresh=false, warmed FTS) |
| Warm local recall p95 @ 100k records | < 300 ms | same, scaled slice |
| One-file watch update → queryable | < 5 s p95 (crib repo) | Gate 3 E2E watch fixture — re-run against the current build |
| `git commit` blocking added by crib | 0 ms blocking (hooks async/fire-and-forget) | freshness post-commit hook timing + freshness-worker lease path |
| Failed refresh readability | prior readable generation preserved | GenerationCache law (Gate 3.3): a failed refresh never replaces the last good generation |
| Sync convergence | duplicate / reordered / offline / interrupted events converge without data loss | Gate 4 engine tests + a dedicated soak scenario in the launch run |

## Method honesty

- Timings are measured over the real CLI/MCP process boundary (cold process spawn excluded from the
  "warm" numbers but reported separately) — per `docs/bench/memory.md`'s in-process-vs-real-cost
  lesson.
- p95 over >= 50 warm iterations after >= 5 warmup iterations, single machine, background load noted
  in the run report.
- The soak scenario (`crib freshness auto` beyond the 5s fixture) runs the durable worker through a
  15-minute wall-clock window with synthetic churn and reports lease/heartbeat/dead-letter counts.

## Known open integration followups (carried, not launch-blocking unless they fail their gate)

- On-device embedder model acquisition is an operator out-of-band step (char-ngram fallback is the
  shipped default and is declared degraded honestly).
- Persistent FTS snapshot size/rotation policy at 10k+ scale — measured, not yet capped.
- Sync-log rotation/compaction — documented operator procedure, not yet automated.
---

## RESULTS (appended by the launch-verification run, 2026-09-04)

**Machine:** darwin 25.6.0, Node 22.23.1, single machine, no significant background load.
**Build:** `feature/superset-plan` + launch-audit fixes. Method per §"Method honesty": 5 warmup +
50 warm iterations, `fresh=false`, p95 reported.

### The measurement instrument was wrong, and was replaced

The gate table names `scripts/scale-bench.mjs` (the J1 latency family) as the measurement site. **The
J1 family does not measure the production recall path.** `runLatency` (`bench/scenarios.ts:112-129`)
constructs `new MemoryFtsIndex(':memory:')` + `fts.rebuild(...)` and a raw `new MemoryEvaluator()`
— the *pre-Gate-3* shape. Production recall (`MemoryApi.search`, and `Verbs.recallProjectionOf`)
goes through `lexicalChannel`'s persistent snapshot and `bindEvaluationPass`'s generation-keyed
cache. A gate measured on J1 could neither pass nor fail honestly.

The run below therefore measures **`MemoryApi.search`** directly, over the same 10k corpus the J1
family builds.

### Gate results

| Gate | Threshold | Measured | Verdict |
|------|-----------|----------|---------|
| Warm local recall p95 @ 10k | < 100 ms | **1321.8 ms** | **FAIL** (13.2×) |
| Warm local recall p95 @ 100k | < 300 ms | **not measured** | **BLOCKED** (bench scale caps at 10k) |
| One-file watch update → queryable | < 5 s p95 | **not measured** | **BLOCKED** (no E2E watch fixture wired) |
| `git commit` blocking added by crib | 0 ms | **0 ms** — managed block runs `crib freshness hook`; `crib doctor` asserts it | **PASS** |
| Failed refresh readability | prior generation preserved | GenerationCache law covered by Gate 3.3 tests | **PASS (by test, not by soak)** |
| Sync convergence | converge without data loss | Gate 4 engine tests pass; **dedicated soak not run** | **PARTIAL** |

### Where the 1321.8 ms goes (CPU profile, 10 searches @ 10k)

| frame | share |
|---|---|
| `parseMemoryShard` (`loader.js:28`) | **37%** |
| `readFileSync` | **28%** |
| `supersededBy` (`api.js:1923`) | 27% *(before the fix below)* |
| `enrichHit` | 9% |

**~65% of every search is re-reading and re-validating the entire ledger from disk.** `gatherRecall`
has no cache: each `search()` re-reads every JSONL shard, re-parses it, and re-runs Ajv validation
plus the `^mem:[0-9a-f]+$` / `^blake3:` id regexes over all 10k records. G3.1 delivered a persistent
index for **FTS only**; the *gather* — the larger cost — was never cached.

### Two defects fixed during this run (2074 → 1322 ms p95, −36%)

1. **`search` rebuilt a 10k-element array per hit.** `gathered.records.map(...)` sat *inside* the
   per-hit `projection.memories.map(...)`, making the call O(hits × records). Hoisted; the ledger
   path (`ledgerRows`) already hoisted the identical projection, so the two paths are now consistent.
2. **`supersededBy` scanned the whole pool per hit** to answer "what supersedes this record?" —
   27% of the call. Replaced with a reverse `lineage.supersedes` index built once per gathered array
   and memoized on its identity (the `evaluationCacheFor` WeakMap pattern), so no signature threading
   and other callers are unchanged.

### The remaining gap is architectural, not a hot loop

Closing 1322 ms → <100 ms requires a **generation- or mtime-keyed gather cache** so a search over an
unchanged ledger does not re-read and re-validate it. That is the same idea G3.1 applied to FTS,
applied to the layer that actually dominates. It carries real invalidation obligations (store writes,
cross-process writers, sync pulls) and is a designed change, not a hot-loop fix — so it is recorded
here as the blocking item rather than attempted under the audit.

**Verdict: the performance gate FAILS and is launch-blocking.**

---

## RE-MEASURED after the recall optimisation (2026-09-04, same session)

Five defects removed from `MemoryApi.search`, each found by CPU profile, each verified by re-measure:

| # | Defect | Fix |
|---|---|---|
| 1 | `gathered.records.map(...)` rebuilt a 10k array **per hit** | hoisted out of the map |
| 2 | `supersededBy` scanned the whole pool **per hit** | reverse `lineage.supersedes` index, memoized on the array identity |
| 3 | every search re-read + re-validated the **entire ledger** | shard-level memo keyed on a new whole-store `store.gen` sidecar |
| 4 | the generation sidecar was re-read **per shard**, then **per lookup** | stat-validated memo (nanosecond mtime) + a pinned generation per read pass |
| 5 | `search` enriched **every eligible record** to return ≤20 | `SearchOpts.limit`, applied before enrichment (`limit + 1` preserves `truncated`) |

`store.gen` is deliberately separate from `fts.gen`: the FTS generation bumps only for RECORD
collections, but the gather also reads `decisions` and `feedback` — and decisions carry
supersede/retract, so a cache keyed on `fts.gen` could have resurrected a retracted memory.

### Gate results

| Gate | Threshold | Before | After | Verdict |
|------|-----------|--------|-------|---------|
| Warm local recall p95 @ 10k | < 100 ms | 2074 ms | **52.2 ms** | **PASS** |
| Warm local recall p95 @ 100k | < 300 ms | — | **not yet passing** — 7362 ms unlimited; the limited-page run did not complete in this session | **OPEN** |
| `git commit` blocking | 0 ms | 0 ms | 0 ms | **PASS** |

**10k: 2074 ms → 52.2 ms, a 40× improvement, gate PASS.** 2,496 tests green, biome clean,
`crib doctor` 12/12 throughout.

**100k remains open and is the honest blocker.** The unlimited-enrichment shape measures 7.4 s at
100k, which says the per-hit enrichment path still scales with the corpus somewhere the 10k run did
not expose. The limited-page measurement — the production shape that passes at 10k — has not been
completed at 100k, so this row must not be reported as passing.

---

## RE-MEASURED again after the decision-index fix (2026-09-04)

A sixth defect, found by isolating the phases at 100k rather than trusting the profiler's
attribution (the 100k CPU profile is dominated by corpus SETUP, which runs the evaluator; the
searches under test do not):

| # | Defect | Fix |
|---|---|---|
| 6 | `effectiveVerdicts` did `decisions.filter(d => d.subject === record.id)` — a full scan of the pool **per record**. At 100k records over 10k decisions that is ~1.09 **billion** comparisons | optional `DecisionsBySubject` index, built once per stable pool in `recallProjection`; the G1.2 alias-bridge path keeps the scan, since its pool is synthesised per record |

### Gate results

| Gate | Threshold | Original | Now | Verdict |
|------|-----------|----------|-----|---------|
| Warm local recall p95 @ 10k | < 100 ms | 2074 ms | **24.7 ms** | **PASS** (84×) |
| Warm local recall p95 @ 100k | < 300 ms | 3775 ms | **1067 ms** | **FAIL** (3.5× better, still 3.6× over) |

### Why 100k is architectural, not another hot loop

Phase isolation at 100k, after the fix:

```
1. gatherRecall (cached reads)            p50 =    2.9 ms
2. recallProjection (rank ALL records)    p50 = 1039.3 ms
3. full api.search (limit 20)             p50 = 1067.1 ms
   ranking share of the call: 97%   |   gathered records: 109,091
```

`effectiveVerdicts` is now 207 ms of the projection; the remaining ~4.7 s per 6 projections is
`recallProjection`'s own loop body — roughly **10 µs per record**, which is honest O(N) work, not a
quadratic left to find. Ranking a 109k-record corpus to return 20 rows cannot reach 300 ms however
tightly the loop is written.

**The fix is candidate-pool retrieval**: let the persistent FTS index produce a bounded top-K, and
compute verdicts + scoring only for those. It is deliberately NOT attempted here, because it changes
a correctness contract rather than an implementation detail — `conflicts` and
`provenance.counts` are computed over the CONSIDERED set, and the W3 exit gate requires that
"conflicting claims appear together". A candidate pool that never sees a conflicting record cannot
surface it. That needs a design (probably: pool for ranking, plus a propositionKey-keyed second pass
so conflict groups stay complete), a pre-registered eval, and its own tests.

**100k remains a documented FAIL. It is not reported as passing, and no launch claim should say
100k until the redesign lands and is measured.**

---

## FINAL — both scale gates PASS (2026-09-04)

A seventh defect, and the largest of all. It was found only after direct phase instrumentation:
two profiler attempts pointed at the wrong place (the 100k CPU profile is dominated by corpus SETUP,
and V8 inlining attributed the projection's body to the caller's frame), and a hand-written
replication of the loop ran in 13.8 ms against a real 1055 ms — the replication had omitted one line.

| # | Defect | Fix |
|---|---|---|
| 7 | `const decs = source === 'local' ? [...gathered.decisions, ...gathered.localDecisions] : …` — a two-array SPREAD **inside** the per-record loop. The pool is identical for every local record, so at 100k records over 10k decisions it copied ~360 million elements, and was **92% of the entire projection** | build the merged pool once, lazily (a projection with no local records still pays nothing) |

Phase timings inside `recallProjection` @ 109,091 records, before the fix:

```
buildAliasIndex           0.0 ms
feedback + decisionIdx    0.4 ms
MAIN LOOP              1055.6 ms   ← 92%
score map                12.4 ms
sort                     78.5 ms
TOTAL                  1146.9 ms
```

### Gate results — both PASS

| Gate | Threshold | Original | Final | Verdict |
|------|-----------|----------|-------|---------|
| Warm local recall p95 @ 10k | < 100 ms | 2074 ms | **8.3 ms** | **PASS** (250×) |
| Warm local recall p95 @ 100k | < 300 ms | 3775 ms | **132.8 ms** | **PASS** (28×) |
| `git commit` blocking | 0 ms | 0 ms | 0 ms | **PASS** |

**The earlier "100k is architectural, it needs candidate-pool retrieval" conclusion was WRONG and is
retracted.** It was a seventh hoistable loop defect, not a design limit. No candidate-pool redesign
is needed, and the correctness contract that redesign would have threatened — `conflicts` and
`provenance.counts` computed over the full considered set, so "conflicting claims appear together"
still holds — is preserved untouched.

**Method note worth keeping:** every one of the seven defects was a loop-invariant recomputation, and
the last one was invisible to two different profiling approaches. Phase instrumentation of the real
function beat both sampling and reimplementation.

### Still open

- Watch-update → queryable (< 5 s p95): unmeasured, no E2E fixture wired.
- Sync convergence soak: unit-tested, never run as a soak.

---

## Persistent vector store (2026-09-04)

Making `semantic-only` the shipped default introduced a cost the earlier perf runs never measured:
those runs used no lexical scorer at all, so they never embedded anything.

**The defect.** `VersionedLexicalScorer` holds record vectors for its own lifetime, and
`lexicalChannel` constructs a FRESH scorer per verb call. With the char-ngram fallback that was free.
With `multilingual-e5-large`, embedding a 307-record ledger measured **4,896 ms** — paid by every
recall, by every agent. The ranking quality would have been real and unaffordable.

**The fix.** `MemoryVectorStore` — SQLite, one row per `(record_id, embedder_id, text_version)`,
opened beside the FTS snapshot under the store's index home.

Invalidation is a non-problem, and that is a property of the ledger rather than a trick: a memory id
is `mem:<blake3-of-content>`, so a record's text cannot change under a stable id. A vector keyed that
way is **immutable** — there is no staleness to detect and no write path that can invalidate a row.
Edits mint a new id and simply miss. The store therefore has no `invalidate()`; the only reason to
delete a row is that its record is gone (`pruneOrphans`).

| | model calls | texts embedded | rows |
|---|---|---|---|
| no vector store, per call | 2 | **308** | — |
| with the store, first call | 2 | 308 | 307 persisted (1.4 MB) |
| with the store, later calls | 1 | **1** (the query) | — |

At the measured ~16 ms/text that is **~4.9 s → ~16 ms** per recall.

*Honest reading of the wall-clock:* the millisecond figures in that experiment are contaminated,
because the embed adapter used for the run has a disk cache of its own. The clean signal is the
embed COUNT — 308 → 1 — which is independent of any adapter cleverness. A production embedder with
no cache of its own is exactly the case this store exists for.

### A latent contract defect this surfaced

Batching the record embeddings changed `recordVecsFor` from `embed()` to `embedBatch()`, and the
launch gate immediately fell **8/8 → 7/8** (G2 81.0% → 73.2%).

The cause was in the model adapter, not in crib: it applied an E5 `query:` prefix in `embed` and
`passage:` in `embedBatch`, so the ranking depended on which method a caller happened to use.
`Embedder` now states the invariant explicitly — **`embedBatch(texts)[i]` MUST equal
`embed(texts[i])`; batching is a performance variant, never a semantic one** — and notes that a
model needing genuine asymmetry should be two embedders with distinct ids, not two methods of one.

The adapter was made symmetric (`query:` on both sides), which is also E5's own guidance for
similarity tasks and measures better here: **81.0% symmetric vs 73.2% asymmetric**. Its `id` was
bumped with the behaviour change, because `id` keys the vector cache and a silent behaviour change
under a stable id would serve vectors from the old space.

**Gate restored: 8/8.**
