/**
 * The fixed-argument gate runner (PRD §2 "Execution rules" + W4 lines 340–350).
 *
 * Runs a {@link GateProfile} against a candidate's claim and produces a sanitized {@link GateReceipt}
 * — the ONLY artifact a promotion may trust. The runner:
 *
 *   - uses `execFile` with `shell:false` (PRD line 271) — no shell interpolation, ever;
 *   - never lets candidate content add arguments (PRD line 272) — the argv is the profile's, frozen;
 *   - resolves + records the executable path (PRD line 273) so revalidation sees no PATH ambiguity;
 *   - passes through ONLY `permittedEnv` names (least privilege; every other env var is dropped);
 *   - computes `outputDigest` (blake3 of stdout+stderr) + evaluates the bounded `assertions` against
 *     the captured output in-memory, then DISCARDS the raw output (PRD line 162: "Command output is
 *     never persisted verbatim. Store only digests and allowlisted assertion results.");
 *   - records `head` + `worktreeDigest` + `policyHash` + `profileHash` so the promotion layer can
 *     snapshot → execute → reacquire → verify they are unchanged (PRD line 277).
 *
 * The runner NEVER holds a filesystem lock while the command runs (PRD line 69 + 277): the snapshot
 * values are an INPUT, and the verify step is the caller's job. It NEVER executes through MCP (PRD
 * line 68: `runner` is `cli` or `ci`, never `mcp`). The `GateExecPort` is injectable so the unit
 * tests fake execution without spawning a real process.
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { blake3Hex } from '@knowledge-crib/soul-schema';
import type { RunnerType } from './enums.js';
import { receiptId } from './ids.js';
import type { GateAssertion, GateProfile, MemoryPolicy } from './policy.js';
import { policyHash, profileHash } from './policy.js';
import type { GateReceipt } from './types.js';

/** The exit code recorded when a profile times out (the conventional timeout signal). */
export const GATE_TIMEOUT_EXIT = 124;

// ─── the injectable execution port ───────────────────────────────────────────

/** One gate execution's captured result (stdout + stderr + exit; the raw text is discarded after hashing). */
export interface GateExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** true iff the run was killed for exceeding `timeoutMs` (the receipt records the timeout exit). */
  timedOut?: boolean;
}

/** The spawn options the runner passes to the exec port. */
export interface GateExecOpts {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

/**
 * The execution port. Injected so tests fake execution; the default {@link NodeGateExecPort} spawns a
 * real child via `execFile(shell:false)`.
 */
export interface GateExecPort {
  execFile(file: string, args: string[], opts: GateExecOpts): Promise<GateExecResult>;
  /** Resolve a profile `executable` to an absolute path (recorded on the receipt). */
  resolveExecutable(name: string, env: NodeJS.ProcessEnv): string;
}

// ─── the run input ───────────────────────────────────────────────────────────

export interface GateRunInput {
  /** the profile to run (already resolved from the trusted-base policy). */
  profile: GateProfile;
  /** the trusted-base policy the profile was resolved from (for policyHash). */
  policy: MemoryPolicy;
  /** git HEAD the gate ran against (snapshot input — the caller verifies it post-run). */
  head: string;
  /** blake3 digest of the worktree state the gate observed (snapshot input). */
  worktreeDigest: string;
  /** who executed the gate — `cli` or `ci` (NEVER `mcp`; PRD line 68). */
  runner: RunnerType;
  /** the repo root the cwd resolves against. */
  repoRoot: string;
  /** the full env to filter `permittedEnv` from (the runner passes ONLY permitted names through). */
  env: NodeJS.ProcessEnv;
  /** fixed clock for a deterministic receipt `ts`. */
  now: () => string;
  /** the execution port (default: {@link NodeGateExecPort}). */
  exec?: GateExecPort;
}

/** The run outcome: either a sanitized receipt, or a failure to run at all (unresolvable executable). */
export type GateRunOutcome = { ok: true; receipt: GateReceipt } | { ok: false; error: string };

// ─── assertion evaluation ────────────────────────────────────────────────────

/** Evaluate one bounded assertion against the captured output. Pure. */
export function evalAssertion(a: GateAssertion, exitCode: number, output: string): boolean {
  switch (a.kind) {
    case 'exit-code':
      return (a.codes ?? []).includes(exitCode);
    case 'output-contains':
      return typeof a.needle === 'string' && a.needle.length > 0
        ? output.includes(a.needle)
        : false;
    case 'output-matches': {
      if (typeof a.pattern !== 'string') return false;
      try {
        return new RegExp(a.pattern, a.flags ?? '').test(output);
      } catch {
        return false; // an invalid regex pattern is a config error → assertion fails closed
      }
    }
    default:
      return false;
  }
}

// ─── the runner ──────────────────────────────────────────────────────────────

/**
 * Run a gate profile and produce a sanitized {@link GateReceipt}. Never throws on a non-zero exit or
 * a timeout — those are valid (failed) receipts. Throws only on an unresolvable executable (no
 * receipt can be produced). The raw stdout/stderr is consumed for the digest + assertions and then
 * discarded; it never leaves this function.
 */
export async function runGate(input: GateRunInput): Promise<GateRunOutcome> {
  const exec = input.exec ?? new NodeGateExecPort();
  const { profile, policy, runner, now } = input;

  let resolved: string;
  try {
    resolved = exec.resolveExecutable(profile.executable, input.env);
  } catch (e) {
    return {
      ok: false,
      error: `could not resolve executable '${profile.executable}': ${(e as Error).message}`,
    };
  }

  // Pass through ONLY the permitted env names (least privilege). PATH is included only if the profile
  // explicitly permits it — the executable was already resolved above, so the child does not need PATH
  // for that, but a child that itself shells out would; that is the profile author's call.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of profile.permittedEnv) {
    if (input.env[name] !== undefined) childEnv[name] = input.env[name]!;
  }

