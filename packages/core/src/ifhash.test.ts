import { describe, expect, it } from 'vitest';
import { canonicalStringify, ifHash } from './ifhash.js';

/**
 * ifHash — stateless change-aware response fingerprint (M2.6).
 *
 * The contract the verbs rely on: two structurally-equal responses hash identically regardless of
 * key order, strings fingerprint to their raw bytes, and the result is a stable `blake3:<hex>` that
 * a client can echo back as `ifHash` to short-circuit an unchanged response.
 */
describe('ifHash — change-aware response fingerprint', () => {
  it('produces a blake3:-prefixed hex digest', () => {
    const h = ifHash({ a: 1 });
    expect(h).toMatch(/^blake3:[0-9a-f]{64}$/);
  });

  it('is order-independent: same data, different key order, same hash', () => {
    expect(ifHash({ a: 1, b: 2, c: 3 })).toBe(ifHash({ c: 3, b: 2, a: 1 }));
  });

  it('is recursive: nested key order does not change the fingerprint', () => {
    expect(ifHash({ outer: { x: 1, y: 2 } })).toBe(ifHash({ outer: { y: 2, x: 1 } }));
  });

  it('distinguishes different content', () => {
    expect(ifHash({ a: 1 })).not.toBe(ifHash({ a: 2 }));
    expect(ifHash({ a: 1 })).not.toBe(ifHash({ a: 1, b: 2 }));
  });

  it('fingerprints a plain string by its raw bytes (no JSON quoting)', () => {
    const s = '# heading\nbody';
    expect(ifHash(s)).toBe(ifHash(s));
    expect(canonicalStringify(s)).toBe(s);
    expect(ifHash(s)).not.toBe(ifHash('# heading\nbodyX'));
  });

  it('is deterministic across calls (no time/randomness)', () => {
    expect(ifHash({ deep: { nested: [1, 2, { z: 9 }] } })).toBe(
      ifHash({ deep: { nested: [1, 2, { z: 9 }] } }),
    );
  });

  it('treats arrays positionally (order matters) and recurses into elements', () => {
    expect(ifHash([1, 2, 3])).not.toBe(ifHash([3, 2, 1]));
    expect(ifHash([{ b: 2, a: 1 }])).toBe(ifHash([{ a: 1, b: 2 }]));
  });
});
