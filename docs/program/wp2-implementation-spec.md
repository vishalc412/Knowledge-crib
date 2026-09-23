# WP2 Implementation Spec — Lawful Graph Context (final synthesis)

Branch `program/developer-trust` @ HEAD 86a87d56. Synthesized from three designs (trust / recall / arch) and three adversarial judge verdicts; every judge-flagged contradiction was re-verified in code and is corrected here. No file is edited by this spec; all citations are to the current tree.

Task-text corrections carried into this spec (verified):
- gd1 (`mem:89940073621200d4297b33b2bcb1c9e6eb09bb1cc382ad9bd71f0b6f1aa996bc`, corpus.ts:515-524) has TWO backfilled assertions, not one: `about(gd1→T_DECOY)` and `supported-by(gd1→LEDGER_JOURNAL)` (graph-backfill.ts:137 soulId anchors, :196-211 about, :216-257 supported-by; scopeForRecord :146-154 → both GLOBAL-scoped because gd1 has no projectId). corpus.ts:718-719 are **g1's** assertions.
- The harness recall channel is INERT on both corpora: corpus fixtures are v3 records projecting trust `candidate` (evaluator.ts:916-932, :923) and `isRecallEligible` requires `local|team` (evaluator.ts:954-962), so `memorySearch` returns `eligible: 0` on every question; the graph-eval.ts:245-247 comment claiming activate decisions make fixtures recall-eligible is wrong (activate mutates lifecycle only, evaluator.ts:919-921). All measured behavior is lexical + semantic.
- Alpha's checkout record a10 is "Cart locks line items while authorization is in flight." (corpus.ts:467-477, subject `CHECKOUT_CART`); "Guest checkout must not persist card data…" (corpus.ts:495-503) is b1, PRINCIPAL_BETA. a10's searchable text includes its subject ref string (`${claim} ${subject}`, api.ts:1613), so it lexically witnesses "checkout" — load-bearing for the residue accounting.

---

## 1. Chosen rules, with rationale

Winner: the **trust** design (all three judges), grafted with recall's item-level eligibility, recall's historical traversal (hops unchanged), arch's natural-zero recall floor, empty-pack per-op contract, and perf gate. The rules:

### S1 — Evidence-placement containment ("anchor citizenship") — a PROJECTION rule

**Law.** A record's evidence anchors must be citizens of the record's claimed placement scope. A supporter counts toward an assertion only if every evidence anchor of that supporter — recovered as the objects of the supporter's derived `supported-by` assertions (graph-backfill.ts:216-257) — is placement-admissible at the assertion's scope.

**Anchor placement** is computed from `input.assertions` BEFORE visibility filtering (api.ts gathers all stores' assertions pre-visibility; `visibleTo` is applied inside projectGraph, graph-projection.ts:366): `placement(anchor)` = the set of scopes of NON-CITATION assertions (predicate ≠ `supported-by`) in which the anchor is an endpoint. `placement(anchor) = ∅` means unknown → admissible.

**Inadmissible** = `placement(anchor) ≠ ∅` and no member covers the assertion's scope: no member equals the scope and no member is global.

Two deliberate consequences of "non-citation only":
- **Self-support is structurally excluded**: a record's own `supported-by` edge is a citation and contributes nothing to its anchor's placement. No special-case exclusion is needed.
- **Citations never place content** (fixes the judge-1 shared-anchor over-kill): a global convention and a repo record citing the SAME artifact anchor both survive — the anchor's placement stays ∅ (it is an endpoint of citation edges only). An artifact cited by twenty repo records does not thereby become repo-placed.

**Enforcement.** Inside `projectGraph` (graph-projection.ts:344-380): extend the supporter-resolution at :369-372. Today a supporter is missing only if unresolvable (`!resolvable.has(ref) && !historicalSupport.has(ref)`). Add: a resolvable supporter whose anchor set is placement-inadmissible at the assertion's scope counts as missing for the same branch; if ALL supporters are missing (`missing.length === assertion.supportedBy.length`), the assertion goes to `unsupported` (:373-374 — "excluded from every trusted surface; the owner still sees it in diagnostics"). New diagnostic field, e.g. `placementInvalidSupporters: [{assertionId, supporter, anchors:[{ref, placements}]}]`, so the owner sees WHY.

**Measured effect on the frozen corpora (verified end-to-end by the trust design's probes and all three judges):** exactly one fixture dies — gd1. `LEDGER_JOURNAL`'s placement from non-citation assertions = {ledger repo} (about a11→LJ corpus.ts:717; applies-to a5/a6/a7→LJ :705-707; part-of LJ→E_JOURNAL :727 — all ledger-scoped). gd1's scope is global ⇒ inadmissible ⇒ both gd1 assertions unsupported ⇒ gd1 leaves `current`/`historical`/`timeline` ⇒ its refs drop out of `graphCandidateNodes` (graph-retrieval.ts:471-478), out of `authorizedGraphNodes` (memory-graph.ts:159-175, reads `projection.current`), and can never seed, expand, surface as a pack item, or be an explicit seed (resolves as `unresolvedRefs` — consistent with the projection's existing treatment of unresolvable supporters).
Survivors verified: g1's `ARTIFACT_TOOLING` appears in no non-citation assertion (corpus.ts:718-719 are g1's only assertions and the only edges touching g1/T_TOOLING/ARTIFACT_TOOLING) → placement ∅ → admissible. Every repo record cites same-repo symbols (placement {R} covers scope {R}) or attestation/artifact refs (placement ∅). d1, a3–a11, b1/b2, intakes, entities: unchanged.

