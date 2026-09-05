# Knowledge Crib: competitor evidence and launch implications

Research date: 2026-09-05. Scope: official public documentation and upstream repositories only. No competing memory tool was installed, invoked, or used to understand the Knowledge Crib repository. No competitor benchmark was executed. This document supplies external evidence; statements about whether Knowledge Crib already meets a requirement must come from the parent audit's repository and runtime evidence.

## Executive assessment

The competitive bar has moved beyond an MCP server that stores notes. Buyers can already obtain automatic capture, background consolidation, identity-scoped retrieval, inspectors, version history, and multiple deployment choices. Knowledge Crib should compete on a proven combination: portable agent memory, explicit local/personal/team boundaries, code-grounded freshness, recoverable execution handoffs, and inspectable evidence. Neither “works with any model,” “Git-backed,” “local,” nor “has a graph” is a defensible exclusive claim on its own.

Three distinct product categories must remain separate in the comparison:

- Conversational/user memory infrastructure: Mem0 and Zep.
- Repository code intelligence: GitNexus.
- Stateful agent runtime and memory filesystem: Letta.

OpenMemory is a directly relevant cross-client memory UX comparator. Here it means **Mem0's OpenMemory**, not another similarly named project. A code graph cannot by itself remember a user's constraints; a semantic memory store cannot by itself resolve a call graph. The strongest launch story is the tested intersection, not an unsupported universal ranking.

## Current documented capabilities

### Mem0: application memory and increasingly automatic coding memory

Mem0's add API extracts facts with an LLM unless inference is disabled. It supports user, agent, application, and run identifiers; managed Platform and self-hosted OSS are distinct paths. Platform add operations return a pending event to track processing, and can use prior messages with matching identifiers when resolving a new turn. An expiration date hides records from ordinary search/list after expiry but does not erase them: retrieval by ID still works. These are important distinctions for ingestion durability and retention claims. [Mem0 Add Memory](https://docs.mem0.ai/core-concepts/memory-operations/add), accessed 2026-09-05.

The current Claude Code integration captures messages, changed files, and short test/build results locally through hooks. A detached worker flushes after five exchanges, earlier for large exchanges, on exit/compaction, or after a configurable five-minute idle period; it survives the client exiting. It documents credential redaction, automatic first-prompt recall, pause/resume/status/forget controls, and separate shared project and personal memories. The project lane is repository-scoped; the personal lane is user-and-repository-scoped. This is substantive automation, although the vendor's non-blocking claims were not measured here. Its explicit scope/filter behavior is a useful UX benchmark. [Mem0 Claude Code](https://docs.mem0.ai/integrations/claude-code), accessed 2026-09-05.

