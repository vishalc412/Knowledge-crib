# Graph gate pre-registration — connected memory graph (WP-G0)

**Status: FROZEN BEFORE MEASUREMENT.** The fixture universe, question set, expected evidence
paths, and construction invariants below were fixed before any graph-retrieval number exists —
no `memory_graph` tool, no projection, no backfill has been built yet (those are WP-G1–WP-G5).
Everything above the `RESULTS` divider is the commitment; everything below it is the outcome,
appended after the deciding WP-G5 run, with the commitments unedited. If a result is negative,
it ships as a negative result.

Disclosure (same partial-blinding disclosure `launch-gates.md` carries): the corpus author knows
the §4 gate table of the connected-memory-graph plan, and authored these questions while knowing
the fixture universe. What the author does NOT know is which retrieval configuration will pass —
nothing has been measured, and the test-set-selection law applies: any configuration found by
sweeping against THIS question set must be confirmed on an independently authored split before a
GO claim cites it.

Corpus source of truth: `packages/memory/src/graph-corpus/corpus.ts`,
`GRAPH_CORPUS_VERSION = 1`, pinned by `packages/memory/src/graph-corpus/graph-corpus.test.ts`.
Changing either the universe or the questions bumps the version; a frozen corpus is never edited
in place.

## WP-G0 baseline (recorded before graph work starts)

| | |
| --- | --- |
| Candidate commit | `0ec61c27c6d83e79624c0c1edf8eed32afe9bc6e` (branch `debug/auditMaster`, pushed to cmp-remote) |
| Packages | 8 workspace packages @ 0.1.0 |
| Memory envelope | memory-3 (`schemaVersion: '3'`, content-addressed ids seeded without lineage/validTime/visibility, namespace = identity) |
| Launch policy | version 4, `scripts/launch-policy.json`, frozen 2026-09-15 |
| Gates at baseline | `pnpm verify` exit 0; docs-site-check exit 0; client-certification-matrix `--check` exit 0 |
| Launch decision | NO-GO by design (see below) |
| Graph index at baseline | refreshed via `crib update`; `status({op:'gaps'})` reports **6,509 unresolved call sites** and `analysisReadiness: incomplete` |

**Remaining launch blockers at baseline (unchanged by graph work).** Every one of the
twenty-one client cells is uncertified (`client-cell-uncertified:*`) — a cell needs a signed-in
vendor client on a native host, and none has been run. The six acceptance-receipt cells were
collected on darwin only, and three certification hosts lack operator attestations. These are
the honest blockers the frozen policy names; the graph work packages do not touch them.

**Graph coverage limit carried into this corpus.** Because `analysisReadiness` is `incomplete`,
the corpus NEVER assumes the code graph resolves every symbol. Every `sym:` id in the universe
is a fixture declared by the corpus itself (`corpus.symbols`, the rename fixture's two
revisions), not a live index node — WP-G1 backfill and WP-G5 retrieval are judged against the
corpus universe, so an unresolved live call site cannot make a gate silently pass or fail.

## 1. Fixture universe (version 1)

Two principals, two repositories, local and global memory, decisions with supersession,
conflicting claims, renamed code, and unfinished/completed intakes — every fixture dimension
the plan's WP-G0 names, each with a deterministic probe:

| Dimension | Fixture |
| --- | --- |
| Principals | `principal:alpha` (spans both repos — cross-repo probe), `principal:beta` (checkout only — isolation probe) |
| Repositories | `graph-corpus-ledger`, `graph-corpus-checkout` |
| Records | 15 memory-3 records: 10 alpha/ledger, 1 alpha/global (convention), 1 alpha cross-repo (checkout cart fact), 2 beta/checkout, 1 global decoy (`topic:idempotency-general` — HTTP PUT lore that must never hijack a labeled question) |
| Supersession | decision pair D1→D2 on `topic:ledger-retry-idempotency`, with a `supersede` decision event (append-only; D1 is never rewritten) |
| Conflict | 30s vs 60s retry-window pair, mutually `contradicts`-stamped (possible because lineage is excluded from the v3 id seed) — last-write-wins is a failure, both must travel together |
| Rename | `chargeOrder` → `settleOrder` across two source revisions; the pre-rename claim's valid window closes exactly when the rename lands |
| No-silent-merge | `OrderService` exists in BOTH repos with distinct entity ids |
| Global isolation | the global convention is alpha-owned; beta's global probes expect emptiness |
| Intakes | 3 (alpha completed, alpha in-progress, beta in-progress), 4 checkpoints — exactly one terminal `completed` checkpoint (phase `complete`); open ones carry `nextSafeAction` |
| Entities | 5 (two repositories, two same-named services, one journal artifact) |
| Anchors | 7 (3 committed-policy artifacts, 2 attestations, 2 receipt-pair receipts) |
| Expected relationships | 44 edges over the eight-predicate vocabulary, each naming the records that support deriving it |

