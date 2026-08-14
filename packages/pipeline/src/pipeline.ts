/**
 * The index orchestrator — wires the deterministic phases that exist today and writes the soul,
 * then builds the derived index:
 *   Phase 1 structure → 2 parse → 3 resolve → 3b doc-extract → 4 link → commit → build index.
 * Later phases (cluster, semantic link) slot in before/after commit as they land.
 */
import type { IndexStore, SoulStore } from '@knowledge-crib/core';
import { ExtractorRegistry } from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';
import { defaultExtractors } from './extractors.js';
export { defaultExtractors } from './extractors.js';
import { runArtifactGraph } from './artifacts.js';
import type { ArtifactGraphOpts, ArtifactStats } from './artifacts.js';
import { runCluster } from './cluster/index.js';
import type { ClusterStats } from './cluster/index.js';
import { runDossiers } from './dossiers.js';
import type { DossierStats } from './dossiers.js';
import { runLink } from './linker/index.js';
import type { LinkStats } from './linker/index.js';
import type { SemanticStats } from './linker/index.js';
import { runSemanticLink } from './linker/index.js';
import { runMultimodal } from './multimodal/index.js';
import type { MultimodalPhaseOpts, MultimodalReport } from './multimodal/index.js';
import { isMediaPath } from './multimodal/ingest.js';
import { runOwnership } from './ownership.js';
import type { OwnershipStats } from './ownership.js';
import { runParse } from './parse.js';
import type { ParseStats } from './parse.js';
import { runCfg } from './resolve/index.js';
import { runResolve } from './resolve/index.js';
import type { ResolveStats } from './resolve/index.js';
import type { CfgPass, Resolver } from './resolve/index.js';
import { discoverFiles, runStructure } from './structure.js';
import { classifyMuleDiscovery } from './mule/discover.js';
import { currentHead } from './vcs.js';

export interface IndexOpts {
  /** extractors to register; defaults to Markdown + TypeScript + PL/SQL + Python + Java + C# + Go + Rust. */
  extractors?: Extractor[];
  /** cross-file resolvers to register; defaults to TypeScript + PL/SQL + Python + Java + C# + Go + Rust. */
  resolvers?: Resolver[];
  /** CFG guard-chain passes to register; defaults to PL/SQL (M11). */
  cfgPasses?: CfgPass[];
  /** commit timestamp for deterministic output. */
  now?: string;
  /** build the derived index after committing the soul. */
  index?: IndexStore;
  /** link persist threshold (default 0.4). */
  linkThreshold?: number;
  /** dirs to skip during discovery; REPLACES the default ignore set (merge with DEFAULT_IGNORES at
   *  the caller if you want to extend rather than narrow). */
  ignores?: Set<string>;
  /** Repo-relative POSIX package dirs to scope discovery to (monorepo `--package`). When non-empty,
   *  discovery only descends into these roots (+ root-level files); sibling packages are pruned.
   *  Absent/empty → full-repo walk. One soul stays unified so cross-package impact still resolves. */
  packageRoots?: string[];
  /** run structural clustering (Louvain) after the link phase; default true (M7). */
  cluster?: boolean;
  /** run the INFERRED TF-IDF semantic linker pass after the deterministic linker; default false (M7).
   *  Off → `--extracted-only` pure deterministic subset; on → adds capped `references` (INFERRED) edges
   *  for pairs the deterministic signals missed, strictly increasing recall. */
  semantic?: boolean;
  /** run the offline multimodal phase (M13): spawn `crib_worker` for media files, ingest `media-seg`
   *  nodes, link them to symbols, flip `capabilities.multimodal`. Default OFF — pure-TS safety: the
   *  default index/serve path never spawns a subprocess. Present → run with these opts. */
  multimodal?: MultimodalPhaseOpts;
  /** build + persist reusable deep dossiers for every callable symbol post-resolve (Workstream E).
   *  Default ON — the artifact the MCP `dossier` verb serves from cache; graph-divergent artifacts
   *  are refreshed while true no-ops remain byte-stable. */
  dossiers?: boolean;
  /** run the M3.1 ownership phase: `git blame` → symbol→owner `owned-by` EXTRACTED edges. Default ON
   *  inside a git work tree (a clean no-op in a non-git repo, so the deterministic path is unchanged).
   *  Set false to skip blame (benches / `--extracted-only` reproducibility checks that want no git). */
  ownership?: boolean;
  /** M3.4 parallel parse: run Phase 2 extraction across a worker-thread pool. Default ON when the
   *  built worker script is present, ≥2 files are discovered, and `KCRIB_PARALLEL != '0'`. The pool
   *  ships the DEFAULT fleet only; a non-default `extractors` opt forces the serial loop regardless.
   *  Output is byte-identical to serial (results persist in discovery order). Set false to force
   *  serial (determinism cross-check, single-file index, environments without worker_threads). */
  parallel?: boolean;
  /** W1 (AI-artifact graph): run the committed + (opt-in) local-overlay artifact scanner after the
   *  doc linker, emitting `agent-artifact` nodes (skills/agents/commands/rules/instructions/MCP
   *  servers) + `governs`/`requires`/`invokes` edges. Default ON — a clean no-op on repos with no
   *  allowlist-matching tracked artifacts (the common test-fixture case), so the deterministic path
   *  is unchanged. `false` skips; an object passes through {@link ArtifactGraphOpts} (e.g. localRoots). */
  artifacts?: boolean | ArtifactGraphOpts;
}

