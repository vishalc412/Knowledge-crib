/**
 * M2.3 semantic signal — a char-n-gram embedding-cosine index over symbol text, the upgrade to the
 * M7 TF-IDF linker. Same contract as {@link TfidfIndex}: a doc-section's query is scored against every
 * symbol's surface text and the top-K above a floor are returned. Same confidence cap [0.4, 0.6] in
 * {@link runSemanticLink} keeps the INFERRED `references` edges strictly below the 0.8 `describes`
 * threshold, so `--extracted-only` and deterministic precision are untouched.
 *
 * Why over TF-IDF: char-n-gram hashing generalizes across inflection ("validation" ≈ "validate"),
 * case, and affix boundaries where TF-IDF's exact-token match (no stemmer) sees no shared term and
 * misses. The M2.3 gate pins this with an inflection pair TF-IDF cannot catch. The brute-force cosine
 * is sub-millisecond for the fixture corpus and the same <5MB/≤6-deps gates as M2.1 hold (the
 * embedder is pure JS, no native deps, vectors live only in this transient index).
 */
import { CharNgramEmbedder } from '@knowledge-crib/core';
import type { Embedder, Vec } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';

/** Surface text embedded per symbol — same fields TF-IDF tokenized (name + qualifiedName + file
 *  basename), so the comparison is apples-to-apples on the recall-up gate. */
function symbolText(sym: Node): string {
  return `${sym.name ?? ''} ${sym.qualifiedName ?? ''} ${basenameNoExt(sym.file)}`;
}

function basenameNoExt(file: string | undefined): string {
  if (!file) return '';
  const base = file.split('/').pop() ?? file;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Embedding-cosine index over a set of symbol documents. Embeds each symbol once at construction,
 * then brute-force cosine against the query embedding. Deterministic (the char-n-gram embedder is a
 * pure function of its input); identical corpus + query → identical results across runs.
 */
export class EmbeddingLinkIndex {
  private readonly embedder: Embedder;
  private readonly ids: string[] = [];
  private readonly vecs: Vec[] = [];

  constructor(symbols: Iterable<Node>) {
    this.embedder = new CharNgramEmbedder();
    for (const sym of symbols) {
      const text = symbolText(sym);
      if (text.trim().length === 0) continue;
      const v = this.embedder.embed(text);
      // skip zero vectors (empty after padding) so they never score > 0
      if (norm(v) === 0) continue;
      this.ids.push(sym.id);
      this.vecs.push(v);
    }
  }

  /** Number of symbol documents indexed. */
  get size(): number {
    return this.ids.length;
  }

  /** Top symbols by cosine similarity to `queryText`, each ≥ `floor` (0..1). Deterministic order. */
  query(queryText: string, floor: number, k: number): Array<{ id: string; score: number }> {
    if (this.ids.length === 0 || queryText.trim().length === 0) return [];
    const q = this.embedder.embed(queryText);
    const qn = norm(q);
    if (qn === 0) return [];
    const scored: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < this.vecs.length; i++) {
      const v = this.vecs[i]!;
      const vn = norm(v);
      if (vn === 0) continue;
      const sim = dot(q, v) / (qn * vn);
      if (sim >= floor) scored.push({ id: this.ids[i]!, score: sim });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return scored.slice(0, k);
  }
}

function dot(a: Vec, b: Vec): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

function norm(v: Vec): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] ?? 0) * (v[i] ?? 0);
  return Math.sqrt(s);
}
