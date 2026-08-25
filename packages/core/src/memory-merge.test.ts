import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type MemoryRecord,
  mergeMemoryChunk,
  parseMemoryChunk,
  serializeMemoryChunk,
} from './memory-merge.js';

/** Parse raw record objects into the chunk shape the merger expects. */
function chunk(records: Array<Record<string, unknown>>, source = 'x') {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  return parseMemoryChunk(text, source);
}

const empty = () => chunk([]);

describe('parseMemoryChunk', () => {
  it('parses valid records into an id map', () => {
    const { records, errors } = parseMemoryChunk(
      '{"id":"a","kind":"fact"}\n{"id":"b","kind":"pitfall"}\n',
      'src',
    );
    expect([...records.keys()].sort()).toEqual(['a', 'b']);
    expect(errors).toHaveLength(0);
  });

  it('ignores blank lines but FAILS malformed lines (records them as errors, never skips)', () => {
    const text = '{"id":"a","kind":"fact"}\n\nnot-json\n{"id":"b","kind":"pitfall"}\n';
    const { records, errors } = parseMemoryChunk(text, 'src');
    // the malformed line is NOT in the map (it cannot be), but it IS surfaced as an error so the
    // caller fails the merge — unlike the soul parseChunk which silently skips.
    expect([...records.keys()].sort()).toEqual(['a', 'b']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('src:3');
  });

  it('rejects objects with a missing or non-string id as errors', () => {
    const text = '{"kind":"fact"}\n{"id":5,"kind":"fact"}\n{"id":"","kind":"fact"}\n';
    const { errors } = parseMemoryChunk(text, 'src');
    expect(errors).toHaveLength(3);
  });
});

describe('serializeMemoryChunk', () => {
  it('emits id-sorted JSONL with a trailing newline; empty map → empty string', () => {
    expect(serializeMemoryChunk(new Map())).toBe('');
    const map = new Map<string, MemoryRecord>([
      ['mem:z', { id: 'mem:z', kind: 'fact' }],
      ['mem:a', { id: 'mem:a', kind: 'fact' }],
    ]);
    expect(serializeMemoryChunk(map)).toBe(
      '{"id":"mem:a","kind":"fact"}\n{"id":"mem:z","kind":"fact"}\n',
    );
  });
});

describe('mergeMemoryChunk — union semantics', () => {
  it('unions records present on either side (immutability: base always survives)', () => {
    const base = chunk([{ id: 'mem:base', kind: 'fact' }]);
    const ours = chunk([
      { id: 'mem:base', kind: 'fact' },
      { id: 'mem:ours', kind: 'fact' },
    ]);
    const theirs = chunk([
      { id: 'mem:base', kind: 'fact' },
      { id: 'mem:theirs', kind: 'fact' },
    ]);
    const { merged, conflicts, warnings } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(false);
    expect(warnings).toHaveLength(0);
    expect([...merged.keys()].sort()).toEqual(['mem:base', 'mem:ours', 'mem:theirs'].sort());
  });

  it('keeps a base record even when both sides dropped the line (immutable claims)', () => {
    const base = chunk([{ id: 'mem:keep', kind: 'fact' }]);
    const ours = empty();
    const theirs = empty();
    const { merged, conflicts } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(false);
    expect([...merged.keys()]).toEqual(['mem:keep']);
  });

  it('deduplicates identical records present on both sides', () => {
    const rec = { id: 'mem:same', kind: 'fact', claim: 'x' };
    const ours = chunk([rec]);
    const theirs = chunk([rec]);
    const { merged, conflicts } = mergeMemoryChunk(empty(), ours, theirs);
    expect(conflicts).toBe(false);
    expect([...merged.keys()]).toEqual(['mem:same']);
  });
});

describe('mergeMemoryChunk — hard conflicts', () => {
  it('same id with different content is a hard conflict (id excluded from merged, flagged)', () => {
    const base = chunk([{ id: 'mem:x', kind: 'fact', claim: 'base' }]);
    const ours = chunk([{ id: 'mem:x', kind: 'fact', claim: 'ours' }]);
    const theirs = chunk([{ id: 'mem:x', kind: 'fact', claim: 'theirs' }]);
    const { merged, conflicts, conflictIds } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(true);
    expect(conflictIds).toEqual(['mem:x']);
    expect(merged.has('mem:x')).toBe(false);
  });

  it('a malformed line in ANY input makes the whole merge fail', () => {
    const base = chunk([{ id: 'mem:x', kind: 'fact' }]);
    const ours = parseMemoryChunk('{"id":"mem:x","kind":"fact"}\nbroken\n', 'ours');
    const theirs = chunk([{ id: 'mem:x', kind: 'fact' }]);
    const { conflicts, errors } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(true);
    expect(errors.some((e) => e.includes('ours:2'))).toBe(true);
  });
});

describe('mergeMemoryChunk — logical conflicts', () => {
  it('concurrent supersede (ours) + retract (theirs) on the same subject: both survive + warning', () => {
    const base = chunk([{ id: 'mem:rec', kind: 'fact' }]);
    const ours = chunk([
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-o', kind: 'supersede', subject: 'mem:rec' },
    ]);
    const theirs = chunk([
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-t', kind: 'retract', subject: 'mem:rec' },
    ]);
    const { merged, conflicts, warnings } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(false); // logical, not hard — both events retained
    expect(warnings.some((w) => w.includes('logical conflict') && w.includes('mem:rec'))).toBe(
      true,
    );
    expect([...merged.keys()].sort()).toEqual(['mem:dec-o', 'mem:dec-t', 'mem:rec'].sort());
  });

  it('two supersedes of the same subject from different branches are a logical conflict', () => {
    const base = chunk([{ id: 'mem:rec', kind: 'fact' }]);
    const ours = chunk([
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-o', kind: 'supersede', subject: 'mem:rec', successor: 'mem:rec2' },
    ]);
    const theirs = chunk([
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-t', kind: 'supersede', subject: 'mem:rec', successor: 'mem:rec3' },
    ]);
    const { conflicts, warnings } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(false);
    expect(warnings.some((w) => w.includes('logical conflict'))).toBe(true);
  });

  it('the same decision event on both sides is NOT a logical conflict', () => {
    const base = empty();
    const dec = { id: 'mem:dec', kind: 'retract', subject: 'mem:rec' };
    const ours = chunk([dec]);
    const theirs = chunk([dec]);
    const { conflicts, warnings } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('a supersede present in base is not re-flagged when one side adds a retract', () => {
    // supersede already in base (ancestor); ours unchanged; theirs adds retract → not concurrent.
    const base = chunk([
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-base', kind: 'supersede', subject: 'mem:rec' },
    ]);
    const ours = chunk([
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-base', kind: 'supersede', subject: 'mem:rec' },
    ]);
    const theirs = chunk([
      { id: 'mem:rec', kind: 'fact' },
      { id: 'mem:dec-base', kind: 'supersede', subject: 'mem:rec' },
      { id: 'mem:dec-t', kind: 'retract', subject: 'mem:rec' },
    ]);
    const { conflicts, warnings } = mergeMemoryChunk(base, ours, theirs);
    expect(conflicts).toBe(false);
    // the retract is theirs-only, but the supersede is in base (not ours-new) → not concurrent.
    expect(warnings).toHaveLength(0);
  });
});

describe('mergeMemoryChunk — property tests', () => {
  // A set of independent immutable events (distinct ids, distinct content) merged in any 3-way
  // arrangement must always produce the exact same union — deterministic + associative.
  type Rec = { id: string; kind: 'fact'; n: number };
  const arbitraryChunk: fc.Arbitrary<Rec[]> = fc.uniqueArray(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }).map((s: string) => `mem:${s}`),
      kind: fc.constant('fact' as const),
      n: fc.integer({ min: 0, max: 999 }),
    }),
    { selector: (r: Rec) => r.id, minLength: 0, maxLength: 25 },
  );
  const ids = (rs: Rec[]): string[] => rs.map((r) => r.id);

  it('union is deterministic: same three inputs always merge to the same merged set', () => {
    fc.assert(
      fc.property(arbitraryChunk, arbitraryChunk, arbitraryChunk, (b, o, t) => {
        const r1 = mergeMemoryChunk(chunk(b), chunk(o), chunk(t));
        const r2 = mergeMemoryChunk(chunk(b), chunk(o), chunk(t));
        expect(r1.conflicts).toBe(r2.conflicts);
        expect([...r1.merged.keys()].sort()).toEqual([...r2.merged.keys()].sort());
        for (const id of r1.merged.keys()) {
          expect(JSON.stringify(r1.merged.get(id))).toBe(JSON.stringify(r2.merged.get(id)));
        }
      }),
    );
  });

  it('union is associative for independent events: (b∪o)∪t == b∪(o∪t) at the record-set level', () => {
    fc.assert(
      fc.property(arbitraryChunk, arbitraryChunk, arbitraryChunk, (b, o, t) => {
        // "independent" = all ids distinct across b,o,t → no content collisions possible.
        const allDistinct =
          new Set([...ids(b), ...ids(o), ...ids(t)]).size === b.length + o.length + t.length;
        fc.pre(allDistinct);

        const bo = [...mergeMemoryChunk(chunk(b), chunk(o), empty()).merged.values()] as Rec[];
        const ot = [...mergeMemoryChunk(chunk(o), chunk(t), empty()).merged.values()] as Rec[];
        const left = mergeMemoryChunk(chunk(bo), empty(), chunk(t)); // (b∪o)∪t
        const right = mergeMemoryChunk(chunk(b), empty(), chunk(ot)); // b∪(o∪t)
        expect([...left.merged.keys()].sort()).toEqual([...right.merged.keys()].sort());
      }),
    );
  });

  it('fails on id/content mismatch: two records sharing an id with different content always conflict', () => {
    fc.assert(
      fc.property(arbitraryChunk, arbitraryChunk, arbitraryChunk, (b, o, t) => {
        fc.pre(o.length > 0 && t.length > 0);
        const o0 = o[0];
        const t0 = t[0];
        fc.pre(o0 !== undefined && t0 !== undefined && t0.n !== o0.n);
        // force a collision: rewrite the first id of `t` to equal the first id of `o` but keep its
        // distinct content (different `n`).
        const tForced: Rec[] = t.map((r, i) => (i === 0 && o0 ? { ...r, id: o0.id } : r));
        const { conflicts, conflictIds } = mergeMemoryChunk(chunk(b), chunk(o), chunk(tForced));
        expect(conflicts).toBe(true);
        if (o0) expect(conflictIds).toContain(o0.id);
      }),
    );
  });

  it('a clean union (all-distinct ids, no malformed lines) never conflicts and equals base∪ours∪theirs', () => {
    fc.assert(
      fc.property(arbitraryChunk, arbitraryChunk, arbitraryChunk, (b, o, t) => {
        const allDistinct =
          new Set([...ids(b), ...ids(o), ...ids(t)]).size === b.length + o.length + t.length;
        fc.pre(allDistinct);
        const { merged, conflicts } = mergeMemoryChunk(chunk(b), chunk(o), chunk(t));
        expect(conflicts).toBe(false);
        const expected = new Set([...ids(b), ...ids(o), ...ids(t)]);
        expect(new Set(merged.keys())).toEqual(expected);
      }),
    );
  });
});
