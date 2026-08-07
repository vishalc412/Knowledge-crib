import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, edgeId, idFor } from '@knowledge-crib/soul-schema';
import type { Edge, Node, Rel } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Verbs } from './verbs.js';
import type { VcsAdapter } from './verbs.js';

let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

const handle: Node = {
  id: idFor({
    kind: 'symbol',
    path: 'src/http.ts',
    qualifiedName: 'Controller.handleLogin',
    startLine: 5,
  }),
  kind: 'symbol',
  type: 'method',
  name: 'handleLogin',
  qualifiedName: 'Controller.handleLogin',
  file: 'src/http.ts',
  span: { start: 5, end: 6 },
  lang: 'typescript',
  hash: contentHash('handleLogin'),
};
const login: Node = {
  id: idFor({
    kind: 'symbol',
    path: 'src/auth.ts',
    qualifiedName: 'AuthService.login',
    startLine: 10,
  }),
  kind: 'symbol',
  type: 'method',
  name: 'login',
  qualifiedName: 'AuthService.login',
  file: 'src/auth.ts',
  span: { start: 10, end: 11 },
  lang: 'typescript',
  hash: contentHash('login'),
};
const issue: Node = {
  id: idFor({
    kind: 'symbol',
    path: 'src/token.ts',
    qualifiedName: 'TokenService.issue',
    startLine: 20,
  }),
  kind: 'symbol',
  type: 'method',
  name: 'issue',
  qualifiedName: 'TokenService.issue',
  file: 'src/token.ts',
  span: { start: 20, end: 21 },
  lang: 'typescript',
  hash: contentHash('issue'),
};
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

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-detect-'));
  mkdirSync(join(repo, 'docs'), { recursive: true });
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
    edge(handle.id, login.id, 'calls'),
    edge(login.id, issue.id, 'calls'),
    edge(docSection.id, login.id, 'describes', { method: 'explicit', confidence: 0.95 }),
  ]);
  soul.setVcsHead('h1'); // establishes the incremental anchor
  soul.commit('2026-01-01T00:00:00.000Z');
  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  verbs = new Verbs({ soul, index, repoRoot: repo }); // no vcs → "not configured"
});
afterEach(() => {
  index.close();
  rmSync(repo, { recursive: true, force: true });
});

/** A stub adapter pretending HEAD moved h1→h2 and `changed` files differ since the anchor. */
function stubAdapter(changed = ['src/auth.ts']): VcsAdapter {
  return {
    currentHead: () => 'h2',
    changedFilesSince: () => changed,
    uncommittedChanges: () => [],
  };
}

describe('detect_changes (M6 read-only dry run)', () => {
  it('without a vcs adapter, reports not-configured and never throws', () => {
    const res = verbs.detectChanges({}) as Record<string, unknown>;
    expect(res.note).toBe('vcs adapter not configured');
    expect(res.changedSymbols).toEqual([]);
  });

  it('reports changed symbols + touching edges since the anchor (no mutation)', () => {
    const callsHandleLogin = edge(handle.id, login.id, 'calls').id;
    const callsIssue = edge(login.id, issue.id, 'calls').id;
    const describes = edge(docSection.id, login.id, 'describes').id;
    const beforeCommit = soul.getManifest().stats.incrementalSince;
    const beforeNodes = soul.getManifest().stats.nodes;

    const v = new Verbs({ soul, index, repoRoot: repo, vcs: stubAdapter() });
    const res = v.detectChanges({}) as Record<string, unknown>;

    expect(res.since).toBe('h1');
    expect(res.head).toBe('h2');
    expect(res.changedPaths).toEqual(['src/auth.ts']);
    expect((res.changedSymbols as string[]).sort()).toEqual([login.id, 'file:src/auth.ts'].sort());
    const removedEdgeIds = (res.removedEdges as Array<{ id: string }>).map((e) => e.id).sort();
    expect(removedEdgeIds).toEqual([callsHandleLogin, callsIssue, describes].sort());

    // Read-only: the soul + manifest are untouched.
    expect(soul.getManifest().stats.incrementalSince).toBe(beforeCommit);
    expect(soul.getManifest().stats.nodes).toBe(beforeNodes);
  });

  it('with an anchor-less soul, asks for a full index', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'crib-detect-noanchor-'));
    try {
      const s = new SoulStore(join(fresh, '.crib'), {
        manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
      });
      s.load();
      s.putNodes([login, fileNode('src/auth.ts')]);
      s.commit('2026-01-01T00:00:00.000Z'); // no setVcsHead → no anchor
      const idx = new SqliteIndexStore();
      idx.buildFromSoul(s, fresh);
      const v = new Verbs({ soul: s, index: idx, repoRoot: fresh, vcs: stubAdapter() });
      const res = v.detectChanges({}) as Record<string, unknown>;
      expect(res.note).toBe('no incremental anchor — run `crib index` to establish one');
      idx.close();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('honours an explicit --since override', () => {
    const v = new Verbs({ soul, index, repoRoot: repo, vcs: stubAdapter(['src/token.ts']) });
    const res = v.detectChanges({ since: 'h0' }) as Record<string, unknown>;
    expect(res.since).toBe('h0');
    expect(res.changedPaths).toEqual(['src/token.ts']);
    expect((res.changedSymbols as string[]).sort()).toEqual([issue.id, 'file:src/token.ts'].sort());
  });
});
