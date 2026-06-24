# Knowledge-crib — PRD / Design Doc
### A greenfield, open-source, MCP-based "project soul" for AI coding agents
### (all-new code; inspired by GitNexus = deep analysis, Graphify = indexing — neither copied)

> Decisions referenced as [Qn] map to `knowledge-crib-decisions.md`.

---

## 1. One-liner
**A portable "project soul" for AI coding agents** [Q3] — a local-first knowledge graph that digs
deep like GitNexus and indexes broadly like Graphify, persisted as the project's **memory**:
cross-IDE, agent-agnostic, incrementally upgraded as the project evolves. Any agentic IDE (and
later **SeeroFlow** [Q38]) can read it to understand the whole project **fast**, with **full
context** and **far fewer tokens**. Delivered as **one fast MCP server** — not a skill. [Q22, Q31–Q33]

## 2. Problem & User
**Primary user** [Q5]: the AI-IDE power developer (Cursor / Claude Code daily driver) working on
a large or legacy codebase, who repeatedly watches the agent break things because it lacks
architectural awareness.

**Job-to-be-done** [Q6]: *"Understand any project faster, give my agent full project context, and
cut token cost."*

**Today** [Q8], the pain is **rework/breakage** (agent edits blindly) **and token cost** (agent
bulk-reads files to rebuild context every session). Two existing tools each prove half of the
answer — and serve as **design inspiration, not code to copy** [Q1, Q2]:
- **GitNexus** → how to dig **deep** (impact, call chains, type resolution).
- **Graphify** → how to **index** broadly and portably (any input → a queryable graph).

Knowledge-crib is a **greenfield, original implementation** of the union: deep code analysis +
broad indexing + a **portable memory** any agent can reuse across IDEs.

**Second wedge — deep extraction for migration [Q39]:** the same engine, pushed deep, extracts a
legacy system (e.g. a PL/SQL rule engine) *completely enough to rebuild it* on COBOL/Java/.NET —
call chains, data flow, and crucially the **guard conditions** (the rules). First-class, alongside
the agent-context wedge. See [deep-extraction](knowledge-crib-deep-extraction.md).

## 3. Positioning
| | Code-only context | Multimodal context |
|---|---|---|
| **Shallow** | grep / file paste | Graphify (alone) |
| **Deep** | GitNexus (alone) | **Knowledge-crib (this product)** |

Knowledge-crib is the only quadrant where an agent asks *"what breaks if I change `AuthService`?"* and gets
**both** the code blast-radius **and** the docs/specs describing it [Q16] — then keeps that answer
as durable project memory, so the next agent (or the next IDE, or a SeeroFlow run) doesn't
re-derive it. Querying the graph instead of re-reading files is the token-cut [Q25].

## 4. Build Strategy [Q1, Q2, Q31, Q36]
- **Greenfield, neither as base.** All-new codebase. Study both projects' architecture; **copy no
  code.** Graphify is the model for *indexing/breadth*, GitNexus the model for *deep analysis*.
- **IP hygiene (clear):** reading the MIT Graphify source is fine; **do not paste GitNexus's
  PolyForm-Noncommercial source** — reimplement its ideas originally. Architecture/ideas aren't
  copyrightable; source expression is. Credit both as inspiration.
- **Runtime:** **TypeScript / Node** [Q36] — strongest MCP SDK, `npx` one-command cross-IDE
  distribution, tree-sitter WASM for deep parsing, embeddable index store. *(Confirm before
  scaffolding; Python if ML-first, Rust if perf is the overriding constraint.)*
- **Sequencing:** prove the wedge end-to-end on one narrow flow first [Q4]; multimodal deferred [Q32].

## 5. Architecture