Every fixture is built through the REAL builders — `memoryRecordV3Id` + `assertValidMemoryRecordV3`,
`createIntakeRequirement`/`createIntakeCheckpoint`, `decisionId` + `assertValidMemoryDecision` —
with fixed literal clocks (`2026-09-01`…`2026-09-15`, no `Date.now()` anywhere), and two builds are
JSON-identical (asserted).

## 2. Expected-relationship scope split

The 44 expected edges are NOT all backfill-derivable, and the corpus says which are:

- **Backfill-scope (WP-G1)** — derivable directly from record structure: `about` (record subject
  → topic/symbol), `supported-by` (record → its evidence anchors), `derived-from` / `supersedes`
  / `contradicts` (record lineage, itself append-only), `part-of` (symbol → entity, from the
  corpus entity table).
- **Capture-scope (WP-G4)** — the `affects` (topic → symbol) and `applies-to` (record → symbol)
  edges, and the intake `about` edges, are what the hybrid-capture pipeline is expected to
  propose; they are stated as EXPECTED, and a GO claim requires them to exist through an
  authorized proposal, never an invented link.

## 3. Question set (frozen)

43 hand-authored seeds × 3 variants (`exact` search phrasing, `paraphrase`, and the `context`
-assembly framing) = **129 questions**, of which **117 are multi-hop (≥2 expected hops)** —
above the plan's ≥100 multi-hop threshold. The 12 zero-hop questions are deliberate emptiness
probes: nine where beta asks about ledger, global, or alpha's work, and three where alpha asks
global memory for the repo-scoped retry-window decision that must not surface outside its
repository scope. Their expected claim set is EMPTY and their `forbiddenIds` name what must not
leak.

| Family | Seeds | Questions (×3) | What it pins |
| --- | ---: | ---: | --- |
| current | 12 | 36 | the default eligible projection, after supersession and rename |
| historical | 12 | 36 | bi-temporal reads at fixed `knownAt` points (5th, 7th, 9th, 11th, 13th, 15th) |
| conflict | 3 | 9 | both sides of the contradiction travel together |
| isolation | 5 | 15 | alpha's cross-repo view, beta's own view, and three emptiness probes |
| rename | 3 | 9 | pre/post-revision symbol ownership, `derived-from` across the rename |
| work | 4 | 12 | intakes as authorized work references; completed work excluded from resumables |
| cross-repo | 2 | 6 | same-named entities never merge; alpha spanning repos |
| decoy | 2 | 6 | confusable global content never hijacks a labeled question |

Every question carries `principal` + scope, optional `knownAt`, an expected evidence path over
universe ids only (`claimIds`, `symbolIds?`, `entityIds?`, `intakeIds?`, `forbiddenIds?`, and
`hops` over the eight fixed predicates), and all three variants of a seed demand the SAME
evidence path.

## 4. Gates this corpus will measure (WP-G5, thresholds from the plan §4)

| Gate | Measurement | Threshold |
| --- | --- | --- |
| Connected retrieval | expected-evidence-path recall over the multi-hop questions, run as the packaged harness | ≥ 90% |
| Isolation | zero foreign-principal claims in any answer; emptiness probes stay empty | 100% |
| Temporal correctness | `knownAt` reads return the projection as of that instant (superseded answers before, current after; closed valid windows end at their boundary) | 100% |
| Conflict preservation | both sides of the contradiction returned for conflict questions | 100% |
| Semantic preservation | the existing 8 plain-recall gates re-run unchanged on the launch corpus | unchanged (G2 ≥80%, G3 ≥0.75) |
| Update latency | graph proposal → durable, visible in reads | ≤ 2s p95 |

