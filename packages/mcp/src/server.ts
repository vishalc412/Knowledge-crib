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
export function buildServer(verbs: Verbs, version = '0.0.0'): McpServer {
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
        format: z.enum(['json', 'markdown']).optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.dossier(a)),
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
      description: 'Hybrid BM25 search over code + docs.',
      inputSchema: {
        q: z.string(),
        kinds: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (a) =>
      TOOL_RESULT(
        verbs.query({
          q: a.q,
          ...(a.kinds ? { kinds: a.kinds as NodeKind[] } : {}),
          ...(a.limit ? { limit: a.limit } : {}),
        }),
      ),
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
