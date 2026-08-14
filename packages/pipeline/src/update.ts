/**
 * Incremental update (M6) — a git-anchored scoped re-extract of the changed files PLUS their
 * reverse-dependency closure, producing an `IndexDelta` the caller applies to the derived index.
 *
 * Why the reverse-dependency closure (the P0-1 fix): `SoulStore.removeByFile(A)` drops edges whose
 * `dst` resolves into A, i.e. incoming `B→A` from unchanged files that import/call/describe A. A resolve
 * over ONLY A would never re-emit `B→A` (the resolver emits edges whose `src` lives in the passed files),
 * so the edge would be silently lost and pushed to the index `removed[]`. Instead we re-resolve the union
 * of changed files and every file whose references reach into them: B is re-resolved too, `B→A` is
 * re-emitted, and — because B's source is unchanged — its shard chunk rewrites with byte-identical
 * content (no git diff). The honest gate is "only the edited file's shard chunks differ" for a body-only
 * edit; an API change legitimately alters reverse-deps' edge shards, which is correct, not a violation.
 *
 * Returns `null` when there is no anchor (fresh soul) or the repo isn't git — the caller degrades to a
 * full `indexRepo`. Does NOT touch the index; the caller applies `delta` via `index.applyDelta`.
 */
import {
  buildDelta,
  fileScopedIds,
  pathFromId,
  pruneSemanticArtifacts,
} from '@knowledge-crib/core';
import type { IndexDelta, SoulStore } from '@knowledge-crib/core';
import { ExtractorRegistry } from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';
import { runArtifactGraph } from './artifacts.js';
import type { ArtifactStats } from './artifacts.js';
import { runCluster } from './cluster/index.js';
import type { ClusterStats } from './cluster/index.js';
import { runDossiers } from './dossiers.js';
import type { DossierStats } from './dossiers.js';
import { runLink } from './linker/index.js';
import type { LinkStats } from './linker/index.js';
import type { SemanticStats } from './linker/index.js';
import { runSemanticLink } from './linker/index.js';
import { runOwnership } from './ownership.js';
import type { OwnershipStats } from './ownership.js';
import { runParse } from './parse.js';
import type { ParseStats } from './parse.js';
import { defaultExtractors } from './pipeline.js';
import { runResolve } from './resolve/index.js';
import type { ResolveStats } from './resolve/index.js';
import { metaForPaths, runStructure } from './structure.js';
import { classifyMuleDiscovery } from './mule/discover.js';
import { changedFilesSince, currentHead, uncommittedChanges } from './vcs.js';

export interface UpdateOpts {
  /** commit timestamp (deterministic tests). */
  now?: string;
  /** link persist threshold. */
  linkThreshold?: number;
  /** override the incremental anchor sha (else manifest.incrementalSince ?? repo.vcsHead). */
  since?: string;
  /** extractors to register; defaults to the full shipped fleet (Markdown + TypeScript + PL/SQL +
   *  + Python + Java + C# + Go + Rust) — shared with `indexRepo` so an incremental update re-extracts
   *  the changed file's language, never silently dropping Java/C#/Go/Rust/Python/SQL symbols. */
  extractors?: Extractor[];
  /** re-run structural clustering after re-extraction; default true (M7). Clustering is a global,
   *  deterministic, idempotent phase — re-running it keeps cluster nodes + member-of edges consistent
   *  with the re-extracted symbols so a body-only edit produces no spurious cluster-edge delta. */
  cluster?: boolean;
  /** run the INFERRED TF-IDF semantic linker pass over scoped docs; default false (M7). */
  semantic?: boolean;
  /** run the M3.1 ownership phase over changed files: re-blame + re-attribute `owned-by` EXTRACTED edges
   *  for symbols in changed files (their old owned-by edges were dropped by `removeByFile`). Default ON
   *  inside a git work tree (clean no-op otherwise); false skips blame (benches / reproducibility). */
  ownership?: boolean;
  /** Include staged and unstaged working-tree changes in the delta without advancing `repo.vcsHead`.
   * The derived index/soul is refreshed, `stats.incrementalSince` is set to current HEAD so subsequent
   * normal updates see no committed diff, but `repo.vcsHead` stays pinned to the last real commit so
   * `crib status` can still report the dirty delta. */
  dirty?: boolean;
  /** Restrict this update to files under any of these repo-relative package roots (multi-package
   *  federation: independently re-sync one package's slice of a shared, already-indexed monorepo
   *  soul without touching the rest). Changed files OUTSIDE every root are left untouched AND —
   *  critically — the incremental anchor (`vcsHead`/`incrementalSince`) is only advanced if there
   *  were none, so a later scoped-or-unscoped update still sees the full diff for whatever this run
   *  skipped. Undefined ⇒ unscoped, the existing whole-repo behavior. */
  packageRoots?: string[];
}

