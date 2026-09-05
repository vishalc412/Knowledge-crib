/**
 * `crib embed setup` — the ONE command that turns the degraded lexical fallback into the semantic
 * tier.
 *
 * Why this exists. The on-device tier was reachable only by a three-step README ritual
 * (`pip install`, a Python one-liner to fetch weights, `crib embed install <repo-path>`), and that
 * last step named a path inside the git checkout — `examples/embedders/minilm-e5`. The published
 * package ships `["dist","skills","LICENSE","NOTICE"]`, so for anyone who installed crib from npm
 * the documented instructions could not be followed at all: the directory does not exist on their
 * disk. The tier was, in practice, git-checkout-only.
 *
 * So this module OWNS the adapter rather than pointing at one. It writes the bridge files into the
 * embed home, pins them through the same integrity path as a hand-installed model, and proves the
 * result works before reporting success.
 *
 * What it deliberately does NOT do:
 *   • It never installs a Python package or downloads weights without `--yes`. Both reach outside
 *     the repo — one mutates the operator's interpreter, the other pulls gigabytes over the
 *     network — so the default prints the exact commands and stops. `--yes` is the consent.
 *   • It never enables the remote embedder tier. That gate stays where it is (`--accept-remote-policy`
 *     on `crib embed install`), because "make setup easy" must not become "quietly start sending
 *     memory text to a third party".
 *   • It never claims a quality number it has not verified in-process. The smoke test at the end is
 *     a real ranking check, not a dimension assertion.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedHomeDir, installEmbedModel } from '@knowledge-crib/core';

/** A model the setup command knows how to install, with the numbers that make it choosable. */
export interface EmbedModelSpec {
  /** Short alias accepted by `--model`. */
  alias: string;
  /** HuggingFace repo id passed to sentence-transformers. */
  hfId: string;
  dim: number;
  /**
   * Text prefix applied to BOTH sides. E5 is trained asymmetrically (`query:`/`passage:`), but
   * memory recall is a similarity task — a paraphrase and the claim it restates are two ways of
   * saying one thing — so E5's own guidance is `query:` on both sides. Measured, not assumed:
   * 81.0% symmetric vs 73.2% asymmetric on the launch corpus.
   */
  prefix: string;
  /** Approximate on-disk size of the weights, so `--help` can state the download honestly. */
  approxDisk: string;
  /**
   * What this repository can actually SHOW about this model's retrieval quality.
   *
   * This is a field rather than a comment because the alternative was tried and failed: the ladder
   * previously carried bare `g2`/`gates` numbers for all three rows, attributed to a
   * `docs/bench/embed-model-ladder.md` that does not exist in the repository — and two of those
   * numbers disagreed with the figures that ARE committed (`docs/bench/launch-gates.md` records
   * 43.8% for e5-base, and the R1 pre-registration records 45.0% for MiniLM on a different, much
   * smaller harness). Printing those in `--help` would have sold a measurement no one can open.
   *
   * `gateVerified` rows may state a number. Everything else says plainly that it is unverified
   * here, so a reader can tell a reproduced result from a plausible one.
   */
  evidence: ModelEvidence;
  /** One line on the tradeoff this model represents. */
  note: string;
}

/** Provenance for a ladder row's quality claim. */
export type ModelEvidence =
  | {
      kind: 'gate-verified';
      /** Word-disjoint paraphrase recall@5 on the frozen launch corpus (gate G2, >= 80%). */
      g2: number;
      /** Gates passed out of 8, same run. */
      gates: number;
      /** The committed document a reader can open to check the number. */
      source: string;
    }
  | {
      kind: 'unverified';
      /** Why it is listed at all despite carrying no reproduced number. */
      reason: string;
    };

/** One line describing a row's evidence, for `--help` and the setup preamble. */
export function describeEvidence(evidence: ModelEvidence): string {
  return evidence.kind === 'gate-verified'
    ? `G2 ${(evidence.g2 * 100).toFixed(1)}%, ${evidence.gates}/8 gates (${evidence.source})`
    : `no gate run committed in this repository — ${evidence.reason}`;
}

