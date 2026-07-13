---
name: crib-enrich
description: Drive the knowledge-crib LLM semantic-graph generation loop. Use when the user says "crib-enrich", "enrich the crib", "build the LLM graph", "generate the codebase bible", or when `crib enrich` / `mcp__knowledge-crib__enrich_status` shows pending LLM targets. On large repos it shows a graphify-style scope picker first (which module to enrich), then authors deep per-target analysis + a grounded semantic graph bottom-up across symbol → file → cluster → system, ONE batch per turn. The crib MCP server never calls a model — YOU (the host IDE LLM) are the generator; it only hands you grounded seed and persists what you author.
---

# crib-enrich — author knowledge-crib's LLM semantic graph

You are the **generator**. The `knowledge-crib` MCP server is 100% deterministic: it exposes a work queue (`enrich_next`), validates + persists what you author (`enrich_save`), reports coverage (`enrich_status`), and ranks scopes (`enrich_status({scopes:true})`). It never calls a model. You drive the loop, author each work item against its schema, ground every claim in the seed it hands you, and save.

## When to run

- The user asks to enrich the crib / build the LLM graph / generate the codebase bible.
- `mcp__knowledge-crib__enrich_status` (or `crib enrich`) shows `done: false` with pending targets.
- After a fresh `crib index` (it prints "N target(s) pending LLM graph generation — run /crib-enrich").

Do **not** run if `enrich_status` reports `done: true` unless the user forces a re-run (e.g. code changed and artifacts are `stale`).

## Not a search command

`/crib-enrich` generates and persists LLM analysis; it does not look up arbitrary text. If the
invocation asks to "search", "find", "look up", or explain a named symbol, do not enter the
enrichment queue. Tell the user to use the Knowledge-crib `query` MCP tool (or
`crib query "<text>"`) and perform that lookup when the tool is available. Also correct
`/crib-enric` to `/crib-enrich` when the final `h` is missing.

## ⚠️ The two rules that prevent the infinite loop

1. **ONE batch per turn. HARD STOP.** You pull one batch, author it, save it, report progress, and **return to the user**. You do NOT re-enter the loop inside one invocation. Never call `enrich_next` twice in one turn. The old "repeat until done" loop is gone on purpose — with thousands of pending targets it loops forever and burns tokens. Re-running `/crib-enrich` continues from where you left off.
2. **Zero-progress guard.** `batchId` is deterministic (same pending set ⇒ same id) AND the server persists the last-issued batchId per `(layer, scope)` and echoes `previousBatchId` + `zeroProgress` in every `enrich_next` response. If `batchId === previousBatchId` (i.e. the response carries `zeroProgress: true`), do NOT author or save — break and report: *"No progress: `enrich_next` returned the same batchId (`<id>`) the server already issued for this (layer, scope) with no save landing in between. Stopping. Check that `enrich_save` is persisting (`rejected[].reason`)."* This is the **server-side source of truth** — it fires even after context compaction forgets the id you saw last turn, so a headless driver need not remember anything. The host-memory comparison (`batchId === lastBatchId`) is now a secondary backstop, not the primary check.

## Phase 0 — the scope picker (first thing, once per session)

Call `mcp__knowledge-crib__enrich_status` with `{ scopes: true }` and NO scope.

