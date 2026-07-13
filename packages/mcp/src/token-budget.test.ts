import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOC_LIMIT,
  DEFAULT_LIMIT,
  DEFAULT_MAX_TOKENS,
  MAX_DEPTH,
  MAX_DOC_LIMIT,
  MAX_HOPS,
  MAX_LIMIT,
  MAX_MAX_TOKENS,
  MAX_SCOPE_SYMBOLS,
  MAX_SOURCE_CHARS,
  MAX_SOURCE_LINES,
  bound,
  capInt,
  capMaxTokens,
  clampMax,
  estimateTokens,
  fitTokenBudget,
} from './token-budget.js';

describe('token-budget hard caps', () => {
  it('exposes the plan-mandated maximums', () => {
    expect(MAX_LIMIT).toBe(200);
    expect(MAX_SCOPE_SYMBOLS).toBe(500);
    expect(MAX_SOURCE_CHARS).toBe(512 * 1024);
    expect(MAX_SOURCE_LINES).toBe(10_000);
    expect(MAX_DOC_LIMIT).toBe(100);
    expect(MAX_DEPTH).toBe(32);
    expect(MAX_HOPS).toBe(64);
  });

  it('keeps the soft defaults strictly below the hard caps', () => {
    expect(DEFAULT_LIMIT).toBeLessThan(MAX_LIMIT);
    expect(DEFAULT_DOC_LIMIT).toBeLessThan(MAX_DOC_LIMIT);
  });
});

describe('capInt', () => {
  it('resolves a missing value to its default', () => {
    expect(capInt(undefined, DEFAULT_LIMIT, MAX_LIMIT)).toBe(DEFAULT_LIMIT);
    expect(capInt(undefined, 2, MAX_DEPTH)).toBe(2);
  });

  it('passes a sane value through unchanged', () => {
    expect(capInt(50, DEFAULT_LIMIT, MAX_LIMIT)).toBe(50);
    expect(capInt(5, 2, MAX_DEPTH)).toBe(5);
  });

  it('clamps an absurd value down to the hard cap', () => {
    expect(capInt(1_000_000, DEFAULT_LIMIT, MAX_LIMIT)).toBe(MAX_LIMIT);
    expect(capInt(1_000_000, 2, MAX_DEPTH)).toBe(MAX_DEPTH);
    expect(capInt(999_999, 6, MAX_HOPS)).toBe(MAX_HOPS);
    expect(capInt(9_999_999, 3, MAX_DOC_LIMIT)).toBe(MAX_DOC_LIMIT);
  });

  it('floors zero and negatives at 1 so a count can never silently empty a page', () => {
    expect(capInt(0, DEFAULT_LIMIT, MAX_LIMIT)).toBe(1);
    expect(capInt(-5, DEFAULT_LIMIT, MAX_LIMIT)).toBe(1);
    expect(capInt(0, 2, MAX_DEPTH)).toBe(1);
  });

  it('treats the cap itself as in-bounds (inclusive)', () => {
    expect(capInt(MAX_LIMIT, DEFAULT_LIMIT, MAX_LIMIT)).toBe(MAX_LIMIT);
  });
});

describe('clampMax', () => {
  it('leaves an absent value absent (downstream keeps its own default)', () => {
    expect(clampMax(undefined, MAX_SOURCE_CHARS)).toBeUndefined();
    expect(clampMax(undefined, MAX_SCOPE_SYMBOLS)).toBeUndefined();
  });

  it('passes a present value under the cap through unchanged', () => {
    expect(clampMax(1024, MAX_SOURCE_CHARS)).toBe(1024);
    expect(clampMax(40, MAX_SCOPE_SYMBOLS)).toBe(40);
  });

  it('clamps an absurd value down to the cap', () => {
    expect(clampMax(99_999_999, MAX_SOURCE_CHARS)).toBe(MAX_SOURCE_CHARS);
    expect(clampMax(99_999_999, MAX_SOURCE_LINES)).toBe(MAX_SOURCE_LINES);
    expect(clampMax(99_999, MAX_SCOPE_SYMBOLS)).toBe(MAX_SCOPE_SYMBOLS);
  });

  it('floors zero/negative at 1', () => {
    expect(clampMax(0, MAX_SOURCE_CHARS)).toBe(1);
    expect(clampMax(-3, MAX_SCOPE_SYMBOLS)).toBe(1);
  });
});

