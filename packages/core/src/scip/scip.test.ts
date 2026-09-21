import type { Edge, Node } from '@knowledge-crib/soul-schema';
/**
 * SCIP interop tests (F7).
 *
 * The encoder is NOT used to build the decoder's fixtures where that would make the test circular.
 * {@link handEncodedIndex} assembles bytes from the wire format directly — tag bytes written out by
 * hand from the field numbers in `scip.proto` — so a decoder bug cannot be cancelled out by a
 * matching encoder bug. The round-trip tests, which legitimately exercise both halves, are separate
 * and clearly labelled.
 */
import { describe, expect, it } from 'vitest';
import { ROLE, looksLikeScip, rangeFromPacked, readDocuments, readMetadata } from './decode.js';
import { scipSymbolFor, soulToScip } from './from-soul.js';
import { formatScipSymbol, parseDescriptors, parseScipSymbol, qualifiedNameOf } from './symbol.js';
import { scipToSoul } from './to-soul.js';
import { WireError, Writer, readVarint } from './wire.js';

// ─── hand-assembled wire bytes ───────────────────────────────────────────────

/** A protobuf tag byte: field number and wire type, as the spec composes them. */
const tag = (no: number, wire: number) => no * 8 + wire;

/** A base-128 varint, written by hand — a payload over 127 bytes needs more than one length byte. */
function lenBytes(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

/** Length-delimited field, assembled by hand: tag, varint length, payload. */
function ld(no: number, payload: number[]): number[] {
  return [tag(no, 2), ...lenBytes(payload.length), ...payload];
}

const utf8 = (s: string) => [...new TextEncoder().encode(s)];

/** A string field. */
const str = (no: number, value: string) => ld(no, utf8(value));

/** A varint field (single-byte values only, which is all these fixtures need). */
const vi = (no: number, value: number) => [tag(no, 0), value];

/**
 * A minimal but REALISTIC index: one document, one class with one method, one reference from the
 * method to the class, encoded the way scip-typescript encodes it — including the deprecated packed
 * `range` (field 1) rather than the typed oneof, and a bare dotted path segment in the symbol.
 */
function handEncodedIndex(): Uint8Array {
  const SYM_CLASS = 'scip-typescript npm demo 1.0.0 src/app.ts/Service#';
  const SYM_METHOD = 'scip-typescript npm demo 1.0.0 src/app.ts/Service#run().';

  // Metadata { tool_info { name, version }, project_root, text_document_encoding = UTF8 }
  const metadata = [
    ...ld(2, [...str(1, 'scip-typescript'), ...str(2, '0.3.0')]),
    ...str(3, 'file:///repo'),
    ...vi(4, 1),
  ];

  // Occurrence { range = [line, startChar, endChar] (PACKED, field 1), symbol, roles }
  const defClass = [
    ...ld(1, [6, 13, 20]), // line 6, chars 13..20
    ...str(2, SYM_CLASS),
    ...vi(3, ROLE.DEFINITION),
    ...ld(7, [6, 0, 40, 1]), // enclosing_range: the class body, lines 6..40
  ];
  const defMethod = [
    ...ld(1, [9, 2, 5]),
    ...str(2, SYM_METHOD),
    ...vi(3, ROLE.DEFINITION),
    ...ld(7, [9, 2, 12, 3]), // the method body, lines 9..12
  ];
  // A reference to the class from INSIDE the method body (line 10) — must attribute to the method.
  const refClass = [...ld(1, [10, 8, 15]), ...str(2, SYM_CLASS)];
  // A reference to a symbol defined in another package — must be counted, not minted.
  const refExternal = [
    ...ld(1, [11, 4, 9]),
    ...str(2, 'scip-typescript npm lodash 4.17.0 `index.d.ts`/map().'),
  ];
  // A document-local symbol — skipped by design.
  const refLocal = [...ld(1, [11, 20, 24]), ...str(2, 'local 7')];

  const infoMethod = [
    ...str(1, SYM_METHOD),
    ...vi(5, 26), // Kind.Method
    ...str(6, 'run'),
    ...ld(4, [...str(1, SYM_CLASS), ...vi(3, 1)]), // Relationship { is_implementation }
    ...str(8, SYM_CLASS), // enclosing_symbol
  ];

  const document = [
    ...str(1, 'src/app.ts'),
    ...ld(2, defClass),
    ...ld(2, defMethod),
    ...ld(2, refClass),
    ...ld(2, refExternal),
    ...ld(2, refLocal),
    ...ld(3, infoMethod),
    ...str(4, 'TypeScript'),
  ];

  return new Uint8Array([...ld(1, metadata), ...ld(2, document)]);
}

// ─── wire codec ──────────────────────────────────────────────────────────────

describe('the protobuf wire codec', () => {
  it('round-trips varints past the 32-bit boundary', () => {
    // `<<` is 32-bit in JS; a shift-based reader silently wraps here. 2^35 needs 6 bytes.
    for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 2 ** 31, 2 ** 35, 2 ** 45]) {
      const bytes = new Writer().varint(value).finish();
      expect(readVarint(bytes, 0)[0], `varint ${value}`).toBe(value);
    }
  });

  it('refuses a truncated varint instead of reading past the buffer', () => {
    // 0x80 sets the continuation bit with nothing after it.
    expect(() => readVarint(new Uint8Array([0x80]), 0)).toThrow(WireError);
  });

  it('refuses to encode a negative int32 rather than writing a 10-byte surprise', () => {
    expect(() => new Writer().varint(-1)).toThrow(WireError);
  });

  it('skips a field it does not model, so a newer index still decodes', () => {
    // A future Index field 99 (length-delimited) followed by a real document.
    const future = ld(99, utf8('a field from a later SCIP version'));
    const buf = new Uint8Array([...future, ...ld(2, str(1, 'src/late.ts'))]);
    const docs = [...readDocuments(buf)];
    expect(docs.map((d) => d.relativePath)).toEqual(['src/late.ts']);
  });
});

