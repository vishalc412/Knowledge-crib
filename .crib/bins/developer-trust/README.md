# `developer-trust/` — the developer-trust program (WP0–WP6)

This bin is the work-product dossier for the **developer-trust program**: a multi-work-package
effort to make this repository's own gates, durability claims and retrieval measurements
trustworthy. It records what was **measured**, what was **corrected**, what was deliberately
**refused**, and what is still **open**.

It is a bin, not memory. It has **no trust lifecycle**, and a claim in here must never be cited
where a trusted memory record is required. Where a statement is a *claim* rather than a
work-product observation, it lives in the ledger and this bin **points at** it — it never
adjudicates or restates a record's verdicts (see `.crib/bins/README.md`, "Why bins exist").

## Files

| File | What it holds |
|---|---|
| [`index.json`](index.json) | Machine-readable manifest of this bin (every file, one-line purpose) |
| [`b5-update-visibility.md`](b5-update-visibility.md) | The watch-update visibility instrument: its constants, every measurement, the negative control, and the 2 s-vs-5 s threshold disagreement that **is** the verdict |
| [`gates-and-ci.md`](gates-and-ci.md) | The `npm run verify` chain, the three runs and four red items, the hosted `rerank:check` red, the `verify-matrix` skip, the dead `on.push`, and the final suite re-baseline |
| [`corrections-log.md`](corrections-log.md) | Errors this program got wrong and caught — including the procedure that caught each, and live anchor-rot evidence |
| [`environment-findings.md`](environment-findings.md) | Machine and tooling state: the broken global `crib` shim, the local store layout, why a bin is a convention rather than a crib primitive |
| [`open-blockers.md`](open-blockers.md) | The full open residue, split into decision-shaped / implementation-shaped / externally blocked |

## The one-line state of the program

**Landing:** WP0, WP1 (13 of 15 items), WP2, WP3 (register row `WP3`,
`docs/program/evidence-register.md:2026`: **5 of 7 bullets complete; H4 partially landed** with
residue **B14**; H7 not started), WP5, and WP4 — where WP4 is **implemented and DECIDED, and the
candidate is not promoted**.

**Not landing:** WP3-H7 (unstarted, blocked), WP3-H4's remaining memory-panel helpers (held by
**B14**, register `:2132`; register row **B6** at `:2124` is the structural reason), WP6
(externally blocked, register row **B8** at `:2126`), and a set of principal-gated decisions that
no amount of implementation work can clear.

**Read [`open-blockers.md`](open-blockers.md) first** if you are picking this up. The
tempting error it exists to prevent is reading a *decision* as a *completion*.

## Where the authoritative text lives

This bin is a dossier, not the register. The authoritative, continuously-updated record is
[`docs/program/evidence-register.md`](../../../docs/program/evidence-register.md) — §9.3 (named
blockers, lines 2113–2136), §9.4 (test-suite re-baseline, from line 2137) and §9.5 (options,
from line 2240).

## What this bin does NOT claim

- It does **not** claim any gate is green. `npm run verify` has not gone green, and the reds are
  named with their owners.
- It does **not** claim the program is complete. WP3-H7 is unstarted and WP6 is externally
  blocked (register row **B8**, `docs/program/evidence-register.md:2126`).
- It does **not** convert a measurement into a verdict about product quality. Where a number does
  not decide a question, the file says so — that is rule 4 of the bin convention.
- It does **not** restate memory verdicts. Where it points at a ledger record, the record's own
  derived verdicts govern, and this bin has no authority over them.
