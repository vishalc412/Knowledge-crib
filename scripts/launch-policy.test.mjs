/**
 * The policy is only a freeze if changing it is LOUD.
 *
 * Its sha256 is the binding between requirements and receipts: a receipt records the hash it was
 * collected under, and the decision refuses receipts from another one. So an edit — including an
 * innocent reformat — silently invalidates every receipt already gathered. The hash is therefore
 * pinned here: changing the policy is allowed, changing it QUIETLY is not. When this fails, either
 * revert the edit or update the pin deliberately and recollect the affected evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_POLICY_PATH,
  EXPECTED_POLICY_VERSION,
  LaunchPolicyError,
  POLICY_CLIENTS,
  POLICY_GATE_IDS,
  POLICY_PLATFORMS,
  evaluateGate,
  hashLaunchPolicyBytes,
  loadLaunchPolicy,
  policyClientCells,
  policyClientVersionFloor,
  policyFuzzRequirements,
  policyGateIds,
  policyGlobalReceiptTypes,
  policyOsNodeCells,
  validateLaunchPolicy,
} from './launch-policy.mjs';

const FROZEN_POLICY_SHA256 =
  'sha256:c05ad25952bbe23ad259ac7f11c703adebe5921541badfee90b94ebb98852988';

/**
 * The version-2 policy hash, kept here as a HEADSTONE rather than deleted.
 *
 * Version 2 narrowed the promise to Claude Code on macOS and declared the other six clients and two
 * platforms preview. Every receipt collected under this hash was collected against that narrower
 * promise, so none of them may contribute to a version-3 decision — and the fact that the hash
 * moved is the only mechanical reason they cannot. If a receipt from this era ever appears to
 * certify a cell, this constant is what explains why it must not.
 */
const VOID_POLICY_V2_SHA256 =
  'sha256:44da0cce45cf15c81b191de992344e21e6c7883dd0d156b3d12a4d9fbbcbcbdf';

const { policy, sha256 } = loadLaunchPolicy();
assert.equal(
  sha256,
  FROZEN_POLICY_SHA256,
  'the launch policy changed: every receipt collected under the previous hash is now void. ' +
    'Update FROZEN_POLICY_SHA256 deliberately and recollect the affected evidence.',
);
// The hash is over the FILE BYTES, so a reformat is a change.
assert.equal(hashLaunchPolicyBytes(readFileSync(DEFAULT_POLICY_PATH)), FROZEN_POLICY_SHA256);
assert.notEqual(
  sha256,
  VOID_POLICY_V2_SHA256,
  'the policy must no longer carry the version-2 hash: receipts collected under it describe the ' +
    'narrowed promise and cannot certify this one',
);

// ─── the frozen retrieval contract, restated where a diff will show it ────────
assert.deepEqual(policyGateIds(policy), POLICY_GATE_IDS);
const byId = Object.fromEntries(policy.gates.map((gate) => [gate.id, gate]));
assert.deepEqual(
  policy.gates.map((gate) => [gate.id, gate.threshold, gate.direction]),
  [
    ['G1', 1, 'gte'],
    ['G2', 0.8, 'gte'],
    ['G3', 0.75, 'gte'],
    ['G4', 0.9, 'gte'],
    ['G5', 0.01, 'lte'],
    ['G6', 0, 'lte'],
    ['G7', 0, 'lte'],
    ['G8', 1, 'gte'],
  ],
  'G1-G8 are the preregistered thresholds and directions; widening the promise must not move them',
);
assert.equal(policy.gateEpsilon, 1e-9);
// The scorer the gates were measured against is frozen too — otherwise "G2 >= 0.80" could be met by
// swapping in a model that was never measured.
assert.deepEqual(policy.semanticModel.supportedScorers, [
  'memory-rank-v2:multilingual-e5-large-1024-sym:cosine:semantic-only',
]);
assert.equal(policy.semanticModel.requiredState, 'installed');

// ─── version 3: the FULL promise, which may not be narrowed ──────────────────
assert.equal(policy.policyVersion, EXPECTED_POLICY_VERSION);
assert.equal(policy.policyVersion, 3);
// Exactly 21 cells: seven clients, three native platforms, and no waiver anywhere.
assert.deepEqual(policy.clients, POLICY_CLIENTS);
assert.deepEqual(policy.clientPlatforms, POLICY_PLATFORMS);
assert.deepEqual(policyClientCells(policy), [
  'claude/darwin',
  'claude/linux',
  'claude/win32',
  'copilot/darwin',
  'copilot/linux',
  'copilot/win32',
  'cursor/darwin',
  'cursor/linux',
  'cursor/win32',
  'codex/darwin',
  'codex/linux',
  'codex/win32',
  'windsurf/darwin',
  'windsurf/linux',
  'windsurf/win32',
  'gemini/darwin',
  'gemini/linux',
  'gemini/win32',
  'vscode/darwin',
  'vscode/linux',
  'vscode/win32',
]);
assert.equal(policyClientCells(policy).length, 21);

