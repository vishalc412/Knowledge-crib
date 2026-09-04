/**
 * G3.2 — the VERSIONED memory ranking scorer: a scorer id traceable to configuration
 * (embedder id + scorer version + fusion strategy — red line #6) plus the fusion strategies that
 * id names, selected ONLY through the pre-registered held-out rule in
 * docs/bench/retrieval-pre-registration.md.
 *
 * WHY a version id on the scorer: a recall answer is only auditable if the ranking that produced it
 * names its configuration. `memory-rank-v2:char-ngram-3-6-512:bm25+cosine:rrf-k60` says exactly
 * which embedder, which lexical channel, and which fusion produced the order — so a ranking change
 * is a version change, never a silent drift.
 *
 * HOW fusion enters the projection WITHOUT touching recall.ts: `recallProjection`'s criterion-1
 * slot is the {@link LexicalScorer} port, so fusion lives BEHIND that port. The exact-match band is
 * preserved identically in every strategy (a subject/appliesTo exact match returns
 * `EXACT_MATCH_BONUS`+n before any fusion math) — criterion-1 exact dominance is an invariant, and
 * fusion only ever reorders BELOW that band. Source tier / evidence quality / feedback (criteria
 * 2–6) are untouched: fusion changes which records carry lexical relevance, not how criteria
 * compare.
 *
 * Strategies (pre-registered):
 *   - `lexical-only` — delegates 1:1 to `FtsLexicalScorer`; the incumbent default.
 *   - `rrf`          — reciprocal-rank fusion of the BM25 channel and the cosine channel, k = 60
 *                      (Cormack et al.'s standard; rank-based, so no score-scale calibration).
 *   - `weighted`     — `0.5 × max-normalized BM25 + 0.5 × max(0, cosine)` (alpha FROZEN at 0.5 by
 *                      the pre-registration — alpha is not tuned on the held-out set).
 *
 * The embedder is whatever tier resolution supplies: the char-ngram fallback tier, or the pinned
 * on-device model (`crib embed install`). The fused scorer NEVER fabricates an embedder: with no
 * embedder supplied, only `lexical-only` is constructible (rrf/weighted throw) — an honest
 * lexical-only result beats a pretend semantic one.
 */
import type { Embedder } from '@knowledge-crib/core';
import { cosine } from '@knowledge-crib/core';
import { FtsLexicalScorer, type MemoryFtsIndex, toFtsMatch } from './fts-index.js';
import { type LexicalScorer, exactLexicalScorer } from './recall.js';
import { type MemoryRecord, type MemoryRecordV2, isMemoryRecordV2 } from './types.js';

/** The scorer generation. Bump ONLY for a ranking-semantics change — the id is the audit trail. */
export const MEMORY_RANK_SCORER_VERSION = 'memory-rank-v2';

/**
 * The fusion strategies. `lexical-only` is the incumbent; the others are pre-registered candidates.
 *
 * `semantic-only` ranks on the cosine channel ALONE. It exists because the BM25 channel is not a
 * weak signal on a word-disjoint corpus — it is noise, and mixing it in displaces the right record:
 * measured on the launch corpus, moving from pure cosine to just a 10% BM25 weight cost 33 points of
 * paraphrase recall. Making it a first-class NAMED strategy (rather than `weighted` with alpha=0)
 * keeps it addressable by version id, so a deployment can state which ranker produced a result.
 *
 * The exact-match band still short-circuits before it, so exact recall is unaffected.
 */
export type FusionStrategy = 'lexical-only' | 'rrf' | 'weighted' | 'semantic-only';

/**
 * A second-stage reranker: scores (query, text) PAIRS jointly, rather than comparing two vectors
 * that were embedded independently.
 *
 * Why a second stage exists at all — measured, not assumed. On the launch corpus the bi-encoder
 * retrieves the correct record for EVERY word-disjoint query (zero misses at any depth), but only
 * ranks it top-5 for 43.8% of them; recall@25 is 74.5% and recall@50 ~87%. The information needed
 * to answer G2 is already in the candidate pool — what is missing is the precision to lift it into
 * the top five, and that is exactly the job a cross-encoder does and a bi-encoder structurally
 * cannot: a bi-encoder must commit to a query-independent document vector.
 *
 * The port is deliberately batch-shaped: a cross-encoder's cost is one model call per pair, so the
 * implementation must be free to run the whole candidate window at once.
 */
