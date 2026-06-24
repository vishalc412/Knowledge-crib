import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import { mergeThreeWay, parseChunk, serializeChunk } from './merge.js';
import type { ChunkRecord } from './merge.js';

/** Build a chunk map from raw record objects (no schema validation — these tests are pure). */
function chunk(records: Array<Record<string, unknown>>): Map<string, ChunkRecord> {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  return parseChunk(text);
}

/** Narrow the merged union back to its concrete member for field assertions. */
function asEdge(r: ChunkRecord | undefined): Edge {
  return r as unknown as Edge;
}
function asNode(r: ChunkRecord | undefined): Node {
  return r as unknown as Node;
}

/** A calls edge shaped to satisfy `isEdge` (carries `rel` + `src`) and `resolveEdgeConflict`. */
function edge(
  id: string,
  provenance: 'EXTRACTED' | 'INFERRED',
  confidence: number,
  method = 'static',
) {
  return {
    id,
    src: 'sym:src/b.ts#main@L2',
    dst: 'sym:src/a.ts#greet@L1',
    rel: 'calls',
    method,
    provenance,
    confidence,
  };
}

describe('parseChunk / serializeChunk', () => {
  it('round-trips id-sorted, dropping blank and malformed lines', () => {
    const recs = [
      { id: 'sym:z.ts#b@L1', kind: 'symbol' },
      { id: 'sym:a.ts#a@L1', kind: 'symbol' },
      { id: 'file:a.ts', kind: 'file' },
    ];
    const map = chunk(recs);
    expect([...map.keys()].sort()).toEqual(['file:a.ts', 'sym:a.ts#a@L1', 'sym:z.ts#b@L1']);
    const text = serializeChunk(map);
    // re-parse and confirm byte-stable order (ids ascending)
    const ids = [...parseChunk(text).keys()];
    expect(ids).toEqual([...map.keys()].sort());
  });

  it('serializeChunk emits empty string for an empty chunk', () => {
    expect(serializeChunk(new Map())).toBe('');
  });

  it('parseChunk tolerates blank/malformed lines', () => {
    const text = '{"id":"a","kind":"symbol"}\n\nnot-json\n{"id":"b","kind":"symbol"}\n';
    expect([...parseChunk(text).keys()].sort()).toEqual(['a', 'b']);
  });
});

describe('mergeThreeWay', () => {
  it('keeps a one-sided addition', () => {
    const ours = chunk([{ id: 'file:a.ts', kind: 'file' }]);
    const { merged, warnings } = mergeThreeWay(new Map(), ours, new Map());
    expect([...merged.keys()]).toEqual(['file:a.ts']);
    expect(warnings).toHaveLength(0);
  });

  it('keeps identical additions from both sides without warning', () => {
    const rec = { id: 'file:a.ts', kind: 'file' };
    const ours = chunk([rec]);
    const theirs = chunk([rec]);
    const { merged, warnings } = mergeThreeWay(new Map(), ours, theirs);
    expect([...merged.keys()]).toEqual(['file:a.ts']);
    expect(warnings).toHaveLength(0);
  });

  it('resolves an edge conflict deterministically (EXTRACTED beats INFERRED)', () => {
    const base = chunk([edge('e:1', 'EXTRACTED', 0.5)]);
    const ours = chunk([edge('e:1', 'INFERRED', 0.5)]); // changed to INFERRED
    const theirs = chunk([edge('e:1', 'EXTRACTED', 0.9)]); // changed confidence
    const { merged, warnings } = mergeThreeWay(base, ours, theirs);
    const winner = asEdge(merged.get('e:1'));
    expect(winner.provenance).toBe('EXTRACTED');
    expect(winner.confidence).toBe(0.9);
    expect(warnings).toHaveLength(0); // edges never warn
  });

  it('takes "ours" + warns on a conflicting node-level addition', () => {
    const ours = chunk([{ id: 'sym:a.ts#a@L1', kind: 'symbol', hash: 'aaaa' }]);
    const theirs = chunk([{ id: 'sym:a.ts#a@L1', kind: 'symbol', hash: 'bbbb' }]);
    const { merged, warnings } = mergeThreeWay(new Map(), ours, theirs);
    expect(asNode(merged.get('sym:a.ts#a@L1')).hash).toBe('aaaa');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('review');
  });

  it('keeps a one-sided modification (other side unchanged from base)', () => {
    const base = chunk([{ id: 'file:a.ts', kind: 'file', hash: 'aaa' }]);
    const ours = chunk([{ id: 'file:a.ts', kind: 'file', hash: 'bbb' }]); // changed
    const theirs = chunk([{ id: 'file:a.ts', kind: 'file', hash: 'aaa' }]); // unchanged
    const { merged, warnings } = mergeThreeWay(base, ours, theirs);
    expect(asNode(merged.get('file:a.ts')).hash).toBe('bbb');
    expect(warnings).toHaveLength(0);
  });

  it('respects a one-sided deletion', () => {
    const base = chunk([
      { id: 'file:a.ts', kind: 'file' },
      { id: 'file:b.ts', kind: 'file' },
    ]);
    const ours = chunk([{ id: 'file:a.ts', kind: 'file' }]); // dropped b
    const theirs = chunk([
      { id: 'file:a.ts', kind: 'file' },
      { id: 'file:b.ts', kind: 'file' },
    ]); // unchanged
    const { merged } = mergeThreeWay(base, ours, theirs);
    expect([...merged.keys()]).toEqual(['file:a.ts']);
  });
});
