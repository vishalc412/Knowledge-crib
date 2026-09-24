# Corrections log

Errors this program made, **the procedure that caught each** where a procedure did, and the
anchor-rot evidence that motivated rule 3 of the bin convention (`.crib/bins/README.md`). A
correction with no attached procedure is not reusable, so the entries that have one carry it, and
the two that are not errors at all (C6, C7) say so in their headings.

This file is deliberately not a victory log. Two of the entries below are errors **still present
in the tree**, not fixed — they are recorded so the next reader does not inherit them as truth.

---

## C1 — Interpolated p50 values, caught and fixed (2026-09-23)

**What happened.** p50 values were written into the visibility results for runs whose output did
not actually print a p50. The cells were filled rather than left empty.

**Why it is a serious error and not a sloppy one.** An interpolated number is indistinguishable
from a measured one downstream. It would have been differenced against a real measurement,
produced a real-looking delta, and been cited as a regression or an improvement that no run ever
observed.

**The procedure that caught it.** Requiring that **every p50/p95 cell come from that same run's
own printed output, or be marked as not captured.** No cell is computed, carried over, or
inferred. Applying it turned four fixture rows into two with p50 and two explicitly marked "not
captured" — see `b5-update-visibility.md`, where the empty cells are now visible as empty.

**Where it stands.** The register records this in §4.6 and the values are non-interpolated there.
The correction is complete; the procedure is the durable part.

---

## C2 — Stale `perf-gates.md` line citations, caught and fixed (2026-09-23)

**What happened.** An edit to `docs/bench/perf-gates.md` shifted a table row. Twenty citations into
that file — across four rows, replaced 1:1 by the fixing commit `cdc04bfc`: `:30`→`:31` ×1,
`:32`→`:33` ×11, `:42`→`:43` ×4, `:79`→`:80` ×4 — were left naming the old line numbers. `:32` no
longer held what they quoted.

**The procedure that caught it.** **After any edit that can move lines in a cited file, re-grep
for citations into that file.**
(A grep for the *string* `perf-gates.md:32` still returns hits, and none of them is a citation into
that file's rows: this entry, which is discussing it, and `b5-update-visibility.md`'s "Caveat on the
log this bin names" section, which quotes the number as a string to search a `/tmp` log for. That
file is cited by section name here rather than by line number because it is itself still moving.)

**Why it belongs next to rule 3.** This is the failure rule 3 describes: the citation looked
fine, resolved to a real line, and that line held *different content*. Nothing detects this
except the reader remembering what the number was supposed to name — which is why rule 3 says to
cite **the row, not just the number**.

---

## C3 — `memAxis` anchors that do not resolve anywhere (OPEN — not fixed)

**The defect.** Two documents cite `packages/ui/web/index.html:1804` for the `memAxis`
translation boundary and `:1805-1806` for its obfuscated string comparison:

| Document | Citation |
|---|---|
| `docs/program/evidence-register.md:2132` (register row `B14`) | `memAxis` at `index.html:1804`; the obfuscated `fromCharCode` pair at `:1805-1806` |
| `docs/program/wp5-implementation-spec.md:88` | repeats `index.html:1804` as "the sole translation boundary" |

A third document, `docs/program/logs/wp3-h4-extraction-2026-09-23.log:163-164`, cites the
**call sites** as `index.html:1813`, `:1816`, `:2172`, `:2174`.

**What actually resolves** (verified live at codeHead `060898de`, file unchanged since
`79552537`):

| Anchor | Content |
|---|---|
| `index.html:1854` | `memAxis(v){ const raw=v===void 0?'':String(v);` |
| `index.html:1855` | `if(raw===String.fromCharCode(99,97,110,100,105,100,97,116,101)) return 'staged';` |
| `index.html:1856` | `if(raw===String.fromCharCode(116,114,117,115,116)) return 'standing';` |
| `index.html:1857` | `return raw; }` |
| `index.html:1886`, `:1889`, `:2142`, `:2315`, `:2317` | the `memAxis(...)` **call sites** |
| `index.html:1850-1853` | the comment explaining why the literals are obfuscated |

