# WP4 Implementation Spec — Code retrieval, measured

Program: Developer Trust (`docs/program/developer-trust-plan.md` §2 WP4).
Status: **SPEC — not yet implemented.** §1–§4 are plan-derived and fixed. §5–§9 are filled from a
read-only grounding pass over the tree at `b4615721`, and every load-bearing claim carries its source
or its measurement — marked **[V]** (verified by reading the cited source in this pass), **[M]**
(measured, artifact named), or **[R]** (reported by another document, not re-verified here).
**§10 is a pre-registration: it is written before any WP4 measurement and is FROZEN once the deciding
run starts.** Its results are appended under `§10 RESULTS` and are never folded back into the rule.
Baseline for this spec: branch `program/developer-trust` @ `b4615721`.

**Read §5 before §6.** Three of WP4's six bullets are already implemented and measured; a spec that
re-planned them would spend the whole work package rebuilding what exists, and one that silently took
credit for them would misreport the work package as finished. §5 states what is built, with evidence.
§6 states what is genuinely owed.

**Before implementing:** §10's budgets are the load-bearing product decision. WP4's exit is "published
quality/resource measurements **replace** unsupported scale or semantic-search claims" — so the
budgets decide, in advance, what claim the program is allowed to publish. §15 records the three
choices the principal reviewer may want to move before §10 freezes.

---

## 1. The requirement, verbatim, and what "done" means

The plan states WP4 as six obligations:

1. "Add an opt-in code-search embedding path through the existing backend interface, using the
   installed local model."
2. "Keep vectors derived and rebuildable, keyed by source content and model revision. Batch embedding
   work and update only changed content."
3. "Preserve lexical search when the model is unavailable, with explicit capability/degradation
   reporting."
4. "Evaluate exact-symbol, natural-language, cross-file, rename, and dependency questions separately."
5. "Measure cold indexing, incremental updates, query latency, memory, and disk usage on fixed 10k,
   100k, and 500k LOC fixtures."
6. "Promote hybrid search to default only after independent evaluation shows improved natural-language
   retrieval, no exact-symbol regression, and compliance with preregistered resource budgets.
   Otherwise retain opt-in status."

**Exit:** "published quality/resource measurements replace unsupported scale or semantic-search
claims."

What "done" means, stated so it can be checked rather than felt:

- **D-a.** Each of the five question categories in bullet 4 has a **number**, published, with the
  harness that produced it named — **including the categories where hybrid loses**, and including
  rename, which today has no evidence of any kind.
- **D-b.** Cold indexing, incremental update, query latency, memory, and disk are measured for the
  **vector** path at exactly 10k/100k/500k LOC, because the committed curve covers the lexical path
  only and says so in its own text.
- **D-c.** The promote/retain decision is **written down with the rule that produced it**, applied as
  written, and the rule was frozen before the numbers existed.
- **D-d.** No sentence in the published docs claims a scale, a latency, or a semantic-search
  advantage that the measurements above do not support. Where a claim is unsupported, it is
  **withdrawn or labelled**, not softened.

D-a is the sharpest of the four, because the repository's own published evidence is currently
*negative* on exactly this question (§5.5) and a work package that only adds a faster build would not
satisfy its own exit condition.

## 2. Acceptance and regression rows this work package must satisfy

From `developer-trust-plan.md` §4:

| Row | Requirement as applied to WP4 |
| --- | --- |
| **Connected retrieval** | "Independent held-out v3; ≥90% path recall; zero forbidden/unauthorized results." WP4 does not set this threshold and must not appear to. It measures the **code** retrieval channel; the v3 path-recall gate is WP2's and stays frozen. |
| **Performance** | "Preserve existing graph targets: bounded warm reads ≤500ms p95, context assembly ≤1s, update visibility ≤2s on the specified workload." The hybrid path is opt-in today, but bullet 6 makes it the default if it passes, so the hybrid path must be shown **not** to break these while opt-in. |
| **Refactoring** | "CLI/MCP contract tests, full workspace checks, package boundaries, browser acceptance, packaging and install smoke tests." `--vectors` is a CLI contract; its refusal path is asserted (§12). |

From `docs/bench/perf-gates.md` **[V]** — the gates the hybrid path may not quietly move:

| Gate | Threshold | Measured (lexical) |
| --- | --- | --- |
| Warm local recall p95 @ 10k | < 100 ms | **8.3 ms** PASS |
| Warm local recall p95 @ 100k | < 300 ms | **132.8 ms** PASS |

(The 100k number carries 132.8 ms against a 300 ms ceiling — a 2.26× margin. §10's latency guard is
written to stay inside it rather than to consume it.)

## 3. Interfaces and compatibility this spec must not break

`developer-trust-plan.md` §3 names two interfaces WP4 owns:

- "Introduce an internal request-scoped evidence resolver and **optional index embedder
  configuration**." The optional index embedder configuration is the half that is **already landed**
  (§5.1) — its shape is now a compatibility surface, not a proposal.
- "Keep canonical memory identities stable. **Rebuild derived indexes when model or projection
  versions change.**" Vectors are derived; the rebuild rule is what §7 must not weaken.

Additional constraints this spec holds itself to:

- `buildFromSoul` is **synchronous by contract**, and `runtime.ts` has a test pinning it **[V]**. The
  embedder is therefore resolved asynchronously by the caller and handed in; batching (§7) must not
  make the build asynchronous.
- `Embedder.embedBatch(texts)[i]` **MUST equal** `embed(texts[i])` **[V]**, `types.ts` — every change
  in §7 is bound by this.
- `Embedder.id` "must change whenever the embedding behaviour changes. It keys crib's persistent
  vector cache." **[V]** The `id` is part of the cache key and of `vector_meta`; §7 does not change it.
- Vectors are **gitignored** (`.gitignore` excludes `.crib/index/`, which is the whole index directory
  and therefore the `vectors` table inside `crib.sqlite`) **[V]**, and are a derived artifact — a
  rebuild is always allowed to discard them.
- The CLI contract `crib index --vectors` / `crib reindex --vectors` keeps its name, its refusal exit
  code, and its refusal message **[V]** (`cli.ts`).

## 4. Honesty rules for this work package

WP4 is the work package whose **exit condition is about claims**, so its honesty rules are the
deliverable, not the packaging. Carried from the plan's own method:

- **H-1. A negative result ships as a negative result.** This is R1's and R2's rule
  (`retrieval-pre-registration-r2.md` §5.5) and it applies here hardest: the published localisation
  evidence (§5.5) is currently negative for crib. WP4 may not "fix" that by framing.
- **H-2. Freeze before measuring, append after.** §10 is written before the deciding run. Its numbers
  go under `§10 RESULTS`. Editing a §10 rule after seeing a number voids the run — that is precisely
  the test-set-selection error R2 was written to correct.
- **H-3. No self-evaluation.** A passing local gate is a receipt, not a verification claim. WP4 states
  what it measured; the freshness engine and the principal derive the verdict.
- **H-4. The five categories are reported separately, and a category is not averaged away.** A single
  blended MRR is the framing this work package exists to remove.
- **H-5. Blinding must be disclosed, not assumed.** The same agent authored the corpus, the harness,
  and (prospectively) the code under test. That is a **regression gate, not an external benchmark**,
  and §10 must say so in the same terms R1 used rather than implying an independence it does not have.
- **H-6. A measurement that did not run is reported as not having run.** Today's eval harness can print
  a lexical-vs-hybrid report with the hybrid column **silently absent** (§5.6) and exit 0. That is the
  single most important harness fix in this work package: a report that cannot distinguish "hybrid
  lost" from "hybrid never ran" is not evidence.
- **H-7. The word "semantic" is not a claim.** The word may appear in a doc only next to a number from
  §8, or next to an explicit statement that no such number exists.

## 5. What already exists — so this spec neither re-plans it nor claims credit for it

### 5.1 The opt-in embedding path exists and is reachable **[V]**

The audit finding F1 (`docs/audits/2026-09-20/graph-memory-rag-audit.md`) was that the code-graph
vector path was **unreachable**: the store took an optional embedder but no production call site
passed one, so `capabilities().vector` was permanently false, `vectorQuery()` never executed, and all
of `packages/core/src/index/rerank.ts` was dead in production. The register records F1 as **verified
fixed** in `d28fc17f` (evidence register row F1).

What landed, all re-verified here:

| Surface | Evidence |
| --- | --- |
| `OpenIndexOpts.embedder?: Embedder \| null`, forwarded by `openIndex(backend, opts)` into `SqliteIndexStore` | `packages/core/src/index/factory.ts` **[V]** |
| The embedder is threaded through all five entry points | `runtime.ts` — `buildIndex(rt, embedder?)` (:261), `openIndexOnly(rt, embedder?)` (:368), `openIndexForServe(rt, embedder?)` (:402) **[V]** |
| `--vectors` is a real, documented opt-in on `index` and `reindex` | `cli.ts` (:1192, :2575), identical rationale in both places **[V]** |
| The embedder is resolved from the **installed** tier | `resolveCodeVectorEmbedder()` `cli.ts` (:1416) **[V]** |
| A query-time open can upgrade a lexical index | `upgradeIndexToVectors`, `cli.ts` (:1430) **[V]** |

### 5.2 It refuses rather than degrading silently **[V]**

`--vectors` with no installed tier exits `EXIT.BAD_ARGS` with a message that names the reason and
states why it will not fall back. The refusal is not politeness — it encodes a measured result:
building char-n-gram vectors measured **worse** than lexical-only (R1). A silent fallback would
publish a "hybrid" number produced by an arithmetic n-gram, which is the class of unsupported claim
this work package's exit condition targets.

### 5.3 Degradation reporting exists, with four named cases **[V]**

`restoreVectorMeta()` (`sqlite-index.ts`) decides one of four outcomes on open and **never throws**;
`textVersion` defaults to 1 for pre-versioning indexes. It sets `vectorUnavailable` to one of three
specific messages (:263, :272, :276) — a text-recipe mismatch, a dim mismatch, an embedder-id
mismatch — and `capabilities()` (:577) reports `vector: this.builtEmbedderId !== null` together with
`vectorNote`. That is the "explicit capability/degradation reporting" bullet 3 asks for, including
the honest case where a lexical index is opened with an embedder and the vectors are still refused
because they were built by a **different** model revision.

### 5.4 Vectors are derived, rebuildable, and versioned **[V]**

- Vectors live in the `vectors` table and are authorized by `vector_meta`, written **in one
  transaction with the vectors themselves** so an interrupted build cannot leave metadata claiming a
  channel the table does not back **[V]**.
