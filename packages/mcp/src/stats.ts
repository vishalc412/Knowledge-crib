/**
 * Server observability (M3.3) — runtime-only per-verb counts/latency + cache hit rate.
 *
 * DETERMINISM CONTRACT — read this before touching anything here. Crib's inviolable invariant is
 * that every committed soul + every deterministic verb output is byte-stable across runs. These
 * counters are the opposite of deterministic by design: they measure wall-clock latency
 * (`performance.now()`), live call counts, and a process's cache hit/miss tally. They are:
 *   - in-memory only — NEVER persisted to the soul, NEVER written to `.crib`, NEVER committed.
 *   - returned ONLY by the `stats` verb, whose contract is explicitly "live numbers".
 *   - side-effect only on every OTHER verb — the interceptor times the call and passes the result
 *     through verbatim, so `context`/`query`/`impact` outputs are byte-identical with or without it.
 *
 * So the non-determinism is quarantined to one verb whose job is to report it. The rest of the
 * surface stays deterministic. Stderr structured logs are opt-in via `KCRIB_LOG=1` (default off) so
 * a normal run / test suite emits nothing on stderr and no determinism test sees clock drift.
 */
import { performance } from 'node:perf_hooks';

/** Per-verb running aggregate. `totalMs/count` = mean latency; min/max bound the distribution. */
export interface VerbStat {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  /** Rejects/errors thrown by the verb (the interceptor re-throws after counting). */
  errors: number;
}

/** The live snapshot the `stats` verb returns. `verbs` is keyed by verb name. */
export interface StatsSnapshot {
  verbs: Record<string, VerbStat>;
  cache: { hits: number; misses: number; hitRate: number };
  /** Process uptime in ms (when the stats instance began counting — same as process start). */
  uptimeMs: number;
  /** Total calls across all verbs (convenience for dashboards). */
  totalCalls: number;
}

export class Stats {
  private perVerb = new Map<string, VerbStat>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly startMs = performance.now();

  /** Record a verb invocation outcome. `ms` is the wall-clock duration; `error` flags a throw. */
  record(verb: string, ms: number, error: boolean): void {
    const existing = this.perVerb.get(verb);
    const s: VerbStat = existing ?? {
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      errors: 0,
    };
    s.count += 1;
    s.totalMs += ms;
    if (ms < s.minMs) s.minMs = ms;
    if (ms > s.maxMs) s.maxMs = ms;
    if (error) s.errors += 1;
    if (!existing) this.perVerb.set(verb, s);
    if (process.env.KCRIB_LOG === '1') {
      // Structured stderr — opt-in. stdout is the MCP transport, so this MUST stay on stderr.
      // JSON line so a host log shipper can parse it without regex. `ts` is the only non-deterministic
      // field and it rides ONLY in this opt-in side-channel, never in a verb result or the soul.
      process.stderr.write(
        `${JSON.stringify({ ts: Date.now(), verb, ms: Math.round(ms * 1000) / 1000, error })}\n`,
      );
    }
  }

  /** Record an ifHash cache outcome. A "hit" = caller echoed the prior hash → `{unchanged:true}`. */
  recordCacheHit(hit: boolean): void {
    if (hit) this.cacheHits += 1;
    else this.cacheMisses += 1;
  }

  /** The live snapshot. `hitRate` is 0 (not NaN) when no cache calls have occurred. */
  snapshot(): StatsSnapshot {
    const verbs: Record<string, VerbStat> = {};
    let totalCalls = 0;
    for (const [name, s] of this.perVerb) {
      verbs[name] = { ...s, minMs: s.minMs === Number.POSITIVE_INFINITY ? 0 : s.minMs };
      totalCalls += s.count;
    }
    const cacheTotal = this.cacheHits + this.cacheMisses;
    return {
      verbs,
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: cacheTotal === 0 ? 0 : this.cacheHits / cacheTotal,
      },
      uptimeMs: performance.now() - this.startMs,
      totalCalls,
    };
  }
}

/**
 * Wrap a value that may be a Promise: time its resolution (or immediate rejection) and record.
 * Returns the same value/promise the wrapped fn produced — the interceptor is transparent to the
 * caller. Handles both sync verb methods (most crib verbs are pure reads) and async ones.
 */
export function trackCall<T>(stats: Stats, verb: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    const r = fn();
    if (r && typeof (r as unknown as PromiseLike<unknown>).then === 'function') {
      // Async path: record on settlement, preserve the resolution value / rejection.
      return (r as unknown as PromiseLike<unknown>).then(
        (v) => {
          stats.record(verb, performance.now() - t0, false);
          return v;
        },
        (e) => {
          stats.record(verb, performance.now() - t0, true);
          throw e;
        },
      ) as unknown as T;
    }
    stats.record(verb, performance.now() - t0, false);
    return r;
  } catch (e) {
    stats.record(verb, performance.now() - t0, true);
    throw e;
  }
}
