# WP5 Implementation Spec — Make trust and recovery understandable

**Status:** SPEC WRITTEN 2026-09-23. **Implementation NOT started.** This document is the
pre-registration for the work, in the same shape as `wp1-implementation-spec.md`,
`wp2-implementation-spec.md` and `wp4-implementation-spec.md`, so that a reviewer can tell what was
promised before the code arrived from what was discovered while writing it.

Companion documents: `developer-trust-plan.md` (WP5, lines 87–95), `evidence-register.md` §6 (empty
placeholder today), `docs/audits/2026-09-05/post-merge-reaudit.md` **R08** (the finding WP5 exists to
close), `packages/cli/test/browser/memory-home.browser.ts` (the acceptance harness).

---

## 1. The requirement, verbatim, and what "done" means

From `developer-trust-plan.md:87-95`, unedited:

> ### WP5 — Make trust and recovery understandable
>
> - Extend Memory Home to explain why an item appeared, its supporting evidence, freshness, scope,
>   conflicts, and exclusion reasons.
> - Separate reusable knowledge from unfinished work; make continuation choices and repository drift
>   understandable without inspecting raw records.
> - Provide actionable recovery for stale indexes, unavailable models, blocked extraction, and failed
>   persistence.
> - Add keyboard, accessibility, empty-state, offline, and recovery coverage to browser acceptance.
> - Validate the complete workflow: save a decision → change its evidence → observe its changed
>   status → continue the task in another agent.
>
> **Exit:** users can understand and repair the tested failure states without editing internal
> storage.

"Done" is **not** "a new panel exists". The exit criterion is a capability claim about a person: for
each tested failure state, the UI must let a user both **understand** it and **repair** it, and
neither step may require opening `.crib/` with an editor, running a command whose prerequisites the
operator has not set up, or calling a memory verb that only an agent can call.

The audit that generated this work package states the same acceptance in operational terms
(`post-merge-reaudit.md`, R08 Acceptance — quoted because it is the closer reading of the same
requirement):

> users can inspect why a memory is missing, review pending outcomes, inspect source evidence, copy or
> execute an appropriate next command, choose an intake, and distinguish completed history from
> unfinished work. Provide keyboard entry/focus/close behavior, readable light/dark styles, and a
> narrow-screen entry point. Offer safe review steps for destructive corrections rather than silently
> changing records.

---

## 2. Acceptance and regression rows this work package must satisfy

One row per plan bullet. Each row names the artifact that closes it; a row is closed only by that
artifact, not by an adjacent one.

| Row | Bullet | Closes when | Artifact |
| --- | --- | --- | --- |
| **U1** | explain why an item appeared / its evidence / freshness / scope / conflicts / **exclusion reasons** | a user can select any claim — *including one that did not appear in a search* — and see the reason it was admitted or excluded, in words, without reading a record | `packages/ui/web/index.html`, `packages/cli/src/viz-server.ts`, `packages/memory/src/api.ts` |
| **U2** | separate reusable knowledge from unfinished work; continuation + drift understandable | the Home view distinguishes the claim ledger from intakes by layout **and** labels, and states drift (HEAD moved / index behind) in words | UI + `readMemoryHome` |
| **U3** | actionable recovery: stale index, unavailable model, blocked extraction, failed persistence | each of the four named states renders a next step the operator can actually take — never a command with unmet prerequisites | UI + `readMemoryHome` nextAction ladder |
| **U4** | keyboard, accessibility, empty-state, offline, recovery coverage in browser acceptance | `memory-home.browser.ts` covers each of the five, on the real server, including the **empty** and **offline** states | `packages/cli/test/browser/*` |
| **U5** | end-to-end workflow validation | one browser test performs: save a decision → change its evidence → observe the changed status → continue the intake; no manual step | browser suite |

**Regression rows** (must not break while doing the above):

| Row | Guarantee | Currently proven by |
| --- | --- | --- |
| **U-R1** | recall eligibility semantics unchanged | `packages/memory/src/recall.test.ts`, `evaluator.test.ts` |
| **U-R2** | `reasons` remain absent-by-default on the ledger projection unless an evaluation is supplied (no accidental cost on every ledger page) | new test, §7 T13 |
| **U-R3** | the memory panel's vocabulary law holds (`memVerdictChips` output is the compliance boundary) | `packages/ui/src/web-assets.test.ts` (B14) |
| **U-R4** | the Home view's `nextAction` never names a command the operator cannot run | existing comment at `viz-server.ts:241-251`; new test, §7 T12 |

