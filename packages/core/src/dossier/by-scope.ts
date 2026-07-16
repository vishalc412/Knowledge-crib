/**
 * Dossier-by-scope (Workstream WS-4) — bulk per-symbol dossiers for every symbol in a scope
 * (a package's members, a file's symbols, or a cluster's symbols), built in ONE call.
 *
 * The analyst flow this serves: `crib context --package PKG_LOAN_RULE_ENGINE` returns the deep
 * reusable context for ALL ~50 members at once — the constants, bodies, callers/callees, decision
 * tables, and linked docs for every procedure — so a migration plan built from crib (Plan A) sees
 * the same per-symbol detail a full code read (Plan B) sees, without 50 round-trips.
 *
 * Purity contract: PURE over the soul + repoRoot (no IndexStore, no network, no enricher) — the same
 * contract as {@link buildDossier}. The 1-scan optimization: `iterateEdges()` is walked ONCE to build
 * outgoing + incoming adjacency, then every per-symbol {@link buildDossier} reuses it via the
 * `outgoing`/`incoming` {@link DossierOpts} fields (additive; absent → buildDossier builds its own,
 * so the single-symbol path is unchanged).
 */
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import type { SoulStore } from '../soul-store.js';
import { buildDossier } from './builder.js';
import type { Dossier, DossierOpts } from './builder.js';

/** The scope kinds `dossierByScope` enumerates symbols within. */
export type DossierScope = 'package' | 'file' | 'cluster';

/** Options for {@link buildDossiersByScope}. */
export interface DossiersByScopeOpts {
  /** when true, drop non-EXTRACTED edges from each dossier (trust filter). */
  extractedOnly?: boolean;
  /** when true, resolve reads/writes table names in each callable's decision table (extra lookups). */
  includeTables?: boolean;
  /** char cap for each rehydrated source body (default {@link DEFAULT_BODY_MAX_CHARS}). */
  sourceMaxChars?: number;
  /** line cap for each rehydrated source body (default {@link DEFAULT_BODY_MAX_LINES}). */
  sourceMaxLines?: number;
  /** cap on the number of per-symbol dossiers returned (default 1000; `truncated` flags a cap). */
  maxSymbols?: number;
  /** skip the first `offset` resolved symbols (resume cursor for token-budget paging; M1.2). */
  offset?: number;
}

/** The bulk result: per-symbol dossiers + scope metadata + honesty flags. */
export interface DossiersByScope {
  scope: DossierScope;
  /** the resolved scope-node id (the package / file / cluster node). */
  id: string;
  /** a human label for the scope node (qualifiedName / path / slug), for headers + attribution. */
  label: string;
  schemaVersion: string;
  builtAt: string;
  /** the per-symbol dossiers (capped at maxSymbols); each is a full {@link Dossier}. */
  symbols: Dossier[];
  /** number of symbol ids enumerated within the scope (the pre-cap member count; may exceed
   *  `symbols.length` when capped). This is the count of resolved member ids, NOT the count of
   *  dossiers built — use `symbols.length` for that. */
  symbolCount: number;
  /** true iff `symbols` was capped at maxSymbols. */
  truncated: boolean;
  /** member ids that resolved to NO dossier. Defensive invariant: enumerateSymbols only yields
   *  ids whose node exists (member-of srcs are node-checked; file/cluster symbols come straight from
   *  `iterate('symbol')`), so under the current contract this is always empty. It is kept + surfaced
   *  so a future membership source that could yield a stale id (e.g. a deleted node still referenced by
   *  an edge) is reported honestly rather than silently dropped. */
  skipped: string[];
}

/** Default cap — large enough for any real package, small enough to bound a single response. */
const DEFAULT_MAX_SYMBOLS = 1000;

