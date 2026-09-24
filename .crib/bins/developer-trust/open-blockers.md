# Open blockers — the residue a principal has to decide or fund

**Read this file before picking the program up.** §9.3 of the register (`docs/program/evidence-register.md:2113`)
lists 17 named blockers (`B1`–`B17`, rows `:2119`–`:2135`). The roster below carries each row's
current status; what remains open is not more implementation work. It is a set of **decisions** that
no amount of coding can clear, plus a small number of things that are blocked on something outside this
repository.

**The tempting error this file exists to prevent:** reading a *decision* as a *completion*. Several blockers below are recorded as "**proposed and deliberately NOT applied**" — that is
a **complete** state for the program and an **open** state for the product.

---

## The roster at a glance

| Row | Register | Status | Shape |
|---|---|---|---|
| B1 | `:2119` | closed | — |
| B2 | `:2120` | closed | — |
| B3 | `:2121` | **OPEN** | principal decision ×2 |
| B4 | `:2122` | closed | — |
| B5 | `:2123` | **OPEN** | principal decision ×1 (threshold) |
| B6 | `:2124` | **OPEN** | structural; only H7 implementable |
| B7 | `:2125` | **narrowed, not closed** | E2E coverage gap |
| B8 | `:2126` | **externally blocked** | not actionable here |
| B9 | `:2127` | closed | — |
| B10 | `:2128` | **triaged 2026-09-23; not closed** | F1→WP3, F2→WP2; cause unfiled |
| B11 | `:2129` | **corrected; partially remediated 2026-09-23** | default test invocation |
| B12 | `:2130` | closed (both) | — |
| B13 | `:2131` | **OPEN** | principal decision ×1 |
| B14 | `:2132` | **proposed and deliberately NOT applied** (A+B recommended) | Gate-0 law surface |
| B15 | `:2133` | **R-D open; R-C partially cleared** | hypothesis + user-state residue |
| B16 | `:2134` | **OPEN** | two strings, plus a default-mode question |
| B17 | `:2135` | **OPEN** | instrument gap; route (B) cannot clear it |

---

## Decision-shaped — these need a principal, not a commit

### B3 — two WP1 items need a ruling (register `:2121`)

1. **Item 9:** capture bytes at publish, or detect-and-degrade at read? Both are implementable;
   they are not both correct, and the choice determines what an artifact's provenance means.
2. **Item 10 / spec D-3:** whether the **persistent FTS corpus**
   (`packages/memory/src/persistent-fts.ts:318-320`, `rebuildFromStores`) becomes principal-scoped.
   The register characterises the exposure precisely: it is *"a weak cross-principal channel, not a
   record disclosure"*. That framing is the decision's whole difficulty — it is not a leak, and it
   is not nothing.

### B5 — which bound is the gate (register `:2123`)

The instrument exists, runs reproducibly, and has a negative control. **What is left is one
choice: 2 s or 5 s.** At 5 s the watch-update path is green today; at 2 s it is red today. Full
detail, every measurement, and the two things you must not do to the number:
[`b5-update-visibility.md`](b5-update-visibility.md).

**Wiring the check into CI is downstream of this**, not parallel to it.

### B13 — an unattributable lock is terminal, not retryable (register `:2131`)

`packages/core/src/lock.ts:202` computes
`stale = Date.now() - st.mtimeMs > staleMs || (holder !== 0 && !pidAlive(holder))`, so when the
holder reads `0` the second clause is **deliberately** skipped (comment at `:199-201`: a
contender can observe the `O_EXCL` create before the holder writes its pid, and reclaiming then
would admit two writers into the critical section). But `acquire()` **throws** on `live`
(`:123`) instead of retrying — so a **young** unattributable lock is a **terminal** hard failure,
with a message telling the user to wait ten minutes. `readHolder()` returns `0` for
unreadable/non-integer content.

This is also the **single failure** holding the whole suite at exit 1 — `LockBusyError (pid 0)`
in `freshness-election.test.ts` (see [`gates-and-ci.md`](gates-and-ci.md)).

