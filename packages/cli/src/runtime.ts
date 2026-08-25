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
 * Wrong-project guard: a walk-up that lands on an ANCESTOR's `.crib` serves that ancestor's soul —
 * silently, unless this layer says so. (Measured incident: `crib serve` run against a repo whose
 * `.crib/crib.json` was missing fell through to ~/Documents/.crib and served a stray 366-node soul
 * to a swarm gate, which then scored 0/400 while looking healthy.) Two mechanisms, one per hazard:
 *
 *   - DAMAGED INDEX → hard refusal. A dir that HAS a `.crib` directory but no `crib.json` was
 *     indexed and lost its manifest; an ancestor's soul is never an acceptable substitute, so
 *     resolution stops there regardless of how the root was signaled (explicit, env, or CWD) and
 *     logs the repair command. Callers then hit their `isIndexedRoot` guard as usual. Bonus: this
 *     also stops `crib index <dir>` from reindexing the wrong (ancestor) tree — resolution targets
 *     the dir, which is exactly the repair.
 *   - NO `.crib` AT ALL → lenient walk-up, but loud. A monorepo subdir legitimately falls through
 *     to the indexed project root (pinned by resolution.test.ts), so refusal there would break real
 *     usage; instead, an explicitly-signaled root that falls through logs WHICH ancestor's project
 *     is being served. The pure CWD-discovery walk-up (monorepo normal case) stays silent.
 *
 * then the `~/.crib` registry is consulted as an **overlay**: a registered custom `cribDir` wins over
 * the standard `<root>/.crib`. Explicit args always win, so existing per-project IDE entries that
 * pass an explicit root keep working unchanged.
 */
