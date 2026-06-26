/**
 * Per-callable analysis coverage (Phase 4 — the 360° self-report). The crib's promise is "read the
 * graph, not the source"; this is the honest answer to "how much of this callable does the graph
 * actually know?" — so an LLM building a migration plan gates on `readiness` instead of silently
 * back-filling gaps with assumptions (the failure mode that made a graph-only plan lose detail to a
 * direct-source read).
 *
 * Pure over the soul. Counts the callable's own body constructs (statements, assignments/formulas,
 * conditions, raises, handlers, cursors, case-branches), its call resolution (resolved vs. recorded
 * vs. unresolved), recursion, and any expression-fidelity loss (`exprTruncated` nodes). It then
 * rolls those into a single `readiness`:
 *   • `unimplemented` — zero body statements: the implementation is unavailable (missing PL/SQL body,
 *     a spec-only declaration). Behavior analysis is impossible; the LOUD banner.
 *   • `partial` — a body exists but some fidelity is lost: unresolved call sites (a callee whose body
 *     the graph never saw) or truncated expressions. Usable, with named caveats.
 *   • `complete` — a body exists, every call resolves, no expression was clipped.
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { SoulStore } from '../soul-store.js';

export interface CoverageCalls {
  /** distinct `calls` edges out of this callable that resolved to a symbol. */
  resolved: number;
  /** call sites recorded on `meta.calls` (every site the body invokes, resolved or not). */
  recorded: number;
  /** recorded sites whose callee simple-name matches no symbol in the soul (missing asset). */
  unresolved: number;
}

export interface CallableCoverage {
  readiness: 'complete' | 'partial' | 'unimplemented';
  /** the callable owns a body (≥1 `executes`)? */
  bodyPresent: boolean;
  /** body statements the callable owns (outgoing `executes`). */
  executes: number;
  /** formula-bearing assignment nodes in the body (the scoring math). */
  assignments: number;
  /** distinct guard conditions reachable in the body. */
  conditions: number;
  /** raise / throw nodes the callable can fire. */
  raises: number;
  /** exception handlers guarding the body. */
  handlers: number;
  /** cursors / row-sources the body iterates or declares. */
  cursors: number;
  /** CASE / switch / match arms in the body. */
  caseBranches: number;
  calls: CoverageCalls;
  /** the callable recurses (calls itself; flagged via `meta.recursive`). */
  recursive: boolean;
  /** count of body nodes whose captured expression was clipped at the fidelity cap. */
  exprTruncated: number;
  /** human/LLM-readable caveats — what to distrust or go read the source for. Empty when complete. */
  caveats: string[];
}

const BUILTIN = /^(DBMS_|UTL_|APEX_|HTP|HTF_|SYS\.|STANDARD\.|DBA_|ALL_|USER_)/i;

/**
 * Compute the coverage for one callable. `outgoing`/`incoming` may be passed in (the dossier builder
 * already has them) to avoid a redundant edge scan; absent, they are built from the soul.
 */
