/**
 * Spring Boot framework-semantics extraction (schema 1.3) — the layer that puts a Java graph "above
 * SQL". On top of the syntactic symbol/CFG graph it derives the three artifacts that let a team
 * understand a Spring service WITHOUT reading it:
 *
 *   1. STEREOTYPES — every `@RestController`/`@Service`/`@Repository`/`@Component`/`@Configuration`/
 *      `@Entity` class is tagged `framework:'spring'` + `stereotype:'<role>'` on its symbol node, so
 *      the graph is filterable by architectural role.
 *   2. ROUTES — every `@GetMapping`/`@PostMapping`/`@RequestMapping(...)` handler becomes a `route`
 *      node (`GET /api/loans/{id}`) with the class-level base path composed in, linked to its handler
 *      method by an `exposes` edge. This is the API surface — the single most valuable artifact.
 *   3. DI GRAPH — constructor-injected params and `@Autowired` fields become `injects` edges
 *      (consumer class → dependency type). Intra-file deps resolve here; cross-file deps are recorded
 *      on `meta.injects` for the resolver.
 *   4. JPA RELATIONS — `@ManyToOne`/`@OneToMany`/`@ManyToMany`/`@OneToOne` fields on an `@Entity`
 *      emit a `references` edge field → related type (intra-file), the entity relationship model.
 *
 * Pure + additive: mutates class symbol nodes (stereotype/framework) and appends route/exposes/
 * injects/references. A non-Spring class is a no-op.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { ExtractCtx } from '../types.js';
import type { JavaAnno, JavaDef } from './parser.js';

/** Class-level annotation → architectural stereotype. */
const CLASS_STEREOTYPE: Record<string, string> = {
  RestController: 'controller',
  Controller: 'controller',
  Service: 'service',
  Repository: 'repository',
  Component: 'component',
  Configuration: 'config',
  Entity: 'entity',
  Embeddable: 'entity',
  ControllerAdvice: 'controller',
  RestControllerAdvice: 'controller',
};

/** Method-mapping annotation → HTTP verb. `RequestMapping` is ANY unless its args pin a method. */
const MAPPING_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ANY',
};

/** JPA relation annotations — a field carrying one is an entity association. */
const RELATION_ANNOS = new Set(['ManyToOne', 'OneToMany', 'ManyToMany', 'OneToOne']);

/** Spring Data repository base interfaces — a class/interface `extends` one is a repository bean
 *  EVEN without a `@Repository` annotation (Spring Data's convention). Stereotype detection falls
 *  back to this so `interface LoanRepo extends JpaRepository<Loan,Long>` is tagged `repository`. */
const REPOSITORY_BASES = new Set([
  'Repository',
  'CrudRepository',
  'PagingAndSortingRepository',
  'JpaRepository',
  'ReactiveRepository',
  'ReactiveCrudRepository',
  'ReactiveSortingRepository',
  'CoroutineRepository',
  'CoroutineCrudRepository',
  'ListCrudRepository',
  'ListRepository',
  'R2dbcRepository',
]);

/** Handler-parameter binding annotation → where the param is bound (the route-param contract). */
const PARAM_BINDING: Record<string, string> = {
  PathVariable: 'path',
  RequestParam: 'query',
  RequestBody: 'body',
  RequestHeader: 'header',
  CookieValue: 'cookie',
  RequestPart: 'part',
  ModelAttribute: 'form',
  MatrixVariable: 'matrix',
};

/** Security annotations on a handler method → `meta.security` (the access-control contract). */
const SECURITY_ANNOS = new Set(['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed']);

/** Spring Data query-method annotations → `meta.query` (the derived/read query contract). */
const QUERY_ANNOS = new Set(['Query', 'Modifying', 'Procedure']);

export interface SpringPassInput {
  classDefs: Array<{ def: JavaDef; id: string; qualifiedName: string }>;
  fieldDefs: Array<{ def: JavaDef; id: string; ownerId: string; ownerQ: string }>;
  symbols: Array<{ node: Node }>;
  byKey: Map<string, string>;
  nodes: Node[];
  edges: Edge[];
  ctx: ExtractCtx;
  path: string;
}