```
                 ┌──────────────────────────────────────────────┐
   INPUTS        │              INGESTION PIPELINE [Q13]         │
   ───────       │   one pipeline, pluggable extractors          │
   code  ───────▶│   ┌──────────┐ ┌──────────┐ ┌──────────┐      │
   md/pdf ──────▶│   │  code-   │ │  doc-    │ │ media-   │ (v2) │
   media (v2) ──▶│   │ extractor│ │ extractor│ │ extractor│      │
   workspace(v2)─│   └────┬─────┘ └────┬─────┘ └────┬─────┘      │
                 │        └────────────┼────────────┘            │
                 │              CROSS-MODAL LINKER [Q16]          │
                 │        (doc/spec mention ↔ code symbol)        │
                 └───────────────────────┬──────────────────────-┘
                                          ▼
                 ┌──────────────────────────────────────────────┐
                 │      STORAGE LAYER — DUAL ROLE [Q9]            │
                 │  ┌────────────────────────────────────────┐   │
                 │  │ SOUL (source of truth, portable):       │   │
                 │  │  chunked graph.json on filesystem,      │   │
                 │  │  git-committable, cross-IDE, agnostic   │   │
                 │  └────────────────────────────────────────┘   │
                 │  ┌────────────────────────────────────────┐   │
                 │  │ INDEX (fast, derived, rebuildable):     │   │
                 │  │  LadybugDB (swappable) + vector/BM25     │   │
                 │  └────────────────────────────────────────┘   │
                 │  one ontology [Q10]: symbol|file|doc-section| │
                 │   media-seg|explanation ; edges calls|imports| │
                 │   inherits|describes|references|derived-from   │
                 │   each edge {method,provenance,confidence}     │
                 │   (EXTRACTED vs INFERRED; static>inferred)[Q35]│
                 └───────────────────────┬──────────────────────-┘
                                          ▼
        ┌─────────────────────┬───────────────────────┬─────────────────┐
        │  INTELLIGENCE [Q19]  │     MCP SERVER [Q20]   │   VIZ [Q21]      │
        │  deterministic core: │  canonical verbs:      │  WASM web UI     │
        │  parse/graph/impact/ │  impact · context ·    │  Mermaid export  │
        │  cypher/search       │  query · cypher ·      │  GRAPH_REPORT.md │
        │  ── opt-in LLM ──    │  detect_changes ·      │  wiki gen        │
        │  enrichment only:    │  rename · route_map ·  │                  │
        │  cluster names,      │  group_* · +shortest_  │  (MCP-first      │
        │  wiki, NL→query [Q17] │  path                  │   priority [Q22])│
        └─────────────────────┴───────────────────────┴─────────────────┘
```

**Store** [Q9–Q11]: **dual role.** The **soul** — chunked `graph.json` on the filesystem — is the
portable, git-committable source of truth: the project's memory, readable cross-IDE and by
SeeroFlow without running the engine, incrementally upgraded as the project changes. The **index**
— LadybugDB (or any efficient embedded store; swappable) with vector + BM25 — is a fast, derived
view, fully rebuildable from the soul. Small projects can run soul-only; scale adds the index.
Scale-first, with portability a first-class second [Q11].

**Ontology** [Q10]: one schema spanning code + non-code so cross-modal queries are first-class.

**Pipeline** [Q13–Q15]: single pipeline, pluggable extractors (community can add languages/formats
— graphify's stated growth path). Code depth is non-negotiable; breadth bolts on. MVP = code + MD
+ PDF; media/Workspace deferred [Q15, Q24].

**Intelligence** [Q17–Q19]: deterministic core never needs the network (parse, graph, impact,
search stay fast/free/offline). LLM is opt-in enrichment only — cluster naming, NL→query,
summaries — and **defaults to the host IDE's own model via MCP `sampling`** (no bundled provider,
no API key, works on any sampling-capable IDE). Fallback chain: sampling → local Ollama →
configured cloud key → skip. Never on the query hot path [Q18].

**Interfaces** [Q20–Q22]: MCP-first (agent is the primary consumer). GitNexus verb set is
canonical; graphify verbs map on (`query_graph`→`query`, `get_node`→`context`, add `shortest_path`,
keep `list_prs`). WASM UI is the interactive viz; Mermaid + report + static HTML are cheap exports.

## 6. MVP Scope [Q23]
The smallest slice that validates the wedge, in the new TS codebase:
1. **`doc-extractor`** for Markdown + PDF → doc-section nodes in the unified store.
2. **Cross-modal linker** → edges from doc-section ↔ code symbol.
3. **Extend `impact` and `context` MCP verbs** to surface linked docs alongside code.
4. **One narrow demo flow:** agent asks *"impact of changing X"* → receives code blast-radius **+**
   the spec sections describing X, in a single response.

