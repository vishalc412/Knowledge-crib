/**
 * Embedder interface + provider resolution (M2.1).
 *
 * The derived index can fuse BM25 with a vector retriever to generalize across the case/affix/
 * paraphrase gaps exact-match BM25 misses — the conceptual-query recall win M2.1 gates on.
 *
 * Determinism contract: the DEFAULT embedder is pure JS, dependency-free, and byte-identical across
 * runs/machines (a hashing-trick char n-gram vector). It is the *offline default*. An external
 * provider (env `KCRIB_EMBEDDER`) may be plugged in for denser neural embeddings; that path is
 * non-deterministic by nature and MUST NOT feed the committed soul — only the gitignored derived
 * vector table. `--extracted-only` is therefore byte-identical with or without embeddings, because
 * vectors live only in `.crib/index` / `.crib/embeddings` (gitignored, rebuildable).
 *
 * Storage note: vectors are float32 BLOB columns in the existing `node:sqlite` derived index with
 * brute-force cosine ANN — NOT the `sqlite-vec` native extension. The plan names sqlite-vec, but
 * shipping a per-platform native binary breaks the M0 gates (packaged <5 MB, runtime deps ≤6,
 * cross-platform matrix). The BLOB+cosine path honors those gates; M3.6's ≥1M-LOC scale bench will
 * decide whether to graduate to sqlite-vec / sharded loading from measured data, not guesswork.
 */

/** A unit vector (L2-normalized float32) of length {@link Embedder.dim}. */
export type Vec = Float32Array;

/**
 * A deterministic, dependency-free text embedder. The default impl is pure JS; an external provider
 * implements this to plug a neural embedder in via `KCRIB_EMBEDDER`.
 */
export interface Embedder {
  /** stable id recorded in derived vector metadata, e.g. `char-ngram-512`. */
  id: string;
  /** fixed vector dimensionality. */
  dim(): number;
  /** embed a single text into a unit vector. */
  embed(text: string): Vec;
  /** embed a batch (default impl loops; providers override for throughput). */
  embedBatch(texts: string[]): Vec[];
}

/** Provider-resolution options. */
export interface EmbedderOptions {
  /** override the provider id; `undefined` → env `KCRIB_EMBEDDER` → `'char-ngram'` default. */
  provider?: string;
  /** vector dimensionality for the default char-n-gram embedder (ignored by external providers). */
  dim?: number;
  /** minimum/maximum n-gram length for the default embedder. */
  minN?: number;
  maxN?: number;
}

/** Default vector dimensionality — enough buckets for the char n-gram hashing trick at 18k-node scale. */
export const DEFAULT_DIM = 512;
/** Default n-gram window for the char embedder: 3–6 catches affix/paraphrase variants. */
export const DEFAULT_MIN_N = 3;
export const DEFAULT_MAX_N = 6;
