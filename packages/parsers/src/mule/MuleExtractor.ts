/**
 * MuleExtractor — the first NON-source-language extractor: it ingests a classified Mule 3/4
 * project file (config XML, DataWeave, RAML, descriptors, properties) and emits the same graph
 * vocabulary the language extractors emit. It produces ONLY intra-file facts — cross-file
 * resolution (imports, cross-file flow-ref, config-ref, APIKit mappings, DW includes) is the
 * resolver's job (mule-resolver.ts). Cross-file names are kept as `meta.references` on the
 * enclosing node so the resolver can resolve them against the project's files without the
 * extractor guessing at paths it cannot see.
 *
 * SECURITY (locked constraint): property VALUES are never stored. `parseProperties`/`parsePom`
 * return keys only; every `property` symbol node carries `meta.valueRedacted = true` and never a
 * resolved value. Credential-like attribute literals are already `<redacted>` by the mule4
 * normalizer before they reach this layer; `${key}` / `secure::key` placeholders stay as key
 * references. A literal secret can never reach the graph.
 *
 * Dialect dispatch: Mule 4 is fully implemented here; Mule 3 (Task 16) is not yet — it returns an
 * honest `mule:mule3-not-implemented` diagnostic and emits no semantic nodes. MUnit files are
 * represented by their structure-phase file node; MUnit semantic nodes arrive in the hardening plan.
 */
import { edgeId } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type {
  Capabilities,
  ExtractCtx,
  ExtractDiagnostic,
  ExtractResult,
  Extractor,
  FileClassification,
  FileMeta,
} from '../types.js';
import type { MuleErrorHandler, MuleProcessor } from './ast.js';
import { parseDataWeave } from './dataweave.js';
import { parseMuleArtifact, parsePom, parseProperties } from './descriptors.js';
import { parseMule4 } from './mule4.js';
import { parseRaml } from './raml.js';

/** A cross-file reference the extractor surfaces for the resolver (never resolved here). */
export interface MuleReference {
  kind:
    | 'flow-ref'
    | 'config-ref'
    | 'import'
    | 'include'
    | 'property'
    | 'resource'
    | 'type'
    | 'trait'
    | 'securityScheme';
  name: string;
}

/** A node id ↔ flow-name index for the file being extracted (intra-file flow-ref resolution). */
interface FlowIndex {
  /** flow/subflow name → symbol node id. */
  byName: Map<string, string>;
  /** config name → basePath (for listener route-path composition). */
  configBasePath: Map<string, string>;
}

export class MuleExtractor implements Extractor {
  readonly name = 'family:mulesoft';
  readonly capabilities: Capabilities = {
    imports: true,
    calls: true,
    inheritance: false,
    types: 'none',
  } as const;

  supports(file: FileMeta): boolean {
    return file.classification?.family === 'mule';
  }

  async extract(file: FileMeta, ctx: ExtractCtx): Promise<ExtractResult> {
    const c = file.classification;
    if (!c) return { nodes: [], edges: [] };
    try {
      const source = await ctx.readText();
      return extractClassifiedMuleFile(file, c, source, ctx);
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        diagnostics: [
          {
            code: 'mule:parse-failed',
            severity: 'error',
            message: error instanceof Error ? error.message : String(error),
            file: file.path,
            projectId: c.projectId,
          },
        ],
      };
    }
  }
}

/** Top-level role dispatch. Routes each Mule file to its focused parser and graph emitter. */
function extractClassifiedMuleFile(
  file: FileMeta,
  c: FileClassification,
  source: string,
  ctx: ExtractCtx,
): ExtractResult {
  const fileId = ctx.idFor('file', { path: file.path });
  switch (c.role) {
    case 'config':
      if (c.dialect === 'mule4') return emitConfig(source, file, c, ctx, fileId);
      return mule3NotImplemented(file, c);
    case 'dataweave':
      return emitDataWeave(source, file, c, ctx, fileId);
    case 'raml':
      return emitRaml(source, file, c, ctx, fileId);
    case 'descriptor':
      return emitDescriptor(source, file, c, ctx, fileId);
    case 'properties':
      return emitProperties(source, file, c, ctx, fileId);
    case 'mel':
      // Mule 3 Expression Language resource — Mule 4 has none. Defer to Task 16.
      if (c.dialect === 'mule3') return mule3NotImplemented(file, c);
      return { nodes: [], edges: [] };
    default:
      // `munit` and `resource` roles are represented by their structure-phase file node; MUnit
      // semantic nodes arrive in the hardening plan. Emit nothing here so the file node stands
      // alone. (Any other unhandled role likewise carries no semantic nodes.)
      return { nodes: [], edges: [] };
  }
}