- Identity is three-part: `embedderId` + `dim` + `VECTOR_TEXT_VERSION` (`= 2`, :91) **[V]**, written by
  `writeVectorMeta` (:284). "Keyed by source content and model revision" is therefore **true at the
  identity level**: change the model or the text recipe and the vectors are refused rather than used.
- `applyDelta` re-embeds changed nodes when the channel is live, and when it is not, **deletes** their
  vectors rather than leaving them — with the rationale recorded in-source that a stale vector "is a
  wrong answer that looks right" **[V]**.
- The adapter memoizes vectors on disk keyed by `sha256(text)` under `~/.cache/crib-embed-vec/<id>/`
  **[V]** (`embed-setup.ts`), so unchanged text never re-runs the model. This is the honest part of
  "update only changed content" — it already holds **at the model layer**.

### 5.5 The published code-retrieval evidence is negative, and it is published **[M]**

`docs/bench/localisation.md`, measured 2026-09-21, base `d872789840b4`, k = 10, from this
repository's own history with no hand-labelling (61 localisation tasks; 75 co-change tasks from 25
commits):

| Method | MRR |
| --- | --- |
| crib full-message | 0.323 |
| grep-bm25 | **0.478** |
| **churn (query-blind)** | **0.501** |
| `crib-impact` co-change | 0.357 |
| `cochange` | 0.441 |
| churn on the co-change task | 0.640 |

Three things in that table matter more than the ordering:

1. **A query-blind control beats every method that reads the question.** "Always guess the busiest
   files" scores 0.501. Any retrieval claim that has not cleared that bar has demonstrated nothing.
2. Stripping the `fix(freshness):` scope from the query costs crib **18% of its MRR** — so a large part
   of what the lexical path retrieves is the *words of the commit message*, not the code.
3. **H2 is preregistered and untested**: "crib's localisation MRR rises above grep-bm25's when the
   query is a symbol-bearing question rather than a change description — i.e. the gap above is a
   property of the task, not of the index. **If H2 fails, the retrieval path needs work, not
   framing.**" WP4's §8 is the first harness that can test H2, because it separates exact-symbol from
   natural-language questions for the first time.

### 5.6 The evaluation machinery exists, with two named limits **[V]**

- `scripts/eval/code-vector-eval.mjs` — **20** labelled natural-language questions (`CASES`), scored
  through a store and reported as lexical / hybrid / reranked columns. Its own header states it is "a
  regression gate, not an external benchmark".
  - **Limit 1 — the hybrid column is conditional and its absence is silent.** The hybrid arm runs only
    if `capabilities().vector` is true, i.e. only on an index that was already built with `--vectors`;
    otherwise `hybridScore` is `undefined` and the report simply lacks the column.
  - **Limit 2 — it exits 0 by default.** "Exits non-zero only when `--min-mrr` is supplied and the
    hybrid MRR falls below it, so the default run is a report, not a gate."
  - **Limit 3 — every case is natural-language paraphrase.** There is no exact-symbol arm, no cross-file
    arm, no rename arm, no dependency arm. Bullet 4's five categories are one category today.
- `scripts/bench/locate-corpus.mjs` + `locate-eval.mjs` — the mature change-localisation harness:
  leakage controls, query-blind controls, token cost. This is the corpus §10's primary natural-language
  arm should use, because it is the one with controls and the one the negative result came from.
- `scripts/bench/cochange-eval.mjs` — builds its tasks from git history at run time (the published run
  used 75) **[V]**. This is the dependency-question harness.
- `scripts/scale-bench.mjs` — replicated-fixture method, `--slices` defaulting to
  `10_000,100_000,500_000,1_000_000`, peak RSS via `/usr/bin/time`. **No `--vectors` support** **[V]**.

### 5.7 The scale curve for the lexical path is measured, and names its own gap **[M]**

`docs/bench/scale-curve.md`: 10k/50k/100k/200k LOC → 4.67 / 28.28 / 56.98 / 116.82 s wall; peak RSS
243.5 / 367.2 / 670.4 / 1122.7 MB; nodes/s 1253 / 998 / 981 / 953 — **linear, with flat throughput**.
The doc states its gap in its own words: "**Still not measured: the 1M-LOC point, and nothing here
covers `--vectors`. The vector build is a different and much steeper cost — 1,444 s vs 86 s for this
repository's own 185K LOC (16.8×)… Extrapolating the lexical curve to a vectorized index is
invalid.**"

That 16.8× is the single most important prior in this spec. It is why §7 exists (batching is the one
lever with a plausible large effect), why §10's cold-index budget is written against it rather than
around it, and why bullet 6's "compliance with preregistered resource budgets" is a real gate and not
a formality: **promoting hybrid to default would multiply every user's index time by roughly
seventeen unless the vector phase changes.**

The doc also carries a hygiene rule this spec inherits: "**Regenerate this file in the same change
that touches `scripts/scale-bench.mjs`.**"

### 5.8 The pre-registration house style exists **[V]**

`docs/bench/retrieval-pre-registration-r2.md` — §1–§7 written and frozen before measurement, a
decision rule with a **minimum effect**, an **exact guard** (`exact R@5(C) == 1.00`, any regression
disqualifying outright), a **latency guard** (p95 ≤ 2× incumbent), a **tie-break biased toward no
change**, and "A negative result ships as a negative result". §10 is written in that shape.

### 5.9 A naming collision, recorded so it is not conflated **[V]**

Dozens of `WP4.x` comments in `packages/cli/src/{refresh-coordinator,watch,runtime,cli,viz-server}.ts`
and their tests (WP4.1 serialized refresh loop, WP4.2 serve-startup HEAD comparison, WP4.3
content-addressed digest, WP4.4 candidate source re-check, WP4.5 request pins, WP4.6 last-good keeps
serving, WP4.7 cold-reader freshness) belong to an **earlier PRD wave** and have nothing to do with
this plan's WP4. Any grep for "WP4" in this tree returns both; this spec's numbering is not that one.

## 6. The gap, bullet by bullet

| # | Plan bullet | State | Owed |
| --- | --- | --- | --- |
| 1 | opt-in code-search embedding path via the backend interface, installed local model | **BUILT** (§5.1) | Nothing. Keep it working. |
| 2 | vectors derived + rebuildable, keyed by content and model revision; **batch** embedding work; update only changed content | **PARTLY** — identity and incremental maintenance are built (§5.4); per-node `embed()` in the build loop; the disk cache covers unchanged text at the model layer only | **§7** |
| 3 | preserve lexical search when the model is unavailable, with capability/degradation reporting | **BUILT** (§5.2, §5.3) | Nothing, plus one test (§12) — and the harness half of H-6, which is the *reporting* being honest about **itself** |
| 4 | evaluate exact-symbol, natural-language, cross-file, rename, dependency **separately** | **ONE OF FIVE** — natural-language only (§5.6); **rename has no evidence at all** | **§8** |
| 5 | measure cold indexing, incremental updates, query latency, memory, disk at 10k/100k/500k LOC | **LEXICAL ONLY** (§5.7); the doc names the `--vectors` gap itself | **§9** |
| 6 | promote to default only after independent evaluation; otherwise retain opt-in | **OFF, with the reason recorded in-source** (quoted below) | **§10** — this spec closes the reason |

Bullets 1 and 3 were closed by the F1 remedy. **Bullet 6's stated blocker is closed by this spec** —
and the source says so in exactly these words (`cli.ts`, immediately above `wantVectors` in both
commands) **[V]**:

> …that default is a measurement decision, not caution: no labelled code-retrieval corpus or
> pre-registered gate exists yet, so making hybrid the default would change every user's ranking on an
> unmeasured promise.

That comment is the work package's charter written by the code itself, three months before this spec.
It names two missing artifacts — **a labelled code-retrieval corpus** and **a pre-registered gate** —
and §8 and §10 are precisely those two artifacts. The work is therefore bullets 2, 4, 5, and 6 — and
of those, **bullet 4 is the one that decides whether bullet 6 can ever be answered yes.**

## 7. The vector-maintenance increment (bullet 2's owed half)

### 7.1 What is owed, precisely

`buildVectors` (`sqlite-index.ts`, :482) embeds **one node at a time**:

```ts
for (const node of soul.iterate()) {
  if (isDetailNodeKind(node.kind)) continue;
  const v = e.embed(vectorText(node, repoRoot, fileCache));
  upsert.run(node.id, Buffer.from(encodeVec(v)), v.length);
}
```

`embedBatch` exists on the interface and is used by every other vector loop in the repository
(`memory/fusion.ts`, `memory/vector-store.ts`, `mcp/verbs.ts`) **[V]**. The code-graph build is the
one loop that does not batch.

### 7.2 The hazard this increment must carry, because it is measured

The contract is `embedBatch(texts)[i] === embed(texts[i])` **[V]**. It is not decorative. The
repository carries a scar with a number on it (`embed-setup.ts`) **[V]**:

> An earlier hand-written adapter applied E5's `query:` prefix in one method and `passage:` in the
> other; ranking then depended on which method the caller reached for, and **switching crib's record
> loop from `embed` to `embedBatch` silently cost 8 points of paraphrase recall.**

Two conclusions, both load-bearing:

- The 8-point loss came from a **prefix asymmetry between the two methods**, not from batching. Today
  the prefix is applied "in the one place both `embed()` and `embedBatch()` reach" **[V]**, and
  `embed()` now delegates to `embedBatch([text])[0]` **[V]** — so equivalence holds by construction and
  there is no second path to diverge.
- **That construction is asserted, not proven, for the code-graph loop.** §7.3 therefore requires a
  proof, not a reading: the increment must show that the vector table produced by the batched build is
  **equal** to the one produced node-by-node, before any timing is reported. A speedup measured on a
  build that changed the vectors is not a speedup, it is a different index.

### 7.3 The change

1. **Batch the build with a bounded chunk.** Accumulate non-detail nodes' `vectorText` into chunks of
   `VECTOR_EMBED_CHUNK` (default 64), call `embedBatch` once per chunk, and upsert the results — inside
   the same single transaction that currently wraps the loop, so the "vectors and their authorizing
   metadata commit together" property (§5.4) is unchanged.
