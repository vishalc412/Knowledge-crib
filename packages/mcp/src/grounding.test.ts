/**
 * M1.3 grounding validator (the moat) — gate tests.
 *
 * Plan gate (eager-giggling-matsumoto.md, M1.3):
 *   "synthetically hallucinated batch rejected; real batch passes; post-refactor re-verify works."
 *
 * The fixture mirrors verbs.test.ts: a real `src/auth.ts` on disk so `rehydrateBody` reads actual
 * span text. The `login` symbol's span (lines 10-11) rehydrates to:
 *     "  login(user, pass) {\n    return issue(user, pass);"
 * so `return issue(user, pass)` is a grounded quote and `password = hash(user.secret)` is a
 * hallucination (present as a claim, absent from the span).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmEvidence } from './enrichment.js';
import type { AuditLlmResult, AuditTarget } from './enrichment.js';
import { verifyArtifact, verifyEvidence } from './grounding.js';
import type { EvidenceCheck, GroundingResult } from './grounding.js';
import { Verbs } from './verbs.js';

interface EnrichNextResult {
  batchId: string;
  layer: string;
  items: Array<{ targetId: string }>;
  remaining: number;
}
interface EnrichSaveResult {
  accepted: Array<{
    targetId: string;
    grounded?: boolean;
    droppedEvidence?: Array<{ soulId: string; reason: string }>;
  }>;
  rejected: Array<{ targetId: string; reason: string }>;
}

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

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crib-grounding-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  // lines 1-8 blank, line 9 `class AuthService {`, lines 10-11 the login body, line 12 `  }`, line 13 `}`.
  writeFileSync(
    join(repo, 'src', 'auth.ts'),
    `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return issue(user, pass);
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
      id: idFor({ kind: 'file', path: 'src/auth.ts' }),
      kind: 'file',
      file: 'src/auth.ts',
      hash: contentHash('src/auth.ts'),
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

describe('M1.3 grounding — pure validator', () => {
  it('verifyEvidence: a verbatim quote from the span is grounded', () => {
    const ev: LlmEvidence = { soulId: loginId, quote: 'return issue(user, pass)' };
    const check = verifyEvidence(soul, repo, ev) as EvidenceCheck;
    expect(check.verdict).toBe('grounded');
  });

  it('verifyEvidence: a quote NOT in the span is ungrounded (hallucination signal)', () => {
    const ev: LlmEvidence = { soulId: loginId, quote: 'password = hash(user.secret)' };
    const check = verifyEvidence(soul, repo, ev) as EvidenceCheck;
    expect(check.verdict).toBe('ungrounded');
    expect(check.reason).toMatch(/not found/i);
  });

  it('verifyEvidence: no quote is unsupported (downgrade, not a reject)', () => {
    const check = verifyEvidence(soul, repo, {
      soulId: loginId,
      why: 'no quote here',
    }) as EvidenceCheck;
    expect(check.verdict).toBe('unsupported');
  });

  it('verifyArtifact: counts grounded / ungrounded / unsupported and sets verified', () => {
    const artifact = {
      evidence: [
        { soulId: loginId, quote: 'return issue(user, pass)' },
        { soulId: loginId, quote: 'password = hash(user.secret)' },
        { soulId: loginId, why: 'no quote' },
      ],
    } as never;
    const result = verifyArtifact(soul, repo, artifact) as GroundingResult;
    expect(result.grounded).toBe(1);
    expect(result.ungrounded).toBe(1);
    expect(result.unsupported).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.score).toBeCloseTo(1 / 3);
  });
});

describe('M1.3 grounding — enrich_save gate (hallucinated rejected, real passes)', () => {
  it('GATE 1: a synthetically hallucinated batch is rejected', () => {
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 10 }) as unknown as EnrichNextResult;
    const target = batch.items.find((i) => i.targetId === loginId) ?? batch.items[0]!;

    const save = verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: target.targetId,
          model: 'host-model',
          analysis: { purpose: 'Hashes a password.', confidence: 0.5 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: target.targetId, quote: 'password = hash(user.secret)' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    expect(save.accepted).toEqual([]);
    expect(save.rejected).toHaveLength(1);
    expect(save.rejected[0]!.targetId).toBe(target.targetId);
    expect(save.rejected[0]!.reason).toMatch(/hallucination/i);
  });

  it('GATE 2: a real (verbatim-quoted) batch passes and is stamped grounded', () => {
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 10 }) as unknown as EnrichNextResult;
    const target = batch.items.find((i) => i.targetId === loginId) ?? batch.items[0]!;

    const save = verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: target.targetId,
          model: 'host-model',
          analysis: { purpose: 'Delegates token issuance.', confidence: 0.9 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: target.targetId, quote: 'return issue(user, pass)' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    expect(save.rejected).toEqual([]);
    expect(save.accepted).toHaveLength(1);
    expect(save.accepted[0]!.targetId).toBe(target.targetId);
    expect(save.accepted[0]!.grounded).toBe(true);
    // the on-disk artifact only carries verifiable evidence — no dropped quote here.
    expect(save.accepted[0]!.droppedEvidence).toBeUndefined();

    // audit immediately after save: grounded, no drift, not stale.
    const audit = verbs.auditLlm() as unknown as AuditLlmResult;
    expect(audit.checked).toBe(1);
    expect(audit.grounded).toBe(1);
    expect(audit.ungrounded).toBe(0);
    expect(audit.drifted).toBe(0);
    expect(audit.stale).toBe(0);
    const target0 = audit.targets[0] as AuditTarget;
    expect(target0.grounded).toBe(true);
    expect(target0.groundedCount).toBe(1);
    expect(target0.ungroundedCount).toBe(0);
  });

  it('GATE 3: post-refactor re-verify works — a refactor that removes the quote flips the verdict (drift)', () => {
    // 1. save a grounded artifact against the original span.
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 10 }) as unknown as EnrichNextResult;
    const target = batch.items.find((i) => i.targetId === loginId) ?? batch.items[0]!;
    verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: target.targetId,
          model: 'host-model',
          analysis: { purpose: 'Delegates token issuance.', confidence: 0.9 },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: target.targetId, quote: 'return issue(user, pass)' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    const before = verbs.auditLlm() as unknown as AuditLlmResult;
    expect(before.grounded).toBe(1);
    expect(before.drifted).toBe(0);

    // 2. "refactor": rewrite src/auth.ts so the quoted line is gone. The soul node's name-based
    //    hash is unchanged, so the artifact is NOT stale by nodeHash — but re-verify rehydrates
    //    the CURRENT span and the quote is no longer there. The save-time `grounded:true` stamp
    //    now disagrees with the recomputed `false` → drift detected.
    writeFileSync(
      join(repo, 'src', 'auth.ts'),
      `${'\n'.repeat(8)}class AuthService {
  login(user, pass) {
    return new Session(user);
  }
}
`,
    );

    const after = verbs.auditLlm() as unknown as AuditLlmResult;
    expect(after.checked).toBe(1);
    expect(after.grounded).toBe(0);
    expect(after.ungrounded).toBe(1);
    expect(after.drifted).toBe(1);
    const target0 = after.targets[0] as AuditTarget;
    expect(target0.grounded).toBe(false);
    expect(target0.ungroundedCount).toBe(1);
    expect(target0.stampedGrounded).toBe(true); // the save-time stamp still says grounded
    expect(target0.stale).toBe(false); // name-based hash unchanged → not stale, just drifted
  });
});