export interface IndexReport {
  files: number;
  parse: ParseStats;
  resolve: ResolveStats;
  cfg: { annotated: number; skipped: number };
  dossiers: DossierStats;
  multimodal: MultimodalReport;
  link: LinkStats;
  cluster: ClusterStats;
  semantic: SemanticStats;
  ownership: OwnershipStats;
  artifacts: ArtifactStats;
}

/** Full index of a repo through the deterministic linker, then (optional) index build. */
export async function indexRepo(
  soul: SoulStore,
  root: string,
  opts: IndexOpts = {},
): Promise<IndexReport> {
  const registry = new ExtractorRegistry();
  for (const e of opts.extractors ?? defaultExtractors()) {
    registry.register(e);
  }

  const discoverOpts: { ignores?: Set<string>; packageRoots?: string[] } = {};
  if (opts.ignores) discoverOpts.ignores = opts.ignores;
  if (opts.packageRoots && opts.packageRoots.length > 0)
    discoverOpts.packageRoots = opts.packageRoots;
  const files = discoverFiles(root, discoverOpts);
  // Mule pre-pass (Foundation Task 4): stamp a clone-safe FileClassification + role lang onto Mule
  // files so MuleExtractor.supports() can dispatch disjointly (Task 13) and fileNode can hash
  // sensitive config by KEYS only. Diagnostics are aggregated by the parse phase (Task 7).
  classifyMuleDiscovery(root, files);
  runStructure(soul, root, files); // Phase 1
  // defaultRegistry = the fleet came from defaultExtractors() (no custom opts.extractors) → the
  // parallel pool can ship it. Custom extractors force the serial path (workers can't receive them).
  const parse = await runParse(soul, registry, root, files, {
    parallel: opts.parallel,
    defaultRegistry: !opts.extractors,
  }); // Phase 2 + 3b (Markdown extractor)
  const resolve = runResolve(soul, root, files, opts.resolvers); // Phase 3 (TS + PL/SQL + Python)
  const cfg = runCfg(soul, root, files, opts.cfgPasses); // Phase 3d (M11 guard-chain annotation)
  // Phase 3e (M13, OFF by default): ingest media segments via the offline worker + link them to
  // symbols. Slots before the doc linker; both write disjoint edge src-kinds (media-seg vs doc-section).
  const mediaPaths = files.filter((f) => isMediaPath(f.path)).map((f) => f.path);
  const multimodal = opts.multimodal
    ? await runMultimodal(soul, root, opts.multimodal, mediaPaths)
    : { ingest: { files: 0, segments: 0, dropped: 0 }, link: { describes: 0, references: 0 } };
  const link = runLink(soul, root, opts.linkThreshold); // Phase 4
  // Phase 4a (W1): the AI-artifact graph — discovers tracked skills/agents/commands/rules/instructions
  // + MCP-server configs that the normal walk misses (they live under gitignored tool dirs), emits
  // `agent-artifact` nodes, and resolves `governs`/`requires`/`invokes` edges against the indexed
  // symbol/file/doc graph. A clean no-op on repos with no allowlist-matching artifacts.
  const artifacts =
    opts.artifacts === false
      ? {
          artifacts: 0,
          governs: 0,
          requires: 0,
          invokes: 0,
          mcpServers: 0,
          localOverlay: 0,
          diagnostics: [],
        }
      : runArtifactGraph(soul, root, typeof opts.artifacts === 'object' ? opts.artifacts : {});
  const cluster = opts.cluster === false ? { communities: 0, members: 0 } : runCluster(soul); // Phase 4b (M7)
  const semantic = opts.semantic ? runSemanticLink(soul, root) : { added: 0 }; // Phase 4c (M7, INFERRED)
  // Phase 4d (M3.1): `git blame` → symbol→owner `owned-by` EXTRACTED edges. Clean no-op in a non-git
  // repo, so the deterministic path (and the mkdtemp-based tests/gates) is unchanged. Runs before the
  // VCS anchor stamp + commit so owners land in the committed soul.
  const ownership =
    opts.ownership === false
      ? { files: 0, symbols: 0, owners: 0, edges: 0, skipped: 0 }
      : runOwnership(soul, root);
  // Best-effort VCS anchor (M6): stamp the current HEAD so `crib update` / `detect_changes` can diff
  // against it. Non-git repos silently skip (the stamp stays absent → update degrades to full index).
  try {
    const head = currentHead(root);
    if (head) soul.setVcsHead(head);
  } catch {
    // not a git repo — leave the anchor unset
  }
  soul.commit(opts.now);

  // Phase 5 (Workstream E): build + persist reusable deep dossiers for every callable symbol. Runs
  // after commit so the manifest (schemaVersion + lastUpdated) is final; true no-ops are skipped.
  const committedAt = opts.now ?? soul.getManifest().stats.lastUpdated;
  const dossiers =
    opts.dossiers === false
      ? { candidates: 0, written: 0, fresh: 0, skipped: 0, pruned: 0 }
      : runDossiers(soul, root, committedAt);

  if (opts.index) opts.index.buildFromSoul(soul, root);

  return {
    files: files.length,
    parse,
    resolve,
    cfg,
    dossiers,
    multimodal,
    link,
    cluster,
    semantic,
    ownership,
    artifacts,
  };
}
