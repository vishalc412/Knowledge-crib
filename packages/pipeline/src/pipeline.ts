/**
 * The index orchestrator — wires the deterministic phases that exist today and writes the soul,
 * then builds the derived index:
 *   Phase 1 structure → 2 parse → 3 resolve → 3b doc-extract → 4 link → commit → build index.
 * Later phases (cluster, semantic link) slot in before/after commit as they land.
 */
import type { BuildOpts, IndexStore, SoulStore } from '@knowledge-crib/core';
import {
  ExtractorRegistry,
  MarkdownExtractor,
  PlSqlExtractor,
  PythonExtractor,
  TypeScriptExtractor,
} from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';
import { runCluster } from './cluster/index.js';
import type { ClusterStats } from './cluster/index.js';
import { runLink } from './linker/index.js';
import type { LinkStats } from './linker/index.js';
import type { SemanticStats } from './linker/index.js';
import { runSemanticLink } from './linker/index.js';
import { runParse } from './parse.js';
import type { ParseStats } from './parse.js';
import { runCfg } from './resolve/index.js';
import { runResolve } from './resolve/index.js';
import type { ResolveStats } from './resolve/index.js';
import type { CfgPass, Resolver } from './resolve/index.js';
import { discoverFiles, runStructure } from './structure.js';
import { currentHead } from './vcs.js';

export interface IndexOpts {
  /** extractors to register; defaults to Markdown + TypeScript + PL/SQL + Python. */
  extractors?: Extractor[];
  /** cross-file resolvers to register; defaults to TypeScript + PL/SQL + Python. */
  resolvers?: Resolver[];
  /** CFG guard-chain passes to register; defaults to PL/SQL (M11). */
  cfgPasses?: CfgPass[];
  /** commit timestamp for deterministic output. */
  now?: string;
  /** build the derived index after committing the soul. */
  index?: IndexStore;
  buildOpts?: BuildOpts;
  /** link persist threshold (default 0.4). */
  linkThreshold?: number;
  /** run structural clustering (Louvain) after the link phase; default true (M7). */
  cluster?: boolean;
  /** run the INFERRED TF-IDF semantic linker pass after the deterministic linker; default false (M7).
   *  Off → `--extracted-only` pure deterministic subset; on → adds capped `references` (INFERRED) edges
   *  for pairs the deterministic signals missed, strictly increasing recall. */
  semantic?: boolean;
}

export interface IndexReport {
  files: number;
  parse: ParseStats;
  resolve: ResolveStats;
  cfg: { annotated: number; skipped: number };
  link: LinkStats;
  cluster: ClusterStats;
  semantic: SemanticStats;
}

/** Full index of a repo through the deterministic linker, then (optional) index build. */
export async function indexRepo(
  soul: SoulStore,
  root: string,
  opts: IndexOpts = {},
): Promise<IndexReport> {
  const registry = new ExtractorRegistry();
  // Markdown first so doc files never fall through to a code extractor; TypeScript + PL/SQL + Python
  // ship by default. Supports() are disjoint by extension, so order is only load-bearing for .md.
  for (const e of opts.extractors ?? [
    new MarkdownExtractor(),
    new TypeScriptExtractor(),
    new PlSqlExtractor(),
    new PythonExtractor(),
  ]) {
    registry.register(e);
  }

  const files = discoverFiles(root);
  runStructure(soul, root, files); // Phase 1
  const parse = await runParse(soul, registry, root, files); // Phase 2 + 3b (Markdown extractor)
  const resolve = runResolve(soul, root, files, opts.resolvers); // Phase 3 (TS + PL/SQL + Python)
  const cfg = runCfg(soul, root, files, opts.cfgPasses); // Phase 3d (M11 guard-chain annotation)
  const link = runLink(soul, root, opts.linkThreshold); // Phase 4
  const cluster = opts.cluster === false ? { communities: 0, members: 0 } : runCluster(soul); // Phase 4b (M7)
  const semantic = opts.semantic ? runSemanticLink(soul, root) : { added: 0 }; // Phase 4c (M7, INFERRED)
  // Best-effort VCS anchor (M6): stamp the current HEAD so `crib update` / `detect_changes` can diff
  // against it. Non-git repos silently skip (the stamp stays absent → update degrades to full index).
  try {
    const head = currentHead(root);
    if (head) soul.setVcsHead(head);
  } catch {
    // not a git repo — leave the anchor unset
  }
  soul.commit(opts.now);

  if (opts.index) opts.index.buildFromSoul(soul, opts.buildOpts);

  return { files: files.length, parse, resolve, cfg, link, cluster, semantic };
}
