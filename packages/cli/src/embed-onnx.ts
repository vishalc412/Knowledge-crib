/**
 * The on-device semantic tier, provisioned WITHOUT Python.
 *
 * WHY THIS REPLACES THE PYTHON BRIDGE
 * The previous adapter shelled out to `sentence-transformers`, so reaching crib's advertised
 * semantic tier meant `pip install sentence-transformers` (and, transitively, PyTorch) from a Node
 * CLI. In practice that is where installs died: a developer who installed crib from npm hit a
 * Python toolchain requirement they never signed up for, `crib doctor` reported the degraded
 * char-ngram fallback, and the semantic tier stayed git-checkout-only.
 *
 * This module provisions an ONNX runtime instead — plain npm packages, installed into the embed
 * home on demand rather than shipped in crib's tarball. Nothing about the vector space changes:
 * `multilingual-e5-large` measured G2 81.05% / G3 0.8814 through this path against the frozen
 * launch corpus, reproducing the 81.0% / 88.1% the repository already had on record for the Python
 * configuration. Same model, same weights, same numbers — one less toolchain.
 *
 * WHAT STAYS THE SAME (deliberately)
 *   • Weights land under the embed home and are pinned through the SAME integrity manifest a
 *     hand-installed model uses, so a drifted file still fails verification.
 *   • Nothing here runs at query time over the network. Provisioning fetches; serving does not.
 *   • The remote-embedder tier is untouched. "Make setup easy" must not become "quietly start
 *     sending memory text to a third party".
 *
 * THE SYNCHRONOUS-EMBEDDER PROBLEM
 * Crib's `Embedder` port is synchronous; ONNX inference is async. The Python adapter solved that by
 * spawning a process per batch — which cost a full model load (seconds) every call, and is why it
 * needed an aggressive on-disk vector cache to be usable at all. Here the model is loaded ONCE in a
 * worker thread and the main thread blocks on `Atomics.wait`, draining the reply with
 * `receiveMessageOnPort` (which does not require returning to the event loop). One load per
 * process, ~9ms per embed after it.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type EmbedProvisioningPin, hashDirFiles } from '@knowledge-crib/core';
import { type NpmRunResult, type PkgPhase, runNpm } from './pkg-manager.js';

/**
 * The npm packages the ONNX tier needs, pinned. `@huggingface/transformers` brings the ONNX runtime
 * and the tokenizers, so this is the whole surface — installed into the embed home, never added to
 * crib's own `dependencies` (the workspace runs a hard external-dependency cap, and a ~300MB native
 * runtime has no business in the tarball of a tool most users run lexically).
 */
export const ONNX_RUNTIME_PACKAGE = '@huggingface/transformers@3.7.6';

/**
 * Approximate on-disk size of the runtime install, stated UP FRONT in the consent message (WP1.7:
 * consent must carry size, destination and identity before anything is fetched). A consent that
 * does not say how big the download is does not let the operator make the decision they are being
 * asked to make — especially on metered or disk-constrained hosts.
 */
export const ONNX_RUNTIME_APPROX_DISK = '~376 MB';

/** Layout under the embed home. Weights, runtime and adapters stay in separate subtrees so the
 *  integrity hash over an adapter never sweeps in a multi-gigabyte model file. */
export function onnxRuntimeDir(home: string): string {
  return join(home, 'runtime');
}
export function onnxModelCacheDir(home: string): string {
  return join(home, 'models');
}

/** Is the ONNX runtime already installed in this embed home? */
export function onnxRuntimeInstalled(home: string): boolean {
  return existsSync(join(onnxRuntimeDir(home), 'node_modules', '@huggingface', 'transformers'));
}

/**
 * (Re)write the generated worker. Called on EVERY setup, including when the npm install is skipped
 * because the runtime is already present.
 *
 * `onnxRuntimeInstalled` only proves `node_modules` exists, which says nothing about the version of
 * the worker sitting next to it. Writing the worker only inside the install branch meant an upgraded
 * crib kept running the PREVIOUS release's worker forever — and the failure mode is the worst kind:
 * the adapter and the worker disagree about their handshake, so the tier hangs rather than erroring.
 * The file is generated and tiny; there is no reason to preserve an old one.
 */
