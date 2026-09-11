# Knowledge Crib: real-world feasibility against agent-memory and code-context tools

**Research date:** 11 September 2026
**Crib anchor:** `86040a2c` on `debug/auditMaster` (includes `3ab2a899` "admit grounded writes and map memory into the graph").
**Method:** Competitor facts come only from primary sources: official docs, upstream READMEs and source, vendor papers and blogs, first-party benchmark repositories, and GitHub API metadata queried on this date. No competitor tool was installed, run or used for repository context. Crib facts come from reading this repository's code and its dated evidence documents. **No head-to-head benchmark was run.** Every competitor benchmark quoted below was run by the vendor itself unless stated otherwise.
**Supersedes for positioning purposes:** [2026-09-05 competitor research](../2026-09-05/competitor-research.md), [2026-09-05 re-audit research](../2026-09-05/reaudit-competitor-research.md), and the competitor sections of [comparison.md](../../launch/comparison.md). Those remain the historical record. See §5.

**How to read cells:** `unverified` means no primary source was found for that cell. `—` means the tool does not target that capability according to its own documentation. It is not a ✗ we tested. Link keys like [mem0-add] resolve in §6.

---

## 1. Executive verdict

- **Ahead: memory re-validated against live code.** A crib memory carries a quote pinned to a code span and a content hash. When the code moves, the freshness evaluator marks the memory degraded, orphaned or needs-review. It is the only tool in this set that documents invalidating memory because *code* changed.
  - Mem0's current extractor is ADD-only and keeps old and new facts side by side [mem0-algo].
  - Graphiti invalidates facts when *new episodes* contradict them, not when source changes [graphiti].
  - Letta and claude-mem document no staleness check against code [letta-memory][claude-mem-arch].
- **Ahead: no model or API key on the core path, under a permissive license.** Memory recall and the code graph make zero LLM calls. Mem0, Graphiti, Cognee (memory path), claude-mem and Letta all default to a hosted LLM for writes [mem0-oss][graphiti][cognee][claude-mem][letta-code]. GitNexus is also local, but it is PolyForm **Noncommercial** [gitnexus-license]. Crib is Apache-2.0.
- **Narrower than claimed: code graph plus memory in one server.** Crib projects pending and admitted memories into `context`/`impact`/`neighbors` (`3ab2a899`). Cognee now ships a deterministic, LLM-free code graph with an `impact_analysis` operation next to its memory graph [cognee-code]. The "only tool with the intersection" line in [comparison.md](../../launch/comparison.md) is no longer safe.
- **At parity: MCP code verbs.** GitNexus exposes `query`/`context`/`impact`/`detect_changes`/`rename`, a token cap (`maxTokens`), PDG/taint `explain`, cross-repo groups, and a `/gitnexus-review` skill [gitnexus]. Crib's verb set is comparable, not superior. Token-budgeted responses are no longer a differentiator.
- **At parity: Git-backed, inspectable memory.** Letta's MemFS tracks all agent context in git and can sync it to a GitHub repository [letta-code].
- **Behind (largest gap): automatic capture.** Mem0's Claude Code plugin, claude-mem, OpenMemory and Letta's dreaming all capture and consolidate with no user action [mem0-cc][claude-mem-arch][openmemory][letta-memory]. Crib writes only when the agent calls `memory_observe` with exact code quotes. Decisions and conventions always need a human at the terminal ([auto-admit.ts:196](../../../packages/memory/src/auto-admit.ts)).
- **Behind: distribution.** Crib is not on npm (`npm view knowledge-crib` returns 404 today). Install is clone + corepack + a default ~2.1 GB model download ([README.md](../../../README.md)). Every competitor installs with one registry command.
- **Behind: client breadth.** Lifecycle hooks exist for Claude Code only. The other six clients get instruction files ([adapters.ts:256-376](../../../packages/cli/src/adapters.ts)). The generated certification table lists **zero** runtime-certified clients ([capability-matrix.md](../../capability-matrix.md)). GitNexus wires hooks for Claude Code, Codex, Cursor and Antigravity [gitnexus]. Mem0 ships plugins for roughly ten agents [mem0-integrations].
- **Behind: language coverage and published evidence.**
  - Crib parses 11 languages (no Kotlin, Swift, Ruby, C, C++, Dart). GitNexus parses 16 [gitnexus]. Serena covers 40+ through LSP [serena].
  - Crib's retrieval numbers come from its own synthetic corpus. There is no LoCoMo/LongMemEval/BEAM run, and no labelled code-edge accuracy.
- **Adoption signal.** Crib has 12 GitHub stars and an unreleased 0.1.0. Comparators range from 29k to 94k stars with daily-to-weekly releases (§2.3). The realistic near-term position is a niche: **code-grounded, verifiable project memory for teams that cannot send code or conversations to a hosted LLM.** It cannot win a broad "agent memory" contest on automation or reach today.

---

## 2. Comparison matrix

Tools chosen beyond the required set:

- **Serena:** LSP-backed MCP code tools, 29k stars, MIT, active releases [serena]. Functionally the closest widely adopted MCP code-context server that is not a graph index.
- **Aider repo-map:** the widely copied tree-sitter plus graph-ranking context baseline [aider-blog]. Included as a baseline even though Aider's releases have slowed (last release v0.86.0, 2025-08-09 [aider-api]).
- **Not selected:**
  - Sourcegraph Cody: the public `sourcegraph/cody` repository returns 404 through the GitHub API today, and Amp is closed source.
  - Greptile: a hosted PR-review SaaS, not a self-hostable context layer. Neither could be characterised from primary open sources.

### 2.1 Memory systems: dimensions 1, 2, 3, 5, 10

