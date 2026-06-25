/**
 * Shared CLI runtime: resolve a project root, locate `.crib`, open the SoulStore, and (re)build the
 * derived IndexStore from the soul. The index is always rebuilt from the committed soul so a
 * stale/gitignored index can never drift — the soul is the source of truth.
 *
 * Root resolution (REQ-1) is a priority chain so a single user-scoped IDE entry (`crib serve` with no
 * per-project arg) can serve every project:
 *
 *   1. explicit root — positional arg (not `.`) or `--cwd` flag
 *   2. `KCRIB_ROOT` env
 *   3. `CLAUDE_PROJECT_DIR` env (Claude Code's real workspace signal; its `cwd` field is ignored)
 *   4. upward walk from CWD for `.crib/crib.json` (handles monorepo subdirs)
 *   5. cwd fallback (preserves pre-REQ-1 behaviour)
 *
 * then the `~/.crib` registry is consulted as an **overlay**: a registered custom `cribDir` wins over
 * the standard `<root>/.crib`. Explicit args always win, so existing per-project IDE entries that
 * pass an explicit root keep working unchanged.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { SoulStore, openIndex } from '@knowledge-crib/core';
import type { IndexStore } from '@knowledge-crib/core';
import { type Registry, lookupProject, readRegistry } from './registry.js';

export interface Runtime {
  repoRoot: string;
  cribDir: string;
  soul: SoulStore;
}

export interface ResolvedRoot {
  /** Work-tree root — used for source-file reads + VCS adapters. */
  repoRoot: string;
  /** Where the soul lives — `<repoRoot>/.crib` by default, or a registered custom dir. */
  cribDir: string;
}

export interface ResolveOpts {
  /** Explicit root from a positional arg (not `.`) or the `--cwd` flag. */
  explicitRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Injectable registry; defaults to the real `~/.crib/registry.json`. */
  registry?: Registry;
}

/**
 * Resolve the project root + soul directory per the priority chain above. Never throws — a miss
 * returns `{ repoRoot: <candidate>, cribDir: <candidate>/.crib }` so the caller's `isIndexedRoot`
 * check produces the familiar "not indexed" error rather than a crash.
 */
export function resolveProjectRoot(opts: ResolveOpts): ResolvedRoot {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const registry = opts.registry ?? readRegistry(env);

  const hasCrib = (dir: string) => existsSync(join(dir, '.crib', 'crib.json'));

  // 1–3. explicit root: --cwd flag, positional arg (not "."), or env signals.
  let candidate: string | undefined;
  if (opts.explicitRoot) {
    candidate = resolve(cwd, opts.explicitRoot);
  } else if (env.KCRIB_ROOT) {
    candidate = resolve(cwd, env.KCRIB_ROOT);
  } else if (env.CLAUDE_PROJECT_DIR) {
    candidate = resolve(cwd, env.CLAUDE_PROJECT_DIR);
  }

  let repoRoot: string;
  if (candidate) {
    // Explicit/env: walk up only if the exact dir has no .crib (handles a subdir of a project).
    repoRoot = hasCrib(candidate) ? candidate : (walkUpForCrib(candidate) ?? candidate);
  } else {
    // 4–5. no signal: walk up from CWD, else fall back to CWD (pre-REQ-1 behaviour).
    repoRoot = walkUpForCrib(cwd) ?? cwd;
  }

  // Registry overlay: a registered custom cribDir wins, but only if it still exists on disk.
  const entry = lookupProject(repoRoot, env) ?? registry.projects[repoRoot];
  const cribDir = entry && existsSync(entry.cribDir) ? entry.cribDir : join(repoRoot, '.crib');

  return { repoRoot, cribDir };
}

/** Walk upward from `start` returning the first dir containing `.crib/crib.json`, else `undefined`. */
export function walkUpForCrib(start: string): string | undefined {
  let dir = resolve(start);
  // guard against a symlink/`..` loop: stop at the filesystem root.
  for (let i = 0; i < 128; i++) {
    if (existsSync(join(dir, '.crib', 'crib.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached root
    dir = parent;
  }
  return undefined;
}

/** Open the soul at `resolved.cribDir`. Does not build the index. */
export function openSoul(resolved: ResolvedRoot): Runtime {
  const soul = new SoulStore(resolved.cribDir);
  soul.load();
  return { repoRoot: resolved.repoRoot, cribDir: resolved.cribDir, soul };
}

/** True if the resolved soul has a manifest on disk. */
export function isIndexedRoot(resolved: ResolvedRoot): boolean {
  return existsSync(join(resolved.cribDir, 'crib.json'));
}

/** Back-compat shim: `isIndexed(repoRoot)` for callers that only know the work-tree root. */
export function isIndexed(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.crib', 'crib.json'));
}

/**
 * Build the IndexStore from the soul, persisting it to the manifest's declared index path.
 *
 * The manifest path (`.crib/index/crib.sqlite`) is **repo-root-relative** by convention. When
 * `cribDir === <repoRoot>/.crib` (the standard layout) it resolves against `repoRoot` as before.
 * When the registry has redirected `cribDir` to a custom location, the index lives *inside* that
 * `cribDir` (it's a derived artifact of the soul, so it travels with it) — the leading `.crib/` is
 * stripped so the path lands at `<cribDir>/index/crib.sqlite`. Absolute manifest paths are honored.
 */
export function buildIndex(rt: Runtime): IndexStore {
  const manifest = rt.soul.getManifest();
  const rel = manifest.stores.index.path; // e.g. .crib/index/crib.sqlite
  const path = resolveIndexPath(rel, rt.repoRoot, rt.cribDir);
  mkdirSync(dirname(path), { recursive: true });
  const index = openIndex(manifest.stores.index.backend, { path });
  index.buildFromSoul(rt.soul, { withEmbeddings: manifest.capabilities.embeddings });
  return index;
}

/**
 * Open the derived IndexStore WITHOUT rebuilding from the soul (M6 incremental path). Used by
 * `crib update`, which mutates the soul then applies an `IndexDelta` to the existing index. Throws if
 * no index exists yet (run `crib index` first).
 */
export function openIndexOnly(rt: Runtime): IndexStore {
  const manifest = rt.soul.getManifest();
  const rel = manifest.stores.index.path;
  const path = resolveIndexPath(rel, rt.repoRoot, rt.cribDir);
  if (!existsSync(path)) {
    throw new Error('index not built — run `crib index` first');
  }
  return openIndex(manifest.stores.index.backend, { path });
}

/** Resolve a manifest index path (repo-root-relative by convention) to an absolute on-disk path. */
function resolveIndexPath(rel: string, repoRoot: string, cribDir: string): string {
  if (isAbsolute(rel)) return rel;
  if (cribDir === join(repoRoot, '.crib')) return resolve(repoRoot, rel); // standard layout
  // Custom cribDir: the index is a derived artifact of the soul, so it lives inside cribDir.
  // The manifest convention prefixes `.crib/`; strip it so the path lands under cribDir.
  const stripped = rel.replace(/^\.crib\//, '');
  return resolve(cribDir, stripped);
}
