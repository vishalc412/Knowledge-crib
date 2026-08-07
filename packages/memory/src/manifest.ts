/**
 * Memory manifest construction (mirrors `core/manifest.ts` `newManifest`). One manifest per store
 * (local repo, global, team). `repoId` is the registry-supplied stable id (PRD: "the registry
 * already supplies a stable repoId") — present for the `local` and `team` stores, absent for
 * `global`.
 */
import type { MemoryManifest, MemoryStoreRole } from './types.js';

export interface NewMemoryManifestOpts {
  store: MemoryStoreRole;
  /** registry repoId; required for `local`/`team`, ignored for `global`. */
  repoId?: string;
  repoRoot?: string;
  now?: string;
}

export function newMemoryManifest(opts: NewMemoryManifestOpts): MemoryManifest {
  const manifest: MemoryManifest = {
    memoryFormatVersion: '1',
    schemaVersion: '1',
    store: opts.store,
    counts: {
      records: 0,
      candidates: 0,
      attempts: 0,
      receipts: 0,
      decisions: 0,
      feedback: 0,
    },
    lastUpdated: opts.now ?? new Date().toISOString(),
  };
  if (opts.store !== 'global' && opts.repoId) {
    manifest.repo = { id: opts.repoId, root: opts.repoRoot ?? '.' };
  }
  return manifest;
}

/** An empty-counts manifest's zero record count, for comparisons. */
export function emptyMemoryCounts() {
  return { records: 0, candidates: 0, attempts: 0, receipts: 0, decisions: 0, feedback: 0 };
}
