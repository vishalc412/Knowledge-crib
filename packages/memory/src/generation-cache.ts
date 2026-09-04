/**
 * G3.3 — the generation-keyed evaluation cache.
 *
 * WHAT IS CACHED: per-record {@link RecordEvaluation}s (frozen), keyed by the record's own content
 * (`evaluationCacheKey` in evaluator.ts) UNDER a whole-cache dependency fingerprint. While every
 * dependency slot is unchanged, the last evaluation IS the evaluation — served without re-reading a
 * single evidence item (red line #1: never revalidate every record to answer one query).
 *
 * WHAT BUSTS IT: any dependency slot changing between binds clears ALL entries (wholesale
 * invalidation — the same posture as `SoulStore`'s kindIndex; per-slot tracking would trade a rare
 * over-invalidation for a silent stale verdict, which this engine never risks). An explicit
 * {@link GenerationCache.invalidate} clears too. And a pass whose dependency names
 * {@link UNVERSIONED} is NOT served a cache at all: a dependency that cannot be versioned cannot be
 * proven current, so the pass evaluates fresh — the pre-G3.3 behaviour, exactly.
 *
 * DEPENDENCY SLOTS (every input that could flip a verdict is one):
 *   code      — the soul node/code generation (`MemorySoulPort.generation()`; absent ⇒ UNVERSIONED)
 *   policy    — the trusted-base policy hash (`MemoryPolicyPort.policyHash()`; undefined ⇒ UNVERSIONED)
 *   receipts  — the receipt-store generation (`MemoryReceiptPort.generation()`; absent ⇒ UNVERSIONED)
 *   decisions — append-only decision set fingerprint (count + max content-addressed id)
 *   feedback  — append-only feedback set fingerprint (count + max content-addressed id)
 *   embedder/index — reserved ranking-side slots (default `none`; a scorer change busts via code)
 *
 * SCOPE: per-process, in memory. A durable (cross-process) cache is deliberately OUT of scope — a
 * durable verdict would need its own trust story, and this gate's law is only that a query never
 * pays full revalidation while its dependencies are unchanged within the serving process.
 *
 * WALL-CLOCK LAW: nothing here feeds an id, hash, or ifHash projection. `evaluatedAtMs` is stamped
 * ONLY as a display-only freshness age, attached to results NON-ENUMERABLY
 * ({@link attachVolatileFreshness}) so the ifHash canonical form (`Object.keys`-based) never sees
 * it — two identical searches stay byte-equal, and `scripts/ifhash-check.mjs` stays green.
 */
import type { EvaluationCachePort, RecordEvaluation } from './evaluator.js';

/** Marker for a dependency that cannot be versioned — caching is REFUSED, never risked. */
export const UNVERSIONED = 'unversioned';

/** The six dependency slots a record evaluation may read. All are inputs to the fingerprint. */
export interface DependencyGenerations {
  /** soul node/code generation (node bodies + manifest extracted/semantic counters). */
  code: string;
  /** trusted-base policy hash (drift detection for committed-policy evidence). */
  policy: string;
  /** receipt-store generation (execution-assertion / receipt-pair resolution). */
  receipts: string;
  /** the append-only decision set (lifecycle overlay + conflict resolution). */
  decisions: string;
  /** the append-only feedback set (criterion-6 ranking bound). */
  feedback: string;
  /** reserved: embedder generation (ranking-side; busts the cache when ranking inputs change). */
  embedder: string;
  /** reserved: index generation (FTS/lexical index state). */
  index: string;
}

/**
 * Defaults BEFORE a pass binds: every optional port reads `none` (absent ⇒ the evaluation cannot
 * depend on it, and a port APPEARING later changes the slot → busts), while `code` defaults
 * UNVERSIONED because a soul port without a generation signal is the common case (unit fakes) and
 * must refuse caching rather than risk a stale verdict.
 */
const DEFAULT_GENERATIONS: DependencyGenerations = {
  code: UNVERSIONED,
  policy: 'none',
  receipts: 'none',
  decisions: 'none',
  feedback: 'none',
  embedder: 'none',
  index: 'none',
};

/** The whole-cache fingerprint: every slot joined — ANY slot changing re-fingerprints the cache. */
export function fingerprintGenerations(g: DependencyGenerations): string {
  return [g.code, g.policy, g.receipts, g.decisions, g.feedback, g.embedder, g.index].join('|');
}

/**
 * Fingerprint for an append-only, content-addressed entry set (decisions / feedback). Count + the
 * lexicographically-max id: entries are only ever appended (history is a read projection — no op
 * rewrites a line), so (count, maxId) uniquely identifies the set prefix. NOT a hash of contents —
 * O(n) max, not O(n) hashing — and collision-free for append-only sets.
 */
export function entrySetFingerprint(entries: readonly { id: string }[]): string {
  if (entries.length === 0) return '0:';
  let max = entries[0]!.id;
  for (const e of entries) if (e.id > max) max = e.id;
  return `${entries.length}:${max}`;
}

/** Freshness age in ms, floored at 0 (a clock that runs backwards never shows negative age). */
export function freshnessAgeMs(evaluatedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - evaluatedAtMs);
}

