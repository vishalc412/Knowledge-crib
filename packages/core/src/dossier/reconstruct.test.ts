import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newManifest } from '../manifest.js';
import { SoulStore } from '../soul-store.js';
import { buildReconstruction, reconstructionToMarkdown } from './reconstruct.js';

let repo: string;
let crib: string;
let soul: SoulStore;

const NOW = '2026-01-01T00:00:00.000Z';

function sym(path: string, q: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: q, startLine: line }),
    kind: 'symbol',
    type: 'procedure',
    name: q.split('.').pop() ?? q,
    qualifiedName: q,
    file: path,
    span: { start: line, end: line + 3 },
    lang: 'plsql',
    hash: contentHash(q),
    ...extra,
  };
}

function stmt(path: string, line: number, sqlKind: string, expr: string): Node {
  return {
    id: idFor({ kind: 'statement', file: path, line }),
    kind: 'statement',
    type: 'statement',
    sqlKind,
    expr,
    file: path,
    span: { start: line, end: line },
    lang: 'plsql',
    hash: contentHash(`${path}:${line}:statement`),
  };
}

function table(schema: string, name: string, file: string): Node {
  return {
    id: idFor({ kind: 'table', schema, name }),
    kind: 'table',
    schema,
    name,
    file,
    hash: contentHash(`${schema}.${name}`),
  };
}

function doc(path: string, anchor: string, heading: string, spanStart: number): Node {
  return {
    id: idFor({ kind: 'doc-section', path, anchor }),
    kind: 'doc-section',
    heading,
    anchor,
    file: path,
    span: { start: spanStart, end: spanStart },
    hash: contentHash(`${path}:${anchor}`),
  };
}

function edge(src: string, dst: string, rel: Rel, over: Partial<Edge> = {}): Edge {
  return {
    id: edgeId(src, dst, rel),
    src,
    dst,
    rel,
    method: 'static',
    provenance: 'EXTRACTED',
    confidence: 1,
    ...over,
  };
}

const PKG = 'src/pkg_spec.sql';
const BODY = 'src/pkg_body.sql';
const pkg = sym(PKG, 'pkg', 5, {
  type: 'package',
  meta: {
    variables: [
      { name: 'C_RULE_PASSED', dataType: 'VARCHAR2(20)', init: "'PASSED'", constant: true },
      { name: 'C_THRESHOLD_AUTO_REJECT', dataType: 'NUMBER', init: '30', constant: true },
      { name: 'C_THRESHOLD_AUTO_APPROVE', dataType: 'NUMBER', init: '80', constant: true },
      { name: 'g_default_limit', dataType: 'NUMBER', init: '1000' },
    ],
  },
});
const doWork = sym(BODY, 'pkg.DO_WORK', 10, { type: 'procedure', file: BODY });
const specOnly = sym(PKG, 'pkg.SPEC_ONLY', 20, { type: 'function' });
const selStmt = stmt(BODY, 12, 'select', 'select * from app.loans where id = :1');
const updStmt = stmt(BODY, 13, 'update', 'update app.audits set status = 1');
const loans = table('app', 'loans', 'src/loans.sql');
const audits = table('app', 'audits', 'src/audits.sql');
const pkgDoc = doc('docs/ARCH.md', 'overview', 'Package overview', 1);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-reconstruct-repo-'));
  crib = mkdtempSync(join(tmpdir(), 'crib-reconstruct-crib-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, PKG), '-- spec\n');
  writeFileSync(join(repo, BODY), `${'\n'.repeat(9)}-- body\n`);
  writeFileSync(join(repo, 'docs/ARCH.md'), '# Package overview\npkg does the work\n');
  soul = new SoulStore(crib, { manifest: newManifest({ now: NOW, root: repo }) });
  soul.load();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(crib, { recursive: true, force: true });
});

