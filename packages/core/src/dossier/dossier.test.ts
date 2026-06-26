import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newManifest } from '../manifest.js';
import { SoulStore } from '../soul-store.js';
import {
  buildDossier,
  dossierPath,
  dossierToMarkdown,
  dossiersDir,
  readDossier,
  writeDossier,
} from './index.js';

let repo: string;
let crib: string;
let soul: SoulStore;

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
function stmt(path: string, line: number, lang = 'plsql'): Node {
  return {
    id: idFor({ kind: 'statement', file: path, line }),
    kind: 'statement',
    type: 'statement',
    file: path,
    span: { start: line, end: line },
    lang,
    hash: contentHash(`${path}:${line}:statement`),
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

const NOW = '2026-01-01T00:00:00.000Z';
const proc = sym('src/claims.pkb', 'claims.process_claim', 10);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-dossier-repo-'));
  crib = mkdtempSync(join(tmpdir(), 'crib-dossier-crib-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'claims.pkb'),
    `${'\n'.repeat(9)}procedure process_claim is\n  begin\n  update claims set status = 1;\nend;\n`,
  );
  soul = new SoulStore(crib, { manifest: newManifest({ now: NOW, root: repo }) });
  soul.load();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(crib, { recursive: true, force: true });
});

describe('buildDossier — pure over soul + repoRoot', () => {
  it('builds the deep artifact: node + source + rules + controlFlow, with hash + schemaVersion', () => {
    const raise: Node = {
      id: idFor({ kind: 'raise', file: 'src/claims.pkb', line: 12 }),
      kind: 'raise',
      name: 'raise_application_error',
      errorCode: '-20001',
      errorMessage: 'bad claim',
      file: 'src/claims.pkb',
      span: { start: 12, end: 12 },
      lang: 'plsql',
      hash: contentHash('raise-bad-claim'),
    };
    soul.putNodes([proc, raise]);
    soul.putEdges([
      edge(proc.id, raise.id, 'raises'),
      edge(proc.id, idFor({ kind: 'statement', file: 'src/claims.pkb', line: 11 }), 'executes'),
    ]);
    soul.commit(NOW);

    const d = buildDossier(soul, repo, proc.id, NOW, { includeTables: true });
    expect(d).toBeDefined();
    expect(d!.id).toBe(proc.id);
    expect(d!.nodeHash).toBe(proc.hash);
    expect(d!.schemaVersion).toBe(soul.getManifest().schemaVersion);
    expect(d!.node.qualifiedName).toBe('claims.process_claim');
    expect(d!.source.text).toContain('procedure process_claim');
    expect(d!.rules).toBeDefined();
    expect(d!.controlFlow).toBeDefined();
    expect(d!.controlFlow!.raises[0]!.errorCode).toBe('-20001');
  });

  it('returns undefined for an unknown node id', () => {
    expect(buildDossier(soul, repo, 'sym:nope', NOW)).toBeUndefined();
  });

  it('omits rules + controlFlow for a non-callable node', () => {
    const doc: Node = {
      id: idFor({ kind: 'doc-section', path: 'docs/a.md', anchor: 'x' }),
      kind: 'doc-section',
      file: 'docs/a.md',
      heading: 'X',
      anchor: 'x',
      span: { start: 1, end: 2 },
      hash: contentHash('doc-x'),
    };
    soul.putNodes([doc]);
    soul.commit(NOW);
    const d = buildDossier(soul, repo, doc.id, NOW);
    expect(d!.rules).toBeUndefined();
    expect(d!.controlFlow).toBeUndefined();
  });
});

describe('dossier persistence — sharded + atomic + hash-stale', () => {
  it('writeDossier lands at a sharded path under .crib/dossiers/ and is readable', () => {
    soul.putNodes([proc]);
    soul.commit(NOW);
    const d = buildDossier(soul, repo, proc.id, NOW)!;
    writeDossier(crib, d);
    const path = dossierPath(crib, proc.id);
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(dossiersDir(crib))).toBe(true);
    // the file is valid JSON matching the artifact
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as typeof d;
    expect(onDisk.id).toBe(proc.id);
    expect(onDisk.nodeHash).toBe(proc.hash);
  });

  it('readDossier reports fresh when nodeHash + schemaVersion match', () => {
    soul.putNodes([proc]);
    soul.commit(NOW);
    const d = buildDossier(soul, repo, proc.id, NOW)!;
    writeDossier(crib, d);
    const read = readDossier(crib, proc.id, {
      nodeHash: proc.hash,
      schemaVersion: soul.getManifest().schemaVersion,
    });
    expect(read.missing).toBe(false);
    expect(read.stale).toBe(false);
    expect(read.dossier?.id).toBe(proc.id);
  });

  it('readDossier reports missing for a never-built symbol', () => {
    const read = readDossier(crib, 'sym:nope', { schemaVersion: '1.2' });
    expect(read.missing).toBe(true);
    expect(read.stale).toBe(false);
  });

  it('readDossier reports stale when the live node hash diverges (rebuild trigger)', () => {
    soul.putNodes([proc]);
    soul.commit(NOW);
    writeDossier(crib, buildDossier(soul, repo, proc.id, NOW)!);
    // the source node changed (re-extracted with a new hash) → persisted artifact is stale
    const read = readDossier(crib, proc.id, {
      nodeHash: 'blake3:different',
      schemaVersion: soul.getManifest().schemaVersion,
    });
    expect(read.stale).toBe(true);
  });

  it('readDossier reports stale on a schemaVersion bump', () => {
    soul.putNodes([proc]);
    soul.commit(NOW);
    writeDossier(crib, buildDossier(soul, repo, proc.id, NOW)!);
    const read = readDossier(crib, proc.id, {
      nodeHash: proc.hash,
      schemaVersion: '9.9',
    });
    expect(read.stale).toBe(true);
  });
});

