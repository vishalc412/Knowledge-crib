/**
 * Graph-aware rerank (M2.2) — a deterministic structural prior multiplied into the RRF score.
 *
 * The M2.1 hybrid path fuses BM25 ∪ char-n-gram vectors via reciprocal-rank fusion. RRF can reorder
 * a BM25-found relevant doc below rank 10 when the vector signal is noisy on a specific naming
 * convention (the java -10.5pp case in the M2.1 gate). This module multiplies each fused
 * candidate's RRF score by a structural prior composed of three deterministic, model-free signals:
 *
 *   prior = centrality(node) × stereotypeMatch(node, query) × kindPrior(node, intent(query))
 *
 *   • centrality      — 1 + 0.03·log₂(1 + degree). A more connected node is more likely the
 *                       canonical target; the log + 0.03 weight keep it a nudge, not an override.
 *   • stereotypeMatch — 1.2 when an action-verb stem in the query ("issue", "valid", "assess" …)
 *                       is a substring of the node's name/qualifiedName, else 1.0. This is the
 *                       direct fix for "which controller method issues a token" → the `issue`
 *                       method, which char-n-gram vector noise had buried.
 *   • kindPrior       — per-intent preference over NodeKind. "where" → symbol > route > file;
 *                       "how" → symbol > route; "what/which" → symbol/route/component > file. 1.0
 *                       when the intent is unknown so unfiltered queries are unaffected.
 *
 * Determinism: every signal is a pure function of (node, query) with no randomness, no clock, no
 * model. The same fused candidates + query yield byte-identical reranking across machines. The
 * prior is applied ONLY on the hybrid (semantic) path — pure BM25 (semantic:false) is returned
 * untouched, so the deterministic exact-match path and the mechanical eval pairs are unaffected.
 *
 * The prior is a multiplier in [≈0.85, ≈1.3]; it can reorder within an RRF tier but cannot invent
 * relevance — a candidate absent from both retrievers never enters the set. This bounds the
 * downside: the worst case is a nudge that misorders, never a fabricated hit.
 */
import type { NodeKind } from '@knowledge-crib/soul-schema';

/** A fused candidate carrying the metadata the prior needs (degree fetched from the edges table). */
export interface RerankCandidate {
  id: string;
  kind: NodeKind;
  name: string | null;
  file: string | null;
  /** RRF score from fusion (higher = better). */
  rrfScore: number;
  /** Total in+out edge count for this node (centrality signal). */
  degree: number;
}

/** The coarse query intent the kind prior keys on. */
export type QueryIntent = 'location' | 'behavior' | 'entity' | 'unknown';

/**
 * Action-verb stems long enough to be specific (≥4 chars where possible). A stem "matches" a node
 * when it is a substring of the node's lowercased name/qualifiedName, and "matches" a query when
 * some query token *contains* the stem. Bi-directional containment keeps false positives bounded:
 * the boost fires only when BOTH the query and the node surface the same action stem.
 *
 * Curated from the M1.1 conceptual packs (assess/validate/process/evaluate/decide/classify/auth/
 * grant/hash/verify/issue/approve/deny/review/make) plus common agent verbs (create/handle/route/
 * push). Extending this set is a deterministic, reviewable change — no model weights involved.
 */
const ACTION_STEMS = [
  'assess',
  'valid',
  'process',
  'evalu',
  'decid',
  'decise',
  'class',
  'classif',
  'auth',
  'grant',
  'hash',
  'verif',
  'verify',
  'issue',
  'login',
  'approve',
  'approv',
  'deny',
  'review',
  'make',
  'creat',
  'handle',
  'handl',
  'route',
  'push',
  'authoriz',
  'evaluate',
] as const;

/** Detect the query intent from leading question words. Deterministic, keyword-only. */
export function detectIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  // "where is/are … defined" — location queries want the symbol/route, not a file or doc.
  if (/\bwhere\b/.test(q)) return 'location';
  // "how does/do/is …" — behavior queries want the function/method.
  if (/\bhow\b/.test(q)) return 'behavior';
  // "what/which …" — entity queries want the symbol/route/component.
  if (/\b(what|which)\b/.test(q)) return 'entity';
  return 'unknown';
}

/** The set of action stems present in the query (stems that some query token contains). */
export function actionStemsInQuery(query: string): Set<string> {
  const q = query.toLowerCase();
  const stems = new Set<string>();
  for (const stem of ACTION_STEMS) {
    if (q.includes(stem)) stems.add(stem);
  }
  return stems;
}

/** Per-intent, per-NodeKind multiplier. 1.0 = neutral; the table only lists non-1.0 entries. */
const KIND_PRIOR: Record<QueryIntent, Partial<Record<NodeKind, number>>> = {
  location: { symbol: 1.1, route: 1.05, file: 0.9, 'doc-section': 0.85 },
  behavior: { symbol: 1.08, route: 1.04, file: 0.9, 'doc-section': 0.85 },
  entity: { symbol: 1.08, route: 1.08, component: 1.04, file: 0.92, 'doc-section': 0.88 },
  unknown: {},
};

/** 1 + 0.03·log₂(1 + degree): degree 0 → 1.0, 8 → 1.09, 64 → 1.18. A gentle centrality nudge. */
function centralityFactor(degree: number): number {
  return 1 + 0.03 * Math.log2(1 + Math.max(0, degree));
}

/** 1.2 when a query action stem is a substring of the node's name/qualifiedName, else 1.0. */
function stereotypeFactor(
  name: string | null,
  qualifiedName: string | null,
  stems: Set<string>,
): number {
  if (stems.size === 0) return 1;
  const surface = `${name ?? ''} ${qualifiedName ?? ''}`.toLowerCase();
  if (surface.length === 0) return 1;
  for (const stem of stems) {
    if (surface.includes(stem)) return 1.2;
  }
  return 1;
}

/** The kind prior for a (kind, intent) pair; 1.0 when the table has no entry. */
function kindFactor(kind: NodeKind, intent: QueryIntent): number {
  return KIND_PRIOR[intent]?.[kind] ?? 1;
}

/** Compute the full structural prior for one candidate. Exposed for tests. */
export function structuralPrior(c: RerankCandidate, query: string, intent?: QueryIntent): number {
  const intent_ = intent ?? detectIntent(query);
  const stems = actionStemsInQuery(query);
  return (
    centralityFactor(c.degree) * stereotypeFactor(c.name, null, stems) * kindFactor(c.kind, intent_)
  );
}

/**
 * Rerank fused candidates by RRF score × structural prior, returning the top `limit` after `offset`.
 * Pure + deterministic: identical candidates + query → identical output across calls.
 */
export function rerank(
  candidates: RerankCandidate[],
  query: string,
  limit: number,
  offset: number,
): Array<{ id: string; kind: NodeKind; score: number; name?: string; file?: string }> {
  const intent = detectIntent(query);
  const stems = actionStemsInQuery(query);
  const scored = candidates.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    file: c.file,
    score:
      c.rrfScore *
      stereotypeFactor(c.name, null, stems) *
      kindFactor(c.kind, intent) *
      centralityFactor(c.degree),
  }));
  // Stable sort by score desc, id asc as a deterministic tiebreak so equal scores don't depend on
  // input order (Map iteration is insertion order, which can vary with fusion edge cases).
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(offset, offset + limit).map((s) => {
    const out: { id: string; kind: NodeKind; score: number; name?: string; file?: string } = {
      id: s.id,
      kind: s.kind,
      score: Math.round(s.score * 1e5) / 1e5,
    };
    if (s.name != null) out.name = s.name;
    if (s.file != null) out.file = s.file;
    return out;
  });
}