describe('buildReconstruction — pure over soul + repoRoot', () => {
  it('returns undefined for a non-package / unknown id (reconstruct is package-scoped)', () => {
    soul.putNodes([pkg, doWork]);
    soul.commit(NOW);
    expect(buildReconstruction(soul, repo, doWork.id, NOW)).toBeUndefined();
    expect(buildReconstruction(soul, repo, 'sym:src/missing#Nope@L1', NOW)).toBeUndefined();
  });

  it('assembles constants, variables, members, referenced tables, docs + expectedBodyFile', () => {
    soul.putNodes([pkg, doWork, specOnly, selStmt, updStmt, loans, audits, pkgDoc]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(specOnly.id, pkg.id, 'member-of'),
      edge(doWork.id, selStmt.id, 'executes'),
      edge(doWork.id, updStmt.id, 'executes'),
      edge(selStmt.id, loans.id, 'reads'),
      edge(updStmt.id, audits.id, 'writes'),
      edge(pkgDoc.id, pkg.id, 'describes', { confidence: 0.95 }),
    ]);
    soul.commit(NOW);

    const r = buildReconstruction(soul, repo, pkg.id, NOW)!;
    expect(r).toBeDefined();
    expect(r.id).toBe(pkg.id);
    expect(r.schemaVersion).toBe(soul.getManifest().schemaVersion);
    expect(r.nodeHash).toBe(pkg.hash);
    expect(r.expectedBodyFile).toBe('src/pkg_body.sql');

    // constants: only CONSTANT entries; 30/80 survive
    expect(r.constants.map((c) => c.name)).toEqual([
      'C_RULE_PASSED',
      'C_THRESHOLD_AUTO_REJECT',
      'C_THRESHOLD_AUTO_APPROVE',
    ]);
    expect(r.constants).toContainEqual({
      name: 'C_THRESHOLD_AUTO_REJECT',
      dataType: 'NUMBER',
      init: '30',
      constant: true,
    });
    expect(r.constants).toContainEqual({
      name: 'C_THRESHOLD_AUTO_APPROVE',
      dataType: 'NUMBER',
      init: '80',
      constant: true,
    });

    // variables: ALL four (constants + the plain default)
    expect(r.variables.map((v) => v.name)).toEqual([
      'C_RULE_PASSED',
      'C_THRESHOLD_AUTO_REJECT',
      'C_THRESHOLD_AUTO_APPROVE',
      'g_default_limit',
    ]);

    // members: implemented DO_WORK (2 executes, rulesCount=2) + unimplemented SPEC_ONLY (0)
    expect(r.members).toHaveLength(2);
    const doWorkM = r.members.find((m) => m.qualifiedName === 'pkg.DO_WORK')!;
    expect(doWorkM.implementation).toEqual({
      status: 'implemented',
      executesCount: 2,
      referencedByFiles: [],
    });
    expect(doWorkM.rulesCount).toBe(2); // 2 executes edges (no calls)
    const specOnlyM = r.members.find((m) => m.qualifiedName === 'pkg.SPEC_ONLY')!;
    expect(specOnlyM.implementation.status).toBe('unimplemented');
    expect(specOnlyM.implementation.executesCount).toBe(0);

    // referenced tables: loans read by DO_WORK, audits written by DO_WORK
    expect(r.referencedTables).toHaveLength(2);
    const loansT = r.referencedTables.find((t) => t.name === 'app.loans')!;
    expect(loansT.readBy).toEqual(['pkg.DO_WORK']);
    expect(loansT.writtenBy).toEqual([]);
    const auditsT = r.referencedTables.find((t) => t.name === 'app.audits')!;
    expect(auditsT.writtenBy).toEqual(['pkg.DO_WORK']);
    expect(auditsT.readBy).toEqual([]);

    // docs: the describes edge → package
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0]!.edgeType).toBe('describes');
    expect(r.docs[0]!.target).toBe('pkg');

    expect(r.memberCount).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.shapeVersion).toBe(1);
  });

  it('caps members at maxSymbols and flags truncated (honesty)', () => {
    soul.putNodes([pkg, doWork, specOnly]);
    soul.putEdges([edge(doWork.id, pkg.id, 'member-of'), edge(specOnly.id, pkg.id, 'member-of')]);
    soul.commit(NOW);
    const r = buildReconstruction(soul, repo, pkg.id, NOW, {
      maxSymbols: 1,
      includeTables: false,
    })!;
    expect(r.members).toHaveLength(1);
    expect(r.memberCount).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it('omits referencedTables when includeTables:false, computes them when true', () => {
    soul.putNodes([pkg, doWork, selStmt, loans]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(doWork.id, selStmt.id, 'executes'),
      edge(selStmt.id, loans.id, 'reads'),
    ]);
    soul.commit(NOW);
    const off = buildReconstruction(soul, repo, pkg.id, NOW, { includeTables: false })!;
    expect(off.referencedTables).toEqual([]);
    const on = buildReconstruction(soul, repo, pkg.id, NOW, { includeTables: true })!;
    expect(on.referencedTables.find((t) => t.name === 'app.loans')).toBeDefined();
  });

  it('surfaces a cursor-only read in referencedTables.readBy (declares → cursor → reads, WS-7)', () => {
    // a procedure whose ONLY read of a table is via a cursor SELECT (no direct DML read). Plan B
    // sees the cursor SELECT in the body; Plan A must surface the table as readBy too. The cursor
    // is declared by the member (declares: member → cursor) and its read fans out cursor → table.
    const cur: Node = {
      id: idFor({ kind: 'cursor', file: BODY, name: 'c_app', line: 11 }),
      kind: 'cursor',
      name: 'c_app',
      file: BODY,
      span: { start: 11, end: 11 },
      lang: 'plsql',
      hash: contentHash('cursor:c_app'),
      cursorQuery: 'SELECT amount FROM app.loans WHERE id = :1',
      meta: { tables: ['app.loans'] },
    };
    soul.putNodes([pkg, doWork, cur, loans]);
    // member-of + declares + the cursor's read (NO executes → reads from a statement)
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(doWork.id, cur.id, 'declares'),
      edge(cur.id, loans.id, 'reads'),
    ]);
    soul.commit(NOW);

    const r = buildReconstruction(soul, repo, pkg.id, NOW, { includeTables: true })!;
    // the member is implemented? declares is NOT executes, so executesCount=0 → unimplemented.
    const dw = r.members.find((m) => m.qualifiedName === 'pkg.DO_WORK')!;
    expect(dw.implementation.executesCount).toBe(0);
    // ...but the table IS surfaced as readBy the member via the declares→cursor→reads chain
    const loansT = r.referencedTables.find((t) => t.name === 'app.loans')!;
    expect(loansT).toBeDefined();
    expect(loansT.readBy).toEqual(['pkg.DO_WORK']);
    expect(loansT.writtenBy).toEqual([]);
  });
});

