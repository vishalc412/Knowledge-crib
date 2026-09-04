/**
 * PDG layer — taint flows over the per-callable PDG.
 *
 * The rule table is PLAIN DATA (DEFAULT_TAINT_RULES below): sources mark where request-supplied
 * values enter, sinks mark where they become dangerous, sanitizers clear specific taint contexts. Users
 * extend it by passing extra rules — `analyzeTaint(pdg, [...DEFAULT_TAINT_RULES, myRule])`.
 *
 * Propagation is a fixpoint over the CFG: a variable tainted at a node flows along CFG edges,
 * through local defs (`const y = q` taints `y`), and — conservatively — through control
 * dependence (a tainted branch condition taints everything it guards, because the branch decided
 * whether the guarded code runs). A sanitizer def REPLACES the cleared contexts rather than
 * adding: `encodeURIComponent(q)` yields a value that is still tainted in every context except
 * url, so feeding it to a shell sink still reports. That is the honest direction: real-world
 * sanitizers are context-specific, and claiming a general clean after a URL escape would be a
 * false negative.
 *
 * INTRA-PROCEDURAL ONLY: values returned to callers, passed to other functions, or stored in
 * module state are NOT followed. An empty flow list is therefore never proof of safety.
 */
import type { Pdg, PdgEdge, PdgNode } from './cfg.js';

/** The kind of dangerous use a sink guards. Sanitizers clear these per variable. */
export type TaintContext = 'url' | 'shell' | 'code' | 'html' | 'sql' | 'fs' | 'path';

export const ALL_CONTEXTS: readonly TaintContext[] = [
  'url',
  'shell',
  'code',
  'html',
  'sql',
  'fs',
  'path',
];

export interface TaintRule {
  /** Stable identifier, e.g. `source.http-input` — surfaced in results. */
  id: string;
  kind: 'source' | 'sink' | 'sanitizer';
  /** Case-insensitive substrings; a node matches when its text contains ANY of these. */
  match: readonly string[];
  /** sink only: the context whose taint makes the sink dangerous */
  context?: TaintContext;
  /** source only: contexts the value could be used in (default: all — unknown origin) */
  emits?: readonly TaintContext[];
  /** sanitizer only: contexts this call clears (default: all) */
  clears?: readonly TaintContext[];
}

/**
 * Small, deliberately conservative starter table for TypeScript/JavaScript. Substring matching
 * means known false positives (e.g. `regex.exec(`) are reported — over-reporting is the accepted
 * direction for a conservative analyzer; each entry names a real-world pattern.
 */
export const DEFAULT_TAINT_RULES: readonly TaintRule[] = [
  // ─── sources ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'source.http-input',
    kind: 'source',
    match: [
      'req.query',
      'request.query',
      'req.params',
      'request.params',
      'req.body',
      'request.body',
      'req.headers',
      'request.headers',
    ],
  },
  {
    id: 'source.url-search-params',
    kind: 'source',
    match: ['searchparams.get', 'urlsearchparams'],
  },
  { id: 'source.env', kind: 'source', match: ['process.env'] },
  { id: 'source.fs-read', kind: 'source', match: ['readfile', 'readdir'] },
  { id: 'source.parsed-json', kind: 'source', match: ['json.parse'] },
  { id: 'source.child-args', kind: 'source', match: ['argv'] },
  // ─── sinks ──────────────────────────────────────────────────────────────────────────────────
  { id: 'sink.code-eval', kind: 'sink', match: ['eval(', 'new function('], context: 'code' },
  {
    id: 'sink.shell-exec',
    kind: 'sink',
    match: ['exec(', 'execsync(', 'spawn(', 'spawnsync(', 'execfile('],
    context: 'shell',
  },
  { id: 'sink.sql-concat', kind: 'sink', match: ['.query(', '.execute('], context: 'sql' },
  {
    id: 'sink.html-inject',
    kind: 'sink',
    match: ['innerhtml', 'dangerouslysetinnerhtml', 'document.write('],
    context: 'html',
  },
  {
    id: 'sink.fs-write-path',
    kind: 'sink',
    match: ['writefile', 'appendfile', 'unlink', 'rmsync', 'mkdir'],
    context: 'path',
  },
  {
    id: 'sink.url-fetch',
    kind: 'sink',
    match: ['fetch(', 'http.request(', 'https.request('],
    context: 'url',
  },
  // ─── sanitizers ─────────────────────────────────────────────────────────────────────────────
  {
    id: 'sanitizer.schema-validate',
    kind: 'sanitizer',
    match: ['safeparse(', '.validate(', 'z.object', 'yup.object', 'joi.object'],
  },
  {
    id: 'sanitizer.uri-encode',
    kind: 'sanitizer',
    match: ['encodeuricomponent('],
    clears: ['url'],
  },
];

