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
      description: '360° context for one symbol: signature, callers, callees, and linked docs.',
      inputSchema: {
        id: z.string(),
        docLimit: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.context(a)),
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
