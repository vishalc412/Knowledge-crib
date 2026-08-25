import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHITECTURAL_RELS,
  SoulStore,
  computeImportance,
  deriveNodeKind,
  isTestPath,
  kindBase,
  newManifest,
} from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node } from '@knowledge-crib/soul-schema';
import { afterEach, describe, expect, it } from 'vitest';

let dir: string | undefined;

function sym(path: string, qname: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: qname, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: qname.split('.').pop() ?? qname,
    qualifiedName: qname,
    file: path,
    span: { start: line, end: line },
    lang: 'typescript',
    hash: contentHash(`${path}:${qname}`),
    ...extra,
  };
}
function edge(src: string, dst: string, rel: Edge['rel']): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
  };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('importance (core port — value parity with viz.ts)', () => {
  it('gives a heavily-called symbol higher importance than an uncalled one', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-imp-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const hub = sym('src/hub.ts', 'Hub.run', 1);
    const caller1 = sym('src/a.ts', 'A.go', 1);
    const caller2 = sym('src/b.ts', 'B.go', 1);
    const lonely = sym('src/c.ts', 'C.go', 1);
    soul.putNodes([hub, caller1, caller2, lonely]);
    soul.putEdges([edge(caller1.id, hub.id, 'calls'), edge(caller2.id, hub.id, 'calls')]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const imp = computeImportance(soul);
    expect(imp.get(hub.id)?.degree).toBe(2);
    expect(imp.get(hub.id)?.importance).toBe(2); // kindBase(method)=0 + degree 2 × weight 1
    // lonely has 0 importance → absent from the lean map.
    expect(imp.has(lonely.id)).toBe(false);
  });

  it('weighs a noise kind down (×0.1) relative to an architectural kind at equal degree', () => {
    dir = mkdtempSync(join(tmpdir(), 'crib-imp-noise-'));
    const soul = new SoulStore(join(dir, '.crib'), {
      manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
    });
    soul.load();
    const fn = sym('src/x.ts', 'X.run', 1);
    const guard: Node = {
      id: 'cond:src/x.ts@L2',
      kind: 'condition',
      file: 'src/x.ts',
      span: { start: 2, end: 2 },
      hash: contentHash('cond'),
    };
    const caller = sym('src/y.ts', 'Y.go', 1);
    soul.putNodes([fn, guard, caller]);
    // one caller → each target gets degree 1; condition weights 0.1, function weights 1.
    soul.putEdges([edge(caller.id, fn.id, 'calls'), edge(caller.id, guard.id, 'calls')]);
    soul.commit('2026-01-01T00:00:00.000Z');

    const imp = computeImportance(soul);
    expect(imp.get(fn.id)?.importance).toBe(1);
    expect(imp.get(guard.id)?.importance).toBeCloseTo(0.1, 10);
    expect(imp.get(fn.id)!.importance).toBeGreaterThan(imp.get(guard.id)!.importance);
  });

  it('kindBase floors a file/class/interface/route/table above the noise floor', () => {
    expect(kindBase('file')).toBe(2);
    expect(kindBase('class')).toBe(3);
    expect(kindBase('interface')).toBe(3);
    expect(kindBase('route')).toBe(3);
    expect(kindBase('table')).toBe(3);
    expect(kindBase('method')).toBe(0);
  });

  it('deriveNodeKind resolves a raw symbol into its architectural subtype', () => {
    expect(deriveNodeKind({ kind: 'file' } as Node)).toBe('file');
    expect(deriveNodeKind({ kind: 'symbol', type: 'class' } as Node)).toBe('class');
    expect(deriveNodeKind({ kind: 'symbol', type: 'functionDeclaration' } as Node)).toBe(
      'function',
    );
    expect(deriveNodeKind({ kind: 'symbol', type: '' } as Node)).toBe('symbol');
  });

  it('ARCHITECTURAL_RELS excludes member-of and statement-level control-flow rels', () => {
    expect(ARCHITECTURAL_RELS.has('calls')).toBe(true);
    expect(ARCHITECTURAL_RELS.has('member-of')).toBe(false);
    expect(ARCHITECTURAL_RELS.has('executes')).toBe(false);
    expect(ARCHITECTURAL_RELS.has('reads')).toBe(false);
  });

  it('isTestPath detects test scaffolding', () => {
    expect(isTestPath('src/cli.test.ts')).toBe(true);
    expect(isTestPath('src/cli.spec.ts')).toBe(true);
    expect(isTestPath('src/__tests__/foo.ts')).toBe(true);
    expect(isTestPath('tests/foo.ts')).toBe(true);
    expect(isTestPath('test/foo.ts')).toBe(true);
    expect(isTestPath('src/cli.ts')).toBe(false);
    expect(isTestPath(undefined)).toBe(false);
  });
});

// Fixture directories hold sample INPUTS for tests, not shipped code. Before they were recognised,
// 289 symbols (7% of this repo's graph) ranked alongside production modules — surfacing in
// top-symbol lists and being offered for enrichment ahead of real code.
describe('isTestPath — fixture and golden-data directories', () => {
  it('treats fixture, __fixtures__ and testdata DIRECTORIES as test material', () => {
    for (const p of [
      'packages/parsers/fixtures/go/auth.go',
      'packages/parsers/fixture/x.ts',
      'a/__fixtures__/b.ts',
      'svc/testdata/sample.json',
      'testdata/root.go',
    ]) {
      expect(isTestPath(p)).toBe(true);
    }
  });

  it('still recognises the existing test conventions', () => {
    for (const p of ['a/b.test.ts', 'a/b.spec.ts', 'a/__tests__/c.ts', 'test/x.ts', 'tests/y.ts']) {
      expect(isTestPath(p)).toBe(true);
    }
  });

  it('does not catch ordinary source that merely mentions fixtures', () => {
    // Only directory segments match, so a module named for the concept is untouched.
    for (const p of [
      'src/fixtures.ts',
      'src/fixture-builder.ts',
      'src/testdata.ts',
      'src/latest.ts',
    ]) {
      expect(isTestPath(p)).toBe(false);
    }
  });
});