RESULTS will be appended below only after the WP-G5 evaluation run. Nothing above this line
changes once any such number exists.

---

## RESULTS

### Run 1 — 2026-09-16, harness v1, corpus v1 (`scripts/graph-eval.mjs`)

**Verdict: the connected-retrieval gate FAILS. NO-GO for the graph launch requirement.**

| Gate | Measured | Threshold | Result |
| --- | --- | --- | --- |
| Connected retrieval (expected evidence-path recall, 117 multi-hop questions) | **80.14%** (81 fully recalled) | ≥ 90% | **FAIL** |
| Isolation — foreign assertions in any answer | **0** unauthorized paths; isolation family 15/15 at 100% | 0 | PASS |
| Emptiness probes stay empty | **3 violations** (all `q-decoy-window-emptiness-*`) | 0 | **FAIL** |
| Forbidden ids as current items | **3** (the same probe) | 0 | **FAIL** |
| Temporal correctness / conflict preservation (per-family recall) | historical 79.4%, rename 64.8%, conflict 88.9% | 100% | **FAIL** |
| Semantic preservation (existing 8 gates) | not re-run by this harness | unchanged | not measured here |
| Update latency | not measured by this harness | ≤ 2s p95 | not measured here |

Per variant (multi-hop): exact 81.45%, paraphrase 77.52%, context 81.45%. Per family: current
93.98%, decoy 100%, isolation 100%, conflict 88.89%, historical 79.44%, rename 64.81%, work 45.83%,
cross-repo 50.00%. Missing expected hops by predicate: about 35, affects 15, part-of 6,
contradicts 3, supersedes 3, supported-by 1, derived-from 1.

What the harness measures: every fixture is written through real stores; the 35 backfill-scope
edges come from `deriveAssertionsFromRecords`; the 9 capture-scope edges are admitted ONLY through
leased extraction jobs (`submitExtractedGraphProposal`); each corpus record is admitted by an
`activate` lifecycle decision at its `recordedAt` (a memory-3 record is otherwise never
recall-eligible). Each question is asked through `memory_graph({op:'context'})` as its own
principal, from its own repository placement, with `knownBy = knownAt`, at the default two hops
and 2,000-token budget. An unplaced question (`scope: {}`) is asked from every repository and the
answers are unioned. A hop counts as recalled when an assertion with that exact
(predicate, subject, object) appears anywhere in the returned pack.

**Disclosure — this run is NOT a clean held-out measurement.** The first executions of the harness
exposed product defects, and they were repaired while looking at this corpus's failures:

1. memory-3 records could never seed `search`/`context` (recall holds them at `candidate` trust),
   so every answer was empty — fixed by graph-side seed selection over the caller's authorized
   graph nodes (`graph-seed-v1:term-overlap`). Note this fix is the reason runs 1 and 2 measure
   the lexical + semantic channels only: the seed selection that replaced the dead recall channel
   is what produces the seeds, and `activate` (which every fixture receives) moves the lifecycle
   axis only — it never confers trust, so the recall channel stays empty on these fixtures until
   harness v3 stamps them with bound legacy aliases (see Run 3);
2. an edge between two directly-retrieved items was never cited — fixed with `relations`;
3. supersession deleted graph history instead of keeping it historical, and a `knownBy` read
   applied supersessions recorded after it — fixed (retraction and quarantine still apply at every
   read point);
4. an assertion could be "known" before its endpoint record was recorded — fixed;
5. intakes were not resolvable work references, and finished work was not history — fixed;
6. multi-valued predicates (two `supported-by` anchors) were reported as conflicts — fixed:
   conflicts are functional predicates (`about`, `part-of`) and explicit `contradicts` pairs;
7. the context pack repeated assertion bodies in every path and fit ~3 items in 2,000 tokens —
   fixed by listing each assertion and producer once.

Each is a correctness or efficiency defect with its own regression test, not a parameter sweep —
but they were found on this question set, so by this file's test-set-selection law **no GO claim
may cite this number**. A GO claim needs an independently authored held-out split (≥100 multi-hop
questions) measured once with the frozen configuration. No threshold, seed limit, hop count, or
budget was changed.

