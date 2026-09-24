# Pending captures — 19 untrusted leads, deliberately NOT in the ledger

This file lists the **capture outbox**: observations written during the developer-trust program
that have been captured but **not distilled**. They are not memory records, and they are not
recallable.

**Treat every line here as a lead, not a fact.** A capture carries no trust tier, no admissible
evidence verdict and no freshness. `memory_recall` excludes them by design — a claim captured but
not yet distilled is *absent* from recall, which is a decision about trust, not an omission.

| | |
|---|---|
| Count | **19** (17 with at least one evidence item, **2 with none**) |
| Reconciles with | `memory op=status` → `pending: 19` |
| Location | `~/.crib/memory/repos/31fec5e7-*/outbox/*.jsonl` (32 shard files, **33 objects** — `32.jsonl` holds two lines; 33 = 19 pending + 14 done) |
| Read it whole | `jq -c 'select(.status=="pending")' ~/.crib/memory/repos/31fec5e7-*/outbox/*.jsonl` |
| Verified count | `jq -c 'select(.status=="pending")' … | wc -l` → 19 |

**A `grep -l '"status":"pending"'` undercounts this as 18** — the two-object `32.jsonl` is one
file. Use `jq`, not `grep`, for the count.

## Why they are not in the ledger

Nothing was declined. Each is **pending distillation**: the capture path stores an observation and
the admission gate admits it only once the claim can be grounded in admissible evidence. A
capture observed against code the index has not seen cannot be admitted, and several of the
entries below are blocked for exactly that reason.

## How to drain them

```
node packages/cli/dist/cli.js memory distill --provider <name> [--max-batches N] [--concurrency N] [--timeout-ms N]
```

Anchors, all in `packages/cli/src/cli.ts`, measured at `3434c19f`: `case 'distill':` at `:6940`,
dispatching to `cmdMemoryDistill` at `:6941`; the usage string at `:7060` — `usage: crib memory
distill --provider <name> [--providers-file <path>] [--max-batches N] [--concurrency N]
[--timeout-ms N]`; the section banner at `:7010`; the comment above the dispatch at `:6939`
(`// G2.3 — the capture-outbox drain loop (provider proposes, crib disposes).`); `distillStatePath`
defined at `:7024`, used at `:7094`. Three siblings sit on the same dispatch: `case 'capture-hook':`
at `:6944`, `case 'recheck':` at `:6947` (re-run the admission gate over pending captures) and
`case 'dismiss':` at `:6949` (retire one queued capture or staged candidate).

**Note on the provider flag.** `distill` requires a provider; there is no local default. Without
one configured, the outbox drains nowhere and this count will not move.

## The two that cannot be admitted as they stand

Both carry **zero evidence items**. A claim with no admissible evidence stays a candidate, however
obviously true it looks from a shell. Neither is fixed here — recording them is the point.

| Capture | Kind | Subject |
|---|---|---|
| `cap:23cb26ad8570` | fact | `crib on PATH resolves to a sibling checkout, not this repo` |
| `cap:2ae42572f37f` | pitfall | `The credential gate reads tracked files only, and scans its own allowlist` |

Both are **corroborated by hand** elsewhere in this repository — the first in
[`../../bins/developer-trust/environment-findings.md`](../../bins/developer-trust/environment-findings.md)
(E1), the second in `.crib/bins/README.md`'s Tracking section and in
[`../../bins/developer-trust/environment-findings.md`](../../bins/developer-trust/environment-findings.md)
(E4). **That corroboration is not evidence.** A bin file is work-product knowledge with no trust
lifecycle; it cannot ground a ledger claim. To admit either, the evidence has to be re-observed
as something the gate accepts — a source-quote, an execution-assertion, or a receipt — after an
index refresh makes the anchor verifiable.

---

## The 19

Format: `capture id` — *kind* — evidence items — subject (verbatim).
Timestamps are the capture's own, in ISO-8601.

### Instruments, evals and measurement (8)

| Capture | Kind | Ev | Subject |
|---|---|---|---|
| `cap:568ac5bbd988` | pitfall | 3 | `code-vector-eval.mjs can print a lexical-vs-hybrid report with the hybrid arm silently absent, and exits 0` |
| `cap:ddc6a4f4f1d4` | pitfall | 2 | ``A locate-eval `vectorNote` describes the PROBE reader, not the scored arm — reading it as "this arm was lexical" invalidates a valid hybrid measurement`` |
| `cap:5b1ab29ded41` | pitfall | 2 | `A ranking that breaks score ties by Map insertion order over non-deterministic parallel tool output is not bit-stable — measure the noise bound before calling a small delta signal` |
| `cap:d9169226df0e` | pitfall | 2 | `Proving a batching change is semantically neutral requires an outside-the-store oracle, not a batched-vs-per-node byte comparison` |
| `cap:72ec4634a853` | pitfall | 2 | `scale-bench's embedder-footprint probe measures the idle regime, not the batch regime, so it cannot support clause 5b's RSS split` |
| `cap:8f81e1d56c0e` | pitfall | 1 | `A pre-registered decision rule must map every clause to its instrument before the run, or the rule can be unappliable while looking computable` |
| `cap:0b34d60a466c` | pitfall | 1 | `Vector embedding cache is keyed on the full embedded text, which includes node.file` |
| `cap:344f9bd71e41` | pitfall | 1 | `Discrimination runs against packages/cli are vacuous without a rebuild (stale dist/cli.js)` |