  const cwd = profile.cwd ? resolve(input.repoRoot, profile.cwd) : input.repoRoot;
  let result: GateExecResult;
  try {
    result = await exec.execFile(resolved, profile.args, {
      cwd,
      timeoutMs: profile.timeoutMs,
      env: childEnv,
    });
  } catch (e) {
    // spawn failed entirely (ENOENT, EACCES, …) — no receipt can be produced; surface the error.
    return { ok: false, error: `gate execution failed: ${(e as Error).message}` };
  }

  const exitCode = result.timedOut ? GATE_TIMEOUT_EXIT : result.exitCode;
  const output = `${result.stdout}\n${result.stderr}`;
  const outputDigest = `blake3:${blake3Hex(output)}`;
  const assertions = profile.assertions.map((a) => ({
    name: a.name,
    passed: evalAssertion(a, exitCode, output),
  }));
  const ph = policyHash(policy);
  const profHash = profileHash(profile);

  const receipt: GateReceipt = {
    id: receiptId({
      policyHash: ph,
      profileHash: profHash,
      executable: resolved,
      args: profile.args,
      head: input.head,
      worktreeDigest: input.worktreeDigest,
      exitCode,
      outputDigest,
      assertions,
      runner,
    }),
    schemaVersion: '1',
    policyHash: ph,
    profileHash: profHash,
    executable: resolved,
    args: profile.args,
    head: input.head,
    worktreeDigest: input.worktreeDigest,
    exitCode,
    durationMs: 0, // the exec port may set this; the canonical id excludes it (see ids.ts)
    outputDigest,
    assertions,
    runner,
    ts: now(),
  };
  return { ok: true, receipt };
}

// ─── the default Node exec port ──────────────────────────────────────────────

/**
 * The default {@link GateExecPort} using `node:child_process` `execFile` (`shell:false`). Resolves
 * the executable via PATH (or as a repo-relative / absolute path) so the receipt records the exact
 * binary. NOT used by the unit tests (they inject a fake port).
 */
export class NodeGateExecPort implements GateExecPort {
  resolveExecutable(name: string, env: NodeJS.ProcessEnv): string {
    if (isAbsolute(name)) return name;
    if (name.includes('/') || name.includes('\\')) return resolve(process.cwd(), name);
    const path = env.PATH ?? process.env.PATH ?? '';
    for (const dir of path.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`executable '${name}' not found on PATH`);
  }

  execFile(file: string, args: string[], opts: GateExecOpts): Promise<GateExecResult> {
    return new Promise((resolveFn) => {
      execFileCb(
        file,
        args,
        { cwd: opts.cwd, timeout: opts.timeoutMs, env: opts.env, shell: false },
        (err, stdout, stderr) => {
          // A timeout surfaces as a NodeJS.ErrnoException with `killed` + code ETIMEOUT/” — record the
          // conventional timeout exit; otherwise the child's numeric exit code (0 when no err).
          const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
          const timedOut = Boolean(e?.killed);
          const exitCode =
            typeof e?.code === 'number'
              ? e.code
              : e && !timedOut
                ? 1
                : timedOut
                  ? GATE_TIMEOUT_EXIT
                  : 0;
          resolveFn({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode,
            timedOut,
          });
        },
      );
    });
  }
}