export interface Reranker {
  /** Stable id — flows into the scorer version id, so a ranking is traceable to its reranker. */
  readonly id: string;
  /** Score each `texts[i]` against `query`. Higher = more relevant. Same length as `texts`. */
  rerankBatch(query: string, texts: readonly string[]): number[];
}

/**
 * A persistent vector cache. Narrow on purpose: the scorer hands over every (id, text) it needs and
 * receives every vector back, so the implementation is free to batch its misses into ONE model call
 * — which is the whole economy, since a model's fixed cost dwarfs its per-item cost.
 */
export interface VectorCache {
  vectorsFor(
    targets: readonly { id: string; text: string }[],
    embedder: Embedder,
  ): Map<string, Float32Array>;
}

/** How deep the first stage is reranked. 50 is where the launch corpus's recall curve flattens. */
export const DEFAULT_RERANK_DEPTH = 50;

/** RRF constant k (pre-registered): score = Σ_channels 1/(k + rank). Standard k = 60. */
export const DEFAULT_RRF_K = 60;

/** Weighted-fusion alpha, FROZEN by the pre-registration (not tuned on the held-out set). */
export const DEFAULT_FUSION_ALPHA = 0.5;

/**
 * The versioned scorer id: `<scorerVersion>:<embedderId|none>:<lexical channel>:<fusion tag>`.
 * Examples:
 *   `memory-rank-v2:none:bm25:lexical-only`
 *   `memory-rank-v2:char-ngram-3-6-512:bm25+cosine:rrf-k60`
 *   `memory-rank-v2:char-ngram-3-6-512:bm25+cosine:weighted-a0.5`
 */
export function scorerVersionId(opts: {
  strategy: FusionStrategy;
  embedderId?: string;
  rrfK?: number;
  alpha?: number;
  rerankerId?: string;
  rerankDepth?: number;
}): string {
  const stage2 = opts.rerankerId
    ? `+rerank-${opts.rerankerId}-d${opts.rerankDepth ?? DEFAULT_RERANK_DEPTH}`
    : '';
  if (opts.strategy === 'lexical-only')
    return `${MEMORY_RANK_SCORER_VERSION}:none:bm25:lexical-only${stage2}`;
  if (!opts.embedderId) {
    throw new Error(
      `fusion strategy "${opts.strategy}" requires an embedder — lexical-only is the no-embedder default`,
    );
  }
  if (opts.strategy === 'semantic-only') {
    // the lexical channel is not consulted at all — the id says so rather than implying a mix
    return `${MEMORY_RANK_SCORER_VERSION}:${opts.embedderId}:cosine:semantic-only${stage2}`;
  }
  const k = opts.rrfK ?? DEFAULT_RRF_K;
  const alpha = (opts.alpha ?? DEFAULT_FUSION_ALPHA).toString();
  const tag = opts.strategy === 'rrf' ? `rrf-k${k}` : `weighted-a${alpha}`;
  return `${MEMORY_RANK_SCORER_VERSION}:${opts.embedderId}:bm25+cosine:${tag}${stage2}`;
}

/**
 * The text the cosine channel embeds for a record: subject + claim + appliesTo targets — the SAME
 * field set the FTS row composes (minus the evidence quotes, which describe where a claim was
 * verified rather than what it says). Deterministic over the record alone, so the vector table is
 * reproducible (mirrors the fts-index composition discipline).
 */
export function recordEmbedText(record: MemoryRecord | MemoryRecordV2): string {
  const appliesTo = isMemoryRecordV2(record) ? [] : record.appliesTo;
  return [record.subject, record.claim, ...appliesTo].join(' ');
}