Known residual causes, stated rather than tuned away:

- **Lexical seeds.** `graph-seed-v1` is term overlap with plural folding and no stemming or
  semantic channel: "settlement" does not meet "settles", "repositories" meets nothing. Rename
  (64.8%) and cross-repo (50%) questions lose their seeds this way.
- **Budget.** At 2,000 tokens and ~70-character content-addressed ids the pack holds roughly
  8–10 items; directly-retrieved seeds outrank connected nodes, so a two-hop target behind five
  seeds is often trimmed (`affects` misses).
- **Corpus construction (v1).** The corpus entity table is authored as alpha, so beta's expected
  `part-of … → entity:graph-corpus-checkout/OrderService` hop is alpha-owned; isolation correctly
  withholds it and those three questions cannot exceed 50%. A corrected corpus is a version bump.
- **Emptiness probe.** `q-decoy-window-emptiness-*` asks alpha's global memory about the retry
  window; alpha's own global decoy ("HTTP PUT makes retries idempotent") matches "retry" and is
  returned. It is authorized content, not a leak, but the frozen probe requires emptiness and the
  forbidden list names it, so it fails as specified.

### Run 2 — 2026-09-17, harness v2, HELD-OUT corpus v2 (`scripts/graph-eval.mjs --corpus heldout-v2`)

**Verdict: the connected-retrieval gate FAILS on held-out data. NO-GO for the graph launch requirement.**

Held-out discipline, in commit order: the retrieval configuration froze in `18fc98c3`
(graph-seed-v2 — stemmed term overlap, cosine similarity on the installed
`multilingual-e5-large-1024-sym` model, and recall hits fused by reciprocal rank, k = 60, five
seeds, two hops, 2,000 tokens). The held-out questions landed in `13cc9244`, written by an author
who did not see run 1, the retrieval code, or the harness. This run is the ONLY measurement taken
on them. Nothing below was tuned against them, and nothing may be: a configuration change informed
by these failures needs a new independently authored split (v3) before a GO claim.

**Correction (2026-09-22, harness v3).** The configuration above fuses three channels, but this
run exercised only two of them. Every corpus fixture is a memory-3 record, a v3 record projects
trust `'candidate'` unless a legacy alias binds it, and recall eligibility requires
`trust ∈ {local, team}` — so the recall channel returned an empty seed set on every question and
the fused-by-reciprocal-rank step had nothing to fuse. Read the 86.94% below as the lexical +
semantic measurement; the recall channel contributed no seed. The configuration text is
unchanged and still correct as a description of the frozen config; only the claim that this run
*measured* it as written was wrong. Run 3 re-baselines both corpora with the channel live.

| Gate | Measured | Threshold | Result |
| --- | --- | --- | --- |
| Connected retrieval (expected evidence-path recall, 116 multi-hop questions) | **86.94%** (88 fully recalled) | ≥ 90% | **FAIL** |
| Isolation — foreign assertions in any answer | **0** unauthorized paths; isolation family 13/13 at 100% | 0 | PASS |
| Emptiness probes stay empty | **3 violations** | 0 | **FAIL** |
| Forbidden ids as current items | **8** | 0 | **FAIL** |
| Held out | yes (corpus v2) | required | PASS |

Per variant (multi-hop): exact 88.44%, paraphrase 87.75%, context 83.89%. Per family: historical
94.79%, current 94.36%, decoy 92.59%, rename 85.00%, cross-repo 82.50%, conflict 75.83%, work 60.71%,
isolation 100%. Missing expected hops by predicate: about 22, affects 10, supersedes 4,
supported-by 4, applies-to 4, contradicts 3, part-of 2.

Every one of the eleven violations is the same shape: alpha's own global decoy claim ("HTTP PUT
makes retries idempotent") surfaces as a current item on a decoy or global probe
(`h2-cur-pnpm-global`, `h2-xr-idem-and-tooling`, `h2-decoy-*`). It is authorized content, never a
foreign disclosure, but the pre-registered probes forbid confusable global content, and they fail
as specified.

