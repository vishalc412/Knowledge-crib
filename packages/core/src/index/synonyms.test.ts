import { describe, expect, it } from 'vitest';
import { expandToken } from './synonyms.js';

describe('expandToken (P2 lightweight hybrid retrieval)', () => {
  it('expands a word with a synonym group to the whole group, including itself', () => {
    const expanded = expandToken('save');
    expect(expanded).toContain('save');
    expect(expanded).toContain('persist');
    expect(expanded).toContain('write');
  });

  it('is case-insensitive', () => {
    expect(expandToken('SAVE')).toContain('persist');
    expect(expandToken('Save')).toContain('persist');
  });

  it('maps a word with no synonym group to itself only (no-op for arbitrary identifiers)', () => {
    expect(expandToken('SoulStore')).toEqual(['SoulStore']);
    expect(expandToken('xyzzy123')).toEqual(['xyzzy123']);
  });

  it('every word in a group expands to the same group (symmetric)', () => {
    const fromSave = new Set(expandToken('save'));
    const fromPersist = new Set(expandToken('persist'));
    expect(fromSave).toEqual(fromPersist);
  });
});
