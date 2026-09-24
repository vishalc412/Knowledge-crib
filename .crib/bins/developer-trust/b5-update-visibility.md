# B5 — the watch-update visibility instrument

**Register row:** `docs/program/evidence-register.md:2123` (`B5`). **Status: open on one
principal decision, not on a missing instrument.** The instrument now exists, runs
reproducibly, and has a working negative control. What is left is *which bound is the gate*.

This is the single most misreadable item in the program. The register row was **updated
2026-09-24** and now reads that two of the three original facts against B5 are **fixed**; the
third is not a formality any more — it **is** the verdict.

## The instrument

| | |
|---|---|
| Command | `npm run visibility:check` (`package.json:22` → `node scripts/update-visibility.mjs`) |
| File | `scripts/update-visibility.mjs` |
| What it drives | `watch.ts`'s watch-update path against a generated fixture tree, polling for the visibility update to land |
| Method as `docs/bench/perf-gates.md:43-44` states it | p95 over ≥ 50 warm iterations after ≥ 5 warmup iterations, single machine, background load noted in the run report |

### Constants (all verified against the live file, codeHead `060898de`)

| Line | Constant | Value | Note |
|---|---|---|---|
| `:67` | `PINNED_DATE` | `'2026-01-01T00:00:00.000Z'` | git dates are pinned so the fixture is byte-stable; applied at `:132` (git author/committer dates), `:205`, `:213` |
| `:69` | `FIXTURE_FILES` | `300` | the named workload |
| `:70` | (comment) | cites `perf-gates.md:43` | the method line above |
| `:71` | `WARMUP_ITERATIONS` | `5` | |
| `:72` | `MEASURED_ITERATIONS` | `process.env.UV_ITERATIONS ?? '50'` | **the `n` column below is this** |
| `:73` | `POLL_INTERVAL_MS` | `10` | used at `:258` |
| `:81` | `PLAN_THRESHOLD_MS` | `2000` | the plan's bound (`developer-trust-plan.md:127`) |
| `:82` | `PERF_GATES_THRESHOLD_MS` | `5000` | the perf-gates bound (`perf-gates.md:33`) |
| `:269` | `CONTROL_WAIT_MS` | `10_000` | **only inside the `--negative-control` branch** |

`:267` states the control wait is "~14x the observed p95 from the measured run", and `:275`
prints that same claim. Both derive from the runs below, so the control's margin is a function
of the measurements, not an independent number.

The two verdict expressions are at `:309` and `:311`; the workload source is printed at `:315`,
the iteration line at `:319`, observed/timeouts at `:320`. The tool prints its own citations:
`:326` prints `(developer-trust-plan.md:127)` and `:327` prints `(perf-gates.md:33,
watch.ts:71-73)`.

### The second `2000` — do not conflate them