export interface TaintPathStep {
  /** CFG node id */
  node: number;
  /** 1-based source line */
  line: number;
  text: string;
  /** the edge relation that carried the taint into this step ('source' for the origin) */
  via: string;
}

export interface TaintFlow {
  sinkRule: string;
  sourceRule: string;
  /** the variable that carried the taint (the sink's use, or the source's def for direct flows) */
  variable: string;
  contexts: readonly TaintContext[];
  /** origin → … → sink, each step with its source line and text */
  path: readonly TaintPathStep[];
}

export interface TaintResult {
  flows: readonly TaintFlow[];
  /** how many sink occurrences were checked — context for an empty `flows` list */
  sinksChecked: number;
}

interface TaintState {
  contexts: Set<TaintContext>;
  /** origin-side chain: from the source node forward to the current node */
  path: TaintPathStep[];
}

const ALL: readonly TaintContext[] = ALL_CONTEXTS;

/** Run taint analysis over a completed PDG with the given rules (defaults + user extensions). */
export function analyzeTaint(
  pdg: Pdg,
  rules: readonly TaintRule[] = DEFAULT_TAINT_RULES,
): TaintResult {
  const sources = rules.filter((r) => r.kind === 'source');
  const sinks = rules.filter((r) => r.kind === 'sink');
  const sanitizers = rules.filter((r) => r.kind === 'sanitizer');
  const sourceOf = (n: PdgNode): TaintRule | null => sources.find((r) => matches(n, r)) ?? null;
  const sinkRulesOf = (n: PdgNode): TaintRule[] => sinks.filter((r) => matches(n, r));

  // per-node incoming state: variable → taint (contexts + the path that carried it here)
  const inState = new Map<number, Map<string, TaintState>>();
  for (const n of pdg.nodes) inState.set(n.id, new Map());

  // seed: a source node taints every variable it uses or defines
  for (const n of pdg.nodes) {
    const rule = sourceOf(n);
    if (!rule || !pdg.reachable.has(n.id)) continue;
    const st: TaintState = { contexts: new Set(rule.emits ?? ALL), path: [step(n, 'source')] };
    const state = inState.get(n.id)!;
    for (const v of [...n.uses, ...n.defs]) mergeInto(state, v, st);
  }

  // fixpoint over CFG edges (taint of a var follows flow) + control edges (a tainted branch
  // condition taints every variable the guarded statement uses), then local def transfer
  const edges = [...pdg.edges, ...pdg.control];
  for (let pass = 0; pass < pdg.nodes.length + 2; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!pdg.reachable.has(e.src) || !pdg.reachable.has(e.dst)) continue;
      const srcState = inState.get(e.src)!;
      const dstState = inState.get(e.dst)!;
      const dstNode = pdg.nodes[e.dst];
      if (!dstNode) continue;
      if (e.rel === 'control') {
        for (const [, st] of srcState) {
          for (const v of dstNode.uses) {
            if (mergeInto(dstState, v, withStep(st, dstNode, 'control'))) changed = true;
          }
        }
      } else {
        for (const [v, st] of srcState) {
          if (mergeInto(dstState, v, withStep(st, dstNode, e.rel))) changed = true;
        }
      }
    }
    // local transfer: defs consume the taint of the uses on the same node
    for (const n of pdg.nodes) {
      if (!pdg.reachable.has(n.id)) continue;
      const state = inState.get(n.id)!;
      const sanitizeRule = sanitizers.find((r) => matches(n, r)) ?? null;
      for (const v of n.defs) {
        const ctxs = new Set<TaintContext>();
        let carried: TaintPathStep[] | null = null;
        for (const u of n.uses) {
          const st = state.get(u);
          if (st) {
            for (const c of st.contexts) ctxs.add(c);
            carried = carried ?? st.path;
          }
        }
        if (sanitizeRule) for (const c of sanitizeRule.clears ?? ALL) ctxs.delete(c);
        if (ctxs.size === 0) {
          if (state.delete(v)) changed = true;
        } else {
          const fresh: TaintState = {
            contexts: ctxs,
            path: [...(carried ?? [step(n, 'flow')]), step(n, 'def')],
          };
          if (mergeInto(state, v, fresh)) changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // sink check
  const flows: TaintFlow[] = [];
  const seen = new Set<string>();
  let sinksChecked = 0;
  for (const n of pdg.nodes) {
    const nodeSinks = sinkRulesOf(n);
    if (nodeSinks.length === 0 || !pdg.reachable.has(n.id)) continue;
    sinksChecked += nodeSinks.length;
    const state = inState.get(n.id)!;
    for (const rule of nodeSinks) {
      const ctx = rule.context ?? 'code';
      for (const v of n.uses) {
        const st = state.get(v);
        if (!st || !st.contexts.has(ctx)) continue;
        const key = `${rule.id}|${n.id}|${v}`;
        if (seen.has(key)) continue;
        seen.add(key);
        flows.push({
          sinkRule: rule.id,
          sourceRule: sourceRuleId(st.path[0]?.text ?? '', sources) ?? 'source.unknown',
          variable: v,
          contexts: [...st.contexts],
          path: dedupePath([...st.path, step(n, `sink:${rule.id}`)]),
        });
      }
    }
  }
  return { flows, sinksChecked };
}

function matches(n: PdgNode, rule: TaintRule): boolean {
  const text = n.text.toLowerCase();
  return rule.match.some((m) => text.includes(m));
}

function step(n: PdgNode, via: string): TaintPathStep {
  return { node: n.id, line: n.line, text: n.text, via };
}

function withStep(st: TaintState, n: PdgNode, via: string): TaintState {
  return { contexts: st.contexts, path: [...st.path, step(n, via)] };
}

/** Merge `st` into `state[var]`; returns true when the merge added anything. */
function mergeInto(state: Map<string, TaintState>, v: string, st: TaintState): boolean {
  const prev = state.get(v);
  if (prev) {
    let added = false;
    for (const c of st.contexts) {
      if (!prev.contexts.has(c)) {
        prev.contexts.add(c);
        added = true;
      }
    }
    return added;
  }
  state.set(v, { contexts: new Set(st.contexts), path: [...st.path] });
  return true;
}

/** Identify which source rule the origin step came from, by re-matching its text. */
function sourceRuleId(text: string, sources: readonly TaintRule[]): string | null {
  const lower = text.toLowerCase();
  const hit = sources.find((r) => r.match.some((m) => lower.includes(m)));
  return hit?.id ?? null;
}

/** Collapse runs of steps on the same node (arrival + sink marker) to one step each. */
function dedupePath(path: readonly TaintPathStep[]): TaintPathStep[] {
  const out: TaintPathStep[] = [];
  for (const s of path) {
    const prev = out[out.length - 1];
    if (prev && prev.node === s.node)
      out[out.length - 1] = { ...s }; // keep the later (more specific) label
    else out.push(s);
  }
  return out;
}

/** Union of data- and control-dependence edges, for callers that walk the full PDG. */
export function dependenceEdges(pdg: Pdg): readonly PdgEdge[] {
  return [...pdg.data, ...pdg.control];
}
