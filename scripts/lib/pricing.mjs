/**
 * Shared token-cost model for the crib cost harness (`crib-bench.mjs`) and the cost budget gate
 * (`budget-check.mjs`). Kept in one place so the benchmark and the CI gate can never disagree about
 * what a task *costs* — only about the token counts they measure.
 *
 * WHY a cost model at all: raw token counts hide the product's real advantage. Anthropic bills four
 * buckets at wildly different rates, and crib's whole thesis is that it shifts work into the cheap
 * bucket. A benchmark that only reports tokens makes crib look *worse* (it injects more tokens); a
 * benchmark that reports *dollars over a multi-turn session* shows the truth (those tokens are cheap,
 * cache-stable reads). This module encodes that conversion transparently and overridably.
 *
 * The rates below are Sonnet-class list prices (USD per 1M tokens) as a documented default. They are
 * overridable via env so the number is never a black box:
 *   CRIB_PRICE_INPUT, CRIB_PRICE_OUTPUT, CRIB_PRICE_CACHE_WRITE, CRIB_PRICE_CACHE_READ
 */

/** USD per 1,000,000 tokens. Defaults are Sonnet-class list prices; override via env. */
export function rates(env = process.env) {
  const num = (key, fallback) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`${key} must be a non-negative number, got ${JSON.stringify(raw)}`);
    }
    return v;
  };
  return {
    input: num('CRIB_PRICE_INPUT', 3.0), // fresh input
    output: num('CRIB_PRICE_OUTPUT', 15.0), // generated output — 5x input
    cacheWrite: num('CRIB_PRICE_CACHE_WRITE', 3.75), // 1.25x input — the expensive priming bucket
    cacheRead: num('CRIB_PRICE_CACHE_READ', 0.3), // 0.1x input — the whole point of caching
  };
}

/** Dollar cost of `tokens` billed entirely in one bucket. */
export function bucketCost(tokens, rate) {
  return (tokens / 1_000_000) * rate;
}

/**
 * Model the dollar cost of using a retrieved context block across a multi-turn agent task.
 *
 * The realistic lifecycle of a piece of retrieved context in a live agent session:
 *   - turn 1: it is written into the prompt cache (cache-write, 1.25x)
 *   - turns 2..N: it is re-read from cache on every follow-up turn (cache-read, 0.1x)
 *   - each turn also emits some reasoning/output tokens
 *
 * This is the honest core of the "more tokens yet less money" phenomenon: a *bigger* but
 * *cache-stable* context is cheap to reuse, because reuse is priced at the 0.1x cache-read rate.
 * A context that is NOT cache-stable (churns every turn) never gets that discount — every turn pays
 * the 1.25x cache-write rate instead. Callers pass `stable: false` to model that penalty.
 *
 * @param {object} o
 * @param {number} o.contextTokens  size of the retrieved context block (per turn)
 * @param {number} o.turns          number of agent turns that reference this context (>= 1)
 * @param {number} [o.outputTokens] reasoning/output tokens per turn (default 0 — attribute output
 *                                   separately so the context-bucket comparison stays apples-to-apples)
 * @param {boolean} [o.stable]      true (default) if the context is byte-stable across turns and so
 *                                   stays cached; false models a churning context re-primed each turn
 * @param {ReturnType<typeof rates>} [r]
 */
export function sessionCost(
  { contextTokens, turns, outputTokens = 0, stable = true },
  r = rates(),
) {
  if (!(turns >= 1)) throw new Error(`turns must be >= 1, got ${turns}`);
  const reuseTurns = turns - 1;
  let contextCost;
  if (stable) {
    // primed once, re-read cheaply thereafter
    contextCost =
      bucketCost(contextTokens, r.cacheWrite) + reuseTurns * bucketCost(contextTokens, r.cacheRead);
  } else {
    // re-primed (cache-write) on every turn — no discount ever lands
    contextCost = turns * bucketCost(contextTokens, r.cacheWrite);
  }
  const outputCost = turns * bucketCost(outputTokens, r.output);
  return contextCost + outputCost;
}

/** Round a dollar figure to a stable, printable precision (6 dp — sub-cent, deterministic). */
export function usd(n) {
  return +n.toFixed(6);
}
