# Knowledge-crib — Implementation Plan (detailed)

> A greenfield, open-source, Apache-2.0 **TypeScript/Node** product: a portable **"project soul"**
> for AI coding agents. It parses a codebase (+Markdown/docs, +SQL) into a unified knowledge graph,
> persists it as a **git-committable chunked-JSONL soul** (source of truth, cross-IDE, engine-free
> readable by SeeroFlow), derives a **fast rebuildable index**, and serves query/impact/context
> verbs to any agentic IDE over **one MCP server** (stdio, `npx knowledge-crib`). Deterministic core
> (parse/graph/impact/search) **never needs a network**; LLM enrichment is **opt-in and off the
> query hot path**. Inspired by **GitNexus** (deep code analysis) and **Graphify** (broad indexing),
> copying **neither**'s code. **Knowledge-crib is its own individual product** — see
> §Differentiation.

This plan converts the 17-doc spec package in `/Users/vishalchawla/Documents/Knowlege-crib/` into an
executable, dependency-ordered build. It merges: (a) the full 17-doc analysis, (b) the cross-document
gap analysis, (c) the **migration-scope** deep-research findings, and (d) the **complete-requirements**
deep-research findings (105 agents, ~3.3M tokens, 21 verified claims). Two deep-research runs
materially changed the spec — those corrections are folded in below (see **Research-driven corrections**).

---

## Table of contents
1. Context & locked decisions
2. **Architecture** (system design, data flow, layering, deployment)
3. **Differentiation from Graphify and from Nexus/GitNexus** (as an individual product)
4. Research-driven corrections (what the internet forces us to change)
5. Reconciliation decisions (cross-doc contradictions/gaps resolved)
6. Repo & stack
7. Canonical interfaces
8. Build waves (parallelism)
9. Milestones M0–M13
10. Migration track (widened) — ACE→Java, COBOL→Java, .NET upgrade, Java upgrade, legacy families
11. Verification strategy
12. Critical files (read-first)
13. Open questions / research coverage gaps

---

## 1. Context & locked decisions

### What this is
`/Users/vishalchawla/Documents/Knowlege-crib/` holds 17 spec markdown files (no code yet). This plan
is the bridge from spec → repo. Two co-equal wedges ship:
- **(1) The doc-link MVP** — code blast-radius (`impact`) + linked doc sections (`describes`). This is
  the wedge that proves the token-cut thesis end-to-end at M5.
- **(2) The deep-extraction/migration track** — widened well beyond the original PL/SQL→COBOL framing
  to a multi-source-family migration/rule-extraction engine: **ACE→Java, COBOL→Java, .NET upgrade,
  Java upgrade**, plus legacy families (**RPG, Natural/ADABAS, MUMPS, PL/I, ABL/OpenEdge,
  PowerBuilder**) via an ANTLR4 fallback front-end and an acyclic-CFG structuring step. See §10.

Analysis of all 17 docs surfaced real cross-document contradictions and gaps; this plan resolves each
(see §5). Two `/deep-research` runs validated/contradicted spec bets (see §4).

### Locked decisions (from clarifying questions + spec + research)
- **Index backend: `better-sqlite3 + FTS5 + sqlite-vec` is the default** at M1. The spec's
  "LadybugDB" is **Kùzu** — which genuinely exists (MIT, in-process, HNSW vector + FTS + Cypher, Node
  bindings) BUT canonical `kuzudb/kuzu` was **archived read-only Oct 10 2025** (Apple acquired Kùzu
  Inc.); only a vendor fork (`Vela-Engineering/kuzu`) remains active. → **sqlite default reinforced**;
  Kùzu/Ladybug becomes an *optional* "rich graph+vector" backend with sunset/fork-stewardship risk,
  `capabilities().cypher=false` until it lands. The `IndexStore` interface makes the swap invisible
  upstream. (Research finding, §4.)
- **Scope: full M0–M13, both tracks.** Migration track forks at M3 and runs parallel to M4–M9; the
  `extract_rules` MCP verb (M12) rejoins at M5 (the server).
- **`explanation` + `derived-from` get real producers:** a **Phase 3e docstring/comment extractor**
  emits `explanation` nodes from TS/Java/PL/SQL comments and links them via `derived-from` to the
  owning symbol (also feeds the migration track — captures rule-engine intent comments).
- **Enrichment transport: direct LLM provider API, NOT MCP sampling.** The spec's "opt-in LLM via
  host-IDE MCP sampling" is **formally deprecated** (SEP-2577, protocol 2026-07-28). New
  implementations SHOULD NOT adopt it. → design the enrichment layer around direct provider API calls
  as primary; treat sampling as a transitional, capability-gated fallback only. (Research finding, §4.)

### Open confirmations — gating status (none block M0)
- **Q36 (TypeScript runtime)** — every doc assumes TS → rubber-stamp and proceed.
- **C1 (GitNexus PolyForm)** — de-risked: greenfield, no GitNexus code reused; credit in `NOTICE`.
- **C2 (cluster algo)** — **Louvain** for M7 (`graphology-communities-louvain`); Leiden as future swap.
- **C3 (LadybugDB)** — resolved by flipping sqlite to default (above).
- **C4 (scale)** — default 100k LOC / 10k files; `shardHexDigits=2`, `maxChunkLines=5000`,
  `withEmbeddings=false`. Tune post-M5.
- **C5 (deployment)** — local per-dev MCP stdio only for v1; hosted/team deferred.
- **C6 (resourcing)** — solo; pnpm monorepo sized for one dev + agent-fleet delegation.
- **C7/C8** — "Knowledge-crib", OSS-only.

---

## 2. Architecture

### 2.1 The one-sentence model
**Parse → graph → persist as a committable "soul" → build a fast index from it → serve to agents over MCP.**

### 2.2 Layered architecture (dependency direction, top → bottom)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CONSUMERS (no knowledge-crib code dependency)                          │
│  Claude Code · Cursor · Copilot · Windsurf · SeeroFlow (Tier-1 soul)    │
└───────────────▲───────────────────────────────────▲────────────────────┘
                │ MCP (stdio)                        │ engine-free JSONL read
┌───────────────┴───────────────┐    ┌──────────────┴────────────────────┐
│  mcp   (one server, npx)      │    │  soul-reader  (Tier-1, no engine)  │
│  verbs + token-budget +       │    │  stream/validate/rehydrate         │
│  enrichment (provider API)    │    └──────────────▲────────────────────┘
└───────────────▲───────────────┘                   │ depends only on soul-schema
                │ wraps                              │
┌───────────────┴───────────────┐                   │
│  cli   (crib index|update|    │                   │
│   export|serve|install-hooks) │                   │
└───────────────▲───────────────┘                   │
                │                                    │