2. **Keep the detail-kind skip and the one-line-per-file cache exactly as they are.** The skip is what
   "makes body text affordable" (79% of the crib's own nodes are detail kinds) **[V]**; the file cache
   is what stops a symbol-dense file being re-read hundreds of times **[V]**. Batching changes how the
   texts are sent, not which texts are chosen.
3. **Keep `buildFromSoul` synchronous.** `embedBatch` is sync at the interface; the caller still
   resolves the embedder asynchronously before `openIndex`, per §3.
4. **Do not change `Embedder.id`.** It keys `vector_meta` and the persistent cache (§5.4).

### 7.4 What this increment does **not** claim

- It does not claim the 16.8× goes away. Chunking removes per-call overhead; the model's forward passes
  dominate. §9 measures what it actually is, and §10's cold-index budget is set before that number
  exists.
- It does not claim "update only changed content" is now fully solved. It is solved at the **model**
  layer by the sha256 disk cache (§5.4) and at the **node** layer by `applyDelta` (§5.4). What it is
  *not* solved at is the **table** layer: a full `crib index --vectors` rewrites the `vectors` table
  even when every text is a cache hit. §9 measures that separately, as warm-cache cold-index time, and
  the spec labels it as the remaining non-incremental step rather than hiding it inside a "cold" number.

## 8. The five evaluation categories

Bullet 4 says "separately", and that word is the whole section. Each category gets its own arm, its
own metric, and its own verdict. **A category with no discriminating power is reported as such** — not
merged into a blend.

| Category | Query shape | Ground truth | Metric | Harness |
| --- | --- | --- | --- | --- |
| **Exact-symbol** | the symbol's name or qualified name, as typed | that node's file + id | **R@1**, R@10, MRR | **new** — derived from the soul store, not hand-written |
| **Natural-language** | a developer's question, no identifier | the files that answer it | MRR, R@10 | incumbent: `code-vector-eval.mjs` (20 cases) **and** `locate-eval.mjs` (61 tasks) |
| **Cross-file** | a question whose answer spans ≥2 files | the full file set | file-level R@k **and** all-files-covered rate | **new** — a view over `CASES`, whose ground truth is already a file list |
| **Rename** | the **old** name + a description of the symbol | the **new** location | R@1 on the new site; and the old site must not be top | **new** — built from git history |
| **Dependency** | "if I change X, what else must I touch?" | co-changed files | MRR, R@10 | incumbent: `cochange-eval.mjs` (75 tasks, 25 commits) |

### 8.1 Exact-symbol — the guard category, and it must be **exact**

Exact-symbol retrieval is where a hybrid ranker is most likely to *lose*, because cosine similarity
flattens the difference between `parseConfig` and `parseConfigFile`. The arm is built mechanically from
the soul store: for each node, the query is its `name` (and separately its `qualifiedName`), and the
ground truth is that node. No hand-labelling, no authoring bias, no test-set selection — which makes it
the cleanest measurement in this work package.

The R2 precedent's exact guard is `exact R@5(C) == 1.00`, "any regression disqualifies outright"
**[V]**. Here the guard is **`R@1(C_x, exact) ≥ R@1(C0, exact)`** under §10.5.

### 8.2 Natural-language — two corpora, and the primary one is not the 20-case one

The 20-case corpus (§5.6) is a regression gate whose own header says so. The 61-task localisation
corpus has leakage controls, query-blind controls and a published negative result (§5.5). **§10's
primary arm is the 61-task corpus**, with the 20-case corpus reported as a secondary gate. Choosing
the 20-case corpus as primary would be choosing the corpus that flatters the change.

### 8.3 Cross-file — the category where "found the file" and "found all the files" disagree

Every existing metric stops at the first correct hit. A question like "what groups related code into
modules" has a four-file ground truth **[V]**, and a ranker that returns one of the four scores the
same as one that returns all four. The cross-file arm reports both `R@k` over file sets and an
**all-files-covered rate** at the same `k`.

### 8.4 Rename — the category with no evidence today, and how to build it without leakage

Rename is the category that most directly tests the thing the plan's §3 cares about — "save, rename,
delete… preserve convergence" — and it currently has **nothing** (§6, bullet 4). It is also the
easiest category to build dishonestly, so the construction is fixed here:

1. Take a commit that **renames a declaration** (old path/name → new path/name), with no other
   semantic change in the same commit.
2. Build the index at the **pre-rename** base (the base tree is already the leakage control the
   localisation corpus uses **[V]**).
3. The query is the **old** symbol's name plus a short natural description of what it does. The ground
   truth is the **new** location.
4. Two metrics, because they fail differently: **R@1 on the new site** (does the ranker follow the
   move?) and **whether the old site appears at the top** (does it confidently point at a location that
   no longer exists?).
5. Renames are enumerated mechanically from `git log --diff-filter=R` over a fixed window, and the
   window is recorded as part of the corpus. If the window yields too few qualifying renames, the
   honest outcome is **"underpowered, reported as underpowered"** — not a padded set.

Metric 4 is the one with a user-visible consequence: a stale hit at the top of a rename question is
exactly the "wrong answer that looks right" the `applyDelta` vector-deletion rule was written to
prevent **[V]**. This arm tests whether that rule holds end to end.

### 8.5 Dependency — the existing harness, kept as it is

`cochange-eval.mjs` already asks the question the plan means, over git history with a query-blind
control, and its published result is negative (§5.5). It is carried forward unchanged so the WP4 number
is comparable to the published one, and it is reported with the churn control beside it — because 0.640
for a query-blind method is the number any dependency claim has to clear.

### 8.6 Harness honesty fix (H-6), without which §8 is not evidence

`code-vector-eval.mjs` must stop being able to produce a lexical-vs-hybrid report in which the hybrid
arm silently did not run (§5.6). The fix:

- When an embedder is resolvable but `capabilities().vector` is false, the report says **which of §5.3's
  four cases** refused the vectors (text-recipe, dim, embedder-id, or no `vector_meta` at all) and
  exits non-zero for the hybrid arm.
- When no embedder is installed at all, the report **states that it is lexical-only** and does not
  print a hybrid column.
- `--require-hybrid` makes "hybrid ran" a hard precondition for exit 0, so a CI gate can assert it.

## 9. The scale measurement design

### 9.1 What is measured, and at exactly which slices

Bullet 5 fixes the slices: **10k, 100k, 500k LOC**. `scripts/scale-bench.mjs` gains `--vectors`,
producing both arms at the same slices from the same replicated fixture:

| Column | Definition | Why it is not the same as another column |
| --- | --- | --- |
| **Cold index (lexical)** | build with no `--vectors`, empty model disk cache irrelevant | the incumbent |
| **Cold index (vector)** | `--vectors`, `KCRIB_EMBED_CACHE` pointing at a **fresh** directory | the model work is actually done |
| **Warm-cache cold index** | `--vectors`, cache pre-populated, table still rebuilt | isolates the table rewrite from the model work |
| **Incremental update (1 file)** | touch one file, `crib update` | exact node count, not a ratio |
| **Incremental update (10 files)** | same, ten files | whether cost is per-file or per-corpus |
| **Query latency p50/p95** | warm, ≥50 iterations after ≥5 warmups, `fresh=false` | matches `perf-gates.md`'s stated method |
| **Peak RSS** | `/usr/bin/time` (`-l` BSD / `-v` GNU), as the incumbent does | the embedder's own footprint is reported **separately** |
| **Disk** | index db bytes **and** embed-cache bytes, reported apart | see 9.3 |

### 9.2 The operational trap, stated before the first run

`scale-bench.mjs` uses a **replicated fixture** and re-runs the same slice repeatedly. The adapter's
disk cache is keyed by `sha256(text)` **[V]**. Therefore **a second run of the same slice is not a
cold run** — it is a warm-cache run, and it will be dramatically faster for reasons that have nothing
to do with scale. This is the vector-path analogue of the WP1-D15 hazard (a `packages/cli`
discrimination run is vacuous unless the build is refreshed between runs): the harness must set
`KCRIB_EMBED_CACHE` to a fresh directory for every cold measurement and **record the cache directory
and its byte size in the report**, or every cold number it publishes is a warm one.

### 9.3 Disk, reported as two numbers

Index disk and embed-cache disk are different artifacts with different lifecycles: the index db is
gitignored and rebuildable; the cache is per-user and survives index deletion. Reporting one "disk"
number would hide the fact that a user who deletes `.crib/index/crib.sqlite` still pays for the cache.
Vector disk is also checkable from first principles: at dim 1024, a raw float32 vector is 4,096 bytes,
so **≤ 8 KB/node** is ≤2× raw and is the budget in §10.4.

### 9.4 What the scale run must not do

- It must not extrapolate. §5.7's doc says in its own text that extrapolating the lexical curve to a
  vectorized index is invalid; the fix is to measure the vector curve, not to fit the lexical one.
- It must not publish a single slice as the curve. 10k/100k/500k are all three required; 1M is
  optional and, if included, is labelled as beyond the plan's requirement.
- It must not fold the embedder's memory into the index's. Peak RSS is reported whole **and** with the
  embedder's own footprint named, because a 1.1 GB reranker or a large ONNX tier is an operational
  property of the tier, not a defect of the index (this is the same distinction R2 §5.3 draws for
  embedding cost).
- **`docs/bench/scale-curve.md` is regenerated in the same change that touches `scale-bench.mjs`**
  (§5.7's hygiene rule).

## 10. Pre-registration R3 — code-channel hybrid promotion (FROZEN)

**Status: FROZEN, and NOW DECIDED (2026-09-23) — the candidate is NOT PROMOTED.** Everything in
§10.1–§10.7 was written before any measurement against the §8 corpora or the §9 fixtures. It was applied
**exactly as written**, by tool. The outcome is appended under `§10 RESULTS` below and is **never folded
back in**, so the commitment and the result can always be read apart — the frozen clauses above are
byte-for-byte what they were before the numbers arrived. This mirrors R1 and R2
(`docs/bench/retrieval-pre-registration-r2.md`), including their blinding discipline.

> **Reading note.** The clauses in §10.5 and the instrument audit in §10.8 were written in the future
> tense of an undecided run ("not yet measured", "before the first run", "no C1 number exists yet") and
> are **deliberately left in that tense**. They are the pre-registration; rewriting them in hindsight
> would destroy the very property that makes the result admissible. **What actually happened is in
> `§10 RESULTS`** — verbatim verdict: **`FAILS clause(s) 1 — the candidate is not promoted.`**

### 10.1 Question

> Does an opt-in code-search embedding path **beat the lexical incumbent on natural-language code
> retrieval**, without regressing exact-symbol retrieval, and within resource budgets fixed before the
> run — enough to justify promoting hybrid retrieval to **default** (`crib index` builds vectors
> without `--vectors`)?

Note the precise meaning of "promote", because the system has two defaults and only one of them
changes: the **query** path already prefers hybrid automatically when the open index carries vectors
**[V]**. Promotion therefore means **changing the build default**, i.e. making every user pay the
vector index cost. That is why the resource budgets below are not a formality: they are the price side
of the trade.

### 10.2 Hypothesis

> On symbol-bearing natural-language questions over this repository's own history, hybrid retrieval
> (BM25 ∪ cosine, RRF, then the `rerank.ts` structural prior) beats lexical-only **and beats the
> query-blind churn control**, while exact-symbol retrieval is unchanged, and the vector build stays
> inside budgets that a default-on build could ship.

The churn clause is not optional. §5.5: a query-blind control scored **0.501** and beat every method
that reads the question. A hybrid that beats lexical-only but not churn has learned churn.

### 10.3 Candidate set (frozen)

| id | strategy | notes |
| --- | --- | --- |
| **C0** | `lexical-only` | incumbent, and today's default |
| **C1** | `hybrid-rrf-rerank` | BM25 ∪ cosine fused by RRF, then the structural prior — what `--vectors` produces today |
| **C2** | `hybrid-rrf` | same without the rerank stage, to attribute any gain between fusion and prior |
| **C3** | `semantic-only` | cosine alone, to see whether BM25 is helping or hurting on code — the question R2's lexical-harm finding raises for this channel |

`alpha`, `k` and the rerank parameters are **not swept**. C1–C3 are named strategies, addressable by
id. A sweep over the test corpora is the selection error that invalidated R1's follow-up and R2 exists
to correct; R3 inherits that rule verbatim.

### 10.4 Embedder (frozen)

The installed on-device tier resolved by `loadInstalledEmbedder` / reported by `crib doctor`. The
deciding run records **`embedderId`, `dim`, and `VECTOR_TEXT_VERSION`** verbatim. If no tier is
installed, R3 **does not run** — it makes no claim about the fallback, and the run is reported as not
having happened rather than as a negative result.

Model selection is part of the deciding run, not a prior: R3 fixes the rule and reports each model's
number. The primary result is reported for the tier actually installed and named **before** the run.

### 10.5 Decision rule (frozen — applied exactly as written)

Let `MRR(C)` be mean reciprocal rank on the **primary natural-language arm** — the 61-task
change-localisation corpus (§8.2) — with the same k, base and leakage controls as
`docs/bench/localisation.md`. Let `exact R@1(C)` be exact-symbol R@1 from §8.1. Let `churn MRR` be the
query-blind control's MRR on the primary arm.

1. **Discrimination guard (non-negotiable):** `MRR(C_x) > churn MRR`. A candidate that does not clear
   the query-blind control is **not promoted regardless of any other number**, because it has not been
   shown to read the question.
2. **Minimum effect:** a candidate beats the incumbent only if `MRR(C_x) ≥ MRR(C0) + 0.05`.
3. **Exact guard:** `exact R@1(C_x) ≥ exact R@1(C0)`. **Any** regression disqualifies the candidate
   outright, regardless of natural-language gains.
4. **Latency guard:** query p95 ≤ **2×** the incumbent's query p95, measured on the same machine in the
   same run — the same rule and the same number R2 used (§5.8), so the two retrieval surfaces share one
   latency law. Embedding cost is reported separately and is **not** part of this guard.
5. **Resource budgets (the price of promotion):** a candidate is promotable to **default** only if the
   vector build at each of 10k/100k/500k LOC holds all of:
   - **Cold index (vector) ≤ 20× the lexical wall at the same slice.** *Derivation:* the measured prior
     is 16.8× at 185K LOC **[M]**; this budget forbids a regression larger than ~19% on the phase that is
     the entire cost of the opt-in.
   - **Peak RSS (vector) ≤ 2× the lexical peak at the same slice**, with the embedder's own footprint
     reported separately (§9.4).
   - **Disk ≤ 8 KB per vectorized node** at dim 1024 (= 2× the 4,096-byte raw float32), reported for
     index and cache separately.
   - **Incremental update:** a one-file change writes vectors for **exactly** the changed non-detail
     nodes — an exact count, not a ratio.
   - **Existing perf gates unchanged:** `perf-gates.md`'s warm recall p95 (< 100 ms @ 10k, < 300 ms
     @ 100k) must still pass **with** vectors.
6. **Tie:** if two candidates clear (1)–(5), the higher MRR wins; if still tied, the incumbent is
   retained — **bias toward no change**.
7. **A negative result ships as a negative result**, exactly as R1's and R2's did. §10 RESULTS will
   carry the numbers either way, and the doc surfaces users read (`docs/bench/scale-curve.md`, and a new
   `docs/bench/code-retrieval.md` publishing §8's per-category table) get the same numbers.

### 10.6 What R3 does NOT claim

- R3 does not set WP2's connected-retrieval gate (≥90% path recall on held-out v3). That gate stays
  frozen as written (§2).
- R3 makes no claim about the fallback tier, and none about scales beyond the measured slices.
- **R3 is a regression gate, not an external benchmark.** The same agent authored the corpus, the
  harness and the code under test (§8's construction is deliberately mechanical where it can be, to
  reduce this, but does not eliminate it). The result **recommends** a promotion; the principal
  **decides** it. This disclosure is stated here rather than discovered later.
- **A win in R3 does not mean hybrid should be on for everyone.** Budgets are measured for one machine
  and one tier; a candidate that clears them is promotable on that evidence, and the promotion commit
  must say which evidence.
- R3 says nothing about whether `rerank.ts` is worth its cost on the **lexical** path — the eval harness
  already supports rerank-over-lexical and that is a separate, cheaper question.

### 10.7 How to run

```bash
# 1. the tiers must be present, or the run does not happen
node packages/cli/dist/cli.js doctor .          # expect: embedder tier — installed (<id>)

# 2. vectors must actually be in the index; --require-hybrid makes its absence fatal (§8.6)
KCRIB_EMBED_CACHE=$(mktemp -d) node packages/cli/dist/cli.js index . --vectors
node scripts/eval/code-vector-eval.mjs --require-hybrid --json

# 3. the per-category arms (§8)
node scripts/bench/code-retrieval-eval.mjs --category exact,nl,cross-file,rename,dependency --json
node scripts/bench/locate-eval.mjs                       # primary NL arm, 61 tasks
node scripts/bench/cochange-eval.mjs                     # dependency arm, with the churn control

# 4. the scale arms (§9) — fresh cache per cold measurement
node scripts/scale-bench.mjs --vectors --slices 10000,100000,500000 \
  --out docs/bench/scale-curve.md
```

### 10.8 Instrument status, recorded BEFORE the run — and what it does not change

**This section amends nothing.** §10.1–§10.7 stand exactly as frozen. What follows is the state of the
*instruments*, audited before any R3 number is read, because §10.5 says "applied exactly as written" and a
criterion is only worth freezing if its instruments are checked first. Full reasoning: evidence register
§5.6.

**(1) `--decide` cannot measure a hybrid arm, so it cannot decide §10.5.** `code-retrieval-eval.mjs`
constructs its store with no embedder (`:209`), and `SqliteIndexStore.query` fuses only when
`builtEmbedderId !== null` (`packages/core/src/index/sqlite-index.ts:352`), which is set only for a supplied
embedder matching the index's recorded id and dim. A no-embedder store therefore never fuses, whatever the
index holds: C1 and C2 report `unavailable` on every index, and `--decide` can produce `minimumEffect: null`.
**R3 is therefore decided on the 61-task corpus by `scripts/bench/locate-eval.mjs` against two index states**
— the same tree, one indexed vectorless and one with `--vectors`, so exactly one variable moves. That is
what §10.5 clause 2 asks for and §10.5's own definition of `MRR(C)` already names the corpus. Making
`--decide` arm-capable is a real fix and is filed as an open decision (§15), **not** patched mid-run.

**(2) `--decide`'s `minimumEffect` is not §10.5 clause 2.** It is computed (`:550`) on the harness's own
hardcoded **20-case** `CASES` array (`:103`, asserted to be exactly 20 at `:151`), not on the 61-task corpus
§10.5 names. It is reported for information and **decides nothing**.

**(3) The 61-task arm is selected by the tree's index state, not by a flag — and that is sufficient.**
`crib query` has no `--semantic`; `cmdQuery` (`cli.ts:1366`) opens lexically and calls
`upgradeIndexToVectors`, which loads the on-device tier only when the index carries vectors. So C0 and C1
are two checkouts of one commit differing only in that property.

**(4) The arm is a verified fact about a run, and `locate-eval.mjs` now says which run it was.**
`--arm c0|c1` asserts it (a *request* against a mismatched tree is refused, never relabelled), and the
report carries `arm`, `index.carriesVectors`, `index.vectorNote` and `index.servedLexically`. An index that
carries vectors whose tier will not load yields a **lexical** number and is labelled `c0-lexical-only`,
because that is what it is. Proof of non-vacuity, seven rules in both directions:
`node scripts/bench/locate-eval.test.mjs`.

**(5) The frozen §10.7 command for the primary NL arm is under-specified, and the run uses the corrected
form.** `locate-eval.mjs` requires `--base-tree` (a checkout of the corpus `base` commit with `crib index`
already run there) and verifies the commit, refusing otherwise — the leak control the corpus exists for.
Because the arm is a property of the **tree's index** (point 3), the two arms need two checkouts of the one
base commit: one indexed vectorless, one indexed `--vectors`. The invocations actually used:

```bash
# C0 — the incumbent: the base commit, indexed VECTORLESS, in its own worktree
node scripts/bench/locate-eval.mjs --base-tree /tmp/crib-wp4-base-c0 --arm c0 --json

# C1 — the same base commit, indexed WITH VECTORS
node scripts/bench/locate-eval.mjs --base-tree /tmp/crib-wp4-base  --arm c1 --json
```

Both trees are detached at `d872789840b47e2a2b2b9a5f0751288b6ad0a050` — the corpus `base` — and carry an
index of the same build lineage (38,584 nodes / 85,431 edges each), so the **only** variable between the
two arms is whether the index holds vectors. That is the single-variable pair §10.5 clause 2 compares.
`--arm` is not decoration: it *asserts* the arm the run measured and exits non-zero on a mismatch, so a
mis-provisioned tree is a failed run rather than a column that quietly means something else.

**(6) The deciding pair is measured back-to-back with nothing else running, and that is a condition of the
result.** Clause 4 is *"latency p95 ≤ 2× incumbent **same machine same run**"*. *Same run* is a property of
the pair, not of each arm: two arms measured minutes apart under different machine load are not that, and
the error does not cancel — whichever arm runs on the busier machine is penalised, and a machine made busy
by the C1 fixture's own build penalises **C0**, flattering the hypothesis under test. Measured while the
first C0 attempt was in flight: load average **24.07 on 16 cores**, with two `crib index . --vectors`
children at **601%** and **593%** CPU and 5.9 GB RSS each. That attempt's `MRR(C0)` is retained as a
cross-check — retrieval quality does not depend on core availability — and **its latency column is not
filed under clause 4 at all**. All seven clauses are read from one clean back-to-back `{C0, C1}`.
`docs/program/tools/wp4-r3-run.sh` step 4 is updated in the same change to measure and assert both arms
(`WP4_BASE_TREE` = the vectorised tree, `WP4_BASE_TREE_C0` = its vectorless twin), so a re-run reproduces
the deciding pair rather than the contaminated one.

**(7) Clause 1's control beats both retrieval methods on this corpus, and the reason is one file.**
Measured from the incumbent half — no C1 number exists yet, and none is needed to see this. On the 61-task
corpus: **`churn MRR = 0.5012`**, the incumbent **`MRR(C0) = 0.3231`**, `grep-bm25` **0.4762**. The
query-blind control wins. It wins for a stated, measured reason: **`packages/cli/src/cli.ts` is expected in
29 of 61 tasks (47.5%) and is the repository's most-churned file — rank 1 of 5,946, 52 commits.** Those 29
tasks are **0.4754 of churn's 0.5012 — 94.8%** of its score; on the other 32 tasks churn's MRR is
**0.0492**. The corpus's discriminating power is concentrated on one hot file, and a method may clear
clause 1 by ranking that file well without reading the question. Recomputed independently from `git log`
in another language and reproduced to the digit (register §5.6(F) records the one discrepancy found on the
way, and that it was the ad-hoc script's, not the harness's).

Three consequences, recorded **before** the C1 number exists. **(i)** Clause 2 is **strictly dominated**:
`MRR(C0) + 0.05 = 0.3731 < 0.5012`, so clearing clause 1 clears clause 2 automatically and clause 2 cannot
bind on this corpus. **(ii)** A clause-1 pass would therefore **not** establish what clause 1 intends,
since a query-blind ranking reaches the same bar. **(iii)** R3's outcome here is **recommendatory with a
measured reason** — §10.6's disclosure, now with evidence. Clause 1 itself is unaffected: it tests the
*candidate*, so R3 is still formally decidable and C1 is still measured.

**The corpus is not re-authored in this run.** Rewriting a corpus after observing that its control wins is
fitting the instrument to the result — the failure the freeze exists to prevent. The pre-registered run
proceeds as written; a replacement corpus would be a **new** pre-registered measurement carrying this one's
numbers as its justification.

**(8) Clauses 3 and 4 are not read from the `{C0, C1}` pair, and clause 3 has no instrument at all.**
Recorded before the pair runs, for the same reason as (5)–(7): which clauses the run can actually check is
part of the result.

*Clause 4.* `locate-eval.mjs` measures **no latency** — its JSON table row keys are exactly
`['method','variant','recall1','recall5','recall10','mrr','medianTokens']`, and the file contains no match
for `ms|latenc|p95|duration|hrtime|performance`. The deciding pair therefore carries no latency column.
Clause 4's instrument is `scale-bench.mjs` (`:957`–`:974`), which emits **per LOC slice, on one index, in
one run**: `Lexical p50 | Lexical p95 | Hybrid p50 | Hybrid p95 | p95 ratio`. So **(i)** "same machine same
run" holds *inside* scale-bench's lexical-vs-hybrid pair and **not** across the `{C0, C1}` pair — the two
readings are different runs of different harnesses and no number may be quoted from one as measured in the
other; and **(ii)** clause 4's arms are the **synthetic slices** (10k/100k/500k LOC, `--vectors` against
its lexical twin), not the corpus base commit. Clause 4 names no corpus, so this is its intended
instrument — but clause 4 and clauses 1–3 are then measurements of different things on different trees,
which a reader must not fuse. Step 6 carries clause 4 **and** clause 5's last bullet (the `perf-gates.md`
warm-recall p95 with vectors), which is why the run script already assigns step 6 to both.

