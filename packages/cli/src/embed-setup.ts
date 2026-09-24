/**
 * `crib embed setup` — the ONE command that turns the degraded lexical fallback into the semantic
 * tier. It installs an on-device ONNX model into the embed home, pins it through the same integrity
 * path as a hand-installed model, and proves the result ranks before reporting success.
 *
 * What it deliberately does NOT do:
 *   • It never downloads weights without `--yes` — the default prints the plan and stops.
 *   • It never enables the remote embedder tier. That gate stays where it is (`--accept-remote-policy`
 *     on `crib embed install`), because "make setup easy" must not become "quietly start sending
 *     memory text to a third party".
 *   • It never claims a quality number it has not verified in-process. The smoke test at the end is
 *     a real ranking check, not a dimension assertion.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { embedHomeDir, installEmbedModel } from '@knowledge-crib/core';
import {
  ONNX_RUNTIME_APPROX_DISK,
  ONNX_RUNTIME_PACKAGE,
  type OnnxAdapterSpec,
  type OnnxStep,
  downloadOnnxWeights,
  installOnnxRuntime,
  onnxModelCacheDir,
  onnxProvisioningPin,
  onnxRuntimeInstalled,
  publishStagedModel,
  refreshOnnxWorker,
  stagedModelProblem,
  writeOnnxAdapter,
} from './embed-onnx.js';

/** A model the setup command knows how to install, with the numbers that make it choosable. */
export interface EmbedModelSpec {
  /** Short alias accepted by `--model`. */
  alias: string;
  /** HuggingFace repo id — the model's canonical identity, used for the integrity pin. */
  hfId: string;
  /** The ONNX-hosted mirror the runtime loads. Same weights, converted; this is what ships. */
  onnxId: string;
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
 * The model ladder — one family at three sizes, so `--model` is a size/quality dial and not a change
 * of behaviour. Every row now carries a gate run measured through the ONNX path and recorded in
 * `docs/bench/onnx-model-ladder.md`, including the rows that FAIL a gate: a row's number is there to
 * be argued with, and hiding a 42.5% behind "unverified" would be less honest than printing it.
 *
 * `large` is the default because it is the only row clearing all eight frozen gates — shipping
 * anything else as "the semantic tier" would advertise a threshold the project's own release
 * evidence would then fail.
 *
 * Do not add a number to a row without adding the run that produced it. `describeEvidence` prints
 * whatever is here verbatim, so an invented figure becomes a user-visible claim immediately.
 */
export const EMBED_MODELS: readonly EmbedModelSpec[] = [
  {
    alias: 'small',
    hfId: 'sentence-transformers/all-MiniLM-L6-v2',
    onnxId: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    prefix: '',
    approxDisk: '~97 MB',
    evidence: {
      kind: 'gate-verified',
      g2: 0.66,
      gates: 6,
      source: 'docs/bench/onnx-model-ladder.md',
    },
    note: 'English-only, and 5x smaller than the multilingual rows for BETTER paraphrase recall than multilingual-e5-small on this corpus. Misses G2 and G3 — choose it for footprint, not for the advertised tier.',
  },
  {
    alias: 'base',
    hfId: 'intfloat/multilingual-e5-base',
    onnxId: 'Xenova/multilingual-e5-base',
    dim: 768,
    prefix: 'query: ',
    approxDisk: '~1.1 GB',
    evidence: {
      kind: 'gate-verified',
      g2: 0.699,
      gates: 7,
      source: 'docs/bench/onnx-model-ladder.md',
    },
    note: 'half the download of large and the best MRR below it, but still short of the 80% paraphrase gate.',
  },
  {
    alias: 'large',
    hfId: 'intfloat/multilingual-e5-large',
    onnxId: 'Xenova/multilingual-e5-large',
    dim: 1024,
    prefix: 'query: ',
    approxDisk: '~2.1 GB',
    evidence: {
      kind: 'gate-verified',
      g2: 0.811,
      gates: 8,
      source: 'docs/bench/onnx-model-ladder.md',
    },
    note: 'the only row clearing all 8 frozen gates — the default, and the configuration the release evidence describes.',
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

export interface StepResult {
  ok: boolean;
  detail: string;
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

/**
 * Pin the generated adapter through the same integrity path a hand-installed model takes — plus
 * (WP1.8) the provisioning pin for everything setup downloaded BESIDES the adapter: the weight
 * cache by sha256 of every file, the runtime by installed dependency versions. Without the
 * provisioning pin the manifest verified two generated .mjs files and trusted 2.1 GB of weights
 * by omission.
 */
export async function pinAdapter(spec: EmbedModelSpec, dir: string, home: string) {
  return installEmbedModel({
    modelDir: dir,
    modelId: spec.hfId,
    // Ladder-row label. The ARTIFACT identity is the content hashes, not this string.
    modelVersion: '1',
    entry: 'embedder.mjs',
    installedAt: new Date().toISOString(),
    // Forward the caller's home explicitly — without this, installEmbedModel falls back to its
    // OWN embedHomeDir() default. That default coincides with the caller's home in every real
    // invocation (both resolve KCRIB_EMBED_HOME the same way), so the bug is silent in production
    // and only bites a caller that legitimately passes a DIFFERENT home (a test's tmpdir), where
    // it silently published the pin into the developer's real ~/.crib/embed instead.
    home,
    provisioning: onnxProvisioningPin(home, {
      onnxId: spec.onnxId,
      dim: spec.dim,
      prefix: spec.prefix,
    }),
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
  /**
   * Machine-readable terminal state (WP1.7), so a noninteractive caller never has to parse prose:
   *   installed         the tier is installed, pinned and proven to rank
   *   consent-required  nothing happened; the run stopped BEFORE any download, waiting on --yes
   *   failed            a step that was consented to did not succeed; see remediation
   * A run that stopped for consent is deliberately NOT "failed" — the plan's own contract is that
   * nothing reached the network, which is the expected behaviour without `--yes`.
   */
  status: 'installed' | 'consent-required' | 'failed';
  /** Set when the run stopped deliberately rather than failing (e.g. missing download consent). */
  needsConsent?: string;
  /** The exact commands an operator should run to satisfy a stopped or failed step. */
  remediation: string[];
}

export interface SetupOptions {
  spec: EmbedModelSpec;
  /**
   * Consent for the steps that reach the network: installing the ONNX runtime into the embed home
   * and downloading the model weights. Without it the run STOPS and prints the exact commands.
   */
  yes: boolean;
  home?: string;
  /**
   * A directory holding a pre-fetched runtime + weights (the air-gapped path). When set, nothing
   * reaches the network at all: the bundle is used as the model cache and no download is attempted.
   */
  from?: string;
  /** Injected so the smoke test can be exercised without a real model on the box. */
  smoke?: (home: string) => Promise<{ ok: boolean; detail: string }>;
  pin?: (spec: EmbedModelSpec, dir: string, home: string) => Promise<unknown>;
  /** Injected runtime installer (tests). */
  installRuntime?: (home: string) => OnnxStep;
  /** Injected weight fetcher (tests). */
  fetchWeights?: (home: string, spec: OnnxAdapterSpec) => OnnxStep;
  /** Injected probe for "is the runtime already here?" (tests). */
  runtimePresent?: (home: string) => boolean;
}

/**
 * Run setup as a sequence of checks that STOP at the first unmet precondition.
 *
 * The ordering is the point: every step is cheap and local until the one that is not, and nothing
 * reaches the network without `yes`. A stopped run is not a failure — it reports the exact command
 * to run, which is the difference between "setup failed" and "setup needs consent for a 1.1 GB
 * download".
 *
 * The steps are ONNX now, not Python. What did not change is the last one: success is not reported
 * until a paraphrase out-scores an unrelated sentence in-process. A dimension check passes for a
 * model returning noise, and the audited failure was precisely a configured-but-unusable tier
 * silently serving lexical results.
 */
export async function runEmbedSetup(opts: SetupOptions): Promise<SetupPlan> {
  const { spec, yes } = opts;
  const home = opts.home ?? embedHomeDir();
  const smoke = opts.smoke ?? smokeTest;
  const pin = opts.pin ?? pinAdapter;
  const installRuntime = opts.installRuntime ?? ((h: string) => installOnnxRuntime(h));
  const fetchWeights =
    opts.fetchWeights ?? ((h: string, sp: OnnxAdapterSpec) => downloadOnnxWeights(h, sp));
  const runtimePresent = opts.runtimePresent ?? onnxRuntimeInstalled;
  const adapterSpec: OnnxAdapterSpec = {
    onnxId: spec.onnxId,
    dim: spec.dim,
    prefix: spec.prefix,
  };
  const steps: SetupPlan['steps'] = [];
  const stop = (needsConsent: string | undefined, remediation: string[]): SetupPlan => ({
    spec,
    steps,
    installed: false,
    status: needsConsent ? 'consent-required' : 'failed',
    ...(needsConsent ? { needsConsent } : {}),
    remediation,
  });

  // 1. The runtime. ~376 MB of npm packages into the embed home — never into the user's project,
  //    never into crib's own dependencies (the workspace runs a hard external-dependency cap).
  if (!runtimePresent(home)) {
    if (!yes && !opts.from) {
      return stop(
        `the ONNX runtime (${ONNX_RUNTIME_PACKAGE}, ${ONNX_RUNTIME_APPROX_DISK}) is not installed ` +
          `and would be downloaded into ${home}`,
        [
          'Re-run with consent to install the runtime and weights:',
          `  crib embed setup --model ${spec.alias} --yes`,
          'Air-gapped? Point at a pre-fetched bundle instead:',
          `  crib embed setup --model ${spec.alias} --from /path/to/bundle`,
        ],
      );
    }
    const installed = installRuntime(home);
    steps.push({ name: 'runtime', result: installed });
    if (!installed.ok) {
      // The launcher's classified repair (discovery/network/install/post-install) is specific;
      // the generic text remains only as the fallback for steps that produced none.
      return stop(undefined, [
        installed.repair ??
          'The ONNX runtime could not be installed. Check network access, npm availability and disk' +
            ' space, then re-run. For an air-gapped host, use `--from <bundle-dir>`.',
      ]);
    }
  } else {
    // The npm install is skipped, but the GENERATED worker is refreshed regardless: it ships with
    // crib, so a stale one from a previous release would silently disagree with this release's
    // adapter about their handshake — which hangs instead of failing.
    refreshOnnxWorker(home);
    steps.push({
      name: 'runtime',
      result: { ok: true, detail: `already installed in ${home} (worker refreshed)` },
    });
  }

  // 2. The weights. `--from` is the offline path: the bundle IS the cache, so nothing is fetched.
  if (opts.from) {
    const linked = adoptOfflineBundle(home, opts.from, spec.onnxId);
    steps.push({ name: 'weights (offline bundle)', result: linked });
    if (!linked.ok) {
      return stop(undefined, [
        `The bundle at ${opts.from} does not contain a usable model cache.`,
        `Produce one on a networked machine with \`crib embed setup --model ${spec.alias} --yes\`,`,
        `then copy that machine's ${onnxModelCacheDir('<embed-home>')} directory across.`,
      ]);
    }
  } else {
    if (!yes) {
      return stop(
        `${spec.onnxId} (${spec.approxDisk}) is not cached and would be downloaded into ` +
          `${onnxModelCacheDir(home)}`,
        [
          `Re-run with consent for the ${spec.approxDisk} download:`,
          `  crib embed setup --model ${spec.alias} --yes`,
        ],
      );
    }
    const fetched = fetchWeights(home, adapterSpec);
    steps.push({ name: 'weights', result: fetched });
    if (!fetched.ok) {
      return stop(undefined, [
        'The weight download failed. Check network access and disk space, then re-run.',
      ]);
    }
  }

  // 3. The adapter, pinned through the SAME integrity manifest a hand-installed model uses.
  const dir = adapterDir(spec, home);
  writeOnnxAdapter(home, adapterSpec, embedderIdFor(spec), dir);
  steps.push({ name: 'adapter', result: { ok: true, detail: `wrote adapter to ${dir}` } });

  try {
    await pin(spec, dir, home);
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

  // 4. Prove it RANKS. The only step that distinguishes a working tier from a loaded one.
  const proof = await smoke(home);
  steps.push({ name: 'smoke', result: proof });
  if (!proof.ok) {
    return stop(undefined, [
      'The model installed but did not demonstrate semantic ranking, so the tier is NOT enabled.',
      'Re-run `crib embed setup`; if it persists, the adapter and the runtime disagree.',
    ]);
  }

  return { spec, steps, installed: true, status: 'installed', remediation: [] };
}

/**
 * Adopt a pre-fetched bundle as this embed home's model cache — the air-gapped path.
 *
 * Copying rather than symlinking: the cache is read on every model load, and a link into a
 * removable directory turns a working tier into one that breaks the day someone unmounts the
 * bundle. The failure would surface as a degraded fallback at query time, which is exactly the
 * silent-downgrade behaviour this whole tier exists to avoid.
 *
 * WP1.10 — when `onnxId` is supplied (the setup flow always supplies it), the bundle passes the
 * SAME gate a network download does: copy into staging, verify the model dir is complete (the
 * `stagedModelProblem` checklist), then publish by atomic swap so a bad bundle never replaces a
 * working cache. Without `onnxId` the legacy whole-cache copy is kept for callers that relocate a
 * cache without a specific model in mind.
 */
export function adoptOfflineBundle(home: string, bundle: string, onnxId?: string): OnnxStep {
  const cache = onnxModelCacheDir(home);
  try {
    if (!existsSync(bundle)) return { ok: false, detail: `bundle not found: ${bundle}` };
    if (!onnxId) {
      mkdirSync(cache, { recursive: true });
      cpSync(bundle, cache, { recursive: true });
      return { ok: true, detail: `adopted ${bundle} as the offline model cache` };
    }
    mkdirSync(home, { recursive: true });
    const staging = mkdtempSync(join(home, '.bundle-staging-'));
    try {
      cpSync(bundle, staging, { recursive: true });
      const problem = stagedModelProblem(join(staging, ...onnxId.split('/')));
      if (problem) {
        return {
          ok: false,
          detail: `bundle incomplete: ${problem} — nothing was adopted, the previous model was preserved`,
        };
      }
      publishStagedModel(staging, cache, onnxId);
      return {
        ok: true,
        detail: `adopted ${bundle} as the offline model cache (verified complete)`,
      };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (err) {
    return { ok: false, detail: `could not adopt bundle: ${(err as Error).message}` };
  }
}
