import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newManifest } from '../manifest.js';
import { SoulStore } from '../soul-store.js';
import { buildDossiersByScope } from './by-scope.js';

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
      { name: 'C_THRESHOLD_AUTO_REJECT', dataType: 'NUMBER', init: '30', constant: true },
      { name: 'C_THRESHOLD_AUTO_APPROVE', dataType: 'NUMBER', init: '80', constant: true },
    ],
  },
});
const doWork = sym(BODY, 'pkg.DO_WORK', 10, { type: 'procedure' });
const specOnly = sym(PKG, 'pkg.SPEC_ONLY', 20, { type: 'function' });
const helper = sym(BODY, 'pkg.HELPER', 30, { type: 'procedure' });
const selStmt = stmt(BODY, 12, 'select', 'select * from app.loans where id = :1');
const loans = table('app', 'loans', 'src/loans.sql');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-byscope-repo-'));
  crib = mkdtempSync(join(tmpdir(), 'crib-byscope-crib-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, PKG), '-- spec\n');
  writeFileSync(join(repo, BODY), `${'\n'.repeat(9)}-- body\n`);
  soul = new SoulStore(crib, { manifest: newManifest({ now: NOW, root: repo }) });
  soul.load();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(crib, { recursive: true, force: true });
});

describe('buildDossiersByScope — pure over soul + repoRoot', () => {
  it('returns undefined when the scope node cannot be resolved', () => {
    soul.putNodes([pkg, doWork]);
    soul.commit(NOW);
    expect(buildDossiersByScope(soul, repo, 'package', 'NOPE', NOW)).toBeUndefined();
    // a package id passed as a file scope → not a file node
    expect(buildDossiersByScope(soul, repo, 'file', pkg.id, NOW)).toBeUndefined();
  });

  it('enumerates package members by qualifiedName / name / id and builds a dossier per symbol', () => {
    soul.putNodes([pkg, doWork, specOnly, helper, selStmt, loans]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(specOnly.id, pkg.id, 'member-of'),
      edge(helper.id, pkg.id, 'member-of'),
      edge(doWork.id, selStmt.id, 'executes'),
      edge(selStmt.id, loans.id, 'reads'),
      // an inter-member call so callees/callers are populated from the shared adjacency
      edge(doWork.id, helper.id, 'calls'),
    ]);
    soul.commit(NOW);

    const byQ = buildDossiersByScope(soul, repo, 'package', 'pkg', NOW)!;
    expect(byQ).toBeDefined();
    expect(byQ.scope).toBe('package');
    expect(byQ.id).toBe(pkg.id);
    expect(byQ.label).toBe('pkg');
    expect(byQ.symbolCount).toBe(3);
    expect(byQ.truncated).toBe(false);
    expect(byQ.symbols).toHaveLength(3);
    expect(byQ.skipped).toEqual([]);
    // members sorted top-to-bottom by source line: DO_WORK(10), SPEC_ONLY(20), HELPER(30)
    expect(byQ.symbols.map((d) => d.node.qualifiedName)).toEqual([
      'pkg.DO_WORK',
      'pkg.SPEC_ONLY',
      'pkg.HELPER',
    ]);

    // each dossier carries the full per-symbol shape (callers/callees/rules/implementation)
    const dw = byQ.symbols.find((d) => d.node.qualifiedName === 'pkg.DO_WORK')!;
    expect(dw.implementation?.status).toBe('implemented');
    expect(dw.implementation?.executesCount).toBe(1);
    expect(dw.callees.map((c) => c.qualifiedName)).toContain('pkg.HELPER');
    expect(dw.rules).toBeDefined();
    // the package node (with its CONSTANT thresholds) is NOT a per-member dossier; it surfaces its
    // own variables only when it is itself a symbol in scope. Here members are the callables.
    expect(dw.node.qualifiedName).toBe('pkg.DO_WORK');

    const helperD = byQ.symbols.find((d) => d.node.qualifiedName === 'pkg.HELPER')!;
    expect(helperD.callers.map((c) => c.qualifiedName)).toContain('pkg.DO_WORK');
    expect(helperD.implementation?.status).toBe('unimplemented'); // zero executes

    // resolves by bare name and by id too
    expect(buildDossiersByScope(soul, repo, 'package', doWork.id, NOW)).toBeUndefined(); // not a package
    const byId = buildDossiersByScope(soul, repo, 'package', pkg.id, NOW)!;
    expect(byId.symbolCount).toBe(3);
  });

  it('caps at maxSymbols and flags truncated + symbolCount (honesty)', () => {
    soul.putNodes([pkg, doWork, specOnly, helper]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(specOnly.id, pkg.id, 'member-of'),
      edge(helper.id, pkg.id, 'member-of'),
    ]);
    soul.commit(NOW);
    const r = buildDossiersByScope(soul, repo, 'package', 'pkg', NOW, { maxSymbols: 2 })!;
    expect(r.symbols).toHaveLength(2);
    expect(r.symbolCount).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('enumerates a file scope: every symbol whose file matches the file node path', () => {
    soul.putNodes([pkg, doWork, helper, specOnly, selStmt, loans]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(specOnly.id, pkg.id, 'member-of'),
      edge(helper.id, pkg.id, 'member-of'),
      edge(doWork.id, selStmt.id, 'executes'),
      edge(selStmt.id, loans.id, 'reads'),
    ]);
    soul.commit(NOW);

    // file node for the body file
    const bodyFileNode: Node = {
      id: `file:${BODY}`,
      kind: 'file',
      file: BODY,
      hash: contentHash(`file:${BODY}`),
    };
    soul.putNodes([bodyFileNode]);
    soul.commit(NOW);

    const r = buildDossiersByScope(soul, repo, 'file', BODY, NOW)!;
    expect(r).toBeDefined();
    expect(r.scope).toBe('file');
    expect(r.id).toBe(`file:${BODY}`);
    expect(r.label).toBe(BODY);
    // symbols whose file === BODY: DO_WORK + HELPER + selStmt (loans has file loans.sql, pkg has PKG)
    const qs = r.symbols.map((d) => d.node.qualifiedName ?? d.node.name).sort();
    expect(qs).toEqual(['pkg.DO_WORK', 'pkg.HELPER'].sort());
    // statements are NOT symbols → not enumerated
    expect(r.symbols.find((d) => d.node.kind === 'statement')).toBeUndefined();
  });

  it('extractedOnly drops INFERRED edges from every dossier (trust filter, shared path)', () => {
    soul.putNodes([pkg, doWork, helper]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(helper.id, pkg.id, 'member-of'),
      // an INFERRED call edge (should be dropped under extractedOnly)
      edge(doWork.id, helper.id, 'calls', { provenance: 'INFERRED', confidence: 0.4 }),
    ]);
    soul.commit(NOW);

    const all = buildDossiersByScope(soul, repo, 'package', 'pkg', NOW)!;
    const dwAll = all.symbols.find((d) => d.node.qualifiedName === 'pkg.DO_WORK')!;
    expect(dwAll.callees.map((c) => c.qualifiedName)).toContain('pkg.HELPER');

    const ex = buildDossiersByScope(soul, repo, 'package', 'pkg', NOW, {
      extractedOnly: true,
    })!;
    const dwEx = ex.symbols.find((d) => d.node.qualifiedName === 'pkg.DO_WORK')!;
    expect(dwEx.callees.map((c) => c.qualifiedName)).not.toContain('pkg.HELPER');
  });

  it('enumerates a cluster scope: symbols sharing the cluster id, resolved by slug or c:<id>', () => {
    // two symbols tagged to a cluster "rule-evaluators"; a third untagged (excluded)
    const evalA = sym(BODY, 'pkg.EVAL_A', 40, { clusterId: 'c:rule-evaluators' });
    const evalB = sym(BODY, 'pkg.EVAL_B', 50, { clusterId: 'c:rule-evaluators' });
    const other = sym(BODY, 'pkg.OTHER', 60);
    const clusterNode: Node = {
      id: 'c:rule-evaluators',
      kind: 'cluster',
      label: 'Rule Evaluators',
      hash: contentHash('c:rule-evaluators'),
    };
    soul.putNodes([pkg, doWork, evalA, evalB, other, clusterNode]);
    soul.putEdges([
      edge(doWork.id, pkg.id, 'member-of'),
      edge(evalA.id, pkg.id, 'member-of'),
      edge(evalB.id, pkg.id, 'member-of'),
      edge(other.id, pkg.id, 'member-of'),
    ]);
    soul.commit(NOW);

    // resolve by slug (no c: prefix)
    const bySlug = buildDossiersByScope(soul, repo, 'cluster', 'rule-evaluators', NOW)!;
    expect(bySlug).toBeDefined();
    expect(bySlug.scope).toBe('cluster');
    expect(bySlug.id).toBe('c:rule-evaluators');
    expect(bySlug.label).toBe('Rule Evaluators');
    expect(bySlug.symbolCount).toBe(2);
    expect(bySlug.symbols.map((d) => d.node.qualifiedName).sort()).toEqual([
      'pkg.EVAL_A',
      'pkg.EVAL_B',
    ]);
    // untagged symbol excluded
    expect(bySlug.symbols.find((d) => d.node.qualifiedName === 'pkg.OTHER')).toBeUndefined();

    // resolve by full c:<slug> id too
    const byId = buildDossiersByScope(soul, repo, 'cluster', 'c:rule-evaluators', NOW)!;
    expect(byId.symbolCount).toBe(2);

    // truncation: maxSymbols caps the cluster members
    const capped = buildDossiersByScope(soul, repo, 'cluster', 'rule-evaluators', NOW, {
      maxSymbols: 1,
    })!;
    expect(capped.symbols).toHaveLength(1);
    expect(capped.symbolCount).toBe(2);
    expect(capped.truncated).toBe(true);

    // unknown cluster slug → undefined (NOT_FOUND at verb layer)
    expect(buildDossiersByScope(soul, repo, 'cluster', 'nope', NOW)).toBeUndefined();
  });

  it('resolves a file scope from a `file:`-prefixed id as well as a bare path', () => {
    soul.putNodes([pkg, doWork, helper]);
    soul.putEdges([edge(doWork.id, pkg.id, 'member-of'), edge(helper.id, pkg.id, 'member-of')]);
    const bodyFileNode: Node = {
      id: `file:${BODY}`,
      kind: 'file',
      file: BODY,
      hash: contentHash(`file:${BODY}`),
    };
    soul.putNodes([bodyFileNode]);
    soul.commit(NOW);

    // bare path
    const byPath = buildDossiersByScope(soul, repo, 'file', BODY, NOW)!;
    expect(byPath.symbolCount).toBe(2); // DO_WORK + HELPER
    // explicit file: prefix → same resolution
    const byPrefix = buildDossiersByScope(soul, repo, 'file', `file:${BODY}`, NOW)!;
    expect(byPrefix.id).toBe(byPath.id);
    expect(byPrefix.symbolCount).toBe(2);
  });
});