Codex documentation distinguishes direct remote MCP from the plugin route: the plugin adds memory protocol skills and opt-in lifecycle hooks, whereas direct MCP supplies tools. Therefore “MCP-compatible” must never be treated as equivalent to automatic lifecycle support. [Mem0 Codex](https://docs.mem0.ai/integrations/codex), accessed 2026-09-05.

Mem0 Dream documents automatic supersession and duplicate merging as additions are processed. Scheduled synthesis is opt-in on Pro+, preserves sources, and links patterns to evidence. Synthesis considers only user-only memories, at least 20 memories, and only memories created after enablement. Documented cadence is weekly on Pro and daily/configurable on Enterprise, with roughly another day possible for batch processing. A critical read contract: default searches can return superseded history; `latest_only=true` selects active facts. Merged records are retained but hidden unless requested. These are documented Platform semantics, not claims about every OSS version. [Mem0 Dream](https://docs.mem0.ai/platform/features/dream), accessed 2026-09-05.

Project-specific webhooks notify about memory mutations and ingestion-job outcomes. They make event-driven downstream refresh possible, but an event API alone does not establish end-to-end delivery or freshness guarantees. [Mem0 Webhooks](https://docs.mem0.ai/platform/features/webhooks), accessed 2026-09-05.

**Implication for Crib:** demonstrate capture-to-recall without the user reminding the agent, show the queue and last successful processing time, and explain the difference between a saved candidate, admitted memory, current fact, superseded history, and deletion. Preserve Crib's stricter no-transcript policy instead of copying every competitor's capture behavior.

### GitNexus: strong repository intelligence with multiple refresh mechanisms

The upstream README documents Tree-sitter parsing, cross-file resolution, communities, execution processes, hybrid search, a browser graph explorer, and a global registry pointing to per-repository indexes. Its current editor matrix includes MCP, skills, and hooks for Claude Code and Codex. Hooks detect stale indexes after commits and prompt reindexing; the enterprise offering separately advertises automatic reindexing and a unified graph across repositories. The README also documents signed container releases with provenance/SBOM attestations. Its language table and roadmap are not perfectly synchronized: the table contains 15 languages while a completed milestone says 14, and incremental indexing remains on the roadmap despite incremental cache controls elsewhere. Avoid binary feature claims based on one heading. [GitNexus upstream README](https://github.com/abhigyanpatwari/GitNexus), accessed 2026-09-05.

The runbook recognizes stale-HEAD indexes, failed/unverified scope extraction, incomplete graph writes, and pending embedding checkpoints. It explains that impact/context may be lower bounds and old indexes need reanalysis before empty results can be trusted. It documents resuming partial embedding work and manually forcing rebuilds. This means “honesty about incomplete graphs” is a current competitor capability, not a unique Crib differentiator. The durable distinction to test is how precisely each system invalidates code-grounded memories and refuses unsupported conclusions after source drift. [GitNexus Runbook](https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/RUNBOOK.md), accessed 2026-09-05.

The current upstream license file names PolyForm Noncommercial 1.0.0. Procurement comparisons should identify that license accurately and distinguish any commercial offering; do not label all source-available software as permissively licensed. [GitNexus LICENSE](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE), accessed 2026-09-05.

**Implication for Crib:** compare source-to-index freshness, caller/callee accuracy, unsupported edge reporting, cross-repository identity, and index corruption recovery separately from conversational memory. “Frequent update” should cover uncommitted edits and branch transitions, not just Git commits. A richer visualization and easy inspection can matter more for adoption than another graph verb.

### Letta: Git-backed persistent agents and background learning

Current Letta documentation uses MemFS: each agent owns a Git-backed Markdown memory repository projected into its execution environment. Memory edits become available elsewhere after commit/push. Files under `system/` are always in prompt; other files are discovered and loaded on demand. MemFS has no built-in semantic/vector index by default; optional search augmentation exists. Local agents retain local repositories and require their own backup. Cloud-backed agents synchronize hosted repositories, and memory subagents use worktrees for concurrent updates. This is direct evidence that Git-backed portable memory and inspectable files are already competitor capabilities. [Letta MemFS](https://docs.letta.com/concepts/memfs), accessed 2026-09-05.

Dreaming reviews conversations in background subagents after configurable completed steps or context compaction. There is an optional second agent-review pass; memory initialization, explicit teaching, viewer access, and a memory doctor make maintenance visible to users. [Letta Memory & Dreaming](https://docs.letta.com/configuration/memory), accessed 2026-09-05.

Organization-owned shared memory repositories attach to several agents, with commit/push/pull semantics and Git history. Current docs explicitly say these shared repositories require cloud-hosted agents and recommend migration from legacy shared blocks. This is narrower than arbitrary local agents sharing an independently owned memory service. [Letta Shared Memory](https://docs.letta.com/concepts/shared-memory), accessed 2026-09-05.

Letta supports local runtime and self-hosted App Server with on-device state and no account required. Local storage does not imply local inference: choosing a remote model still sends prompts there. [Letta Self-hosting](https://docs.letta.com/self-hosting), accessed 2026-09-05.

**Implication for Crib:** prove independence from the agent runtime and persistent agent ID. The same authorized user should resume useful work from a new agent/session/client while identity and sharing boundaries remain explicit. Git history is helpful but does not by itself deliver semantic conflict handling or tenant authorization.

### Zep / Graphiti: temporal memory and enterprise governance

Graphiti builds temporal graphs from structured or unstructured episodes with provenance, incremental updates, fact invalidation, and hybrid semantic/lexical/graph retrieval. Its bi-temporal model preserves changing relationships. Current docs distinguish the open-source graph framework from Zep's managed context engine and governance. These are semantic entity/fact graphs, not automatically compiler-quality call graphs. [Graphiti Overview](https://help.getzep.com/graphiti/getting-started/overview), accessed 2026-09-05.

The Graphiti MCP server exposes persistent graph context to clients including Claude Desktop, Cursor, and VS Code/Copilot, but its docs explicitly call the server experimental. MCP availability is therefore evidence of an integration surface, not universal production readiness. [Graphiti MCP](https://help.getzep.com/graphiti/getting-started/mcp-server), accessed 2026-09-05.

Zep separates human dashboard RBAC from agent/API-key ABAC. Policies govern both allowed actions and context classes derived from ingestion metadata, with report-only and enforcement modes. This is a useful enterprise bar: “local versus team” scope selection is not a substitute for server-side authorization on every returned artifact. [Zep Governance](https://help.getzep.com/governance), [Zep Policy-based Access](https://help.getzep.com/policy-based-access-control), accessed 2026-09-05.

Zep's security guidance treats memory as untrusted evidence rather than permission to act; it warns against privileged prompt insertion and requires authenticated source labels. It also calls out that thread-message metadata does not project onto derived graph artifacts, whereas episode metadata can. These are unusually concrete controls worth testing in Crib's evidence, admission, and recall paths. [Zep Memory Security](https://help.getzep.com/v3/memory-security), accessed 2026-09-05.

The service distinguishes administrative dashboard audit logs from API request logs, including separate plan/retention scopes. Both need assessment; one log type is not a full audit trail. Its webhooks document signatures, duplicate handling, replay, and a 5–10 minute configuration propagation delay. [Zep Audit Logging](https://help.getzep.com/audit-logging), [Zep API Logging](https://help.getzep.com/api-logging), [Zep Webhooks](https://help.getzep.com/v3/webhooks), accessed 2026-09-05.

**Implication for Crib:** measure stale-fact suppression and provenance reachability, test authorization before ranking, and distinguish graph temporal validity from repository revision validity. An enterprise story needs identity administration, revocation, recovery, and observability around the memory algorithms.

### Mem0 OpenMemory: cross-client UX is already a product category

The May 13, 2025 launch describes local MCP memory with a dashboard and shared access across compatible clients. Another launch guide specifies Postgres/Qdrant/Docker, app- and memory-level pause/revocation, and read/write audit logs. Treat the historical “all local” language as a storage/deployment description to validate against configured model/embedding providers, not a universal proof of zero network egress. [OpenMemory launch](https://mem0.ai/blog/introducing-openmemory-mcp), [OpenMemory architecture guide](https://mem0.ai/blog/how-to-make-your-clients-more-context-aware-with-openmemory-mcp), published 2025-05-13; accessed 2026-09-05.

The current product page advertises automatic coding-preference capture, project-scoped delivery, typed memories, access logs, versioning, and visibility rules. These are vendor product claims rather than features exercised in this audit. Its present packaging should not be conflated with the original local release. [OpenMemory product](https://mem0.ai/openmemory), accessed 2026-09-05.

**Implication for Crib:** install-and-forget portability and an accessible memory inspector are launch expectations, not stretch goals. A user should understand what was saved, why it returned, where it applies, and who can access it without knowing internal graph vocabulary.

## What frequent updates must mean for Knowledge Crib

The following is proposed architecture and acceptance guidance, not a claim about existing implementation or measured competitor performance.

| Independent lifecycle | Proposed trigger | Acceptance evidence |
| --- | --- | --- |
| Code index | Debounced file events, rename/delete, branch switch, checkout, merge and pull; on-read drift check | Source fingerprint and indexed generation match; stale/partial status is visible; atomic replacement prevents mixed generations |
| Session handoff | Meaningful completed step, compaction, idle, exit, restart | Accepted work resumes in a different client; queue survives forced process kill; completion is not inferred from an empty queue |
| Reusable memory | Sanitized explicit lesson or admissible execution/source evidence | Admission rule, scope and evidence are recorded; repeated event is idempotent; unsupported claims do not promote themselves |
| Existing fact validity | Source drift, contradictory evidence, policy change, TTL | Current recall suppresses invalid claims while history stays inspectable; changed evidence creates a review item |
| Device/team propagation | Authorized sync event and reconnect | Local-only data never leaks; revoked devices lose access; replay does not resurrect deletions; conflicts stay recoverable |
| Consolidation | Idle budget and scheduled maintenance | Bounded cost; sources preserved; false merges reversible; no inference changes trusted policy silently |
| Software upgrades | Signed stable release, explicit update policy | Migration backup, schema compatibility check, rollback exercise and diagnostic version report |

Use a persistent outbox with event IDs, repository/principal/scope identifiers, monotonic source versions, bounded retries, backoff, and a dead-letter queue. Idempotence should be a storage invariant, not a prompt instruction. Separate the hot path (small local capture and retrieval) from optional expensive extraction or synthesis. Expose last captured, last processed, last indexed, and last synced times independently. A single green “connected” badge conceals too many different failures.

For client portability, publish a conformance matrix with **MCP tools**, **startup recall**, **automatic capture**, **compaction/exit flush**, **recovery after crash**, and **verified client version** as separate columns. Where hooks do not exist, show the reduced guarantee and provide explicit checkpoint actions. A client-neutral protocol cannot force every client to implement lifecycle hooks.

Suggested launch targets should be labeled targets until measured: local recall p95 ≤200 ms at 10,000 memories; ≥95% relevant durable-fact recall on a held-out project dataset; zero cross-scope disclosure in adversarial tests; zero acknowledged-write loss after crash/restart; and ≤5 seconds from ordinary file-save quiescence to a usable updated index on a declared reference repository. Publish hardware, memory count, graph size, concurrency, warm/cold state, and embedding mode with every latency number.

## Evaluation and claims discipline

Mem0's April 28, 2025 paper reports a 26% relative LLM-as-judge gain over the OpenAI memory baseline and 91% lower p95 latency / over 90% token reduction versus a full-context method. These have different baselines; they are vendor-authored results on LOCOMO, not evidence that Mem0 is 26% better than Knowledge Crib or that a current hosted release has identical performance. [Mem0 paper](https://arxiv.org/abs/2504.19413).

A fair Crib evaluation needs three suites: conversational persistence/temporal changes, repository graph correctness/freshness, and cross-client operational recovery. Measure answer correctness, false-memory admission, stale recall, scope leakage, resumed-task success, token cost, and update lag together. Latency alone can reward returning incomplete context. Benchmark any external baselines in a separately authorized fixture environment, never by violating this repository's memory-tool policy.

Do not publish “best memory tool” or “perfect persistent memory” until falsifiable tests support the intended workload. A credible initial promise is: **durable, inspectable project knowledge and work continuity across supported agents, with explicit ownership and source freshness**. Strengthen it through measured case studies: a bug fixed once and recalled by another IDE; a changed architecture decision invalidated automatically; a crash-safe handoff; and a privacy boundary that prevents one project's memory reaching another.

## Research limitations

Documentation was inspected as available on 2026-09-05; most feature pages do not provide a reliable publication date. Upstream default branches can contain unreleased changes, so production comparisons should pin release versions before implementation-level benchmarking. Old Letta URLs redirect to its newer MemFS documentation, and old Mem0 descriptions can differ from current Dream/add behavior. Those changes are why this report prefers present canonical pages and avoids relying on cached search summaries. No live account, paid governance feature, client integration, SLA, or zero-egress claim was verified through execution.
