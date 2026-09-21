/**
 * `crib rerank setup` / `crib rerank status` — provisioning the second-stage cross-encoder.
 *
 * Deliberately a SEPARATE tier from `crib embed setup`, not an extension of it. The two answer
 * different questions and cost different things: the embedder is a first stage that must run over
 * every node at index time, the reranker is a second stage that runs over a bounded candidate window
 * at query time. Someone who wants cheap lexical retrieval plus a good final ordering should be able
 * to have exactly that, and someone who wants neither should pay for neither.
 *
 * It does REUSE the embed tier's ONNX runtime (~400 MB of `@huggingface/transformers` and its native
 * backends), which makes `crib embed setup` a prerequisite. That is stated in the refusal rather than
 * discovered at query time.
 *
 * The download is the one step that needs the network, and it is isolated here for that reason: the
 * generated query adapter runs with `allowRemoteModels: false`, so once provisioned a ranking can
 * never quietly fetch different weights. Warming the cache therefore happens in this command, under
 * an explicit `--yes`, and never as a side effect of a query.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  embedHomeDir,
  installReranker,
  readRerankManifest,
  rerankHomeDir,
  verifyInstalledReranker,
} from '@knowledge-crib/core';

/**
 * The shipped model, and the reason it is not the small one.
 *
 * `Xenova/ms-marco-MiniLM-L-6-v2` is the standard small cross-encoder (~90 MB) and was measured
 * first. It is trained on web prose and cannot separate relevant code from irrelevant code: on a
 * four-passage probe it scored an unrelated `renderMarkdown` (-11.421) marginally ABOVE the relevant
 * `withLock` (-11.467). `bge-reranker-base` ordered the same probe correctly (-6.54 relevant code vs
 * -7.55 and -8.76 irrelevant). A reranker that cannot tell code apart converts noise into confident
 * order, which is worse than not reranking, so the 1.1 GB model is the default.
 */
export const DEFAULT_RERANK_MODEL = 'Xenova/bge-reranker-base';

/** Models this command will provision. An arbitrary id is refused — see {@link cmdRerankSetup}. */
export const SUPPORTED_RERANK_MODELS: readonly string[] = [
  'Xenova/bge-reranker-base',
  'Xenova/ms-marco-MiniLM-L-6-v2',
];

/**
 * Warm the weight cache by loading the model ONCE with remote fetching allowed.
 *
 * Runs as a child process inside the reused runtime directory, because a bare
 * `@huggingface/transformers` specifier only resolves from inside that tree. Returns the child's
 * stderr on failure so a network or disk error reaches the operator instead of becoming a later
 * integrity failure with no explanation.
 */
