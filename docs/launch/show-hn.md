<!-- Launch asset — Show HN post draft. Human-reviewed before posting (M4.6 gate). Tone: HN-technical, no marketing fluff, lead with differentiator + reproducible proof + honest limits. Grounded in technical-pitch.md; do not contradict the limits section. -->

# Show HN: Knowledge-crib — a git-committable code knowledge graph for AI agents (MCP)

**Title (HN):** `Show HN: Knowledge-crib — a git-committable code knowledge graph for AI agents` (78 chars)

**URL:** (the canonical GitHub home — pending M4.5 repo-identity decision; use `github.com/vishalc412/Knowledge-crib` until the org is chosen)

---

## Body

Hi HN. Knowledge-crib is a code-context layer for AI coding agents. It indexes a repository once into a deterministic, git-committable knowledge graph (a "project soul") and serves it over MCP — so an agent retrieves bounded, provenance-tagged context instead of re-reading files every session.

The thing I couldn't find anywhere else: **a code knowledge graph that is deterministic, committed with the code, carries per-edge provenance/confidence, has a behavior layer (control-flow + decision tables), is agent-native over MCP, federates across repos for blast-radius, and keeps LLM semantics as a grounded opt-in layer — in one local-first tool.** Each of those capabilities exists in some specialist tool; the intersection doesn't.

What's in the graph:
- 20 node kinds / 21 relations across TypeScript/JS, Python, PL/SQL, Java, C#, Go, Rust, PHP, Markdown.
- Beyond symbols/calls/imports: SQL tables + statements, conditions, exceptions, routes, fields, components, owners (git blame), outbound HTTP calls.
- A behavior layer: PL/SQL control-flow extraction attaches guard chains, branch/loop/exception context to calls; rule extraction materializes decision tables + Mermaid flows. This is the migration/legacy-analysis wedge — "what does this 1990s rule engine actually decide."
- Per-edge `EXTRACTED` vs `INFERRED` provenance + confidence + an evidence span. Consumers can request `EXTRACTED`-only and get byte-stable output forever.

Two stores, hard trust boundary:
- **Soul** = sharded JSONL, committed with code, git-diffable, portable, schema-validated, atomic writes, BLAKE3-hashed. This is the source of truth.
- **Index** = derived SQLite FTS5 + adjacency + source-body projection. Gitignored, rebuildable, never source of truth. Vectors live only here — the committed soul is deterministic forever.

Agent surface: 23 MCP verbs (query, context, source, impact, dossier, rules, gaps, ownership, federation, change-detection, observability, enrichment). Responses are token-budgeted response-wide; an `ifHash` lets agents skip unchanged bodies (a repeat call with a matching hash collapses to `{unchanged:true}` — ~10× size drop measured).

LLM enrichment is deliberately split from the deterministic core:
1. The deterministic soul creates grounded work items.
2. The host agent/model writes the analysis — the crib process **never calls a model**.
3. `enrich_save` rehydrates every claimed evidence span and requires quote overlap; ungrounded quoted submissions are rejected; model-authored strings are scanned for secrets.
4. `crib audit-llm` re-verifies saved artifacts after refactors.

I want to be precise about #3: quote overlap proves **source anchoring**, not truth of every interpretive statement. Call it grounded semantic enrichment, not formal verification.

Honest limits, before anyone asks:
- Hybrid retrieval (vectors + RRF + structural rerank) is an implemented + tested component, not the default CLI runtime path yet (CLI reports embeddings disabled pending product wiring).
- Scale: memory is sub-linear (~3 GB projected at 1M LOC) but index time is super-linear (N^1.8), so the documented answer for very large repos is per-module souls (ADR-002), not one giant soul.
- Access model inherits the repo's git ACL — no centralized multi-tenant RBAC/SSO. Local-first by design.
- Language fidelity varies; PHP lacks cross-file resolver depth. Unresolved refs are dropped, not guessed.
- npm publish + canonical GitHub home are pending (user-gated; the `npx knowledge-crib` form lands then).

Reproducible: `corepack pnpm@9.15.0 release:verify` is green (build + ~1000 tests + every gate incl. a parser fuzzer that found a real sync-hang bug, a retrieval eval harness with regression gates, a scale bench, a security/threat-model doc gate, and a docs drift gate). Self-indexed dogfood: the repo's own soul is committed and refreshed by a GitHub Action on every merge (the "never stale" differentiator — the action runs `crib update` and commits the refreshed soul with `[skip ci]`, and a gate pins that a no-op update is byte-idempotent so it doesn't spam git-log).

5-minute onboarding: `crib init` (index + hooks + MCP wiring in one command), `crib doctor` (6 health checks). The `npx` form lands with M4.1 publish.

The comparison matrix vs GraphRAG / SCIP / Joern / CodeQL / Aider / Glean is in `docs/launch/comparison.md` — every cell is ✓/~/✗ with a reason, and the "what this is NOT claiming" section is there because every column has a best-in-class owner; the moat is the intersection.

Happy to go deep on: the determinism contract (why vectors only live in gitignored derived state), the grounding validator (the moat — unverifiable LLM claims get rejected), the federation design (cross-repo edges computed at runtime, never persisted, so each repo stays independently reproducible), or the scale curve.

What would you build on top of a committed, queryable, behavior-aware graph of your repo?