export function extractSpringSemantics(input: SpringPassInput): void {
  const { classDefs, fieldDefs, byKey, nodes, edges, ctx, path } = input;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // A class is a Spring-managed bean iff it carries a class-level stereotype annotation. DI and JPA
  // edges are emitted ONLY for beans — a `@Autowired` field / `@ManyToOne` in a non-managed class is
  // a no-op in Spring, and implicit constructor autowiring is a bean-only feature. Keeps the
  // framework graph honest (no false DI/relation edges on plain POJOs).
  const stereotypeById = new Map<string, string | undefined>();
  for (const { def, id } of classDefs) stereotypeById.set(id, stereotypeOf(def));
  const isBean = (cid: string): boolean => stereotypeById.get(cid) !== undefined;

  for (const { def, id, qualifiedName } of classDefs) {
    const stereotype = stereotypeById.get(id);
    const classNode = nodeById.get(id);
    if (stereotype && classNode) {
      classNode.framework = 'spring';
      classNode.stereotype = stereotype;
    }
    const isController = stereotype === 'controller';
    const basePath = isController ? classMappingPath(def) : '';

    // --- routes: one per mapping-annotated method (controllers only) ---
    if (isController) {
      for (const m of def.body) {
        if (m.kind !== 'method') continue;
        const mapping = mappingAnno(m);
        if (!mapping) continue;
        // HTTP verbs: a short-form mapping pins one verb; `@RequestMapping` is ANY unless
        // `method=RequestMethod.X` pins it (which may list several verbs: `method={GET,POST}` → both).
        const verbs =
          mapping.http === 'ANY'
            ? (requestMethodsOf(mapping.anno.args) ?? ['ANY'])
            : [mapping.http];
        // Paths: one or more (`@GetMapping("/x")`, `@GetMapping({"/a","/b"})`); pathless → base path.
        const subs = allQuoted(mapping.anno.args);
        const pathStrs = subs.length > 0 ? subs : [''];
        // Route-param contract + security, derived once per handler (shared across its verbs/paths).
        const routeMeta = routeMetaOf(m);
        for (const verb of verbs) {
          for (const sub of pathStrs) {
            const routePath = joinPath(basePath, sub);
            const routeId = ctx.idFor('route', {
              httpMethod: verb,
              routePath,
              file: path,
              line: m.startLine,
            });
            nodes.push({
              id: routeId,
              kind: 'route',
              name: `${verb} ${routePath}`,
              httpMethod: verb,
              routePath,
              framework: 'spring',
              file: path,
              span: { start: m.startLine, end: m.endLine },
              lang: 'java',
              ...(Object.keys(routeMeta).length ? { meta: routeMeta } : {}),
              hash: ctx.hash(`${path}:route:${verb}:${routePath}`),
            });
            // exposes: the handler method symbol → the route it serves.
            const handlerId = byKey.get(`${qualifiedName}.${m.name}`);
            if (handlerId) {
              edges.push(edge(handlerId, routeId, 'exposes', `${verb} ${routePath}`));
            }
          }
        }
      }
    }

    // --- DI: constructor-injected params → injects (beans only). Spring 4.3+ implicit autowire
    // applies to a SINGLE ctor; with multiple ctors the @Autowired one is the injection point (if none
    // is annotated, Spring uses a no-arg default ctor and injects via fields/setters — no ctor DI).
    // Self-injection is skipped by emitInject. Records' compact header ctor is in `def.paramTypes`. ---
    if (isBean(id)) {
      const recordedInjects: string[] = [];
      const ctors = def.body.filter((m) => m.kind === 'constructor');
      let ctorTypes: string[] = [];
      if (ctors.length === 1) {
        ctorTypes = ctors[0]?.paramTypes ?? [];
      } else if (ctors.length > 1) {
        const autowired = ctors.find((c) => c.annotations.includes('Autowired'));
        ctorTypes = autowired?.paramTypes ?? [];
      } else if (def.kind === 'record') {
        ctorTypes = def.paramTypes ?? []; // record compact ctor (no body member)
      }
      for (const depType of ctorTypes) {
        if (!depType) continue;
        emitInject(id, depType, byKey, edges, recordedInjects);
      }
      // @Autowired setter-method injection: `@Autowired void setX(X x)` — a single-param @Autowired
      // method is a Spring injection point (setter injection). Walk the bean's methods for these.
      for (const m of def.body) {
        if (m.kind !== 'method' || !m.annotations.includes('Autowired')) continue;
        const setterType = m.paramTypes?.[0];
        if (setterType) emitInject(id, setterType, byKey, edges, recordedInjects);
      }
      if (recordedInjects.length && classNode) {
        classNode.meta = { ...(classNode.meta ?? {}), injects: dedupe(recordedInjects) };
      }
    }

    // --- @Bean producer graph: a @Bean-annotated method in a @Configuration class PRODUCES its
    // return type — the Spring container's produced beans, the dual of the `injects` DI graph. A
    // collection-returning bean (`List<Payment> payments()`) produces the element type. Intra-file
    // resolved here; cross-file recorded on the method's `meta.produces` for Phase 3 to resolve. ---
    if (stereotype === 'config') {
      for (const m of def.body) {
        if (m.kind !== 'method' || !m.annotations.includes('Bean')) continue;
        const producedType = m.returnElementType ?? m.returnType;
        if (!producedType) continue;
        const methodId = byKey.get(`${qualifiedName}.${m.name}`);
        if (!methodId) continue;
        const targetId = byKey.get(producedType);
        if (targetId) edges.push(edge(methodId, targetId, 'produces', producedType));
        const methodNode = nodeById.get(methodId);
        if (methodNode) {
          const prev = (methodNode.meta?.produces as string[] | undefined) ?? [];
          methodNode.meta = {
            ...(methodNode.meta ?? {}),
            produces: dedupe([...prev, producedType]),
          };
        }
      }
    }

    // --- @ExceptionHandler advice: a `@ExceptionHandler` method in a @Controller / @ControllerAdvice
    // handles the listed exception type(s). Modeled as an `exception-handler` node (whenSelector = the
    // exception class(es), `A|B` for multi) + a `handles` edge exception-handler → method symbol. ---
    if (isController) {
      for (const m of def.body) {
        if (m.kind !== 'method' || !m.annotations.includes('ExceptionHandler')) continue;
        const handlerId = byKey.get(`${qualifiedName}.${m.name}`);
        if (!handlerId) continue;
        const excAnno = m.annos?.find((a) => a.name === 'ExceptionHandler');
        const whenSelector = exceptionTypesOf(excAnno?.args);
        const excId = ctx.idFor('exception-handler', { file: path, line: m.startLine });
        nodes.push({
          id: excId,
          kind: 'exception-handler',
          name: whenSelector ? `@ExceptionHandler ${whenSelector}` : '@ExceptionHandler',
          ...(whenSelector ? { whenSelector } : {}),
          framework: 'spring',
          file: path,
          span: { start: m.startLine, end: m.endLine },
          lang: 'java',
          hash: ctx.hash(`${path}:exch:${m.startLine}:${whenSelector ?? '*'}`),
        });
        edges.push(edge(excId, handlerId, 'handles', whenSelector ?? 'ExceptionHandler'));
      }
    }

    // --- per-method framework metadata (every bean stereotype): transactional / scheduled entry
    // points, security on the method, and Spring Data query methods. Each is stamped on the method
    // symbol node's `meta.*` so the graph carries the access-control + lifecycle + query contract. ---
    for (const m of def.body) {
      if (m.kind !== 'method') continue;
      const methodId = byKey.get(`${qualifiedName}.${m.name}`);
      if (!methodId) continue;
      const methodNode = nodeById.get(methodId);
      if (!methodNode) continue;
      const add: Record<string, unknown> = {};
      if (m.annotations.includes('Transactional')) add.transactional = true;
      const scheduled = m.annos?.find((a) => a.name === 'Scheduled');
      if (scheduled) add.scheduled = scheduledAnnoKind(scheduled.args) ?? 'scheduled';
      const query = m.annos?.find((a) => a.name === 'Query');
      if (query) {
        add.query = {
          jpql: allQuoted(query.args)[0],
          native: /\bnativeQuery\s*=\s*true\b/.test(query.args ?? ''),
        };
      }
      if (m.annotations.includes('Modifying')) add.modifying = true;
      if (m.annotations.includes('Procedure')) add.storedProcedure = true;
      const sec = securityOf(m);
      if (sec) add.security = sec;
      if (Object.keys(add).length) methodNode.meta = { ...(methodNode.meta ?? {}), ...add };
    }
  }

  // --- DI via @Autowired/@Inject/@Resource fields + JPA relations on @Entity fields (beans only) ---
  for (const { def, id, ownerId } of fieldDefs) {
    if (!isBean(ownerId)) continue; // a field in a non-bean class carries no Spring semantics
    const annos = def.annotations;
    const depType = def.fieldType;
    if (!depType) continue;
    if (annos.includes('Autowired') || annos.includes('Inject') || annos.includes('Resource')) {
      const owner = nodeById.get(ownerId);
      const recorded: string[] = [];
      emitInject(ownerId, depType, byKey, edges, recorded);
      if (recorded.length && owner) {
        const prev = (owner.meta?.injects as string[] | undefined) ?? [];
        owner.meta = { ...(owner.meta ?? {}), injects: dedupe([...prev, ...recorded]) };
      }
    }
    // JPA relation: field → related type (references edge), intra-file resolved. Only on an @Entity
    // (a @ManyToOne/@OneToMany on a non-entity field is not a persistence association). A
    // collection-valued association (`@OneToMany List<Payment> payments`) targets the generic element
    // type (`Payment`), NOT the collection head (`List`) — `fieldElementType` carries it; single
    // types (`@ManyToOne Applicant applicant`) fall back to `fieldType`. The relation's cardinality
    // attributes (cascade / fetch / mappedBy / orphanRemoval) ride on the edge `meta`.
    if (stereotypeById.get(ownerId) === 'entity' && annos.some((a) => RELATION_ANNOS.has(a))) {
      const relatedType = def.fieldElementType ?? depType;
      const targetId = byKey.get(relatedType);
      if (targetId) {
        const relAnno = def.annos?.find((a) => RELATION_ANNOS.has(a.name));
        const relMeta = relationMetaOf(relAnno?.args);
        // cardinality = the relation annotation NAME itself (ManyToOne/OneToMany/ManyToMany/
        // OneToOne) — the multiplicity of the association. The args only carry cascade/fetch/
        // mappedBy/orphanRemoval, so without this the multiplicity is extracted then dropped.
        if (relAnno) relMeta.cardinality = relAnno.name;
        const e = edge(id, targetId, 'references', relatedType);
        if (Object.keys(relMeta).length) e.meta = relMeta;
        edges.push(e);
      }
    }
    // Entity column metadata: @Id / @Column / @GeneratedValue / @JoinColumn on an @Entity field →
    // `meta.column` on the field node (the persistence model — PK flag, column name, generation
    // strategy, join column). A non-annotated entity field carries no column meta.
    if (stereotypeById.get(ownerId) === 'entity') {
      const col = columnMetaOf(def);
      if (col) {
        const fieldNode = nodeById.get(id);
        if (fieldNode) fieldNode.meta = { ...(fieldNode.meta ?? {}), column: col };
      }
    }
  }
}