/**
 * What the COSINE channel embeds: the claim, and only the claim.
 *
 * The default used to be {@link recordEmbedText} — subject + claim + appliesTo, mirroring the FTS
 * row. That is right for a LEXICAL channel, where the subject is how an exact or target match is
 * found. It is actively harmful for a semantic one: the subject is an identifier
 * (`decision:dec0`, `sym:src/x.ts#f@L1`), `appliesTo` usually repeats it, and a short claim ends up
 * surrounded by tokens that carry no meaning a paraphrase could ever match — diluting the vector.
 *
 * Measured both ways on two independent corpora, same embedder and strategy:
 *
 * | corpus | subject + claim + appliesTo | claim only |
 * | --- | --- | --- |
 * | launch gate (307 records) | 71.9% | **81.0%** |
 * | R2-HELDOUT (74 records) | 86.4% | **90.9%** |
 *
 * Exact recall stayed 100% in every arm — `score()` short-circuits the exact band before the cosine
 * channel is consulted, so the subject is not needed HERE to find a record by its id.
 */
/** Bump whenever {@link recordSemanticText} changes what it returns — it keys the vector cache. */
export const SEMANTIC_TEXT_VERSION = 'claim-v1';

export function recordSemanticText(record: MemoryRecord | MemoryRecordV2): string {
  return record.claim;
}

// ─── the versioned scorer ────────────────────────────────────────────────────

export interface VersionedScorerOptions {
  /** The FTS-backed lexical channel (the same index the projection already builds). */
  fts: MemoryFtsIndex;
  /** The candidate set the channels rank over — the same records the index was built from. */
  records: ReadonlyArray<MemoryRecord | MemoryRecordV2>;
  /** REQUIRED for rrf/weighted; rejected (with `lexical-only`) for a no-embedder deployment. */
  embedder?: Embedder;
  strategy?: FusionStrategy;
  rrfK?: number;
  alpha?: number;
  /**
   * What the COSINE channel embeds for a record. Defaults to {@link recordSemanticText}.
   *
   * Override to embed something else — e.g. {@link recordEmbedText}, the FTS-mirroring composition
   * that was the default until it was measured against claim-only on two independent corpora.
   */
  embedTextOf?: (record: MemoryRecord | MemoryRecordV2) => string;
  /**
   * Persistent vector cache. Absent ⇒ vectors are embedded per scorer lifetime, which is what the
   * char-ngram fallback can afford and a real model cannot (a 307-record ledger measured 4.9 s).
   */
  vectors?: VectorCache;
  /** Optional second stage. Absent ⇒ single-stage ranking, unchanged. */
  reranker?: Reranker;
  /** Candidate window handed to {@link reranker}. Ignored without one. */
  rerankDepth?: number;
}

/**
 * The criterion-1 scorer behind the version id. One fused ranking per distinct query string,
 * memoized (the same one-FTS-scan-per-projection economy `FtsLexicalScorer` uses); the cosine
 * channel's per-record vectors are embedded lazily once per scorer lifetime, so a `lexical-only`
 * deployment never pays any embedding cost.
 */
export class VersionedLexicalScorer implements LexicalScorer {
  readonly versionId: string;
  readonly strategy: FusionStrategy;

  private readonly fts: MemoryFtsIndex;
  private readonly records: ReadonlyArray<MemoryRecord | MemoryRecordV2>;
  private readonly embedder?: Embedder;
  private readonly rrfK: number;
  private readonly alpha: number;
  private readonly embedTextOf: (r: MemoryRecord | MemoryRecordV2) => string;
  private readonly vectors?: VectorCache;
  private readonly reranker?: Reranker;
  private readonly rerankDepth: number;
  /** Per-query fused score map (memoized — one fused ranking per distinct query). */
  private readonly cache = new Map<string, Map<string, number>>();
  /** The incumbent scorer, constructed lazily so `lexical-only` pays no fusion setup. */
  private incumbent: FtsLexicalScorer | undefined;
  /** Per-record cosine-channel vectors, computed lazily on the first fused query. */
  private recordVecs: Map<string, Float32Array> | undefined;

