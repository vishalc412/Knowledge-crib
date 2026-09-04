/**
 * Pure-JS char n-gram hashing-trick embedder — the offline default (M2.1).
 *
 * ⚠ DEGRADED OFFLINE FALLBACK — NOT the semantic implementation. This embedder is a hashing-trick
 * bag of character n-grams: it generalizes across case/affix/light inflection ONLY. It is not a
 * trained model, it carries no word-order or compositional semantics, and its paraphrase recall is
 * the thing G3.2's held-out eval (docs/bench/retrieval-pre-registration.md) measures rather than
 * assumes. It ships as the zero-dependency default so recall never hard-fails offline; the
 * ADVERTISED tier is the pinned on-device model installed out-of-band via `crib embed install`
 * (see `embed-install.ts`). Never describe this class as the semantic embedder in user-facing text.
 *
 * Why char n-grams (not word embeddings): the M1.1 conceptual eval queries are paraphrases —
 * "how is a loan application assessed" → `assess_application`, "where is the auth token validated"
 * → `validate`. BM25 misses these because the surface forms don't share stems ("assessed" ≠ "assess"
 * to FTS5's Porter stemmer in all cases; "validated" ≠ "validate"). Char n-grams generalize across
 * case, affix, and light paraphrase: "assess" and "assessed" share the 4-gram "asse"/"sses"/"esse"/"ssed",
 * so their hashed unit vectors land cosine-similar. No model, no network, no native dep.
 *
 * Determinism: the hash is FNV-1a (stable, no Math.random), the dimensionality is fixed, and the
 * n-gram window is fixed → the SAME text always yields the SAME unit vector on every machine.
 * `--extracted-only` is byte-identical because this feeds only the gitignored derived vector table.
 *
 * Algorithm: for each n-gram g of the lowercased, alnum-padded text, `h = fnv1a(g)`, sign the
 * accumulation by `h & 1` (the hashing-trick signed-count trick that cancels collisions in
 * expectation), add ±1 to `vec[h % dim]`. Then L2-normalize. Counts are int32 before normalization;
 * the float32 unit vector is the stored form.
 */
import type { Embedder, Vec } from './types.js';
import { DEFAULT_DIM, DEFAULT_MAX_N, DEFAULT_MIN_N } from './types.js';

/** FNV-1a 32-bit hash — stable, dependency-free, well-mixed for small strings. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619, kept in uint32 via Math.imul for sign-stable behavior.
    h = Math.imul(h, 0x01000193);
  }
  // force unsigned 32-bit
  return h >>> 0;
}

/** Lowercase + pad with a delimiter so edge n-grams are anchored to token boundaries. */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
}

/** Build the raw signed-count vector for a normalized text. */
function accumulate(text: string, dim: number, minN: number, maxN: number): Float32Array {
  const v = new Float32Array(dim);
  const s = normalize(text);
  if (s.trim().length === 0) return v;
  const lo = Math.max(1, minN);
  const hi = Math.max(lo, maxN);
  for (let n = lo; n <= hi; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const gram = s.slice(i, i + n);
      if (gram.trim().length === 0) continue; // skip all-space n-grams
      const h = fnv1a(gram);
      const bucket = h % dim;
      v[bucket] = (v[bucket] ?? 0) + (h & 1 ? 1 : -1);
    }
  }
  return v;
}

/** L2-normalize a vector in place; a zero vector stays zero (returns it unchanged). */
function l2normalize(v: Float32Array): Vec {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] ?? 0) * (v[i] ?? 0);
  if (norm === 0) return v;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) * inv;
  return v;
}

/**
 * The offline default embedder. Constructed with a fixed dimensionality + n-gram window so the
 * derived vector table is reproducible from the soul alone.
 */
export class CharNgramEmbedder implements Embedder {
  readonly id: string;
  private readonly dim_: number;
  private readonly minN: number;
  private readonly maxN: number;

  constructor(opts: { dim?: number; minN?: number; maxN?: number } = {}) {
    this.dim_ = opts.dim ?? DEFAULT_DIM;
    this.minN = opts.minN ?? DEFAULT_MIN_N;
    this.maxN = opts.maxN ?? DEFAULT_MAX_N;
    this.id = `char-ngram-${this.minN}-${this.maxN}-${this.dim_}`;
  }

  dim(): number {
    return this.dim_;
  }

  embed(text: string): Vec {
    return l2normalize(accumulate(text, this.dim_, this.minN, this.maxN));
  }

  embedBatch(texts: string[]): Vec[] {
    return texts.map((t) => this.embed(t));
  }
}

/** Cosine similarity of two unit vectors = their dot product (no magnitude term needed). */
export function cosine(a: Vec, b: Vec): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** Decode a stored float32 BLOB back into a Vec. */
export function decodeVec(blob: Uint8Array, dim: number): Vec {
  const v = new Float32Array(dim);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < dim; i++) v[i] = view.getFloat32(i * 4, true);
  return v;
}

/** Encode a Vec into a little-endian float32 BLOB for sqlite storage. */
export function encodeVec(v: Vec): Uint8Array {
  const buf = new ArrayBuffer(v.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i] ?? 0, true);
  return new Uint8Array(buf);
}
