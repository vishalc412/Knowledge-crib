/**
 * Framework-semantics surfacing (schema 1.3) — the resolved-relationships complement to a node's
 * own 1.3 identity fields. A handler method's `publicNode` already carries its `httpMethod`/
 * `routePath`/`stereotype`/`framework` + `meta.params`/`security`; this module folds in the EDGES that
 * connect it to the framework: the route it exposes, the bean it produces, the dependencies its
 * owning class injects, the JPA relations its sibling fields declare, the components it renders.
 *
 * PURE over the soul (no IndexStore, no disk) so the pipeline-persisted dossier and the live MCP
 * `context` verb share one code path and are byte-identical in shape. Auto-scopes by node:
 *   • CLASS symbol (controller/service/repository/entity/config/component/module, or type
 *     class/interface/record/struct, or has incoming `member-of` children) → CLASS scope: owners =
 *     {classId} ∪ {incoming member-of srcs that are callable symbols or `field` nodes}; aggregates
 *     the route table / DI graph / relation model / renders across members.
 *   • callable symbol / component / field / route / anything else → METHOD scope: owners = {nodeId}
 *     (direct outgoing; dependencies lifted from the owning class for a callable context).
 *
 * `lean: true` populates only the {routes, produces} the node OWNS (the persisted-dossier subset — a
 * method's own route + bean). `lean: false` (default, the `context` verb) additionally populates
 * dependencies / dependents / relations / renders per scope. Deterministic: same node → same object.
 * Returns `undefined` when every populated array is empty (so a non-Spring method attaches nothing).
 *
 * Supply chain (no round-trip): a dependency whose type is a @Bean-produced type is surfaced with
 * `kind: 'produces'` + `producer: <@Bean method brief>` in the SAME object — a consumer reads
 * "LoanRepository is injected AND produced by LoanRepositoryConfig.loanRepository()" in one trip.
 * One-hop only; multi-hop DI remains the `impact` verb's job.
 *
 * Unresolved honesty: `meta.produces` / `meta.injects` type NAMES that have no emitted edge are
 * appended as entries with `unresolved: true`, `id: '?'`, `qualifiedName: <type>` — parity with the
 * `gaps` verb's unresolved call-sites. A @Configuration declaring a bean the resolver hasn't linked,
 * or a service injecting a type the resolver hasn't linked, yields a visible gap, not silence.
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { SoulStore } from '../soul-store.js';
import type { AdjacentBrief } from './builder.js';

/** Where a route param is bound. Closed union for the 6 Spring values + open for `form`/`matrix`/… */
export type ParamLocation =
  | 'path'
  | 'query'
  | 'body'
  | 'header'
  | 'cookie'
  | 'part'
  | (string & {});

/** A route exposed by a handler (method scope) or aggregated into a controller's route table (class scope). */
export interface DossierRoute {
  id: string;
  confidence: number;
  name?: string;
  httpMethod?: string;
  routePath?: string;
  framework?: string;
  params?: Array<{ name: string; type?: string; in: ParamLocation }>;
  security?: Record<string, unknown>;
  /** set ONLY when aggregating a class's route table — the owning handler method. Omitted on a
   *  method dossier (the node IS the handler). */
  handler?: AdjacentBrief;
  /** honesty signal: a route id that could not be resolved (reserved for future inferred routes). */
  unresolved?: boolean;
}

/** A @Bean method's produced type (method scope) or a class's bean inventory (class scope). */
export interface DossierProduces {
  id: string;
  confidence: number;
  brief: AdjacentBrief;
  /** the producing METHOD's own return type / element type (from meta.returnType / meta.returnElementType),
   *  NOT the produced type's meta. Omitted on a class aggregation where the member carries it. */
  returnType?: string;
  returnElementType?: string;
  /** set ONLY when aggregating a class's bean table — the @Bean method that produces this type. */
  producer?: AdjacentBrief;
  /** honesty signal: a `meta.produces` type name on the method/class with no emitted `produces` edge. */
  unresolved?: boolean;
}

