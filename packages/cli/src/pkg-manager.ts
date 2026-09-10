/**
 * The shared package-manager launcher (WP1.1–WP1.3).
 *
 * WHY THIS EXISTS
 * `installOnnxRuntime` used to spawn the bare command `npm`. That is the exact shape of a
 * Windows-install failure: on Windows the executable is `npm.cmd`, and Node (since the
 * CVE-2024-27980 fix) refuses to launch `.cmd`/`.bat` shims without `shell: true` — and a
 * shell invocation is how crib would reintroduce quoting and injection surface it otherwise
 * does not have. The fix is not "add shell: true"; it is to never resolve a package manager
 * through a shim at all.
 *
 * HOW IT RESOLVES
 * The launcher finds npm's JavaScript entry (`npm-cli.js`) and runs it with the SAME node
 * binary that is running crib (`process.execPath`), argument-array only, `shell` never set:
 *   1. `npm_execpath` — when crib itself was started by npm, the user's own npm CLI is the
 *      most faithful choice. Only accepted when it actually names npm (pnpm sets
 *      `npm_execpath` to pnpm's own bin, which must never be run as npm).
 *   2. Bundled npm next to the node binary — the layout of every ordinary Node install
 *      (unix prefix `../lib/node_modules/…`, Windows `node_modules/…` beside node.exe).
 *   3. PATH probe — last resort, non-Windows only: on unix `execFileSync('npm', …)` finds
 *      a regular executable without a shell. On Windows the PATH entry is a `.cmd` shim,
 *      which we refuse by design, so the result is a discovery failure with the repair
 *      action "install Node from the official distribution".
 *
 * Failure taxonomy (WP1.3) — every failure is one machine-readable phase, never a prose guess:
 *   discovery     no usable npm could be resolved at all
 *   network       npm ran but could not reach the registry
 *   install       npm ran and failed for a non-network reason
 *   post-install  npm exited 0 but the expected artifact is missing (owned by the caller)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type PkgPhase = 'discovery' | 'network' | 'install' | 'post-install';

/** A classified, machine-readable failure with the ONE action that repairs it. */
export interface PkgFailure {
  phase: PkgPhase;
  /** single sanitized line — safe to print, log, or embed in JSON. */
  message: string;
  /** the concrete command or fix the user should run next. */
  repair: string;
}

/** How npm was found. Reported in step output so a user can tell which npm ran. */
export type NpmSource = 'npm-execpath' | 'bundled-npm' | 'path-npm';

export interface NpmResolution {
  /** node binary to run the CLI script with (normally process.execPath). */
  execPath: string;
  /** absolute path of npm-cli.js (never a shim, never a shell command). */
  script: string;
  source: NpmSource;
}

export type NpmResolveResult = { ok: true; npm: NpmResolution } | ({ ok: false } & PkgFailure);

export interface ResolveDeps {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** platform check override for unit tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** PATH-probe override for unit tests; defaults to a real `npm --version` spawnSync. */
  probe?: (cmd: string, args: string[]) => boolean;
}

const NPM_CLI_RELATIVE_CANDIDATES = [
  // Windows layout: node_modules/npm sits beside node.exe.
  join('node_modules', 'npm', 'bin', 'npm-cli.js'),
  // Unix prefix layouts (Homebrew, nvm, volta, /usr/local, distro installs):
  join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
];

/**
 * Resolve a runnable npm. Never returns a shell command or a `.cmd` shim; on failure returns
 * a `discovery`-phase PkgFailure with the repair action. Pure w.r.t. the filesystem through
 * injected `exists`, so the resolution matrix is unit-testable on any platform.
 */
