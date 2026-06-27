import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoulStore, newManifest } from '@knowledge-crib/core';
import type { Node } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexRepo } from '../pipeline.js';

const SQL_CROSS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'sql-cross',
);
const SQL_DATAFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'sql-dataflow',
);
const MIXED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'mixed');

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
const SQL_FILE_EXTS = ['.sql', '.pkb', '.pks', '.pck', '.pls', '.pkh', '.typ'];

let cribDir: string;
function soulFor(): SoulStore {
  const s = new SoulStore(cribDir, { manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }) });
  s.load();
  return s;
}

beforeEach(() => {
  cribDir = mkdtempSync(join(tmpdir(), 'crib-sql-'));
});
afterEach(() => rmSync(cribDir, { recursive: true, force: true }));

describe('SqlResolver — cross-file SQL data-flow (M10 gate)', () => {
  it('resolves statement→table reads/writes across files against the schema catalog', async () => {
    const soul = soulFor();
    await indexRepo(soul, SQL_CROSS, { now: '2026-01-01T00:00:00.000Z' });

    const tables = [...soul.iterate('table')].map((n) => n.name).sort();
    expect(tables).toEqual(['audit_log', 'claims']);

    // reads: the SELECT in claim_pkg.process_claim → claims (table declared in schema.sql)
    const reads = [...soul.iterateEdges('reads')].map((e) => pair(soul, e.src, e.dst));
    // writes: UPDATE claims (process_claim) + INSERT audit_log (log_event)
    const writes = [...soul.iterateEdges('writes')].map((e) => pair(soul, e.src, e.dst)).sort();

    expect(reads).toContain('stmt:claim_pkg.pkb:select -> table:claims');
    expect(writes).toEqual(
      [
        'stmt:audit_pkg.pkb:insert -> table:audit_log',
        'stmt:claim_pkg.pkb:update -> table:claims',
      ].sort(),
    );

    // every resolved edge is EXTRACTED/static/confidence 1 (no guessing)
    for (const e of soul.iterateEdges('reads')) expectEdge(e);
    for (const e of soul.iterateEdges('writes')) expectEdge(e);
  });

  it('resolves procedure→procedure calls across files (process_claim → audit_pkg.log_event)', async () => {
    const soul = soulFor();
    await indexRepo(soul, SQL_CROSS, { now: '2026-01-01T00:00:00.000Z' });

    const calls = [...soul.iterateEdges('calls')].map((e) => pair(soul, e.src, e.dst)).sort();
    expect(calls).toContain('sym:claim_pkg.process_claim -> sym:audit_pkg.log_event');
    for (const e of soul.iterateEdges('calls')) expectEdge(e);
  });

  it('never emits an edge whose endpoint node does not exist (pruneDangling-safe)', async () => {
    const soul = soulFor();
    await indexRepo(soul, SQL_CROSS, { now: '2026-01-01T00:00:00.000Z' });
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });

  it('keeps extractor + resolver edges consistent (executes, guarded-by, member-of still present)', async () => {
    const soul = soulFor();
    await indexRepo(soul, SQL_CROSS, { now: '2026-01-01T00:00:00.000Z' });
    // extractor-emitted intra-file edges survive the resolver pass
    expect([...soul.iterateEdges('executes')].length).toBeGreaterThan(0);
    expect([...soul.iterateEdges('guarded-by')].length).toBeGreaterThan(0);
    expect([...soul.iterateEdges('member-of')].length).toBeGreaterThan(0);
    // a condition node exists for the IF in process_claim
    const conds = [...soul.iterate('condition')];
    expect(conds.length).toBeGreaterThan(0);
  });
});

describe('Mixed TS + SQL indexRepo — no cross-talk (M10 gate)', () => {
  it('indexes both languages in one repo without cross-language edges', async () => {
    const soul = soulFor();
    const report = await indexRepo(soul, MIXED, { now: '2026-01-01T00:00:00.000Z' });

    // both language families are present
    const tsSyms = [...soul.iterate('symbol')].filter((n) => n.lang === 'typescript');
    const sqlSyms = [...soul.iterate('symbol')].filter((n) => n.lang === 'plsql');
    const sqlTables = [...soul.iterate('table')];
    expect(tsSyms.some((n) => n.qualifiedName === 'greet')).toBe(true);
    expect(sqlSyms.some((n) => n.qualifiedName === 'event_pkg.record')).toBe(true);
    expect(sqlTables.map((n) => n.name)).toEqual(['events']);

    // TS files produce no reads/writes/executes/calls-into-SQL; SQL files produce no imports.
    // Assert by endpoint SOURCE FILE family: no edge connects a node in app.ts to a node in a
    // .sql file (or vice-versa). (File nodes carry lang='sql' but symbols lang='plsql' — same SQL
    // source — so classify by the file extension the node lives in, not by `lang`.)
    const allNodes = [...soul.iterate()];
    const famOf = (id: string): 'ts' | 'sql' | undefined => {
      const n = allNodes.find((x) => x.id === id);
      const f = n?.file;
      if (!f) return undefined;
      if (TS_EXTS.some((e) => f.endsWith(e))) return 'ts';
      if (SQL_FILE_EXTS.some((e) => f.endsWith(e))) return 'sql';
      return undefined;
    };
    let crossTalk = 0;
    for (const e of soul.iterateEdges()) {
      const sf = famOf(e.src);
      const df = famOf(e.dst);
      if (sf && df && sf !== df) crossTalk++;
    }
    expect(crossTalk).toBe(0);

    // every edge endpoint exists; the resolver dropped nothing it should have kept (TS imports resolve
    // within the single TS file or drop; SQL refs resolve to the local table).
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
    // report resolves without throwing and carries both resolver stat families
    expect(report.resolve).toBeDefined();
  });
});