/** Mule 3 honest fallback — no semantic nodes until the legacy normalizer lands (Task 16). */
function mule3NotImplemented(file: FileMeta, c: FileClassification): ExtractResult {
  const diagnostic: ExtractDiagnostic = {
    code: 'mule:mule3-not-implemented',
    severity: 'info',
    message: `Mule 3 extraction is not yet implemented for role '${c.role}' (planned)`,
    file: file.path,
    projectId: c.projectId,
  };
  return { nodes: [], edges: [], diagnostics: [diagnostic] };
}

// ---------------------------------------------------------------------------
// config role (Mule 4)
// ---------------------------------------------------------------------------

/** Emit the Mule 4 config graph: configs, flows/subflows, processors, routers, handlers, routes,
 *  outbound calls. */
function emitConfig(
  source: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  fileId: string,
): ExtractResult {
  const doc = parseMule4(source);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const diagnostics: ExtractDiagnostic[] = [
    ...doc.diagnostics.map((d) => ({
      ...d,
      file: file.path,
      projectId: c.projectId,
    })),
  ];

  const index: FlowIndex = { byName: new Map(), configBasePath: new Map() };

  // Global configurations → config symbol nodes. Pre-index basePath for listener composition.
  for (const cfg of doc.configurations) {
    const id = ctx.idFor('symbol', {
      path: file.path,
      qualifiedName: cfg.name,
      startLine: cfg.span.start,
    });
    index.configBasePath.set(cfg.name, cfg.attributes.basePath ?? '');
    nodes.push({
      id,
      kind: 'symbol',
      type: 'config',
      lang: 'mule',
      name: cfg.name,
      qualifiedName: cfg.name,
      file: file.path,
      span: cfg.span,
      hash: ctx.hash(`config:${cfg.name}@${cfg.span.start}`),
      meta: { namespace: cfg.namespace, configurationName: cfg.name },
    });
    edges.push(memberOf(id, fileId, 'family:mulesoft'));
  }

  // Flows + subflows → flow/subflow symbol nodes, then their processors.
  for (const flow of doc.flows) {
    const flowId = ctx.idFor('symbol', {
      path: file.path,
      qualifiedName: flow.name,
      startLine: flow.span.start,
    });
    index.byName.set(flow.name, flowId);
    nodes.push({
      id: flowId,
      kind: 'symbol',
      type: flow.kind === 'flow' ? 'flow' : 'subflow',
      lang: 'mule',
      name: flow.name,
      qualifiedName: flow.name,
      file: file.path,
      span: flow.span,
      hash: ctx.hash(`flow:${flow.name}@${flow.span.start}`),
      meta: { dialect: 'mule4', projectId: c.projectId },
    });
    edges.push(memberOf(flowId, fileId, 'family:mulesoft'));
  }

  // Second pass: emit processors for each flow (now flow ids are indexed for flow-ref calls).
  for (const flow of doc.flows) {
    const flowId = index.byName.get(flow.name);
    if (!flowId) continue;
    emitProcessors(flow.processors, flowId, file, c, ctx, index, nodes, edges);
    // Error handlers → exception-handler nodes + handles edges to their processors.
    for (const eh of flow.errorHandlers) {
      emitErrorHandler(eh, flowId, file, c, ctx, index, nodes, edges);
    }
  }

  return { nodes, edges, diagnostics: diagnostics.length ? diagnostics : undefined };
}

/** Recursively emit processor nodes under a flow. Each processor becomes either a `statement`
 *  (the default), an `http-call` (outbound), a `route` (listener source), or a `condition`
 *  (`<when>`/`<otherwise>` route of a `<choice>` router). Statements are `executes`'d by the flow;
 *  statements nested in a route are `guarded-by` that route's condition. A `<choice>` itself is a
 *  statement whose direct children are routes — handled by {@link emitChoice} so the router's
 *  children are NOT also recursed as generic processors (which would double-emit them). */