`scripts/update-visibility.mjs:81` (`PLAN_THRESHOLD_MS`) and `:82` (`PERF_GATES_THRESHOLD_MS`)
are the two **candidate** bounds, and the instrument itself declines to pick between them: it
"prints the verdict against both and asserts against neither unless told to"
(`scripts/update-visibility.mjs:44-45`), the default is `--assert=none` (`:84`), and a mode that
does not name a bound cannot fail: `gate` falls through to `'PASS'` (`:351-360`) and the process
returns 0 (`:365`). So `:81` is **not** the
gate — *which* bound is the gate is the open decision this bin names below
(`docs/program/evidence-register.md:2123`: "the instrument asserts against neither until it is
made").

A *different* `2000` lives at `docs/program/tools/wp1-write-cost-probe.mjs:93`
(`UPDATE_VISIBILITY_BUDGET_MS`) and is consumed at `docs/program/tools/wp1-write-cost-probe.mjs:820`
and `:869`, which print it as a denominator ("% of the 2000 ms budget"). The register row
(`docs/program/evidence-register.md:2123`) cites `docs/program/tools/wp1-write-cost-probe.mjs:820`
as a denominator that "consumes the budget but never measures it" — accurate in substance. The
two constants are independent, and a change to one does not move the other.

## Measurements

All through the documented `npm run visibility:check`, which **exits 0** on these runs.

| Workload | n | observed | p50 | p95 | vs 5 s | vs 2 s |
|---|---|---|---|---|---|---|
| 300-file fixture, run 1 | 50 | 50/50 | 614.7 ms | 670.4 ms | PASS | PASS |
| 300-file fixture, run 2 | 50 | 50/50 | 655.4 ms | 749.6 ms | PASS | PASS |
| 300-file fixture, earlier run | 50 | — | **not captured** | 724.2 ms | PASS | PASS |
| 300-file fixture, earlier run | 50 | — | **not captured** | 662.1 ms | PASS | PASS |
| `--repo=` on a 786k-LOC copy | 5 | 5/5 | 2345.5 ms | 2405.9 ms | PASS | **FAIL** |
| `--repo=` on a 786k-LOC copy | 50 | 50/50 | 2490.7 ms | 2644.7 ms | PASS | **FAIL** |

**Four fixture runs**, p95 range **662.1–749.6 ms** — this is the range `perf-gates.md:14`
records. p50 was captured for only two of the four; the other two rows say so rather than
filling the cell (see `corrections-log.md` for why that distinction is written down).

**Negative control:** with the watcher never started, **0 of 1** updates landed within the 10 s
`CONTROL_WAIT_MS`. This is the evidence that the instrument measures the update landing rather
than merely elapsing — a positive result with no control would not distinguish "the update
appeared" from "the timer ran".

## The verdict

On the named 300-file workload, **both bounds agree and both pass**. On the `--repo=` 786k-LOC
workload, `n=50`, p95 **2644.7 ms**:

- **PASS at `PERF_GATES_THRESHOLD_MS` (5000 ms)** — `perf-gates.md:14` records PASS.
- **FAIL at `PLAN_THRESHOLD_MS` (2000 ms)** — the plan's own bound.

So the remaining **principal** blocker is **a threshold choice**; the register's status cell also
records one further item still owed, unchanged — the full regression-suite re-run with the change
in place (`docs/program/evidence-register.md:2123`). Stated as a decision:
*which of the two bounds is the gate for the watch-update path?* Choosing 5 s makes the
instrument green today; choosing 2 s makes it red today. Both are defensible; only one can be
the gate.

**Two things must not be done to this number:**

1. **Do not difference the old `1956.6 ms` against `2644.7 ms`.** The register states the reason
   in its own words: that figure's workload is **unattributable** — it is recorded only as "the
   verifier's own run" — "so `2405.9 − 1956.6 = 449 ms of barrier cost` is **not derivable**"
   (`docs/program/evidence-register.md:828-830`). The two numbers were taken on different, one of
   them unnamed, workloads.
2. **Do not read "PASS" as settled.** The PASS is at one bound; the same run FAILs at the other.
   A one-word status hides exactly the disagreement that is the blocker.

## Deliberately not done

- **The check is not wired into CI.** It is a manual `npm run <script>`; nothing in
  `.github/workflows/ci.yml` invokes it. Whether it belongs in CI is downstream of the threshold
  decision — wiring a check whose verdict depends on an unmade decision would import an
  ambiguity into the gate.
- **The thresholds were not reconciled.** Changing `update-visibility.mjs:81` or `:82` to match
  the other would *decide* the question by edit rather than by decision. It was left open and
  named.

## What this does NOT claim

- **Not a claim about user-visible latency.** This measures the update path's visibility under
  a generated 300-file fixture and a specific 786k-LOC copy on one machine. It does not measure
  the product's responsiveness.
- **Not a scale curve.** Only two workload sizes were run on the repo copy (n=5 and n=50 on the
  *same* size, not two sizes). There is no fit and no extrapolation here.
- **Timings are single-shot per configuration.** Each row is one run of the tool at that `n`;
  the 300-file workload is the only one with repeats, and only four of them.
- **Background load is noted, but only as a report-level statement — no run's printed output
  establishes it.** `perf-gates.md:43` requires background load be noted, and the run reports do
  note it: `perf-gates.md:307` ("**Machine:** darwin 25.6.0, single machine, single session, no
  induced background load"), `:341` ("background load was neither induced nor controlled for"),
  and the register's §4.6 header (`docs/program/evidence-register.md:781`: "no induced background
  load"). What the *instrument's* own output does not carry is a load line:
  `scripts/update-visibility.mjs:39-40` states that none was induced and none was controlled for.
  The annotation is therefore an assertion by the report, not a per-run measured field.

## Caveat on the log this bin names

`/tmp/visibility-scale50.log` is outside
this repository and outside version control, so what is stated here about its contents and its
timestamps is not independently verifiable from the repository. Commit `678e08b8` moved the
perf-gates table row the register cites from `:32` to `:33`. (Verified by reading the commits, not
by inferring it: `git show 678e08b8^:docs/bench/perf-gates.md` has the watch row at line 32 and
`git show 678e08b8:docs/bench/perf-gates.md` has it at line 33, and `scripts/update-visibility.mjs`
was introduced in that commit printing `perf-gates.md:32`. `cdc04bfc` later corrected that printed
citation to `:33` — `git show cdc04bfc^:docs/bench/perf-gates.md` and
`git show cdc04bfc:docs/bench/perf-gates.md` both have the watch row at line 33, so that commit
corrected citations the move had invalidated; it did not move the row.) The live row is `:33` (the
"Where measured" row naming `npm run visibility:check`); the live results row is `:14`. The log was
not rewritten, and the citation in it should be read at its own revision.

An earlier revision of this section also named `tasks/bufdxr4m0.output`. That path resolves nowhere
— it is not in this repository and does not exist on the machine this bin was written on — and no
file in this repository cites it, so nothing about it can be checked and nothing about it is
claimed here.

Related: `perf-gates.md:79` (warm local recall) and `:80` (watch-update) both carry **BLOCKED**
in their original form; `:243` restates it ("Watch-update → queryable (< 5 s p95): unmeasured, no
E2E fixture wired"), and the narrative section opened at `:300` carries it: `:302` the
"stood as *not measured / BLOCKED (no E2E watch fixture wired)*" line, `:304` naming
`scripts/update-visibility.mjs` as the fixture, `:310` the results table's header, `:327` "Two
thresholds for one quantity therefore produce opposite verdicts", and `:328` "that is a decision,
not a measurement". The narrative's own account of the threshold split is what `:14` and the
register row now supersede.