---

## 3. Interfaces and compatibility this spec must not break

- **`MemoryApi` is the only data source.** The viz server owns no projection of its own
  (`viz-server.ts:141-147`). Any new field must come from an existing or extended `MemoryApi` op —
  the UI must not compute trust from anything the backend did not say.
- **`EffectiveVerdicts` is a read projection, not a stored shape.** Adding a populated `reasons` must
  not change `evaluationCacheKey` (`evaluator.ts:855`) or any persisted byte. The WALL-CLOCK LAW
  applies: nothing here may derive a key from the clock.
- **`isRecallEligible` (`evaluator.ts:983`) stays the single inclusion predicate.** WP5 surfaces its
  answer; it does not fork it. A second implementation of "is this eligible" in the UI would be the
  defect this row exists to prevent.
- **`ifHash` stability.** `SearchHit.freshness` documents that the response must be a pure function of
  its inputs (`api.ts:886-899`). Any new display-only field must ride non-enumerably or be
  deterministic, or pinned-hash tests break.
- **Vocabulary law (B14).** `memAxis` (`index.html:1804`) is the sole translation boundary for the
  memory panel. New chips must go through it; a new user-visible string that spells a banned
  vocabulary word raw is a regression regardless of whether the test catches it.

---

## 4. Honesty rules for this work package

1. **"Not measured" ≠ "zero".** A recovery surface that could not be exercised against a real failure
   state must render as UNAVAILABLE with a reason, never as a green check. Same three-outcome
   discipline as `docs/bench/perf-gates.md`.
2. **No fabricated reassurance.** An empty-state message must say what was searched, not "all good".
   Audit R08's core complaint was eight pending captures reported as tiles with nothing to do next.
3. **Recovery text names only steps the operator can take.** The precedent is recorded at
   `viz-server.ts:244-247`: the old hint named `crib memory distill --provider <name>`, which needs an
   LLM provider nobody configured. A next step that cannot be executed is worse than none, because it
   reads as the user's failure.
4. **Do not silently change records.** Destructive corrections are offered as review, matching R08's
   "Offer safe review steps for destructive corrections rather than silently changing records."
5. **A visual surface is not a fix until a test drives it.** U4/U5 are the rows that make this real.

---

## 5. What already exists — so this spec neither re-plans it nor claims credit for it

This section is the reason the spec is short. Most of WP5's *plumbing* is already built; the gap is
narrow and specific.

**5.1 The exclusion vocabulary is already computed.** `MemoryEvaluator.collectReasons`
(`evaluator.ts:839`) returns an `ItemReason[]` per evaluated record, from a 15-value union
(`evaluator.ts:240-256`): `no-quote`, `anchor-gone`, `hash-drift`, `reattached`, `ambiguous-reattach`,
`quote-not-found`, `receipt-missing`, `assertion-failed`, `policy-drift`, `not-attested`,
`relayed-unconfirmed`, `inadmissible-kind`, `not-applicable`, `ok`, `ignored`. This is the answer to
"why is this missing" and it is already the tool's own words — not UI copy invented for the panel.

**5.2 The read projection already has a slot for it.** `EffectiveVerdicts.reasons: ItemReason[]`
(`evaluator.ts:868`), populated by `effectiveVerdicts` (`evaluator.ts:944-974`) as
`reasons: evaluation?.reasons ?? []`.

**5.3 Recall hits already carry it.** The recall pass supplies an evaluation
(`recall.ts:698`), so `SearchHit.verdicts.reasons` is populated whenever a revalidation pass ran
(`freshness.state === 'fresh'`, `api.ts:886`).

**5.4 The Home view already has the explanation surface's skeleton.** `memVerdictChips`
(`index.html:1809-1818`) renders `standing: <axis>`, `evidence: <verdict>`, `applies: <applicability>`
per item, plus `lifecycle` and `quarantined` when non-active. The comment at `:1809-1811` records a
prior defect ("Reading `evidence` blindly rendered 'evidence: [object Object]' on every ledger row"),
i.e. this surface has already been hardened once.

