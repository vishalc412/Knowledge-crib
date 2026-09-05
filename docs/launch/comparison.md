<!-- Launch asset — Show HN / comparison page source. Human-reviewed before posting (M4.6 gate: "assets reviewed and ready"). Grounded in docs/knowledge-crib-technical-pitch.md (do not contradict its honest limits section). -->

# Knowledge-crib vs the field — the capability matrix

**One-line claim:** Knowledge-crib is the only tool that combines a **deterministic, git-committable** code knowledge graph with **per-edge provenance/confidence**, a **behavior layer** (CFG / decision tables), **agent-native MCP delivery**, **federated blast-radius**, and **grounded opt-in LLM semantics** — in one local-first workflow.

The matrix below makes that claim checkable. Every cell is ✓ / ~ (partial) / ✗ with a one-line reason. **No column is unique to Knowledge-crib in isolation** — each capability exists in some specialist tool. The moat is the **intersection**: the full column-set in one committed, reviewable artifact.

## The 7-column matrix

| Tool | 1. Deterministic + git-committable | 2. Per-edge provenance + confidence | 3. Behavior depth (CFG / rules / decision tables) | 4. Agent-native (MCP tools) | 5. Federated cross-repo blast-radius | 6. Grounded opt-in LLM layer | 7. Local-first / portable (no server upload) |
|---|---|---|---|---|---|---|---|
| **Knowledge-crib** | ✓ JSONL soul committed with code; `--extracted-only` byte-stable; no-op update is byte-idempotent | ✓ every edge carries `EXTRACTED`/`INFERRED` + confidence + evidence span; `audit-llm` re-verifies | ✓ PL/SQL CFG guard chains, condition/exception nodes, decision tables, Mermaid flows | ✓ 16 MCP verbs over stdio; token-budgeted responses; `ifHash` skip-unchanged | ✓ runtime federation via http-call↔route bridge; cross-repo edges computed, not persisted | ✓ host agent authors analysis; `enrich_save` requires quote-overlap grounding + secret scan | ✓ stdio-only server; deterministic core offline; soul = repo files (inherits git ACL) |
| Microsoft GraphRAG | ✗ LLM-extracted; non-deterministic across runs; Parquet/vector outputs, not git-diffable | ~ model-derived edges, no source-span provenance discipline | ✗ graph over unstructured text, no code CFG/rule layer | ✗ library/indexing pipeline, not an agent tool surface | ✗ single-corpus graph | ✓ (its whole point) but ungrounded-by-default | ✗ cloud + model-dependent |
| Sourcegraph / SCIP | ~ precise compiler indices, but uploaded to a server; not a committed portable artifact | ~ precise but no confidence/provenance taxonomy on edges | ✗ navigation + references, no CFG/decision-table behavior layer | ~ has an API, not MCP-native agent verbs | ~ code navigation across repos, not change-impact traversal | ✗ no LLM semantic layer | ✗ server-hosted index |
| Joern | ~ deep code property graph, but custom graph store, not git-committable JSONL | ~ CPG edges precise but no EXTRACTED/INFERRED confidence split | ✓ taint/data-flow — strong, security-focused | ✗ Scala DSL + query shell, not agent-native MCP | ✗ single-codebase | ✗ no LLM layer | ~ self-hostable but heavy |
| CodeQL (GitHub) | ✗ query-language over extracted DB; DB is derived, not committed-with-code | ~ precise queries, no per-edge provenance/confidence artifact | ✓ data-flow/taint + path queries — strong | ✗ CLI/query lang, not MCP verbs | ~ packs across repos, query-time not graph-federation | ✗ no LLM layer | ✗ DB build + upload to GitHub |
| Aider repo-map | ~ token-budgeted symbol map, but prompt-only, not persisted graph memory | ✗ no edge provenance | ✗ map of important symbols, no behavior layer | ~ sent inline to coding LLM, not a tool surface | ✗ single-repo map | ✗ no separate LLM layer (it IS the LLM client) | ✓ local |
| Glean (enterprise search) | ✗ SaaS graph over connectors, not git-committable | ~ activity/content graph, no code-edge provenance | ✗ no code CFG/rule layer | ~ has APIs, not MCP code verbs | ~ enterprise cross-app, not code blast-radius | ~ assistant features, not grounded code semantics | ✗ SaaS |

