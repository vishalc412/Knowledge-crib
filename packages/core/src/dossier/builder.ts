/**
 * Dossier builder (Workstream E) — the canonical "reusable deep context" artifact for one symbol.
 *
 * A dossier folds together everything an agent otherwise assembles from `context` + `source` +
 * `extract_rules`: the deep node fields, the paged rehydrated source body, callers / callees, linked
 * docs, the decision table (for a callable), AND the schema-1.2 control-flow constructs (raises /
 * handles / iterates / declares). It is PURE over the soul + repoRoot (no IndexStore, no network, no
 * enricher) so the pipeline can build + persist it post-resolve and the MCP `dossier` verb can rebuild
 * it on a cache miss from the same code path — guaranteeing the persisted artifact and the live verb
 * output are byte-identical in shape.
 *
 * The persisted artifact (see {@link './persist.js'}) embeds the source text so a read needs no disk
 * access; staleness is hash-anchored to the soul node's `hash` (the dossier records `nodeHash` and is
 * rebuilt when the node changes).
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { CALLABLE_SYMBOL_TYPES, decisionTable } from '../rules/index.js';
import type { DecisionTable, ExtractRulesOpts } from '../rules/index.js';
import type { SoulStore } from '../soul-store.js';
import {
  DEFAULT_BODY_MAX_CHARS,
  DEFAULT_BODY_MAX_LINES,
  rehydrate,
  rehydrateBody,
} from '../source.js';
import type { RehydratedBody } from '../source.js';
import { type CallableCoverage, computeCoverage } from './coverage.js';
import {
  DOSSIER_SHAPE_VERSION,
  type DossierFrameworkSemantics,
  frameworkSemantics,
} from './framework.js';

const DOC_RELS = new Set(['describes', 'references']);

/** A caller or callee brief — enough to locate + identify, with the edge confidence. */
export interface AdjacentBrief {
  id: string;
  confidence: number;
  name?: string;
  qualifiedName?: string;
  signature?: string;
  type?: string;
  file?: string;
  line?: number;
}

/** A doc link pointing at the dossier's node (incoming describes/references). */
export interface DossierDocLink {
  sectionId: string;
  heading?: string;
  anchor?: string;
  snippet: string;
  edgeType: 'describes' | 'references';
  method: string;
  provenance: string;
  confidence: number;
}

/** The schema-1.2 control-flow constructs owned by a callable, grouped by edge rel. */
export interface DossierControlFlow {
  raises: Array<Record<string, unknown> & { confidence: number }>;
  handles: Array<Record<string, unknown> & { confidence: number }>;
  iterates: Array<Record<string, unknown> & { confidence: number }>;
  declares: Array<Record<string, unknown> & { confidence: number }>;
}

/** Options for {@link buildDossier}. */
export interface DossierOpts extends ExtractRulesOpts {
  sourceMaxChars?: number;
  sourceMaxLines?: number;
  /** absolute file line to start the source page at (paging cursor; default = span start) */
  sourceStartLine?: number;
  /** when true, drop non-EXTRACTED edges from callers/callees/docs/controlFlow (trust filter) */
  extractedOnly?: boolean;
}

/** The persisted dossier artifact. `nodeHash` + `schemaVersion` drive staleness; the rest is payload. */
export interface Dossier {
  /** the symbol node id this dossier describes */
  id: string;
  /** schema version of the soul the dossier was built from */
  schemaVersion: string;
  /** blake3 hash of the source node at build time — staleness key (compare to the live node.hash) */
  nodeHash: string;
  /** ISO timestamp the dossier was built */
  builtAt: string;
  /** the deep public node shape (every captured field, per kind) */
  node: Record<string, unknown>;
  /** the rehydrated source body (embedded so a read needs no disk access) */
  source: RehydratedBody;
  callers: AdjacentBrief[];
  callees: AdjacentBrief[];
  docs: DossierDocLink[];
  /** present iff the node is a callable (procedure/function/method/…) */
  rules?: DecisionTable;
  /** present iff the callable owns schema-1.2 control-flow constructs */
  controlFlow?: DossierControlFlow;
  /** present iff the node is a callable. `unimplemented` (zero `executes` body statements) is the
   *  LOUD signal that the implementation is unavailable — the body may be in a missing file (e.g. a
   *  PL/SQL package body), so the decision-table / control-flow fields are necessarily empty and an
   *  analyst must not mistake "structure-only" for "complete". Universal across every language. */
  implementation?: DossierImplementation;
  /** present iff the node is a callable. The 360° self-report: what the graph knows about this
   *  callable (body statements, formulas, conditions, raises, handlers, cursors, call resolution,
   *  recursion, fidelity loss) rolled into a single `readiness` + named `caveats`. This is what an
   *  LLM gates on so it never mistakes "structure-only" for "complete analysis". */
  coverage?: CallableCoverage;
  /** schema-1.3 framework-semantics relationships (the resolved complement to the node's own 1.3
   *  identity). Present iff non-empty. The persisted dossier carries the LEAN method subset
   *  (routes + produces the callable owns); the live `context` verb carries the full set
   *  (dependencies / dependents / relations / renders via member-of aggregation for a class). */
  framework?: DossierFrameworkSemantics;
  /** dossier shape version — bumped on any Dossier interface change; independent of soul
   *  schemaVersion so pre-change persisted artifacts are rebuilt even when schemaVersion is
   *  unchanged (persist.readDossier ORs this into the staleness check). */
  shapeVersion?: number;
}

