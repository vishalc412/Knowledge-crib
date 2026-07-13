/**
 * Token-budget defaults + a tiny truncation helper. Every list verb is bounded so an agent never
 * pulls an unbounded payload; results return `truncated` and a `cursor` to page.
 */
export const DEFAULT_LIMIT = 10;
export const DEFAULT_DOC_LIMIT = 3;

/**
 * Hard caps for MCP verb inputs. These are the upper bounds a client can never exceed, regardless of
 * what they pass — a rogue or buggy agent asking for limit=1_000_000 still gets MAX_LIMIT=200. They sit
 * on top of the soft defaults above: a missing arg resolves to its default, a present arg resolves to
 * min(arg, cap). Caps are defense-in-depth: the verbs clamp at consumption time (trust nothing) AND the
 * zod inputSchemas in server.ts reject wildly out-of-range values up front with a clean error.
 */
export const MAX_LIMIT = 200;
export const MAX_SCOPE_SYMBOLS = 500;
export const MAX_SOURCE_CHARS = 512 * 1024; // 512 KiB of rehydrated source
export const MAX_SOURCE_LINES = 10_000;
export const MAX_DOC_LIMIT = 100;
export const MAX_DEPTH = 32;
export const MAX_HOPS = 64;
// M3.2 — federation root cap. `federatedImpact` loads one SoulStore per extra repo root (each a
// file-read + sqlite-open + adjacency build), so an unbounded `roots` array is a load-amplification
// vector. A rogue/buggy agent passing 10k roots would OOM the server. 64 is far beyond any realistic
// cross-repo blast-radius query and matches the MAX_HOPS traversal ceiling.
export const MAX_FED_ROOTS = 64;

/**
 * Response-wide token budgets (M1.2). When a caller passes `maxTokens`, the verb guarantees its
 * serialized response fits the budget (chars/4 estimator): list verbs keep the largest leading
 * prefix of items that fits, `context withSource` shrinks the source body to the remaining budget.
 * The default is the soft ceiling applied when a caller opts in with no explicit value; the max is
 * the hard cap no caller can exceed. Both are defense-in-depth alongside the per-arg `MAX_*` caps.
 */
export const DEFAULT_MAX_TOKENS = 32_000;
export const MAX_MAX_TOKENS = 1_000_000;

export interface Bounded<T> {
  items: T[];
  truncated: boolean;
  cursor?: string;
}

/** Result of fitting an item list into a token budget ({@link fitTokenBudget}). */
export interface Fitted<T> {
  items: T[];
  /** true when items were dropped (or the first item alone overflowed) to fit the budget. */
  budgetExhausted: boolean;
  /** when budgetExhausted, the count of items kept as a string cursor — pass it back to resume. */
  cursor?: string;
}

/**
 * Rough token estimator: characters / 4. Used for cost previews and budget guards; never billed.
 * Falls back to 0 for undefined/null.
 */
export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

/** Take the first `limit` items, signalling truncation + a numeric cursor for the next page. */
export function bound<T>(all: T[], limit: number, offset = 0): Bounded<T> {
  const slice = all.slice(offset, offset + limit);
  const truncated = offset + limit < all.length;
  return truncated
    ? { items: slice, truncated, cursor: String(offset + limit) }
    : { items: slice, truncated };
}

/**
 * Resolve an optional count to its default when absent, then hard-cap it at `max`. Floors at 1 so a
 * zero/negative count can never produce an empty slice silently. Use this for count-style args
 * (limit, docLimit, depth, maxHops) where undefined means "use the default", not "unbounded".
 */
export function capInt(value: number | undefined, def: number, max: number): number {
  const v = value ?? def;
  if (v < 1) return 1;
  return v > max ? max : v;
}

/**
 * Clamp a present size/count arg to its hard cap and leave an absent arg absent. Use this for
 * pass-through args (sourceMaxChars, sourceMaxLines, maxSymbols) where undefined must stay undefined
 * so the downstream reader keeps its own default rather than inheriting ours.
 */
export function clampMax(value: number | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  return value > max ? max : value < 1 ? 1 : value;
}

/**
 * Resolve an optional `maxTokens` to its default when absent, then hard-cap it at
 * {@link MAX_MAX_TOKENS}. Floors at 1 so a zero/negative budget can never silently disable the guard.
 * Use this for the response-wide token budget on `query --with-source` / `dossier_by_scope` /
 * `context withSource` (M1.2).
 */
export function capMaxTokens(value: number | undefined): number {
  const v = value ?? DEFAULT_MAX_TOKENS;
  if (v < 1) return 1;
  return v > MAX_MAX_TOKENS ? MAX_MAX_TOKENS : v;
}

/**
 * Fit a list of items into a token budget by keeping the largest leading prefix whose serialized
 * form fits. The chars/4 estimator ({@link estimateTokens}) is applied response-wide via
 * `serialize`, which must return the candidate response string for a given prefix (the caller folds
 * in the non-item skeleton + the budgetExhausted/cursor signals so the estimate reflects the real
 * response size). `estimateTokens` is monotonic in the prefix length, so a binary search finds the
 * cut in O(log N) re-estimates. Deterministic: same items + budget → same cut.
 *
 * Returns the kept prefix, `budgetExhausted:true` when items were dropped (or the first item alone
 * overflowed — items:[] + cursor:'0' so the caller can still page past the oversized item), and a
 * `cursor` = the count kept as a string for the caller to pass back as the resume offset.
 */
export function fitTokenBudget<T>(
  items: T[],
  maxTokens: number,
  serialize: (prefix: T[]) => string,
): Fitted<T> {
  if (items.length === 0) return { items, budgetExhausted: false };
  let lo = 1;
  let hi = items.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estimateTokens(serialize(items.slice(0, mid))) <= maxTokens) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === items.length) return { items, budgetExhausted: false };
  // best < items.length: even the full page overflows. best===0 means ONE item already overflowed —
  // return none + exhausted + cursor '0' so the caller can resume past it (offset unchanged would
  // loop, so the verb layer advances the cursor by the page it attempted).
  return { items: items.slice(0, best), budgetExhausted: true, cursor: String(best) };
}