/**
 * The model ladder.
 *
 * ONE row carries a committed gate run: `large` (`docs/bench/launch-gates.md`, G2 81.0%, 8/8). It is
 * therefore the default, because shipping anything else as "the semantic tier" would be selling a
 * threshold nothing here demonstrates.
 *
 * The other two rows are offered as smaller downloads and are labelled `unverified` — not as a
 * hedge, but because this repository contains no run to cite for them. Do not add a number to a row
 * without adding the run that produced it; `describeEvidence` prints whatever is here verbatim, so
 * an invented figure becomes a user-visible claim immediately.
 */
export const EMBED_MODELS: readonly EmbedModelSpec[] = [
  {
    alias: 'small',
    hfId: 'sentence-transformers/all-MiniLM-L6-v2',
    dim: 384,
    prefix: '',
    approxDisk: '~90 MB',
    evidence: {
      kind: 'unverified',
      reason:
        'English-only and by far the smallest download; listed as the low-cost option for trying the tier',
    },
    note: 'English-only. Not gate-verified here — do not assume it clears G2.',
  },
  {
    alias: 'base',
    hfId: 'intfloat/multilingual-e5-base',
    dim: 768,
    prefix: 'query: ',
    approxDisk: '~1.1 GB',
    evidence: {
      kind: 'unverified',
      reason:
        'the committed launch-gate run records 43.8% G2 for this model at an earlier configuration, below the 80% threshold',
    },
    note: 'multilingual, half the download of large. Not gate-verified here.',
  },
  {
    alias: 'large',
    hfId: 'intfloat/multilingual-e5-large',
    dim: 1024,
    prefix: 'query: ',
    evidence: {
      kind: 'gate-verified',
      g2: 0.81,
      gates: 8,
      source: 'docs/bench/launch-gates.md',
    },
    approxDisk: '~2.2 GB',
    note: 'the only model with a committed run passing all 8 launch gates — the default',
  },
] as const;

export const DEFAULT_EMBED_ALIAS = 'large';

export function resolveModelSpec(nameOrAlias: string): EmbedModelSpec | undefined {
  const hit = EMBED_MODELS.find((m) => m.alias === nameOrAlias || m.hfId === nameOrAlias);
  if (hit) return hit;
  // An unlisted HuggingFace id is allowed, but only with an explicit --dim: the dimension is
  // re-checked against the pinned manifest on every load, and guessing it would turn a typo into a
  // silent mis-scoring rather than a clean failure.
  return undefined;
}

/**
 * Directory holding the generated adapter for one model — inside the embed home, never the repo.
 *
 * The model id reaches here from `--model`, so it is untrusted input that becomes a path segment.
 * Replacing the separators alone already keeps the result under `home`, but a surviving `..` is one
 * refactor away from being a traversal, so dot runs are collapsed too: the segment is defended on
 * its own terms rather than by an argument about the caller.
 */
export function adapterDir(spec: { hfId: string }, home: string = embedHomeDir()): string {
  const segment = spec.hfId
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '');
  return join(home, 'adapters', segment || 'model');
}

/** Stable embedder id. Encodes everything that changes the vector space, because it KEYS the
 *  persistent vector cache — a behaviour change under a stable id would serve stale vectors from
 *  the old embedding space. */
export function embedderIdFor(spec: EmbedModelSpec): string {
  const base = spec.hfId.split('/').pop() ?? spec.hfId;
  return `${base}-${spec.dim}-${spec.prefix ? 'sym' : 'raw'}`;
}

