/**
 * NestJS + TypeORM framework-semantics extraction (schema 1.3) — the layer that puts a Node graph
 * "above SQL", the direct counterpart of {@link extractSpringSemantics} for the Java track. On top
 * of the syntactic symbol/CFG graph the TS compiler API already built it derives the artifacts that
 * let a team understand a NestJS service WITHOUT reading it:
 *
 *   1. STEREOTYPES — every `@Controller`/`@Injectable`/`@Module`/`@Entity` class is tagged
 *      `framework:'nestjs'` (or `'typeorm'` for entities) + `stereotype:'<role>'` on its symbol node.
 *      NestJS collapses services/repos/guards/pipes/interceptors/filters under `@Injectable`; those are
 *      tagged `'service'` (the dominant role) — an honest limitation NestJS itself encodes (one decorator
 *      for every provider; the role is naming/heritage convention, not metadata).
 *   2. ROUTES — every `@Get`/`@Post`/`@Put`/`@Delete`/`@Patch`/`@All`/`@Head`/`@Options` handler becomes a
 *      `route` node (`GET /api/loans/:id`) with the `@Controller('/api')` base path composed in, linked
 *      to its handler method by an `exposes` edge. Multi-path mappings (`@Get('/a','/b')`) emit one
 *      route per path. This is the API surface — the single most valuable artifact.
 *   3. DI GRAPH — NestJS uses IMPLICIT constructor injection (no annotation needed): every constructor
 *      param becomes an `injects` edge (consumer class → dependency type). `@Inject(token)` overrides
 *      the dep with a DI token; `@Inject()` property injection is supported too. Intra-file deps
 *      resolve here; cross-file deps are recorded on `meta.injects` for the resolver (and surfaced as
 *      unresolved by the dossier — honesty, not silence).
 *   4. MODULE PRODUCERS — a `@Module({ providers: [Foo, Bar] })` PRODUCES its providers: `produces`
 *      edges module → provider. This is the NestJS analog of Spring's `@Bean` producer graph — the DI
 *      container composition. `{ provide: Token, useFactory }` factories capture the `provide` token.
 *   5. TYPEORM RELATIONS — `@ManyToOne`/`@OneToMany`/`@OneToOne`/`@ManyToMany` on an `@Entity` property
 *      emit a `field` node + `references` edge field → related type (intra-file), with the cardinality
 *      (the relation-annotation name) on the edge meta. The element type behind `Payment[]`/`Promise<X>`
 *      is unwrapped so a collection association targets `Payment`, not `Array`.
 *   6. ENTITY COLUMNS — `@PrimaryColumn`/`@PrimaryGeneratedColumn`/`@Column`/`@JoinColumn` on an `@Entity`
 *      property stamp `meta.column` on the `field` node (PK flag, name, type, nullable/unique/length,
 *      join column, generation strategy).
 *   7. EXCEPTION FILTERS — a `@Catch(FooException)` filter class's `catch()` method is modeled as an
 *      `exception-handler` node (whenSelector = the caught type) + a `handles` edge → the catch method.
 *   8. GUARDS/ROLES — `@UseGuards(G)`/`@Roles('admin')` on a handler stamp `meta.security` on the route +
 *      method nodes (the access-control contract); class-level guards stamp the controller node.
 *   9. ROUTE-PARAM CONTRACT — `@Param`/`@Query`/`@Body`/`@Headers`/`@Session`/`@UploadedFile`/… on a
 *      handler param become `meta.params` on the route node (where each param is bound).
 *
 * Pure + additive: mutates class symbol nodes (stereotype/framework + class-level security) and
 * appends route/field/exception-handler nodes + exposes/injects/produces/references/handles edges. A
 * non-NestJS class is a no-op. Shares the 1.3 kinds/rels with Spring — no schema change.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import ts from 'typescript';
import type { ExtractCtx } from '../types.js';

/** Class-level decorator → architectural stereotype + framework tag. */
const CLASS_STEREOTYPE: Record<string, { stereotype: string; framework: string }> = {
  Controller: { stereotype: 'controller', framework: 'nestjs' },
  Injectable: { stereotype: 'service', framework: 'nestjs' },
  Module: { stereotype: 'module', framework: 'nestjs' },
  // TypeORM entities carry the entity model (relations/columns), not NestJS DI/routes — tagged typeorm.
  Entity: { stereotype: 'entity', framework: 'typeorm' },
};

