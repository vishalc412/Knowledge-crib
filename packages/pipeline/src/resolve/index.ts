import type { SoulStore } from '@knowledge-crib/core';
/**
 * Phase 3 — resolve. Builds the global symbol table from the soul, dispatches the per-language
 * resolvers (P0a registry), and writes the cross-file EXTRACTED edges back to the soul. Then the
 * M11 CFG pass (Phase 3d) annotates the `executes`/`calls` edges with their guard chain.
 *
 * Defaults: TypeScript + PL/SQL + Python (M10/M8 resolvers; M11 CFG pass). Other languages register
 * append-only through the registries passed via `IndexOpts`. A reference that does not resolve to
 * an indexed node is dropped, never guessed.
 */
import type { FileMeta } from '@knowledge-crib/parsers';
import type { CfgPass } from './dispatch.js';
import { CfgPassRegistry } from './dispatch.js';
import { PlSqlCfgPass } from './plsql-cfg.js';
import { PythonResolver } from './python-resolver.js';
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
export { PythonResolver, resolvePython } from './python-resolver.js';
export { SchemaCatalog } from './schema-catalog.js';
export { ResolverRegistry } from './resolver-registry.js';
export type {
  Resolver,
  ResolveContext,
  ResolveResult as ResolverResult,
} from './resolver-registry.js';
export { CfgPassRegistry } from './dispatch.js';
export type { CfgPass, CfgContext, CfgStats } from './dispatch.js';
export { PlSqlCfgPass } from './plsql-cfg.js';
export { segmentBlock } from '../cfg/basic-block.js';
export type { BasicBlock } from '../cfg/basic-block.js';
export { pathCondition } from '../cfg/guard-chain.js';
export type { GuardFrame, PathCondition } from '../cfg/guard-chain.js';

/** Default resolvers when the caller doesn't override: TypeScript + PL/SQL + Python. */
export function defaultResolvers(): Resolver[] {
  return [new TypeScriptResolver(), new SqlResolver(), new PythonResolver()];
}

/** Default CFG passes when the caller doesn't override: PL/SQL (M11). */
export function defaultCfgPasses(): CfgPass[] {
  return [new PlSqlCfgPass()];
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

/**
 * Phase 3d (M11): annotate the guard chain onto existing `executes`/`calls` edges. Runs AFTER
 * {@link runResolve} so the cross-file `calls` edges it annotates already exist. Returns aggregate
 * stats (merged per pass).
 */
export function runCfg(
  soul: SoulStore,
  root: string,
  files: FileMeta[],
  passes?: CfgPass[],
): { annotated: number; skipped: number } {
  const registry = new CfgPassRegistry();
  for (const p of passes ?? defaultCfgPasses()) registry.register(p);
  let annotated = 0;
  let skipped = 0;
  for (const pass of registry.all()) {
    const supported = files.filter((f) => pass.supports(f));
    if (supported.length === 0) continue;
    const stats = pass.run({ soul, root, files: supported });
    annotated += stats.annotated ?? 0;
    skipped += stats.skipped ?? 0;
  }
  return { annotated, skipped };
}