**5.5 The intake half of R08 has landed.** `readMemoryHome` (`viz-server.ts:213`) returns
`sections{active,pending,needsReview,history,resume}`, `health`, `lastSession` and a most-urgent-first
`nextAction`; the browser suite covers resume, the 409 re-base, idempotence, Escape/focus restore and
390 px (`memory-home.browser.ts`).

**5.6 The health tiles exist and carry the four recovery signals.** `VizMemoryHomeOperations.health`
(`viz-server.ts:196-206`) already has `retrieval.mode` + `reason`, `capture`, `codeIndex`
(`lastSuccessfulAt`, `behindHead`, `workerRunning`), `sync`, `readerFreshness` — which are exactly the
stale-index / unavailable-model / blocked-extraction / failed-persistence states U3 names.

---

## 6. The gap, bullet by bullet

### 6.1 U1 — exclusion reasons are computed, then discarded at the API boundary (the main gap)

`effectiveVerdicts` accepts an optional `evaluation` and falls back to `reasons: []` when it is
absent. **No call site in `api.ts` supplies one.** There are four, and they are not four copies of
nothing — they are **three near-duplicate folds plus one direct call**, which is why "add the
argument" is a bigger change than it looks:

| Site | Enclosing op (verified by reading, not inferred) | Reached by |
| --- | --- | --- |
| `api.ts:3875` | `foldedVerdicts()` — the **shared** private fold | `ledger()` (`:3787`) and conflict grouping |
| `api.ts:2847` | `get(idOrAlias)` — its **own** inline fold, not the shared one | get |
| `api.ts:3757` | `audit(idOrSubject)` — its **own** inline fold | audit |
| `api.ts:2560` | `handoff()` — direct | the Home view's own read |

The docstring on `foldedVerdicts` claims it is "the effective-verdict fold `get()`/`audit()` apply,
extracted so the ledger REUSES the same decision truth" — but reading `get()` and `audit()` shows each
still calls `effectiveVerdicts` itself with its own pool split. The fold is **triplicated**, and the
shared one is used by ledger and conflicts only.

**Consequence for this work package:** supplying the evaluation means touching three folds, or
unifying them. The spec takes the **three-site route** — passing the optional context at each of the
three folds and at `handoff()` — and explicitly **does not** unify them. Unifying three folds that
differ in pool-split semantics is a refactor of `get`/`audit`/`ledger` correctness with its own blast
radius, and bundling it would make this change unreviewable. Filed as **P-11** (§11).

Every row the ledger endpoint (and therefore Memory Home) receives carries `reasons: []` **by
construction** today, and the UI cannot render "why is this missing" even though the evaluator knows.
Only `recall.ts:698` supplies an evaluation.

**The plumbing to supply one already exists.** `this.deps` carries `{ evaluator, evalCtx, soul, ... }`
(used at `api.ts:2144-2145`, `:2176`, `:2726`), so each fold can compute
`this.deps.evaluator?.evaluate(record, this.deps.evalCtx)` under the same both-must-be-present rule
recall already applies. Where either is absent the fallback stays exactly `[]` — pinned by T13.