/**
 * Build per-symbol dossiers for every symbol in a scope, pure over the soul + repoRoot. Returns
 * `undefined` when the scope node cannot be resolved (the verb layer emits NOT_FOUND). The scope
 * `id` is resolved as:
 *   • package — a symbol node with type 'package' matching the id (exact), qualified name, or name
 *     (case-insensitive); members are the incoming `member-of` symbol children.
 *   • file — a file node (`file:<path>`) by exact id, or `<path>`; symbols are those whose `file`
 *     matches the file node's path.
 *   • cluster — a cluster node by exact id (`c:<slug>`) or slug; symbols are those sharing its id.
 *
 * 1-scan invariant — `iterateEdges()` is walked EXACTLY ONCE (to build outgoing + incoming adjacency
 * + the `produces` supply-chain map), and `iterate('symbol')` is walked ONCE (to build the
 * lowercased name index for coverage call-site resolution + to enumerate file/cluster symbols).
 * Every per-symbol {@link buildDossier} reuses that adjacency + the name index via the `outgoing` /
 * `incoming` / `producerOf` / `nameIndex` {@link DossierOpts} fields (additive; absent → buildDossier
 * builds its own, so the single-symbol path is unchanged). Package members are derived from the
 * already-built `incoming` map (filtered to `member-of` dsts) — no second edge scan.
 */
export function buildDossiersByScope(
  soul: SoulStore,
  repoRoot: string,
  scope: DossierScope,
  id: string,
  now: string,
  opts: DossiersByScopeOpts = {},
): DossiersByScope | undefined {
  const scopeNode = resolveScopeNode(soul, scope, id);
  if (!scopeNode) return undefined;

  // ONE iterateEdges() pass → outgoing + incoming adjacency AND the `produces` supply-chain map
  // (dst-type → src-producer). All three are reused by every per-symbol buildDossier + the
  // frameworkSemantics / computeCoverage callees inside it, so the bulk path scans edges ONCE
  // regardless of how many members the scope holds (the WS-4 1-scan optimization).
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const producerOf = new Map<string, string>();
  for (const e of soul.iterateEdges()) {
    const o = outgoing.get(e.src);
    if (o) o.push(e);
    else outgoing.set(e.src, [e]);
    const i = incoming.get(e.dst);
    if (i) i.push(e);
    else incoming.set(e.dst, [e]);
    if (e.rel === 'produces' && !producerOf.has(e.dst)) producerOf.set(e.dst, e.src);
  }

  // ONE iterate('symbol') pass → the lowercased name index for coverage call-site resolution
  // (reused by every callable dossier's computeCoverage) AND the file/cluster member ids (so the
  // file + cluster paths do NOT re-scan symbols). The package path uses the `incoming` adjacency
  // instead (members are `member-of` dsts), so it touches neither this pass nor a second edge scan.
  const nameIndex = new Set<string>();
  const scopeMembers: string[] = [];
  const filePath =
    scope === 'file' ? (scopeNode.file ?? scopeNode.id.replace(/^file:/, '')) : undefined;
  const clusterId = scope === 'cluster' ? scopeNode.id : undefined;
  for (const n of soul.iterate('symbol')) {
    if (n.name) nameIndex.add(n.name.toLowerCase());
    if (n.qualifiedName) {
      nameIndex.add(n.qualifiedName.toLowerCase());
      nameIndex.add((n.qualifiedName.split('.').pop() ?? '').toLowerCase());
    }
    if (filePath !== undefined && n.file === filePath) scopeMembers.push(n.id);
    else if (clusterId !== undefined && n.clusterId === clusterId) scopeMembers.push(n.id);
  }

  const symbolIds =
    scope === 'package'
      ? packageMembers(soul, scopeNode, incoming)
      : scopeMembers.sort(byNodeLine(soul));
  const symbolCount = symbolIds.length;
  const maxSymbols = opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const offset = Math.max(0, opts.offset ?? 0);
  const capped = symbolIds.slice(offset, offset + maxSymbols);
  // truncated when symbols remain beyond this page (past the cap OR past a non-zero offset).
  const truncated = offset + capped.length < symbolCount;

  const buildOpts: DossierOpts = {
    ...(opts.extractedOnly ? { extractedOnly: true } : {}),
    ...(opts.includeTables ? { includeTables: true } : {}),
    ...(opts.sourceMaxChars !== undefined ? { sourceMaxChars: opts.sourceMaxChars } : {}),
    ...(opts.sourceMaxLines !== undefined ? { sourceMaxLines: opts.sourceMaxLines } : {}),
    outgoing,
    incoming,
    producerOf,
    nameIndex,
  };

  const symbols: Dossier[] = [];
  const skipped: string[] = [];
  for (const sid of capped) {
    const d = buildDossier(soul, repoRoot, sid, now, buildOpts);
    if (d) symbols.push(d);
    else skipped.push(sid);
  }

  return {
    scope,
    id: scopeNode.id,
    label: scopeLabel(scopeNode),
    schemaVersion: soul.getManifest().schemaVersion,
    builtAt: now,
    symbols,
    symbolCount,
    truncated,
    skipped,
  };
}