  constructor(opts: VersionedScorerOptions) {
    this.strategy = opts.strategy ?? 'lexical-only';
    this.fts = opts.fts;
    this.records = opts.records;
    this.embedder = opts.embedder;
    this.rrfK = opts.rrfK ?? DEFAULT_RRF_K;
    this.alpha = opts.alpha ?? DEFAULT_FUSION_ALPHA;
    this.embedTextOf = opts.embedTextOf ?? recordSemanticText;
    this.vectors = opts.vectors;
    this.reranker = opts.reranker;
    this.rerankDepth = opts.rerankDepth ?? DEFAULT_RERANK_DEPTH;
    // Fail closed: fusion without an embedder would silently LOOK semantic while ranking lexically.
    if (this.strategy !== 'lexical-only' && !this.embedder) {
      throw new Error(
        `fusion strategy "${this.strategy}" requires an embedder — construct with strategy 'lexical-only' when no model tier is available`,
      );
    }
    this.versionId = scorerVersionId({
      strategy: this.strategy,
      embedderId: this.embedder?.id,
      rrfK: this.rrfK,
      alpha: this.alpha,
      ...(this.reranker ? { rerankerId: this.reranker.id, rerankDepth: this.rerankDepth } : {}),
    });
  }

  score(record: MemoryRecord, query: string, targetIds: readonly string[]): number {
    // The exact-match band short-circuits BEFORE fusion in every strategy — criterion-1 exact
    // dominance is invariant (the pre-registration's regression guard depends on this).
    const exact = exactLexicalScorer(record, query, targetIds);
    if (exact > 0) return exact;
    if (this.strategy === 'lexical-only') {
      // Delegation, not reimplementation: lexical-only must be score-identical to the incumbent.
      this.incumbent ??= new FtsLexicalScorer(this.fts);
      return this.incumbent.score(record, query, targetIds);
    }
    if (query.length === 0) return 0;
    let byId = this.cache.get(query);
    if (!byId) {
      byId = this.fuse(query);
      this.cache.set(query, byId);
    }
    return byId.get(record.id) ?? 0;
  }

  /** Drop memoized fused rankings (e.g. after the underlying index is rebuilt). */
  reset(): void {
    this.cache.clear();
  }

  /**
   * The fused ranking for one query: BM25 channel + cosine channel over the candidate set, combined
   * per the strategy. Records absent from both channels score 0 (they fall through to criteria 2–6
   * exactly as a no-lexical-signal record does today).
   */
  private fuse(query: string): Map<string, number> {
    const embedder = this.embedder;
    if (!embedder) return new Map(); // unreachable (constructor enforces) — keeps narrowing honest
    // `semantic-only` never consults the lexical channel — skipping the scan is both the point and
    // a saving, not an optimisation detail.
    const semanticOnly = this.strategy === 'semantic-only';
    const match = semanticOnly ? undefined : toFtsMatch(query);
    // One FTS scan per distinct query, here — the fusion owns the memoization for its two channels.
    const bm25 = match ? this.fts.search(query) : new Map<string, number>();
    const qv = embedder.embed(query);
    const cosById = new Map<string, number>();
    for (const [id, rv] of this.recordVecsFor(embedder)) {
      const c = cosine(qv, rv);
      if (c > 0) cosById.set(id, c);
    }
    const stage1 = semanticOnly
      ? cosById
      : this.strategy === 'rrf'
        ? fuseRrf(bm25, cosById, this.rrfK)
        : fuseWeighted(bm25, cosById, this.alpha);
    return this.reranker ? this.applyRerank(query, stage1) : stage1;
  }

