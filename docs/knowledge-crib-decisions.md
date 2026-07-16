# Unified KG Platform (GitNexus × Graphify) — Design Decisions

**Session date:** 2026-06-24
**Domain:** Product Design × System Architecture (hybrid)
**Total decisions:** 47 (+ 8 clarifications)
**Resolution:** Major direction lock (2026-06-24): **greenfield, all-new open-source product** — neither tool used as a base, **no code copy-pasted**. Both are *inspiration only*: Graphify = the indexing model, GitNexus = the deep-analysis model. Product = a single **MCP-based, cross-IDE "project memory / soul."** Overrides on Q1, Q2, Q3, Q6, Q8, Q9, Q26; new Q31–Q38; SeeroFlow named as a future integration target.

---

## Inputs (resolved from repo analysis, not asked)

| Fact | GitNexus | Graphify |
|------|----------|----------|
| Runtime | TypeScript / Node | Python 3.10+ |
| Parsing | tree-sitter (~20 langs) | tree-sitter (36 grammars) |
| Clustering | Louvain or Leiden (verify) | Leiden (graspologic) |
| Edge provenance | static / certain | EXTRACTED vs INFERRED |
| Store | **LadybugDB** (embedded graph + vector) | `graph.json` (512 MiB cap) |
| Depth | execution-flow tracing, type resolution, Cypher, blast-radius | shortest-path, god-nodes, cross-file links |
| Breadth | code only | code + docs + PDF + media + YouTube + Workspace |
| LLM | local-only, no network | pluggable (Claude/Gemini/OpenAI/Ollama/Bedrock/Azure) |
| Interfaces | CLI, MCP, WASM web UI, HTTP API | CLI skill, MCP, HTTP, HTML viz, Mermaid |
| License | PolyForm Noncommercial (+ akonlabs commercial) | **MIT** (permissive — reuse/modify/distribute incl. commercial) |
| Owner | vishalc412 (you) | safishamsi (third party) |

---

## Decision Log

