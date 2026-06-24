import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { PlSqlExtractor } from './PlSqlExtractor.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/plsql/claims.pkb', import.meta.url));
const PATH = 'fixtures/plsql/claims.pkb';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'plsql', bytes: text.length, mtime: 0 };
  return new PlSqlExtractor().extract(meta, ctxFor(text));
}

/** label a node id for readable assertions: qualified name / table / col / stmt:L / cond:L. */
function labeler(r: ExtractResult): (id: string) => string {
  return (id: string): string => {
    const n = r.nodes.find((x) => x.id === id);
    if (!n) return id;
    switch (n.kind) {
      case 'symbol':
        return n.qualifiedName ?? n.name ?? id;
      case 'table':
        return `table:${n.name}`;
      case 'column':
        return `col:${n.table}.${n.name}`;
      case 'statement':
        return `stmt:L${n.span?.start}:${n.sqlKind ?? n.type}`;
      case 'condition':
        return `cond:L${n.span?.start}:${n.branch}`;
      default:
        return n.kind;
    }
  };
}

describe('PlSqlExtractor — golden (M10 gate)', () => {
  it('emits the table + column nodes with member-of edges', async () => {
    const { nodes, edges } = await run();
    const tables = nodes.filter((n) => n.kind === 'table').map((n) => n.name);
    expect(tables).toEqual(['claims']);
    const cols = nodes
      .filter((n) => n.kind === 'column')
      .map((n) => `${n.table}.${n.name}`)
      .sort();
    expect(cols).toEqual(['claims.amount', 'claims.id', 'claims.status'].sort());

    const label = labeler({ nodes, edges } as ExtractResult);
    const memberOfCols = edges
      .filter((e) => e.rel === 'member-of' && e.src.startsWith('col:'))
      .map((e) => `${label(e.src)} -> ${label(e.dst)}`)
      .sort();
    expect(memberOfCols).toEqual(
      [
        'col:claims.amount -> table:claims',
        'col:claims.id -> table:claims',
        'col:claims.status -> table:claims',
      ].sort(),
    );
  });

  it('emits the package + procedure symbols with member-of to the enclosing unit', async () => {
    const { nodes, edges } = await run();
    const syms: Record<string, string | undefined> = {};
    for (const n of nodes) if (n.kind === 'symbol') syms[n.qualifiedName ?? ''] = n.type;
    expect(syms).toEqual({
      claim_pkg: 'package',
      'claim_pkg.validate_claim': 'procedure',
      'claim_pkg.process_claim': 'procedure',
    });

    const label = labeler({ nodes, edges } as ExtractResult);
    const fileId = idFor({ kind: 'file', path: PATH });
    const symMemberOf = edges
      .filter((e) => e.rel === 'member-of' && e.src.startsWith('sym:'))
      .map((e) => `${label(e.src)} -> ${e.dst === fileId ? 'FILE' : label(e.dst)}`)
      .sort();
    expect(symMemberOf).toEqual(
      [
        'claim_pkg -> FILE',
        'claim_pkg.validate_claim -> claim_pkg',
        'claim_pkg.process_claim -> claim_pkg',
      ].sort(),
    );
  });

  it('emits executes edges from each procedure to its DML statements', async () => {
    const { nodes, edges } = await run();
    const label = labeler({ nodes, edges } as ExtractResult);
    const exec = edges
      .filter((e) => e.rel === 'executes')
      .map((e) => `${label(e.src)} -> ${label(e.dst)}`)
      .sort();
    expect(exec).toEqual(
      [
        'claim_pkg.validate_claim -> stmt:L13:select',
        'claim_pkg.validate_claim -> stmt:L15:update',
        'claim_pkg.process_claim -> stmt:L23:select',
        'claim_pkg.process_claim -> stmt:L25:insert',
        'claim_pkg.process_claim -> stmt:L27:delete',
      ].sort(),
    );
  });

  it('emits reads/writes with correct roles (select→reads, update/insert/delete→writes)', async () => {
    const { nodes, edges } = await run();
    const label = labeler({ nodes, edges } as ExtractResult);
    const reads = edges
      .filter((e) => e.rel === 'reads')
      .map((e) => `${label(e.src)} -> ${label(e.dst)}`)
      .sort();
    const writes = edges
      .filter((e) => e.rel === 'writes')
      .map((e) => `${label(e.src)} -> ${label(e.dst)}`)
      .sort();
    expect(reads).toEqual(
      ['stmt:L13:select -> table:claims', 'stmt:L23:select -> table:claims'].sort(),
    );
    expect(writes).toEqual(
      [
        'stmt:L15:update -> table:claims',
        'stmt:L25:insert -> table:claims',
        'stmt:L27:delete -> table:claims',
      ].sort(),
    );
  });

  it('emits guarded-by from a guarded DML to its innermost condition (THEN), not from the ELSE branch', async () => {
    const { nodes, edges } = await run();
    const label = labeler({ nodes, edges } as ExtractResult);
    const guarded = edges
      .filter((e) => e.rel === 'guarded-by')
      .map((e) => `${label(e.src)} -> ${label(e.dst)}`)
      .sort();
    // The UPDATE (THEN branch) and INSERT (THEN branch) are guarded; the DELETE (ELSE branch) is not.
    expect(guarded).toEqual(
      ['stmt:L15:update -> cond:L14:THEN', 'stmt:L25:insert -> cond:L24:THEN'].sort(),
    );
    // a condition node exists per guarded branch
    const conds = nodes
      .filter((n) => n.kind === 'condition')
      .map((n) => `${n.span?.start}:${n.branch}`)
      .sort();
    expect(conds).toEqual(['14:THEN', '24:THEN']);
  });

  it('emits an intra-file calls edge and records the call site for cross-file resolution', async () => {
    const { nodes, edges } = await run();
    const label = labeler({ nodes, edges } as ExtractResult);
    const calls = edges
      .filter((e) => e.rel === 'calls')
      .map((e) => `${label(e.src)} -> ${label(e.dst)}`)
      .sort();
    expect(calls).toEqual(['claim_pkg.process_claim -> claim_pkg.validate_claim']);
    // call site stamped on the caller's meta for the SqlResolver to resolve cross-file.
    const proc = nodes.find((n) => n.qualifiedName === 'claim_pkg.process_claim');
    expect(proc?.meta?.calls).toEqual([{ callee: 'validate_claim', line: 22 }]);
  });

  it('stamps statement meta with referenced tables + guard/loop flags', async () => {
    const { nodes } = await run();
    const select = nodes.find(
      (n) => n.kind === 'statement' && n.sqlKind === 'select' && n.span?.start === 13,
    );
    expect(select?.meta?.tables).toEqual(['claims']);
    expect(select?.meta?.branch).toBeUndefined();
    const update = nodes.find((n) => n.kind === 'statement' && n.sqlKind === 'update');
    expect(update?.meta?.branch).toBe('GUARDED');
    expect(update?.meta?.inLoop).toBe(false);
  });

  it('uses the canonical id grammar', async () => {
    const { nodes } = await run();
    const proc = nodes.find((n) => n.qualifiedName === 'claim_pkg.validate_claim');
    expect(proc?.id).toMatch(/^sym:fixtures\/plsql\/claims\.pkb#claim_pkg\.validate_claim@L\d+$/);
    const table = nodes.find((n) => n.kind === 'table');
    expect(table?.id).toBe(idFor({ kind: 'table', schema: '', name: 'claims' }));
  });

  it('degrades on a malformed file (no nodes, no throw)', async () => {
    const r = await run('CREATE PACKAGE !!! ((( ;');
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });

  it('every edge is EXTRACTED/static/confidence 1 with plsql-extractor evidence', async () => {
    const { edges } = await run();
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.method).toBe('static');
      expect(e.confidence).toBe(1);
      expect(e.evidence?.by).toBe('plsql-extractor');
    }
  });
});