/** Implementation completeness for a callable. `executesCount` = body statements the proc owns. */
export interface DossierImplementation {
  status: 'implemented' | 'unimplemented';
  executesCount: number;
  /** distinct files holding call sites that resolve to this callable (empty when nobody calls it).
   *  Surfaces "referenced everywhere but missing" without a separate lookup. */
  referencedByFiles: string[];
}

/**
 * Build a dossier for one node, pure over the soul + repoRoot. Returns `undefined` when the node is
 * absent. The caller chooses `now` (an ISO timestamp) so the artifact is deterministic under a fixed
 * build time (the pipeline passes the manifest's `now`; tests inject a constant).
 */
export function buildDossier(
  soul: SoulStore,
  repoRoot: string,
  nodeId: string,
  now: string,
  opts: DossierOpts = {},
): Dossier | undefined {
  const node = soul.getNode(nodeId);
  if (!node) return undefined;

  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const e of soul.iterateEdges()) {
    const o = outgoing.get(e.src);
    if (o) o.push(e);
    else outgoing.set(e.src, [e]);
    const i = incoming.get(e.dst);
    if (i) i.push(e);
    else incoming.set(e.dst, [e]);
  }
  const keep = (e: Edge): boolean => !opts.extractedOnly || e.provenance === 'EXTRACTED';

  const callers = (incoming.get(nodeId) ?? [])
    .filter((e) => e.rel === 'calls' && keep(e))
    .map((e) => brief(soul, e.src, e.confidence))
    .sort((a, b) => byLabel(a, b));
  const callees = (outgoing.get(nodeId) ?? [])
    .filter((e) => e.rel === 'calls' && keep(e))
    .map((e) => brief(soul, e.dst, e.confidence))
    .sort((a, b) => byLabel(a, b));

  const docs = (incoming.get(nodeId) ?? [])
    .filter((e) => DOC_RELS.has(e.rel) && keep(e) && e.confidence >= 0)
    .map((e): DossierDocLink => {
      const section = soul.getNode(e.src);
      return {
        sectionId: e.src,
        ...(section?.heading ? { heading: section.heading } : {}),
        ...(section?.anchor ? { anchor: section.anchor } : {}),
        snippet: rehydrate(repoRoot, section),
        edgeType: e.rel as 'describes' | 'references',
        method: e.method,
        provenance: e.provenance,
        confidence: e.confidence,
      };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const source: RehydratedBody = rehydrateBody(repoRoot, node, {
    maxChars: opts.sourceMaxChars ?? DEFAULT_BODY_MAX_CHARS,
    maxLines: opts.sourceMaxLines ?? DEFAULT_BODY_MAX_LINES,
    ...(opts.sourceStartLine !== undefined ? { startLine: opts.sourceStartLine } : {}),
  });

  const dossier: Dossier = {
    id: nodeId,
    schemaVersion: soul.getManifest().schemaVersion,
    nodeHash: node.hash,
    builtAt: now,
    shapeVersion: DOSSIER_SHAPE_VERSION,
    node: publicNode(node),
    source,
    callers,
    callees,
    docs,
  };

  if (node.type && CALLABLE_SYMBOL_TYPES.has(node.type)) {
    dossier.rules = decisionTable(soul, nodeId, {
      ...(opts.includeTables ? { includeTables: true } : {}),
    });
    const cf = controlFlow(soul, nodeId, outgoing, incoming, keep);
    if (cf.raises.length || cf.handles.length || cf.iterates.length || cf.declares.length) {
      dossier.controlFlow = cf;
    }
    // implementation completeness: counts the proc's OWN body statements (outgoing `executes`).
    // Zero → the implementation is unavailable (body in a missing file / spec-only declaration);
    // the decision table + controlFlow above are necessarily empty in that case, so this flag is what
    // tells an analyst "do not expect behavior here — go find the body".
    const execs = (outgoing.get(nodeId) ?? []).filter((e) => e.rel === 'executes' && keep(e));
    const refFiles = new Set<string>();
    for (const e of incoming.get(nodeId) ?? []) {
      if (e.rel !== 'calls' || !keep(e)) continue;
      const caller = soul.getNode(e.src);
      if (caller?.file) refFiles.add(caller.file);
    }
    dossier.implementation = {
      status: execs.length > 0 ? 'implemented' : 'unimplemented',
      executesCount: execs.length,
      referencedByFiles: [...refFiles].sort(),
    };
    // 360° self-report: reuse the adjacency we already built (no extra edge scan).
    dossier.coverage = computeCoverage(soul, nodeId, { keep, outgoing, incoming });
  }
  // schema-1.3 framework semantics: the LEAN method subset (routes + produces the callable owns).
  // Reuses the single iterateEdges() adjacency already built above — no extra scan. Undefined for a
  // non-Spring callable (no exposes/produces edges) → the key is omitted, keeping the shape honest.
  const fw = frameworkSemantics(soul, nodeId, { keep, outgoing, incoming, lean: true });
  if (fw) dossier.framework = fw;
  return dossier;
}

/** The public node shape — surfaces EVERY captured field, not just the symbol-header subset. */
export function publicNode(n: Node): Record<string, unknown> {
  const out: Record<string, unknown> = { id: n.id, kind: n.kind };
  if (n.type) out.type = n.type;
  if (n.name) out.name = n.name;
  if (n.qualifiedName) out.qualifiedName = n.qualifiedName;
  if (n.signature) out.signature = n.signature;
  if (n.lang) out.lang = n.lang;
  if (n.file) out.file = n.file;
  if (n.span) out.span = n.span;
  if (n.clusterId) out.clusterId = n.clusterId;
  // deep-extraction: SQL / table / column
  if (n.schema) out.schema = n.schema;
  if (n.table) out.table = n.table;
  if (n.dataType) out.dataType = n.dataType;
  if (n.sqlKind) out.sqlKind = n.sqlKind;
  if (n.expr) out.expr = n.expr;
  if (n.branch) out.branch = n.branch;
  // deep-extraction 1.2 (behavior-bearing fidelity)
  if (n.errorCode) out.errorCode = n.errorCode;
  if (n.errorMessage) out.errorMessage = n.errorMessage;
  if (n.whenSelector) out.whenSelector = n.whenSelector;
  if (n.assignTarget) out.assignTarget = n.assignTarget;
  if (n.cursorQuery) out.cursorQuery = n.cursorQuery;
  if (n.exprTruncated) out.exprTruncated = n.exprTruncated;
  if (Array.isArray(n.constraints)) out.constraints = n.constraints;
  if (n.commentRef) out.commentRef = n.commentRef;
  // doc-section
  if (n.heading) out.heading = n.heading;
  if (n.level !== undefined) out.level = n.level;
  if (n.anchor) out.anchor = n.anchor;
  // framework-semantics 1.3 identity — the handler's own route verb/path, the symbol's stereotype +
  // framework. Without these the route section shows the route but hides the handler's own contract
  // (e.g. its @PreAuthorize on the node), breaking the no-round-trip surfacing guarantee.
  if (n.framework) out.framework = n.framework;
  if (n.stereotype) out.stereotype = n.stereotype;
  if (n.httpMethod) out.httpMethod = n.httpMethod;
  if (n.routePath) out.routePath = n.routePath;
  // selective meta — surface the structured deep fields, not arbitrary blobs
  if (n.meta) {
    const m = n.meta as Record<string, unknown>;
    if (Array.isArray(m.columns)) out.columns = m.columns;
    if (m.returnType !== undefined) out.returnType = m.returnType;
    if (Array.isArray(m.tables)) out.tables = m.tables;
    if (Array.isArray(m.attributes)) out.attributes = m.attributes;
    if (m.collection !== undefined) out.collection = m.collection;
    if (m.kind !== undefined) out.kindMeta = m.kind;
    if (m.recursive !== undefined) out.recursive = m.recursive;
    if (Array.isArray(m.calls)) out.callSites = m.calls;
    // framework-semantics 1.3 meta — route params/security, DI injects, @Bean produces, JPA column.
    if (Array.isArray(m.params)) out.params = m.params;
    if (m.security !== undefined) out.security = m.security;
    if (Array.isArray(m.injects)) out.injects = m.injects;
    if (Array.isArray(m.produces)) out.produces = m.produces;
    if (m.column !== undefined) out.column = m.column;
  }
  return out;
}

/** Build a caller/callee brief from a node id + the edge confidence. */
function brief(soul: SoulStore, id: string, confidence: number): AdjacentBrief {
  const n = soul.getNode(id);
  if (!n) return { id, confidence };
  return {
    id,
    confidence,
    ...(n.name ? { name: n.name } : {}),
    ...(n.qualifiedName ? { qualifiedName: n.qualifiedName } : {}),
    ...(n.signature ? { signature: n.signature } : {}),
    ...(n.type ? { type: n.type } : {}),
    ...(n.file ? { file: n.file } : {}),
    ...(n.span ? { line: n.span.start } : {}),
  };
}

/** Gather the schema-1.2 control-flow edges out of a callable, grouped by rel. */
/**
 * Gather the schema-1.2 control-flow constructs the callable owns. A behavior node is NOT always
 * reached by an edge originating at the proc: `raises` + `declares` do (proc → raise / proc →
 * cursor), but `handles` edges originate at the exception-handler (handler → stmt) and `iterates`
 * edges originate at the loop condition (cond → cursor). So we walk the proc's body-reachable set:
 *   body stmts   = dsts of outgoing `executes` (proc → stmt)
 *   handlers     = srcs of incoming `handles` to those stmts        (handler → stmt)
 *   body conds   = dsts of outgoing `guarded-by` from those stmts    (stmt → cond)
 *   iterated     = dsts of outgoing `iterates` from those conds      (cond → cursor)
 * plus the proc-direct `raises` + `declares`. O(body size), no full-graph scan.
 */
function controlFlow(
  soul: SoulStore,
  nodeId: string,
  outgoing: Map<string, Edge[]>,
  incoming: Map<string, Edge[]>,
  keep: (e: Edge) => boolean,
): DossierControlFlow {
  const groups: DossierControlFlow = { raises: [], handles: [], iterates: [], declares: [] };
  // dedup is PER GROUP: a cursor can be both declared (declares) and iterated (iterates) and must
  // appear in both; only within-group duplicates (e.g. a cursor iterated by two loops) collapse.
  const seen: Record<keyof DossierControlFlow, Set<string>> = {
    raises: new Set(),
    handles: new Set(),
    iterates: new Set(),
    declares: new Set(),
  };
  const push = (rel: keyof DossierControlFlow, e: Edge, behaviorNodeId: string): void => {
    if (!keep(e)) return;
    if (seen[rel].has(behaviorNodeId)) return;
    const n = soul.getNode(behaviorNodeId);
    if (!n) return;
    seen[rel].add(behaviorNodeId);
    groups[rel].push({ ...publicNode(n), confidence: e.confidence });
  };

  const out = outgoing.get(nodeId) ?? [];
  // proc-direct: raises (proc → raise) + declares (proc → cursor). Collect every node the proc
  // reaches via any outgoing edge as the "body" — an exception handler can `handles` a statement,
  // an assignment, OR a raise inside its body, so executes-dsts alone would miss the raise case.
  const bodyNodes = new Set<string>();
  for (const e of out) {
    if (e.rel === 'raises') push('raises', e, e.dst);
    else if (e.rel === 'declares') push('declares', e, e.dst);
    bodyNodes.add(e.dst);
  }
  // exception-handlers that handle a body node (handler → node; the proc is not the src)
  for (const bn of bodyNodes) {
    for (const e of incoming.get(bn) ?? []) {
      if (e.rel === 'handles') push('handles', e, e.src);
    }
  }
  // body conditions guarding body nodes (node → cond), then cursors iterated by them (cond → cursor)
  const bodyConds = new Set<string>();
  for (const bn of bodyNodes) {
    for (const e of outgoing.get(bn) ?? []) {
      if (e.rel === 'guarded-by') bodyConds.add(e.dst);
    }
  }
  for (const cond of bodyConds) {
    for (const e of outgoing.get(cond) ?? []) {
      if (e.rel === 'iterates') push('iterates', e, e.dst);
    }
  }
  return groups;
}

function str(s: string): string {
  return s;
}

/** Sort adjacent briefs by a stable label (qualifiedName → name → id). */
function byLabel(a: AdjacentBrief, b: AdjacentBrief): number {
  const la = a.qualifiedName ?? a.name ?? a.id;
  const lb = b.qualifiedName ?? b.name ?? b.id;
  return la < lb ? -1 : la > lb ? 1 : 0;
}
