/**
 * Phase 3 — MuleSoft cross-file resolver. Consumes the `meta.references` the MuleExtractor records
 * on processor / module / route nodes and turns them into EXTRACTED edges against a project-scoped
 * symbol index, WITHOUT re-parsing XML (the extractor already recorded the cross-file names; this
 * layer resolves them deterministically against the soul). Resolves only within the same detected
 * Mule project (indexed by `projectId + type + name`); a reference that does not resolve is DROPPED,
 * never guessed. Dynamic flow-ref names (`#[…]` / `${…}`) are dropped + counted, never placeholders.
 *
 * Reference families resolved:
 *   flow-ref      enclosing flow symbol --calls--> target flow (evidence.callSite = processor id);
 *                a static missing target → an `external-flow` placeholder node + calls edge.
 *   config-ref    processor --references--> config symbol (evidence.referenceKind = 'config')
 *   endpoint      Mule 3 inbound/outbound-endpoint `ref` --references--> connector config
 *                (evidence.referenceKind = 'endpoint'; same `config` bucket as config-ref)
 *   exceptionStrategy  Mule 3 reference-exception-strategy `ref` --references--> global strategy
 *                config symbol (evidence.referenceKind = 'exceptionStrategy')
 *   property      DW module --references--> property symbol (evidence.referenceKind = 'property')
 *   import (DW)   DW file --imports--> imported module symbol (project-local; stdlib dropped)
 *   include (RAML) RAML file --imports--> included file node (path-suffix match)
 *
 * Deferred legacy families (honest gaps, not yet emitted by the extractor): Mule 3 transformer
 * `ref` and `<import resource="..."/>` config-file imports. The extractor decides when to emit
 * those reference kinds; the resolver needs no dialect branch once it does.
 *
 * Same-file flow-refs are SKIPPED here: the extractor already emitted the local statement→flow
 * `calls` edge; emitting a flow→flow edge too would double-count the relationship. The placeholder
 * nodes this resolver creates are returned alongside edges so the caller (runResolve) persists them.
 *
 * SECURITY (locked constraint): only KEYS + REFERENCES are resolved. Property VALUES never enter
 * this layer — the extractor stores `meta.valueRedacted = true` and no value, and this resolver
 * only matches property keys by name. A literal secret can never reach the graph via this path.
 */
import type { SoulStore } from '@knowledge-crib/core';
import type { FileMeta } from '@knowledge-crib/parsers';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import type { ResolveContext, ResolveResult, Resolver } from './resolver-registry.js';
import type { SymbolTable } from './symbol-table.js';
import type { ResolveStats } from './ts-resolver.js';

/** A reference the extractor surfaces (shape of `meta.references` entries on Mule nodes). The
 *  legacy Mule 3 kinds `endpoint` (inbound/outbound-endpoint `ref` → connector config) and
 *  `exceptionStrategy` (reference-exception-strategy `ref` → global strategy config) both resolve
 *  against the `config` symbol bucket — the extractor decides the kind, the resolver maps it to a
 *  `references` edge with a distinct `referenceKind` for migration clarity. */
interface MuleReference {
  kind:
    | 'flow-ref'
    | 'config-ref'
    | 'import'
    | 'include'
    | 'property'
    | 'resource'
    | 'type'
    | 'trait'
    | 'securityScheme'
    | 'endpoint'
    | 'exceptionStrategy';
  name: string;
}

/** The resolver's richer return: edges + placeholder NODES (for external-flow targets) + stats. */
export interface MuleResolveResult {
  edges: Edge[];
  /** placeholder nodes the resolver created (external-flow targets); the caller persists them. */
  nodes: Node[];
  stats: ResolveStats;
}

/** Mule symbol buckets indexed for resolution (projectId + bucket + name → node id). */
type Bucket = 'flow' | 'config' | 'property' | 'module';

const FLOW_TYPES = new Set(['flow', 'subflow']);

