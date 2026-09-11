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
 *
 * Version 3 widens the promise back to its full advertised boundary and then makes NARROWING it a
 * validation failure: clients and platforms must be exactly the known vocabulary, the OS/Node grid
 * must be the complete Cartesian product, every one of the 21 client cells must carry a version
 * floor, and a policy that tries to reintroduce a preview tier or accept WSL as a native runtime is
 * refused outright. A promise that can be quietly narrowed is the defect this file exists to
 * prevent, so the narrowing is now the thing that fails loudly.
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

/**
 * The known vocabularies. These are deliberately fixed rather than derived from the policy itself:
 * a validator that reads its expectations out of the document it is validating cannot notice the
 * document shrinking. Bumping any of them is a deliberate act that accompanies a policyVersion
 * bump, which is what makes the corresponding hash change legible.
 */
export const POLICY_CLIENTS = [
  'claude',
  'copilot',
  'cursor',
  'codex',
  'windsurf',
  'gemini',
  'vscode',
];
export const POLICY_PLATFORMS = ['darwin', 'linux', 'win32'];
export const POLICY_GATE_IDS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];
export const POLICY_ACCEPTANCE_RECEIPT_TYPES = [
  'install',
  'native-service',
  'browser',
  'recovery',
  'security-privacy',
  'freshness',
  'adapter',
];
export const POLICY_GLOBAL_RECEIPT_TYPES = ['fuzz-deep'];
const RUNNER_OSES = ['macos-latest', 'ubuntu-latest', 'windows-latest'];
const NODE_MAJORS = ['22', '24'];
export const EXPECTED_POLICY_VERSION = 3;

/** `macos-latest/22` -> { os: 'macos-latest', node: '22' } */
function parseOsNodeCell(cell) {
  if (typeof cell !== 'string') return undefined;
  const match = /^([a-z0-9][a-z0-9-]*)\/(\d+)$/.exec(cell);
  return match ? { os: match[1], node: match[2] } : undefined;
}