*Clause 3.* `exact R@1(C_x)` is §8.1's exact-symbol arm, owned by `code-retrieval-eval.mjs` — the harness
(5)'s blocker and **P-8** are about. It constructs `new SqliteIndexStore(DB)` with no embedder (`:208`), so
`caps.vector` is never `true`, `hybridMeasurable` (`:212`) is false on **every** index, and its own
clause-3 field is `null` by construction (`:552`). `exact R@1(C1)` is not merely unreported; it is **not
representable** in the instrument clause 3 names. Clause 3 is an outright disqualifier, so an unevaluable
clause 3 **cannot be cleared, only left unmet**: a C1 satisfying 1, 2, 4 and 5 still cannot be shown
promotable on this run's instruments. The strongest verdict available is **"promotable on 1, 2, 4 and 5,
with 3 unproven"**, and it must be written that way. Rescue routes are P-8's, both the principal's, and
route (B) does **not** rescue clause 3 — §8.1's arm has no other instrument.

**§10.5 remains FROZEN.** (8) amends no clause, redefines no quantity and moves no bar. It records which
clauses the pre-registered run can and cannot check, so that the results section is read for what it
measured rather than for what the rule asks.

---

# §10 RESULTS

**Status: DECIDED. The candidate is NOT promoted.** §10.1–§10.8 above are frozen and are **not** amended
here; this section is appended, so the commitment and the result can still be read apart. The verdict
below was produced by `docs/program/tools/wp4-r3-apply.mjs`, not by hand (§10.7 step 4b): a rule read at
the moment its numbers are finally visible is exactly where a frozen rule gets quietly bent.

