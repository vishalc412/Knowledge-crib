# Knowledge-crib — Technical Pitch

**Audit basis:** source review, attached 360° plan, release gate run on 2026-07-13. Audience: principal engineers, AI architects, enterprise architects.

## Position

Knowledge-crib is a local-first **code-context platform for agents**. It turns a repository into a versioned, queryable *soul*: deterministic code and documentation graph, committed with code, then served through MCP, CLI, and offline visualization.

Pitch this outcome:

> Agents stop reconstructing architecture from files every session. They retrieve bounded, provenance-tagged context, impact paths, rule logic, ownership, and—when enabled—validated semantic analysis.

This is not generic RAG, IDE autocomplete, or enterprise search. It is durable machine context for software systems.

## How it works

```text
Repository + docs
  → structure map + language extractors
  → cross-file resolution + CFG / SQL / framework passes
  → doc-to-code links + clusters + ownership
  → committed JSONL Soul (.crib/ node and edge shards)
  → rebuildable SQLite FTS5 + adjacency index (.crib/index)
  → bounded MCP tools / CLI / local graph UI
```

Two stores enforce clear trust boundaries:

| Store | Role | Properties |
|---|---|---|
| **SoulStore** | Source of truth | Sharded JSONL, stable IDs and BLAKE3 hashes, schema validation, atomic writes, git-diffable, portable. |
| **IndexStore** | Query acceleration | Derived SQLite FTS5, graph adjacency, source-body projection. Rebuildable; never source of truth. |

Each graph edge carries relation, derivation method, provenance (`EXTRACTED` or `INFERRED`), confidence, and optional evidence. Consumers can request `EXTRACTED`-only views. This turns uncertainty into selectable data, not hidden model behavior.

## Technical depth

- **Parsing:** TypeScript/JavaScript, Python, PL/SQL, Java, C#, Go, Rust, PHP, and Markdown. Cross-file resolvers currently cover TypeScript, Python, PL/SQL, Java, C#, Go, and Rust.
- **Ontology:** schema 1.5 defines 20 node kinds and 21 relations. Beyond symbols/calls/imports: SQL tables and statements, conditions, exceptions, routes, fields, components, owners, and outbound HTTP calls.
- **Behavior layer:** PL/SQL control-flow extraction attaches guard chains, branch, loop, and exception context to calls and SQL actions. Rule extraction materializes decision tables and Mermaid flows. This supports legacy-rule discovery and migration analysis, not only navigation.
- **Framework layer:** Java/Spring emits routes, DI edges, JPA relations, produced beans, and framework roles. Architectural intent becomes graph data.
- **Incremental correctness:** update starts from git delta, re-extracts changed files plus reverse dependencies, then keeps unchanged shards byte-stable. A process lock protects writers.
- **Enterprise context:** ownership derives symbol-to-author edges from `git blame`; federation joins independent repository souls at runtime through HTTP-call ↔ route matching. Cross-repo links are computed, not persisted, so each repository stays independently reproducible.

## Agent and LLM design

Knowledge-crib exposes 23 MCP tools: discovery, query, context, source, impact, dossiers, rules, gaps, ownership, federation, change detection, observability, and enrichment workflows.

Responses have hard limits and response-wide token budgets. `ifHash` lets agents skip unchanged bodies. Result: agents retrieve evidence in small slices instead of repeatedly loading whole files.

LLM enrichment is deliberately separate:

1. Deterministic soul creates grounded work items at symbol, file, cluster, and system layers.
2. Host agent/model writes analysis and semantic graph; MCP server never selects or calls a model.
3. `enrich_save` checks evidence quotes against rehydrated source spans, drops failed evidence, rejects a fully ungrounded quoted submission, scans model-authored strings for secrets, then persists artifacts under `.crib/llm`.
4. `audit_llm` rechecks saved artifacts after refactors.

Important precision: quote overlap proves source anchoring, not truth of every interpretive LLM statement. Present it as **grounded semantic enrichment**, not formal semantic verification.

## Why it matters

| Enterprise need | Knowledge-crib response |
|---|---|
| Safe agent coding | Bounded context, impact traversal, provenance, `EXTRACTED`-only trust mode. |
| Legacy modernization | SQL data flow, CFG guard chains, decision tables, dossiers, reconstruction paths. |
| Faster onboarding | Functional map, clusters, docs linked to symbols, ownership queries. |
| Cross-service change analysis | Federated blast-radius traversal through client-call and server-route contracts. |
| Governance | Git-reviewable soul, source references instead of copied code, local-first deterministic core, LLM secret scan and redacted export. |
| Cost control | Lean-by-default responses, hash-based no-change replies, measurable budget and cost gates. |

## Market position — accurate comparison

Do not claim “no competitor.” Market contains strong specialist products. Better claim: **Knowledge-crib combines versioned deterministic code knowledge, agent-native delivery, and opt-in grounded semantics in one local developer workflow.**

