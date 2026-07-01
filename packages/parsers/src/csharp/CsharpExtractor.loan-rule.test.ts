import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import type { IdSpec, NodeKind } from '@knowledge-crib/soul-schema';
import { describe, expect, it } from 'vitest';
import type { ExtractCtx, ExtractResult, FileMeta } from '../types.js';
import { CsharpExtractor } from './CsharpExtractor.js';

// G2 — C# loan-rule-engine: a faithful C# port of the PL/SQL `assess_application` procedure
// (packages/parsers/fixtures/plsql/loan_rule_engine.pkb). The hand-rolled C# parser must parse it
// cleanly (real symbol nodes, NOT a file-node-only degradation) and emit the schema-1.2 behavior
// nodes that mirror the PL/SQL golden: raise / exception-handler / case-branch / assignment.

const FIXTURE = fileURLToPath(new URL('../../fixtures/csharp/LoanRuleEngine.cs', import.meta.url));
const PATH = 'fixtures/csharp/LoanRuleEngine.cs';

function ctxFor(text: string): ExtractCtx {
  return {
    async readText() {
      return text;
    },
    treeSitter() {
      throw new Error('not used — C# is hand-rolled, no tree-sitter');
    },
    hash: contentHash,
    idFor: (kind: NodeKind, parts) => idFor({ kind, ...parts } as IdSpec),
  };
}

async function run(text = readFileSync(FIXTURE, 'utf8')): Promise<ExtractResult> {
  const meta: FileMeta = { path: PATH, lang: 'csharp', bytes: text.length, mtime: 0 };
  return new CsharpExtractor().extract(meta, ctxFor(text));
}

