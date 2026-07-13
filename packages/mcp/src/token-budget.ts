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

export interface Bounded<T> {
  items: T[];
  truncated: boolean;
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