**Verdict (verbatim from the tool, exit 1): `FAILS clause(s) 1 — the candidate is not promoted.`**

## R1. The deciding pair

Run at HEAD `b4615721e6a352aa9f89edc0f9f4094d28e113a6`, branch `program/developer-trust`, on corpus base
`d872789840b47e2a2b2b9a5f0751288b6ad0a050`, **61 tasks**, both arms **back-to-back with nothing else
running** (§10.8(6)). Both trees are that one commit and carry an index of the same build lineage
(38,584 nodes / 85,431 edges each), so the only variable between the arms is whether the index holds
vectors. Log: `docs/program/logs/wp4-r3-wp4-r3-quality.log`; reports
`docs/program/logs/wp4-r3-wp4-r3-quality-{c0,c1}.json`.

| arm | label | vectors | `crib`/full MRR | `churn` control MRR | `grep-bm25`/full MRR |
|---|---|---:|---:|---:|---:|
| **C0** | `c0-lexical-only` | no | **0.3231** | 0.5012 | 0.4781 |
| **C1** | `c1-hybrid-rrf-rerank` | **yes** | **0.4169** | 0.5012 | 0.4795 |

The arms are **as intended and verified, not assumed**: C0 reports `carriesVectors: false` (0 rows in both
`vectors` and `vector_meta`); C1 reports `carriesVectors: true` with `vector_meta` reading exactly
`embedderId=multilingual-e5-large-1024-sym`, `dim=1024`, `textVersion=2` — the values §10.4 pre-recorded, so
the run is provably on the pre-registered tier and not a silent fallback.

**The `vectorNote` field is a trap and must not be read as it naively reads.** C1's report carries
`"index carries multilingual-e5-large-1024-sym vectors; this reader loaded no embedder, so code search is
lexical here"`, which taken at face value says the arm the whole decision rests on was served lexically. It
was not. That note is written by the **probe** reader (`locate-eval.mjs:154`,
`carries: caps.vectorNote !== undefined`), which has no embedder **by design** — the note's *presence* is
the discriminator's evidence that the index carries vectors. The scored arm is decided separately, from the
CLI's own stderr degradation warnings (`:180` sets `degraded = true`; `:439` assigns C1 only when
`carries === true` **and** `degraded !== true`). C1's `servedLexically: false` means no degradation warning
fired, so the tier loaded and fused. Verified against source rather than inferred. Step 3 below shows the
identical message text arising as a **genuine** `unavailable` in a harness with no upgrade step — which is
why the two must not be conflated.

## R2. §10.5, applied by tool

| # | clause | rule | result | value |
|---|---|---|---|---|
| 1 | discrimination guard | `MRR(C1) > churn MRR` | **FAIL** | 0.4169 vs **0.5012** |
| 2 | minimum effect | `MRR(C1) >= MRR(C0) + 0.05` | pass | 0.4169 vs 0.3731 |
| 3 | exact guard | `exact R@1(C1) >= exact R@1(C0)` | **UNPROVEN** | no instrument (§10.8(8), P-8) |
| 4 | latency guard | `p95(C1) <= 2x p95(C0)`, same machine same run | **UNPROVEN** | no ratio measured at any slice (R7) |
| 5 | resource budgets | cold / RSS / disk / incremental / perf-gates | **FAIL** | 1/5 bullets clear; 5a breaches (R7) |
| 6 | tie-break | — | NOT APPLICABLE | clauses 1–5 are not all cleared |

**Clause 1 is an outright disqualifier and it failed by a wide margin.** Clause 2's pass carries **no
independent weight** and must never be reported as a win: on this corpus `MRR(C0) + 0.05 = 0.3731 < 0.5012`,
so the *control alone* already clears clause 2 — the clause is **strictly dominated** by clause 1 (as
§10.8(7)(i) pre-registered before any C1 number existed). Clearing clause 1 clears it automatically; clearing
clause 2 establishes nothing.

**Clauses 4–5 cannot change this verdict, and clause 5 now corroborates it.** Clause 1 already failed, so no
latency or resource result can rescue the candidate. Step 6 has since run (R7): clause 4 is **UNPROVEN** for
want of an instrument reading, and clause 5 **FAILS** on its 5a bullet. So the row above is **not** a pending
verdict awaiting data — the scale run is complete, and it adds a second failed clause while clearing nothing.

## R3. The full ranking, both arms

Every method, both arms, so the result cannot be read as "hybrid vs nothing":

| method / variant | C0 MRR | C1 MRR | C0 `r@1` | C1 `r@1` | median tokens |
|---|---:|---:|---:|---:|---:|
| **`churn` / full** (query-blind) | **0.5012** | **0.5012** | **0.2708** | **0.2708** | 0 |
| `grep-bm25` / full | 0.4781 | 0.4795 | 0.2484 | 0.2484 | 24,062 |
| **`crib` / full** | **0.3231** | **0.4169** | 0.1653 | 0.2178 | 1,902 / 1,806 |
| `crib` / subject | 0.2987 | 0.2939 | 0.1352 | 0.1790 | 1,889 / 1,812 |
| `crib` / no-scope | 0.2650 | 0.2584 | 0.1025 | 0.1612 | 1,890 / 1,813 |
| `recency` / full | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0 |