**`index.html:1804` is `}`; `:1805` is the doc comment for `closeIntake` (it describes the method
but does not contain the identifier); the identifier itself is at `:1806`,
`async closeIntake(intakeId,outcome){`.**

**What was deliberately NOT concluded.** The position of `memAxis` was traced across four
revisions — `86a87d56` → `:1811`, `79552537` → `:1854`, `cdc04bfc` → `:1854`, HEAD → `:1854`.
`:1804` matches **none** of them. No revision was found in which the citation is correct, and the
correction note says only that (which is what was verified) rather than speculating about which
revision the register meant to read. `:1811` in the oldest revision is *close* to `:1804`, and
that nearness is exactly the kind of plausible story this log exists to refuse.

**Scope of the defect.** It is presentational: the register's *claim* about `memAxis` (that the
Gate-0 vocabulary law cannot see the obfuscated banned words) is unaffected by the wrong line
number. The register row and the spec were not rewritten — recording an unfixed anchor here is
the point, and editing a register row that a reviewer is about to read would hide the drift
rather than surface it.

**Related.** A related capture — that the vocabulary law cannot see obfuscated banned words at
`memAxis` — is among the pending captures, and is also blocked by this same anchor (see
`../../memory/enhancement/pending-captures.md`, `cap:d30264f84a61`).

---

## C4 — B17 / P-8 anchors: one off by 2, and a bare filename (OPEN — not fixed)

**The defect.** Register row `B17` (`docs/program/evidence-register.md:2135`) cites
`code-retrieval-eval.mjs` — **no directory** — at `:208`, `:212` and `:552` for clause 3's missing
instrument. The file is **`scripts/bench/code-retrieval-eval.mjs`** (the register's own
file-qualified reference at `docs/program/evidence-register.md:1217` spells it that way);
`scripts/eval/` does not contain it — that directory holds `code-vector-eval.mjs`, a different
harness. In the real file:

| Cited | Live | Content |
|---|---|---|
| `:208` | `:208` ✓ | `const store = new SqliteIndexStore(DB);` — the no-embedder construction that *is* the missing instrument |
| `:212` | **`:214`** | `const hybridMeasurable = caps.vector === true;` |
| `:552` | `:552` ✓ | the clause-3 `exactGuard` expression, `null` by construction |

`:212` is the comment above the declaration, not the declaration. This is a mis-numbered citation
rather than drift: at `79552537` — the commit that wrote the row — the harness was already 737 lines
and `hybridMeasurable` was already at `:214`.

Also relevant and correct in substance: `:215-217` `hybridNote`, `:226` the `index` object with
`vectorNote`, `:231`/`:236` the measured/unavailable status, `:250` `RUNNABLE`.

**The substantive finding is unaffected:** clause 3 (`exact R@1(C_x) ≥ exact R@1(C0)`) has no
instrument because `:208` constructs `new SqliteIndexStore(DB)` with **no embedder**. That anchor,
and the `:552` clause-3 field it names, both resolve as written. Only the filename and the `:212`
number were wrong.

---

## C5 — A carried `code-vector-eval.mjs` anchor was wrong by 47 lines

The ledger record `mem:7238293f1b3a3383a92b92f79fe5fb752b07d15575debfb5ca340608953a8e3f` carries a
`source-quote` evidence item whose `path`/`line` are `scripts/eval/code-vector-eval.mjs:278`, for the
quote `hybridScore = hybrid.capabilities().vector ? score(hybrid) : undefined;`. That quote is live
at **`:325`** — 47 lines below the number it was carried at. Live, in
`scripts/eval/code-vector-eval.mjs`: `:33` documents `--require-hybrid` in the usage line, `:69`
`const REQUIRE_HYBRID = args.includes('--require-hybrid');`, `:320` `let hybridScore;`, `:325`
`hybridScore = hybrid.capabilities().vector ? score(hybrid) : undefined;`, `:357-362` the graded
arm, `:384`/`:419`/`:422` reporting. **`:278` is nothing in particular** (`    n,` — the `n,` of a
return object belonging to a different function).

**The procedure that caught it.** Re-reading the live file rather than trusting a carried number.
A carried anchor has no owner: the number still resolves, so nothing complains, and only opening
the file shows what `:278` now holds.

