import type { SoulStore } from '@knowledge-crib/core';
/**
 * Phase 3 — resolve. Builds the global symbol table from the soul, dispatches the per-language
 * resolvers (P0a registry), and writes the cross-file EXTRACTED edges back to the soul.
 *
 * Defaults: TypeScript + PL/SQL (M10). Other languages (M8) register append-only through the
 * {@link ResolverRegistry} passed via `IndexOpts.resolvers`. A reference that does not resolve to
 * an indexed node is dropped, never guessed.
 */
import type { FileMeta } from '@knowledge-crib/parsers';
import { ResolverRegistry } from './resolver-registry.js';
import type { Resolver } from './resolver-registry.js';
import { SqlResolver } from './sql-resolver.js';
import { SymbolTable } from './symbol-table.js';
import { TypeScriptResolver } from './ts-resolver.js';
import type { ResolveStats } from './ts-resolver.js';

export { SymbolTable } from './symbol-table.js';
export { resolveTypeScript, TypeScriptResolver } from './ts-resolver.js';
export type { ResolveStats, ResolveResult } from './ts-resolver.js';
export { SqlResolver } from './sql-resolver.js';
export { SchemaCatalog } from './schema-catalog.js';
export { ResolverRegistry } from './resolver-registry.js';
export type {
  Resolver,
  ResolveContext,
  ResolveResult as ResolverResult,
} from './resolver-registry.js';

/** Default resolvers when the caller doesn't override: TypeScript + PL/SQL. */
export function defaultResolvers(): Resolver[] {
  return [new TypeScriptResolver(), new SqlResolver()];
}

/** Phase 3: resolve cross-file edges and persist them. Returns aggregate stats (merged per resolver). */
export function runResolve(
  soul: SoulStore,
  root: string,
  files: FileMeta[],
  resolvers?: Resolver[],
): ResolveStats {
  const registry = new ResolverRegistry();
  for (const r of resolvers ?? defaultResolvers()) registry.register(r);

  const table = new SymbolTable(soul);
  const agg: ResolveStats = { imports: 0, calls: 0, inherits: 0, implements: 0, dropped: 0 };

  const allEdges = [];
  for (const resolver of registry.all()) {
    const supported = files.filter((f) => resolver.supports(f));
    if (supported.length === 0) continue;
    const { edges, stats } = resolver.resolve({ soul, table, root, files: supported });
    for (const e of edges) allEdges.push(e);
    for (const [k, v] of Object.entries(stats)) agg[k] = (agg[k] ?? 0) + (v ?? 0);
  }
  if (allEdges.length > 0) soul.putEdges(allEdges);
  return agg;
}
