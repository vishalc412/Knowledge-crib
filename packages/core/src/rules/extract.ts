import type { Edge, Node } from '@knowledge-crib/soul-schema';
/**
 * M12 rule extraction — walks a procedure's guard-annotated CFG (the M11 `cfgPath`/`guard`/
 * `branch`/`inLoop`/`inException` stamped on its `executes`/`calls` edges) and materializes the
 * inherited path condition into decision-table / rule records.
 *
 * Pure over the soul: it builds a one-shot adjacency index from {@link SoulStore.iterateEdges} and
 * never touches the network, the enricher, or the derived index — so it is fully testable without an
 * IndexStore. A procedure is identified by node id OR by qualified name (case-insensitive match).
 *
 * Honesty: `branch` records polarity only for the INNERMOST IF on the path (the M11 convention). An
 * outer condition that is not the innermost appears in `conditions` with `polarity: undefined`
 * (present-on-path, polarity unknown at this depth) — we never fabricate a THEN/ELSE for it.
 */
import type { SoulStore } from '../soul-store.js';

/** One condition on a rule's path (a materialized `cfgPath` entry). */
export interface RuleCondition {
  /** condition node id (cond:<file>@L<line>) */
  id: string;
  /** the condition's source expression, if the extractor captured one */
  expr?: string;
  /** polarity of THIS condition on the path: 'THEN'/'ELSIF'/'ELSE' for the innermost IF; undefined for outer conditions (present, polarity unknown at this depth) */
  polarity?: string;
}

/** The action a rule fires — one `executes` or `calls` edge out of the procedure. */
export interface RuleAction {
  /** 'executes' (proc→statement) or 'calls' (proc→callee) */
  kind: 'executes' | 'calls';
  /** the annotated edge id */
  edgeId: string;
  /** statement node id (executes) or callee symbol id (calls) */
  target: string;
  /** source line of the action */
  line?: number;
  /** SQL verb for an executes statement (select/insert/update/delete/…) */
  sqlKind?: string;
  /** statement expression (SQL text) or callee name */
  expr?: string;
  /** tables read by this statement (from outgoing `reads` edges), when includeTables */
  reads?: string[];
  /** tables written by this statement (from outgoing `writes` edges), when includeTables */
  writes?: string[];
}

/** One rule = one action under a materialized path condition. */
export interface RuleRecord {
  /** procedure symbol id */
  procedure: string;
  /** procedure qualified name, if known */
  procedureName?: string;
  /** innermost condition node id (last of cfgPath), or undefined at procedure top level */
  guard?: string;
  /** polarity of the innermost IF branch (THEN/ELSIF/ELSE); undefined for loops / top level */
  branch?: string;
  /** materialized cfgPath, outer→inner */
  conditions: RuleCondition[];
  inLoop: boolean;
  inException: boolean;
  action: RuleAction;
}

/** A decision table: the distinct conditions (columns) + the rule rows. */
export interface DecisionTable {
  procedure: string;
  procedureName?: string;
  /** distinct condition ids across all rules, in first-seen order (the columns) */
  conditions: string[];
  rules: RuleRecord[];
}

export interface ExtractRulesOpts {
  /** resolve reads/writes table names per statement (extra lookups); default false */
  includeTables?: boolean;
  /**
   * Prebuilt outgoing-adjacency (src → edges), so a caller extracting rules for MANY procedures
   * (e.g. the `query` verb with `withRules` over N hits) builds it ONCE and reuses it instead of
   * scanning all edges per procedure. Absent → built internally from the soul (single-procedure path).
   */
  out?: Map<string, Edge[]>;
}

/**
 * Symbol `type` values that count as a "procedure" for rule extraction — i.e. a callable with a
 * body that carries `executes`/`calls` edges. Covers every parser's naming: PL/SQL
 * procedure/function, TypeScript/Java/C#/Python method/function, Go func, Rust fn, plus
 * getters/setters/constructors (a getter body can be guarded too). Widened from the original
 * procedure|function set so `extract_rules` and `context(withRules)` work for ALL languages, not
 * just PL/SQL.
 */
export const CALLABLE_SYMBOL_TYPES: ReadonlySet<string> = new Set([
  'procedure',
  'function',
  'method',
  'func',
  'fn',
  'getter',
  'setter',
  'constructor',
]);

/** Locate a procedure node by id, qualified name, or simple name (case-insensitive). */
export function findProcedure(soul: SoulStore, procedure: string): Node | undefined {
  const byId = soul.getNode(procedure);
  if (byId) return byId;
  const needle = procedure.toLowerCase();
  for (const n of soul.iterate('symbol')) {
    if (n.type && CALLABLE_SYMBOL_TYPES.has(n.type) && n.qualifiedName) {
      if (n.qualifiedName.toLowerCase() === needle) return n;
    }
  }
  // last resort: simple name match
  for (const n of soul.iterate('symbol')) {
    if (n.type && CALLABLE_SYMBOL_TYPES.has(n.type) && n.name) {
      if (n.name.toLowerCase() === needle) return n;
    }
  }
  return undefined;
}

/** Build outgoing-adjacency (src → edges) once, for O(1) per-procedure lookups. */
function outgoingIndex(soul: SoulStore): Map<string, Edge[]> {
  const idx = new Map<string, Edge[]>();
  for (const e of soul.iterateEdges()) {
    const list = idx.get(e.src);
    if (list) list.push(e);
    else idx.set(e.src, [e]);
  }
  return idx;
}

