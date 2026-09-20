/**
 * Backend factory: resolve an {@link IndexStore} from the manifest's declared backend. This is the
 * one place that knows about concrete backends; everything else codes to the interface.
 */
import type { IndexBackend } from '@knowledge-crib/soul-schema';
import type { Embedder } from '../embeddings/types.js';
import type { IndexStore } from '../index-store.js';
import { KuzuIndexStore } from './kuzu-index.js';
import { SqliteIndexStore } from './sqlite-index.js';

export interface OpenIndexOpts {
  /** sqlite db path, or ':memory:'. Ignored by the Kùzu stub. */
  path?: string;
  /**
   * The resolved embedder for the vector channel, or omitted for a lexical store.
   *
   * On a BUILD (`buildFromSoul`) this decides whether vectors are written. On a REOPEN it decides
   * whether existing vectors may be queried — the store refuses them unless `id`/`dim` match what
   * built them. Callers resolve this asynchronously (`loadInstalledEmbedder`) and hand the instance
   * in, because `buildFromSoul` is synchronous by contract and `runtime.ts` has a test pinning it.
   */
  embedder?: Embedder | null;
}

/** Open the IndexStore for a backend. Defaults to sqlite (the production default, research §4.2). */
export function openIndex(backend: IndexBackend = 'sqlite', opts: OpenIndexOpts = {}): IndexStore {
  switch (backend) {
    case 'sqlite':
      return new SqliteIndexStore(opts.path ?? ':memory:', { embedder: opts.embedder ?? null });
    case 'kuzu':
      return new KuzuIndexStore();
  }
}
