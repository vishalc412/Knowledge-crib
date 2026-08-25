---
name: crib-enrich
description: Drive the knowledge-crib LLM semantic-graph generation loop. Use when the user says "crib-enrich", "enrich the crib", "build the LLM graph", "generate the codebase bible", or when `crib enrich` / `mcp__knowledge-crib__enrich (op:'status')` shows pending LLM targets. On large repos it shows a graphify-style scope picker first (which module to enrich), then authors deep per-target analysis + a grounded semantic graph bottom-up across symbol → file → cluster → system, one token-packed batch per turn by default (an opt-in bounded autonomous loop drains multiple batches when the user asks for --auto / "keep going"). The crib MCP server never calls a model — YOU (the host IDE LLM) are the generator; it only hands you grounded seed and persists what you author.
---

# crib-enrich — author knowledge-crib's LLM semantic graph

You are the **generator**. The `knowledge-crib` MCP server is 100% deterministic: it exposes a work queue (`enrich({op:'next'})`), validates + persists what you author (`enrich({op:'save'})`), reports coverage (`enrich({op:'status'})`), and ranks scopes (`enrich({ op:'status', scopes:true })`). It never calls a model. You drive the loop, author each work item against its schema, ground every claim in the seed it hands you, and save.

## When to run

- The user asks to enrich the crib / build the LLM graph / generate the codebase bible.
- `mcp__knowledge-crib__enrich (op:'status')` (or `crib enrich`) shows `done: false` with pending targets.
- After a fresh `crib index` (it prints "N target(s) pending LLM graph generation — run /crib-enrich").

Do **not** run if `enrich({op:'status'})` reports `done: true` unless the user forces a re-run (e.g. code changed and artifacts are `stale`).

## Not a search command

`/crib-enrich` generates and persists LLM analysis; it does not look up arbitrary text. If the
invocation asks to "search", "find", "look up", or explain a named symbol, do not enter the
enrichment queue. Tell the user to use the Knowledge-crib `query` MCP tool (or
`crib query "<text>"`) and perform that lookup when the tool is available. Also correct
`/crib-enric` to `/crib-enrich` when the final `h` is missing.

## ⚠️ The two rules that prevent the infinite loop

1. **One batch per turn by default (token-packed); autonomous mode is opt-in.** The default turn pulls ONE batch, authors it, saves it, reports progress, and **returns to the user** — the review checkpoint is preserved. But the batch is now sized by **token budget**, not a hardcoded item count: call `enrich({op:'next'})` with **no `limit`** (the server defaults to the 25-item ceiling) and let the token packer fill it. Do NOT pass `limit: 4` — that count-cap was the throttle that turned 34 symbols into 9 turns. Re-running `/crib-enrich` continues from where you left off. Only enter the explicit autonomous loop (below) when the user asks for `--auto` / "keep going".
2. **Zero-progress guard.** `batchId` is deterministic (same pending set ⇒ same id, independent of `limit`/budget) AND the server persists the last-issued batchId per `(layer, scope)` and echoes `previousBatchId` + `zeroProgress` in every `enrich({op:'next'})` response. If `batchId === previousBatchId` (i.e. the response carries `zeroProgress: true`), do NOT author or save — break and report: *"No progress: `enrich({op:'next'})` returned the same batchId (`<id>`) the server already issued for this (layer, scope) with no save landing in between. Stopping. Check that `enrich({op:'save'})` is persisting (`rejected[].reason`)."* This is the **server-side source of truth** — it fires even after context compaction forgets the id you saw last turn, so a headless driver need not remember anything. The host-memory comparison (`batchId === lastBatchId`) is now a secondary backstop, not the primary check.

## Phase 0 — the scope picker (first thing, once per session)

Call `mcp__knowledge-crib__enrich (op:'status')` with `{ scopes: true }` and NO scope.