describe('CsharpExtractor — loan-rule-engine fixture (G2 PL/SQL port)', () => {
  it('parses cleanly: emits the namespace/class/method symbols with qualified names (no degradation)', async () => {
    const { nodes } = await run();
    const syms = nodes
      .filter((n) => n.kind === 'symbol')
      .map((n) => `${n.qualifiedName}|${n.type}`)
      .sort();
    expect(syms).toEqual(
      [
        'Crib.LoanRuleEngine|namespace',
        'Crib.LoanRuleEngine.ApplicationRow|class',
        'Crib.LoanRuleEngine.LoanRuleService|class',
        'Crib.LoanRuleEngine.LoanRuleService.AssessApplication|method',
        'Crib.LoanRuleEngine.LoanRuleService.SelectApplications|method',
        'Crib.LoanRuleEngine.LoanRuleService.UpdateApplication|method',
        'Crib.LoanRuleEngine.NoDataException|class',
      ].sort(),
    );
  });

  it('emits a raise node for the -20001 reject throw with the error code embedded in errorMessage', async () => {
    const { nodes, edges } = await run();
    const procId = idFor({
      kind: 'symbol',
      path: PATH,
      qualifiedName: 'Crib.LoanRuleEngine.LoanRuleService.AssessApplication',
      startLine: 9,
    });
    const raiseId = idFor({ kind: 'raise', file: PATH, line: 34 });
    const raise = nodes.find((n) => n.id === raiseId);
    expect(raise).toBeDefined();
    expect(raise?.kind).toBe('raise');
    expect(raise?.name).toBe('ApplicationException');
    // NOTE: the C# extractor does NOT split an errorCode out of `throw new XException("msg")` —
    // only PL/SQL's RAISE_APPLICATION_ERROR(code, msg) populates `errorCode`. The C# port embeds
    // the code in the message ("-20001: …") so it is recoverable from errorMessage.
    expect(raise?.errorCode).toBeUndefined();
    expect(raise?.errorMessage).toContain('-20001');
    expect(raise?.errorMessage).toContain('application rejected: insufficient credit');
    // raises edge: AssessApplication → raise(L34)
    const raisesEdge = edges.find(
      (e) => e.rel === 'raises' && e.src === procId && e.dst === raiseId,
    );
    expect(raisesEdge).toBeDefined();
    expect(raisesEdge?.provenance).toBe('EXTRACTED');
  });

  it('emits a raise node for the -20002 failure throw (WHEN OTHERS equivalent)', async () => {
    const { nodes, edges } = await run();
    const procId = idFor({
      kind: 'symbol',
      path: PATH,
      qualifiedName: 'Crib.LoanRuleEngine.LoanRuleService.AssessApplication',
      startLine: 9,
    });
    const raiseId = idFor({ kind: 'raise', file: PATH, line: 48 });
    const raise = nodes.find((n) => n.id === raiseId);
    expect(raise).toBeDefined();
    expect(raise?.name).toBe('ApplicationException');
    expect(raise?.errorMessage).toContain('-20002');
    expect(raise?.errorMessage).toContain('assess_application failed');
    const raisesEdge = edges.find(
      (e) => e.rel === 'raises' && e.src === procId && e.dst === raiseId,
    );
    expect(raisesEdge).toBeDefined();
  });

  it('emits exception-handler nodes for both catch clauses with handles edges to their body actions', async () => {
    const { nodes, edges } = await run();
    // catch (NoDataException) → line 41 (NO_DATA_FOUND equivalent)
    const noDataHandlerId = idFor({ kind: 'exception-handler', file: PATH, line: 41 });
    const noDataHandler = nodes.find((n) => n.id === noDataHandlerId);
    expect(noDataHandler).toBeDefined();
    expect(noDataHandler?.kind).toBe('exception-handler');
    expect(noDataHandler?.whenSelector).toBe('NoDataException');
    // catch (System.Exception) → line 46 (OTHERS equivalent)
    const othersHandlerId = idFor({ kind: 'exception-handler', file: PATH, line: 46 });
    const othersHandler = nodes.find((n) => n.id === othersHandlerId);
    expect(othersHandler?.whenSelector).toBe('System.Exception');
    // handles edges: NoDataException handler → assignment(L43) + UpdateApplication call(L44)
    const assignL43 = idFor({ kind: 'assignment', file: PATH, line: 43 });
    const callL44 = idFor({ kind: 'statement', file: PATH, line: 44 });
    const handles = edges.filter((e) => e.rel === 'handles');
    expect(handles.some((e) => e.src === noDataHandlerId && e.dst === assignL43)).toBe(true);
    expect(handles.some((e) => e.src === noDataHandlerId && e.dst === callL44)).toBe(true);
    // OTHERS handler → throw/raise(L48) — the re-raise of -20002
    const raiseL48 = idFor({ kind: 'raise', file: PATH, line: 48 });
    expect(handles.some((e) => e.src === othersHandlerId && e.dst === raiseL48)).toBe(true);
    for (const e of handles) {
      expect(e.method).toBe('static');
      expect(e.provenance).toBe('EXTRACTED');
    }
  });

  it('emits case-branch nodes for the switch arms (REJECT + default)', async () => {
    const { nodes } = await run();
    const rejectCase = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: PATH, line: 33 }),
    );
    const defaultCase = nodes.find(
      (n) => n.id === idFor({ kind: 'case-branch', file: PATH, line: 35 }),
    );
    expect(rejectCase?.kind).toBe('case-branch');
    expect(rejectCase?.whenSelector).toBe('"REJECT"');
    // default: whenSelector omitted, expr empty
    expect(defaultCase).toBeDefined();
    expect(defaultCase?.whenSelector).toBeUndefined();
    expect(defaultCase?.expr).toBe('');
  });

  it('walks the switch case body under the case-branch guard (throw guarded-by the REJECT case-branch)', async () => {
    const { edges } = await run();
    const caseRejectId = idFor({ kind: 'case-branch', file: PATH, line: 33 });
    const throwStmtL34 = idFor({ kind: 'statement', file: PATH, line: 34 });
    const gb = edges.find(
      (e) => e.rel === 'guarded-by' && e.src === throwStmtL34 && e.dst === caseRejectId,
    );
    expect(gb).toBeDefined();
  });

  it('emits assignment nodes for the variable provenance (amount/status/score + decision)', async () => {
    const { nodes, edges } = await run();
    const procId = idFor({
      kind: 'symbol',
      path: PATH,
      qualifiedName: 'Crib.LoanRuleEngine.LoanRuleService.AssessApplication',
      startLine: 9,
    });
    const amount = nodes.find((n) => n.id === idFor({ kind: 'assignment', file: PATH, line: 16 }));
    const status = nodes.find((n) => n.id === idFor({ kind: 'assignment', file: PATH, line: 17 }));
    const score = nodes.find((n) => n.id === idFor({ kind: 'assignment', file: PATH, line: 18 }));
    const approve1 = nodes.find(
      (n) => n.id === idFor({ kind: 'assignment', file: PATH, line: 21 }),
    );
    const reject = nodes.find((n) => n.id === idFor({ kind: 'assignment', file: PATH, line: 29 }));
    expect(amount?.assignTarget).toBe('amount');
    expect(status?.assignTarget).toBe('status');
    expect(score?.assignTarget).toBe('score');
    expect(approve1?.assignTarget).toBe('decision');
    expect(reject?.assignTarget).toBe('decision');
    // executes edge AssessApplication → assignment(L16)
    const exec = edges.find(
      (e) => e.rel === 'executes' && e.src === procId && e.dst === amount?.id,
    );
    expect(exec).toBeDefined();
  });

  it('emits the loop condition (foreach) + the IF condition for the searched-CASE equivalent', async () => {
    const { nodes } = await run();
    const loopCond = nodes.find((n) => n.kind === 'condition' && n.span?.start === 14);
    expect(loopCond?.branch).toBe('LOOP');
    expect(loopCond?.expr).toBe('var rec in SelectApplications(pId)');
    const ifCond = nodes.find((n) => n.kind === 'condition' && n.span?.start === 19);
    expect(ifCond?.branch).toBe('THEN');
    expect(ifCond?.expr).toBe('amount > 50000 && score >= 700');
  });

  it('emits an explanation node for the /// doc comment above the class + a describes edge', async () => {
    const { nodes, edges } = await run();
    const classId = idFor({
      kind: 'symbol',
      path: PATH,
      qualifiedName: 'Crib.LoanRuleEngine.LoanRuleService',
      startLine: 7,
    });
    const explId = idFor({ kind: 'explanation', path: PATH, startLine: 3 });
    const expl = nodes.find((n) => n.id === explId);
    expect(expl?.kind).toBe('explanation');
    expect(String(expl?.meta?.text ?? '')).toContain('Loan rule engine');
    const describes = edges.find(
      (e) => e.rel === 'describes' && e.src === explId && e.dst === classId,
    );
    expect(describes).toBeDefined();
  });

  it('is id-stable: re-running yields byte-identical output', async () => {
    const a = await run();
    const b = await run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