| Dimension | **Knowledge Crib** | **Mem0 / OpenMemory** | **Zep / Graphiti** | **Letta (Letta Code)** | **claude-mem** | **Cognee** |
|---|---|---|---|---|---|---|
| **1a. Who decides what is stored** | The agent calls `memory_observe`. Crib re-grounds each cited quote and auto-admits to *local* trust only if the evaluator can vouch for it. `decision`/`convention` are always held for a human (`crib memory remember`). A claim with no code evidence stays pending ([auto-admit.ts:194-235](../../../packages/memory/src/auto-admit.ts), [api.ts:1837-1857](../../../packages/memory/src/api.ts)). | LLM extractor (`infer=True` default); `infer=False` stores verbatim [mem0-add]. | LLM extraction from ingested episodes [graphiti][graphiti-episodes]. | The agent self-edits MemFS. Background "dreaming" subagents consolidate lessons, with an optional second-agent review [letta-memory]. | A worker compresses captured tool executions with the Claude Agent SDK, Gemini or OpenRouter [claude-mem-arch]. | LLM entity/relationship extraction via `remember` (add + cognify + improve) [cognee]. |
| **1b. Automatic capture from sessions** | No transcript capture, by policy. A Claude Code Stop hook *asks* the agent to call `memory_observe`, once per session per HEAD ([stop-nudge.ts](../../../packages/cli/src/stop-nudge.ts)). `memory{op:'capture'}` stages loose candidates that never enter normal recall ([verbs.ts:3551-3575](../../../packages/mcp/src/verbs.ts)). | Yes. The Claude Code plugin captures prompts, answers, changed files and test/build results locally, then flushes every 5 exchanges, at session end/compaction or after 5 min idle [mem0-cc]. OpenMemory "auto-captures your coding preferences" [openmemory]. | — (application pushes episodes) [graphiti]. | Yes. Dreaming triggers after N steps or on compaction [letta-memory]. | Yes. SessionStart, UserPromptSubmit, PreToolUse(Read), PostToolUse and Stop hooks [claude-mem-arch]. | Session memory "syncs to graph in background" [cognee]. Hook-level capture is unverified. |
| **1c. Sync vs async, latency** | Synchronous and local. The write path measured ~4.0k upserts/s ([memory.md](../../bench/memory.md), historical). | Platform async (`PENDING` + `event_id` poll); OSS sync [mem0-add]. | Per-episode `add_episode`. Default `SEMAPHORE_LIMIT=10` to avoid LLM 429s; bulk ingestion skips edge invalidation [graphiti][graphiti-episodes]. | Async background dreaming [letta-memory]. | Async worker pipeline [claude-mem-arch]. | Background session → graph sync [cognee]. Latency unverified. |
| **1d. Dedupe / update / delete** | Content-addressed ids: re-observing upserts. Explicit `supersede`/`delete`/`purge`/`resolve` CLI. Optional `distill` accepts ADD/SUPERSEDE/CONFLICT/NOOP from a host-agent provider, verified deterministically before apply ([distill.ts](../../../packages/memory/src/distill.ts), [cli.ts:6217](../../../packages/cli/src/cli.ts)). | Current algorithm (16 Apr 2026) is **single-pass ADD-only**: "the new fact lives alongside the old one" [mem0-algo]. The earlier two-pass ADD/UPDATE/DELETE design is retired [mem0-algo]. Update/delete remain explicit tools [mem0-mcp]. Platform "Dream" supersession/merge is opt-in (09-05 research, not re-fetched) [mem0-dream]. | Facts get validity windows; contradicted facts are "invalidated — not deleted" [graphiti]. | Agent edits files; `/doctor` audits duplication [letta-memory]. | unverified | `forget` tool deletes datasets [cognee-mcp]. README claims "better conflict resolution"; semantics unverified [cognee]. |
| **2. Published retrieval benchmarks** | Self-authored synthetic 500-query corpus, frozen before measurement:<br>• large e5 tier: G1-G8 8/8, paraphrase R@5 81.05%, MRR 0.881<br>• lexical fallback: 2.6% / 0.520<br>Recall p95 8.3 ms @10k and 132.8 ms @100k, measured with `fresh=false` ([launch-gates.md](../../bench/launch-gates.md), [perf-gates.md](../../bench/perf-gates.md)).<br>**No LoCoMo/LongMemEval/BEAM run** (`git grep` finds them only in audit prose). | **Vendor-run.** LoCoMo 92.5, LongMemEval 94.4, BEAM 1M 64.1 / 10M 48.6, ~7K tokens per retrieval, p50 0.88-1.09 s [mem0-readme][mem0-research]. Harness is public: default answerer and judge `gpt-4o`, top-k 200 [mem0-bench]. The 2025 LoCoMo paper [mem0-paper] was disputed by Zep (Zep 75.14 on Zep's own rerun) [zep-rebuttal] and Letta (filesystem agent 74.0 vs Mem0's reported 68.5) [letta-bench]. | **Vendor paper** (Jan 2025): DMR 94.8% vs MemGPT 93.4%; LongMemEval "up to 18.5%" accuracy gain and 90% latency reduction [zep-paper]. | Vendor blog (Aug 2025): LoCoMo 74.0% with a filesystem-only agent on GPT-4o mini [letta-bench]. | None found (unverified). README claims "~10x token savings" from progressive disclosure [claude-mem]. | Self-reported BEAM: 100K 0.79 (20 questions, one conversation), 10M 0.67 "exploratory", with stated limitations [cognee][cognee-beam]. |
| **3. Graph** | Deterministic code graph (tree-sitter). Memory records are bi-temporal (valid/transaction time) with `supersedes`/`contradicts` lineage and are projected onto code nodes on every read ([comparison.md](../../launch/comparison.md), `3ab2a899`). No conversational entity graph. | Entity co-occurrence linking, built "automatically on add". **No typed relationships.** Neo4j integration deprecated [mem0-graph]. Temporal edges not documented [mem0-graph]. | Bi-temporal context graph: entities, fact edges with validity windows, episode provenance, communities; updated per episode [graphiti]. Not a code call graph. | None; memory is a file tree [letta-code]. | None; SQLite FTS5 + Chroma [claude-mem]. | Knowledge graph + vectors, plus a separate deterministic code graph [cognee][cognee-code]. |
| **5. Staleness vs code, conflicts** | Quote/hash re-validation against the live soul; staleness precision 12/12 on the crib bench ([memory.md](../../bench/memory.md)). Conflicts keyed on `propositionKey`. Team trust requires a trusted Git ref + CI check ([trusted-ref.ts](../../../packages/memory/src/trusted-ref.ts)). | No code-grounded invalidation documented. ADD-only retention [mem0-algo]. | Temporal invalidation driven by new data, not code [graphiti]. | unverified | unverified | Code graph has delta receipts; invalidation of *memories* on code change unverified [cognee-code]. |
| **10. LLM calls** | Zero per read or write in core. Optional enrichment and distill use the *host* agent, never a crib-initiated call ([README.md](../../../README.md), [distill.ts](../../../packages/memory/src/distill.ts)). | 1 extraction LLM call per `add` (single pass) + embeddings [mem0-algo]. Answer-side retrieval ~7K tokens [mem0-readme]. Platform MCP billed via the Mem0 account [mem0-mcp]. | Multiple LLM calls per episode (exact count unverified). Zep Cloud bills 1 credit per 350 bytes per episode [zep-pricing]. | The agent's own tokens plus dreaming subagent tokens; review mode "consum[es] more tokens" [letta-memory]. | Compression calls per session batch through the chosen provider. The installer defaults to a hosted "observer" trial [claude-mem]. | Default OpenAI for LLM + embeddings; "Processing and generated answers make provider calls" [cognee]. The code graph needs no LLM [cognee-code]. |

### 2.2 Code-context tools: dimensions 3 (code graph) and 4

