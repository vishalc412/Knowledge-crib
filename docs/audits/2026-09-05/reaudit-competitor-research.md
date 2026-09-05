# Knowledge Crib launch re-audit: current competitor evidence

Research date: 2026-09-05. Knowledge Crib audit anchor supplied by coordinating auditor: `3fa52e53`. Scope: primary-source web research only; no competing memory/code-context product was installed or invoked. This report establishes market expectations and proposed acceptance criteria; it does not certify Knowledge Crib implementation or competitor runtime performance.

## Assessment

The strongest launch position to investigate is **portable engineering memory whose claims remain attached to code, evidence, and unfinished intent across agent changes**. Local storage, MCP compatibility, Git versioning, and automatic capture are individually insufficient differentiators. Several competitors now document these capabilities. Knowledge Crib should compete on the complete user journey: remember a decision in one client, recover the correct next action in another, detect that its evidence changed, and explain what remains safe to reuse.

Do not publish “better than Mem0/GitNexus” from a feature checklist. These products solve overlapping but different problems, and this research did not execute a comparative benchmark. The capabilities below are documented contracts or vendor claims, with limitations identified explicitly.

## Mem0: memory infrastructure and agent integration

**Current ingestion behavior matters.** The platform's V3 add endpoint documents asynchronous, ADD-only extraction, returning an event identifier whose completion can be polled. It does not automatically UPDATE/DELETE existing memories in that pipeline. This differs from older descriptions of Mem0 consolidation. Separately, its OSS asynchronous API still documents explicit update, delete, and history operations. Pin the product/API version when comparing behavior. [V3 add reference](https://docs.mem0.ai/api-reference/memory/add-memories), [OSS AsyncMemory](https://docs.mem0.ai/open-source/features/async-memory).