/** Emit an `injects` edge (consumer → dependency type) when the type resolves intra-file; always
 *  record the dependency type name (for the cross-file resolver). Self-injection is skipped. */
function emitInject(
  consumerId: string,
  depType: string,
  byKey: Map<string, string>,
  edges: Edge[],
  recorded: string[],
): void {
  recorded.push(depType);
  const depId = byKey.get(depType);
  if (depId && depId !== consumerId) edges.push(edge(consumerId, depId, 'injects', depType));
}

/** The architectural stereotype for a class from its annotations (first match wins), falling back
 *  to a Spring Data repository base interface (`extends JpaRepository<…>` → repository) — a Spring
 *  Data repo carries no `@Repository` annotation, so the bases are the only signal. */
function stereotypeOf(def: JavaDef): string | undefined {
  for (const a of def.annotations) {
    const s = CLASS_STEREOTYPE[a];
    if (s) return s;
  }
  if (def.kind === 'interface' && def.bases.some((b) => REPOSITORY_BASES.has(b))) {
    return 'repository';
  }
  return undefined;
}

/** Class-level base path from `@RequestMapping("/api")` / `@RequestMapping(value="/api")`. A
 *  class-level mapping with multiple paths is unusual; the first is the base. */
function classMappingPath(def: JavaDef): string {
  const anno = (def.annos ?? []).find((a) => a.name === 'RequestMapping');
  return anno ? (allQuoted(anno.args)[0] ?? '') : '';
}

