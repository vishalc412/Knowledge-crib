/**
 * The RERANKER tier — provisioning, integrity pinning, and loading for an on-device cross-encoder.
 *
 * WHY A SECOND STAGE EXISTS AT ALL, measured rather than assumed. A bi-encoder must commit to one
 * document vector before it has seen the query, so it can put the right answer in the candidate pool
 * and still fail to put it near the top. On this repository's own launch corpus that is exactly what
 * happens: the correct record is retrieved for EVERY word-disjoint query at some depth, yet ranks
 * top-5 for only 43.8% of them (`packages/memory/src/fusion.ts`). A cross-encoder scores the
 * (query, text) PAIR jointly, which is the thing a bi-encoder structurally cannot do, and the
 * `Reranker` port + `DEFAULT_RERANK_DEPTH` were written for it. This module is the implementation
 * that port has been waiting for.
 *
 * MODEL CHOICE, and why it is not the obvious one. `ms-marco-MiniLM` is the standard small
 * cross-encoder and is ~90 MB against bge-reranker-base's ~1.1 GB, so it was tried first. It is
 * trained on web prose and cannot separate relevant code from irrelevant code: on a probe of four
 * passages it scored an unrelated `renderMarkdown` (-11.421) marginally ABOVE the relevant
 * `withLock` (-11.467), while ranking a prose sentence about mutexes far above all code.
 * `bge-reranker-base` ordered the same probe correctly (-4.28 prose, -6.54 relevant code, -7.55 and
 * -8.76 irrelevant code). A reranker that cannot tell code apart would reorder noise into confidence,
 * so the larger model is the one that ships.
 *
 * RAW LOGITS, NOT A CLASSIFICATION. These models have ONE output label, so the obvious
 * `pipeline('text-classification', …)` route softmaxes a single class and returns `score: 1` for
 * every pair — a reranker that silently reorders nothing. The adapter therefore drives
 * `AutoModelForSequenceClassification` directly and reads `logits`, which is where the ranking
 * signal actually is. Higher is better; the values are unbounded and comparable only WITHIN one
 * query's candidate set, which is all `rerankBatch` promises.
 *
 * RUNTIME REUSE. The ONNX runtime installed by `crib embed setup` under the embed home is reused
 * rather than duplicated — it is ~400 MB of `@huggingface/transformers` and its native backends, and
 * two copies would be pure waste. That makes the embed tier a PREREQUISITE, stated in the error
 * rather than discovered: `installReranker` refuses when the runtime is absent.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type EmbedModelFileEntry, embedHomeDir, hashDirFiles } from '../embeddings/embed-install.js';

/** Bumped when the manifest shape changes; an older manifest is refused, never guessed at. */
export const RERANK_MANIFEST_FORMAT_VERSION = 1;

/**
 * How deep the first stage is reranked, mirrored from `packages/memory/src/fusion.ts`.
 *
 * Duplicated deliberately: `core` must not depend on `memory`, and a cross-package import for one
 * integer would invert the layering. `reranker.test.ts` pins the two equal so they cannot drift.
 */
export const DEFAULT_RERANK_DEPTH = 50;

/** A scored (query, text) pair ranker. Structurally identical to `memory`'s `Reranker` port. */
export interface Reranker {
  /** Stable id — flows into the scorer version id, so a ranking is traceable to its reranker. */
  readonly id: string;
  /** Score each `texts[i]` against `query`. Higher = more relevant. Same length as `texts`. */
  rerankBatch(query: string, texts: readonly string[]): number[];
}

export interface RerankManifest {
  formatVersion: number;
  /** The id the scorer records. Changes whenever ranking behaviour changes. */
  rerankerId: string;
  /** Upstream model id, e.g. `Xenova/bge-reranker-base`. */
  modelId: string;
  /** Directory holding the generated adapter, pinned file-by-file. */
  modelDir: string;
  entry: string;
  /** The reused embed runtime, pinned so a swapped runtime is detected. */
  runtimeDir: string;
  /** Weight cache directory + the hashes of every file under the model's subtree. */
  weights: { dir: string; files: EmbedModelFileEntry[] };
  /** Hashes of the generated adapter's own files. */
  files: EmbedModelFileEntry[];
}