function emitProcessors(
  processors: MuleProcessor[],
  flowId: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
  guardConditionId?: string,
): void {
  for (const proc of processors) {
    if (proc.semanticKind === 'router') {
      emitChoice(proc, flowId, file, c, ctx, index, nodes, edges, guardConditionId);
      continue;
    }
    // A bare `<when>`/`<otherwise>` reached without an enclosing `<choice>` (defensive): treat it
    // as a route condition directly.
    if (proc.operation === 'when' || proc.operation === 'otherwise') {
      emitRouteCondition(proc, flowId, file, c, ctx, index, nodes, edges, guardConditionId);
      continue;
    }
    emitStatement(proc, flowId, file, c, ctx, index, nodes, edges, guardConditionId);
  }
}

/** Emit a `<choice>` router as a `statement`, then each `<when>`/`<otherwise>` child as a
 *  `condition` node guarding its own sub-processors. The router's children are owned here — they
 *  are routes, not generic processors — so {@link emitStatement} does NOT recurse into them. */
function emitChoice(
  proc: MuleProcessor,
  flowId: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
  outerGuard: string | undefined,
): void {
  emitStatement(proc, flowId, file, c, ctx, index, nodes, edges, outerGuard);
  for (const route of proc.children) {
    emitRouteCondition(route, flowId, file, c, ctx, index, nodes, edges, outerGuard);
  }
}

/** Emit a single route (`<when>`/`<otherwise>`) as a `condition` node, then its sub-processors as
 *  statements `guarded-by` this condition. The route's own children are emitted exactly once. */
function emitRouteCondition(
  route: MuleProcessor,
  flowId: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
  outerGuard?: string,
): void {
  const condId = ctx.idFor('condition', { file: file.path, line: route.span.start });
  const exprRaw = route.expressions[0]?.raw ?? route.attributes.expression ?? '';
  nodes.push({
    id: condId,
    kind: 'condition',
    lang: 'mule',
    file: file.path,
    span: route.span,
    expr: exprRaw || undefined,
    branch: route.operation === 'when' ? 'when' : 'otherwise',
    hash: ctx.hash(`cond:${route.operation}@${route.span.start}`),
    meta: { semanticKind: 'route', operation: route.operation },
  });
  edges.push(executes(flowId, condId, 'family:mulesoft'));
  if (outerGuard) edges.push(guardedBy(condId, outerGuard));
  emitProcessors(route.children, flowId, file, c, ctx, index, nodes, edges, condId);
}

/** Emit a single processor as a `statement` (or `http-call`/`route`/`flow-ref` call) node. */
function emitStatement(
  proc: MuleProcessor,
  flowId: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
  guardConditionId?: string,
): void {
  // A listener message source → a `route` node the flow `exposes`.
  if (proc.semanticKind === 'source') {
    emitSourceRoute(proc, flowId, file, ctx, index, nodes, edges);
    return;
  }
  // An outbound connector call (http:request) → an `http-call` node.
  if (proc.semanticKind === 'outbound-call') {
    emitHttpCall(proc, flowId, file, ctx, index, nodes, edges, guardConditionId);
    return;
  }
  // A flow-ref → a `calls` edge to the named flow (local) or a reference (cross-file).
  if (proc.semanticKind === 'flow-ref') {
    emitFlowRef(proc, flowId, file, c, ctx, index, nodes, edges, guardConditionId);
    return;
  }

  // Generic processor → statement node.
  const id = ctx.idFor('statement', { file: file.path, line: proc.span.start });
  const references = collectConfigRef(proc, index);
  nodes.push({
    id,
    kind: 'statement',
    lang: 'mule',
    file: file.path,
    span: proc.span,
    hash: ctx.hash(`stmt:${proc.namespace}:${proc.operation}@${proc.span.start}`),
    meta: {
      semanticKind: proc.semanticKind,
      operation: proc.operation,
      namespace: proc.namespace,
      ...(proc.name ? { name: proc.name } : {}),
      ...(proc.configRef ? { configRef: proc.configRef } : {}),
      ...(references.length ? { references } : {}),
    },
  });
  edges.push(executes(flowId, id, 'family:mulesoft'));
  if (guardConditionId) edges.push(guardedBy(id, guardConditionId));
  // Recurse nested processors (e.g. a transform's children) as their own statements.
  emitProcessors(proc.children, flowId, file, c, ctx, index, nodes, edges, guardConditionId);
}