describe('reconstructionToMarkdown — deterministic, sections emit only when non-empty', () => {
  it('emits the constants table with 30/80, expectedBodyFile, members, and referenced tables', () => {
    soul.putNodes([pkg, doWork, specOnly, selStmt, updStmt, loans, audits]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(specOnly.id, pkg.id, 'member-of'),
      edge(doWork.id, selStmt.id, 'executes'),
      edge(doWork.id, updStmt.id, 'executes'),
      edge(selStmt.id, loans.id, 'reads'),
      edge(updStmt.id, audits.id, 'writes'),
    ]);
    soul.commit(NOW);
    const r = buildReconstruction(soul, repo, pkg.id, NOW)!;
    const md = reconstructionToMarkdown(r);

    expect(md).toContain('# Reconstruct: pkg');
    expect(md).toContain('- expectedBodyFile: `src/pkg_body.sql`');
    // constants table — 30/80 impossible to miss
    expect(md).toContain('| C_THRESHOLD_AUTO_REJECT | NUMBER | `30` |');
    expect(md).toContain('| C_THRESHOLD_AUTO_APPROVE | NUMBER | `80` |');
    // defaults section surfaces the plain g_default_limit (non-constant with init)
    expect(md).toContain('## Defaults');
    expect(md).toContain('| g_default_limit | NUMBER | `1000` |');
    // members
    expect(md).toContain('pkg.DO_WORK');
    expect(md).toContain('⚠ unimplemented'); // SPEC_ONLY
    // referenced tables
    expect(md).toContain('## Referenced tables');
    expect(md).toContain('app.loans');
    expect(md).toContain('app.audits');
  });

  it('omits the Constants / Referenced tables sections when empty (honesty)', () => {
    const emptyPkg = sym(PKG, 'emptypkg', 5, { type: 'package', meta: { variables: [] } });
    soul.putNodes([emptyPkg]);
    soul.commit(NOW);
    const r = buildReconstruction(soul, repo, emptyPkg.id, NOW, { includeTables: true })!;
    const md = reconstructionToMarkdown(r);
    expect(md).not.toContain('## Constants');
    expect(md).not.toContain('## Defaults');
    expect(md).not.toContain('## Referenced tables');
    expect(md).not.toContain('## Members');
    expect(md).toContain('# Reconstruct: emptypkg');
  });

  it('surfaces exprTruncated on a clipped CONSTANT and flags it in markdown (fidelity honesty)', () => {
    // a CONSTANT whose initializer exceeded the parser fidelity cap → init is the clipped prefix,
    // exprTruncated:true. The reconstruct must carry that flag so a migrator does NOT trust the
    // clipped value as the literal threshold, and the markdown must mark it `⚠ clipped`.
    const longInit = 'X'.repeat(2048); // > the 2000-char fidelity cap
    const clipPkg = sym(PKG, 'clippkg', 5, {
      type: 'package',
      meta: {
        variables: [
          {
            name: 'C_BIG',
            dataType: 'VARCHAR2(4000)',
            init: longInit,
            constant: true,
            exprTruncated: true,
          },
          { name: 'C_THRESHOLD_AUTO_REJECT', dataType: 'NUMBER', init: '30', constant: true },
        ],
      },
    });
    soul.putNodes([clipPkg]);
    soul.commit(NOW);

    const r = buildReconstruction(soul, repo, clipPkg.id, NOW, { includeTables: false })!;
    const big = r.constants.find((c) => c.name === 'C_BIG')!;
    expect(big.exprTruncated).toBe(true);
    expect(big.init).toBe(longInit); // the clipped prefix is carried verbatim
    // the clean threshold is NOT flagged
    const thr = r.constants.find((c) => c.name === 'C_THRESHOLD_AUTO_REJECT')!;
    expect(thr.exprTruncated).toBeUndefined();

    const md = reconstructionToMarkdown(r);
    expect(md).toContain('⚠ clipped');
    // the clean 30 renders WITHOUT the clipped marker
    expect(md).toContain('| C_THRESHOLD_AUTO_REJECT | NUMBER | `30` |');
  });
});
