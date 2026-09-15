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

(none yet — the first graph evaluation has not run)