Three facts a reader must take from this table, in order of importance:

**(a) The control wins outright, and wins at the top of the ranking too.** `churn` is *query-blind* — the
same files in the same order for every task — and it holds the highest MRR **and the highest `r@1`
(0.2708) of any method measured**. This is not a tie-break artifact: blind recency beats every retrieval
method including `grep-bm25` on the first-rank metric.

**(b) The hybrid genuinely works, and that is why the result is interesting rather than merely negative.**
C1 lifts `crib`'s own lexical arm by **+0.0938 MRR** (0.3231 → 0.4169), with `r@5` 0.3566 → 0.4087 and
`r@10` 0.4730 → 0.5478. §10.2's hypothesis is *supported*: the vector channel does improve code retrieval.
What it does **not** do is beat a method that never reads the question. The failure is a property of this
**corpus** (one hot file, §10.8(7)), not of the channel — and §10.6 already confined R3's claim accordingly.

**(c) `crib` is not the most accurate method even as the incumbent — but it is ~13x cheaper.**
`grep-bm25`/full outranks `crib`/full in both arms at **24,062** median tokens against **1,806**. §10.5
contains **no token clause**, so this efficiency advantage cannot and does not rescue clause 1. It is
recorded because it is a real, measured property of the incumbent that the rule was never asked to price.

## R4. Noise bound — the verdict is not rescuable by measurement error

`grep-bm25` differs between the two arms (0.4781 vs 0.4795) although it reads the **tree**
(`locate-eval.mjs:313`, `rg ... --glob !.crib/**`) and both trees are the same commit. Cause, from source:
`:352–363` accumulates `idf = 1 / Math.log2(2 + filesForWord.size)` per word, so files matching the **same
word set** receive *identical* float sums, and the sort `(a, b) => b[1] - a[1]` breaks exact ties by **Map
insertion order** — which comes from `rg`'s non-deterministic parallel emission. The signature confirms it:
`r@1` is **byte-identical** (0.2484 in both arms) while `r@5`/`r@10` shuffle. This also explains why
`churn` (0.5012) and `recency` (0.0000) are **bit-stable** — both are built from deterministic `git log`.

**Measured noise bound: ΔMRR = 0.0014.** Clause 1 fails by **0.0843 — roughly 60x the observed noise**;
C1's gain over C0 is **+0.0938 — roughly 67x** it. Neither could be produced or overturned by this
mechanism. One pair of observations is a **sample, not a variance**: this bound is stated as an
order-of-magnitude guard, not as a measured standard deviation.

**Reconciliation of a pre-registered number.** §10.8(7) recorded `grep-bm25 = 0.4762`; the clean run
measures **0.4781**. Both lie within the tie-break noise above, and (7)'s figure was taken from the
earlier **contaminated** attempt, whose retrieval column was always sound but whose provenance is mixed.
The clean pair's 0.4781 is the number of record; (7)'s qualitative claim is unaffected.

**And the one number that had to match, did — precisely because it could not be allowed to move.**
§13 step 5 makes this an acceptance gate rather than a courtesy: *"verify the churn control's MRR matches
its published value on the same corpus (**a control that drifts is a broken control**)."* The published
prior is **0.501** (§5.5, §10.8(7)); the clean pair measures **0.5012** in **both** arms — i.e. it agrees
to the published precision and is bit-identical across the two arms. That is the difference between this
reconciliation and the `grep-bm25` one above, and the difference is the whole point: `grep-bm25` moved
*within* its noise floor because it is built on a tie-break over a non-deterministic traversal, while
`churn` did not move at all because it is built on deterministic `git log`. **A control that had drifted
would have invalidated the pair, not merely annotated it** — so this check is reported as **passed**, not
as an absence of complaint.

**§13 step 5, discharged precisely — the harness was NOT unchanged, and the distinction is the whole
question.** §13 step 5 reads *"Run `docs/bench/localisation.md`'s existing harness **unchanged** so the
WP4 number is directly comparable to the published one."* `scripts/bench/locate-eval.mjs` **is modified**
by this work package (**+219/−14**), so the literal obligation was not met — and saying so is required,
because a reader who checks `git diff` will find the modification and needs to know what it means. What
was actually preserved is narrower and is the thing comparability rests on: **no scoring body changed.**
The diff's hunks are confined to the header comment, two imports, the arm probe and its refusal paths,
`cribQuery`'s process spawn, the post-hoc arm establishment, and the JSON output shape. The methods that
produce the numbers — the `grep-bm25` IDF accumulation and its tie-break, the metrics, and `METHODS` —
are **byte-identical** to the version that published 0.4762, and the three independent cross-checks in
**R5** were produced by other instruments entirely.

**Why the harness had to change, and why that is the honest direction.** The modification exists to fix
the defect class this work package is about: two runs against two index states previously produced two
MRR columns **a reader could not attribute**, because the arm was an unstated ambient property of the
tree. `--arm` is an *assertion, not a switch* — there is no way to select an arm, only the tree's state,
and a mismatch is refused rather than relabelled. So the modification makes the comparison **more**
auditable than the published harness was, at the cost of the literal "unchanged" wording. **The
alternative — reporting the numbers and letting "unchanged" stand unchallenged — would have been the
precise failure this register exists to prevent**, and the correct response is to state the deviation,
state what it does and does not touch, and let a reader judge it rather than to rely on a reader not
checking.

## R5. Independent cross-checks from the same run's other steps

These are separate instruments on separate corpora, run under the same frozen block. They **agree with the
pair**, which is why the pair is reported as trustworthy rather than merely as a number:

- **Step 2 — H-6 honesty gate, exit 0**, `vectorChannel: true`, `vectorNote: null`. Lexical MRR **0.0533**
  (found 6/20) vs hybrid MRR **0.2687** (found 10/20): direction and rough magnitude consistent with the pair.
- **Step 3 — `code-retrieval-eval.mjs`**, the harness of §10.8(1)/(8). `arms.C0 = measured`,
  `arms.C1`/`C2 = unavailable`, `arms.C3 = not-measurable`, `exactGuard = null`, and
  `decision.verdict = "no-change"`. **This is the demonstration of clause 3's instrument gap, live**: the
  *same* message text that C1's `vectorNote` shows as a probe artifact here appears as a **genuine**
  `unavailable`, because this harness has no `upgradeIndexToVectors` step. Only the `exact` category yielded
  data, and only for C0 — `name`: self `r@1` 0.3675, self `r@k` 0.735, file `r@1` 0.615, MRR 0.4980,
  ceiling 0.7442; `qualifiedName`: 0.4375 / 0.805 / 0.708 / 0.5660 / 0.8368. **Clause 3's `C1` column does
  not exist in any instrument named by the frozen rule** (P-8).
- **Step 5 — dependency arm, 75 tasks, an independent corpus.** `churn` (query-blind) **MRR 0.6400** >
  `cochange` 0.4411 > `crib-impact` 0.3573 > `same-dir` (also blind) 0.0100;
  `crib-impact.liftOverBlind = 0.5583`. **The same pattern reproduces on a corpus the deciding pair never
  touched** — blind churn first — which is why R3's result is characterised as a fact about this
  repository's churn distribution rather than about the vector channel.

## R6. Clause 5's disk budget — measured, with its scope stated

On the real corpus index: `crib.sqlite` **126,767,104 → 164,741,120 bytes** for **8,106 vector rows** =
**~4.68 KB/vector** at dim 1024, against the **8 KB** budget. 8,106 vectors for 38,584 nodes (~21%),
consistent with "vectors for the changed **non-detail** nodes" by design.

**Scope, stated rather than blurred:** clause 5 names the 10k/100k/500k LOC slices. This is a
**corpus-tree** measurement. It is a partial satisfaction of one bullet of clause 5 and is **not** the
clause's slice measurement. Step 6 has since supplied the slice figure (R7): **5.12 KB/node at 10,000**,
also within the 8 KB budget — but only at that slice, which is why 5c remains **unproven** rather than
passed. Both independent measurements land inside the budget; neither is a clause-5 clearance.

## R7. Clauses 4–5: measured, the routing decision, and the two gaps that stop them being conclusive

Step 6 was launched with **`--slices 10000,50000,100000,200000,500000`** — the **union** of the frozen
command's slices (10k/100k/500k) and the slices `docs/bench/scale-curve.md` already publishes
(10k/50k/100k/200k). Reason: the frozen command's slice set alone would **silently delete** the 50K and
200K lexical points that document currently carries and that ADR-002's conclusion leans on. The union is
**additive** — every pre-registered slice is still present, so clauses 4–5 are still read exactly where
§10.7 says, and nothing published is lost. This is a **routing** note of the same kind as §10.8(5); it
moves no bar, redefines no quantity and amends no clause.

Step 6 completed at **2026-09-23T16:40:26Z** (started 16:06:50Z, 33m36s) at HEAD `b4615721`, and §10.5 was
applied **by tool** — `wp4-r3-apply.mjs --scale docs/bench/scale-curve.md` — not by hand, per §10.7. Verbatim
verdict, exit 1:

> **`FAILS clause(s) 5 — the candidate is not promoted.`**

with `cleared: []`. The clause-4 read is from `scale-bench.mjs`'s
`Lexical p50 | Lexical p95 | Hybrid p50 | Hybrid p95 | p95 ratio` table (§10.8(8)).

**Clause 4 — UNPROVEN, and not by choice.** The latency table carries a lexical reading at **10,000 only**
(p50 0.31 / p95 1.14 ms) with both hybrid columns `—`, and `*UNAVAILABLE*` at 50k/100k/200k/500k. There is
therefore **no measured p95 ratio at any pre-registered slice**, and clause 4 can be neither passed nor
failed: a ratio that was never computed is not a ratio that stayed under 2×. The tool reads the bare `—`
ratio cell as *unavailable* rather than as a pass — the specific failure its suite was built to refuse
(`wp4-r3-apply.test.mjs`, "an UNAVAILABLE slice reads UNPROVEN, never as a pass").

**Clause 5 — FAIL, on one of its five bullets.** Reported apart, as the frozen rule writes them:

| bullet | status | what was measured |
|---|---|---|
| 5a cold ≤ 20× lexical | **fail** | **10,000: cold vector 633.4 s is 76.7× the lexical 8.26 s** |
| 5b peak RSS ≤ 2× (index-side model excluded) | unproven | the split is `*n/a*` — see below |
| 5c disk ≤ 8 KB/vectorized node | unproven | 10,000 measures **5.12 KB/node, within budget**; unmeasured at 100k/500k |
| 5d incremental writes exactly the changed nodes | unproven | 10,000 is **exact at 1 file (18/18) and at 9 files (89/89)**; unmeasured at 100k/500k |
| 5e perf gates unchanged with vectors | pass | **BY CONSTRUCTION, not by measurement** |

