/**
 * Shared acceptance-receipt validator (format v2).
 *
 * The launch decision and the release-evidence reader used to each re-implement a slice of "is this
 * receipt trustworthy", and each slice had a hole: the decision checked status and an artifacts
 * array but never the package identity or the artifact BYTES; the reader checked digests but
 * resolved any path, including absolute paths and symlinks escaping the evidence root. v1 receipts
 * are still READABLE (collectors keep accepting them) but they never certify — a v1 envelope
 * cannot say which package it measured, so letting it pass would reopen the exact defect the
 * candidate-bound receipt was built to close.
 *
 * One validator, used by every consumer, so a fact checked once is checked everywhere:
 *   format and version → type → candidate identity (commit/package/policy) → cell (os/node) →
 *   run identity → command results (status recomputed from exit codes) → artifact bytes (existence,
 *   containment inside the evidence root, digest) → type-specific measurements (freshness p95).
 *
 * Every problem is a named blocker; an empty array is the only certifying verdict.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const ACCEPTANCE_RECEIPT_FORMAT = 'knowledge-crib-acceptance-receipt';
export const ACCEPTANCE_RECEIPT_FORMAT_VERSION = 2;
/** Reader-compat: v1 stays parseable for historical evidence, but only v2 can certify. */
export const SUPPORTED_ACCEPTANCE_FORMAT_VERSIONS = [1, 2];

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/** "v22.23.1" / "22.23.1" → 22; anything else → undefined (reported as a node mismatch by the caller). */
export function nodeMajorOf(node) {
  if (typeof node !== 'string') return undefined;
  const match = /^v?(\d+)(?:\.|$)/.exec(node);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Containment that cannot be spelled around: the artifact's REAL path (symlinks resolved) must be
 * the evidence root or inside it. A missing file is "inside" — it is reported as missing separately,
 * and realpathSync on a nonexistent path would throw before the digest could be checked anyway.
 */
function insideRoot(root, target) {
  if (typeof root !== 'string' || root.trim() === '') return false;
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    // The root itself is unreadable (deleted between the caller's exists check and here, or a
    // permission problem). Containment cannot be established — say so, never throw.
    return false;
  }
  let realTarget;
  try {
    realTarget = realpathSync(target);
  } catch {
    return true;
  }
  const rel = relative(realRoot, realTarget);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function artifactProblem(type, artifact, evidenceRoot) {
  if (!artifact || typeof artifact !== 'object') return `receipt-artifact-missing:${type}`;
  const { path, sha256: digest } = artifact;
  if (typeof path !== 'string' || path.trim() === '') return `receipt-artifact-missing:${type}`;
  if (
    !evidenceRoot ||
    typeof evidenceRoot !== 'string' ||
    evidenceRoot.trim() === '' ||
    !existsSync(evidenceRoot)
  ) {
    // No artifact-root context — or a --receipts-root that is not actually there (a typo) — means
    // the bytes cannot be verified at all. A named blocker, not a skip and not an ENOENT crash.
    return `receipt-artifact-unverifiable:${type}`;
  }
  const absolute = resolve(evidenceRoot, path);
  if (!insideRoot(evidenceRoot, absolute)) return `receipt-artifact-outside-root:${type}:${path}`;
  if (!existsSync(absolute)) return `receipt-artifact-missing:${type}:${path}`;
  if (typeof digest !== 'string' || !SHA256_DIGEST.test(digest)) {
    return `receipt-artifact-digest:${type}:${path}`;
  }
  let bytes;
  try {
    bytes = readFileSync(absolute);
  } catch {
    // An artifact path that resolves to a directory or a permission-restricted file: the bytes
    // cannot be read, so they cannot match the digest. A named blocker, not an EISDIR/EACCES throw
    // — hand-edited receipts listing a directory are exactly the input this validator judges.
    return `receipt-artifact-digest:${type}:${path}`;
  }
  if (sha256(bytes) !== digest) return `receipt-artifact-digest:${type}:${path}`;
  return null;
}

/**
 * Judge one acceptance receipt and return its problems (an empty array certifies).
 *
 * `options` carries the facts the receipt must agree with:
 *   - `type`        — the policy receipt type this slot is for (a receipt filed under the wrong
 *                     name is evidence for something else)
 *   - `candidate`   — { commit, packageSha256 } of the candidate under decision
 *   - `policySha256`— the frozen policy digest the decision is being made under
 *   - `policy`      — the loaded launch policy (freshness target/workload, receipt types)
 *   - `cell`        — { os, nodeMajor } the receipt's platform must match
 *   - `evidenceRoot`— the directory artifacts resolve against (missing root ⇒ unverifiable)
 */
export function acceptanceReceiptProblems(receipt, options) {
  const type = options.type ?? receipt?.type;
  const problems = [];

  // (1) Format: an unrecognised envelope is not a receipt of any version — refuse before reading more.
  if (receipt?.format !== ACCEPTANCE_RECEIPT_FORMAT) {
    problems.push(`receipt-unknown-format:${type}:${receipt?.format ?? 'missing'}`);
    return problems;
  }
  // (2) Version: v1 is readable but non-certifying. It cannot carry package identity or exit codes,
  // so no fact it records can be trusted enough to certify a launch.
  if (receipt.formatVersion !== ACCEPTANCE_RECEIPT_FORMAT_VERSION) {
    if (!SUPPORTED_ACCEPTANCE_FORMAT_VERSIONS.includes(receipt.formatVersion)) {
      problems.push(`receipt-unknown-format:${type}:${receipt.formatVersion}`);
    } else {
      problems.push(`receipt-schema-non-certifying:${type}:v${receipt.formatVersion}`);
    }
    return problems;
  }
  // (3) The receipt must be FOR the type it is filed under.
  if (receipt.type !== type) {
    problems.push(`receipt-type-mismatch:${type}:${receipt.type}`);
  }

  // (4) Candidate identity. Missing counts as foreign: a receipt that cannot say which commit,
  // package or policy it measured certifies nothing, not "whatever is under decision today".
  const candidate = options.candidate ?? {};
  if (receipt.candidateCommit !== candidate.commit) {
    problems.push(`receipt-foreign-commit:${type}`);
  }
  if (receipt.candidatePackageSha256 !== candidate.packageSha256) {
    problems.push(`receipt-foreign-package:${type}`);
  }
  if (options.policySha256 !== undefined && receipt.policySha256 !== options.policySha256) {
    problems.push(`receipt-foreign-policy:${type}`);
  }

  // (5) Cell: platform/Node must match the cell this receipt is offered to.
  const cell = options.cell;
  if (cell?.os !== undefined && receipt.platform?.os !== cell.os) {
    problems.push(`receipt-platform-mismatch:${type}:${receipt.platform?.os ?? 'missing'}`);
  }
  if (cell?.nodeMajor !== undefined && nodeMajorOf(receipt.platform?.node) !== cell.nodeMajor) {
    problems.push(`receipt-node-mismatch:${type}:${receipt.platform?.node ?? 'missing'}`);
  }

  // (6) Run identity: a receipt with no run id cannot be told apart from a stale pair left by the
  // previous pass — or from its own duplicate written by a retried step.
  if (typeof receipt.runId !== 'string' || receipt.runId.trim() === '') {
    problems.push(`receipt-run-identity-missing:${type}`);
  }

  // (7) Command results: pass/fail is RECOMPUTED from recorded exit codes. A check that never
  // finished cannot be reported as finished by writing "--status pass" after the fact.
  const commandResults = receipt.commandResults;
  if (
    !Array.isArray(commandResults) ||
    commandResults.length === 0 ||
    !commandResults.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.command === 'string' &&
        entry.command.trim() !== '' &&
        Number.isInteger(entry.exitCode),
    )
  ) {
    problems.push(`receipt-exit-code-missing:${type}`);
  } else {
    const derived = commandResults.every((entry) => entry.exitCode === 0) ? 'pass' : 'fail';
    if (receipt.status !== derived) {
      problems.push(`receipt-status-contradiction:${type}:${receipt.status}`);
    }
  }

  // (8) Status: a failed or not-run receipt is a blocker by name; its artifacts are not verified
  // because a failed check's missing log is not the failure that matters.
  if (receipt.status !== 'pass') {
    problems.push(`receipt-not-passing:${type}:${receipt.status}`);
    return problems;
  }

  // (9) Artifacts: a passing receipt must reference real bytes, inside the evidence root, matching
  // the recorded digests.
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    problems.push(`receipt-artifact-missing:${type}`);
  } else {
    for (const artifact of receipt.artifacts) {
      const problem = artifactProblem(type, artifact, options.evidenceRoot);
      if (problem) problems.push(problem);
    }
  }

  // (10) Type-specific measurements. Freshness carries the p95 the convergence claim rests on.
  if (type === 'freshness' && options.policy) {
    const spec = options.policy.freshness;
    const p95 = receipt.p95Ms;
    if (typeof p95 !== 'number' || !Number.isFinite(p95)) {
      problems.push('freshness-p95-not-finite');
    } else if (p95 > spec.p95TargetMs) {
      problems.push(`freshness-p95-exceeded:${p95}`);
    }
    if (receipt.workload !== spec.workload) {
      problems.push(`freshness-workload-mismatch:${receipt.workload}`);
    }
  }

  return problems;
}
