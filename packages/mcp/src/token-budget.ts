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

/** Take the first `limit` items, signalling truncation + a numeric cursor for the next page. */
export function bound<T>(all: T[], limit: number, offset = 0): Bounded<T> {
  const slice = all.slice(offset, offset + limit);
  const truncated = offset + limit < all.length;
  return truncated
    ? { items: slice, truncated, cursor: String(offset + limit) }
    : { items: slice, truncated };
}
