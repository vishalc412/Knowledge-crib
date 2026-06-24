/**
 * Shared CLI runtime: locate `.crib`, open the SoulStore, and (re)build the derived IndexStore from
 * the soul. The index is always rebuilt from the committed soul so a stale/gitignored index can
 * never drift — the soul is the source of truth.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { SoulStore, openIndex } from '@knowledge-crib/core';
import type { IndexStore } from '@knowledge-crib/core';

export interface Runtime {
  repoRoot: string;
  cribDir: string;
  soul: SoulStore;
}

/** Open the soul at <repoRoot>/.crib. Does not build the index. */
export function openSoul(repoRoot: string): Runtime {
  const cribDir = join(repoRoot, '.crib');
  const soul = new SoulStore(cribDir);
  soul.load();
  return { repoRoot, cribDir, soul };
}

/** True if the repo has been indexed (a manifest exists on disk). */
export function isIndexed(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.crib', 'crib.json'));
}

/** Build the IndexStore from the soul, persisting it to the manifest's declared index path. */
export function buildIndex(rt: Runtime): IndexStore {
  const manifest = rt.soul.getManifest();
  const rel = manifest.stores.index.path; // e.g. .crib/index/crib.sqlite
  const path = isAbsolute(rel) ? rel : resolve(rt.repoRoot, rel);
  mkdirSync(dirname(path), { recursive: true });
  const index = openIndex(manifest.stores.index.backend, { path });
  index.buildFromSoul(rt.soul, { withEmbeddings: manifest.capabilities.embeddings });
  return index;
}

/**
 * Open the derived IndexStore at the manifest's declared path WITHOUT rebuilding from the soul (M6).
 * Used by `crib update`, which mutates the soul then applies an `IndexDelta` to the existing index.
 * Throws if no index exists yet (the caller should run `crib index` first).
 */
export function openIndexOnly(rt: Runtime): IndexStore {
  const manifest = rt.soul.getManifest();
  const rel = manifest.stores.index.path;
  const path = isAbsolute(rel) ? rel : resolve(rt.repoRoot, rel);
  if (!existsSync(path)) {
    throw new Error('index not built — run `crib index` first');
  }
  return openIndex(manifest.stores.index.backend, { path });
}