/** Resolve the scope node for a given scope + id (exact id, then qname/name/path/slug). */
function resolveScopeNode(soul: SoulStore, scope: DossierScope, id: string): Node | undefined {
  if (scope === 'package') {
    const byId = soul.getNode(id);
    if (byId?.type === 'package') return byId;
    const needle = id.toLowerCase();
    for (const n of soul.iterate('symbol')) {
      if (n.type !== 'package') continue;
      if (n.qualifiedName?.toLowerCase() === needle) return n;
    }
    for (const n of soul.iterate('symbol')) {
      if (n.type !== 'package') continue;
      if (n.name?.toLowerCase() === needle) return n;
    }
    return undefined;
  }
  if (scope === 'file') {
    const byId = soul.getNode(id);
    if (byId?.kind === 'file') return byId;
    const fileNodeId = id.startsWith('file:') ? id : `file:${id}`;
    const byConstructed = soul.getNode(fileNodeId);
    if (byConstructed?.kind === 'file') return byConstructed;
    return undefined;
  }
  // cluster
  const byId = soul.getNode(id);
  if (byId?.kind === 'cluster') return byId;
  const clusterNodeId = id.startsWith('c:') ? id : `c:${id}`;
  const byConstructed = soul.getNode(clusterNodeId);
  if (byConstructed?.kind === 'cluster') return byConstructed;
  return undefined;
}

/**
 * Package members from the prebuilt `incoming` adjacency (incoming `member-of` edges point
 * child→parent; members are the sources), so the package path does NOT re-scan `iterateEdges()` NOR
 * `iterate('symbol')`. File + cluster member ids are collected during the caller's single symbol
 * pass (see {@link buildDossiersByScope}). Include ALL symbol members (callables + types).
 */
function packageMembers(soul: SoulStore, scopeNode: Node, incoming: Map<string, Edge[]>): string[] {
  const out: string[] = [];
  for (const e of incoming.get(scopeNode.id) ?? []) {
    if (e.rel !== 'member-of') continue;
    const m = soul.getNode(e.src);
    if (m && m.kind === 'symbol') out.push(m.id);
  }
  return out.sort(byNodeLine(soul));
}

/** A sort comparator factory keyed by source line (stable, top-to-bottom). */
function byNodeLine(soul: SoulStore): (a: string, b: string) => number {
  return (a, b): number => {
    const na = soul.getNode(a);
    const nb = soul.getNode(b);
    const la = na?.span?.start ?? Number.POSITIVE_INFINITY;
    const lb = nb?.span?.start ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return (na?.qualifiedName ?? na?.name ?? a) < (nb?.qualifiedName ?? nb?.name ?? b) ? -1 : 1;
  };
}

/** Human label for a scope node (package qualifiedName / file path / cluster slug). */
function scopeLabel(n: Node): string {
  if (n.kind === 'file') return n.file ?? n.id;
  if (n.kind === 'cluster') return n.label ?? n.id;
  return n.qualifiedName ?? n.name ?? n.id;
}