/** The method's mapping annotation + its HTTP verb, if any. */
function mappingAnno(m: JavaDef): { anno: JavaAnno; http: string } | undefined {
  for (const a of m.annos ?? []) {
    const http = MAPPING_HTTP[a.name];
    if (http) return { anno: a, http };
  }
  return undefined;
}

/** Every double-quoted literal in an annotation's args (the paths), unquoted, in order.
 *  `"/x"` → ["/x"]; `{"/a","/b"}` → ["/a","/b"]; `value="/x"` → ["/x"]. Empty if none quoted. */
function allQuoted(s?: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"/g)) out.push(m[1]!);
  return out;
}

/** HTTP methods pinned by `@RequestMapping(method = RequestMethod.GET)` / `method={GET,POST}`, in
 *  order. The `/g` flag captures every `RequestMethod.X` so a multi-verb mapping yields all verbs. */
function requestMethodsOf(s?: string): string[] | undefined {
  if (!s) return undefined;
  const out: string[] = [];
  for (const m of s.matchAll(/RequestMethod\.([A-Z]+)/g)) out.push(m[1]!);
  return out.length > 0 ? out : undefined;
}

/** Join a controller base path with a method sub-path into one normalized `/a/b` route path. */
function joinPath(base: string, sub: string): string {
  const a = base.replace(/\/+$/, '');
  const b = sub.replace(/^\/+/, '');
  const joined = b ? `${a}/${b}` : a;
  const out = joined.startsWith('/') ? joined : `/${joined}`;
  return out.replace(/\/{2,}/g, '/') || '/';
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** The route-param contract + security for a handler method, as a `meta` object for its route node. */
function routeMetaOf(m: JavaDef): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const params = routeParamsOf(m);
  if (params.length) meta.params = params;
  const sec = securityOf(m);
  if (sec) meta.security = sec;
  return meta;
}