| # | Question | Decision | Rec? |
|---|----------|----------|------|
| **Branch 1 — Strategic Intent & Ownership** ||||
| Q1 | Structural relationship | **Greenfield** — neither as base; all-new code inspired by both (Graphify = indexing model, GitNexus = deep-analysis model) | ⚡ Override |
| Q2 | Rights reconciliation | **Clean original implementation** — study both, copy neither; OK to read MIT graphify; must NOT copy PolyForm GitNexus source | ⚡ Override |
| Q3 | North-star wedge | **Portable "project soul/memory" for AI agents** — cross-IDE, agent-agnostic context giving full project understanding fast & cutting tokens | ⚡ refined |
| Q4 | Build sequencing | **Prototype the wedge end-to-end, narrow** before full unification | ✅ |
| **Branch 2 — Target User & Job** ||||
| Q5 | Primary persona | AI-IDE power dev on a large/legacy codebase (Cursor/Claude Code daily) | ✅ |
| Q6 | Core job-to-be-done | "Understand any project **faster**, give the agent **full project context**, and **cut token cost**" | ⚡ refined |
| Q7 | Code-first vs corpus-first | **Code-first**, docs as first expansion ring | ✅ |
| Q8 | Pain to anchor on | **Rework/breakage AND token cost** (both, for now) | ⚡ Override |
| **Branch 3 — Unified Graph & Data Architecture** ||||
| Q9 | Canonical store | **Dual, two roles:** LadybugDB = fast local working index; chunked `graph.json` on filesystem = portable, git-committable **soul** (source of truth, cross-IDE, rebuildable index). Store-agnostic/swappable; soul-only mode for small projects | ⚡ Override |
| Q10 | Ontology | **One unified schema**: code symbols + doc nodes + media nodes + explanation nodes; typed edges (calls/imports/describes/references/derived-from) | ✅ |
| Q11 | Portability vs scale | **Scale-first** (LadybugDB), portability via export | ✅ |
| Q12 | Incremental + git | Adopt graphify post-commit hook + merge driver atop GitNexus incremental indexing | ✅ |
| **Branch 4 — Ingestion & Extraction** ||||
| Q13 | Pipeline architecture | **One pluggable pipeline** with extractor plugins → unified store | ✅ |
| Q14 | Depth vs breadth | Preserve GitNexus code depth (non-negotiable); layer breadth as plugins | ✅ |
| Q15 | Multimodal scope @ MVP | Code + Markdown + PDF; defer media/Workspace to v2 | ✅ |
| Q16 | Cross-modal linking | **Yes** — auto-link doc/spec mentions ↔ code symbols (the differentiator) | ✅ |
| **Branch 5 — Intelligence Layer (LLM / Privacy)** ||||
| Q17 | Local vs cloud | **Local-by-default, optional opt-in cloud enrichment** | ✅ |
| Q18 | LLM backend | **Default: host IDE's LLM via MCP `sampling`** (no bundled provider/key, cross-IDE). Fallback chain: sampling → local Ollama → configured cloud key → skip. Never on the deterministic query path | ⚡ updated |
| Q19 | LLM vs deterministic | Deterministic core (parse/graph/impact/Cypher/search) never needs LLM; LLM only for enrichment | ✅ |
| **Branch 6 — Interface & Output Surface** ||||
| Q20 | Unified MCP verbs | GitNexus verbs canonical; map graphify verbs onto them; add `shortest_path` | ✅ |
| Q21 | Visualization | WASM web UI primary; adopt Mermaid export + GRAPH_REPORT.md + static HTML share; keep wiki gen | ✅ |
| Q22 | MCP-first vs UI-first | **MCP-first** — agent is primary consumer | ✅ |
| **Branch 7 — MVP Scope & Roadmap** ||||
| Q23 | MVP slice | Doc-extractor (MD+PDF) + cross-modal linker + extend `impact`/`context` to surface linked docs, one repo | ✅ |
| Q24 | v2 deferrals | Media ingestion, Workspace, graph.json store-swap, multi-repo multimodal, cloud SaaS | ✅ |
| Q25 | Metrics | Activation (% repos using doc-link verbs in wk 1); guardrail = index time + p99 latency no regression | ✅ |
| Q26 | License/commercial | **Fully open-source, all-new code** → permissive OSI license (rec **Apache-2.0**). No PolyForm inheritance (not reusing GitNexus source). OSS-only, no commercial tier for now | ⚡ Override |
| **Branch 8 — User Research Plan** ||||
| Q27 | Riskiest assumption | "Devs want — and trust — doc/spec context fused into code impact, vs. better code-only context" | ✅ |
| Q28 | Method + sample | 5–8 interviews + moderated usability test of MVP flow (1–2 wks) | ✅ |
| Q29 | Key questions | (1) When agent broke X, what context was missing? (2) Do you trust auto-linked doc↔code? (3) Would persistent multimodal memory change delegation? | ✅ |
| Q30 | Recruit pool | Both user bases + 2–3 cold AI-IDE devs on large codebases | ✅ |
| **Branch 9 — Architecture Reconciliation (unified vs federated)** ||||
| Q31 | Runtime model | **Single unified runtime, greenfield** (not federation, not either tool's process) | ⚡ (greenfield) |
| Q32 | Python heavy extractors (PDF/image/whisper/LLM) | **Drop multimodal for v1** (code + MD); add later via optional offline worker | ✅ |
| Q33 | # MCP servers | **One** MCP server, unified verb namespace, serves every project from its on-disk soul | ✅ |
| Q34 | Single UI | **One** graph UI + layers (code/docs/concepts), per-project | ✅ |
| Q35 | Edge provenance | **Adopt EXTRACTED/INFERRED** → edge `{method, provenance, confidence}`; static/deterministic outranks inferred on conflict | ✅ |
| **Branch 10 — Greenfield Build (new)** ||||
| Q36 | Implementation language | **TypeScript / Node** (rec) — best MCP SDK + `npx` cross-IDE distribution + tree-sitter WASM + embeddable store. **Confirm before scaffolding** (Python if ML-first, Rust if perf-first) | ⭐ rec, confirm |
| Q37 | OSS license | **Apache-2.0** (patent grant) over MIT | ⭐ rec |
| Q38 | SeeroFlow integration | Future: expose the soul via MCP + portable `graph.json` so SeeroFlow flows consume project memory; design the read seam now, build after MVP | new |
| **Branch 11 — Deep Extraction / Migration (new)** ||||
| Q39 | Deep-extraction wedge | **First-class, kept alongside the doc-link MVP** — extract a system completely enough to rebuild it (PL/SQL→COBOL/Java/.NET); not flagship, but in scope | ⚡ added |
| Q40 | Data-model extension | **Spec now:** `table`/`column`/`statement`/`condition` nodes; `reads`/`writes`/`executes`/`guarded-by` edges; `guard`/`cfgPath` on calls; CFG pass for conditions (see deep-extraction doc) | ⚡ added |
| **Branch 12 — Schema 1.3 Framework-Semantics Layer (new)** ||||
| Q41 | route/field/component as NODE kinds | **First-class `NodeKind`s** (`route`/`field`/`component` in `NODE_KINDS`, with `field:`/`route:`/`comp:` id prefixes), NOT bare `symbol` sub-types — so they can be edge endpoints (`exposes`/`references`/`renders` terminate on them) and carry their own fields (`httpMethod`/`routePath` on route, `dataType`+`meta.column` on field, `framework` on component). Confirmed in `packages/soul-schema/src/enums.ts` | ⭐ rec, yes |
| Q42 | `produces` rel (not folding @Bean into `injects`) | **Separate `produces` rel** (Rel enum, producer method → produced type), NOT folding the @Bean supply edge into `injects` — so the supply chain is one-hop queryable: a `soul-wide produces scan` builds `producerOf` and a dependency whose type is a @Bean output surfaces `kind:'produces'` + the producer brief in the same object. Confirmed in `enums.ts` (`produces` in `RELS`) + `framework.ts` `pushDependency`/`producerOf` | ⭐ rec, yes |
| Q43 | `context` `withFramework` is OPT-IN | **Opt-in `withFramework:boolean`** on the `context` verb (matches the existing `withRules`/`withSource` convention), NOT unconditional — `frameworkSemantics` runs only when the flag is set, and `result.framework` is omitted when undefined (no framework edges). Confirmed in `packages/mcp/src/verbs.ts` (`withFramework?: boolean`, `if (args.withFramework)`) | ⭐ rec, yes |
| Q44 | `shapeVersion` OR'd into `readDossier` staleness | **Independent `shapeVersion` staleness gate** in `readDossier` (`stale = hashStale ‖ schemaStale ‖ shapeStale`), separate from `schemaVersion` — so a pre-2.0 persisted dossier (`shapeVersion` undefined → treated as 1, ≠ `DOSSIER_SHAPE_VERSION`=2) is rebuilt on demand even when `schemaVersion` is still `1.3`. Without this, the `framework` section would be served fresh-and-incomplete forever. Confirmed in `packages/core/src/dossier/persist.ts` + `framework.ts` `DOSSIER_SHAPE_VERSION = 2` | ⭐ rec, yes |
| Q45 | Supply chain is one-hop (no round-trip) | **A dependency whose type is a @Bean-produced type surfaces `kind:'produces'` + `producer: <@Bean method brief>` in the SAME read** — built from one soul-wide `produces` scan into `producerOf` (producer id per dst). A consumer reads "LoanRepository is injected AND produced by LoanRepositoryConfig.loanRepository()" in one trip; multi-hop DI remains the `impact` verb's job. Confirmed in `framework.ts` (`pushDependency` sets `kind` from `producerOf`, attaches `producer`) | ⭐ rec, yes |
| Q46 | Unresolved honesty for `meta.injects`/`meta.produces` | **Type NAMES with no emitted edge become explicit gap entries** (`unresolved:true`, `id:'?'`, `qualifiedName:<type>`), appended via `appendUnresolvedInjects`/`appendUnresolvedProduces` — parity with the `gaps` verb's unresolved call-sites. A @Configuration declaring a bean the resolver hasn't linked, or a service injecting an unlinked type, yields a visible `⚠ unresolved` entry, not silence. Confirmed in `framework.ts` | ⭐ rec, yes |
| Q47 | `cardinality` = the JPA annotation NAME | **`edge.meta.cardinality` stores the multiplicity as the verbatim annotation NAME** (`ManyToOne`/`OneToMany`/`ManyToMany`/`OneToOne`), NOT a separate enum/normalized code — the `references` edge meta also carries `cascade`/`fetch`/`mappedBy`/`orphanRemoval` verbatim (whitespace preserved). The dossier `DossierRelation.cardinality` is a plain string read straight from `edge.meta.cardinality`. Confirmed in `framework.ts` (`DossierRelation.cardinality?: string`, populated from `m.cardinality`) | ⭐ rec, yes |

## Key Divergences
- **Q1 / Q2 / Q31:** rejected "GitNexus as base" and "vendor graphify" → **greenfield all-new code**, neither as base, nothing copy-pasted. (More work; chosen for clean IP + true unification + open-source freedom.)
- **Q9:** rejected "LadybugDB-only canonical" → **dual store** (fast index + portable committable soul). Enables the cross-IDE / SeeroFlow vision.
- **Q26:** rejected "PolyForm + commercial" → **fully open-source** (Apache-2.0 rec). Dissolves the GitNexus license/authorship risk.
- **Q3 / Q6 / Q8:** sharpened toward "portable project soul + faster understanding + token-cut"; pains = rework + token cost.

## Clarifications (status)
- **C1 GitNexus authorship / PolyForm** — **De-risked.** Greenfield ⇒ we don't reuse GitNexus source, so PolyForm doesn't bind us. Study its architecture freely; do not paste its code; credit as inspiration.
- **C2 Clustering algo** — pick one for the new build regardless (Leiden via a JS port, or Louvain); not blocked on the originals.
- **C3 Index store** — confirm LadybugDB is embeddable under OSS-compatible terms for a TS product; if not, swap the index (the soul format is store-agnostic).
- **C4 Target scale** — largest repo (files/LOC)? drives index store + soul-chunk sizing. *(still needed)*
- **C5 Deployment** — local per-dev MCP only, or hosted/team too? *(still needed)*
- **C6 Resourcing** — solo or team? *(still needed)*
- **C7 Brand/name** — **RESOLVED: "Knowledge-crib".**
- **C8 Commercial intent** — **OSS-only confirmed.**
- **Q36 runtime (TypeScript)** — confirm or override before scaffolding.
