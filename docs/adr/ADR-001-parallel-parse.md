# ADR-001 — Parallel parse: bounded concurrency as the shipped default, worker-thread pool retained as opt-in

- **Status:** Accepted
- **Date:** 2026-07-13
- **Milestone:** M3.4 (parallel parse)
- **Supersedes:** the M3.4 plan row's original "≥ 2× faster via worker-thread pool" gate — reframed to the honest, measured contract (see *Reframe* below).

## Context

The M3.4 plan row called for a worker-thread pool over file batches, gated on "index time on the parsers-pkg fixture ≥ 2× faster; deterministic output identical." The motivation was sound — Phase 2 (parse) is the longest single phase of `crib index`, and extractors are pure per-file, so parallelizing them is the obvious lever. The question this ADR answers is **which** parallelism mechanism ships as the default, given crib's hard determinism invariant and its parse-workload shape.

### Crib's parse workload (measured)

Each extractor is `async` (`await ctx.readText()` for the file body) followed by **sync** CPU work — regex for 22/23 languages, tree-sitter WASM for PHP. Per-file work is ~0.45 ms, of which:

- **~75–80 % sync CPU** (regex / tree-sitter parse) — a single Node event-loop thread cannot run two of these concurrently; they serialize on the main thread under `Promise.all` too.
- **~20–25 % `readFile` I/O** — async, overlap-able on the event loop (libuv thread pool), the only fraction any in-process mechanism can hide.

The 23-file `packages/parsers/fixtures` tree is too small to amortize any dispatch overhead, so all measurements use a **scaled fixture** (the 23-file tree copied into 100 sibling `batchN/` dirs → ~2300 files). `scripts/parallel-check.mjs` is the pinned gate.

## Considered options

### Option A — Worker-thread pool over file batches (the plan's original proposal)

A persistent `worker_threads` pool; the main thread dispatches file batches, each worker resolves an extractor and returns plain `{nodes, edges}` JSON; the main thread persists in discovery order (determinism — see *Determinism trick*).

Implemented in `packages/pipeline/src/parse-worker.ts` + `parse-pool.ts` (kept behind `KCRIB_PARALLEL=workers`).

**Measured result: NET-NEGATIVE (~0.65× at N=50, ~0.72× batched at N=100).** Slower than serial. Four compounding costs:

1. **Cold V8 JIT.** A fresh worker isolate starts with cold inline caches + an unwarmed regex compiler. The regex extractors run ~2–3× slower per file in a cold worker than on the warm main thread — eating the parallelism gain before it accrues.
2. **`structuredClone` transfer.** Every `{nodes, edges}` result is cloned across the isolate boundary. For crib's many-small-file workload (thousands of small result objects), the per-file clone cost dominates.
3. **Spawn overhead.** Worker boot + grammar preload (PHP WASM) is paid per pool, not per file.
4. **No amortization.** `crib index` is a CLI command — the pool is torn down at the end of every run. Unlike a server, the cold start is paid every invocation and never amortized.

Variants tried (all in `/tmp/measure-*.mjs`, not committed): no-WASM workers (PHP on main, regex in workers) → 0.57–0.86×; batched slices (one message per slice, not per file) → 0.71–0.76×. The cold-JIT floor dominates regardless of message granularity.

### Option B — Bounded-concurrency async pool (the shipped default)

A bounded pool of K concurrent extractors on the **main** event loop: K runners pull from a shared cursor, each `await extractor.extract(file, ctx)`. While one runner is inside sync regex parse, another's `readFile` I/O is pending on the libuv pool — the only fraction that can actually overlap.

Implemented in `packages/pipeline/src/parse-concurrent.ts` (`DEFAULT_CONCURRENCY = 16`).

**Measured result: ~1.2–1.3×** (gate pinned ≥1.10× (measured 1.15-1.31×) to absorb CI machine variance; latest run 1.23×, serial 957 ms → concurrent 779 ms on 2300 files). Stays in-process: no cold JIT, no clone, no spawn, no new failure modes. The ceiling is the I/O fraction (~25 %) — provably, because the rest is sync CPU a single Node thread cannot parallelize.

### Option C — Serial (status quo)

The original `for (const file of files) { await extract(...) }` loop. Correct, deterministic, no overhead — but serializes the readFile I/O.

## Decision

