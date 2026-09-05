/**
 * `crib embed setup` — the supported semantic installation path.
 *
 * F05 (docs/audits/2026-09-05) found the on-device tier reachable only through a README ritual whose
 * final step named a path inside the git checkout, which the published package does not ship — so an
 * npm install could not follow the documented instructions at all and silently served the lexical
 * fallback. The deeper barrier was the toolchain: reaching the tier required `pip install
 * sentence-transformers` (and PyTorch) from a Node CLI, which is where real installs died.
 *
 * Setup is now ONNX — npm packages installed into crib's embed home, no Python. What did not change
 * is what the tests below pin:
 *   - the ladder never states a quality number this repository cannot source;
 *   - nothing reaches the network without consent, and a stopped run prints the exact command;
 *   - setup does NOT report success on a model that loads but does not RANK, because "installed"
 *     silently meaning "still lexical" is the audited failure itself.
 *
 * Every side-effecting step is injected, so each branch is exercised without a network, an npm
 * install, or a multi-gigabyte download on the machine running the suite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OnnxStep } from './embed-onnx.js';
import {
  DEFAULT_EMBED_ALIAS,
  EMBED_MODELS,
  adoptOfflineBundle,
  describeEvidence,
  resolveModelSpec,
  runEmbedSetup,
} from './embed-setup.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crib-embed-setup-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const spec = resolveModelSpec(DEFAULT_EMBED_ALIAS)!;
const passingSmoke = async () => ({ ok: true, detail: 'paraphrase 0.90 > unrelated 0.10' });
const noopPin = async () => ({});
const ok = (detail: string): OnnxStep => ({ ok: true, detail });
const fail = (detail: string): OnnxStep => ({ ok: false, detail });

/** Setup with every side effect stubbed; `over` steers one branch at a time. */
function setup(over: Partial<Parameters<typeof runEmbedSetup>[0]> = {}) {
  return runEmbedSetup({
    spec,
    yes: false,
    home,
    smoke: passingSmoke,
    pin: noopPin,
    runtimePresent: () => true,
    installRuntime: () => ok('installed'),
    fetchWeights: () => ok('fetched'),
    ...over,
  });
}

const stepNames = (plan: Awaited<ReturnType<typeof runEmbedSetup>>) =>
  plan.steps.map((s) => s.name);