describe('range decoding', () => {
  it('reads the 3-element packed form as a single line', () => {
    expect(rangeFromPacked([6, 13, 20])).toEqual({
      startLine: 6,
      startChar: 13,
      endLine: 6,
      endChar: 20,
    });
  });

  it('reads the 4-element packed form as a multi-line range', () => {
    expect(rangeFromPacked([6, 0, 40, 1])).toEqual({
      startLine: 6,
      startChar: 0,
      endLine: 40,
      endChar: 1,
    });
  });

  it('returns undefined for a malformed arity rather than guessing', () => {
    expect(rangeFromPacked([1, 2])).toBeUndefined();
    expect(rangeFromPacked([1, 2, 3, 4, 5])).toBeUndefined();
  });

  it('decodes the DEPRECATED packed range every deployed indexer still writes', () => {
    // The regression this pins: reading only the typed oneof (fields 8/9) yields no ranges at all
    // from real scip-typescript / scip-java / scip-go output, and therefore no importable symbols.
    const doc = [...readDocuments(handEncodedIndex())][0];
    expect(doc?.occurrences[0]?.range).toEqual({
      startLine: 6,
      startChar: 13,
      endLine: 6,
      endChar: 20,
    });
    expect(doc?.occurrences[0]?.enclosingRange?.endLine).toBe(40);
  });

  it('accepts the typed single-line oneof too', () => {
    // Occurrence { single_line_range = SingleLineRange { line, start_character, end_character } }
    const occ = ld(8, [...vi(1, 3), ...vi(2, 4), ...vi(3, 9)]);
    const buf = new Uint8Array([...ld(2, [...str(1, 'a.ts'), ...ld(2, occ)])]);
    expect([...readDocuments(buf)][0]?.occurrences[0]?.range).toEqual({
      startLine: 3,
      startChar: 4,
      endLine: 3,
      endChar: 9,
    });
  });
});

// ─── symbol grammar ──────────────────────────────────────────────────────────