**The decision:** what should a young unattributable lock do — retry with a bounded backoff, or
stay terminal? The current behaviour is deliberate and the reasoning behind it is sound; the
question is whether the *cost* of terminal-failure-by-default is acceptable.

### B14 — the Gate-0 vocabulary law cannot see an obfuscated word (register `:2132`)

`packages/ui/web/index.html:1855`/`:1856` write the law's two banned words as
`String.fromCharCode(99,97,110,100,105,100,97,116,101)` and `(116,114,117,115,116)` — decoding to
`candidate` and `trust` — and return the compliant `'staged'` / `'standing'`. They are the only
two `fromCharCode` uses in the served asset set. `memAxis` (`:1854`) is the **sole** point where
backed enum values become user-facing vocabulary, with a `return raw` fallthrough.

The rendered text is compliant; the construction is un-auditable by inspection. A
literal-matching law **structurally cannot see a word that is never written as one**.

**Three options, and the recommended pair was deliberately not applied.** Options A, B and C were
evaluated with **A + B recommended**, and none applied — because **both change a Gate-0 law
surface**, and changing the law to catch an evasion is a different kind of act from fixing a bug.
The obfuscation and its explanatory comment (`:1850-1853`) were deliberately left in the asset.

> The register row and `docs/program/wp5-implementation-spec.md:88` cite these at `:1804`/`:1805-1806`,
> which do not resolve. The live anchors are `:1854`/`:1855`/`:1856`. See
> [`corrections-log.md`](corrections-log.md), C3.

### B16 — the repair line names a command that provably does not clear the fault (register `:2134`)

