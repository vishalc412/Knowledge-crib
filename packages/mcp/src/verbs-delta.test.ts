/**
 * `semantic_delta` verb — the VCS-aware wrapper around `EnrichmentStore.semanticDelta`. Covers the
 * three scoping modes the verb exposes: explicit `targets`, a `since` VCS ref (threaded through
 * `affectedTargetIds` → changed symbols/files + every cluster + system:repo), and the bare
 * whole-repo scan. Also covers the graceful VCS degradation (no adapter / not a git work tree →
 * whole-repo scan + a `note`, never a throw), mirroring `verbs-detect.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Verbs } from './verbs.js';
import type { VcsAdapter } from './verbs.js';

let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

const loginId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.login',
  startLine: 10,
});
const issueId = idFor({
  kind: 'symbol',
  path: 'src/token.ts',
  qualifiedName: 'TokenService.issue',
  startLine: 20,
});
const authFileId = idFor({ kind: 'file', path: 'src/auth.ts' });
const tokenFileId = idFor({ kind: 'file', path: 'src/token.ts' });

/** Save a grounded (verified) artifact for `targetId` whose `quote` overlaps the symbol's span. */
function saveGrounded(targetId: string, quote: string): void {
  verbs.enrichSave({
    batchId: `test:${targetId}`,
    items: [
      {
        targetId,
        model: 'host-model',
        analysis: { purpose: 'x', confidence: 0.9 },
        graph: { nodes: [], edges: [] },
        evidence: [{ soulId: targetId, quote }],
      },
    ],
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-verbs-delta-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  // auth.ts: login at lines 10-11.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
  }
}
`,
  );
  // token.ts: issue at lines 20-21.
  writeFileSync(
    join(repo, 'src', 'token.ts'),
    `${'\n'.repeat(18)}class TokenService {
  issue() {
    return token();
  }
}
`,
  );

  soul = new SoulStore(join(repo, '.crib'), {
    manifest: newManifest({ now: '2026-01-01T00:00:00.000Z' }),
  });
  soul.load();
  soul.putNodes([
    {
      id: authFileId,
      kind: 'file',
      file: 'src/auth.ts',
      hash: contentHash('src/auth.ts'),
      lang: 'typescript',
    },
    {
      id: loginId,
      kind: 'symbol',
      type: 'method',
      name: 'login',
      qualifiedName: 'AuthService.login',
      file: 'src/auth.ts',
      span: { start: 10, end: 11 },
      lang: 'typescript',
      hash: contentHash('login'),
    },
    {
      id: tokenFileId,
      kind: 'file',
      file: 'src/token.ts',
      hash: contentHash('src/token.ts'),
      lang: 'typescript',
    },
    {
      id: issueId,
      kind: 'symbol',
      type: 'method',
      name: 'issue',
      qualifiedName: 'TokenService.issue',
      file: 'src/token.ts',
      span: { start: 20, end: 21 },
      lang: 'typescript',
      hash: contentHash('issue'),
    },
  ]);
  soul.setVcsHead('h1'); // establishes the incremental anchor
  soul.commit('2026-01-01T00:00:00.000Z');

  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  verbs = new Verbs({ soul, index, repoRoot: repo }); // no vcs by default → degradation path

  saveGrounded(loginId, 'return issue(user, pass)');
  saveGrounded(issueId, 'return token()');
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

describe('semantic_delta verb — scoping modes', () => {
  it('whole-repo scan when neither since nor targets is given', () => {
    const res = verbs.semanticDelta({}) as Record<string, unknown>;
    expect(res.scanned).toBe(2);
    expect(res.orphaned as unknown[]).toEqual([]);
    expect(res.stale as unknown[]).toEqual([]);
    expect(res.since).toBeUndefined();
    expect(res.head).toBeUndefined();
    expect(res.note).toBeUndefined();
  });

  it('explicit targets restrict the scan and attach no VCS context', () => {
    const res = verbs.semanticDelta({ targets: [issueId] }) as Record<string, unknown>;
    expect(res.scanned).toBe(1);
    expect(res.since).toBeUndefined();
    expect(res.head).toBeUndefined();
  });

  it('since threads the VCS diff into a target filter and attaches since/head/changedPaths', () => {
    const v = new Verbs({ soul, index, repoRoot: repo, vcs: stubAdapter(['src/auth.ts']) });
    const res = v.semanticDelta({ since: 'h1' }) as Record<string, unknown>;
    // Only the login artifact (in src/auth.ts) is in the affected set; the issue artifact is not scanned.
    expect(res.scanned).toBe(1);
    expect(res.since).toBe('h1');
    expect(res.head).toBe('h2');
    expect(res.changedPaths).toEqual(['src/auth.ts']);
    expect(res.note).toBeUndefined();
  });

  it('since with a diff touching a different file scans only that file’s artifact', () => {
    const v = new Verbs({ soul, index, repoRoot: repo, vcs: stubAdapter(['src/token.ts']) });
    const res = v.semanticDelta({ since: 'h1' }) as Record<string, unknown>;
    expect(res.scanned).toBe(1);
    expect(res.changedPaths).toEqual(['src/token.ts']);
  });
});

describe('semantic_delta verb — VCS degradation (never throws)', () => {
  it('without a vcs adapter, falls back to a whole-repo scan with a note', () => {
    const res = verbs.semanticDelta({ since: 'h1' }) as Record<string, unknown>;
    expect(res.scanned).toBe(2); // whole-repo
    expect(res.since).toBeUndefined();
    expect(res.head).toBeUndefined();
    expect(res.note).toBe('no vcs anchor — scanned whole repo');
  });

  it('with a vcs adapter that throws (not a git work tree), falls back to a whole-repo scan', () => {
    const throwing: VcsAdapter = {
      currentHead: () => {
        throw new Error('not a git work tree');
      },
      changedFilesSince: () => [],
      uncommittedChanges: () => [],
    };
    const v = new Verbs({ soul, index, repoRoot: repo, vcs: throwing });
    const res = v.semanticDelta({ since: 'h1' }) as Record<string, unknown>;
    expect(res.scanned).toBe(2); // whole-repo
    expect(res.note).toBe('no vcs anchor — scanned whole repo');
  });
});

describe('semantic_delta verb — prune + reissueTargets pass-through', () => {
  it('prune deletes orphans through the verb and bumps generation', () => {
    // Orphan the login artifact by removing its file from the soul.
    soul.removeByFile('src/auth.ts');
    const genBefore = soul.getManifest().generation?.semantic ?? 0;
    const res = verbs.semanticDelta({ prune: true }) as Record<string, unknown>;
    expect(res.pruned).toBe(1);
    expect(res.bumped).toBe(true);
    expect(soul.getManifest().generation?.semantic ?? 0).toBe(genBefore + 1);
    // A second scan sees only the issue artifact (login orphan was deleted).
    const after = verbs.semanticDelta({}) as Record<string, unknown>;
    expect(after.scanned).toBe(1);
  });

  it('reissueTargets flows from a stale classification and feeds enrich_next({targets})', () => {
    // Stale the login artifact (hash changed).
    soul.putNodes([
      {
        id: loginId,
        kind: 'symbol',
        type: 'method',
        name: 'login',
        qualifiedName: 'AuthService.login',
        file: 'src/auth.ts',
        span: { start: 10, end: 11 },
        lang: 'typescript',
        hash: contentHash('login.v2'),
      },
    ]);
    const res = verbs.semanticDelta({}) as Record<string, unknown>;
    expect(res.reissueTargets).toEqual([loginId]);
    const batch = verbs.enrichNext({
      targets: res.reissueTargets as string[],
    }) as Record<string, unknown>;
    expect(batch.targeted).toEqual({ count: 1 });
    expect(batch.selectedTargetIds).toEqual([loginId]);
  });
});