┌───────────────┴────────────────────────────────────┴───────────────────┐
│  pipeline  (extract → resolve → 3e-docstring → 3b-doc → 3c-SQL →        │
│             3d-CFG → link(det) → cluster → index)                        │
│  DeterministicLinker (Phase 4) · SemanticLinker (post-Phase 6)          │
└───────────────▲─────────────────────────────────────────────────────────┘
                │ uses                                                    ▲
┌───────────────┴───────────────┐                          ┌──────────────┴────┐
│  parsers  (Extractor plugins) │                          │  core             │
│  tree-sitter WASM + ANTLR4    │                          │  SoulStore        │
│  fallback; Markdown; PL/SQL;  │                          │  IndexStore       │
│  COBOL/legacy grammars        │                          │  GraphModel       │
└───────────────▲───────────────┘                          └──────────────▲────┘
                │                                                            │
┌───────────────┴────────────────────────────────────────────────────────────┴──┐
│  soul-schema  (JSON Schema + TS types — THE CONTRACT; leaf, no deps)          │
│  Node/Edge/Manifest · enums · idFor() (11 id grammars) · vendored schemas     │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** `soul-schema ◄── core ◄── pipeline ◄── mcp ◄── cli`;
`soul-schema ◄── soul-reader` (no engine deps); `parsers ──► pipeline`. **Nothing depends on a
concrete index backend — only on the `IndexStore` interface.** This is what lets sqlite default today
and Kùzu slot in later without touching upstream.

### 2.3 Dual-store architecture (the core differentiator)

| Store | What it is | On disk | Git? | Engine? | Rebuildable? |
|-------|-----------|---------|------|---------|--------------|
| **SoulStore** | Source of truth: chunked JSONL graph (nodes + edges + manifest) | `.crib/nodes/**.jsonl`, `.crib/edges/**.jsonl`, `.crib/manifest.json` | **committed** | **engine-free** (plain text) | no — it *is* the truth |
| **IndexStore** | Derived fast-query layer: FTS5 BM25 + adjacency tables + optional sqlite-vec vectors | `.crib/index/crib.sqlite` (gitignored) | no | sqlite (swap to Kùzu later) | **yes** — `buildFromSoul()` rebuilds from soul |

**Why dual:** the soul is cross-IDE, cross-agent, survives engine swaps, and is readable by SeeroFlow
with zero dependencies (Tier-1 `soul-reader`). The index is disposable performance machinery —
delete `.crib/index/`, `crib index` rebuilds it from the committed soul. **All pipeline writes land
in the soul first; the index is derived.** This invariant is enforced in tests (round-trip
soul→index→soul must be lossless for the deterministic subset).

### 2.4 Pipeline architecture (phased, write-to-soul-first)

```
Phase 1  structure map     ─► file nodes + dir tree
Phase 2  parse             ─► symbol nodes + intra-file edges (tree-sitter WASM / ANTLR4)
Phase 3  resolve           ─► cross-file calls/imports/inheritance/receiver-types (EXTRACTED, conf 1.0)
Phase 3b doc-extract       ─► doc-section / media-seg nodes (Markdown)
Phase 3c SQL data-flow     ─► table/column/statement nodes + reads/writes/executes (migration)
Phase 3d CFG-conditions    ─► condition nodes + guard/cfgPath/branch on edges (migration)
Phase 3e docstring         ─► explanation nodes + derived-from (NEW — gives real producers)
Phase 4  DeterministicLink ─► describes/references via signals 1-3,5 (EXTRACTED, pre-index)
Phase 5  cluster           ─► cluster nodes + member-of (Louvain, EXTRACTED, index-time)
Phase 6  index build       ─► FTS5 + adjacency + (optional) sqlite-vec vectors
─── after Phase 6 ─────────►
Phase 7  SemanticLink      ─► INFERRED references via ANN (capped ≤0.5, opt-in, withEmbeddings)
```

