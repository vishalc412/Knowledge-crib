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
  TypeScriptExtractor,
} from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';
import { runLink } from './linker/index.js';
import type { LinkStats } from './linker/index.js';
import { runParse } from './parse.js';
import type { ParseStats } from './parse.js';
import { runResolve } from './resolve/index.js';
import type { ResolveStats } from './resolve/index.js';
import type { Resolver } from './resolve/index.js';
import { discoverFiles, runStructure } from './structure.js';
import { currentHead } from './vcs.js';

export interface IndexOpts {
  /** extractors to register; defaults to TypeScript + Markdown + PL/SQL. */
  extractors?: Extractor[];
  /** cross-file resolvers to register; defaults to TypeScript + PL/SQL (M10). */
  resolvers?: Resolver[];
  /** commit timestamp for deterministic output. */
  now?: string;
  /** build the derived index after committing the soul. */
  index?: IndexStore;
  buildOpts?: BuildOpts;
  /** link persist threshold (default 0.4). */
  linkThreshold?: number;
}

export interface IndexReport {
  files: number;
  parse: ParseStats;
  resolve: ResolveStats;
  link: LinkStats;
}

/** Full index of a repo through the deterministic linker, then (optional) index build. */
export async function indexRepo(
  soul: SoulStore,
  root: string,
  opts: IndexOpts = {},
): Promise<IndexReport> {
  const registry = new ExtractorRegistry();
  // Markdown first so doc files never fall through to a code extractor; TypeScript + PL/SQL ship
  // by default. Supports() are disjoint by extension, so order is only load-bearing for .md.
  for (const e of opts.extractors ?? [
    new MarkdownExtractor(),
    new TypeScriptExtractor(),
    new PlSqlExtractor(),
  ]) {
    registry.register(e);
  }

  const files = discoverFiles(root);
  runStructure(soul, root, files); // Phase 1
  const parse = await runParse(soul, registry, root, files); // Phase 2 + 3b (Markdown extractor)
  const resolve = runResolve(soul, root, files, opts.resolvers); // Phase 3 (TS + PL/SQL)
  const link = runLink(soul, root, opts.linkThreshold); // Phase 4
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

  return { files: files.length, parse, resolve, link };
}
