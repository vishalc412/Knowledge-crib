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
import { randomUUID } from 'node:crypto';
import { type Stats, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MANIFEST_FILE, SoulStore, graphPaths, openIndex } from '@knowledge-crib/core';
import type { IndexStore } from '@knowledge-crib/core';
import { type Registry, lookupProject, readRegistry } from './registry.js';

export interface Runtime {
  repoRoot: string;
  cribDir: string;
  soul: SoulStore;
}

export interface ResolvedRoot {
  /**
   * The canonical registry key for this input: the absolute path the user pointed at (a directory OR
   * an archive file). For directories this equals `repoRoot`; for archives it is the `.zip`/`.jar`
   * path while `repoRoot` is the extracted cache tree. The registry is keyed by this, not `repo.id`.
   */
  projectKey: string;
  /** Work-tree root — used for source-file reads + VCS adapters. For archives this is the extracted
   *  cache tree (registered `sourceRoot`), so read-only commands resolve without re-extracting. */
  repoRoot: string;
  /** Where the soul lives — `<repoRoot>/.crib` by default, or a registered custom dir. */
  cribDir: string;
  /** Original archive path, when this project was indexed from an archive (registry overlay). */
  sourceArchive?: string;
  /** SHA-256 of archive bytes at index time (registry overlay), for archive change detection. */
  sourceFingerprint?: string;
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
 * returns `{ projectKey: <candidate>, repoRoot: <candidate>, cribDir: <candidate>/.crib }` so the
 * caller's `isIndexedRoot` check produces the familiar "not indexed" error rather than a crash.
 *
 * Archive inputs (a `.zip`/`.jar` FILE) are a distinct resolution shape: the `projectKey` is the
 * archive path (the registry key), while `repoRoot` is the registered `sourceRoot` (the extracted
 * cache tree) when the archive was previously indexed, or the archive path itself on a first index
 * (the indexing command then calls `prepareSourceInput` to extract + override `repoRoot`). Directory
 * inputs keep `projectKey === repoRoot` exactly as before, so every existing call site is unchanged.
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

  // Look up the registry entry for the candidate key FIRST. A registered archive (entry with
  // sourceArchive) is the authority: its extracted cache tree + its .crib were created at index
  // time, so resolve straight to them — no stat, no existsSync guard (the archive file need not be
  // present for read-only resolution; cmdIndex re-prepares if a refresh is needed). This also keeps
  // resolution cheap and avoids walking up from an archive path (which would find an unrelated
  // ancestor .crib). Directory inputs keep `projectKey === repoRoot`.
  if (candidate) {
    const entry = lookupProject(candidate, env) ?? registry.projects[candidate];
    if (entry?.sourceArchive !== undefined) {
      return {
        projectKey: candidate,
        repoRoot: entry.sourceRoot ?? candidate,
        cribDir: entry.cribDir,
        sourceArchive: entry.sourceArchive,
        ...(entry.sourceFingerprint !== undefined
          ? { sourceFingerprint: entry.sourceFingerprint }
          : {}),
      };
    }
  }

  let projectKey: string;
  let repoRoot: string;
  let entry: ReturnType<typeof lookupProject>;
  if (candidate) {
    // A fresh (unregistered) archive input is a FILE: its projectKey is the file path; do NOT walk up
    // from a file (that would find an unrelated ancestor .crib). repoRoot is the archive path itself
    // here; cmdIndex overrides it via prepareSourceInput to the extracted cache tree. A directory
    // input walks up to its .crib as before.
    let st: Stats | undefined;
    try {
      st = statSync(candidate);
    } catch {
      st = undefined;
    }
    if (st?.isFile()) {
      projectKey = candidate;
      repoRoot = candidate;
      entry = lookupProject(projectKey, env) ?? registry.projects[projectKey];
    } else {
      repoRoot = hasCrib(candidate) ? candidate : (walkUpForCrib(candidate) ?? candidate);
      projectKey = repoRoot;
      entry = lookupProject(projectKey, env) ?? registry.projects[projectKey];
    }
  } else {
    // 4–5. no signal: walk up from CWD, else fall back to CWD (pre-REQ-1 behaviour).
    repoRoot = walkUpForCrib(cwd) ?? cwd;
    projectKey = repoRoot;
    entry = lookupProject(projectKey, env) ?? registry.projects[projectKey];
  }

