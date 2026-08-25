/**
 * Memory storage paths + repo-id resolution (PRD §2 storage layout).
 *
 * Three stores, three roots:
 *   - **team**   — committed + team-shared, inside the repo:    `<cribDir>/memory/team/…`
 *                  (+ the committed `policy.json` at `<cribDir>/memory/policy.json`).
 *   - **local**  — per-machine, per-repo, NOT committed:         `~/.crib/memory/repos/<repoId>/…`
 *   - **global** — per-machine, cross-repo, NOT committed:       `~/.crib/memory/global/…`
 *
 * Local + global live under `~/.crib` (NOT the repo `.crib`) on purpose: the repo `clean` / reindex
 * paths sweep `.crib`, and the registry — not the repo — supplies the stable `repoId` (PRD: "the
 * registry already supplies a stable repoId"). `KCRIB_MEMORY_DIR` relocates the whole `~/.crib/memory`
 * tree (parallel to `KCRIB_REGISTRY_DIR` for the registry) so the test suite can point at a tmpdir.
 *
 * `repoId` resolution (PRD: "from `manifest.repo.id` or registry"):
 *   1. read `<cribDir>/crib.json` → `.repo.id` (the soul manifest; same pattern as `cli.ts`
 *      `freshSoulForRebuild`); then
 *   2. fall back to `~/.crib/registry.json`, scanning for the entry whose `cribDir` matches.
 * The registry read is re-implemented inline (not imported from `@knowledge-crib/cli`) because `cli`
 * is the application leaf — a library may not depend on it. The shared `KCRIB_REGISTRY_DIR` override
 * convention is mirrored so tests relocate both consistently.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MANIFEST_FILE } from '@knowledge-crib/core';

/** `~/.crib/memory`, or `KCRIB_MEMORY_DIR` when set (tests relocate the whole tree). */
export function memoryHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KCRIB_MEMORY_DIR;
  return override ? resolve(override) : join(homedir(), '.crib', 'memory');
}

/** Local repo store root: `~/.crib/memory/repos/<repoId>`. */
export function localStoreRoot(repoId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(memoryHome(env), 'repos', repoId);
}

/** Global (cross-repo) store root: `~/.crib/memory/global`. */
export function globalStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(memoryHome(env), 'global');
}

/** The committed team-shared store root: `<cribDir>/memory/team`. */
export function teamStoreRoot(cribDir: string): string {
  return join(cribDir, 'memory', 'team');
}

/** The repo memory root (holds `policy.json` + `team/`): `<cribDir>/memory`. */
export function teamMemoryRoot(cribDir: string): string {
  return join(cribDir, 'memory');
}

/** The committed trusted-base policy file a `committed-policy` evidence item anchors: `<cribDir>/memory/policy.json`. */
export function policyPath(cribDir: string): string {
  return join(cribDir, 'memory', 'policy.json');
}

/** `~/.crib`, or `KCRIB_REGISTRY_DIR` when set (mirrors `cli/registry.ts`'s `registryDir`). */
function registryDir(env: NodeJS.ProcessEnv): string {
  const override = env.KCRIB_REGISTRY_DIR;
  return override ? resolve(override) : join(homedir(), '.crib');
}

interface RegistryEntry {
  repoId: string;
  cribDir: string;
}
interface RegistryShape {
  projects?: Record<string, RegistryEntry>;
}

/**
 * Scan `~/.crib/registry.json` for the project whose `cribDir` matches `cribDir` and return its
 * `repoId`. Returns `undefined` when the registry is absent, unparseable, or has no matching entry.
 * Paths are compared by `resolve()` so a trailing-slash / relative mismatch never blocks the match.
 */
function registryRepoIdForCribDir(cribDir: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = join(registryDir(env), 'registry.json');
  if (!existsSync(path)) return undefined;
  let parsed: RegistryShape;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as RegistryShape;
  } catch {
    return undefined;
  }
  const target = resolve(cribDir);
  const projects = parsed.projects ?? {};
  for (const key of Object.keys(projects)) {
    const entry = projects[key];
    if (entry && resolve(entry.cribDir) === target) return entry.repoId;
  }
  return undefined;
}

/**
 * Resolve the stable `repoId` for a crib dir: prefer the soul manifest's `repo.id`, fall back to the
 * registry. Returns `undefined` only when neither source has it (an unregistered, un-indexed repo —
 * the caller decides whether to synthesize a fresh id or refuse).
 */
export function readRepoId(
  cribDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const manifestPath = join(cribDir, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    try {
      const repoId = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { repo?: { id?: string } })
        .repo?.id;
      if (typeof repoId === 'string' && repoId.length > 0) return repoId;
    } catch {
      // corrupt manifest — fall through to the registry
    }
  }
  return registryRepoIdForCribDir(cribDir, env);
}
