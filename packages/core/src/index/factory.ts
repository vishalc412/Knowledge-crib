/**
 * Backend factory: resolve an {@link IndexStore} from the manifest's declared backend. This is the
 * one place that knows about concrete backends; everything else codes to the interface.
 */
import type { IndexBackend } from '@knowledge-crib/soul-schema';
import type { IndexStore } from '../index-store.js';
import { KuzuIndexStore } from './kuzu-index.js';
import { SqliteIndexStore } from './sqlite-index.js';

export interface OpenIndexOpts {
  /** sqlite db path, or ':memory:'. Ignored by the Kùzu stub. */
  path?: string;
}

/** Open the IndexStore for a backend. Defaults to sqlite (the production default, research §4.2). */
export function openIndex(backend: IndexBackend = 'sqlite', opts: OpenIndexOpts = {}): IndexStore {
  switch (backend) {
    case 'sqlite':
      return new SqliteIndexStore(opts.path ?? ':memory:');
    case 'kuzu':
      return new KuzuIndexStore();
  }
}
