/**
 * The immutable release policy: WHAT a production developer launch requires.
 *
 * The audit's A01/A02 failure was structural, not arithmetic — an evidence manifest carried both
 * the results AND the requirements those results were judged against, so a manifest with an empty
 * gate list, a flipped `certification.required`, or a receipt for a different commit could select
 * requirements it happened to satisfy. Requirements now live HERE, outside every artifact a run can
 * produce, are hashed before candidate testing, and the decision recomputes eligibility from this
 * file plus validated measurements.
 *
 * The hash is the binding: a receipt records the policy hash it was collected under, and evidence
 * gathered under a different policy cannot certify this candidate.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POLICY_PATH = join(HERE, 'launch-policy.json');

export class LaunchPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LaunchPolicyError';
  }
}

function assertPolicy(condition, message) {
  if (!condition) throw new LaunchPolicyError(message);
}

const DIRECTIONS = new Set(['gte', 'lte']);

/** Validate the policy document itself — a malformed policy must never silently weaken a decision. */
export function validateLaunchPolicy(policy) {
  assertPolicy(policy && typeof policy === 'object', 'launch policy must be an object');
  assertPolicy(
    policy.format === 'knowledge-crib-launch-policy',
    `unsupported launch policy format: ${policy.format}`,
  );
  assertPolicy(
    Number.isInteger(policy.policyVersion) && policy.policyVersion > 0,
    'launch policy policyVersion must be a positive integer',
  );
  assertPolicy(
    Array.isArray(policy.gates) && policy.gates.length > 0,
    'launch policy must declare at least one gate',
  );
  const ids = new Set();
  for (const gate of policy.gates) {
    assertPolicy(gate && typeof gate === 'object', 'launch policy gates must be objects');
    assertPolicy(typeof gate.id === 'string' && gate.id, 'launch policy gate needs an id');
    assertPolicy(!ids.has(gate.id), `duplicate gate id in launch policy: ${gate.id}`);
    ids.add(gate.id);
    assertPolicy(
      typeof gate.threshold === 'number' && Number.isFinite(gate.threshold),
      `launch policy gate ${gate.id} needs a finite threshold`,
    );
    assertPolicy(
      DIRECTIONS.has(gate.direction),
      `launch policy gate ${gate.id} needs direction gte or lte`,
    );
  }
  for (const field of ['osNodeCells', 'clients', 'clientPlatforms', 'receiptTypes']) {
    assertPolicy(
      Array.isArray(policy[field]) && policy[field].length > 0,
      `launch policy ${field} must be a non-empty array`,
    );
  }
  assertPolicy(
    policy.freshness && typeof policy.freshness === 'object',
    'launch policy freshness workload is required',
  );
  assertPolicy(
    typeof policy.freshness.p95TargetMs === 'number' && policy.freshness.p95TargetMs > 0,
    'launch policy freshness.p95TargetMs must be a positive number',
  );
  assertPolicy(
    policy.semanticModel && Array.isArray(policy.semanticModel.supportedScorers),
    'launch policy semanticModel.supportedScorers is required',
  );
  return policy;
}

/** `sha256:<hex>` over the policy file's exact bytes — the value receipts must carry. */
export function hashLaunchPolicyBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Load + validate the policy and its hash together. The hash is over the FILE BYTES, not over a
 * re-serialization of the parsed object: reformatting the file changes what was frozen, and the
 * decision should notice.
 */
export function loadLaunchPolicy(path = DEFAULT_POLICY_PATH) {
  const resolved = resolve(path);
  let bytes;
  try {
    bytes = readFileSync(resolved);
  } catch (error) {
    throw new LaunchPolicyError(`unreadable launch policy ${resolved}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new LaunchPolicyError(`launch policy ${resolved} is not valid JSON: ${error.message}`);
  }
  return {
    policy: validateLaunchPolicy(parsed),
    sha256: hashLaunchPolicyBytes(bytes),
    path: resolved,
  };
}

/** The exact gate id set the decision may reason about — never read from an artifact. */
export function policyGateIds(policy) {
  return policy.gates.map((gate) => gate.id);
}

/** Every client/platform cell the current promise advertises (7 clients × 3 platforms = 21). */
export function policyClientCells(policy) {
  return policy.clients.flatMap((client) =>
    policy.clientPlatforms.map((platform) => `${client}/${platform}`),
  );
}

/** Every CI OS/Node cell that must complete successfully. */
export function policyOsNodeCells(policy) {
  return [...policy.osNodeCells];
}

/**
 * Judge ONE measurement against the policy's own threshold and direction.
 *
 * A non-finite measurement is a failure, not a comparison: `NaN >= 0.8` is false but `NaN <= 0.01`
 * is also false, so a silently missing number could otherwise pass a `lte` gate.
 */
export function evaluateGate(policyGate, measured, epsilon = 1e-9) {
  if (typeof measured !== 'number' || !Number.isFinite(measured)) {
    return { pass: false, reason: 'measurement-not-finite' };
  }
  const pass =
    policyGate.direction === 'gte'
      ? measured >= policyGate.threshold - epsilon
      : measured <= policyGate.threshold + epsilon;
  return { pass, reason: pass ? undefined : 'threshold' };
}
