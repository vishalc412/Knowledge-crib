import { z } from 'zod';

/**
 * The single capability manifest (Gate 1.4).
 *
 * WHY this exists: the tool/operation counts were stated in prose (docs/knowledge-crib-mcp-api.md),
 * re-derived by hand in server.test.ts's name array, and implicitly encoded in six `z.enum([...])`
 * op lists in server.ts — seven places that all claimed to describe one surface and drifted
 * independently. This module is the ONE list: server registration derives its op enums from it and
 * is validated against it (buildServer throws on disagreement), tests assert tools/list against it,
 * and the docs gate (scripts/capabilities-check.mjs) regenerates the "N tools / M operations"
 * figures from it, so a stale count is a build/test failure rather than a doc-sweep.
 *
 * Shape notes for extensibility: a tool with `ops` is an `op` dispatcher; a tool without `ops` is
 * standalone and IS exactly one operation. Adding an op (e.g. `memory({op:'history'})` when Gate 1.3
 * lands) is ONE line in the ops array — the zod enum, the operation count and the docs check all
 * follow; only the dispatcher's routing switch and the doc prose remain to update, and the gate
 * fails until they are.
 */

/** One `op` value behind a dispatcher tool, and the Verbs method it routes to. */
export interface CapabilityOp {
  readonly op: string;
  /**
   * Verbs method the op reaches. `getStats` for `status({op:'stats'})` is the one entry that is not
   * a plain verb method — the dispatcher calls `verbs.getStats().snapshot()`.
   */
  readonly verb: string;
}

/** A standalone tool — no `op` parameter, invoked directly, counts as exactly one operation. */
export interface StandaloneCapability {
  readonly tool: string;
  readonly verb: string;
}

/** A dispatcher tool — capabilities folded behind `op` to cut fixed per-session tool-list cost. */
export interface DispatcherCapability {
  readonly tool: string;
  readonly ops: readonly CapabilityOp[];
  /** The op applied when the caller omits `op`; declared ⟺ the schema's `op` is optional. */
  readonly defaultOp?: string;
}

export type Capability = StandaloneCapability | DispatcherCapability;

export const CAPABILITIES: readonly Capability[] = [
  // ─── Standalone tools (one operation each) ────────────────────────────────────────────────
  // `brief`, `context`, `query`, `source`, `detect_changes`, `overview` are reached for
  // constantly; `memory_recall` and `memory_observe` are named directly by the installed client
  // protocol, so an extra `op` would be friction or breakage (see server.ts).
  { tool: 'context', verb: 'context' },
  { tool: 'source', verb: 'source' },
  { tool: 'query', verb: 'query' },
  { tool: 'overview', verb: 'overview' },
  { tool: 'detect_changes', verb: 'detectChanges' },
  { tool: 'brief', verb: 'brief' },
  { tool: 'memory_recall', verb: 'memoryRecall' },
  { tool: 'memory_observe', verb: 'memoryObserve' },
  // G5.2 — on-demand PDG/taint analysis for one callable (TypeScript/JavaScript). Opt-in by
  // design: nothing runs at index time, and the analyzer is injected (see verbs.ts PdgPort).
  { tool: 'explain', verb: 'explain' },
  // G5.1 — safe symbol rename. Default dry-run; apply is gated on the deterministic plan id and
  // per-file content hashes, and application is all-or-nothing (see verbs.ts rename).
  { tool: 'rename', verb: 'rename' },
  // ─── `op` dispatchers ──────────────────────────────────────────────────────────────────────
  {
    tool: 'memory',
    ops: [
      { op: 'get', verb: 'memoryGet' },
      { op: 'status', verb: 'memoryStatus' },
      { op: 'audit', verb: 'memoryAudit' },
      { op: 'capture', verb: 'memoryCapture' },
      { op: 'feedback', verb: 'memoryFeedback' },
      // Gate 1.3 — the portable MemoryApi's op set, wired through the manifest so the op enum,
      // the operation count and the docs gate all follow this one list.
      { op: 'search', verb: 'memorySearch' },
      { op: 'supersede', verb: 'memorySupersede' },
      { op: 'delete', verb: 'memoryDelete' },
      { op: 'history', verb: 'memoryHistory' },
      { op: 'sync', verb: 'memorySync' },
      // G2.3 — the capture-outbox drain surface: queue counts + per-entry distill decisions.
      { op: 'outbox', verb: 'memoryOutbox' },
      // Session handoff — the "where was I?" projection a returning agent (new context window,
      // different IDE, different vendor) calls FIRST, before it can phrase a question.
      { op: 'handoff', verb: 'memoryHandoff' },
      { op: 'intake_create', verb: 'memoryIntakeCreate' },
      { op: 'intake_checkpoint', verb: 'memoryIntakeCheckpoint' },
      { op: 'intake_list', verb: 'memoryIntakeList' },
      { op: 'intake_get', verb: 'memoryIntakeGet' },
      { op: 'intake_share', verb: 'memoryIntakeShare' },
    ],
  },
  {
    tool: 'enrich',
    ops: [
      { op: 'status', verb: 'enrichStatus' },
      { op: 'next', verb: 'enrichNext' },
      { op: 'save', verb: 'enrichSave' },
      { op: 'delta', verb: 'semanticDelta' },
      { op: 'audit', verb: 'auditLlm' },
    ],
  },
  {
    tool: 'impact',
    defaultOp: 'blast',
    ops: [
      { op: 'blast', verb: 'impact' },
      { op: 'federated', verb: 'federatedImpact' },
      { op: 'path', verb: 'shortestPath' },
      { op: 'owners', verb: 'ownership' },
    ],
  },
  {
    tool: 'dossier',
    defaultOp: 'one',
    ops: [
      { op: 'one', verb: 'dossier' },
      { op: 'package', verb: 'reconstruct' },
      { op: 'scope', verb: 'dossierByScope' },
      { op: 'rules', verb: 'extractRules' },
    ],
  },
  {
    tool: 'neighbors',
    defaultOp: 'edges',
    ops: [
      { op: 'edges', verb: 'neighbors' },
      { op: 'llm', verb: 'llmNeighbors' },
      { op: 'describes', verb: 'describes' },
    ],
  },
  {
    tool: 'status',
    defaultOp: 'health',
    ops: [
      { op: 'health', verb: 'status' },
      { op: 'stats', verb: 'getStats' },
      { op: 'gaps', verb: 'gaps' },
    ],
  },
];