describe('the SCIP symbol grammar', () => {
  it('parses a scip-typescript symbol with a bare dotted path segment', () => {
    // Every deployed indexer emits `src/app.ts/` unescaped although the grammar requires backticks.
    const s = parseScipSymbol('scip-typescript npm demo 1.0.0 src/app.ts/Service#run().');
    expect(s?.package).toEqual({ manager: 'npm', name: 'demo', version: '1.0.0' });
    expect(s?.descriptors.map((d) => `${d.suffix}:${d.name}`)).toEqual([
      'namespace:src',
      'namespace:app.ts',
      'type:Service',
      'method:run',
    ]);
  });

  it('names the entity, not its path — which is what keeps imported ids matching native ones', () => {
    const s = parseScipSymbol('semanticdb maven com.example.lib 1.2.3 com/example/Service#run().');
    expect(qualifiedNameOf(s as never)).toBe('Service.run');
  });

  it('treats a double space as an escaped space, not a field separator', () => {
    const s = parseScipSymbol('scip-java maven my  lib 1.0 Foo#');
    expect(s?.package.name).toBe('my lib');
    expect(s?.descriptors).toEqual([{ name: 'Foo', suffix: 'type' }]);
  });

  it('decodes a backtick-escaped identifier, doubled backticks included', () => {
    const s = parseScipSymbol('scip-x . pkg . `a b``c`#');
    expect(s?.descriptors[0]?.name).toBe('a b`c');
  });

  it('maps the `.` placeholder back to an empty package field', () => {
    const s = parseScipSymbol('scip-x . . . Foo#');
    expect(s?.package).toEqual({ manager: '', name: '', version: '' });
  });

  it('parses a local symbol', () => {
    const s = parseScipSymbol('local 7');
    expect(s?.local).toBe(true);
  });

  it('returns undefined on a malformed symbol instead of a partial parse', () => {
    // A partial parse yields a plausible wrong qualified name, which becomes a wrong node id.
    expect(parseScipSymbol('')).toBeUndefined();
    expect(parseScipSymbol('only-a-scheme')).toBeUndefined();
    expect(parseScipSymbol('scip-x . pkg . Foo')).toBeUndefined(); // no descriptor suffix
    expect(parseScipSymbol('scip-x . pkg . `unterminated#')).toBeUndefined();
  });

  /**
   * Descriptor runs taken VERBATIM from the SCIP project's own committed snapshot outputs
   * (sourcegraph/scip, `reprolang/testdata/snapshots/output/**`), not written for this test.
   *
   * They matter because every one of them carries a BARE DOTTED path segment — `animal.repro/` —
   * which the grammar says must be backtick-escaped. This is the evidence that the tolerance branch
   * in `readPathSegment` is required rather than defensive: parsed strictly, `animal.repro/animal#`
   * yields a term `animal` plus a namespace `repro`, and the qualified name comes out as
   * `animal.repro.animal` instead of `animal` — a wrong node id for every symbol in the index.
   */
  it.each([
    ['animal.repro/animal#', 'animal'],
    ['animal.repro/cat#', 'cat'],
    ['cycle1.repro/hello().', 'hello'],
    ['duplicate.repro/readFileSync.', 'readFileSync'],
    ['forward_def.repro/abc#', 'abc'],
  ])('parses %s from real indexer output as %s', (run, expected) => {
    const descriptors = parseDescriptors(run);
    expect(descriptors, run).toBeDefined();
    const name = qualifiedNameOf({
      scheme: 'x',
      package: { manager: '', name: '', version: '' },
      descriptors: descriptors as never,
      local: false,
    });
    expect(name).toBe(expected);
  });

  it('round-trips through format', () => {
    for (const input of [
      'scip-typescript npm demo 1.0.0 src/app.ts/Service#run().',
      'scip-java maven my  lib 1.0 Foo#bar().',
      'scip-x . . . `weird name`#field.',
      'scip-x . p . Foo#method(overload).',
      'local 7',
    ]) {
      const parsed = parseScipSymbol(input);
      expect(parsed, input).toBeDefined();
      expect(formatScipSymbol(parsed as never), input).toBe(input);
    }
  });
});

// ─── import ──────────────────────────────────────────────────────────────────

