/**
 * Incremental update (M6) — a git-anchored scoped re-extract of the changed files PLUS their
 * reverse-dependency closure, producing an `IndexDelta` the caller applies to the derived index.
 *
 * Why the reverse-dependency closure (the P0-1 fix): `SoulStore.removeByFile(A)` drops edges whose
 * `dst` resolves into A, i.e. incoming `B→A` from unchanged files that import/call/describe A. A resolve
 * over ONLY A would never re-emit `B→A` (the resolver emits edges whose `src` lives in the passed files),
 * so the edge would be silently lost and pushed to the index `removed[]`. Instead we re-resolve the union
 * of changed files and every file whose references reach into them: B is re-resolved too, `B→A` is
 * re-emitted, and — because B's source is unchanged — its shard chunk rewrites with byte-identical
 * content (no git diff). The honest gate is "only the edited file's shard chunks differ" for a body-only
 * edit; an API change legitimately alters reverse-deps' edge shards, which is correct, not a violation.
 *
 * Returns `null` when there is no anchor (fresh soul) or the repo isn't git — the caller degrades to a
 * full `indexRepo`. Does NOT touch the index; the caller applies `delta` via `index.applyDelta`.
 */
import { buildDelta, fileScopedIds, pathFromId } from '@knowledge-crib/core';
import type { IndexDelta, SoulStore } from '@knowledge-crib/core';
import { ExtractorRegistry, MarkdownExtractor, TypeScriptExtractor } from '@knowledge-crib/parsers';
import type { Extractor } from '@knowledge-crib/parsers';
import { runLink } from './linker/index.js';
import type { LinkStats } from './linker/index.js';
import { runParse } from './parse.js';
import type { ParseStats } from './parse.js';
import { runResolve } from './resolve/index.js';
import type { ResolveStats } from './resolve/index.js';
import { metaForPaths, runStructure } from './structure.js';
import { changedFilesSince, currentHead } from './vcs.js';

export interface UpdateOpts {
  /** commit timestamp (deterministic tests). */
  now?: string;
  /** link persist threshold. */
  linkThreshold?: number;
  /** override the incremental anchor sha (else manifest.incrementalSince ?? repo.vcsHead). */
  since?: string;
  /** extractors to register; defaults to TypeScript + Markdown. */
  extractors?: Extractor[];
}

export interface UpdateReport {
  delta: IndexDelta;
  changedPaths: string[];
  scopeFiles: string[];
  head: string;
  parse: ParseStats;
  resolve: ResolveStats;
  link: LinkStats;
}

export interface UpdateNoopReport {
  changedPaths: string[];
  scopeFiles: [];
  head: string;
  noop: true;
}

export type UpdateResult = UpdateReport | UpdateNoopReport | null;

const EMPTY_PARSE: ParseStats = { filesParsed: 0, nodes: 0, edges: 0 };
const EMPTY_RESOLVE: ResolveStats = {
  imports: 0,
  calls: 0,
  inherits: 0,
  implements: 0,
  dropped: 0,
};
const EMPTY_LINK: LinkStats = { describes: 0, references: 0 };

/** Scoped re-extract since the manifest's VCS anchor. `null` ⇒ caller does a full `indexRepo`. */
export async function updateRepo(
  soul: SoulStore,
  root: string,
  opts: UpdateOpts = {},
): Promise<UpdateResult> {
  let head: string;
  try {
    head = currentHead(root);
  } catch {
    return null; // non-git → degrade to full index
  }

  const manifest = soul.getManifest();
  const since = opts.since ?? manifest.stats.incrementalSince ?? manifest.repo.vcsHead;
  if (!since) return null; // no anchor yet → full index

  const changedPaths = changedFilesSince(root, since);

  // No file changes: just advance the anchor so the next update is anchored to the new HEAD.
  if (changedPaths.length === 0) {
    soul.setVcsHead(head);
    soul.commit(opts.now);
    return { changedPaths, scopeFiles: [], head, noop: true };
  }

  // Reverse-dependency closure: every file whose references reach into a changed file. Captured BEFORE
  // removal (single pass over edges; covers imports/calls/inherits/describes/references — any edge whose
  // dst resolves into a changed path).
  const changed = new Set(changedPaths);
  const scope = new Set(changedPaths);
  for (const edge of soul.iterateEdges()) {
    const d = pathFromId(edge.dst);
    if (d !== undefined && changed.has(d)) {
      const s = pathFromId(edge.src);
      if (s !== undefined) scope.add(s);
    }
  }

  const before = fileScopedIds(soul, scope);

  // Drop only the CHANGED files' records (reverse-dep nodes persist — their source is unchanged).
  for (const p of changedPaths) soul.removeByFile(p);

  // Re-extract changed files: structure (file nodes) + parse (symbols + intra-file edges).
  const registry = new ExtractorRegistry();
  for (const e of opts.extractors ?? [new TypeScriptExtractor(), new MarkdownExtractor()]) {
    registry.register(e);
  }
  const changedMetas = metaForPaths(root, changedPaths);
  runStructure(soul, root, changedMetas);
  const parse = await runParse(soul, registry, root, changedMetas);

  // Re-resolve the whole closure (changed + reverse deps): re-emits incoming B→A edges. The resolver
  // only processes files in the passed set; the SymbolTable spans the whole soul (B's symbols remain).
  const scopeMetas = metaForPaths(root, [...scope]);
  const resolve = runResolve(soul, root, scopeMetas);

  // Re-link only the docs in scope (InvertedIndex still spans the whole soul).
  const scopeDocFiles = scopeMetas.filter((m) => m.lang === 'markdown').map((m) => m.path);
  const link = runLink(soul, root, opts.linkThreshold, scopeDocFiles);

  soul.setVcsHead(head);
  soul.commit(opts.now);

  const delta = buildDelta(soul, before, scope);
  return { delta, changedPaths, scopeFiles: [...scope].sort(), head, parse, resolve, link };
}