- If `totalPending <= threshold` (the response's `threshold` field, default 200) OR `scopes` is empty: **skip the picker**, proceed to Phase 1 with no scope.
- If `totalPending > threshold` AND `scopes.length > 0`: print the picker block below **verbatim** (fill in the real numbers from the response), then **STOP and wait for the user**. Do not call `enrich({op:'next'})`.

```
This repo has <totalPending> pending LLM targets across 4 layers (symbol: <s> pending, file: <f> pending, cluster: <c> pending, system: 1 total), exceeding the recommended threshold of <threshold>. Batched by token budget that is ~<ceil(totalPending/16)> batches — enriching everything unattended is not realistic. Which module should I enrich first?

Top-5 modules by pending symbols (the parenthesized counts are TOTAL symbols/files/clusters in that prefix; `pending` is pending symbols only):
  1. <scopes[0].pathPrefix>   — <scopes[0].pending> pending  (<scopes[0].symbols> symbols, <scopes[0].files> files, <scopes[0].clusters> clusters)
  2. <scopes[1].pathPrefix>   — <scopes[1].pending> pending  (...)
  3. <scopes[2].pathPrefix>   — <scopes[2].pending> pending  (...)
  4. <scopes[3].pathPrefix>   — <scopes[3].pending> pending  (...)
  5. <scopes[4].pathPrefix>   — <scopes[4].pending> pending  (...)

Options:
  • Type a number (1–5) to scope to that module.
  • Type a path prefix (e.g. packages/cli/src) for a finer scope.
  • Type 'list clusters <number>' to refine by cluster inside a module first.
  • Type 'full' to enrich the whole repo (not recommended — ~<ceil(totalPending/16)> batches).

I'll wait for your choice before proceeding.
```

**Scope carry:** once the user picks, remember the scope for the rest of this `/crib-enrich` session and pass `{scope:{pathPrefix, cluster?}}` to EVERY `enrich({op:'status'})` + `enrich({op:'next'})` call. The scope lives in your prompt context, not server-side. Resolve the choice:
- A number `1–5` → `scope.pathPrefix = scopes[n-1].pathPrefix`.
- A custom prefix string → `scope.pathPrefix = <that string>`.
- `list clusters <n>` → call `enrich({ op:'next', layer:'cluster', scope:{pathPrefix: scopes[n-1].pathPrefix}, limit: 25 })`. This returns the **pending cluster work items** under that prefix; each item's `targetId` is a cluster id (e.g. `c:cli-mod`). Show them, let the user pick one, then set `scope.cluster = <that targetId>` (the `c:`-prefixed id, or its bare slug, both accepted).
- `full` → no scope (undefined).

If a new `/crib-enrich` turn cannot find the scope in context, **re-call `enrich({ op:'status', scopes:true })` and re-prompt — never silently default to full-repo.** That silent default is the failure mode being fixed.

## Phase 0.5 — the skeleton bible (once, before Phase 1, unscoped only)

Before authoring any per-target analysis, author a quick **draft skeleton system bible** so an
overview is useful at 0% enrichment. Gate it on `enrich({op:'status'})` (unscoped):

```
s = enrich({ op:'status' })                                  # NO scope — system is whole-repo only
if s.systemSkeleton.present === false:
    batch = enrich({ op:'next', layer:'system', skeleton:true })   # single work item, llm:system-skeleton: batchId
    item = batch.items[0]
    # Author a DRAFT: confidence ≤ 0.6, and put a draft note in analysis.whatToDistrust
    #   e.g. "Draft skeleton — not yet grounded in per-symbol analyses; will be superseded."
    # Seed gives you: repo, stats, functionalMap (modules), top READMEs, topSymbols, caveats.
    result = enrich({ op:'save', batchId: batch.batchId, items:[author(item)] })
    report: "Draft skeleton bible saved (low-confidence). Phase 1 will supersede it with the full pass."
# then proceed to Phase 1.
```

- **Explicit-only:** `skeleton:true` is never auto-chosen by `nextLayer` — you must ask for it. This
  prevents driver loops. A second `enrich({ op:'next', layer:'system', skeleton:true })` returns an empty
  batch once a fresh skeleton exists, so author it **once**.
- **A skeleton never satisfies the system layer** — `enrich({op:'status'}).layers.system.missing` stays 1,
  so the final full pass (`enrich({ op:'next', layer:'system' })`, batchId prefix `llm:system:`) is still
  offered in Phase 1 and **overwrites** the skeleton at the same path. `overview` surfaces the
  skeleton (with `systemProvenance.mode:"skeleton"`) only until the full bible lands.
- **Scoped runs skip Phase 0.5** — the system layer is whole-repo only.

## Phase 1 — one batch, author, save, stop (the default loop, per turn)

```
s = enrich({ op:'status', ...(scope? {scope} : {}) })
if s.scopeEmpty:  print "No pending targets under '<scope.pathPrefix>'. Check the path prefix." and re-present the picker; STOP.
if s.done:        report completion (see below) and STOP. Do NOT call `enrich({op:'next'})`.
batch = enrich({ op:'next', ...(scope? {scope} : {}) })              # NO limit — token packer fills the batch
# Server-side zero-progress guard (source of truth, survives context compaction):
if batch.zeroProgress || batch.batchId === lastBatchId:  break + report zero-progress (see rule 2). Do NOT author.
lastBatchId = batch.batchId
items = []
for item in batch.items: items.push(author(item))              # YOU reason + author (see contract)
result = enrich({ op:'save', batchId: batch.batchId, items })        # server validates + persists
report: layer, accepted/rejected, droppedEdges, batch.remaining, overall done
STOP — return to the user. Re-run /crib-enrich to continue.
```

- **Do not pass `limit`.** The server's token packer walks the importance-ranked pending list and fills the batch against `DEFAULT_BATCH_TOKENS` (24k), capped at the 60-item safety ceiling. A fixed `limit: 4` was the throttle that made 34 symbols take 9 turns; the default now packs many more cheap items per batch. Seeds also sample long caller/callee lists (`callersTotal`/`calleesTotal` report the true fan-in), which is what stopped one heavily-referenced symbol from consuming an entire batch alone. Pass `limit` only to lower the ceiling; pass `budgetTokens` only to tighten/loosen the budget.
- **`oversized` / `budgetExceeded`:** if you pass a `budgetTokens` and the FIRST item alone exceeds it, the server returns that one item alone with `oversized: true` (the queue never stalls). Author it — or raise the budget / route the item to a bigger tier — then continue.
- **Layers run in order:** `symbol` → `file` → `cluster` → `system`. `enrich({op:'status'}).nextLayer` tells you which is next; never jump ahead — higher layers' `lowerLayer` payload contains the saved child analyses you synthesize from. **Under a scope, `nextLayer` excludes `system`** (system is whole-repo only) — a scoped run ends at the cluster layer.
- **Resumable:** already-`fresh` targets are skipped; `enrich({op:'status'})` reports the first `missing|stale` layer. Just call `enrich({op:'next'})` again next turn.
- **`remaining`** in each batch tells the user how many are left in that layer.
- **Rejected items:** if `enrich({op:'save'})` returns `rejected[].reason`, note them; the next turn's `enrich({ op:'next', ...scope })` still sees those targetIds as pending and re-offers them. Fix and re-submit — do not silently drop.

## Phase 1-auto — bounded autonomous loop (opt-in only)

Enter this mode **only** when the user explicitly asks ("keep going", "auto", "drain the queue", `--auto`). The default turn stays one batch. The autonomous loop runs multiple batches in one turn, bounded by **all three** of:

- a **token ceiling** (`maxTokens`, default 100k) — the sum of batch costs across the loop,
- a **max batch count** (`maxBatches`, default 5) — a hard turn cap, and
- the **layer boundary** — STOP when `enrich({op:'next'})` would cross to a new layer.

```
spent = 0; batches = 0; layer = (scope? scope-implied nextLayer : enrich({op:'status'}).nextLayer)
while true:
    s = enrich({ op:'status', ...(scope? {scope} : {}) })
    if s.done or s.scopeEmpty:  report completion; break
    if s.nextLayer !== layer:   print "reached layer boundary (<layer> → <s.nextLayer>) — stopping for review."; break
    batch = enrich({ op:'next', ...(scope? {scope} : {}) })
    if batch.zeroProgress || batch.batchId === lastBatchId:  break + report zero-progress (rule 2). Do NOT author.
    if batch.costEstimate.batch + spent > maxTokens:  print "token ceiling reached (~<spent> tokens) — stopping for review."; break
    lastBatchId = batch.batchId
    items = [author(item) for item in batch.items]
    result = enrich({ op:'save', batchId: batch.batchId, items })
    if result.rejected and result.rejected.length > 0:  print "rejected items — stopping for review."; break
    spent += batch.costEstimate.batch; batches += 1
    report: batch <batches>: layer, accepted/rejected, droppedEdges, batch.remaining
    if batches >= maxBatches:  print "max-batches reached (<maxBatches>) — stopping for review."; break
report: total batches, tokens spent, remaining per layer, which bound stopped the loop
```

- **Break immediately** on `zeroProgress`, on any `rejected[]`, or at a layer boundary — do not power through. `zeroProgress` is the primary break (server-side, survives context compaction).
- **Layer-boundary stop is deliberate:** lower layers feed upper ones (`lowerLayer` seed). Auto-draining `symbol` → `file` without review lets a bad symbol pattern propagate into every file synthesis before you see it. Stop at the boundary, let the user review, then resume.
- **`maxTokens` is the sum of `costEstimate.batch` across the loop** (the packer already guarantees each batch fits its own `DEFAULT_BATCH_TOKENS`); the ceiling bounds the *turn*, not the batch.

### Completion reporting

- **Unscoped, `done:true`:** call `mcp__knowledge-crib__overview` (no scope) and give the user a
  short v2 summary — the system bible purpose, then the top modules (`name — purpose (coverage%)`).
  `overview` is now lean by default (modules + analyses pointers + system); pass `withLlm:true` only
  if the user asks for the full analysis blobs. Do not dump the full JSON unless asked.
- **Scoped, `done:true`:** do NOT call `overview` with no scope (it would mislead). Report: *"Module `<scope.pathPrefix>` complete: N symbols / M files / K clusters fresh. The whole-repo system layer is NOT enriched under scope — run `/crib-enrich` and pick `full` (or a different module) to continue. For this module's bible now, run `/crib-enrich` and ask for `overview --scope <pathPrefix>`."*
- **Stale artifacts:** if `enrich({op:'status'})` shows `stale > 0`, tell the user once: *"<S> artifacts are stale (code changed since last enrich) and will be re-authored."*

## The author contract — what you write per item

For each `item` from `enrich({op:'next'})`, read `item.seed` (grounding), `item.lowerLayer` (saved child analyses for file/cluster/system), `item.outputSchema` (the JSON Schema your output MUST satisfy), and `item.instructions`. **Honor `item.suggestedTier`** — route the item to the model tier it names (`fast`/`balanced`/`powerful`); a multi-tier host fans a batch's items across tiers by this field (see the cost model below for the mapping and why it is the biggest cost lever). Then author ONE object:

```json
{
  "targetId": "<item.targetId — verbatim>",
  "model": "<your model id, e.g. claude-opus-4-8>",
  "analysis": {
    "purpose": "<one paragraph: what this target is for>",
    "responsibilities": ["<responsibility 1>", "..."],
    "businessRules": [{ "rule": "...", "rationale": "...", "sourceRef": "<line or symbol id>" }],
    "inputs": [...], "outputs": [...], "sideEffects": [...],
    "errorBehavior": [...], "invariants": [...],
    "preconditions": [...], "postconditions": [...],
    "risks": [...],
    "whatToDistrust": ["<where the seed was truncated / a call was unresolved / you are unsure>"],
    "confidence": 0.0
  },
  "graph": {
    "nodes": [{ "localId": "rule:dti-cap", "kind": "business-rule", "name": "DTI 43% cap", "summary": "..." }],
    "edges": [{ "from": "<soul id or localId>", "to": "<soul id or localId>", "rel": "enforces", "rationale": "...", "confidence": 0.0 }]
  },
  "evidence": [{ "soulId": "<id from seed>", "quote": "<verbatim text lifted from that node's source span>", "why": "<what this quote justifies>" }]
}
```

### Required fields (server rejects otherwise)
- `analysis`: object with `purpose` (string), `responsibilities` (string[]), `confidence` (number 0–1).
- `graph`: `{ nodes: [], edges: [] }`. Every node needs `localId`, `kind`, `name`. Every edge needs `from`, `to`, `rel`. `confidence` (if set) must be 0–1.
- `evidence`: array (can be empty, but prefer at least one pointer per non-trivial claim).

### Grounding contract (M1.3 — the moat)
- `evidence[].quote` is a **verbatim substring** lifted from the `soulId` node's rehydrated source span. At `enrich({op:'save'})` time the server rehydrates the anchor span and checks the quote overlaps it.
- A `quote` that does NOT appear in the span is a **hallucination** — the whole item is **rejected** ("no evidence grounded"). Re-read `item.seed.sourceBody` and copy the exact text; do not paraphrase, do not invent.
- Evidence **without** a `quote` (just `{soulId, why}`) is `unsupported` — downgraded, not rejected (backward-compatible). But a grounded `quote` is the strongest signal; prefer it for every non-trivial claim.
- `evidence[].startLine` (optional) pages a large span to the line the quote came from.
- After a refactor, `crib audit-llm` re-runs this exact check against every persisted artifact. An artifact whose save-time `grounded` stamp no longer matches the recomputed verdict is reported as **drift**.

### Node `kind` values (use these)
`concept` | `entity` | `business-rule` | `capability` | `feature` | `flow` | `invariant` | `decision`

### Edge `rel` values (use these)
`realizes` | `validates` | `governs` | `part-of-feature` | `transforms` | `depends-on-concept` | `produces` | `consumes` | `enforces` | `triggers`

## Grounding rule (anti-hallucination) — the server enforces this on save

Every `graph.edge` endpoint must resolve to **(a)** a real soul node id present in `item.seed` (e.g. `sym:...@L120`, the node itself, its callers, callees), **or (b)** a `localId` authored in *this* item or an *earlier saved* item. The server drops edges with unresolved endpoints and reports them in `enrich({op:'save'})` → `accepted[].droppedEdges`. Scope does NOT constrain edge resolution — cross-scope edges (a `packages/core` symbol calling a `packages/mcp` symbol) resolve against the full soul, so they are fine. To avoid drops:
- Point `from`/`to` at the target's own soul id, its callers/callees (from `seed.callers`/`seed.callees`), or a `localId` you just defined in this item's `graph.nodes`.

**Never invent code facts.** If `seed.coverage.readiness === "unimplemented"` (body absent), say so in `analysis.purpose`/`whatToDistrust` and author the graph from the *signature* + *spec context*, not a body that doesn't exist. Mark `confidence` lower (0.3–0.5) for spec-only symbols.

## Per-layer guidance

- **symbol** — `seed` = full dossier (`node`, `sourceBody`, `callers`, `callees`, `decisionTable`, `controlFlow`, `coverage`). Author purpose, business rules, invariants, IO, side effects, errors, risks. Emit `business-rule`/`invariant`/`concept` nodes + `realizes`/`validates`/`enforces` edges to the symbol's own soul id and its callees.
- **file** — `lowerLayer.symbols` = the saved symbol analyses for symbols in this file. Synthesize the file's purpose and `part-of-feature` / `capability` edges. Do NOT re-derive what each symbol does — compose from the child analyses.
- **cluster** — `seed.members` + `lowerLayer.files`. Name the module, describe its responsibility, emit `capability` nodes + `depends-on-concept` edges to other clusters' concepts. A cluster in-scope via one prefix may have member files OUTSIDE the prefix — note in `whatToDistrust` which member files lack a fresh analysis.
- **system** — `lowerLayer.clusters` + `seed.entryPoints`. Produce the **bible**: architecture, subsystems, **cross-cutting flows** (a `flow` node like `flow:loan-approval` chaining symbols across files via `triggers`/`transforms` edges), **domain glossary** (`entity` nodes: DTI, LTV, AML, KYC…), tech stack, and a risk map. This is the headline artifact; spend the most reasoning here. **The system layer is whole-repo only — it is never offered under a scope.** When authoring the domain glossary, also emit the alias dictionary (below) so acronym queries resolve.

## Model-tier hints + cost model (M2.7)

Every `enrich({op:'next'})` item carries `suggestedTier` ∈ `{fast, balanced, powerful}` — a deterministic
recommendation for which model tier to author that item with. `costEstimate.perItem` mirrors it so a
host dispatcher can route from either surface. **Honor the tier:** routing each item to its suggested
tier is the single biggest cost lever on the enrichment queue (symbols are the bulk; the bible is
rare). A multi-tier host (Claude Code, Codex, Copilot CLI) should fan a batch's items across tiers by
this field; a single-tier host uses it only to anticipate per-item effort.

| layer | suggestedTier | why | rel. cost × |
|-------|---------------|-----|-------------|
| symbol | `fast` | many small per-callable analyses; the bulk by count | 1× |
| file | `balanced` | mid-synthesis: compose the child symbol analyses | 3× |
| cluster | `balanced` | mid-synthesis: name a module, cross-cluster concepts | 3× |
| system | `powerful` | the bible — the rare, high-synthesis whole-repo pass | 10× |
| system (skeleton) | `balanced` | a lightweight Phase-0.5 draft, not the full bible | 3× |

**Cost model (relative, not absolute — stable as prices move).** Per enrichment pass:

```
$pass ≈ Σ_items ( tokens_item × tierMultiplier_item × $/1M @ that tier )
       = Σ_items ( tokens_item × {fast:1, balanced:3, powerful:10}[item.suggestedTier] × $/1M @ tier )
```

`tokens_item` is the per-item estimate from `costEstimate.perItem[i].tokens`. Because `fast` handles
the bulk by count, a full pass costs roughly `fast_count × 2500 × 1× + file_count × 5000 × 3× +
cluster_count × 8000 × 3× + 1 × 12000 × 10×` — i.e. the per-symbol line dominates by count, the
system line dominates by per-item cost, and the total stays a small multiple of the symbol-tier cost.
The crib never calls a model; this is the estimate a host uses to budget a pass before it starts.

## Alias dictionary (`.crib/graph/semantic/aliases.json`)

Acronyms and domain shorthand ("DTI", "LTV", "AML") rarely share a token with the symbol that
implements them: `DebtToIncomeCalculator` tokenizes (FTS5 `unicode61`, no camelCase split) to a
single token `debttoincomecalculator`, so a user query "DTI" (prefix `dti*`) misses it entirely.
The alias dictionary maps each shorthand to a phrase that DOES share a token-prefix with the
canonical symbol surface; a deterministic rewrite pass appends the expansion to the query before
it reaches the index (`query` and `ask` verbs only — the index itself stays alias-agnostic).

**File** (committed, per-repo, agent-authorable, same layer as the rest of the LLM graph):

```json
{
  "version": 1,
  "aliases": [
    { "alias": "DTI", "expand": "debt to income" },
    { "alias": "LTV", "expand": "loan to value" }
  ]
}
```

**Author it from the system-layer glossary.** When you emit `entity` nodes for DTI/LTV/AML/KYC,
write the matching `aliases.json` via `writeAliases(cribDir, entries)` (exported from
`@knowledge-crib/core`) — or just write the JSON by hand. Rules:

- The `alias` is matched as a **case-sensitive whole word** (word boundaries on both sides), so
  "DTI" fires but a lowercase "dti" inside another token does not. Carry the canonical casing the
  user types.
- The `expand` phrase should contain a token-prefix that hits the implementing symbol's surface
  ("debt" hits `debttoincomecalculator`). Multi-word expansions are fine.
- First write wins on a duplicated alias. An absent or malformed file is treated as an empty
  dictionary — every query path is byte-identical when no aliases are configured (zero regression
  for repos without a dictionary). Determinism is preserved: the rewrite is a pure function, and
  file lives in committed `.crib/graph/semantic/` layer, never derived index.

## Honesty

- `confidence` is mandatory and must reflect how grounded your analysis is. Spec-only/unimplemented symbols → lower confidence, flagged in `whatToDistrust`.
- If `seed.sourceBody.truncated === true`, note it in `whatToDistrust` and avoid claiming details beyond the shown span.
- Never fill `businessRules` from imagination — tie each to a `sourceRef` (line number or symbol id) in `evidence`.
- If the server rejects an item (`rejected[].reason`), fix that item and re-submit it in the next batch — do not silently drop it.

## Tools

- `mcp__knowledge-crib__enrich (op:'status')` — `{ layer?, scope?, scopes? }`. Coverage + `nextLayer` + `done` + `systemSkeleton:{present,fresh}`; with `scopes:true` also returns `totalPending` + `threshold` + `scopes[]` for the picker; with `scope` also returns `scopeEcho` + `scopeEmpty` + `wholeRepoPending.system`.
- `mcp__knowledge-crib__enrich (op:'next')` — `{ layer?, limit?, scope?, budgetTokens?, skeleton? }` → grounded batch + `batchId` + `selectedTargetIds` + `remaining` + `previousBatchId` + `zeroProgress` + `oversized`. The batch is filled by a **token packer** (greedy strict-prefix over the importance-ranked pending list) against `budgetTokens` (default `DEFAULT_BATCH_TOKENS` = 24k), capped at `limit` (default 25, the hard ceiling). Do NOT pass `limit: 4`. `batchId` is deterministic over the full pending set (independent of `limit`/budget); `zeroProgress: true` means the server already issued this `batchId` for this (layer, scope) with no save landing — break. `oversized: true` (with `budgetExceeded: true`) means the first item alone exceeded `budgetTokens` and was returned alone — author it, or raise the budget / route to a bigger tier. Queue is importance-ranked (tests last). `skeleton:true` + `layer:'system'` → the Phase-0.5 draft-bible work item.
- `mcp__knowledge-crib__enrich (op:'save')` — `{ batchId, items }` → `{ accepted, rejected }`. Scope is NOT a write constraint (cross-scope edges resolve against the full soul). A `llm:system-skeleton:` batch is stamped `mode:"skeleton"` server-side.
- `mcp__knowledge-crib__overview` — `{ scope?, withLlm? }` → v2 bible: `modules` (always present) + lean `analyses` pointers + `system`/`systemProvenance`. Omit scope for the cached whole-repo overview.json; pass scope for a module bible (excludes the system layer). `withLlm:true` folds the full analysis+graph+evidence blobs into a `full` array (computed live).
- `mcp__knowledge-crib__llm_neighbors` — (optional) walk the semantic graph around a symbol to sanity-check your edges.

If the MCP server is not connected, the same loop is drivable headlessly via the CLI: `crib enrich --scopes` prints the ranked picker data; `crib enrich --next --scope <prefix> [--layer L] [--limit N] [--budget-tokens N]` prints a scoped grounded batch (author items to a JSON file `{batchId, items}` and persist with `crib enrich --save <file>`); `crib enrich --auto --max-tokens N --max-batches N [--layer L] [--scope PFX]` runs the bounded autonomous loop headlessly (per-batch progress, stops at the token ceiling / max-batches / layer boundary, exits non-zero on zero-progress or rejects); `crib enrich --overview --scope <prefix>` prints a module bible; `crib enrich --scope <prefix>` prints scoped coverage.