describe('importing a SCIP index', () => {
  const result = scipToSoul(handEncodedIndex());

  it('reads the indexer identity for provenance', () => {
    expect(result.tool).toEqual({ name: 'scip-typescript', version: '0.3.0' });
  });

  it('mints ids in crib grammar so an import merges with the native graph', () => {
    // SCIP line 6 (0-based) is crib line 7 (1-based).
    expect(result.nodes.map((n) => n.id)).toContain('sym:src/app.ts#Service@L7');
    expect(result.nodes.map((n) => n.id)).toContain('sym:src/app.ts#Service.run@L10');
    expect(result.nodes.map((n) => n.id)).toContain('file:src/app.ts');
  });

  it('carries the declaration extent from enclosing_range, not just the name line', () => {
    const service = result.nodes.find((n) => n.id === 'sym:src/app.ts#Service@L7');
    expect(service?.span).toEqual({ start: 7, end: 41 });
    expect(service?.lang).toBe('typescript');
    // No `Kind` was set on the class, so the type falls back to the descriptor suffix: `#` is a
    // type descriptor, which is a class.
    expect(service?.type).toBe('class');
  });

  it('prefers the indexer Kind over the descriptor suffix when it has one', () => {
    const run = result.nodes.find((n) => n.id === 'sym:src/app.ts#Service.run@L10');
    expect(run?.type).toBe('method'); // Kind.Method = 26
    expect(run?.name).toBe('run');
  });

  it('attributes a reference to the innermost enclosing definition', () => {
    // The reference to Service sits at line 10, inside run()'s body (SCIP lines 9..12) and inside
    // Service's body (6..40). The method is the innermost owner, so the edge starts there.
    const edge = result.edges.find(
      (e) => e.rel === 'references' && e.dst === 'sym:src/app.ts#Service@L7',
    );
    expect(edge?.src).toBe('sym:src/app.ts#Service.run@L10');
  });

  it('stamps the indexer, not this importer, as the evidence', () => {
    const edge = result.edges.find((e) => e.rel === 'references');
    expect(edge?.evidence?.by).toBe('scip:scip-typescript');
    expect(edge?.method).toBe('static');
    expect(edge?.provenance).toBe('EXTRACTED');
  });

  it('turns a declared is_implementation relationship into an implements edge', () => {
    expect(
      result.edges.some(
        (e) =>
          e.rel === 'implements' &&
          e.src === 'sym:src/app.ts#Service.run@L10' &&
          e.dst === 'sym:src/app.ts#Service@L7',
      ),
    ).toBe(true);
  });

  it('counts a cross-package reference rather than minting the dependency closure', () => {
    expect(result.counts.externalReferences).toBe(1);
    expect(result.nodes.some((n) => n.id.includes('lodash'))).toBe(false);
    expect(result.notes.join(' ')).toMatch(/defined OUTSIDE this index/);
  });

  it('skips document-local symbols', () => {
    expect(result.counts.locals).toBe(1);
  });

  it('never claims a reference is a call', () => {
    expect(result.edges.some((e) => e.rel === 'calls')).toBe(false);
    expect(result.notes.join(' ')).toMatch(/never `calls`/);
  });

  it('is deterministic: re-importing the same bytes yields the same ids and hashes', () => {
    const again = scipToSoul(handEncodedIndex());
    expect(again.nodes.map((n) => `${n.id}|${n.hash}`).sort()).toEqual(
      result.nodes.map((n) => `${n.id}|${n.hash}`).sort(),
    );
    expect(again.edges.map((e) => e.id).sort()).toEqual(result.edges.map((e) => e.id).sort());
  });

  it('applies a path prefix for a sub-project index', () => {
    const prefixed = scipToSoul(handEncodedIndex(), { pathPrefix: 'services/api' });
    expect(prefixed.nodes.map((n) => n.id)).toContain('sym:services/api/src/app.ts#Service@L7');
  });

  it('reports an index with no metadata instead of inventing a tool', () => {
    const noMeta = new Uint8Array([...ld(2, str(1, 'src/x.ts'))]);
    const r = scipToSoul(noMeta);
    expect(r.tool.name).toBe('unknown');
    expect(r.notes.join(' ')).toMatch(/no Metadata block/);
  });

  it('recognises a non-SCIP file up front', () => {
    expect(looksLikeScip(new Uint8Array(0))).toBe(false);
    expect(looksLikeScip(new TextEncoder().encode('#!/bin/sh\necho hi\n'))).toBe(false);
    expect(looksLikeScip(handEncodedIndex())).toBe(true);
  });
});

// ─── export ──────────────────────────────────────────────────────────────────

const node = (over: Partial<Node> & { id: string }): Node => ({
  kind: 'symbol',
  hash: 'blake3:0',
  ...over,
});