export function computeCoverage(
  soul: SoulStore,
  nodeId: string,
  opts: {
    keep?: (e: Edge) => boolean;
    outgoing?: Map<string, Edge[]>;
    incoming?: Map<string, Edge[]>;
  } = {},
): CallableCoverage {
  const keep = opts.keep ?? (() => true);
  let outgoing = opts.outgoing;
  if (!outgoing) {
    outgoing = new Map<string, Edge[]>();
    for (const e of soul.iterateEdges()) {
      const o = outgoing.get(e.src);
      if (o) o.push(e);
      else outgoing.set(e.src, [e]);
    }
  }
  const out = (outgoing.get(nodeId) ?? []).filter(keep);

  // body statement nodes (executes dsts) + the proc-direct behavior nodes (raises / declared cursors).
  const bodyNodeIds = new Set<string>();
  let executes = 0;
  let raises = 0;
  let declaredCursors = 0;
  const callEdgeDsts = new Set<string>();
  for (const e of out) {
    if (e.rel === 'executes') {
      executes++;
      bodyNodeIds.add(e.dst);
    } else if (e.rel === 'raises') {
      raises++;
      bodyNodeIds.add(e.dst);
    } else if (e.rel === 'declares') {
      declaredCursors++;
      bodyNodeIds.add(e.dst);
    } else if (e.rel === 'calls') {
      callEdgeDsts.add(e.dst);
    }
  }

  // classify the body nodes by kind + tally fidelity loss; gather their guard conditions + cursors.
  let assignments = 0;
  let caseBranches = 0;
  let exprTruncated = 0;
  const conditionIds = new Set<string>();
  const iteratedCursorIds = new Set<string>();
  const tally = (n: Node | undefined): void => {
    if (!n) return;
    if (n.exprTruncated) exprTruncated++;
    if (n.kind === 'assignment') assignments++;
    else if (n.kind === 'case-branch') caseBranches++;
  };
  for (const id of bodyNodeIds) {
    const n = soul.getNode(id);
    tally(n);
    for (const e of (outgoing.get(id) ?? []).filter(keep)) {
      if (e.rel === 'guarded-by') conditionIds.add(e.dst);
    }
  }
  // each guard condition may iterate a cursor (cond → cursor) and may itself be expr-truncated.
  for (const cid of conditionIds) {
    const c = soul.getNode(cid);
    if (c?.exprTruncated) exprTruncated++;
    for (const e of (outgoing.get(cid) ?? []).filter(keep)) {
      if (e.rel === 'iterates') iteratedCursorIds.add(e.dst);
    }
  }
  const cursors = new Set<string>([
    ...iteratedCursorIds,
    ...bodyNodeIdsOfKind(soul, bodyNodeIds, 'cursor'),
  ]);
  // declared cursors are reached via `declares`; count the union of declared + iterated.
  const cursorCount = Math.max(declaredCursors, cursors.size);

  // exception handlers that guard a body node (handler → node; the proc is not the src).
  let incoming = opts.incoming;
  if (!incoming) {
    incoming = new Map<string, Edge[]>();
    for (const e of soul.iterateEdges()) {
      const i = incoming.get(e.dst);
      if (i) i.push(e);
      else incoming.set(e.dst, [e]);
    }
  }
  const handlerIds = new Set<string>();
  for (const id of bodyNodeIds) {
    for (const e of (incoming.get(id) ?? []).filter(keep)) {
      if (e.rel === 'handles') handlerIds.add(e.src);
    }
  }

  // call resolution: recorded sites (meta.calls) vs. resolved `calls` edges vs. unresolved sites.
  // A call that constructs a raised exception (`throw new X()` / `raise X()`) is NOT a missing
  // behavioral callee — it is already represented by the body's `raise` node — so exclude call sites
  // whose simple name matches a raised exception type. This keeps readiness honest about genuinely
  // missing logic without flagging every `throw new IllegalStateException(...)` as a gap (which would
  // make raise-heavy code falsely `partial` and break cross-language parity).
  const raisedTypes = new Set<string>();
  for (const id of bodyNodeIds) {
    const n = soul.getNode(id);
    if (n?.kind === 'raise' && n.name) {
      const lower = n.name.toLowerCase();
      raisedTypes.add(lower);
      // index the simple segment too — a raise `name` may be qualified (`System.InvalidOperationException`)
      // while the recorded call site is the simple constructor name (`InvalidOperationException`).
      raisedTypes.add(lower.split('.').pop() ?? lower);
    }
  }
  const node = soul.getNode(nodeId);
  const sites = (node?.meta?.calls as Array<{ callee: string; line: number }> | undefined) ?? [];
  const nameIndex = buildNameIndex(soul);
  let unresolved = 0;
  for (const s of sites) {
    const simple = (s.callee.split('.').pop() ?? s.callee).toLowerCase();
    if (nameIndex.has(simple) || BUILTIN.test(s.callee) || raisedTypes.has(simple)) continue;
    unresolved++;
  }
  const recursive = node?.meta?.recursive === true;

  const calls: CoverageCalls = {
    resolved: callEdgeDsts.size,
    recorded: sites.length,
    unresolved,
  };

  const bodyPresent = executes > 0;
  const caveats: string[] = [];
  if (!bodyPresent) {
    caveats.push(
      'BODY UNAVAILABLE — no body statements indexed. The implementation may live in a missing file ' +
        '(e.g. a PL/SQL package body) or be a spec-only declaration. Do NOT derive behavior, scoring ' +
        'formulas, or migration logic from this node — locate and index the body first.',
    );
  }
  if (unresolved > 0) {
    caveats.push(
      `${unresolved} call site(s) resolve to no indexed symbol — those callees' behavior is not in the graph. Index them or treat their effect as unknown.`,
    );
  }
  if (exprTruncated > 0) {
    caveats.push(
      `${exprTruncated} expression(s) were clipped at the fidelity cap — rehydrate the source span for the verbatim text before relying on the exact formula/query.`,
    );
  }

  const readiness: CallableCoverage['readiness'] = !bodyPresent
    ? 'unimplemented'
    : unresolved > 0 || exprTruncated > 0
      ? 'partial'
      : 'complete';

  return {
    readiness,
    bodyPresent,
    executes,
    assignments,
    conditions: conditionIds.size,
    raises,
    handlers: handlerIds.size,
    cursors: cursorCount,
    caseBranches,
    calls,
    recursive,
    exprTruncated,
    caveats,
  };
}

/** Count body nodes of a given kind (used to union declared + iterated cursors). */
function bodyNodeIdsOfKind(soul: SoulStore, ids: Set<string>, kind: Node['kind']): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const n = soul.getNode(id);
    if (n?.kind === kind) out.push(id);
  }
  return out;
}

/** Lowercased index of every callable's simple + qualified name (for call-site resolution checks). */
function buildNameIndex(soul: SoulStore): Set<string> {
  const idx = new Set<string>();
  for (const n of soul.iterate('symbol')) {
    if (n.name) idx.add(n.name.toLowerCase());
    if (n.qualifiedName) {
      idx.add(n.qualifiedName.toLowerCase());
      idx.add((n.qualifiedName.split('.').pop() ?? '').toLowerCase());
    }
  }
  return idx;
}