  /**
   * Second stage: rerank the top {@link rerankDepth} of `stage1` and lift that window above the
   * tail.
   *
   * The reranked window is mapped into a score band strictly ABOVE every un-reranked candidate, so
   * the cross-encoder decides the order of what it saw and never has to out-number a first-stage
   * score it never examined. Candidates outside the window keep their stage-1 scores and their
   * relative order — a reranker with a short window must not silently discard the tail, because
   * `recallProjection` ranks over everything the scorer returns.
   *
   * Exactness is unaffected: `score()` short-circuits the exact band before `fuse()` is ever called.
   */
  private applyRerank(query: string, stage1: Map<string, number>): Map<string, number> {
    const ordered = [...stage1.entries()].sort((a, b) => b[1] - a[1]);
    const window = ordered.slice(0, this.rerankDepth);
    if (window.length === 0) return stage1;
    const byId = new Map(this.records.map((r) => [r.id, r]));
    const texts = window.map(([id]) => {
      const record = byId.get(id);
      return record ? this.embedTextOf(record) : '';
    });
    const scores = this.reranker?.rerankBatch(query, texts) ?? [];
    if (scores.length !== window.length) return stage1; // fail closed: a bad reranker changes nothing

    // the band floor: every un-reranked candidate stays strictly below the window
    const tailMax = ordered[this.rerankDepth]?.[1] ?? 0;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = max - min || 1;
    const out = new Map(stage1);
    for (let i = 0; i < window.length; i++) {
      const id = window[i]![0];
      // normalise into (tailMax, tailMax + 1] so the window dominates the tail deterministically
      out.set(id, tailMax + ((scores[i]! - min) / span) * 0.999 + 0.001);
    }
    return out;
  }

  /** Embed every candidate record once (lazy: a `lexical-only` lifetime never pays this). */
  private recordVecsFor(embedder: Embedder): Map<string, Float32Array> {
    if (this.recordVecs) return this.recordVecs;
    const targets = this.records.map((r) => ({ id: r.id, text: this.embedTextOf(r) }));
    if (this.vectors) {
      // one lookup + one batched embed of the misses, persisted for every later scorer
      this.recordVecs = this.vectors.vectorsFor(targets, embedder);
      return this.recordVecs;
    }
    // no cache wired: batch anyway, so a model still pays ONE call rather than N
    const vecs = embedder.embedBatch(targets.map((t) => t.text));
    this.recordVecs = new Map();
    for (let i = 0; i < targets.length; i++) {
      const v = vecs[i];
      if (v) this.recordVecs.set(targets[i]!.id, v);
    }
    return this.recordVecs;
  }
}

// ─── fusion math (pure, unit-tested directly on fixed fixtures) ──────────────

/**
 * Reciprocal-rank fusion (pre-registered, k = 60): each channel ranks its non-zero scores descending
 * (rank 1 = best); a record's fused score is Σ 1/(k + rank) over the channels where it appears.
 * Rank-based, so the O(1–10) BM25 scale and the [0,1] cosine scale never need calibrating.
 */
export function fuseRrf(
  bm25: ReadonlyMap<string, number>,
  cos: ReadonlyMap<string, number>,
  k: number = DEFAULT_RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();
  const addChannel = (scores: ReadonlyMap<string, number>): void => {
    const ranked = [...scores.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < ranked.length; i++) {
      const id = ranked[i]![0];
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + i + 1));
    }
  };
  addChannel(bm25);
  addChannel(cos);
  return fused;
}

/**
 * Weighted fusion (pre-registered, alpha frozen at 0.5): `alpha × (bm25 / max(bm25)) +
 * (1 − alpha) × max(0, cosine)`. Max-normalization keeps both channels on [0,1] without inventing a
 * scale; a query with no BM25 hits therefore contributes 0 lexically and lets cosine decide.
 */
export function fuseWeighted(
  bm25: ReadonlyMap<string, number>,
  cos: ReadonlyMap<string, number>,
  alpha: number = DEFAULT_FUSION_ALPHA,
): Map<string, number> {
  let bm25Max = 0;
  for (const s of bm25.values()) if (s > bm25Max) bm25Max = s;
  const fused = new Map<string, number>();
  const ids = new Set<string>([...bm25.keys(), ...cos.keys()]);
  for (const id of ids) {
    const b = bm25.get(id) ?? 0;
    const c = Math.max(0, cos.get(id) ?? 0);
    const bn = bm25Max > 0 ? b / bm25Max : 0;
    const score = alpha * bn + (1 - alpha) * c;
    if (score > 0) fused.set(id, score);
  }
  return fused;
}
