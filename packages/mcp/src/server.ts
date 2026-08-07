import type { NodeKind } from '@knowledge-crib/soul-schema';
/**
 * The one MCP server (stdio). Each verb is registered as an MCP tool; handlers are thin adapters
 * over the pure {@link Verbs}. MCP TS SDK v1.29 (research §4.4: v1.x production line; v2 pre-alpha).
 * Enrichment (when configured) is never reachable from these deterministic verbs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MAX_DEPTH,
  MAX_DOC_LIMIT,
  MAX_FED_ROOTS,
  MAX_HOPS,
  MAX_LIMIT,
  MAX_MAX_TOKENS,
  MAX_SCOPE_SYMBOLS,
  MAX_SOURCE_CHARS,
  MAX_SOURCE_LINES,
} from './token-budget.js';
import type { Verbs } from './verbs.js';

const TOOL_RESULT = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
});

/** Build (but do not connect) the MCP server with all verbs registered. */
export function buildServer(verbs: Verbs, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: 'knowledge-crib', version });

  server.registerTool(
    'status',
    { description: 'Health + whether the project is indexed.', inputSchema: {} },
    async () => TOOL_RESULT(verbs.status()),
  );

  server.registerTool(
    'context',
    {
      description:
        '360° context for one symbol: deep fields, callers, callees, and linked docs. Set withSource to include the full source body (rehydrated from disk, budgeted) and withRules to fold in a procedure decision table (conditions/actions/reads/writes).',
      inputSchema: {
        id: z.string(),
        docLimit: z.number().int().positive().max(MAX_DOC_LIMIT).optional(),
        extractedOnly: z.boolean().optional(),
        withSource: z.boolean().optional(),
        withRules: z.boolean().optional(),
        withLlm: z.boolean().optional(),
        sourceMaxChars: z.number().int().positive().max(MAX_SOURCE_CHARS).optional(),
        sourceMaxLines: z.number().int().positive().max(MAX_SOURCE_LINES).optional(),
        sourceStartLine: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().max(MAX_MAX_TOKENS).optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.context(a)),
  );

  server.registerTool(
    'source',
    {
      description:
        'Full source text of one node span, rehydrated from disk and char/line-budgeted. Use this to read the actual code body / DDL / statement / doc-section that the lean soul references but never copies. truncated=true means the on-disk span exceeded the budget.',
      inputSchema: {
        id: z.string(),
        maxChars: z.number().int().positive().max(MAX_SOURCE_CHARS).optional(),
        maxLines: z.number().int().positive().max(MAX_SOURCE_LINES).optional(),
        startLine: z.number().int().positive().optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.source(a)),
  );

  server.registerTool(
    'dossier',
    {
      description:
        'One-shot deep reusable context for a symbol: deep node fields, paged rehydrated source body, callers, callees, linked docs, the decision table (callable), and the schema-1.2 control-flow constructs (raises / handles / iterates / declares). The artifact a migration analyst consumes in one call instead of orchestrating context + source + extract_rules. source.nextLine (when truncated) is the paging cursor — pass it back as sourceStartLine.',
      inputSchema: {
        id: z.string(),
        includeTables: z.boolean().optional(),
        sourceMaxChars: z.number().int().positive().max(MAX_SOURCE_CHARS).optional(),
        sourceMaxLines: z.number().int().positive().max(MAX_SOURCE_LINES).optional(),
        sourceStartLine: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
        withLlm: z.boolean().optional(),
        format: z.enum(['json', 'markdown']).optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.dossier(a)),
  );

  server.registerTool(
    'reconstruct',
    {
      description:
        'Package-scoped migration reconstruction: the package CONSTANT values (e.g. the 30/80 thresholds), every member callable with its implementation status, the union of tables the package reads/writes, docs linked to the package or its members, and the expected body file (Oracle spec→body inference). The artifact an agent hands a migrator in one call instead of orchestrating context over every member + gaps + extract_rules. Returns NOT_FOUND for an unknown id or a non-package node (use context/dossier for a single callable).',
      inputSchema: {
        id: z.string(),
        extractedOnly: z.boolean().optional(),
        includeTables: z.boolean().optional(),
        maxSymbols: z.number().int().positive().max(MAX_SCOPE_SYMBOLS).optional(),
        format: z.enum(['json', 'markdown']).optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.reconstruct(a)),
  );

  server.registerTool(
    'dossier_by_scope',
    {
      description:
        "Bulk per-symbol dossiers for EVERY symbol in a scope — a package's members, a file's symbols, or a cluster's symbols — in ONE call (the 1-scan-adjacency path). Each dossier carries the deep node, rehydrated source body, callers/callees, decision table, implementation status, and linked docs. Use this instead of orchestrating `dossier` over each of ~50 package members: one call returns all of them so a migration plan built from crib (Plan A) sees the same per-symbol detail a full code read (Plan B) sees. Returns NOT_FOUND when the scope node cannot be resolved. Honesty flags: symbolCount (total resolved), truncated (capped at maxSymbols), skipped (ids that resolved to no dossier). For a package, `id` is the id or qualified/simple name; for a file, the path (with or without the `file:` prefix); for a cluster, the slug.",
      inputSchema: {
        scope: z.enum(['package', 'file', 'cluster']),
        id: z.string(),
        extractedOnly: z.boolean().optional(),
        includeTables: z.boolean().optional(),
        maxSymbols: z.number().int().positive().max(MAX_SCOPE_SYMBOLS).optional(),
        sourceMaxChars: z.number().int().positive().max(MAX_SOURCE_CHARS).optional(),
        sourceMaxLines: z.number().int().positive().max(MAX_SOURCE_LINES).optional(),
        format: z.enum(['json', 'markdown']).optional(),
        cursor: z.string().optional(),
        maxTokens: z.number().int().positive().max(MAX_MAX_TOKENS).optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.dossierByScope(a)),
  );

  server.registerTool(
    'impact',
    {
      description:
        'Blast radius (up=dependents, down=dependencies) + docs describing affected nodes.',
      inputSchema: {
        id: z.string(),
        dir: z.enum(['up', 'down']),
        depth: z.number().int().positive().max(MAX_DEPTH).optional(),
        docLimit: z.number().int().positive().max(MAX_DOC_LIMIT).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        extractedOnly: z.boolean().optional(),
        includeLlm: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.impact(a)),
  );

  server.registerTool(
    'federatedImpact',
    {
      description:
        'M3.2 cross-repo blast radius. Like `impact` but federates extra repo souls (`roots`) and crosses the route-layer bridge: a repo-A outbound HTTP client call (`http-call` node) resolves to the repo-B `route` it serves, matched by {httpMethod, routePath}. No cross-repo edge is committed — the bridge is a runtime computation over the loaded souls. Each affected node carries `soul` (its repo root) + `crossRepo` (true iff the hop crossed repos). The primary repo (the server cwd) is always federated.',
      inputSchema: {
        id: z.string(),
        dir: z.enum(['up', 'down']),
        roots: z.array(z.string()).max(MAX_FED_ROOTS).optional(),
        depth: z.number().int().positive().max(MAX_DEPTH).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        extractedOnly: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.federatedImpact(a)),
  );

  server.registerTool(
    'query',
    {
      description:
        'Hybrid BM25 search over code + docs, including rehydrated source bodies (WS-1: matches rule content, not just signatures). Returns { hits, llmHits, truncated }. `hits` are BM25-ranked symbols/docs each carrying a one-line snippet + a LIGHTWEIGHT LLM pointer (provenance/confidence/purpose) when an LLM analysis exists — this is the cheap default that keeps token cost low. `llmHits` are semantic discoveries from the LLM graph layer that BM25 missed, ranked by term-overlap, de-duplicated against `hits` (they never override BM25 ranking). Set withSource to fold the rehydrated source body into each hit, withRules to fold a callable decision table + coverage readiness, withFramework to fold routes/beans/DI/relations, and withLlm to upgrade the LLM pointer to the FULL analysis+graph+evidence blob. One query --with-source --with-rules --with-llm returns what a full file read + an LLM brief surfaces, but the default call stays tiny.',
      inputSchema: {
        q: z.string(),
        kinds: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        extractedOnly: z.boolean().optional(),
        withSource: z.boolean().optional(),
        sourceMaxChars: z.number().int().positive().max(MAX_SOURCE_CHARS).optional(),
        sourceMaxLines: z.number().int().positive().max(MAX_SOURCE_LINES).optional(),
        withRules: z.boolean().optional(),
        withFramework: z.boolean().optional(),
        withLlm: z.boolean().optional(),
        cursor: z.string().optional(),
        maxTokens: z.number().int().positive().max(MAX_MAX_TOKENS).optional(),
      },
    },
    async (a) =>
      TOOL_RESULT(
        verbs.query({
          q: a.q,
          ...(a.kinds ? { kinds: a.kinds as NodeKind[] } : {}),
          ...(a.limit ? { limit: a.limit } : {}),
          ...(a.extractedOnly !== undefined ? { extractedOnly: a.extractedOnly } : {}),
          ...(a.withSource !== undefined ? { withSource: a.withSource } : {}),
          ...(a.sourceMaxChars ? { sourceMaxChars: a.sourceMaxChars } : {}),
          ...(a.sourceMaxLines ? { sourceMaxLines: a.sourceMaxLines } : {}),
          ...(a.withRules !== undefined ? { withRules: a.withRules } : {}),
          ...(a.withFramework !== undefined ? { withFramework: a.withFramework } : {}),
          ...(a.withLlm !== undefined ? { withLlm: a.withLlm } : {}),
          ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
          ...(a.maxTokens !== undefined ? { maxTokens: a.maxTokens } : {}),
        }),
      ),
  );

  server.registerTool(
    'enrich_status',
    {
      description:
        'Coverage/progress for agent-driven semantic layer under .crib/graph/semantic. Pass scopes:true (with no scope) to get ranked path-prefix scopes + totalPending + threshold. Pass scope:{pathPrefix} to restrict counts/nextLayer/done. Pass targets:[ids] to restrict counts to a delta re-issue set (mutually exclusive with scope/scopes). Server never calls a model.',
      inputSchema: {
        layer: z.enum(['symbol', 'file', 'cluster', 'system']).optional(),
        scope: z
          .object({
            pathPrefix: z.string().optional(),
            cluster: z.string().optional(),
          })
          .optional(),
        scopes: z.boolean().optional(),
        targets: z.array(z.string()).optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.enrichStatus(a)),
  );

  server.registerTool(
    'enrich_next',
    {
      description:
        'Return the next missing/stale grounded work batch for the IDE agent model to author. Includes seed facts, lower-layer analyses, schema, and instructions. Pass scope:{pathPrefix} to restrict the batch to in-scope targets. Pass targets:[ids] to restrict the queue to a delta re-issue set (from semantic_delta.reissueTargets); a targeted re-issue is namespaced apart from the unscoped queue for zero-progress detection. batchId is deterministic (same pending set => same id) so a zero-progress re-issue is detectable by id equality. The system layer is never offered under a scope. Pass skeleton:true with layer:"system" for the Phase-0.5 draft skeleton bible (a single work item seeded from the functional map + top READMEs + top symbols; a skeleton never satisfies the system layer — the full pass is still offered).',
      inputSchema: {
        layer: z.enum(['symbol', 'file', 'cluster', 'system']).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        scope: z
          .object({
            pathPrefix: z.string().optional(),
            cluster: z.string().optional(),
          })
          .optional(),
        skeleton: z.boolean().optional(),
        targets: z.array(z.string()).optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.enrichNext(a)),
  );

  server.registerTool(
    'enrich_save',
    {
      description:
        'Validate and persist an IDE-agent-authored semantic graph batch under .crib/graph/semantic.',
      inputSchema: {
        batchId: z.string(),
        items: z.array(
          z.object({
            targetId: z.string(),
            model: z.string().optional(),
            analysis: z.record(z.string(), z.unknown()),
            graph: z.object({
              nodes: z.array(z.record(z.string(), z.unknown())),
              edges: z.array(z.record(z.string(), z.unknown())),
            }),
            evidence: z.array(z.record(z.string(), z.unknown())),
          }),
        ),
      },
    },
    async (a) => TOOL_RESULT(verbs.enrichSave(a)),
  );

  server.registerTool(
    'semantic_delta',
    {
      description:
        "Semantic-layer delta report (+ optional prune) — the explicit companion to crib update's silent orphan auto-prune. Scans persisted LLM artifacts, classifies each as orphaned (target node gone) / stale (hash mismatch) / drifted (grounding verdict changed, only with verifyDrift), and returns `reissueTargets` to pass to enrich_next/enrich_status `targets` to re-author exactly the flagged set. Two scoping modes: `targets:[ids]` scans only those ids; `since:<ref>` computes the changed symbols/files via VCS and scopes the scan to them; neither scans the whole repo. Non-destructive by default: `prune:true` deletes orphans (safe), `pruneStale:true` also deletes stale-but-present (destructive — discards old evidence). Bumps generation.semantic only when a file was deleted. PURE over the soul — never calls a model.",
      inputSchema: {
        since: z.string().optional(),
        targets: z.array(z.string()).optional(),
        prune: z.boolean().optional(),
        pruneStale: z.boolean().optional(),
        verifyDrift: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.semanticDelta(a)),
  );

  server.registerTool(
    'audit_llm',
    {
      description:
        "Re-verify every persisted LLM artifact on disk against the current soul (M1.3 — the grounding moat). Re-runs the save-time grounding check: rehydrates each evidence quote's anchor span and requires overlap. A post-refactor re-verify is identical to the original verdict. PURE — never calls a model, never mutates artifacts. Returns per-target verdicts (grounded/ungrounded/unsupported), drift (save-time stamp vs recomputed), and staleness. Use after a refactor or index rebuild to confirm the LLM graph is still traceable to disk.",
      inputSchema: {},
    },
    async () => TOOL_RESULT(verbs.auditLlm()),
  );

  server.registerTool(
    'overview',
    {
      description:
        'Return the LLM-authored codebase bible / overview generated from the semantic graph layer. v2: module-segmented, importance-ranked, LEAN by default — `modules` (always present, works at 0% enrichment), `analyses` (lean pointers, production symbols first / test helpers last), and `system` (the freshest bible, full preferred over a draft skeleton). Pass withLlm:true to fold the full analysis+graph+evidence blobs into a `full` array (computed live, never cached). Pass scope:{pathPrefix} for a module-scoped bible (excludes the whole-repo system layer); omit scope for the cached whole-repo overview.json.',
      inputSchema: {
        scope: z
          .object({
            pathPrefix: z.string().optional(),
            cluster: z.string().optional(),
          })
          .optional(),
        withLlm: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.overview(a)),
  );

  server.registerTool(
    'llm_neighbors',
    {
      description:
        'Walk the LLM semantic graph around a soul id or LLM local/global node id: rules, features, flows, capabilities, and concepts touching it.',
      inputSchema: { id: z.string() },
    },
    async (a) => TOOL_RESULT(verbs.llmNeighbors(a)),
  );

  server.registerTool(
    'describes',
    {
      description: 'The doc-sections linked to a symbol (cheap, high value).',
      inputSchema: {
        id: z.string(),
        minConfidence: z.number().min(0).max(1).optional(),
        extractedOnly: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.describes(a)),
  );

  server.registerTool(
    'neighbors',
    {
      description: 'Raw adjacency for a node (graph-walking primitive).',
      inputSchema: {
        id: z.string(),
        rel: z.string().optional(),
        dir: z.enum(['in', 'out', 'both']).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        extractedOnly: z.boolean().optional(),
        includeLlm: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.neighbors(a)),
  );

  server.registerTool(
    'ownership',
    {
      description:
        'M3.1 ownership: the git-blame owners of a node (symbol → owner), answering "who do I ask about this code". Returns owner nodes + the blame commit + the HEAD the index ran against.',
      inputSchema: {
        id: z.string(),
      },
    },
    async (a) => TOOL_RESULT(verbs.ownership(a)),
  );

  server.registerTool(
    'shortest_path',
    {
      description: 'Shortest directed path between two nodes.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        maxHops: z.number().int().positive().max(MAX_HOPS).optional(),
        includeLlm: z.boolean().optional(),
        extractedOnly: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.shortestPath(a)),
  );

  server.registerTool(
    'detect_changes',
    {
      description: 'Dry-run delta report since a git ref (completed at M6).',
      inputSchema: { since: z.string().optional() },
    },
    async (a) => TOOL_RESULT(verbs.detectChanges(a)),
  );

  server.registerTool(
    'extract_rules',
    {
      description:
        'Walk a procedure guard-annotated CFG (M11) and materialize its decision table / rule records.',
      inputSchema: {
        procedure: z.string(),
        includeTables: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.extractRules(a)),
  );

  server.registerTool(
    'gaps',
    {
      description:
        'Missing-asset + unimplemented-symbol detection over the soul. Returns unimplemented procedures (declared, no body / no executes edges), package specs with no body file (e.g. a .pks present but .pkb absent — the migration-critical "body is missing" signal), and unresolved call sites (calls into symbols that do not exist in the crib; Oracle built-ins flagged). Use this to confirm whether a package body or implementation is actually present before trusting the graph for line-level migration.',
      inputSchema: {
        extractedOnly: z.boolean().optional(),
        includeBuiltins: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.gaps(a)),
  );

  // ─── W3 trusted-agent-memory verbs (PRD lines 226–248) ─────────────────────────────────────
  // `brief`         — the one-call typed-group retrieval: code BM25 hits + doc instructions + trusted
  //                   memories as SEPARATE groups (code + memory scores are never fused — PRD 333).
  // `memory_recall` — ranked eligible memories (default limit 5, max 20, default budget 1200), team +
  //                   local + applicable-global; conflicting claims appear together.
  // `memory_observe` — writes a LOCAL candidate only (never evaluates / executes / team-writes).
  // `memory_get`    — one record by id (+ optional full evidence).
  // `memory_status` — counts by trust / evidence / applicability / lifecycle / source + pending.
  // `memory_audit`  — read-only drift / conflict / privacy / trust + contradicted-for-review report.
  // `memory_feedback` — write a LOCAL feedback signal; a `contradicted` signal quarantines locally
  //                    only with admissible counter-evidence (one negative event never retracts team).
  // All read APIs support `ifHash` (a repeat collapses to `{ unchanged: true, hash }`). When no memory
  // ledger is configured the memory verbs degrade to `{ memory: 'not configured' }` (mirrors `vcs`).
  server.registerTool(
    'brief',
    {
      description:
        'W3 — the one-call typed-group retrieval. Returns code BM25 hits, doc-section instructions, and trusted memories as SEPARATE typed groups (code + memory scores are never fused). `codeHits`+`instructions` come from one BM25 scan over the soul index (partitioned by kind); `memories`+`conflicts` come from the memory recall projection (criterion-1 lexical via the separate memory FTS, ranked by the 6-criterion comparator). `cursor` pages the code BM25 offset; `maxTokens` (default 2000) trims the combined payload. `ifHash` collapses a repeat to ~30 bytes.',
      inputSchema: {
        q: z.string(),
        paths: z.array(z.string()).optional(),
        targetIds: z.array(z.string()).optional(),
        sources: z.array(z.enum(['team', 'local', 'global'])).optional(),
        maxTokens: z.number().int().positive().optional(),
        cursor: z.string().optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.brief(a)),
  );

  server.registerTool(
    'memory_recall',
    {
      description:
        'W3 — recall trusted memory. Default limit 5, max 20, default token budget 1200; team + local + applicable-global sources. Normal recall never returns invalid / orphaned / superseded / retracted / pending records; conflicting claims appear together. Default view = evidence summaries + pointers; full evidence opt-in via withEvidence. Supports ifHash.',
      inputSchema: {
        q: z.string().optional(),
        targetIds: z.array(z.string()).optional(),
        sources: z.array(z.enum(['team', 'local', 'global'])).optional(),
        limit: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        withEvidence: z.boolean().optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.memoryRecall(a)),
  );

  server.registerTool(
    'memory_observe',
    {
      description:
        "W4 — write a LOCAL candidate only (PRD: the MCP server never evaluates, executes a gate, or writes team memory). Stages an untrusted, content-addressed candidate in the local `candidates` collection; a repeat observation of the same claim upserts to the same id (idempotent). Promotion to a trusted record is a separate CLI/CI step (`crib memory evaluate`/`activate`/`propose`). Degrades to `{ memory: 'not configured' }` when no local store is wired. The repoId for a repo-scoped claim is resolved from the soul manifest / registry.",
      inputSchema: {
        kind: z.enum(['fact', 'procedure', 'decision', 'pitfall', 'convention']),
        subject: z.string(),
        claim: z.string(),
        appliesTo: z.array(z.string()).optional(),
        evidence: z.array(z.record(z.string(), z.unknown())).optional(),
        actor: z.string(),
        authorKind: z.enum(['agent', 'human']).optional(),
        tool: z.string().optional(),
        scopeBoundary: z.enum(['repo', 'global']).optional(),
        attemptId: z.string().optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.memoryObserve(a)),
  );

  server.registerTool(
    'memory_get',
    {
      description:
        'W3 — fetch one memory record by id: the full record + effective verdicts + store source. Evidence is returned as summaries by default (kind + verdict + soul anchor); the full evidence array is opt-in via withEvidence. Searches team `records`, local `active`, then global `records`. Supports ifHash.',
      inputSchema: {
        id: z.string(),
        withEvidence: z.boolean().optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.memoryGet(a)),
  );

  server.registerTool(
    'memory_status',
    {
      description:
        'W3 — memory ledger status: counts by trust / evidence / applicability / lifecycle / source, plus eligible (recall-eligible), quarantined, and pending (local candidate entries not yet promoted to active records). provenance.fresh = true means the counts reflect a live revalidation against the soul. Supports ifHash.',
      inputSchema: { ifHash: z.string().optional() },
    },
    async (a) => TOOL_RESULT(verbs.memoryStatus(a)),
  );

  server.registerTool(
    'memory_audit',
    {
      description:
        'W3 — read-only memory audit: a validation / conflict / drift / privacy / trust report. validation.drift lists records whose fresh evidence/applicability verdict differs from the stamped one; conflicts lists the conflict groups; privacy re-runs the write-time secret scan on every record; trust is the trust distribution; feedback.quarantined counts records excluded from recall by a local quarantine, and feedback.contradictedForReview lists `contradicted` feedback whose subject was NOT suppressed (bounded penalty only — awaiting admissible counter-evidence). Read-only: never mutates a record, decision, or store. Supports ifHash.',
      inputSchema: { ifHash: z.string().optional() },
    },
    async (a) => TOOL_RESULT(verbs.memoryAudit(a)),
  );

  server.registerTool(
    'memory_feedback',
    {
      description:
        'W5 — write a LOCAL feedback signal (useful / unhelpful / contradicted) on a memory record by id (PRD line 241: "Writes a local feedback event; one negative event cannot retract team memory"). For a `contradicted` signal, the record is quarantined LOCALLY only when supported by admissible counter-evidence (a counterEvidence item whose kind is admissible for the record claim kind and whose verdict is valid — PRD W5 line 361); otherwise it keeps a bounded penalty and is surfaced for review via memory_audit. The quarantine decision is local-only — team memory is never retracted by a single local negative event. Content-addressed → idempotent. Degrades to `{ memory: \'not configured\' }` when no local store is wired.',
      inputSchema: {
        subject: z.string(),
        signal: z.enum(['useful', 'unhelpful', 'contradicted']),
        actor: z.string(),
        context: z.string().optional(),
        counterEvidence: z.array(z.record(z.string(), z.unknown())).optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.memoryFeedback(a)),
  );

  server.registerTool(
    'stats',
    {
      description:
        'M3.3 server observability — live per-verb call counts + latency (min/mean/max) and the ifHash change-aware cache hit rate for this running process. Pure runtime counters; not persisted, not part of the deterministic soul. Useful for capacity tuning and cache-effectiveness checks.',
      inputSchema: {},
    },
    async () => TOOL_RESULT(verbs.getStats().snapshot()),
  );

  return server;
}

/**
 * Connect the server to a stdio transport (the `crib serve` runtime) and BLOCK until the client
 * disconnects (stdin EOF). {@link McpServer.connect} resolves as soon as the transport starts
 * listening — it does NOT keep the process alive by itself. The CLI wrapper calls `process.exit`
 * once `main()` resolves, so without blocking here the server would be killed before it could
 * answer a single request. We wait on stdin's `end`/`close` so the process lives exactly as long
 * as the client keeps the connection open.
 */
export async function serveStdio(verbs: Verbs, version = '0.0.0'): Promise<void> {
  const server = buildServer(verbs, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
}
