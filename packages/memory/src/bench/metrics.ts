/**
 * P0 bench metrics — pure math over ranked lists and timing samples. Deliberately dependency-free:
 * the benchmark's job is to be the ruler every phase measures itself against, so the ruler itself
 * must be trivially correct. Every metric here has an obvious definition; no smoothing, no
 * normalization magic — the raw numbers land in the report.
 */

/**
 * Fraction of the labeled-relevant set returned within the top `k` ranks.
 * `|relevant ∩ top-k| / |relevant ∩ returned-scope|` — for these scenarios every relevant record
 * exists in the store, so the denominator is `|relevant|`.
 */
export function recallAtK(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  if (relevantIds.length === 0) return 0;
  let hits = 0;
  for (const id of relevantIds) if (rankedIds.slice(0, k).includes(id)) hits += 1;
  return hits / relevantIds.length;
}

/** Fraction of the top `k` results that are relevant (0 when k === 0). */
export function precisionAtK(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  if (k === 0) return 0;
  const relevant = new Set(relevantIds);
  let hits = 0;
  for (const id of rankedIds.slice(0, k)) if (relevant.has(id)) hits += 1;
  return hits / k;
}

/**
 * Mean reciprocal rank: `1 / (rank of the first relevant result)`, averaged over the queries whose
 * relevant set is NON-EMPTY (unlabeled queries are excluded from both numerator and denominator). A
 * relevant record at rank 1 scores 1.0; absent from the ranked list (the caller bounds the list to
 * the k it cares about) scores 0 but still counts in the mean.
 */
export function mrr(
  rankedIdsList: readonly (readonly string[])[],
  relevantIdsList: readonly (readonly string[])[],
): number {
  let count = 0;
  let total = 0;
  for (let i = 0; i < rankedIdsList.length; i++) {
    const relevant = relevantIdsList[i] ?? [];
    if (relevant.length === 0) continue; // unlabeled query → excluded from the mean
    count += 1;
    const rel = new Set(relevant);
    const idx = (rankedIdsList[i] ?? []).findIndex((id) => rel.has(id));
    if (idx >= 0) total += 1 / (idx + 1);
  }
  return count === 0 ? 0 : total / count;
}

/** Interpolated percentile of a timing sample (0 ≤ p ≤ 1). Nearest-rank on the sorted sample. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

/** Convenience p50/p95 pair for a timing sample. */
export function p50p95(samples: readonly number[]): { p50: number; p95: number } {
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}
