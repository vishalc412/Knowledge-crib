/**
 * The core record types for the Knowledge-crib soul.
 *
 * Nodes are a discriminated union on `kind`, but the store handles them uniformly, so a broad
 * `Node` interface with optional per-kind fields is used. Text is ALWAYS referenced by `file` +
 * `span`, never copied (lean soul; rehydrate on demand). Unknown `meta` keys are preserved on
 * round-trip (invariant #5 — forward compatibility).
 */
import type { Method, NodeKind, Provenance, Rel } from './enums.js';

export interface Span {
  /** start line, 1-based inclusive */
  start: number;
  /** end line, 1-based inclusive (start <= end) */
  end: number;
}

export interface Evidence {
  /** provenance snippet — the source text that justifies this edge */
  snippet?: string;
  /** which extractor/resolver produced this */
  by?: string;
  [k: string]: unknown;
}

/**
 * A graph node. Common fields across kinds; per-kind extras are optional.
 * `id` is stable + deterministic (see id.ts). `hash` is blake3 of content (change detection).
 */
export interface Node {
  id: string;
  kind: NodeKind;
  /** "blake3:<hex>" — content hash; changes iff content changes (invariant #3) */
  hash: string;

  // --- location (text referenced, not copied) ---
  /** repo-relative source/doc path */
  file?: string;
  /** line range in `file` */
  span?: Span;

  // --- symbols ---
  lang?: string;
  /** AST type (class|function|method|interface|enum|…) or doc level (h2…) */
  type?: string;
  name?: string;
  qualifiedName?: string;
  signature?: string;
  clusterId?: string;

  // --- doc-section ---
  heading?: string;
  level?: number;
  anchor?: string;

  // --- explanation ---
  /** reference to the source text of a docstring/comment (file + span), concept form */
  textRef?: string;

  // --- cluster ---
  label?: string;
  members?: string[];

  // --- deep-extraction (table/column/statement/condition) ---
  schema?: string;
  table?: string;
  dataType?: string;
  sqlKind?: string;
  expr?: string;
  branch?: string;

  /** extensible; unknown keys preserved on read→write */
  meta?: Record<string, unknown>;
}

/** A graph edge. Every edge carries provenance + confidence + evidence (trust model). */
export interface Edge {
  /** "e:<blake3(src|dst|rel)>" — deterministic */
  id: string;
  src: string;
  dst: string;
  rel: Rel;
  method: Method;
  provenance: Provenance;
  /** 0..1 */
  confidence: number;
  evidence?: Evidence;

  // --- migration metadata (deep-extraction): the rule's guard chain (M11 CFG pass) ---
  /** guard predicate reaching this edge's action (innermost condition node id on the path) */
  guard?: string;
  /** path through the CFG from procedure entry — the chain of condition node ids, outer→inner */
  cfgPath?: string[];
  /** branch label of the innermost IF branch (e.g. "THEN"/"ELSIF"/"ELSE"); undefined for loops */
  branch?: string;
  /** true if the edge's action sits inside a loop body */
  inLoop?: boolean;
  /** true if the edge's action sits inside an exception handler */
  inException?: boolean;

  /** extensible; unknown keys preserved on read→write */
  meta?: Record<string, unknown>;
}

export interface ManifestRepo {
  id: string;
  root: string;
  /** git sha at last full index */
  vcsHead?: string;
}

export interface ManifestChunking {
  shardHexDigits: number;
  maxChunkLines: number;
  format: 'jsonl';
}

export interface ManifestStores {
  soul: 'jsonl-chunked';
  /** reconciliation #7: concrete backend field (was hardcoded `ladybug.db`) */
  index: { backend: IndexBackend; path: string };
}

export type IndexBackend = 'sqlite' | 'kuzu';

export interface ManifestStats {
  nodes: number;
  edges: number;
  clusters: number;
  lastUpdated: string;
  /** git sha the incremental update is anchored to */
  incrementalSince?: string;
}

export interface ManifestCapabilities {
  embeddings: boolean;
  multimodal: boolean;
}

export interface Manifest {
  cribFormatVersion: string;
  schemaVersion: string;
  repo: ManifestRepo;
  generator: { tool: string; version: string };
  chunking: ManifestChunking;
  stores: ManifestStores;
  stats: ManifestStats;
  capabilities: ManifestCapabilities;
  /** extensible; unknown keys preserved */
  meta?: Record<string, unknown>;
}

/** Current format + schema versions. */
export const CRIB_FORMAT_VERSION = '1.0';
/**
 * Schema version. 1.1 (M11) widens `Edge.cfgPath` from `string` to `string[]` and adds
 * `inLoop`/`inException`. A soul written at 1.0 (no `cfgPath` on its edges) still loads — the
 * absent field stays `undefined` (no widening) — see {@link SUPPORTED_SCHEMA_VERSIONS}.
 */
export const SCHEMA_VERSION = '1.1';
export const TOOL_NAME = 'knowledge-crib';

/**
 * Schema versions the loader will hydrate. A 1.0 soul (pre-M11) loads as-is; its edges have no
 * `cfgPath` and that is preserved on re-write (no widening). Unknown versions → load() refuses.
 */
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0', '1.1'] as const;

/** Default chunking knobs (per spec storage §6 / C4). */
export const DEFAULT_CHUNKING: ManifestChunking = {
  shardHexDigits: 2,
  maxChunkLines: 5000,
  format: 'jsonl',
};