A breach is a fact about the channel, so it takes precedence: 5a's breach makes clause 5 `fail`. **Three of
the other four are unproven because the vector arm could not run** — not because they passed, and not because
they failed. The reason is a measured rate carried verbatim in the document: cold embedding costs
**243 ms/node**, so from the 10k slice outward the projection is 51 / 100 / 200 / 498 minutes against the
45-minute ceiling, and §9.4 forbids extrapolating a curve. **Only 5e passes, and it says so itself: the
vector arm runs only under `--vectors`, so the lexical path is exactly what it was before the flag existed.**

**5b is not merely unmeasured — the named instrument cannot measure it.** `measureEmbedderFootprint`
(`scale-bench.mjs:242`) embeds **one short string** and takes the child's `/usr/bin/time` peak, which
captures the model's **idle** resident floor; re-measured standalone at HEAD that floor is **65 MB**. But the
frozen run's cold vector arm peaked at **5,680 MB whole-process** against a **249.438 MB** lexical peak at the
same slice — 5,431 MB incurred by the only difference between the two runs, which is batched embedding
(`embedBatch`, chunk 64). So the subtraction §9.4's method rests on would compute an "index-side" figure of
≈5,615 MB = **22.5×** the lexical peak, from a model whose footprint was never measured. **`*n/a*` is the
correct cell, and the probe failing to report a number was, accidentally, the safe direction.** The probe is
additionally flaky for an independent reason — `e.embed(...)` is never awaited (`:248`), so the stdout write
races the exit; the identical child exited **1** inside the frozen run and **0** standalone. The method's own
note is right that "a resident model and a live indexing pass do not simply add"; this is that caveat with a
magnitude attached — the instrument's premise holds only in the *idle* regime, and clause 5b needs the *batch*
regime. **This is a named instrument gap of the same class as clause 3's (P-8), and it is left open rather
than papered over.**

**One reading this result must not invite.** The whole-process pair at 10k (5,680 MB vector vs 249 MB lexical)
is **22.8×**, but that folds the embedder into the index, which §9.4 forbids and which 5b's own rule excludes
the model from. Reported as a 5b breach it would be wrong; as a *resource fact* it is only a fact about the
model. 5b stays **unproven**.

**Clause 5 fails narrowly, and the narrowness must be stated.** One bullet, at one slice, and that slice is
the only one the vector arm could reach. A reader must not extract "the vector channel breaches its resource
budgets" in the plural, nor "the vector channel was measured at scale" — it was measured at 10,000 LOC and
nowhere else.

**Neither clause can change the verdict, and clause 5 does not rescue it.** R2 already failed clause 1, an
outright disqualifier; this run adds a second failed clause and clears nothing. The combined state, across
both modes and two different trees, is **failed 1, failed 5, unproven 3, unproven 4, cleared: none**. No
number from the `{C0, C1}` pair may be quoted as clause 4 or 5, and no clause-4/5 number may be read back into
clauses 1–3: the runs measure different things on different trees. Whatever step 6 reports, **R2's verdict
stands**.

**The same run also regenerated the lexical curve**, which is the free four-point A/B the additive slice
union bought: the four slices common to the published curve and this one (10k/50k/100k/200k) are
8.26/35.45/67.38/134.42 s against the published 4.67/28.28/56.98/116.82 s — a delta of **+3.11 s fixed plus
~0.131 ms/node** (it predicts +17.67 s at 111,316 nodes against +17.60 s measured), presenting as 1.77× at 10k
and decaying to 1.15× at 200k. It is a **separate observation,
filed under WP1** (register §2), because it measures the *lexical* path — and it is *not* a clause-5 finding.
The harness's timing path is argv-identical to the published run's, so the comparison is method-clean; the
mixed-freshness `dist/` caveat stands, so the delta is measured but **not attributed to a revision**.

## R8. What this result does and does not say

Consistent with §10.6, and stated here so the negative is not over-read:

- **Does not say** the vector channel is worthless. It raised `crib`'s own arm by +0.0938 MRR (67x noise) and
  the H-6 gate and step 2 independently agree the channel functions.
- **Does not say** the candidate may be promoted. Clause 1 is an outright disqualifier and it failed.
- **Does not say** clause 2 was passed in any meaningful sense. It was **strictly dominated** (R2).
- **Does not say** clauses 4–5 would have changed anything had they been measurable. They cannot.
- **Does say** that on this repository's 61-task corpus, *guessing the recently-changed files* outperforms
  every retrieval method measured, on MRR **and** on `r@1`, and that this reproduces on an independent
  75-task corpus. The instrument's discriminating power is concentrated in one hot file (§10.8(7)).

**The corpus was not re-authored after seeing this.** Rewriting the corpus now that its control is known to
win would be fitting the instrument to the result — the failure the freeze exists to prevent. A
replacement corpus would be a **new** pre-registered measurement, carrying these numbers as its
justification.

## R9. Artefacts

| artefact | what it is |
|---|---|
| `docs/program/logs/wp4-r3-wp4-r3-quality.log` | the deciding run, with the NOTE ON ORDER for steps 2/3/5 |
| `docs/program/logs/wp4-r3-wp4-r3-quality-{c0,c1}.json` | the pair's raw reports (the tool's only inputs) |
| `docs/program/logs/wp4-r3-wp4-r3-quality-step{2,3,5}.json` | the independent cross-checks of R5 |
| `docs/program/logs/wp4-r3-step6-scale.log` | step 6 (clauses 4–5) — complete, exit 1, 33m36s; the exit code is the harness reporting the 5a breach |
| `docs/program/tools/wp4-r3-apply.mjs` + `.test.mjs` | the §10.5 application, and its two-directional suite |
| `docs/bench/code-retrieval.md` | §8's per-category table (D-a), including the losses |

## 11. Per-file change list (exact signatures)