**Where the rot was already recorded, independently.** The enhancement written against that record
noted the same anchor, in the same file, at
`.crib/memory/enhancement/7238293f1b3a3383a92b92f79fe5fb752b07d15575debfb5ca340608953a8e3f.md:67`
("`:278` now holds `n,`"). Two readers opening the same file is what makes the number's fault
visible rather than a matter of memory.

---

## C6 — Anchor rot *in place*: `packages/memory/src/atomic.ts` (evidence, not an error)

The superseded v1 record quotes a primitive at `packages/memory/src/atomic.ts:16-21`. That text
is **no longer there**. The file is now a **27-line re-export shim** (`wc -l
packages/memory/src/atomic.ts`), and its header explains that the implementation moved to
`packages/core/src/atomic-write.ts` and that the `./atomic.js` module path is deliberately kept
(because `packages/memory/src/ack-after-persist.test.ts` and `packages/memory/src/graph-submit.test.ts`
mock it).

**Why this is the strongest case for rule 3.** The v1 record was written when the anchor was
correct. The anchor did not "break" — the file changed underneath it, and the record was not
re-read. Nothing in the record's own machinery detects this, because the *path* still exists and
still resolves. Only `path:line` **plus the row it names** distinguishes "the anchor resolves" from
"the anchor resolves to the thing I quoted".

---

## C7 — Precision note, not an error: `wp1-write-cost-probe.mjs:820`

The register row for B5 (`docs/program/evidence-register.md:2123`) cites
`docs/program/tools/wp1-write-cost-probe.mjs:820` as "a *denominator* … which consumes the budget
but never measures it". Accurate in substance: `:820` and `:869` are consumer lines printing
the budget's share — `${UPDATE_VISIBILITY_BUDGET_MS} ms update-visibility budget` at `:820`, and `${UPDATE_VISIBILITY_BUDGET_MS} ms budget` at `:869`. The **definition** is at `:93`. Recorded here
only so a reader who greps `:820` expecting `const UPDATE_VISIBILITY_BUDGET_MS` is not surprised —
the row names the right thing at the wrong-role line.

---

## The rule this file supports

> **Anchors must be verifiable.** … when you cite one, cite the *row it names* too, so a stale
> number is detectable rather than silently wrong. — `.crib/bins/README.md`, rule 3

Six of the seven entries above are instances of the same failure: **a citation, or a number, that
resolves but points at the wrong thing, or at nothing.** The exception is C1, where no citation was
involved at all — its defect was a *value* filled in by hand. Three working procedures came out of
them:

1. After any edit that can move lines in a cited file, **re-grep citations into that file** (C2).
2. Cite **the row, not the number** — the row name is what makes a stale number detectable (C3,
   C6).
3. Never carry a line number forward without opening the file it names (C5). A carried anchor has
   no owner.

**C3 and C4 are the two errors above that are still present in the tree, and neither is fixed.** C6
and C7 record the same class of rot but are not themselves defects: C6 is anchor rot inside a
superseded record, C7 is a register row naming the right thing at a wrong-role line. All four are
left as recorded, with the live anchors that do resolve, so the next reader starts from the truth
rather than from a plausible-looking number.

---

## What this file does NOT claim

- **That the documents named above are correct now.** C3 and C4 are open: the register row, the WP5
  spec and the extraction log that carry the non-resolving anchors were left unedited on purpose,
  because editing a row a reviewer is about to read hides the drift instead of surfacing it.
- **That this list is exhaustive.** An entry exists only where someone re-opened a file and found
  the anchor gone. A stale anchor nobody re-read is not counted here.
- **Any verdict about a memory record.** Record and capture ids are pointed at
  (`cap:d30264f84a61`, and the record cited in C5), not summarized. Trust, evidence and lifecycle
  verdicts are the ledger's to compute and are not restated here.
- **That the C2 counts measure anything but citation text.** They count occurrences of the string
  `perf-gates.md:<n>` in files (documents and scripts), re-derived from `cdc04bfc`'s diff. Nothing
  or the product follows from them.
- **That a resolving anchor is a verified one.** Every anchor in the right-hand columns above was
  opened at codeHead `060898de`. Resolving proves only that the line exists — an anchor that
  resolves to changed content is precisely the failure C6 records.