**Foreign-repo anchor classification (judge-flagged corner):** a repo record whose evidence anchor is a symbol placed only in ANOTHER repo is inadmissible — the read-side mirror of the write-side placement law (scopeForRecord, graph-backfill.ts:146-154). No frozen fixture exercises it; flagged in §10 for the reviewer.

### S2 — Seed admission: scope placement + content-bearing, enforced at the fuse choke point

**Law A (scope placement of seeds).** For viewer scope (boundary, repoId), a node is seed-eligible iff it is an endpoint of at least one assertion **of the viewer's own scope boundary set** in the projected view:
- repo scope R: endpoint of an R-scoped current-or-historical assertion (repo-placed or repo-connected content);
- global scope: endpoint of a global-scoped current-or-historical assertion.
Global nodes with no R-scoped connection are NOT seed-eligible in R scope. Similarity and broad-topic membership confer no eligibility.

**Law B2 (content-bearing seeds).** A node may seed only if it carries caller-visible content, defined exactly as membership in `graphNodeTexts` (api.ts:1610-1628): records (`claim + subject`), intake requirements (`original + interpretation.outcome`), own-principal entities (`name`). Anchor refs, topics, and symbols never seed — their lexical "hits" are ref-syntax artifacts (e.g. `attestation:operator:alpha#retry-key` scoring lexical 1.0 on stems inside the ref). They remain fully expansion-reachable and citable as relation endpoints.

