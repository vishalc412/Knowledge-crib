/**
 * M1.4 secret scanner + persist-time guard — gate tests.
 *
 * Plan gate (eager-giggling-matsumoto.md, M1.4):
 *   "planted canary secret never reaches any committed artifact."
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoulStore, SqliteIndexStore, newManifest } from '@knowledge-crib/core';
import { contentHash, idFor } from '@knowledge-crib/soul-schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnrichmentStore } from './enrichment.js';
import { collectStrings, hasSecret, redactSecrets, scanSecrets } from './secrets.js';
import { Verbs } from './verbs.js';

interface EnrichNextResult {
  batchId: string;
  items: Array<{ targetId: string }>;
}
interface EnrichSaveResult {
  accepted: Array<{ targetId: string }>;
  rejected: Array<{ targetId: string; reason: string }>;
}

describe('M1.4 secret scanner — pure', () => {
  it('detects an AWS access key id', () => {
    expect(scanSecrets('aws key AKIAIOSFODNN7EXAMPLE here').map((h) => h.pattern)).toContain(
      'aws-access-key-id',
    );
  });

  it('detects a GitHub token', () => {
    expect(hasSecret('token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')).toBe(true);
  });

  it('detects a PEM private key block', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    expect(hasSecret(pem)).toBe(true);
  });

  it('detects a generic password assignment', () => {
    expect(hasSecret('password = "s3cret-pw-1234"')).toBe(true);
  });

  it('detects a high-entropy run with no known prefix', () => {
    // 48-char base64-ish, high entropy, no prefix match
    expect(hasSecret('x=Zm9vYmFyYmF6cXdlcnR5dWlvcGFzZGZnaGprbHF6eDM0NQ==')).toBe(true);
  });

  it('does not flag ordinary prose or short hashes', () => {
    expect(hasSecret('The login method issues a session.')).toBe(false);
    expect(hasSecret('commit a182c0b updated the docs')).toBe(false);
    expect(hasSecret('return issue(user, pass)')).toBe(false);
  });

  it('redactSecrets masks every hit', () => {
    const masked = redactSecrets('key=AKIAIOSFODNN7EXAMPLE end');
    expect(masked).toContain('[REDACTED:aws-access-key-id]');
    expect(masked).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('collectStrings walks nested objects/arrays with dotted paths', () => {
    const fields = collectStrings({
      analysis: { purpose: 'p', responsibilities: ['r1', 'r2'] },
      evidence: [{ soulId: 's', quote: 'q' }],
    });
    const paths = fields.map((f) => f.path);
    expect(paths).toContain('analysis.purpose');
    expect(paths).toContain('analysis.responsibilities[0]');
    expect(paths).toContain('evidence[0].quote');
  });
});

// ---- persist-time guard: canary secret never reaches a committed artifact ----

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
  repo = mkdtempSync(join(tmpdir(), 'crib-secrets-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
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

describe('M1.4 persist-time guard — GATE: canary secret never reaches a committed artifact', () => {
  it('an evidence quote carrying a planted AWS canary is rejected and never persisted', () => {
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 10 }) as unknown as EnrichNextResult;
    const target = batch.items.find((i) => i.targetId === loginId) ?? batch.items[0]!;

    const save = verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: target.targetId,
          model: 'host-model',
          analysis: { purpose: 'Reads config.', confidence: 0.5 },
          graph: { nodes: [], edges: [] },
          evidence: [
            {
              soulId: target.targetId,
              quote: 'AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            },
          ],
        },
      ],
    }) as unknown as EnrichSaveResult;

    expect(save.accepted).toEqual([]);
    expect(save.rejected).toHaveLength(1);
    expect(save.rejected[0]!.targetId).toBe(target.targetId);
    expect(save.rejected[0]!.reason).toMatch(/secret pattern detected/i);

    // the on-disk LLM layer carries NO artifact for this target — audit-llm sees nothing.
    const audit = verbs.auditLlm() as unknown as { checked: number };
    expect(audit.checked).toBe(0);
  });

  it('a secret planted in an analysis field is rejected even with a clean grounded quote', () => {
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 10 }) as unknown as EnrichNextResult;
    const target = batch.items.find((i) => i.targetId === loginId) ?? batch.items[0]!;

    const save = verbs.enrichSave({
      batchId: batch.batchId,
      items: [
        {
          targetId: target.targetId,
          model: 'host-model',
          analysis: {
            purpose: 'Uses key ghp_abcdefghijklmnopqrstuvwxyz0123456789AB to call API.',
            confidence: 0.9,
          },
          graph: { nodes: [], edges: [] },
          evidence: [{ soulId: target.targetId, quote: 'return issue(user, pass)' }],
        },
      ],
    }) as unknown as EnrichSaveResult;

    expect(save.accepted).toEqual([]);
    expect(save.rejected).toHaveLength(1);
    expect(save.rejected[0]!.reason).toMatch(/secret pattern detected/i);
  });

  it('a clean grounded batch still passes (the guard does not false-positive on ordinary code)', () => {
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
  });
});

describe('M1.4 crib export --redact — evidence quotes → span refs, secrets masked', () => {
  it('exportLlm(redact=true) strips evidence quotes to span refs and masks secrets', () => {
    const batch = verbs.enrichNext({ layer: 'symbol', limit: 10 }) as unknown as EnrichNextResult;
    const target = batch.items.find((i) => i.targetId === loginId) ?? batch.items[0]!;
    // save a grounded artifact; plant a secret in the analysis purpose (it passes the persist guard
    // only because... it must NOT — so instead use a clean purpose and a secret-free quote).
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

    const enrich = new EnrichmentStore(soul, repo);
    const redacted = JSON.parse(enrich.exportLlm(true)) as {
      redacted: boolean;
      artifacts: Array<{
        evidence: Array<{
          soulId: string;
          quote?: string;
          file?: string;
          startLine?: number;
          endLine?: number;
        }>;
      }>;
    };
    expect(redacted.redacted).toBe(true);
    const ev = redacted.artifacts[0]!.evidence[0]!;
    expect(ev.quote).toBeUndefined(); // verbatim source stripped
    expect(ev.file).toBe('src/auth.ts');
    expect(ev.startLine).toBe(10);
    expect(ev.endLine).toBe(11);
  });

  it('exportLlm(redact=false) keeps verbatim evidence quotes', () => {
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

    const enrich = new EnrichmentStore(soul, repo);
    const raw = JSON.parse(enrich.exportLlm(false)) as {
      redacted: boolean;
      artifacts: Array<{ evidence: Array<{ quote?: string }> }>;
    };
    expect(raw.redacted).toBe(false);
    expect(raw.artifacts[0]!.evidence[0]!.quote).toBe('return issue(user, pass)');
  });

  it('exportLlm(redact=true) masks a secret that slipped past persist (defense-in-depth for pre-M1.4 artifacts)', () => {
    // Simulate a pre-M1.4 artifact on disk (before the persist guard existed) with a canary in its
    // analysis. allArtifacts() walks analysis/ recursively for every .json, so a plain file works.
    const dir = join(repo, '.crib', 'graph', 'semantic', 'artifacts', 'symbol', 'legacy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'pre-m14.json'),
      JSON.stringify({
        version: 1,
        layer: 'symbol',
        targetId: loginId,
        nodeHash: contentHash('AuthService.login'),
        schemaVersion: soul.getManifest().schemaVersion,
        builtAt: '2026-01-01T00:00:00.000Z',
        analysis: { purpose: 'calls API with AKIAIOSFODNN7EXAMPLE key', confidence: 0.9 },
        graph: { nodes: [], edges: [] },
        evidence: [],
      }),
    );

    const enrich = new EnrichmentStore(soul, repo);
    const redacted = JSON.parse(enrich.exportLlm(true)) as {
      artifacts: Array<{ analysis: { purpose?: string } }>;
    };
    const purpose = redacted.artifacts[0]!.analysis.purpose!;
    expect(purpose).toContain('[REDACTED:aws-access-key-id]');
    expect(purpose).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