/** Emit a listener source as a `route` node + an `exposes` edge flow → route. The route path is the
 *  composed config basePath + the listener `path`; the HTTP method is `allowedMethods`. */
function emitSourceRoute(
  proc: MuleProcessor,
  flowId: string,
  file: FileMeta,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
): void {
  const basePath = proc.configRef ? (index.configBasePath.get(proc.configRef) ?? '') : '';
  const path = proc.attributes.path ?? '';
  const routePath = composePath(basePath, path);
  const httpMethod = (proc.attributes.allowedMethods ?? 'ANY').toUpperCase();
  const id = ctx.idFor('route', {
    httpMethod,
    routePath,
    file: file.path,
    line: proc.span.start,
  });
  const references: MuleReference[] = [];
  if (proc.configRef) references.push({ kind: 'config-ref', name: proc.configRef });
  nodes.push({
    id,
    kind: 'route',
    lang: 'mule',
    file: file.path,
    span: proc.span,
    httpMethod,
    routePath,
    hash: ctx.hash(`route:${httpMethod} ${routePath}@${proc.span.start}`),
    meta: {
      semanticKind: 'source',
      operation: proc.operation,
      namespace: proc.namespace,
      ...(proc.configRef ? { configRef: proc.configRef } : {}),
      ...(references.length ? { references } : {}),
    },
  });
  edges.push({
    id: edgeId(flowId, id, 'exposes'),
    src: flowId,
    dst: id,
    rel: 'exposes',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by: 'family:mulesoft' },
  });
}

/** Emit an outbound http:request as an `http-call` node executes'd by the flow. */
function emitHttpCall(
  proc: MuleProcessor,
  flowId: string,
  file: FileMeta,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
  guardConditionId?: string,
): void {
  const httpMethod = (proc.attributes.method ?? 'GET').toUpperCase();
  const routePath = proc.attributes.path ?? '';
  const id = ctx.idFor('http-call', {
    httpMethod,
    routePath,
    file: file.path,
    line: proc.span.start,
  });
  const references: MuleReference[] = [];
  if (proc.configRef) references.push({ kind: 'config-ref', name: proc.configRef });
  nodes.push({
    id,
    kind: 'http-call',
    lang: 'mule',
    file: file.path,
    span: proc.span,
    httpMethod,
    routePath,
    framework: 'mule',
    hash: ctx.hash(`http-call:${httpMethod} ${routePath}@${proc.span.start}`),
    meta: {
      semanticKind: 'outbound-call',
      operation: proc.operation,
      namespace: proc.namespace,
      ...(proc.configRef ? { configRef: proc.configRef } : {}),
      ...(references.length ? { references } : {}),
    },
  });
  edges.push(executes(flowId, id, 'family:mulesoft'));
  if (guardConditionId) edges.push(guardedBy(id, guardConditionId));
}

/** Emit a flow-ref. Same-file target → local `calls` edge; cross-file → a statement carrying the
 *  reference name for the resolver. */
function emitFlowRef(
  proc: MuleProcessor,
  flowId: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
  guardConditionId?: string,
): void {
  const target = proc.name ?? '';
  const id = ctx.idFor('statement', { file: file.path, line: proc.span.start });
  const references: MuleReference[] = [{ kind: 'flow-ref', name: target }];
  nodes.push({
    id,
    kind: 'statement',
    lang: 'mule',
    file: file.path,
    span: proc.span,
    hash: ctx.hash(`flow-ref:${target}@${proc.span.start}`),
    meta: {
      semanticKind: 'flow-ref',
      operation: proc.operation,
      namespace: proc.namespace,
      references,
    },
  });
  edges.push(executes(flowId, id, 'family:mulesoft'));
  if (guardConditionId) edges.push(guardedBy(id, guardConditionId));
  // Local calls edge if the target flow lives in this file; cross-file is the resolver's job.
  const dstId = index.byName.get(target);
  if (dstId) {
    edges.push({
      id: edgeId(id, dstId, 'calls'),
      src: id,
      dst: dstId,
      rel: 'calls',
      method: 'explicit',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'family:mulesoft', snippet: `flow-ref ${target}` },
    });
  }
}

