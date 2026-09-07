/**
 * G3.2 — the embedder TIER report: the structured doctor surface (red line #3 + #6). `crib doctor`
 * renders this verbatim; this module owns the truth about WHICH tier is active and WHY, so the
 * doctor stays a formatter and never re-derives tier logic.
 *
 * Tiers, exactly one active:
 *   - `installed`  — the pinned on-device model, loaded from the integrity-verified manifest under
 *                    the embed home (the ADVERTISED semantic tier).
 *   - `fallback`   — the char-ngram hashing-trick embedder: a DEGRADED OFFLINE FALLBACK, never the
 *                    semantic implementation (the wording in `reason` is the contract).
 *   - the remote tier is never active here — it is reported via `remoteEnabled` (opt-in-only, see
 *                    `remote.ts`) so doctor can show "remote: acknowledged/disabled".
 *
 *   - `external`   — a working `KCRIB_EMBEDDER` provider supplied by the operator. It is reported as
 *                    its OWN tier, not as `fallback`: calling a real semantic embedder "degraded
 *                    char-ngram fallback" told operators who had correctly wired a local model that
 *                    their setup had not taken effect. Crib does not pin or verify this provider,
 *                    so the report says so rather than claiming the `installed` tier's guarantees.
 *
 * `externalOverride` remains on the report as the raw fact (an override is configured) — the `tier`
 * says whether that override actually LOADED.
 *
 * Async because the honest report LOADS the installed model (id + dim re-check) rather than
 * trusting the manifest. Failure modes degrade to `fallback` + `problems`, never to a fabricated
 * quality claim — and never throw: a broken install must be renderable by doctor, not fatal.
 */
import { CharNgramEmbedder } from './char-ngram.js';
import {
  embedHomeDir,
  embedManifestPath,
  loadInstalledEmbedder,
  verifyInstalledEmbed,
} from './embed-install.js';
import { remoteOptIn } from './remote.js';

/** The active embedder tier. */
export type EmbedTierState = 'fallback' | 'installed' | 'external';

/** Structured tier report — the doctor surface data (JSON-serializable, no functions). */
export interface EmbedTierReport {
  tier: EmbedTierState;
  /** The embedder id backing the ACTIVE tier (flows into scorer version ids, red line #6). */
  embedderId: string;
  /** The degraded fallback's id — always reported, so doctor can show what you'd fall back TO. */
  fallbackId: string;
  /** true iff the operator acknowledged the current remote data policy (the tier stays opt-in). */
  remoteEnabled: boolean;
  /** true iff KCRIB_EMBEDDER selects a non-builtin provider (the tiers are then bypassed). */
  externalOverride: boolean;
  modelId?: string;
  modelVersion?: string;
  manifestPath: string;
  manifestPresent: boolean;
  /** undefined when no manifest exists; otherwise the integrity verdict. */
  integrityOk?: boolean;
  /** Integrity/manifest problems (empty when healthy). */
  problems: string[];
  /** Human-readable WHY — includes the degraded-fallback wording verbatim when tier=fallback. */
  reason: string;
}

/**
 * Load an operator-supplied `KCRIB_EMBEDDER` provider and prove it answers, so the tier report can
 * distinguish "configured" from "working". Never throws: a broken provider is a renderable state.
 */
