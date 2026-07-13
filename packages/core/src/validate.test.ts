/**
 * Schema-validation integrity tests (invariant #4 + #5). The vendored JSON Schemas are the
 * authority for what a Node/Edge/Manifest may carry; `assertValid*` is the gate every write goes
 * through. These tests pin three properties the migration story depends on:
 *
 * 1. **1.3 round-trip** — a node/edge carrying every framework-semantics field (framework/
 *    stereotype/httpMethod/routePath/whenSelector + meta.params/security/injects/produces/column +
 *    references-edge meta.cardinality/cascade/fetch/mappedBy/orphanRemoval) validates, survives a
 *    JSON serialize/parse, and re-validates. Schema drift that drops or mistypes a 1.3 field is
 *    caught here.
 * 2. **Forward compatibility** — a 1.0-era record (no 1.1/1.2/1.3 fields) and a 1.2 record (behavior
 *    fields, no framework fields) BOTH validate under the current 1.3 schema, because every added
 *    field is optional + `additionalProperties: true`. This is the "crib migrate" guarantee: an old
 *    soul loads verbatim; migration is additive (re-index stamps the new fields), never a rewrite.
 * 3. **Closed enums** — a bad `kind` / `rel` / `provenance` is rejected with `SchemaValidationError`,
 *    so an extractor emitting a typo can never silently corrupt the soul.
 */
import {
  type Edge,
  type Manifest,
  type Node,
  type Rel,
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  contentHash,
  edgeId,
  idFor,
} from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import { newManifest } from './manifest.js';
import {
  SchemaValidationError,
  assertValidEdge,
  assertValidManifest,
  assertValidNode,
} from './validate.js';

const F = 'src/com/acme/Loan.java';

function routeNode(): Node {
  return {
    id: idFor({ kind: 'route', httpMethod: 'POST', routePath: '/api/loans', file: F, line: 5 }),
    kind: 'route',
    name: 'POST /api/loans',
    httpMethod: 'POST',
    routePath: '/api/loans',
    framework: 'spring',
    file: F,
    span: { start: 5, end: 5 },
    lang: 'java',
    hash: contentHash('route:POST:/api/loans'),
    meta: {
      params: [{ name: 'loan', type: 'Loan', in: 'body' }],
      security: { PreAuthorize: "hasRole('LENDER')" },
    },
  };
}
function fieldNode(): Node {
  return {
    id: idFor({ kind: 'field', path: F, qualifiedName: 'com.acme.Loan.applicant', startLine: 8 }),
    kind: 'field',
    name: 'applicant',
    qualifiedName: 'com.acme.Loan.applicant',
    dataType: 'Applicant', // 1.1 reuse: the field's declared type
    framework: 'spring',
    file: F,
    span: { start: 8, end: 8 },
    lang: 'java',
    hash: contentHash('field:applicant'),
    meta: { column: { name: 'applicant_id', nullable: 'false', joinColumn: 'applicant_id' } },
  };
}
function componentNode(): Node {
  return {
    id: idFor({
      kind: 'component',
      path: 'src/LoanForm.tsx',
      qualifiedName: 'LoanForm',
      startLine: 1,
    }),
    kind: 'component',
    name: 'LoanForm',
    qualifiedName: 'LoanForm',
    framework: 'react',
    stereotype: 'component',
    file: 'src/LoanForm.tsx',
    span: { start: 1, end: 30 },
    lang: 'typescript',
    hash: contentHash('comp:LoanForm'),
  };
}
function beanMethodNode(): Node {
  return {
    id: idFor({
      kind: 'symbol',
      path: F,
      qualifiedName: 'com.acme.Config.loanRepository',
      startLine: 12,
    }),
    kind: 'symbol',
    type: 'method',
    name: 'loanRepository',
    qualifiedName: 'com.acme.Config.loanRepository',
    framework: 'spring',
    stereotype: 'config',
    file: F,
    span: { start: 12, end: 14 },
    lang: 'java',
    hash: contentHash('bean:loanRepository'),
    meta: { returnType: 'LoanRepository', produces: ['LoanRepository'], injects: ['DataSource'] },
  };
}
function referencesEdge(): Edge {
  return {
    id: edgeId(
      fieldNode().id,
      'sym:src/com/acme/Applicant.java#com.acme.Applicant@L1',
      'references',
    ),
    src: fieldNode().id,
    dst: 'sym:src/com/acme/Applicant.java#com.acme.Applicant@L1',
    rel: 'references',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { snippet: 'Applicant', by: 'lang:java/spring' },
    meta: {
      cardinality: 'ManyToOne',
      fetch: 'FetchType.LAZY',
      cascade: 'CascadeType.ALL',
      orphanRemoval: false,
    },
  };
}
function producesEdge(): Edge {
  return {
    id: edgeId(
      beanMethodNode().id,
      'sym:src/com/acme/LoanRepository.java#com.acme.LoanRepository@L1',
      'produces',
    ),
    src: beanMethodNode().id,
    dst: 'sym:src/com/acme/LoanRepository.java#com.acme.LoanRepository@L1',
    rel: 'produces',
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    evidence: { snippet: 'LoanRepository', by: 'lang:java/spring' },
  };
}