// Six CI cells: every operating system the product runs on, on both supported Node majors.
assert.deepEqual(policyOsNodeCells(policy), [
  'macos-latest/22',
  'macos-latest/24',
  'ubuntu-latest/22',
  'ubuntu-latest/24',
  'windows-latest/22',
  'windows-latest/24',
]);
assert.equal(policyOsNodeCells(policy).length, 6);

// Every one of the 21 cells carries a version floor — a cell with no floor is a client that was
// never checked against a supported version at all.
assert.deepEqual(
  Object.keys(policy.clientVersionRequirements).sort(),
  [...policyClientCells(policy)].sort(),
);
for (const cell of policyClientCells(policy)) {
  const [client, platform] = cell.split('/');
  const floor = policyClientVersionFloor(policy, client, platform);
  assert.match(floor, /^\d+(\.\d+)*$/, `${cell} must carry a dotted numeric version floor`);
}

// The narrowing language is GONE. Version 2 said six clients and two platforms were preview; that
// is exactly the claim version 3 removes, so its absence is asserted rather than assumed.
assert.equal(policy.uncertified, undefined);
assert.ok(
  !JSON.stringify(policy.scope).includes('never as supported'),
  'the version-2 preview language must not survive into version 3',
);
assert.match(policy.scope.preview, /^Nothing\./);
assert.match(policy.scope.certified, /seven clients/i);
assert.match(policy.scope.wsl, /not a native/i);
// A GO is not a publication: the tag workflow still aggregates over the CI cells, the 21 client
// cells, and the deep-fuzz receipt, on real runners and real vendor hosts.
assert.match(policy.scope.publication, /real runners and real vendor hosts/);
assert.match(policy.scope.publication, /twenty-one client cells/);

// The global receipt is the deep fuzz, which is collected once per candidate, not once per cell.
assert.deepEqual(policyGlobalReceiptTypes(policy), ['fuzz-deep']);
assert.deepEqual(policy.receiptTypes, [
  'install',
  'native-service',
  'browser',
  'recovery',
  'security-privacy',
  'freshness',
  'adapter',
]);

// The deep sweep's thresholds are REQUIREMENTS, so they are frozen here rather than in the receipt
// that reports them. 10 is not a typo and the "9 extractors" comments elsewhere in the tree are
// stale: FUZZ_EXTRACTORS ships ten entries, Mule included.
assert.deepEqual(policyFuzzRequirements(policy), {
  workload: 'parser-fuzz-seeded-fast-check-v1',
  seed: 1,
  requiredIterations: 1_000_000,
  minimumExtractors: 10,
  perCallBudgetMs: 1000,
});

// Freshness is proven on every advertised platform, with the workload preregistered CONCRETELY — a
// target with no stated workload can be met by choosing an easier one after the fact.
assert.deepEqual(policy.freshness.platforms, POLICY_PLATFORMS);
assert.equal(policy.freshness.p95TargetMs, 5000);
assert.equal(policy.freshness.workload, 'synthetic-ts-call-chain-transitions-v1');
assert.equal(policy.freshness.files, 120);
assert.equal(policy.freshness.samplesPerTransition, 10);
assert.equal(policy.freshness.warmupSamples, 2);
assert.deepEqual(policy.freshness.transitions, [
  'save',
  'rename',
  'delete',
  'clean-checkout',
  'merge',
  'rebase',
  'external-update',
  'restart',
]);

// ─── the policy validator refuses a policy that would weaken a decision ───────
const clone = () => JSON.parse(readFileSync(DEFAULT_POLICY_PATH, 'utf8'));
/** Drop every version requirement whose key starts with `prefix` — a narrowed policy, rebuilt. */
const withoutCells = (requirements, prefix) =>
  Object.fromEntries(Object.entries(requirements).filter(([cell]) => !cell.startsWith(prefix)));
const refuses = (label, mutate, pattern) => {
  const bad = clone();
  mutate(bad);
  assert.throws(() => validateLaunchPolicy(bad), pattern, `${label} must be refused`);
};