  // Registry overlay: a registered custom cribDir wins, but only if it still exists on disk.
  const cribDir = entry && existsSync(entry.cribDir) ? entry.cribDir : join(repoRoot, '.crib');

  return {
    projectKey,
    repoRoot,
    cribDir,
    ...(entry?.sourceArchive !== undefined ? { sourceArchive: entry.sourceArchive } : {}),
    ...(entry?.sourceFingerprint !== undefined
      ? { sourceFingerprint: entry.sourceFingerprint }
      : {}),
  };
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
  if (manifest.stores.index.backend === 'sqlite') {
    const tmp = join(dirname(path), `.crib-build-${process.pid}-${randomUUID()}.sqlite`);
    try {
      const index = openIndex(manifest.stores.index.backend, { path: tmp });
      index.buildFromSoul(rt.soul, rt.repoRoot);
      index.close();
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      renameSync(tmp, path);
      return openIndex(manifest.stores.index.backend, { path });
    } catch (e) {
      rmSync(tmp, { force: true });
      rmSync(`${tmp}-wal`, { force: true });
      rmSync(`${tmp}-shm`, { force: true });
      throw e;
    }
  }
  const index = openIndex(manifest.stores.index.backend, { path });
  // The derived index is fully determined by the soul + repoRoot (FTS5 + adjacency + rehydrated
  // body text); no vector/embedding build options exist today. `manifest.capabilities.embeddings`
  // is a capability record (always false until a vector backend ships) and does not drive the build.
  index.buildFromSoul(rt.soul, rt.repoRoot);
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
    throw new Error('derived index missing or stale — run `crib index .`');
  }
  const canonicalManifest = graphPaths(rt.cribDir).manifest;
  const manifestPath = existsSync(canonicalManifest)
    ? canonicalManifest
    : join(rt.cribDir, MANIFEST_FILE);
  if (existsSync(manifestPath) && statSync(path).mtimeMs + 1 < statSync(manifestPath).mtimeMs) {
    throw new Error('derived index missing or stale — run `crib index .`');
  }
  return openIndex(manifest.stores.index.backend, { path });
}

/**
 * Open the derived index for `crib serve`. The MCP stdio server must NEVER drop the transport on a
 * stale/missing derived index — that surfaces to the IDE as `MCP error -32000: Connection closed`,
 * because the serve process exits and the stdio pipe dies. So this is deliberately more forgiving
 * than {@link openIndexOnly}:
 *
 *   - fresh index → open it (same mtime guard as `openIndexOnly`).
 *   - stale-but-present (the canonical manifest advanced past the sqlite — e.g. an external
 *     `crib update`/enrich bumped the soul after the index was built) → open the existing sqlite
 *     ANYWAY and log a one-line warning. A slightly-behind index is internally consistent (it was
 *     built from a valid earlier soul) and far better than a dead transport; the IDE stays usable
 *     while an explicit `crib index .` refreshes it.
 *   - missing entirely → throw `'derived index missing'` so the caller can rebuild from the
 *     committed soul (self-heal) instead of exiting.
 *
 * Never returns null for a present index. Throws only on a truly missing (or unreadable) sqlite.
 */
export function openIndexForServe(rt: Runtime): IndexStore {
  const manifest = rt.soul.getManifest();
  const rel = manifest.stores.index.path;
  const path = resolveIndexPath(rel, rt.repoRoot, rt.cribDir);
  if (!existsSync(path)) {
    throw new Error('derived index missing');
  }
  const canonicalManifest = graphPaths(rt.cribDir).manifest;
  const manifestPath = existsSync(canonicalManifest)
    ? canonicalManifest
    : join(rt.cribDir, MANIFEST_FILE);
  if (existsSync(manifestPath) && statSync(path).mtimeMs + 1 < statSync(manifestPath).mtimeMs) {
    process.stderr.write(
      'warning: derived index stale (soul advanced) — serving existing index; run `crib index .` to refresh\n',
    );
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
