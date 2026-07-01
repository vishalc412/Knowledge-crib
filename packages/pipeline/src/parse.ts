import type { SoulStore } from '@knowledge-crib/core';
/**
 * Phase 2 — parse. For each discovered file, resolve an extractor and run it, writing the resulting
 * symbol nodes + intra-file edges to the soul. A file with no extractor is left as just its Phase-1
 * file node. Extractors degrade to no symbols on parse failure (they never throw the pipeline).
 */
import { grammarsNeededFor, preloadGrammars } from '@knowledge-crib/parsers';
import type { ExtractorRegistry, FileMeta } from '@knowledge-crib/parsers';
import { makeExtractCtx } from './extract-ctx.js';

export interface ParseStats {
  filesParsed: number;
  nodes: number;
  edges: number;
}

/** Phase 2: run the registry over every file, persisting nodes + intra-file edges to the soul. */
export async function runParse(
  soul: SoulStore,
  registry: ExtractorRegistry,
  root: string,
  files: FileMeta[],
): Promise<ParseStats> {
  // Preload only the tree-sitter grammars THIS run actually needs (grammarsNeededFor([]) short-
  // circuits to a true no-op) — a repo with zero .php files never boots the WASM engine.
  await preloadGrammars(grammarsNeededFor(files));
  let filesParsed = 0;
  let nodes = 0;
  let edges = 0;
  for (const file of files) {
    const extractor = registry.resolve(file);
    if (!extractor) continue;
    const ctx = makeExtractCtx(root, file.path);
    const result = await extractor.extract(file, ctx);
    if (result.nodes.length > 0) soul.putNodes(result.nodes);
    if (result.edges.length > 0) soul.putEdges(result.edges);
    filesParsed++;
    nodes += result.nodes.length;
    edges += result.edges.length;
  }
  return { filesParsed, nodes, edges };
}