/** One entry per handler param that carries a binding annotation (`@PathVariable`→path,
 *  `@RequestParam`→query, `@RequestBody`→body, `@RequestHeader`→header, `@CookieValue`→cookie,
 *  `@RequestPart`→part, `@ModelAttribute`→form, `@MatrixVariable`→matrix). */
function routeParamsOf(m: JavaDef): Array<{ name: string; type?: string; in: string }> {
  const out: Array<{ name: string; type?: string; in: string }> = [];
  const names = m.params ?? [];
  const types = m.paramTypes ?? [];
  const annosList = m.paramAnnos ?? [];
  for (let i = 0; i < names.length; i++) {
    const annos = annosList[i] ?? [];
    const binding = annos.find((a) => PARAM_BINDING[a]);
    if (!binding) continue;
    out.push({
      name: names[i]!,
      ...(types[i] ? { type: types[i] } : {}),
      in: PARAM_BINDING[binding]!,
    });
  }
  return out;
}

/** Security annotations on a method → `{ PreAuthorize: "hasRole('ADMIN')", Secured: "ROLE_A|ROLE_B" }`.
 *  The value is the quoted expression (for @PreAuthorize/@PostAuthorize) or the joined roles array. */
function securityOf(m: JavaDef): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const a of m.annos ?? []) {
    if (!SECURITY_ANNOS.has(a.name)) continue;
    const v = allQuoted(a.args).join('|');
    out[a.name] = v || (a.args?.trim() ?? '');
  }
  return Object.keys(out).length ? out : undefined;
}

