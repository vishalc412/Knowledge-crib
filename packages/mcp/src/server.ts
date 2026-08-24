import { createServer } from 'node:http';
import type { NodeKind } from '@knowledge-crib/soul-schema';
/**
 * The one MCP server (stdio). Each verb is registered as an MCP tool; handlers are thin adapters
 * over the pure {@link Verbs}. MCP TS SDK v1.29 (research §4.4: v1.x production line; v2 pre-alpha).
 * Enrichment (when configured) is never reachable from these deterministic verbs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

/** Uniform argument-validation failure for the `op` dispatchers below. A dispatcher can otherwise
 *  forward an under-specified call to a verb and return a plausible-but-wrong payload. */
const BAD_REQUEST = (message: string) => ({ error: { code: 'BAD_REQUEST', message } });

/** Build (but do not connect) the MCP server with all verbs registered. */
export function buildServer(verbs: Verbs, version = '0.1.0'): McpServer {
  const server = new McpServer({ name: 'knowledge-crib', version });

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
    'query',
    {
      description:
        'Keyword search over code + docs, including source bodies, so rule CONTENT matches and not just names. Prefer brief for questions; use query when you want raw ranked hits or the opt-in folds. Returns { hits, llmHits, truncated }; each hit has a one-line snippet plus a lightweight LLM pointer when analysis exists. llmHits are semantic finds BM25 missed. Opt in with withSource (full body), withRules (decision table), withFramework (routes/DI), withLlm (full analysis). Defaults stay small.',
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
    'overview',
    {
      description:
        'The codebase overview built from the semantic layer. Lean by default: modules (always present, works at 0% enrichment), analyses (pointers, production symbols first), and system (the freshest bible). withLlm:true folds in the full analyses; scope:{pathPrefix} gives a module-scoped view.',
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
        "START HERE for any question about this codebase - ask it before reading files. Searches BOTH the code and the AUTHORED MEANING layer, then interleaves them, so a conceptual question ('how do I debug a parser that hangs') finds the module that answers it even when they share no words. Returns code hits, doc-section instructions and trusted memories as SEPARATE typed groups. Each hit carries a one-line snippet plus `grounding` (semantic = authored purpose is in `llm`; if `inherited` is set that purpose describes the owning file/cluster named in `via`, NOT the hit itself) and `semanticMatch` when authored meaning RANKED it rather than merely decorating it. Two self-reports: `coverage` = share of hits carrying prose; `retrieval.matched` = share the semantic layer actually found - the honest signal, since coverage saturates once most files are described. `cursor` pages; `maxTokens` (default 2000) trims; `ifHash` collapses a repeat to ~30 bytes.",
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
        "Recall trusted team/local/global memory. Default limit 5 (max 20), token budget 1200. Never returns invalid, superseded, retracted or pending records; conflicting claims come back together so the disagreement is visible. Evidence is summarised unless withEvidence. `includePending: true` adds a SEPARATE `pending` group of untrusted, in-flight observations from other agents on this repo - the shared working set for a swarm. They are never merged into `memories`, and each is stamped trust:'untrusted'/status:'pending': treat them as leads, not facts.",
      inputSchema: {
        q: z.string().optional(),
        targetIds: z.array(z.string()).optional(),
        sources: z.array(z.enum(['team', 'local', 'global'])).optional(),
        limit: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        withEvidence: z.boolean().optional(),
        includePending: z.boolean().optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.memoryRecall(a)),
  );

  server.registerTool(
    'memory_observe',
    {
      description:
        "Stage a LOCAL memory candidate. Never writes team memory and never evaluates it - promotion is a separate CLI/CI step (crib memory evaluate/activate/propose). Re-observing the same claim upserts the same id. Returns { memory: 'not configured' } when no local store is wired.",
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

  // One dispatcher instead of four near-identical tools (memory_get / memory_status / memory_audit /
  // memory_feedback). Each carried its own name, description and schema in the tool list every
  // session; folding them behind `op` removes that fixed cost without losing any capability.
  // `memory_recall` and `memory_observe` stay standalone: they are the two verbs the installed
  // client protocol names directly, and renaming them would break existing agent instructions.
  server.registerTool(
    'memory',
    {
      description:
        'Memory ledger operations, selected by `op`. get: one record by id (needs id; withEvidence for full evidence). status: ledger counts by trust/evidence/lifecycle plus recall-eligible, quarantined, and pending. audit: read-only health report - drifted verdicts, conflict groups, a secret re-scan, trust distribution, locally quarantined records. feedback: record LOCAL feedback on a record (needs subject, signal, actor); a `contradicted` signal quarantines only when backed by admissible counterEvidence, and never retracts team memory. To READ memory for a task use `memory_recall`; to WRITE a new claim use `memory_observe`.',
      inputSchema: {
        op: z.enum(['get', 'status', 'audit', 'feedback']),
        id: z.string().optional(),
        withEvidence: z.boolean().optional(),
        subject: z.string().optional(),
        signal: z.enum(['useful', 'unhelpful', 'contradicted']).optional(),
        actor: z.string().optional(),
        context: z.string().optional(),
        counterEvidence: z.array(z.record(z.string(), z.unknown())).optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => {
      switch (a.op) {
        case 'get':
          if (!a.id)
            return TOOL_RESULT({ error: { code: 'BAD_REQUEST', message: 'op=get requires id' } });
          return TOOL_RESULT(
            verbs.memoryGet({
              id: a.id,
              ...(a.withEvidence !== undefined ? { withEvidence: a.withEvidence } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        case 'status':
          return TOOL_RESULT(
            verbs.memoryStatus({ ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}) }),
          );
        case 'audit':
          return TOOL_RESULT(
            verbs.memoryAudit({ ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}) }),
          );
        case 'feedback': {
          if (!a.subject || !a.signal || !a.actor)
            return TOOL_RESULT({
              error: {
                code: 'BAD_REQUEST',
                message: 'op=feedback requires subject, signal, and actor',
              },
            });
          return TOOL_RESULT(
            verbs.memoryFeedback({
              subject: a.subject,
              signal: a.signal,
              actor: a.actor,
              ...(a.context !== undefined ? { context: a.context } : {}),
              ...(a.counterEvidence !== undefined ? { counterEvidence: a.counterEvidence } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        }
      }
    },
  );

  // ---------------------------------------------------------------------------------------------
  // Dispatchers. Each of these replaced a family of near-identical tools that differed only in
  // which verb they called. Every tool in the list costs name + description + JSON schema in the
  // tool list of EVERY session, whether or not it is used, so a family of five rarely-used tools is
  // a permanent tax on every conversation. Folding them behind `op` keeps every capability while
  // paying for one entry instead of five.
  //
  // `brief`, `context`, `query`, `source`, `detect_changes`, `memory_recall` and `memory_observe`
  // stay standalone: they are the verbs reached for constantly, or named directly by the installed
  // client protocol / project instructions, where an extra `op` would be friction or breakage.
  // ---------------------------------------------------------------------------------------------

  server.registerTool(
    'enrich',
    {
      description:
        "Drive the agent-authored semantic layer, selected by `op`. The server NEVER calls a model — you author the content. status: coverage + progress; `scopes:true` ranks path-prefix scopes to choose from, `scope:{pathPrefix}` restricts counts, and `gate` reports the symbol-importance cut that makes `done` honest. next: the next batch of targets to author, with seed facts, lower-layer analyses, output schema and instructions; `batchId` is deterministic, so the same batchId twice means nothing was authored in between. Long caller/callee lists are sampled — `callersTotal`/`calleesTotal` give the true count. save: validate + persist authored items (needs batchId + items); rejected items stay pending and are re-offered. delta: classify persisted artifacts as orphaned/stale/drifted and return `reissueTargets`; non-destructive unless prune/pruneStale. audit: re-verify every artifact's evidence against current code and report grounded/ungrounded/unsupported.",
      inputSchema: {
        op: z.enum(['status', 'next', 'save', 'delta', 'audit']),
        layer: z.enum(['symbol', 'file', 'cluster', 'system']).optional(),
        scope: z.record(z.string(), z.unknown()).optional(),
        scopes: z.boolean().optional(),
        targets: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
        skeleton: z.boolean().optional(),
        batchId: z.string().optional(),
        items: z.array(z.record(z.string(), z.unknown())).optional(),
        since: z.string().optional(),
        prune: z.boolean().optional(),
        pruneStale: z.boolean().optional(),
        verifyDrift: z.boolean().optional(),
      },
    },
    async (a) => {
      const { op, ...rest } = a as Record<string, unknown> & { op: string };
      switch (op) {
        case 'status':
          return TOOL_RESULT(verbs.enrichStatus(rest as never));
        case 'next':
          return TOOL_RESULT(verbs.enrichNext(rest as never));
        case 'save':
          if (!a.batchId || !a.items)
            return TOOL_RESULT(BAD_REQUEST('op=save requires batchId and items'));
          return TOOL_RESULT(verbs.enrichSave(rest as never));
        case 'delta':
          return TOOL_RESULT(verbs.semanticDelta(rest as never));
        case 'audit':
          return TOOL_RESULT(verbs.auditLlm());
        default:
          return TOOL_RESULT(BAD_REQUEST(`unknown op ${op}`));
      }
    },
  );

  server.registerTool(
    'impact',
    {
      description:
        'Blast radius and reachability, selected by `op`. blast (default): what breaks if `id` changes — `dir` up = dependents, down = dependencies; carries the docs that describe the changed symbol. federated: the same walk across MULTIPLE repos (`roots`), following an outbound HTTP call to the route that serves it; each node carries `soul` and `crossRepo`. path: the shortest dependency path between `from` and `to`. owners: which files/modules own `id`. Run blast BEFORE editing any symbol.',
      inputSchema: {
        op: z.enum(['blast', 'federated', 'path', 'owners']).optional(),
        id: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        dir: z.enum(['up', 'down']).optional(),
        roots: z.array(z.string()).max(MAX_FED_ROOTS).optional(),
        depth: z.number().int().positive().max(MAX_DEPTH).optional(),
        maxHops: z.number().int().positive().max(MAX_HOPS).optional(),
        docLimit: z.number().int().positive().max(MAX_DOC_LIMIT).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        extractedOnly: z.boolean().optional(),
        includeLlm: z.boolean().optional(),
      },
    },
    async (a) => {
      const { op, ...rest } = a as Record<string, unknown> & { op?: string };
      switch (op ?? 'blast') {
        case 'blast':
          if (!a.id) return TOOL_RESULT(BAD_REQUEST('op=blast requires id'));
          return TOOL_RESULT(verbs.impact(rest as never));
        case 'federated':
          if (!a.id) return TOOL_RESULT(BAD_REQUEST('op=federated requires id'));
          return TOOL_RESULT(verbs.federatedImpact(rest as never));
        case 'path':
          if (!a.from || !a.to) return TOOL_RESULT(BAD_REQUEST('op=path requires from and to'));
          return TOOL_RESULT(verbs.shortestPath(rest as never));
        case 'owners':
          if (!a.id) return TOOL_RESULT(BAD_REQUEST('op=owners requires id'));
          return TOOL_RESULT(verbs.ownership(rest as never));
        default:
          return TOOL_RESULT(BAD_REQUEST(`unknown op ${op}`));
      }
    },
  );

  server.registerTool(
    'dossier',
    {
      description:
        'Deep reusable context, selected by `op`. one (default): everything about ONE symbol in a call — deep node fields, paged source body, callers, callees, linked docs, decision table, control flow. `source.nextLine` is the paging cursor; pass it back as sourceStartLine. package: everything about one PACKAGE — constant values, every member with implementation status, tables read/written, docs, expected body file. scope: bulk dossiers for EVERY symbol in a package/file/cluster in ONE call (use instead of looping over ~50 members); honesty flags symbolCount, truncated, skipped.',
      inputSchema: {
        op: z.enum(['one', 'package', 'scope']).optional(),
        id: z.string(),
        scope: z.enum(['package', 'file', 'cluster']).optional(),
        includeTables: z.boolean().optional(),
        maxSymbols: z.number().int().positive().max(MAX_SCOPE_SYMBOLS).optional(),
        sourceMaxChars: z.number().int().positive().max(MAX_SOURCE_CHARS).optional(),
        sourceMaxLines: z.number().int().positive().max(MAX_SOURCE_LINES).optional(),
        sourceStartLine: z.number().int().positive().optional(),
        extractedOnly: z.boolean().optional(),
        withLlm: z.boolean().optional(),
        format: z.enum(['json', 'markdown']).optional(),
        cursor: z.string().optional(),
        maxTokens: z.number().int().positive().max(MAX_MAX_TOKENS).optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => {
      const { op, ...rest } = a as Record<string, unknown> & { op?: string };
      switch (op ?? 'one') {
        case 'one':
          return TOOL_RESULT(verbs.dossier(rest as never));
        case 'package':
          return TOOL_RESULT(verbs.reconstruct(rest as never));
        case 'scope':
          if (!a.scope)
            return TOOL_RESULT(
              BAD_REQUEST("op=scope requires scope: 'package' | 'file' | 'cluster'"),
            );
          return TOOL_RESULT(verbs.dossierByScope(rest as never));
        default:
          return TOOL_RESULT(BAD_REQUEST(`unknown op ${op}`));
      }
    },
  );

  server.registerTool(
    'neighbors',
    {
      description:
        'One hop out from `id`, selected by `op`. edges (default): adjacent soul nodes, filterable by `rel` and `dir`. llm: neighbours in the agent-authored semantic graph instead of the extracted one. describes: the doc sections that document `id`, with confidence and provenance.',
      inputSchema: {
        op: z.enum(['edges', 'llm', 'describes']).optional(),
        id: z.string(),
        rel: z.string().optional(),
        dir: z.enum(['in', 'out', 'both']).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        minConfidence: z.number().optional(),
        extractedOnly: z.boolean().optional(),
        includeLlm: z.boolean().optional(),
      },
    },
    async (a) => {
      const { op, ...rest } = a as Record<string, unknown> & { op?: string };
      switch (op ?? 'edges') {
        case 'edges':
          return TOOL_RESULT(verbs.neighbors(rest as never));
        case 'llm':
          return TOOL_RESULT(verbs.llmNeighbors(rest as never));
        case 'describes':
          return TOOL_RESULT(verbs.describes(rest as never));
        default:
          return TOOL_RESULT(BAD_REQUEST(`unknown op ${op}`));
      }
    },
  );

  server.registerTool(
    'status',
    {
      description:
        'Server and graph state, selected by `op`. health (default): is the project indexed. stats: live per-verb call counts, latency and ifHash cache hit rate for this process (in-memory only). gaps: what the graph is MISSING — procedures declared with no body, package specs whose body file is absent, and call sites pointing at symbols the crib has never seen. Check gaps before trusting the graph for line-level work.',
      inputSchema: {
        op: z.enum(['health', 'stats', 'gaps']).optional(),
        extractedOnly: z.boolean().optional(),
        includeBuiltins: z.boolean().optional(),
      },
    },
    async (a) => {
      const { op, ...rest } = a as Record<string, unknown> & { op?: string };
      switch (op ?? 'health') {
        case 'health':
          return TOOL_RESULT(verbs.status());
        case 'stats':
          return TOOL_RESULT(verbs.getStats().snapshot());
        case 'gaps':
          return TOOL_RESULT(verbs.gaps(rest as never));
        default:
          return TOOL_RESULT(BAD_REQUEST(`unknown op ${op}`));
      }
    },
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
/**
 * Shared-daemon mode: ONE process holds the graph, many agents connect over HTTP.
 *
 * Why this exists. The stdio transport is one process per client, and each loads the full graph:
 * measured on this repo, 213 MB and ~450ms of startup EACH. A swarm of 400 agents would therefore
 * need ~83 GB of RAM to do nothing but hold 400 identical copies of the same graph — more than the
 * machine has. Sharing one instance is not an optimisation here; it is the difference between the
 * swarm being possible and impossible.
 *
 * Stateless by construction (`sessionIdGenerator: undefined`): every request carries everything it
 * needs, so agents may connect, disconnect and reconnect freely, and one crashed agent leaves no
 * server-side state behind to leak or to confuse the next one. A fresh transport and server object
 * per request keeps concurrent callers isolated from each other's streams while they continue to
 * share the single expensive thing — the graph held in `verbs`.
 *
 * Binds to loopback by default: the graph contains source text, and a code-knowledge daemon should
 * never become reachable from the network by accident.
 */
export async function serveHttp(
  verbs: Verbs,
  opts: { port?: number; host?: string; version?: string } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const version = opts.version ?? '0.0.0';
  const host = opts.host ?? '127.0.0.1';
  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'parse error' },
            }),
          );
          return;
        }
        // One transport+server per request: the SDK objects are per-connection, while `verbs` —
        // the graph, the index, the caches — stays shared. That is the whole point of this mode.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = buildServer(verbs, version);
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32603, message: 'internal error' },
              }),
            );
          }
        }
      })();
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, host, () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

export async function serveStdio(verbs: Verbs, version = '0.0.0'): Promise<void> {
  const server = buildServer(verbs, version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
}