The platform documents user, agent, application, and run scopes. Its entity-scoping page includes restrictive null/default behavior and a warning that some combined entity filters do not match the independently persisted records. This is a useful warning for Crib's usability design: an empty result must distinguish “no memory exists” from “the selected identity/scope cannot see it.” The page's examples and explanation are not entirely consistent, so this research does not prescribe an exact Mem0 filter implementation. [Entity-scoped memory](https://docs.mem0.ai/platform/features/entity-scoped-memory).

Current platform Graph Memory uses entity co-occurrence links to improve ranking alongside vectors and BM25. It is documented as native and always enabled, with interactive visualization restricted to Pro/Enterprise. It explicitly does not assign typed relationship labels. Consequently it should not be equated with a compiler-derived call graph, nor should old external-Neo4j configuration claims be presented as current platform requirements. [Graph Memory](https://docs.mem0.ai/platform/features/graph-memory).

Mem0 now documents a self-hosted dashboard with request logs, memory browsing, entity management, API-key controls, and configuration. Authentication is enabled by default. “Mem0's dashboard is cloud-only” is therefore not a defensible current comparison. These are documentation observations, not security testing. [Self-hosted setup](https://docs.mem0.ai/open-source/setup).

The current coding plugin documentation describes integrations for Codex, Cursor, Kimi, OpenCode, and Antigravity, and a separate current Claude Code plugin. Codex opt-in lifecycle hooks cover session bootstrap, relevant-memory injection, scope enforcement, turn-end reminders, and compaction capture. The README documents migration and duplicate-registration pitfalls, demonstrating that client compatibility is an ongoing operational obligation, not a one-time MCP configuration. [Current integration README](https://github.com/mem0ai/mem0/blob/main/integrations/mem0-plugin/README.md).

**OpenMemory qualification:** the historical OpenMemory overview URL redirected to the general Mem0 introduction, and its old README path returned 404 during this audit. A July issue describes OpenMemory as sunset while proposing self-hosted Cursor integration. That issue is not proof of a complete official support policy; treat historical OpenMemory claims as version-specific and compare current Mem0 OSS, self-hosted, platform, and plugin surfaces separately. [Integration issue #6370](https://github.com/mem0ai/mem0/issues/6370), [old overview redirect](https://docs.mem0.ai/openmemory/overview).

**Crib implications:** demonstrate minimal setup, transparent identity, memory browse/edit/export/recovery, observable write completion, and real client lifecycle capture. Merely having `memory_observe` callable does not prove a new agent will call it or recover its output.

## GitNexus: the code-intelligence competitor

GitNexus currently documents local persistent CLI/MCP indexes, a browser graph explorer, process-oriented hybrid retrieval, symbol context, impact, diff analysis, and repository groups. Its expanded surface includes route maps, tool maps, response-shape checks, API impact, and statement-level dependence/taint queries. It supports several coding clients and documents branch-specific indexes. These are stronger comparison targets than matching only `query`/`context`/`impact` names. [GitNexus README](https://github.com/abhigyanpatwari/GitNexus).

That README describes post-tool hooks which detect stale indexes after commits and prompt agents to reindex; this should not be described as a guaranteed continuous update daemon. An August 22 enhancement request for automatic incremental watch mode remained open when read. This is evidence of a requested capability and a qualified competitive opportunity, not proof that every released or enterprise edition lacks it. [Watch request #3030](https://github.com/abhigyanpatwari/GitNexus/issues/3030).

A closed issue documents a stale metadata banner after an out-of-process index refresh, separately from refreshed query data. Another closed issue describes stale MCP database connections after reindexing. These are historical reported regressions, not assertions that current GitNexus remains broken. They identify valuable Crib test cases: metadata and query readers must adopt the same generation, including during active sessions. [Metadata issue #2438](https://github.com/abhigyanpatwari/GitNexus/issues/2438), [connection issue #297](https://github.com/abhigyanpatwari/GitNexus/issues/297).

GitNexus's tool source explicitly labels partial diff-analysis results and warns that an empty result under failure is not a clean check. Honest incompleteness is therefore a shared competitive requirement. Crib should quantify unresolved edges and unsupported constructs instead of presenting graph size or distance-derived risk as completeness or safety. [MCP tool definitions](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/src/mcp/tools.ts).

**Crib implications:** compare supported semantics and measured task outcomes, not raw tool counts. Prioritize fresh reads across edits, commit/merge/rebase/branch changes, persistent MCP sessions, and concurrent index writers. A repository code graph and personal conversational memory are different products; neither proves superiority over the other.

## Letta: Git-backed memory is now a direct comparison

Current Letta documentation describes MemFS as Git-backed Markdown memory projected onto the current computer. Local edits become shared durable state after commit/push; local-only agents require operator backup. System memory is always in context, while other files are discovered through a tree and read when needed. MemFS has no default vector index; optional search extensions add keyword/semantic retrieval. This creates direct overlap with Crib's file ownership and versioning story. [MemFS](https://docs.letta.com/concepts/memfs).

The current Agent SDK offers persistent or temporary shared-repository attachments for Cloud agents. This is different from the older shared-memory-block model still visible under legacy V1 docs. Comparisons must name the generation. The current memory guide also states that self-hosted agents can use their own Git remote for shared memory. [Shared repositories](https://docs.letta.com/agent-sdk/repositories), [current memory model](https://docs.letta.com/agent-sdk/memory).

Letta documents background “dreaming” that reviews conversations and consolidates lessons. Users configure step-count or compaction triggers, and may enable a second agent review before applying proposals. Memory inspection and cleanup are exposed through a viewer and doctor workflow. This establishes a concrete expectation for automatic learning plus user-visible maintenance. [Memory and dreaming](https://docs.letta.com/configuration/memory).

**Crib implications:** emphasize durable identity independent of the client runtime and evidence-aware memory maintenance. Do not claim Git-backed memory alone is unique. Benchmark Crib's deterministic retrieval against file discovery for specific engineering tasks, including total prompt/tool tokens.

## Graphiti and Zep: evolving facts and enterprise boundaries

Graphiti documents incremental episode ingestion, time-qualified facts, invalidation that preserves history, provenance back to episodes, configurable ontology, and hybrid retrieval. It is an OSS framework requiring an operated backing store. Zep is the managed product with additional user/thread management, governance, SDKs, and dashboard; their capabilities should not be combined into one fictional free/local edition. Vendor latency/scalability claims are not independently measured here. [Graphiti repository](https://github.com/getzep/graphiti), [Zep/Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview).

Zep's enterprise access-control documentation separates human dashboard RBAC from policies governing agent API access. Policies can restrict actions and data attributes, operate in report-only or enforcement mode, and give denies precedence. This is a sharper enterprise bar than labeling records “team” or “private.” [Policy-based access control](https://help.getzep.com/policy-based-access-control), [governance](https://help.getzep.com/governance).

Zep's Memory MCP documentation binds personal graph access and project selection to authenticated identity, rather than model-selected identifiers. Enterprise standalone-graph policies apply to discovery and search; authorized filtering occurs before ranking/limits, and revocations affect the next operation. Writes also have independent gates. Default standalone access can be project-wide, so enterprise policy mode must not be assumed for every deployment. [Client connection](https://help.getzep.com/memory-mcp-server/connect), [standalone authorization](https://help.getzep.com/memory-mcp-server/standalone-graph-authorization).

Zep explicitly treats memory as untrusted decision evidence and recommends application-derived identity and provenance labels. Its July 29 changelog also records a fix extending attribute controls to update/delete paths. This provides concrete evidence that authorization must cover all mutation paths and derived artifacts, while avoiding the unsupported claim that the current service remains vulnerable. [Memory security](https://help.getzep.com/v3/memory-security), [July 29 changelog](https://help.getzep.com/changelog/2026/7/29).

**Crib implications:** code freshness and fact validity are separate clocks. A current code index can contain an outdated preference or decision; an unchanged memory file can have invalidated code evidence. Test both explicitly. For enterprise positioning, validate authenticated identity, tenant isolation, export/deletion, audit completeness, and revocation independently of provenance/trust scoring.

## Acceptance criteria to connect with the implementation audit

These are proposed product gates, not statements that Crib currently fails them.

| User outcome | Required demonstration | Measure |
| --- | --- | --- |
| Change AI client without losing intent | Client A checkpoints; B starts with a different session/client ID and recovers the same authorized intake | Correct continuation, ambiguity handling, no private-scope leakage |
| Keep memory current during coding | Create/edit/rename/delete, then merge/rebase/switch branch while an MCP reader stays connected | Event-to-query p50/p95, stale-read rate, graph/metadata generation agreement |
| Survive interruptions | Kill worker during write, restart, replay a duplicate event, fill disk, and retry | No acknowledged loss; idempotence; bounded backlog; understandable recovery |
| Remember the right truth | Supersede a decision and alter its source evidence; ask current and historical questions | Correct validity, provenance, abstention, contradiction disclosure |
| Share deliberately | Mix global preference, private repository detail, and approved team knowledge | Pre-ranking authorization; no leakage through counts, explanations, graph edges, or exports |
| Use memory without learning internals | Clean install, first capture, cross-client recovery, inspect/correct/forget | Time to first successful recall; task completion rate; useful error recovery |
| Establish retrieval advantage | Fixed code tasks and memory tasks with relevance judgments and equal budgets | Recall/precision, task success, total tokens, ingest/query cost, latency, degraded-mode behavior |
| Be operable | Observe accepted/pending/indexed/failed states and restore a backup | Completion receipts, queue age, restore correctness, published limitations |

The automatic-update design should expose separate state for capture, durable write, derived indexing, and reader adoption. A hook reporting success is insufficient if the write was merely queued, or if a running server still serves the prior generation. Preserve the last readable generation, serialize/coalesce writers, reconcile missed events, and make failure visible with one next recovery action.

## Launch recommendation

Publish a narrowly scoped evidence-backed launch before making universal enterprise claims. Lead with a reproducible cross-client engineering story and the exact support matrix. Establish separate evidence for local-first operation, cross-device sync, team sharing, agent identity, and enterprise authorization; none implies the others.

The defensible opportunity is a coherent workflow joining code-derived context, durable intent, evidence-qualified memory, and transparent recovery. Validate that combination in the coordinating implementation audit, then promote the measured outcomes. Leave comparative speed, accuracy, and “best” claims unclaimed until a reproducible, version-pinned, permitted benchmark supports them.

## Evidence limitations

All links were consulted on the research date. Official documentation and upstream source describe intended/current behavior, not independent operational assurance. Main-branch documentation can precede release artifacts; exact competitor release SHAs were not pinned. Search snippets occasionally reflected older product generations, so directly opened current pages were preferred. Competitor issue reports are labeled as reports and their observed open/closed state is time-sensitive. No comparative workload, hosted account, pricing estimate, or compliance certification was tested.