/** Method route-mapping decorator → HTTP verb. `@All` maps to ANY (matches every verb). */
const MAPPING_VERB: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Delete: 'DELETE',
  Patch: 'PATCH',
  All: 'ANY',
  Head: 'HEAD',
  Options: 'OPTIONS',
};

/** TypeORM relation annotations — a property carrying one is an entity association. */
const RELATION_ANNOS = new Set(['ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany']);

/** TypeORM column annotations — a property carrying one carries persistence column metadata. */
const COLUMN_ANNOS = new Set(['Column', 'PrimaryColumn', 'PrimaryGeneratedColumn', 'JoinColumn']);

/** Handler-parameter binding decorator → where the param is bound (the route-param contract). */
const PARAM_BINDING: Record<string, string> = {
  Param: 'path',
  Query: 'query',
  Body: 'body',
  Headers: 'header',
  Session: 'session',
  UploadedFile: 'file',
  UploadedFiles: 'files',
  Ip: 'ip',
  HostParam: 'host',
};

/** Security/access-control decorators → `meta.security` (the access-control contract). */
const SECURITY_ANNOS = new Set(['UseGuards', 'Roles', 'Permissions']);

export interface NestPassInput {
  /** class symbols (ts.ClassDeclaration) with their id + qualifiedName, drawn from the extractor. */
  classSyms: Array<{ tsNode: ts.ClassDeclaration; id: string; qualifiedName: string }>;
  /** intra-file lookup: qualifiedName | simpleName → symbol id. */
  byKey: Map<string, string>;
  nodes: Node[];
  edges: Edge[];
  ctx: ExtractCtx;
  path: string;
  lineOf: (pos: number) => number;
  /** M2.5 — `lang` tag for emitted framework nodes ('typescript' | 'javascript'). */
  lang: 'typescript' | 'javascript';
}