describe('exporting a SCIP index', () => {
  const nodes: Node[] = [
    node({
      id: 'sym:src/app.ts#Service@L7',
      file: 'src/app.ts',
      span: { start: 7, end: 41 },
      lang: 'typescript',
      type: 'class',
      name: 'Service',
      qualifiedName: 'Service',
    }),
    node({
      id: 'sym:src/app.ts#Service.run@L10',
      file: 'src/app.ts',
      span: { start: 10, end: 13 },
      lang: 'typescript',
      type: 'method',
      name: 'run',
      qualifiedName: 'Service.run',
      signature: 'run(): void',
    }),
    { id: 'doc:README.md#intro', kind: 'doc-section', hash: 'blake3:1' },
  ];
  const edges: Edge[] = [
    {
      id: 'e:1',
      src: 'sym:src/app.ts#Service.run@L10',
      dst: 'sym:src/app.ts#Service@L7',
      rel: 'implements',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
    },
  ];
  const exported = soulToScip(nodes, edges, { projectRoot: '/repo', toolVersion: '0.1.0' });

  it('produces bytes a SCIP decoder reads back', () => {
    const meta = readMetadata(exported.bytes);
    expect(meta?.toolName).toBe('knowledge-crib');
    expect(meta?.projectRoot).toBe('/repo');
    expect(meta?.textDocumentEncoding).toBe(1); // UTF8
    const docs = [...readDocuments(exported.bytes)];
    expect(docs).toHaveLength(1);
    expect(docs[0]?.relativePath).toBe('src/app.ts');
    expect(docs[0]?.language).toBe('TypeScript');
  });

  it('marks every exported occurrence as a definition, on the declaring line', () => {
    const doc = [...readDocuments(exported.bytes)][0];
    for (const occ of doc?.occurrences ?? []) {
      expect(occ.roles & ROLE.DEFINITION).toBe(ROLE.DEFINITION);
    }
    // crib line 7 → SCIP line 6.
    const service = doc?.occurrences.find((o) => o.symbol.endsWith('Service#'));
    expect(service?.range?.startLine).toBe(6);
    expect(service?.enclosingRange?.endLine).toBe(40);
  });

  it('chooses the descriptor suffix from the node type', () => {
    expect(scipSymbolFor(nodes[0] as Node, { projectRoot: '/repo' })).toBe(
      'knowledge-crib . . . src/app.ts/Service#',
    );
    expect(scipSymbolFor(nodes[1] as Node, { projectRoot: '/repo' })).toBe(
      'knowledge-crib . . . src/app.ts/Service#run().',
    );
  });

  it('exports an implements edge as a SymbolInformation relationship', () => {
    const doc = [...readDocuments(exported.bytes)][0];
    const run = doc?.symbols.find((s) => s.symbol.endsWith('run().'));
    expect(run?.relationships[0]?.isImplementation).toBe(true);
    expect(run?.kind).toBe(26); // Kind.Method
    expect(exported.counts.relationships).toBe(1);
  });

  it('omits references and says so, rather than exporting wrong positions', () => {
    const withRef: Edge[] = [{ ...(edges[0] as Edge), id: 'e:2', rel: 'references' }];
    const r = soulToScip(nodes, withRef, { projectRoot: '/repo' });
    const doc = [...readDocuments(r.bytes)][0];
    // Only the two definitions; no third, positionless occurrence invented for the reference.
    expect(doc?.occurrences).toHaveLength(2);
    expect(r.notes.join(' ')).toMatch(/find-references does not/);
  });

  it('reports the nodes it could not carry', () => {
    expect(exported.notes.join(' ')).toMatch(/1 non-symbol node/);
    expect(exported.notes.join(' ')).toMatch(/character-coarse/);
  });

  it('re-exports an imported symbol verbatim, so import→export is stable', () => {
    const imported = scipToSoul(handEncodedIndex());
    const service = imported.nodes.find((n) => n.id === 'sym:src/app.ts#Service@L7') as Node;
    expect(scipSymbolFor(service, { projectRoot: '/repo' })).toBe(
      'scip-typescript npm demo 1.0.0 src/app.ts/Service#',
    );
  });
});

describe('the import→export round trip', () => {
  it('preserves every definition and its declaring line', () => {
    const imported = scipToSoul(handEncodedIndex());
    const out = soulToScip(imported.nodes, imported.edges, { projectRoot: '/repo' });
    const reimported = scipToSoul(out.bytes);
    const idsOf = (r: typeof imported) =>
      r.nodes
        .filter((n) => n.kind === 'symbol')
        .map((n) => n.id)
        .sort();
    expect(idsOf(reimported)).toEqual(idsOf(imported));
  });

  it('loses exactly the references, which is the documented gap', () => {
    const imported = scipToSoul(handEncodedIndex());
    const out = soulToScip(imported.nodes, imported.edges, { projectRoot: '/repo' });
    const reimported = scipToSoul(out.bytes);
    expect(imported.counts.references).toBeGreaterThan(0);
    expect(reimported.counts.references).toBe(0);
    // The implements edge survives, because SCIP carries it as a declared relationship.
    expect(reimported.edges.some((e) => e.rel === 'implements')).toBe(true);
  });
});
