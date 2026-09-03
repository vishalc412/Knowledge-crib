/**
 * G3.2 — the REMOTE embedder tier: a provider shape for send-query-text-to-a-service embedders,
 * DISABLED unless the operator explicitly accepts the data policy.
 *
 * Red line #3: disabled-by-default is a red line. A remote embedder ships query text (and, in this
 * codebase's memory-recall use, fragments of memory claims) off the machine — that is a data-flow
 * decision only the operator may make, so it is gated on a persisted, explicit, versioned
 * acknowledgment under the embed home, NOT on an env var (env vars leak through shells and CI) and
 * NOT on a mere flag a caller could pass by accident. The gate fails CLOSED: an unreadable,
 * malformed, stale-versioned, or unacknowledged policy means the remote tier does not exist.
 *
 * The gate is deliberately separate from `provider.ts`'s pre-existing module-path hook: that hook
 * loads LOCAL operator-installed code (same trust level as any devDependency); the remote tier is
 * about the QUERY-TEXT EGRESS a hosted embedding endpoint implies, and that is what the policy
 * acknowledges.
 *
 * This module implements the policy + gate + a `resolve` helper. It NEVER performs network IO
 * itself — a policy-acknowledged operator still supplies an embedder module (which may do its own
 * network calls); the core path stays network-free for the budget gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedHomeDir as embedHomeDefault, loadEmbedderFromModule } from './embed-install.js';
import type { Embedder, EmbedderOptions } from './types.js';

/** Bump when the policy TEXT changes materially — a stale policyVersion means "re-acknowledge". */
export const REMOTE_EMBED_POLICY_VERSION = 1;

/**
 * The data-policy text the operator must have acknowledged, verbatim. Surfaced by `crib embed
 * install --accept-remote-policy` (the CLI's job, not this module's) so acknowledgment is informed.
 */
export const REMOTE_EMBED_POLICY_TEXT = [
  'REMOTE EMBEDDER DATA POLICY (knowledge-crib, G3.2)',
  '',
  'Enabling a remote embedder sends query text — and the memory-record text used to build',
  'query-time vectors — off this machine to the endpoint you configure. That data may include',
  'fragments of your memory ledger (claims, subjects, evidence quotes) and of your code search',
  "queries. It leaves the process boundary and is subject to the remote operator's retention",
  'policy, which knowledge-crib does not control.',
  '',
  'The built-in char-ngram fallback and the pinned on-device model tier (`crib embed install`)',
  'never transmit data. This acknowledgment is what turns the remote tier on.',
].join('\n');

/** The persisted operator acknowledgment, read from `<embed-home>/remote-policy.json`. */
export interface RemoteEmbedPolicy {
  /** Must be literally `true` — any other value (including `true`-ish strings) fails the gate. */
  acknowledged?: boolean;
  /** The policy version the operator read; must match {@link REMOTE_EMBED_POLICY_VERSION}. */
  policyVersion?: number;
  /** Free-form operator note (which endpoint/provider was accepted) — never parsed by the gate. */
  provider?: string;
}

/** `<embed-home>/remote-policy.json` — written by the CLI after an explicit operator confirmation. */
export function remotePolicyPath(home: string = embedHomeDefault()): string {
  return join(home, 'remote-policy.json');
}

/**
 * Read the policy file. Returns `undefined` on absence OR on any read/parse problem — the remote
 * gate treats "cannot prove acknowledgment" identically to "not acknowledged" (fail closed), so a
 * half-written policy file can never half-enable data egress.
 */
export function readRemoteEmbedPolicy(
  home: string = embedHomeDefault(),
): RemoteEmbedPolicy | undefined {
  const p = remotePolicyPath(home);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RemoteEmbedPolicy;
  } catch {
    return undefined;
  }
}

/**
 * The full remote opt-in gate: a policy file exists, says `acknowledged: true`, AND was written
 * against the CURRENT policy version. Any divergence → false → the remote tier stays disabled.
 */
export function remoteOptIn(home: string = embedHomeDefault()): boolean {
  const policy = readRemoteEmbedPolicy(home);
  return (
    policy !== undefined &&
    policy.acknowledged === true &&
    policy.policyVersion === REMOTE_EMBED_POLICY_VERSION
  );
}

/** Thrown when a remote embedder is requested without the operator's data-policy acknowledgment. */
export class RemoteEmbedPolicyError extends Error {
  constructor() {
    super(
      `remote embedder is disabled: no acknowledged data policy — write <embed-home>/remote-policy.json {"acknowledged": true, "policyVersion": ${REMOTE_EMBED_POLICY_VERSION}} after reviewing REMOTE_EMBED_POLICY_TEXT (the built-in tiers — char-ngram fallback and the pinned on-device model — never transmit data)`,
    );
  }
}

export interface ResolveRemoteEmbedderOptions extends EmbedderOptions {
  /** Local module path of the operator's remote-embedder adapter (it performs any network IO). */
  module: string;
  /** Embed home holding the policy file. Default {@link embedHomeDir}. */
  home?: string;
}

/**
 * Resolve a remote embedder — THROUGH the policy gate. Without an acknowledged, current-version
 * policy file this throws {@link RemoteEmbedPolicyError} and nothing is loaded. This function is
 * the ONLY sanctioned way to reach the remote tier; `resolveEmbedder` deliberately does not route
 * here, so a stray `KCRIB_EMBEDDER` value can never silently enable data egress.
 */
export async function resolveRemoteEmbedder(opts: ResolveRemoteEmbedderOptions): Promise<Embedder> {
  if (!remoteOptIn(opts.home)) throw new RemoteEmbedPolicyError();
  return loadEmbedderFromModule(opts.module, opts);
}
