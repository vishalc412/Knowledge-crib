/**
 * Retrieval-quality metrics for the M1.1 eval harness (pure, deterministic, no deps).
 *
 * Every function is set-based against `retrieved` (ranked ids, best first) and `expected`
 * (the golden ground-truth ids). BM25 returns lower score = better, and SqliteIndexStore.query
 * already sorts ascending, so `retrieved` is in rank order — index 0 is the top hit.
 *
 * Standard IR definitions, binary relevance:
 *  - recall@k    = |expected ∩ top-k| / |expected|
 *  - MRR         = 1 / rank of first expected hit (0 if absent)
 *  - nDCG@k      = DCG@k / IDCG@k, where DCG@k = Σ rel_i / log2(i+1) for i=1..k (rel ∈ {0,1})
 *
 * These are the three metrics the plan gates on (recall@10, MRR, nDCG) computed per golden pair
 * then averaged across a fixture and across the whole pack.
 */

/**
 * Recall@k: fraction of expected ids present in the first `k` retrieved ids.
 * Returns 0 when `expected` is empty (undefined behavior, not 1).
 */
export function recallAtK(retrieved, expected, k) {
  const want = new Set(expected);
  if (want.size === 0) return 0;
  const top = retrieved.slice(0, k);
  let hit = 0;
  for (const id of top) if (want.has(id)) hit += 1;
  return hit / want.size;
}

/**
 * Mean reciprocal rank: 1/rank of the first expected id in `retrieved` (1-indexed), else 0.
 */
export function mrr(retrieved, expected) {
  const want = new Set(expected);
  for (let i = 0; i < retrieved.length; i += 1) {
    if (want.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with binary relevance. DCG = Σ_{i=1..k} rel_i / log2(i+1); IDCG is the ideal ordering
 * (all relevant first, capped at k). Returns 0 when no relevant items exist.
 */
export function ndcgAtK(retrieved, expected, k) {
  const want = new Set(expected);
  if (want.size === 0) return 0;

  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i += 1) {
    const rel = want.has(retrieved[i]) ? 1 : 0;
    if (rel) dcg += 1 / Math.log2(i + 2); // i+2 because i is 0-indexed and rank is 1-indexed
  }
  const idealHits = Math.min(k, want.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Average a metric across a list of per-pair scores. Returns 0 for an empty list so an
 * under-populated fixture never divides by zero.
 */
export function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * The per-pair retrieval result the harness records. `retrieved` is the ranked id list the
 * index returned (already truncated to the requested limit); `expected` is the golden id set.
 */
export function scorePair(retrieved, expected, k = 10) {
  return {
    recall: recallAtK(retrieved, expected, k),
    mrr: mrr(retrieved, expected),
    ndcg: ndcgAtK(retrieved, expected, k),
  };
}
