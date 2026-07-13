import type { NodeKind } from '@knowledge-crib/soul-schema';
/**
 * The one MCP server (stdio). Each verb is registered as an MCP tool; handlers are thin adapters
 * over the pure {@link Verbs}. MCP TS SDK v1.29 (research §4.4: v1.x production line; v2 pre-alpha).
 * Enrichment (when configured) is never reachable from these deterministic verbs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
        docLimit: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
        withSource: z.boolean().optional(),
        withRules: z.boolean().optional(),
        withLlm: z.boolean().optional(),
        sourceMaxChars: z.number().int().positive().optional(),
        sourceMaxLines: z.number().int().positive().optional(),
        sourceStartLine: z.number().int().positive().optional(),
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
        maxChars: z.number().int().positive().optional(),
        maxLines: z.number().int().positive().optional(),
        startLine: z.number().int().positive().optional(),
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
        sourceMaxChars: z.number().int().positive().optional(),
        sourceMaxLines: z.number().int().positive().optional(),
        sourceStartLine: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
        withLlm: z.boolean().optional(),
        format: z.enum(['json', 'markdown']).optional(),
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
        maxSymbols: z.number().int().positive().optional(),
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
        maxSymbols: z.number().int().positive().optional(),
        sourceMaxChars: z.number().int().positive().optional(),
        sourceMaxLines: z.number().int().positive().optional(),
        format: z.enum(['json', 'markdown']).optional(),
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
        depth: z.number().int().positive().optional(),
        docLimit: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.impact(a)),
  );

  server.registerTool(
    'query',
    {
      description:
        'Hybrid BM25 search over code + docs, including rehydrated source bodies (WS-1: matches rule content, not just signatures). Returns { hits, llmHits, truncated }. `hits` are BM25-ranked symbols/docs each carrying a one-line snippet + a LIGHTWEIGHT LLM pointer (provenance/confidence/purpose) when an LLM analysis exists — this is the cheap default that keeps token cost low. `llmHits` are semantic discoveries from the LLM graph layer that BM25 missed, ranked by term-overlap, de-duplicated against `hits` (they never override BM25 ranking). Set withSource to fold the rehydrated source body into each hit, withRules to fold a callable decision table + coverage readiness, withFramework to fold routes/beans/DI/relations, and withLlm to upgrade the LLM pointer to the FULL analysis+graph+evidence blob. One query --with-source --with-rules --with-llm returns what a full file read + an LLM brief surfaces, but the default call stays tiny.',
      inputSchema: {
        q: z.string(),
        kinds: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
        withSource: z.boolean().optional(),
        sourceMaxChars: z.number().int().positive().optional(),
        sourceMaxLines: z.number().int().positive().optional(),
        withRules: z.boolean().optional(),
        withFramework: z.boolean().optional(),
        withLlm: z.boolean().optional(),
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
        }),
      ),
  );

  server.registerTool(
    'enrich_status',
    {
      description:
        'Coverage/progress for the agent-driven LLM semantic graph layer under .crib/llm. Pass scopes:true (with no scope) to get ranked path-prefix scopes + totalPending + threshold for the graphify-style scope picker. Pass scope:{pathPrefix} to restrict counts/nextLayer/done to in-scope targets (system layer is whole-repo only and reported via wholeRepoPending). The server never calls a model.',
      inputSchema: {
        layer: z.enum(['symbol', 'file', 'cluster', 'system']).optional(),
        scope: z
          .object({
            pathPrefix: z.string().optional(),
            cluster: z.string().optional(),
          })
          .optional(),
        scopes: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.enrichStatus(a)),
  );

  server.registerTool(
    'enrich_next',
    {
      description:
        'Return the next missing/stale grounded work batch for the IDE agent model to author. Includes seed facts, lower-layer analyses, schema, and instructions. Pass scope:{pathPrefix} to restrict the batch to in-scope targets. batchId is deterministic (same pending set => same id) so a zero-progress re-issue is detectable by id equality. The system layer is never offered under a scope. Pass skeleton:true with layer:"system" for the Phase-0.5 draft skeleton bible (a single work item seeded from the functional map + top READMEs + top symbols; a skeleton never satisfies the system layer — the full pass is still offered).',
      inputSchema: {
        layer: z.enum(['symbol', 'file', 'cluster', 'system']).optional(),
        limit: z.number().int().positive().optional(),
        scope: z
          .object({
            pathPrefix: z.string().optional(),
            cluster: z.string().optional(),
          })
          .optional(),
        skeleton: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.enrichNext(a)),
  );

  server.registerTool(
    'enrich_save',
    {
      description:
        'Validate and persist an IDE-agent-authored LLM semantic graph batch under .crib/llm.',
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
        limit: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.neighbors(a)),
  );

  server.registerTool(
    'shortest_path',
    {
      description: 'Shortest directed path between two nodes.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        maxHops: z.number().int().positive().optional(),
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