**Reading the matrix:** Knowledge-crib is the only row with ✓ across columns 1–5 simultaneously, plus a grounded (not default) LLM layer (6) and local-first portability (7). Each competitor owns one or two columns decisively — Joern/CodeQL own behavior depth for security; GraphRAG owns LLM-first semantics; Sourcegraph owns compiler-precise navigation. None ships the intersection.

## The memory matrix — vs Mem0, Graphiti/Zep, Letta

The matrix above covers the **code-graph** half. Knowledge-crib also ships an agent-memory ledger,
and that is a different field with different incumbents.

**How to read the cells.** The Knowledge-crib column is **measured** — every number traces to the
frozen launch gate (`docs/bench/launch-gates.md`) or the model ladder
(`docs/bench/embed-model-ladder.md`), both reproducible from this repo. The competitor columns are
**capability claims read from their public documentation**, not benchmarks run here. No number in a
competitor column is a measurement of ours, and none should be quoted as one. Re-verify against
current vendor docs before publishing this table anywhere.

| | **Knowledge-crib** | Mem0 | Graphiti / Zep | Letta |
|---|---|---|---|---|
| **Claims re-verified against ground truth** | **✓ — the differentiator.** Evidence anchors to a code span (`soulId` + `quote` + `targetHash`); the quote must be a normalised substring of the rehydrated span and the hash must match the live node. Code moves → `degraded`. Anchor vanishes → stable-locator reattachment: one match reattaches, zero → `orphaned`, many → `needs-review`. **100% staleness precision, 12/12 transitions.** | ✗ conversation-derived; a fact that stopped being true stays confidently true | ✗ episodes + invalidation over text, no external ground truth to check against | ✗ |
| **Bi-temporal validity** | ✓ `validTime` vs `transactionTime` — answers "what did we believe, and when" without destroying history | ~ recency/temporal signals | ✓ its defining capability | ~ |
| **Lineage + explicit contradiction** | ✓ `supersedes` / `contradicts` / `derivedFrom`; conflict keys on `propositionKey`, so complementary facts about one symbol are not falsely collided | ~ explicit updates and deletions | ✓ | ~ |
| **Runs with no network and no API key** | ✓ local-first; the semantic tier is an on-device model, and there is no query-time network call in any tier | ✗ hosted platform / API key for the managed path | ~ self-hostable, model-dependent | ✓ Git-backed MemFS |
| **Semantic recall out of the box** | ✗ **6/8, 2.6% paraphrase recall until `crib embed setup` runs** — the one place crib is behind | ✓ works from first call | ~ | ✗ semantic search not enabled by default |
| **Semantic recall once configured** | ✓ **8/8, 81.0% word-disjoint paraphrase recall @5, MRR 88.1%** — one command, measured, reproducible | (not measured here) | (not measured here) | (not measured here) |
| **Agent- and IDE-neutral** | ✓ one ledger across Claude Code, Cursor, Copilot, VS Code, Codex, Windsurf, Gemini; agent/session ids are provenance, never an access boundary | ~ SDK-centric | ~ | ~ |
| **Deletion that actually deletes** | ✓ logical tombstones **plus** a documented physical purge; private memory never enters Git, because git history cannot provide irreversible deletion | ~ explicit delete API | ~ | ~ |
| **Cost per recall** | ✓ zero marginal — no per-query model call; vectors are content-addressed and cached, so an unchanged record is embedded once ever | ~ per-call pricing on the managed path | ~ | ~ |
| **Untrusted content kept out of recall** | ✓ measured **zero** — captured claims stay `candidate`-trust and `isRecallEligible` excludes them until evidence and policy gates promote them | ~ | ~ | ~ |

