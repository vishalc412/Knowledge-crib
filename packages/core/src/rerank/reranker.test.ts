/**
 * The reranker tier's contract — everything that can be asserted WITHOUT the ~1.1 GB model.
 *
 * The model-backed behaviour (real logits, correct ordering) is measured by
 * `scripts/eval/code-vector-eval.mjs --rerank` rather than unit-tested: a 1.1 GB download in the test
 * suite would make `pnpm test` unrunnable offline, and a ranking assertion belongs in a corpus
 * measurement anyway. What IS unit-tested is everything that fails silently — the manifest contract,
 * the integrity gate, the generated adapter's own guards, and the layering constant.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RERANK_DEPTH } from '../index.js';
import {
  RERANK_MANIFEST_FORMAT_VERSION,
  RerankIntegrityError,
  RerankManifestError,
  RerankNotInstalledError,
  installReranker,
  readRerankManifest,
  renderRerankWorkerMjs,
  renderRerankerMjs,
  rerankHomeDir,
  rerankManifestPath,
  verifyInstalledReranker,
} from './reranker-install.js';

let home: string;
let embedHome: string;

/** A fake embed tier: a runtime marker plus weight files, which is all provisioning inspects. */
function fakeEmbedTier(): void {
  mkdirSync(join(embedHome, 'runtime'), { recursive: true });
  writeFileSync(join(embedHome, 'runtime', 'package.json'), '{"name":"fake-runtime"}\n');
  const weights = join(embedHome, 'models', 'Xenova/bge-reranker-base');
  mkdirSync(join(weights, 'onnx'), { recursive: true });
  writeFileSync(join(weights, 'config.json'), '{"num_labels":1}\n');
  writeFileSync(join(weights, 'onnx', 'model.onnx'), 'not-a-real-model');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crib-rr-home-'));
  embedHome = mkdtempSync(join(tmpdir(), 'crib-rr-embed-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(embedHome, { recursive: true, force: true });
});

describe('reranker provisioning', () => {
  it('refuses when the reused ONNX runtime is absent, and names the prerequisite', () => {
    expect(() => installReranker({ modelId: 'Xenova/bge-reranker-base', home, embedHome })).toThrow(
      RerankNotInstalledError,
    );
    expect(() => installReranker({ modelId: 'Xenova/bge-reranker-base', home, embedHome })).toThrow(
      /crib embed setup/,
    );
  });

  it('refuses when the weights were never downloaded', () => {
    mkdirSync(join(embedHome, 'runtime'), { recursive: true });
    writeFileSync(join(embedHome, 'runtime', 'package.json'), '{}\n');
    expect(() => installReranker({ modelId: 'Xenova/bge-reranker-base', home, embedHome })).toThrow(
      /no downloaded weights/,
    );
  });

  it('pins the adapter AND the weights — swapped weights change the ranking with no code change', () => {
    fakeEmbedTier();
    const manifest = installReranker({ modelId: 'Xenova/bge-reranker-base', home, embedHome });
    expect(manifest.formatVersion).toBe(RERANK_MANIFEST_FORMAT_VERSION);
    expect(manifest.files.length).toBe(2); // reranker.mjs + rerank-worker.mjs
    expect(manifest.weights.files.length).toBe(2);
    // weight paths are recorded model-relative so the manifest is readable and re-verifiable
    expect(manifest.weights.files.map((f) => f.path).sort()).toEqual([
      'Xenova/bge-reranker-base/config.json',
      'Xenova/bge-reranker-base/onnx/model.onnx',
    ]);
    expect(verifyInstalledReranker(home).rerankerId).toBe(manifest.rerankerId);
  });

  it('a drifted ADAPTER file fails verification', () => {
    fakeEmbedTier();
    const manifest = installReranker({ modelId: 'Xenova/bge-reranker-base', home, embedHome });
    writeFileSync(join(manifest.modelDir, 'reranker.mjs'), '/* tampered */\n');
    expect(() => verifyInstalledReranker(home)).toThrow(RerankIntegrityError);
    expect(() => verifyInstalledReranker(home)).toThrow(/re-run `crib rerank setup`/);
  });

  it('a drifted WEIGHT file fails verification too', () => {
    fakeEmbedTier();
    installReranker({ modelId: 'Xenova/bge-reranker-base', home, embedHome });
    writeFileSync(
      join(embedHome, 'models', 'Xenova/bge-reranker-base', 'config.json'),
      '{"num_labels":2}\n',
    );
    expect(() => verifyInstalledReranker(home)).toThrow(/pinned weight file changed/);
  });

  it('reports "not installed" rather than throwing something opaque', () => {
    expect(() => readRerankManifest(home)).toThrow(RerankNotInstalledError);
    expect(() => readRerankManifest(home)).toThrow(/crib rerank setup/);
  });

  it('refuses a manifest from a different format version', () => {
    fakeEmbedTier();
    installReranker({ modelId: 'Xenova/bge-reranker-base', home, embedHome });
    const path = rerankManifestPath(home);
    const m = JSON.parse(readFileSync(path, 'utf8'));
    m.formatVersion = 99;
    writeFileSync(path, JSON.stringify(m));
    expect(() => readRerankManifest(home)).toThrow(RerankManifestError);
  });

  it('honours KCRIB_RERANK_HOME and stays OUTSIDE the embed home', () => {
    expect(rerankHomeDir({ KCRIB_RERANK_HOME: '/tmp/x' } as NodeJS.ProcessEnv)).toBe('/tmp/x');
    // The embed manifest hashes its own subtree, so a reranker written under it would break that
    // install on first use. The default path must therefore be a sibling, never a child.
    const def = rerankHomeDir({ HOME: '/home/u' } as NodeJS.ProcessEnv);
    expect(def).toBe('/home/u/.crib/rerank');
    expect(def.startsWith('/home/u/.crib/embed')).toBe(false);
  });
});

describe('the generated adapter', () => {
  const rendered = renderRerankerMjs({
    rerankerId: 'test-rr',
    modelId: 'Xenova/bge-reranker-base',
    runtimeDir: '/rt',
    cacheDir: '/models',
  });

  it('is valid JS and exports a Reranker-shaped default', () => {
    expect(rendered).toContain('export default {');
    expect(rendered).toContain('rerankBatch(query, texts)');
    expect(rendered).toContain('id: ID');
  });

  it('guards a score/candidate length mismatch — misaligned scores look considered and are not', () => {
    expect(rendered).toMatch(/scores for \$\{texts\.length\} texts/);
  });

  it('returns [] for an empty candidate set rather than calling the model', () => {
    expect(rendered).toContain('if (!Array.isArray(texts) || texts.length === 0) return [];');
  });

  it('the worker forbids remote fetching, so a query cannot pick up different weights', () => {
    const worker = renderRerankWorkerMjs();
    expect(worker).toContain('env.allowRemoteModels = false;');
    expect(worker).toContain('env.allowLocalModels = true;');
  });

  it('the worker reads LOGITS, not a softmaxed classification', () => {
    const worker = renderRerankWorkerMjs();
    // `pipeline('text-classification')` softmaxes a single output label and returns 1.0 for every
    // pair — a reranker that silently reorders nothing. This is the line that avoids it.
    expect(worker).toContain('AutoModelForSequenceClassification');
    expect(worker).toContain('logits');
    expect(worker).not.toContain("pipeline('text-classification'");
  });

  it('the worker accepts BOTH module shapes — path resolution lands on the CJS build', () => {
    const worker = renderRerankWorkerMjs();
    expect(worker).toContain('mod?.env ? mod : mod?.default');
    expect(worker).toMatch(/did not expose env\/AutoTokenizer/);
  });
});

describe('layering', () => {
  it('core mirrors memory’s DEFAULT_RERANK_DEPTH rather than importing it', () => {
    // `core` must not depend on `memory`. The constant is duplicated, so it is pinned here: if
    // memory changes its depth and this is not updated, a scorer version id would claim a depth the
    // loader does not use.
    expect(DEFAULT_RERANK_DEPTH).toBe(50);
  });
});
