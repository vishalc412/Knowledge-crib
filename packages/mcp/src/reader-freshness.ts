/**
 * WP4.7 — the reader-facing freshness contract.
 *
 * Every surface that answers code queries — `crib status` JSON, the MCP `status` tool's health op,
 * the Memory Home — reports the same {@link ReaderFreshness} shape so a consumer never has to guess
 * whether the graph it is reading matches the source tree. Two distinctions the plan pins
 * explicitly (WP4, "report"):
 *
 *  - `stale` means the ACTIVE READER is behind the live source — the snapshot answering queries was
 *    not built from the current working tree/HEAD. A committed index that sits behind HEAD while the
 *    working overlay compensates is NOT reader-stale; it is reported through `staleReasons` as
 *    `committed-index-behind-head` so the two conditions can never be conflated.
 *  - `publishedGeneration` vs `readerGeneration`: publication is atomic-per-request, so a refresh
 *    that completes while requests are in flight lands in `publishedGeneration` first; the reader
 *    adopts it (and the generations re-agree) only once the active requests drain. A consumer that
 *    sees `publishedGeneration !== readerGeneration` knows a swap is imminent, not lost.
 *
 * This type is the MCP-layer contract; the serving process (refresh coordinator in `packages/cli`)
 * constructs it. A cold, non-serving consumer (one-shot `crib status`, the viz server) constructs it
 * via the same interface from manifest + VCS facts — there is no second, divergent health shape.
 */

/** Lifecycle of the serving process's refresh loop, reported per status call. */
export type RefreshState =
  /** No graph has ever been published for this root — nothing to serve. */
  | 'unindexed'
  /** Serving a published bundle; no refresh running or queued. */
  | 'idle'
  /** A refresh is waiting for the current one to finish (WP4.1 coalescing). */
  | 'queued'
  /** A refresh is building a candidate bundle right now. */
  | 'refreshing'
  /** The last refresh attempt failed; the last-good bundle is still serving (WP4.6). */
  | 'error';

export interface ReaderRefreshError {
  /** Stable machine-readable code (`AnchorUnavailableError`, `Error`, …). */
  code: string;
  message: string;
  /** ISO timestamp of the failed attempt. */
  occurredAt: string;
}

/** The reader-freshness block every status surface carries (WP4.7). */
export interface ReaderFreshness {
  /** HEAD the committed (`.crib/graph`) index was built at; null when unknown/absent. */
  indexedHead: string | null;
  /** Live repository HEAD right now; null when VCS detection failed (unknown ≠ fresh). */
  currentHead: string | null;
  /** Generation of the most recently PUBLISHED bundle (ahead of `readerGeneration` during a swap drain). */
  publishedGeneration: string | null;
  /** Generation of the bundle the reader is actually answering from right now. */
  readerGeneration: string | null;
  refreshState: RefreshState;
  /** True only when the ACTIVE READER is behind the live source (see file comment). */
  stale: boolean;
  /** Machine-readable reasons; non-empty only when something is actually wrong or compensating. */
  staleReasons: string[];
  /** ISO timestamp of the last refresh that published successfully. */
  lastSuccessfulRefreshAt: string | null;
  /** The last refresh failure, retained until a later refresh SUCCEEDS (never cleared by time). */
  lastRefreshError: ReaderRefreshError | null;
}

/**
 * Canonical stale reasons (the strings `staleReasons` may carry). Exported so tests and consumers
 * assert against names, not magic strings.
 */
export const STALE_REASONS = {
  /** Live HEAD moved after the serving bundle was built. */
  HEAD_MOVED: 'head-moved-since-publication',
  /** Watchable working-tree content changed after the serving bundle was built. */
  WORKING_TREE_CHANGED: 'working-tree-changed-since-publication',
  /** The committed `.crib` graph advanced externally (`crib update` in another process). */
  CANONICAL_ADVANCED: 'canonical-graph-advanced',
  /** The committed index sits behind HEAD; the overlay compensates — NOT reader-stale alone. */
  COMMITTED_BEHIND: 'committed-index-behind-head',
  /** `changedFilesSince(indexedHead)` could not resolve — history rewritten/gc'd. Fallback rebuild. */
  ANCHOR_UNAVAILABLE: 'indexed-anchor-unavailable',
  /** VCS read failed entirely — the source state is UNKNOWN and must not read as fresh. */
  SOURCE_UNKNOWN: 'source-detection-unavailable',
} as const;
