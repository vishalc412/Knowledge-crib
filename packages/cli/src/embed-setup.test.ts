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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type OnnxStep,
  downloadOnnxWeights,
  onnxModelCacheDir,
  onnxProvisioningPin,
} from './embed-onnx.js';
import {
  DEFAULT_EMBED_ALIAS,
  EMBED_MODELS,
  adoptOfflineBundle,
  describeEvidence,
  pinAdapter,
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
    // The small row measures 66.0% against an 80% gate. Printing that is more honest than
    // "unverified", and a reader can open the cited run and disagree with it.
    const small = resolveModelSpec('small')!;
    expect(describeEvidence(small.evidence)).toMatch(/G2 66\.0%/);
    expect(describeEvidence(small.evidence)).toMatch(/6\/8 gates/);
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

  it('reports consent machine-readably: status consent-required, size + destination + identity named', async () => {
    // WP1.7: a noninteractive caller reads `status`, never prose. Both consent stops must carry
    // all three facts the operator is being asked to consent to: how big, where, and what.
    const weights = await setup();
    expect(weights.status).toBe('consent-required');
    expect(weights.needsConsent).toContain(onnxModelCacheDir(home));

    const runtime = await setup({ runtimePresent: () => false });
    expect(runtime.status).toBe('consent-required');
    expect(runtime.needsConsent).toMatch(/~376 MB/);
    expect(runtime.needsConsent).toContain(home);
  });

  it('reports status failed (not consent-required) when a CONSENTED step fails', async () => {
    const plan = await setup({
      yes: true,
      runtimePresent: () => false,
      installRuntime: () => fail('boom'),
    });
    expect(plan.status).toBe('failed');
    expect(plan.needsConsent).toBeUndefined();
  });

  it('reports status installed only on the full pinned-and-proven path', async () => {
    const plan = await setup({ yes: true });
    expect(plan.status).toBe('installed');
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
    writeCompleteModelUnder(bundle);
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

describe('adoptOfflineBundle — the air-gapped path passes the SAME gate (WP1.10)', () => {
  it('COPIES a complete bundle rather than linking to it', () => {
    // A link into a removable directory turns a working tier into one that breaks the day someone
    // unmounts the bundle — surfacing as a degraded fallback at query time, which is the silent
    // downgrade this tier exists to avoid.
    const bundle = join(home, 'b');
    writeCompleteModelUnder(bundle);
    const result = adoptOfflineBundle(home, bundle, spec.onnxId);
    expect(result.ok).toBe(true);
    rmSync(bundle, { recursive: true, force: true });
    // Still usable after the bundle is gone: the cache holds its own copy.
    expect(adoptOfflineBundle(home, join(home, 'b')).ok).toBe(false);
    expect(existsSync(join(modelDirUnder(onnxModelCacheDir(home)), 'tokenizer.json'))).toBe(true);
  });

  it('refuses an incomplete bundle without touching the existing cache', () => {
    writeOldModel();
    const bundle = join(home, 'partial-bundle');
    writeCompleteModelUnder(bundle, { 'config.json': '{}', 'onnx/model.onnx': 'weights' });
    const result = adoptOfflineBundle(home, bundle, spec.onnxId);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/tokenizer\.json is missing/);
    expect(result.detail).toMatch(/previous model was preserved/);
    expect(oldWeightsIntact()).toBe(true);
  });
});

// ─── WP1.8: the provisioning pin — weights + runtime deps ride in the manifest ──

describe('pinAdapter — the manifest pins what setup downloaded, not just the adapter', () => {
  /** The on-disk footprint of a completed setup, at fixture scale: weights + tokenizer in the
   *  cache, two pinned packages in the runtime. */
  function writeProvisionedFootprint(): void {
    const cache = onnxModelCacheDir(home);
    mkdirSync(join(cache, 'onnx'), { recursive: true });
    writeFileSync(join(cache, 'tokenizer.json'), '{"tokenizer":"fixture"}\n');
    writeFileSync(join(cache, 'onnx', 'model.onnx'), 'weights-bytes-fixture');
    const runtime = join(home, 'runtime');
    mkdirSync(join(runtime, 'node_modules', '@huggingface', 'transformers'), { recursive: true });
    writeFileSync(
      join(runtime, 'node_modules', '@huggingface', 'transformers', 'package.json'),
      '{"name":"@huggingface/transformers","version":"3.7.6"}\n',
    );
    mkdirSync(join(runtime, 'node_modules', 'onnxruntime-node'), { recursive: true });
    writeFileSync(
      join(runtime, 'node_modules', 'onnxruntime-node', 'package.json'),
      '{"name":"onnxruntime-node","version":"1.21.0"}\n',
    );
  }

  it('writes the weights pin (hashes) and the runtime dep pin into the manifest', async () => {
    writeProvisionedFootprint();
    const dir = join(home, 'adapters', 'fixture');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'embedder.mjs'),
      `export default { id: 'fixture', dim() { return 1; }, embed() { return new Float32Array(1); }, embedBatch(t) { return t.map(() => new Float32Array(1)); } }\n`,
    );
    const manifest = await pinAdapter(spec, dir, home);
    expect(manifest.provisioning?.onnxId).toBe(spec.onnxId);
    expect(manifest.provisioning?.weights.dir).toBe(onnxModelCacheDir(home));
    expect(manifest.provisioning?.weights.files.map((f) => f.path)).toEqual([
      'onnx/model.onnx',
      'tokenizer.json',
    ]);
    expect(manifest.provisioning?.runtime?.deps).toEqual({
      '@huggingface/transformers': '3.7.6',
      'onnxruntime-node': '1.21.0',
    });
    // WP1.9: the platform key is what makes a COPIED embed home fail at first verification
    // instead of later inside a dlopen of the wrong-arch onnxruntime binary.
    expect(manifest.provisioning?.runtime?.platform).toBe(`${process.platform}-${process.arch}`);
  });

  it('refuses to pin when the weight cache is empty — a vacuous pin passes every later check', () => {
    mkdirSync(onnxModelCacheDir(home), { recursive: true });
    expect(() => onnxProvisioningPin(home, spec)).toThrow(/is empty/);
  });

  it('refuses to pin when the weight cache is missing', () => {
    expect(() => onnxProvisioningPin(home, spec)).toThrow(/weight cache is missing/);
  });

  it('runEmbedSetup hands the pin step the home it provisioned', async () => {
    // The pin step receives (spec, dir, home) — the third argument is what lets the default pin
    // reach the weight cache; losing it would silently pin the adapter alone (the WP1.8 defect).
    let seen: string[] = [];
    await setup({
      yes: true,
      pin: async (s, d, h) => {
        seen = [s.alias, d, h];
      },
    });
    expect(seen[0]).toBe(spec.alias);
    expect(seen[2]).toBe(home);
  });
});