/** A dependency (injects) or a supplied @Bean (produces-via-DI). Forward edges from the consumer. */
export interface DossierDependency {
  id: string;
  confidence: number;
  brief: AdjacentBrief;
  stereotype?: string;
  framework?: string;
  /** `'injects'` = plain DI; `'produces'` = the dep type is itself a @Bean some producer makes. */
  kind: 'injects' | 'produces';
  /** the wired type name (edge evidence snippet). */
  injectedAs?: string;
  /** when `kind === 'produces'`, the @Bean method that supplies this dep (one-hop supply chain). */
  producer?: AdjacentBrief;
  /** honesty signal: a `meta.injects` type name on the class with no emitted `injects` edge. */
  unresolved?: boolean;
}

/** A reverse-DI entry: who injects this class OR a type this method produces. */
export interface DossierDependent {
  id: string;
  confidence: number;
  brief: AdjacentBrief;
  stereotype?: string;
  framework?: string;
  /** the edge label (the wired type name) the consumer injected. */
  injectedAs?: string;
}

/** A JPA relation: entity field → related type, with the cardinality + cascade/fetch/mappedBy attrs. */
export interface DossierRelation {
  id: string;
  confidence: number;
  brief: AdjacentBrief;
  /** owning field name (class aggregation; the member `field` node's name). */
  field?: string;
  /** the multiplicity (ManyToOne/OneToMany/ManyToMany/OneToOne) — from `edge.meta.cardinality`. */
  cardinality?: string;
  cascade?: string;
  fetch?: string;
  mappedBy?: string;
  orphanRemoval?: string;
}

/** A component → child component render edge (React/Angular; Spring: empty). */
export interface DossierRenders {
  id: string;
  confidence: number;
  brief: AdjacentBrief;
  framework?: string;
}

/** The container — each key present iff non-empty. `undefined` overall when all are empty. */
export interface DossierFrameworkSemantics {
  routes?: DossierRoute[];
  produces?: DossierProduces[];
  dependencies?: DossierDependency[];
  dependents?: DossierDependent[];
  relations?: DossierRelation[];
  renders?: DossierRenders[];
}

/** Options for {@link frameworkSemantics}. */
export interface FrameworkSemanticsOpts {
  /** trust filter (extractedOnly). Default: keep every edge. */
  keep?: (e: Edge) => boolean;
  /** outgoing edges by src — reuse the caller's single soul scan (e.g. buildDossier's adjacency). */
  outgoing?: Map<string, Edge[]>;
  /** incoming edges by dst — reuse the caller's single soul scan. */
  incoming?: Map<string, Edge[]>;
  /** when true, populate only {routes, produces} the node OWNS (the persisted-dossier subset). */
  lean?: boolean;
}

/** Stereotypes that mark a class as a framework class (CLASS scope). */
const CLASS_STEREOTYPES = new Set([
  'controller',
  'service',
  'repository',
  'entity',
  'config',
  'component',
  'module',
  'directive',
  'pipe',
  'hook',
]);

/** Symbol AST types that are class-like (CLASS scope even without a stereotype). */
const CLASS_TYPES = new Set(['class', 'interface', 'record', 'struct']);

/** Callable symbol AST types (members that expose routes / produce beans). */
const CALLABLE_TYPES = new Set([
  'procedure',
  'function',
  'method',
  'func',
  'fn',
  'getter',
  'setter',
  'constructor',
]);

/** The framework-rel edges this module reads. */
const FRAMEWORK_RELS = new Set([
  'exposes',
  'produces',
  'injects',
  'references',
  'renders',
  'member-of',
]);

/** The Dossier shape version — bumped on any Dossier interface change so persisted artifacts with a
 *  stale shape are rebuilt even when schemaVersion is unchanged. Independent of soul schemaVersion. */
export const DOSSIER_SHAPE_VERSION = 2;