Second half of the same gap: recall computes verdicts for **every considered record**
(`recall.ts:705`) and then drops the ineligible ones at `recall.ts:706`
(`if (!isRecallEligible(verdicts)) continue;`). The excluded set — with its reasons — is therefore in
hand at the moment it is thrown away; what survives is a bare **count**, `RecallResult.counts`
(`recall.ts:188-196`), which carries both `considered` ("total records considered before eligibility
filtering") and `eligible`. A user who cannot find a memory they saved sees two numbers and no rows.

Third, smallest: the UI has no **conflict** chip and no **scope** chip distinct from `standing`.
`standing` is the store axis (team/local/global); `scope` is the semantic axis; `conflictGroups`
already exists in the backend (`recall.ts:739`). Two different questions currently share one label.

### 6.2 U2 — the separation exists structurally but is not stated

The Home view already renders `sections.resume` separately from the ledger, so reusable knowledge and
unfinished work are already in different regions. What is owed is the *statement*: labels that say
which is which, and drift in words. `health.codeIndex.behindHead` exists as a boolean-ish signal and
is surfaced as `behind HEAD` in red (`index.html:2042-2054`); there is no sentence telling the user
what that means for what they are about to read.

### 6.3 U3 — the tiles report, they do not recover (verified, not assumed)

`readMemoryHome`'s `nextAction` ladder (`viz-server.ts:241-251`) already picks **one** action, most
urgent first, following the scar-tissue rule quoted in §4.3 — and **it is blind to `health`.**
Verified by reading every branch: the ladder reads `handoff.intakes.primary.nextSafeAction`,
`resumeCount`, `pending`, `staleCount` and `handoff.counts.needsAttention`, and nothing else. `health`
is passed through to the caller verbatim (`viz-server.ts:267`) and never consulted. So the four states
U3 names — stale index (`health.codeIndex.behindHead`), unavailable model
(`health.retrieval.mode === 'lexical-fallback'` + `reason`), blocked extraction and failed persistence
(`health.capture.dead`) — are **displayed and cannot produce a next step at all**.

This is therefore an **API/ladder gap in `readMemoryHome`**, not a rendering gap, and the fix belongs
at `viz-server.ts`, not in the UI. It also means the UI half is already honest: `index.html:2042-2054`
renders these fields today, including `behind HEAD` in red. T12 keeps its job — it pins the ladder
having a branch per state — but it no longer has to discover which layer is missing.

### 6.4 U4/U5 — coverage, not construction

Keyboard, Escape/focus-restore and 390 px are covered for the intake flows. What is absent from
`memory-home.browser.ts` today: the **empty** state (a repository with no memory configured), the
**offline** state, the four **recovery** states of U3, and the single end-to-end script U5 names.

---

## 7. Per-file change list (exact signatures)

Ordered so each step is independently reviewable and revertible. No step depends on a later one.

**7.1 `packages/memory/src/api.ts`** — supply the evaluation at the three folds + `handoff`.

The three folds differ only in their pool split, so each needs the same one-line addition and the
same both-ports-present guard recall already uses (`api.ts:2726`):

```ts
// In foldedVerdicts / get()'s fold / audit()'s fold, immediately before effectiveVerdicts:
const { evaluator, evalCtx } = this.deps;
const evaluation = evaluator && evalCtx ? evaluator.evaluate(record, evalCtx) : undefined;
const verdicts = effectiveVerdicts(record, bridged, evaluation, conservativeVerdicts(legacy));
```

Three consequences the implementer must respect:

- **Supplying an evaluation does not merely add `reasons` — it can change the verdicts.** In
  `effectiveVerdicts` (`evaluator.ts:944-974`) the evaluation is consulted *first* for `evidence` and
  `applicability`: `evaluation?.evidence ?? record.verdicts.evidence` (v1) and
  `evaluation?.evidence ?? migratedVerdicts?.evidence ?? stampedEvidenceVerdict(...)` (v2). So passing
  a fresh evaluation where the code passed `undefined` **replaces a stamped verdict with a recomputed
  one**. A record whose quote no longer grounds moves from `evidenceVerdict: 'valid'` to `'invalid'`
  and, by `isRecallEligible`, from `eligible: true` to `false` — it leaves **recall**. That is the
  correct direction (evidence validity is a property of the world now, `evaluator.ts:~340`) and it is
  precisely why recall already does it — but it is a **behaviour change to what recall returns, not a
  display-only addition**, and it must be gated behind the opt-in described below rather than switched
  on by default. T13 must assert the default-off path is byte-identical to today, and T13b must pin
  the one re-decision the opt-in path produces.
- **CORRECTION (2026-09-23, found while landing Step A).** This bullet originally claimed the change
  moves a row's **ledger group** (`current` → `stale`/`unanchored`). **That is wrong**, and the
  implementer found it by reading `ledgerGroupOf` (`ledger.ts:196-211`) after T13b's group assertion
  failed: the group is derived from the **anchor correlation**, and verdicts enter it only for
  `lifecycle === 'retracted' | 'superseded'` or `quarantined`. An evidence-only re-decision therefore
  leaves the row sitting in `current`. The sharper consequence is the opposite of reassuring: **the
  ledger group does not encode evidence freshness at all**, so a record re-decided to `invalid` keeps
  reading as healthy while silently dropping out of recall. Without `reasons` that transition is
  **unobservable from the ledger** — which is exactly the U1 failure this work package exists to fix,
  and it makes `reasons` load-bearing rather than decorative. T13b now asserts both halves: the
  re-decision (`evidenceVerdict`, `eligible`) **and** the group that does not move.
- The **both-must-be-present** rule is not a convenience: a lone evaluator without a context cannot
  revalidate anything, and recall already refuses that combination (`api.ts:867-868`). Same rule here.
- `handoff()` (`:2560`) reads many records; evaluating all of them is the one place this change can
  cost real time. It stays **opt-in**: `handoff` gains no evaluation unless its options ask, so the
  Home view's cost is a deliberate choice (P-7) rather than a side effect.
- `evaluate()` is memoized per content at a dependency generation (`evaluator.ts:352-370`), so a
  ledger page evaluating its rows does not re-read evidence items twice for the same record.

**Because of the first point, the change lands in two steps, in this order**, so each is separately
reviewable and revertible:

1. **Step A — opt-in, no default change.** Add the optional evaluation to the three folds and to
   `handoff`, defaulted **off**. Nothing a user sees changes; `reasons` stays `[]` on every default
   path. T13 pins that.
2. **Step B — turn it on for the surfaces U1 names**, one at a time, with T13b (the re-decision test)
   green before each. The ledger and the Home view are the two that matter; `get()`/`audit()` may stay
   off if the reviewer judges the cost not worth it. Step B is where the correction above bites: the
   re-decision shows on `evidenceVerdict`/`eligible`/`reasons`, **never on `group`**, so a surface that
   switches this on must render `reasons` or the change is invisible to the user it is for.

**7.2 `packages/memory/src/recall.ts`** — expose the excluded set.

Add the `RecallExclusion[]` field to the recall projection, populated from the records already in
`consideredEntries` that fail `isRecallEligible` at `recall.ts:706`:

```ts
export interface RecallExclusion {
  id: string;
  claim: string;
  source: MemorySource;
  verdicts: EffectiveVerdicts;   // carries `reasons`
  /** which predicate clause excluded it — derived from verdicts, never re-implemented. */
  excludedBy: 'trust' | 'evidence' | 'applicability' | 'lifecycle' | 'quarantined';
}
```

`excludedBy` must be derived by asking `isRecallEligible`'s clauses in order, in one place, so the
label and the decision cannot disagree. This is the field that turns `counts.considered: 8` alongside
`counts.eligible: 3` into five honest rows.

**7.3 `packages/cli/src/viz-server.ts`** — pass the excluded rows through the recall/home reads, and
extend the `nextAction` ladder so each of the four `health` signals can produce a step. No new op: the
same `readMemoryHome` contract, more inputs to the ladder (§6.3 — the ladder is blind to `health`
today, verified).

**7.4 `packages/ui/web/index.html`** — add a conflict chip and a scope chip through `memAxis`; add an
exclusion panel rendering `reasons` as text; add a recovery line bound to each health tile.

**7.5 `packages/cli/test/browser/memory-home.browser.ts`** — U4/U5 coverage (below).

---

## 8. Test plan

Test IDs continue the program sequence (WP4 ends at T11). Every test must be shown to fail against
pre-change code before it is credited (the method note in WP4 §12).

| # | Test | Asserts | Guards |
| --- | --- | --- | --- |
| **T12** | `viz-server.test.ts` — recovery ladder | for each of the four health states, `nextAction` is non-null and its text names a step reachable with no unconfigured prerequisite | U3, U-R4 |
| **T13** | `revalidate-optin.test.ts` — reasons fallback is exact | with no eval context (the default path), a ledger row's `reasons` is exactly `[]` **and its group/evidence/applicability/eligible are byte-identical to today** | U-R2 |
| **T13b** | `revalidate-optin.test.ts` — the opt-in changes verdicts, deliberately | with the eval context supplied, a record whose quote no longer grounds moves `evidenceVerdict` `valid` → `invalid` and `eligible` `true` → `false`, carrying the matching `ItemReason`; **and its `group` does NOT move** (`ledgerGroupOf` is anchor-derived — see the §7.1 correction, which is why `reasons` is load-bearing rather than decorative) | U1, §7.1 |
| **T14** | `recall.test.ts` — excluded rows | a record failing on each of the five clauses appears in `exclusions` with the matching `excludedBy`, and `excludedBy` never disagrees with `isRecallEligible` | U1 |
| **T15** | `evaluator.test.ts` — reason vocabulary | every `ItemReason` the evaluator can emit is either rendered or deliberately mapped; no new union member is silently invisible | U1 |
| **T16** | browser — empty state | a repo with no memory store renders the empty state with what was searched, not a success message | U4 |
| **T17** | browser — offline | with the backend unreachable, the panel states it is offline and keeps the last-known content readable | U4 |
| **T18** | browser — exclusion is inspectable | a claim excluded from recall is reachable in the UI and its reason is rendered as words | U1, U4 |
| **T19** | browser — the U5 workflow | save a decision → change its evidence → observe the changed status → continue the intake, in one test, with no manual step | U5 |
| **T20** | browser — accessibility | keyboard-only traversal of the new surfaces; focus is never lost; contrast meets the R08 threshold (~1.025:1 was the audited failure) | U4 |

---

## 9. Measurement protocol and acceptance gates

WP5's exit criterion is behavioural, so it cannot be gated by a number the way WP4's is. The gates
are:

1. **G-U1** — T14 and T18 pass, and the reason shown is the evaluator's `ItemReason` (T15), not UI
   copy.
2. **G-U2** — every test in §8 passes on the real server (`pnpm verify:browser`), not on a fixture.
3. **G-U3** — the four recovery states are exercised **against real failure states**, not simulated
   ones where a real one is reachable. A recovery path demonstrated only by a mock is recorded as
   UNPROVEN, with the reason.
4. **G-U4** — `pnpm lint` and `pnpm test` clean; no ledger page regresses (U-R2).
5. **G-U5** — the E2E round (§8 of the register) is re-run **after** WP5 lands, because the existing
   round predates it and its F1/F2 findings remain open.

---

## 10. Freeze notes

Frozen at spec time; changing any of these after implementation begins requires a dated note here,
not a silent edit.

- The `ItemReason` union is used verbatim as the exclusion vocabulary. **No new vocabulary is
  invented for the UI.** If the vocabulary is insufficient, that is a finding about the evaluator and
  is recorded as such.
- `isRecallEligible` is not forked. `excludedBy` is derived from it.
- No change to persisted bytes, `evaluationCacheKey`, or any `ifHash`-pinned response shape.
- The four `api.ts` sites gain an **optional** parameter. Existing callers keep today's exact
  behaviour; T13 pins that.
- The vocabulary law (B14) is respected via `memAxis`, and B14's own repair (proposed A+B) is
  **deliberately not bundled here** — it is a Gate-0 law item, not WP5 scope.

### Dated notes (changes to the frozen list, made after implementation began)

**2026-09-23 — `LedgerResult.revalidated: boolean` is added (additive field).** The freeze says no
change to persisted bytes, `evaluationCacheKey`, or any `ifHash`-pinned response shape. This field is
none of those: it is a boolean on a read projection that is computed per request and never persisted,
and it enters no cache key. It is added because implementation exposed an ambiguity the spec had
assumed away.

`LedgerRow.reasons` is empty in **two** situations that mean opposite things — the read revalidated
the row and nothing failed, or the read never revalidated it at all. `collectReasons` filters `'ok'`
and `'ignored'`, so a healthy revalidated row reports exactly `[]`, the same value as a row nobody
looked at. The surface cannot tell them apart, and the sentence it renders for that case ("this read
did not re-check the claim") was therefore **false** on the revalidated path — an assertion about a
read that did happen, in the direction that understates what the system did.

The flag is computed by `MemoryApi.canRevalidate(want)` and is the **same predicate**
`freshEvaluation` consults, so "the rows were re-checked" and "an evaluation was supplied" cannot
disagree. It reports `false` when the caller asked but a port was missing, because a revalidation
that could not run is not one that did.

**2026-09-23 — T15's file moves from `evaluator.test.ts` to `packages/ui/src/web-assets.test.ts`.**
T15 asserts that every `ItemReason` the evaluator can emit is rendered or deliberately mapped. The
union is declared in `@knowledge-crib/memory`; the map that must cover it (`memReason`) is in
`packages/ui/web/index.html`, a served asset. The memory package does not depend on the UI package
and should not start — a test that reaches the asset from the memory package would invent that edge
for test convenience. `web-assets.test.ts` already reads every served asset by path for the same
class of contract (the Gate-0 vocabulary law), so T15 is a second contract of the same shape in the
file that already establishes it. The check reads the union out of the evaluator's source rather
than re-typing it: a re-typed list would pass while a new member went unrendered, which is the exact
failure T15 exists to catch.

**2026-09-23 — the WP5 surfaces do not use the accent palette as text colour.** The recovery line
(`§7.4`) and the read-failure notice initially followed the existing convention of an accent as text
(`#f59e0b`, `#f87171`). Measured against the panel backgrounds, those are ≈2.0:1 and ≈2.8:1 on the
LIGHT theme — below WCAG AA (4.5:1) for normal text, against the R08 acceptance this work package
must satisfy ("readable light/dark styles"). The colour now rides on the left rule and the text uses
the panel's own `t.text` (≈14.5:1 light, ≈13:1 dark), per the convention the pre-existing health
tiles already use. The same accents used as text elsewhere in the panel (`#f87171` error text, and
the chip foreground palette) are **pre-existing and outside this work package's edit scope**; they
are recorded as a finding in the evidence register rather than silently fixed here.


---

## 11. Open decisions for the principal reviewer

**P-7. Does the excluded set belong in the recall response, or in a separate explain verb?**
Putting `exclusions` on the recall result makes every recall pay for it and grows a hot response; a
separate verb keeps recall lean but means the UI must make a second call to answer "why is this
missing". The spec takes the recall-response route because the reasons are already computed there and
discarding them is the defect being fixed — but this is a cost/ergonomics trade and the reviewer may
prefer the separate verb.

**P-8. Where do the four recovery states sit in the priority ladder?** The ladder picks one action and
today is blind to `health` (§6.3, verified). Adding branches raises a priority question that must be
*stated*, not implied: does a stale index outrank five resumable intakes, or is it lower because work
in progress is rarer than a stale index? The spec proposes extending the existing most-urgent-first
ladder with the four states placed **below** work-to-resume and pending (they are conditions, not
tasks a user owes) — but the ordering is a judgement the reviewer may invert.

**P-9. Is `excludedBy` a distinct field, or derivable in the UI?** Derivable means the UI re-implements
eligibility clauses, which §3 forbids. The spec keeps it server-side. Flagged because it is the one
place this spec adds a field that exists only to label a decision the backend already made.

**P-10. Offline state scope.** T17 needs a definition of "offline" for a locally-served panel: backend
process gone, or the browser unable to reach it. The spec means the latter (the panel must survive a
dead server); if the reviewer means the former, T17 changes shape.

**P-11. `get()` and `audit()` each carry their own copy of the verdict fold, while the docstring on
`foldedVerdicts` says they do not.** This spec deliberately does **not** unify them (§6.1): the three
folds differ in pool-split semantics, so unifying them is a change to `get`/`audit`/`ledger`
correctness with its own blast radius, and bundling it would make this change unreviewable. It is
flagged rather than fixed, and note it is a **defect of the comment, not (on the evidence read here)
of the code** — the comment asserts a sharing the bodies do not implement. A reviewer may prefer to
unify first and land WP5 on top; that ordering is defensible and this spec does not preclude it.

---

## 12. What this spec does NOT claim

- It does not claim WP5 is implemented. It is not.
- It does not close B2 or B9 in the register; B9 (nothing committed) stays open until the terminal
  push/PR.
- It does not fix F1/F2/F3 from the E2E round, or B13/B14. Those are separate, named, and
  deliberately not bundled.
- It does not assert that the four `api.ts` sites passing `undefined` is *wrong* — for a ledger page
  the fallback may well be the intended cheap path. It asserts only that it makes exclusion reasons
  unreachable, which U1 requires.