import { randomUUID } from 'node:crypto';
import {
  type Stats,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
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
      repoRoot = hasCrib(candidate)
        ? candidate
        : resolveUnindexedDir(candidate, { logFallThrough: true });
      projectKey = repoRoot;
      entry = lookupProject(projectKey, env) ?? registry.projects[projectKey];
    }
  } else {
    // 4–5. no signal: walk up from CWD, else fall back to CWD (pre-REQ-1 behaviour). The
    // wrong-project guard still applies (a damaged CWD index never serves an ancestor), but a
    // healthy subdir walk-up is the normal monorepo case, so its fall-through stays silent.
    repoRoot = resolveUnindexedDir(cwd, { logFallThrough: false });
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

/** True when `dir` has a `.crib` directory but no committed manifest — was indexed, lost its soul. */
function hasDamagedCrib(dir: string): boolean {
  return existsSync(join(dir, '.crib')) && !existsSync(join(dir, '.crib', 'crib.json'));
}

/**
 * The wrong-project guard (see module doc): decide what an UNINDEXED dir resolves to.
 *
 * A dir with a DAMAGED `.crib` (dir exists, manifest gone) refuses to fall through — serving an
 * ancestor's soul then is always wrong-project, and `crib index <dir>` is the repair. The caller's
 * own `isIndexedRoot` check then produces the standard not-indexed error on top of the loud line
 * here. A dir with NO `.crib` walks up as before (monorepo subdirs); when `logFallThrough`, an
 * ancestor hit is announced so an explicitly-signaled root never silently serves another project.
 */
function resolveUnindexedDir(dir: string, opts: { logFallThrough: boolean }): string {
  if (hasDamagedCrib(dir)) {
    process.stderr.write(
      `not indexed: ${join(dir, '.crib')} exists but crib.json is missing — the index is damaged; ` +
        `refusing to serve an ancestor project. Repair with \`crib index ${dir}\`\n`,
    );
    return dir;
  }
  const ancestor = walkUpForCrib(dir);
  if (ancestor === undefined || ancestor === dir) return dir;
  if (opts.logFallThrough) {
    process.stderr.write(
      `warning: ${dir} is not indexed — serving the ancestor project at ${ancestor}. ` +
        `To index this directory instead, run \`crib index ${dir}\`\n`,
    );
  }
  return ancestor;
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
    sweepStaleBuilds(dirname(path));
    const tmp = join(dirname(path), `.crib-build-${process.pid}-${randomUUID()}.sqlite`);
    // A `catch` only covers *thrown* errors. A build interrupted by Ctrl-C (SIGINT) or a `kill`
    // unwinds no stack, so without these handlers the partial sqlite plus its uncheckpointed WAL
    // (tens of MB) are simply abandoned — the mechanism that accumulated 510 MB of
    // `.crib-build-*` files in this repo. Handlers are removed in `finally` so repeated builds in
    // one process (tests, `crib serve` self-heal) never stack listeners.
    const cleanup = (): void => removeBuildArtifacts(tmp);
    const onSignal = (sig: NodeJS.Signals) => () => {
      cleanup();
      process.removeAllListeners(sig);
      process.kill(process.pid, sig); // re-raise so the default disposition still applies
    };
    const onSigint = onSignal('SIGINT');
    const onSigterm = onSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    // No `uncaughtException` handler — deliberately. Every statement between registration and the
    // `finally` below is synchronous: `openIndex` is a sync factory, `buildFromSoul` is declared
    // `void` (its sqlite transaction runs in one JS stack, and `Embedder.embed` is sync by type —
    // async provider resolution happens in the caller, per the SqliteIndexStore docstring), and the
    // commit is `rmSync`/`renameSync`. The event loop therefore never yields inside this window, and
    // `uncaughtException` is only deliverable at a yield point — an error from a pending timer or
    // watcher callback queues until this task completes, by which time a handler here would already
    // be removed. It could never fire, so registering one would be dead code. Signals differ —
    // Ctrl-C arrives mid-build from OUTSIDE the loop and is delivered between the discrete native
    // sqlite statements (the 510 MB leak mode), so the SIGINT/SIGTERM handlers stay. The
    // `buildIndex is fully synchronous…` test in runtime.test.ts fails if an `await` is ever
    // introduced into this window — at which point an uncaughtException handler (and
    // `unhandledRejection`) becomes mandatory alongside the signals.
    try {
      const index = openIndex(manifest.stores.index.backend, { path: tmp });
      index.buildFromSoul(rt.soul, rt.repoRoot);
      index.close();
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      renameSync(tmp, path);
      return openIndex(manifest.stores.index.backend, { path });
    } catch (e) {
      cleanup();
      throw e;
    } finally {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }
  const index = openIndex(manifest.stores.index.backend, { path });
  // The derived index is fully determined by the soul + repoRoot (FTS5 + adjacency + rehydrated
  // body text); no vector/embedding build options exist today. `manifest.capabilities.embeddings`
  // is a capability record (always false until a vector backend ships) and does not drive the build.
  index.buildFromSoul(rt.soul, rt.repoRoot);
  return index;
}

/** Remove a temp build sqlite together with its `-wal` / `-shm` sidecars. */
function removeBuildArtifacts(tmp: string): void {
  rmSync(tmp, { force: true });
  rmSync(`${tmp}-wal`, { force: true });
  rmSync(`${tmp}-shm`, { force: true });
}

/** How old an abandoned `.crib-build-*` must be before the sweep reclaims it. Comfortably longer
 *  than any real build, so a concurrent writer's in-progress temp file is never deleted. */
const STALE_BUILD_MS = 60 * 60 * 1000;

/**
 * Reclaim `.crib-build-*` temp databases abandoned by earlier interrupted builds.
 *
 * Signal handlers stop *new* leaks; this clears the backlog already on disk (and anything a
 * SIGKILL — which cannot be trapped — leaves behind). Age-gated so a build running concurrently in
 * another process is never touched, and fully best-effort: a sweep failure must never block an
 * index build.
 */
export function sweepStaleBuilds(indexDir: string, now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(indexDir)) {
      if (!name.startsWith('.crib-build-') || !name.endsWith('.sqlite')) continue;
      const full = join(indexDir, name);
      try {
        if (now - statSync(full).mtimeMs < STALE_BUILD_MS) continue;
        removeBuildArtifacts(full);
        removed++;
      } catch {
        // Racing with another sweep, or a permissions problem — skip this entry.
      }
    }
  } catch {
    // Index dir unreadable/absent: nothing to sweep.
  }
  return removed;
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
