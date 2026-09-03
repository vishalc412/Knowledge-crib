/**
 * G3.2 tier + remote-policy tests. Two red lines are pinned here:
 *   - the doctor surface reports the ACTIVE tier honestly (fallback vs installed), and the fallback
 *     wording always carries the DEGRADED-OFFLINE-FALLBACK framing — never "semantic";
 *   - the remote tier is DISABLED unless the operator explicitly accepted the current data policy
 *     (disabled-by-default is a red line; every fail-open shape fails this suite).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installEmbedModel } from './embed-install.js';
import {
  REMOTE_EMBED_POLICY_TEXT,
  REMOTE_EMBED_POLICY_VERSION,
  RemoteEmbedPolicyError,
  remoteOptIn,
  remotePolicyPath,
  resolveRemoteEmbedder,
} from './remote.js';
import { embedTierReport } from './tier.js';

const FIXTURE_EMBEDDER = `
export default {
  id: 'test-fixture-embedder-v1',
  dim() { return 8; },
  embed(text) {
    const v = new Float32Array(8);
    for (let i = 0; i < text.length; i++) v[i % 8] = (v[i % 8] ?? 0) + (i + 1);
    return v;
  },
  embedBatch(texts) { return texts.map((t) => this.embed(t)); },
};
`;

let home: string;
let modelDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crib-tier-home-'));
  modelDir = mkdtempSync(join(tmpdir(), 'crib-tier-model-'));
  process.env.KCRIB_EMBED_HOME = home;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env-var removal requires the delete operator
  delete process.env.KCRIB_EMBED_HOME;
  // biome-ignore lint/performance/noDelete: env-var removal requires the delete operator
  delete process.env.KCRIB_EMBEDDER;
  rmSync(home, { recursive: true, force: true });
  rmSync(modelDir, { recursive: true, force: true });
});

async function installFixture(): Promise<void> {
  writeFileSync(join(modelDir, 'embedder.mjs'), FIXTURE_EMBEDDER, 'utf8');
  await installEmbedModel({ modelDir, modelId: 'fixture-model', modelVersion: '1.0.0', home });
}

describe('embedTierReport — the doctor surface', () => {
  it('no install: tier is the degraded fallback, with the honest wording', async () => {
    const r = await embedTierReport({ home });
    expect(r.tier).toBe('fallback');
    expect(r.manifestPresent).toBe(false);
    expect(r.embedderId).toBe(r.fallbackId);
    expect(r.reason).toContain('DEGRADED OFFLINE FALLBACK');
    expect(r.reason).not.toMatch(/semantic implementation/i);
    expect(r.reason).toContain('crib embed install');
  });

  it('installed manifest: tier reports the pinned model identity', async () => {
    await installFixture();
    const r = await embedTierReport({ home });
    expect(r.tier).toBe('installed');
    expect(r.embedderId).toBe('test-fixture-embedder-v1');
    expect(r.modelId).toBe('fixture-model');
    expect(r.modelVersion).toBe('1.0.0');
    expect(r.integrityOk).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('a broken install degrades the REPORT to fallback with problems — doctor renders, never crashes', async () => {
    await installFixture();
    rmSync(modelDir, { recursive: true, force: true });
    const r = await embedTierReport({ home });
    expect(r.tier).toBe('fallback');
    expect(r.integrityOk).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('remoteEnabled reflects the policy gate, and defaults to FALSE', async () => {
    const r = await embedTierReport({ home });
    expect(r.remoteEnabled).toBe(false);
  });

  it('an external KCRIB_EMBEDDER override is surfaced, not folded into a tier', async () => {
    process.env.KCRIB_EMBEDDER = './my-embedder.mjs';
    const r = await embedTierReport({ home });
    expect(r.externalOverride).toBe(true);
    expect(r.tier).toBe('fallback');
  });
});

describe('remote embedder policy — disabled by default is the pinned state', () => {
  it('no policy file: remoteOptIn is false and resolution throws RemoteEmbedPolicyError', async () => {
    expect(remoteOptIn(home)).toBe(false);
    await expect(resolveRemoteEmbedder({ module: './x.mjs', home })).rejects.toBeInstanceOf(
      RemoteEmbedPolicyError,
    );
  });

  it('a malformed policy file fails CLOSED (cannot half-enable data egress)', async () => {
    writeFileSync(remotePolicyPath(home), '{not json', 'utf8');
    expect(remoteOptIn(home)).toBe(false);
    await expect(resolveRemoteEmbedder({ module: './x.mjs', home })).rejects.toBeInstanceOf(
      RemoteEmbedPolicyError,
    );
  });

  it('an acknowledged but STALE policy version fails closed — policy text changes re-require consent', async () => {
    writeFileSync(
      remotePolicyPath(home),
      JSON.stringify({ acknowledged: true, policyVersion: REMOTE_EMBED_POLICY_VERSION + 1 }),
      'utf8',
    );
    expect(remoteOptIn(home)).toBe(false);
  });

  it('a truthy-but-not-literal-true acknowledgment fails closed', async () => {
    writeFileSync(
      remotePolicyPath(home),
      JSON.stringify({ acknowledged: 'true', policyVersion: REMOTE_EMBED_POLICY_VERSION }),
      'utf8',
    );
    expect(remoteOptIn(home)).toBe(false);
  });

  it('explicit acknowledgment of the CURRENT policy version opens the gate (and only that)', async () => {
    expect(REMOTE_EMBED_POLICY_TEXT).toContain('sends query text');
    writeFileSync(
      remotePolicyPath(home),
      JSON.stringify({ acknowledged: true, policyVersion: REMOTE_EMBED_POLICY_VERSION }),
      'utf8',
    );
    expect(remoteOptIn(home)).toBe(true);
  });
});