export interface UpdateReport {
  delta: IndexDelta;
  changedPaths: string[];
  /** changed files outside every `packageRoots` prefix, left unprocessed this run (empty when
   *  unscoped, or when every changed file happened to fall inside the requested package(s)). */
  excludedPaths: string[];
  scopeFiles: string[];
  head: string;
  parse: ParseStats;
  resolve: ResolveStats;
  link: LinkStats;
  cluster: ClusterStats;
  semantic: SemanticStats;
  dossiers: DossierStats;
  ownership: OwnershipStats;
  artifacts: ArtifactStats;
  /** count of persisted LLM semantic artifacts whose target node no longer exists, deleted by this
   *  update's orphan-prune (the semantic-layer analogue of `dossiers.pruned`). Zero when nothing was
   *  orphaned; bumped `manifest.generation.semantic` only when > 0. */
  semanticPruned: number;
}

export interface UpdateNoopReport {
  changedPaths: string[];
  excludedPaths: string[];
  scopeFiles: [];
  head: string;
  noop: true;
}

export type UpdateResult = UpdateReport | UpdateNoopReport | null;

const EMPTY_PARSE: ParseStats = { filesParsed: 0, nodes: 0, edges: 0 };
const EMPTY_RESOLVE: ResolveStats = {
  imports: 0,
  calls: 0,
  inherits: 0,
  implements: 0,
  dropped: 0,
};
const EMPTY_LINK: LinkStats = { describes: 0, references: 0, diagnostics: [] };
const EMPTY_ARTIFACTS: ArtifactStats = {
  artifacts: 0,
  governs: 0,
  requires: 0,
  invokes: 0,
  mcpServers: 0,
  localOverlay: 0,
  diagnostics: [],
};