function assertNoDuplicates(values, label) {
  const seen = new Set();
  for (const value of values) {
    assertPolicy(!seen.has(value), `duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

/** Set equality, reported as the two differences rather than as a bare boolean. */
function assertSameSet(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unknown = [...actualSet].filter((value) => !expectedSet.has(value));
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  assertPolicy(
    unknown.length === 0 && missing.length === 0,
    unknown.length
      ? `launch policy declares unknown ${label}: ${unknown.join(', ')}`
      : `launch policy is missing required ${label}: ${missing.join(', ')}`,
  );
}

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
    policy.policyVersion === EXPECTED_POLICY_VERSION,
    `launch policy policyVersion is ${policy.policyVersion}, but this build validates version ${EXPECTED_POLICY_VERSION}. Bump the validator and this assertion together with the policy, deliberately — the hash change voids every receipt collected under the previous policy.`,
  );

  // gates ─────────────────────────────────────────────────────────────────────────────────────
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
  // The gate set is the measurement contract: a missing gate is a requirement that quietly stopped
  // being measured, and an extra one is a threshold the decision would judge without a workload.
  assertSameSet(ids, POLICY_GATE_IDS, 'gate id');

  // clients and platforms ──────────────────────────────────────────────────────────────────────
  assertPolicy(
    Array.isArray(policy.clients) && policy.clients.length > 0,
    'launch policy clients must be a non-empty array',
  );
  assertPolicy(
    Array.isArray(policy.clientPlatforms) && policy.clientPlatforms.length > 0,
    'launch policy clientPlatforms must be a non-empty array',
  );
  assertNoDuplicates(policy.clients, 'client');
  assertNoDuplicates(policy.clientPlatforms, 'platform');
  // Exact equality, not containment. A promise is allowed to grow, but only by editing this
  // vocabulary at the same moment — dropping a client or a platform out of the policy would
  // otherwise silently shrink what a GO means.
  assertSameSet(policy.clients, POLICY_CLIENTS, 'client');
  assertSameSet(policy.clientPlatforms, POLICY_PLATFORMS, 'platform');
  // WSL is not a native Linux or Windows runtime. It is refused structurally (the platform
  // vocabulary above has no such member) AND explicitly, so a policy cannot reintroduce it by
  // declaring it acceptable in a flag nobody reads.
  for (const key of ['allowWslSubstitution', 'wslSatisfiesNativePlatforms']) {
    assertPolicy(
      !policy[key],
      `launch policy ${key} is refused: WSL reports process.platform 'linux' from a Windows host and is not a native Linux or Windows runtime, so it can never satisfy a platform cell`,
    );
  }

  // the promise may not be narrowed by declaring part of it preview ────────────────────────────
  const uncertified = policy.uncertified;
  const uncertifiedSize = Array.isArray(uncertified)
    ? uncertified.length
    : uncertified && typeof uncertified === 'object'
      ? Object.values(uncertified).reduce(
          (total, value) => total + (Array.isArray(value) ? value.length : 1),
          0,
        )
      : 0;
  assertPolicy(
    !uncertifiedSize,
    'launch policy declares an `uncertified` set: version 3 has no preview tier for clients or platforms. Every advertised cell is a hard requirement, and a cell that cannot be executed leaves the release NO-GO rather than becoming preview.',
  );

  // per-cell version floors ────────────────────────────────────────────────────────────────────
  const cells = policyClientCells(policy);
  assertPolicy(
    policy.clientVersionRequirements &&
      typeof policy.clientVersionRequirements === 'object' &&
      !Array.isArray(policy.clientVersionRequirements),
    'launch policy clientVersionRequirements must be an object keyed by client/platform',
  );
  const floorKeys = Object.keys(policy.clientVersionRequirements);
  assertNoDuplicates(floorKeys, 'version-requirement key');
  assertSameSet(floorKeys, cells, 'client cell version requirement');
  for (const [cell, floor] of Object.entries(policy.clientVersionRequirements)) {
    assertPolicy(
      typeof floor === 'string' && floor.trim(),
      `launch policy version floor for ${cell} must be a non-empty version string`,
    );
    // A floor is compared as a version, so it has to LOOK like one. A free-text floor would compare
    // lexically ("2.10.0" < "2.9.0") and silently pass an unsupported client.
    assertPolicy(
      /^\d+(\.\d+)*$/.test(floor),
      `launch policy version floor for ${cell} must be a dotted numeric version, got ${floor}`,
    );
  }

  // the CI grid ────────────────────────────────────────────────────────────────────────────────
  assertPolicy(
    Array.isArray(policy.osNodeCells) && policy.osNodeCells.length > 0,
    'launch policy osNodeCells must be a non-empty array',
  );
  assertNoDuplicates(policy.osNodeCells, 'OS/Node cell');
  for (const cell of policy.osNodeCells) {
    const parsed = parseOsNodeCell(cell);
    assertPolicy(
      parsed !== undefined,
      `launch policy OS/Node cell must look like "<runner-os>/<node-major>", got ${JSON.stringify(cell)}`,
    );
    assertPolicy(
      RUNNER_OSES.includes(parsed.os),
      `launch policy OS/Node cell names an unknown runner OS: ${parsed.os}`,
    );
    assertPolicy(
      NODE_MAJORS.includes(parsed.node),
      `launch policy OS/Node cell names an unsupported Node major: ${parsed.node}`,
    );
  }
  // The COMPLETE product. A grid that is missing a cell is a platform/Node combination nobody
  // verified; the aggregation would then pass for lack of a manifest rather than for a measurement.
  const expectedGrid = RUNNER_OSES.flatMap((os) => NODE_MAJORS.map((node) => `${os}/${node}`));
  assertSameSet(policy.osNodeCells, expectedGrid, 'OS/Node cell');

  // receipt types ──────────────────────────────────────────────────────────────────────────────
  for (const [field, vocabulary] of [
    ['receiptTypes', POLICY_ACCEPTANCE_RECEIPT_TYPES],
    ['globalReceiptTypes', POLICY_GLOBAL_RECEIPT_TYPES],
  ]) {
    assertPolicy(
      Array.isArray(policy[field]) && policy[field].length > 0,
      `launch policy ${field} must be a non-empty array`,
    );
    assertNoDuplicates(policy[field], `receipt type in ${field}`);
    for (const type of policy[field]) {
      assertPolicy(
        vocabulary.includes(type),
        `launch policy ${field} declares an unknown receipt type: ${type}`,
      );
    }
  }

  // fuzz ───────────────────────────────────────────────────────────────────────────────────────
  // The deep sweep's thresholds are requirements, so they live in the policy rather than in the
  // receipt. A receipt may only be judged against numbers it cannot choose: if the required
  // iteration count or extractor count were read out of the artifact, a smoke run could certify
  // itself by declaring a smaller sweep. Missing here is a blocker, never a default.
  assertPolicy(
    policy.fuzz && typeof policy.fuzz === 'object',
    'launch policy fuzz workload is required',
  );
  for (const field of ['seed', 'requiredIterations', 'minimumExtractors']) {
    assertPolicy(
      Number.isInteger(policy.fuzz[field]) && policy.fuzz[field] > 0,
      `launch policy fuzz.${field} must be a positive integer`,
    );
  }
  assertPolicy(
    typeof policy.fuzz.perCallBudgetMs === 'number' && policy.fuzz.perCallBudgetMs > 0,
    'launch policy fuzz.perCallBudgetMs must be a positive number',
  );
  // The workload name is what a receipt is matched on — a receipt for a different harness is not
  // evidence about this one, however many iterations it ran.
  assertPolicy(
    typeof policy.fuzz.workload === 'string' && policy.fuzz.workload.trim().length > 0,
    'launch policy fuzz.workload must name the workload the deep receipt describes',
  );

  // freshness ──────────────────────────────────────────────────────────────────────────────────
  assertPolicy(
    policy.freshness && typeof policy.freshness === 'object',
    'launch policy freshness workload is required',
  );
  assertPolicy(
    typeof policy.freshness.p95TargetMs === 'number' && policy.freshness.p95TargetMs > 0,
    'launch policy freshness.p95TargetMs must be a positive number',
  );
  assertPolicy(
    Array.isArray(policy.freshness.platforms) && policy.freshness.platforms.length > 0,
    'launch policy freshness.platforms must be a non-empty array',
  );
  assertNoDuplicates(policy.freshness.platforms, 'freshness platform');
  // Freshness must be proven on every platform the product advertises. A narrower set would let
  // "automatic convergence" be a claim about one operating system wearing the word "platforms".
  assertSameSet(
    policy.freshness.platforms,
    policy.clientPlatforms,
    'freshness platform (the freshness set must be the advertised platform set)',
  );

  // semantic model ─────────────────────────────────────────────────────────────────────────────
  assertPolicy(
    policy.semanticModel && Array.isArray(policy.semanticModel.supportedScorers),
    'launch policy semanticModel.supportedScorers is required',
  );
  assertPolicy(
    typeof policy.semanticModel.requiredState === 'string' && policy.semanticModel.requiredState,
    'launch policy semanticModel.requiredState is required',
  );
  for (const scorer of policy.semanticModel.supportedScorers) {
    assertPolicy(
      typeof scorer === 'string' && scorer.trim(),
      'launch policy supportedScorers entries must be non-empty strings',
    );
  }
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

/** Every receipt type that is collected once for the candidate rather than once per cell. */
export function policyGlobalReceiptTypes(policy) {
  return [...policy.globalReceiptTypes];
}

/**
 * The deep-fuzz thresholds a `fuzz-deep` receipt is judged against.
 *
 * Read from the policy, never from the receipt: the numbers a run must meet cannot be the numbers
 * the run reported. The decision compares a receipt's declared iterations and extractors against
 * these, so a smoke run wearing the deep receipt's name is refused BY NAME instead of accepted on
 * the artifact's own summary of itself.
 */
export function policyFuzzRequirements(policy) {
  return {
    workload: policy.fuzz.workload,
    seed: policy.fuzz.seed,
    requiredIterations: policy.fuzz.requiredIterations,
    minimumExtractors: policy.fuzz.minimumExtractors,
    perCallBudgetMs: policy.fuzz.perCallBudgetMs,
  };
}

/**
 * The minimum supported version for ONE client/platform cell.
 *
 * Keyed by cell rather than by client: a client's floor can legitimately differ per platform (a
 * date-versioned editor ships different builds per OS), and a client-keyed floor would let the
 * lowest platform's floor certify the highest platform's client.
 */
export function policyClientVersionFloor(policy, client, platform) {
  return policy.clientVersionRequirements?.[`${client}/${platform}`];
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