| File | Change |
| --- | --- |
| `packages/core/src/index/sqlite-index.ts` | `buildVectors`: chunk the non-detail node texts and call `this.embedder.embedBatch(chunk)` instead of `embed()` per node, inside the existing single transaction. Add module const `VECTOR_EMBED_CHUNK = 64`. No change to `writeVectorMeta`, `restoreVectorMeta`, `applyDelta`, `capabilities`, `vectorQuery`, or `rerank` usage. |
| `packages/core/src/index/__tests__/` (vector build) | **New** `vector-batch-equivalence.test.ts`: build one fixture twice — node-by-node and batched — and assert **byte equality** of the `vectors` table and equality of `vector_meta`. This is §7.2's proof obligation and must be shown to fail if `embedBatch` is made to diverge. |
| `scripts/eval/code-vector-eval.mjs` | Per §8.6: named degradation case when `capabilities().vector` is false; explicit lexical-only statement when no embedder exists; `--require-hybrid` makes a missing hybrid arm a non-zero exit. |
| `scripts/bench/code-retrieval-eval.mjs` | **New.** Drives §8's five arms. `--category` selects; exact-symbol and cross-file are derived mechanically from the soul store + `CASES`; rename is derived from `git log --diff-filter=R` over a recorded window; dependency delegates to `cochange-eval.mjs` so the number stays comparable. Emits JSON for the doc. |
| `scripts/bench/rename-corpus.mjs` | **New.** Builds and freezes the rename corpus (§8.4) with its git window recorded, so the corpus is reproducible and its size is a fact rather than a choice made after seeing results. |
| `scripts/scale-bench.mjs` | Add `--vectors`. New columns: cold lexical, cold vector (fresh `KCRIB_EMBED_CACHE`, recorded), warm-cache cold, incremental 1-file and 10-file, query p50/p95, peak RSS (whole + embedder-attributed), disk (index + cache, separate). Report the cache directory and its byte size. |
| `docs/program/tools/wp4-r3-run.sh` | **New.** Runs §10.7's block in order with every artefact captured, so the pre-registered run is reproducible and re-auditable rather than assembled by hand. Step 4 measures **both** arms of the deciding pair (`WP4_BASE_TREE` = vectorised, `WP4_BASE_TREE_C0` = its vectorless twin) and captures each `--json` report, because the harness has no `--out`; step 4b applies §10.5 to the pair. Step 6 runs alone. Non-vacuity: `docs/program/tools/wp4-r3-apply.test.mjs`. |
| `docs/program/tools/wp4-r3-apply.mjs` | **New.** Applies the frozen §10.5 to the deciding pair as arithmetic: clauses 1 and 2 computed, clause 3 reported **UNPROVEN** (no instrument — §10.8(8)), clauses 4–5 read from `scale-bench`'s document under `--scale`, clause 6 not applicable while 3–5 are open. Refuses a pair that is not one experiment (different base, task count, or the same arm twice) and refuses a missing `crib`/`full` or `churn` row rather than defaulting the quantity §10.5 names. Its verdict string refuses to read a 1-and-2 pass as a promotion. |
| `docs/program/tools/wp4-r3-apply.test.mjs` | **New.** Drives every rule in both directions against synthetic pairs — clause 1 (under/over the control), clause 2 (+0.02 fails, exactly +0.05 clears, since the rule reads `>=`), the three unproven/pending clauses, and four refusals. A test written before the C1 number exists, which is the only time it can be. |
| `docs/bench/scale-curve.md` | Regenerated in the same change (§5.7's hygiene rule). Adds the vector rows across all five slices (10k measured, the rest recorded as unaffordable with the rate that makes them so), the incremental and query-latency tables, and the delta against the published curve this file supersedes. States the remaining non-incremental table rewrite as a labelled limitation, not as a result. |
| `docs/bench/code-retrieval.md` | **New.** Publishes §8's per-category table (all five, including losses) with the C0/C1/C2/C3 columns and the churn control beside them. This is D-a's artifact. |
| `docs/bench/retrieval-pre-registration-r3.md` | **Not created.** R3 lives as §10 of this spec so the frozen rule and its appended result stay in one reviewable file. If the principal prefers the bench family's one-doc-per-run convention, this spec's §10 moves there verbatim and unchanged. |
| `docs/program/evidence-register.md` | WP4 section: replace the stub with the spec, the measurements, and the decision. Update the scorecard row and close B1 only against D-a–D-d. |

## 12. Test plan

Method, carried from WP1: **a new test is credited only after it is shown to fail against the
pre-change code.** A test that passes either way is not coverage, and this work package's whole subject
is claims that are not backed.

| # | Test | Discriminates |
| --- | --- | --- |
| T1 | `vector-batch-equivalence.test.ts` — byte-equality of `vectors` and `vector_meta` between the per-node and batched builds (§7.2) | fails if `embedBatch` diverges from `embed`, or if the detail-kind skip / file cache changes behaviour |
| T2 | Batched build writes vectors for exactly the non-detail nodes | fails if chunking changes the *set* of embedded nodes |
| T3 | Batched build still commits vectors + `vector_meta` in one transaction | fails if the chunk loop escapes the transaction |
| T4 | `--vectors` with no installed tier still exits `BAD_ARGS` with the refusal text (§5.2) | the refusal is a measured decision, not a convenience — it must not be softened into a fallback |
| T5 | `code-vector-eval` on a lexical-only index **fails** under `--require-hybrid` and names the §5.3 case | closes H-6; today it exits 0 with the hybrid column silently absent |
| T6 | Exact-symbol arm: `R@1` is computed and reported for both arms | fails if the arm silently reports 0 cases |
| T7 | Rename arm reports **both** metrics, and reports "underpowered" when the git window yields too few renames | fails if an empty corpus is scored as a perfect or terrible result |
| T8 | Cross-file all-files-covered is distinct from file-level R@k on a multi-file case | fails if the two metrics collapse into one |
| T9 | `scale-bench --vectors` records the cache directory and bytes, and a warm-cache run is reported as warm-cache | the §9.2 trap: a warm number published as cold |
| T10 | Incremental update writes vectors for exactly the changed nodes | fails if `applyDelta` embeds the corpus |
| T11 | **Discrimination run for `packages/cli`** | per WP1-D15, a `packages/cli` discrimination run is vacuous unless the build is refreshed between runs — any §12 measurement that touches CLI behaviour rebuilds first |

Suites that must stay green: `packages/core` index/vector suites, `packages/cli` suites (with a
refreshed build), `packages/memory` suites, the eval scripts' own JSON shape assertions, and
`pnpm -w lint` / `tsc --noEmit`.

## 13. Measurement protocol and acceptance gates

1. Confirm the tier: `crib doctor .` reports an installed embedder. **If not, R3 does not run** (§10.4).
2. Build vectors into a scratch index with a **fresh** cache dir; record `embedderId`, `dim`,
   `VECTOR_TEXT_VERSION`, cache dir, cache bytes.
3. Run §8's five arms, C0–C3 as named, JSON out.
4. Run §9's scale arms at 10k/100k/500k with a fresh cache per cold measurement, plus one warm-cache run
   labelled as such.
5. Run `docs/bench/localisation.md`'s existing harness **unchanged** so the WP4 number is directly
   comparable to the published one; verify the churn control's MRR matches its published value on the
   same corpus (a control that drifts is a broken control).
6. Apply §10.5 **as written**. Record the outcome under `§10 RESULTS`, with a per-clause line for each
   of (1)–(7) — including the clauses that failed.
7. Regenerate `docs/bench/scale-curve.md` and publish `docs/bench/code-retrieval.md` in the **same
   change**.
8. Update the register: WP4 section, scorecard row, and B1 — closed only against D-a–D-d, never against
   "the code was written".

Acceptance: **D-a–D-d of §1.** A WP4 that ships the batching change and the harness without the
published per-category numbers has done the cheap half of the work package.

## 14. Freeze notes

- §10 is frozen the moment the first measurement of the deciding run starts. Additions go under
  `§10 RESULTS`.
- §1–§4 are plan-derived. §5–§9 are grounding-derived from `b4615721` and may be corrected if a claim
  is wrong — a correction must say so.
- This spec deliberately does **not** re-plan §5's already-built surfaces, and equally deliberately
  does **not** credit the work package with them. When this note was written the register's B1 read
  "WP4 not started"; §6's table was the precise correction, filed so the register would be updated
  honestly rather than flip-flopped. **Corrected 2026-09-23: the register now carries that correction** —
  B1 reads "WP4 has no retrieval-quality number", and the register also records the §5.5 corpus result.

## 15. Open decisions for the principal reviewer

- **P-1. The minimum effect (0.05).** R2 used +0.15 on R@5. This spec uses +0.05 on MRR over the
  harder, leakage-controlled corpus, with the churn guard doing the heavy lifting. **Lower the number
  and the work package becomes easier to pass and less meaningful; raise it and it may be unpassable
  on a channel whose published floor is below query-blind.** The choice should reflect what the
  promotion is worth: a ~17× index cost.
- **P-2. The cold-index budget (20×).** Derived from the measured 16.8×, allowing a ~19% regression.
  If the principal wants the promotion to require batching to be a *large* win, this number should be
  lower than the prior — which would make the §7 increment a precondition rather than an optimisation.
- **P-3. Whether C3 (`semantic-only`) is in the set at all.** R2's finding that BM25 was *actively
  harmful* on a word-disjoint corpus raises a real possibility for code: that cosine alone is the
  better arm. Including C3 risks a second promotion question; excluding it risks measuring only the
  fusion and missing the answer.
- **P-4. §14's placement of R3** — in this spec (one file, rule and result together) versus
  `docs/bench/retrieval-pre-registration-r3.md` (the bench family's convention). Either is fine; the
  rule must not move after it is frozen.
- **P-5. Whether the promotion, if it passes, ships in this release.** Bullet 6 permits it; the plan's
  §5 lists no release constraint on it. A default that multiplies index time by ~17 is a user-visible
  change and may deserve its own release note even when the evidence supports it.
- **P-6. Whether the embedder's per-load integrity hash stays as it is (raised 2026-09-23, by
  measurement, after §5.4 of the register withdrew its own original explanation for it).**
  `loadInstalledEmbedder` → `verifyInstalledEmbed` → `checkPinnedFiles` → `sha256File`
  (`packages/core/src/embeddings/embed-install.ts:163/375/403`) streams **3,313 MiB across 13 pinned
  files** through the main thread, synchronously, on **every** load in **every** process — including
  **two models the process never loads** (a 1.0 GB reranker and an 87 MB second embedder). Measured
  cost on a warm page cache: **~1.2 s** per load (`docs/program/tools/embed-load-cost.mjs`); the cold
  cost was not measured. This is a **trust boundary**, so the options are a decision and not a
  refactor, and none is taken here: **(A)** keep it — the guarantee is "a compromised weight is caught
  before it is used", and ~1.2 s per process is cheap for that; **(B)** verify once per boot/daemon and
  memoise, accepting that a long-lived process will not re-notice a swap mid-life; **(C)** scope the
  verification to the model actually being loaded, which removes the two unused models from the cost
  but makes the guarantee per-model rather than per-install; **(D)** treat the weight-cache files as
  cache (disposable, re-provisionable) and verify only `manifest.files`, on the argument that a
  corrupted cache is a re-download and not an integrity event. **The measured asymmetry this fixes
  either way:** the cost lands in the cold-index (vector) column and not in the lexical one. It is
  disclosed in the R3 run log and **not subtracted from any column**; at the observed slice it does not
  change clause 5a (122 s vs 1.9 s, 64× a 20× budget), so the breach verdict does not rest on it.
- **P-7. How a rename corpus is powered at all (raised 2026-09-23, by building it).** §8.4's category
  has **no number** and cannot obtain one from this repository: `docs/bench/rename-corpus.json` reports
  `powered: false`, `tasks: 0` against `minTasks: 8`, because the 400-commit window (353 commits; 1,192
  rename entries in 5 commits) contains **zero source-file renames** (`byPathClass`: `derived` 1,188,
  `docs` 3, `other` 1, **`source` 0**), and all 5 rename-carrying commits are additionally dropped for
  `commitHasOtherChanges` — §8.4's own leakage rule, working. The register records the mechanism in §5.5.
  **It does not block R3**: §10.5's deciding quantities do not include rename. The options are **(A)**
  accept *"underpowered, reported as underpowered"* as this repository's permanent result and stop —
  cheapest and honest, leaving one fifth of bullet 4 permanently unmeasured; **(B)** widen the window or
  add repositories until pure-rename commits appear, which changes a **frozen** construction and so must
  be re-frozen *before* the numbers arrive, never after; **(C)** synthesise the corpus (a `git mv` plus a
  mechanical call-site rewrite in a scratch clone, diffed) — powers the arm without leakage, but measures
  *the harness on a constructed move* rather than retrieval on real history, and that distinction must be
  printed beside the number; **(D)** drop the category and state bullet 4 is four-fifths **by design**.
  **(A) is what this run reports.** The deciding constraint: §8.4 exists to answer *"does the retrieval
  path find something that moved"*, and a corpus with no moves cannot answer it at any size.
- **P-8. Whether `code-retrieval-eval.mjs --decide` is made arm-capable, and by which of the two routes
  (raised 2026-09-23, by auditing the instrument before the run — register §5.6, spec §10.8).** The harness
  cannot measure C1/C2 at all: it opens the store with no embedder (`:209`) and `query` fuses only for a
  matching `builtEmbedderId` (`sqlite-index.ts:352`), so its hybrid arms are `unavailable` on every index
  and `--decide` can print `minimumEffect: null`. **Correction, added 2026-09-23 under §10.8(8): an earlier
  version of this entry said "R3 is decided without it", and that is true of clauses 1, 2, 4 and 5 but
  NOT of clause 3.** Clause 3's `exact R@1(C_x)` *is* §8.1's exact-symbol arm, which this harness owns, and
  its own guard field is `null` by construction (`:552`) — so clause 3, an outright disqualifier, is
  **unproven**, not merely undecided. Clauses 1, 2 and (via scale-bench) 4–5 are decided without it, so the
  run proceeds; clause 3 stays open against this entry, and route (B) does **not** close it. Both routes
  are real work and neither is taken here, because changing the deciding instrument after the rule is
  frozen is what the freeze prevents: **(A)**
  make the harness perform the same two-step upgrade the CLI does — open lexically, read `vectorNote`, then
  resolve and supply an embedder — which makes C1/C2 measurable in-process and lets `--decide` mean what it
  says, at the cost of a multi-GB model load inside a benchmark harness; **(B)** delete `--decide` and
  `minimumEffect` and have the harness report arms only, leaving the decision rule to the harness that owns
  the corpus §10.5 names — cheaper, and it removes a number that currently reads as the frozen clause-2 test
  while being computed on 20 cases. **(B) is the smaller honest surface; (A) is the one that makes the
  per-category arms (§8) hybrid-capable, which is a measurement the spec does want.** The choice is the
  principal's.
