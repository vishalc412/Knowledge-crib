/**
 * W6 — working-overlay refresh (PRD line 365).
 *
 * Re-extracts the overlay's dirty files PLUS their reverse-dependency closure into the overlay store,
 * mirroring `updateRepo`'s extracted phases (structure → parse → resolve → cluster) but writing into
 * the EPHEMERAL overlay store instead of the committed soul, and never committing. The committed
 * `.crib/graph` is untouched; the overlay becomes the live extracted graph for the composite read
 * model (see `GraphStore.setWorkingOverlay`).
 *
 * Closure ordering — the P0-1 fix from `updateRepo`: the reverse-dependency closure (every file whose
 * references reach into a dirty file) is computed from the CANONICAL soul BEFORE `removeByFile` drops
 * the dirty files' overlay records. A resolve over ONLY the dirty files would never re-emit the
 * incoming `B→A` edge from an unchanged B that calls a dirty A, so the edge would be silently lost.
 * Re-resolving the closure (B included) re-emits `B→A`; B's source is unchanged so its shard-equivalent
 * overlay records rewrite byte-identically. The closure is read from canonical (intact) because the
 * overlay's dirty-file edges are dropped during refresh.
 *
 * What is NOT re-run here (by design — the overlay is an extracted-graph working view):
 *   - linker / semantic link (docs→symbols): a doc re-link needs the full InvertedIndex; scoped to the
 *     overlay's docs it would diverge from canonical. Docs layer stays canonical; it refreshes on
 *     `crib update`.
 *   - ownership (blame): uncommitted edits have no blame yet; dirty symbols are ownerless in the
 *     overlay and re-attributed on `crib update`.
 *   - artifact graph / dossiers: committed-soul concerns; refresh on `crib update`.
 */
import { pathFromId } from '@knowledge-crib/core';
import type { WorkingOverlay } from '@knowledge-crib/core';
import type { SoulStore } from '@knowledge-crib/core';
import { ExtractorRegistry } from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';
import { runCluster } from './cluster/index.js';
import type { ClusterStats } from './cluster/index.js';
import { runParse } from './parse.js';
import type { ParseStats } from './parse.js';
import { defaultExtractors } from './pipeline.js';
import { runResolve } from './resolve/index.js';
import type { ResolveStats } from './resolve/index.js';
import { metaForPaths, runStructure } from './structure.js';

export interface OverlayRefreshResult {
  /** Dirty files actually re-parsed (deleted files drop out — no meta on disk). */
  dirty: string[];
  /** dirty ∪ reverse-dependency closure (the re-resolve scope). */
  scope: string[];
  parse: ParseStats;
  resolve: ResolveStats;
  cluster: ClusterStats;
}

const EMPTY_RESOLVE: ResolveStats = {
  imports: 0,
  calls: 0,
  inherits: 0,
  implements: 0,
  dropped: 0,
};
const EMPTY_CLUSTER: ClusterStats = { communities: 0, members: 0 };

/**
 * Re-extract the overlay's dirty files + closure into the overlay store. The overlay's `dirty` set is
 * the source of truth for what to re-parse; canonical supplies the closure edges (intact). After a
 * successful refresh the dirty set is NOT cleared — files remain "logically touched" until an external
 * `crib update` triggers a {@link WorkingOverlay.resync}. A reverted-to-canonical file re-parses to
 * canonical-identical records, so the overlay converges without a per-file restore.
 */
export async function refreshWorkingOverlay(
  overlay: WorkingOverlay,
  canonical: SoulStore,
  root: string,
  opts: { extractors?: Extractor[]; cluster?: boolean } = {},
): Promise<OverlayRefreshResult> {
  const dirty = [...overlay.dirty].sort();
  if (dirty.length === 0) {
    return {
      dirty,
      scope: [],
      parse: { filesParsed: 0, nodes: 0, edges: 0 },
      resolve: EMPTY_RESOLVE,
      cluster: EMPTY_CLUSTER,
    };
  }

  // Reverse-dependency closure from the CANONICAL soul (edges intact): every file whose references
  // reach into a dirty file. Computed BEFORE removeByFile so incoming B→dirty edges are captured.
  const dirtySet = new Set(dirty);
  const scope = new Set(dirty);
  for (const edge of canonical.iterateEdges()) {
    const dPath = pathFromId(edge.dst);
    if (dPath !== undefined && dirtySet.has(dPath)) {
      const sPath = pathFromId(edge.src);
      if (sPath !== undefined) scope.add(sPath);
    }
  }

  // Drop the dirty files' overlay records NOW (closure already captured from canonical). Deleted files
  // have no meta and stay dropped — the overlay correctly shows them gone.
  for (const p of dirty) overlay.store.removeByFile(p);

  // Re-extract dirty files: structure (file nodes) + parse (symbols + intra-file edges). The default
  // fleet is the SAME set `indexRepo`/`updateRepo` ship so a dirty `.java`/`.cs`/etc. re-emits its
  // framework semantics rather than vanishing. Serial — the dirty set is small (often 1-3 files).
  const registry = new ExtractorRegistry();
  for (const e of opts.extractors ?? defaultExtractors()) registry.register(e);
  const dirtyMetas = metaForPaths(root, dirty);
  runStructure(overlay.store, root, dirtyMetas);
  const parse = await runParse(overlay.store, registry, root, dirtyMetas, { parallel: false });

  // Re-resolve the whole closure (dirty + reverse deps) against the overlay store: re-emits incoming
  // B→dirty edges. The SymbolTable spans the whole overlay (B's symbols remain); only files in `scope`
  // are processed by the resolvers.
  const scopeMetas = metaForPaths(root, [...scope]);
  const resolve = runResolve(overlay.store, root, scopeMetas);

  // Re-cluster (global + idempotent): re-emits member-of edges for the re-extracted symbols so a
  // body-only edit doesn't leave a stale cluster edge in the overlay. O(all symbols) but the overlay
  // is in-memory and this matches `updateRepo`'s incremental cost.
  const cluster = opts.cluster === false ? EMPTY_CLUSTER : runCluster(overlay.store);

  return { dirty, scope: [...scope].sort(), parse, resolve, cluster };
}
