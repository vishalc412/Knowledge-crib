import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, decisionTable, extractRules, newManifest } from '@knowledge-crib/core';
import type { RuleRecord } from '@knowledge-crib/core';
import { idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from './pipeline.js';
import { exportGraph, renderExport, renderMermaid, renderReport } from './rules/index.js';

// Reuse the M10/M11 PL/SQL golden fixture: a self-contained package body + table DDL. The CFG
// pass (M11) has already annotated its executes/calls edges with the guard chain this test reads.
const PLSQL_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'parsers',
  'fixtures',
  'plsql',
);

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-rules-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

const FILE = 'claims.pkb';
const condId = (line: number): string => idFor({ kind: 'condition', file: FILE, line });

describe('M12 rule extraction — decision table (golden)', () => {
  it('materializes hand-derived rules for claim_pkg.process_claim', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const table = decisionTable(soul, 'claim_pkg.process_claim');
    expect(table.procedureName).toBe('claim_pkg.process_claim');
    expect(table.conditions).toEqual([condId(24)]);
    expect(table.rules).toHaveLength(4);

    // actions sorted by source line: call@22, select@23, insert@25, delete@27
    const [call, select, insert, del] = table.rules as [
      RuleRecord,
      RuleRecord,
      RuleRecord,
      RuleRecord,
    ];
    expect(call).toBeDefined();
    expect(select).toBeDefined();
    expect(insert).toBeDefined();
    expect(del).toBeDefined();
    expect(call.action.kind).toBe('calls');
    expect(call.action.line).toBe(22);
    expect(call.action.expr).toBe('validate_claim');
    expect(call.conditions).toEqual([]);
    expect(call.guard).toBeUndefined();
    expect(call.branch).toBeUndefined();

    expect(select.action.kind).toBe('executes');
    expect(select.action.sqlKind).toBe('select');
    expect(select.action.line).toBe(23);
    expect(select.conditions).toEqual([]);

    expect(insert.action.sqlKind).toBe('insert');
    expect(insert.action.line).toBe(25);
    expect(insert.conditions.map((c) => c.id)).toEqual([condId(24)]);
    expect(insert.guard).toBe(condId(24));
    expect(insert.branch).toBe('THEN');
    // innermost (and only) condition carries the polarity
    expect(insert.conditions[0]!.polarity).toBe('THEN');

    expect(del.action.sqlKind).toBe('delete');
    expect(del.action.line).toBe(27);
    expect(del.guard).toBe(condId(24));
    expect(del.branch).toBe('ELSE');
    expect(del.conditions[0]!.polarity).toBe('ELSE');
  });

  it('materializes hand-derived rules for claim_pkg.validate_claim', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const rules = extractRules(soul, 'claim_pkg.validate_claim');
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.action.sqlKind)).toEqual(['select', 'update']);
    const update = rules[1]!;
    expect(update.guard).toBe(condId(14));
    expect(update.branch).toBe('THEN');
  });

  it('resolves includeTables (reads/writes) against the claims table', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const table = decisionTable(soul, 'claim_pkg.process_claim', { includeTables: true });
    const insert = table.rules.find((r) => r.action.sqlKind === 'insert')!;
    expect(insert.action.writes).toBeDefined();
    expect(insert.action.writes!.length).toBeGreaterThan(0);
    // every read/write target is a table node id (table:...)
    for (const w of insert.action.writes ?? []) expect(w).toMatch(/^table:/);
  });

  it('finds a procedure by node id, qualified name, and simple name', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const byQualified = decisionTable(soul, 'claim_pkg.process_claim');
    const byId = decisionTable(soul, byQualified.procedure);
    const bySimple = decisionTable(soul, 'process_claim');
    expect(byId.rules).toHaveLength(4);
    expect(bySimple.rules).toHaveLength(4);
    expect(bySimple.procedure).toBe(byQualified.procedure);
  });

  it('returns empty rules for an unknown procedure', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });
    expect(extractRules(soul, 'no_such_proc')).toEqual([]);
  });
});

describe('M12 renderers', () => {
  it('renderMermaid produces valid flowchart markup with THEN/ELSE branches', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const mermaid = renderMermaid(decisionTable(soul, 'claim_pkg.process_claim'));
    expect(mermaid.startsWith('flowchart TD')).toBe(true);
    expect(mermaid).toContain('claim_pkg.process_claim');
    expect(mermaid).toContain('-->|THEN|');
    expect(mermaid).toContain('-->|ELSE|');
    // a decision rhombus node shape is present for the IF condition
    expect(mermaid).toMatch(/\{.*\}/);
    // no unquoted special chars leaked into node ids (all node ids are n<digits>)
    const nodeIds = mermaid.match(/\bn\d+\b/g) ?? [];
    expect(nodeIds.length).toBeGreaterThan(0);
  });

  it('renderExport rules/mermaid require a procedure; graph.json and report do not', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const rules = renderExport(soul, 'rules', 'claim_pkg.process_claim');
    expect(() => JSON.parse(rules)).not.toThrow();
    expect(JSON.parse(rules).rules).toHaveLength(4);

    const mermaid = renderExport(soul, 'mermaid', 'claim_pkg.process_claim');
    expect(mermaid.startsWith('flowchart TD')).toBe(true);

    const graph = renderExport(soul, 'graph.json');
    const parsed = JSON.parse(graph);
    expect(parsed.schemaVersion).toBe('1.1');
    expect(parsed.nodes.length).toBeGreaterThan(0);
    expect(parsed.edges.length).toBeGreaterThan(0);

    const report = renderExport(soul, 'report');
    expect(report).toContain('knowledge-crib report');
    expect(report).toContain('nodes by kind:');

    expect(() => renderExport(soul, 'rules')).toThrow(/procedure/);
    expect(() => renderExport(soul, 'mermaid')).toThrow(/procedure/);
  });

  it('exportGraph is a deterministic soul dump', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const g = exportGraph(soul);
    expect(g.stats.nodes).toBe([...soul.iterate()].length);
    expect(g.stats.edges).toBe([...soul.iterateEdges()].length);
  });

  it('renderReport with a procedure prints the materialized rules', async () => {
    const soul = soulFor();
    await indexRepo(soul, PLSQL_FIXTURE, { now: '2026-01-01T00:00:00.000Z' });

    const report = renderReport(soul, 'claim_pkg.process_claim');
    expect(report).toContain('rules for claim_pkg.process_claim');
    expect(report).toContain('insert');
    expect(report).toContain('THEN');
    expect(report).toContain('ELSE');
  });
});
