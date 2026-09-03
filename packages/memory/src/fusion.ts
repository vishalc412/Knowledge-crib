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

/** The fusion strategies. `lexical-only` is the incumbent; the others are pre-registered candidates. */
export type FusionStrategy = 'lexical-only' | 'rrf' | 'weighted';

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
}): string {
  if (opts.strategy === 'lexical-only')
    return `${MEMORY_RANK_SCORER_VERSION}:none:bm25:lexical-only`;
  if (!opts.embedderId) {
    throw new Error(
      `fusion strategy "${opts.strategy}" requires an embedder — lexical-only is the no-embedder default`,
    );
  }
  const k = opts.rrfK ?? DEFAULT_RRF_K;
  const alpha = (opts.alpha ?? DEFAULT_FUSION_ALPHA).toString();
  const tag = opts.strategy === 'rrf' ? `rrf-k${k}` : `weighted-a${alpha}`;
  return `${MEMORY_RANK_SCORER_VERSION}:${opts.embedderId}:bm25+cosine:${tag}`;
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
    const match = toFtsMatch(query);
    // One FTS scan per distinct query, here — the fusion owns the memoization for its two channels.
    const bm25 = match ? this.fts.search(query) : new Map<string, number>();
    const qv = embedder.embed(query);
    const cosById = new Map<string, number>();
    for (const [id, rv] of this.recordVecsFor(embedder)) {
      const c = cosine(qv, rv);
      if (c > 0) cosById.set(id, c);
    }
    return this.strategy === 'rrf'
      ? fuseRrf(bm25, cosById, this.rrfK)
      : fuseWeighted(bm25, cosById, this.alpha);
  }

  /** Embed every candidate record once (lazy: a `lexical-only` lifetime never pays this). */
  private recordVecsFor(embedder: Embedder): Map<string, Float32Array> {
    if (this.recordVecs) return this.recordVecs;
    this.recordVecs = new Map();
    for (const r of this.records) {
      this.recordVecs.set(r.id, embedder.embed(recordEmbedText(r)));
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