/**
 * Surface the framework-semantics relationships for one node. Auto-scopes by node (class → member-of
 * aggregation; callable/component/field → direct). `lean: true` → the persisted-dossier subset
 * (routes + produces the node owns). Returns `undefined` when nothing was populated.
 */
export function frameworkSemantics(
  soul: SoulStore,
  nodeId: string,
  opts: FrameworkSemanticsOpts = {},
): DossierFrameworkSemantics | undefined {
  const node = soul.getNode(nodeId);
  if (!node) return undefined;
  const keep = opts.keep ?? (() => true);

  // adjacency: reuse the caller's single soul scan when supplied (buildDossier / context verb both
  // already have it); else build it here from one iterateEdges() pass.
  const outgoing = opts.outgoing ?? buildAdjacency(soul, 'out');
  const incoming = opts.incoming ?? buildAdjacency(soul, 'in');

  // ONE soul-wide produces scan → producedTypeId → producer method id (the supply-chain map).
  const producerOf = new Map<string, string>();
  for (const e of soul.iterateEdges()) {
    if (e.rel !== 'produces') continue;
    if (!producerOf.has(e.dst)) producerOf.set(e.dst, e.src);
  }

  const classScope = isClassScope(node, incoming);

  const routes: DossierRoute[] = [];
  const produces: DossierProduces[] = [];
  const dependencies: DossierDependency[] = [];
  const dependents: DossierDependent[] = [];
  const relations: DossierRelation[] = [];
  const renders: DossierRenders[] = [];

  // dedup keys — each rel dedups by its natural key.
  const seenRoutes = new Set<string>();
  const seenProduces = new Set<string>();
  const seenDeps = new Set<string>();
  const seenDependents = new Set<string>();
  const seenRelations = new Set<string>();
  const seenRenders = new Set<string>();

  /** brief of a node id (the AdjacentBrief shape — enough to locate + identify). */
  const brief = (id: string, confidence: number): AdjacentBrief => {
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
  };

  if (classScope) {
    // CLASS scope: owners = the class itself + its member methods / fields (incoming member-of srcs).
    const owners = new Set<string>([nodeId]);
    const memberFields: Node[] = [];
    for (const e of incoming.get(nodeId) ?? []) {
      if (e.rel !== 'member-of' || !keep(e)) continue;
      const m = soul.getNode(e.src);
      if (!m) continue;
      owners.add(e.src);
      if (m.kind === 'field') memberFields.push(m);
    }

    // routes + produces: aggregate across member methods (the controller route table / @Configuration
    // bean inventory). handler/producer = brief(member method).
    for (const owner of owners) {
      const m = soul.getNode(owner);
      if (!m || !isCallableSymbol(m)) continue;
      for (const e of outgoing.get(owner) ?? []) {
        if (!keep(e)) continue;
        if (e.rel === 'exposes') {
          if (seenRoutes.has(e.dst)) continue;
          seenRoutes.add(e.dst);
          const r = routeFromNode(soul.getNode(e.dst), e.confidence);
          if (r) {
            r.handler = brief(owner, e.confidence);
            routes.push(r);
          }
        } else if (e.rel === 'produces') {
          if (seenProduces.has(e.dst)) continue;
          seenProduces.add(e.dst);
          const mn = soul.getNode(e.dst);
          if (mn) {
            produces.push({
              id: e.dst,
              confidence: e.confidence,
              brief: brief(e.dst, e.confidence),
              ...returnTypesOf(m),
              producer: brief(owner, e.confidence),
            });
          }
        }
      }
    }

    // dependencies: the CLASS's own outgoing injects (the DI graph).
    collectDependencies(nodeId, outgoing, keep, producerOf, soul, brief, seenDeps, dependencies);
    // unresolved injects from the class meta.injects (a service injecting a type the resolver missed).
    appendUnresolvedInjects(node, outgoing, dependencies, seenDeps);
    // unresolved produces from member methods' meta.produces (a @Bean whose return type the resolver missed).
    for (const owner of owners) {
      const m = soul.getNode(owner);
      if (m) appendUnresolvedProduces(m, outgoing, produces, seenProduces);
    }

    // dependents: incoming injects to the class ∪ incoming injects to any produced type.
    const producedTypeIds = new Set(produces.map((p) => p.id));
    const depTargets = new Set<string>([nodeId, ...producedTypeIds]);
    for (const t of depTargets) {
      for (const e of incoming.get(t) ?? []) {
        if (e.rel !== 'injects' || !keep(e)) continue;
        if (seenDependents.has(e.src)) continue;
        seenDependents.add(e.src);
        const cn = soul.getNode(e.src);
        dependents.push({
          id: e.src,
          confidence: e.confidence,
          brief: brief(e.src, e.confidence),
          ...(cn?.stereotype ? { stereotype: cn.stereotype } : {}),
          ...(cn?.framework ? { framework: cn.framework } : {}),
          ...(e.evidence?.snippet ? { injectedAs: e.evidence.snippet } : {}),
        });
      }
    }

    // relations: member FIELD nodes' outgoing references (the JPA relation model).
    for (const f of memberFields) {
      for (const e of outgoing.get(f.id) ?? []) {
        if (e.rel !== 'references' || !keep(e)) continue;
        const key = `${f.id}|${e.dst}`;
        if (seenRelations.has(key)) continue;
        seenRelations.add(key);
        const rn = soul.getNode(e.dst);
        if (!rn) continue;
        const m = (e.meta ?? {}) as Record<string, unknown>;
        relations.push({
          id: e.dst,
          confidence: e.confidence,
          brief: brief(e.dst, e.confidence),
          field: f.name,
          ...(typeof m.cardinality === 'string' ? { cardinality: m.cardinality } : {}),
          ...(typeof m.cascade === 'string' ? { cascade: m.cascade } : {}),
          ...(typeof m.fetch === 'string' ? { fetch: m.fetch } : {}),
          ...(typeof m.mappedBy === 'string' ? { mappedBy: m.mappedBy } : {}),
          ...(typeof m.orphanRemoval === 'string' ? { orphanRemoval: m.orphanRemoval } : {}),
        });
      }
    }

    // renders: the class/component's own outgoing renders (React/Angular render tree; Spring: empty).
    collectRenders(nodeId, outgoing, keep, soul, brief, seenRenders, renders);
  } else {
    // METHOD scope: owners = {nodeId} (direct). A callable lifts dependencies from its owning class.
    const isMethod = isCallableSymbol(node);

    // routes: own outgoing exposes (handler OMITTED — the node IS the handler).
    for (const e of outgoing.get(nodeId) ?? []) {
      if (e.rel === 'exposes' && keep(e)) {
        if (seenRoutes.has(e.dst)) continue;
        seenRoutes.add(e.dst);
        const r = routeFromNode(soul.getNode(e.dst), e.confidence);
        if (r) routes.push(r);
      }
    }
    // produces: own outgoing produces (producer OMITTED; returnType/returnElementType from THIS method).
    for (const e of outgoing.get(nodeId) ?? []) {
      if (e.rel === 'produces' && keep(e)) {
        if (seenProduces.has(e.dst)) continue;
        seenProduces.add(e.dst);
        const pn = soul.getNode(e.dst);
        if (pn) {
          produces.push({
            id: e.dst,
            confidence: e.confidence,
            brief: brief(e.dst, e.confidence),
            ...returnTypesOf(node),
          });
        }
      }
    }
    // unresolved produces from the method's own meta.produces.
    appendUnresolvedProduces(node, outgoing, produces, seenProduces);

    if (!opts.lean && isMethod) {
      // dependencies: the parent class's outgoing injects ∪ the method's own (rare method-level @Autowired).
      const parent = parentClassOf(node, outgoing);
      if (parent) {
        collectDependencies(
          parent,
          outgoing,
          keep,
          producerOf,
          soul,
          brief,
          seenDeps,
          dependencies,
        );
        const pn = soul.getNode(parent);
        if (pn) appendUnresolvedInjects(pn, outgoing, dependencies, seenDeps);
      }
      for (const e of outgoing.get(nodeId) ?? []) {
        if (e.rel !== 'injects' || !keep(e)) continue;
        if (seenDeps.has(e.dst)) continue;
        seenDeps.add(e.dst);
        pushDependency(e, soul, brief, producerOf, dependencies);
      }
      // dependents: incoming injects to the parent class ∪ incoming injects to any produced type.
      const producedTypeIds = new Set(produces.map((p) => p.id));
      const depTargets = new Set<string>([...(parent ? [parent] : []), ...producedTypeIds]);
      for (const t of depTargets) {
        for (const e of incoming.get(t) ?? []) {
          if (e.rel !== 'injects' || !keep(e)) continue;
          if (seenDependents.has(e.src)) continue;
          seenDependents.add(e.src);
          const cn = soul.getNode(e.src);
          dependents.push({
            id: e.src,
            confidence: e.confidence,
            brief: brief(e.src, e.confidence),
            ...(cn?.stereotype ? { stereotype: cn.stereotype } : {}),
            ...(cn?.framework ? { framework: cn.framework } : {}),
            ...(e.evidence?.snippet ? { injectedAs: e.evidence.snippet } : {}),
          });
        }
      }
    }

    // field scope: relations = own outgoing references (a field does not inject and does not route).
    if (node.kind === 'field') {
      for (const e of outgoing.get(nodeId) ?? []) {
        if (e.rel !== 'references' || !keep(e)) continue;
        const rn = soul.getNode(e.dst);
        if (!rn) continue;
        const key = `${nodeId}|${e.dst}`;
        if (seenRelations.has(key)) continue;
        seenRelations.add(key);
        const m = (e.meta ?? {}) as Record<string, unknown>;
        relations.push({
          id: e.dst,
          confidence: e.confidence,
          brief: brief(e.dst, e.confidence),
          field: node.name,
          ...(typeof m.cardinality === 'string' ? { cardinality: m.cardinality } : {}),
          ...(typeof m.cascade === 'string' ? { cascade: m.cascade } : {}),
          ...(typeof m.fetch === 'string' ? { fetch: m.fetch } : {}),
          ...(typeof m.mappedBy === 'string' ? { mappedBy: m.mappedBy } : {}),
          ...(typeof m.orphanRemoval === 'string' ? { orphanRemoval: m.orphanRemoval } : {}),
        });
      }
    }

    // component scope: renders = own outgoing renders.
    if (node.kind === 'component') {
      collectRenders(nodeId, outgoing, keep, soul, brief, seenRenders, renders);
    }
  }

  // sort every array by (qualifiedName ?? name ?? id) for determinism; assemble only non-empty keys.
  routes.sort((a, b) => cmpLabel(labelOfRoute(a), labelOfRoute(b)));
  produces.sort((a, b) => cmpLabel(labelOfBrief(a.brief), labelOfBrief(b.brief)));
  dependencies.sort((a, b) => cmpLabel(labelOfBrief(a.brief), labelOfBrief(b.brief)));
  dependents.sort((a, b) => cmpLabel(labelOfBrief(a.brief), labelOfBrief(b.brief)));
  relations.sort((a, b) => cmpLabel(labelOfBrief(a.brief), labelOfBrief(b.brief)));
  renders.sort((a, b) => cmpLabel(labelOfBrief(a.brief), labelOfBrief(b.brief)));

  const out: DossierFrameworkSemantics = {};
  if (routes.length) out.routes = routes;
  if (produces.length) out.produces = produces;
  if (dependencies.length) out.dependencies = dependencies;
  if (dependents.length) out.dependents = dependents;
  if (relations.length) out.relations = relations;
  if (renders.length) out.renders = renders;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function buildAdjacency(soul: SoulStore, dir: 'out' | 'in'): Map<string, Edge[]> {
  const m = new Map<string, Edge[]>();
  for (const e of soul.iterateEdges()) {
    if (!FRAMEWORK_RELS.has(e.rel)) continue;
    const key = dir === 'out' ? e.src : e.dst;
    const arr = m.get(key);
    if (arr) arr.push(e);
    else m.set(key, [e]);
  }
  return m;
}

/** CLASS scope iff a symbol is a framework class OR class-like type OR has member-of children. */
function isClassScope(node: Node, incoming: Map<string, Edge[]>): boolean {
  if (node.kind !== 'symbol') return false;
  if (node.stereotype && CLASS_STEREOTYPES.has(node.stereotype)) return true;
  if (node.type && CLASS_TYPES.has(node.type)) return true;
  const ins = incoming.get(node.id);
  return !!ins && ins.some((e) => e.rel === 'member-of');
}

function isCallableSymbol(n: Node): boolean {
  return n.kind === 'symbol' && !!n.type && CALLABLE_TYPES.has(n.type);
}

/** A route entry from a route node (verbatim name/httpMethod/routePath/framework/params/security). */
function routeFromNode(rn: Node | undefined, confidence: number): DossierRoute | undefined {
  if (!rn) return undefined;
  const meta = (rn.meta ?? {}) as Record<string, unknown>;
  const params = Array.isArray(meta.params) ? (meta.params as DossierRoute['params']) : undefined;
  const security =
    meta.security !== undefined ? (meta.security as Record<string, unknown>) : undefined;
  return {
    id: rn.id,
    confidence,
    ...(rn.name ? { name: rn.name } : {}),
    ...(rn.httpMethod ? { httpMethod: rn.httpMethod } : {}),
    ...(rn.routePath ? { routePath: rn.routePath } : {}),
    ...(rn.framework ? { framework: rn.framework } : {}),
    ...(params ? { params } : {}),
    ...(security ? { security } : {}),
  };
}

/** A method's own return types from its meta (NOT the produced type's meta). */
function returnTypesOf(method: Node): { returnType?: string; returnElementType?: string } {
  const m = (method.meta ?? {}) as Record<string, unknown>;
  const out: { returnType?: string; returnElementType?: string } = {};
  if (typeof m.returnType === 'string') out.returnType = m.returnType;
  if (typeof m.returnElementType === 'string') out.returnElementType = m.returnElementType;
  return out;
}

/** The parent class of a method: the dst of its outgoing member-of edge that lands on a class-like symbol. */
function parentClassOf(method: Node, outgoing: Map<string, Edge[]>): string | undefined {
  for (const e of outgoing.get(method.id) ?? []) {
    if (e.rel !== 'member-of') continue;
    return e.dst;
  }
  return undefined;
}

/** Collect forward injects from `ownerId` into `dependencies` (dedup by dst id). */
function collectDependencies(
  ownerId: string,
  outgoing: Map<string, Edge[]>,
  keep: (e: Edge) => boolean,
  producerOf: Map<string, string>,
  soul: SoulStore,
  brief: (id: string, c: number) => AdjacentBrief,
  seen: Set<string>,
  out: DossierDependency[],
): void {
  for (const e of outgoing.get(ownerId) ?? []) {
    if (e.rel !== 'injects' || !keep(e)) continue;
    if (seen.has(e.dst)) continue;
    seen.add(e.dst);
    pushDependency(e, soul, brief, producerOf, out);
  }
}

/** Push one injects edge as a dependency, resolving the supply-chain kind (injects vs produces). */
function pushDependency(
  e: Edge,
  soul: SoulStore,
  brief: (id: string, c: number) => AdjacentBrief,
  producerOf: Map<string, string>,
  out: DossierDependency[],
): void {
  const dn = soul.getNode(e.dst);
  const producerId = producerOf.get(e.dst);
  const kind: 'injects' | 'produces' = producerId ? 'produces' : 'injects';
  out.push({
    id: e.dst,
    confidence: e.confidence,
    brief: brief(e.dst, e.confidence),
    ...(dn?.stereotype ? { stereotype: dn.stereotype } : {}),
    ...(dn?.framework ? { framework: dn.framework } : {}),
    kind,
    ...(e.evidence?.snippet ? { injectedAs: e.evidence.snippet } : {}),
    ...(producerId ? { producer: brief(producerId, e.confidence) } : {}),
  });
}

/** Append unresolved produces entries from a node's `meta.produces` type names with no emitted edge. */
function appendUnresolvedProduces(
  node: Node,
  outgoing: Map<string, Edge[]>,
  produces: DossierProduces[],
  seen: Set<string>,
): void {
  const m = (node.meta ?? {}) as Record<string, unknown>;
  const list = Array.isArray(m.produces) ? (m.produces as unknown[]) : [];
  const emitted = new Set<string>();
  for (const e of outgoing.get(node.id) ?? []) {
    if (e.rel === 'produces') emitted.add(e.dst);
  }
  for (const t of list) {
    if (typeof t !== 'string') continue;
    // unresolved iff NO produced-type symbol id matches this type name (best-effort: compare against
    // emitted dst ids + the produced brief qualifiedName/name — a resolver-linked type has an edge).
    const matches = [...emitted].some((id) => id.toLowerCase().includes(t.toLowerCase()));
    if (matches) continue;
    if (seen.has(`?${t}`)) continue;
    seen.add(`?${t}`);
    produces.push({
      id: '?',
      confidence: 0,
      brief: { id: '?', confidence: 0, qualifiedName: t },
      unresolved: true,
    });
  }
}

/** Append unresolved dependency entries from a class node's `meta.injects` type names with no edge. */
function appendUnresolvedInjects(
  classNode: Node,
  outgoing: Map<string, Edge[]>,
  dependencies: DossierDependency[],
  seen: Set<string>,
): void {
  const m = (classNode.meta ?? {}) as Record<string, unknown>;
  const list = Array.isArray(m.injects) ? (m.injects as unknown[]) : [];
  const emitted = new Set<string>();
  for (const e of outgoing.get(classNode.id) ?? []) {
    if (e.rel === 'injects') emitted.add(e.dst);
  }
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const matches = [...emitted].some((id) => id.toLowerCase().includes(t.toLowerCase()));
    if (matches) continue;
    if (seen.has(`?${t}`)) continue;
    seen.add(`?${t}`);
    dependencies.push({
      id: '?',
      confidence: 0,
      brief: { id: '?', confidence: 0, qualifiedName: t },
      kind: 'injects',
      injectedAs: t,
      unresolved: true,
    });
  }
}

