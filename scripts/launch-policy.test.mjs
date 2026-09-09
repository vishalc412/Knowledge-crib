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
  LaunchPolicyError,
  evaluateGate,
  hashLaunchPolicyBytes,
  loadLaunchPolicy,
  policyClientCells,
  policyGateIds,
  policyOsNodeCells,
  validateLaunchPolicy,
} from './launch-policy.mjs';

const FROZEN_POLICY_SHA256 =
  'sha256:4d8d954dc74b1a2aade7cbef7ec92cf35965ecff547a3ac8a0da1bae0ef00e38';

const { policy, sha256 } = loadLaunchPolicy();
assert.equal(
  sha256,
  FROZEN_POLICY_SHA256,
  'the launch policy changed: every receipt collected under the previous hash is now void. ' +
    'Update FROZEN_POLICY_SHA256 deliberately and recollect the affected evidence.',
);
// The hash is over the FILE BYTES, so a reformat is a change.
assert.equal(hashLaunchPolicyBytes(readFileSync(DEFAULT_POLICY_PATH)), FROZEN_POLICY_SHA256);

// The frozen retrieval contract the audit measured against, restated where a diff will show it.
assert.deepEqual(policyGateIds(policy), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
const byId = Object.fromEntries(policy.gates.map((gate) => [gate.id, gate]));
assert.equal(byId.G2.threshold, 0.8);
assert.equal(byId.G2.direction, 'gte');
assert.equal(byId.G3.threshold, 0.75);
assert.equal(byId.G3.direction, 'gte');
assert.equal(byId.G6.threshold, 0);
assert.equal(byId.G6.direction, 'lte');

// 7 clients × 3 platforms = the 21 cells the current promise advertises.
assert.equal(policyClientCells(policy).length, 21);
assert.ok(policyClientCells(policy).includes('vscode/win32'));
// Both advertised Node majors on all three OSes.
assert.equal(policyOsNodeCells(policy).length, 6);
assert.equal(policy.freshness.p95TargetMs, 5000);

// ─── the policy validator refuses a policy that would weaken a decision ───────
const clone = () => JSON.parse(readFileSync(DEFAULT_POLICY_PATH, 'utf8'));
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
  'a missing freshness target',
  (p) => {
    p.freshness.p95TargetMs = 0;
  },
  /p95TargetMs must be a positive number/,
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