export function extractNestSemantics(input: NestPassInput): void {
  const { classSyms, byKey, nodes, edges, ctx, path, lineOf, lang } = input;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const { tsNode, id, qualifiedName } of classSyms) {
    const classDecs = decors(tsNode);
    const stereo = nestStereotypeOf(classDecs);
    const classNode = nodeById.get(id);
    if (stereo && classNode) {
      classNode.framework = stereo.framework;
      classNode.stereotype = stereo.stereotype;
    }
    const isController = stereo?.stereotype === 'controller';
    const isEntity = stereo?.stereotype === 'entity';
    const basePath = isController ? controllerBasePath(classDecs) : '';

    // --- routes: one per @Verb-decorated method (controllers only) ---
    if (isController) {
      // class-level guards/roles stamp the controller's access-control contract.
      if (classNode) {
        const sec = securityOf(classDecs);
        if (sec) classNode.meta = { ...(classNode.meta ?? {}), security: sec };
      }
      for (const m of tsNode.members) {
        if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name)) continue;
        const mapDec = findDecBy(m, MAPPING_VERB);
        if (!mapDec) continue;
        const verb = MAPPING_VERB[simpleName(mapDec)]!;
        // Paths: one or more (`@Get('/a','/b')`); pathless → base path (NestJS does NOT derive a sub-
        // path from the method name — parity with Spring).
        const subs = allStringArgs(mapDec);
        const pathStrs = subs.length > 0 ? subs : [''];
        const routeMeta = routeMetaOf(m);
        const methodLine = lineOf(m.getStart());
        const methodEnd = lineOf(m.getEnd());
        for (const sub of pathStrs) {
          const routePath = joinPath(basePath, sub);
          const routeId = ctx.idFor('route', {
            httpMethod: verb,
            routePath,
            file: path,
            line: methodLine,
          });
          nodes.push({
            id: routeId,
            kind: 'route',
            name: `${verb} ${routePath}`,
            httpMethod: verb,
            routePath,
            framework: 'nestjs',
            file: path,
            span: { start: methodLine, end: methodEnd },
            lang,
            hash: ctx.hash(`${path}:route:${verb}:${routePath}`),
            ...(Object.keys(routeMeta).length ? { meta: routeMeta } : {}),
          });
          // exposes: the handler method symbol → the route it serves.
          const handlerId = byKey.get(`${qualifiedName}.${m.name.text}`);
          if (handlerId) edges.push(edge(handlerId, routeId, 'exposes', `${verb} ${routePath}`));
        }
        // per-method security on the method symbol node (parity with Spring's method-meta stamp).
        const methodId = byKey.get(`${qualifiedName}.${m.name.text}`);
        const methodNode = methodId ? nodeById.get(methodId) : undefined;
        if (methodNode) {
          const sec = securityOf(decors(m));
          if (sec) methodNode.meta = { ...(methodNode.meta ?? {}), security: sec };
        }
      }
    }

    // --- DI: NestJS implicit constructor injection — every ctor param → injects. @Inject(token)
    // overrides the dep with the DI token; a param-typed `@InjectRepository(Loan) r: Repository<Loan>`
    // keeps the Repository<Loan> type (the injected thing), recorded unresolved if not intra-file. ---
    if (stereo) {
      const recordedInjects: string[] = [];
      const ctor = tsNode.members.find((m): m is ts.ConstructorDeclaration =>
        ts.isConstructorDeclaration(m),
      );
      if (ctor) {
        for (const p of ctor.parameters) {
          const depType = paramDepType(p);
          if (!depType) continue;
          emitInject(id, depType, byKey, edges, recordedInjects);
        }
      }
      // property-based @Inject() injection (NestJS supports it; rarer than ctor injection).
      for (const m of tsNode.members) {
        if (!ts.isPropertyDeclaration(m) || !ts.isIdentifier(m.name)) continue;
        const pDecs = decors(m);
        const injectDec = pDecs.find((d) => simpleName(d) === 'Inject');
        if (!injectDec) continue;
        const depType = firstInjectToken(injectDec) ?? paramTypeOf(m);
        if (depType) emitInject(id, depType, byKey, edges, recordedInjects);
      }
      if (recordedInjects.length && classNode) {
        classNode.meta = { ...(classNode.meta ?? {}), injects: dedupe(recordedInjects) };
      }
    }

    // --- @Module producers: providers[] → produces (module → provider). The NestJS DI container
    // composition — the dual of the `injects` graph, mirroring Spring's @Bean producer graph. ---
    if (stereo?.stereotype === 'module') {
      const modDec = classDecs.find((d) => simpleName(d) === 'Module');
      const produced = moduleProviders(modDec);
      const recordedProduces: string[] = [];
      for (const prov of produced) {
        recordedProduces.push(prov);
        const targetId = byKey.get(prov);
        if (targetId) edges.push(edge(id, targetId, 'produces', prov));
      }
      if (recordedProduces.length && classNode) {
        const prev = (classNode.meta?.produces as string[] | undefined) ?? [];
        classNode.meta = {
          ...(classNode.meta ?? {}),
          produces: dedupe([...prev, ...recordedProduces]),
        };
      }
    }

    // --- @Catch exception filter: the filter's catch() method is modeled as an exception-handler node
    // (whenSelector = the caught type) + a handles edge → the catch method symbol. ---
    const catchDec = classDecs.find((d) => simpleName(d) === 'Catch');
    if (catchDec) {
      const catchMethod = tsNode.members.find(
        (m): m is ts.MethodDeclaration =>
          ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'catch',
      );
      if (catchMethod) {
        const whenSelector = firstInjectToken(catchDec) ?? undefined; // @Catch(FooException) → FooException
        const cLine = lineOf(catchMethod.getStart());
        const excId = ctx.idFor('exception-handler', { file: path, line: cLine });
        nodes.push({
          id: excId,
          kind: 'exception-handler',
          name: whenSelector ? `@Catch ${whenSelector}` : '@Catch',
          ...(whenSelector ? { whenSelector } : {}),
          framework: 'nestjs',
          file: path,
          span: { start: cLine, end: lineOf(catchMethod.getEnd()) },
          lang,
          hash: ctx.hash(`${path}:exch:${cLine}:${whenSelector ?? '*'}`),
        });
        const handlerId = byKey.get(`${qualifiedName}.catch`);
        if (handlerId) edges.push(edge(excId, handlerId, 'handles', whenSelector ?? 'Catch'));
      }
    }

    // --- TypeORM entity: emit `field` nodes for ORM-decorated properties + references + column meta.
    // A `field` node (not a `symbol`) is the ORM-semantic member the dossier's relation surfacing reads
    // (it filters member-of children by `kind === 'field'`). Non-ORM properties stay plain symbols. ---
    if (isEntity) {
      for (const m of tsNode.members) {
        if (!ts.isPropertyDeclaration(m) || !ts.isIdentifier(m.name)) continue;
        const pDecs = decors(m);
        const names = new Set(pDecs.map((d) => simpleName(d)));
        const hasRelation = pDecs.some((d) => RELATION_ANNOS.has(simpleName(d)));
        const hasColumn = pDecs.some((d) => COLUMN_ANNOS.has(simpleName(d)));
        if (!hasRelation && !hasColumn) continue;
        const propQ = `${qualifiedName}.${m.name.text}`;
        const startLine = lineOf(m.getStart());
        const endLine = lineOf(m.getEnd());
        const fieldTypeText = paramTypeOf(m);
        const fid = ctx.idFor('field', { path, qualifiedName: propQ, startLine });
        const fieldNode: Node = {
          id: fid,
          kind: 'field',
          name: m.name.text,
          qualifiedName: propQ,
          file: path,
          span: { start: startLine, end: endLine },
          lang,
          hash: ctx.hash(m.getText()),
          ...(fieldTypeText ? { dataType: fieldTypeText } : {}),
          signature: fieldTypeText ? `${fieldTypeText} ${m.name.text}` : m.name.text,
          meta: {
            parentQualifier: qualifiedName,
            ...(pDecs.length ? { annotations: pDecs.map((d) => decName(d)) } : {}),
          },
        };
        nodes.push(fieldNode);
        edges.push(memberOf(fid, id));
        // relation: field → related type (references), intra-file resolved. Element type unwrapped.
        if (hasRelation) {
          const relDec = pDecs.find((d) => RELATION_ANNOS.has(simpleName(d)))!;
          const relatedType = fieldElementType(fieldTypeText) ?? fieldTypeText;
          if (relatedType) {
            const targetId = byKey.get(relatedType);
            const e = edge(fid, relatedType, 'references', relatedType, 'lang:typescript/typeorm', {
              cardinality: simpleName(relDec),
            });
            if (targetId && targetId !== fid) {
              e.dst = targetId;
            }
            edges.push(e);
          }
        }
        // column metadata: @PrimaryColumn/@PrimaryGeneratedColumn/@Column/@JoinColumn → meta.column.
        const col = columnMetaOf(pDecs, names);
        if (col) fieldNode.meta = { ...(fieldNode.meta ?? {}), column: col };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Emit an `injects` edge (consumer → dependency type) when the type resolves intra-file; always
 *  record the dependency type name (for the cross-file resolver / unresolved surfacing). Self-injection
 *  is skipped. */
function emitInject(
  consumerId: string,
  depType: string,
  byKey: Map<string, string>,
  edges: Edge[],
  recorded: string[],
): void {
  recorded.push(depType);
  const depId = byKey.get(depType);
  if (depId && depId !== consumerId) {
    edges.push(edge(consumerId, depId, 'injects', depType));
  }
}

/** The architectural stereotype for a class from its decorators (first match wins). */
function nestStereotypeOf(
  classDecs: ts.Decorator[],
): { stereotype: string; framework: string } | undefined {
  for (const d of classDecs) {
    const s = CLASS_STEREOTYPE[simpleName(d)];
    if (s) return s;
  }
  return undefined;
}

/** `@Controller('/api')` base path — the first string-literal arg (else '' = root). */
function controllerBasePath(classDecs: ts.Decorator[]): string {
  const dec = classDecs.find((d) => simpleName(d) === 'Controller');
  return dec ? (firstStringArg(dec) ?? '') : '';
}

/** The first decorator on `node` whose simple name is in `set`, or undefined. */
function findDecBy(node: ts.Node, names: Record<string, unknown>): ts.Decorator | undefined {
  return decors(node).find((d) => simpleName(d) in names);
}

/** The dependency type for a constructor param: `@Inject(token)` overrides with the DI token, else
 *  the param's type annotation. `@Inject()` with no arg falls back to the type. */
function paramDepType(p: ts.ParameterDeclaration): string | undefined {
  const injectDec = decors(p).find((d) => simpleName(d) === 'Inject');
  if (injectDec) {
    const token = firstInjectToken(injectDec);
    if (token) return token;
  }
  return paramTypeOf(p);
}

/** The DI token of `@Inject(token)` / `@Catch(token)`: a string-literal or identifier arg's text. */
function firstInjectToken(dec: ts.Decorator): string | undefined {
  const a = decArgs(dec)[0];
  if (!a) return undefined;
  if (ts.isStringLiteral(a)) return a.text;
  if (ts.isIdentifier(a)) return a.text;
  return a.getText();
}

/** The `@Module` providers list as provider names (identifiers, or `provide` tokens of factories). */
function moduleProviders(modDec: ts.Decorator | undefined): string[] {
  if (!modDec) return [];
  const obj = decArgs(modDec).find(ts.isObjectLiteralExpression);
  if (!obj) return [];
  for (const prop of obj.properties) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !ts.isIdentifier(prop.name) ||
      prop.name.text !== 'providers'
    ) {
      continue;
    }
    if (!ts.isArrayLiteralExpression(prop.initializer)) return [];
    const out: string[] = [];
    for (const el of prop.initializer.elements) {
      if (ts.isIdentifier(el)) {
        out.push(el.text);
      } else if (ts.isObjectLiteralExpression(el)) {
        const provide = objRaw(el, 'provide');
        if (provide) {
          if (ts.isStringLiteral(provide)) out.push(provide.text);
          else if (ts.isIdentifier(provide)) out.push(provide.text);
          else out.push(provide.getText());
        }
      }
    }
    return out;
  }
  return [];
}