- If `totalPending <= threshold` (the response's `threshold` field, default 200) OR `scopes` is empty: **skip the picker**, proceed to Phase 1 with no scope.
- If `totalPending > threshold` AND `scopes.length > 0`: print the picker block below **verbatim** (fill in the real numbers from the response), then **STOP and wait for the user**. Do not call `enrich_next`.

```
This repo has <totalPending> pending LLM targets across 4 layers (symbol: <s> pending, file: <f> pending, cluster: <c> pending, system: 1 total), exceeding the recommended threshold of <threshold>. At 4 items/batch that is ~<totalPending/4> batches — enriching everything unattended is not realistic. Which module should I enrich first?

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
  • Type 'full' to enrich the whole repo (not recommended — ~<totalPending/4> batches).

I'll wait for your choice before proceeding.
```

**Scope carry:** once the user picks, remember the scope for the rest of this `/crib-enrich` session and pass `{scope:{pathPrefix, cluster?}}` to EVERY `enrich_status` + `enrich_next` call. The scope lives in your prompt context, not server-side. Resolve the choice:
- A number `1–5` → `scope.pathPrefix = scopes[n-1].pathPrefix`.
- A custom prefix string → `scope.pathPrefix = <that string>`.
- `list clusters <n>` → call `enrich_next({layer:'cluster', scope:{pathPrefix: scopes[n-1].pathPrefix}, limit: 25})`. This returns the **pending cluster work items** under that prefix; each item's `targetId` is a cluster id (e.g. `c:cli-mod`). Show them, let the user pick one, then set `scope.cluster = <that targetId>` (the `c:`-prefixed id, or its bare slug, both accepted).
- `full` → no scope (undefined).

If a new `/crib-enrich` turn cannot find the scope in context, **re-call `enrich_status({scopes:true})` and re-prompt — never silently default to full-repo.** That silent default is the failure mode being fixed.

## Phase 0.5 — the skeleton bible (once, before Phase 1, unscoped only)

Before authoring any per-target analysis, author a quick **draft skeleton system bible** so an
overview is useful at 0% enrichment. Gate it on `enrich_status` (unscoped):

```
s = enrich_status({})                                  # NO scope — system is whole-repo only
if s.systemSkeleton.present === false:
    batch = enrich_next({ layer:'system', skeleton:true })   # single work item, llm:system-skeleton: batchId
    item = batch.items[0]
    # Author a DRAFT: confidence ≤ 0.6, and put a draft note in analysis.whatToDistrust
    #   e.g. "Draft skeleton — not yet grounded in per-symbol analyses; will be superseded."
    # Seed gives you: repo, stats, functionalMap (modules), top READMEs, topSymbols, caveats.
    result = enrich_save({ batchId: batch.batchId, items:[author(item)] })
    report: "Draft skeleton bible saved (low-confidence). Phase 1 will supersede it with the full pass."
# then proceed to Phase 1.
```

- **Explicit-only:** `skeleton:true` is never auto-chosen by `nextLayer` — you must ask for it. This
  prevents driver loops. A second `enrich_next({layer:'system', skeleton:true})` returns an empty
  batch once a fresh skeleton exists, so author it **once**.
- **A skeleton never satisfies the system layer** — `enrich_status.layers.system.missing` stays 1,
  so the final full pass (`enrich_next({layer:'system'})`, batchId prefix `llm:system:`) is still
  offered in Phase 1 and **overwrites** the skeleton at the same path. `overview` surfaces the
  skeleton (with `systemProvenance.mode:"skeleton"`) only until the full bible lands.
- **Scoped runs skip Phase 0.5** — the system layer is whole-repo only.

## Phase 1 — one batch, author, save, stop (the loop, per turn)

```
s = enrich_status({ ...(scope? {scope} : {}) })
if s.scopeEmpty:  print "No pending targets under '<scope.pathPrefix>'. Check the path prefix." and re-present the picker; STOP.
if s.done:        report completion (see below) and STOP. Do NOT call enrich_next.
batch = enrich_next({ ...(scope? {scope} : {}), limit: 4 })     # grounded seed + schema per item
# Server-side zero-progress guard (source of truth, survives context compaction):
if batch.zeroProgress || batch.batchId === lastBatchId:  break + report zero-progress (see rule 2). Do NOT author.
lastBatchId = batch.batchId
items = []
for item in batch.items: items.push(author(item))              # YOU reason + author (see contract)
result = enrich_save({ batchId: batch.batchId, items })        # server validates + persists
report: layer, accepted/rejected, droppedEdges, batch.remaining, overall done
STOP — return to the user. Re-run /crib-enrich to continue.
```

- **Layers run in order:** `symbol` → `file` → `cluster` → `system`. `enrich_status.nextLayer` tells you which is next; never jump ahead — higher layers' `lowerLayer` payload contains the saved child analyses you synthesize from. **Under a scope, `nextLayer` excludes `system`** (system is whole-repo only) — a scoped run ends at the cluster layer.
- **Resumable:** already-`fresh` targets are skipped; `enrich_status` reports the first `missing|stale` layer. Just call `enrich_next` again next turn.
- **Batched:** `limit` (default 4, max 25) bounds tokens per turn. Process one batch per turn and report progress.
- **`remaining`** in each batch tells the user how many are left in that layer.
- **Rejected items:** if `enrich_save` returns `rejected[].reason`, note them; the next turn's `enrich_next(scope)` still sees those targetIds as pending and re-offers them. Fix and re-submit — do not silently drop.

### Completion reporting

- **Unscoped, `done:true`:** call `mcp__knowledge-crib__overview` (no scope) and give the user a
  short v2 summary — the system bible purpose, then the top modules (`name — purpose (coverage%)`).
  `overview` is now lean by default (modules + analyses pointers + system); pass `withLlm:true` only
  if the user asks for the full analysis blobs. Do not dump the full JSON unless asked.
- **Scoped, `done:true`:** do NOT call `overview` with no scope (it would mislead). Report: *"Module `<scope.pathPrefix>` complete: N symbols / M files / K clusters fresh. The whole-repo system layer is NOT enriched under scope — run `/crib-enrich` and pick `full` (or a different module) to continue. For this module's bible now, run `/crib-enrich` and ask for `overview --scope <pathPrefix>`."*
- **Stale artifacts:** if `enrich_status` shows `stale > 0`, tell the user once: *"<S> artifacts are stale (code changed since last enrich) and will be re-authored."*

## The author contract — what you write per item

For each `item` from `enrich_next`, read `item.seed` (grounding), `item.lowerLayer` (saved child analyses for file/cluster/system), `item.outputSchema` (the JSON Schema your output MUST satisfy), and `item.instructions`. Then author ONE object:

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
- `evidence[].quote` is a **verbatim substring** lifted from the `soulId` node's rehydrated source span. At `enrich_save` time the server rehydrates the anchor span and checks the quote overlaps it.
- A `quote` that does NOT appear in the span is a **hallucination** — the whole item is **rejected** ("no evidence grounded"). Re-read `item.seed.sourceBody` and copy the exact text; do not paraphrase, do not invent.
- Evidence **without** a `quote` (just `{soulId, why}`) is `unsupported` — downgraded, not rejected (backward-compatible). But a grounded `quote` is the strongest signal; prefer it for every non-trivial claim.
- `evidence[].startLine` (optional) pages a large span to the line the quote came from.
- After a refactor, `crib audit-llm` re-runs this exact check against every persisted artifact. An artifact whose save-time `grounded` stamp no longer matches the recomputed verdict is reported as **drift**.

### Node `kind` values (use these)
`concept` | `entity` | `business-rule` | `capability` | `feature` | `flow` | `invariant` | `decision`

### Edge `rel` values (use these)
`realizes` | `validates` | `governs` | `part-of-feature` | `transforms` | `depends-on-concept` | `produces` | `consumes` | `enforces` | `triggers`

## Grounding rule (anti-hallucination) — the server enforces this on save

Every `graph.edge` endpoint must resolve to **(a)** a real soul node id present in `item.seed` (e.g. `sym:...@L120`, the node itself, its callers, callees), **or (b)** a `localId` authored in *this* item or an *earlier saved* item. The server drops edges with unresolved endpoints and reports them in `enrich_save` → `accepted[].droppedEdges`. Scope does NOT constrain edge resolution — cross-scope edges (a `packages/core` symbol calling a `packages/mcp` symbol) resolve against the full soul, so they are fine. To avoid drops:
- Point `from`/`to` at the target's own soul id, its callers/callees (from `seed.callers`/`seed.callees`), or a `localId` you just defined in this item's `graph.nodes`.

**Never invent code facts.** If `seed.coverage.readiness === "unimplemented"` (body absent), say so in `analysis.purpose`/`whatToDistrust` and author the graph from the *signature* + *spec context*, not a body that doesn't exist. Mark `confidence` lower (0.3–0.5) for spec-only symbols.

## Per-layer guidance

- **symbol** — `seed` = full dossier (`node`, `sourceBody`, `callers`, `callees`, `decisionTable`, `controlFlow`, `coverage`). Author purpose, business rules, invariants, IO, side effects, errors, risks. Emit `business-rule`/`invariant`/`concept` nodes + `realizes`/`validates`/`enforces` edges to the symbol's own soul id and its callees.
- **file** — `lowerLayer.symbols` = the saved symbol analyses for symbols in this file. Synthesize the file's purpose and `part-of-feature` / `capability` edges. Do NOT re-derive what each symbol does — compose from the child analyses.
- **cluster** — `seed.members` + `lowerLayer.files`. Name the module, describe its responsibility, emit `capability` nodes + `depends-on-concept` edges to other clusters' concepts. A cluster in-scope via one prefix may have member files OUTSIDE the prefix — note in `whatToDistrust` which member files lack a fresh analysis.
- **system** — `lowerLayer.clusters` + `seed.entryPoints`. Produce the **bible**: architecture, subsystems, **cross-cutting flows** (a `flow` node like `flow:loan-approval` chaining symbols across files via `triggers`/`transforms` edges), **domain glossary** (`entity` nodes: DTI, LTV, AML, KYC…), tech stack, and a risk map. This is the headline artifact; spend the most reasoning here. **The system layer is whole-repo only — it is never offered under a scope.**

## Honesty

- `confidence` is mandatory and must reflect how grounded your analysis is. Spec-only/unimplemented symbols → lower confidence, flagged in `whatToDistrust`.
- If `seed.sourceBody.truncated === true`, note it in `whatToDistrust` and avoid claiming details beyond the shown span.
- Never fill `businessRules` from imagination — tie each to a `sourceRef` (line number or symbol id) in `evidence`.
- If the server rejects an item (`rejected[].reason`), fix that item and re-submit it in the next batch — do not silently drop it.

## Tools

- `mcp__knowledge-crib__enrich_status` — `{ layer?, scope?, scopes? }`. Coverage + `nextLayer` + `done` + `systemSkeleton:{present,fresh}`; with `scopes:true` also returns `totalPending` + `threshold` + `scopes[]` for the picker; with `scope` also returns `scopeEcho` + `scopeEmpty` + `wholeRepoPending.system`.
- `mcp__knowledge-crib__enrich_next` — `{ layer?, limit?, scope?, skeleton? }` → grounded batch + `batchId` + `selectedTargetIds` + `remaining` + `previousBatchId` + `zeroProgress`. `batchId` is deterministic over the full pending set (independent of `limit`); `zeroProgress: true` means the server already issued this `batchId` for this (layer, scope) with no save landing — break. Queue is importance-ranked (tests last). `skeleton:true` + `layer:'system'` → the Phase-0.5 draft-bible work item.
- `mcp__knowledge-crib__enrich_save` — `{ batchId, items }` → `{ accepted, rejected }`. Scope is NOT a write constraint (cross-scope edges resolve against the full soul). A `llm:system-skeleton:` batch is stamped `mode:"skeleton"` server-side.
- `mcp__knowledge-crib__overview` — `{ scope?, withLlm? }` → v2 bible: `modules` (always present) + lean `analyses` pointers + `system`/`systemProvenance`. Omit scope for the cached whole-repo overview.json; pass scope for a module bible (excludes the system layer). `withLlm:true` folds the full analysis+graph+evidence blobs into a `full` array (computed live).
- `mcp__knowledge-crib__llm_neighbors` — (optional) walk the semantic graph around a symbol to sanity-check your edges.

If the MCP server is not connected, the same loop is drivable headlessly via the CLI: `crib enrich --scopes` prints the ranked picker data; `crib enrich --next --scope <prefix> [--layer L] [--limit N]` prints a scoped grounded batch (author items to a JSON file `{batchId, items}` and persist with `crib enrich --save <file>`); `crib enrich --overview --scope <prefix>` prints a module bible; `crib enrich --scope <prefix>` prints scoped coverage.
