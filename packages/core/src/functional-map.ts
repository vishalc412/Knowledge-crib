import type { Node } from '@knowledge-crib/soul-schema';
import { clusterMembers } from './cluster-hash.js';
import {
  type ImportanceEntry,
  computeImportance,
  deriveNodeKind,
  isTestPath,
} from './importance.js';
import { type LlmOverlay, type LlmOverlayEntry, readLlmOverlay } from './llm-overlay.js';
/**
 * Functional map — outcome A of the overview/functional-segregation fix. Segments the soul into
 * architecturally meaningful modules (workspace packages when the indexer stamped them, else
 * directory prefixes with the same >80% descent rule the enrich scope picker uses) and attaches
 * per-module counts, stereotypes, cluster membership, top symbols (importance-ranked, tests
 * deprioritized), and a `purpose` resolved bottom-up from the LLM layer when present.
 *
 * Computed on demand from the soul — no `module` NodeKind, no schema bump (NodeKind is a closed
 * enum, invariant #4). `core`-resident so both `ui` and `mcp` can consume it without crossing the
 * dependency graph. Deterministic: every iteration is id-sorted, so two runs over the same soul
 * produce byte-identical output.
 */
import type { SoulStore } from './soul-store.js';

export interface FunctionalTopSymbol {
  id: string;
  name?: string;
  qualifiedName?: string;
  file?: string;
  importance: number;
  stereotype?: string;
}

export interface FunctionalPurpose {
  text: string;
  source: 'llm-cluster' | 'llm-file' | 'doc' | 'heuristic';
  stale?: boolean;
}

export interface FunctionalModule {
  id: string; // `module:${pathPrefix}`, 'module:(root)' for root files
  name: string;
  pathPrefix: string;
  source: 'workspace' | 'directory';
  counts: { files: number; symbols: number; clusters: number; routes: number; docSections: number };
  stereotypes: Record<string, number>;
  clusterIds: string[];
  topSymbols: FunctionalTopSymbol[];
  readme?: { sectionId: string; heading?: string; file: string };
  purpose?: FunctionalPurpose;
  /** LLM enrichment coverage over the module's symbols+files+clusters. Present when an overlay was
   *  available (always, internally) — the overview surfaces it; callers may ignore. */
  coverage?: { fresh: number; pending: number; pct: number };
}

export interface FunctionalMap {
  modules: FunctionalModule[];
  source: 'workspace' | 'directory';
}

export interface BuildFunctionalMapOpts {
  topSymbolsPerModule?: number;
  importance?: Map<string, ImportanceEntry>;
  overlay?: LlmOverlay;
}

const TOP_SYMBOLS_DEFAULT = 8;
const DESCENT_RATIO = 0.8;

interface WorkspacePackage {
  name: string;
  rel: string;
}