### Gates and CI (4)

| Capture | Kind | Ev | Subject |
|---|---|---|---|
| `cap:0e53017506b9` | procedure | 3 | `Release gates in this repo use a three-outcome model — PASS(0) / FAIL(1) / UNAVAILABLE(2) — and UNAVAILABLE fails by default` |
| `cap:722a5600d1be` | pitfall | 1 | `npm run verify: pnpm -r abort hides the three non-test gates` |
| `cap:b8c9612093ac` | pitfall | 2 | `Load-induced vitest timeouts under pnpm workspace concurrency` |
| `cap:d30264f84a61` | pitfall | 6 | `The Gate-0 vocabulary law cannot see the obfuscated banned words at memAxis in packages/ui/web/index.html` |

### The memory package's principal boundary (4)

| Capture | Kind | Ev | Subject |
|---|---|---|---|
| `cap:51d4c1dcf43a` | pitfall | 2 | `MemoryApi.acceptsRecord was a second principal boundary with no strict mode (WP1 item 15 / audit F03 remainder)` |
| `cap:03a22d5d7de9` | fact | 3 | `Two principal-boundary implementations in the memory package; only gatherRecall's honoured KCRIB_STRICT_PRINCIPAL (unified 2026-09-23)` |
| `cap:e9dbd7d18e68` | pitfall | 3 | `guard-at-gather-point-misread` |
| `cap:f4a8b77aec8b` | pitfall | 3 | `cli-help-dispatch-init-has-no-gate` |

### Durability (1)

| Capture | Kind | Ev | Subject |
|---|---|---|---|
| `cap:dbc42ac04510` | pitfall | 1 | ``The shared `<path>.tmp` temp name is only safe for single-writer paths`` |

### Environment (**0 evidence** — see above) (2)

| Capture | Kind | Ev | Subject |
|---|---|---|---|
| `cap:23cb26ad8570` | fact | **0** | `crib on PATH resolves to a sibling checkout, not this repo` |
| `cap:2ae42572f37f` | pitfall | **0** | `The credential gate reads tracked files only, and scans its own allowlist` |

---

## Four of these overlap something the repository already records

Named here so the distillation is not read as nineteen new findings where two would upsert an
existing memory record and two restate statements the register already carries.
**Re-observing the same claim upserts the same id**, so a duplicate is a no-op rather than a
conflict — but a reader comparing counts should know.

| Pending capture | Already recorded as |
|---|---|
| `cap:03a22d5d7de9` — two principal boundaries; only `gatherRecall` honoured `KCRIB_STRICT_PRINCIPAL` | `mem:bab1095d1a6bf60d4687c5e2afd432b219eb8a6016112c88bb923c9476b99290` (same subject, near-verbatim) |
| `cap:344f9bd71e41` — discrimination runs against `packages/cli` are vacuous without a rebuild | `mem:45591b62535fa429c9f9fb63b621d0a41f5aaa44ca5054566d564aee7c27e24e` |
| `cap:722a5600d1be` — `pnpm -r` abort hides the three non-test gates | the register's §4.3 body, `docs/program/evidence-register.md:604–606` (the sentence naming `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` and "the recursion aborts before any of the three runs"). **No B-row carries this** — **B11** at `:2129` is a different finding (the test-timeout/budget defect) |

`cap:d30264f84a61` (6 evidence items, the most of any pending capture) is the same finding as
register row `B14` (`:2132`) and is **blocked by the same anchor-rot** — see
[`../../bins/developer-trust/corrections-log.md`](../../bins/developer-trust/corrections-log.md), C3.

## What this file does NOT claim

- It does **not** assert any capture is true. Each is a lead with no trust tier.
- It does **not** assert the count is stable. The outbox drains; a `distill` run makes this file
  stale, and the `jq` command above is the authority, not this table.
- It does **not** claim the two zero-evidence entries are wrong. They are almost certainly right.
  They are inadmissible, which is a different thing, and the distinction is the whole point of the
  admission gate.