/** The Python side: one process per batch, offline, L2-normalised so cosine is a dot product. */
export function renderEmbedBatchPy(spec: EmbedModelSpec): string {
  return `"""Batch embedder generated by \`crib embed setup\` for ${spec.hfId}.

Protocol (one process per batch, so the model load is amortised):
    stdin  {"texts": ["...", ...]}
    stdout {"dim": ${spec.dim}, "vectors": [[...], ...]}

Vectors are L2-normalised, so the consumer's cosine is a plain dot product.

OFFLINE by default: the weights must already be in the local HuggingFace cache, so a query never
reaches the network. \`crib embed setup\` performs the one-time download.
"""

import json
import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL = os.environ.get("KCRIB_EMBED_MODEL", ${JSON.stringify(spec.hfId)})
DIM = ${spec.dim}
BATCH = int(os.environ.get("KCRIB_EMBED_BATCH", "64"))


def main() -> int:
    payload = json.load(sys.stdin)
    texts = payload.get("texts") or []
    if not texts:
        json.dump({"dim": DIM, "vectors": []}, sys.stdout)
        return 0

    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        # crib treats any adapter error as "no tier" and falls back to lexical-only, so this
        # message is the operator's only clue about why recall got worse.
        print(
            "knowledge-crib embedder: sentence-transformers is not installed.\\n"
            "  pip install sentence-transformers\\n"
            "  (or set KCRIB_EMBED_PYTHON to an interpreter that has it)",
            file=sys.stderr,
        )
        return 1

    model = SentenceTransformer(MODEL, device="cpu")
    vecs = model.encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        batch_size=BATCH,
        show_progress_bar=False,
    )
    json.dump(
        {"dim": int(vecs.shape[1]), "vectors": [[float(x) for x in v] for v in vecs]},
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
}

/** The JS side: the Embedder crib loads. Synchronous contract over an async model, so it shells out
 *  to one short-lived Python batch and memoizes every vector on disk. */
export function renderEmbedderMjs(spec: EmbedModelSpec, pythonPath: string): string {
  const id = embedderIdFor(spec);
  return `/**
 * Generated by \`crib embed setup\` for ${spec.hfId}. Regenerate with the same command; do not
 * hand-edit — \`crib embed install\` hashes every file here and a drifted file fails verification.
 *
 * THE TWO CONTRACTS THAT ARE EASY TO GET WRONG
 * 1. \`embedBatch(texts)[i]\` MUST equal \`embed(texts[i])\`. Batching is a PERFORMANCE variant,
 *    never a semantic one. An earlier hand-written adapter applied E5's \`query:\` prefix in one
 *    method and \`passage:\` in the other; ranking then depended on which method the caller reached
 *    for, and switching crib's record loop from \`embed\` to \`embedBatch\` silently cost 8 points of
 *    paraphrase recall. Both methods below go through ONE code path.
 * 2. \`id\` must change whenever the embedding behaviour changes. It keys crib's persistent vector
 *    cache, so a silent behaviour change under a stable id would serve vectors from the old space.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.KCRIB_EMBED_PYTHON ?? ${JSON.stringify(pythonPath)};
const SCRIPT = join(HERE, 'embed_batch.py');
const ID = ${JSON.stringify(id)};
const DIM = ${spec.dim};
const PREFIX = ${JSON.stringify(spec.prefix)};
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

function runPython(texts) {
  const out = execFileSync(PYTHON, [SCRIPT], {
    input: JSON.stringify({ texts }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  if (parsed.dim !== DIM) {
    throw new Error(
      'embedder dim ' + parsed.dim + ' != pinned ' + DIM + ' — manifest and model disagree',
    );
  }
  return parsed.vectors.map((v) => Float32Array.from(v));
}

class GeneratedEmbedder {
  get id() {
    return ID;
  }

  dim() {
    return DIM;
  }

  /** The ONE code path. \`embed\` delegates here so the two can never diverge. */
  embedBatch(texts) {
    const out = new Array(texts.length);
    const missing = [];
    const missingIdx = [];
    for (let i = 0; i < texts.length; i++) {
      const hit = readCached(texts[i]);
      if (hit) out[i] = hit;
      else {
        missing.push(texts[i]);
        missingIdx.push(i);
      }
    }
    if (missing.length > 0) {
      const fresh = runPython(missing.map((t) => PREFIX + t));
      for (let i = 0; i < fresh.length; i++) {
        writeCached(missing[i], fresh[i]);
        out[missingIdx[i]] = fresh[i];
      }
    }
    return out;
  }

  embed(text) {
    return this.embedBatch([text])[0];
  }
}