/** Exception types from `@ExceptionHandler({SQLException.class, IOException.class})` / `(X.class)`,
 *  joined `A|B`. Undefined for a marker `@ExceptionHandler` (handles any). */
function exceptionTypesOf(s?: string): string | undefined {
  if (!s) return undefined;
  const out: string[] = [];
  for (const m of s.matchAll(/(\w+)\.class/g)) out.push(m[1]!);
  return out.length ? out.join('|') : undefined;
}

/** The kind of a `@Scheduled` trigger: `cron` / `fixedRate` / `fixedDelay` (else `'scheduled'`). */
function scheduledAnnoKind(s?: string): string | undefined {
  if (!s) return undefined;
  if (/\bcron\s*=/.test(s)) return 'cron';
  if (/\bfixedRate\b/.test(s)) return 'fixedRate';
  if (/\bfixedDelay\b/.test(s)) return 'fixedDelay';
  return 'scheduled';
}

/** JPA relation cardinality attributes from the relation annotation args:
 *  `cascade`, `fetch`, `mappedBy`, `orphanRemoval`. `{}` if none present. */
function relationMetaOf(s?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  const mappedBy = matchKV(s, 'mappedBy');
  if (mappedBy) out.mappedBy = mappedBy;
  const cascade = matchKV(s, 'cascade');
  if (cascade) out.cascade = cascade;
  const fetch = matchKV(s, 'fetch');
  if (fetch) out.fetch = fetch;
  if (/orphanRemoval\s*=\s*true/.test(s)) out.orphanRemoval = 'true';
  return out;
}

/** Entity column metadata for a field: `@Id` (id flag), `@Column` (name/nullable/unique/length),
 *  `@GeneratedValue` (strategy), `@JoinColumn` (the FK column name). Undefined if none present. */
function columnMetaOf(def: JavaDef): Record<string, unknown> | undefined {
  const annos = def.annotations;
  const hasId = annos.includes('Id');
  const colAnno = def.annos?.find((a) => a.name === 'Column');
  const joinAnno = def.annos?.find((a) => a.name === 'JoinColumn');
  const genAnno = def.annos?.find((a) => a.name === 'GeneratedValue');
  if (!hasId && !colAnno && !joinAnno && !genAnno) return undefined;
  const out: Record<string, unknown> = {};
  if (hasId) out.id = true;
  if (colAnno) {
    const name = matchKV(colAnno.args ?? '', 'name');
    if (name) out.name = name;
    const nullable = matchKV(colAnno.args ?? '', 'nullable');
    if (nullable) out.nullable = nullable;
    const unique = matchKV(colAnno.args ?? '', 'unique');
    if (unique) out.unique = unique;
    const length = matchKV(colAnno.args ?? '', 'length');
    if (length) out.length = length;
  }
  if (joinAnno) {
    const name = matchKV(joinAnno.args ?? '', 'name');
    out.joinColumn = name ?? true;
  }
  if (genAnno) {
    const strategy = matchKV(genAnno.args ?? '', 'strategy');
    out.generated = strategy ?? true;
  }
  return out;
}

/** Extract `key = value` from annotation args; value is a brace group `{...}` or text up to `,`/`}`.
 *  Quoted strings are unquoted. `fetch = FetchType.LAZY` → "FetchType.LAZY";
 *  `mappedBy = "payments"` → "payments"; `cascade = {CascadeType.PERSIST}` → "{CascadeType.PERSIST}". */
function matchKV(s: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}\\s*=\\s*(\\{[^}]*\\}|[^,}]+)`);
  const m = re.exec(s);
  return m ? m[1]!.trim().replace(/"/g, '') : undefined;
}

function edge(src: string, dst: string, rel: Edge['rel'], snippet: string): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by: 'lang:java/spring', snippet },
  };
}
