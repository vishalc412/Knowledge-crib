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

  it('terminates on an anonymous block with CASE + EXCEPTION (stray WHEN at top level)', async () => {
    // Regression: the parser does not model CASE/EXCEPTION precisely, so the EXCEPTION handler's
    // `WHEN` (a BLOCK_END keyword) was left as a stray top-level token. parseFile's unknown-construct
    // fallback called recover(), which bails on BLOCK_END keywords without advancing → infinite loop.
    // The block is followed by a bare SELECT to prove parseFile kept walking past the stray tokens.
    const src = [
      'DECLARE',
      '  v_icon VARCHAR2(3);',
      'BEGIN',
      '  CASE v_status',
      "    WHEN 'PASSED' THEN v_icon := 'OK';",
      "    ELSE v_icon := '?';",
      '  END CASE;',
      'EXCEPTION',
      '  WHEN OTHERS THEN',
      '    ROLLBACK;',
      'END;',
      '/',
      'SELECT * FROM DUAL;',
      '',
    ].join('\n');
    const r = await run(src);
    // no throw, no hang — and the trailing top-level SELECT was reached (a statement node exists).
    const selects = r.nodes.filter((n) => n.kind === 'statement' && n.sqlKind === 'select');
    expect(selects.length).toBe(1);
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

describe('PlSqlExtractor — CREATE TYPE / VIEW (Track 2 deep-context)', () => {
  const TYPES_FIXTURE = fileURLToPath(new URL('../../fixtures/plsql/types.sql', import.meta.url));
  const TYPES_PATH = 'fixtures/plsql/types.sql';

  async function runTypes(): Promise<ExtractResult> {
    const text = readFileSync(TYPES_FIXTURE, 'utf8');
    const meta: FileMeta = { path: TYPES_PATH, lang: 'plsql', bytes: text.length, mtime: 0 };
    return new PlSqlExtractor().extract(meta, ctxFor(text));
  }

  it('models CREATE TYPE AS OBJECT as a symbol with the FULL attribute field list', async () => {
    const { nodes } = await runTypes();
    const t = nodes.find((n) => n.qualifiedName === 'applicant_ctx_obj');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('symbol');
    expect(t!.type).toBe('type');
    // the full attribute list — the deep context that was previously missing
    const attrs = (t!.meta?.attributes as Array<{ name: string; dataType: string }>) ?? [];
    expect(attrs.map((a) => a.name)).toEqual([
      'applicant_id',
      'full_name',
      'date_of_birth',
      'gender',
      'nationality',
      'residency_code',
      'monthly_income',
      'existing_debt',
      'kyc_passed',
    ]);
    expect(attrs.find((a) => a.name === 'full_name')!.dataType).toContain('VARCHAR2');
  });

  it('models a TABLE OF collection type with element type on meta.collection', async () => {
    const { nodes } = await runTypes();
    const t = nodes.find((n) => n.qualifiedName === 'income_sources');
    expect(t?.type).toBe('type');
    expect(t?.meta?.collection).toEqual({ kind: 'table', elementType: 'income_source_obj' });
    expect((t?.meta?.attributes as unknown[]) ?? []).toHaveLength(0);
  });

  it('models a VARRAY OF collection type', async () => {
    const { nodes } = await runTypes();
    const t = nodes.find((n) => n.qualifiedName === 'doc_list');
    const collection = t?.meta?.collection as { kind: string; elementType: string } | undefined;
    expect(collection?.kind).toBe('varray');
    expect(collection?.elementType).toContain('VARCHAR2');
  });

  it('models CREATE VIEW as a table node (meta.kind:view) with explicit columns', async () => {
    const { nodes, edges } = await runTypes();
    const v = nodes.find((n) => n.kind === 'table' && n.name === 'applicant_summary');
    expect(v).toBeDefined();
    expect(v!.meta?.kind).toBe('view');
    expect(v!.meta?.columns).toEqual(['applicant_id', 'full_name', 'total_income']);
    // explicit view columns become column nodes member-of the view
    const cols = nodes.filter((n) => n.kind === 'column' && n.table === 'applicant_summary');
    expect(cols.map((c) => c.name).sort()).toEqual(['applicant_id', 'full_name', 'total_income']);
    expect(
      cols.every((c) =>
        edges.some((e) => e.rel === 'member-of' && e.src === c.id && e.dst === v!.id),
      ),
    ).toBe(true);
  });

  it('the object type is member-of the file and indexed for cross-file resolution', async () => {
    const { nodes, edges } = await runTypes();
    const t = nodes.find((n) => n.qualifiedName === 'applicant_ctx_obj')!;
    const fileId = idFor({ kind: 'file', path: TYPES_PATH });
    expect(edges.some((e) => e.rel === 'member-of' && e.src === t.id && e.dst === fileId)).toBe(
      true,
    );
  });

  it('uses the canonical id grammar for the type symbol', async () => {
    const { nodes } = await runTypes();
    const t = nodes.find((n) => n.qualifiedName === 'applicant_ctx_obj');
    expect(t?.id).toMatch(/^sym:fixtures\/plsql\/types\.sql#applicant_ctx_obj@L\d+$/);
  });
});

describe('PlSqlExtractor — schema-1.2 behavior constructs (Workstream B/G golden)', () => {
  const LOAN_FIXTURE = fileURLToPath(
    new URL('../../fixtures/plsql/loan_rule_engine.pkb', import.meta.url),
  );
  const LOAN_PATH = 'fixtures/plsql/loan_rule_engine.pkb';

  async function runLoan(): Promise<ExtractResult> {
    const text = readFileSync(LOAN_FIXTURE, 'utf8');
    const meta: FileMeta = { path: LOAN_PATH, lang: 'plsql', bytes: text.length, mtime: 0 };
    return new PlSqlExtractor().extract(meta, ctxFor(text));
  }

  /** label ids for the 1.2 behavior kinds so assertions stay readable. */
  function loanLabel(r: ExtractResult): (id: string) => string {
    const nm = new Map(r.nodes.map((n) => [n.id, n] as const));
    return (id: string): string => {
      const n = nm.get(id);
      if (!n) return id;
      switch (n.kind) {
        case 'symbol':
          return n.qualifiedName ?? n.name ?? id;
        case 'table':
          return `table:${n.name}`;
        case 'statement':
          return `stmt:L${n.span?.start}:${n.sqlKind ?? n.type}`;
        case 'condition':
          return `cond:L${n.span?.start}:${n.branch}`;
        case 'cursor':
          return `cursor:${n.name}`;
        case 'raise':
          return `raise:L${n.span?.start}:${n.errorCode ?? n.name}`;
        case 'exception-handler':
          return `exc:L${n.span?.start}:${n.whenSelector}`;
        case 'case-branch':
          return `case:L${n.span?.start}:${n.whenSelector ?? 'default'}`;
        case 'assignment':
          return `assign:L${n.span?.start}:${n.assignTarget}`;
        case 'explanation':
          return `expl:L${n.span?.start}`;
        default:
          return n.kind;
      }
    };
  }

  it('emits a cursor node (with cursorQuery) + declares + a loop iterates edge', async () => {
    const { nodes, edges } = await runLoan();
    const label = loanLabel({ nodes, edges } as ExtractResult);
    const cur = nodes.find((n) => n.kind === 'cursor' && n.name === 'c_app');
    expect(cur).toBeDefined();
    expect(cur?.cursorQuery).toContain('SELECT amount, status, credit_score');
    expect(cur?.cursorQuery).toContain('FROM loan_applications');

    const proc = nodes.find((n) => n.qualifiedName === 'loan_engine.assess_application')!;
    // proc declares the cursor
    expect(edges.some((e) => e.rel === 'declares' && e.src === proc.id && e.dst === cur!.id)).toBe(
      true,
    );
    // the FOR ... IN c_app LOOP iterates the cursor (loop condition -> cursor)
    const loopCond = nodes.find((n) => n.kind === 'condition' && n.branch === 'LOOP');
    expect(loopCond).toBeDefined();
    expect(
      edges.some((e) => e.rel === 'iterates' && e.src === loopCond!.id && e.dst === cur!.id),
    ).toBe(true);
  });

  it('emits an explanation node from the comment block above the procedure + a describes edge', async () => {
    const { nodes, edges } = await runLoan();
    const label = loanLabel({ nodes, edges } as ExtractResult);
    const expl = nodes.find((n) => n.kind === 'explanation');
    expect(expl).toBeDefined();
    expect(expl?.commentRef?.file).toBe(LOAN_PATH);
    expect(String(expl?.meta?.text ?? '')).toContain('Assess one loan application');
    const proc = nodes.find((n) => n.qualifiedName === 'loan_engine.assess_application')!;
    expect(
      edges.some((e) => e.rel === 'describes' && e.src === expl!.id && e.dst === proc.id),
    ).toBe(true);
  });

  it('emits assignment nodes with assignTarget for each := in the body', async () => {
    const { nodes } = await runLoan();
    const assigns = nodes
      .filter((n) => n.kind === 'assignment')
      .map((n) => `${n.assignTarget}@L${n.span?.start}`)
      .sort();
    expect(assigns).toEqual(
      [
        'v_amount@L28',
        'v_decision@L33',
        'v_decision@L35',
        'v_decision@L37',
        'v_decision@L46',
        'v_score@L30',
        'v_status@L29',
      ].sort(),
    );
  });

  it('emits one case-branch per WHEN/ELSE with the WHEN condition as whenSelector', async () => {
    const { nodes } = await runLoan();
    const cases = nodes
      .filter((n) => n.kind === 'case-branch')
      .map((n) => `${n.span?.start}:${n.whenSelector ?? 'default'}`)
      .sort();
    expect(cases).toEqual(
      ['32:v_amount > 50000 AND v_score >= 700', '34:v_score >= 600', '36:default'].sort(),
    );
  });

  it('emits raise nodes with errorCode + errorMessage and raises edges from the proc', async () => {
    const { nodes, edges } = await runLoan();
    const label = loanLabel({ nodes, edges } as ExtractResult);
    const raises = nodes.filter((n) => n.kind === 'raise');
    expect(raises.map((n) => n.errorCode).sort()).toEqual(['-20001', '-20002']);
    const r1 = raises.find((n) => n.errorCode === '-20001')!;
    expect(r1.errorMessage).toBe('application rejected: insufficient credit');
    const r2 = raises.find((n) => n.errorCode === '-20002')!;
    expect(r2.errorMessage).toBe('assess_application failed');

    const proc = nodes.find((n) => n.qualifiedName === 'loan_engine.assess_application')!;
    const raisesEdges = edges
      .filter((e) => e.rel === 'raises' && e.src === proc.id)
      .map((e) => label(e.dst))
      .sort();
    expect(raisesEdges).toEqual(['raise:L40:-20001', 'raise:L49:-20002']);
  });

  it('emits exception-handler nodes (whenSelector) with handles edges to their guarded stmts', async () => {
    const { nodes, edges } = await runLoan();
    const label = loanLabel({ nodes, edges } as ExtractResult);
    const excs = nodes
      .filter((n) => n.kind === 'exception-handler')
      .map((n) => `${n.span?.start}:${n.whenSelector}`)
      .sort();
    expect(excs).toEqual(['45:NO_DATA_FOUND', '48:OTHERS']);

    const handles = edges
      .filter((e) => e.rel === 'handles')
      .map((e) => `${label(e.src)} -> ${label(e.dst)}`)
      .sort();
    expect(handles).toEqual(
      [
        'exc:L45:NO_DATA_FOUND -> assign:L46:v_decision',
        'exc:L45:NO_DATA_FOUND -> stmt:L47:update',
        'exc:L48:OTHERS -> raise:L49:-20002',
      ].sort(),
    );
  });

  it('stamps guard-chain: the raise inside the guarded IF is guarded-by the IF condition', async () => {
    const { nodes, edges } = await runLoan();
    const label = loanLabel({ nodes, edges } as ExtractResult);
    const r1 = nodes.find((n) => n.kind === 'raise' && n.errorCode === '-20001')!;
    // the IF v_decision = 'REJECT' THEN guard stamps a guarded-by edge onto the raise
    const guardedBy = edges
      .filter((e) => e.rel === 'guarded-by' && e.src === r1.id)
      .map((e) => label(e.dst));
    expect(guardedBy.length).toBe(1);
    expect(guardedBy[0]).toMatch(/^cond:L\d+:THEN$/);
  });

  it('emits executes edges from the proc to its assignments + DML (no regression to Track-3)', async () => {
    const { nodes, edges } = await runLoan();
    const label = loanLabel({ nodes, edges } as ExtractResult);
    const proc = nodes.find((n) => n.qualifiedName === 'loan_engine.assess_application')!;
    const exec = edges
      .filter((e) => e.rel === 'executes' && e.src === proc.id)
      .map((e) => label(e.dst))
      .sort();
    // 7 assignments + 2 DML statements (the body UPDATE + the NO_DATA_FOUND handler UPDATE)
    expect(exec).toContain('stmt:L42:update');
    expect(exec).toContain('stmt:L47:update');
    expect(exec.filter((x) => x.startsWith('assign:')).length).toBe(7);
  });

  it('every 1.2 edge is EXTRACTED/static/confidence 1 with plsql-extractor evidence', async () => {
    const { edges } = await runLoan();
    const rel12 = edges.filter((e) =>
      ['raises', 'handles', 'iterates', 'declares', 'describes'].includes(e.rel),
    );
    expect(rel12.length).toBeGreaterThan(0);
    for (const e of rel12) {
      expect(e.provenance).toBe('EXTRACTED');
      expect(e.method).toBe('static');
      expect(e.confidence).toBe(1);
      expect(e.evidence?.by).toBe('plsql-extractor');
    }
  });
});