export function buildFunctionalMap(
  soul: SoulStore,
  opts: BuildFunctionalMapOpts = {},
): FunctionalMap {
  const topN = opts.topSymbolsPerModule ?? TOP_SYMBOLS_DEFAULT;
  const importance = opts.importance ?? computeImportance(soul);
  const overlay = opts.overlay ?? readLlmOverlay(soul);

  const packages = readWorkspacePackages(soul);
  const source: 'workspace' | 'directory' = packages.length > 0 ? 'workspace' : 'directory';

  const symbols = [...soul.iterate('symbol')].sort(byId);
  const files = [...soul.iterate('file')].sort(byId);
  const clusters = [...soul.iterate('cluster')].sort(byId);
  const routes = [...soul.iterate('route')].sort(byId);
  const docSections = [...soul.iterate('doc-section')].sort(byId);

  // Segment every node with a `file` into exactly one module path prefix.
  const prefixes =
    source === 'workspace' ? workspacePrefixes(packages) : directoryPrefixes(symbols);

  // Bucket symbols by their own `file` field (a soul may have symbols without explicit `file`
  // nodes; bucketing must not depend on file nodes existing). Root catch-all = ''.
  const symbolToPrefix = new Map<string, string>();
  for (const s of symbols) {
    symbolToPrefix.set(s.id, s.file ? prefixForFile(s.file, prefixes) : '');
  }
  const prefixSet = new Set<string>(prefixes.map((p) => p.pathPrefix));
  prefixSet.add(''); // root module always exists as the catch-all

  // Give every cluster exactly one discoverable module owner. The old `>50%` rule dropped evenly
  // split and broadly cross-module clusters from every module. Highest local member count wins;
  // path-prefix tie-break keeps ownership deterministic.
  const clusterOwner = new Map<string, string>();
  const clusterCountsByPrefix = new Map<string, Map<string, number>>();
  const clusterTotals = new Map<string, number>();
  for (const cluster of clusters) {
    const counts = new Map<string, number>();
    const members = clusterMembers(soul, cluster);
    for (const member of members) {
      const prefix = symbolToPrefix.get(member.id) ?? '';
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    clusterCountsByPrefix.set(cluster.id, counts);
    clusterTotals.set(cluster.id, members.length);
    const owner = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    if (owner !== undefined) clusterOwner.set(cluster.id, owner);
  }

  const modules: Array<FunctionalModule & { _summedImportance: number }> = [];
  for (const pathPrefix of [...prefixSet].sort()) {
    const inModule = (p?: string): boolean =>
      !!p &&
      (pathPrefix === ''
        ? !inAnyPrefix(p, prefixes)
        : p === pathPrefix || p.startsWith(`${pathPrefix}/`));

    const moduleSymbols = symbols.filter((s) => symbolToPrefix.get(s.id) === pathPrefix);
    const moduleFiles = files.filter((f) => f.file && inModule(f.file));
    const moduleRoutes = routes.filter((r) => r.file && inModule(r.file));
    const moduleDocs = docSections.filter((d) => d.file && inModule(d.file));

    // Cluster ownership is precomputed globally above so ties cannot make a cluster disappear.
    const clusterIds = clusters
      .filter((cluster) => clusterOwner.get(cluster.id) === pathPrefix)
      .map((cluster) => cluster.id)
      .sort(byIdString);
    const clusterMemberCounts = new Map<string, { here: number; total: number }>();
    for (const clusterId of clusterIds) {
      clusterMemberCounts.set(clusterId, {
        here: clusterCountsByPrefix.get(clusterId)?.get(pathPrefix) ?? 0,
        total: clusterTotals.get(clusterId) ?? 0,
      });
    }

    // Stereotype tally + dominant stereotype/kind for the heuristic purpose.
    const stereotypes: Record<string, number> = {};
    const kindTally: Record<string, number> = {};
    for (const s of moduleSymbols) {
      if (s.stereotype) stereotypes[s.stereotype] = (stereotypes[s.stereotype] ?? 0) + 1;
      const k = deriveNodeKind(s);
      kindTally[k] = (kindTally[k] ?? 0) + 1;
    }

    // Top symbols: importance desc, tests last, id tie-break.
    const topSymbols = moduleSymbols
      .map((s) => ({
        id: s.id,
        ...(s.name ? { name: s.name } : {}),
        ...(s.qualifiedName ? { qualifiedName: s.qualifiedName } : {}),
        ...(s.file ? { file: s.file } : {}),
        importance: importance.get(s.id)?.importance ?? 0,
        ...(s.stereotype ? { stereotype: s.stereotype } : {}),
        test: isTestPath(s.file),
      }))
      .sort((a, b) => {
        if (a.test !== b.test) return a.test ? 1 : -1;
        if (b.importance !== a.importance) return b.importance - a.importance;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, topN)
      .map(({ test: _test, ...rest }) => rest);

    const name = moduleName(pathPrefix, packages, source);
    const readme = findReadme(moduleDocs);

    const summedImportance = moduleSymbols.reduce(
      (n, s) => n + (importance.get(s.id)?.importance ?? 0),
      0,
    );

    const purpose = resolvePurpose(
      clusterIds,
      clusterMemberCounts,
      moduleFiles,
      moduleSymbols,
      overlay.entries,
      importance,
      stereotypes,
      kindTally,
      name,
    );

    // LLM coverage over the module's enrichable targets (symbols + files + clusters).
    const totalTargets = moduleSymbols.length + moduleFiles.length + clusterIds.length;
    let fresh = 0;
    for (const s of moduleSymbols) {
      const e = overlay.entries.get(s.id);
      if (e && !e.stale) fresh++;
    }
    for (const f of moduleFiles) {
      const e = overlay.entries.get(f.id);
      if (e && !e.stale) fresh++;
    }
    for (const cid of clusterIds) {
      const e = overlay.entries.get(cid);
      if (e && !e.stale) fresh++;
    }
    const coverage = {
      fresh,
      pending: Math.max(0, totalTargets - fresh),
      pct: totalTargets > 0 ? Math.round((fresh / totalTargets) * 100) : 0,
    };

    modules.push({
      id: `module:${pathPrefix || '(root)'}`,
      name,
      pathPrefix,
      source,
      counts: {
        files: moduleFiles.length,
        symbols: moduleSymbols.length,
        clusters: clusterIds.length,
        routes: moduleRoutes.length,
        docSections: moduleDocs.length,
      },
      stereotypes,
      clusterIds,
      topSymbols,
      ...(readme ? { readme } : {}),
      ...(purpose ? { purpose } : {}),
      coverage,
      _summedImportance: summedImportance,
    });
  }

  modules.sort((a, b) => b._summedImportance - a._summedImportance || a.id.localeCompare(b.id));
  const stripped: FunctionalModule[] = modules.map(
    ({ _summedImportance: _unused, ...rest }) => rest,
  );

  return { modules: stripped, source };
}

/** Workspace packages stamped by `crib index` (manifest.meta.workspace.packages). */
function readWorkspacePackages(soul: SoulStore): WorkspacePackage[] {
  const meta = soul.getManifest().meta ?? {};
  const ws = meta.workspace as { packages?: Array<{ name?: string; rel?: string }> } | undefined;
  if (!ws?.packages) return [];
  const out: WorkspacePackage[] = [];
  for (const p of ws.packages) {
    if (p && typeof p.rel === 'string' && typeof p.name === 'string') {
      out.push({ name: p.name, rel: p.rel });
    }
  }
  return out;
}

function workspacePrefixes(
  packages: WorkspacePackage[],
): Array<{ pathPrefix: string; name: string }> {
  return packages.map((p) => ({ pathPrefix: p.rel, name: p.name }));
}

/** Directory fallback: first path component, descending one level when the largest bucket holds
 *  >80% of symbols (same rule as `EnrichmentStore.scopes`). */
function directoryPrefixes(symbols: Node[]): Array<{ pathPrefix: string; name: string }> {
  const withFile = symbols.filter((s) => s.file);
  if (withFile.length === 0) return [];
  const depth1 = groupByDepth(withFile, 1);
  const largest = [...depth1].sort((a, b) => b.symbols.length - a.symbols.length)[0];
  const useDepth2 = largest && largest.symbols.length > withFile.length * DESCENT_RATIO;
  const buckets = useDepth2 ? groupByDepth(withFile, 2) : depth1;
  return buckets.map((b) => ({
    pathPrefix: b.prefix,
    name: b.prefix.split('/').pop() || b.prefix,
  }));
}

function groupByDepth(symbols: Node[], depth: number): Array<{ prefix: string; symbols: Node[] }> {
  const map = new Map<string, Node[]>();
  for (const n of symbols) {
    const p = n.file;
    if (!p) continue;
    const parts = p.split('/');
    if (parts.length < depth) continue; // root-level file → root module, not a bucket
    const prefix = parts.slice(0, depth).join('/');
    if (!map.has(prefix)) map.set(prefix, []);
    map.get(prefix)!.push(n);
  }
  return [...map.entries()].map(([prefix, syms]) => ({ prefix, symbols: syms }));
}

/** The module prefix a single file belongs to, or '' for the root catch-all. */
function prefixForFile(file: string, prefixes: Array<{ pathPrefix: string }>): string {
  // Longest-prefix match so `packages/core/src` correctly lands in `packages/core`, not `packages`.
  let best: string | undefined;
  for (const p of prefixes) {
    if (file === p.pathPrefix || file.startsWith(`${p.pathPrefix}/`)) {
      if (best === undefined || p.pathPrefix.length > best.length) best = p.pathPrefix;
    }
  }
  return best ?? '';
}

function inAnyPrefix(file: string, prefixes: Array<{ pathPrefix: string }>): boolean {
  return prefixes.some((p) => file === p.pathPrefix || file.startsWith(`${p.pathPrefix}/`));
}

function moduleName(
  pathPrefix: string,
  packages: WorkspacePackage[],
  source: 'workspace' | 'directory',
): string {
  if (pathPrefix === '') return '(root)';
  if (source === 'workspace') {
    const pkg = packages.find((p) => p.rel === pathPrefix);
    if (pkg) return pkg.name;
  }
  return pathPrefix.split('/').pop() || pathPrefix;
}

/** First README doc-section in the module (id-sorted). Core stays fs-pure — only the pointer. */
function findReadme(
  docs: Node[],
): { sectionId: string; heading?: string; file: string } | undefined {
  const readme = docs.filter((d) => d.file && /readme(\.|$)/i.test(d.file)).sort(byId)[0];
  if (!readme || !readme.file) return undefined;
  return {
    sectionId: readme.id,
    ...(readme.heading ? { heading: readme.heading } : {}),
    file: readme.file,
  };
}

/** Resolve a module purpose, bottom-up: fresh dominant-cluster LLM → fresh top-file LLM → README
 *  pointer → heuristic. */
function resolvePurpose(
  clusterIds: string[],
  clusterMemberCounts: Map<string, { here: number; total: number }>,
  moduleFiles: Node[],
  moduleSymbols: Node[],
  overlay: Map<string, LlmOverlayEntry>,
  importance: Map<string, ImportanceEntry>,
  stereotypes: Record<string, number>,
  kindTally: Record<string, number>,
  name: string,
): FunctionalPurpose | undefined {
  // 1. Dominant cluster (most members in this module) with a fresh LLM purpose.
  let dominantCluster: string | undefined;
  let dominantHere = -1;
  for (const cid of clusterIds) {
    const c = clusterMemberCounts.get(cid);
    if (!c) continue;
    if (c.here > dominantHere) {
      dominantHere = c.here;
      dominantCluster = cid;
    }
  }
  if (dominantCluster) {
    const entry = overlay.get(dominantCluster);
    if (entry && entry.layer === 'cluster' && !entry.stale && entry.purpose) {
      return { text: entry.purpose, source: 'llm-cluster', stale: false };
    }
  }

  // 2. Top file (highest importance) with a fresh LLM purpose. A file is as central as its hottest
  //    symbol, so its importance is the max of its member symbols' importance.
  let topFile: Node | undefined;
  let topFileImportance = -1;
  for (const f of moduleFiles) {
    let imp = 0;
    for (const s of moduleSymbols) {
      if (s.file !== f.file) continue;
      imp = Math.max(imp, importance.get(s.id)?.importance ?? 0);
    }
    // Tie-break by file id for determinism.
    if (imp > topFileImportance || (imp === topFileImportance && topFile && f.id < topFile.id)) {
      topFileImportance = imp;
      topFile = f;
    }
  }
  if (topFile) {
    const entry = overlay.get(topFile.id);
    if (entry && entry.layer === 'file' && !entry.stale && entry.purpose) {
      return { text: entry.purpose, source: 'llm-file', stale: false };
    }
  }

  // 3. README pointer is left to the consumer (core stays fs-pure for snippets); the `readme` field
  //    on the module carries the pointer. Purpose falls through to the heuristic here.

  // 4. Heuristic: "<name> — <dominant stereotype/kind> module, N symbols".
  const dominant = dominantLabel(stereotypes, kindTally);
  return {
    text: `${name} — ${dominant} module, ${moduleSymbols.length} symbols`,
    source: 'heuristic',
  };
}

/** Pick the dominant stereotype, else the dominant derived kind, for the heuristic label. */
function dominantLabel(
  stereotypes: Record<string, number>,
  kindTally: Record<string, number>,
): string {
  let bestStereo: string | undefined;
  let bestStereoN = 0;
  for (const [k, n] of Object.entries(stereotypes)) {
    if (n > bestStereoN || (n === bestStereoN && (bestStereo === undefined || k < bestStereo))) {
      bestStereo = k;
      bestStereoN = n;
    }
  }
  if (bestStereo) return bestStereo;
  let bestKind: string | undefined;
  let bestKindN = 0;
  for (const [k, n] of Object.entries(kindTally)) {
    if (n > bestKindN || (n === bestKindN && (bestKind === undefined || k < bestKind))) {
      bestKind = k;
      bestKindN = n;
    }
  }
  return bestKind ?? 'code';
}

function byId(a: Node, b: Node): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function byIdString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