**Companion (lexical honesty):** `selectGraphSeeds` (graph-retrieval.ts:445-463) term set becomes `graphTerms(texts.get(ref) ?? '')` only — remove the `graphTerms(ref)` union at :456. A ref is an identifier, not content. (Note: a record's subject REF STRING remains inside its `graphNodeTexts` text at api.ts:1613 — that is record content by the existing definition and is NOT changed; this is why a10 legitimately witnesses "checkout".)

**Choke point.** `fuseGraphSeeds(channels, opts)` (graph-retrieval.ts:518-548) gains `opts.eligible?: ReadonlySet<string>` and drops ineligible refs before RRF. `memoryGraphExpand` (verbs.ts:3093-3168, fuse at :3129) computes the eligible set once and passes it in. This is the single funnel for all search-driven channels (recall at :3119, lexical :3120, semantic :3123), including the recall channel that bypasses `graphCandidateNodes` entirely (recallSeeds, memory-graph.ts:232-241, converts any hit with no scope/node check; timeBoundRecallSeeds :344-348 passes through unfiltered when `at`/`knownBy` are undefined). No current or future channel added to that call site can bypass.

**Recall-channel natural-zero floor (grafted from arch):** `recallSeeds` additionally drops hits with `score <= 0`. Zero is the FTS scorer's identity element; `recallProjection` returns zero-score eligible records (recall.ts:642-666) and `memorySearch` adds no cutoff (verbs.ts:3110-3112) — a production hole (inert in the harness per the inertness finding). `memorySearch` itself is untouched: plain recall, global searchability, and global-store visibility are byte-identical.

**Explicit seeds are NOT gated** (documented contract): `authorizeExplicitSeeds` (memory-graph.ts:178-190) already requires membership in the authorized current view; a caller-named ref is its own authorization basis, and `visibleTo` (the security boundary) still applies. Post-S1, an explicit ref to gd1 resolves as unresolved — the projection already excludes unsupported assertions from every trusted surface.

### S3 — Item-level scope eligibility (grafted from recall; closes trust's seed-only gap)

**Law.** A node may appear as a pack ITEM in repo R's view only via an authorized, temporally valid, supported relationship:
- (a) it is an endpoint of an R-scoped CURRENT assertion (repo-placed records/intakes/entities, and the topics/symbols/anchors connected to them by repo content);
- (b) it is carried by a current assertion whose supporters resolve to ≥1 supporter placed in R (the legal cross-scope inclusion path — e.g. capture edges admitted with the supporting source's repo, graph-eval.ts:179-228);
- (c) it is a record/intake/entity whose own placement is R (covers superseded records and finished intakes whose own edges are historical-only, so their historical relations remain citable).
Global scope: NO extra item rule — the view is already all-global by `visibleScope` (graph-projection.ts:182-186).

**Why needed (judge-1 counterexample 7):** trust's Class A gates seeds only. Repo record R with `about(R→topic:shared)` seeds lawfully; BFS reaches `topic:shared` at d1, then a global record G with its own global `about(G→topic:shared)` at d2 — G's edge is visible to the repo viewer (:184) and adjacency has no edge-scope filter (graph-retrieval.ts:159-179) — so G enters a repo pack as a CURRENT item by broad-topic membership, violating the law's item clause. S3 blocks G: no current R-scoped edge, no R-anchored supporter, not placed in R.

**Enforcement.** Filter arrivals in `expandFromSeeds` (ineligible nodes cannot be items, so dropping them at arrival also saves budget) plus defense-in-depth in `buildGraphContextPack` (graph-context.ts:138-156). Relations need both endpoints among items (:163-166), so a kept item cannot cite a filtered node. Appended completion items (S5) pass the same filter.

**Also closes the judge-1 R2 leak shape (counterexample 5):** an ACTIVE global record reached through a HISTORICAL edge is not item-eligible in repo scope (no CURRENT carrying relationship) — it can only be cited via `historicalAssertions` (:167-168) labeled historical, never surfaced as a current item. Temporal validity holds.

**Corpus sweep (no expected hop lost):** every expected hop in both corpora has endpoints that are repo-placed/repo-connected at repo scope (d1, d2, a3–a11, T_*, symbols, entities, anchors cited by repo records via R-scoped supported-by) or global content at G scope. The only global-cluster endpoints expected from a REPO view are g1's hops on h2-xr-idem-and-tooling (and possibly h2-xr-onboarding — verify, §5/§10), which are the task-acknowledged lawful losses.

### S4 — Historical-traversal alignment (grafted from recall's R2; hop count unchanged)

`expandFromSeeds` adjacency (graph-retrieval.ts:159-179) is built from `projection.current` ONLY (:164) — historical assertions (superseded/finished support) are structurally untraversable, so a finished intake or a superseded record with historicalOnly edges cannot be reached except by seeding it directly. `graphPath` already serves the same graph at up to `GRAPH_PATH_MAX_HOPS = 4` (graph-projection.ts:514, :522-571).

**Fix:** adjacency includes `projection.historical` as well (current ∪ historical, same node/edge budgets 200/500, graph-retrieval.ts:49-52). Arrivals keep today's labeling: item state from `historicalRefs` (graph-context.ts:145-150), historical relations served via `historicalAssertions` (:167-168). Item-level protection is S3's, not the traversal's.

**`GRAPH_DEFAULT_HOPS` stays 2** (graph-retrieval.ts:46 — frozen retrieval config; judges 2 and 3 both reject the 2→4 raise as a config change needing v3 confirmation). Consequence: 3-hop expectations (e.g. `about a3` reached only as d2→T_IDEM→CHARGE_API→a3) remain honest structural residuals (§5, §9) — do not "fix" them by moving a frozen constant.

### S5 — Pack completion (prefix-superset, budget-bounded)

The dominant measured recall deficit is prefix trimming: `fitGraphContext` (memory-graph.ts:320-337) keeps the largest rank-ordered prefix within `maxTokens`, and a relation needs BOTH endpoints kept (graph-context.ts:163-166), so a trimmed endpoint kills its hop even when both were reached.

**Fix.** After the prefix fit, a completion pass appends still-dropped, S3-eligible expansions — in rank order, only when the append completes at least one current relation whose other endpoint is already kept — iterating to fixed point, re-checking budget per append (marginal cost = the appended item; if the pack builder's token estimator costs assertions, charge them too; `fitTokenBudget` re-measures the rebuilt pack, memory-graph.ts:327-330). Appends NEVER reorder the prefix (first-K invariant preserved). No-op when already relation-complete. Internal test option `{ completion?: boolean }`, default on.

It cannot reopen leaks: completion only adds nodes connected to already-kept, already-authorized items through already-projected assertions, and every appended item passes S3.

### "Unsupported candidates cannot seed answer expansion" — precise meaning

A node whose graph edges are all unsupported (post-S1: gd1) is not a seed candidate in any channel, not expansion-reachable (its assertions are not traversable), not a pack item, and not explicit-seed resolvable — at every layer, because S1 removes it from the projection's trusted surfaces entirely. Additionally, no search-derived channel may introduce a node that is out-of-scope (S2 Law A) or content-free (S2 Law B2); similarity alone (semantic channel, unfloored) admits nothing outside that set. "Unsupported" and "unconnected-global" are thus both structural: no score threshold is involved anywhere.

### The demanded G-scope probe rule is UNSATISFIABLE on corpus v2 — measured, three ways

The task demands: reject g1 on the retry-window emptiness probes, admit g1 on the pnpm questions. On content alone this has no solution; every design measured it and the judges confirmed:
- g1 has ZERO stemmed-term contact with BOTH the v1 window probes ("Does any global claim set the ledger retry window?", corpus.ts:1372-1382) AND the legal questions h2-cur-pnpm-global, h2-decoy-global-conventions, h2-hist-global-2nd (graphStem graph-retrieval.ts:403-419, graphTerms :426-434; judges verified by running the real dist). So lexical corroboration fails both ways.
- The semantic channel has no floor and cannot get one: the same-node inversion — g1 must be ADMITTED at cosine ≈0.806 on h2-cur-pnpm-global and REJECTED at ≈0.820 on h2-decoy-global-key-empty — is not satisfiable by any monotone rule; must-reject gd1/a10/CART cosines (0.785-0.853) interleave the must-admit g1 band (0.790-0.826).
- The witness law (recall's B2, "abolish pure-semantic admission") cleans the probes only by zeroing the legal questions themselves (pnpm-global, conventions, hist-global-2nd go 1.0→0.0 with empty packs on expects-claims questions; installer-rule and fresh-workspace survive via 'use'/'tool' witnesses) — violating the hard constraints that g1 seed on pnpm questions and that weak-but-relevant paraphrases still seed. All three judges scored recall's recall-preservation 55-60 for exactly this.
- Support-only rules are provably insufficient: gd1 carries a derived supported-by edge.

The shipped rules therefore fix trust structurally (S1/S2/S3/S4/S5) and hand the probe-vs-legal separation to corpus v3 (§9), consistent with the pre-registered test-set-selection law (graph-gates.md §4, ~:204-207: a config change informed by v2 failures claims GO on v3 regardless).

---

## 2. Per-file change list (exact signatures)

1. `packages/memory/src/graph-projection.ts` — S1, inside `projectGraph` (no signature change):
   - Precompute `placement(ref): Set<scopeKey>` from `input.assertions` (pre-visibility), counting only predicates ≠ `supported-by`; scope key = `global` or `repo:<repoId>`.
   - Compute each record's anchor set from its derived `supported-by` assertions (subject = record id).
   - Extend the missing-supporter predicate at :369-372: supporter is missing if unresolvable OR its anchor set is non-empty and no anchor's placement covers the assertion's scope.
   - Extend `GraphProjectionDiagnostics` with `placementInvalidSupporters` entries (assertion id, supporter, anchor refs + placements).
2. `packages/memory/src/graph-retrieval.ts`:
   - `GRAPH_SEED_SCORER_VERSION` (:341) → `'graph-seed-v3:placement-eligible+content-bearing+historical-traversal+pack-completion'`.
   - `selectGraphSeeds` (:445-463): term set at :456 becomes `graphTerms(texts.get(ref) ?? '')` (signature unchanged).
   - `graphCandidateNodes` (:471-478): unchanged (S1 already shrinks the assertion universe).
   - NEW export `seedEligibleNodes(projection: GraphProjection, texts: ReadonlyMap<string, string>, viewerScope: { boundary: 'repo'; repoId: string } | { boundary: 'global' }): Set<string>` — candidates ∩ content-bearing (`texts.has(ref)`) ∩ S2 Law A placement (scopes of the view's current/historical assertions).
   - `fuseGraphSeeds(channels, opts?: { limit?: number; eligible?: ReadonlySet<string> })` (:518): drop refs not in `eligible` before RRF.
   - `expandFromSeeds` (`GraphExpansionOpts`, :191-196): NEW opts `itemEligible?: ReadonlySet<string>` (S3 arrival filter) ; adjacency at :159-179/:218 built from `projection.current` ∪ `projection.historical` (S4). Default hops (:46), budgets (:49-52), decay, `eligibleSupporters` semantics unchanged.
3. `packages/memory/src/graph-context.ts` — defense-in-depth only: `buildGraphContextPack` (:138) drops items failing the S3 set when passed via opts (the expansion filter is primary; keep the pack builder total when not passed).
4. `packages/mcp/src/memory-graph.ts`:
   - `recallSeeds(recalled)` (:232-241): drop hits with `score <= 0` (natural zero).
   - `fitGraphContext` (:320-337): completion pass (S5) appended after the prefix fit; signature unchanged; internal `{ completion?: boolean }` test option acceptable.
   - `graphViewGeneration` (:74-93), `authorizedGraphNodes` (:159-175), `authorizeExplicitSeeds` (:178-190), `timeBoundRecallSeeds` (:344-348): unchanged.
5. `packages/mcp/src/verbs.ts` — `memoryGraphExpand` (:3093-3168):
   - After `const texts = ...` (:3117): `const eligible = seedEligibleNodes(graph, texts, scope)`; `fuseGraphSeeds(channels, { eligible })` at :3129.
   - Compute the S3 item-eligible set (same placement data) and pass to `expandFromSeeds` at :3131-3134 as `itemEligible`.
   - Zero-eligible-seed `context` returns the normal empty pack (`items: []`, `assertions: []`, generation + seedScorer present) — NEVER the `unavailable` shape (reserved for projection failure, :3170+; harness maps `res.context === undefined` to unavailable, graph-eval.ts:319).
   - `memoryConnectedGraph` default `maxTokens` 2_000 unchanged.
6. No changes to: `visibleScope`/`visibleTo` (graph-projection.ts:182-192), plain `memorySearch`/recall (recall.ts:642-666, api.search), `graphNodeTexts` (api.ts:1610-1628), backfill derivation, intake placement, the frozen corpora, the frozen harness (`GRAPH_EVAL_HARNESS_VERSION` stays 2, graph-eval.ts:47).

---

## 3. Violation-by-violation kill table (all 11 heldout-v2 + 3 v1 rows)

Scoring: forbidden = forbidden id in `currentItemRefs` (graph-eval.ts:382); emptiness = 0-hop/0-claim probe with any pack assertion (:369-370, :383); a hop is found if its (predicate, from, to) appears in any pack assertion (:361-367).

| Question | Scope | Today's mechanism | Killing rule | Post-fix |
|---|---|---|---|---|
| h2-cur-pnpm-global | G | gd1 sem ~0.796 seeds (no floor, graph-retrieval.ts:490-510) and surfaces as a current item alongside the correct g1 | **S1** (gd1 unsupported everywhere) | forbidden 0; recall stays 2/2 — g1 is global-placed, content-bearing, S2-eligible at G scope; unfloored semantic still admits it |
| h2-decoy-global-conventions | G | gd1 top-2 semantic (~0.853); found 2/2 via g1 | **S1** | forbidden 0; recall 2/2 preserved |
| h2-decoy-global-key-empty | G (emptiness) | gd1 sem ~0.816; LedgerJournal seeds lexically via ref-path tokens (:456) | gd1: **S1**. LedgerJournal: **S2-B2** (symbol — no `graphNodeTexts` entry) + ref-term removal | forbidden 0; **emptiness STAYS VIOLATED via g1's cluster** (g1 pure-semantic ~0.78-0.82, no floor; §1 impossibility) — documented residue |
| h2-decoy-global-wait-empty | G (emptiness) | gd1 has a GENUINE lexical witness ('retries'→'retry') + sem ~0.810 | gd1: **S1** (killed despite the genuine match — the proof that no score rule works) | forbidden 0; **emptiness residue via g1's cluster** |
| h2-decoy-checkout-idem-empty | C (emptiness) | gd1 visible/seeding from repo scope; PLUS a10 (corpus.ts:467-477) — alpha's own checkout record, checkout-placed, content-bearing, lexical witness 'checkout' via its subject ref in record text (api.ts:1613) | gd1: **S1 + S2/S3** (global, unconnected to checkout → not seedable, not an item at C scope) | forbidden 0; **emptiness STAYS VIOLATED via a10** — no placement or content rule can reject a legitimately-placed, genuinely-matching own-repo record; residue routed to corpus v3 (content-distant probes) |
| h2-decoy-not-http | L | gd1's global assertions visible to the repo viewer (graph-projection.ts:184) → candidate (graph-retrieval.ts:471-478) → surfaces; found 2/2 | **S1** (dead in the projection) + S2/S3 belt-and-braces | forbidden 0; recall 2/2 preserved |
| h2-decoy-switch-to-put | L | same leak; found 3/3 | **S1** | forbidden 0; recall 3/3 |
| h2-xr-idem-and-tooling | X (every repo, merged; graph-eval.ts:440-446) | forbidden gd1; the one FOUND hop (about g1→T_TOOLING) is reachable ONLY through the leak (artifact-anchor seed → g1 at d1); legit hops d2About + affects(T_IDEM→SETTLE) missing (crowding + trim) | gd1: **S1**. g1's cluster at repo scope: **S2/S3** (no repo-scoped assertion touches g1/T_TOOLING/ARTIFACT_TOOLING — corpus.ts:718-719 are the only edges; no legal path exists). Legit hops: **S2 slot relief + S5 completion** | forbidden 0; **2/3 — the g1About hop is LOST BY DESIGN** (§5); do not "fix" with a threshold |
| q-decoy-window-emptiness-e/-p/-c | G (emptiness; corpus.ts:1372-1382, forbidden [gd1, g1]) | gd1 lexical+sem seeds; LedgerJournal ref-term lexical; g1 sem ~0.78-0.81; pack non-empty; BOTH forbidden ids surface | gd1: **S1**. LedgerJournal: **S2-B2** + ref-term removal. g1: **NOT killable without tuning** (§1) | forbidden 2→1 per row (**g1 residue**); **emptiness stays violated via g1's cluster** — residue, corpus v3 |

Net: **heldout-v2 forbidden 8 → 0; emptiness 3 → 3 residue** (key-empty, wait-empty via g1 cluster at G scope; checkout-idem-empty via a10 at C scope). **v1: all 3 violating rows lose gd1, keep g1** (forbidden-by-id 6→3; the 3 rows still violate), emptiness 3 → 3 residue. Zero new violation classes: every rule only removes candidates/items; the empty-pack contract keeps `unavailableAnswers` 0 (a zero-seed read is a valid empty answer, not a graph failure — and the emptiness gate in the harness is precisely the regression detector for over-rejection).

Must-keep-passing (verified): the five G-scope legals (pnpm-global, installer-rule, fresh-workspace, hist-global-2nd, conventions) — g1 seeds as a record at G scope (S2 admits; S2-B2 excludes only ref-only nodes; no witness law ships, so zero-contact paraphrases still seed — installer-rule has a 'use' witness, fresh-workspace 'tool', the rest pure-semantic). v1 q-cur-tooling-convention (G, expects g1's about + supported-by): g1 seeds, anchor enters at d1, completion keeps it. Isolation family: every gate narrows within the authorized projection; `visibleTo` untouched → beta's views only narrow → 1.0 preserved.

---

## 4. Recall-mechanism fix table

| Missing-hop pattern | Root cause (file:line) | Fix |
|---|---|---|
| `affects T_IDEM→SETTLE_ORDER` (→chargeOrder) — ~14 questions across families | Endpoints reached by BFS but land at low rank; `fitGraphContext` keeps the largest rank-ordered prefix within 2000 tokens (memory-graph.ts:320-337) and a relation needs BOTH endpoints (graph-context.ts:163-166), so the trimmed endpoint kills the hop | **S5 completion** (appends the partner of an already-kept relation) + **S2 slot relief** (junk seeds gone: post-S1 gd1, ref-only nodes, unconnected globals no longer crowd the 5 RRF slots, graph-retrieval.ts:347) |
| `supersedes d2→d1`, `about d1→T_IDEM` — ~8 questions | (i) d2/d1 not seeded (crowding); (ii) d1's own derived edges are historicalOnly (graph-projection.ts:376, :404-409) and adjacency is current-only (graph-retrieval.ts:164), so d1 unreachable from topic-side seeds; (iii) trim | (i) **S2 slot relief**; (ii) **S4 historical traversal** (d1 reachable at 1 hop from T_IDEM via its historical about edge; the supersedes edge from d2 is current); (iii) **S5**. d1 is item-eligible by placement (ledger record; S3(a)/(c)); arrives labeled historical (historicalRefs, graph-context.ts:149) |
| Conflict pair a5/a6 (`contradicts`, `applies-to`/`supported-by` → LEDGER_JOURNAL, `about` → T_RETRY_WINDOW) — h2-conf-tuning 0/4, conf-journal-all 1/4, conf-source-lines 1/3 | Seed-slot crowding: attestation/anchor ref-seeds score lexical 1.0 on ref stems (:456) and take RRF slots, so a5/a6 (real records) never seed; when they do expand at low rank, the prefix trims them | **S2-B2 + ref-term removal** (a5/a6 regain slots); **S5** keeps both endpoints; conflict groups then ride whole (graph-context.ts:169-174) |
| Intake about-edges (I_OPEN→T_IDEM current; I_DONE→T_IDEM historical) — work family zeros | I_DONE's about edge is historicalOnly (finished intake → historicalRecords → :376) and untraversable; I_OPEN's topic partner trimmed; intake slots crowded | **S4** (historical traversal reaches I_DONE at 1 hop from its topic; served from `historicalAssertions`, graph-context.ts:167-168), **S2-B2** (intakes have text, api.ts:1615-1617 — they stay seedable), **S5**; S3(c) keeps finished intakes item-eligible by their own placement |
| `about a3/a4 → symbols`, `part-of sym→entity` — h2-ren-rule-target-now 0/3, h2-xr-functions-where 3/6, h2-xr-onboarding 4/6 | Crowding + trim (a4's 'renamed' token matches few queries; entities/symbols seeded only via ref fragments) | **S2 slot relief + S5**. Residual: `about a3` reachable only as a 3-hop path from d2-side seeds — **hops stay 2 (frozen)** → honest structural residual (§5, §9), not fixable without unfreezing a config constant |
| `supported-by d2→attestation/artifact` anchors — h2-cur-runbook-edit, h2-work-close-out | Anchor partner trimmed; both-endpoints rule kills the relation | **S5** completes it; anchors stay non-seeding (S2-B2) but expansion/citation-reachable — the intended asymmetry |

Recall-channel inertness (judge-verified): `considered: 12, eligible: 0` on every harness question — evaluator.ts:923 ('candidate') + :954-962 (`local|team`). The B3/FTS>0 recall gates are production defense, not measured-corpus levers; report as a separate pre-freeze work item (the gates doc's "recall hits fused by reciprocal rank" currently overstates what was measured — amend the doc text, not the harness).

---

## 5. Reachability risks and honest consequences

**Designed losses (certain):**
- `about g1→T_TOOLING` on h2-xr-idem-and-tooling — reachable today ONLY via the leak; no repo-scoped assertion connects g1's cluster to either repo (corpus.ts:718-719). Post-fix the question caps at **2/3** (both legal hops recovered). This is the single intended recall loss.
- **h2-xr-onboarding risk:** arch claimed it also expects a g1-cluster hop (4/6 today). VERIFY its `expected.hops` in heldout-v2.ts before landing; if a global-cluster hop is expected from a repo view, it is lost by the same law and the foundHops non-decreasing gate must name it explicitly (predicted loss ≤1 hop; the aggregate estimates below absorb it).
- gd1 as a current item everywhere — the trust fix, not a recall loss (no question in either corpus expects a gd1 hop).

**Residue (not fixable without tuning; measured three ways, §1):** g1's cluster keeps seeding at G scope on key-empty/wait-empty/window probes (emptiness residue ×5 rows: 2 v2 + 3 v1; v1 also keeps forbidden-g1 ×3 rows); a10 keeps seeding at C scope on checkout-idem-empty (emptiness ×1). The launch gate "zero forbidden/emptiness" therefore STILL FAILS post-fix on both corpora. Honest statement: WP2 takes v2 forbidden 8→0 and kills the unauthorized class everywhere; the residue is a corpus-v3 dependency (§9), and GO on the launch gate requires v3 regardless (graph-gates.md ~:204-207).

**Principal falsifiable risk:** currently-found hops whose pack entry today depends on a ref-syntax SEED (artifact/attestation/topic/symbol). Diagnosis says every such hop is recoverable from a content-bearing seed (anchors/topics are 1 hop from their records; symbols 1 hop from about/applies-to) plus S5 completion — but this must be verified by the per-row `foundHops` diff (§8): non-decreasing on EVERY multiHop row except the named global-cluster losses; any other decrease falsifies the design. Localization tool: re-run the channel probe comparing fused seeds pre/post.

**90% arithmetic (honest bands, not promises):**
- v1: baseline 0.85655 (117 multi-hop; 46 missing hops). Mechanisms cover the trim + crowding + historical families; minus the frozen-2-hop a3About residual and the v1 corpus-construction residuals (graph-gates.md:186-191). Predicted band **0.89-0.94**, floor the 0.85655 baseline.
- heldout-v2: baseline 0.86940 (116 multi-hop; 49 missing hops); xr-idem nets +1/3 (its g1About loss is outweighed by 2 recovered hops); xr-onboarding ≤1 hop risk absorbed. Predicted band **0.90-0.94**, floor the baseline.
- If a measured number lands < 0.90, the freeze forbids sweeping: ship with per-pattern attribution and route to corpus v3.

---

## 6. Cache / generation / version effects

- `graphViewGeneration` (memory-graph.ts:82-93) digests projection CONTENT (viewer/at/knownBy/aliases/conflicts/current). S1 changes projection content (gd1's assertions leave current/historical) → digests change automatically → `cachedGraphView` entries and page cursors (bound to generation, encodeGraphCursor) invalidate correctly with NO code change. No cache key change is needed across a code deployment (in-process caches do not survive the upgrade).
- `graphVectors` (verbs.ts:3242-3254): keyed by embedder id + text; `graphNodeTexts` unchanged → cache keys unchanged; only fewer nodes are embedded for seed selection (expansion texts unchanged).
- `GRAPH_SEED_SCORER_VERSION` → `graph-seed-v3:placement-eligible+content-bearing+historical-traversal+pack-completion` (graph-retrieval.ts:341). Reported per response (verbs.ts:3137) and per report (`seedScorer`, graph-eval.ts:484); update any pinned test assertions.
- Frozen-parameter checklist — NOTHING here moves: `GRAPH_DEFAULT_SEED_LIMIT=5` (:347), `GRAPH_SEED_RRF_K=60` (:344), `GRAPH_DEFAULT_HOPS=2` (:46), `GRAPH_MAX_VISITED_NODES/EDGES=200/500` (:49-52), `GRAPH_DEFAULT_CONTEXT_TOKENS=2000`, `GRAPH_PATH_MAX_HOPS=4` (graph-projection.ts:514), `GRAPH_EVAL_HARNESS_VERSION=2`, corpusVersion 1 + heldout 2, embedder id. The only new "thresholds" are the recall channel's natural zero (FTS identity element) and structural set-membership tests (placement, content) — no swept numbers.
- `projectGraph`'s `unsupported` diagnostics legitimately grow (gd1's two assertions + the placement reason). `exportGraphProjection` shape unchanged.

---

## 7. Test plan

Existing suites must stay green: packages/memory (1,109), packages/mcp (468). No fixture edits to the frozen corpora.

`packages/memory/src/graph-projection.test.ts` — S1: (a) gd1 shape (global record, repo-symbol source-quote anchor placed by repo-scoped non-citation assertions) → ALL its derived assertions `unsupported`, absent from current/historical/timeline; (b) g1 shape (global record, artifact anchor in no non-citation assertion) → unchanged; (c) repo record citing same-repo symbol → unchanged; (d) SHARED-ANCHOR: global record + repo record citing the same artifact → BOTH survive (citation edges place nothing); (e) foreign-repo anchor (repo record, symbol placed only in another repo) → unsupported (pin the classification); (f) diagnostics name the placement-invalid supporter and the anchor placements.

`packages/memory/src/graph-retrieval.test.ts` — S2: repo-scope eligibility admits repo-placed + repo-connected nodes, rejects unconnected globals; global-scope admits global-placed, rejects repo-placed. B2: anchor/topic/symbol/other-principal-entity are expansion-reachable and relation-endpoints but never in `seedEligibleNodes`; records/intakes/own entities are. Lexical: a ref whose IDENTIFIER matches query stems scores 0 after the :456 change (attestation:…#retry-key vs "retry"); record text matches still score. `fuseGraphSeeds` drops ineligible seeds regardless of channel order. S4: adjacency traverses a historicalOnly edge; arrival labeled via historicalRefs. S3: an arrival outside the item-eligible set is dropped. `GRAPH_SEED_SCORER_VERSION` equals the v3 string.

`packages/memory/src/graph-context.test.ts` — S5: (a) prefix dropping one endpoint of an otherwise-kept relation regains it within budget; (b) chains complete across passes (topic, then settleOrder); (c) first-K prefix identity (appends never reorder); (d) budget-exhausted prefix adds nothing beyond budget (assert total ≤ maxTokens); (e) no-op when relation-complete; (f) zero expansions → 0-item/0-assertion pack, no crash.

`packages/mcp/src/memory-graph.test.ts` — recallSeeds drops score-0 hits; timeBoundRecallSeeds windowing unchanged; context with zero eligible seeds returns `items: [], assertions: []`, generation present, NOT the unavailable shape; neighbors/path/history ref requirements unchanged (memory-graph.ts:211-230).

`packages/mcp/src/verbs-memory-graph.test.ts` — THE core regression: repo-scope `context` where a global decoy is visible-but-unconnected → absent from items/relations/assertions; the same query via plain `memorySearch` still returns the decoy (law: global memories stay searchable). Global scope: visible global record still seeds. Explicit authorized global ref still seeds neighbors/path (documented bypass). Isolation: beta's views unchanged. Shared-topic counterexample (S3): repo record + global record sharing a topic — global record absent from the repo pack.

---

## 8. Measurement protocol + acceptance gates

```bash
pnpm --filter @knowledge-crib/memory build && pnpm --filter @knowledge-crib/mcp build
node scripts/graph-eval.mjs --out docs/program/eval/graph-eval-v1-postwp2.json
node scripts/graph-eval.mjs --corpus heldout-v2 --out docs/program/eval/graph-eval-heldout-v2-postwp2.json
node scripts/graph-bench.mjs    # perf: warm read p95 <= 500ms with the extra placement pass
pnpm verify
```

Acceptance on BOTH reports (baselines v1 0.85655 / v2 0.86940):
- `unauthorizedPaths: 0`; `unavailableAnswers: 0`; isolation byFamily meanRecall = 1.0.
- **heldout-v2: forbiddenViolations 0** (all 8 rows clean). **v1: every violating row's `forbiddenSurfaced` contains ONLY g1** (gd1 gone; 3 rows still violate via g1).
- **Emptiness residue, exactly enumerated:** v2 — key-empty, wait-empty (g1 cluster), checkout-idem-empty (a10); v1 — the three window-emptiness rows (g1 cluster). Any OTHER emptiness or forbidden id is a regression.
- `evidencePathRecall ≥ 0.86940` (v2) and `≥ 0.85655` (v1); target ≥ 0.90 (band §5). Measured ONCE; no post-measurement adjustment.
- Per-row gate: `foundHops` non-decreasing on every multiHop row EXCEPT h2-xr-idem-and-tooling (1/3→2/3, the designed loss) and — if verified — one global-cluster hop on h2-xr-onboarding. Any other decrease falsifies the design.
- h2-xr-idem-and-tooling: assert forbidden 0 and found = 2/3.
- `seedScorer` = v3 string in both reports; `embedderId` non-null; harness version 2 unchanged.
- graph-bench p95 gate holds (the placement/eligibility passes are O(V+E) per request over the same view adjacency already scans).

**Freeze checklist** (behavior + retrieval config freeze, BEFORE corpus v3 authoring): record the v3 scorer string, both report paths, corpus versions, embedder id, harness version; both suites green; amend the gates doc's recall-channel description to note the harness inertness (doc text only); then freeze. The GO claim itself rides on corpus v3 (graph-gates.md ~:204-207).

---

## 9. Freeze notes + corpus v3 coverage gaps

Frozen now: both corpora, harness v2, all retrieval constants (§6), the baselines, and the new behavior once measured. Corpus v3 (independent author, AFTER the freeze) MUST add:
1. **Legal-inclusion fixture** — NO existing fixture demonstrates a repo answer legitimately including a global claim through an authorized, supported, repo-connected relationship (S3(b)). Add one: a capture-scope assertion connecting a global record to repo content (admitted via a leased extraction job with the supporting source's repo, graph-eval.ts:179-228), asked at repo scope; it exercises S2's repo-connected admission AND S3(b) end to end.
2. **Content-distant emptiness probes** — the G-scope (window/key/wait) and C-scope (checkout-idem) probes share stems/similarity with universe content (g1 ~0.78-0.82; a10 has a genuine 'checkout' witness via its subject ref): no retrieval-side rule separates them from legal questions (§1 same-node inversion). Re-author with zero stemmed overlap and semantic distance from every universe text, or re-scope to repo scope where S2/S3 yield lawful emptiness; consider enlarging the global universe so top-k semantic selection is meaningful.
3. **DONE-intake seeding fixture** — a question whose only path to a historical about-edge is a finished intake seeding (exercises S4 end to end).
4. **Shared-anchor fixture** — a global convention and a repo record citing the SAME artifact (pins S1's citation-does-not-place rule against regression).
5. (If the a3About 3-hop pattern matters) either accept it as out-of-reach at the frozen 2-hop default, or re-author those questions at ≤2 hops — do NOT unfreeze the hop count for v2-era failures.

---

## 10. Open decisions for the principal reviewer

1. **Foreign-repo evidence anchors** (S1 classification): a repo record whose source-quote anchor is a symbol placed only in ANOTHER repo becomes unsupported. Mirror of the write-side placement law, but it is a NEW hard failure mode no fixture exercises. RECOMMEND: ship as specified (consistent, diagnosable), and add a v3 fixture + a capture-time warning so the owner learns at write time, not read time.
2. **Historical traversal at global scope** (S4): a principal's own global content reached through a superseded-time edge surfaces with its own lifecycle state. Within the viewer's own rights; no cross-principal or cross-scope surface is affected (S3 governs repo scope). RECOMMEND: ship; note in the law doc that temporal validity for CURRENT surfacing is enforced at repo scope, and global-scope history is the viewer's own.
3. **h2-xr-onboarding expected-hops audit** (§5): verify whether it expects a g1-cluster hop from a repo view before landing; if yes, add it to the named-losses gate. RECOMMEND: verify first; predicted impact ≤1 hop, absorbed by the band.
4. **Harness recall-channel inertness**: fix `isRecallEligible`/harness trust stamping so the recall channel actually contributes (would change plain recall — out of WP2 scope). RECOMMEND: separate work item BEFORE the freeze (it changes what the frozen config claims to measure), but do NOT block WP2 on it; document the inertness in the gates doc.
5. **The residue and the launch gate**: post-fix, forbidden/emptiness still fail on both corpora (g1 cluster, a10). RECOMMEND: accept the residue as measured impossibility (§1), record it in the launch plan (G-R2), and gate GO on corpus v3 — which the test-set-selection law already requires.
6. **Explicit-seed bypass of S2/S3**: a caller naming an authorized ref still gets it as a traversal anchor (neighbors/path/history). RECOMMEND: keep (visibleTo is the security boundary; explicit intent is its own authorization); the frozen eval never exercises refs, so no gate depends on this reading.