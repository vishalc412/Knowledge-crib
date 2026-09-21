# Knowledge-crib — graph / memory / graph-RAG audit and competitive gap analysis

**Audit date:** 2026-09-20. **Branch:** `claude/graph-memory-rag-audit-600923` (worktree),
**HEAD:** `342d8c1e`. **Host:** Apple M4 Max, darwin 25.6.0, Node 22.
**Auditor role:** independent architecture review. **Prior art:** this report is the companion to
[`docs/audits/2026-09-05/competitor-research.md`](../2026-09-05/competitor-research.md), which
covered the *memory* market from vendor documentation. This one is grounded in **this
repository's source and in runs executed against it**, and extends the comparison into the two
markets that document did not cover: **graph-RAG pipelines** and **code-intelligence indexers**.

**Method and its limits.** Every finding below cites either a source location in this repository or
a command executed against this worktree during the audit. No competitor software was installed,
invoked or benchmarked; competitor statements are attributed to public documentation and are
labelled as such. Where a competitor claim is a vendor number, it is named as a vendor number.
Nothing here was measured on Linux or Windows. The MCP server (`knowledge-crib`) failed to connect
in the auditing session (`CONNECTION_CLOSED`), so all graph verbs were exercised through the `crib`
CLI instead — same `Verbs` layer, different transport, and no MCP-transport claim is made.

---

## 1. What the shipped system actually is, measured

A clean index of this repository was built twice during the audit.

```
crib index .              → 953 files, 48,327 nodes, 125,722 edges,  86,039 ms
crib index . --semantic   → 953 files, 48,327 nodes, 131,564 edges,  94,750 ms, peak RSS 806 MB
```

`crib status` on the `--semantic` build:

| capability | value |
|---|---|
| `embeddings` | **false** |
| `vector` | **false** |
| `pdg` | false |
| `multimodal` | false |
| `cypher` | false |
| `llmGraph` | **false** |

…while on the same machine `crib embed status` reports
`installed (multilingual-e5-large-1024-sym) / state: semantic-ready`.

Of the 125,722 edges in the default build, **54,285 are `references`** (the capped, weakest
relation) and **3,571 are `describes`**; ~67,900 are structural. The semantic pass added 5,842
further `references` edges. Semantic (LLM) artifacts: **0 of 3,826 targets** — 1,863 symbol, 953
file, 1,009 cluster, 1 system, `coverage.pct: 0`.

**So the product as installed is:** a deterministic multi-language code graph (tree-sitter, plus the
real TypeScript type-checker for TS) + **BM25/FTS5 lexical search** + a ~30-group static synonym
table + fixed graph traversal verbs (`impact`/`path`/`owners`/`neighbors`) + an evidence-gated
memory ledger whose recall *is* embedding-backed. Everything else — code-side vectors, the LLM
semantic layer, PDG/taint, multimodal, Cypher — is off, opt-in, unreachable, or absent.

That is a narrower system than the README implies, and the gap between the two is finding F1 and F2.

---

## 2. Findings

Severity is judged by effect on the product's own stated promise, not by code size.

### F1 — CRITICAL: the code-graph vector retrieval path is unreachable in the shipped product

`SqliteIndexStore` takes an optional embedder
(`packages/core/src/index/sqlite-index.ts:119` — `constructor(path, opts: { embedder?: Embedder | null } = {})`).
`buildVectors` only runs `if (this.embedder)` (`:135`), and query-time hybrid retrieval is gated on
`wantSemantic = q.semantic !== false && this.builtEmbedderId !== null` (`:166`), falling back to
`bm25Query` otherwise.

**No production call site ever passes an embedder.** Every construction site omits it:

- `packages/core/src/index/factory.ts:19` — `new SqliteIndexStore(opts.path ?? ':memory:')`
- `packages/cli/src/runtime.ts:289, 295, 304, 370, 406` — `openIndex(manifest.stores.index.backend, { path })`
- `packages/cli/src/refresh-coordinator.ts:486` — `new SqliteIndexStore()`
- `packages/pipeline/src/pipeline.ts:206` — `opts.index.buildFromSoul(soul, root)`, no embedder

`OpenIndexOpts` has no `embedder` field at all, so the factory cannot forward one.

Consequences, all confirmed:

1. `builtEmbedderId` is permanently `null` → `capabilities().vector` is permanently `false`
   (`sqlite-index.ts:381`), which is exactly what `crib status` reports above.
2. `vectorQuery()` (`:248`) never executes.
3. **The whole of `packages/core/src/index/rerank.ts` is dead in production** — 187 lines of
   graph-aware structural prior (centrality × stereotype-match × kind-prior), written with a
   detailed rationale about fixing a measured "java −10.5pp case", applied *only* on the hybrid
   path, which never runs. It is reachable from tests alone.
4. Code search is therefore BM25 over `name, qualifiedName, signature, heading, file, body`
   (`:51`) plus synonym expansion (`packages/core/src/index/synonyms.ts`).

**Empirically**, three paraphrase queries with no lexical overlap to the target were run against the
fresh index:

| query | top hits returned | correct target |
|---|---|---|
| "stop two machines writing the same record at the same time" | `stmt:scripts/client-certify.mjs@L1774`, `stmt:scripts/client-desktop-certify.mjs@L440`, `sym:…/multimodal/worker.ts#runWorker.finish` | `core/src/lock.ts`, freshness worker lease/epoch fencing — **missed** |
| "hide customer identifiers before saving" | `sym:packages/ui/web/support.js#hideRawTemplate`, `stmt:…/linker/media.ts@L72`, `expl:…/go/lexer.ts@L230` | `memory/src/secrets.ts`, capture-policy `pii` axis — **missed** |
| "make sure a crash does not lose an acknowledged write" | `sym:…/memory-crash-recovery.test.ts#makeRepo`, `expl:…/store.ts@L302`, `sym:…/sync/queue.ts#saveSyncState` | partially hit, but the #1 result is a test helper |