export function fetchRerankWeights(
  modelId: string,
  opts: { embedHome?: string } = {},
): { ok: true } | { ok: false; error: string } {
  const embedHome = opts.embedHome ?? embedHomeDir();
  const runtime = join(embedHome, 'runtime');
  const cacheDir = join(embedHome, 'models');
  if (!existsSync(join(runtime, 'package.json'))) {
    return {
      ok: false,
      error: `no ONNX runtime at ${runtime} — run \`crib embed setup\` first (the reranker reuses it rather than installing a second ~400 MB copy)`,
    };
  }
  // A module, run with the runtime as cwd so the bare specifier resolves. `allowRemoteModels` is TRUE
  // here and only here.
  const script = `
    const mod = await import('@huggingface/transformers');
    const api = mod?.env ? mod : mod?.default;
    api.env.cacheDir = ${JSON.stringify(cacheDir)};
    api.env.allowRemoteModels = true;
    api.env.allowLocalModels = true;
    await api.AutoTokenizer.from_pretrained(${JSON.stringify(modelId)});
    await api.AutoModelForSequenceClassification.from_pretrained(${JSON.stringify(modelId)}, { dtype: 'fp32' });
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: runtime,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // The first fetch pulls ~1.1 GB; a short timeout here would look like a broken install.
    timeout: 45 * 60 * 1000,
  });
  if (res.status === 0) return { ok: true };
  return {
    ok: false,
    error: (res.stderr || res.error?.message || `exit ${res.status}`).trim().slice(0, 600),
  };
}

/** `crib rerank setup [--model <id>] [--yes] [--list]` */
export function cmdRerankSetup(args: string[]): number {
  if (args.includes('--list')) {
    process.stdout.write(
      `supported reranker models:\n${SUPPORTED_RERANK_MODELS.map(
        (m) => `  ${m}${m === DEFAULT_RERANK_MODEL ? '   (default)' : ''}`,
      ).join('\n')}\n`,
    );
    return 0;
  }
  const modelIdx = args.indexOf('--model');
  const modelId = modelIdx >= 0 ? args[modelIdx + 1] : DEFAULT_RERANK_MODEL;
  if (!modelId || !SUPPORTED_RERANK_MODELS.includes(modelId)) {
    // An arbitrary id is refused rather than attempted: a model whose head is not a single-logit
    // sequence classifier produces scores that look like a ranking and are not one, and that failure
    // is invisible downstream.
    process.stderr.write(
      `unsupported reranker model: ${modelId ?? '(none)'}\n  supported: ${SUPPORTED_RERANK_MODELS.join(', ')}\n  A cross-encoder must expose a single-logit sequence-classification head; a model that does not\n  yields scores that look like a ranking without being one.\n`,
    );
    return 2;
  }
  if (!args.includes('--yes')) {
    process.stdout.write(
      `crib rerank setup would:\n` +
        `  1. download ${modelId} into ${join(embedHomeDir(), 'models')} (one time; ~1.1 GB for the default)\n` +
        `  2. generate an integrity-pinned adapter under ${rerankHomeDir()}\n` +
        `  3. reuse the ONNX runtime already installed by \`crib embed setup\` — no second copy\n\n` +
        `Re-run with --yes to proceed. Queries are offline afterwards: the generated adapter sets\n` +
        `allowRemoteModels=false, so a ranking can never fetch different weights than the pinned ones.\n`,
    );
    return 0;
  }
  process.stdout.write(`fetching ${modelId} (one time)…\n`);
  const fetched = fetchRerankWeights(modelId);
  if (!fetched.ok) {
    process.stderr.write(`error: ${fetched.error}\n`);
    return 1;
  }
  try {
    const manifest = installReranker({ modelId });
    process.stdout.write(
      `installed reranker ${manifest.rerankerId}\n` +
        `  adapter: ${manifest.modelDir} (${manifest.files.length} pinned file(s))\n` +
        `  weights: ${manifest.weights.files.length} pinned file(s) under ${manifest.weights.dir}\n` +
        `  runtime: ${manifest.runtimeDir} (reused)\n\n` +
        'Nothing uses it yet by default. Measure it before trusting it:\n' +
        '  node scripts/eval/code-vector-eval.mjs --rerank\n',
    );
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

/** `crib rerank status` — is a reranker installed, and does it still verify? */
export function cmdRerankStatus(): number {
  try {
    const manifest = readRerankManifest();
    process.stdout.write(
      `reranker: ${manifest.rerankerId}\n  model: ${manifest.modelId}\n  adapter: ${manifest.modelDir}\n  runtime: ${manifest.runtimeDir} (reused from the embed tier)\n`,
    );
    try {
      verifyInstalledReranker();
      process.stdout.write('  integrity: ok (adapter + weights match the pinned hashes)\n');
    } catch (e) {
      // Reported, never thrown: `status` exists to describe a broken install, so it must be able to.
      process.stdout.write(`  integrity: FAILED — ${(e as Error).message}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    process.stdout.write(
      `reranker: not installed (${(e as Error).message})\n  install with \`crib rerank setup --yes\`\n`,
    );
    return 0;
  }
}

/** `crib rerank <setup|status>` */
export function cmdRerank(args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'setup':
      return cmdRerankSetup(rest);
    case 'status':
    case undefined:
      return cmdRerankStatus();
    default:
      process.stderr.write('usage: crib rerank <setup [--model <id>] [--yes] [--list] | status>\n');
      return 2;
  }
}