export default new GeneratedEmbedder();
`;
}

/** Write the adapter pair for `spec` into `dir` (created fresh — a stale file would fail the hash
 *  pin on the next install). Returns the directory. */
export function writeAdapter(spec: EmbedModelSpec, pythonPath: string, dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'embed_batch.py'), renderEmbedBatchPy(spec));
  writeFileSync(join(dir, 'embedder.mjs'), renderEmbedderMjs(spec, pythonPath));
  return dir;
}

export interface StepResult {
  ok: boolean;
  detail: string;
}

/** Injectable process runner, so the setup steps are testable without a Python on the box. */
export type RunFn = (cmd: string, args: string[], input?: string) => string;

export const defaultRun: RunFn = (cmd, args, input) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 64,
  });

/** Step 1 — a Python that actually runs. `KCRIB_EMBED_PYTHON` wins, then `--python`, then PATH. */
export function checkPython(pythonPath: string, run: RunFn = defaultRun): StepResult {
  try {
    const v = run(pythonPath, ['-c', 'import sys; print(sys.version.split()[0])']).trim();
    return { ok: true, detail: `${pythonPath} (Python ${v})` };
  } catch (err) {
    return {
      ok: false,
      detail: `cannot run "${pythonPath}": ${(err as Error).message.split('\n')[0]}`,
    };
  }
}

/** Step 2 — sentence-transformers importable by THAT interpreter (not by whatever is on PATH). */
export function checkSentenceTransformers(pythonPath: string, run: RunFn = defaultRun): StepResult {
  try {
    const v = run(pythonPath, [
      '-c',
      'import sentence_transformers as s; print(s.__version__)',
    ]).trim();
    return { ok: true, detail: `sentence-transformers ${v}` };
  } catch {
    return { ok: false, detail: 'sentence-transformers is not importable by this interpreter' };
  }
}

/** Step 3 — are the weights already in the local HuggingFace cache? Checked OFFLINE, so a "yes"
 *  proves a later query needs no network. */
export function checkWeights(
  spec: EmbedModelSpec,
  pythonPath: string,
  run: RunFn = defaultRun,
): StepResult {
  const probe = [
    'import os',
    'os.environ["HF_HUB_OFFLINE"]="1"',
    'os.environ["TRANSFORMERS_OFFLINE"]="1"',
    'from sentence_transformers import SentenceTransformer',
    `SentenceTransformer(${JSON.stringify(spec.hfId)}, device="cpu")`,
    'print("cached")',
  ].join('; ');
  try {
    run(pythonPath, ['-c', probe]);
    return { ok: true, detail: `${spec.hfId} present in the local HuggingFace cache (offline)` };
  } catch {
    return { ok: false, detail: `${spec.hfId} is not in the local cache (${spec.approxDisk})` };
  }
}

/** Step 3b — the ONE step that touches the network, and only under `--yes`. */
export function downloadWeights(
  spec: EmbedModelSpec,
  pythonPath: string,
  run: RunFn = defaultRun,
): StepResult {
  try {
    run(pythonPath, [
      '-c',
      `from sentence_transformers import SentenceTransformer; SentenceTransformer(${JSON.stringify(spec.hfId)})`,
    ]);
    return { ok: true, detail: `downloaded ${spec.hfId}` };
  } catch (err) {
    return { ok: false, detail: `download failed: ${(err as Error).message.split('\n')[0]}` };
  }
}

/**
 * Step 5 — prove the tier RANKS, not merely that it loads. A dimension check passes for a model
 * returning noise; this asserts that a paraphrase scores above an unrelated sentence, which is the
 * property recall actually depends on. Returns the margin so the CLI can print it.
 */
export async function smokeTest(home: string): Promise<{ ok: boolean; detail: string }> {
  const { loadInstalledEmbedder } = await import('@knowledge-crib/core');
  const embedder = await loadInstalledEmbedder(home);
  if (!embedder) return { ok: false, detail: 'installed model failed to load' };
  const claim = 'the deploy pipeline retries a failed step three times before giving up';
  const paraphrase = 'how many attempts does a broken release make before it stops';
  const unrelated = 'the office coffee machine is on the second floor';
  const [a, b, c] = embedder.embedBatch([claim, paraphrase, unrelated]);
  if (!a || !b || !c) return { ok: false, detail: 'embedBatch returned fewer vectors than texts' };
  const dot = (x: Float32Array, y: Float32Array) => {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += (x[i] ?? 0) * (y[i] ?? 0);
    return s;
  };
  const near = dot(a, b);
  const far = dot(a, c);
  // Also assert the batch/single invariant here: it is the failure that silently cost 8 points.
  const single = embedder.embed(claim);
  let drift = 0;
  for (let i = 0; i < a.length; i++)
    drift = Math.max(drift, Math.abs((a[i] ?? 0) - (single[i] ?? 0)));
  if (drift > 1e-5) {
    return {
      ok: false,
      detail: `embed() and embedBatch() disagree by ${drift.toFixed(6)} — the adapter has two code paths`,
    };
  }
  if (!(near > far)) {
    return {
      ok: false,
      detail: `no semantic signal: paraphrase ${near.toFixed(3)} <= unrelated ${far.toFixed(3)}`,
    };
  }
  return {
    ok: true,
    detail: `paraphrase ${near.toFixed(3)} > unrelated ${far.toFixed(3)} (margin ${(near - far).toFixed(3)})`,
  };
}

/** Pin the generated adapter through the same integrity path a hand-installed model takes. */
export async function pinAdapter(spec: EmbedModelSpec, dir: string) {
  return installEmbedModel({
    modelDir: dir,
    modelId: spec.hfId,
    modelVersion: '1',
    entry: 'embedder.mjs',
    installedAt: new Date().toISOString(),
  });
}

// ─── the orchestrator ────────────────────────────────────────────────────────

/** What `crib embed setup` decided and did, as data — the CLI renders it, tests assert on it. */
export interface SetupPlan {
  spec: EmbedModelSpec;
  /** Each step in the order attempted, with its human-readable outcome. */
  steps: { name: string; result: StepResult }[];
  /** True when the tier is installed, pinned and proven to rank. */
  installed: boolean;
  /** Set when the run stopped deliberately rather than failing (e.g. missing download consent). */
  needsConsent?: string;
  /** The exact commands an operator should run to satisfy a stopped or failed step. */
  remediation: string[];
}

export interface SetupOptions {
  spec: EmbedModelSpec;
  pythonPath: string;
  /** Consent for the one step that reaches the network (the weight download). */
  yes: boolean;
  home?: string;
  run?: RunFn;
  /** Injected so the smoke test can be exercised without a real model on the box. */
  smoke?: (home: string) => Promise<{ ok: boolean; detail: string }>;
  pin?: (spec: EmbedModelSpec, dir: string) => Promise<unknown>;
}

/**
 * Run setup as a sequence of checks that STOP at the first unmet precondition.
 *
 * The ordering is the point: every step is cheap and local until the one that is not. Python and
 * `sentence-transformers` are verified against the SAME interpreter that will run the adapter (a
 * PATH-level check would pass while the adapter fails), and the weights are probed OFFLINE, so a
 * pass proves a later query needs no network rather than merely that a download could succeed.
 *
 * Nothing is downloaded without `yes`. A stopped run is not a failure: it reports the exact commands
 * to run, which is the difference between "setup failed" and "setup needs your consent for a 2.2 GB
 * download".
 */
export async function runEmbedSetup(opts: SetupOptions): Promise<SetupPlan> {
  const { spec, pythonPath, yes } = opts;
  const run = opts.run ?? defaultRun;
  const home = opts.home ?? embedHomeDir();
  const smoke = opts.smoke ?? smokeTest;
  const pin = opts.pin ?? pinAdapter;
  const steps: SetupPlan['steps'] = [];
  const stop = (needsConsent: string | undefined, remediation: string[]): SetupPlan => ({
    spec,
    steps,
    installed: false,
    ...(needsConsent ? { needsConsent } : {}),
    remediation,
  });

  const python = checkPython(pythonPath, run);
  steps.push({ name: 'python', result: python });
  if (!python.ok) {
    return stop(undefined, [
      'Install Python 3.9+ and re-run, or point crib at a specific interpreter:',
      '  crib embed setup --python /path/to/python3',
      '  (or set KCRIB_EMBED_PYTHON)',
    ]);
  }

  const st = checkSentenceTransformers(pythonPath, run);
  steps.push({ name: 'sentence-transformers', result: st });
  if (!st.ok) {
    // Deliberately NOT auto-installed even under --yes: this mutates the operator's interpreter,
    // which is theirs to decide. Consent for a model download is not consent to change a toolchain.
    return stop(`sentence-transformers is not installed for ${pythonPath}`, [
      'Install it into that interpreter, then re-run:',
      `  ${pythonPath} -m pip install sentence-transformers`,
    ]);
  }

  let weights = checkWeights(spec, pythonPath, run);
  steps.push({ name: 'weights', result: weights });
  if (!weights.ok) {
    if (!yes) {
      return stop(`${spec.hfId} (${spec.approxDisk}) is not cached and would be downloaded`, [
        `Re-run with consent for the ${spec.approxDisk} download:`,
        `  crib embed setup --model ${spec.alias} --yes`,
        'Or fetch the weights yourself first:',
        `  ${pythonPath} -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${spec.hfId}')"`,
      ]);
    }
    const downloaded = downloadWeights(spec, pythonPath, run);
    steps.push({ name: 'download', result: downloaded });
    if (!downloaded.ok) {
      return stop(undefined, [
        'The download failed. Check network access and disk space, then re-run.',
      ]);
    }
    weights = checkWeights(spec, pythonPath, run);
    steps.push({ name: 'weights (recheck)', result: weights });
    if (!weights.ok) {
      // A download reporting success but leaving nothing offline-loadable is a broken cache, not a
      // working tier — refuse rather than pin an adapter that cannot answer a query.
      return stop(undefined, [
        'The weights downloaded but are still not loadable offline — the HuggingFace cache may be',
        'partially written. Locate and clear it, then re-run:',
        `  ${pythonPath} -c "import huggingface_hub; print(huggingface_hub.constants.HF_HUB_CACHE)"`,
      ]);
    }
  }

  const dir = adapterDir(spec, home);
  writeAdapter(spec, pythonPath, dir);
  steps.push({ name: 'adapter', result: { ok: true, detail: `wrote bridge files to ${dir}` } });

  try {
    await pin(spec, dir);
    steps.push({
      name: 'pin',
      result: { ok: true, detail: `pinned ${spec.hfId} through the integrity manifest` },
    });
  } catch (err) {
    steps.push({
      name: 'pin',
      result: { ok: false, detail: `pin failed: ${(err as Error).message.split('\n')[0]}` },
    });
    return stop(undefined, [
      'The adapter could not be pinned. Re-run; if it persists, report the error above.',
    ]);
  }

  // The last step is the only one proving the tier RANKS. A dimension check passes for a model
  // returning noise, and the audited failure mode was precisely a configured-but-unusable tier
  // silently serving lexical results — so success is not reported until a paraphrase outscores an
  // unrelated sentence in-process.
  const proof = await smoke(home);
  steps.push({ name: 'smoke', result: proof });
  if (!proof.ok) {
    return stop(undefined, [
      'The model installed but did not demonstrate semantic ranking, so the tier is NOT enabled.',
      'Re-run `crib embed setup`; if it persists, the adapter and the interpreter disagree.',
    ]);
  }

  return { spec, steps, installed: true, remediation: [] };
}