The served line (`packages/cli/src/viz-server.ts:343`) says *"run `crib update` to catch it up"*; the
freshness-status line — `packages/cli/src/cli.ts:3939` at `8563f56e`, `:3933` at `3434c19f`, `:3929` at
`060898de` (the number the register's own citation uses) — offers `crib update` as an alternative to `crib freshness worker`.

**Measured in one run, not reasoned:** after `crib update .` changed **19 files** under `.crib/`,
`codeIndex.behindHead` was **still true** and the recovery line was **still served**. Only
`freshness hook` plus a worker publish cleared it. **Mechanism pinned to source:** `behindHead`
compares against `lastKnownGood`, and `publishGeneration` has exactly **one** production call site
(`packages/cli/src/freshness.ts:943`, the worker's task loop) — so `crib update` refreshes the graph
but cannot move the published generation, by design. The user follows the instruction and the banner
never clears.

Severity **medium**. **The minimal fix is two strings** — but there is a second consequence worth
a decision: in the default **`manual`** mode, **nothing ever publishes**, so the stale-index state
is **unreachable by construction, not merely rare**, and a user who commits without re-indexing
gets **no stale-index signal at all**.

### B17 / P-8 — clause 3 has no instrument, and one route cannot clear it (register `:2135`)

WP4's deciding rule (§10.5 clause 3, `exact R@1(C_x) ≥ exact R@1(C0)`) is an **outright
disqualifier**, and its named quantity is owned by `scripts/bench/code-retrieval-eval.mjs`, which
constructs `new SqliteIndexStore(DB)` with **no embedder** (`:208`). `caps.vector` is therefore
never `true`, `hybridMeasurable` (`:214`) is false always, and the harness computes its own
clause-3 field — `exactGuard` — as **`null` by construction** (`:552`). `exact R@1(C1)` is not
merely unreported — it is **not representable in the instrument the frozen clause names**.

**Route (B) does not clear clause 3. Only route (A) does.** This is the single most important
sentence in this file for anyone planning a follow-up: an obvious-looking repair path is
insufficient by construction.

Found by auditing the rule clause-by-clause **against the instruments, before the run** — which
is why the run could not have promoted the candidate even if it had been clean.

> Register cites `:212` for `hybridMeasurable`; live is `:214`. Its `:208` (the no-embedder
> `new SqliteIndexStore(DB)`) and its `:552` (the clause-3 `exactGuard` expression) both resolve as
> written, and the row names no directory for the file. See [`corrections-log.md`](corrections-log.md),
> C4.

---

## Implementation-shaped, or environment-shaped

### B6 — WP3-H7 unstarted; H4's residue is blocked *structurally* (register `:2124`)

**WP3-H7 is the only part implementable as written** (`packages/cli/src/cli.ts`,
`packages/mcp/src/verbs.ts`), and its characterization net still exits 1 because of B11/B13.

H4's **remaining substance cannot follow** the already-landed slice: the **1,642-line
`<script type="text/x-dc">` payload** (`packages/ui/web/index.html:726`–`:2369`; 1,642 content
lines between the two tag lines, re-measured 2026-09-24 — register row B6 (`:2124`) still carries
1,527 for this payload) **is read out of the served document** by `support.js` via
`doc.querySelector("script[data-dc-script]")` (`packages/ui/web/support.js:27`), so a `<script src>`
extraction is **structurally impossible**, and `support.js` is generated from an absent
`dc-runtime/`. This is not an effort problem. The memory-panel helpers are held by **B14**, not
here.

### B7 — the E2E round is thin, and the partial is measured (register `:2125`)

**Cleared by the second round:** a multi-package monorepo with a real cross-package import, and
deliberately induced failure paths — the two things the blocker named first.

**Still not cleared:** `--vectors` was still off; the **MCP verbs were still not driven**; no
crash or torn-write path; the **doctor's durability claim is still not independently verified**;
timings are still single-shot on a box at load 6.

**The blocker narrows rather than closes** — and one of the four states it was meant to reach
turned out to be **unreachable by construction**, which is itself a result.

### B10 — two product defects found by the E2E round are triaged; the cause is unfiled (register `:2128`)

**Triaged 2026-09-23 (register `:2128`):** F1 → **WP3**, F2 → **WP2** (its command half → WP3, its
precision cost → WP4). The register's title still reads "sit in no work package"; the triage's
outcome is that the *symptoms* are filed and the **cause is not** — no work package states the rule
that what `crib init` writes into a user's repo must not become evidence in that repo's index — so
what still clears this row is a **principal decision on that rule**.

- **F1: `crib init --help` performs init.** Re-measured: exit 0, no usage text, **12 new
  top-level entries written** (including `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.cursor/`,
  `.claude/`) into a repo holding only `.git` and one source file. Re-verified independently in a
  fresh sandbox: `crib init --help` printed the onboarding banner and then executed `step 1/5` …
  `step 5/5`. **The help flag is not merely undocumented — it is the full command with a banner
  in front of it.**
- **F2: init is not idempotent in the index**, and makes its own adapter prose queryable graph
  docs (13/109/140 → 21/165/188). The triage **corrected the recorded shape**: the
  non-idempotence is a consequence, not the defect.

### B11 — the default test invocation is not a trustworthy gate (register `:2129`, corrected)

`pnpm -r run test` exits 1 on this tree with **10 × `Test timed out in 5000ms` and zero assertion
failures**, plus a vitest worker `onTaskUpdate` IPC timeout in `mcp` — which reports
`Tests 490 passed (490)` and exits 1 anyway. **That first sentence is the register's original,
pre-fix measurement**; the row's remediation column carries the measured outcome of the fix. Cause,
**measured rather than assumed**: pnpm's default **4-way workspace concurrency** starves the
index-heavy tests. Run serially, `memory` (1,159/1,159) and `mcp` (490/490) clear outright — `:2129`'s pre-fix half, superseded for `mcp` by the row's own correction. The
concurrency half is now pinned in the tree — `.npmrc` carries `workspace-concurrency=1` — and the
register records that pin's measured outcome.

`packages/cli/vitest.config.ts` carries the budget remedy (`testTimeout`/`hookTimeout` 30 s, and
they must sit under the `test:` key or Vite swallows them). Note the correction on this row:
**the status was revised**, not merely reaffirmed.

### B12 — two residual failures, both resolved (register `:2130`)

**(a) `cli`'s p95 red-line assertion** — **downgraded, and the original framing was mistaken.**
It was first written up as "a principal must decide whether to re-calibrate the red line, and
must not loosen it to go green". That framing was **wrong**: the gate is **sound** — it passes at
`workspace-concurrency=1` — and the cross-package-starvation hypothesis for it is **refuted by
the timestamps**. The gate is wall-clock and therefore *environment*-sensitive: **a property
worth knowing, not a defect, and emphatically not a reason to raise the bound.**

**(b)** the second residual failure is likewise resolved.

### B15 — the registry: one open hypothesis, one deliberately untouched 3.28 MB (register `:2133`)

- **R-D (OPEN):** the global registry's read-modify-write is guarded only by the **per-project**
  `.crib` lock, so two different repos registering concurrently can lose one update. This is
  **reasoned from the code shape and explicitly NOT observed** — a hypothesis with a mechanism,
  not a measured bug. Treat it as such in both directions.
- **R-C (partially cleared):** the growth source is fixed and proven non-vacuous
  (`scripts/release-cli-smoke.mjs` no longer writes user state; the register records the real
  registry reading **10,491** before and **10,491** after a smoke run). But the dead entries
  already accumulated in the real `~/.crib/registry.json` — **10,465 dead of 10,491** in a 3.28 MB
  file rewritten in full on every `crib index`, as the register records it — were deliberately
  **NOT touched**: that file is **user state, not repo state**, and pruning it is a product
  decision, not a cleanup. **Those counts are a dated snapshot of a live user-state file, not a
  property of the tree:** re-measured 2026-09-24 it holds 11,007 entries, 10,976 of them under
  `/var/folders` or `/tmp` (3.29 MiB).

---

## Externally blocked

### B8 / WP6 — real native certification hosts (register `:2126`)

**Not actionable by this program.** WP6 needs hosts this environment does not have.

### WP3-H7 — blocked on B11/B13 (register `:2124`)

Unstarted. Its characterization net exits 1 for reasons owned by B11 and B13.

---

## The program's own options (§9.5, register `:2240`)

- **A — continue in delivery order.** **Recommended.** The order is now
  **B5 → B13 → B14 → B3 → WP3-H7**.
- **B — freeze as an honest partial.** Legitimate; the register and this bin exist precisely to
  make that a defensible choice rather than a silent one.
- **C — cheap high-value first.** Take the small, decidable wins out of order.

**Not recommended: declaring done.** Nothing in the register, and nothing in this bin, supports
it — WP3-H7 is unstarted, WP6 is blocked, and at least five items above are decisions rather
than work.

---

## Also open, tracked outside the B-rows

| Item | Where |
|---|---|
| Wiring `visibility:check` into CI | downstream of B5's threshold decision |
| The clause-5b embedder-footprint probe repair | the probe measures the **idle** regime, not the batch regime (`scripts/scale-bench.mjs:242`, the `measureEmbedderFootprint` function), so it cannot support clause 5b's RSS split. Full detail: `docs/program/wp4-implementation-spec.md:969` (the idle-vs-batch premise, left open as a named instrument gap). |
| **P-6** — embedder per-load integrity hash | register §5.4 (`docs/program/evidence-register.md:1166`); filed in `docs/program/wp4-implementation-spec.md:1123` (§15) |
| **P-7** — how a rename corpus is powered at all | register §5.5 (`docs/program/evidence-register.md:1205`); filed in `docs/program/wp4-implementation-spec.md:1141` (§15) |
| The dead `on.push` trigger (`.github/workflows/ci.yml:5`) | reported, not fixed — see [`gates-and-ci.md`](gates-and-ci.md) |
| The `verify-matrix` `needs: release-gate` skip (`.github/workflows/ci.yml:108`) | reported, not fixed |
| The broken global `crib` shim | reported, not fixed — see [`environment-findings.md`](environment-findings.md) |

## What this file does NOT claim

- It does **not** rank these by importance, and the roster order is the register's, not a
  priority order. §9.5's recommended order (**B5 → B13 → B14 → B3 → WP3-H7**) is the only
  ordering claim made here, and it is the register's.
- It does **not** restate any row's verdicts as settled where the register qualifies them.
  **R-D is a hypothesis**, B7 "narrows rather than closes", and B14 is *proposed and deliberately
  NOT applied* — those qualifications are load-bearing and are repeated verbatim above.
- It does **not** claim the closed rows are closed *because of this program*. B1, B2, B4, B9 and
  B12 are closed; the register says how.
