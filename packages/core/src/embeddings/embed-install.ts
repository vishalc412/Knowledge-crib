/**
 * G3.2 — the pinned on-device embedder tier: install, integrity-verify, and load under
 * `~/.crib/embed/` (relocatable via `KCRIB_EMBED_HOME`).
 *
 * The tier contract (red line #3):
 *   - The model is acquired OUT-OF-BAND. Nothing here downloads anything — no network at install or
 *     query time, and no new runtime dependency (a per-platform model runtime would break the
 *     MAX_RUNTIME_DEPS=9 / MAX_PACKAGE_BYTES=5MB budget gates; real on-device model acquisition is
 *     therefore the OPERATOR step, pointed at a local model directory — see `installEmbedModel`
 *     below and the limitation stated in the G3.2 report).
 *   - The install is PINNED: the manifest records the model id + version + a sha256 + byte length
 *     for every file in the model dir. `loadInstalledEmbedder` re-verifies every hash before the
 *     module is imported — a tampered or half-copied model dir is refused, never served.
 *   - The loaded module must be a local file implementing the {@link Embedder} interface (default
 *     export: an instance, or a factory `(opts) => Embedder`) — the same trust level as the
 *     pre-existing `KCRIB_EMBEDDER` module hook: operator-installed code, executed locally,
 *     offline.
 *
 * WALL-CLOCK LAW: no Date.now()/new Date() anywhere here — the manifest is content-addressed
 * bookkeeping (hashes), and `installedAt` is an OPTIONAL display field the caller supplies; this
 * module never reads the clock itself.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Embedder, EmbedderOptions } from './types.js';
import { DEFAULT_DIM } from './types.js';

/** Bump on any change to the manifest contract — a mismatch makes the install invalid (fail closed). */
export const EMBED_MANIFEST_FORMAT_VERSION = 1;

/** One integrity-checked file of the installed model, relative to the model dir (POSIX separators). */
export interface EmbedModelFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * The install manifest — the pin. Written by {@link installEmbedModel}, read + hash-verified by
 * {@link verifyInstalledEmbed} / {@link loadInstalledEmbedder}. Deliberately carries NO wall-clock
 * field the loader depends on (`installedAt` is optional, display-only, caller-supplied).
 */
export interface EmbedManifest {
  formatVersion: number;
  /** The id the loaded Embedder reports — the id that flows into scorer version ids (red line #6). */
  embedderId: string;
  /** The pinned model identity the operator installed. */
  modelId: string;
  modelVersion: string;
  /** Fixed vector dimensionality (re-checked against the loaded instance on every load). */
  dim: number;
  /** Absolute model directory this install was made from (files are verified relative to it). */
  modelDir: string;
  /** The JS entry module, relative to `modelDir`, whose default export is the Embedder. */
  entry: string;
  files: EmbedModelFileEntry[];
  /** Display-only; supplied by the CLI caller. The pure module never reads the clock. */
  installedAt?: string;
}