/** Registered tool names in manifest order (the order tools/list advertises them in). */
export const TOOL_NAMES: readonly string[] = CAPABILITIES.map((c) => c.tool);

/** The count every doc must quote for tools (`tools/list` length — buildServer enforces it). */
export const TOOL_COUNT = TOOL_NAMES.length;

/**
 * The count every doc must quote for operations: each dispatcher contributes `ops.length`, each
 * standalone tool contributes 1 (the tool IS the operation). This is the derivation the
 * "N tools / M operations" prose in docs/knowledge-crib-mcp-api.md is checked against.
 */
export const OPERATION_COUNT = CAPABILITIES.reduce(
  (total, c) => total + ('ops' in c ? c.ops.length : 1),
  0,
);

/** Look up one tool's manifest entry; unknown tools are a programming error, so throw. */
export function capabilityOf(tool: string): Capability {
  const found = CAPABILITIES.find((c) => c.tool === tool);
  if (!found) throw new Error(`capability manifest has no tool named '${tool}'`);
  return found;
}

/** The ops of a dispatcher tool (manifest order). Throws for standalone/unknown tools. */
export function opsOf(tool: string): readonly CapabilityOp[] {
  const cap = capabilityOf(tool);
  if (!('ops' in cap)) throw new Error(`tool '${tool}' is standalone — it has no ops`);
  return cap.ops;
}

/** The op values of a dispatcher tool as a tuple, for `z.enum` derivation. */
export function opValues(tool: string): [string, ...string[]] {
  const values = opsOf(tool).map((o) => o.op);
  if (values.length === 0) throw new Error(`dispatcher '${tool}' declares no ops`);
  return values as unknown as [string, ...string[]];
}

/**
 * The `op` schema for a dispatcher tool, derived from the manifest: required when there is no
 * default op, optional when `op` may be omitted. This is why a manifest edit cannot leave the
 * zod enum behind — the enum IS generated from the manifest.
 */
export function opSchema(tool: string) {
  const cap = capabilityOf(tool);
  const schema = z.enum(opValues(tool));
  return 'defaultOp' in cap && cap.defaultOp !== undefined ? schema.optional() : schema;
}

/**
 * Cross-entry consistency checks, returned as human-readable violations (empty = healthy) so tests
 * and the release gate can assert the manifest is well-formed before anything derives from it.
 */
export function manifestInvariants(): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const cap of CAPABILITIES) {
    if (seen.has(cap.tool)) problems.push(`duplicate tool name '${cap.tool}'`);
    seen.add(cap.tool);
    if (!('ops' in cap)) {
      if (!cap.verb) problems.push(`standalone tool '${cap.tool}' declares no verb`);
      continue;
    }
    if (cap.ops.length === 0) problems.push(`dispatcher '${cap.tool}' declares no ops`);
    const opSeen = new Set<string>();
    for (const { op } of cap.ops) {
      if (opSeen.has(op)) problems.push(`dispatcher '${cap.tool}' has duplicate op '${op}'`);
      opSeen.add(op);
      if (!op) problems.push(`dispatcher '${cap.tool}' has an empty op name`);
    }
    if (cap.defaultOp !== undefined && !opSeen.has(cap.defaultOp))
      problems.push(`dispatcher '${cap.tool}' defaultOp '${cap.defaultOp}' is not one of its ops`);
  }
  return problems;
}
