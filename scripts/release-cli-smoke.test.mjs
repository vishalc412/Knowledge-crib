import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../packages/soul-schema/dist/index.js';
import { smokeCli } from './release-cli-smoke.mjs';

const status = smokeCli();

assert.equal(status.indexed, true, 'smoke project must be indexed');
// Compared against the declared constant rather than a literal. Hardcoding '1.5' here meant the
// assertion silently rotted the moment the schema moved to 1.6, and this check — whose whole job is
// to prove a freshly installed CLI writes the CURRENT schema — failed on every release run instead
// of catching anything. A test that must be hand-edited on every bump will be stale most of the time.
assert.equal(status.schemaVersion, SCHEMA_VERSION, 'smoke project must use the current schema');
assert.ok(status.stats.nodes > 0, 'smoke project must contain extracted nodes');

const releaseVerifier = readFileSync('scripts/release-verify.mjs', 'utf8');
assert.match(
  releaseVerifier,
  /release-cli-smoke\.mjs/,
  'release gate must run the hermetic CLI smoke project',
);
assert.doesNotMatch(
  releaseVerifier,
  /\['packages\/cli\/dist\/cli\.js', 'status', '\.'\]/,
  'release gate must not depend on a machine-local derived index',
);

console.log('release-cli-smoke tests ok');