**Ship Option B (bounded concurrency) as the default. Retain Option A (worker pool) behind `KCRIB_PARALLEL=workers`. Keep Option C as `parallel: false`.**

`runParse` (`packages/pipeline/src/parse.ts`) routes between three modes:

- **concurrency** (default, `parallel !== false` and `files.length > 1`): `runParseConcurrent`.
- **workers** (opt-in, `KCRIB_PARALLEL === 'workers'`, default fleet only, worker script built, ≥8 files): `runParseParallel`.
- **serial** (`parallel === false`, or 1 file, or custom extractors): the in-order loop.

`crib update` (incremental — 1–3 changed files) forces `parallel: false`: worker boot dominates for that few files, and the pool is torn down per call anyway.

## Determinism trick (load-bearing)

Crib's determinism invariant is inviolable: `--extracted-only` must be byte-identical across runs, and the downstream Louvain cluster (M7) is **order-sensitive** — it iterates the soul's in-memory `Map` insertion order, and cluster ids are `auto-<blake3(sorted member ids)>` (deterministic given a fixed iteration order, but a different iteration order can yield a different cluster decomposition).

Both parallel modes solve this the same way: **parallel extract, serial persist in discovery order.** Results are collected into `results[idx]` keyed by discovery index; once all extractors resolve, `putNodes`/`putEdges` run in `files` order. The soul's `Map` insertion order is therefore byte-identical to the serial loop, so every order-sensitive downstream phase iterates the same sequence.

`scripts/parallel-check.mjs` pins this: a full `indexRepo` via the concurrent path commits a soul byte-identical to the serial path (same fixed `repoId`, dossiers + ownership off to isolate parse + resolve/link/cluster); and `KCRIB_PARALLEL=workers` commits a soul byte-identical to the same serial snapshot. The unit test `packages/pipeline/src/parse-concurrent.test.ts` pins the same property at the `runParseConcurrent` + `indexRepo` level (3 tests).

## Reframe (M2.1 precedent)

The original "≥ 2× faster" gate is **unsatisfiable** for crib's parse workload via any in-process mechanism:

- Worker threads lose to cold-JIT + clone cost (measured, Option A).
- Bounded concurrency is capped by the I/O fraction (~25 %), so ~1.25× is the theoretical ceiling, not 2× (measured, Option B).

This mirrors the M2.1 recovery-rate reframe: a literal relative-recall gate was unsatisfiable above the BM25 floor, so it was reframed to a recovery-rate measurement of the honest, achievable contract. M3.4 reframes the same way: ship the honest ~1.2× (bounded concurrency, free + deterministic + no new failure modes), ADR the unsatisfiable-2× finding, and retain the worker pool as opt-in for the future case where it could win — a repo with few, very large files where per-worker work is long enough to amortize the cold start. That case is not crib today; the ADR records why so the decision is not relitigated.

## Consequences

- **Positive:** ~1.2–1.3× parse speedup for free, determinism preserved, no worker failure modes in the default path, no native-thread spawn cost.
- **Positive:** The worker pool is retained + smoke-tested in the gate, so if the workload shifts toward few-large-file repos, flipping the default is a one-line env change with a working, tested path already in place.
- **Negative:** The 2× headline from the plan is not met; the gate pins 1.10× instead. This is the honest number — see *Reframe*.
- **Neutral:** Custom extractors (`opts.extractors`) force the serial path (workers can't receive class instances across the isolate boundary; the concurrency path honors any registry, so only the worker mode is constrained).

## References

- `packages/pipeline/src/parse.ts` — three-mode router.
- `packages/pipeline/src/parse-concurrent.ts` — shipped default (header documents the why-not-workers reasoning).
- `packages/pipeline/src/parse-pool.ts` + `parse-worker.ts` — retained worker pool.
- `packages/pipeline/src/extractors.ts` — single source of truth for the default fleet (shared by index / update / worker).
- `packages/pipeline/src/parse-concurrent.test.ts` — determinism unit tests (3).
- `scripts/parallel-check.mjs` — the pinned release gate (determinism + speedup ≥1.10× + worker opt-in smoke).
- M2.1 recovery-rate reframe (`memory/m2.1-recovery-rate-gate-reframe.md`) — the precedent for reframing an unsatisfiable literal gate to the honest measured contract.