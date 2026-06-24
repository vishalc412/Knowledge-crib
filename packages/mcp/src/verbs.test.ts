import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Verbs } from './verbs.js';

let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

function sym(path: string, q: string, line: number, extra: Partial<Node> = {}): Node {
  return {
    id: idFor({ kind: 'symbol', path, qualifiedName: q, startLine: line }),
    kind: 'symbol',
    type: 'method',
    name: q.split('.').pop() ?? q,
    qualifiedName: q,
    file: path,
    span: { start: line, end: line + 1 },
    lang: 'typescript',
    hash: contentHash(q),
    ...extra,
  };
}
function fileNode(path: string): Node {
  return { id: idFor({ kind: 'file', path }), kind: 'file', file: path, hash: contentHash(path) };
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

const handle = sym('src/http.ts', 'Controller.handleLogin', 5);
const login = sym('src/auth.ts', 'AuthService.login', 10);
const issue = sym('src/token.ts', 'TokenService.issue', 20);
const docSection: Node = {
  id: idFor({ kind: 'doc-section', path: 'docs/auth.md', anchor: 'sessions' }),
  kind: 'doc-section',
  file: 'docs/auth.md',
  heading: 'Sessions',
  anchor: 'sessions',
  span: { start: 1, end: 3 },
  lang: 'markdown',
  hash: contentHash('sessions'),
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(
    join(repo, 'docs', 'auth.md'),
    '# Sessions\n\nThe AuthService.login method issues a session.\n',
  );

  soul = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
  soul.putNodes([
    fileNode('src/http.ts'),
    fileNode('src/auth.ts'),
    fileNode('src/token.ts'),
    fileNode('docs/auth.md'),
    handle,
    login,
    issue,
    docSection,
  ]);
  soul.putEdges([
    edge(handle.id, login.id, 'calls'), // handleLogin -> login
    edge(login.id, issue.id, 'calls'), // login -> issue
    edge(docSection.id, login.id, 'describes', { method: 'explicit', confidence: 0.95 }),
  ]);
  soul.commit('2026-01-01T00:00:00.000Z');

  index = new SqliteIndexStore();
  index.buildFromSoul(soul);
  verbs = new Verbs({ soul, index, repoRoot: repo });
});
afterEach(() => {
  index.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('M5 wedge — impact returns blast radius + describing docs', () => {
  it('impact(login, up) returns dependents AND a describes doc with provenance + snippet', () => {
    const res = verbs.impact({ id: login.id, dir: 'up' }) as any;
    // blast radius: handleLogin depends on login
    expect(res.affected.map((a: any) => a.id)).toContain(handle.id);
    // related docs for the changed symbol, with provenance + rehydrated snippet
    expect(res.relatedDocs.length).toBeGreaterThanOrEqual(1);
    const doc = res.relatedDocs[0];
    expect(doc.edgeType).toBe('describes');
    expect(doc.provenance).toBe('EXTRACTED');
    expect(doc.confidence).toBeCloseTo(0.95);
    expect(doc.snippet.length).toBeGreaterThan(0); // rehydrated from docs/auth.md
  });

  it('impact down returns dependencies (issue), not dependents', () => {
    const res = verbs.impact({ id: login.id, dir: 'down' }) as any;
    expect(res.affected.map((a: any) => a.id)).toEqual([issue.id]);
  });
});

describe('verbs', () => {
  it('context bundles signature, callers, callees, docs', () => {
    const res = verbs.context({ id: login.id }) as any;
    expect(res.node.name).toBe('login');
    expect(res.callers.map((c: any) => c.id)).toContain(handle.id);
    expect(res.callees.map((c: any) => c.id)).toContain(issue.id);
    expect(res.docs[0].edgeType).toBe('describes');
  });

  it('describes returns linked docs with min confidence', () => {
    expect((verbs.describes({ id: login.id }) as any).docs).toHaveLength(1);
    expect((verbs.describes({ id: login.id, minConfidence: 0.99 }) as any).docs).toHaveLength(0);
  });

  it('query finds symbols by BM25', () => {
    const res = verbs.query({ q: 'login', kinds: ['symbol'] }) as any;
    expect(res.hits[0].id).toBe(login.id);
  });

  it('neighbors maps in/out/both', () => {
    expect((verbs.neighbors({ id: login.id, rel: 'calls', dir: 'in' }) as any).edges[0].src).toBe(
      handle.id,
    );
    expect((verbs.neighbors({ id: login.id, rel: 'calls', dir: 'out' }) as any).edges[0].dst).toBe(
      issue.id,
    );
  });

  it('shortest_path walks the chain', () => {
    const res = verbs.shortestPath({ from: handle.id, to: issue.id }) as any;
    expect(res.found).toBe(true);
    expect(res.path).toEqual([handle.id, login.id, issue.id]);
  });

  it('status reports indexed + capabilities', () => {
    const res = verbs.status() as any;
    expect(res.indexed).toBe(true);
    expect(res.capabilities.cypher).toBe(false);
  });

  it('NOT_FOUND for unknown id', () => {
    expect((verbs.context({ id: 'sym:nope' }) as any).error.code).toBe('NOT_FOUND');
  });

  it('extractedOnly filters out INFERRED doc links', () => {
    soul.putEdges([
      edge(docSection.id, issue.id, 'references', {
        method: 'semantic',
        provenance: 'INFERRED',
        confidence: 0.5,
      }),
    ]);
    soul.commit('2026-01-02T00:00:00.000Z');
    index.buildFromSoul(soul);
    expect((verbs.describes({ id: issue.id }) as any).docs).toHaveLength(1);
    expect((verbs.describes({ id: issue.id, extractedOnly: true }) as any).docs).toHaveLength(0);
  });
});
