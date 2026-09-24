# Gates and CI — what ran, what came out, and what was never exercised

## The gate chain

`package.json:17` defines `verify`:

```
corepack pnpm@9.15.0 -r run build
&& corepack pnpm@9.15.0 -r run test
&& biome check .
&& node scripts/boundaries-check.mjs
&& node scripts/credential-check.mjs
&& node scripts/license-check.mjs
```

Six stages, `&&`-chained: **build → test → biome → boundaries → credential → license**. The
three `node scripts/*.mjs` gates at the end are not test suites, and they only run if the build,
the tests and biome all pass.

**Consequence, and it bit:** `pnpm -r run test` aborts the chain on the first package that fails,
so when a test suite is red the three non-test gates are **never reached**. A run's tail is not
evidence about them. This is why "the suite is red" and "the gates are red" are separate
statements.

## Three runs, four red items

| Run | Red on | Ours? |
|---|---|---|
| 1 | `boundaries-check` **R6** — 11 `biome-ignore` / 8 `as any` in `packages/core` vs baseline 9 / 6 | **Yes** — fixed; baseline not raised |
| 2 | `cli` — `freshness-election.test.ts` (`LockBusyError (pid 0)`) **and** `freshness.test.ts:385` (`expected 60 to be less than 50`, heartbeat age) | No — B13, and a wall-clock-sensitive bound |
| 3 | `mcp` — `[vitest-worker]: Timeout calling "onTaskUpdate"`, reported beside `490 passed (490)` and exit 1 | No — B11's fourth class, mitigated not eliminated |

The attribution is the register's, not this file's: §4.2 (`docs/program/evidence-register.md:562`,
table `:567-572`), which also names the three logs. The items are all *different* — register
`:564-565` — and only run 1's is this work's. The register calls them **three** red items there and
"the same **four** items" at `:636`, because run 2 carries two failures; the table keeps them separate.

**R6 was the only red this work owned, and it is fixed.** The fix did **not** move
`scripts/boundaries-baseline.json` — it removed the offending markers instead, so the baseline
still describes the tree it was written for. `packages/core` is back to **exactly 9 + 6 = 15**.
That distinction matters: moving a boundaries baseline to accommodate a change is exactly the
move that makes a boundaries gate stop meaning anything.

**Removing a marker is not removing the coupling.** R6's fix took out the *markers*; the
underlying dependency the marker was recording was not restructured. A future reader who sees
the marker gone should not conclude the coupling is gone.

The other three red items **predate this work** and are not addressed here.

## The hosted `rerank:check` red

A hosted red on `rerank:check` was investigated and has **four independent lines of evidence
that it predates the PR** (`docs/program/evidence-register.md:649-660`): a fresh `git worktree` at
`Master` reproduces it to the digit; the same assertions fail on a dependabot branch dated
2026-09-21, two days before this branch existed; this branch changes no rerank line at all; and it
reproduces locally with the same four numbers, so it is environment-independent and deterministic.
It is a pre-existing hosted failure, reported rather than fixed — fixing it was outside the
program's scope and would have muddied a change set whose whole point is trustworthiness.

## The CI wiring, and its two defects

**1. The verify matrix is switched off by a `needs:` (`ci.yml:104-108`).** `verify-matrix:` at
`:104` (name `verify (${{ matrix.os }}, Node ${{ matrix.node }})`, `:105`; `runs-on:` `:106`)
declares `needs: release-gate` at `:108`. There is **no `if: always()` on `verify-matrix`** — the
workflow does contain `if: always()` at `:88` and `:156`, but both belong to *Upload failure
diagnostics* steps and neither touches the job-level gate. So when the release gate is red the matrix
does not run at all. A red gate therefore *silently disables* the
coverage beneath it: the matrix's absence looks like *not needed* rather than *skipped because
something above it failed". The matrix's own diagnostics artifact is at `:159`
(`knowledge-crib-ci-diagnostics-${{ matrix.os }}-node${{ matrix.node }}`); the release gate's is a
separate one at `:91`.

**2. The `on.push` trigger is dead (`ci.yml:4-8`).** `:4` `pull_request:`, `:5` `push:`, `:6`
`branches:`, `:7` `- main`, `:8` `- master`. The measurement: every `CI` run in the workflow's
history is `pull_request` or `workflow_dispatch`, and **zero** are `push` (register §4.4,
`docs/program/evidence-register.md:667-668`; re-derived with `gh api …/actions/workflows/ci.yml/runs`
on 2026-09-24, still zero). No run *count* is quoted here: `CI`'s run total is live and still
growing, so a count would be stale on arrival. The mechanism is consistent with the
workflow files but is **not proven here**: the `push` filters are lowercase `main`/`master` while this
repository's default branch is **`Master`**, and GitHub branch filters are case-sensitive. The register
records the case mismatch as the leading explanation and not a settled fact — "a one-line edit plus a
test push would settle it" (`:672-677`).

**`Crib Soul Refresh` has never run.** No run record exists for it under any trigger.

**Consequence for reading CI here:** the green check on a PR describes `pull_request` only. It is
not evidence that anything ran on a push to the default branch, because nothing ever has.

## The final suite re-baseline (§9.4, register `:2163-2173`)

| Package | Tests | Δ | Exit |
|---|---|---|---|
| soul-schema | 18 | — | 0 |
| core | 432 | +15 | 0 |
| memory | 1,171 | +62 | 0 |
| parsers | 506 | — | 0 |
| ui | 42 | +17 | 0 |
| mcp | 490 | +22 | **0** |
| pipeline | 286 | — | 0 |
| cli | 662 | +31 | **1** |
| **total** | **3,607** | **+147** | **1** |

**3,606 of 3,607 pass; 7 of 8 packages green.** The overall exit of 1 rests on **a single
failure**: B13's `LockBusyError (pid 0)` in `freshness-election.test.ts` — a test that deliberately
SIGKILLs every worker mid-refresh and so *engineers* the unattributable-lock window B13 describes.
That single failure is the entire difference between 7/8 green and 8/8, and it is **not a flake**: the
register lifts it out of "flake" and into **B13**, a genuine defect in the derived-index lock, on the
ground that it reproduced at both concurrency 4 and 1 in two *different* test files
(`docs/program/evidence-register.md:2222-2223`).

**Caveat (recorded in register §9.4, `docs/program/evidence-register.md:2237`, which itself credits the
log's §10.4, `docs/program/logs/test-suite-2026-09-23.log:374` — not invented here):** with concurrency
pinned to 1, the `memory` and `mcp` test-budget raises are **not shown necessary**. The change set is
*sufficient* but not shown *minimal* — a reader who wants the budget raises justified needs a run at
concurrency 1 to demonstrate the dependency.

## What this does NOT claim

- **No green verify.** The chain has not gone green end to end; the reds are named above with
  their owners, and three of the four predate this work.
- **No claim that a chained run reached the three trailing gates.** Because `pnpm -r` aborts, a suite-red run
  never reaches `boundaries-check`, `credential-check` or `license-check`. Those three were run
  separately on the staged set, where the register records all three **PASS** —
  `boundaries-check` with `packages/core` still at exactly its frozen `9 + 6`,
  `credential-check` at 11 findings, 11 allowlisted, `license-check` at 164 / 164 permissive
  (`docs/program/evidence-register.md:631-635`) — but no single `npm run verify` invocation has
  exercised the full chain.
- **No claim the matrix is covered.** It is skipped whenever the release gate is red — which is
  precisely when coverage is most wanted.
- **No claim about the default branch.** `push` has never fired.
