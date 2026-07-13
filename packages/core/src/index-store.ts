/**
 * IndexStore — the derived, fast, swappable query layer.
 *
 * 100% derived from the SoulStore: delete it and `buildFromSoul` rebuilds it, so soul↔index drift
 * is impossible. The pipeline and MCP depend ONLY on this interface — swapping the sqlite backend
 * for Kùzu later touches nothing upstream (storage §2). The deterministic verbs
 * (query/impact/neighbors/shortestPath) never need a network or vectors.
 */
import type { Edge, Node, NodeKind, Rel } from '@knowledge-crib/soul-schema';
import type { SoulStore } from './soul-store.js';

/** Traversal direction. `up` = follow incoming edges (dependents / blast-radius); `down` = outgoing (dependencies). */
export type Dir = 'up' | 'down';

/**
 * The derived index (FTS5 BM25 + adjacency over names/signatures/headings/files AND rehydrated body
 * text) is fully determined by the soul + the work-tree root — `buildFromSoul(soul, repoRoot)`
 * rehydrates each node's span from disk to populate the body FTS column (capped; the soul stays
 * lean). `repoRoot` is required so the body-search projection is built from real source, not a
 * stale copy. The INFERRED TF-IDF semantic pass is a pipeline-level concern
 * (`IndexOpts.semantic` / CLI `--semantic`), not an index-build option, so there is no
 * `withEmbeddings`/vector field anywhere.
 */

/** An incremental change set applied to the index after the soul is updated. */
export interface IndexDelta {
  nodes: Node[];
  edges: Edge[];
  /** ids of nodes/edges removed from the soul. */
  removed: string[];
}

export interface HybridQuery {
  /** free-text query against names/signatures/headings/files AND rehydrated body text (FTS5 BM25). */
  text: string;
  /** restrict to these node kinds. */
  kinds?: NodeKind[];
  limit?: number;
  /** skip the first `offset` ranked rows (FTS5 OFFSET) — the resume cursor for `query` paging (M1.2). */
  offset?: number;
  /**
   * When the index was built with an embedder, fuse BM25 ∪ vector retrieval via reciprocal-rank
   * fusion (RRF). `true` (default) fuses when vectors are present; `false` forces pure BM25 — the
   * deterministic exact-match path. Vectors live only in the gitignored derived index, so the soul
   * and `--extracted-only` output stay byte-identical either way (M2.1).
   */
  semantic?: boolean;
}

export interface Hit {
  id: string;
  kind: NodeKind;
  /** lower BM25 score = better match; normalized so callers can sort ascending. */
  score: number;
  name?: string;
  file?: string;
}

export interface ImpactResult {
  root: string;
  dir: Dir;
  depth: number;
  /** node ids in the blast radius, excluding the root. */
  nodes: string[];
  /** the edges traversed to reach them (carry provenance/confidence for trust). */
  edges: Edge[];
}

export interface PathResult {
  found: boolean;
  /** node ids from `from` to `to` inclusive, or [] if not found. */
  path: string[];
  edges: Edge[];
}

export interface IndexCapabilities {
  /** Cypher pass-through (Kùzu only; false for sqlite — reconciliation #9). */
  cypher: boolean;
  /** vector / ANN search available (requires a loaded vector extension; no vector path ships today, so always false). */
  vector: boolean;
}

export interface IndexStore {
  /**
   * Rebuild the entire derived index from the soul, rehydrating each node's body text from
   * `repoRoot` into the FTS body column. `repoRoot` is the work-tree root used for source reads;
   * it is required because the body-search projection is built from on-disk source (the soul stays
   * lean — text is referenced by file+span, never copied into the soul).
   */
  buildFromSoul(soul: SoulStore, repoRoot: string): void;
  /**
   * Apply an incremental change set. `repoRoot` is required for the same reason as
   * {@link buildFromSoul}: each changed/added node's body must be rehydrated from disk so the FTS
   * body column never carries a stale body.
   */
  applyDelta(changed: IndexDelta, repoRoot: string): void;
  query(q: HybridQuery): Hit[];
  impact(id: string, dir: Dir, depth?: number): ImpactResult;
  neighbors(id: string, rel?: Rel, dir?: Dir): Edge[];
  shortestPath(from: string, to: string, maxHops?: number): PathResult;
  capabilities(): IndexCapabilities;
  /** release the underlying handle (sqlite connection). */
  close(): void;
}