describe('bound (unchanged behavior)', () => {
  it('slices to limit and signals truncation + cursor', () => {
    const all = [1, 2, 3, 4, 5];
    const page = bound(all, 2);
    expect(page.items).toEqual([1, 2]);
    expect(page.truncated).toBe(true);
    expect(page.cursor).toBe('2');
  });

  it('reports no truncation when the whole set fits', () => {
    const page = bound([1, 2], 5);
    expect(page.items).toEqual([1, 2]);
    expect(page.truncated).toBe(false);
    expect(page.cursor).toBeUndefined();
  });
});

describe('estimateTokens (unchanged behavior)', () => {
  it('estimates chars / 4 and tolerates nullish input', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(null)).toBe(0);
  });
});

describe('capMaxTokens (M1.2 response-wide budget)', () => {
  it('resolves a missing value to the default', () => {
    expect(capMaxTokens(undefined)).toBe(DEFAULT_MAX_TOKENS);
  });

  it('passes a present value under the cap through unchanged', () => {
    expect(capMaxTokens(1000)).toBe(1000);
    expect(capMaxTokens(MAX_MAX_TOKENS)).toBe(MAX_MAX_TOKENS);
  });

  it('clamps an absurd value down to the hard cap', () => {
    expect(capMaxTokens(99_999_999)).toBe(MAX_MAX_TOKENS);
  });

  it('floors zero and negatives at 1 so the guard can never be silently disabled', () => {
    expect(capMaxTokens(0)).toBe(1);
    expect(capMaxTokens(-5)).toBe(1);
  });
});

describe('fitTokenBudget (M1.2 response-wide prefix fit)', () => {
  // serialize = the candidate response string for a given prefix. Each item is a short string so
  // token counts are small + predictable; the skeleton `{"hits":` overhead is counted too.
  const serialize = (prefix: string[]) => JSON.stringify({ hits: prefix });

  it('returns the whole list + no exhaustion when everything fits', () => {
    const items = ['a', 'b', 'c'];
    const fitted = fitTokenBudget(items, 1000, serialize);
    expect(fitted.items).toEqual(items);
    expect(fitted.budgetExhausted).toBe(false);
    expect(fitted.cursor).toBeUndefined();
  });

  it('keeps the largest leading prefix that fits + signals exhaustion + a count cursor', () => {
    // each item adds 4 chars ('"x",') = 1 token; the 6-item list + skeleton is 9 tokens, so a budget
    // of 6 forces a leading prefix to survive (3 items = 6 tokens; the 4th would push it to 7).
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    const budget = 6;
    const fitted = fitTokenBudget(items, budget, serialize);
    expect(fitted.budgetExhausted).toBe(true);
    expect(fitted.cursor).toBe(String(fitted.items.length));
    // the kept prefix must actually fit the budget.
    expect(estimateTokens(serialize(fitted.items))).toBeLessThanOrEqual(budget);
    // adding one more item would overflow (largest-prefix property).
    if (fitted.items.length < items.length) {
      expect(estimateTokens(serialize(items.slice(0, fitted.items.length + 1)))).toBeGreaterThan(
        budget,
      );
    }
  });

  it('returns an empty prefix + cursor 0 when a single item overflows', () => {
    const fitted = fitTokenBudget(['xxxxxxxxxxxxxxxxxxxxxxxx'], 1, serialize);
    expect(fitted.items).toEqual([]);
    expect(fitted.budgetExhausted).toBe(true);
    expect(fitted.cursor).toBe('0');
  });

  it('returns an empty list unexhausted when there are no items', () => {
    const fitted = fitTokenBudget([], 1000, serialize);
    expect(fitted.items).toEqual([]);
    expect(fitted.budgetExhausted).toBe(false);
    expect(fitted.cursor).toBeUndefined();
  });

  it('is deterministic — same inputs always yield the same cut', () => {
    const items = Array.from({ length: 20 }, (_, i) => `item${i}`);
    const a = fitTokenBudget(items, 30, serialize);
    const b = fitTokenBudget(items, 30, serialize);
    expect(a).toEqual(b);
  });
});