export function resolveNpm(deps: ResolveDeps = {}): NpmResolveResult {
  const execPath = deps.execPath ?? process.execPath;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;

  // 1. The npm that started us, when it really is npm.
  const execPathEnv = env.npm_execpath;
  if (typeof execPathEnv === 'string' && execPathEnv.length > 0 && looksLikeNpmCli(execPathEnv)) {
    if (exists(execPathEnv)) {
      return { ok: true, npm: { execPath, script: execPathEnv, source: 'npm-execpath' } };
    }
  }

  // 2. The npm bundled with the running node.
  const binDir = dirname(execPath);
  for (const rel of NPM_CLI_RELATIVE_CANDIDATES) {
    const candidate = join(binDir, rel);
    if (exists(candidate)) {
      return { ok: true, npm: { execPath, script: candidate, source: 'bundled-npm' } };
    }
  }

  // 3. PATH probe, non-Windows only. On Windows every PATH entry for npm is a `.cmd` shim and
  // spawning one without a shell is refused by Node on purpose — we do not "fix" that with a
  // shell; we fail with the repair action instead.
  if (platform !== 'win32') {
    const probeOk = deps.probe
      ? deps.probe('npm', ['--version'])
      : (() => {
          const probe = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: false });
          return probe.status === 0 && !probe.error;
        })();
    if (probeOk) {
      return { ok: true, npm: { execPath, script: 'npm', source: 'path-npm' } };
    }
  }

  return {
    ok: false,
    phase: 'discovery',
    message: `no runnable npm found beside ${execPath} or on PATH`,
    repair:
      'Install Node.js from an official distribution (https://nodejs.org), which bundles npm, then re-run this command',
  };
}

function looksLikeNpmCli(p: string): boolean {
  const name = basename(p);
  return name === 'npm-cli.js' || name === 'npm' || name === 'npm.js';
}

const NETWORK_SIGNATURES = [
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EAI_AGAIN',
  'getaddrinfo',
  'network',
  'EHOSTUNREACH',
];

/**
 * Classify a package-manager failure into the taxonomy. Given a Node child-process error or a
 * plain Error, produces the phase plus a bounded, single-line message — a step report must never
 * spray an entire npm log into a setup plan.
 */
export function classifyNpmFailure(err: unknown, fallbackRepair: string): PkgFailure {
  const e = err as {
    code?: string | number;
    status?: number | null;
    stderr?: string;
    message?: string;
  };
  const raw = String(e.stderr ?? e.message ?? err);
  const oneLine = tail(raw).replace(/\s+/g, ' ').trim();

  if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
    return {
      phase: 'discovery',
      message: oneLine || 'the package manager could not be started',
      repair: fallbackRepair,
    };
  }
  if (NETWORK_SIGNATURES.some((sig) => raw.includes(sig))) {
    return {
      phase: 'network',
      message: oneLine || 'the package registry could not be reached',
      repair: 'Check network access (proxy, DNS, registry reachability) and re-run this command',
    };
  }
  return {
    phase: 'install',
    message: oneLine || 'the package manager exited with a failure',
    repair: fallbackRepair,
  };
}

/** Keep the last ~800 characters — enough to name the error, never enough to flood a report. */
function tail(text: string): string {
  const cleaned = text.replace(/\r/g, '');
  return cleaned.length > 800 ? cleaned.slice(-800) : cleaned;
}

export interface RunDeps extends ResolveDeps {
  maxBuffer?: number;
}

export type NpmRunResult = { ok: true; stdout: string } | ({ ok: false } & PkgFailure);

/**
 * Run one npm command (e.g. `['install', pkg]`) in `cwd`, argument-array only. The single code
 * path every provisioning step uses, so the resolution logic and taxonomy are shared, not copied.
 */
export function runNpm(cwd: string, args: string[], deps: RunDeps = {}): NpmRunResult {
  const resolved = resolveNpm(deps);
  if (!resolved.ok) return resolved;
  const { execPath, script } = resolved.npm;
  try {
    // `shell` is deliberately never set: the argument array is the whole command line.
    const stdout = spawnSync(execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: deps.maxBuffer ?? 64 * 1024 * 1024,
    });
    if (stdout.error) throw stdout.error;
    if (stdout.status !== 0) {
      const stderrText = (stdout.stderr ?? '').trim().length > 0 ? stdout.stderr : undefined;
      const failure = classifyNpmFailure(
        {
          status: stdout.status,
          stderr: stderrText,
          message: `npm ${args[0]} exited with status ${stdout.status}`,
        },
        'Re-run with a working npm, or provision this machine by hand and use the offline bundle path',
      );
      return { ok: false, ...failure };
    }
    return { ok: true, stdout: stdout.stdout ?? '' };
  } catch (err) {
    return { ok: false, ...classifyNpmFailure(err, 'Re-run with a working npm') };
  }
}
