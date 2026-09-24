import { describe, expect, it } from 'vitest';
import { compactSignature } from './verbs.js';

describe('compactSignature', () => {
  it('drops doc and line comments and joins the declaration onto one line', () => {
    const raw = `handoff(opts: {
      limits?: Limits;
      /** pass the current time to mark idle work stale. */
      now?: string; // optional
    } = {}): HandoffResponse`;
    expect(compactSignature(raw)).toBe(
      'handoff(opts: {limits?: Limits; now?: string;} = {}): HandoffResponse',
    );
  });

  it('leaves an already compact signature unchanged', () => {
    expect(compactSignature('login(email: string, pw: string): Session')).toBe(
      'login(email: string, pw: string): Session',
    );
  });

  it('caps pathological signatures', () => {
    expect(compactSignature(`f(${'a: number, '.repeat(100)})`).length).toBeLessThanOrEqual(240);
  });
});