**Out of scope for MVP** [Q24]: media ingestion (whisper/video/YouTube), Google Workspace, full
graph.json→LadybugDB store-swap for graphify users, multi-repo multimodal groups, cloud SaaS.

## 7. Success Metrics [Q25]
- **Primary (activation):** % of indexed repos where the agent invokes a doc-link verb within
  week 1.
- **Efficiency (headline):** tokens consumed per agent task vs. a raw-file-reading baseline —
  Graphify's core selling point. The merge must match or beat it *while* adding doc context.
- **Guardrails (must not regress):** index time and p99 query latency vs current GitNexus.
- **30 / 90 / 180 days:** activation → retained weekly-active → self-reported reduction in
  architecture-breakage incidents.
- **Failure looks like:** agents/users ignore the doc links and fall back to code-only context.

## 8. License & Open Source [Q26, Q37]
**Fully open-source, all-new code** under a permissive OSI license — recommend **Apache-2.0** (adds
an explicit patent grant over MIT). Because no GitNexus source is reused, **PolyForm Noncommercial
does not bind this project** and the authorship/commercial-rights question is moot for the code we
ship. No commercial tier for now [C8]. Confirm the chosen **index store** (LadybugDB or alternative)
is embeddable under an OSS-compatible license; the soul format is store-agnostic, so the index is
swappable if not.

## 9. User Research Plan [Q27–Q30]
**Riskiest assumption to validate first:** developers actually *want* — and will *trust* —
doc/spec context fused into code impact, rather than just wanting better code-only context.

**Method:** 5–8 user interviews + a moderated usability test of the MVP flow (1–2 weeks).
**Recruit:** both existing user bases (GitNexus + graphify) + 2–3 cold AI-IDE devs on large
codebases, to expose onboarding/positioning gaps.

**Guide (Deep-dive questions):**
1. Last time the agent broke something — what context was missing: code, docs, or both?
2. Do you trust auto-linked doc↔code mappings? When would a wrong link mislead you?
3. Would persistent multimodal memory change how much you delegate to the agent?

**Synthesis:** affinity-map findings → impact/effort matrix → feed into MVP iteration.

## 10. Risks & Assumptions
| Risk | Mitigation |
|------|------------|
| License/IP | **Resolved — greenfield + Apache-2.0.** Copy no code; PolyForm doesn't bind; MIT graphify readable |
| Greenfield effort > merge effort | Accepted for clean IP + true unification; narrow MVP first [Q4] caps risk |
| Soul ↔ index drift | Index is always rebuildable from the soul (single-writer pipeline; soul is source of truth) |
| Cross-modal links are noisy / mistrusted | Validate in research [Q27]; show provenance + confidence on every link |
| Merge cost balloons before value proven | Narrow prototype first [Q4]; full unification gated on validation |
| Local LLM quality too low for enrichment | Enrichment is opt-in; deterministic core stands alone [Q19] |
| Index-store licensing surprise | Soul is store-agnostic; swap the index if LadybugDB isn't OSS-embeddable |

## 11. Open Questions / Confirmations
- **Q36 runtime = TypeScript** — confirm before scaffolding (Python if ML-first; Rust if perf-first).
- **C4 scale** — largest repo (files/LOC) to support? drives index store + soul-chunk sizing.
- **C5 deployment** — local per-dev MCP only, or hosted/team server too?
- **C3 index store** — LadybugDB embeddable under OSS terms? else pick an alternative.
- **C7 brand** — **resolved: "Knowledge-crib".**

## 12. Future: SeeroFlow Integration [Q38]
Knowledge-crib's portable soul is the natural context source for **SeeroFlow** (your flow product). Seam:
expose project memory via (a) the MCP verbs and (b) the committed `graph.json` soul, so a SeeroFlow
run loads full project context — impact, call graph, doc links — without re-indexing. Define the
read contract now (stable node/edge schema + soul file layout); build the connector after MVP.
