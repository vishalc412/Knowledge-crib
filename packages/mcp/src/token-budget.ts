/**
 * Token-budget defaults + a tiny truncation helper. Every list verb is bounded so an agent never
 * pulls an unbounded payload; results return `truncated` and a `cursor` to page.
 */
export const DEFAULT_LIMIT = 10;
export const DEFAULT_DOC_LIMIT = 3;

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
