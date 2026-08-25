/**
 * `semantic_delta` — the semantic-layer delta report + optional prune (the explicit companion to
 * `crib update`'s silent orphan auto-prune). Covers the EnrichmentStore.semanticDelta classification
 * (orphaned / stale / drifted), the prune + generation bump, the `targets` filter, and the
 * `reissueTargets` → `next({targets})` re-issue path.
 *
 * The fixture mirrors enrichment-quality.test.ts: two real source files on disk so evidence quotes
 * rehydrate to actual span text (`login` in src/auth.ts, `logout` in src/other.ts). Orphans are made
 * by `soul.removeByFile` (the in-memory node vanishes → targetFor returns undefined); staleness by
 * `soul.putNodes` with a new hash (artifact.nodeHash no longer matches).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  EnrichNextBatch,
  EnrichSaveResult,
  EnrichStatus,
  SemanticDeltaReport,
} from './enrichment.js';
import { Verbs } from './verbs.js';

let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

const authId = idFor({ kind: 'file', path: 'src/auth.ts' });
const otherId = idFor({ kind: 'file', path: 'src/other.ts' });
const loginId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.login',
  startLine: 10,
});
const logoutId = idFor({
  kind: 'symbol',
  path: 'src/other.ts',
  qualifiedName: 'Auth.logout',
  startLine: 5,
});

/** Save a grounded (verified) artifact for `targetId` whose `quote` overlaps the symbol's span. */
function saveGrounded(targetId: string, quote: string): EnrichSaveResult {
  return verbs.enrichSave({
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
  }) as unknown as EnrichSaveResult;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-semantic-delta-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  // auth.ts: lines 1-8 blank, 9 `class AuthService {`, 10-11 login body, 12 `  }`, 13 `}`.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
  }
}
`,
  );
  // other.ts: lines 1-3 blank, 4 `class Auth {`, 5-6 logout body, 7 `  }`, 8 `}`.
  writeFileSync(
    join(repo, 'src', 'other.ts'),
    `${'\n'.repeat(3)}class Auth {
  logout() {
    return clear();
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
      id: authId,
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
      hash: contentHash('AuthService.login'),
    },
    {
      id: otherId,
      kind: 'file',
      file: 'src/other.ts',
      hash: contentHash('src/other.ts'),
      lang: 'typescript',
    },
    {
      id: logoutId,
      kind: 'symbol',
      type: 'method',
      name: 'logout',
      qualifiedName: 'Auth.logout',
      file: 'src/other.ts',
      span: { start: 5, end: 6 },
      lang: 'typescript',
      hash: contentHash('Auth.logout'),
    },
  ]);
  soul.commit('2026-01-01T00:00:00.000Z');

  index = new SqliteIndexStore();
  index.buildFromSoul(soul, repo);
  verbs = new Verbs({ soul, index, repoRoot: repo });
});

afterEach(() => {
  index.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('EnrichmentStore.semanticDelta — classification (read-only, default)', () => {
  it('reports a clean repo: both fresh, no orphans/stale', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
    const report = verbs.semanticDelta({}) as unknown as SemanticDeltaReport;
    expect(report.scanned).toBe(2);
    expect(report.orphaned).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.drifted).toEqual([]);
    expect(report.reissueTargets).toEqual([]);
    expect(report.pruned).toBe(0);
    expect(report.bumped).toBe(false);
  });

  it('classifies an orphaned artifact (target node removed) but does NOT delete without --prune', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
    // Orphan logout by removing its file from the soul (in-memory node vanishes).
    soul.removeByFile('src/other.ts');
    const report = verbs.semanticDelta({}) as unknown as SemanticDeltaReport;
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0]!.targetId).toBe(logoutId);
    expect(report.stale).toEqual([]);
    expect(report.reissueTargets).toEqual([]); // orphans are not re-issue targets (target is gone)
    expect(report.pruned).toBe(0);
    expect(report.bumped).toBe(false);
  });

  it('classifies a stale artifact (hash changed) and lists it for re-issue', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
    // Stale login: replace the node with a new hash (artifact.nodeHash no longer matches).
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
        hash: contentHash('AuthService.login.v2'),
      },
    ]);
    const report = verbs.semanticDelta({}) as unknown as SemanticDeltaReport;
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.targetId).toBe(loginId);
    expect(report.orphaned).toEqual([]);
    expect(report.reissueTargets).toEqual([loginId]);
  });
});