export function refreshOnnxWorker(home: string): void {
  const dir = onnxRuntimeDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'worker.mjs'), renderOnnxWorkerMjs());
}

/**
 * The worker that owns the model. Lives INSIDE the runtime dir so a bare
 * `import '@huggingface/transformers'` resolves against the runtime's own `node_modules` — the
 * adapter itself never imports it, which is what lets the adapter live in a different subtree.
 *
 * `allowRemoteModels: false` is the offline contract: once weights are in the cache, a serving
 * process cannot reach the network even if the cache is incomplete. It fails loudly instead.
 */
export function renderOnnxWorkerMjs(): string {
  return `/**
 * Generated by \`crib embed setup\`. Do not hand-edit.
 *
 * Loads the pinned ONNX model ONCE and answers batches over a MessagePort.
 *
 * READINESS TRAVELS OVER THE ATOMICS CHANNEL, NOT THE EVENT LOOP. The caller blocks on
 * \`Atomics.wait\`, which parks the main thread — so a \`worker.on('message')\` callback there could
 * never run, and signalling readiness that way deadlocks until the timeout. A model that fails to
 * load reports through the same channel for the same reason: an exception here would be invisible
 * to a blocked parent, and the tier would look like a hang instead of a failure.
 */
import { parentPort, workerData } from 'node:worker_threads';

const flag = new Int32Array(workerData.signal);
const port = workerData.port;
const done = () => {
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
};

let extract;
let loadError;
try {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = workerData.cacheDir;
  // OFFLINE AT SERVE TIME. Provisioning already fetched the weights; a serving process that reached
  // out for a missing file would turn a corrupt cache into a silent network dependency.
  env.allowRemoteModels = workerData.allowRemote === true;
  env.allowLocalModels = true;
  extract = await pipeline('feature-extraction', workerData.model, { dtype: 'fp32' });
} catch (err) {
  loadError = String((err && err.message) || err);
}

port.on('message', async ({ texts }) => {
  try {
    if (loadError) throw new Error(loadError);
    // The prefix is applied HERE, in the one place both embed() and embedBatch() reach, so the two
    // can never diverge (contract 1 in the adapter).
    const out = await extract(
      texts.map((t) => workerData.prefix + t),
      { pooling: 'mean', normalize: true },
    );
    port.postMessage({ ok: true, dim: out.dims.at(-1), flat: Array.from(out.data) });
  } catch (err) {
    port.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
  done();
});

port.postMessage(
  loadError ? { ok: false, error: 'model load failed: ' + loadError } : { ok: true, ready: true },
);
done();
if (parentPort) parentPort.postMessage('ready');
`;
}

/** Spec fields the generated adapter needs. Structural so this module does not depend on the
 *  setup module's richer `EmbedModelSpec` (which carries help-text and provenance fields). */
export interface OnnxAdapterSpec {
  /** The ONNX-hosted model id passed to the pipeline (e.g. `Xenova/multilingual-e5-large`). */
  onnxId: string;
  dim: number;
  prefix: string;
}

/**
 * The synchronous `Embedder` crib actually consumes.
 *
 * Two contracts this file exists to hold, both learned the hard way (see the Python adapter's
 * header): `embedBatch(texts)[i]` MUST equal `embed(texts[i])` — batching is a performance variant,
 * never a semantic one — and `id` must change whenever embedding behaviour changes, because it keys
 * the persistent vector cache.
 */