async function loadExternalEmbedder(
  spec: string,
): Promise<{ ok: true; id: string; dim: number } | { ok: false; error: string }> {
  try {
    const { resolveEmbedder } = await import('./provider.js');
    const embedder = await resolveEmbedder({ provider: spec });
    if (!embedder) return { ok: false, error: 'provider resolved to nothing' };
    const probe = embedder.embed('knowledge crib embedder probe');
    if (!Array.isArray(probe) || probe.length === 0) {
      return { ok: false, error: 'embed() returned no vector' };
    }
    return { ok: true, id: embedder.id, dim: probe.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const FALLBACK_NOTE =
  'char-ngram is a DEGRADED OFFLINE FALLBACK (hashing-trick char n-grams), never a semantic embedder';
// One command, and it names the cost up front. The previous hint pointed at
// `examples/embedders/minilm-e5`, a path that exists only in a git checkout — the published package
// ships dist/skills/LICENSE/NOTICE, so for an npm install the instructions could not be followed.
const INSTALL_HINT =
  'install the on-device tier with one command: `crib embed setup` ' +
  '(add --yes to allow the one-time model download; `crib embed setup --list` shows the measured ' +
  'size/quality ladder)';

/**
 * Build the tier report for the CURRENT environment. `opts.home` relocates the embed home (tests);
 * `opts.env` relocates env reads (tests).
 */
export async function embedTierReport(
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<EmbedTierReport> {
  const home = opts.home ?? embedHomeDir(opts.env);
  const fallback = new CharNgramEmbedder();
  const override = (opts.env ?? process.env).KCRIB_EMBEDDER;
  const externalOverride =
    override !== undefined &&
    override !== 'char-ngram' &&
    override !== 'builtin:char-ngram' &&
    override !== 'installed' &&
    override !== 'builtin:installed';

  const report: EmbedTierReport = {
    tier: 'fallback',
    embedderId: fallback.id,
    fallbackId: fallback.id,
    remoteEnabled: remoteOptIn(home),
    externalOverride,
    manifestPath: embedManifestPath(home),
    manifestPresent: false,
    problems: [],
    reason: '',
  };

  try {
    const v = verifyInstalledEmbed(home);
    report.manifestPresent = v.present;
    report.integrityOk = v.present ? v.ok : undefined;
    report.problems = v.problems;
    if (v.present && v.ok && v.manifest) {
      // The honest check: LOAD the model and re-verify the pin rather than trusting the manifest.
      const loaded = await loadInstalledEmbedder(home);
      if (loaded) {
        return {
          ...report,
          tier: 'installed',
          embedderId: loaded.id,
          modelId: v.manifest.modelId,
          modelVersion: v.manifest.modelVersion,
          reason: `pinned on-device model ${v.manifest.modelId}@${v.manifest.modelVersion} loaded from the integrity-verified manifest (offline; no network at query time)`,
        };
      }
      report.problems = [...report.problems, 'manifest present but model failed to load'];
      report.integrityOk = false;
    }
  } catch (err) {
    // A drifted manifest formatVersion / unreadable manifest degrades the REPORT to fallback with
    // the problem attached — the doctor must render the failure, not die on it.
    report.problems = [...report.problems, err instanceof Error ? err.message : String(err)];
    report.integrityOk = report.manifestPresent ? false : undefined;
    report.manifestPresent = true;
  }

  if (externalOverride) {
    // Honest check, mirroring the installed tier: LOAD the provider rather than trusting the
    // variable. A configured-but-broken override is NOT a working embedder, and reporting it as one
    // would be the same fabrication the installed path is careful to avoid.
    const external = await loadExternalEmbedder(override);
    if (external.ok) {
      return {
        ...report,
        tier: 'external',
        embedderId: external.id,
        reason: `KCRIB_EMBEDDER="${override}" is active and loaded (id ${external.id}, dim ${external.dim}). Crib neither pins nor integrity-verifies an operator-supplied provider, so its retrieval quality is UNMEASURED here — the launch gates describe the pinned installed tier only.`,
      };
    }
    report.problems = [...report.problems, `KCRIB_EMBEDDER failed to load: ${external.error}`];
    report.reason = `KCRIB_EMBEDDER="${override}" is configured but did NOT load (${external.error}) — serving ${FALLBACK_NOTE}; ${INSTALL_HINT}`;
  } else if (report.problems.length > 0) {
    report.reason = `installed model FAILED verification — serving the fallback instead. ${FALLBACK_NOTE}. Fix the model dir and re-run "crib embed install"`;
  } else {
    report.reason = `no pinned on-device model installed; serving ${FALLBACK_NOTE}. ${INSTALL_HINT}`;
  }
  return report;
}