/** Install/manifest errors — messages name the remediation so doctor/CLI can echo them verbatim. */
export class EmbedManifestError extends Error {}
export class EmbedModelNotInstalledError extends Error {
  constructor(home: string) {
    super(
      `no installed embed model under ${home} — run "crib embed install" (char-ngram remains the degraded offline fallback until then)`,
    );
  }
}
export class EmbedIntegrityError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`installed embed model failed integrity verification:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** The embed home: `KCRIB_EMBED_HOME` override, else `~/.crib/embed` (tests relocate via the env). */
export function embedHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KCRIB_EMBED_HOME ?? join(homedir(), '.crib', 'embed');
}

/** The manifest location inside the embed home. */
export function embedManifestPath(home: string = embedHomeDir()): string {
  return join(home, 'manifest.json');
}

// ─── hashing ─────────────────────────────────────────────────────────────────

const HASH_CHUNK = 1 << 20; // 1 MiB — models are large; never buffer a whole model for its hash.

/** sha256 of a file, streamed in chunks (a model binary can be far larger than memory should hold). */
function sha256File(path: string): { sha256: string; bytes: number } {
  const fd = openSync(path, 'r');
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(HASH_CHUNK);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, HASH_CHUNK, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      total += n;
    }
    return { sha256: hash.digest('hex'), bytes: total };
  } finally {
    closeSync(fd);
  }
}

// ─── module loading (the one audited import path for embedder modules) ───────

/**
 * Load an Embedder from a local JS module: the default export must be an Embedder instance, or a
 * factory `(opts) => Embedder`. Exported so `provider.ts` (the `KCRIB_EMBEDDER` hook) and
 * `remote.ts` (the policy-gated remote tier) load through ONE validated path instead of two
 * drifting ones. Throws {@link EmbedManifestError} when the module has no usable default export.
 */
/** The Embedder surface check shared by the direct-export and factory branches of the loader. */
function assertEmbedderSurface(ex: unknown, modulePath: string): void {
  const e = ex as Partial<Embedder> | undefined;
  if (
    e === undefined ||
    typeof e !== 'object' ||
    typeof e.id !== 'string' ||
    typeof e.dim !== 'function' ||
    typeof e.embed !== 'function' ||
    typeof e.embedBatch !== 'function'
  ) {
    throw new EmbedManifestError(`module "${modulePath}" has no default Embedder export`);
  }
}

export async function loadEmbedderFromModule(
  modulePath: string,
  opts: EmbedderOptions = {},
): Promise<Embedder> {
  const url = pathToFileURL(modulePath).href;
  // NOTE: under vitest the tmpdir must be allow-listed in server.fs (packages/core/vitest.config.ts)
  // or this native import of an out-of-root file:// URL fails with a misleading "Does the file exist?".
  const mod = (await import(url)) as {
    default?: Embedder | ((opts: EmbedderOptions) => Embedder);
  };
  const ex = mod.default;
  if (ex === undefined) {
    throw new EmbedManifestError(`module "${modulePath}" has no default Embedder export`);
  }
  // Fail closed BEFORE the caller touches the embedder: an object without the full Embedder
  // surface (id/dim/embed/embedBatch) must be an EmbedManifestError at load time, never a
  // TypeError deep in a later call (the install then leaves no manifest).
  if (typeof ex === 'function') {
    const instance = ex({ ...opts, dim: opts.dim ?? DEFAULT_DIM });
    assertEmbedderSurface(instance, modulePath);
    return instance;
  }
  assertEmbedderSurface(ex, modulePath);
  return ex;
}

// ─── install ─────────────────────────────────────────────────────────────────

/** Recursively list files under `root` as POSIX-relative paths, refusing anything that escapes it. */
function listModelFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(root, full).split(sep).join('/');
      // Path-escape guard: a symlinked entry that resolves outside the model dir must never be
      // pinned (the manifest would bless a file the operator did not install).
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new EmbedManifestError(`model file "${full}" escapes the model directory`);
      }
      out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

export interface InstallEmbedModelOptions {
  /** The operator-supplied local model directory (the out-of-band acquisition lands here). */
  modelDir: string;
  modelId: string;
  modelVersion: string;
  /** JS module inside `modelDir` whose default export is the Embedder. Default: `embedder.mjs`. */
  entry?: string;
  /** Optional display timestamp (caller-supplied; this module never reads the clock). */
  installedAt?: string;
  /** Where to write the manifest. Default {@link embedHomeDir}. */
  home?: string;
}

/**
 * Validate a local model dir and pin it: load the entry module, check it implements
 * {@link Embedder}, hash every file, and atomically write the manifest into the embed home.
 * The install FAILS CLOSED — an unusable model dir leaves no manifest, so the fallback tier stays
 * active rather than a broken install silently degrading recall.
 */
export async function installEmbedModel(opts: InstallEmbedModelOptions): Promise<EmbedManifest> {
  const entry = opts.entry ?? 'embedder.mjs';
  const entryRel = entry.split(sep).join('/');
  const modelDir = opts.modelDir;
  if (!existsSync(modelDir) || !statSync(modelDir).isDirectory()) {
    throw new EmbedManifestError(`model directory "${modelDir}" does not exist`);
  }
  const entryPath = join(modelDir, entry);
  if (!existsSync(entryPath)) {
    throw new EmbedManifestError(`model dir has no entry module "${entry}"`);
  }
  // Validate the Embedder surface BEFORE pinning — an install that cannot load must not exist.
  const embedder = await loadEmbedderFromModule(entryPath);
  const files: EmbedModelFileEntry[] = listModelFiles(modelDir).map((rel) => {
    const { sha256, bytes } = sha256File(join(modelDir, rel));
    return { path: rel, sha256, bytes };
  });
  if (!files.some((f) => f.path === entryRel)) {
    throw new EmbedManifestError(`entry module "${entry}" was not hashed — install refused`);
  }
  const manifest: EmbedManifest = {
    formatVersion: EMBED_MANIFEST_FORMAT_VERSION,
    embedderId: embedder.id,
    modelId: opts.modelId,
    modelVersion: opts.modelVersion,
    dim: embedder.dim(),
    modelDir,
    entry: entryRel,
    files,
    ...(opts.installedAt ? { installedAt: opts.installedAt } : {}),
  };
  const home = opts.home ?? embedHomeDir();
  mkdirSync(home, { recursive: true });
  // Atomic temp→rename (the store's discipline): a crashed install leaves either the old manifest
  // or the new one, never a truncated one.
  const target = embedManifestPath(home);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return manifest;
}

// ─── verify + load ───────────────────────────────────────────────────────────

export interface EmbedVerification {
  present: boolean;
  ok: boolean;
  manifest?: EmbedManifest;
  problems: string[];
}

/** Read the manifest without integrity checks (undefined = no install). Throws on format drift. */
export function readEmbedManifest(home: string = embedHomeDir()): EmbedManifest | undefined {
  const p = embedManifestPath(home);
  if (!existsSync(p)) return undefined;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as EmbedManifest;
  if (raw.formatVersion !== EMBED_MANIFEST_FORMAT_VERSION) {
    throw new EmbedManifestError(
      `embed manifest formatVersion ${raw.formatVersion} != ${EMBED_MANIFEST_FORMAT_VERSION} — reinstall via "crib embed install"`,
    );
  }
  return raw;
}

/**
 * Hash-verify every manifest file against the model dir. A tampered, truncated, or moved model dir
 * fails here — and since {@link loadInstalledEmbedder} calls this first, an unverified model is
 * never imported, let alone served.
 */
export function verifyInstalledEmbed(home: string = embedHomeDir()): EmbedVerification {
  let manifest: EmbedManifest;
  try {
    const m = readEmbedManifest(home);
    if (!m) return { present: false, ok: false, problems: [] };
    manifest = m;
  } catch (err) {
    // A malformed manifest is itself an integrity failure — fail closed with the reason attached.
    return {
      present: true,
      ok: false,
      problems: [err instanceof Error ? err.message : String(err)],
    };
  }
  const problems: string[] = [];
  if (!manifest.modelDir || !existsSync(manifest.modelDir)) {
    problems.push(`model dir "${manifest.modelDir}" is missing`);
  } else {
    for (const f of manifest.files) {
      const full = join(manifest.modelDir, f.path);
      if (!existsSync(full)) {
        problems.push(`missing file ${f.path}`);
        continue;
      }
      const { sha256, bytes } = sha256File(full);
      if (bytes !== f.bytes) problems.push(`size drift ${f.path}: ${bytes} != ${f.bytes}`);
      if (sha256 !== f.sha256) problems.push(`hash drift ${f.path}: content changed since install`);
    }
  }
  return { present: true, ok: problems.length === 0, manifest, problems };
}

/**
 * Load the installed embedder: verify integrity FIRST, then import the entry module, then re-check
 * the instance's id + dim against the pin. Returns `undefined` when nothing is installed (the
 * caller decides whether to fall back to char-ngram); throws {@link EmbedIntegrityError} on any
 * drift. OFFLINE by construction — the only IO is local file reads.
 */
export async function loadInstalledEmbedder(
  home: string = embedHomeDir(),
): Promise<Embedder | undefined> {
  const v = verifyInstalledEmbed(home);
  if (!v.present) return undefined;
  if (!v.ok || !v.manifest) throw new EmbedIntegrityError(v.problems);
  const manifest = v.manifest;
  const embedder = await loadEmbedderFromModule(join(manifest.modelDir, manifest.entry));
  // Re-check the pin AFTER import: a model dir whose module reports a different id/dim than the
  // manifest is not the model that was installed — refuse rather than silently mis-score.
  if (embedder.id !== manifest.embedderId) {
    throw new EmbedIntegrityError([
      `loaded embedder id "${embedder.id}" != pinned "${manifest.embedderId}"`,
    ]);
  }
  if (embedder.dim() !== manifest.dim) {
    throw new EmbedIntegrityError([
      `loaded embedder dim ${embedder.dim()} != pinned ${manifest.dim}`,
    ]);
  }
  return embedder;
}
