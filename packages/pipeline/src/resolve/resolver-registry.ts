import type { SoulStore } from '@knowledge-crib/core';
/**
 * Resolver dispatch table (P0a) — the per-language cross-file resolver contract. Replaces the
 * single hard-coded `resolveTypeScript` call so M8/M10/M11 register append-only instead of touching
 * the shared `resolve/index.ts` dispatch each time.
 *
 * A resolver resolves cross-file edges for the files it `supports`, against a shared
 * {@link SymbolTable} + the soul (the SQL resolver needs the soul to build a SchemaCatalog and to
 * read statement/symbol node metadata). Resolvers are PURE: they return edges; {@link runResolve}
 * persists them. A reference that does not resolve to an indexed node is dropped, never guessed.
 */
import type { FileMeta } from '@knowledge-crib/parsers';
import type { Edge } from '@knowledge-crib/soul-schema';
import type { SymbolTable } from './symbol-table.js';

export interface ResolveContext {
  soul: SoulStore;
  table: SymbolTable;
  root: string;
  files: FileMeta[];
}

export interface ResolveResult {
  edges: Edge[];
  /**
   * per-resolver stat counts; merged into the aggregate by {@link runResolve}. Values are
   * `number | undefined` so a resolver returning {@link ResolveStats} (named + index) is assignable.
   */
  stats: Record<string, number | undefined>;
}

export interface Resolver {
  /** unique id, e.g. "ts-resolver" / "sql-resolver". */
  name: string;
  /** which files this resolver claims (partitioned — a file goes to at most one resolver). */
  supports(file: FileMeta): boolean;
  /** resolve cross-file edges for the supported files; pure (returns edges, caller persists). */
  resolve(ctx: ResolveContext): ResolveResult;
}

export class ResolverRegistry {
  private readonly resolvers: Resolver[] = [];
  register(resolver: Resolver): this {
    this.resolvers.push(resolver);
    return this;
  }
  all(): readonly Resolver[] {
    return this.resolvers;
  }
}
