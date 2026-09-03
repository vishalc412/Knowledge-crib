import type { CapturePolicySection } from './policy.js';
/**
 * The capture-policy gate (G2.2) — a PURE check that runs BEFORE any id is computed or any byte is
 * written. Two layers:
 *
 * 1. ALWAYS-ON hygiene axes (non-configurable, `policy.capture` cannot disable them): secrets
 *    (the memory package's own scanner), PII (emails), filesystem-path leakage (absolute home-tree
 *    paths + `~/` — a capture quoting `/Users/<who>/...` leaks an identity into the ledger), and
 *    raw-transcript markers (dialogue lines are the StructuredSummary-only law's brightest line).
 * 2. POLICY-TIGHTENING axes (only bind when the policy sets them): `maxClaimChars`,
 *    `forbiddenKinds`, `allowedScopeBoundaries`.
 *
 * DEFAULT DECISION (explicit): when the `capture` section is absent the policy is DEFAULTED-OPEN on
 * the tightening axes and CLOSED on the always-on axes. Rationale: the hygiene axes are content
 * invariants (a secret is a secret whatever the operator thinks), while the tightening axes gate
 * the operator's own writers — defaulting `allowedScopeBoundaries` closed (no `global`) would
 * silently break the W4 `memory_observe` global-scope contract mid-gate, so `global` stays legal
 * until an operator's policy forbids it. A CORRUPT policy.json is different: `PolicyError` from the
 * loader is fail-closed at the API layer (a typed rejection, never a silent pass).
 *
 * Violations never echo the offending content (an error message that quotes the secret it refused
 * would leak it into the caller's log); they carry the axis + a static reason + counts only.
 */
import { scanSecrets } from './secrets.js';

/** Which invariant a capture-policy violation violates. */
export type CapturePolicyAxis =
  | 'secret'
  | 'pii'
  | 'path'
  | 'transcript'
  | 'length'
  | 'kind'
  | 'scope';

/** One refusal reason. `reason` is STATIC — never quotes the refused content. */
export interface CapturePolicyViolation {
  axis: CapturePolicyAxis;
  reason: string;
}

export type CapturePolicyResult =
  | { ok: true }
  | { ok: false; violations: readonly CapturePolicyViolation[] };

/** The pure check's input — exactly the fields the decision reads (no store, no clock, no I/O). */
export interface CapturePolicyInput {
  kind: string;
  subject: string;
  claim: string;
  boundary: 'repo' | 'global';
}

/** Default claim ceiling when the policy omits `maxClaimChars` (generous prose budget). */
export const DEFAULT_CAPTURE_MAX_CLAIM_CHARS = 2000;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/;
// Absolute paths under the home tree (username leakage) — repo-relative paths like `src/auth.ts`
// are legitimate provenance and stay clean.
const HOME_PATH_RE =
  /(?:^|[\s(`"'[])(?:\/(?:Users|home|root)\/[^\s"'`,)\]},;]*|~\/[^\s"'`,)\]},;]*)/;
// Dialogue-shaped lines are the raw-transcript smell (StructuredSummary-only law).
const TRANSCRIPT_RE = /(?:^|\n)\s*(?:user|assistant|system|human|tool)\s*:/i;

/**
 * Decide a capture against the policy. PURE — same inputs, same verdict, no I/O, no clock. Returns
 * ALL violations (not fail-fast) so a caller fixing an input sees the full picture at once.
 */
export function checkCapturePolicy(
  input: CapturePolicyInput,
  policy?: CapturePolicySection,
): CapturePolicyResult {
  const violations: CapturePolicyViolation[] = [];
  const prose = `${input.subject}\n${input.claim}`;

  if (scanSecrets(prose).length > 0) {
    violations.push({
      axis: 'secret',
      reason: 'refused: the text matches a secret-credential pattern and must not enter memory',
    });
  }
  if (EMAIL_RE.test(prose)) {
    violations.push({
      axis: 'pii',
      reason: 'refused: the text contains an email address (personal data)',
    });
  }
  if (HOME_PATH_RE.test(prose)) {
    violations.push({
      axis: 'path',
      reason: 'refused: the text leaks an absolute home-directory path (use repo-relative paths)',
    });
  }
  if (TRANSCRIPT_RE.test(prose)) {
    violations.push({
      axis: 'transcript',
      reason: 'refused: the text is dialogue-shaped (a raw transcript, not a structured summary)',
    });
  }

  const maxChars = policy?.maxClaimChars ?? DEFAULT_CAPTURE_MAX_CLAIM_CHARS;
  if (input.claim.length > maxChars) {
    violations.push({
      axis: 'length',
      reason: `refused: the claim is ${input.claim.length} chars (policy max ${maxChars}) — distill it`,
    });
  }
  if (policy?.forbiddenKinds?.includes(input.kind)) {
    violations.push({
      axis: 'kind',
      reason: `refused: kind '${input.kind}' is forbidden by the capture policy`,
    });
  }
  if (policy?.allowedScopeBoundaries && !policy.allowedScopeBoundaries.includes(input.boundary)) {
    violations.push({
      axis: 'scope',
      reason: `refused: scope boundary '${input.boundary}' is not allowed by the capture policy`,
    });
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