| Product category | Strength | Knowledge-crib distinction |
|---|---|---|
| Microsoft GraphRAG | LLM-extracted knowledge graph over unstructured text; uses models, embeddings, and Parquet/vector outputs. | Code-aware deterministic extraction first; source-controlled JSONL soul; model layer optional and separately grounded. |
| Sourcegraph / SCIP | Compiler/indexer-driven precise navigation; repository indices upload into Sourcegraph. | Adds portable graph artifacts, doc-to-code links, behavior/rule layer, MCP tools, and reviewable provenance. Not substitute for compiler-accurate language intelligence. |
| Joern | Deep code property graph, taint analysis, security-focused traversals over custom graph storage and Scala DSL. | Targets agent context and modernization workflows with committed souls and MCP. Not substitute for Joern security analysis. |
| Aider repo map | Token-budgeted map of important symbols sent with coding requests. | Persists richer graph memory across sessions; supports impact, provenance, dossiers, ownership, and federation rather than prompt-only map context. |
| Enterprise search (Glean) | Broad SaaS connectors, permissions, content/people/activity graph. | Starts inside repository and Git workflow; no claim of replacing enterprise search, connectors, centralized RBAC, or SaaS operations. |

Market evidence: [GraphRAG indexing](https://microsoft.github.io/graphrag/index/overview/), [Sourcegraph precise navigation](https://sourcegraph.com/docs/code-navigation/precise-code-navigation), [Joern overview](https://docs.joern.io/), [Aider repository map](https://aider.chat/docs/repomap.html), [Glean enterprise knowledge graph](https://docs.glean.com/security/knowledge-graph). “Glean” also names Meta’s source-code fact database; keep that distinct from Glean enterprise search: [Meta Glean](https://glean.software/docs/introduction/).

## Proof observed in this audit

- `corepack pnpm@9.15.0 release:verify` completed successfully on 2026-07-13.
- 1,014 TypeScript Vitest cases passed across schema, core, parsers, pipeline, MCP, UI, and CLI; release gate also runs Python worker, package, budget, evaluation, installer, security-related, federation, and smoke checks.
- Tests cover lock behavior, malformed/oversized MCP inputs, source containment and Host-header checks for visualization, secret detection, evidence grounding, incremental update closure, parser fidelity, ownership, federation, and deterministic output.

## Current limits — say before architects ask

1. **Hybrid query retrieval not wired as default runtime path.** Core has tested char-n-gram vectors, reciprocal-rank fusion, and structural reranking. CLI runtime currently opens SQLite without an embedder and reports embeddings disabled. Treat hybrid retrieval as an implemented component awaiting product wiring, capability reporting, and end-to-end benchmark evidence.
2. **Scale proof pending.** SoulStore hydrates full graph in memory; vector retrieval scans derived vectors. M3 scale benchmarks and sharding/lazy-load decision remain necessary before large-enterprise claims.
3. **Access model inherits repository controls.** Stdio/local workflow is strong for local-first use. It is not yet centralized multi-tenant RBAC, audit retention, connector governance, or enterprise SSO.
4. **Language fidelity varies.** Extractors degrade safely and unresolved references are dropped rather than guessed. PHP currently lacks cross-file resolver depth. Claims must name tested languages and behavior layers.
5. **Documentation drift exists.** Some architecture text still describes vectors as unshipped, while core contains optional vector code; user-facing status must match actual CLI wiring. Rerun release gate on final commit before release.

## Recommended pitch close

Fund pilot for one legacy modernization or multi-service change-risk program. Measure: time-to-context, agent token use, impact-path correctness, unresolved-reference rate, and developer trust in provenance. Release only claims backed by reproducible evaluation pack, final release gate, and scale results.

**Category statement:** *Knowledge-crib is version-controlled, deterministic context infrastructure for software agents—deep enough for behavior and change analysis, lean enough for routine agent work, and explicit about what came from code versus inference.*

## Code anchors

- Contract and schema: `packages/soul-schema/src/types.ts`, `packages/soul-schema/src/enums.ts`
- Durable graph: `packages/core/src/soul-store.ts`, `packages/core/src/lock.ts`
- Index and retrieval: `packages/core/src/index/sqlite-index.ts`, `packages/core/src/index/rerank.ts`, `packages/cli/src/runtime.ts`
- Pipeline: `packages/pipeline/src/pipeline.ts`, `packages/pipeline/src/update.ts`, `packages/pipeline/src/resolve/`
- LLM trust controls: `packages/mcp/src/enrichment.ts`, `packages/mcp/src/grounding.ts`, `packages/mcp/src/secrets.ts`
- Agent surface: `packages/mcp/src/server.ts`, `packages/mcp/src/verbs.ts`
- Product verification: `scripts/release-verify.mjs`, `docs/knowledge-crib-production-readiness.md`