/** Scoped re-extract since the manifest's VCS anchor. `null` ⇒ caller does a full `indexRepo`. */
export async function updateRepo(
  soul: SoulStore,
  root: string,
  opts: UpdateOpts = {},
): Promise<UpdateResult> {
  let head: string;
  try {
    head = currentHead(root);
  } catch {
    return null; // non-git → degrade to full index
  }

  const manifest = soul.getManifest();
  const since = opts.since ?? manifest.stats.incrementalSince ?? manifest.repo.vcsHead;
  if (!since) return null; // no anchor yet → full index

  const allChangedPaths = changedFilesSince(root, since);

  if (opts.dirty) {
    for (const p of uncommittedChanges(root)) {
      if (!allChangedPaths.includes(p)) allChangedPaths.push(p);
    }
  }

  // Package-scoped update: only re-sync files under one of the given roots. `excludedPaths` is what
  // this run intentionally leaves pending — the anchor-advance guard below uses it to decide whether
  // it's safe to move `vcsHead`/`incrementalSince` forward (only when nothing was skipped).
  const inRoot = (p: string, r: string): boolean => p === r || p.startsWith(`${r}/`);
  const packageRoots = opts.packageRoots;
  const changedPaths = packageRoots
    ? allChangedPaths.filter((p) => packageRoots.some((r) => inRoot(p, r)))
    : allChangedPaths;
  const excludedPaths = packageRoots
    ? allChangedPaths.filter((p) => !packageRoots.some((r) => inRoot(p, r)))
    : [];

  // No in-scope file changes: advance the anchor ONLY if nothing was excluded — a scoped run that
  // skipped out-of-scope changes must NOT advance the shared anchor, or a later update (for another
  // package, or unscoped) would wrongly believe those skipped changes were already accounted for.
  if (changedPaths.length === 0) {
    if (excludedPaths.length === 0) {
      if (opts.dirty) {
        // Dirty no-op: keep the committed vcsHead pinned, but record that the soul is now current with HEAD.
        soul.setIncrementalSince(head);
      } else {
        soul.setVcsHead(head);
      }
      // No content changed — only the vcsHead anchor advances. Preserve the existing lastUpdated so
      // crib.json stays byte-identical apart from the anchor field (idempotent re-runs don't churn
      // the timestamp, and the M4.3 soul-refresh action's empty-diff check works on a no-op merge).
      soul.commit(opts.now, true);
    }
    return { changedPaths, excludedPaths, scopeFiles: [], head, noop: true };
  }

  // Reverse-dependency closure: every file whose references reach into a changed file. Captured BEFORE
  // removal (single pass over edges; covers imports/calls/inherits/describes/references — any edge whose
  // dst resolves into a changed path).
  const changed = new Set(changedPaths);
  const scope = new Set(changedPaths);
  for (const edge of soul.iterateEdges()) {
    const d = pathFromId(edge.dst);
    if (d !== undefined && changed.has(d)) {
      const s = pathFromId(edge.src);
      if (s !== undefined) scope.add(s);
    }
  }

  const before = fileScopedIds(soul, scope);

  // Drop only the CHANGED files' records (reverse-dep nodes persist — their source is unchanged).
  for (const p of changedPaths) soul.removeByFile(p);

  // Re-extract changed files: structure (file nodes) + parse (symbols + intra-file edges). The
  // default fleet is the SAME set `indexRepo` ships (via `defaultExtractors`) so a body-only edit to a
  // `.java` controller re-emits its Spring routes/exposes/DI rather than vanishing from the graph.
  const registry = new ExtractorRegistry();
  for (const e of opts.extractors ?? defaultExtractors()) {
    registry.register(e);
  }
  const changedMetas = metaForPaths(root, changedPaths);
  // Mule pre-pass: stamp classification on changed Mule files so fileNode hashes sensitive config by
  // keys only and the Mule extractor (Task 13) dispatches. Full-index path (pipeline.ts) does the same.
  classifyMuleDiscovery(root, changedMetas);
  runStructure(soul, root, changedMetas);
  // Incremental: the changed set is small (often 1-3 files). Worker-boot cost would dominate, and
  // the pool is torn down per call, so force the serial path here — parallel is for full-index only.
  const parse = await runParse(soul, registry, root, changedMetas, { parallel: false });

  // Re-resolve the whole closure (changed + reverse deps): re-emits incoming B→A edges. The resolver
  // only processes files in the passed set; the SymbolTable spans the whole soul (B's symbols remain).
  const scopeMetas = metaForPaths(root, [...scope]);
  const resolve = runResolve(soul, root, scopeMetas);

  // Re-link only the docs in scope (InvertedIndex still spans the whole soul).
  const scopeDocFiles = scopeMetas.filter((m) => m.lang === 'markdown').map((m) => m.path);
  const link = runLink(soul, root, opts.linkThreshold, scopeDocFiles);

  // Re-cluster (M7): clustering is global + idempotent, so re-running it re-emits the member-of edges
  // for symbols in the changed files — preventing a body-only edit from silently dropping a cluster
  // edge into `delta.removed`. `before` captured these ids pre-removal; re-emission makes after==before.
  const cluster = opts.cluster === false ? { communities: 0, members: 0 } : runCluster(soul);

  // Semantic pass (M7, INFERRED): scoped to the docs in scope, like the deterministic re-link.
  const semantic = opts.semantic ? runSemanticLink(soul, root, scopeDocFiles) : { added: 0 };

  // W1 artifact graph: a changed artifact file (a tracked skill under .claude/ — gitignored, so not
  // in `changedMetas`/`scopeMetas`) had its node + incoming edges dropped by `removeByFile`. A changed
  // SYMBOL may also be the target of a `governs`/`requires`/`invokes` edge from an unchanged artifact
  // (captured in the reverse-dep closure, but the artifact file itself isn't re-extracted by runParse
  // — it isn't in the registry). A full re-scan is idempotent + cheap (artifacts are few) and re-emits
  // every artifact node + edge, so a body-only symbol edit produces no spurious artifact-edge delta
  // (unchanged artifacts rewrite byte-identical shards) while a changed/added/deleted artifact is
  // correctly re-emitted or dropped. Local overlay is OFF here — incremental updates refresh the
  // committed soul only; the working overlay (W7) re-applies on read.
  const artifacts = runArtifactGraph(soul, root);

  // Ownership (M3.1): re-blame only the CHANGED files — their old `owned-by` edges were dropped by
  // `removeByFile`, so a body edit re-attributes ownership instead of leaving symbols ownerless. The
  // full-index path (`indexRepo`) blames every file; this is the scoped mirror.
  const ownership =
    opts.ownership === false
      ? { files: 0, symbols: 0, owners: 0, edges: 0, skipped: 0 }
      : runOwnership(soul, root, new Set(changedPaths));

  // Advance the shared incremental anchor only if this run left nothing pending — a package-scoped
  // update that excluded other packages' changes must NOT advance it (see UpdateOpts.packageRoots).
  if (excludedPaths.length === 0) {
    if (opts.dirty) {
      // Dirty update: refresh the soul to match HEAD + working tree, but keep vcsHead on the last real
      // commit so `crib status` can still detect/report the uncommitted delta.
      soul.setIncrementalSince(head);
    } else {
      soul.setVcsHead(head);
    }
  }
  soul.commit(opts.now);

  const committedAt = opts.now ?? soul.getManifest().stats.lastUpdated;
  const dossiers = runDossiers(soul, root, committedAt);

  // Semantic orphan-prune (the missing delta path): `soul.commit()` above has already written the
  // refreshed soul, so symbols removed by `removeByFile` are gone from the graph but their persisted
  // LLM artifacts linger under .crib/graph/semantic/artifacts (the enrich queue only re-offers STALE
  // artifacts — a target node that simply vanished is never re-offered, and query/context still serve
  // its stale analysis as if the code existed). Pruning orphans here — using the post-commit live node
  // set — keeps the semantic cache consistent with the soul exactly once per update, mirroring what
  // `runDossiers` already does for dossiers. Bumping `generation.semantic` only when something was
  // pruned invalidates `graphFingerprint`'s semanticHash-derived half so semantic readers don't serve
  // a stale composite cache; a zero-prune update (no symbols deleted) leaves the counter untouched so
  // pure-additive edits don't needlessly invalidate the semantic cache.
  const liveNodeIds = new Set<string>();
  for (const node of soul.iterate()) liveNodeIds.add(node.id);
  const semanticPruned = pruneSemanticArtifacts(soul.cribDir, liveNodeIds);
  if (semanticPruned > 0) soul.bumpSemanticGeneration();

  const delta = buildDelta(soul, before, scope);
  return {
    delta,
    changedPaths,
    excludedPaths,
    scopeFiles: [...scope].sort(),
    head,
    parse,
    resolve,
    link,
    cluster,
    semantic,
    dossiers,
    ownership,
    artifacts,
    semanticPruned,
  };
}
