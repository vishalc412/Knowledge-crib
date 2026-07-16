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

  // --- deep-extraction 1.2 (behavior-bearing fidelity) ---
  /** `raise` node: the Oracle error code, e.g. "-20001" (from RAISE_APPLICATION_ERROR). */
  errorCode?: string;
  /** `raise` node: the error message text. */
  errorMessage?: string;
  /** `exception-handler` node: the WHEN selector, e.g. "NO_DATA_FOUND" / "OTHERS" / user exception. */
  whenSelector?: string;
  /** `assignment` node: the assignment target (LHS), e.g. "v_status". */
  assignTarget?: string;
  /** `cursor` node: the cursor's SELECT query text. */
  cursorQuery?: string;
  /** true iff a captured expression (`expr`/`cursorQuery`) was clipped at the fidelity cap
   *  (EXPR_MAX_CHARS) — a fidelity caveat telling the consumer to rehydrate `file`+`span` for the
   *  full text. Absent/false means the captured snippet IS the complete expression. */
  exprTruncated?: boolean;

  // --- framework-semantics 1.3 (routes / DI / components / fields) ---
  /** `route` node: the HTTP verb, uppercased — "GET" / "POST" / "PUT" / "DELETE" / "PATCH" / "ANY". */
  httpMethod?: string;
  /** `route` node: the composed path — class base + method mapping, e.g. "/api/loans/{id}". */
  routePath?: string;
  /** symbol/component framework tag, e.g. "spring" / "express" / "nestjs" / "react" / "angular". */
  framework?: string;
  /** symbol semantic role within its framework: "controller"/"service"/"repository"/"entity"/
   *  "config"/"component"/"module"/"directive"/"pipe"/"hook" — the stereotype, derived from
   *  annotations/decorators/structure. Lets a consumer filter the graph by architectural role. */
  stereotype?: string;
  /** `column` node: inline constraints as written, e.g. ["NOT NULL","DEFAULT 0","CHECK (…)"]. */
  constraints?: string[];
  /** `explanation` node: the source span of the comment block this explanation was derived from. */
  commentRef?: { file: string; span: Span };

  // --- ownership 1.4 (git blame → owned-by edges) ---
  /** `owner` node: the git author's email (the canonical, stable identity for dedup). Absent for
   *  owners extracted from a blame that exposed no email (rare; the name is the fallback identity). */
  email?: string;

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
  /** Canonical layered graph store. `soul` remains legacy format capability metadata. */
  graph?: { path: string; format: 'layered-jsonl' };
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
  /** Monotonic source generations for derived-cache invalidation. */
  generation?: { extracted: number; semantic: number };
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
 * `inLoop`/`inException`. 1.2 (deep-extraction fidelity) adds NodeKinds `exception-handler`,
 * `raise`, `cursor`, `assignment`, `case-branch`; Rels `raises`/`handles`/`iterates`/`declares`;
 * and optional Node fields `errorCode`/`errorMessage`/`whenSelector`/`assignTarget`/`cursorQuery`/
 * `constraints`/`commentRef`. ALL additions are optional, so a 1.0/1.1 soul still loads verbatim —
 * absent fields stay `undefined` (no widening) and are preserved on re-write. 1.3 (framework-
 * semantics) adds NodeKinds `route`/`field`/`component`, Rels `exposes`/`injects`/`renders`, and
 * optional Node fields `httpMethod`/`routePath`/`framework`/`stereotype`/`exprTruncated` — all
 * additive + optional, so a 1.0–1.2 soul still loads verbatim. 1.4 (ownership) adds NodeKind
 * `owner`, Rel `owned-by`, and the optional Node field `email` — additive + optional, so a
 * 1.0–1.3 soul still loads verbatim. 1.5 (cross-repo federation) adds NodeKind `http-call` (an
 * outbound HTTP client call site; reuses the optional `httpMethod`/`routePath`/`framework` fields)
 * — additive + optional, so a 1.0–1.4 soul still loads verbatim. No new Rel: the A→B route
 * resolution is a runtime federation computation, not a committed edge.
 */
export const SCHEMA_VERSION = '1.5';
export const TOOL_NAME = 'knowledge-crib';

/**
 * Schema versions the loader will hydrate. A 1.0 soul (pre-M11) loads as-is; its edges have no
 * `cfgPath` and that is preserved on re-write (no widening). Unknown versions → load() refuses.
 */
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5'] as const;

/** Default chunking knobs (per spec storage §6 / C4). */
export const DEFAULT_CHUNKING: ManifestChunking = {
  shardHexDigits: 2,
  maxChunkLines: 5000,
  format: 'jsonl',
};