export class RerankManifestError extends Error {}
export class RerankNotInstalledError extends Error {}
export class RerankIntegrityError extends Error {}

/** `~/.crib/rerank`, or `KCRIB_RERANK_HOME`. Kept beside the embed home, not inside it: the embed
 *  manifest hashes its own subtree, so a reranker written under it would break that install. */
export function rerankHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KCRIB_RERANK_HOME?.trim();
  if (override) return override;
  return join(env.HOME?.trim() || homedir(), '.crib', 'rerank');
}

export function rerankManifestPath(home: string = rerankHomeDir()): string {
  return join(home, 'manifest.json');
}

function sha256File(path: string): { sha256: string; bytes: number } {
  const buf = readFileSync(path);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.byteLength };
}

/**
 * The generated adapter. A WORKER holds the model because loading it costs seconds and the scorer is
 * synchronous by contract — `rerankBatch` returns numbers, not a promise, exactly as the port
 * declares — so the call crosses into the worker and blocks on `receiveMessageOnPort`, the same
 * shape `crib embed setup`'s embedder adapter uses for the same reason.
 */
export function renderRerankerMjs(opts: {
  rerankerId: string;
  modelId: string;
  runtimeDir: string;
  cacheDir: string;
}): string {
  return `/**
 * Generated by \`crib rerank setup\` for ${opts.modelId}. Regenerate with the same command; do not
 * hand-edit — the install hashes every file here and a drifted file fails verification.
 *
 * THE CONTRACT THAT IS EASY TO GET WRONG: this reads raw LOGITS, not a classification. These models
 * have a single output label, so \`pipeline('text-classification', …)\` softmaxes one class and hands
 * back 1.0 for every pair — a reranker that reorders nothing. Scores are unbounded and comparable
 * only within one query's candidate set.
 */
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

const RUNTIME = ${JSON.stringify(opts.runtimeDir)};
const CACHE_MODELS = ${JSON.stringify(opts.cacheDir)};
const ID = ${JSON.stringify(opts.rerankerId)};
const MODEL = ${JSON.stringify(opts.modelId)};

let worker;
function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('./rerank-worker.mjs', import.meta.url), {
    workerData: { runtime: RUNTIME, cacheDir: CACHE_MODELS, model: MODEL },
  });
  // Idle by default so a finished process is never held open by the model.
  worker.unref();
}

function callWorker(query, texts) {
  ensureWorker();
  const { port1, port2 } = new MessageChannel();
  const shared = new SharedArrayBuffer(4);
  const signal = new Int32Array(shared);
  worker.postMessage({ query, texts, port: port2, signal: shared }, [port2]);
  // Block this thread until the worker publishes. The port is drained only after the signal flips,
  // so a spurious wake cannot read a half-written message.
  while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0, 50);
  const message = receiveMessageOnPort(port1);
  port1.close();
  if (!message) throw new Error('reranker worker produced no result');
  if (message.message.error) throw new Error(message.message.error);
  return message.message.scores;
}

export default {
  id: ID,
  rerankBatch(query, texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const scores = callWorker(String(query), texts.map((t) => String(t)));
    if (!Array.isArray(scores) || scores.length !== texts.length) {
      // A length mismatch would silently misalign every score with the wrong candidate, which is
      // worse than no reranking: the order would look considered and be arbitrary.
      throw new Error(
        \`reranker returned \${Array.isArray(scores) ? scores.length : 'non-array'} scores for \${texts.length} texts\`,
      );
    }
    return scores;
  },
};
`;
}