**Ordering invariant:** Phases 1→3e write to SoulStore; Phase 6 builds IndexStore **from** the soul;
the SemanticLinker runs **after** Phase 6 because it needs vectors. The spec conflated ANN into
Phase 4 — this plan splits the linker (see §5 decision #2).

### 2.5 Data model (ontology) — summary; full grammar in data-model §4 (merge 11 ids here)

- **Node kinds:** `file · symbol · doc-section · media-seg · explanation · cluster · table · column ·
  statement · condition`
- **Edge rels:** `calls · imports · inherits · implements · describes · references · derived-from ·
  member-of · executes · reads · writes · guarded-by`
- **Edge metadata (every edge carries):** `{ method, provenance: EXTRACTED|INFERRED, confidence,
  evidence }` plus, for migration edges, `guard` / `cfgPath` / `branch` on `calls`/`executes`/`writes`.
- **ID grammar (11):** `sym:` · `file:` · `doc:` · `table:` · `col:` · `stmt:` · `cond:` · `c:` ·
  `e:` · (+ cluster/explanation prefixes per data-model). Note `col:` id-prefix vs `column`
  kind-name mismatch — keep `col:` as id prefix, `column` as kind.
- **6 invariants (data-model §5)** enforced at write time in `SoulStore.putNodes`/`putEdges`.

### 2.6 Deterministic core vs opt-in enrichment (the trust model)

| Layer | Network? | Provenance | On hot path? |
|-------|----------|-----------|--------------|
| **Deterministic core** (parse/resolve/link-det/cluster/impact/neighbors/shortest_path/query-BM25/describes) | **never** | EXTRACTED, conf=1.0 | **yes** |
| **Enrichment** (semantic link, cluster labels, explanation summaries) | opt-in (direct provider API) | INFERRED, capped ≤0.5 | **no** — lazy, cached |

`--extracted-only` trust mode returns **zero INFERRED** edges. This is the reliability guarantee: an
agent can run on the deterministic core alone, offline, deterministically, and trust every edge.

### 2.7 Deployment & lifecycle

- **v1: local per-dev, stdio MCP.** `npx knowledge-crib` spawns the server; the IDE connects over
  stdio. No daemon required (server is short-lived per session or long-lived per IDE — config-gated).
- **Index lifecycle:** `crib index .` (full) → `crib update` (incremental, computeDelta from git diff)
  → `crib install-hooks` (post-commit hook calls `update`) → `crib serve`. `.gitattributes`
  registers `*.jsonl merge=crib` for the merge driver.
- **Concurrency:** single-writer (index/update acquire `.crib/index/.lock`); queries read a snapshot
  lock-free; `commit()` atomic per chunk (temp→rename). Multi-agent concurrent edits resolved by the
  JSONL merge driver (§5 decision #5).
- **Future:** hosted/team mode (Streamable HTTP transport) deferred past v1 — MCP TS SDK supports it,
  but not needed for the local wedge.

### 2.8 SeeroFlow integration (downstream consumer)

SeeroFlow (the user's MCP-native visual workflow canvas) consumes the soul two ways:
- **Tier-1 (engine-free):** `soul-reader` streams `nodes/**.jsonl` + `edges/**.jsonl`, resolves IDs,
  validates against vendored schema, rehydrates source snippets via `file`+`span` fs reads. **No
  sqlite, no tree-sitter, no network.** This is the "committed soul, readable anywhere" payoff.
- **Tier-2 (with engine):** SeeroFlow can also spawn the MCP server for `impact`/`query`/`shortestPath`
  when it needs fast graph traversal. Tier-1 is the default; Tier-2 is opt-in.

> SeeroFlow integration is grounded in the spec's soul-format §7 Tier-1 contract; the internet research
> run did **not** verify SeeroFlow internals (coverage gap, §13).

---

## 3. Differentiation from Graphify and from Nexus/GitNexus

> **Honesty note:** the complete-requirements deep-research run (105 agents) verified the
> store/MCP/tree-sitter layers but did **NOT** produce surviving verified claims about Graphify's or
> GitNexus's internals, licenses, or architecture. The comparison below is grounded in (a) the 17
> Knowledge-crib spec docs' own characterization of the two inspirations, (b) the research question
> framing, and (c) general knowledge. Treat the competitor columns as directionally accurate but
> **not internet-verified this run**. Knowledge-crib's own columns are spec-grounded.

### 3.1 Knowledge-crib is its own product — not a fork of either

Knowledge-crib copies **no code** from GitNexus or Graphify. It takes one idea from each as design
inspiration and combines them into a third architecture neither has: a **dual soul+index store**
with a **committed, cross-IDE, engine-free soul** and a **deterministic-core-with-opt-in-enrichment**
trust model. The `NOTICE` file credits both as inspiration.

### 3.2 Feature-by-feature

| Dimension | **Knowledge-crib** | **Graphify** (inspiration: broad indexing) | **GitNexus / "Nexus"** (inspiration: deep analysis) |
|-----------|-------------------|---------------------------------------------|-----------------------------------------------------|
| **Language/runtime** | TypeScript/Node | Python | TypeScript |
| **License** | Apache-2.0 (permissive, OSS) | MIT (permissive) | PolyForm-Noncommercial (source-available, **not** OSS) |
| **Primary bet** | Deep **and** broad via dual store + committed soul | Broad multimodal indexing (any input → graph) | Deep code analysis (impact, call chains, type resolution) |
| **Storage model** | **Dual: SoulStore (chunked JSONL, committed, engine-free) + IndexStore (sqlite, derived, rebuildable)** | Single `graph.json` (one file, reportedly up to ~512MiB) | LadybugDB (per research = Kùzu; now archived) — engine-bound store |
| **Committed to git?** | **Yes — soul is the source of truth, diff-able, mergeable** | graph.json committed but monolithic/binary-ish, hard to diff | DB file — not meaningfully diff/merge-able |
| **Cross-IDE portability** | **Engine-free soul readable by any tool (SeeroFlow Tier-1)** | Portable graph file but needs Graphify to query | Needs the LadybugDB engine to read |
| **Serving surface** | **One MCP server (stdio)** — any agentic IDE | Library/CLI (not MCP-native) | MCP server (deep-analysis verbs) |
| **Determinism / trust** | **Deterministic core never needs network; EXTRACTED conf=1.0; `--extracted-only` mode** | LLM-in-the-loop indexing | Deep but engine-coupled; less explicit EXTRACTED/INFERRED split |
| **Enrichment transport** | **Direct LLM provider API** (sampling deprecated — see §4) | LLM-centric | (per spec) MCP sampling |
| **Doc↔code cross-modal linking** | **First-class `describes`/`references` with provenance + confidence + evidence** | Broad indexing includes docs | Code-focused; docs secondary |
| **Migration / rule extraction** | **First-class track: CFG guards → decision-table rule book** (widened, §10) | Not a focus | Not a focus |
| **Rebuildability** | Index rebuildable from soul; soul is truth | graph.json is the artifact | DB is the artifact |

### 3.3 The three things neither inspiration has, that define Knowledge-crib

1. **A committed, engine-free, mergeable soul.** Graphify commits a graph but it's one big file;
   GitNexus commits a DB. Knowledge-crib commits **chunked JSONL that diffs, merges, and survives
   engine swaps** — and is readable by SeeroFlow with zero dependencies. This is the IP moat and the
   cross-IDE story.
2. **A deterministic core with an explicit EXTRACTED/INFERRED trust split + `--extracted-only` mode.**
   Every edge carries provenance, confidence, and evidence. An agent can run fully offline on
   EXTRACTED-only and trust every edge. Neither inspiration makes this split first-class.
3. **A first-class migration/rule-extraction track.** CFG guard conditions → decision-table rule
   book for legacy modernization (ACE/COBOL→Java, .NET/Java upgrades, legacy families). Neither
   Graphify nor GitNexus targets migration.

### 3.4 What Knowledge-crib deliberately does NOT do (to stay distinct)
- Not an IDE plugin / skill — it's a **server** (one MCP server, agent-agnostic).
- Not an LLM-in-the-loop indexer — the core is deterministic; LLM is opt-in enrichment only.
- Not a hosted/team product at v1 — local per-dev only.
- Not multimodal-heavy at MVP — PDF/image/audio deferred to M13 (offline Python worker); MVP is
  Markdown + code + SQL, pure TS.

---

## 4. Research-driven corrections (what the internet forces us to change)

Two `/deep-research` runs (migration scope; complete requirements, 105 agents / ~3.3M tokens / 21
verified claims). Findings that change the spec:

### 4.1 ⚠ MAJOR — MCP sampling is deprecated; enrichment moves to direct provider API
**Finding (3-0 verified):** MCP `sampling/createMessage` — the spec's "opt-in LLM enrichment via
host-IDE MCP sampling" transport — is **formally deprecated** as of protocol version 2026-07-28 via
**SEP-2577** (Final, merged May 15 2026). New implementations **SHOULD NOT adopt it**; existing ones
SHOULD migrate to direct LLM provider API integration. It remains wire-functional ≥12 months
(annotation-only deprecation; methods/types/capability flags still work). Sampling was always
recommended-not-required (capability declared via `_meta.io.modelcontextprotocol/clientCapabilities`).
**Action:** Redesign `packages/mcp/src/enrichment.ts` around **direct LLM provider API calls**
(OpenAI/Anthropic/etc., env-configured key) as the **primary** mechanism. Keep a **transitional,
capability-gated sampling fallback** (only if the host declares the sampling capability) for the
12-month window, clearly marked deprecated. Update `knowledge-crib-architecture.md` §8 and
`knowledge-crib-decisions.md` Q18. **Enrichment is never on the deterministic query hot path** — this
is unchanged and is what makes the deprecation low-risk.

### 4.2 ⚠ "LadybugDB" = Kùzu, but Kùzu is archived → sqlite default reinforced
**Finding (3-0 verified):** The spec's aspirational "LadybugDB" (embedded, OSS, Node-usable
graph+vector+FTS+Cypher) **genuinely exists as Kùzu** (MIT, in-process, HNSW vector shipped v0.9.0
Apr 2025, FTS shipped v0.8.0 Nov 2024, Cypher, first-class Node bindings via cmake-js + prebuilt
binaries, TS defs + ESM). **BUT** canonical `kuzudb/kuzu` was **archived read-only Oct 10 2025**
(Apple acquired Kùzu Inc.; "working on something new"). An actively-maintained vendor fork
(`Vela-Engineering/kuzu`, v0.12.0-vela Jun 14 2026, adds concurrent multi-writer) exists but is
vendor-self-interested (AI-native quant VC using it for their own stack). On-disk format changed
v0.11.0 (July 2025).
**Action:** **sqlite+FTS5+sqlite-vec remains the default** (already locked). Kùzu/Ladybug becomes an
**optional** "rich graph+vector" backend — slot in behind the `IndexStore` interface at M1 as a stub,
land for real only if a community (non-vendor) steward emerges. `capabilities().cypher=false` until
then. Do **not** bet the product on a sunset-codebase fork.

### 4.3 sqlite-vec ceiling + refuted perf claims
**Finding (3-0 / 2-1 verified):** sqlite-vec is MIT, disk-backed, brute-force/exact (100% recall) but
**impractical above ~100k high-dim vectors**. DuckDB+VSS is OOM-disqualified for desktop (HNSW not
buffer-managed, bypasses `memory_limit`). LanceDB scales best but is not set-and-forget (per-dataset
`numPartitions`/`nprobes` tuning) and has a silent-failure Arrow module-conflict footgun. The
specific "40× faster / production-viable via bun:sqlite" and "reranker equalizes quality" claims
were **REFUTED** (0-3, 1-2 — single uncorroborated benchmark, Bun-coupled, depends on a reranker the
deterministic core doesn't use).
**Action:** The deterministic core needs **no vectors at all** — sqlite+FTS5 is the safe default for
it. sqlite-vec is acceptable **only** for the opt-in enrichment path at sub-100k-vector scale.
Default `withEmbeddings=false`. Document the ~100k ceiling in `knowledge-crib-storage.md`.

### 4.4 MCP TS SDK version
**Finding (3-0 verified):** Official MCP TypeScript SDK supports stdio as a first-class transport
(`StdioServerTransport`). **v1.29.0 (Mar 30 2026) is production-recommended**; v2 on main is
explicitly pre-alpha (stable not expected until Q3 2026). Streamable HTTP available for future
remote mode.
**Action:** Target **@modelcontextprotocol/server v1.x** for production; pin v1.29+; do not chase v2
until stable. Streamable HTTP kept in pocket for hosted mode (post-v1).

### 4.5 tree-sitter WASM + the offline-core tension
**Finding (3-0 verified, one medium-confidence nuance):** All 8 core langs (TS/TSX, JS, Python, Java,
Go, Rust, C, C++) have official tree-sitter-org grammars with 2025 commits at ABI 14/15.
`tree-sitter-language-pack` bundles 306 pre-built grammars at ABI 14. web-tree-sitter runs in Node
(mature TS rewrite Jan 2025, dual CJS/ESM). **But:** WASM is "considerably slower than Node native
bindings" (one benchmark found WASM ~2× faster for fish-shell — workload-dependent, not absolute);
the parser registry does **not** track WASM build status; and the 306-grammar pack delivers parsers
via **on-demand download + local cache** on first use — **a cold install needs network**, which
conflicts with "deterministic core never needs network."
**Action:** (a) **Vendor the ~8 core grammar `.wasm` files** statically under
`packages/parsers/grammars/` (the spec already plans this — make it mandatory, not optional) so cold
install is offline. (b) Run a documented `crib doctor --warm-grammars` pre-fetch for non-core langs.
(c) Accept the WASM perf gap for portability (one binary, no native compile); revisit native
`node-tree-sitter` only if parse latency breaches the M2 gate budget on `fixtures/large`. (d) For
each non-core grammar, verify WASM build exists before claiming support (registry won't tell us).

### 4.6 Migration track findings (from the migration-scope run)
- **COBOL** is the only legacy family with a real (pre-1.0) tree-sitter grammar; the strongest
  deterministic COBOL extractors (**Cobol-REKT, COBREX, ProLeap**) all use **ANTLR4, not tree-sitter**.
  → retain **ANTLR4** (Che4z LSP, GnuCOBOL/COBOL85 grammars) as the fallback parse front-end for
  legacy langs.
- **No verified tree-sitter grammar** for RPG, Natural/ADABAS, MUMPS, PL/I, ACE, Clarion. ABL/
  PowerBuilder grammars are experimental. → these families are **ANTLR4-only or regex/LSP-assisted**,
  never tree-sitter-primary; capability-honesty tests must reflect this.
- **Cobol-REKT** computes reaching conditions (the `cfgPath` model) but **only on acyclic, sliced
  CFGs** — needs a structuring/slicing step first; **ALTER & GO TO DEPENDING ON unaddressed**.
  → the CFG pass (Phase 3d) **must include an explicit structuring/slicing step** to produce an
  acyclic CFG before computing guard chains; document ALTER/GO TO DEPENDING ON as known limitations.
- **COBREX** has CFG+DFS but **no guard/condition labeling** — that labeling gap is exactly what
  Knowledge-crib's `condition` nodes + `guarded-by` fill (our differentiator).
- **Heirloom-style** migration = two-stage deterministic-then-LLM (we keep the deterministic stage
  pure-deterministic; LLM is a later opt-in review pass, never in the rule path).
- **Java upgrade:** OpenRewrite `rewrite-migrate-java` = deterministic, no-LLM recipes (8→11→17→21→25).
  **.NET upgrade:** Microsoft .NET Upgrade Assistant is **deprecated** in favor of an LLM Copilot
  agent — Microsoft's *deterministic stance itself* is Knowledge-crib's differentiator here.
  **AWS Blu Age** = Transform→Refactor→Generate via intermediate JSON/DSL IR (a pattern we mirror:
  soul-graph as the IR).
- **ACE→Java:** treat ACE (ADABAS-CAN/Encima, or IBM Advanced CASE) via the ANTLR4/legacy front-end;
  emit the same `table/column/statement/condition` nodes; the rule book is the migration artifact.

---

## 5. Reconciliation decisions (cross-doc contradictions/gaps resolved)

These change the spec; implement to the reconciled form and update the offending docs.

1. **PDF out of MVP.** PRD §6 lists PDF; decisions Q15/Q32 + build-plan M4 + extractor-plugins §2
   defer PDF/media to an offline Python worker. → **MVP = Markdown only, pure TS.** PDF = M13. Update PRD §6.
2. **Split the linker.** pipeline §Phase 4 lists semantic signal #4 (ANN) inside Phase 4, but vectors
   don't exist until Phase 6. → Phase 4 = **`DeterministicLinker.link(soul)`** (signals 1–3,5,
   EXTRACTED, pre-index). A **`SemanticLinker.link(soul, index)`** pass runs **after Phase 6**
   (INFERRED, capped ≤0.5, `references` only). M4 tests deterministic; M7 tests semantic.
3. **Cluster detection vs labeling.** pipeline §Phase 5 conflates index-time clustering with
   serve-time sampling. → cluster **detection** at index time (deterministic `cluster` nodes +
   `member-of`, EXTRACTED); cluster **labeling** via enrichment (direct provider API, post-§4.1) at
   **serve-time** (lazy, cached as INFERRED `meta`). Document the split.
4. **`detect_changes` vs `update` overlap.** → `detect_changes` = **dry-run delta report**
   (compute graph delta from git diff vs current soul, no write); `update` = **apply delta** (write
   soul + index). Share a common `computeDelta(since)` core in `pipeline/incremental.ts`.
5. **Define the merge driver concretely** (docs only assert it exists). → a TS script registered in
   `.gitattributes` (`*.jsonl merge=crib`): for nodes, union lines by `id` (content-identical → no
   real conflict); for edges, union lines then dedup by `(src,dst,rel)` applying the conflict rule.
   A JSONL-line union + semantic dedup, not a text merge.
6. **Merge the 11 ID grammars into data-model §4** (canonical ontology): add `table:`, `col:`,
   `stmt:`, `cond:` (currently only in deep-extraction §2). Keep `col:` id prefix, `column` kind.
7. **Manifest `stores` gets a `backend` field:** `"index": {"backend":"sqlite","path":".crib/index/crib.sqlite"}`
   (soul-format §4 currently hardcodes `ladybug.db`).
8. **`route_map` verb:** drop (use `shortest_path` + `neighbors`). build-plan §3 references it;
   mcp-api never defines it.
9. **`cypher` is an optional pass-through** verb gated on backend; remove from "always-available
   deterministic core" wording in architecture §8. Always-available deterministic core =
   parse/graph/impact/neighbors/shortest_path/query(BM25)/describes.
10. **Conflict-rule tie-break (unspecified):** on equal provenance + equal confidence, merge
    `evidence` arrays and keep the lexicographically smaller `id` (deterministic). Add to data-model §3.
11. **Embedding/vector storage:** `IndexStore` owns vectors inside `.crib/index/` (sqlite-vec); the
    separate `.crib/embeddings/` dir becomes an optional export only (soul-format §2).
12. **Interface drift:** treat **storage §1/§2 as canonical** for `SoulStore`/`IndexStore`; build-plan
    §1 abridged versions are summaries, not the contract.
13. **Define the `SoulReader` Tier-1 TS interface** (soul-format §7 is prose-only) — see M9. Pull
    `soul-reader` forward to right after M0 (depends only on `soul-schema`).
14. **M12 depends on M5** (hidden MCP dependency): `extract_rules` is an MCP verb needing the M5
    server. Schedule M12 after M5 + M11.
15. **(NEW, from §4.1) Enrichment transport = direct provider API, not MCP sampling.** Update
    architecture §8, decisions Q18, mcp-api enrichment section.
16. **(NEW, from §4.5) Vendor core grammar `.wasm` statically** — mandatory for the offline guarantee.
    Add to extractor-plugins §3 and build-plan.

---

## 6. Repo & stack

- **pnpm monorepo**, TypeScript/Node 22+, **Apache-2.0** + `NOTICE` crediting GitNexus & Graphify as
  inspiration (no code reused).
- Packages: `soul-schema` · `core` · `parsers` · `pipeline` · `mcp` · `cli` · `ui` (later) ·
  `soul-reader`. (Layout per README target.)
- **Parsing:** `web-tree-sitter` (WASM) for 8 core langs; **ANTLR4 fallback front-end** for legacy
  (COBOL/RPG/Natural/MUMPS/PL-I/ACE/ABL/PowerBuilder); grammars **vendored** under
  `packages/parsers/grammars/` with upstream permissive-license notices. ~20 langs incrementally.
- **Index:** `better-sqlite3` + FTS5 (BM25) + `sqlite-vec` (optional vectors) — default. Adjacency
  materialized at build so `impact`/`neighbors`/`shortestPath` are O(degree). Kùzu/Ladybug = optional
  stub backend.
- **MCP:** `@modelcontextprotocol/server` **v1.29+** (v1.x production line; v2 pre-alpha, do not chase).
- **Clustering:** `graphology-communities-louvain` (Louvain) for M7; Leiden as future swap.
- **IP hygiene:** never paste GitNexus PolyForm source into this repo; read MIT Graphify freely for
  ideas but write all code original. `NOTICE` credits both.

---

## 7. Canonical interfaces to define first (cite, don't re-invent)

- **`SoulStore`** — `storage.md` §1: `load()`, `putNodes()`, `putEdges()`, `getNode()`,
  `iterate(kind?)`, `iterateEdges(rel?)`, `removeByFile()`, `commit()`.
- **`IndexStore`** — `storage.md` §2: `buildFromSoul(soul, opts?)`, `applyDelta(changed)`,
  `query(HybridQuery)`, `impact(id, dir, depth?)`, `neighbors(id, rel?, dir?)`,
  `shortestPath(from, to, maxHops?)`, `capabilities(): {cypher, vector}`.
- **`Extractor`** — `extractor-plugins.md` §1: `name`, `supports(file)`,
  `extract(file, ctx) → {nodes, edges}`; `FileMeta`, `ExtractCtx` (`readText()`, `treeSitter()`,
  `hash()`, `idFor()`), `ExtractResult`. Put **types** in `soul-schema`; `ExtractCtx`
  **implementation** in `pipeline`. Capability matrix `{imports, calls, inheritance, types}`. Add an
  **`antlrParse()`** hook on `ExtractCtx` for legacy langs (§4.6).
- **`Linker`** — split: `DeterministicLinker { link(soul): Edge[] }` (Phase 4) +
  `SemanticLinker { link(soul, index): Edge[] }` (post-Phase 6).
- **`SoulReader`** — **new** (see M9): `discover(root): Manifest`, `streamNodes(kind?)`,
  `streamEdges(rel?)`, `getNode(id)`, `neighbors(id)` (linear scan), `validate()`,
  `rehydrate(node)` (source-file fs read by `file`+`span`). Tier-1 has no `impact`/`query`/`shortestPath`.
- **`Enricher`** — **new** (§4.1): `enrich(nodes/edges, op): {nodes, edges}` over **direct LLM
  provider API** (env-configured); capability-gated sampling fallback marked deprecated; never on the
  deterministic verb path.

---

## 8. Build waves (parallelism)

| Wave | Packages | Parallel? | Blocked by |
|------|----------|-----------|------------|
| W1 | `soul-schema` | — (leaf) | nothing |
| W2 | `core`(SoulStore), `parsers`(base+Extractor types+vendor grammars), `soul-reader` | **yes** (all depend only on soul-schema) | W1 |
| W3 | `core`(IndexStore impl), `pipeline`(structure+parse), `parsers`(TS extractor) | yes | W2 |
| W4 | `pipeline`(resolve), `parsers`(Markdown extractor) | yes | W3 |
| W5 | `pipeline`(deterministic linker, Phase 3e docstring), `parsers`(more langs) | yes | W4 |
| W6 | `mcp`(verbs + enricher via provider API), `cli` | yes (mcp first, cli wraps) | W5(M4) + W3(M1) |
| W7 | `ui`, `pipeline`(cluster+semantic, incremental+merge driver) | yes | W6 |
| W8 migration | `parsers`(PL/SQL + ANTLR4 legacy front-end), `pipeline`(3c/3d CFG + structuring) | yes — forks at W4(M3) | M3 for M10; M11←M10; M12←M11+M5 |

**Critical path:** W1→W2(core)→W3(pipeline parse)→W4(resolve)→W5(linker)→W6(mcp)→**M5 wedge gate**.
Migration track is off-critical-path once it forks at M3; M12 rejoins at M5.

---

## 9. Milestones (each = one flagged PR + test gate)

### M0 — `soul-schema` + `SoulStore` (chunked JSONL r/w + manifest)
- **Packages:** `soul-schema`, `core` (SoulStore only).
- **Files:** `packages/soul-schema/src/{types.ts,id.ts,schema/*.json}`,
  `packages/core/src/{soul-store.ts,shard.ts,conflict-rule.ts,manifest.ts}`.
- **Define day-one:** `Node`/`Edge`/`Manifest` types, all enums (`NodeKind`, `Rel`, `Method`,
  `Provenance`), `Span`, `Evidence`, `idFor()` covering **all 11 id grammars** (incl.
  `table/col/stmt/cond`), vendored JSON Schema for node/edge/manifest. Sharding =
  `blake3(sourcePath)[:shardHexDigits]`, chunk rolls at `maxChunkLines`. Conflict rule incl. tie-break (#10).
- **Gate:** round-trip nodes/edges→JSONL chunks→reload byte-stable; conflict-rule unit-tested; all 6
  data-model §5 invariants enforced; unknown `meta` preserved.
  Run: `pnpm --filter @knowledge-crib/core test`.
- **Unblocks:** M1, M2, M9, M10. **Unblocked by:** nothing.

### M1 — `IndexStore` interface + sqlite default impl (+ Kùzu stub)
- **Packages:** `core` (IndexStore iface + sqlite impl; Kùzu/Ladybug stub).
- **Files:** `packages/core/src/{index-store.ts,index/sqlite-index.ts,index/kuzu-index.ts}`.
- sqlite impl: FTS5 BM25, adjacency tables, `sqlite-vec` for optional vectors, `applyDelta`,
  `capabilities().cypher=false`. `withEmbeddings` default false. Document the ~100k sqlite-vec ceiling.
- **Gate:** `buildFromSoul` on a fixture soul; `query` returns expected ids; sqlite parity test
  (canonical since sqlite is default). Run: `pnpm --filter @knowledge-crib/core test`.
- **Unblocks:** M5, M6. **Unblocked by:** M0.

### M2 — parse pipeline, 1 lang (TypeScript) → symbols + intra-file edges
- **Packages:** `parsers` (tree-sitter base + TS extractor + **vendored core grammars**),
  `pipeline` (Phase 1 structure + Phase 2 parse).
- **Files:** `packages/parsers/src/{registry.ts,ts/TypeScriptExtractor.ts,grammars/}`,
  `packages/pipeline/src/{structure.ts,parse.ts,extract-ctx.ts}`.
- **Gate:** TS golden on `fixtures/ts-min` → exact symbol nodes + intra-file `member-of`/local-calls;
  degradation (malformed → file-level node, no throw); id-stability; **offline cold-install test**
  (grammars vendored, no network). Run: `pnpm --filter @knowledge-crib/parsers test`.
- **Unblocks:** M3. **Unblocked by:** M0, M1.

### M3 — resolve pass (cross-file imports/calls/inheritance/receiver-types) ← MIGRATION FORK POINT
- **Packages:** `pipeline` (Phase 3 resolve).
- **Files:** `packages/pipeline/src/resolve/{imports.ts,calls.ts,inheritance.ts,receiver-types.ts,symbol-table.ts}`.
  All edges `method:static, provenance:EXTRACTED, confidence:1.0`; **unresolved calls dropped, never guessed**.
- **Gate:** call/import/inherit edges on `ts-min` at **precision ≥ 0.95**; unresolved-call drop verified.
  Run: `pnpm --filter @knowledge-crib/pipeline test -- resolve`.
- **Unblocks:** M4, M5, M10. **Unblocked by:** M2.

### M4 — doc-extractor (Markdown) + deterministic cross-modal linker ← HEADLINE GATE #1
- **Packages:** `parsers` (MarkdownExtractor), `pipeline` (Phase 3b doc-extract + Phase 4 deterministic linker).
- **Files:** `packages/parsers/src/md/MarkdownExtractor.ts`,
  `packages/pipeline/src/{doc-extract.ts,linker/{index.ts,inverted-index.ts,signals/{explicit,identifier,path,heading-scope}.ts,score.ts}}`.
  Inverted index `symbolName→symbol[]` ⇒ O(doc tokens). Scoring per pipeline §Phase 4:
  `conf=max(signalConf)`+agreement boost (cap 0.99); `describes` iff `conf≥0.8` and
  `method∈{explicit,identifier}`; else `references`; persist iff `conf≥0.4`.
- **Gate:** deterministic-signal **precision ≥ 0.9** on `fixtures/docs-linked` (hand-labeled
  `labels.json` → precision/recall per `method`/provenance; threshold honored). Semantic is M7.
  Run: `pnpm test -- linker-precision`.
- **Unblocks:** M5. **Unblocked by:** M3.

### Phase 3e — docstring/comment → `explanation` extractor (parallel to M4)
- **Packages:** `parsers`/`pipeline` (per-language comment extraction) → `explanation` nodes +
  `derived-from` edges to the owning symbol; provenance `EXTRACTED`. TS/Java first, PL/SQL at M10.
- **Gate:** golden on a fixture with docstrings → expected `explanation` nodes + `derived-from` edges;
  id/hash stability. Run: `pnpm test -- explanation-golden`.

### M5 — MCP server: context/impact/describes/query/neighbors/shortest_path/detect_changes ← HEADLINE GATE #2
- **Packages:** `mcp` (verbs + **enricher via direct provider API**, §4.1), `cli` (`crib serve|status|query`).
- **Files:** `packages/mcp/src/{server.ts,verbs/*.ts,token-budget.ts,enrichment.ts}`,
  `packages/cli/src/commands/{serve,status,query}.ts`. Token-budget: `docLimit=3`, `limit=10`,
  `truncated`+`cursor`; every edge result carries `{method,provenance,confidence,evidence}`;
  `--extracted-only` trust mode. `enrichment.ts`: direct LLM provider API primary, capability-gated
  sampling fallback (deprecated), never on deterministic verbs. MCP SDK v1.29+.
- **Gate:** (1) **E2E wedge** — index a repo with `/docs`; `impact("AuthService","up")` returns code
  blast-radius **and** ≥1 `describes` doc-section with provenance snippet; (2) **token-cut benchmark**
  — Arm A (agent reads files) vs Arm B (agent queries crib) → measurable token reduction while adding
  doc context; results in `bench/REPORT.md`. Run: `pnpm test:e2e` + `pnpm bench:token-cut`.
  *(Bench harness uses an env-provided LLM key — test infra, not shipped product.)*
- **Unblocks:** M6, M12. **Unblocked by:** M4, M1.

### M6 — incremental `update` + git hook + merge driver
- **Packages:** `cli` (`crib update|install-hooks`), `core` (applyDelta wired), `pipeline` (incremental).
- **Files:** `packages/pipeline/src/incremental.ts(computeDelta)`,
  `packages/cli/src/commands/{install-hooks.ts,merge-driver.ts}`, `.gitattributes` `*.jsonl merge=crib`.
  Merge driver = JSONL-line union + edge dedup by `(src,dst,rel)` per conflict rule (#5). Single-writer;
  `.crib/index/.lock`; `commit()` atomic per chunk (temp→rename).
- **Gate:** edit 1 file → only its shard-chunks change (diff assertion); merge-driver resolves a
  synthetic conflict via the rule. Run: `pnpm test -- incremental` + `pnpm test -- merge-driver`.
- **Unblocks:** production lifecycle. **Unblocked by:** M5.

### M7 — clustering + semantic linker signal + web UI viz
- **Packages:** `pipeline` (Phase 5 cluster + semantic pass), `ui`.
- **Files:** `packages/pipeline/src/{cluster.ts,linker/signals/semantic.ts}`, `packages/ui/`.
  **Louvain** for detection (EXTRACTED `cluster` + `member-of`); labels via enrichment (provider API)
  at serve-time (lazy, INFERRED). Semantic pass post-Phase 6: ANN over sqlite-vec, INFERRED, capped
  ≤0.5, `references` only (sub-100k vectors per §4.3).
- **Gate:** clusters render in UI; semantic signal improves recall without dropping deterministic
  precision below M4's 0.9. Run: `pnpm test -- cluster` + UI smoke.
- **Unblocks:** M8. **Unblocked by:** M6 (+ `withEmbeddings` for semantic).

### M8 — more languages (plugin extractors)
- **Packages:** `parsers` (Rust/Python/Go/Java per extractor-plugins §4). Each ships golden +
  capability-honesty tests; resolver hooks added in `pipeline/resolve`. Parallelizable per language.
  Verify WASM build exists per grammar before claiming support (§4.5).
- **Gate:** per-lang golden + capability-honesty. Run: `pnpm --filter @knowledge-crib/parsers test -- <lang>`.

### M9 — `soul-reader` package + SeeroFlow Tier-1 read contract
- **Packages:** `soul-reader` (build right after M0 in practice; M9 = formalize + test).
- **Files:** `packages/soul-reader/src/{reader.ts,snippet.ts}`. Tier-1: stream `nodes/**.jsonl` +
  `edges/**.jsonl`, resolve by ID grammar, validate against vendored schema, rehydrate snippets via
  source-file fs reads. No `impact`/`query`/`shortestPath` (Tier-2 only) — document linear-scan `neighbors` cost.
- **Gate:** reads `.crib/` engine-free and validates against schema (SeeroFlow Tier-1).
  Run: `pnpm --filter @knowledge-crib/soul-reader test`.
- **Unblocked by:** M0 only — runs parallel to M1–M8.

### M10–M12 — migration track (see §10) · M13 — offline Python worker (PDF/image/whisper → soul)

---

## 10. Migration track (widened) — first-class, deterministic, no-LLM in the rule path

**Goal:** extract a deterministic **decision-table rule book** from legacy source via CFG guard
conditions, as the migration artifact. Pure-deterministic; LLM is a later opt-in review pass only.

### 10.1 Source families (widened beyond the original PL/SQL→COBOL framing)

| Family | Parse front-end | Tree-sitter? | Notes |
|--------|-----------------|--------------|-------|
| **PL/SQL** (Oracle) | tree-sitter (primary) | yes | M10 baseline; DDL→`table/column`, procs→`statement`, reads/writes/executes |
| **COBOL → Java** | **ANTLR4** (Cobol-REKT/COBREX/ProLeap style; GnuCOBOL/COBOL85 grammar) | pre-1.0 grammar only | acyclic-CFG structuring step mandatory; ALTER/GO TO DEPENDING ON = known limits |
| **ACE → Java** | ANTLR4 / LSP-assisted | no verified grammar | same `table/column/statement/condition` nodes; rule book = artifact |
| **.NET upgrade** (framework → modern) | tree-sitter C# + Roslyn/LSP-assist | C# yes | Microsoft deprecated Upgrade Assistant for LLM — **our deterministic stance is the differentiator** |
| **Java upgrade** (8→11→17→21→25) | tree-sitter Java | yes | mirror OpenRewrite `rewrite-migrate-java` deterministic-recipe pattern (no LLM) |
| **RPG / Natural-ADABAS / MUMPS / PL/I** | ANTLR4 or regex/LSP-assist | **no verified grammar** | ANTLR4-only; capability-honesty tests must reflect |
| **ABL (OpenEdge) / PowerBuilder** | ANTLR4 (experimental grammars) | experimental only | lower confidence; flag in capability matrix |

### 10.2 Pipeline (Phases 3c + 3d, the migration wedge)

- **Phase 3c — SQL/legacy data-flow:** emit `symbol(procedure|function|package|trigger)`,
  `table`/`column` (from DDL), `statement` nodes + `reads`/`writes`/`executes` edges.
- **Phase 3d — CFG + guard conditions:**
  1. **Structuring/slicing step (NEW, §4.6):** produce an **acyclic, sliced CFG** per procedure
     (Cobol-REKT model). Document unstructured constructs (ALTER, GO TO DEPENDING ON) as limits.
  2. Compute guard chain from procedure entry.
  3. Attach `guard`/`cfgPath`/`branch` to `calls`/`executes`/`writes` edges.
  4. Emit `condition` nodes + `guarded-by` edges. All `EXTRACTED` — **no LLM in the rule path**.
- **M12 — `extract_rules` verb + `crib export --format rules`:** flatten the CFG into a decision
  table: per terminal action, the AND-chain of guards reaching it (+ `reads`, `via`). This fills the
  gap COBREX leaves (CFG+DFS but no guard/condition labeling).

### 10.3 Milestones (fork at M3, rejoin at M5)

- **M10 — PL/SQL extractor + SQL data-flow.** Gate: golden — a package → expected
  procs/tables/edges on `fixtures/plsql/`. Run: `pnpm test -- plsql-golden`. **Unblocked by:** M3, M0.
- **M11 — CFG pass + structuring + guard/cfgPath/branch + `condition` nodes.** Gate: guard-chain
  correctness on a branchy fixture proc (hand-derived `cfgPath`); acyclic-CFG structuring verified;
  ALTER/GO-TO-DEPENDING-ON limits documented. Run: `pnpm test -- cfg-guards`. **Unblocked by:** M10.
- **M12 — `extract_rules` verb + `crib export --format rules|mermaid`.** Gate: decision-table
  matches hand-derived rules on fixture; `crib export --format rules` diff vs
  `fixtures/plsql/expected-rules.json`. Run: `pnpm test -- extract-rules`.
  **Unblocked by:** M11 **and M5** (hidden MCP dependency).
- **M12b (later) — COBOL/ACE + legacy-family extractors via ANTLR4 front-end.** Per-family golden +
  capability-honesty tests; the structuring step is per-family. Parallelizable per family.
- **M13 (later) — offline Python worker: PDF/image/whisper → same node/edge records into the soul**
  (decisions Q32; keeps the TS MCP path pure-TS/fast). Multimodal fixtures.

---

## 11. Verification strategy (end-to-end)

- **CI pyramid** (testing §1/§7): PR = lint + typecheck + unit + golden + integration + contract
  (ajv vs JSON Schema) + trust-mode (`--extracted-only` ⇒ zero INFERRED, from M4 on) + **offline
  cold-install** (vendored grammars, no network). Nightly = E2E + benchmark + perf on `fixtures/large`.
  Schema changes require a `crib migrate` round-trip test.
- **Two headline gates:**
  - **M4 link precision ≥ 0.9** — hand-label `fixtures/docs-linked/labels.json`; `precision=correct/emitted`,
    `recall=correct/true`; report per `method`/provenance; deterministic precision gated; semantic recall-only + capped.
  - **M5 token-cut + E2E wedge** — `impact("AuthService","up")` returns code blast-radius + ≥1 `describes`
    doc with provenance snippet; Arm A vs Arm B token reduction + rubric quality; `bench/REPORT.md`.
- **Guardrails (testing §6):** index time on `fixtures/large` within budget; p99 verb latency
  tracked; incremental 1-file change ≪ full index; parser `--worker-timeout` prevents hangs.
- **E2E wedge assertion (build-plan §5):** index a repo with `/docs`; agent calls
  `impact("AuthService","up")` → code blast-radius **and** ≥1 `doc-section` linked by `describes`
  with provenance snippet. Wedge proven.
- **Typical lifecycle smoke (cli.md §):** `crib index .` → `crib install-hooks` → `crib serve` →
  `crib export --format graph.json`. Exit codes: 0 ok · 1 error · 2 bad args · 3 not indexed · 4 migration required.
- **Determinism check:** re-index identical source → byte-identical soul (modulo shard ordering);
  `--extracted-only` returns zero INFERRED edges.

---

## 12. Critical files (spec, read-first during implementation)
- `knowledge-crib-build-plan.md` — M0–M12 milestones, interfaces, ordering (abridged — defer to storage for canonical interfaces)
- `knowledge-crib-storage.md` — canonical `SoulStore` + `IndexStore` interfaces ← code to these
- `knowledge-crib-data-model.md` — ontology, ID grammar (merge 11 grammars here), conflict rule, invariants
- `knowledge-crib-soul-format.md` — on-disk layout, manifest (add `backend` field), merge driver, SeeroFlow Tier-1 contract
- `knowledge-crib-pipeline.md` — Phase 1–6 sequencing, linker signals (split semantic out), clustering, incremental
- `knowledge-crib-deep-extraction.md` — migration track: `table/column/statement/condition`, CFG guards, `extract_rules` (widen per §10)
- `knowledge-crib-architecture.md` — system design + diagrams (fix §8: cypher optional; enrichment=provider API not sampling)
- `knowledge-crib-mcp-api.md` / `knowledge-crib-cli.md` / `knowledge-crib-extractor-plugins.md` / `knowledge-crib-testing.md`
- `knowledge-crib-decisions.md` — the why (Q1–Q40; update Q18 enrichment transport); `knowledge-crib-prd.md` — vision/scope/metrics (update §6 to Markdown-only)

---

## 13. Open questions / research coverage gaps

**Research coverage gap (honesty):** The complete-requirements deep-research run (105 agents, 21
verified claims) validated the **store**, **MCP**, and **tree-sitter** layers only. It produced **no
surviving verified claims** for: Graphify-vs-Nexus differentiation internals, competitive prior-art
map (Sourcegraph Cody, Augment, Cursor, Aider repo-map, repomix, Joern CPG, academic CPG-for-LLM),
pure-JS/TS clustering lib correctness, git merge-driver patterns, token-reduction benchmarks, the
"soul"/project-memory precedents, or SeeroFlow internals. §3 differentiation is grounded in the 17
docs + general knowledge and flagged as **not internet-verified this run**. A dedicated second
research pass is recommended for the token-reduction thesis (the core value prop) and clustering-lib
correctness before M7.

**Open for implementation:**
1. Token-reduction benchmark design (M5) — needs a controlled repo + an env-provided LLM key + a
   rubric. The thesis is the product's core value prop and is currently **unvalidated by research**.
2. Clustering-lib correctness — `graphology-communities-louvain` vs reference Louvain (assess before M7).
3. Kùzu/Ladybug optional backend — land only if a non-vendor community steward emerges post-archive.
4. Sampling → provider-API migration timing (12-month window from 2026-07-28).

---

> **First implementation step:** `pnpm` workspace init + `soul-schema` package + W1 (M0). Apply doc
> updates (reconciliations #1,6,7,8,9,11,12,15,16 + PRD §6 + architecture §8 + decisions Q18)
> alongside the corresponding milestones so spec and code stay in sync. License Apache-2.0 + `NOTICE`
> crediting GitNexus & Graphify as inspiration (no code reused).