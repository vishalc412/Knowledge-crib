import { existsSync, readFileSync } from 'node:fs';
/**
 * The trusted-base gate policy (PRD §2 "CLI and CI interfaces" + W4 lines 340–350).
 *
 * `.crib/memory/policy.json` is a **committed** artifact (normal Git text merge) that names the
 * fixed-argument runner profiles a candidate may be evaluated against. It is the ONLY thing that
 * decides what command CI executes — an untrusted PR cannot inject or alter a command because CI
 * loads the policy from the merge base, never from the untrusted PR version (PRD line 275), and a
 * policy-changing PR cannot authorize memories introduced by the same PR (PRD line 276).
 *
 * A profile fixes the executable, the exact argv, the cwd, the timeout, the environment names that
 * may pass through, the success exit codes, and a bounded set of named output assertions. Candidate
 * content can NEVER add arguments (PRD line 272) — the candidate only selects a profile by name.
 *
 * The policy + profile hashes are blake3 over canonical (key-sorted) JSON of the semantic content,
 * so a receipt's `policyHash`/`profileHash` deterministically detect drift (PRD line 179: execution-
 * backed memories become `needs-review` when their declared policy hash changes).
 */
import { blake3Hex } from '@knowledge-crib/soul-schema';
import { policyPath } from './paths.js';

// ─── canonical serialization (key-sorted, matches ids.ts / memory-merge.ts) ──

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/** Stable canonical JSON for hashing (key-sorted). */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

// ─── the bounded output assertion a profile may declare ──────────────────────

/**
 * One named, bounded assertion evaluated against the gate's captured output. The raw output is NEVER
 * persisted (PRD: "Command output is never persisted verbatim"); only the assertion's `passed`
 * boolean lands on the {@link GateReceipt}. An `execution-assertion` evidence item references a
 * receipt id + assertion NAME — the named result is the admissible signal, not the output text.
 *
 *   - `exit-code`        — passed iff the command's exit code is in `codes`.
 *   - `output-contains`  — passed iff the concatenated stdout+stderr contains `needle`.
 *   - `output-matches`   — passed iff `pattern` (regex, anchored by the caller) matches the output.
 */
export interface GateAssertion {
  name: string;
  kind: 'exit-code' | 'output-contains' | 'output-matches';
  /** `exit-code`: the codes that satisfy this assertion. */
  codes?: number[];
  /** `output-contains`: the substring to search for. */
  needle?: string;
  /** `output-matches`: a JavaScript regex source. Case-sensitive; flags default to `''`. */
  pattern?: string;
  /** `output-matches`: optional regex flags (e.g. `'i'`). */
  flags?: string;
}

// ─── a named runner profile ──────────────────────────────────────────────────

/**
 * A fixed-argument runner profile (PRD line 267). `executable` is resolved + recorded on the receipt
 * (no PATH ambiguity at revalidation time). `args` is frozen — a candidate never adds to it. Only
 * `permittedEnv` names pass through to the child; every other env var is dropped (least privilege).
 */
export interface GateProfile {
  name: string;
  executable: string;
  args: string[];
  /** cwd relative to the repo root; defaults to the repo root. */
  cwd?: string;
  timeoutMs: number;
  permittedEnv: string[];
  successExitCodes: number[];
  assertions: GateAssertion[];
}

// ─── the policy document ─────────────────────────────────────────────────────

/** The policy schema + format version (mirrors the memory-1 versioning discipline). */
export const POLICY_FORMAT_VERSION = 1;

/**
 * The optional `capture` section of the policy (G2.2) — tightening knobs ONLY. The always-on
 * capture-hygiene axes (secrets / PII / paths / transcripts) live in `capture-policy.ts` and CANNOT
 * be disabled from here; a policy can only make capture stricter. Additive optional top-level
 * section: `assertValidPolicy` tolerates absent/unknown top-level fields, so no
 * `POLICY_FORMAT_VERSION` bump.
 */
export interface CapturePolicySection {
  /** ceiling on a capture's claim (observation) length. Default: 2000 (see capture-policy.ts). */
  maxClaimChars?: number;
  /** record kinds refused at capture time (e.g. forbid `decision` captures from loose lanes). */
  forbiddenKinds?: string[];
  /** scope boundaries capture may use (e.g. `['repo']` to forbid global captures). Default: both. */
  allowedScopeBoundaries?: string[];
}

