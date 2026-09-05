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
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TOOL_NAMES, opSchema } from './capabilities.js';
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

/**
 * Retired standalone tool names → the dispatcher tool + `op` that replaced them. ONE-RELEASE-ONLY
 * backwards-compat shim: the six installed clients were configured against these names before the
 * `op` dispatchers folded them, so their calls must keep resolving until the next release, after
 * which this table and {@link installAliasRouter} are removed. New clients never see these names —
 * they are not registered tools, so they cost nothing in tools/list (see the router comment).
 *
 * Exported so tests derive the retired-name list from here instead of re-maintaining it by hand.
 */
export const RETIRED_ALIASES: Record<string, { tool: string; op: string }> = {
  memory_get: { tool: 'memory', op: 'get' },
  memory_status: { tool: 'memory', op: 'status' },
  memory_audit: { tool: 'memory', op: 'audit' },
  memory_feedback: { tool: 'memory', op: 'feedback' },
  enrich_status: { tool: 'enrich', op: 'status' },
  enrich_next: { tool: 'enrich', op: 'next' },
  enrich_save: { tool: 'enrich', op: 'save' },
  semantic_delta: { tool: 'enrich', op: 'delta' },
  audit_llm: { tool: 'enrich', op: 'audit' },
  shortest_path: { tool: 'impact', op: 'path' },
  ownership: { tool: 'impact', op: 'owners' },
  reconstruct: { tool: 'dossier', op: 'package' },
  dossier_by_scope: { tool: 'dossier', op: 'scope' },
  llm_neighbors: { tool: 'neighbors', op: 'llm' },
  describes: { tool: 'neighbors', op: 'describes' },
  stats: { tool: 'status', op: 'stats' },
  gaps: { tool: 'status', op: 'gaps' },
  extract_rules: { tool: 'dossier', op: 'rules' },
};

/**
 * Route the retired names in {@link RETIRED_ALIASES} to their dispatcher before the SDK's own
 * tools/call handler rejects them as unknown.
 *
 * Why a call-level router and not hidden tool registrations: MCP TS SDK v1.29 has no supported
 * way to hide a CALLABLE tool from tools/list — the list filters on `tool.enabled`, and a
 * `disable()`d tool answers calls with `Tool X disabled`. Registering the 18 retired names would
 * therefore re-inflate every session's tool list to 32 entries, exactly the fixed per-session cost
 * the `op` dispatchers removed. Instead we wrap the protocol's tools/call request handler:
 * Protocol.setRequestHandler explicitly documents that it replaces the previous handler for a
 * method, so we capture the handler the SDK installed (lazily on the first registerTool call —
 * always above us here), then install a wrapper that rewrites an alias call into the dispatcher
 * call (name swapped, `op` injected, other arguments untouched) and forwards everything else
 * unmodified. Validation, error mapping and the Stats interceptor all still run in the SDK's own
 * handler on the forward path. Callers may not contradict the alias: an injected `op` always wins
 * over one smuggled into `arguments`.
 */
function installAliasRouter(server: McpServer, verbs: Verbs): void {
  const protocol = server.server;
  // `_requestHandlers` is an underscore-private Protocol field; there is no public getter for the
  // installed handler, and this is the minimal seam the wrapper needs.
  const handlers = (
    protocol as unknown as {
      // Promise<never> so the forwarded result type-checks against whatever response type the SDK
      // expects from a tools/call handler; the runtime value is the SDK handler's own result.
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<never>>;
    }
  )._requestHandlers;
  const original = handlers.get('tools/call');
  if (!original) {
    // Fail loudly rather than ship a server whose clients silently lose the retired names: the
    // handler is installed lazily by the first registerTool call, so absent wiring means the SDK's
    // internals changed under us and this shim must be re-derived.
    throw new Error('SDK tools/call handler not installed; alias shim cannot be wired');
  }
  protocol.removeRequestHandler('tools/call');
  protocol.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    // Every client reaches crib through this one call path, whatever IDE it is, so this is where a
    // session's coordinates can be observed without any client-specific hook. It is what makes a
    // timed-out session recoverable for the six adapters that expose no lifecycle hook surface.
    // Coalesced internally and never throwing — see `Verbs.noteSessionActivity`.
    // Optional call: the router must not depend on a breadcrumb. A partial `Verbs` (tests, a future
    // variant) still routes correctly, and a resume aid can never be the reason a tool call fails.
    verbs.noteSessionActivity?.();
    const alias = RETIRED_ALIASES[request.params.name];
    if (!alias) return original(request, extra);
    return original(
      {
        ...request,
        params: {
          ...request.params,
          name: alias.tool,
          arguments: { ...(request.params.arguments ?? {}), op: alias.op },
        },
      },
      extra,
    );
  });
}