describe('SqlResolver — WS-7 cross-file cursor reads + FK references', () => {
  it('resolves a cursor SELECT → table read across files (cursor in .pkb, table in loans.sql)', async () => {
    const soul = soulFor();
    await indexRepo(soul, SQL_DATAFLOW, { now: '2026-01-01T00:00:00.000Z' });

    // the cursor node carries its row-source table on meta.tables
    const cur = [...soul.iterate('cursor')].find((n) => n.name === 'c_app')!;
    expect(cur).toBeDefined();
    expect(cur.meta?.tables).toEqual(['loan_applications']);

    // cross-file cursor read: cursor (in loan_pkg.pkb) -> loan_applications (in loans.sql)
    const cursorReads = [...soul.iterateEdges('reads')]
      .filter((e) => soul.getNode(e.src)?.kind === 'cursor')
      .map((e) => pair(soul, e.src, e.dst));
    expect(cursorReads).toContain('cursor:loan_pkg.pkb:c_app -> table:loan_applications');

    // the body UPDATE writes loan_applications (cross-file, same catalog resolution path)
    const writes = [...soul.iterateEdges('writes')].map((e) => pair(soul, e.src, e.dst));
    expect(writes).toContain('stmt:loan_pkg.pkb:update -> table:loan_applications');

    for (const e of soul.iterateEdges('reads')) expectEdge(e);
    for (const e of soul.iterateEdges('writes')) expectEdge(e);
  });

  it('resolves a cross-file FK REFERENCES child table → parent table (parent in applicants.sql)', async () => {
    const soul = soulFor();
    await indexRepo(soul, SQL_DATAFLOW, { now: '2026-01-01T00:00:00.000Z' });

    // the child table carries its FK on meta.foreignKeys
    const child = [...soul.iterate('table')].find((n) => n.name === 'loan_applications')!;
    expect(child.meta?.foreignKeys).toEqual([
      { columns: ['applicant_id'], refTable: 'applicants', refColumns: ['id'] },
    ]);

    // cross-file references edge: child (loans.sql) -> parent (applicants.sql)
    const refs = [...soul.iterateEdges('references')].map((e) => pair(soul, e.src, e.dst));
    expect(refs).toEqual(['table:loan_applications -> table:applicants']);
    for (const e of soul.iterateEdges('references')) expectEdge(e);
  });

  it('never emits a dangling edge for the data-flow fixture (pruneDangling-safe)', async () => {
    const soul = soulFor();
    await indexRepo(soul, SQL_DATAFLOW, { now: '2026-01-01T00:00:00.000Z' });
    const ids = new Set([...soul.iterate()].map((n) => n.id));
    for (const e of soul.iterateEdges()) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });
});

// --- helpers ---

function pair(soul: SoulStore, srcId: string, dstId: string): string {
  return `${label(soul, srcId)} -> ${label(soul, dstId)}`;
}

function label(soul: SoulStore, id: string): string {
  const n: Node | undefined = [...soul.iterate()].find((x) => x.id === id);
  if (!n) return id;
  switch (n.kind) {
    case 'symbol':
      return `sym:${n.qualifiedName ?? n.name}`;
    case 'table':
      return `table:${n.name}`;
    case 'column':
      return `col:${n.table}.${n.name}`;
    case 'statement':
      return `stmt:${shortFile(n.file)}:${n.sqlKind ?? n.type}`;
    case 'cursor':
      return `cursor:${shortFile(n.file)}:${n.name}`;
    case 'condition':
      return `cond:${shortFile(n.file)}:L${n.span?.start}`;
    default:
      return n.kind;
  }
}

function shortFile(p: string | undefined): string {
  return p ? (p.split('/').pop() ?? p) : '?';
}

function expectEdge(e: { provenance: string; method: string; confidence: number }): void {
  expect(e.provenance).toBe('EXTRACTED');
  expect(e.method).toBe('static');
  expect(e.confidence).toBe(1);
}
