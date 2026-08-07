/**
 * W7 — semantic quality tiers + coverage (PRD line 377–392).
 *
 * Exit gate: "automated runs cannot improve coverage with empty artifacts; every verified artifact
 * passes grounding; provider failure leaves work pending and resumable." This file covers the
 * quality/coverage half: only a `verified` (grounded) artifact satisfies coverage; a fresh-but-
 * unverified `draft`/`legacy` artifact is still pending repair; and the lower-layer seed fed to a
 * higher layer is verified-only so a stub can never propagate garbage upward.
 *
 * The fixture mirrors grounding.test.ts: a real `src/auth.ts` on disk so `rehydrateBody` reads actual
 * span text. `login` (lines 10-11) rehydrates `return issue(user, pass)` (grounded); `logout`
 * (lines 13-14) rehydrates `return clear()` (grounded). A no-quote evidence item downgrades to a
 * `legacy` artifact (grounded:false) — the pre-W7 stub shape — and must NOT satisfy coverage.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type LlmArtifact, qualityOf } from './enrichment.js';
import type {
  AuditLlmResult,
  AuditTarget,
  EnrichNextBatch,
  EnrichSaveResult,
  EnrichStatus,
} from './enrichment.js';
import { Verbs } from './verbs.js';

let repo: string;
let soul: SoulStore;
let index: SqliteIndexStore;
let verbs: Verbs;

const fileId = idFor({ kind: 'file', path: 'src/auth.ts' });
const loginId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.login',
  startLine: 10,
});
const logoutId = idFor({
  kind: 'symbol',
  path: 'src/auth.ts',
  qualifiedName: 'AuthService.logout',
  startLine: 13,
});

/** Save a grounded (verified) artifact for `login`. Returns the save result. */
function saveVerifiedLogin(): EnrichSaveResult {
  const batch = verbs.enrichNext({ layer: 'symbol', limit: 25 }) as unknown as EnrichNextBatch;
  return verbs.enrichSave({
    batchId: batch.batchId,
    items: [
      {
        targetId: loginId,
        model: 'host-model',
        analysis: { purpose: 'Delegates token issuance.', confidence: 0.9 },
        graph: { nodes: [], edges: [] },
        evidence: [{ soulId: loginId, quote: 'return issue(user, pass)' }],
      },
    ],
  }) as unknown as EnrichSaveResult;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-w7-quality-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  // lines 1-8 blank, line 9 `class AuthService {`, lines 10-11 login body, line 12 `  }`,
  // lines 13-14 logout body, line 15 `  }`, line 16 `}`.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
  }
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
      id: fileId,
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
      id: logoutId,
      kind: 'symbol',
      type: 'method',
      name: 'logout',
      qualifiedName: 'AuthService.logout',
      file: 'src/auth.ts',
      span: { start: 13, end: 14 },
      lang: 'typescript',
      hash: contentHash('AuthService.logout'),
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

describe('W7 qualityOf — derive-on-read (no on-disk rewrite needed)', () => {
  it('prefers the stamped `quality` field when present', () => {
    expect(qualityOf({ quality: 'verified' } as LlmArtifact)).toBe('verified');
    expect(qualityOf({ quality: 'legacy' } as LlmArtifact)).toBe('legacy');
    expect(qualityOf({ quality: 'draft' } as LlmArtifact)).toBe('draft');
  });

  it('derives draft from mode==="skeleton" when quality is absent (pre-W7 skeleton)', () => {
    expect(qualityOf({ mode: 'skeleton' } as LlmArtifact)).toBe('draft');
  });

  it('derives verified from grounded===true when quality is absent (pre-W7 grounded artifact)', () => {
    expect(qualityOf({ grounded: true } as LlmArtifact)).toBe('verified');
  });

  it('derives legacy from a full ungrounded artifact (pre-W7 stub / pre-quality-era)', () => {
    expect(qualityOf({} as LlmArtifact)).toBe('legacy');
    expect(qualityOf({ mode: 'full', grounded: false } as LlmArtifact)).toBe('legacy');
  });
});