| Dimension | **Knowledge Crib** | **GitNexus** | **Serena** | **Aider repo-map** | **Cognee code graph** |
|---|---|---|---|---|---|
| **Engine** | Tree-sitter extractors, JSONL "soul", SQLite/FTS index ([README.md](../../../README.md)). | Tree-sitter + LadybugDB; hybrid BM25 + semantic + RRF search [gitnexus]. | Language servers (LSP), or the paid JetBrains plugin [serena]. | Tree-sitter definitions/references, file-dependency graph ranking [aider-blog]. | "enola" AST extractor, deterministic [cognee-code]. |
| **Languages** | 11 (TS/JS, Java, Python, C#, Go, Rust, PHP, PL/SQL, Markdown, Mule, agent artifacts). **No Kotlin/Swift/Ruby/C/C++/Dart** ([STATS.md](../../STATS.md), [extractors.ts](../../../packages/pipeline/src/extractors.ts)). | 16 in the support table (adds Kotlin, Ruby, Swift, C, C++, Objective-C, Dart, Zig) [gitnexus]. | "over 40 programming languages" [serena]. | Many, via tree-sitter language packs [aider-blog]. | Not listed (unverified) [cognee-code]. |
| **Call graph / impact** | `context`, `impact` (blast/path/owners), cross-repo federation. Risk is distance-derived ([server.ts](../../../packages/mcp/src/server.ts)). | `impact` with depth grouping and confidence; `api_impact`; group cross-repo impact [gitnexus]. | find symbol / find referencing symbols; no blast-radius tool documented [serena]. | — (prompt context only) [aider-repomap]. | `impact_analysis` "see what depends on a fact" [cognee-code]. |
| **Change / PR review** | `detect_changes`, `review` (bounded, callers + prior decisions) ([review-cost.md](../../bench/review-cost.md)). No PR-bot integration. | `detect_changes` (diff → affected processes); `/gitnexus-review` skill for PR/branch/range with taint pass [gitnexus]. | unverified | — | unverified |
| **Rename** | Graph-planned `rename`, dry-run + `planId` ([server.ts:454](../../../packages/mcp/src/server.ts)). | "Multi-file coordinated rename with graph + text search" [gitnexus]. | LSP rename (symbols); move/file/dir rename only in the JetBrains plugin [serena]. | — | — |
| **Dataflow** | `explain`: on-demand PDG/taint for TS/JS ([server.ts](../../../packages/mcp/src/server.ts)). | `explain` + `pdg_query` with `--pdg`; CFG for TS/JS only [gitnexus]. | — | — | Cycles/violations "with confidence scoring" [cognee-code]. |
| **Incremental reindex / freshness** | `serve --watch` and a supervised `auto` worker exist; freshness p95 2022 ms on the frozen workload ([production-go-decision.md](../2026-09-09/production-go-decision.md)). **Not on by default:** generated MCP args are `serve <path>` with no `--watch` ([mcp-install.ts:437-445](../../../packages/cli/src/mcp-install.ts)). | `analyze --watch` (300 ms debounce, serialized incremental refresh). Running MCP reopens the new index "typically within five seconds". PostToolUse hooks flag a stale index after commits [gitnexus]. | Live LSP; no persisted index to go stale [serena]. | Recomputed per chat state [aider-repomap]. | Delta "last ingestion's changes + snapshot receipt" [cognee-code]. |
| **Semantic code search** | `query` is BM25 over code. The embedding tier serves memory recall, not code (`status.capabilities.embeddings: false` on this repo). | Hybrid; embeddings opt-in with a 50k-node cap [gitnexus]. | — (symbolic) [serena]. | — | unverified |

### 2.3 All tools: dimensions 6-9

| Dimension | **Crib** | **Mem0** | **Zep / Graphiti** | **Letta Code** | **claude-mem** | **Cognee** | **GitNexus** | **Serena** | **Aider** |
|---|---|---|---|---|---|---|---|---|---|
| **6. Deployment** | Local, Node ≥22.5, no services. Default setup downloads ~2.1 GB model ([cli.ts:2437](../../../packages/cli/src/cli.ts), [README.md](../../../README.md)). | Library (local Qdrant + OpenAI `gpt-5-mini` default), self-hosted server (Postgres + pgvector, auth on), or Cloud [mem0-oss][mem0-readme]. | Graphiti: Neo4j 5.26 / FalkorDB / Neptune (Kuzu deprecated) + OpenAI key default [graphiti]. Zep: Cloud/BYOC, no community edition on pricing page [zep-pricing]. | npm CLI + App Server; bring your own LLM keys; Letta Cloud for cross-computer [letta-code]. | Local Bun worker + uv/Chroma. Installer offers a hosted observer or own OpenRouter/Gemini/Anthropic [claude-mem]. | Python; default OpenAI; Ollama option; docker compose API/UI/MCP [cognee]. | `npm i -g gitnexus`, local LadybugDB, no network [gitnexus]. | uv/pipx, local LSPs [serena]. | pip, local [aider-repomap]. |
| **6b. License** | Apache-2.0 | Apache-2.0 [mem0-api] | Graphiti Apache-2.0 [graphiti-api]; Zep SaaS | Apache-2.0 [letta-code-api] | Apache-2.0 [claude-mem-api] | Apache-2.0; Postgres-graph production is licensed [cognee] | **PolyForm Noncommercial 1.0.0** [gitnexus-license] | MIT [serena-api] | Apache-2.0 [aider-api] |
| **7. MCP / clients / hooks** | stdio MCP, 17 tools / 47 ops ([STATS.md](../../STATS.md)). Hooks: Claude Code only (SessionStart + Stop). Cursor, Copilot, VS Code, Codex, Windsurf, Gemini are instruction-only ([adapters.ts](../../../packages/cli/src/adapters.ts)). | Hosted MCP `mcp.mem0.ai`, 11 tools, Platform account required [mem0-mcp]. Plugins: Claude Code, Codex, Cursor, OpenCode, Antigravity, Kimi, pi-agent, OpenClaw, Vercel AI SDK… [mem0-integrations]. | Graphiti MCP "experimental", HTTP default, Docker + FalkorDB [graphiti-mcp]. Zep Memory MCP seats [zep-pricing]. | Is itself the agent harness; Agent SDK (TS), channels [letta-code]. | Claude Code plugin, OpenCode, Antigravity, OpenClaw, Grok Bot; 4 MCP search tools [claude-mem]. | cognee-mcp stdio/SSE/HTTP; Claude Code + Codex plugins [cognee][cognee-mcp]. | 17 MCP tools; hooks for Claude Code, Codex, Cursor, Antigravity [gitnexus]. | MCP stdio/HTTP; Claude Code, Codex, Cursor, VS Code, JetBrains… [serena]. | Not MCP (in-process) [aider-repomap]. |
| **8. Team / multi-agent / cross-device** | Git-committed team store with CI trusted-ref promotion. Encrypted sync over `file`/`http` backends (preview). No authn multi-tenancy ([sync/adapter.ts:30-37](../../../packages/memory/src/sync/adapter.ts), [capability-matrix.md](../../capability-matrix.md)). | user/agent/app/run ids; shared project vs personal lanes [mem0-cc]. | Zep RBAC + agent ABAC policies [zep-pbac]. | MemFS synced to a git remote; subagents [letta-code]. | Cloud sync to cmem.ai [claude-mem]. | Permissions guide, Company Brain [cognee]. | Repo groups; Render deploy with token auth [gitnexus]. | unverified | — |
| **9. Stars / contributors≈ / latest release** | 12 / 1 primary author / unreleased 0.1.0 [crib-api] | 65.1k / 399 / plugin tags 2026-09-09 [mem0-api] | 30.8k / 62 / v0.30.2 2026-09-08 [graphiti-api] | legacy `letta` 24.7k (V1 archived); `letta-code` 3.3k / v0.32.2 2026-09-11 [letta-api][letta-code-api] | 93.7k / 153 / v13.24.20 2026-09-11 [claude-mem-api] | 30.6k / 304 / v1.5.4 2026-09-04 [cognee-api] | 47.2k / 193 / v1.6.12-rc.32 2026-09-11 [gitnexus-api] | 29.2k / 229 / v1.7.0 2026-08-09 [serena-api] | 48.9k / 182 / v0.86.0 2025-08-09 [aider-api] |

Contributor counts come from the GitHub API `contributors?anon=true` pagination header, so they include anonymous committers and are approximate. Stars are not users. No tool's "production users" claim was verified.

---

## 3. Per-tool notes: what users actually rely on

**Mem0 / OpenMemory.**
- *What users rely on:* "install once, memories are captured automatically" [mem0-cc], plus automatic top-5 recall injected on the first prompt of the next session.
- *Change since 2025:* the product is now built around single-pass ADD-only extraction with semantic + keyword + entity retrieval fusion [mem0-algo]. Anyone comparing against the 2025 ADD/UPDATE/DELETE/NOOP pipeline is comparing against a retired design.
- *Benchmark claims:* the new numbers are strong but vendor-run. The harness uses a `gpt-4o` answerer and judge at top-k 200 [mem0-bench]. Earlier Mem0 LoCoMo numbers were publicly contested by two competitors [zep-rebuttal][letta-bench].
- *Code-agent limits:*
  - Coding-agent memory needs a Platform API key; the hosted MCP stores data "in your Mem0 account, not on your computer" [mem0-mcp].
  - The `openmemory/` directory is no longer in the mem0 repository root (GitHub contents API 404 today). OpenMemory survives as a product page [openmemory].
  - Nothing is re-checked against code.

**Zep / Graphiti.**
- *What users rely on:* temporal truth. Facts carry validity windows and are invalidated, not deleted, with provenance back to episodes [graphiti]. This is the strongest "what was true when" model in the set, and crib's bi-temporal records are the nearest analogue.
- *Cost of adoption:* operating Neo4j/FalkorDB/Neptune plus LLM calls on ingestion. The MCP server is still labelled experimental [graphiti-mcp]. Zep Cloud pricing is per-byte ingestion credits [zep-pricing].
- *Enterprise:* governance (RBAC/ABAC) is real, and crib has none of it [zep-pbac].

**Letta (Letta Code).**
- *What users rely on:* an agent that owns and rewrites its memory. Git-tracked MemFS, background dreaming, `/remember`, `/doctor`, and cloud continuity across computers [letta-code][letta-memory].
- *Repository move:* the original `letta` repository now points to `letta-code`, and the V1 API server lives on an archive branch [letta]. Letta is a harness, not a memory layer for an arbitrary agent, so it competes with crib only when users switch harness.
- *Benchmark stance:* its LoCoMo post argues agent capability matters more than retrieval mechanism [letta-bench]. That is a useful caution against over-investing in retrieval benchmarks.

**claude-mem.**
- *Adoption:* the most-starred tool in the set (93.7k), on a very high release cadence. What people rely on is zero-effort continuity inside Claude Code: hooks capture tool executions, a worker compresses them into observations, and SessionStart injects them [claude-mem-arch].
- *Trade-offs:*
  - It captures prompts and tool I/O, which crib's policy forbids.
  - It sends that material to an LLM provider; the installer now defaults to a hosted "observer" trial [claude-mem].
  - It has no code grounding.
  - Its README also promotes a third-party crypto token [claude-mem]. Enterprise reviewers are likely to note this.

**Cognee.**
- *Capabilities:* a general memory platform (ingest anything → graph + vectors) with Claude Code/Codex plugins and an MCP server [cognee][cognee-mcp]. It now also has a **deterministic, LLM-free code graph with impact analysis** [cognee-code]. This is the most direct challenge to crib's "code graph + memory" framing, though the code graph's MCP exposure and language list are not documented on the guide page.
- *Benchmarks:* self-reported with unusually candid caveats (20 questions at 100K) [cognee-beam].

**GitNexus.**
- *What users rely on:* one-command `analyze` that indexes, installs skills, registers hooks, writes AGENTS.md/CLAUDE.md, and keeps agents fed through PreToolUse augmentation and stale-index detection [gitnexus].
- *Gaps closed since 09-05:*
  - `analyze --watch` with automatic MCP index reopen is now documented [gitnexus]; the 09-05 research cited an open watch request.
  - The language table grew to 16.
- *Remaining crib advantages:* agent memory (GitNexus has none in its README), a committable graph artifact, and the license. PolyForm Noncommercial [gitnexus-license] blocks commercial use of the open edition. That is crib's cleanest procurement advantage in code intelligence.

**Serena.**
- *What users rely on:* IDE-grade symbol navigation and *editing* (find references, rename, symbolic edits) across 40+ languages through LSP, with no index to maintain [serena]. It has a simple memory system that users combine with AGENTS.md [serena].
- *What it lacks vs crib:* persisted graph, blast radius and provenance.
- *What crib lacks vs Serena:* language breadth and precise LSP resolution, especially where crib's resolver drops unresolved references.

**Aider repo-map.**
- A token-budgeted (default 1,000 tokens) ranked symbol map generated per chat [aider-repomap][aider-blog]. It matters as the baseline expectation that structural context should be automatic and cheap, not as a direct competitor. Aider's last tagged release is over a year old [aider-api].

---

## 4. Shortcomings of Knowledge Crib (ranked by real-world adoption impact)

Size: **S** ≤ a few days, **M** ≈ 1-3 weeks, **L** > 3 weeks, for one engineer familiar with the repo.

### 4A. Fixable in code in this repository now

#### P0-1: No automatic write path for anything that is not an exact code quote (M)

**Gap.** Every reusable memory needs the agent to (a) decide to call `memory_observe`, and (b) cite `path + line + exact quote`. Without that:
- **Preferences, environment facts, decisions and conventions:** decisions and conventions are held for `crib memory remember` at a terminal ([auto-admit.ts:196-200](../../../packages/memory/src/auto-admit.ts)); the other categories get held for "no evidence crib could verify" ([auto-admit.ts:206-208](../../../packages/memory/src/auto-admit.ts)).
- **Pitfalls:** they need a failing + passing receipt pair (lines 209-212).
- **Non-Claude clients:** the Stop hook only *asks* ([stop-nudge.ts](../../../packages/cli/src/stop-nudge.ts)), and it exists only for Claude.
- **Stranded work:** the capture outbox and `distill` exist, but distillation is a manual `crib memory distill --provider <name>` ([cli.ts:6207](../../../packages/cli/src/cli.ts), [distill.ts](../../../packages/memory/src/distill.ts)). Nothing drains it automatically, so captured candidates never reach recall.
- `authorKind: 'human'` over MCP does not change this ([api.ts:1837-1850](../../../packages/memory/src/api.ts)). That is correct for trust, but it leaves the user no in-client way to say "remember this."

**Competitor evidence.** Automatic capture and recall is the headline feature users install for:
- Mem0: "Install once, memories are captured automatically" [mem0-cc].
- claude-mem: "Automatic Operation - No manual intervention required" [claude-mem].
- Letta: dreaming [letta-memory].
- OpenMemory: auto-captures coding preferences [openmemory].

**Fix proposal (preserves the no-transcript and agent-cannot-self-trust invariants).**
1. **User-originated attestation hook (S-M).** Add a `UserPromptSubmit` hook for Claude Code. When the *user's own prompt* contains an explicit marker (e.g. a line starting `remember:` or `#crib`), write only that sentence as a `human-attestation` evidence item with kind `preference`/`convention`/`decision` and admit it to local trust.
   - The hook input comes from the client, not the model, so the model cannot forge it.
   - Store only the flagged sentence, never the prompt.
   - Wire it in `CLIENT_ADAPTERS` ([adapters.ts:274-290](../../../packages/cli/src/adapters.ts)) and route it through `cmdMemoryCaptureHook`.
2. **Close the distill loop at Stop (M).** When the Stop nudge fires and the capture outbox has undistilled entries, return a bounded distill work item in the hook reason, with the host agent as provider. The agent answers with ADD/SUPERSEDE/NOOP, and `distill.ts` verifies it as today. Crib still never calls a model.
3. **Pre-grounded suggestions (S).** In the nudge, list the files and symbols changed this session (already computed by `nudgeWorkPaths`) with their current spans. The agent can then cite quotes without re-reading, which lowers the diligence cost that makes the ledger empty.
4. **Acceptance:** a fresh Claude Code session with no user reminder produces ≥1 admitted, recallable memory from a session that fixed a bug. A second session recalls it through `brief`. No prompt/tool text is stored beyond user-flagged sentences.

#### P0-2: Lifecycle automation exists for one client; zero clients are runtime-certified (M per client, code part)

**Gap.** Cursor, Copilot, VS Code, Codex, Windsurf and Gemini are `INSTRUCTION_RECALL_ONLY`, with `lifecycleHooks: null` ([adapters.ts:256-260, 298-376](../../../packages/cli/src/adapters.ts)). Their bootstrap/recall depends on the model obeying an instruction file. The generated certification table shows "not certified" for all seven clients, Claude Code included ([capability-matrix.md](../../capability-matrix.md)). The 09-09 decision is NO-GO on the Claude/darwin receipt ([production-go-decision.md](../2026-09-09/production-go-decision.md)).

**Competitor evidence.**
- GitNexus ships hooks for Codex (`~/.codex/hooks.json`, "same schema as Claude Code"), Cursor (postToolUse) and Antigravity (AfterTool, Gemini CLI schema) [gitnexus].
- Mem0 ships per-agent plugins for Codex, Cursor, OpenCode and Antigravity [mem0-integrations].

**Fix proposal.**
1. Add `lifecycleHooks` cells and writers for Codex and Gemini CLI, reusing the existing `session-start`/`turn-end` capture commands and the matcher-group writer. Both documented schemas mirror Claude's.
2. Add a Cursor `hooks.json` writer.
3. Keep evidence at `verified-upstream-doc` until a receipt exists.
4. Extend `scripts/client-certify-claude.mjs` into a per-client driver.

Running certification needs signed-in vendor clients (see 4B-3).

#### P1-1: Freshness is not on in the configuration crib generates (S)

**Gap.** `crib setup` writes MCP args `serve <path>` with no `--watch` ([mcp-install.ts:437-445](../../../packages/cli/src/mcp-install.ts)). The audit found freshness mode defaults to manual (F06 in [launch-audit.md](../2026-09-05/launch-audit.md)). On this repository right now, `status` reports `vcsHead 19491a0c` against `currentHead 86040a2c`: the index missed the last two commits, including the memory-graph feature. A stale graph "answers confidently and wrongly" (this repo's own CLAUDE.md).

**Competitor evidence.** GitNexus's MCP reopens a newly published index "typically within five seconds", and its hooks flag stale indexes after git operations [gitnexus]. Serena has no index to go stale [serena].

**Fix proposal.**
1. Emit `--watch` in generated server args for project scope.
2. Add a SessionStart check comparing `vcsHead` with `HEAD`. When they differ, enqueue the existing incremental `crib update` via the supervised worker rather than blocking.
3. Surface a one-line stale warning in the SessionStart bootstrap block.
4. **Acceptance:** after `git commit` in a client session, `query` for a symbol added by that commit succeeds within the 5 s p95 already measured.

#### P1-2: Language coverage (M per language, L for the set)

**Gap.** 11 extractors ([extractors.ts](../../../packages/pipeline/src/extractors.ts), [STATS.md](../../STATS.md)). Kotlin, Swift, Ruby, C, C++, Objective-C and Dart are missing. That excludes Android/iOS, most systems code and Rails codebases from `impact`/`review`/`rename`. On those repos crib is memory-only.

**Competitor evidence.** GitNexus lists 16 languages including all of those [gitnexus]. Serena covers 40+ through LSP [serena].

**Fix proposal.**
1. Add tree-sitter extractors for Kotlin, Ruby and C/C++ first; grammars already exist and the parser pool supports them ([tree-sitter-pool.ts](../../../packages/parsers/src/tree-sitter-pool.ts)).
2. Gate each with the existing eval-fixture pattern.
3. Separately, add a generic "outline-only" fallback extractor (symbols without call resolution) for any tree-sitter language, labelled `EXTRACTED`, low confidence, with unresolved calls reported through `status{op:'gaps'}`. Unsupported repositories then get degraded graph coverage instead of none.

#### P1-3: No external, reproducible quality evidence (M)

**Gap.** All memory-quality numbers come from a corpus written by the same team ([launch-gates.md](../../bench/launch-gates.md) discloses partial blinding). `scripts/launch-vendor-compare.mjs` has vendor adapters but has never produced a vendor column ([comparison.md](../../launch/comparison.md)). Code-edge precision/recall by language is still unpublished (F11 in [launch-audit.md](../2026-09-05/launch-audit.md)).

**Competitor evidence.**
- Mem0 publishes a runnable harness [mem0-bench].
- Cognee publishes a methodology report [cognee-beam].
- Zep and Letta publish papers/blogs [zep-paper][letta-bench].

All are vendor-run, but buyers expect *a* number on a public benchmark.

**Fix proposal.**
- **Retrieval-only LongMemEval track (M):** feed each session's gold evidence turns as claims, because crib deliberately does not extract from conversations. Report recall@k and MRR without an LLM judge, and state plainly that it is not comparable to end-to-end judged scores.
- **Code-edge accuracy fixture (M):** callbacks, shadowing, dynamic dispatch, overloads; precision/recall per language and resolution method.
- **Publish both** with commit, model and scorer ids. An end-to-end LLM-judged run is a spend decision (4B).

#### P1-4: Semantic search does not cover code (M)

**Gap.** Code `query` is BM25. The installed e5 embedder serves memory recall only. This repository's `status` reports `capabilities.embeddings: false, vector: false`, and comparison.md's honest-limits section still says hybrid retrieval is not the default runtime path.

**Competitor evidence.** GitNexus `query` is "BM25 + semantic + RRF" [gitnexus]. Mem0 fuses semantic, keyword and entity signals [mem0-algo].

**Fix proposal.**
1. Reuse the pinned embedder and the content-addressed vector cache ([vector-store.ts](../../../packages/memory/src/vector-store.ts)) to embed symbol signature + docstring + dossier purpose per node.
2. RRF-fuse with BM25 in `query`/`brief` only when the tier is installed, and report `retrieval.matched`.
3. Gate on a pre-registered code-search corpus. The memory-side fusion result was negative ([launch-gates.md](../../bench/launch-gates.md)), so fusion must earn its default.

#### P1-5: Documentation contradicts itself on first-contact facts (S)

**Gap.**
- **Semantic tier:** [capability-matrix.md](../../capability-matrix.md) (dated 6 Sep) says the tier is "opt-in (`crib embed setup`)" and lists 10 extractors. Setup now installs the large model by default ([cli.ts:2436-2437](../../../packages/cli/src/cli.ts)), and STATS lists 11.
- **Clone URL:** the README clone URL is `github.com/KnowledgeCrib/knowledge-crib`, while the repository that exists is `vishalc412/Knowledge-crib` ([repo-identity-decision.md](../../launch/repo-identity-decision.md) is still pending).
- **Exclusivity claim:** [comparison.md](../../launch/comparison.md) keeps the "only one showing the intersection" claim; Cognee's code graph and GitNexus's `explain` undercut it (§1).

**Why P1.** Crib's pitch is honesty. A reviewer who finds these three contradictions in ten minutes discounts every other claim.

**Fix proposal.**
1. Regenerate the matrix's default column from `parseEmbedChoice` in the docs-stats generator.
2. Replace the hard-coded clone URL with the pending identity placeholder.
3. Rewrite the comparison intersection claim to the narrower one in §1, bullet 1.

#### P1-6: A default 2.1 GB download for the only model that passes the gate (M, measurement)

**Gap.** Every size below `large` fails G2 (small 66.0%, base 69.9%) ([capability-matrix.md](../../capability-matrix.md)). The default install is therefore a 2.1 GB download ([README.md](../../../README.md)). On CI runners, laptops on metered links and corporate proxies this breaks the "one command" promise. Skipping it drops paraphrase recall to 2.6%.

**Competitor evidence.** GitNexus makes embeddings opt-in, fetches its runtime on demand, and documents proxy workarounds [gitnexus]. Mem0 uses API embeddings by default [mem0-oss].

**Fix proposal.**
1. Add an int8-quantized `multilingual-e5-large` ONNX variant to [onnx-model-ladder.md](../../bench/onnx-model-ladder.md) and let G2/G3 decide.
2. Make setup non-blocking: index + MCP + memory first, model in the background, with `crib doctor` showing tier state.

Hosting a smaller distilled model is a 4B decision.

#### P2-1: No PR-bot surface for `review` (S-M)

**Gap.** `review` is agent-side only. The GitHub Action refreshes the soul on merge but does not comment on PRs.

**Competitor evidence.** GitNexus's `/gitnexus-review` covers PR/branch/range reviews [gitnexus]. Hosted PR reviewers (Greptile) define the user expectation.

**Fix proposal.** Add an Action step that runs `crib review --since origin/<base> --json` and posts changed declarations, callers and prior team decisions as one PR comment. Degrade to a `note` when the index is incomplete.

#### P2-2: The served recall path with fresh revalidation has no current latency number (S)

**Gap.** Recall p95 is 8.3 ms @10k with `fresh=false` ([perf-gates.md](../../bench/perf-gates.md)). The historical fresh-revalidation phase cost 429 ms p50 @10k ([memory.md](../../bench/memory.md)). MCP recall paths set `fresh: true` ([verbs.ts:2681, 2779](../../../packages/mcp/src/verbs.ts)).

**Fix proposal.** Add a `fresh=true` served-path row (MCP stdio, warm, 10k/100k) to perf-gates, and fix whatever it reveals. Do not quote 8.3 ms for MCP recall until then.

### 4B. Needs product or infra decisions

| P | Gap | Competitor evidence | Decision needed / proposal | Size |
|---|---|---|---|---|
| **P0-3** | **Not installable from a registry.** npm 404; clone + corepack + bootstrap; repo identity unresolved ([publish-runbook.md](../../launch/publish-runbook.md), [repo-identity-decision.md](../../launch/repo-identity-decision.md)). | `npm i -g gitnexus`, `npx claude-mem install`, `npm i -g @letta-ai/letta-code`, pip for Mem0/Graphiti/Cognee/Serena [gitnexus][claude-mem][letta-code][mem0-readme][graphiti][cognee][serena]. | Settle org identity (M4.5), publish `@knowledge-crib/*` with `npx knowledge-crib setup` as the entry point, and ship a Claude Code plugin-marketplace manifest (plugin marketplaces are how claude-mem, Mem0 and Cognee reach users). Code part (plugin manifest, `npx` launcher) is S once the name is decided. | S (code) + decision |
| **P0-3b** | **Launch still NO-GO for lack of an authenticated vendor-client receipt.** | Not applicable (competitors do not publish certification). This is crib's own policy. | An operator with a signed-in Claude Code must run `scripts/client-certify-claude.mjs` ([production-go-decision.md](../2026-09-09/production-go-decision.md)). Consider shipping as an explicitly labelled preview rather than holding distribution for certification: the rest of the table shows adoption follows availability. | S (ops) |
| **P1-7** | Certifying Codex/Cursor/Gemini/Windsurf/Copilot needs paid, signed-in clients and CI secrets. | GitNexus lists "Full" support per editor [gitnexus]. | Budget vendor accounts and a macOS/Linux/Windows runner matrix, or keep the preview label honestly. | M |
| **P1-8** | No LLM-judged end-to-end memory benchmark. | Every competitor headline is judge-based [mem0-bench][zep-paper][letta-bench][cognee-beam]. | Decide whether to spend API budget on judged LongMemEval, and whether crib's no-extraction design should be shown on a conversational benchmark at all. Recommended: publish the retrieval-only track (4A P1-3) and a *code-memory* task suite instead of chasing LoCoMo. | M |
| **P1-9** | Model distribution: 2.1 GB third-party weights fetched from upstream at setup. | Mem0 and Graphiti default to hosted embedding APIs [mem0-oss][graphiti]. | Choose between mirroring a pinned bundle (hosting cost, licence attribution), a quantized variant, or an opt-in hosted embedding endpoint (contradicts no-network core; would need an explicit egress mode). | M |
| **P2-3** | No authenticated shared/hosted mode: team sharing is Git PR + CI only; HTTP transport is loopback with a Host/Origin guard but no caller auth ([server.ts:1015-1060](../../../packages/mcp/src/server.ts)). | Mem0 hosted MCP with OAuth [mem0-mcp]; Zep RBAC/ABAC [zep-pbac]; Cognee permissions [cognee]. | Decide whether crib ever runs as a shared service. If yes: identity provider, per-principal authz on every read path (F03 lineage), audit log. If no: say so in the comparison page. | L |
| **P2-4** | Community and maturity: 12 stars, single primary author, no release. | 29k-94k stars, 60-400 contributors, weekly-to-daily releases (§2.3). | Launch plan, contributor guide exercised by an outsider, public issue triage cadence. Not a code problem. | ongoing |
| **P2-5** | No conversational entity/temporal graph (people, preferences over time). | Graphiti's core model [graphiti]; Mem0 entity linking [mem0-graph]. | Recommend **not** building it: it needs LLM extraction and puts crib in the most crowded category. Position crib next to such tools instead. | — |

---

## 5. What changed since the 2026-09-05 research

**Knowledge Crib**
1. **Writes can now reach recall without the CLI.** `memory_observe` grounds agent-cited quotes and auto-admits to local trust; pending and admitted memories appear in `context`/`impact`/`neighbors`; a Stop-hook nudge exists; PostToolUse capture was removed as too slow (~1 s per tool call) (`3ab2a899`, 11 Sep). This partially addresses 09-05 finding F04. It does not provide non-agent-initiated capture (§4A P0-1).
2. **Semantic tier is on by default in `crib setup`** (`large`, ~2.1 GB; [cli.ts:2437](../../../packages/cli/src/cli.ts)). The 09-05 audit and the 09-06 capability matrix describe it as opt-in.
3. **Freshness measured:** p95 2022 ms on the frozen workload (09-09). It was previously "NOT MEASURED".
4. **Launch scope narrowed** to Claude Code on macOS (policy v2). The decision is NO-GO on a single missing vendor receipt (09-09).
5. Still unpublished on npm; repository identity still unresolved.

**Competitors**
1. **Mem0:** now a single-pass ADD-only algorithm (16 Apr 2026) with LoCoMo 92.5 / LongMemEval 94.4 / BEAM results and a public harness [mem0-algo][mem0-bench]. Graph Memory is co-occurrence based and the Neo4j integration is deprecated [mem0-graph]. The coding MCP is hosted and Platform-only [mem0-mcp]. The OSS `openmemory/` directory is gone from the repository root. The 09-05 note that V3 add is ADD-only is confirmed and now applies to the whole product.
2. **GitNexus:** `analyze --watch` with automatic MCP index reopen is now documented. The 09-05 research relied on open watch request #3030, so "no continuous refresh" is no longer a valid comparison. The language table is now 16 (was 15). PDG/taint `explain`, `api_impact` and a review skill are listed [gitnexus]. The license is still PolyForm Noncommercial.
3. **Letta:** the `letta` repository now redirects development to `letta-code`, and the V1 server moved to an archive branch [letta]. MemFS/dreaming descriptions are consistent with 09-05.
4. **Graphiti:** MCP server still "experimental"; FalkorDB is now the MCP default; Kuzu deprecated [graphiti][graphiti-mcp].
5. **Newly covered here (absent from 09-05):**
   - **claude-mem**, the adoption leader: 93.7k stars, auto-capture.
   - **Cognee:** deterministic code graph with impact analysis next to its memory.
   - **Serena:** LSP-based code tools across 40+ languages.
   - **Aider repo-map:** baseline.

   Cognee in particular invalidates the exclusivity framing in [comparison.md](../../launch/comparison.md).
6. **Benchmark disputes are now on the record from primary parties** [zep-rebuttal][letta-bench]. Any crib copy that quotes a competitor's LoCoMo number should cite the dispute alongside it.

---

## 6. Sources

All accessed 2026-09-11 unless noted. Competitor claims are as documented by the vendor; none were independently executed.

**Mem0 / OpenMemory**
[mem0-add]: https://docs.mem0.ai/core-concepts/memory-operations/add
[mem0-oss]: https://docs.mem0.ai/open-source/overview
[mem0-readme]: https://github.com/mem0ai/mem0/blob/main/README.md
[mem0-algo]: https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm
[mem0-research]: https://mem0.ai/research
[mem0-bench]: https://github.com/mem0ai/memory-benchmarks
[mem0-cc]: https://docs.mem0.ai/integrations/claude-code
[mem0-mcp]: https://docs.mem0.ai/platform/mem0-mcp
[mem0-graph]: https://docs.mem0.ai/platform/features/graph-memory
[mem0-dream]: https://docs.mem0.ai/platform/features/dream
[mem0-integrations]: https://github.com/mem0ai/mem0/tree/main/integrations
[mem0-paper]: https://arxiv.org/abs/2504.19413
[openmemory]: https://mem0.ai/openmemory
[mem0-api]: https://api.github.com/repos/mem0ai/mem0

- [mem0-add] Add memory operation: https://docs.mem0.ai/core-concepts/memory-operations/add
- [mem0-oss] Open-source overview: https://docs.mem0.ai/open-source/overview
- [mem0-readme] README (benchmark table, deployment modes, license): https://github.com/mem0ai/mem0/blob/main/README.md
- [mem0-algo] Token-efficient memory algorithm (16 Apr 2026): https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm
- [mem0-research] Research page: https://mem0.ai/research
- [mem0-bench] Evaluation harness: https://github.com/mem0ai/memory-benchmarks
- [mem0-cc] Claude Code integration: https://docs.mem0.ai/integrations/claude-code
- [mem0-mcp] Hosted MCP server: https://docs.mem0.ai/platform/mem0-mcp
- [mem0-graph] Graph Memory: https://docs.mem0.ai/platform/features/graph-memory
- [mem0-dream] Dream (cited from 2026-09-05 research; not re-fetched): https://docs.mem0.ai/platform/features/dream
- [mem0-integrations] Integrations directory: https://github.com/mem0ai/mem0/tree/main/integrations
- [mem0-paper] 2025 LOCOMO paper: https://arxiv.org/abs/2504.19413
- [openmemory] OpenMemory product page: https://mem0.ai/openmemory
- [mem0-api] GitHub metadata: https://api.github.com/repos/mem0ai/mem0

**Zep / Graphiti**
[graphiti]: https://github.com/getzep/graphiti/blob/main/README.md
[graphiti-mcp]: https://github.com/getzep/graphiti/blob/main/mcp_server/README.md
[graphiti-episodes]: https://help.getzep.com/graphiti/core-concepts/adding-episodes
[zep-paper]: https://arxiv.org/abs/2501.13956
[zep-pricing]: https://www.getzep.com/pricing
[zep-pbac]: https://help.getzep.com/policy-based-access-control
[zep-rebuttal]: https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
[graphiti-api]: https://api.github.com/repos/getzep/graphiti

- [graphiti] README: https://github.com/getzep/graphiti/blob/main/README.md
- [graphiti-mcp] MCP server README: https://github.com/getzep/graphiti/blob/main/mcp_server/README.md
- [graphiti-episodes] Adding episodes: https://help.getzep.com/graphiti/core-concepts/adding-episodes
- [zep-paper] Zep paper (Jan 2025): https://arxiv.org/abs/2501.13956
- [zep-pricing] Pricing: https://www.getzep.com/pricing
- [zep-pbac] Policy-based access control (from 2026-09-05 research): https://help.getzep.com/policy-based-access-control
- [zep-rebuttal] Zep on Mem0's LoCoMo evaluation (May 2025, corrections noted): https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- [graphiti-api] GitHub metadata: https://api.github.com/repos/getzep/graphiti

**Letta**
[letta]: https://github.com/letta-ai/letta
[letta-code]: https://github.com/letta-ai/letta-code
[letta-memory]: https://docs.letta.com/letta-code/memory
[letta-bench]: https://www.letta.com/blog/benchmarking-ai-agent-memory
[letta-api]: https://api.github.com/repos/letta-ai/letta
[letta-code-api]: https://api.github.com/repos/letta-ai/letta-code

- [letta] Legacy repository README: https://github.com/letta-ai/letta
- [letta-code] Letta Code: https://github.com/letta-ai/letta-code
- [letta-memory] Letta Code memory docs: https://docs.letta.com/letta-code/memory
- [letta-bench] Filesystem LoCoMo post (Aug 2025): https://www.letta.com/blog/benchmarking-ai-agent-memory
- [letta-api] / [letta-code-api] GitHub metadata: https://api.github.com/repos/letta-ai/letta, https://api.github.com/repos/letta-ai/letta-code

**claude-mem**
[claude-mem]: https://github.com/thedotmack/claude-mem/blob/main/README.md
[claude-mem-arch]: https://docs.claude-mem.ai/architecture/overview
[claude-mem-api]: https://api.github.com/repos/thedotmack/claude-mem

- [claude-mem] README: https://github.com/thedotmack/claude-mem/blob/main/README.md
- [claude-mem-arch] Architecture overview: https://docs.claude-mem.ai/architecture/overview
- [claude-mem-api] GitHub metadata: https://api.github.com/repos/thedotmack/claude-mem

**Cognee**
[cognee]: https://github.com/topoteretes/cognee/blob/main/README.md
[cognee-mcp]: https://github.com/topoteretes/cognee/blob/main/cognee-mcp/README.md
[cognee-code]: https://docs.cognee.ai/guides/code-graph
[cognee-beam]: https://github.com/topoteretes/cognee/blob/main/cognee/eval_framework/beam/REPORT.md
[cognee-api]: https://api.github.com/repos/topoteretes/cognee

- [cognee] README: https://github.com/topoteretes/cognee/blob/main/README.md
- [cognee-mcp] MCP server README: https://github.com/topoteretes/cognee/blob/main/cognee-mcp/README.md
- [cognee-code] Code graph guide: https://docs.cognee.ai/guides/code-graph
- [cognee-beam] BEAM report: https://github.com/topoteretes/cognee/blob/main/cognee/eval_framework/beam/REPORT.md
- [cognee-api] GitHub metadata: https://api.github.com/repos/topoteretes/cognee

**GitNexus**
[gitnexus]: https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md
[gitnexus-license]: https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE
[gitnexus-api]: https://api.github.com/repos/abhigyanpatwari/GitNexus

- [gitnexus] README (tools, languages, hooks, watch, groups): https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md
- [gitnexus-license] LICENSE (PolyForm Noncommercial 1.0.0): https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE
- [gitnexus-api] GitHub metadata: https://api.github.com/repos/abhigyanpatwari/GitNexus

**Serena / Aider**
[serena]: https://github.com/oraios/serena/blob/main/README.md
[serena-api]: https://api.github.com/repos/oraios/serena
[aider-repomap]: https://aider.chat/docs/repomap.html
[aider-blog]: https://aider.chat/2023/10/22/repomap.html
[aider-api]: https://api.github.com/repos/Aider-AI/aider

- [serena] README: https://github.com/oraios/serena/blob/main/README.md
- [serena-api] GitHub metadata: https://api.github.com/repos/oraios/serena
- [aider-repomap] Repo map docs: https://aider.chat/docs/repomap.html
- [aider-blog] Repo map design post (Oct 2023): https://aider.chat/2023/10/22/repomap.html
- [aider-api] GitHub metadata and releases: https://api.github.com/repos/Aider-AI/aider

**Knowledge Crib (this repository)**
[crib-api]: https://api.github.com/repos/vishalc412/Knowledge-crib

- [crib-api] GitHub metadata (12 stars, public): https://api.github.com/repos/vishalc412/Knowledge-crib
- In-repo evidence is linked inline: [auto-admit.ts](../../../packages/memory/src/auto-admit.ts), [api.ts](../../../packages/memory/src/api.ts), [stop-nudge.ts](../../../packages/cli/src/stop-nudge.ts), [adapters.ts](../../../packages/cli/src/adapters.ts), [mcp-install.ts](../../../packages/cli/src/mcp-install.ts), [cli.ts](../../../packages/cli/src/cli.ts), [verbs.ts](../../../packages/mcp/src/verbs.ts), [server.ts](../../../packages/mcp/src/server.ts), [distill.ts](../../../packages/memory/src/distill.ts), [trusted-ref.ts](../../../packages/memory/src/trusted-ref.ts), [sync/adapter.ts](../../../packages/memory/src/sync/adapter.ts), [extractors.ts](../../../packages/pipeline/src/extractors.ts), [STATS.md](../../STATS.md), [capability-matrix.md](../../capability-matrix.md), [launch-gates.md](../../bench/launch-gates.md), [perf-gates.md](../../bench/perf-gates.md), [memory.md](../../bench/memory.md), [production-go-decision.md](../2026-09-09/production-go-decision.md).

## Research limitations

- Vendor documentation describes intended behaviour; main-branch READMEs can run ahead of releases, and no competitor version was pinned or executed.
- WebFetch summaries were used for several docs pages; key numbers were cross-checked against READMEs or the GitHub API where possible, and cells not so confirmed are marked unverified.
- GitHub stars and contributor counts are popularity signals, not usage.
- Crib's own index was two commits behind HEAD during this research (`status`), so files changed in `3ab2a899` were read directly instead of through graph verbs.
- No crib test, benchmark or release gate was re-run for this document; crib numbers are quoted from dated evidence files.
