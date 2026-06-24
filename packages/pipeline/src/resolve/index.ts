import type { SoulStore } from '@knowledge-crib/core';
/**
 * Phase 3 — resolve. Builds the global symbol table from the soul, runs the per-language resolvers,
 * and writes the cross-file EXTRACTED edges back to the soul. Today: TypeScript. Other languages
 * add a resolver here (extractor-plugins §4 step 4).
 */
import type { FileMeta } from '@knowledge-crib/parsers';
import { SymbolTable } from './symbol-table.js';
import { resolveTypeScript } from './ts-resolver.js';
import type { ResolveStats } from './ts-resolver.js';

export { SymbolTable } from './symbol-table.js';
export { resolveTypeScript } from './ts-resolver.js';
export type { ResolveStats, ResolveResult } from './ts-resolver.js';

/** Phase 3: resolve cross-file edges and persist them. Returns aggregate stats. */
export function runResolve(soul: SoulStore, root: string, files: FileMeta[]): ResolveStats {
  const table = new SymbolTable(soul);
  const { edges, stats } = resolveTypeScript(table, root, files);
  if (edges.length > 0) soul.putEdges(edges);
  return stats;
}