/**
 * The trusted-base policy. `trustedRef` is the Git ref whose tree is the source of team trust (PRD
 * line 279: "exact record and decision blobs being present in a configured trusted Git ref"; default
 * `refs/remotes/origin/HEAD`). Without it, committed memories remain `pending` rather than trusted.
 */
export interface MemoryPolicy {
  version: 1;
  trustedRef?: string;
  profiles: Record<string, GateProfile>;
  /** G2.2 — optional capture-tightening section (see {@link CapturePolicySection}). */
  capture?: CapturePolicySection;
}

/** The default trusted ref when the policy omits one (PRD line 279). */
export const DEFAULT_TRUSTED_REF = 'refs/remotes/origin/HEAD';

// ─── hashing ─────────────────────────────────────────────────────────────────

/** `blake3:<hex>` over a profile's canonical semantic content — the receipt's `profileHash`. */
export function profileHash(profile: GateProfile): string {
  return `blake3:${blake3Hex(canonical(profile))}`;
}

/** `blake3:<hex>` over the whole policy's canonical semantic content — the receipt's `policyHash`. */
export function policyHash(policy: MemoryPolicy): string {
  return `blake3:${blake3Hex(canonical(policy))}`;
}

// ─── validation ──────────────────────────────────────────────────────────────

/** Thrown when a policy document fails validation (unknown version, malformed profile, …). */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

const ASSERTION_KINDS = new Set(['exit-code', 'output-contains', 'output-matches']);

/** Validate a profile's shape (called by {@link assertValidPolicy}). Throws `PolicyError`. */
function assertValidProfile(profile: unknown, name: string): asserts profile is GateProfile {
  if (profile === null || typeof profile !== 'object') {
    throw new PolicyError(`profile '${name}' must be an object`);
  }
  const p = profile as Record<string, unknown>;
  if (typeof p.executable !== 'string' || p.executable.length === 0) {
    throw new PolicyError(`profile '${name}' executable must be a non-empty string`);
  }
  if (!Array.isArray(p.args) || p.args.some((a) => typeof a !== 'string')) {
    throw new PolicyError(`profile '${name}' args must be an array of strings`);
  }
  if (typeof p.timeoutMs !== 'number' || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) {
    throw new PolicyError(`profile '${name}' timeoutMs must be a positive finite number`);
  }
  if (!Array.isArray(p.permittedEnv) || p.permittedEnv.some((e) => typeof e !== 'string')) {
    throw new PolicyError(`profile '${name}' permittedEnv must be an array of strings`);
  }
  if (!Array.isArray(p.successExitCodes) || p.successExitCodes.some((c) => typeof c !== 'number')) {
    throw new PolicyError(`profile '${name}' successExitCodes must be an array of numbers`);
  }
  if (!Array.isArray(p.assertions)) {
    throw new PolicyError(`profile '${name}' assertions must be an array`);
  }
  for (const a of p.assertions) {
    if (a === null || typeof a !== 'object')
      throw new PolicyError(`profile '${name}' assertion must be an object`);
    const ax = a as Record<string, unknown>;
    if (typeof ax.name !== 'string' || ax.name.length === 0) {
      throw new PolicyError(`profile '${name}' assertion name must be a non-empty string`);
    }
    if (typeof ax.kind !== 'string' || !ASSERTION_KINDS.has(ax.kind)) {
      throw new PolicyError(`profile '${name}' assertion '${ax.name}' has an invalid kind`);
    }
    if (
      ax.kind === 'exit-code' &&
      (!Array.isArray(ax.codes) || ax.codes.some((c) => typeof c !== 'number'))
    ) {
      throw new PolicyError(
        `profile '${name}' assertion '${ax.name}' codes must be a number array`,
      );
    }
    if (ax.kind === 'output-contains' && typeof ax.needle !== 'string') {
      throw new PolicyError(`profile '${name}' assertion '${ax.name}' needle must be a string`);
    }
    if (ax.kind === 'output-matches' && typeof ax.pattern !== 'string') {
      throw new PolicyError(`profile '${name}' assertion '${ax.name}' pattern must be a string`);
    }
  }
  if (typeof p.cwd === 'string' && (p.cwd.length === 0 || p.cwd.startsWith('/'))) {
    throw new PolicyError(
      `profile '${name}' cwd must be a non-absolute, non-empty path relative to the repo root`,
    );
  }
}

/**
 * Validate a parsed policy document. Unknown versions fail closed (PRD discipline: a future policy
 * version is not silently accepted). Throws `PolicyError` on any violation.
 */
