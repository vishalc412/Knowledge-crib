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