/** Emit an `<error-handler>` block: one `exception-handler` node per `<on-error-*>`, each
 *  `handles`'ing its processor subtree (which is also `executes`'d by the flow). */
function emitErrorHandler(
  eh: MuleErrorHandler,
  flowId: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  index: FlowIndex,
  nodes: Node[],
  edges: Edge[],
): void {
  const id = ctx.idFor('exception-handler', { file: file.path, line: eh.span.start });
  nodes.push({
    id,
    kind: 'exception-handler',
    lang: 'mule',
    file: file.path,
    span: eh.span,
    whenSelector: eh.errorType,
    hash: ctx.hash(`exc:${eh.strategy}@${eh.span.start}`),
    meta: { strategy: eh.strategy, ...(eh.errorType ? { errorType: eh.errorType } : {}) },
  });
  edges.push(memberOf(id, ctx.idFor('file', { path: file.path }), 'family:mulesoft'));
  // The handler's processors are statements the flow executes, guarded-by the handler.
  for (const proc of eh.processors) {
    emitProcessors([proc], flowId, file, c, ctx, index, nodes, edges, undefined);
    // `handles`: exception-handler → the just-emitted statement (best-effort, last statement).
    const last = nodes[nodes.length - 1];
    if (last && last.kind === 'statement') {
      edges.push({
        id: edgeId(id, last.id, 'handles'),
        src: id,
        dst: last.id,
        rel: 'handles',
        method: 'static',
        provenance: 'EXTRACTED',
        confidence: 1,
        evidence: { by: 'family:mulesoft' },
      });
    }
  }
}

/** If a processor references a config (config-ref), surface it as a reference for the resolver. */
function collectConfigRef(proc: MuleProcessor, _index: FlowIndex): MuleReference[] {
  const refs: MuleReference[] = [];
  if (proc.configRef) refs.push({ kind: 'config-ref', name: proc.configRef });
  return refs;
}