export function renderOnnxEmbedderMjs(
  spec: OnnxAdapterSpec,
  id: string,
  runtimeDir: string,
  cacheDir: string,
): string {
  return `/**
 * Generated by \`crib embed setup\` for ${spec.onnxId}. Regenerate with the same command; do not
 * hand-edit — \`crib embed install\` hashes every file here and a drifted file fails verification.
 *
 * THE TWO CONTRACTS THAT ARE EASY TO GET WRONG
 * 1. \`embedBatch(texts)[i]\` MUST equal \`embed(texts[i])\`. Both go through ONE path below, and the
 *    model prefix is applied in the worker so neither method can apply a different one.
 * 2. \`id\` must change whenever embedding behaviour changes — it keys crib's persistent vector
 *    cache, so a silent behaviour change under a stable id would serve vectors from the old space.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

const RUNTIME = ${JSON.stringify(runtimeDir)};
const CACHE_MODELS = ${JSON.stringify(cacheDir)};
const ID = ${JSON.stringify(id)};
const DIM = ${spec.dim};
const PREFIX = ${JSON.stringify(spec.prefix)};
const MODEL = ${JSON.stringify(spec.onnxId)};
/** Outside the adapter dir: every file under it is hashed for integrity, so a cache written here
 *  would invalidate the install on first use. */
const CACHE =
  process.env.KCRIB_EMBED_CACHE ??
  join(process.env.HOME ?? '/tmp', '.cache', 'crib-embed-vec', ID);

const memo = new Map();
const keyOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const pathOf = (k) => join(CACHE, k.slice(0, 2), k + '.bin');

function readCached(text) {
  const hit = memo.get(text);
  if (hit) return hit;
  const p = pathOf(keyOf(text));
  if (!existsSync(p)) return undefined;
  const buf = readFileSync(p);
  const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const copy = new Float32Array(view); // detach from the file buffer
  memo.set(text, copy);
  return copy;
}

function writeCached(text, vec) {
  const p = pathOf(keyOf(text));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  memo.set(text, vec);
}

let worker;
let port;
let flag;

/** Block until the worker flips the shared flag, or the deadline passes. */
function awaitSignal(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(flag, 0) === 0) {
    if (Date.now() >= deadline) return false;
    // A timeout on each wait so a lost notify cannot park the process forever.
    Atomics.wait(flag, 0, 0, 250);
  }
  return true;
}

/** Start the model worker on first use — a process that never embeds never pays the load. */
function ensureWorker() {
  if (worker) return;
  const signal = new SharedArrayBuffer(4);
  flag = new Int32Array(signal);
  Atomics.store(flag, 0, 0);
  const channel = new MessageChannel();
  port = channel.port1;
  worker = new Worker(join(RUNTIME, 'worker.mjs'), {
    workerData: {
      model: MODEL,
      prefix: PREFIX,
      cacheDir: CACHE_MODELS,
      allowRemote: false,
      signal,
      port: channel.port2,
    },
    transferList: [channel.port2],
  });
  // Idle by default so the embedder never keeps a finished process alive — but see callWorker:
  // the handle is re-\`ref\`d for the duration of each call. Leaving it permanently unref'd let
  // Node judge the loop empty while the main thread sat in \`Atomics.wait\`, and the process exited
  // MID-EMBED, returning nothing and throwing nothing. It only survived inside \`crib serve\`
  // because stdio happened to hold the loop open — a bare script got silence.
  worker.unref();
  // READINESS COMES OVER THE ATOMICS CHANNEL. \`Atomics.wait\` parks this thread, so a
  // \`worker.on('message')\` handler here would never run — waiting on one deadlocks until timeout.
  // The startup wait blocks the same way a call does, so the handle must be held here too.
  worker.ref();
  let started;
  try {
    started = awaitSignal(300000);
  } finally {
    worker.unref();
  }
  if (!started) throw new Error('embedder worker did not start in 300s');
  const hello = receiveMessageOnPort(port);
  if (!hello) throw new Error('embedder worker started without reporting readiness');
  if (!hello.message.ok) throw new Error(hello.message.error);
}

function callWorker(texts) {
  ensureWorker();
  // Hold the process open for exactly as long as this call takes.
  worker.ref();
  try {
    return callWorkerLocked(texts);
  } finally {
    worker.unref();
  }
}

function callWorkerLocked(texts) {
  Atomics.store(flag, 0, 0);
  port.postMessage({ texts });
  // Block the main thread until the worker signals. \`receiveMessageOnPort\` drains the reply
  // without returning to the event loop, which is what makes a synchronous API possible.
  if (!awaitSignal(300000)) throw new Error('embedder worker timed out');
  const msg = receiveMessageOnPort(port);
  if (!msg) throw new Error('embedder worker returned no message');
  const r = msg.message;
  if (!r.ok) throw new Error(r.error);
  if (r.dim !== DIM) {
    throw new Error('embedder dim ' + r.dim + ' != pinned ' + DIM + ' — manifest and model disagree');
  }
  const out = [];
  for (let i = 0; i < texts.length; i += 1) {
    out.push(Float32Array.from(r.flat.slice(i * r.dim, (i + 1) * r.dim)));
  }
  return out;
}

class OnnxEmbedder {
  get id() {
    return ID;
  }

  dim() {
    return DIM;
  }

  /** The ONE code path. \`embed\` delegates here so the two can never diverge. */
  embedBatch(texts) {
    const out = new Array(texts.length);
    const missIdx = [];
    const missText = [];
    for (let i = 0; i < texts.length; i += 1) {
      const hit = readCached(texts[i]);
      if (hit) out[i] = hit;
      else {
        missIdx.push(i);
        missText.push(texts[i]);
      }
    }
    if (missText.length > 0) {
      // De-duplicate before inference: a batch repeating one string should embed it once.
      const uniq = [...new Set(missText)];
      const vecs = callWorker(uniq);
      const byText = new Map();
      uniq.forEach((t, i) => {
        writeCached(t, vecs[i]);
        byText.set(t, vecs[i]);
      });
      missIdx.forEach((idx, k) => {
        out[idx] = byText.get(missText[k]);
      });
    }
    return out;
  }

  embed(text) {
    return this.embedBatch([text])[0];
  }
}

export default new OnnxEmbedder();
`;
}