describe('the model ladder states only sourceable evidence', () => {
  it('cites a committed document and a real number on every gate-verified row', () => {
    for (const model of EMBED_MODELS) {
      if (model.evidence.kind === 'gate-verified') {
        expect(model.evidence.source, model.alias).toMatch(/^docs\//);
        expect(model.evidence.g2, model.alias).toBeGreaterThan(0);
        expect(model.evidence.gates, model.alias).toBeGreaterThan(0);
        expect(model.evidence.gates, model.alias).toBeLessThanOrEqual(8);
      } else {
        expect(model.evidence.reason.length, model.alias).toBeGreaterThan(0);
      }
    }
  });

  it('defaults to the ONLY model that clears all eight frozen gates', () => {
    // Shipping a row that fails a gate as "the semantic tier" would advertise a threshold the
    // project's own release evidence would then fail — the overreach the audit flagged.
    const chosen = resolveModelSpec(DEFAULT_EMBED_ALIAS)!;
    expect(chosen.evidence.kind).toBe('gate-verified');
    if (chosen.evidence.kind !== 'gate-verified') return;
    expect(chosen.evidence.gates).toBe(8);
    for (const m of EMBED_MODELS) {
      if (m.alias === chosen.alias) continue;
      if (m.evidence.kind === 'gate-verified') expect(m.evidence.gates).toBeLessThan(8);
    }
  });

  it('prints a failing row’s real number rather than hiding it behind a label', () => {
    // The small row measures 42.5% against an 80% gate. Printing that is more honest than
    // "unverified", and a reader can open the cited run and disagree with it.
    const small = resolveModelSpec('small')!;
    expect(describeEvidence(small.evidence)).toMatch(/G2 42\.5%/);
    expect(describeEvidence(small.evidence)).toMatch(/7\/8 gates/);
  });

  it('names an ONNX mirror for every row — that is what the runtime can actually load', () => {
    for (const m of EMBED_MODELS) expect(m.onnxId, m.alias).toMatch(/^[\w-]+\/[\w.-]+$/);
  });
});

describe('runEmbedSetup — consent', () => {
  it('installs NOTHING without --yes, and names the runtime it would install', async () => {
    const plan = await setup({ runtimePresent: () => false });
    expect(plan.installed).toBe(false);
    expect(plan.needsConsent).toMatch(/ONNX runtime/);
    expect(plan.remediation.join('\n')).toContain('--yes');
    // The air-gapped alternative is offered at the same moment, not buried in docs.
    expect(plan.remediation.join('\n')).toContain('--from');
  });

  it('does not download weights without --yes, and says exactly what it would fetch', async () => {
    const plan = await setup();
    expect(plan.installed).toBe(false);
    expect(plan.needsConsent).toContain(spec.onnxId);
    expect(plan.needsConsent).toContain(spec.approxDisk);
  });

  it('installs, pins and PROVES the tier under --yes', async () => {
    const plan = await setup({ yes: true, runtimePresent: () => false });
    expect(plan.installed).toBe(true);
    expect(stepNames(plan)).toEqual(['runtime', 'weights', 'adapter', 'pin', 'smoke']);
  });

  it('skips the runtime install when it is already present', async () => {
    const plan = await setup({ yes: true });
    expect(plan.installed).toBe(true);
    expect(plan.steps[0]).toMatchObject({ name: 'runtime' });
    expect(plan.steps[0]?.result.detail).toMatch(/already installed/);
  });
});

describe('runEmbedSetup — failure is never reported as success', () => {
  it('does NOT claim a tier when the model loads but does not rank', async () => {
    // The audited failure exactly: a configured-but-unusable tier silently serving lexical results.
    const plan = await setup({
      yes: true,
      smoke: async () => ({ ok: false, detail: 'no semantic signal: paraphrase 0.10 <= 0.11' }),
    });
    expect(plan.installed).toBe(false);
    expect(plan.remediation.join('\n')).toContain('NOT enabled');
  });

  it('does not claim a tier when pinning fails', async () => {
    const plan = await setup({
      yes: true,
      pin: async () => {
        throw new Error('manifest write failed');
      },
    });
    expect(plan.installed).toBe(false);
    expect(stepNames(plan)).toContain('pin');
  });

  it('stops when the runtime install fails, without attempting a download', async () => {
    const plan = await setup({
      yes: true,
      runtimePresent: () => false,
      installRuntime: () => fail('npm not found'),
    });
    expect(plan.installed).toBe(false);
    expect(stepNames(plan)).not.toContain('weights');
  });

  it('stops when the weight download fails', async () => {
    const plan = await setup({ yes: true, fetchWeights: () => fail('connection reset') });
    expect(plan.installed).toBe(false);
    expect(plan.remediation.join('\n')).toMatch(/download failed/i);
  });
});

describe('runEmbedSetup — the air-gapped path', () => {
  it('adopts a pre-fetched bundle and NEVER fetches, even without --yes', async () => {
    const bundle = join(home, 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'model.onnx'), 'weights');
    let fetched = false;
    const plan = await setup({
      from: bundle,
      runtimePresent: () => false,
      fetchWeights: () => {
        fetched = true;
        return ok('should not happen');
      },
    });
    expect(plan.installed).toBe(true);
    // Consent is about reaching the NETWORK. A bundle already on disk needs none, and asking for
    // it would make the offline path impossible on the hosts that need it most.
    expect(fetched).toBe(false);
    expect(stepNames(plan)).toContain('weights (offline bundle)');
  });

  it('refuses a bundle that is not there rather than pinning an empty cache', async () => {
    const plan = await setup({ from: join(home, 'no-such-bundle') });
    expect(plan.installed).toBe(false);
    expect(plan.remediation.join('\n')).toMatch(/does not contain a usable model cache/);
  });
});

describe('adoptOfflineBundle', () => {
  it('COPIES the bundle rather than linking to it', () => {
    // A link into a removable directory turns a working tier into one that breaks the day someone
    // unmounts the bundle — surfacing as a degraded fallback at query time, which is the silent
    // downgrade this tier exists to avoid.
    const bundle = join(home, 'b');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'w.bin'), 'weights');
    const result = adoptOfflineBundle(home, bundle);
    expect(result.ok).toBe(true);
    rmSync(bundle, { recursive: true, force: true });
    // Still usable after the bundle is gone.
    expect(adoptOfflineBundle(home, join(home, 'b')).ok).toBe(false);
  });
});