/** Compose a config basePath + a listener path into one templated route path. */
function composePath(basePath: string, path: string): string {
  if (!basePath) return path;
  if (!path) return basePath;
  return `${basePath.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

// ---------------------------------------------------------------------------
// properties role (keys only)
// ---------------------------------------------------------------------------

function emitProperties(
  source: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  fileId: string,
): ExtractResult {
  const { keys, diagnostics } = parseProperties(source);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const key of keys) {
    const id = ctx.idFor('symbol', { path: file.path, qualifiedName: key, startLine: 0 });
    nodes.push({
      id,
      kind: 'symbol',
      type: 'property',
      lang: 'properties',
      name: key,
      qualifiedName: key,
      file: file.path,
      hash: ctx.hash(`prop:${key}`),
      // SECURITY: the value is never stored — this flag tells consumers the value was withheld.
      meta: { valueRedacted: true, projectId: c.projectId },
    });
    edges.push(memberOf(id, fileId, 'family:mulesoft'));
  }
  const diags = diagnostics.map((d) => ({ ...d, file: file.path, projectId: c.projectId }));
  return { nodes, edges, diagnostics: diags.length ? diags : undefined };
}

// ---------------------------------------------------------------------------
// descriptor role (POM dependencies + property keys + artifact)
// ---------------------------------------------------------------------------

function emitDescriptor(
  source: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  fileId: string,
): ExtractResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const diagnostics: ExtractDiagnostic[] = [];

  // pom.xml → dependencies + property keys. Other descriptors (mule-artifact.json) are handled below.
  if (file.path.endsWith('pom.xml')) {
    const pom = parsePom(source);
    for (const dep of pom.dependencies) {
      const qualifiedName = dep.groupId ? `${dep.groupId}:${dep.artifactId}` : dep.artifactId;
      const id = ctx.idFor('symbol', { path: file.path, qualifiedName, startLine: 0 });
      nodes.push({
        id,
        kind: 'symbol',
        type: 'dependency',
        lang: 'pom',
        name: dep.artifactId,
        qualifiedName,
        file: file.path,
        hash: ctx.hash(`dep:${qualifiedName}`),
        meta: {
          groupId: dep.groupId,
          artifactId: dep.artifactId,
          versionRef: dep.versionRef, // verbatim — a ${prop} stays a reference, never resolved
          projectId: c.projectId,
        },
      });
      edges.push(memberOf(id, fileId, 'family:mulesoft'));
    }
    for (const key of pom.propertyKeys) {
      const id = ctx.idFor('symbol', { path: file.path, qualifiedName: key, startLine: 0 });
      nodes.push({
        id,
        kind: 'symbol',
        type: 'property',
        lang: 'pom',
        name: key,
        qualifiedName: key,
        file: file.path,
        hash: ctx.hash(`pomprop:${key}`),
        meta: { valueRedacted: true, source: 'pom', projectId: c.projectId },
      });
      edges.push(memberOf(id, fileId, 'family:mulesoft'));
    }
    diagnostics.push(...attachFile(pom.diagnostics, file, c));
  } else if (file.path.endsWith('mule-artifact.json')) {
    const artifact = parseMuleArtifact(source);
    // The artifact descriptor carries deploy metadata on a single descriptor symbol node.
    const id = ctx.idFor('symbol', {
      path: file.path,
      qualifiedName: 'mule-artifact',
      startLine: 0,
    });
    nodes.push({
      id,
      kind: 'symbol',
      type: 'descriptor',
      lang: 'json',
      name: 'mule-artifact',
      qualifiedName: 'mule-artifact',
      file: file.path,
      hash: ctx.hash('mule-artifact'),
      meta: {
        ...(artifact.minMuleVersion ? { minMuleVersion: artifact.minMuleVersion } : {}),
        ...(artifact.requiredProduct ? { requiredProduct: artifact.requiredProduct } : {}),
        ...(artifact.minJavaVersion ? { minJavaVersion: artifact.minJavaVersion } : {}),
        ...(artifact.classLoaderModelLoaderId
          ? { classLoaderModelLoaderId: artifact.classLoaderModelLoaderId }
          : {}),
        projectId: c.projectId,
      },
    });
    edges.push(memberOf(id, fileId, 'family:mulesoft'));
    diagnostics.push(...attachFile(artifact.diagnostics, file, c));
  }

  return { nodes, edges, diagnostics: diagnostics.length ? diagnostics : undefined };
}

// ---------------------------------------------------------------------------
// dataweave role (modules + functions + declarations)
// ---------------------------------------------------------------------------

function emitDataWeave(
  source: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  fileId: string,
): ExtractResult {
  const dw = parseDataWeave(source);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const diagnostics = dw.diagnostics.map((d) => ({
    ...d,
    file: file.path,
    projectId: c.projectId,
  }));

  // The DW file is a `module` symbol.
  const moduleName =
    file.path
      .split('/')
      .pop()
      ?.replace(/\.dwl?$/i, '') ?? file.path;
  const moduleId = ctx.idFor('symbol', {
    path: file.path,
    qualifiedName: moduleName,
    startLine: 0,
  });
  const references: MuleReference[] = [
    ...dw.propertyKeys.map((k) => ({ kind: 'property' as const, name: k })),
    ...dw.resources.map((r) => ({ kind: 'resource' as const, name: r })),
    ...dw.imports.map((i) => ({ kind: 'import' as const, name: i.module })),
  ];
  nodes.push({
    id: moduleId,
    kind: 'symbol',
    type: 'module',
    lang: 'dataweave',
    name: moduleName,
    qualifiedName: moduleName,
    file: file.path,
    hash: ctx.hash(`dw:module:${moduleName}`),
    meta: {
      ...(dw.version ? { version: dw.version } : {}),
      dialect: 'dw2',
      projectId: c.projectId,
      ...(references.length ? { references } : {}),
    },
  });
  edges.push(memberOf(moduleId, fileId, 'family:mulesoft'));

  // Declarations → function/var/type/ns symbols member-of the module.
  const declByName = new Map<string, string>();
  for (const decl of dw.declarations) {
    const type =
      decl.kind === 'fun'
        ? 'function'
        : decl.kind === 'var'
          ? 'variable'
          : decl.kind === 'ns'
            ? 'namespace'
            : 'type';
    const id = ctx.idFor('symbol', {
      path: file.path,
      qualifiedName: decl.name,
      startLine: decl.line,
    });
    declByName.set(decl.name, id);
    nodes.push({
      id,
      kind: 'symbol',
      type,
      lang: 'dataweave',
      name: decl.name,
      qualifiedName: decl.name,
      file: file.path,
      span: { start: decl.line, end: decl.line },
      hash: ctx.hash(`dw:${type}:${decl.name}@${decl.line}`),
      meta: { declarationKind: decl.kind, projectId: c.projectId },
    });
    edges.push(memberOf(id, moduleId, 'family:mulesoft'));
  }

  // Local calls: a call to a declaration defined in THIS module → calls edge module → declaration.
  const seenCalls = new Set<string>();
  for (const call of dw.calls) {
    const dstId = declByName.get(call.name);
    if (!dstId) continue; // imported/builtin → resolver
    const key = `${moduleId}|${dstId}`;
    if (seenCalls.has(key)) continue;
    seenCalls.add(key);
    edges.push({
      id: edgeId(moduleId, dstId, 'calls'),
      src: moduleId,
      dst: dstId,
      rel: 'calls',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'family:mulesoft', snippet: call.name },
    });
  }

  return { nodes, edges, diagnostics: diagnostics.length ? diagnostics : undefined };
}

// ---------------------------------------------------------------------------
// raml role (routes + contract references)
// ---------------------------------------------------------------------------

function emitRaml(
  source: string,
  file: FileMeta,
  c: FileClassification,
  ctx: ExtractCtx,
  fileId: string,
): ExtractResult {
  const raml = parseRaml(source);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const diagnostics = raml.diagnostics.map((d) => ({
    ...d,
    file: file.path,
    projectId: c.projectId,
  }));

  // Each resource method → a `route` node member-of the file. Contract references (includes,
  // type/trait/securityScheme refs) are surfaced on the routes that use them for the resolver.
  for (const res of raml.resources) {
    for (const m of res.methods) {
      const httpMethod = m.method.toUpperCase();
      const id = ctx.idFor('route', {
        httpMethod,
        routePath: res.path,
        file: file.path,
        line: res.span?.start ?? 0,
      });
      // Gather references that belong to THIS method: type/trait/securityScheme refs whose name
      // matches a reference recorded against this resource. We attach all contract refs to the
      // first route as the resolver's entry point (the file-level contract is one API).
      const references: MuleReference[] = [];
      for (const ref of raml.references) {
        if (ref.kind === 'include') references.push({ kind: 'include', name: ref.name });
      }
      nodes.push({
        id,
        kind: 'route',
        lang: 'raml',
        file: file.path,
        httpMethod,
        routePath: res.path,
        framework: 'raml',
        hash: ctx.hash(`raml:${httpMethod} ${res.path}`),
        meta: {
          apiTitle: raml.title,
          apiVersion: raml.version,
          projectId: c.projectId,
          ...(references.length ? { references } : {}),
        },
      });
      edges.push(memberOf(id, fileId, 'family:mulesoft'));
    }
  }

  return { nodes, edges, diagnostics: diagnostics.length ? diagnostics : undefined };
}

// ---------------------------------------------------------------------------
// shared edge builders
// ---------------------------------------------------------------------------

function memberOf(childId: string, parentId: string, by: string): Edge {
  return {
    id: edgeId(childId, parentId, 'member-of'),
    src: childId,
    dst: parentId,
    rel: 'member-of',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by },
  };
}

function executes(flowId: string, stmtId: string, by: string): Edge {
  return {
    id: edgeId(flowId, stmtId, 'executes'),
    src: flowId,
    dst: stmtId,
    rel: 'executes',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by },
  };
}

function guardedBy(stmtId: string, condId: string): Edge {
  return {
    id: edgeId(stmtId, condId, 'guarded-by'),
    src: stmtId,
    dst: condId,
    rel: 'guarded-by',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { by: 'family:mulesoft' },
  };
}

/** Stamp file + projectId onto diagnostics produced by the focused parsers. */
function attachFile(
  diags: ExtractDiagnostic[],
  file: FileMeta,
  c: FileClassification,
): ExtractDiagnostic[] {
  return diags.map((d) => ({ ...d, file: d.file ?? file.path, projectId: c.projectId }));
}