describe('EnrichmentStore.semanticDelta — prune + generation bump', () => {
  it('prune:true deletes orphans and bumps generation.semantic', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
    soul.removeByFile('src/other.ts');
    const genBefore = soul.getManifest().generation?.semantic ?? 0;
    const report = verbs.semanticDelta({ prune: true }) as unknown as SemanticDeltaReport;
    expect(report.pruned).toBe(1);
    expect(report.bumped).toBe(true);
    expect(soul.getManifest().generation?.semantic ?? 0).toBe(genBefore + 1);
    // The orphaned artifact is gone; a second scan sees only login.
    const after = verbs.semanticDelta({}) as unknown as SemanticDeltaReport;
    expect(after.scanned).toBe(1);
    expect(after.orphaned).toEqual([]);
  });

  it('prune without --prune-stale preserves stale-but-present artifacts (non-destructive default)', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
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
        hash: contentHash('AuthService.login.v2'),
      },
    ]);
    const report = verbs.semanticDelta({ prune: true }) as unknown as SemanticDeltaReport;
    expect(report.pruned).toBe(0); // no orphans; stale preserved
    expect(report.bumped).toBe(false);
    expect(report.stale).toHaveLength(1);
  });

  it('pruneStale:true also deletes stale artifacts (destructive)', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
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
        hash: contentHash('AuthService.login.v2'),
      },
    ]);
    const report = verbs.semanticDelta({
      prune: true,
      pruneStale: true,
    }) as unknown as SemanticDeltaReport;
    expect(report.pruned).toBe(1);
    expect(report.bumped).toBe(true);
    expect(report.stale).toHaveLength(1); // still listed (the report lists what was pruned)
  });
});

describe('EnrichmentStore.semanticDelta — targets filter', () => {
  it('restricts the scan to the given target ids', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
    soul.removeByFile('src/other.ts'); // orphan logout
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
        hash: contentHash('AuthService.login.v2'),
      },
    ]); // stale login
    const report = verbs.semanticDelta({ targets: [loginId] }) as unknown as SemanticDeltaReport;
    expect(report.scanned).toBe(1);
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.targetId).toBe(loginId);
    expect(report.orphaned).toEqual([]); // logout not in the filter, not scanned
  });

  it('a targets set with no persisted artifacts scans nothing', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    const report = verbs.semanticDelta({ targets: [logoutId] }) as unknown as SemanticDeltaReport;
    expect(report.scanned).toBe(0);
    expect(report.orphaned).toEqual([]);
    expect(report.stale).toEqual([]);
  });
});

describe('semantic_delta → enrich_next({targets}) re-issue path', () => {
  it('a stale target is re-offered by next({targets}) and namespaced from the unscoped queue', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
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
        hash: contentHash('AuthService.login.v2'),
      },
    ]);
    const delta = verbs.semanticDelta({}) as unknown as SemanticDeltaReport;
    expect(delta.reissueTargets).toEqual([loginId]);
    const batch = verbs.enrichNext({ targets: delta.reissueTargets }) as unknown as EnrichNextBatch;
    expect(batch.targeted).toEqual({ count: 1 });
    expect(batch.selectedTargetIds).toEqual([loginId]);
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]!.targetId).toBe(loginId);
  });

  it('status({targets}) counts only the targeted set', () => {
    saveGrounded(loginId, 'return issue(user, pass)');
    saveGrounded(logoutId, 'return clear()');
    // status of a fully-fresh targeted set is done.
    const st = verbs.enrichStatus({ targets: [loginId, logoutId] }) as unknown as EnrichStatus;
    expect(st.targeted).toBe(2);
    expect(st.layers.symbol.total).toBe(2);
    expect(st.layers.symbol.fresh).toBe(2);
    expect(st.done).toBe(true);
  });
});
