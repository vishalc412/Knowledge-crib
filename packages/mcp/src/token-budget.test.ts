import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOC_LIMIT,
  DEFAULT_LIMIT,
  MAX_DEPTH,
  MAX_DOC_LIMIT,
  MAX_HOPS,
  MAX_LIMIT,
  MAX_SCOPE_SYMBOLS,
  MAX_SOURCE_CHARS,
  MAX_SOURCE_LINES,
  bound,
  capInt,
  clampMax,
  estimateTokens,
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
