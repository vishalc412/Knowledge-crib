import type { BuildOpts, IndexStore, SoulStore } from '@knowledge-crib/core';
/**
 * The index orchestrator — wires the phases that exist today (structure → parse) and writes the
 * soul, then builds the derived index. Later phases (resolve, doc-extract, link, cluster) slot in
 * here between parse and index as they land.
 */
import { ExtractorRegistry, TypeScriptExtractor } from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';
import { runParse } from './parse.js';
import type { ParseStats } from './parse.js';
import { discoverFiles, runStructure } from './structure.js';

export interface IndexOpts {
  /** extractors to register; defaults to the TypeScript extractor. */
  extractors?: Extractor[];
  /** commit timestamp for deterministic output. */
  now?: string;
  /** build the derived index after committing the soul. */
  index?: IndexStore;
  buildOpts?: BuildOpts;
}

export interface IndexReport {
  files: number;
  parse: ParseStats;
}

/** Full index of a repo: Phase 1 structure → Phase 2 parse → commit soul → (optional) build index. */
export async function indexRepo(
  soul: SoulStore,
  root: string,
  opts: IndexOpts = {},
): Promise<IndexReport> {
  const registry = new ExtractorRegistry();
  for (const e of opts.extractors ?? [new TypeScriptExtractor()]) registry.register(e);

  const files = discoverFiles(root);
  runStructure(soul, root, files);
  const parse = await runParse(soul, registry, root, files);
  soul.commit(opts.now);

  if (opts.index) opts.index.buildFromSoul(soul, opts.buildOpts);

  return { files: files.length, parse };
}
