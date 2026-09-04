/**
 * Embedder provider resolution (M2.1).
 *
 * Resolution order: explicit `opts.provider` → env `KCRIB_EMBEDDER` → `'char-ngram'` default.
 *
 * Recognized id forms:
 *   - `undefined` / `'char-ngram'` / `'builtin:char-ngram'` → the pure-JS offline default (the
 *     DEGRADED FALLBACK tier — see char-ngram.ts).
 *   - `'installed'` / `'builtin:installed'` → the pinned on-device model from the integrity-verified
 *     manifest under `~/.crib/embed/` (G3.2, `embed-install.ts`). Throws
 *     {@link EmbedModelNotInstalledError} when no model is installed — an explicitly chosen tier
 *     fails loudly rather than silently degrading; callers that want graceful degradation use
 *     `embedTierReport` / `loadInstalledEmbedder` directly.
 *   - `'<module-path>'` (e.g. `./my-embedder.mjs` or a package name) → dynamically imported; the
 *     module's default export must be an Embedder instance or a factory `(opts) => Embedder`.
 *     NOTE: this is the LOCAL pluggable hook. Remote (data-egress) embedders are NOT reachable
 *     through it — they go through `remote.ts`'s policy-gated `resolveRemoteEmbedder`, disabled
 *     until the operator acknowledges the data policy.
 *
 *
 * The default char-n-gram path is the only one the deterministic build exercises; external module
 * paths are the pluggable-provider hook the plan calls for and stay opt-in. Vectors produced by an
 * external provider feed ONLY the gitignored derived vector table — never the committed soul — so
 * `--extracted-only` stays byte-identical regardless of which provider is active.
 */
import { CharNgramEmbedder } from './char-ngram.js';
import {
  EmbedModelNotInstalledError,
  embedHomeDir,
  loadInstalledEmbedder,
} from './embed-install.js';
import type { Embedder, EmbedderOptions } from './types.js';
import { DEFAULT_DIM } from './types.js';

const BUILTIN = /^builtin:char-ngram$/;
const CHAR_NGRAM = /^char-ngram$/;
const INSTALLED = /^builtin:installed$/;

/** Resolve an Embedder per the resolution order above. Throws on a module path that fails to load. */
export async function resolveEmbedder(opts: EmbedderOptions = {}): Promise<Embedder> {
  const id = opts.provider ?? process.env.KCRIB_EMBEDDER ?? 'char-ngram';
  if (id === 'char-ngram' || BUILTIN.test(id)) {
    return new CharNgramEmbedder({ dim: opts.dim, minN: opts.minN, maxN: opts.maxN });
  }
  if (id === 'installed' || INSTALLED.test(id)) {
    const loaded = await loadInstalledEmbedder(embedHomeDir());
    if (!loaded) throw new EmbedModelNotInstalledError(embedHomeDir());
    return loaded;
  }
  // external module path — pluggable provider hook.
  const mod = (await import(id)) as {
    default?: Embedder | ((opts: EmbedderOptions) => Embedder);
  };
  const ex = mod.default;
  if (ex === undefined) {
    throw new Error(`KCRIB_EMBEDDER module "${id}" has no default Embedder export`);
  }
  if (typeof ex === 'function') return ex({ ...opts, dim: opts.dim ?? DEFAULT_DIM });
  return ex;
}

/** True iff the active provider would be the pure-JS offline default (no module load attempted). */
export function isDefaultProvider(opts: EmbedderOptions = {}): boolean {
  const id = opts.provider ?? process.env.KCRIB_EMBEDDER ?? 'char-ngram';
  return CHAR_NGRAM.test(id) || BUILTIN.test(id);
}