/**
 * Gate 1.4 wiring: fail AT BUILD TIME when the registered surface disagrees with the capability
 * manifest (packages/mcp/src/capabilities.ts). The manifest is the single source for the tool list
 * and each dispatcher's ops; the op zod enums are GENERATED from it ({@link opSchema}), so the only
 * remaining way to drift is registering a tool the manifest does not declare (or forgetting to
 * register one it does) — which this check turns into a thrown error that every server test and the
 * docs count gate surface as a build failure, not a doc-sweep.
 */
function assertSurfaceMatchesManifest(server: McpServer): void {
  const registered = Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
  ).sort();
  const expected = [...TOOL_NAMES].sort();
  if (registered.length !== expected.length || registered.some((name, i) => name !== expected[i])) {
    throw new Error(
      `registered surface does not match the capability manifest: registered [${registered.join(', ')}] vs manifest [${expected.join(', ')}]`,
    );
  }
}

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
      description:
        'Dry-run delta report since a git ref. Reports `changedPaths` (committed since the anchor) AND `uncommittedPaths` (working tree), both folded into `changedSymbols`/`removedEdges`, so it is usable as a PRE-commit check. A `note` means the report is degraded or narrowed in scope — an empty result carrying one is not a clean bill of health. Run BEFORE committing.',
      inputSchema: { since: z.string().optional() },
    },
    async (a) => TOOL_RESULT(verbs.detectChanges(a)),
  );

  // `extract_rules` had no keep-standalone rationale (unlike brief/context/query/source above):
  // it walks a procedure to a decision table, and dossier already carries decision-table semantics
  // (withRules). It is folded behind dossier{op:'rules'} and its name lives on in RETIRED_ALIASES.

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
        // ── G2.2 durable-outbox capture args (part of the `cap:` id seed) ──
        idempotencyKey: z.string().optional(),
        sessionId: z.string().optional(),
        sessionOffset: z.number().int().optional(),
        eventOffset: z.number().int().optional(),
        ifHash: z.string().optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.memoryObserve(a)),
  );

  // G5.2 — on-demand PDG/taint analysis for one callable (TypeScript/JavaScript). Opt-in: nothing
  // runs at index time; the analyzer is injected into Verbs (PdgPort) and the response carries an
  // explicit `limits` block — an empty `flows` list is NOT proof of safety.
  server.registerTool(
    'explain',
    {
      description:
        'On-demand PDG + taint analysis for ONE TypeScript/JavaScript callable: control-dependence and data-dependence edge counts plus taint flows (source rule, sink rule, variable, source→sink path with lines and graph node ids). Conservative and intra-procedural: a reported flow is possible, not confirmed, and an empty flows list is NOT proof of safety (cross-function flows are out of scope).',
      inputSchema: {
        id: z.string(),
      },
    },
    async (a) => TOOL_RESULT(verbs.explain(a)),
  );

  // G5.1 — safe symbol rename. Default DRY-RUN: derives the reviewed plan and a deterministic plan
  // id. `apply` is refused without the plan id, and again (stale) if any file changed since the
  // plan was reviewed. Application is atomic; the response explicitly says the index is now stale.
  server.registerTool(
    'rename',
    {
      description:
        'Safe symbol rename with a plan/apply split. Default is a DRY-RUN that returns the reviewed plan: per-file edits, exact (edge-grounded) vs inferred (text-hit) confidence counts, affected symbols with an unresolved bucket, notes, and a deterministic plan id. To apply, call again with apply: true and the SAME planId — it is refused if any file changed since the plan (stale) or the id does not match. Application is all-or-nothing and does NOT reindex: run `crib update --dirty` afterwards.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        apply: z.boolean().optional(),
        planId: z.string().optional(),
        depth: z.number().int().min(1).max(6).optional(),
      },
    },
    async (a) => TOOL_RESULT(verbs.rename(a)),
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
        'Memory ledger operations, selected by `op`. get: one record by id (needs id; withEvidence for full evidence; follows legacy-ID aliases, and memory-2 records answer with their v2 fields - visibility, propositionKey, validTime/transactionTime, lineage - instead of v1 fields). search: ranked search over the ledger (q, sources, targetIds, limit, maxTokens) - the same projection memory_recall uses, including effective/alias-restored verdicts and conflict groups. supersede: replace a record with a successor (needs id + actor, and either successor=an existing record id or claim=a new claim text) - writes the v2 successor plus a supersede decision. delete: tombstone a record (needs id + actor) - appends a retract decision, never destroys the line. history: bi-temporal timeline for one key (needs key; asOf for a point-in-time read). sync: read-only cross-device sync report (status counts; a `request` of push/pull is rejected - sync writes run only via the CLI `crib memory sync`, never behind an agent session). outbox: read-only capture-outbox drain report (no args) - pending/done/dead counts, pending captures with their retry counts, and drained entries with their distill decision, rationale, and verified flag. status: ledger counts by trust/evidence/lifecycle plus recall-eligible, quarantined, and pending. audit: read-only health report - drifted verdicts, conflict groups, a secret re-scan, trust distribution, locally quarantined records. capture: episodic capture to the candidate tier (needs subject, observation, actor) - loose refs in files/symbols are auto-anchored to a source-quote evidence item when they resolve; the candidate is pending trust and never enters normal recall. feedback: record LOCAL feedback on a record (needs subject, signal, actor); a `contradicted` signal quarantines only when backed by admissible counterEvidence, and never retracts team memory. To READ memory for a task use `memory_recall`; to WRITE a fully-formed grounded claim use `memory_observe`.',
      inputSchema: {
        op: opSchema('memory'),
        id: z.string().optional(),
        withEvidence: z.boolean().optional(),
        subject: z.string().optional(),
        observation: z.string().optional(),
        kind: z.enum(['fact', 'procedure', 'decision', 'pitfall', 'convention']).optional(),
        files: z.array(z.string()).optional(),
        symbols: z.array(z.string()).optional(),
        signal: z.enum(['useful', 'unhelpful', 'contradicted']).optional(),
        actor: z.string().optional(),
        tool: z.string().optional(),
        scopeBoundary: z.enum(['repo', 'global']).optional(),
        // ── G2.2 durable-outbox capture args (part of the `cap:` id seed) ──
        idempotencyKey: z.string().optional(),
        sessionId: z.string().optional(),
        sessionOffset: z.number().int().optional(),
        eventOffset: z.number().int().optional(),
        context: z.string().optional(),
        counterEvidence: z.array(z.record(z.string(), z.unknown())).optional(),
        // ── search / history / supersede args (Gate 1.3 portable op set) ──
        q: z.string().optional(),
        targetIds: z.array(z.string()).optional(),
        sources: z.array(z.enum(['team', 'local', 'global'])).optional(),
        limit: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        asOf: z.string().optional(),
        key: z.string().optional(),
        successor: z.string().optional(),
        claim: z.string().optional(),
        reason: z.string().optional(),
        visibility: z.enum(['private', 'workspace']).optional(),
        propositionKey: z.string().optional(),
        // ── Gate 4 sync: read-only status is the default; push/pull reach the rejection path ──
        request: z.enum(['status', 'push', 'pull']).optional(),
        ifHash: z.string().optional(),
        // ── durable intake continuation ──
        original: z.string().optional(),
        outcome: z.string().optional(),
        scope: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
        retentionPolicyId: z.string().optional(),
        phase: z.enum(['intake', 'planning', 'executing', 'blocked', 'verifying']).optional(),
        summary: z.string().optional(),
        nextSafeAction: z.string().optional(),
        completedStepIds: z.array(z.string()).optional(),
        audience: z.enum(['devices', 'team']).optional(),
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
        case 'search':
          return TOOL_RESULT(
            verbs.memorySearch({
              ...(a.q !== undefined ? { q: a.q } : {}),
              ...(a.targetIds !== undefined ? { targetIds: a.targetIds } : {}),
              ...(a.sources !== undefined ? { sources: a.sources } : {}),
              ...(a.limit !== undefined ? { limit: a.limit } : {}),
              ...(a.maxTokens !== undefined ? { maxTokens: a.maxTokens } : {}),
              ...(a.withEvidence !== undefined ? { withEvidence: a.withEvidence } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        case 'supersede': {
          if (!a.id || !a.actor || (!a.successor && !a.claim))
            return TOOL_RESULT({
              error: {
                code: 'BAD_REQUEST',
                message: 'op=supersede requires id, actor, and either successor or claim',
              },
            });
          return TOOL_RESULT(
            verbs.memorySupersede({
              id: a.id,
              actor: a.actor,
              ...(a.successor !== undefined ? { successor: a.successor } : {}),
              ...(a.claim !== undefined ? { claim: a.claim } : {}),
              ...(a.subject !== undefined ? { subject: a.subject } : {}),
              ...(a.kind !== undefined ? { kind: a.kind } : {}),
              ...(a.visibility !== undefined ? { visibility: a.visibility } : {}),
              ...(a.propositionKey !== undefined ? { propositionKey: a.propositionKey } : {}),
              ...(a.reason !== undefined ? { reason: a.reason } : {}),
              ...(a.tool !== undefined ? { tool: a.tool } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        }
        case 'delete': {
          if (!a.id || !a.actor)
            return TOOL_RESULT({
              error: { code: 'BAD_REQUEST', message: 'op=delete requires id and actor' },
            });
          return TOOL_RESULT(
            verbs.memoryDelete({
              id: a.id,
              actor: a.actor,
              ...(a.reason !== undefined ? { reason: a.reason } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        }
        case 'history': {
          if (!a.key)
            return TOOL_RESULT({
              error: { code: 'BAD_REQUEST', message: 'op=history requires key' },
            });
          return TOOL_RESULT(
            verbs.memoryHistory({
              key: a.key,
              ...(a.asOf !== undefined ? { asOf: a.asOf } : {}),
              ...(a.withEvidence !== undefined ? { withEvidence: a.withEvidence } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        }
        case 'sync':
          return TOOL_RESULT(
            await verbs.memorySync({
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
              ...(a.request !== undefined ? { request: a.request } : {}),
            }),
          );
        case 'outbox':
          return TOOL_RESULT(
            verbs.memoryOutbox({ ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}) }),
          );
        case 'handoff':
          return TOOL_RESULT(
            verbs.memoryHandoff({
              ...(a.limit !== undefined ? { limit: a.limit } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        case 'intake_create':
          if (!a.original || !a.outcome || !a.actor)
            return TOOL_RESULT({
              error: {
                code: 'BAD_REQUEST',
                message: 'op=intake_create requires original, outcome, and actor',
              },
            });
          return TOOL_RESULT(
            verbs.memoryIntakeCreate({
              original: a.original,
              outcome: a.outcome,
              actor: a.actor,
              ...(a.scope !== undefined ? { scope: a.scope } : {}),
              ...(a.constraints !== undefined ? { constraints: a.constraints } : {}),
              ...(a.acceptanceCriteria !== undefined
                ? { acceptanceCriteria: a.acceptanceCriteria }
                : {}),
              ...(a.sensitivity !== undefined ? { sensitivity: a.sensitivity } : {}),
              ...(a.retentionPolicyId !== undefined
                ? { retentionPolicyId: a.retentionPolicyId }
                : {}),
              ...(a.tool !== undefined ? { tool: a.tool } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        case 'intake_checkpoint':
          if (!a.id || !a.phase || !a.summary || !a.nextSafeAction || !a.actor)
            return TOOL_RESULT({
              error: {
                code: 'BAD_REQUEST',
                message:
                  'op=intake_checkpoint requires id, phase, summary, nextSafeAction, and actor',
              },
            });
          return TOOL_RESULT(
            verbs.memoryIntakeCheckpoint({
              id: a.id,
              phase: a.phase,
              summary: a.summary,
              nextSafeAction: a.nextSafeAction,
              actor: a.actor,
              ...(a.completedStepIds !== undefined ? { completedStepIds: a.completedStepIds } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        case 'intake_list':
          return TOOL_RESULT(
            verbs.memoryIntakeList({ ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}) }),
          );
        case 'intake_get':
          if (!a.id)
            return TOOL_RESULT({
              error: { code: 'BAD_REQUEST', message: 'op=intake_get requires id' },
            });
          return TOOL_RESULT(
            verbs.memoryIntakeGet({
              id: a.id,
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        case 'intake_share':
          if (!a.id || !a.audience || !a.actor)
            return TOOL_RESULT({
              error: {
                code: 'BAD_REQUEST',
                message: 'op=intake_share requires id, audience, and actor',
              },
            });
          return TOOL_RESULT(
            verbs.memoryIntakeShare({
              id: a.id,
              audience: a.audience,
              actor: a.actor,
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        case 'audit':
          return TOOL_RESULT(
            verbs.memoryAudit({ ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}) }),
          );
        case 'capture': {
          if (!a.subject || !a.observation || !a.actor)
            return TOOL_RESULT({
              error: {
                code: 'BAD_REQUEST',
                message: 'op=capture requires subject, observation, and actor',
              },
            });
          return TOOL_RESULT(
            verbs.memoryCapture({
              subject: a.subject,
              observation: a.observation,
              actor: a.actor,
              ...(a.kind !== undefined ? { kind: a.kind } : {}),
              ...(a.files !== undefined ? { files: a.files } : {}),
              ...(a.symbols !== undefined ? { symbols: a.symbols } : {}),
              ...(a.tool !== undefined ? { tool: a.tool } : {}),
              ...(a.scopeBoundary !== undefined ? { scopeBoundary: a.scopeBoundary } : {}),
              ...(a.idempotencyKey !== undefined ? { idempotencyKey: a.idempotencyKey } : {}),
              ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
              ...(a.sessionOffset !== undefined ? { sessionOffset: a.sessionOffset } : {}),
              ...(a.eventOffset !== undefined ? { eventOffset: a.eventOffset } : {}),
              ...(a.ifHash !== undefined ? { ifHash: a.ifHash } : {}),
            }),
          );
        }
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
        // `op` is manifest-derived (so its static type is string, not a literal union): the zod
        // enum already rejects unknown values at the protocol layer, this default only guards the
        // impossible in-process case, matching the other dispatchers.
        default:
          return TOOL_RESULT(BAD_REQUEST(`unknown op ${a.op}`));
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
        op: opSchema('enrich'),
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
        op: opSchema('impact'),
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
        'Deep reusable context, selected by `op`. one (default): everything about ONE symbol in a call — deep node fields, paged source body, callers, callees, linked docs, decision table, control flow. `source.nextLine` is the paging cursor; pass it back as sourceStartLine. package: everything about one PACKAGE — constant values, every member with implementation status, tables read/written, docs, expected body file. scope: bulk dossiers for EVERY symbol in a package/file/cluster in ONE call (use instead of looping over ~50 members); honesty flags symbolCount, truncated, skipped. rules: walk a procedure guard-annotated CFG and materialize its decision table / rule records (the retired `extract_rules` tool, folded here).',
      inputSchema: {
        op: opSchema('dossier'),
        // `id` and `procedure` are per-op requirements — one/package/scope need `id`, rules needs
        // `procedure` — so both are optional here and enforced in the handler, where a missing one
        // yields a BAD_REQUEST instead of a plausible-but-wrong payload from a mis-called verb.
        id: z.string().optional(),
        procedure: z.string().optional(),
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
          if (!a.id) return TOOL_RESULT(BAD_REQUEST('op=one requires id'));
          return TOOL_RESULT(verbs.dossier(rest as never));
        case 'package':
          if (!a.id) return TOOL_RESULT(BAD_REQUEST('op=package requires id'));
          return TOOL_RESULT(verbs.reconstruct(rest as never));
        case 'scope':
          if (!a.id || !a.scope)
            return TOOL_RESULT(
              BAD_REQUEST("op=scope requires id and scope: 'package' | 'file' | 'cluster'"),
            );
          return TOOL_RESULT(verbs.dossierByScope(rest as never));
        case 'rules':
          if (!a.procedure) return TOOL_RESULT(BAD_REQUEST('op=rules requires procedure'));
          return TOOL_RESULT(
            verbs.extractRules({
              procedure: a.procedure,
              ...(a.includeTables !== undefined ? { includeTables: a.includeTables } : {}),
            }),
          );
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
        op: opSchema('neighbors'),
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
        op: opSchema('status'),
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

  installAliasRouter(server, verbs);
  assertSurfaceMatchesManifest(server);

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
/**
 * Loopback hosts the shared daemon will answer for.
 *
 * The daemon binds to 127.0.0.1, so a request arriving with some OTHER Host header did not reach it
 * by its bind address — it reached it through a name that resolves to loopback. That is DNS
 * rebinding: an attacker-controlled page resolves its own domain to 127.0.0.1 and the victim's
 * browser then talks to this daemon "same-origin", with the graph's source text on the other side.
 * The audited daemon accepted `Host: audit-untrusted.example` and answered `initialize` with 200
 * (docs/audits/2026-09-05, F14). The visualization server already enforced this; the MCP daemon did
 * not, and the two are the same class of local HTTP surface.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Strip the port from a Host/Origin authority, handling bracketed IPv6. */
function authorityOf(value: string): string {
  let h = value.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(':');
  if (colon > 0) h = h.slice(0, colon);
  return h;
}

/**
 * Is this request allowed past the transport boundary?
 *
 * Two independent checks, both required:
 *   - Host must be loopback (or exactly the host the operator deliberately bound to, so an explicit
 *     non-loopback bind is not broken by its own guard).
 *   - Origin, WHEN PRESENT, must be loopback. A CLI or agent client sends no Origin at all; only a
 *     browser attaches one, so a foreign Origin is by construction a cross-site attempt.
 *
 * This is a transport boundary, not an authorization decision: it establishes that the caller is
 * local. It does NOT identify which local user is calling — the process still runs as one OS user
 * and `verbs` is shared across every request. Do not treat it as multi-tenant isolation.
 */
export function isAllowedHttpCaller(
  headers: { host?: string; origin?: string },
  boundHost: string,
): boolean {
  const host = headers.host;
  if (!host) return false; // HTTP/1.1 requires Host; a missing one is malformed, not trusted
  const hostAuthority = authorityOf(host);
  const boundAuthority = authorityOf(boundHost);
  if (!LOOPBACK_HOSTS.has(hostAuthority) && hostAuthority !== boundAuthority) return false;
  const origin = headers.origin;
  if (origin === undefined || origin === 'null') return true; // non-browser caller
  let originHost: string;
  try {
    originHost = authorityOf(new URL(origin).host);
  } catch {
    return false; // unparseable Origin — refuse rather than guess
  }
  return LOOPBACK_HOSTS.has(originHost) || originHost === boundAuthority;
}

/**
 * Cap on a single JSON-RPC request body. The daemon exists to serve many small verb calls from many
 * agents; nothing legitimate approaches this. Without a cap, an unauthenticated local process could
 * make the shared daemon — the one holding the whole graph in memory — buffer unbounded input and
 * take every connected agent down with it.
 */
export const MAX_HTTP_REQUEST_BYTES = 4 * 1024 * 1024;

export async function serveHttp(
  verbs: Verbs,
  opts: { port?: number; host?: string; version?: string } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const version = opts.version ?? '0.0.0';
  const host = opts.host ?? '127.0.0.1';
  const httpServer = createServer((req, res) => {
    // The boundary check runs BEFORE routing, so /health cannot be used to probe the daemon's
    // presence and version from a rebound origin either.
    if (!isAllowedHttpCaller({ host: req.headers.host, origin: req.headers.origin }, host)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'forbidden: non-local Host/Origin' },
        }),
      );
      return;
    }
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
    let received = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      received += c.length;
      if (received > MAX_HTTP_REQUEST_BYTES) {
        // Stop accumulating AND stop reading: buffering the rest just to reject it would hand the
        // caller the exhaustion it was attempting.
        aborted = true;
        chunks.length = 0;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'request body too large' },
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
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