/** Resolve cross-file edges for all Mule project files. Pure: returns edges + nodes; caller persists. */
export function resolveMule(
  soul: SoulStore,
  table: SymbolTable,
  _root: string,
  files: FileMeta[],
): MuleResolveResult {
  const edges: Edge[] = [];
  const placeholders = new Map<string, Node>();
  const stats: ResolveStats = {
    imports: 0,
    calls: 0,
    inherits: 0,
    implements: 0,
    dropped: 0,
    dynamic: 0,
    externalFlows: 0,
  };
  const seen = new Set<string>();

  // filePath → projectId, for project-scoped resolution (only same-project targets resolve).
  const pathToProject = new Map<string, string>();
  for (const f of files) {
    if (f.classification?.family === 'mule') pathToProject.set(f.path, f.classification.projectId);
  }

  // 1) Build the project symbol index: (projectId, bucket, name) → node id. Iterate every node the
  //    extractor emitted for a Mule project file and bucket the resolvable symbols.
  const index = new Map<string, string>();
  for (const n of soul.iterate()) {
    if (!n.file) continue;
    const proj = pathToProject.get(n.file);
    if (!proj || !n.name || !n.type) continue;
    const bucket = bucketOf(n.type, n.lang);
    if (!bucket) continue;
    index.set(key(proj, bucket, n.name), n.id);
  }

  const push = (src: string, dst: string, rel: Rel, evidence: Record<string, unknown>): void => {
    const id = edgeId(src, dst, rel);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({
      id,
      src,
      dst,
      rel,
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
      evidence: { by: 'mule-resolver', ...evidence },
    });
  };

  // 2) Walk every node carrying meta.references and resolve each reference.
  for (const n of soul.iterate()) {
    if (!n.file) continue;
    const proj = pathToProject.get(n.file);
    if (!proj) continue;
    const refs = (n.meta?.references as MuleReference[] | undefined) ?? [];
    for (const ref of refs) {
      resolveReference(ref, n, proj, soul, table, index, push, placeholders, stats);
    }
  }

  return { edges, nodes: [...placeholders.values()], stats };
}

/** Map a Mule symbol type to a resolution bucket (or undefined = not a resolution target). */
function bucketOf(type: string, lang: string | undefined): Bucket | undefined {
  if (FLOW_TYPES.has(type)) return 'flow';
  if (type === 'config') return 'config';
  if (type === 'property') return 'property';
  if (type === 'module') return 'module';
  // DW declarations (function/variable/namespace/type) are not cross-file import targets here.
  if (lang === 'dataweave') return undefined;
  return undefined;
}

function key(proj: string, bucket: Bucket, name: string): string {
  return `${proj}#${bucket}#${name}`;
}

/** Resolve a single reference surfaced by the extractor. */
function resolveReference(
  ref: MuleReference,
  node: Node,
  proj: string,
  soul: SoulStore,
  table: SymbolTable,
  index: Map<string, string>,
  push: (src: string, dst: string, rel: Rel, evidence: Record<string, unknown>) => void,
  placeholders: Map<string, Node>,
  stats: ResolveStats,
): void {
  switch (ref.kind) {
    case 'flow-ref':
      resolveFlowRef(ref.name, node, proj, soul, table, index, push, placeholders, stats);
      return;
    case 'config-ref':
      resolveIndexedRef(ref, 'config', node, proj, index, push, 'config', stats);
      return;
    case 'endpoint':
      // Mule 3 inbound/outbound-endpoint `ref` → the connector config symbol.
      resolveIndexedRef(ref, 'config', node, proj, index, push, 'endpoint', stats);
      return;
    case 'exceptionStrategy':
      // Mule 3 reference-exception-strategy `ref` → the global exception-strategy config symbol.
      resolveIndexedRef(ref, 'config', node, proj, index, push, 'exceptionStrategy', stats);
      return;
    case 'property':
      resolveIndexedRef(ref, 'property', node, proj, index, push, 'property', stats);
      return;
    case 'import':
      resolveImport(ref.name, node, proj, index, table, push, stats);
      return;
    case 'include':
      resolveInclude(ref.name, node, soul, table, push, stats);
      return;
    default:
      // type / trait / securityScheme / resource — recorded but not resolved to a node here.
      stats.dropped++;
  }
}

/** A flow-ref: dynamic → drop; cross-file static → calls enclosing-flow → target; missing → placeholder. */
function resolveFlowRef(
  name: string,
  node: Node,
  proj: string,
  soul: SoulStore,
  table: SymbolTable,
  index: Map<string, string>,
  push: (src: string, dst: string, rel: Rel, evidence: Record<string, unknown>) => void,
  placeholders: Map<string, Node>,
  stats: ResolveStats,
): void {
  if (isDynamic(name)) {
    stats.dynamic = (stats.dynamic ?? 0) + 1;
    return;
  }
  const enclosing = enclosingFlowId(node, table);
  if (!enclosing) {
    stats.dropped++;
    return;
  }
  const targetId = index.get(key(proj, 'flow', name));
  if (targetId) {
    // Same-file flow-refs are already edged by the extractor (statement→flow); skip to avoid
    // double-counting. Only cross-file flow-refs get the flow→flow calls edge here.
    if (sameFile(node, targetId, soul)) {
      stats.dropped++;
      return;
    }
    push(enclosing, targetId, 'calls', { callSite: node.id, snippet: `flow-ref ${name}` });
    stats.calls = (stats.calls ?? 0) + 1;
    return;
  }
  // Static missing target → external-flow placeholder + calls edge.
  const placeholder = placeholderFor(proj, name, placeholders);
  push(enclosing, placeholder.id, 'calls', { callSite: node.id, snippet: `flow-ref ${name}` });
  stats.externalFlows = (stats.externalFlows ?? 0) + 1;
}