export function assertValidPolicy(policy: unknown): asserts policy is MemoryPolicy {
  if (policy === null || typeof policy !== 'object')
    throw new PolicyError('policy must be an object');
  const p = policy as Record<string, unknown>;
  if (p.version !== POLICY_FORMAT_VERSION) {
    throw new PolicyError(
      `unsupported policy version ${String(p.version)} (expected ${POLICY_FORMAT_VERSION})`,
    );
  }
  if (!p.profiles || typeof p.profiles !== 'object') {
    throw new PolicyError('policy.profiles must be an object keyed by profile name');
  }
  const profiles = p.profiles as Record<string, unknown>;
  for (const name of Object.keys(profiles)) {
    const prof = profiles[name];
    if (prof === null || typeof prof !== 'object') {
      throw new PolicyError(`profile '${name}' must be an object`);
    }
    // the profile's `name` field, if present, must match its key (a drift guard); default to the key.
    const pp = prof as Record<string, unknown>;
    if (pp.name !== undefined && pp.name !== name) {
      throw new PolicyError(`profile key '${name}' does not match name field '${String(pp.name)}'`);
    }
    if (pp.name === undefined) pp.name = name;
    assertValidProfile(pp, name);
  }
  if (
    p.trustedRef !== undefined &&
    (typeof p.trustedRef !== 'string' || p.trustedRef.length === 0)
  ) {
    throw new PolicyError('policy.trustedRef must be a non-empty string when present');
  }
  // G2.2 — the optional `capture` section validates ONLY when present (additive; absence is the
  // defaulted-open posture documented in capture-policy.ts).
  if (p.capture !== undefined) {
    if (p.capture === null || typeof p.capture !== 'object' || Array.isArray(p.capture)) {
      throw new PolicyError('policy.capture must be an object when present');
    }
    const c = p.capture as Record<string, unknown>;
    if (
      c.maxClaimChars !== undefined &&
      (typeof c.maxClaimChars !== 'number' ||
        !Number.isFinite(c.maxClaimChars) ||
        c.maxClaimChars <= 0)
    ) {
      throw new PolicyError('policy.capture.maxClaimChars must be a positive finite number');
    }
    if (
      c.forbiddenKinds !== undefined &&
      (!Array.isArray(c.forbiddenKinds) || c.forbiddenKinds.some((k) => typeof k !== 'string'))
    ) {
      throw new PolicyError('policy.capture.forbiddenKinds must be an array of strings');
    }
    if (
      c.allowedScopeBoundaries !== undefined &&
      (!Array.isArray(c.allowedScopeBoundaries) ||
        c.allowedScopeBoundaries.some((b) => b !== 'repo' && b !== 'global'))
    ) {
      throw new PolicyError(
        "policy.capture.allowedScopeBoundaries must be an array of 'repo'/'global'",
      );
    }
  }
}

// ─── loading ─────────────────────────────────────────────────────────────────

/**
 * Parse + validate a policy document from JSON text. Unknown versions + malformed profiles fail
 * closed with a `PolicyError` (never silently accepted).
 */
export function loadPolicyJson(text: string): MemoryPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new PolicyError(`policy.json is not valid JSON: ${(e as Error).message}`);
  }
  assertValidPolicy(parsed);
  return parsed;
}

/**
 * Load the committed policy from `<cribDir>/memory/policy.json`. Returns `undefined` when the file is
 * absent (no profiles configured — the gate cannot run; the CLI refuses evaluation). Throws
 * `PolicyError` on a corrupt/malformed file (never silently returns a partial policy).
 */
export function loadPolicy(cribDir: string): MemoryPolicy | undefined {
  const path = policyPath(cribDir);
  if (!existsSync(path)) return undefined;
  return loadPolicyJson(readFileSync(path, 'utf8'));
}

/**
 * Resolve a profile by name from the trusted-base policy. Returns `undefined` when the name is absent
 * — the CLI layer refuses evaluation absent a TTY approval (PRD line 274: "Locally refuse profiles
 * absent from the trusted-base policy unless the user explicitly approves them in a TTY"). CI never
 * approves (PRD line 275): a missing profile in the merge-base policy is a hard check failure.
 */
export function resolveProfile(policy: MemoryPolicy, name: string): GateProfile | undefined {
  return policy.profiles[name];
}

/** The effective trusted ref for a policy (explicit or the default). */
export function trustedRefOf(policy: MemoryPolicy | undefined): string {
  return policy?.trustedRef ?? DEFAULT_TRUSTED_REF;
}