### The honest read

**Crib wins on verifiability, deletion, local-first operation, agent neutrality, and marginal cost.
It loses the first five minutes.** A fresh install answers paraphrases at 2.6% until someone runs
one command; Mem0 answers them from the first call. That row is stated in the matrix rather than
omitted, because it is the row a buyer will hit first.

What changed: installing the tier used to be three commands, the last of which named a directory
(`examples/embedders/minilm-e5`) **that does not exist in the published package** — so for an npm
install the documented path was unfollowable. It is now `crib embed setup --yes`, which generates
and pins the adapter itself and proves it ranks before reporting success. The generated adapter
reproduces the published 81.0% to every digit.

What has **not** changed: crib still ships no model and still makes no network call on its own
(`MAX_RUNTIME_DEPS = 9`, `MAX_PACKAGE_BYTES = 5 MB`, enforced by `pnpm budget:check`). The default
model is a 2.2 GB download because the ladder shows it is the only one that passes the gate — the
87 MB option scores 66.0%, which is 25× the fallback but 14 points short.

## What this matrix is NOT claiming

- **Not "no competitor."** Each column has a best-in-class owner. The claim is the **intersection is unoccupied**.
- **Not "better than Joern/CodeQL at security analysis."** They are deeper on taint/path queries. Knowledge-crib targets agent context + migration, not security analysis.
- **Not "better than Sourcegraph at compiler-precise navigation."** SCIP is compiler-accurate; Knowledge-crib's extractors degrade safely and drop unresolved refs rather than guess.
- **Not "better than GraphRAG at unstructured-text KG."** GraphRAG is LLM-first over text; Knowledge-crib is code-first with semantics as an opt-in, separately-grounded layer.
- **Not a head-to-head benchmark against Mem0, Graphiti or Letta.** The memory matrix compares *capabilities* — crib's cells measured here, theirs read from their public docs. Running their systems on this corpus is a separate piece of work (`scripts/launch-vendor-compare.mjs` is the harness); until it runs, no relative quality number should be published.
- **Not "semantic out of the box."** A fresh crib install is 6/8 and 2.6% paraphrase recall. The 8/8 describes a configured deployment. `crib doctor` reports which tier is live and every response names its scorer on `provenance.scorerVersion`, so the difference is visible in crib's own output rather than only in a footnote.

## The honest limits (say before an architect asks)

1. **Hybrid retrieval is a component, not the default runtime path.** Core has tested vectors, RRF, structural rerank; CLI runtime reports embeddings disabled pending product wiring.
2. **Scale proof is bounded.** Memory is sub-linear (~3 GB projected at 1M LOC) but index time is super-linear (N^1.8) → per-module souls are the documented answer (ADR-002), not a single 1M-LOC soul.
3. **Access model inherits repo/git ACL.** No centralized multi-tenant RBAC/SSO/audit retention — local-first by design.
4. **Language fidelity varies.** PHP lacks cross-file resolver depth; unresolved refs are dropped, not guessed.
5. **Repo identity + npm publish are pending** (M4.1/M4.5 — user-gated).

## Sources

Grounded in [`docs/knowledge-crib-technical-pitch.md`](../knowledge-crib-technical-pitch.md) (audit-reviewed 2026-07-13) + `release:verify` green. Market evidence: [GraphRAG](https://microsoft.github.io/graphrag/index/overview/), [Sourcegraph precise nav](https://sourcegraph.com/docs/code-navigation/precise-code-navigation), [Joern](https://docs.joern.io/), [CodeQL](https://codeql.github.com/), [Aider repo map](https://aider.chat/docs/repomap.html), [Glean enterprise KG](https://docs.glean.com/security/knowledge-graph). ("Glean" also names Meta's source-code fact DB — distinct from Glean enterprise search: [Meta Glean](https://glean.software/docs/introduction/).)