/** Result of one provisioning step, mirroring the setup module's step reporting. */
export interface OnnxStep {
  ok: boolean;
  detail: string;
  /** WP1.3 taxonomy: which phase failed (present on failures, absent on success). */
  phase?: PkgPhase;
  /** the ONE action that repairs a failed step; absent on success. */
  repair?: string;
}

/**
 * Install the ONNX runtime into the embed home. Isolated `npm install` in its own directory: it
 * never touches the user's project, their global node_modules, or crib's own installation.
 *
 * The install goes through the shared package-manager launcher (pkg-manager.ts): never a bare
 * `npm` command, never a shell. That is what makes it work on Windows, where `npm` on PATH is a
 * `.cmd` shim Node refuses to spawn without a shell — and where a shell is exactly the injection
 * surface crib must not acquire.
 */
export function installOnnxRuntime(
  home: string,
  run: (dir: string) => NpmRunResult = runNpmInstall,
): OnnxStep {
  const dir = onnxRuntimeDir(home);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'crib-embed-runtime', private: true, type: 'module' }, null, 2)}\n`,
    );
    const result = run(dir);
    writeFileSync(join(dir, 'worker.mjs'), renderOnnxWorkerMjs());
    if (!result.ok) {
      return {
        ok: false,
        detail: `runtime install failed [${result.phase}]: ${result.message}`,
        phase: result.phase,
        ...(result.repair ? { repair: result.repair } : {}),
      };
    }
    if (!onnxRuntimeInstalled(home)) {
      return {
        ok: false,
        detail: `npm install exited 0 but ${ONNX_RUNTIME_PACKAGE} is not present`,
        phase: 'post-install',
        repair: `Delete ${dir} and re-run \`crib embed setup --model <alias> --yes\` to reinstall the runtime`,
      };
    }
    return { ok: true, detail: `installed ${ONNX_RUNTIME_PACKAGE} into ${dir}` };
  } catch (err) {
    return {
      ok: false,
      detail: `runtime install failed: ${(err as Error).message.split('\n')[0]}`,
      phase: 'install',
    };
  }
}

/** The default launcher invocation for `installOnnxRuntime` — overridable in tests. */
function runNpmInstall(dir: string): NpmRunResult {
  return runNpm(dir, [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel',
    'error',
    ONNX_RUNTIME_PACKAGE,
  ]);
}

/**
 * Fetch the model weights into the embed home's cache, so every later load is offline.
 *
 * WP1.9 — STAGED, THEN PUBLISHED. The download lands in a throwaway staging directory under the
 * embed home (same filesystem, so the final publish is a rename) and is moved into the model cache
 * only after BOTH checks pass:
 *   1. inference — the dimension probe actually runs the model and its dim matches the ladder pin;
 *   2. completeness — every staged file is non-empty, at least one `.onnx` graph is present, and
 *      `config.json` + `tokenizer.json` exist.
 * Until then the previous model dir is never touched: an interrupted or truncated download cannot
 * half-replace a working tier, and a bad fetch fails with the old model still serving.
 *
 * Runs in a throwaway child process rather than in-process: the weights are large, the runtime
 * allocates aggressively while converting them, and a provisioning step must not leave that memory
 * attached to the CLI process that happens to have triggered it.
 */