/** Options for {@link GenerationCache}. */
export interface GenerationCacheOpts {
  /** the clock for `evaluatedAtMs` stamps + `ageMs` — DISPLAY ONLY, never a key or id. */
  nowMs?: () => number;
  /** entry bound; hitting it clears the cache (a clear is always safe — a miss re-evaluates). */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * The per-process generation-keyed cache. ONE instance per long-lived eval context (see
 * {@link evaluationCacheFor}); each recall/search call binds a port at the CURRENT dependency
 * fingerprint via {@link GenerationCache.bind}.
 */
export class GenerationCache {
  private fingerprint = fingerprintGenerations(DEFAULT_GENERATIONS);
  private evaluatedAtMs: number | null = null;
  private readonly entries = new Map<string, RecordEvaluation>();
  private readonly nowMs: () => number;
  private readonly maxEntries: number;

  constructor(opts: GenerationCacheOpts = {}) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * Bind a port for one pass at the supplied dependency generations (merged over the defaults).
   * Returns `undefined` — WITHOUT mutating any cached state — when any supplied slot is
   * {@link UNVERSIONED}: that dependency could drift undetected, so the pass must evaluate fresh.
   */
  bind(pass: Partial<DependencyGenerations>): EvaluationCachePort | undefined {
    const merged: DependencyGenerations = { ...DEFAULT_GENERATIONS, ...pass };
    for (const slot of Object.values(merged)) {
      if (slot === UNVERSIONED) return undefined;
    }
    const next = fingerprintGenerations(merged);
    if (next !== this.fingerprint) {
      // Wholesale invalidation: a changed dependency could flip ANY record's verdict, and per-slot
      // (or per-record) tracking would risk serving a stale verdict to save a re-evaluation.
      this.entries.clear();
      this.evaluatedAtMs = null;
      this.fingerprint = next;
    }
    return {
      generation: () => this.fingerprint,
      get: (key) => this.entries.get(key),
      set: (key, evaluation) => {
        if (this.entries.size >= this.maxEntries) {
          // Bounded: clear-all rather than LRU — simpler, and a clear only costs re-evaluation.
          this.entries.clear();
        }
        if (this.evaluatedAtMs === null) this.evaluatedAtMs = this.nowMs();
        this.entries.set(key, evaluation);
      },
    };
  }

  /** the dependency fingerprint the cache currently holds entries for. */
  get currentGeneration(): string {
    return this.fingerprint;
  }

  /** cached evaluation count (bounded by `maxEntries`). */
  get size(): number {
    return this.entries.size;
  }

  /** the wall-clock ms the current generation's first evaluation was stamped at (display only). */
  get evaluatedAt(): number | null {
    return this.evaluatedAtMs;
  }

  /** freshness age of the current generation's entries in ms, or null when nothing is cached. */
  ageMs(nowMs: number = this.nowMs()): number | null {
    return this.evaluatedAtMs === null ? null : freshnessAgeMs(this.evaluatedAtMs, nowMs);
  }

  /** Explicit invalidation (an out-of-band change the slots cannot see). */
  invalidate(): void {
    this.entries.clear();
    this.evaluatedAtMs = null;
  }
}

// ─── volatile (non-enumerable) freshness display fields ──────────────────────

/** The freshness snapshot attached to search results for DISPLAY (non-enumerably). */
export interface FreshnessSnapshot {
  /** the dependency-generation fingerprint the result's verdicts are proven current against. */
  generation: string | null;
  /** wall-clock ms the cached generation was first evaluated at (absent when nothing was cached). */
  evaluatedAtMs?: number;
}

/**
 * Attach the freshness snapshot to a result object as NON-ENUMERABLE properties. The ifHash
 * canonical form walks `Object.keys` (enumerable own properties only), so these fields are
 * structurally invisible to hashing: the response stays a pure function of its inputs and two
 * identical searches stay byte-equal, while a display layer that reads the fields explicitly
 * (`result.freshness.ageMs`) still gets the live age. THIS is how the wall-clock law is enforced
 * by shape — a wall-clock stamp could never survive in an enumerable field.
 */
export function attachVolatileFreshness(
  target: object,
  snapshot: FreshnessSnapshot,
  nowMs: number,
): void {
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(target, name, {
      value,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  };
  define('generation', snapshot.generation);
  if (snapshot.evaluatedAtMs !== undefined) {
    define('evaluatedAtMs', snapshot.evaluatedAtMs);
    define('ageMs', freshnessAgeMs(snapshot.evaluatedAtMs, nowMs));
  }
}

// ─── per-context cache identity ──────────────────────────────────────────────

/** One GenerationCache per eval-context object, for the life of the process. */
const caches = new WeakMap<object, GenerationCache>();

/**
 * The GenerationCache for an eval context — created on first use and REUSED for the life of the
 * context object. This is what makes the cache survive the MCP serving layer, which constructs a
 * fresh `MemoryApi` per verb call: the cache hangs off the LONG-LIVED eval context (via WeakMap),
 * not off the throwaway API. Callers that own their cache pass it explicitly as
 * `MemoryApiDeps.evaluationCache` instead.
 */
export function evaluationCacheFor(ctx: object, opts: GenerationCacheOpts = {}): GenerationCache {
  let cache = caches.get(ctx);
  if (!cache) {
    cache = new GenerationCache(opts);
    caches.set(ctx, cache);
  }
  return cache;
}