// ─── WP1.9: staged download — publish only after inference + completeness checks ──

/** The relative-path shape of a COMPLETE cached model — what a healthy fetch leaves behind. */
const COMPLETE_MODEL: Record<string, string> = {
  'config.json': '{"model_type":"fixture"}',
  'tokenizer.json': '{"tokenizer":"fixture"}',
  'onnx/model.onnx': 'new-weights-bytes',
};

/** Where a fetched model for `spec` lives under a cache/staging root. */
function modelDirUnder(root: string): string {
  const [org, name] = spec.onnxId.split('/');
  if (!org || !name) throw new Error(`fixture spec has no onnxId: ${spec.onnxId}`);
  return join(root, org, name);
}

/** A previously-installed model, distinguishable from a fresh fetch by its bytes. */
function writeOldModel(): void {
  const dir = modelDirUnder(onnxModelCacheDir(home));
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  writeFileSync(join(dir, 'onnx', 'model.onnx'), 'old-weights-bytes');
  writeFileSync(join(dir, 'config.json'), '{"model_type":"old"}');
  writeFileSync(join(dir, 'tokenizer.json'), '{"tokenizer":"old"}');
}

/** Write a model dir in the HF cache shape (`<root>/<org>/<name>/…`) — used for offline bundles,
 *  whose documented form is "copy the networked machine's models directory across". */