export function downloadOnnxWeights(
  home: string,
  spec: OnnxAdapterSpec,
  run: (cmd: string, args: string[], cwd: string) => string = (cmd, args, cwd) =>
    execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }),
): OnnxStep {
  const dir = onnxRuntimeDir(home);
  const cache = onnxModelCacheDir(home);
  mkdirSync(home, { recursive: true });
  const staging = mkdtempSync(join(home, '.download-staging-'));
  const script = `
import { env, pipeline } from '@huggingface/transformers';
env.cacheDir = ${JSON.stringify(staging)};
env.allowRemoteModels = true;
const extract = await pipeline('feature-extraction', ${JSON.stringify(spec.onnxId)}, { dtype: 'fp32' });
const out = await extract([${JSON.stringify(spec.prefix)} + 'dimension probe'], { pooling: 'mean', normalize: true });
console.log(JSON.stringify({ dim: out.dims.at(-1) }));
`;
  try {
    // Absolute node binary (never a PATH lookup): the same process that runs crib runs the probe.
    const out = run(process.execPath, ['--input-type=module', '-e', script], dir);
    const line = out.trim().split('\n').at(-1) ?? '{}';
    const dim = (JSON.parse(line) as { dim?: number }).dim;
    if (dim !== spec.dim) {
      // A dimension mismatch means the ladder's pinned dim disagrees with the real model. Failing
      // here is the point: the dim is re-checked on every load, so letting it through would turn a
      // config error into silently mis-scored retrieval.
      return { ok: false, detail: `model reports dim ${dim}, ladder pins ${spec.dim}` };
    }
    const staged = join(staging, ...spec.onnxId.split('/'));
    const problem = stagedModelProblem(staged);
    if (problem) {
      return {
        ok: false,
        detail: `incomplete download: ${problem} — nothing was published, the previous model was preserved`,
      };
    }
    publishStagedModel(staging, cache, spec.onnxId);
    return { ok: true, detail: `weights cached under ${cache} (dim ${dim} verified)` };
  } catch (err) {
    return { ok: false, detail: `weight download failed: ${(err as Error).message}` };
  } finally {
    // Staging is scratch by contract: after a publish the model dir has been renamed OUT of it,
    // and after any failure it holds only the incomplete fetch. Either way it goes.
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Recursively list every file under `dir`, as paths relative to it. */
function listFilesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesUnder(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * The completeness half of the WP1.9 gate: a model dir the runtime "successfully" fetched can still
 * be useless — a truncated `.onnx` at 0 bytes, a missing tokenizer. Returns the first problem found
 * (undefined = the dir is complete enough to serve).
 *
 * Exported because WP1.10 runs the SAME gate over an offline bundle: "adopted without verification"
 * is how an air-gapped host ends up with a cache that pins fine and loads never.
 */
export function stagedModelProblem(modelDir: string): string | undefined {
  if (!existsSync(modelDir)) return `no model directory was downloaded under ${modelDir}`;
  const files = listFilesUnder(modelDir);
  if (files.length === 0) return 'the model directory is empty';
  for (const f of files) {
    if (statSync(join(modelDir, f)).size === 0) return `${f} is zero bytes`;
  }
  if (!files.some((f) => f.endsWith('.onnx'))) return 'no .onnx graph was downloaded';
  if (!files.includes('config.json')) return 'config.json is missing';
  if (!files.includes('tokenizer.json')) return 'tokenizer.json is missing';
  return undefined;
}

/**
 * Move the staged model dir into the cache as a single rename, keeping the previous model intact
 * until the new one is in place: the old dir is moved aside first, the staged dir is renamed in,
 * and only then is the aside deleted. If the rename-in fails the aside is renamed back — the cache
 * never holds a half-published model.
 */
export function publishStagedModel(staging: string, cache: string, onnxId: string): void {
  // The ladder validates onnxId as `org/name`, but this function walks filesystem paths built
  // from it — a malformed id must be refused here rather than turned into a rename target.
  const [org, name] = onnxId.split('/');
  if (!org || !name || onnxId.split('/').length !== 2) {
    throw new Error(`invalid onnx id: ${onnxId}`);
  }
  const staged = join(staging, org, name);
  const target = join(cache, org, name);
  mkdirSync(join(cache, org), { recursive: true });
  let aside: string | undefined;
  if (existsSync(target)) {
    // The pid suffix makes the aside collision-proof against a leftover from a previous crashed
    // run: two processes cannot share a pid.
    aside = join(cache, org, `.${name}.old-${process.pid}`);
    rmSync(aside, { recursive: true, force: true });
    renameSync(target, aside);
  }
  try {
    renameSync(staged, target);
  } catch (err) {
    if (aside) renameSync(aside, target);
    throw err;
  }
  if (aside) rmSync(aside, { recursive: true, force: true });
}

/** Write the generated adapter pair for one model into `dir`. Returns the adapter entrypoint. */
export function writeOnnxAdapter(
  home: string,
  spec: OnnxAdapterSpec,
  id: string,
  dir: string,
): string {
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'embedder.mjs');
  writeFileSync(
    entry,
    renderOnnxEmbedderMjs(spec, id, onnxRuntimeDir(home), onnxModelCacheDir(home)),
  );
  return entry;
}

/**
 * The dependency names whose INSTALLED versions the provisioning pin records (WP1.8). These two
 * decide every vector the tier emits: `@huggingface/transformers` supplies the tokenizer +
 * inference graph, and `onnxruntime-node` (its native dependency) executes the graph. A silent
 * upgrade of either can shift the vector space under a stable embedder id, which would serve
 * stale-cache vectors from a NEW embedding space.
 */
const RUNTIME_PINNED_DEPS = ['@huggingface/transformers', 'onnxruntime-node'] as const;

/** Read the installed version of one package under the runtime dir (undefined = not installed). */
function installedDepVersion(runtimeDir: string, name: string): string | undefined {
  const segs = name.split('/');
  if (segs.some((s) => !/^(@[\w.-]+|[\w.-]+)$/.test(s) || s === '.' || s === '..'))
    return undefined;
  const pj = join(runtimeDir, 'node_modules', ...segs, 'package.json');
  if (!existsSync(pj)) return undefined;
  try {
    return (JSON.parse(readFileSync(pj, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Build the WP1.8 provisioning pin from what is on disk: every weight-cache file by sha256
 * (tokenizer included — it is part of the cache), plus the installed versions of the runtime
 * packages the pinned behaviour depends on.
 *
 * Throws when the weight cache is missing or empty: setup only calls this AFTER a successful
 * weights step, so a missing cache here is a wiring bug, not an operator state — and pinning an
 * empty cache would write a manifest whose weight verification passes vacuously, which is the
 * "silent downgrade" this whole module exists to prevent.
 */
export function onnxProvisioningPin(home: string, spec: OnnxAdapterSpec): EmbedProvisioningPin {
  const cache = onnxModelCacheDir(home);
  if (!existsSync(cache)) throw new Error(`weight cache is missing: ${cache}`);
  const files = hashDirFiles(cache);
  if (files.length === 0) throw new Error(`weight cache ${cache} is empty — nothing to pin`);
  const runtimeDir = onnxRuntimeDir(home);
  const deps: Record<string, string> = {};
  for (const name of RUNTIME_PINNED_DEPS) {
    const v = installedDepVersion(runtimeDir, name);
    if (v) deps[name] = v;
  }
  return {
    onnxId: spec.onnxId,
    weights: { dir: cache, files },
    // The platform key is what makes a copied embed home fail at the FIRST verification instead
    // of later inside a dlopen: onnxruntime-node's native binaries are per-OS-per-arch, so a home
    // rsynced from an arm64 Mac to an x64 Linux box "verifies" against every hash and then dies
    // at import with an error that names neither the cause nor the fix.
    ...(Object.keys(deps).length > 0
      ? {
          runtime: {
            dir: runtimeDir,
            deps,
            platform: `${process.platform}-${process.arch}`,
          },
        }
      : {}),
  };
}