**Competitive position.** Embedding-based code retrieval is the *default*, not an option, in Cursor,
GitHub Copilot, Sourcegraph Cody, Greptile, Augment, and in the open graph-memory stacks
([Cognee](https://tryxlr8.ai/blogs/best-open-source-ai-memory-frameworks-2026) ships a combined
graph + vector + relational store with fourteen retrieval modes). A 2026 code-intelligence survey
describes vector search as one of the four substrates the field standardised on, alongside LSP,
SCIP and tree-sitter ([Anthony West](https://anthonywest.co.uk/research/code-intelligence-indexing-2026-openai)).
Shipping lexical-only code search in 2026 is a category-level deficit — and the unusual thing here
is that the fix is mostly *already written*.

**This is the highest-leverage defect in the repository.** Plumbing an embedder through
`OpenIndexOpts` → `openIndex` → `runtime.ts` activates an existing, already-reasoned, already-tested
hybrid retrieval + rerank stack.

### F2 — HIGH: the published "81.1% paraphrase recall" is a memory-ledger number presented as a system capability

The README's architecture list places, directly after the `IndexStore` bullet:

> **Semantic recall** — on-device ONNX embeddings behind `crib embed setup` (opt-in): the default
> `large` model reaches 81.1% paraphrase recall / 0.881 MRR

and [`docs/capability-matrix.md`](../../capability-matrix.md) carries
`On-device semantic recall | verified | opt-in`.

The harness behind those numbers is
`runLaunchGate(LAUNCH_SCALE_FULL, { strategy: 'semantic-only', embedder })` over
**"500 labelled queries over 307 records"** ([`docs/bench/onnx-model-ladder.md`](../../bench/onnx-model-ladder.md), lines 4–6).
Those are **memory records**, ranked by `MemoryScorer` in `packages/memory/src/fusion.ts`, wired at
`packages/mcp/src/verbs.ts:324` (`const strategy: FusionStrategy = embedder ? 'semantic-only' : 'lexical-only'`).
It is a real, well-run benchmark **of memory recall**. It says nothing about code search — and by F1
there is no code-search paraphrase measurement at all.

Adjacent to that, `crib index --semantic` does not build query-time vectors either: it runs the
linker's semantic pass (`packages/pipeline/src/linker/semantic.ts`), which emits INFERRED
`doc-section → symbol` `references` edges at confidence capped to [0.4, 0.6] using **char-n-gram**
cosine — not the installed ONNX model. The flag's name invites the reading that it enables semantic
*search*. It does not.

**Why this is severity HIGH rather than a doc nit.** This project's differentiation *is* calibrated
honesty — the capability matrix opens with "if a capability is not listed as verified here, treat it
as unverified", the launch gate holds itself at NO-GO, and `status({op:'gaps'})` volunteers its own
incompleteness. A headline retrieval number that reads as a whole-system claim while being scoped to
one subsystem is the one class of error that damages that position disproportionately. Fix the
framing before anything else ships.

### F3 — HIGH: even when activated, embeddings cover surface fields only — no body, no chunking

`vectorText(node)` (`packages/core/src/index/sqlite-index.ts:53`) is commented
*"Surface fields only — no body"* and concatenates `name`, `qualifiedName`, `signature`, `heading`,
`file`. BM25 *does* index `body` (`:51`); the vector channel does not.

So the retrieval ceiling after fixing F1 is paraphrase-matching against **identifiers and
signatures** — it will find `settleOrder` from "close out an order", but it will not find a function
whose body implements idempotent retry when nothing in its name or docstring says so. Competitors
chunk and embed the body: that is precisely how "find the code that does X" works in Cursor,
Greptile and Cody.

Related: there is **no chunking layer at all**. The retrieval unit is a graph node. That is elegant
for structural queries and a real handicap for prose-shaped questions spanning several symbols.

### F4 — HIGH: the semantic (LLM) graph layer is 0% by default, and its only automated path requires the operator to write a provider program

A fresh index leaves **3,826 enrichment targets pending, 0 fresh** (`crib enrich --scopes`:
symbol 1,863 / file 953 / cluster 1,009 / system 1; every module reports `coverage.pct: 0`).
`capabilities.llmGraph: false`.

There are two ways to fill it:

1. **Interactive** — the bundled `/crib-enrich` skill, which authors artifacts bottom-up
   (symbol → file → cluster → system), **one batch per host-agent turn**. On 3,826 targets that is a
   many-hour, many-turn, operator-supervised loop.
2. **Headless** — `crib enrich run --provider <name>`, which reads `~/.crib/providers.json` and
   spawns a **user-supplied program** (`packages/cli/src/enrich-provider.ts:34` —
   `command: string[]`, run with `shell:false`, concurrency clamped to 4). **No LLM client ships.**
   There is no bundled Anthropic, OpenAI, Ollama or Bedrock adapter; the operator writes the
   stdin/stdout JSON bridge themselves.

The security reasoning for provider-neutrality is sound and clearly stated ("the server itself makes
no model calls"). The *adoption* consequence is that the graph-RAG half of the product is empty for
every user who does not build integration code first.

**Competitive position — and an architectural critique.** Knowledge-crib chose Microsoft GraphRAG's
*shape*: hierarchical, precomputed, bottom-up community/cluster summaries feeding a global "system"
layer ([GraphRAG global search](https://microsoft.github.io/graphrag/examples_notebooks/global_search/)).
That shape is the expensive one. GraphRAG's own successor pressure is
[LightRAG](https://arxiv.org/html/2410.05779v1), which does dual-level (local + global) retrieval
directly over the graph **without precomputed community summaries**, reported at roughly
1/100th–1/6000th of GraphRAG's indexing token cost at comparable accuracy (vendor/paper numbers).
Cognee's `cognify` pipeline runs extraction end-to-end with an API key and no operator glue.

So Knowledge-crib picked the costliest enrichment topology *and* made it manual *and* left it empty
by default. Of the three, "manual" is the one to fix first, and "costliest topology" is the one to
question: a LightRAG-style on-demand path over the existing Louvain clusters
(`packages/pipeline/src/cluster/`) would give thematic answers without authoring 3,826 artifacts.

### F5 — HIGH: no second-stage reranker ships, and the project has already measured the precision gap it would close

`packages/memory/src/fusion.ts:55–72` defines a `Reranker` port and documents the measurement that
motivates it:

> the bi-encoder retrieves the correct record for EVERY word-disjoint query (zero misses at any
> depth), but only ranks it top-5 for **43.8%** of them; recall@25 is **74.5%** and recall@50 ~87%.

`DEFAULT_RERANK_DEPTH = 50` is defined. **No implementation exists** — a repository-wide search for
`implements Reranker` / `new *Reranker` returns nothing outside `fusion.test.ts` (test doubles
`inverting`, `broken`). So the shipped ranker is first-stage only, and by the project's own numbers
it puts the right memory in the top five **fewer than half the time** on paraphrased queries.

**Competitive position.** Cross-encoder reranking is standard: Cohere Rerank and `bge-reranker` are
commodity, and Zep/Graphiti's hybrid search reranks as a documented stage. An ONNX
`bge-reranker-base` would ride the embedding runtime already installed
(`@huggingface/transformers@3.7.6`, per the ONNX ladder) — the justification is measured, the
plumbing exists, the model is small.

### F6 — MEDIUM-HIGH: scale evidence stops at 50K LOC, the curve is super-linear, and vector search has no ANN

[`docs/bench/scale-curve.md`](../../bench/scale-curve.md):

| target LOC | wall (s) | nodes/s |
|---:|---:|---:|
| 10,524 | 10.63 | 551 |
| 25,433 | 51.81 | 272 |
| 50,866 | 184.97 | 153 |

`1M-LOC point: not in this run.` Fitting those points gives **≈O(n^1.8)**, and throughput falls
3.6× across a 4.8× corpus. The document's own reading guide says the diagnosis for that shape is
"GC pressure or an O(N²) link/cluster phase" — the data shows the shape, and the cause is not yet
named. `package.json` declares `scale:nightly` at 10K/100K/500K/1M slices; no such run is recorded.

Separately, `vectorQuery` is an **unindexed full-table cosine scan**
(`packages/core/src/index/sqlite-index.ts:243–246`): *"Brute-force cosine ANN over the derived
`vectors` table … scanned in one pass. For 18k nodes this is sub-millisecond; M3.6's ≥1M-LOC scale
bench decides whether to graduate to sqlite-vec."* At 1M nodes × 1024-dim fp32 that is ~4 GB read
per query. There is no `sqlite-vec`, no HNSW, no IVF.

The self-index is reassuring at its own size (953 files / 48,327 nodes in 86 s, 806 MB peak). The
gap is that **no evidence exists at the scale the competition is sold at**: Sourcegraph and Glean
index monorepos, and Cursor/Augment index millions of lines. Any enterprise conversation will ask
for the 1M-LOC number, and the honest answer today is that the curve was never run and trends the
wrong way.

### F7 — MEDIUM-HIGH: language coverage is 11 hand-written extractors, resolution accuracy is validated on 7 labels, and there is no SCIP interop

**Coverage.** 11 parser languages (`docs/STATS.md`): agent, csharp, go, java, md, mule, php, plsql,
python, rust, ts. Absent: **C, C++, Kotlin, Swift, Ruby, Scala, Terraform/HCL, Solidity, Dart,
Elixir, Objective-C, Kubernetes/YAML manifests**. Only TypeScript uses a real type-checker
(`import ts from 'typescript'` in `packages/parsers/src/ts/`); the rest ride
`web-tree-sitter@^0.20.8`, several minor lines behind current.

**Accuracy evidence is a smoke test, not a benchmark.**
`docs/audits/2026-09-05/evidence/reaudit/graph-accuracy.json` reports `precision: 1, recall: 1` over
`labelledPositive: 5`, `labelledUnresolved: 2` — **seven labels, one language, five actual edges**.
Against that, the live graph on this repository reports **5,419 unresolved call sites** and
`analysisReadiness: "incomplete"` (`crib gaps`; the WP-G0 baseline recorded 6,509). Resolution
recall on real code is therefore *unknown*, and the capability matrix is right to say so — but a
7-label fixture cannot support a precision claim either.

**Competitive position.** This is the structural disadvantage. Serena reaches 30+ languages by
riding LSP instead of maintaining extractors. **SCIP moved to open governance in March 2026** with a
steering committee including Uber, Meta and Sourcegraph engineers
([survey](https://anthonywest.co.uk/research/code-intelligence-indexing-2026-openai)) — precise code
intelligence is becoming a standard with an ecosystem of indexers. Knowledge-crib neither **consumes
nor emits SCIP**, so it cannot absorb that ecosystem's language coverage, and it must hand-write and
maintain every extractor — with a bus factor of one (F16). An SCIP importer would be the single
highest-return breadth investment available, and an LSP-backed fallback extractor the second.

### F8 — MEDIUM: no graph query language; the verb surface is fixed

`capabilities.cypher: false`, and `KuzuIndexStore`'s constructor **throws by design**
(`packages/core/src/index/kuzu-index.ts:25` — a deliberate stub, correctly explained: canonical
`kuzudb/kuzu` was archived read-only in Oct 2025, so depending on it was rejected).

The consequence is that every structural question must fit `blast` / `path` / `owners` /
`neighbors`. There is no way to ask *"every route reachable from an unauthenticated handler that
touches a `writes` edge to the ledger"* — the kind of question a graph is *for*. Competitors
backed by Neo4j or FalkorDB (Graphiti + FalkorDB, SCIP → Neo4j stacks) expose Cypher; CodeQL exposes
a full query language. The decision to avoid an unmaintained embedded graph DB was right; the gap it
leaves — no user-extensible query surface — is still a gap, and a bounded, read-only pattern-query
verb over the existing SQLite schema would close most of it without adopting a dependency.

### F9 — MEDIUM: cross-repo support is a single-hop HTTP-route bridge, not a federated graph

`packages/core/src/federation.ts` loads N souls at **runtime** and hops an outbound `http-call` node
to the `route` node it resolves to, matched on `{httpMethod, routePath}`, deliberately persisting no
cross-repo edge. The reasoning (a committed A→B edge would dangle and would make repo A's soul
non-deterministic w.r.t. repo B's history) is correct and well argued.

What it does not give: cross-repo **symbol** resolution, shared-library graphs, cross-repo rename or
impact through a published package, or an org-wide view. Any service-to-service coupling that is not
an HTTP route — a queue topic, a gRPC method, a shared database table, an npm/Maven dependency — is
invisible across the boundary. Sourcegraph and Glean do cross-repo precise navigation as a core
feature; GitNexus's enterprise tier advertises a unified graph across repositories. For a
Staff+ audience whose reality is 20–200 services, a route-only bridge is a demo, not a platform.

### F10 — MEDIUM: memory capture is gated to the point of emptiness in practice

After a full working session in this worktree, both memory stores were empty:

```
crib memory recall "graph rag audit"  → 0 memories (considered 0, eligible 0, team=0 local=0 global=0)
crib session bootstrap                → openWork: [], pendingCaptures: [], intakes.count: 0
```

That is the admissibility matrix working as designed: *"an agent assertion is never evidence; human
evidence cannot establish implementation facts"* (`packages/memory/src/evaluator.ts:12`), with
always-on hygiene refusals for secrets, PII, absolute home paths and raw-transcript markers
(`packages/memory/src/capture-policy.ts`). Precision is the deliberate choice, and `auto-admit.ts`
exists precisely because *"agents told users 'recorded', recall came back empty, and the store looked
write-only."*

But the competitive comparison is stark. Mem0's Claude Code integration captures messages, changed
files and test/build results through hooks, with a detached worker flushing after five exchanges or
on exit/compaction; Letta's "dreaming" consolidates in background subagents after configurable
steps (both per the 2026-09-05 research, vendor documentation). Those systems admit weaker claims and
are wrong more often — and they are **never empty**. A store that returns nothing loses to a store
that returns something imperfect, because the user cannot experience precision they never see.

The gap to close is not the admissibility matrix; it is the absence of a **visible low-trust lane** —
a "leads, not facts" tier that recall surfaces as explicitly untrusted. The `includePending: true`
flag is close to this but is opt-in and off the default path.

### F11 — MEDIUM: grounding is literal substring overlap — brittle to reformatting, blind to semantic drift

`packages/memory/src/grounding.ts` normalises whitespace and returns `grounded` iff the normalized
quote is a **substring** of the normalized rehydrated span. Two failure directions follow:

- **False invalidation.** A rename, a reformat, a wrapped line, or an inserted argument breaks the
  substring and downgrades a still-true claim to `ungrounded` → `orphaned`/`needs-review`. The
  locator-based reattachment (`locator.ts`, `bestLocatorMatches`) mitigates anchor *movement*, not
  text *change*.
- **False validation.** A quote that survives verbatim while the logic around it inverts still
  reports `grounded`.

No competitor verifies memories against source at all, so this is not a deficit *versus* the market —
it is the moat (§4) with a known brittleness. Worth stating because the four-axis verdict's
credibility rests on it.

### F12 — MEDIUM: taint/PDG is intra-procedural, TS/JS only, off by default

`packages/pipeline/src/pdg/taint.ts` is explicit: *"INTRA-PROCEDURAL ONLY: values returned to
callers, passed to other functions, or stored in module state are NOT followed. An empty flow list is
therefore never proof of safety."* `capabilities.pdg: false` on a default index.

CodeQL, Semgrep Pro and Snyk Code are inter-procedural and multi-language. The honest framing is
already in the code; the product recommendation is **do not position this as security analysis** —
it is a code-comprehension aid, and `explain` should keep saying so.

### F13 — MEDIUM: no authenticated multi-tenancy; team memory is untested multi-user

The capability matrix lists `Authenticated multi-tenancy | not implemented` and
`Team memory over Git | implemented; not multi-user tested`. The HTTP daemon's control is loopback
Host/Origin validation plus a body cap, and the test file states the scope precisely:
*"this is a LOCALITY boundary, not authorization. It does not identify which local user is calling,
and `verbs` remains shared across requests"* (`packages/mcp/src/http-boundary.test.ts:11–12`).

Zep ships dashboard RBAC plus API-key ABAC, report-only and enforcement modes, and separate
administrative-audit and API-request logs (2026-09-05 research). That is the enterprise gate, and
Knowledge-crib is not at it. This is fine — provided the positioning stays "local-first, single
trust domain" and does not drift toward "team platform" in the marketing. Declaring it permanently
local-only is a legitimate strategy; leaving it ambiguous is not.

### F14 — MEDIUM: retrieval returns sub-symbol nodes that carry no answer

`crib ask "how does the system prevent stale memories from being recalled"` returned, as its top
five: `cond:packages/mcp/src/enrichment.ts@L2070`,
`stmt:packages/mcp/src/verbs.ts@L3003` → `const recalledSeeds = Array.isArray(recalled?.hits)`,
`stmt:packages/mcp/src/enrichment.ts@L2224` → `const result: Record<string, unknown> = {`,
`stmt:…/verbs.ts@L2995` → `const recalled =`, and an assignment. The actual answer —
`MemoryEvaluator`, the four-axis verdict, `recall.ts` — did not appear.

`statement`, `assignment`, `condition` and `explanation` nodes are in the FTS corpus and compete with
`symbol` nodes on BM25 score. The `kindPrior` table that would demote them lives in `rerank.ts`,
which never runs (F1). Two cheap independent fixes: kind-aware defaults on the `ask`/`query` path,
and an answer-granularity policy that rolls sub-symbol hits up to their enclosing symbol.

### F15 — LOW: `crib ask "<question>"` mis-parses the question as a path

```
crib ask "how does the system prevent stale memories from being recalled"
→ warning: /…/graph-memory-rag-audit-600923/how does the system prevent stale memories from
  being recalled is not indexed — serving the ancestor project at …
```

The question string is being taken as the optional path positional. Cosmetic, trivially fixed, and
it is the first thing a new user sees from the flagship natural-language verb.

### F16 — MEDIUM: the agent-side memory write path is MCP-only, so a CLI-only agent cannot record a learning honestly

This audit hit the gap it is describing. The protocol in `CLAUDE.md` §3 requires reusable learnings to
be persisted with admissible evidence. The agent-appropriate write is `memory_observe` — an agent
observation with cited quotes that crib re-grounds itself (`packages/memory/src/auto-admit.ts`). It
is **MCP-only**, and the `knowledge-crib` MCP server failed to connect in this session.

The CLI surface (`crib memory <init|remember|admit|handoff|recall|search|get|supersede|delete|history|evaluate|activate|propose|attest|check|audit|feedback|gc|migrate|bench|distill|recheck|dismiss|capture-hook|…>`)
has no `observe` verb. The only write that admits immediately is
`crib memory remember "<claim>"`, documented as *"record + admit a **human-attested** claim from a
terminal"* — so an agent using it would mint an attestation it does not hold, which §4 forbids and
which `evaluator.ts:12` would reject anyway for an implementation fact (*"human evidence cannot
establish implementation facts"*).

Net effect: **when MCP is down, a correct agent cannot write to the ledger at all.** The findings in
this report were therefore checkpointed against the durable intake
(`intake:d186b40d…`, phase `verifying`) rather than distilled into claims. That is the honest
outcome and also the defect: the intake lane degraded gracefully, the claim lane did not. A
`crib memory observe` CLI verb carrying the same re-grounding path would close it.

### F17 — STRUCTURAL: bus factor of one, and a launch gate that currently cannot go green

`git shortlog -sn --all`: 359 of ~389 commits are one person (`Vishalc412` + `Vishal Chawla`),
plus 17 dependabot. **194 commits in the last 60 days** — exceptional velocity, single point of
failure.

The launch policy (version 4, frozen 2026-09-15) requires **21 vendor-client runtime receipts** —
seven clients × three native platforms, no waivers, no preview tier — and **0 are certified**, so
the decision is NO-GO with a `client-cell-uncertified:*` blocker per cell. The engineering
discipline is admirable. The commercial problem is that the gate requires signed-in vendor clients on
native Linux and Windows hosts that the project does not appear to have, so **the release can never
go green as specified**. A self-imposed gate that is unreachable by construction stops being a
quality instrument and becomes a shipping blocker.

Competitors here are funded teams (Zep, Mem0, Sourcegraph, Augment) or have community governance
(SCIP's steering committee; Cognee's Apache-2.0 ecosystem). Sustained single-maintainer velocity
does not close a language-coverage gap against an ecosystem — which is the strategic argument for F7's
SCIP/LSP recommendation.

---

## 3. Competitive positioning — three markets, judged separately

The 2026-09-05 research is right that these must not be collapsed. Adding the two markets it did not
cover:

### A. Agent / conversational memory — *competitive, with a unique advantage*

Competitors: Mem0 (+ OpenMemory), Zep/Graphiti, Letta/MemGPT, Cognee, Supermemory.

| dimension | Knowledge-crib | market |
|---|---|---|
| bi-temporal validity, supersession | yes, append-only, `supersede` decision events | Graphiti/Zep: validity windows; Mem0 Dream: auto-supersession |
| evidence requirement | 5 admissible kinds, agent self-assertion refused | none require evidence |
| **verification against source code** | **quote-overlap re-grounding + locator reattachment + four-axis verdict** | **nobody does this** |
| automatic capture | hook lane exists; evidence gate leaves recall empty in practice (F10) | Mem0/Letta capture aggressively and consolidate in background |
| reranking | port only, no implementation (F5) | reranked hybrid search is standard |
| team / tenancy | Git-backed team store, untested multi-user; no authz (F13) | Zep: RBAC + ABAC + audit logs |
| inspector UI | `crib viz` memory home, local | OpenMemory dashboard, Letta viewer + memory doctor |

**Verdict:** the strongest position of the three. Code-grounded admission is a genuine, defensible
first. It is undercut by F10 (nothing recalled) and F5 (what is recalled is mis-ranked).

### B. Graph-RAG pipelines — *weakest position*

Competitors: Microsoft GraphRAG, LightRAG, nano-graphrag, Cognee, Neo4j GraphRAG.

Knowledge-crib has the pieces — Louvain communities (1,009 on this repo), a symbol→file→cluster→system
hierarchy, importance scoring, a grounding/audit gate (`crib audit-llm`) that no GraphRAG
implementation offers. What it lacks: **any of it populated by default** (F4), **a bundled model
client** (F4), **query-time vectors** (F1), **a reranker** (F5), and a cheap retrieval mode. It
adopted GraphRAG's costly precomputed-summary topology at the moment the field moved toward
LightRAG's summary-free dual-level retrieval.

**Verdict:** behind. The differentiator to lean on is not breadth of retrieval modes (Cognee has
fourteen) — it is that Knowledge-crib's semantic artifacts are **grounded and auditable against the
AST**, and every competitor's are free text. That claim needs the layer to be non-empty to mean
anything.

### C. Code intelligence for agents — *credible core, narrow substrate*

Competitors: GitNexus, CodeGraph, Serena (LSP), Sourcegraph/Cody + SCIP, Greptile, Augment, Glean,
Aider's repo-map.

| dimension | Knowledge-crib | market |
|---|---|---|
| local-first, no server | yes | the winning pattern; GitNexus and CodeGraph named the breakout leaders |
| token reduction | 11.8× measured live here; 45× on the bench harness | a 2026 study reports ~10× and 2.1× fewer tool calls for a tree-sitter KG over 31 repos — **table stakes, not a differentiator** |
| committable, deterministic graph | **`--extracted-only` is byte-identical across runs; the soul is git-committable and mergeable** | **rare — closest to a real differentiator here** |
| bounded change review | `review` at ~2,000 tokens vs ~212,000 to read 8 touched files | no direct equivalent verb |
| languages | 11 hand-written | Serena 30+ via LSP; SCIP ecosystem growing under open governance |
| semantic code search | **none in production (F1)** | default everywhere |
| cross-repo | HTTP-route bridge only (F9) | Sourcegraph/Glean precise cross-repo |
| scale evidence | ≤50K LOC, super-linear (F6) | monorepo scale |

**Verdict:** the deterministic committable graph and the bounded `review` verb are real and
under-marketed. The substrate (11 extractors, no SCIP, no vectors) is the ceiling.

---

## 4. What is genuinely defensible

Stated plainly, because the finding list above is long and the moat is real:

1. **Code-grounded memory admission.** No memory product verifies a claim against the project's AST,
   re-grounds it after refactors, and downgrades it on drift. This is the product.
2. **A committable, mergeable, byte-deterministic graph.** `--extracted-only` reproducibility plus a
   git merge driver means the graph is reviewable in a PR. Server-backed competitors cannot offer it.
3. **Bounded-cost change review.** ~2,000 tokens vs ~212,000 is an argument that survives contact
   with a budget.
4. **Calibrated honesty as a shipped feature.** `status({op:'gaps'})`, `truncated`, `note`-qualified
   reports, "an empty `impact` is not evidence a symbol is unused". Competitors' runbooks now do some
   of this (GitNexus's does), but none makes it a protocol obligation on the agent.
5. **A deterministic core that never touches the network**, with a provider-neutral server.

Four of those five are unusual. None of them depends on the findings above being unfixed — but F1 and
F2 actively erode #4, which is why they are ranked first.

---

## 5. Prioritised remediation

| # | Action | Why now | Effort |
|---|---|---|---|
| **P0** | Plumb `embedder` through `OpenIndexOpts` → `openIndex` → `runtime.ts` / `refresh-coordinator.ts`, behind an explicit index flag. Then re-measure code search on a labelled code corpus and publish the number. | Activates ~350 existing lines (`vectorQuery`, RRF fusion, all of `rerank.ts`) that are currently dead. Closes the category-level deficit in F1. | S (plumbing) + M (corpus) |
| **P0** | Re-scope the README "Semantic recall" bullet and the capability-matrix row to say **memory recall**, and rename or re-document `--semantic` (it adds INFERRED doc→symbol links; it does not enable semantic search). | F2 is the one defect that damages the project's honesty position. Cheapest fix in the list. | XS |
| **P1** | Ship one bundled enrichment provider (Anthropic / OpenAI / Ollama) behind explicit opt-in + a budget cap, and add a LightRAG-style on-demand cluster-summary path that does not require authoring 3,826 artifacts. | F4. The graph-RAG half of the product is empty for anyone who will not write integration code. | M |
| **P1** | Implement the `Reranker` port with an ONNX cross-encoder (`bge-reranker-base`) on the runtime already installed; gate on the pre-registered corpus. | F5. The 43.8% top-5 figure is the project's own measurement, and the port was written for exactly this. | M |
| **P1** | Add body/chunk text to the vector channel (or a second body-level vector table), and kind-aware defaults on `ask`/`query` that roll sub-symbol hits up to their symbol. | F3 + F14. Without this, P0's ceiling is identifier matching. | M |
| **P2** | SCIP importer (and ideally exporter). Optional LSP-backed fallback extractor for unsupported languages. | F7. The only way a one-maintainer project reaches 30+ languages, and SCIP now has open governance. | L |
| **P2** | Run `scale:nightly` to 500K/1M LOC; profile and name the O(n^1.8) hot spot; adopt `sqlite-vec` before making any scale claim about vector search. | F6. Every enterprise conversation asks for this number. | M |
| **P2** | A visible low-trust recall lane (`includePending` surfaced by default as an explicitly untrusted group) so recall is never empty. | F10. A store that returns nothing cannot demonstrate its precision. | S |
| **P2** | A bounded read-only pattern-query verb over the SQLite schema (not Cypher, not Kùzu). | F8. Restores user-extensible graph questions without a dependency. | M |
| **P3** | Decide and state whether multi-tenancy is ever in scope. If not, make "single local trust domain" a permanent, prominent positioning statement. | F13. Ambiguity here is worse than either answer. | XS–L |
| **P2** | Add a `crib memory observe` CLI verb routing through the existing `auto-admit` re-grounding path. | F16. Today a CLI-only agent cannot write a learning without misattributing attestation. | S |
| **P3** | Revisit the launch policy so the 21-cell gate is reachable, or split "certified" from "released". Fix the `crib ask` path-parsing bug (F15). | F17, F15. | S |

---

## 6. Limits of this audit

- Single platform (darwin), single host, single session. Nothing exercised on Linux or Windows.
- The `knowledge-crib` MCP server failed to connect (`CONNECTION_CLOSED`); all verbs were driven
  through the CLI. No claim is made about MCP-transport behaviour.
- No competitor software was installed, run or benchmarked. Competitor capabilities are attributed to
  public documentation and to the 2026-09-05 research; vendor numbers are labelled as vendor numbers.
- The paraphrase-query probe in F1 is three hand-authored queries, not a corpus. It demonstrates the
  failure mode; it does not quantify it. Quantifying it is P0's second half.
- F6's O(n^1.8) fit is over three published points from a run this audit did not re-execute.
- The enrichment cost implication in F4 is an argument from target count (3,826) and topology, not a
  measured dollar figure — no enrichment run was performed.
- Memory findings F10/F11 are read from source plus one empty-store observation, not from a
  longitudinal capture trial.

---

*Audit performed against `342d8c1e` on 2026-09-20. Findings are anchored to source locations and to
commands recorded above; re-running them on a later tree may change the numbers and should.*

---

## 7. Remediation round 1 — what was changed, and what it did NOT fix

Appended 2026-09-20, after the findings above. The findings are left exactly as written; this section
records outcomes against them. **One result is negative and is reported as such.**

### P0.1 — F1 closed: the vector channel is reachable and demonstrably live

The root cause was narrower than "not wired": `builtEmbedderId`/`builtDim` were **in-memory only**, so
even a caller that passed an embedder lost the channel the moment the index was reopened — which
every production path does (the atomic build renames a temp db and reopens it; `openIndexOnly` and
`openIndexForServe` open an existing file). Every pre-existing embedder test used `':memory:'`, which
never reopens, so all of them passed against a store that forgot its vectors.

Changes:

- `sqlite-index.ts` — a `vector_meta` table written inside the same transaction as the vectors, and
  restored in the constructor. A reopen adopts the channel only when the supplied embedder's
  `id` **and** `dim` match what built them; a mismatch **refuses** rather than embedding a query in
  one space and scoring it against another.
- `IndexCapabilities.vectorNote` — the refusal reason, so `false` can be told apart from
  "never built". Worded as a fact, not a remedy: the store cannot distinguish a machine with no
  installed tier from a caller that deliberately skipped the model load.
- `applyDelta` — two new invariants. It will not vectorize a delta on a lexical index (which would
  leave `vectorQuery` ranking a few hundred nodes as if they were the corpus), and on a vectorized
  index it cannot maintain, it **deletes** the changed nodes' vectors rather than leaving them
  describing the previous revision of each symbol.
- `OpenIndexOpts.embedder` → `openIndex` → `buildIndex` / `openIndexOnly` / `openIndexForServe`,
  with `buildIndex` still fully synchronous (its pinning test is unchanged).
- CLI: `crib index --vectors`, opt-in, which **refuses** when no on-device tier is installed rather
  than silently building char-n-gram vectors that R1 measured as worse than lexical-only. `query`,
  `ask`, `serve` and `update` upgrade to the channel only after a cheap lexical open shows the index
  carries vectors — so `crib gaps` and the other structural verbs never trigger a multi-GB load.

Evidence: 8 new tests in `sqlite-index.test.ts`, deliberately **file-backed** (a `':memory:'` rewrite
would stop testing the thing they exist for). 5 of the 8 fail when `restoreVectorMeta()` is removed,
so they are regression tests, not tautologies. Full suite green — 3,287 tests across 8 packages.

End-to-end on this repository:

```
crib index . --vectors     954 files, 48,459 nodes, 127,592 edges — 420.6 s, 4.87 GB peak RSS
crib index .   (lexical)   953 files, 48,327 nodes, 125,722 edges —  86.0 s, 0.81 GB peak RSS
capabilities with e5-large loaded   → {"cypher":false,"vector":true}
capabilities with no embedder       → {"vector":false,"vectorNote":"index carries
                                       multilingual-e5-large-1024-sym vectors; this reader loaded
                                       no embedder, so code search is lexical here"}
```

**Cost, stated because it is not small:** building vectors is **4.9× slower and ~6× more memory** on
this repository. That is a further argument for keeping `--vectors` opt-in, and it interacts badly
with F6 — the super-linear index curve now has a much larger constant on the vectorized path, and
neither has been measured beyond 50K LOC.

### P0.2 — F2 closed: the semantic-recall claim is scoped to what it measures

README and `capability-matrix.md` now state that the 81.1% / 0.881 figures measure **memory-ledger
recall** over 500 queries / 307 **memory records**, and say plainly that they do not describe code
search. The capability matrix gained a separate *Code retrieval* table with two rows: lexical
(verified, on) and vector (implemented, opt-in, **unmeasured on a labelled code corpus**). The stale
assertions in `index-store.ts` ("no vector path ships today, so always false"; "there is no
`withEmbeddings`/vector field anywhere") are corrected, and `ManifestCapabilities.embeddings` now
documents that it is *not* the code-vector channel and why a committed manifest must not record a
gitignored derived artifact's state.

### NEGATIVE RESULT — F3 is now the binding constraint, and retrieval quality did NOT improve

The three paraphrase probes from F1 were re-run against the vectorized index, with the channel
confirmed live (`vector: true`, e5-large, no fallback warning). **None of them improved.**

| query | with vectors live | correct target |
|---|---|---|
| "stop two machines writing the same record at the same time" | `sym:scripts/parallel-check.mjs#fail`, `…/multimodal/worker.ts#runWorker.finish`, `file:scripts/parallel-check.mjs` | `core/src/lock.ts` — **still missed** |
| "hide customer identifiers before saving" | `sym:packages/ui/web/support.js#hideRawTemplate`, `doc:…executive-brief#8-rollout-path` | `memory/src/secrets.ts` — **still missed** |
| "make sure a crash does not lose an acknowledged write" | `doc:…launch-audit.md#f02-…`, `sym:…memory-crash-recovery.test.ts#makeRepo` | partial, still no primary symbol |

The ranking changed materially (doc-sections now surface, order differs), so the channel is doing
work — it is simply not work that answers these queries. The cause is F3, unchanged by this round:
`vectorText()` embeds `name`, `qualifiedName`, `signature`, `heading` and `file` — **surface fields,
no body**. A query describing what code *does* can only match a symbol whose *name* already says so.
A per-node embedding of identifiers is also the wrong retrieval unit for a prose question that spans
several symbols; that needs chunking, which does not exist.

**So P0 restored a capability; it did not deliver a retrieval win, and none is claimed.** This is
exactly why the new capability-matrix row says "implemented, opt-in, UNMEASURED" rather than
advertising a quality improvement. The next honest step is not more plumbing — it is F3 plus a
labelled code corpus (P1), in that order, because without the corpus there is no way to tell whether
body embedding helped.

### F18 (found during remediation) — `crib serve` EXITS on a damaged/absent manifest, so every fresh worktree of this repository starts with a dead MCP server

This audit opened with `knowledge-crib` reporting `CONNECTION_CLOSED`, which reads like a client or
config fault. It is not. Reproduced directly:

```
$ mkdir -p mcptest/.crib/memory && cd mcptest && git init -q .
$ crib serve .
not indexed: …/mcptest/.crib exists but crib.json is missing — the index is damaged;
refusing to serve an ancestor project. Repair with `crib index …/mcptest`
not indexed — run `crib index` first
$ echo $?
3
```

`crib serve` exits `EXIT.NOT_INDEXED` before the stdio transport is established. To any MCP client
that is indistinguishable from a crash: `MCP error -32000: Connection closed`.

**Why this is structural rather than an edge case.** `.gitignore` excludes `.crib/*` and re-includes
only `.crib/memory/` (deliberately — the memory ledger is the committed part, the index is build
output). So a fresh clone or a **fresh git worktree** of this repository materialises `.crib/memory/`
with **no `crib.json`** — which is exactly the state the wrong-project guard refuses. Every new
worktree therefore starts with a non-functional MCP server, and the error surfaced to the IDE names
neither the cause nor the one-command fix.

**Why the existing guard does not cover it.** `openIndexForServe` was written for precisely this
failure mode, and its docstring says so: *"The MCP stdio server must NEVER drop the transport on a
stale/missing derived index — that surfaces to the IDE as `MCP error -32000: Connection closed`,
because the serve process exits and the stdio pipe dies."* But it self-heals a missing **derived
index** only. A missing **manifest** is refused earlier, in `resolveProjectRoot`'s damaged-index
branch, which returns before any of that self-healing runs. The guard is one layer too late.

The refusal itself is correct — serving an ancestor project's soul silently is the worse outcome, and
that reasoning is sound. The defect is the *delivery*: a hard exit converts an actionable diagnosis
into an opaque transport failure. Two non-exclusive fixes, neither implemented here:

1. Complete the handshake, then fail every verb with the diagnosis as its error payload. The user
   reads "`.crib/crib.json` missing — run `crib index .`" in the IDE instead of "Connection closed".
2. Have `crib setup`/`crib init` (or a worktree-aware check) index on first serve in a worktree whose
   `.crib/memory/` exists without a manifest — the one case where "damaged" actually means "freshly
   checked out".

**Consequence for this audit, worth stating:** F16 was caused by F18. The claim ledger was
unreachable all session because the server never started, and the server never started because a
fresh worktree has no manifest.

### Unchanged

F4–F15 and F17 are untouched by this round. F16 in particular still holds: these findings could not be
distilled into the claim ledger, because `memory_observe` is MCP-only and the MCP server was down.
Work is recorded on `intake:d186b40d…`.

---

## 8. Remediation round 2 — the negative result is overturned, with numbers

Appended 2026-09-21. Round 1 (§7) closed F1 and F2 and reported a NEGATIVE result: the vector channel
was live and retrieval had not improved. Round 2 identifies why, fixes it, and **measures the
difference instead of asserting it**.

### F3 closed — body text in the vector channel, funded by F14

`vectorText` v2 appends the rehydrated span (capped at 1,200 chars — below the shipped model's
512-token truncation, surface fields first so the cap never eats the identifier). Two things made
that affordable and safe:

- **Detail kinds are no longer embedded.** Discovery stopped ranking them in F14, and on this index
  they are **38,286 of 48,459 nodes — 79%**. Four fifths of the v1 embedding run was spent on nodes
  no query would ever return.
- **The text recipe is versioned.** Changing *what* is embedded changes the vector space as surely as
  changing the model does, and the model id cannot express it — the same e5-large produced v1 and v2.
  `vector_meta.textVersion` records it and a reopen with a different recipe **refuses** the channel. A
  missing key means v1, not "assume current".

### The measurement

`node scripts/eval/code-vector-eval.mjs` — the same 20-question labelled corpus
`semantic-retrieval-eval.mjs` uses, scored through a lexical and a hybrid store over the **same
sqlite file**, so only the retrieval path varies:

| path | top-1 | top-3 | found@10 | MRR |
|---|---:|---:|---:|---:|
| lexical (BM25, the default) | 0/20 (0%) | 1/20 (5%) | 6/20 (30%) | 0.057 |
| hybrid (`--vectors`, e5-large, v2 recipe) | 4/20 (20%) | 7/20 (35%) | 9/20 (45%) | **0.286** |

**MRR improves 5×.** Nine questions rank better — "how is a claim proven against real code" and
"what decides which memory the team trusts" go from a miss to rank 1; "how do I add a new language"
from 3 to 1. **Three regress**, and they are named rather than buried: "what stops a secret being
indexed" (5 → miss), "how does blast radius cross repositories" (9 → miss), "why is a response never
unbounded" (4 → miss).

**What this does and does not establish.** It overturns §7's negative result — body embedding was the
binding constraint, and closing it produced a measured gain on an independently authored corpus. It
does **not** make code retrieval good: top-1 at 20% means the right file is usually still not first,
and a 20-question corpus on one repository, authored by someone who knows it, cannot carry a
pre-registered gate. The harness also cannot isolate body text from having vectors at all — that
would need a second embedding recipe kept alive in production for the harness's benefit, which is a
worse trade than saying so.

### The cost, which is the real argument for keeping `--vectors` opt-in

| index | wall | peak RSS | vectors |
|---|---:|---:|---:|
| `crib index` | 86 s | 0.81 GB | — |
| `--vectors`, v1 (surface only, all kinds) | 421 s | 4.87 GB | 48,459 |
| `--vectors`, v2 (surface + body, discovery kinds) | **1,444 s** | 4.83 GB | 10,185 |

v2 embeds **4.8× fewer nodes and takes 3.4× longer**, because each embedding carries ~15× more
tokens: 24 minutes for 185K LOC, 16.8× the lexical build. F6 therefore binds harder on the vector
path than on the lexical one, and the 1M-LOC point is still unmeasured on either.

### Also closed in round 2

- **F14** — `query`/`ask`/`brief` no longer rank sub-symbol fragments against symbols. The same
  question that used to answer `const result: Record<string, unknown> = {` now returns the doc section
  titled "staleness detection" and `graph-store.ts#freshness`. Costs no content: a symbol's FTS body
  already holds its statements' text.
- **F15** — was wider than recorded. Thirteen of the fourteen commands on the `openVerbs` funnel take
  an id, name or question as their first positional and all of them resolved a project root named
  after their own argument, printing `crib index <symbol-id>` as the remedy. Only `gaps` takes a path.
- **F16** — `crib memory observe` gives an agent a write path that does not require MCP and does not
  require minting a human attestation it does not hold. Verified by recording this session's three
  learnings through it; all three admitted `grounded: 1 exact citation(s)` and recallable.
- **F18** — `crib serve` no longer exits on a damaged/absent manifest; it completes the handshake and
  answers every verb with the diagnosis and its remedy. Verified over real stdio JSON-RPC.
- **F10** — narrower than recorded, and the audit was wrong about where: the MCP verb *already*
  disclosed withheld candidates (`pendingNotice`, added because "silence was the bug"). The CLI
  assembles its own response shape and dropped it. Now printed as a count plus next action, never the
  content.
- **F4** — a reference enrichment provider (`examples/providers/anthropic/`) so the semantic layer is
  reachable without writing an LLM integration first. The server still makes no model calls.

### An unrelated defect found on the way

`pnpm verify` was **red on HEAD** before this branch started: three files committed unformatted in
`1f589801` failed `biome check`. Fixed as an isolated reflow-only commit. `biome check .` is now clean
across 660 files.

### Two traps worth recording for the next person

- **`runCliResult` in `cli.test.ts` returns `stderr: ''` whenever a command exits 0.** Four F15
  regression tests passed against the unfixed code because of it. Any test asserting on the stderr of
  a *successful* command must use `spawnSync` directly.
- **A `':memory:'` sqlite store never reopens**, so the entire pre-existing embedder test set passed
  while production lost the vector channel on every reopen. State restored in a constructor needs a
  file-backed test.

---

## 9. Where every finding stands

| # | Finding | State | Evidence |
|---|---|---|---|
| F1 | Code-vector path unreachable | **closed** | `vector_meta` + 8 file-backed tests (5 fail without the fix) |
| F2 | Recall claim scoped to the memory ledger | **closed** | README + capability matrix rewritten |
| F3 | Surface-only embeddings | **closed, measured** | MRR 0.057 → 0.286; recipe versioned |
| F4 | Semantic layer empty, no provider | **closed** | `examples/providers/anthropic/` |
| F5 | No cross-encoder reranker | **open** | port + `DEFAULT_RERANK_DEPTH` exist; no implementation |
| F6 | Scale curve stops at 50K, super-linear | **half WITHDRAWN (§10), half open** | curve re-measured to 200K: linear, flat throughput. 1M point still unmeasured; no ANN |
| F7 | 11 extractors, 7-label fixture, no SCIP | **open** | — |
| F8 | No graph query language | **open** | — |
| F9 | Cross-repo is an HTTP-route bridge | **open** | — |
| F10 | Withheld candidates invisible | **closed** | `pendingNotice` in the CLI + 4 tests |
| F11 | Grounding is substring overlap | **open** | demonstrated live during round 2 (below) |
| F12 | Taint intra-procedural, TS/JS only | **no action — correctly disclosed** | already honest in code and matrix |
| F13 | No authenticated multi-tenancy | **open — product decision** | needs a positioning call, not a patch |
| F14 | Fragments outranked symbols | **closed** | 6 tests (3 fail without the fix) |
| F15 | Positional parsed as a path | **closed, wider than recorded** | 5 tests via `spawnSync` |
| F16 | Agent memory write was MCP-only | **closed** | `crib memory observe` + 6 tests |
| F17 | Bus factor 1, gate unreachable | **open — not a code change** | — |
| F18 | `crib serve` exits on damaged manifest | **closed** | verified over stdio JSON-RPC + 4 tests |

**Why the open ones are open**, so the list is a plan rather than an excuse:

- **F5** (cross-encoder) is the biggest remaining quality lever and is now *measurable* — the harness
  from §8 would score it directly. It needs an ONNX cross-encoder provisioned like `crib embed setup`
  does (a ~1 GB download, an integrity pin, a tier report) plus a gate. That is its own change, and
  shipping it hastily is how an unmeasured claim gets made — the failure mode this whole audit exists
  to prevent.
- **F7** (SCIP) is the highest-return breadth investment and a genuine project: a protobuf reader, an
  id-mapping layer onto crib's node ids, and a fixture corpus per language.
- **F8** (query surface) is a language-design decision, not an implementation gap. A bounded
  read-only pattern verb over the existing SQLite schema is the shape; picking its grammar deserves
  more care than the end of a session.
- **F9**, **F11** are research-shaped. F11 in particular has no market alternative to copy — nobody
  else verifies memories against source at all.
- **F13**, **F17** are decisions the maintainer owns. F13 needs a stated position ("local-only
  forever" is a legitimate answer); F17 needs a policy that can go green, or an explicit split
  between "certified" and "released".

### F11 demonstrated live, unprompted

Round 2 edited `sqlite-index.ts`. Two of the three memories recorded through `crib memory observe` in
round 1 were admitted `evidence=valid` against `vectorText@L72` and `restoreVectorMeta@L187`; after
the edit they read `evidence=degraded`, because the anchors moved and the quoted spans shifted. The
freshness engine caught it with no prompting — which is the moat working — **and** it is F11's
brittleness in one observation: one of those claims is still perfectly true, and it degraded only
because a line number changed. The other is now genuinely false (it asserts surface-only embedding,
which round 2 removed) and deserves supersession rather than a downgrade. A verdict engine that
cannot tell those two cases apart is doing less than it appears to.

---

## 10. Correction: F6's super-linearity claim does not reproduce

**F6 said the index curve was roughly O(n^1.8) with collapsing throughput. Re-measured, it is not.**
The finding was read off [`docs/bench/scale-curve.md`](../../bench/scale-curve.md), which was stale.

Fresh run, 2026-09-21, same harness and same replicated fixture, extended to 200K LOC — 4× past the
point the published curve stopped at:

| LOC | Wall (s) | Nodes/s | MB / kLOC |
|---:|---:|---:|---:|
| 10,524 | 4.67 | 1,253 | 23.1 |
| 50,866 | 28.28 | 998 | 7.2 |
| 100,855 | 56.98 | 981 | 6.6 |
| 200,833 | 116.82 | 953 | 5.6 |

50K→100K is 2.00× the corpus for **2.01×** the time; 100K→200K is 2.00× for **2.05×**. That is linear.
Throughput moves 998 → 981 → 953 across a 4× corpus — a 4.5% decline, not the 3.6× collapse the
published table showed. MB/kLOC *falls*, so peak RSS grows sub-linearly.

**This is not noise.** The 10K slice reproduces at 4.67 s and 4.62 s across two runs (~1%), against a
published 10.63 s; the 50K slice is 28.28 s against a published 184.97 s. The published document was
generated 2026-07-13, `scripts/scale-bench.mjs` was modified 2026-08-26 (`1ac2e2ba`, which changed how
wall time is measured among other things), and the document was never regenerated.

**What F6 got right, and what replaces the wrong half:**

- ✅ **The 1M-LOC point was never measured.** Still true — this run reaches 200K.
- ✅ **Vector search is an unindexed full-table cosine scan.** Unchanged; no ANN ships.
- ❌ **"Super-linear, ~O(n^1.8), GC pressure or an O(N²) link/cluster phase."** Withdrawn. The data it
  rested on is superseded, and the fresh data shows a linear curve with flat throughput.
- ➕ **Replaced by a sharper version of the same concern:** the cost that actually explodes is the
  **vector** build, measured in §8 at 1,444 s vs 86 s on this repository (16.8×). The lexical curve
  says nothing about it, and extrapolating one to the other is invalid.

**A process finding, which is the more durable lesson.** A generated benchmark document went stale for
two months while its harness changed underneath it, and it was the one place a reader — including this
audit — would look for scale behaviour. Nothing flagged the drift: `docs:stats` has a freshness gate,
`scale-curve.md` did not. The regenerated file now says to regenerate it in the same change that
touches the harness, but a gate would be better than a sentence.

**How this reflects on the audit.** F6 is the one finding where I reported a repository document as
evidence without re-running the measurement behind it, and it is the one finding that turned out to be
wrong. The findings that held up are the ones anchored to source I read or a command I ran.
