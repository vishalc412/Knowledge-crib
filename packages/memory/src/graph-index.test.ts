import { describe, expect, it } from 'vitest';
import { graphCodeTargetResolver } from './graph-bridge.js';
import { MemoryGraphIndex } from './graph-index.js';
import { projectGraph } from './graph-projection.js';
import { createGraphAssertion } from './graph.js';
import type { MemoryProvenance } from './types.js';

const PRINCIPAL = 'principal:graph-index';
const PROVENANCE: MemoryProvenance = {
  principalId: PRINCIPAL,
  deviceId: 'device:graph-index-test',
  actorId: 'agent:graph-index-test',
  clientId: 'vitest',
};

function projection() {
  const first = createGraphAssertion({
    predicate: 'about',
    subject: 'mem:one',
    object: 'sym:src/service.ts#run',
    namespace: { principalId: PRINCIPAL },
    scope: { boundary: 'global' },
    validAt: '2026-01-01T00:00:00.000Z',
    knownAt: '2026-01-01T00:00:00.000Z',
    supportedBy: ['mem:one'],
    provenance: PROVENANCE,
  });
  const second = createGraphAssertion({
    predicate: 'part-of',
    subject: 'sym:src/service.ts#run',
    object: 'entity:service',
    namespace: { principalId: PRINCIPAL },
    scope: { boundary: 'global' },
    validAt: '2026-01-02T00:00:00.000Z',
    knownAt: '2026-01-02T00:00:00.000Z',
    supportedBy: ['mem:one'],
    provenance: PROVENANCE,
  });
  return projectGraph(
    { assertions: [first, second], records: [{ id: 'mem:one' }] },
    { principalId: PRINCIPAL, scope: { boundary: 'global' } },
  );
}

describe('WP-G2 graph SQLite index', () => {
  it('indexes one authorized projection with its source and code generation metadata', () => {
    const index = new MemoryGraphIndex(':memory:');
    try {
      const projected = projection();
      index.replace(projected, {
        sourcePosition: 'graph:42',
        codeRevision: 'abc123',
        generation: 7,
      });

      expect(index.status()).toEqual({
        sourcePosition: 'graph:42',
        codeRevision: 'abc123',
        generation: 7,
        assertionCount: 2,
      });
      expect(index.neighbors('sym:src/service.ts#run').map((edge) => edge.id)).toEqual(
        projected.current.map((edge) => edge.id).sort(),
      );
    } finally {
      index.close();
    }
  });

  it('replaces the derived projection atomically instead of retaining old assertions', () => {
    const index = new MemoryGraphIndex(':memory:');
    try {
      const projected = projection();
      index.replace(projected, { sourcePosition: 'graph:1', codeRevision: 'one', generation: 1 });
      const retained = projected.current.find((edge) => edge.object === 'sym:src/service.ts#run');
      if (!retained) throw new Error('projection fixture is missing the retained assertion');
      index.replace(
        { ...projected, current: [retained], timeline: [retained] },
        { sourcePosition: 'graph:2', codeRevision: 'two', generation: 2 },
      );

      expect(index.neighbors('entity:service')).toEqual([]);
      expect(index.status()).toMatchObject({ generation: 2, assertionCount: 1 });
    } finally {
      index.close();
    }
  });
});

describe('WP-G2 graph-to-code bridge', () => {
  it('resolves indexed symbol ids and file paths without inventing unknown targets', () => {
    const known = new Set(['sym:src/service.ts#run', 'file:src/service.ts']);
    const resolve = graphCodeTargetResolver((id) => known.has(id));

    expect(resolve('sym:src/service.ts#run')).toBe('sym:src/service.ts#run');
    expect(resolve('src/service.ts')).toBe('file:src/service.ts');
    expect(resolve('src/missing.ts')).toBeUndefined();
  });
});