/** Collect renders edges from `ownerId` into `renders` (dedup by dst id). */
function collectRenders(
  ownerId: string,
  outgoing: Map<string, Edge[]>,
  keep: (e: Edge) => boolean,
  soul: SoulStore,
  brief: (id: string, c: number) => AdjacentBrief,
  seen: Set<string>,
  out: DossierRenders[],
): void {
  for (const e of outgoing.get(ownerId) ?? []) {
    if (e.rel !== 'renders' || !keep(e)) continue;
    if (seen.has(e.dst)) continue;
    seen.add(e.dst);
    const cn = soul.getNode(e.dst);
    out.push({
      id: e.dst,
      confidence: e.confidence,
      brief: brief(e.dst, e.confidence),
      ...(cn?.framework ? { framework: cn.framework } : {}),
    });
  }
}

/** Stable label for sorting a route: "VERB /path". */
function labelOfRoute(r: DossierRoute): string {
  if (r.routePath) return `${r.httpMethod ?? ''} ${r.routePath}`;
  return r.name ?? r.id;
}

/** Stable label for sorting a brief-bearing entry: qualifiedName → name → id. */
function labelOfBrief(b: AdjacentBrief | undefined): string {
  return b?.qualifiedName ?? b?.name ?? b?.id ?? '';
}

/** Numeric comparator for the sort calls. */
function cmpLabel(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