/** The route-param contract + security for a handler method, as a `meta` object for its route node. */
function routeMetaOf(m: ts.MethodDeclaration): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const params = routeParamsOf(m);
  if (params.length) meta.params = params;
  const sec = securityOf(decors(m));
  if (sec) meta.security = sec;
  return meta;
}

/** One entry per handler param that carries a binding decorator (`@Param`→path, `@Query`→query, …). */
function routeParamsOf(
  m: ts.MethodDeclaration,
): Array<{ name: string; type?: string; in: string }> {
  const out: Array<{ name: string; type?: string; in: string }> = [];
  for (const p of m.parameters) {
    const binding = decors(p).find((d) => simpleName(d) in PARAM_BINDING);
    if (!binding) continue;
    const loc = PARAM_BINDING[simpleName(binding)]!;
    const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText();
    const type = paramTypeOf(p);
    out.push({ name, ...(type ? { type } : {}), in: loc });
  }
  return out;
}

/** Security decorators on a node → `{ UseGuards: "JwtAuthGuard|AdminGuard", Roles: "admin|user" }`.
 *  The value is the guard-class names joined (for @UseGuards) or the role strings joined (for @Roles). */
function securityOf(decs: ts.Decorator[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const d of decs) {
    const n = simpleName(d);
    if (!SECURITY_ANNOS.has(n)) continue;
    const args = decArgs(d);
    if (n === 'Roles' || n === 'Permissions') {
      const vals = args
        .filter(ts.isStringLiteral)
        .map((a) => a.text)
        .join('|');
      if (vals) out[n] = vals;
    } else {
      // @UseGuards(G1, G2) → the guard class refs joined.
      const names = args
        .map((a) => a.getText())
        .filter((t) => t.length)
        .join('|');
      if (names) out[n] = names;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Entity column metadata for a property: `@PrimaryColumn`/`@PrimaryGeneratedColumn` (id + strategy),
 *  `@Column` (name/type/nullable/unique/length), `@JoinColumn` (the FK column name). */
function columnMetaOf(
  pDecs: ts.Decorator[],
  names: Set<string>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (names.has('PrimaryGeneratedColumn')) {
    out.id = true;
    const a = decArgs(pDecs.find((d) => simpleName(d) === 'PrimaryGeneratedColumn')!)[0];
    if (a) out.generated = ts.isStringLiteral(a) ? a.text : a.getText();
  } else if (names.has('PrimaryColumn')) {
    out.id = true;
    mergeColumnArgs(pDecs.find((d) => simpleName(d) === 'PrimaryColumn')!, out);
  }
  if (names.has('Column')) {
    mergeColumnArgs(pDecs.find((d) => simpleName(d) === 'Column')!, out);
  }
  if (names.has('JoinColumn')) {
    const a = decArgs(pDecs.find((d) => simpleName(d) === 'JoinColumn')!)[0];
    if (!a) out.joinColumn = true;
    else if (ts.isStringLiteral(a)) out.joinColumn = a.text;
    else if (ts.isObjectLiteralExpression(a)) {
      const name = objGet(a, 'name');
      if (name) out.joinColumn = name;
    } else out.joinColumn = a.getText();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Merge a `@Column`/`@PrimaryColumn` decorator's args into `out`: a bare string arg is the column
 *  `type`; an object arg carries `name`/`type`/`nullable`/`unique`/`length`. */
function mergeColumnArgs(dec: ts.Decorator, out: Record<string, unknown>): void {
  for (const a of decArgs(dec)) {
    if (ts.isStringLiteral(a)) {
      if (out.type === undefined) out.type = a.text;
    } else if (ts.isObjectLiteralExpression(a)) {
      const name = objGet(a, 'name');
      if (name) out.name = name;
      const type = objGet(a, 'type');
      if (type) out.type = type;
      const nullable = objGet(a, 'nullable');
      if (nullable) out.nullable = nullable;
      const unique = objGet(a, 'unique');
      if (unique) out.unique = unique;
      const length = objGet(a, 'length');
      if (length) out.length = length;
    }
  }
}

/** A value property of an object literal as text (StringLiteral/NumericLiteral/Identifier → `.text`,
 *  boolean/other → `.getText()`). `name: 'cust_name'` → "cust_name"; `nullable: false` → "false". */
function objGet(o: ts.ObjectLiteralExpression, key: string): string | undefined {
  const v = objRaw(o, key);
  if (!v) return undefined;
  if (ts.isStringLiteral(v) || ts.isNumericLiteral(v) || ts.isIdentifier(v)) return v.text;
  return v.getText();
}

/** The raw initializer expression of a property, or undefined. */
function objRaw(o: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key) {
      return p.initializer;
    }
  }
  return undefined;
}

/** Unwrap the element type behind `Payment[]` / `Array<Payment>` / `Promise<Payment>` / nested forms.
 *  A single `Applicant` returns itself; `Promise<Payment[]>` → "Payment". */
function fieldElementType(t: string | undefined): string | undefined {
  if (!t) return undefined;
  let s = t.trim();
  for (;;) {
    const m = s.match(/^(?:Promise|Array|ReadonlyArray)<(.+)>$/);
    if (m) {
      s = m[1]!.trim();
      continue;
    }
    if (/\[\s*\]$/.test(s)) {
      s = s.replace(/\[\s*\]$/, '').trim();
      continue;
    }
    break;
  }
  return s.length > 0 ? s : undefined;
}

/** The param/property's type annotation text, or undefined (`@Inject() x` with no type). */
function paramTypeOf(p: ts.ParameterDeclaration | ts.PropertyDeclaration): string | undefined {
  return p.type?.getText();
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

/** The decorators of a node (TS 5+ API; empty for none / unsupported nodes). `canHaveDecorators`
 *  narrows to `HasDecorators` so `getDecorators` type-checks; the spread gives a mutable array. */
function decors(node: ts.Node): ts.Decorator[] {
  return ts.canHaveDecorators(node) ? [...(ts.getDecorators(node) ?? [])] : [];
}

/** The simple (last-segment) name of a decorator: `@Controller('/x')` → "Controller";
 *  `@app.Get('/x')` → "Get". */
function simpleName(d: ts.Decorator): string {
  const e = d.expression;
  const callee = ts.isCallExpression(e) ? e.expression : e;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name))
    return callee.name.text;
  return callee.getText();
}

/** The full callee text of a decorator (for `meta.annotations`): `@Module({...})` → "Module". */
function decName(d: ts.Decorator): string {
  const e = d.expression;
  return (ts.isCallExpression(e) ? e.expression : e).getText();
}

/** The call arguments of a decorator, or [] for a marker decorator (`@Entity`). */
function decArgs(d: ts.Decorator): readonly ts.Expression[] {
  return ts.isCallExpression(d.expression) ? d.expression.arguments : [];
}

/** The first string-literal arg of a decorator, or undefined. */
function firstStringArg(d: ts.Decorator): string | undefined {
  return decArgs(d).find(ts.isStringLiteral)?.text;
}

/** Every string-literal arg of a decorator (the paths), in order. `@Get('/a','/b')` → ['/a','/b']. */
function allStringArgs(d: ts.Decorator): string[] {
  const out: string[] = [];
  for (const a of decArgs(d)) {
    if (ts.isStringLiteral(a)) out.push(a.text);
  }
  return out;
}

/** A `member-of` edge (field → owning class). */
function memberOf(childId: string, parentId: string): Edge {
  return {
    id: edgeId(childId, parentId, 'member-of'),
    src: childId,
    dst: parentId,
    rel: 'member-of',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by: 'lang:typescript/typeorm' },
  };
}

/** Edge factory. `by` defaults to nest; typeorm callers pass 'lang:typescript/typeorm'. `meta` is an
 *  optional initial meta object (e.g. references cardinality). The `dst` may be a type NAME that the
 *  caller swaps for a resolved symbol id after creation (references edge). */
function edge(
  src: string,
  dst: string,
  rel: Edge['rel'],
  snippet: string,
  by = 'lang:typescript/nest',
  meta?: Record<string, unknown>,
): Edge {
  const e: Edge = {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by, snippet },
  };
  if (meta && Object.keys(meta).length) e.meta = meta;
  return e;
}
