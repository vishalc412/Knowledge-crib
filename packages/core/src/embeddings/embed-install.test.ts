/**
 * G3.2 embed-install tests — the pinned on-device tier's fail-closed contract.
 *
 * Pinned invariants (red line #3): the manifest is the pin (id + version + per-file sha256);
 * `loadInstalledEmbedder` verifies BEFORE import and re-checks the pin AFTER; an unusable install
 * leaves NO manifest (the fallback tier stays active rather than a broken install silently serving);
 * nothing here ever touches the network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EmbedIntegrityError,
  EmbedManifestError,
  EmbedModelNotInstalledError,
  embedHomeDir,
  embedManifestPath,
  hashDirFiles,
  installEmbedModel,
  loadInstalledEmbedder,
  readEmbedManifest,
  verifyInstalledEmbed,
} from './embed-install.js';
import { resolveEmbedder } from './provider.js';

/** A tiny deterministic Embedder module — the operator-supplied entry the install pins. */
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
  home = mkdtempSync(join(tmpdir(), 'crib-embed-home-'));
  modelDir = mkdtempSync(join(tmpdir(), 'crib-embed-model-'));
  process.env.KCRIB_EMBED_HOME = home;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env-var removal requires the delete operator
  delete process.env.KCRIB_EMBED_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(modelDir, { recursive: true, force: true });
});

function writeFixtureModel(): string {
  writeFileSync(join(modelDir, 'embedder.mjs'), FIXTURE_EMBEDDER, 'utf8');
  writeFileSync(join(modelDir, 'model.json'), '{"kind":"fixture"}\n', 'utf8');
  return join(modelDir, 'embedder.mjs');
}

