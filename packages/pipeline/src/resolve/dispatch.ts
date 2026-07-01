/**
 * CFG dispatch (M11, P0) — the per-language control-flow-graph pass contract. Mirrors the
 * resolver dispatch: a pass claims the files it `supports` and annotates existing
 * `executes`/`calls` edges with the guard chain via {@link SoulStore.annotateEdges}. Passes are
 * append-only through {@link CfgPassRegistry} so M8 (more languages) slots in without touching the
 * shared `resolve/index.ts` sequencing.
 *
 * A pass is NOT pure: it mutates the soul (annotation is in-place, overwriting edge fields). It
 * never emits new edges — only annotates ones the extractor/resolver already wrote.
 */
import type { SoulStore } from '@knowledge-crib/core';
import type { FileMeta } from '@knowledge-crib/parsers';

export interface CfgContext {
  soul: SoulStore;
  root: string;
  files: FileMeta[];
}

export interface CfgStats {
  /** edges whose guard-chain fields were written */
  annotated: number;
  /** per-pass extras (e.g. edges skipped because the callee didn't resolve) */
  [k: string]: number | undefined;
}

export interface CfgPass {
  /** unique id, e.g. "plsql-cfg". */
  name: string;
  /** which files this pass claims (partitioned — a file goes to at most one pass). */
  supports(file: FileMeta): boolean;
  /** annotate the guard chain onto existing edges for the supported files. */
  run(ctx: CfgContext): CfgStats;
}

export class CfgPassRegistry {
  private readonly passes: CfgPass[] = [];
  register(pass: CfgPass): this {
    this.passes.push(pass);
    return this;
  }
  all(): readonly CfgPass[] {
    return this.passes;
  }
}