describe('dossierToMarkdown — deterministic human/agent projection', () => {
  it('renders behavior-bearing sections (raises, decision table) — the detailed-level view', () => {
    const raise: Node = {
      id: idFor({ kind: 'raise', file: 'src/claims.pkb', line: 12 }),
      kind: 'raise',
      name: 'raise_application_error',
      errorCode: '-20001',
      errorMessage: 'bad claim',
      file: 'src/claims.pkb',
      span: { start: 12, end: 12 },
      lang: 'plsql',
      hash: contentHash('raise-bad-claim'),
    };
    soul.putNodes([proc, raise]);
    soul.putEdges([edge(proc.id, raise.id, 'raises')]);
    soul.commit(NOW);
    const md = dossierToMarkdown(buildDossier(soul, repo, proc.id, NOW)!);
    expect(md).toContain('# claims.process_claim');
    expect(md).toContain('## Source');
    expect(md).toContain('## Raises');
    expect(md).toContain('-20001');
    expect(md).toContain('bad claim');
  });
});

describe('implementation status — the universal "body missing" signal (all languages)', () => {
  it('marks a callable with executes edges as implemented (PL/SQL) + counts body statements', () => {
    const stmt11 = stmt('src/claims.pkb', 11);
    const stmt13 = stmt('src/claims.pkb', 13);
    soul.putNodes([proc, stmt11, stmt13]);
    soul.putEdges([edge(proc.id, stmt11.id, 'executes'), edge(proc.id, stmt13.id, 'executes')]);
    soul.commit(NOW);
    const d = buildDossier(soul, repo, proc.id, NOW)!;
    expect(d.implementation).toBeDefined();
    expect(d.implementation!.status).toBe('implemented');
    expect(d.implementation!.executesCount).toBe(2);
    // markdown surfaces the implemented line, not the warning
    const md = dossierToMarkdown(d);
    expect(md).toContain('## Implementation status');
    expect(md).toContain('Implemented — 2 body statement(s)');
    expect(md).not.toContain('⚠ **Unimplemented**');
  });

  it('marks a spec-only callable (zero executes) unimplemented + emits the loud warning + "referenced everywhere"', () => {
    // PL/SQL spec proc declared but no body file → no executes edges. Two cross-file callers reference
    // it (the "referenced everywhere but missing" signal the loan-rule-engine feedback keys on).
    const specProc = sym('db/PKG.pks', 'PKG.resolve_rules', 3);
    const callerA = sym('db/caller_a.sql', 'caller_a', 5, { type: 'procedure' });
    const callerB = sym('db/caller_b.sql', 'caller_b', 8, { type: 'procedure' });
    soul.putNodes([specProc, callerA, callerB]);
    soul.putEdges([edge(callerA.id, specProc.id, 'calls'), edge(callerB.id, specProc.id, 'calls')]);
    soul.commit(NOW);
    const d = buildDossier(soul, repo, specProc.id, NOW)!;
    expect(d.implementation!.status).toBe('unimplemented');
    expect(d.implementation!.executesCount).toBe(0);
    expect(d.implementation!.referencedByFiles.sort()).toEqual([
      'db/caller_a.sql',
      'db/caller_b.sql',
    ]);
    const md = dossierToMarkdown(d);
    expect(md).toContain('⚠ **Unimplemented**');
    expect(md).toContain('missing file (e.g. a PL/SQL package body)');
    expect(md).toContain('Referenced from 2 file(s): db/caller_a.sql, db/caller_b.sql');
    // Phase 1 — the loud TOP banner gates a plan-building LLM before anything else.
    expect(md).toContain('⛔ **ANALYSIS BLOCKED — body unavailable.**');
    expect(md.indexOf('ANALYSIS BLOCKED')).toBeLessThan(md.indexOf('## Source'));
    // Phase 4 — the coverage self-report reflects readiness=unimplemented with a caveat.
    expect(d.coverage).toBeDefined();
    expect(d.coverage!.readiness).toBe('unimplemented');
    expect(d.coverage!.bodyPresent).toBe(false);
    expect(d.coverage!.caveats.join(' ')).toContain('BODY UNAVAILABLE');
  });

  it('is language-agnostic: a TypeScript method with no body is flagged unimplemented', () => {
    const tsMethod = sym('src/AuthService.ts', 'AuthService.login', 4, {
      type: 'method',
      lang: 'typescript',
    });
    soul.putNodes([tsMethod]);
    soul.commit(NOW);
    const d = buildDossier(soul, repo, tsMethod.id, NOW)!;
    expect(d.implementation!.status).toBe('unimplemented');
    expect(d.implementation!.executesCount).toBe(0);
    expect(dossierToMarkdown(d)).toContain('⚠ **Unimplemented**');
  });

  it('is language-agnostic: a Java method with body statements is implemented', () => {
    const javaMethod = sym('src/Svc.java', 'Svc.handle', 7, {
      type: 'method',
      lang: 'java',
    });
    const stmt9 = stmt('src/Svc.java', 9, 'java');
    soul.putNodes([javaMethod, stmt9]);
    soul.putEdges([edge(javaMethod.id, stmt9.id, 'executes')]);
    soul.commit(NOW);
    const d = buildDossier(soul, repo, javaMethod.id, NOW)!;
    expect(d.implementation!.status).toBe('implemented');
    expect(d.implementation!.executesCount).toBe(1);
  });

  it('omits the implementation field for a non-callable (doc-section) node', () => {
    const doc: Node = {
      id: idFor({ kind: 'doc-section', path: 'docs/a.md', anchor: 'x' }),
      kind: 'doc-section',
      file: 'docs/a.md',
      heading: 'X',
      anchor: 'x',
      span: { start: 1, end: 2 },
      hash: contentHash('doc-x'),
    };
    soul.putNodes([doc]);
    soul.commit(NOW);
    expect(buildDossier(soul, repo, doc.id, NOW)!.implementation).toBeUndefined();
  });
});