describe('installEmbedModel', () => {
  it('pins the model: manifest carries id, version, dim, and per-file sha256', async () => {
    writeFixtureModel();
    const m = await installEmbedModel({
      modelDir,
      modelId: 'fixture-model',
      modelVersion: '1.0.0',
      home,
    });
    expect(m.embedderId).toBe('test-fixture-embedder-v1');
    expect(m.modelId).toBe('fixture-model');
    expect(m.modelVersion).toBe('1.0.0');
    expect(m.dim).toBe(8);
    expect(m.files.map((f) => f.path).sort()).toEqual(['embedder.mjs', 'model.json']);
    for (const f of m.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed: a model dir without the entry module leaves NO manifest', async () => {
    await expect(
      installEmbedModel({ modelDir, modelId: 'x', modelVersion: '0', home }),
    ).rejects.toBeInstanceOf(EmbedManifestError);
    expect(readEmbedManifest(home)).toBeUndefined();
  });

  it('fails closed: a module with no default Embedder export is refused before pinning', async () => {
    writeFileSync(join(modelDir, 'embedder.mjs'), 'export default {};\n', 'utf8');
    await expect(
      installEmbedModel({ modelDir, modelId: 'x', modelVersion: '0', home }),
    ).rejects.toBeInstanceOf(EmbedManifestError);
    expect(readEmbedManifest(home)).toBeUndefined();
  });

  it('embedHomeDir honors KCRIB_EMBED_HOME (tests relocate the whole tree)', () => {
    expect(embedHomeDir()).toBe(home);
  });
});

describe('loadInstalledEmbedder — verify before import, pin re-checked after', () => {
  it('loads the installed model and reproduces identical vectors across loads (determinism)', async () => {
    writeFixtureModel();
    await installEmbedModel({ modelDir, modelId: 'fixture-model', modelVersion: '1.0.0', home });
    const a = await loadInstalledEmbedder(home);
    const b = await loadInstalledEmbedder(home);
    expect(a?.id).toBe('test-fixture-embedder-v1');
    expect(a?.dim()).toBe(8);
    expect(Array.from(a!.embed('assess_application'))).toEqual(
      Array.from(b!.embed('assess_application')),
    );
  });

  it('returns undefined when nothing is installed — the caller decides the fallback', async () => {
    expect(await loadInstalledEmbedder(home)).toBeUndefined();
  });

  it('refuses to serve a tampered model dir (hash drift detected before import)', async () => {
    writeFixtureModel();
    await installEmbedModel({ modelDir, modelId: 'fixture-model', modelVersion: '1.0.0', home });
    writeFileSync(join(modelDir, 'embedder.mjs'), `${FIXTURE_EMBEDDER}\n// tampered\n`, 'utf8');
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('hash drift embedder.mjs');
    await expect(loadInstalledEmbedder(home)).rejects.toBeInstanceOf(EmbedIntegrityError);
  });

  it('refuses to serve a model dir whose files vanished (missing file detected)', async () => {
    writeFixtureModel();
    await installEmbedModel({ modelDir, modelId: 'fixture-model', modelVersion: '1.0.0', home });
    rmSync(join(modelDir, 'model.json'), { force: true });
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain('missing file model.json');
    await expect(loadInstalledEmbedder(home)).rejects.toBeInstanceOf(EmbedIntegrityError);
  });

  it('a drifted manifest formatVersion is an integrity failure, never a serve', async () => {
    writeFixtureModel();
    await installEmbedModel({ modelDir, modelId: 'fixture-model', modelVersion: '1.0.0', home });
    writeFileSync(embedManifestPath(home), '{"formatVersion": 999}\n', 'utf8');
    expect(() => readEmbedManifest(home)).toThrow(EmbedManifestError);
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    await expect(loadInstalledEmbedder(home)).rejects.toBeInstanceOf(EmbedIntegrityError);
  });
});

describe('provider integration — the "installed" tier id', () => {
  it('resolveEmbedder({provider:"installed"}) loads the pinned model when present', async () => {
    writeFixtureModel();
    await installEmbedModel({ modelDir, modelId: 'fixture-model', modelVersion: '1.0.0', home });
    const e = await resolveEmbedder({ provider: 'installed' });
    expect(e.id).toBe('test-fixture-embedder-v1');
  });

  it('resolveEmbedder({provider:"installed"}) throws a remediation-naming error when absent', async () => {
    await expect(resolveEmbedder({ provider: 'installed' })).rejects.toBeInstanceOf(
      EmbedModelNotInstalledError,
    );
  });
});

// ─── WP1.8: the provisioning pin — weights + runtime deps ──────────────────────

let cacheDir: string;
let runtimeDir: string;

/** A fake provisioning footprint: a weight cache (weights + tokenizer) and a runtime with pinned
 *  package versions — the on-disk shape `crib embed setup` leaves behind, at fixture scale. */
function writeProvisioning(): void {
  cacheDir = mkdtempSync(join(tmpdir(), 'crib-embed-cache-'));
  runtimeDir = mkdtempSync(join(tmpdir(), 'crib-embed-runtime-'));
  mkdirSync(join(cacheDir, 'onnx'), { recursive: true });
  writeFileSync(join(cacheDir, 'tokenizer.json'), '{"tokenizer":"fixture"}\n', 'utf8');
  writeFileSync(join(cacheDir, 'onnx', 'model.onnx'), 'weights-bytes-fixture', 'utf8');
  mkdirSync(join(runtimeDir, 'node_modules', '@huggingface', 'transformers'), {
    recursive: true,
  });
  writeFileSync(
    join(runtimeDir, 'node_modules', '@huggingface', 'transformers', 'package.json'),
    '{"name":"@huggingface/transformers","version":"3.7.6"}\n',
    'utf8',
  );
}

/** Install the fixture model WITH the provisioning pin — the WP1.8 manifest shape. */
async function installWithProvisioning() {
  return installEmbedModel({
    modelDir,
    modelId: 'fixture-model',
    modelVersion: '1.0.0',
    home,
    provisioning: {
      onnxId: 'Xenova/fixture-model',
      weights: { dir: cacheDir, files: hashDirFiles(cacheDir) },
      runtime: { dir: runtimeDir, deps: { '@huggingface/transformers': '3.7.6' } },
    },
  });
}

describe('WP1.8 provisioning pin — weights and runtime deps are verified, not trusted', () => {
  beforeEach(() => {
    writeFixtureModel();
    writeProvisioning();
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('the manifest records the weight files by sha256 and the runtime deps by installed version', async () => {
    const m = await installWithProvisioning();
    expect(m.provisioning?.onnxId).toBe('Xenova/fixture-model');
    expect(m.provisioning?.weights.dir).toBe(cacheDir);
    expect(m.provisioning?.weights.files.map((f) => f.path)).toEqual([
      'onnx/model.onnx',
      'tokenizer.json',
    ]);
    expect(m.provisioning?.runtime?.deps).toEqual({ '@huggingface/transformers': '3.7.6' });
    expect(verifyInstalledEmbed(home).ok).toBe(true);
  });

  it('a tampered WEIGHT file fails verification even though the adapter dir is intact', async () => {
    await installWithProvisioning();
    writeFileSync(join(cacheDir, 'onnx', 'model.onnx'), 'tampered-bytes', 'utf8');
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    // The weights: label is what tells an operator this drift is in the 2 GB cache, not the adapter.
    expect(v.problems.join('\n')).toContain('weights: hash drift onnx/model.onnx');
    await expect(loadInstalledEmbedder(home)).rejects.toBeInstanceOf(EmbedIntegrityError);
  });

  it('a vanished weight file (half-copied cache) fails verification', async () => {
    await installWithProvisioning();
    rmSync(join(cacheDir, 'tokenizer.json'), { force: true });
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('weights: missing file tokenizer.json');
  });

  it('an upgraded runtime dep fails verification — the vector space must not shift silently', async () => {
    await installWithProvisioning();
    writeFileSync(
      join(runtimeDir, 'node_modules', '@huggingface', 'transformers', 'package.json'),
      '{"name":"@huggingface/transformers","version":"3.7.7"}\n',
      'utf8',
    );
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain(
      'runtime dep drift @huggingface/transformers: installed 3.7.7 != pinned 3.7.6',
    );
  });

  it('a missing runtime dep fails verification', async () => {
    await installWithProvisioning();
    rmSync(join(runtimeDir, 'node_modules'), { recursive: true, force: true });
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('runtime dep @huggingface/transformers is missing');
  });

  it('a runtime pinned on a DIFFERENT platform fails verification — a copied embed home must be refused up front', async () => {
    // WP1.9: the onnxruntime native binaries are per-OS-per-arch. An embed home rsynced across
    // machines passes every hash check (the files are bit-identical) and then dies inside a dlopen
    // with an error naming neither the cause nor the fix. The platform key surfaces that at the
    // FIRST verification, with a remediation.
    await installWithProvisioning();
    const m = readEmbedManifest(home)!;
    m.provisioning!.runtime!.platform = 'other-os-x99';
    writeFileSync(embedManifestPath(home), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('runtime platform drift: installed on other-os-x99');
    expect(v.problems.join('\n')).toContain(`running on ${process.platform}-${process.arch}`);
  });

  it('an EMPTY weights pin is refused — a vacuous pin would pass every future check', async () => {
    writeFileSync(
      embedManifestPath(home),
      JSON.stringify({
        formatVersion: 2,
        embedderId: 'x',
        modelId: 'x',
        modelVersion: '1',
        dim: 8,
        modelDir,
        entry: 'embedder.mjs',
        files: [],
        provisioning: { onnxId: 'x', weights: { dir: cacheDir, files: [] } },
      }),
      'utf8',
    );
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('is pinned as EMPTY');
  });

  it('a dep name from a tampered manifest is never resolved outside node_modules', async () => {
    await installWithProvisioning();
    // A hand-edited manifest trying to make the verifier read an arbitrary package.json.
    const m = readEmbedManifest(home)!;
    m.provisioning!.runtime!.deps = { '../../../../etc/hosts': '1.0.0' };
    writeFileSync(embedManifestPath(home), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('runtime dep ../../../../etc/hosts is missing');
  });

  it('a v1 manifest (weights never pinned) is refused — unverifiable weights are not served', async () => {
    const m = await installWithProvisioning();
    writeFileSync(
      embedManifestPath(home),
      JSON.stringify({ ...m, formatVersion: 1 }, null, 2),
      'utf8',
    );
    expect(() => readEmbedManifest(home)).toThrow(/formatVersion 1 != 2/);
    const v = verifyInstalledEmbed(home);
    expect(v.ok).toBe(false);
  });
});