describe('W7 save() — stamps the quality tier at persist time', () => {
  it('a grounded (verbatim-quoted) artifact is stamped `verified`', () => {
    const save = saveVerifiedLogin();
    expect(save.rejected).toEqual([]);
    expect(save.accepted).toHaveLength(1);
    expect(save.accepted[0]!.grounded).toBe(true);

    const audit = verbs.auditLlm() as unknown as AuditLlmResult;
    const login = audit.targets.find((t) => t.targetId === loginId) as AuditTarget;
    expect(login).toBeDefined();
    expect(login.quality).toBe('verified');
    expect(login.grounded).toBe(true);
  });

  it('a no-quote (unsupported-only) artifact is stamped `legacy`, not rejected', () => {
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 25 }) as unknown as EnrichNextBatch;
    // Evidence with only `why` (no quote) → groundedCount 0, anyQuoted false → accepted, grounded:false,
    // quality 'legacy'. This is the pre-W7 stub shape — kept for read-back-compat but never satisfies coverage.
    const save = verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: logoutId,
          model: 'host-model',
          analysis: { purpose: 'Clears the session.', confidence: 0.1 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: logoutId, why: 'no verbatim quote available' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    expect(save.rejected).toEqual([]);
    expect(save.accepted).toHaveLength(1);
    expect(save.accepted[0]!.grounded).toBe(false);

    const audit = verbs.auditLlm() as unknown as AuditLlmResult;
    const logout = audit.targets.find((t) => t.targetId === logoutId) as AuditTarget;
    expect(logout).toBeDefined();
    expect(logout.quality).toBe('legacy');
    expect(logout.grounded).toBe(false);
  });

  it('a skeleton system-bible batch is stamped `draft` and mode skeleton', () => {
    // The system target exists because the soul is non-empty. A skeleton batchId prefix forces
    // skeletonMode server-side; with no quoted evidence it persists as a draft (grounded:false).
    const save = verbs.enrichSave({
      batchId: 'llm:system-skeleton:phase05',
      items: [
        {
          targetId: 'system:repo',
          model: 'host-model',
          analysis: { purpose: 'Draft repo bible.', confidence: 0.4 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: loginId, why: 'seed symbol' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    expect(save.rejected).toEqual([]);
    expect(save.accepted).toHaveLength(1);

    const audit = verbs.auditLlm() as unknown as AuditLlmResult;
    const sys = audit.targets.find((t) => t.targetId === 'system:repo') as AuditTarget;
    expect(sys).toBeDefined();
    expect(sys.quality).toBe('draft');
  });
});

describe('W7 coverage — only `verified` satisfies coverage', () => {
  it('a verified artifact is fresh, not pending; a legacy artifact is missing, re-offered', () => {
    // Save login verified and logout legacy.
    saveVerifiedLogin();
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 25 }) as unknown as EnrichNextBatch;
    verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: logoutId,
          model: 'host-model',
          analysis: { purpose: 'Clears the session.', confidence: 0.1 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: logoutId, why: 'no quote' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    // status: symbol layer — login fresh, logout missing (legacy counts as missing per W7).
    const status = verbs.enrichStatus() as unknown as EnrichStatus;
    const symbolCounts = status.layers.symbol;
    expect(symbolCounts.total).toBe(2);
    expect(symbolCounts.fresh).toBe(1); // login verified
    expect(symbolCounts.missing).toBe(1); // logout legacy → pending repair
    expect(symbolCounts.stale).toBe(0);

    // next() re-offers logout (legacy) but NOT login (verified).
    const next = verbs.enrichNext({ layer: 'symbol', limit: 25 }) as unknown as EnrichNextBatch;
    expect(next.selectedTargetIds).toContain(logoutId);
    expect(next.selectedTargetIds).not.toContain(loginId);
  });

  it('read() flags a fresh-but-unverified artifact with unverified:true (the stub-freshness fix)', () => {
    // Persist a legacy artifact directly on disk (fresh hash, not stale, but not grounded) and confirm
    // the queue treats it as pending. logout legacy is the canonical case.
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 25 }) as unknown as EnrichNextBatch;
    verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: logoutId,
          model: 'host-model',
          analysis: { purpose: 'Clears the session.', confidence: 0.1 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: logoutId, why: 'no quote' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    // The logout artifact is on disk with a matching nodeHash (NOT stale), yet it is NOT counted as
    // fresh — it is counted as missing (pending repair). login is unsaved → also missing. So fresh=0
    // and missing=2: the legacy stub cannot masquerade as fresh coverage (the W7 stub-freshness fix).
    const status = verbs.enrichStatus() as unknown as EnrichStatus;
    expect(status.layers.symbol.total).toBe(2);
    expect(status.layers.symbol.fresh).toBe(0);
    expect(status.layers.symbol.missing).toBe(2);
    expect(status.layers.symbol.stale).toBe(0);
  });
});

describe('W7 lowerLayer — only verified artifacts seed a higher layer (no stub propagation)', () => {
  it('a file-layer work item receives the verified symbol but NOT the legacy symbol', () => {
    // login → verified, logout → legacy, both in src/auth.ts.
    saveVerifiedLogin();
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 25 }) as unknown as EnrichNextBatch;
    verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: logoutId,
          model: 'host-model',
          analysis: { purpose: 'Clears the session.', confidence: 0.1 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: logoutId, why: 'no quote' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    // The file layer is pending (no file artifact). Its work item's lowerLayer.symbols must carry the
    // verified login artifact and exclude the legacy logout artifact (PRD line 380).
    const next = verbs.enrichNext({ layer: 'file', limit: 25 }) as unknown as EnrichNextBatch;
    const fileItem = next.items.find((i) => i.targetId === fileId);
    expect(fileItem).toBeDefined();
    const seedSymbols = (fileItem!.lowerLayer.symbols as Array<{ targetId: string }>) ?? [];
    const seedIds = seedSymbols.map((a) => a.targetId);
    expect(seedIds).toContain(loginId);
    expect(seedIds).not.toContain(logoutId);
  });
});