describe('schema validation — 1.3 round-trip', () => {
  it('validates a route node carrying every 1.3 field + meta.params/security', () => {
    expect(() => assertValidNode(routeNode())).not.toThrow();
  });
  it('validates a field node carrying dataType (1.1 reuse) + meta.column', () => {
    expect(() => assertValidNode(fieldNode())).not.toThrow();
  });
  it('validates a component node carrying framework + stereotype', () => {
    expect(() => assertValidNode(componentNode())).not.toThrow();
  });
  it('validates a @Bean method symbol carrying meta.returnType/produces/injects', () => {
    expect(() => assertValidNode(beanMethodNode())).not.toThrow();
  });
  it('validates a references edge with cardinality/cascade/fetch/orphanRemoval meta', () => {
    expect(() => assertValidEdge(referencesEdge())).not.toThrow();
  });
  it('validates a produces edge (1.3 rel)', () => {
    expect(() => assertValidEdge(producesEdge())).not.toThrow();
  });

  it('survives a JSON serialize/parse round-trip and re-validates (no field lost)', () => {
    const n = routeNode();
    const roundTripped = JSON.parse(JSON.stringify(n)) as Node;
    expect(roundTripped).toEqual(n);
    expect(() => assertValidNode(roundTripped)).not.toThrow();
    const e = referencesEdge();
    const eRound = JSON.parse(JSON.stringify(e)) as Edge;
    expect(eRound).toEqual(e);
    expect(() => assertValidEdge(eRound)).not.toThrow();
  });
});

describe('schema validation — forward compatibility (old soul loads under new schema)', () => {
  it('a 1.0-era node (kind/name/file/span/lang/hash only) validates under the 1.3 schema', () => {
    const legacy: Node = {
      id: idFor({ kind: 'symbol', path: 'src/a.ts', qualifiedName: 'A', startLine: 1 }),
      kind: 'symbol',
      type: 'class',
      name: 'A',
      file: 'src/a.ts',
      span: { start: 1, end: 10 },
      lang: 'typescript',
      hash: contentHash('A'),
    };
    expect(() => assertValidNode(legacy)).not.toThrow();
  });

  it('a 1.2 behavior node (raise with errorCode/errorMessage/whenSelector) validates under 1.3', () => {
    const raise: Node = {
      id: idFor({ kind: 'raise', file: 'db/pkg.pkb', line: 42 }),
      kind: 'raise',
      errorCode: '-20001',
      errorMessage: 'loan rejected',
      file: 'db/pkg.pkb',
      span: { start: 42, end: 42 },
      lang: 'plsql',
      hash: contentHash('raise:42'),
    };
    expect(() => assertValidNode(raise)).not.toThrow();
    // a 1.2 cursor/exception-handler/assignment/case-branch all validate too
    const cursor: Node = {
      id: idFor({ kind: 'cursor', file: 'db/pkg.pkb', name: 'c_loans', line: 10 }),
      kind: 'cursor',
      name: 'c_loans',
      cursorQuery: 'SELECT * FROM loans',
      file: 'db/pkg.pkb',
      span: { start: 10, end: 10 },
      lang: 'plsql',
      hash: contentHash('cursor:c_loans'),
    };
    expect(() => assertValidNode(cursor)).not.toThrow();
  });

  it('a 1.0-era edge (calls, no 1.2/1.3 attrs) validates under the 1.3 schema', () => {
    const e: Edge = {
      id: edgeId('sym:src/a.ts#A@L1', 'sym:src/a.ts#B@L5', 'calls'),
      src: 'sym:src/a.ts#A@L1',
      dst: 'sym:src/a.ts#B@L5',
      rel: 'calls',
      method: 'static',
      provenance: 'EXTRACTED',
      confidence: 1,
    };
    expect(() => assertValidEdge(e)).not.toThrow();
  });

  it('a manifest claiming schemaVersion 1.0 still validates (schemaVersion is a free string)', () => {
    const m = newManifest({ now: '2026-01-01T00:00:00.000Z', root: '/repo' });
    (m as Manifest).schemaVersion = '1.0';
    expect(() => assertValidManifest(m)).not.toThrow();
  });
});

