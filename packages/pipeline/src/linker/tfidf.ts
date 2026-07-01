/**
 * M7 semantic signal — a pure-JS TF-IDF vector index over symbol text, the offline "vector index" the
 * deterministic linker defers to. No network, no native deps: graceful-degrade is simply "no shared terms
 * ⇒ no candidates ⇒ no edges", so the deterministic core is never dependent on it and `--extracted-only`
 * stays a clean subset.
 *
 * Retrieval is postings-driven: a doc-section's query vector only scores symbols that share ≥1 term, so
 * cost is O(|query terms| × avg postings) rather than O(docs × symbols). Symbol "documents" are the
 * tokenized name + qualifiedName + file basename — enough to catch conceptual/case-variant mentions the
 * exact-match deterministic signals miss (e.g. prose "token" → `TokenService`), without pulling in full
 * source bodies (which would couple this pass to per-language extractors).
 */
import type { Node } from '@knowledge-crib/soul-schema';

/** English stoplist + tokens shorter than this are dropped (too noisy for short symbol names). */
const MIN_TERM_LEN = 3;
const STOPWORDS = new Set<string>([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'but',
  'not',
  'you',
  'all',
  'can',
  'her',
  'has',
  'had',
  'his',
  'how',
  'its',
  'may',
  'our',
  'out',
  'see',
  'use',
  'via',
  'way',
  'who',
  'your',
  'into',
  'each',
  'them',
  'then',
  'than',
  'have',
  'were',
  'they',
  'will',
  'would',
  'could',
  'should',
  'there',
  'their',
  'about',
  'which',
  'when',
  'what',
  'where',
  'while',
  'also',
  'must',
  'can',
  'per',
  'via',
  'etc',
]);

/**
 * Tokenize text into lowercase terms: splits camelCase / PascalCase / snake_case / kebab-case on
 * boundaries, drops stopwords and terms shorter than {@link MIN_TERM_LEN}. Deterministic (no locale
 * casing beyond toLowerCase; no stemming — a stemmer would be a later opt-in).
 */
export function tokenize(text: string): string[] {
  // split identifiers on case + non-alphanum boundaries, then lowercase
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const raw of parts) {
    const t = raw.toLowerCase();
    if (t.length < MIN_TERM_LEN) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

interface Posting {
  id: string;
  weight: number;
}

/**
 * TF-IDF index over a set of symbol "documents". Builds IDF + per-term postings once; {@link query}
 * returns the top symbols by cosine similarity to a query text, above a floor.
 */
export class TfidfIndex {
  private readonly postings = new Map<string, Posting[]>();
  private readonly norm = new Map<string, number>();
  private readonly n: number;

  constructor(symbols: Iterable<Node>) {
    const docs: Array<{ id: string; terms: Map<string, number> }> = [];
    for (const sym of symbols) {
      const text = `${sym.name ?? ''} ${sym.qualifiedName ?? ''} ${basenameNoExt(sym.file)}`;
      const terms = termCounts(tokenize(text));
      if (terms.size === 0) continue;
      docs.push({ id: sym.id, terms });
    }
    this.n = docs.length;

    // df per term
    const df = new Map<string, number>();
    for (const d of docs) for (const term of d.terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);

    // tf-idf weights + postings + per-doc L2 norm
    for (const d of docs) {
      let sumSq = 0;
      for (const [term, tf] of d.terms) {
        const idf = Math.log(1 + this.n / (1 + (df.get(term) ?? 0)));
        const w = tf * idf;
        if (w <= 0) continue;
        sumSq += w * w;
        const list = this.postings.get(term) ?? [];
        list.push({ id: d.id, weight: w });
        this.postings.set(term, list);
      }
      this.norm.set(d.id, Math.sqrt(sumSq));
    }
  }

  /** Number of symbol documents indexed. */
  get size(): number {
    return this.norm.size;
  }

  /** Top symbols by cosine similarity to `queryText`, each ≥ `floor` (0..1). Deterministic order. */
  query(queryText: string, floor: number, k: number): Array<{ id: string; score: number }> {
    const qTerms = termCounts(tokenize(queryText));
    if (qTerms.size === 0 || this.n === 0) return [];
    // query tf-idf (reuse the index's idf by recomputing from n — we don't store idf per term here, so
    // approximate idf as ln(1+n/(1+df)). We didn't keep df, but postings length == df. Recompute below.
    const dot = new Map<string, number>();
    let qSumSq = 0;
    for (const [term, tf] of qTerms) {
      const postings = this.postings.get(term);
      if (!postings) continue; // term unseen in corpus ⇒ idf would be 0 (ln(1+n/(1+n))=0); skip
      const df = postings.length;
      const idf = Math.log(1 + this.n / (1 + df));
      const qw = tf * idf;
      if (qw <= 0) continue;
      qSumSq += qw * qw;
      for (const p of postings) dot.set(p.id, (dot.get(p.id) ?? 0) + qw * p.weight);
    }
    if (qSumSq === 0) return [];
    const qNorm = Math.sqrt(qSumSq);
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, d] of dot) {
      const symNorm = this.norm.get(id) ?? 0;
      if (symNorm === 0) continue;
      const score = d / (qNorm * symNorm);
      if (score >= floor) scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return scored.slice(0, k);
  }
}

function termCounts(terms: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function basenameNoExt(file: string | undefined): string {
  if (!file) return '';
  const base = file.split('/').pop() ?? file;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