refuses(
  'a wrong format marker',
  (p) => {
    p.format = 'something-else';
  },
  /unsupported launch policy format/,
);
refuses(
  'a stale policy version',
  (p) => {
    p.policyVersion = 2;
  },
  /Bump the validator and this assertion together/,
);
refuses(
  'an empty gate set',
  (p) => {
    p.gates = [];
  },
  /at least one gate/,
);
refuses(
  'a duplicated gate',
  (p) => {
    p.gates.push(p.gates[0]);
  },
  /duplicate gate id/,
);
refuses(
  'a gate dropped from the contract',
  (p) => {
    p.gates = p.gates.filter((gate) => gate.id !== 'G7');
  },
  /missing required gate id: G7/,
);
refuses(
  'an invented gate',
  (p) => {
    p.gates.push({ id: 'G9', threshold: 0, direction: 'lte', label: 'made up' });
  },
  /unknown gate id: G9/,
);
refuses(
  'a non-numeric threshold',
  (p) => {
    p.gates[0].threshold = 'high';
  },
  /finite threshold/,
);
refuses(
  'an unknown comparison direction',
  (p) => {
    p.gates[0].direction = 'about';
  },
  /direction gte or lte/,
);
refuses(
  'an empty client set',
  (p) => {
    p.clients = [];
  },
  /clients must be a non-empty array/,
);
refuses(
  'a client dropped from the promise',
  (p) => {
    p.clients = policy.clients.filter((client) => client !== 'gemini');
    p.clientVersionRequirements = withoutCells(p.clientVersionRequirements, 'gemini/');
  },
  /missing required client: gemini/,
);
refuses(
  'an unknown client',
  (p) => {
    p.clients = [...p.clients, 'notepad'];
    for (const platform of p.clientPlatforms) {
      p.clientVersionRequirements[`notepad/${platform}`] = '1.0.0';
    }
  },
  /unknown client: notepad/,
);
refuses(
  'a duplicated client',
  (p) => {
    p.clients = [...p.clients, 'claude'];
  },
  /duplicate client: claude/,
);
refuses(
  'a platform dropped from the promise',
  (p) => {
    p.clientPlatforms = ['darwin', 'linux'];
    p.clientVersionRequirements = withoutCells(p.clientVersionRequirements, 'claude/win32');
    p.freshness.platforms = ['darwin', 'linux'];
  },
  /missing required platform: win32/,
);
refuses(
  'an unknown platform',
  (p) => {
    p.clientPlatforms = [...p.clientPlatforms, 'freebsd'];
  },
  /unknown platform: freebsd/,
);
// WSL, refused twice over: structurally, because it is not in the platform vocabulary, and
// explicitly, so a flag that declares it acceptable cannot open the door the vocabulary closed.
refuses(
  'WSL offered as a platform',
  (p) => {
    p.clientPlatforms = ['darwin', 'linux', 'wsl'];
    for (const client of p.clients) p.clientVersionRequirements[`${client}/wsl`] = '1.0.0';
    p.freshness.platforms = ['darwin', 'linux', 'wsl'];
  },
  /unknown platform: wsl/,
);
refuses(
  'a flag declaring WSL an acceptable native runtime',
  (p) => {
    p.allowWslSubstitution = true;
  },
  /WSL reports process.platform 'linux' from a Windows host/,
);
refuses(
  'a preview tier reintroduced to narrow the promise',
  (p) => {
    p.uncertified = { clients: ['gemini', 'windsurf'], platforms: ['linux', 'win32'] };
  },
  /no preview tier for clients or platforms/,
);
refuses(
  'a dropped per-cell version floor',
  (p) => {
    p.clientVersionRequirements = withoutCells(p.clientVersionRequirements, 'windsurf/linux');
  },
  /missing required client cell version requirement: windsurf\/linux/,
);
refuses(
  'a version floor for a cell the policy does not declare',
  (p) => {
    p.clientVersionRequirements['gemini/darwin-x64'] = '1.0.0';
  },
  /unknown client cell version requirement: gemini\/darwin-x64/,
);
refuses(
  'a free-text version floor',
  (p) => {
    p.clientVersionRequirements['claude/darwin'] = 'latest';
  },
  /must be a dotted numeric version/,
);
refuses(
  'an empty version floor',
  (p) => {
    p.clientVersionRequirements['claude/darwin'] = '';
  },
  /must be a non-empty version string/,
);
refuses(
  'a missing OS/Node cell',
  (p) => {
    p.osNodeCells = p.osNodeCells.filter((cell) => cell !== 'windows-latest/24');
  },
  /missing required OS\/Node cell: windows-latest\/24/,
);
refuses(
  'an incomplete OS/Node product that drops an operating system',
  (p) => {
    p.osNodeCells = ['macos-latest/22', 'macos-latest/24', 'ubuntu-latest/22', 'ubuntu-latest/24'];
  },
  /OS\/Node cell/,
);
refuses(
  'a duplicated OS/Node cell',
  (p) => {
    p.osNodeCells = [...p.osNodeCells, 'macos-latest/22'];
  },
  /duplicate OS\/Node cell/,
);
refuses(
  'an unsupported Node major',
  (p) => {
    p.osNodeCells = [...p.osNodeCells, 'macos-latest/20'];
  },
  /unsupported Node major: 20/,
);
refuses(
  'an unknown runner OS',
  (p) => {
    p.osNodeCells = [...p.osNodeCells, 'freebsd-latest/22'];
  },
  /unknown runner OS: freebsd-latest/,
);
refuses(
  'a malformed OS/Node cell',
  (p) => {
    p.osNodeCells = [...p.osNodeCells, 'macos-latest'];
  },
  /must look like "<runner-os>\/<node-major>"/,
);
refuses(
  'an unknown acceptance receipt type',
  (p) => {
    p.receiptTypes = [...p.receiptTypes, 'vibes'];
  },
  /unknown receipt type: vibes/,
);
refuses(
  'a duplicated receipt type',
  (p) => {
    p.receiptTypes = [...p.receiptTypes, 'install'];
  },
  /duplicate receipt type in receiptTypes: install/,
);
refuses(
  'an empty global receipt set',
  (p) => {
    p.globalReceiptTypes = [];
  },
  /globalReceiptTypes must be a non-empty array/,
);
refuses(
  'a missing deep-fuzz workload',
  (p) => {
    p.fuzz = undefined;
  },
  /fuzz workload is required/,
);
refuses(
  'a deep sweep with a fractional iteration count',
  (p) => {
    p.fuzz.requiredIterations = 1000.5;
  },
  /fuzz\.requiredIterations must be a positive integer/,
);
refuses(
  'a deep sweep that names no workload',
  (p) => {
    p.fuzz.workload = '';
  },
  /fuzz\.workload must name the workload/,
);
refuses(
  'a deep sweep with no per-call wall-clock budget',
  (p) => {
    p.fuzz.perCallBudgetMs = 0;
  },
  /fuzz\.perCallBudgetMs must be a positive number/,
);
// Shape validation deliberately does NOT police the deep sweep's VALUE. A lowered-but-still-positive
// iteration count is well-formed, and a validator that hardcoded a minimum would be a second place
// the number lives — free to drift from the policy silently. The value is guarded by the hash pin
// instead: weakening the workload changes the file bytes, so it cannot be done quietly. Asserted
// here rather than assumed, so the guard has a test behind it.
{
  const weakened = clone();
  weakened.fuzz.requiredIterations = 1000;
  assert.notEqual(
    hashLaunchPolicyBytes(Buffer.from(`${JSON.stringify(weakened, null, 2)}\n`)),
    FROZEN_POLICY_SHA256,
    'weakening the deep sweep must change the policy hash — the pin is what refuses it',
  );
  // ...and the pin is only meaningful if the same bytes hash the same twice.
  const twice = JSON.stringify(weakened, null, 2);
  assert.equal(
    hashLaunchPolicyBytes(Buffer.from(`${twice}\n`)),
    hashLaunchPolicyBytes(Buffer.from(`${twice}\n`)),
  );
}
refuses(
  'a freshness platform set narrower than the advertised one',
  (p) => {
    p.freshness.platforms = ['darwin'];
  },
  /freshness set must be the advertised platform set/,
);
refuses(
  'a missing freshness target',
  (p) => {
    p.freshness.p95TargetMs = 0;
  },
  /p95TargetMs must be a positive number/,
);
refuses(
  'a missing required semantic state',
  (p) => {
    p.semanticModel = { supportedScorers: p.semanticModel.supportedScorers };
  },
  /semanticModel.requiredState is required/,
);
assert.throws(() => loadLaunchPolicy('/nonexistent/policy.json'), LaunchPolicyError);

// ─── gate arithmetic: a measurement that is not a number never passes ─────────
assert.equal(evaluateGate(byId.G2, 0.8).pass, true);
assert.equal(evaluateGate(byId.G2, 0.79).pass, false);
assert.equal(evaluateGate(byId.G6, 0).pass, true);
assert.equal(evaluateGate(byId.G6, 1).pass, false);
for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '0', {}]) {
  // Both directions: `NaN <= 0` is false, but so is `NaN >= 0.8` — a silently absent measurement
  // must not slip through the lte gates just because the comparison happens to be false.
  assert.deepEqual(evaluateGate(byId.G6, value), { pass: false, reason: 'measurement-not-finite' });
  assert.deepEqual(evaluateGate(byId.G2, value), { pass: false, reason: 'measurement-not-finite' });
}

console.log('launch policy tests ok');