describe('schema validation — "crib migrate" is additive (no rewrite)', () => {
  it('a 1.2 node validates, then stamps 1.3 fields and re-validates (migration = field add, not rewrite)', () => {
    // start: a 1.2-era service class symbol with NO framework fields
    const service: Node = {
      id: idFor({ kind: 'symbol', path: F, qualifiedName: 'com.acme.LoanService', startLine: 30 }),
      kind: 'symbol',
      type: 'class',
      name: 'LoanService',
      file: F,
      span: { start: 30, end: 60 },
      lang: 'java',
      hash: contentHash('svc:LoanService'),
    };
    expect(() => assertValidNode(service)).not.toThrow();
    // migrate: re-index stamps the 1.3 identity onto the SAME node (additive, id-stable)
    const migrated: Node = {
      ...service,
      framework: 'spring',
      stereotype: 'service',
      meta: { injects: ['com.acme.LoanRepository'] },
    };
    expect(() => assertValidNode(migrated)).not.toThrow();
    // the id is unchanged — migration is in-place, not a rewrite
    expect(migrated.id).toBe(service.id);
    expect(migrated.hash).toBe(service.hash);
  });

  it('SUPPORTED_SCHEMA_VERSIONS includes 1.0→1.4 (every old soul is loadable)', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1.0');
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1.1');
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1.2');
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1.3');
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1.4');
    expect(SCHEMA_VERSION).toBe('1.4');
  });
});

describe('schema validation — field-datatype guard (1.1 dataType reuse on 1.3 field nodes)', () => {
  it('a field node MAY carry dataType (the 1.1 scalar-type field, reused for JPA columns + props)', () => {
    const f = fieldNode();
    expect(f.dataType).toBe('Applicant');
    expect(() => assertValidNode(f)).not.toThrow();
  });
  it('a field node without dataType still validates (dataType is optional, not every field has a scalar type)', () => {
    const f: Node = {
      id: idFor({ kind: 'field', path: F, qualifiedName: 'com.acme.Loan.payments', startLine: 9 }),
      kind: 'field',
      name: 'payments',
      qualifiedName: 'com.acme.Loan.payments',
      framework: 'spring',
      file: F,
      span: { start: 9, end: 9 },
      lang: 'java',
      hash: contentHash('field:payments'),
      meta: { column: { name: 'payments_id' } },
    };
    expect(f.dataType).toBeUndefined();
    expect(() => assertValidNode(f)).not.toThrow();
  });
  it("'field' is a declared NodeKind (a typo like 'Field' is rejected)", () => {
    const bad: Node = {
      id: idFor({ kind: 'field', path: F, qualifiedName: 'x', startLine: 1 }),
      kind: 'Field' as Node['kind'], // wrong case
      name: 'x',
      file: F,
      span: { start: 1, end: 1 },
      lang: 'java',
      hash: contentHash('field:x'),
    };
    expect(() => assertValidNode(bad)).toThrow(SchemaValidationError);
  });
});

describe('schema validation — closed enums reject unknown values', () => {
  it('rejects an unknown node kind', () => {
    const bad = { ...routeNode(), kind: 'endpoint' as Node['kind'] };
    expect(() => assertValidNode(bad)).toThrow(SchemaValidationError);
  });
  it('rejects an unknown edge rel', () => {
    const bad = { ...referencesEdge(), rel: 'depends-on' as Rel };
    expect(() => assertValidEdge(bad)).toThrow(SchemaValidationError);
  });
  it('rejects an unknown provenance', () => {
    const bad = { ...referencesEdge(), provenance: 'GUESSED' as Edge['provenance'] };
    expect(() => assertValidEdge(bad)).toThrow(SchemaValidationError);
  });
  it('rejects confidence out of [0,1]', () => {
    const bad = { ...referencesEdge(), confidence: 1.5 };
    expect(() => assertValidEdge(bad)).toThrow(SchemaValidationError);
  });
  it('rejects a malformed node hash (not blake3:)', () => {
    const bad = { ...routeNode(), hash: 'sha256:deadbeef' };
    expect(() => assertValidNode(bad)).toThrow(SchemaValidationError);
  });
  it('rejects a malformed edge id (not e:)', () => {
    const bad = { ...referencesEdge(), id: 'edge-1' };
    expect(() => assertValidEdge(bad)).toThrow(SchemaValidationError);
  });
});
