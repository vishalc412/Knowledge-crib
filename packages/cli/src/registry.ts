/**
 * `~/.crib/registry.json` — the local project dispatch table (REQ-1).
 *
 * The registry is a **pointer layer, not a second store**. The soul (chunked JSONL + manifest) stays
 * committed inside each project's `.crib/` and remains team-shared; `~/.crib/registry.json` only maps
 * an absolute project path → the `.crib` directory that holds its soul. This lets `crib serve`
 * resolve the correct soul for a workspace without a per-project IDE config entry.
 *
 * Resolution priority (see `resolveProjectRoot` in `runtime.ts`) is **explicit arg → `KCRIB_ROOT` →
 * `CLAUDE_PROJECT_DIR` → upward walk from CWD → cwd fallback**. The registry is an **overlay** consulted
 * after a root is discovered: if that root is registered with a custom `cribDir`, the soul is opened
 * from there; otherwise the standard `<root>/.crib` is used. So the registry's load-bearing value is
 * (a) custom `.crib` locations and (b) an enumerable "known projects" list (`crib mcp list`,
 * `crib status`). The env-var + upward-walk carries the actual root resolution.
 *
 * Keyed by **absolute project path** (not `repo.id`): `repo.id` is a `randomUUID()` persisted *inside*
 * `.crib/crib.json`, so reading it requires locating `.crib` first — a chicken-and-egg. `repo.id` is
 * stored as a validation tag only. The registry is therefore machine-specific (absolute paths); the
 * soul itself stays portable/committed.
 *
 * Test override: set `KCRIB_REGISTRY_DIR=<dir>` to relocate the registry file (used by the test suite
 * to point at a tmpdir instead of `~/.crib`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = 'registry.json';

export interface RegisteredProject {
  /** `repo.id` from `.crib/crib.json` — validation tag only, never the resolution key. */
  repoId: string;
  /** Absolute path to the `.crib` directory holding this project's soul. */
  cribDir: string;
  /** Last-known VCS head (optional, informational). */
  vcsHead?: string;
  /** ISO timestamp the project was first registered. */
  addedAt: string;
  /**
   * Absolute path of the tree the pipeline `discover()`s against, when it differs from the registry
   * key. Directories leave this unset (their key IS the source tree); archive inputs point this at the
   * extracted cache tree (`~/.crib/imports/<hash>/source`) so read-only commands resolve the soul
   * without re-extracting.
   */
  sourceRoot?: string;
  /** The original archive path (`.zip`/`.jar`), when the project was indexed from an archive. */
  sourceArchive?: string;
  /** SHA-256 of the archive bytes at index time, for `crib update` change detection on archives. */
  sourceFingerprint?: string;
  /**
   * G3.4 freshness mode for this project (`manual` | `watch` | `auto`). ADDITIVE and OPTIONAL: an
   * unset field means `manual` (the zero-cost default — `watch` is never a persisted default, and
   * `auto` is opt-in because it starts a durable background worker). Parsed/validated by
   * `resolveFreshnessMode` in `freshness.ts`; stored here as the raw literal so an old registry
   * JSON without the field still resolves unchanged.
   */
  freshnessMode?: 'manual' | 'watch' | 'auto';
}

export interface Registry {
  version: number;
  /** Keyed by absolute project path. */
  projects: Record<string, RegisteredProject>;
}

/** Directory holding the registry file. `KCRIB_REGISTRY_DIR` overrides `~/.crib` (for tests). */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KCRIB_REGISTRY_DIR;
  return override ? resolve(override) : join(homedir(), '.crib');
}

/** Absolute path to `registry.json`. */
export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(registryDir(env), REGISTRY_FILE);
}

/** Read the registry, returning an empty one if the file is absent or unparseable. */
export function readRegistry(env: NodeJS.ProcessEnv = process.env): Registry {
  const path = registryPath(env);
  if (!existsSync(path)) return { version: REGISTRY_VERSION, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Registry>;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : REGISTRY_VERSION,
      projects: parsed.projects ?? {},
    };
  } catch {
    return { version: REGISTRY_VERSION, projects: {} };
  }
}

/** Atomic write of the registry (temp→rename); creates the parent dir. */
export function writeRegistry(reg: Registry, env: NodeJS.ProcessEnv = process.env): void {
  const path = registryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Look up a project by absolute root path. */
export function lookupProject(
  absRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): RegisteredProject | undefined {
  return readRegistry(env).projects[absRoot];
}

/** All registered projects as `[absRoot, entry]` pairs. */
export function listProjects(
  env: NodeJS.ProcessEnv = process.env,
): Array<[string, RegisteredProject]> {
  return Object.entries(readRegistry(env).projects);
}

export interface RegisterOpts {
  repoId: string;
  cribDir: string;
  vcsHead?: string;
  /** Fixed timestamp for deterministic tests; defaults to now. */
  addedAt?: string;
  /** Extracted source tree for archive inputs (see {@link RegisteredProject.sourceRoot}). */
  sourceRoot?: string;
  /** Original archive path for archive inputs. */
  sourceArchive?: string;
  /** SHA-256 of archive bytes for archive inputs. */
  sourceFingerprint?: string;
  /** G3.4 freshness mode (see {@link RegisteredProject.freshnessMode}). */
  freshnessMode?: 'manual' | 'watch' | 'auto';
  env?: NodeJS.ProcessEnv;
}

/**
 * Upsert a project into the registry. Preserves `addedAt` on re-registration (so re-indexing a
 * project doesn't reset its first-seen timestamp) but refreshes `repoId`/`cribDir`/`vcsHead` and the
 * archive fields. Only DEFINED optional fields are copied, so a directory re-registration does not
 * erase an earlier archive's `sourceArchive` unless the caller explicitly passes one — and an old
 * registry JSON written before these fields existed still resolves (the fields stay `undefined`).
 * The G3.4 `freshnessMode` is PRESERVED across re-registration unless explicitly passed: re-indexing
 * a project must never silently reset the operator's chosen freshness mode back to `manual`.
 * Idempotent: re-registering the same project is a no-op apart from refreshing the volatile fields.
 */
export function registerProject(absRoot: string, opts: RegisterOpts): RegisteredProject {
  const env = opts.env ?? process.env;
  const reg = readRegistry(env);
  const existing = reg.projects[absRoot];
  const entry: RegisteredProject = {
    repoId: opts.repoId,
    cribDir: opts.cribDir,
    ...(opts.vcsHead !== undefined ? { vcsHead: opts.vcsHead } : {}),
    addedAt: existing?.addedAt ?? opts.addedAt ?? new Date().toISOString(),
    ...(opts.sourceRoot !== undefined ? { sourceRoot: opts.sourceRoot } : {}),
    ...(opts.sourceArchive !== undefined
      ? { sourceArchive: opts.sourceArchive, sourceFingerprint: opts.sourceFingerprint }
      : {}),
    ...(opts.freshnessMode !== undefined
      ? { freshnessMode: opts.freshnessMode }
      : existing?.freshnessMode !== undefined
        ? { freshnessMode: existing.freshnessMode }
        : {}),
  };
  reg.projects[absRoot] = entry;
  writeRegistry(reg, env);
  return entry;
}

/** Remove a project from the registry. Returns true if it was present. */
export function unregisterProject(absRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const reg = readRegistry(env);
  if (!(absRoot in reg.projects)) return false;
  delete reg.projects[absRoot];
  writeRegistry(reg, env);
  return true;
}
