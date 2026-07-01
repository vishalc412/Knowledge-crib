import type { Rel } from '@knowledge-crib/soul-schema';
/**
 * KuzuIndexStore — optional "rich graph + vector + Cypher" backend (stub).
 *
 * The spec's aspirational "LadybugDB" is Kùzu (MIT, in-process, HNSW vector + FTS + Cypher, Node
 * bindings). BUT canonical `kuzudb/kuzu` was archived read-only Oct 2025 (Apple acquisition); only a
 * vendor fork remains active (research §4.2). So sqlite is the default and this backend is a
 * deferred stub behind the same `IndexStore` interface — it lands for real ONLY if a non-vendor
 * community steward emerges. Constructing it throws, by design, so nothing silently depends on it.
 */
import type {
  Dir,
  Hit,
  HybridQuery,
  ImpactResult,
  IndexCapabilities,
  IndexDelta,
  IndexStore,
  PathResult,
} from '../index-store.js';
import type { SoulStore } from '../soul-store.js';

const NOT_IMPLEMENTED =
  'KuzuIndexStore is a deferred stub (research §4.2: kuzudb/kuzu archived Oct 2025). Use the sqlite backend.';

export class KuzuIndexStore implements IndexStore {
  constructor() {
    throw new Error(NOT_IMPLEMENTED);
  }
  buildFromSoul(_soul: SoulStore, _repoRoot: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  applyDelta(_changed: IndexDelta, _repoRoot: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }
  query(_q: HybridQuery): Hit[] {
    throw new Error(NOT_IMPLEMENTED);
  }
  impact(_id: string, _dir: Dir, _depth?: number): ImpactResult {
    throw new Error(NOT_IMPLEMENTED);
  }
  neighbors(_id: string, _rel?: Rel, _dir?: Dir): never {
    throw new Error(NOT_IMPLEMENTED);
  }
  shortestPath(_from: string, _to: string, _maxHops?: number): PathResult {
    throw new Error(NOT_IMPLEMENTED);
  }
  capabilities(): IndexCapabilities {
    // Documented target capabilities, were it implemented.
    return { cypher: true, vector: true };
  }
  close(): void {
    /* no-op */
  }
}