/** Extract the rule records for one procedure, materializing each edge's inherited cfgPath. */
export function extractRules(
  soul: SoulStore,
  procedure: string,
  opts: ExtractRulesOpts = {},
): RuleRecord[] {
  const proc = findProcedure(soul, procedure);
  if (!proc) return [];
  const out = opts.out ?? outgoingIndex(soul);
  const procEdges = out.get(proc.id) ?? [];
  // call-site line index: the `calls` edge's dst is the callee's DEFINITION, not the call site,
  // so the call-site line is recovered from the caller's recorded call sites (meta.calls).
  const callLines = callLineIndex(proc);

  // only executes (→statement) and calls (→callee) carry the guard chain; sort by source line.
  const actionEdges = procEdges
    .filter((e) => e.rel === 'executes' || e.rel === 'calls')
    .sort((a, b) => lineOf(soul, a, callLines) - lineOf(soul, b, callLines));

  const rules: RuleRecord[] = [];
  for (const e of actionEdges) {
    const conditions = (e.cfgPath ?? []).map((condId) => {
      const c = soul.getNode(condId);
      const rc: RuleCondition = { id: condId };
      if (c?.expr) rc.expr = c.expr;
      return rc;
    });
    // polarity is recorded only for the innermost IF — tag the last condition.
    const innermost = conditions[conditions.length - 1];
    if (innermost && e.branch !== undefined) {
      innermost.polarity = e.branch;
    }

    rules.push({
      procedure: proc.id,
      ...(proc.qualifiedName ? { procedureName: proc.qualifiedName } : {}),
      ...(e.guard ? { guard: e.guard } : {}),
      ...(e.branch ? { branch: e.branch } : {}),
      conditions,
      inLoop: e.inLoop ?? false,
      inException: e.inException ?? false,
      action: actionFor(soul, e, out, opts, callLines),
    });
  }
  return rules;
}

/**
 * Build a callee-name → call-site-line index from the procedure's recorded call sites. A `calls`
 * edge is deduped per (caller,callee) so multiple sites to one callee collapse to one edge; we
 * surface the first recorded site's line (best-effort, honest about the loss).
 */
function callLineIndex(proc: Node): Map<string, number> {
  const idx = new Map<string, number>();
  const sites = proc.meta?.calls as Array<{ callee: string; line: number }> | undefined;
  if (!Array.isArray(sites)) return idx;
  for (const s of sites) {
    const key = (s.callee.split('.').pop() ?? s.callee).toLowerCase();
    if (!idx.has(key)) idx.set(key, s.line);
  }
  return idx;
}

/** Assemble the decision table: distinct conditions (columns) + the rule rows. */
export function decisionTable(
  soul: SoulStore,
  procedure: string,
  opts: ExtractRulesOpts = {},
): DecisionTable {
  const proc = findProcedure(soul, procedure);
  const rules = extractRules(soul, procedure, opts);
  const seen = new Set<string>();
  const conditions: string[] = [];
  for (const r of rules)
    for (const c of r.conditions)
      if (!seen.has(c.id)) {
        seen.add(c.id);
        conditions.push(c.id);
      }
  return {
    procedure: proc?.id ?? procedure,
    ...(proc?.qualifiedName ? { procedureName: proc.qualifiedName } : {}),
    conditions,
    rules,
  };
}

/** Build the action record for one annotated edge, optionally pulling reads/writes tables. */
function actionFor(
  soul: SoulStore,
  e: Edge,
  out: Map<string, Edge[]>,
  opts: ExtractRulesOpts,
  callLines: Map<string, number>,
): RuleAction {
  const target = soul.getNode(e.dst);
  const a: RuleAction = {
    kind: e.rel as 'executes' | 'calls',
    edgeId: e.id,
    target: e.dst,
  };
  if (e.rel === 'executes') {
    // executes → statement node whose span.start IS the statement's source line.
    if (target?.span) a.line = target.span.start;
    if (target?.sqlKind) a.sqlKind = target.sqlKind;
    if (target?.expr) a.expr = target.expr;
  } else {
    // calls → callee symbol: surface its name as the expression; the call-site line is recovered
    // from the caller's recorded call sites (the edge's dst is the callee's definition line).
    if (target?.name) a.expr = target.name;
    else if (target?.qualifiedName) a.expr = target.qualifiedName;
    const calleeKey = (target?.name ?? target?.qualifiedName ?? '').split('.').pop()?.toLowerCase();
    if (calleeKey) {
      const line = callLines.get(calleeKey);
      if (line !== undefined) a.line = line;
    }
  }
  if (opts.includeTables && e.rel === 'executes') {
    const reads: string[] = [];
    const writes: string[] = [];
    for (const re of out.get(e.dst) ?? []) {
      if (re.rel === 'reads') reads.push(re.dst);
      else if (re.rel === 'writes') writes.push(re.dst);
    }
    if (reads.length > 0) a.reads = reads;
    if (writes.length > 0) a.writes = writes;
  }
  return a;
}

/** Source line for an action edge — executes from the statement span; calls from the call-site
 * index; otherwise Infinity (sorts last). */
function lineOf(soul: SoulStore, e: Edge, callLines: Map<string, number>): number {
  if (e.rel === 'executes') {
    const n = soul.getNode(e.dst);
    return n?.span?.start ?? Number.POSITIVE_INFINITY;
  }
  // calls: prefer the recovered call-site line, else the callee definition line, else Infinity.
  const callee = soul.getNode(e.dst);
  const calleeKey = (callee?.name ?? callee?.qualifiedName ?? '').split('.').pop()?.toLowerCase();
  const siteLine = calleeKey ? callLines.get(calleeKey) : undefined;
  return siteLine ?? callee?.span?.start ?? Number.POSITIVE_INFINITY;
}