/** The worker that owns the model. Separate file so the adapter stays readable and hashable. */
export function renderRerankWorkerMjs(): string {
  return `/**
 * Generated by \`crib rerank setup\`. Owns the cross-encoder and answers one batch per message.
 */
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(workerData.runtime + '/package.json');
let tok;
let model;

async function ensureModel() {
  if (model) return;
  // Resolved from the REUSED embed runtime, so there is one copy of transformers on the machine.
  // Resolution lands on the package's CJS build (\`transformers.node.cjs\`), whose ESM namespace is
  // \`{ __esModule, default }\` — so the API is under \`.default\`, not at the top level. The embed
  // worker can write a bare \`import '@huggingface/transformers'\` because that file lives INSIDE the
  // runtime's node_modules tree; this adapter lives in the rerank home and cannot. Both shapes are
  // accepted rather than assuming one: guessing produced \`Cannot set properties of undefined
  // (setting 'cacheDir')\`, which names the symptom and hides the cause.
  const mod = await import(
    require.resolve('@huggingface/transformers', { paths: [workerData.runtime] })
  );
  const api = mod?.env ? mod : mod?.default;
  if (!api?.env || !api?.AutoTokenizer || !api?.AutoModelForSequenceClassification) {
    throw new Error(
      'the reused ONNX runtime did not expose env/AutoTokenizer/AutoModelForSequenceClassification — re-run \`crib embed setup\`',
    );
  }
  const { env, AutoTokenizer, AutoModelForSequenceClassification } = api;
  env.cacheDir = workerData.cacheDir;
  // Offline once provisioned: the weights are pinned by the manifest, so a query must never reach
  // the network and silently pick up different ones.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  tok = await AutoTokenizer.from_pretrained(workerData.model);
  model = await AutoModelForSequenceClassification.from_pretrained(workerData.model, {
    dtype: 'fp32',
  });
}

parentPort.on('message', async ({ query, texts, port, signal }) => {
  const flag = new Int32Array(signal);
  try {
    await ensureModel();
    // One tokenizer call for the whole candidate set: the query is paired with each text, so the
    // model sees the pair rather than two independently encoded halves.
    const inputs = tok(new Array(texts.length).fill(query), {
      text_pair: texts,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    port.postMessage({ scores: Array.from(logits.data, (n) => Number(n)) });
  } catch (error) {
    port.postMessage({ error: error?.message ?? String(error) });
  } finally {
    // Publish AFTER the message is posted, so the waiting thread never reads a partial result.
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
});
`;
}

export interface InstallRerankerOptions {
  /** Upstream model id, e.g. `Xenova/bge-reranker-base`. */
  modelId: string;
  /** The id the scorer records; defaults to a slug of `modelId`. */
  rerankerId?: string;
  home?: string;
  /** The embed home whose runtime + weight cache are reused. */
  embedHome?: string;
}

/**
 * Write the adapter and pin everything it depends on.
 *
 * Refuses rather than improvises on two preconditions, because both produce a reranker that loads
 * and then fails at query time: no reused runtime (the embed tier was never installed) and no
 * downloaded weights (the model was never fetched). Naming them here is the difference between a
 * setup error and a mystery during a measurement run.
 */