function writeCompleteModelUnder(root: string, files: Record<string, string> = COMPLETE_MODEL) {
  const dir = modelDirUnder(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
}

/** The real fetch is a node child process; the fake extracts the staging dir the script targets,
 *  writes `files` there as the "download", and prints a dim probe result. */
function fakeDownloadRun(
  files: Record<string, string>,
  dim: number = spec.dim,
): (cmd: string, args: string[], cwd: string) => string {
  return (_cmd: string, args: string[], _cwd: string) => {
    const script = args.find((a) => a.includes('env.cacheDir')) ?? '';
    const m = script.match(/env\.cacheDir = (("(?:[^"\\]|\\.)*"));/);
    const staging = m?.[1] ? (JSON.parse(m[1]) as string) : '';
    const dir = modelDirUnder(staging);
    mkdirSync(dir, { recursive: true });
    for (const [rel, contents] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
    }
    return `${JSON.stringify({ dim })}\n`;
  };
}

/** Any staging dir left behind after the run — a leak means an interrupted download left scratch
 *  in the embed home, which the next setup would then hash into the pin. */
const leftoverStaging = (): string[] =>
  readdirSync(home).filter((n) => n.startsWith('.download-staging-'));

const weightsBytes = (): string =>
  readFileSync(join(modelDirUnder(onnxModelCacheDir(home)), 'onnx', 'model.onnx'), 'utf8');

const oldWeightsIntact = (): boolean => weightsBytes() === 'old-weights-bytes';

describe('downloadOnnxWeights — staged, then atomically published (WP1.9)', () => {
  it('publishes a complete, dim-verified fetch and cleans staging', () => {
    const step = downloadOnnxWeights(home, spec, fakeDownloadRun(COMPLETE_MODEL));
    expect(step.ok).toBe(true);
    const model = modelDirUnder(onnxModelCacheDir(home));
    expect(existsSync(join(model, 'onnx', 'model.onnx'))).toBe(true);
    expect(existsSync(join(model, 'tokenizer.json'))).toBe(true);
    expect(leftoverStaging()).toEqual([]);
  });

  it('replaces an existing model in one rename, not a file-by-file overwrite', () => {
    writeOldModel();
    const step = downloadOnnxWeights(home, spec, fakeDownloadRun(COMPLETE_MODEL));
    expect(step.ok).toBe(true);
    // The old bytes must be GONE — a publish that merged old and new would leave a mixed cache
    // whose every file individually verifies but which no model load can serve.
    expect(weightsBytes()).toBe('new-weights-bytes');
    const onDisk = readdirSync(join(modelDirUnder(onnxModelCacheDir(home)), 'onnx')).sort();
    expect(onDisk).toEqual(['model.onnx']);
  });

  it('an INTERRUPTED download preserves the old model and leaves no staging behind', () => {
    writeOldModel();
    const step = downloadOnnxWeights(home, spec, () => {
      throw new Error('connection reset mid-download');
    });
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/weight download failed/);
    expect(oldWeightsIntact()).toBe(true);
    expect(leftoverStaging()).toEqual([]);
  });

  it('a ZERO-BYTE staged file is never published', () => {
    writeOldModel();
    const step = downloadOnnxWeights(
      home,
      spec,
      fakeDownloadRun({ ...COMPLETE_MODEL, 'onnx/model.onnx': '' }),
    );
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/zero bytes/);
    expect(step.detail).toMatch(/previous model was preserved/);
    expect(oldWeightsIntact()).toBe(true);
  });

  it('a fetch missing the tokenizer is never published', () => {
    writeOldModel();
    const { 'tokenizer.json': _tokenizer, ...files } = COMPLETE_MODEL;
    const step = downloadOnnxWeights(home, spec, fakeDownloadRun(files));
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/tokenizer\.json is missing/);
    expect(oldWeightsIntact()).toBe(true);
  });

  it('a dim that disagrees with the ladder pin is never published', () => {
    writeOldModel();
    const step = downloadOnnxWeights(home, spec, fakeDownloadRun(COMPLETE_MODEL, spec.dim + 1));
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(new RegExp(`model reports dim ${spec.dim + 1}`));
    expect(oldWeightsIntact()).toBe(true);
  });
});