Performance at 100,000 assertions over 5,000 records (Apple M4 Max, `scripts/graph-bench.mjs`,
same configuration): warm bounded read p95 **78 ms** (≤ 500 ms, PASS), context assembly p95
**420 ms** (≤ 1 s, PASS), single-assertion update visible p95 **1.26 s** (≤ 2 s, PASS).

### Run 3 — 2026-09-22, harness v3, RE-BASELINE of both corpora (post-WP2)

**Verdict: the harness now measures all three configured channels; every gate value is unchanged.**

This is not a new held-out round and it produces no new claim. It re-runs the two frozen corpora
with the harness fix, to establish that the WP2 post-fix numbers were taken under a harness that
actually exercised the configuration the gates above describe.

Why a harness change was needed. Runs 1 and 2 measured two of the three fused channels (see the
correction under Run 2): the fixtures were trust-`candidate` memory-3 records, so the recall
channel's seed set was empty and its eligibility gate — the fuse that WP2's law governs — had
nothing to reject. `GRAPH_EVAL_HARNESS_VERSION` 2 → 3 stamps each fixture at seed time with a
synthetic legacy alias carrying `local`/`valid`/`current`/`active` verdicts — the same mechanism
by which a real memory-3 record inherits trust from a migrated v1 record
(`conservativeVerdicts`, `packages/memory/src/aliases.ts`) — written through the real
`AliasIndex.upsertAliases` into the fixture's own store. The frozen corpora are untouched
(`GRAPH_CORPUS_VERSION = 1`, `GRAPH_HELDOUT_CORPUS_VERSION = 2`); no retrieval constant, scorer,
seed limit, hop count, budget or threshold changed. The alias stamp is a measurement-fidelity
change to the harness, not a product behavior change.

| Corpus | Harness v2 (post-WP2) | Harness v3 | Δ |
| --- | --- | --- | --- |
| v1 evidence-path recall (117 multi-hop) | 95.33% (103) | **95.33%** (103) | none |
| v1 forbidden / emptiness / unauthorized | 3 / 3 / 0 | **3 / 3 / 0** | none |
| heldout-v2 evidence-path recall (116 multi-hop) | 95.42% (103) | **95.42%** (103) | none |
| heldout-v2 forbidden / emptiness / unauthorized | 0 / 3 / 0 | **0 / 3 / 0** | none |

Every gate value is identical to the harness-v2 reports — the two report files differ only in the
`harnessVersion` field. That identity IS the finding, and it is a measured one:

- Liveness was proven separately, with a temporary instrumented probe at the context entry point
  (since removed): the recall channel returns 5–6 hits per question with non-zero lexical scores
  and `evidenceQuality` 2, i.e. a genuinely eligible seed set.
- Identity therefore means the recall channel's seed set on these corpora is REDUNDANT with the
  lexical channel's — it re-proposes the same nodes in the same order, so fusing it changes no
  ranking and no pack. `gd1` (the alpha-owned global decoy) remains excluded, but by the
  placement/eligibility gate at the lexical and semantic channels, not by the recall fuse.

Consequence, stated rather than tuned away: the recall channel adds no discriminating power *on
the frozen corpora*, so a regression that broke only its eligibility gate would move no number
here. That gate is therefore proven by unit test instead —
`packages/mcp/src/verbs-memory-graph.test.ts` → "the recall channel cannot seed a foreign-placed
record at repo scope (S2 fuse is not vacuous)" injects a foreign-placed record at rank 1 of the
recall channel and asserts a repo-scoped context drops it. Discrimination was measured, not
asserted: with the pre-fix hole reproduced at the fuse call site the test fails
(`expected [ …(2) ] to not include 'mem:c373bb…'`). An end-to-end discriminating fixture belongs
in corpus v3 (the WP2 spec's §9 gaps list).

Residue is unchanged and enumerated: v1's 3 forbidden violations are `g1` only, on the three
`q-decoy-window-emptiness-{c,e,p}` probes; the 3 emptiness violations per corpus are the
corpus-authoring rows. The residue, not the harness, is what still gates GO on corpus v3.

Reports: `docs/program/eval/graph-eval-v1-harnessv3.json`,
`docs/program/eval/graph-eval-heldout-v2-harnessv3.json`.
Log: `docs/program/logs/wp2-prefreeze-harness-v3-2026-09-22.log`.