export function installReranker(opts: InstallRerankerOptions): RerankManifest {
  const home = opts.home ?? rerankHomeDir();
  const embedHome = opts.embedHome ?? embedHomeDir();
  const runtimeDir = join(embedHome, 'runtime');
  const cacheDir = join(embedHome, 'models');
  if (!existsSync(join(runtimeDir, 'package.json'))) {
    throw new RerankNotInstalledError(
      `the reranker reuses the ONNX runtime from the embed tier, and none is installed at ${runtimeDir}. Run \`crib embed setup\` first — two copies of @huggingface/transformers would be ~400 MB of duplication.`,
    );
  }
  const weightsDir = join(cacheDir, opts.modelId);
  if (!existsSync(weightsDir)) {
    throw new RerankNotInstalledError(
      `no downloaded weights for ${opts.modelId} under ${cacheDir}. \`crib rerank setup\` fetches them; this function pins what is already on disk.`,
    );
  }
  const rerankerId = opts.rerankerId ?? opts.modelId.replace(/[^A-Za-z0-9._-]+/g, '-');
  const modelDir = join(home, 'adapters', opts.modelId.replace(/[^A-Za-z0-9._-]+/g, '_'));
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    join(modelDir, 'reranker.mjs'),
    renderRerankerMjs({ rerankerId, modelId: opts.modelId, runtimeDir, cacheDir }),
  );
  writeFileSync(join(modelDir, 'rerank-worker.mjs'), renderRerankWorkerMjs());
  const manifest: RerankManifest = {
    formatVersion: RERANK_MANIFEST_FORMAT_VERSION,
    rerankerId,
    modelId: opts.modelId,
    modelDir,
    entry: 'reranker.mjs',
    runtimeDir,
    weights: { dir: cacheDir, files: hashDirFiles(weightsDir).map((f) => ({ ...f, path: `${opts.modelId}/${f.path}` })) },
    files: hashDirFiles(modelDir),
  };
  mkdirSync(dirname(rerankManifestPath(home)), { recursive: true });
  writeFileSync(rerankManifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Read the manifest, or throw a typed error naming what is wrong. */
export function readRerankManifest(home: string = rerankHomeDir()): RerankManifest {
  const path = rerankManifestPath(home);
  if (!existsSync(path)) {
    throw new RerankNotInstalledError(`no reranker manifest at ${path} — run \`crib rerank setup\``);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new RerankManifestError(`reranker manifest is not valid JSON: ${(e as Error).message}`);
  }
  const m = parsed as RerankManifest;
  if (m?.formatVersion !== RERANK_MANIFEST_FORMAT_VERSION) {
    throw new RerankManifestError(
      `reranker manifest formatVersion ${m?.formatVersion} is not ${RERANK_MANIFEST_FORMAT_VERSION} — re-run \`crib rerank setup\``,
    );
  }
  if (!m.rerankerId || !m.modelDir || !m.entry) {
    throw new RerankManifestError('reranker manifest is missing rerankerId/modelDir/entry');
  }
  return m;
}

/**
 * Re-verify every pinned file before the adapter is imported.
 *
 * The point is ordering: a tampered adapter must be refused BEFORE it is executed, so verification
 * cannot be a post-hoc check. Weight files are verified too — swapped weights change the ranking
 * without changing a line of code, which is the quieter of the two failures.
 */
export function verifyInstalledReranker(home: string = rerankHomeDir()): RerankManifest {
  const manifest = readRerankManifest(home);
  for (const entry of manifest.files) {
    const full = join(manifest.modelDir, entry.path);
    if (!existsSync(full)) {
      throw new RerankIntegrityError(`pinned adapter file is missing: ${full}`);
    }
    const { sha256, bytes } = sha256File(full);
    if (sha256 !== entry.sha256 || bytes !== entry.bytes) {
      throw new RerankIntegrityError(
        `pinned adapter file changed since install: ${full} — re-run \`crib rerank setup\``,
      );
    }
  }
  for (const entry of manifest.weights.files) {
    const full = join(manifest.weights.dir, entry.path);
    if (!existsSync(full)) {
      throw new RerankIntegrityError(`pinned weight file is missing: ${full}`);
    }
    const { sha256, bytes } = sha256File(full);
    if (sha256 !== entry.sha256 || bytes !== entry.bytes) {
      throw new RerankIntegrityError(
        `pinned weight file changed since install: ${full} — re-run \`crib rerank setup\``,
      );
    }
  }
  return manifest;
}

/** Verify, then import the adapter and check its surface before any caller can touch it. */
export async function loadInstalledReranker(home: string = rerankHomeDir()): Promise<Reranker> {
  const manifest = verifyInstalledReranker(home);
  const entry = join(manifest.modelDir, manifest.entry);
  const mod = (await import(pathToFileURL(entry).href)) as { default?: Reranker };
  const instance = mod.default;
  if (
    !instance ||
    typeof instance.id !== 'string' ||
    typeof instance.rerankBatch !== 'function'
  ) {
    throw new RerankManifestError(`module "${entry}" has no default Reranker export`);
  }
  return instance;
}