/** A config-ref / property reference → `references` edge to an indexed symbol, with referenceKind. */
function resolveIndexedRef(
  ref: MuleReference,
  bucket: Bucket,
  node: Node,
  proj: string,
  index: Map<string, string>,
  push: (src: string, dst: string, rel: Rel, evidence: Record<string, unknown>) => void,
  referenceKind: string,
  stats: ResolveStats,
): void {
  const targetId = index.get(key(proj, bucket, ref.name));
  if (!targetId) {
    stats.dropped++;
    return;
  }
  push(node.id, targetId, 'references', { referenceKind, snippet: `${ref.kind} ${ref.name}` });
  stats.references = (stats.references ?? 0) + 1;
}

/** A DW import → `imports` edge file → imported module (project-local only; stdlib dropped). */
function resolveImport(
  name: string,
  node: Node,
  proj: string,
  index: Map<string, string>,
  table: SymbolTable,
  push: (src: string, dst: string, rel: Rel, evidence: Record<string, unknown>) => void,
  stats: ResolveStats,
): void {
  // A dotted module path (dw::core::Strings) is stdlib/external — never a project module here.
  const localName = name.includes('::') ? undefined : name;
  const targetId = localName ? index.get(key(proj, 'module', localName)) : undefined;
  if (!targetId) {
    stats.dropped++;
    return;
  }
  if (!node.file) return;
  push(table.fileId(node.file), targetId, 'imports', { snippet: `import ${name}` });
  stats.imports = (stats.imports ?? 0) + 1;
}

/** A RAML `!include` → `imports` edge file → included file node (path-suffix match, no re-read). */
function resolveInclude(
  name: string,
  node: Node,
  soul: SoulStore,
  table: SymbolTable,
  push: (src: string, dst: string, rel: Rel, evidence: Record<string, unknown>) => void,
  stats: ResolveStats,
): void {
  if (!node.file) return;
  const targetPath = findIncludedFile(name, soul);
  if (!targetPath) {
    stats.dropped++;
    return;
  }
  push(table.fileId(node.file), table.fileId(targetPath), 'imports', {
    snippet: `!include ${name}`,
  });
  stats.imports = (stats.imports ?? 0) + 1;
}

/** The flow/subflow symbol that encloses a processor node (the `calls` src for a flow-ref). */
function enclosingFlowId(node: Node, table: SymbolTable): string | undefined {
  if (!node.file || !node.span) return undefined;
  return table.enclosingSymbolId(node.file, node.span.start);
}

/** True if the target node lives in the same file as the referencing node (extractor's territory). */
function sameFile(node: Node, targetId: string, soul: SoulStore): boolean {
  const target = [...soul.iterate()].find((n) => n.id === targetId);
  return !!target?.file && target.file === node.file;
}

/** Find or create the external-flow placeholder for a missing flow name (deduped by id). */
function placeholderFor(proj: string, name: string, placeholders: Map<string, Node>): Node {
  const id = idFor({ kind: 'symbol', path: `mule:${proj}`, qualifiedName: name, startLine: 0 });
  const existing = placeholders.get(id);
  if (existing) return existing;
  const node: Node = {
    id,
    kind: 'symbol',
    type: 'external-flow',
    lang: 'mule',
    name,
    qualifiedName: name,
    hash: contentHash(`external-flow:${proj}:${name}`),
    meta: { family: 'mule', projectId: proj, external: true },
  };
  placeholders.set(id, node);
  return node;
}

/** A flow-ref name is dynamic when it is a DataWeave expression (`#[…]`) or a placeholder (`${…}`). */
function isDynamic(name: string): boolean {
  return name.length === 0 || name.startsWith('#') || name.includes('${') || name.includes('#[');
}

/** Find an indexed Mule file whose repo-relative path matches an include path (exact or suffix). */
function findIncludedFile(includePath: string, soul: SoulStore): string | undefined {
  const norm = includePath.replace(/^\.\//, '');
  for (const n of soul.iterate('file')) {
    if (!n.file) continue;
    if (n.file === norm || n.file.endsWith(`/${norm}`)) return n.file;
  }
  return undefined;
}

/** MuleResolver — the {@link Resolver} adapter around {@link resolveMule}. The placeholder nodes
 *  are carried on the return value (extra `nodes` field); runResolve persists them. */
export class MuleResolver implements Resolver {
  name = 'mule-resolver';
  supports(file: FileMeta): boolean {
    return file.classification?.family === 'mule';
  }
  resolve(ctx: ResolveContext): ResolveResult {
    const r = resolveMule(ctx.soul, ctx.table, ctx.root, ctx.files);
    // ResolveResult carries edges + stats; the placeholder nodes ride along as an extra field the
    // caller (runResolve) reads when persisting resolver output.
    return { edges: r.edges, stats: r.stats, nodes: r.nodes } as ResolveResult & {
      nodes: Node[];
    };
  }
}
